import { describe, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import { Observable } from "rxjs";
import { ComputerToolLoop } from "../src/computer/agui-tool-loop";
import type { ToolSpec } from "../src/tools/spec";

/**
 * What the loop for a remote Bot must guarantee.
 *
 * This is the half of the move that has no equivalent anywhere else: a `BuiltInAgent` runs its own
 * tool loop, and a remote AG-UI Bot cannot, so if this file is wrong then every Bot that is an
 * endpoint — which is most of them, including the one that ships in the box — quietly loses the
 * ability to act. The properties worth pinning are the ones whose absence is invisible until a
 * person is watching a transcript:
 *
 *  - the tools are actually offered, under one name each
 *  - a call is carried out and the endpoint is asked again with the result
 *  - the surface sees ONE run, not one per pass
 *  - a tool somebody else owns is left alone
 *  - the loop is bounded, and says so rather than stopping silently
 *  - Stop stops it, including between calls
 */

/** A scripted endpoint: one list of events per pass, and a record of what it was asked. */
class ScriptedAgent extends AbstractAgent {
  readonly seen: RunAgentInput[] = [];
  private pass = 0;

  constructor(private readonly script: BaseEvent[][]) {
    super({ agentId: "scripted" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.seen.push(structuredClone(input));
    const events =
      this.script[this.pass] ?? this.script[this.script.length - 1] ?? [];
    this.pass += 1;
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

const started = { type: "RUN_STARTED", threadId: "t", runId: "r" } as BaseEvent;
const finished = {
  type: "RUN_FINISHED",
  threadId: "t",
  runId: "r",
} as BaseEvent;

function toolCall(id: string, name: string, args: string): BaseEvent[] {
  return [
    {
      type: "TOOL_CALL_START",
      toolCallId: id,
      toolCallName: name,
      parentMessageId: `msg_${id}`,
    } as BaseEvent,
    { type: "TOOL_CALL_ARGS", toolCallId: id, delta: args } as BaseEvent,
    { type: "TOOL_CALL_END", toolCallId: id } as BaseEvent,
  ];
}

function text(messageId: string, body: string): BaseEvent[] {
  return [
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as BaseEvent,
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: body } as BaseEvent,
    { type: "TEXT_MESSAGE_END", messageId } as BaseEvent,
  ];
}

/** A spec that records its arguments and returns whatever it was told to. */
function spy(
  name: string,
  outcome: Record<string, unknown> = { ok: true, action: name },
): ToolSpec & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    name,
    description: `Do ${name}.`,
    parameters: { type: "object", properties: {} },
    calls,
    execute: async (args) => {
      calls.push(args);
      return outcome as { ok: boolean };
    },
  };
}

const INPUT: RunAgentInput = {
  threadId: "t",
  runId: "r",
  messages: [{ id: "u1", role: "user", content: "Open the portal." }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
} as RunAgentInput;

/** Drive the middleware the way the agent does, collecting everything downstream would see. */
function drive(
  loop: ComputerToolLoop,
  endpoint: AbstractAgent,
  input: RunAgentInput = INPUT,
): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    loop.run(input, endpoint).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });
}

describe("the tool loop for a remote AG-UI Bot", () => {
  test("offers the tools, carries out a call, and asks the endpoint again", async () => {
    const click = spy("computer_click", {
      ok: true,
      element: { name: "Submit" },
    });
    const endpoint = new ScriptedAgent([
      [started, ...toolCall("c1", "computer_click", '{"ref":"f1"}'), finished],
      [started, ...text("m2", "Submitted."), finished],
    ]);

    const events = await drive(new ComputerToolLoop([click]), endpoint);

    // The tools reached the endpoint, which is the whole point: without this a remote Bot has none.
    expect(endpoint.seen[0]?.tools?.map((tool) => tool.name)).toEqual([
      "computer_click",
    ]);
    expect(click.calls).toEqual([{ ref: "f1" }]);

    // The second pass carries the model's own call and the result, in the shape a provider expects
    // to receive its previous turn back in.
    const second = endpoint.seen[1];
    expect(second?.messages.at(-2)).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "c1",
          function: { name: "computer_click", arguments: '{"ref":"f1"}' },
        },
      ],
    });
    expect(second?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "c1",
      content: JSON.stringify({ ok: true, element: { name: "Submit" } }),
    });

    // The result is emitted downstream too, or the transcript and the durable thread would never
    // learn what the action did.
    expect(
      events.filter((event) => event.type === "TOOL_CALL_RESULT"),
    ).toHaveLength(1);
  });

  test("the surface sees one run, however many passes it took", async () => {
    const endpoint = new ScriptedAgent([
      [started, ...toolCall("c1", "computer_snapshot", "{}"), finished],
      [started, ...toolCall("c2", "computer_click", '{"ref":"f1"}'), finished],
      [started, ...text("m3", "Done."), finished],
    ]);

    const events = await drive(
      new ComputerToolLoop([spy("computer_snapshot"), spy("computer_click")]),
      endpoint,
    );

    const types = events.map((event) => event.type);
    // Several run boundaries for one question would draw several turns for it.
    expect(types.filter((type) => type === "RUN_STARTED")).toHaveLength(1);
    expect(types.filter((type) => type === "RUN_FINISHED")).toHaveLength(1);
    expect(types[0]).toBe("RUN_STARTED");
    expect(types.at(-1)).toBe("RUN_FINISHED");
  });

  test("the run it reports finishing is the run the caller asked about", async () => {
    const endpoint = new ScriptedAgent([
      [started, ...toolCall("c1", "computer_read", "{}"), finished],
      [
        { type: "RUN_STARTED", threadId: "t", runId: "r:1" } as BaseEvent,
        ...text("m2", "It says hello."),
        { type: "RUN_FINISHED", threadId: "t", runId: "r:1" } as BaseEvent,
      ],
    ]);

    const events = await drive(
      new ComputerToolLoop([spy("computer_read")]),
      endpoint,
    );

    // Each pass runs under its own id, because endpoints derive message ids from it and a reused id
    // would give two assistant messages the same one. What comes back out must still be the caller's.
    expect(endpoint.seen[1]?.runId).toBe("r:1");
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", runId: "r" });
  });

  test("leaves a tool somebody else owns alone, and stops so they can run it", async () => {
    const mine = spy("computer_click");
    const endpoint = new ScriptedAgent([
      [
        started,
        ...toolCall("c1", "computer_click", '{"ref":"f1"}'),
        ...toolCall("c2", "confirm_purchase", '{"amount":10}'),
        finished,
      ],
      [started, ...text("m2", "should never run"), finished],
    ]);

    const events = await drive(new ComputerToolLoop([mine]), endpoint);

    // Ours still runs — leaving it unanswered would put a tool call with no result in the thread.
    expect(mine.calls).toHaveLength(1);
    // Theirs does not, and the loop ends so the client can execute it and continue.
    expect(endpoint.seen).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });

  test("keeps a same-named tool from the caller from being offered twice", async () => {
    const endpoint = new ScriptedAgent([
      [started, ...text("m1", "Hi."), finished],
    ]);
    const input = {
      ...INPUT,
      tools: [
        {
          name: "computer_click",
          description: "the browser's copy",
          parameters: {},
        },
        {
          name: "confirm_purchase",
          description: "someone else's",
          parameters: {},
        },
      ],
    } as RunAgentInput;

    await drive(new ComputerToolLoop([spy("computer_click")]), endpoint, input);

    // A model shown two tools called `computer_click` picks one at random. During the move from the
    // browser both registrations can exist, so ours replaces theirs rather than joining it.
    const names = endpoint.seen[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual(["confirm_purchase", "computer_click"]);
  });

  test("is bounded, and says so rather than stopping silently", async () => {
    const click = spy("computer_click");
    // An endpoint that never stops asking for another click.
    const endpoint = new ScriptedAgent([
      [started, ...toolCall("c1", "computer_click", '{"ref":"f1"}'), finished],
    ]);

    const events = await drive(
      new ComputerToolLoop([click], { maxSteps: 3 }),
      endpoint,
    );

    expect(endpoint.seen).toHaveLength(3);
    expect(click.calls).toHaveLength(3);
    // Silence looks like success. The person watching is owed the sentence.
    const said = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => (event as { delta: string }).delta)
      .join("");
    expect(said).toContain("stopped after 3 actions");
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });

  test("a run error ends it, without carrying out anything else", async () => {
    const click = spy("computer_click");
    const endpoint = new ScriptedAgent([
      [
        started,
        ...toolCall("c1", "computer_click", '{"ref":"f1"}'),
        {
          type: "RUN_ERROR",
          message: "The Bot could not answer.",
        } as BaseEvent,
      ],
    ]);

    const events = await drive(new ComputerToolLoop([click]), endpoint);

    // The endpoint failed mid-turn. Acting on a call from a run that then errored would be acting on
    // an intention nobody completed.
    expect(click.calls).toHaveLength(0);
    expect(endpoint.seen).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain("RUN_ERROR");
  });

  test("Stop stops it, and nothing runs afterwards", async () => {
    let released: (() => void) | undefined;
    const slow: ToolSpec = {
      name: "computer_click",
      description: "Click.",
      parameters: { type: "object", properties: {} },
      execute: () =>
        new Promise((resolve) => {
          released = () => resolve({ ok: true });
        }),
    };
    const endpoint = new ScriptedAgent([
      [started, ...toolCall("c1", "computer_click", '{"ref":"f1"}'), finished],
      [started, ...text("m2", "should never run"), finished],
    ]);

    const loop = new ComputerToolLoop([slow]);
    const subscription = loop
      .run(INPUT, endpoint)
      .subscribe({ next: () => {} });
    await Promise.resolve();

    // The person pressed Stop while the click was in flight.
    subscription.unsubscribe();
    released?.();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // A stopped run must not carry on acting on somebody's behalf after they asked it not to.
    expect(endpoint.seen).toHaveLength(1);
  });

  test("arguments a model mangled become an empty call, not a dead run", async () => {
    const click = spy("computer_click");
    const endpoint = new ScriptedAgent([
      [started, ...toolCall("c1", "computer_click", "{not json"), finished],
      [started, ...text("m2", "Sorry."), finished],
    ]);

    await drive(new ComputerToolLoop([click]), endpoint);

    // The tool reports what it needed, which the model can read and correct. An exception here would
    // end the run with a stack trace instead.
    expect(click.calls).toEqual([{}]);
  });
});
