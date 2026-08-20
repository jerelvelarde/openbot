/**
 * The tool loop for a Bot that is an endpoint rather than a built-in.
 *
 * A `BuiltInAgent` is handed executable tools and runs its own loop, which is what `maxSteps` in
 * `copilot.ts` grants it. A remote AG-UI Bot cannot work that way: the protocol says a Bot emits a
 * tool call and ends its run, and somebody else carries the call out and starts the next run with the
 * result appended. That somebody used to be the browser. It is now this.
 *
 * So this middleware is the browser's old job, moved to the server and written once:
 *
 *   1. put the computer tools into `input.tools`, which is where AG-UI carries callable tools;
 *   2. watch the stream for a call to one of them;
 *   3. carry it out through the gateway, and emit its result so the transcript and the durable
 *      thread both learn what happened;
 *   4. run the endpoint again with the assistant's call and the tool's result appended.
 *
 * Written as AG-UI middleware, so it applies to any endpoint that speaks the protocol — LangGraph,
 * Mastra, ADK, a hand-written server — rather than to one provider's client. `Middleware.runNext`
 * normalises chunked events for us, so an endpoint that streams `TOOL_CALL_CHUNK` instead of
 * start/args/end is handled without a second code path.
 *
 * Downstream sees ONE run, not one per pass. Intermediate `RUN_FINISHED` events are withheld and the
 * following `RUN_STARTED` is dropped, because a surface that received several run boundaries for one
 * question would draw several turns for it. The last pass's `RUN_FINISHED` is forwarded, carrying the
 * run id the caller asked about rather than the one used for the final pass.
 *
 * Known limitation, stated rather than hidden: while a tool is executing this stream is silent, and a
 * tool parked on an `ask` rule can be silent for minutes. On a local deployment that is fine. Behind
 * an intermediary that times out idle responses it is not, and the answer there is the phone rather
 * than a longer-lived HTTP response.
 */

import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { type AbstractAgent, EventType, Middleware } from "@ag-ui/client";
import { Observable, type Subscription } from "rxjs";
import { runTool, type ToolSpec } from "../tools/spec";
import { toAgUiTools } from "../tools/wire";

/**
 * How many times a remote Bot may act before it has to say something.
 *
 * The same number and the same reasoning as `MAX_TOOL_STEPS` in `copilot.ts`, which bounds the
 * built-in Bots' loop. Kept as its own constant because the two loops are different mechanisms —
 * one is the AI SDK's, one is this file — and a shared import would suggest they are the same thing.
 */
const MAX_TOOL_STEPS = 12;

/** One tool call, reassembled from the events that describe it. */
type PendingCall = {
  id: string;
  name: string;
  args: string;
  parentMessageId?: string;
};

type TextMessageStart = BaseEvent & { messageId: string };
type TextMessageContent = BaseEvent & { messageId: string; delta: string };
type ToolCallStart = BaseEvent & {
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
};
type ToolCallArgs = BaseEvent & { toolCallId: string; delta: string };

export type ComputerToolLoopOptions = {
  maxSteps?: number;
  /**
   * Where to record which conversation a run belongs to.
   *
   * The tools are built when the request arrives, before any run has started, so the thread cannot be
   * captured then. This is the hook that fills it in: the same holder the tools read from, written
   * here at the start of each pass.
   *
   * Only a remote Bot gets this. A `BuiltInAgent` runs its own loop and there is no equivalent place
   * to stand, so an approval a built-in Bot parks has no thread on it — answerable, but findable only
   * in the list rather than beside the conversation.
   */
  thread?: { current?: string };
};

export class ComputerToolLoop extends Middleware {
  private readonly specs: Map<string, ToolSpec>;
  private readonly offered: ReturnType<typeof toAgUiTools>;
  private readonly maxSteps: number;
  private readonly thread: { current?: string } | undefined;

  constructor(specs: ToolSpec[], options: ComputerToolLoopOptions = {}) {
    super();
    this.specs = new Map(specs.map((spec) => [spec.name, spec]));
    this.offered = toAgUiTools(specs);
    this.maxSteps = options.maxSteps ?? MAX_TOOL_STEPS;
    this.thread = options.thread;
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      /**
       * Whether the person's Stop, or a closed connection, has ended this.
       *
       * Checked before every pass and between every tool call, so a stopped run does not carry on
       * clicking things on somebody's behalf after they asked it not to.
       */
      let stopped = false;
      let active: Subscription | undefined;

      const pass = (messages: Message[], step: number) => {
        if (stopped) return;
        // Which conversation the tools are acting inside, for as long as this run lasts.
        if (this.thread) this.thread.current = input.threadId;

        const openText = new Map<string, { content: string }>();
        const finishedText: Message[] = [];
        const callOrder: string[] = [];
        const calls = new Map<string, PendingCall>();
        /** The endpoint's own end-of-run, held back until we know whether there is another pass. */
        let withheldFinish: BaseEvent | undefined;
        let errored = false;

        active = this.runNext(
          this.passInput(input, messages, step),
          next,
        ).subscribe({
          next: (event) => {
            switch (event.type) {
              case EventType.RUN_STARTED:
                // One run boundary for the whole loop. A second would draw a second turn.
                if (step > 0) return;
                break;
              case EventType.RUN_FINISHED:
                withheldFinish = event;
                return;
              case EventType.RUN_ERROR:
                errored = true;
                break;
              case EventType.TEXT_MESSAGE_START:
                openText.set((event as TextMessageStart).messageId, {
                  content: "",
                });
                break;
              case EventType.TEXT_MESSAGE_CONTENT: {
                const content = event as TextMessageContent;
                const open = openText.get(content.messageId);
                if (open) open.content += content.delta;
                break;
              }
              case EventType.TEXT_MESSAGE_END: {
                const { messageId } = event as TextMessageStart;
                const open = openText.get(messageId);
                if (open) {
                  openText.delete(messageId);
                  finishedText.push({
                    id: messageId,
                    role: "assistant",
                    content: open.content,
                  });
                }
                break;
              }
              case EventType.TOOL_CALL_START: {
                const start = event as ToolCallStart;
                callOrder.push(start.toolCallId);
                calls.set(start.toolCallId, {
                  id: start.toolCallId,
                  name: start.toolCallName,
                  args: "",
                  ...(start.parentMessageId
                    ? { parentMessageId: start.parentMessageId }
                    : {}),
                });
                break;
              }
              case EventType.TOOL_CALL_ARGS: {
                const args = event as ToolCallArgs;
                const pending = calls.get(args.toolCallId);
                if (pending) pending.args += args.delta;
                break;
              }
              default:
                break;
            }
            subscriber.next(event);
          },
          error: (error) => subscriber.error(error),
          complete: () => {
            if (stopped) return;

            const requested = callOrder
              .map((id) => calls.get(id))
              .filter((call): call is PendingCall => call !== undefined);
            const mine = requested.filter((call) => this.specs.has(call.name));
            /**
             * Calls for tools somebody else registered — a plugin tool, or a confirmation the
             * surface owns. Not ours to run, and their presence ends the loop: the client has to
             * execute them and continue, and a second driver would race it.
             */
            const theirs = requested.filter(
              (call) => !this.specs.has(call.name),
            );

            if (errored || mine.length === 0) {
              this.finish(subscriber, withheldFinish, input);
              return;
            }

            void this.carryOut(mine, subscriber, () => stopped).then(
              (results) => {
                if (stopped) return;

                const exhausted = step + 1 >= this.maxSteps;
                if (theirs.length > 0 || exhausted) {
                  if (exhausted && theirs.length === 0) {
                    this.sayItStopped(subscriber, this.maxSteps);
                  }
                  this.finish(subscriber, withheldFinish, input);
                  return;
                }

                pass(
                  [
                    ...messages,
                    ...assembleAssistantMessages(finishedText, mine),
                    ...results,
                  ],
                  step + 1,
                );
              },
            );
          },
        });
      };

      pass(input.messages, 0);

      return () => {
        stopped = true;
        active?.unsubscribe();
      };
    });
  }

  /**
   * The input for one pass.
   *
   * The tools are ours plus anything the caller offered, with any same-named tool from the caller
   * dropped: during the move from the browser a surface may still be registering these names, and a
   * model shown two tools called `computer_click` will pick one at random.
   *
   * The run id is distinct per pass. Endpoints derive message ids from it — the built-in Bot uses
   * `msg_${runId}` — so reusing it would give two assistant messages the same id and one would
   * overwrite the other in the thread.
   */
  private passInput(
    input: RunAgentInput,
    messages: Message[],
    step: number,
  ): RunAgentInput {
    const mine = new Set(this.specs.keys());
    return {
      ...input,
      ...(step === 0 ? {} : { runId: `${input.runId}:${step}` }),
      messages,
      tools: [
        ...(input.tools ?? []).filter((tool) => !mine.has(tool.name)),
        ...this.offered,
      ],
    };
  }

  /**
   * Carry out the Bot's calls, in the order it asked for them.
   *
   * Sequentially, because they act on one computer: a click and the snapshot that resolves its ref
   * are about the same page, and running them at once would resolve refs against a page that has
   * already moved on.
   */
  private async carryOut(
    calls: PendingCall[],
    subscriber: { next: (event: BaseEvent) => void },
    stopped: () => boolean,
  ): Promise<Message[]> {
    const results: Message[] = [];
    for (const call of calls) {
      if (stopped()) return results;
      const spec = this.specs.get(call.name);
      if (!spec) continue;
      const outcome = await runTool(spec, parseArguments(call.args));
      const content = JSON.stringify(outcome);
      results.push({
        id: `tool_${call.id}`,
        role: "tool",
        toolCallId: call.id,
        content,
      });
      // How the result reaches both the transcript and the durable thread: the runtime turns this
      // into the tool message it stores, exactly as it did when the browser produced it.
      subscriber.next({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool_${call.id}`,
        toolCallId: call.id,
        content,
        role: "tool",
      } as BaseEvent);
    }
    return results;
  }

  /**
   * End the stream, forwarding the endpoint's own end-of-run.
   *
   * Rewritten to carry the run the caller asked about. The last pass ran under a derived id, and a
   * surface that reconciles the id it sent with the id it gets back would not recognise it.
   */
  private finish(
    subscriber: { next: (event: BaseEvent) => void; complete: () => void },
    withheld: BaseEvent | undefined,
    input: RunAgentInput,
  ) {
    if (withheld) {
      subscriber.next({
        ...withheld,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
    }
    subscriber.complete();
  }

  /**
   * Say out loud that the loop stopped, rather than stopping silently.
   *
   * A Bot that has used up its steps has not finished the job, and the person watching is owed that
   * sentence. Silence looks like success.
   */
  private sayItStopped(
    subscriber: { next: (event: BaseEvent) => void },
    steps: number,
  ) {
    const messageId = `openbot_step_limit_${crypto.randomUUID()}`;
    subscriber.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
    } as BaseEvent);
    subscriber.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta:
        `I stopped after ${steps} actions without finishing. Tell me what to do next, ` +
        "or ask me to carry on.",
    } as BaseEvent);
    subscriber.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId,
    } as BaseEvent);
  }
}

/**
 * The assistant messages one pass produced, with its tool calls attached to the right one.
 *
 * An endpoint that emits text and then a tool call under the same `parentMessageId` produced ONE
 * assistant message with both, which is the shape a provider expects to receive back. Splitting them
 * into two would make the model's own last turn unrecognisable to it.
 */
function assembleAssistantMessages(
  text: Message[],
  calls: PendingCall[],
): Message[] {
  const messages = text.map((message) => ({ ...message }));
  const byId = new Map(messages.map((message) => [message.id, message]));
  const orphans: PendingCall[] = [];

  for (const call of calls) {
    const parent = call.parentMessageId
      ? byId.get(call.parentMessageId)
      : undefined;
    if (parent && parent.role === "assistant") {
      parent.toolCalls = [...(parent.toolCalls ?? []), toolCallOf(call)];
      continue;
    }
    orphans.push(call);
  }

  if (orphans.length > 0) {
    messages.push({
      id: orphans[0]?.parentMessageId ?? `assistant_${crypto.randomUUID()}`,
      role: "assistant",
      toolCalls: orphans.map(toolCallOf),
    });
  }

  return messages;
}

function toolCallOf(call: PendingCall) {
  return {
    id: call.id,
    type: "function" as const,
    // An endpoint that emitted no arguments at all means "no arguments", which is `{}` on the wire.
    // An empty string is not valid JSON and would fail at the provider rather than here.
    function: { name: call.name, arguments: call.args || "{}" },
  };
}

/**
 * The arguments a model streamed, as an object.
 *
 * A model can emit arguments that do not parse. That is a bad call, not a server fault, so it
 * becomes an empty argument set and the tool reports what it needed — which is a thing the model can
 * read and correct — rather than an exception that ends the run.
 */
function parseArguments(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  try {
    const parsed = JSON.parse(args) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
