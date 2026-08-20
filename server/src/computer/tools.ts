/**
 * The computer tools, declared once and executed on the server.
 *
 * These used to be registered in the browser with `useFrontendTool`, and each handler did
 * `fetch("/api/computers/:botId/...")` — a round trip back to this same process. That arrangement
 * made an open tab load-bearing: a Bot whose person had closed the window had no browser, no
 * workspace and no MCP, because the only thing that could carry out a tool call had gone away. It
 * also put an unattended run out of reach entirely, which is the wall a scheduled routine meets.
 *
 * So the execution moves here, next to the gateway it was always calling. Nothing about governance
 * moves with it: every acting tool still goes through `ComputerGateway`, which resolves the ref from
 * the snapshot this server took, evaluates the policy, writes the audit row, and only then acts.
 *
 * What deliberately stays in the browser is *rendering*. The transcript still draws these calls, and
 * still names the element the gateway resolved rather than the ref the model sent, because the
 * result shape below is the one the renderers already parse.
 *
 * Parameters are declared as JSON Schema rather than as Zod. That is the shape AG-UI puts on the
 * wire in `RunAgentInput.tools`, so one declaration serves both paths: converted to Zod for a
 * `BuiltInAgent`, and sent verbatim to a remote AG-UI Bot.
 */

import type { ToolOutcome, ToolSpec } from "../tools/spec";
import {
  ComputerUnavailableError,
  ElementNotFoundError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "./client";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGateway,
} from "./gateway";

export type ComputerToolsContext = {
  gateway: ComputerGateway;
  /** The Bot whose computer this is. The gateway addresses the computer by the same id. */
  botId: string;
  actor: ActionActor;
  /** Records a Bot's self-reported refusal. Absent leaves `report_refusal` recording nothing. */
  recordRefusal?: (input: {
    reason: string;
    request?: string;
  }) => Promise<void>;
  /**
   * How long to hold a tool call open while waiting for a person, and how often to look.
   *
   * Injected so a test does not wait ten minutes to prove the give-up path. The wait itself is the
   * server-side replacement for the browser's polling loop; it belongs here because the thing being
   * waited for — a person answering — has nothing to do with whether a tab is open.
   */
  waitFor?: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
  /**
   * Tell somebody the Bot has stopped and needs a hand.
   *
   * The other half of the wait below. A Bot waiting ten minutes for a sign-in it cannot do itself is
   * a Bot that has stopped, and the person who could unblock it in fifteen seconds has no way of
   * knowing unless something tells them. Absent leaves the wait silent, which is a deployment with
   * nowhere to send.
   *
   * It carries what the Bot said it needs, because a person cannot decide whether to get up and help
   * without reading the request. It must not be able to fail the tool.
   */
  announceQuestion?: (question: { asked: string }) => void;
  /**
   * Which conversation this Bot is currently in.
   *
   * A holder rather than a value, because the tools are built when a request arrives and the thread is
   * only known once a run starts inside it. Whoever drives the run sets it; `computer/agui-tool-loop.ts`
   * does for a remote Bot.
   *
   * It is worth threading through because an approval carrying its thread can be shown beside the
   * conversation it came out of, and one without it can only be found in a list. Absent is fine — the
   * approval is still answerable, it just has less context around it.
   */
  thread?: { current?: string };
};

/** Hold a tool call open until a person has answered, or the window closes. */
const WAIT_FOR_PERSON_MS = 10 * 60_000;
const WAIT_POLL_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Run one gateway call and describe the outcome the way the model and the transcript expect.
 *
 * The typed errors are classified here rather than mapped through HTTP statuses, which is strictly
 * more information than the browser had: it received a 409 and had to guess between a stale snapshot
 * and a person holding the wheel, and guessed "stale" for both. A Bot told to take another snapshot
 * when the real answer is "wait, somebody is driving" will loop.
 */
async function outcomeOf(run: () => Promise<unknown>): Promise<ToolOutcome> {
  try {
    const result = await run();
    return isRecord(result) ? { ok: true, ...result } : { ok: true, result };
  } catch (error) {
    // The deployment's policy refused it. Final: nothing the Bot does differently will help, and the
    // rule travels with the refusal so the transcript can name the boundary that was met.
    if (error instanceof ActionRefusedError) {
      return {
        ok: false,
        reason: error.message,
        refused: true,
        rule: error.rule,
      };
    }
    // The computer refused the path or the address itself. Also final, but there is no rule to go and
    // edit, so none is attached.
    if (
      error instanceof WorkspaceRefusedError ||
      error instanceof NavigationRefusedError
    ) {
      return { ok: false, reason: error.message, refused: true, rule: null };
    }
    // Not a refusal: there is no file called that. Told apart from a refusal deliberately, because a
    // Bot that reads "blocked" stops trying, and a Bot that reads "no such file" lists the workspace.
    if (error instanceof WorkspaceRequestError) {
      return { ok: false, reason: error.message };
    }
    if (
      error instanceof StaleSnapshotError ||
      error instanceof ElementNotFoundError
    ) {
      return { ok: false, reason: error.message, staleRefs: true };
    }
    if (error instanceof ComputerUnavailableError) {
      // A person is driving. Waiting is the answer, not a fresh snapshot.
      if (/control/i.test(error.message)) {
        return { ok: false, reason: error.message, humanHasControl: true };
      }
      return { ok: false, reason: error.message };
    }
    return {
      ok: false,
      reason:
        error instanceof Error
          ? error.message
          : "The assistant's computer could not be reached.",
    };
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Build the tools for one Bot and one person.
 *
 * Per run rather than per process: the actor goes on every audit row, and a tool that closed over
 * the wrong person would attribute one person's actions to another.
 */
export function createComputerToolSpecs(
  context: ComputerToolsContext,
): ToolSpec[] {
  const { gateway, botId, actor } = context;
  const announce = context.announceQuestion;
  /** Read at call time, never captured: one build of these tools serves every run in the request. */
  const threadId = () =>
    context.thread?.current ? { threadId: context.thread.current } : {};
  const timeoutMs = context.waitFor?.timeoutMs ?? WAIT_FOR_PERSON_MS;
  const pollMs = context.waitFor?.pollMs ?? WAIT_POLL_MS;
  const sleep =
    context.waitFor?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /**
   * Wait for a person to answer a prompt the Bot raised.
   *
   * Polls the control state rather than subscribing, for the same reason the browser did: the state
   * is owned by the computer, and a person may answer it from a surface this process is not holding a
   * connection to. Finite, so a run cannot be wedged forever by somebody who walked away.
   */
  async function waitForPerson(
    done: (state: Awaited<ReturnType<ComputerGateway["control"]>>) => boolean,
  ): Promise<"answered" | "gave up"> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await gateway.control(botId).catch(() => null);
      if (state && done(state)) return "answered";
      await sleep(pollMs);
    }
    return "gave up";
  }

  return [
    {
      name: "computer_navigate",
      description:
        "Open a web page on your own computer so the person can watch. Use this when asked to look " +
        "at, visit, open or check a website. Returns the page title and its readable text, so answer " +
        "from what comes back rather than telling the person to go and look.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full web address to open, including https://",
          },
        },
        required: ["url"],
      },
      execute: (args) =>
        outcomeOf(() =>
          gateway.navigate(
            botId,
            botId,
            actor,
            requireString(args, "url"),
            threadId(),
          ),
        ),
    },
    {
      name: "computer_read",
      description:
        "Read the page currently open on your computer, without opening anything. Use this after you " +
        "click something that changes the page, such as submitting a form, to find out what it now says.",
      parameters: { type: "object", properties: {} },
      execute: () => outcomeOf(() => gateway.read(botId)),
    },
    {
      name: "computer_snapshot",
      description:
        "List the things on the current page you can act on: fields, buttons, links and checkboxes, " +
        "each with a ref, its label and its current value. Call this BEFORE clicking or typing, and " +
        "use the refs it returns. Always send back the snapshotId it gives you. If an action reports " +
        "that your refs are stale, the page changed: call this again and use the new refs.",
      parameters: { type: "object", properties: {} },
      execute: () => outcomeOf(() => gateway.snapshot(botId)),
    },
    {
      name: "computer_type",
      description:
        "Enter text into a field on the page. Give the ref of the field from your most recent " +
        "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
        "Set submit to true to press Enter afterwards.",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: "Ref of the field, from your most recent snapshot",
          },
          snapshotId: {
            type: "number",
            description: "The snapshotId that ref came from",
          },
          text: { type: "string", description: "The text to enter" },
          submit: {
            type: "boolean",
            description:
              "Press Enter after typing, to submit a single-field form",
          },
        },
        required: ["ref", "snapshotId", "text"],
      },
      execute: (args) =>
        outcomeOf(() =>
          gateway.type(
            botId,
            botId,
            actor,
            {
              ref: requireString(args, "ref"),
              snapshotId: optionalNumber(args, "snapshotId") ?? 0,
              text: requireString(args, "text"),
              ...(args.submit === true ? { submit: true } : {}),
            },
            threadId(),
          ),
        ),
    },
    {
      name: "computer_click",
      description:
        "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
        "from your most recent snapshot and the snapshotId it came from.",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description:
              "Ref of the element to click, from your most recent snapshot",
          },
          snapshotId: {
            type: "number",
            description: "The snapshotId that ref came from",
          },
        },
        required: ["ref", "snapshotId"],
      },
      execute: (args) =>
        outcomeOf(() =>
          gateway.click(
            botId,
            botId,
            actor,
            {
              ref: requireString(args, "ref"),
              snapshotId: optionalNumber(args, "snapshotId") ?? 0,
            },
            threadId(),
          ),
        ),
    },
    {
      name: "computer_key",
      description:
        "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
        "is focused, or omit the ref to press it on the page.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Key name, such as Enter, Tab or Escape",
          },
          ref: {
            type: "string",
            description: "Optional ref to press the key on",
          },
          snapshotId: {
            type: "number",
            description:
              "The snapshotId the ref came from, required if ref is given",
          },
        },
        required: ["key"],
      },
      execute: (args) => {
        const ref = requireString(args, "ref");
        const snapshotId = optionalNumber(args, "snapshotId");
        return outcomeOf(() =>
          gateway.key(
            botId,
            botId,
            actor,
            {
              key: requireString(args, "key"),
              ...(ref && snapshotId !== undefined ? { ref, snapshotId } : {}),
            },
            threadId(),
          ),
        );
      },
    },
    {
      name: "computer_scroll",
      description:
        "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
      parameters: {
        type: "object",
        properties: {
          deltaY: {
            type: "number",
            description: "Pixels to scroll; positive is down. Defaults to 600.",
          },
        },
      },
      execute: (args) => {
        const deltaY = optionalNumber(args, "deltaY");
        return outcomeOf(() =>
          gateway.scroll(
            botId,
            botId,
            actor,
            deltaY === undefined ? {} : { deltaY },
            threadId(),
          ),
        );
      },
    },
    {
      name: "computer_list_files",
      description:
        "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
        "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
        "are not sure of. Never guess a filename.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Optional folder to list. Omit for the whole workspace.",
          },
        },
      },
      execute: (args) => {
        const path = requireString(args, "path");
        return outcomeOf(() =>
          gateway.listFiles(
            botId,
            botId,
            actor,
            path ? { path } : {},
            threadId(),
          ),
        );
      },
    },
    {
      name: "computer_read_file",
      description:
        "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
        "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
        "this to pick up notes you made before.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relative to your workspace, such as notes.md",
          },
        },
        required: ["path"],
      },
      execute: (args) =>
        outcomeOf(() =>
          gateway.readFile(
            botId,
            botId,
            actor,
            { path: requireString(args, "path") },
            threadId(),
          ),
        ),
    },
    {
      name: "computer_write_file",
      description:
        "Save a file in your own workspace so you still have it later. Paths are relative to your " +
        "workspace and folders are created as needed. Set append to true to add to the end of an " +
        "existing file rather than replacing it. Text only.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to your workspace, such as reports/august.csv",
          },
          contents: { type: "string", description: "The text to save" },
          append: {
            type: "boolean",
            description: "Add to the end of the file instead of replacing it",
          },
        },
        required: ["path", "contents"],
      },
      execute: (args) =>
        outcomeOf(() =>
          gateway.writeFile(
            botId,
            botId,
            actor,
            {
              path: requireString(args, "path"),
              contents: requireString(args, "contents"),
              ...(args.append === true ? { append: true } : {}),
            },
            threadId(),
          ),
        ),
    },
    {
      name: "computer_request_secret",
      description:
        "Ask the person for ONE value you must not be told: a password, a one-time code, a card number. " +
        "Focus the field first with computer_click, then call this with the ref of that field and a " +
        "short label for what you need. They type it into a masked box that goes straight to the page. " +
        "You will never see the value, and you must not ask for it any other way. Prefer this over a " +
        "full takeover when you only need one field filled in. The value is only TYPED into the field: " +
        "if the form needs submitting, do that yourself afterwards with computer_click.",
      parameters: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description:
              "What you need, in a few words, e.g. 'the code sent to your phone'",
          },
          ref: {
            type: "string",
            description:
              "Ref of the field it goes in, from your most recent snapshot",
          },
          snapshotId: {
            type: "number",
            description: "The snapshotId that ref came from",
          },
        },
        required: ["label", "ref", "snapshotId"],
      },
      execute: async (args) => {
        const label = requireString(args, "label");
        const asked = await outcomeOf(() =>
          gateway.requestSecret(botId, botId, actor, {
            label,
            ref: requireString(args, "ref"),
            snapshotId: optionalNumber(args, "snapshotId") ?? 0,
          }),
        );
        if (!asked.ok) return asked;

        // The label, not the value. There is no value on this side to leak: it goes from the
        // person's keyboard into the page on a path this process is not on.
        announce?.({ asked: `It needs ${label}.` });

        // Completion is `secretWanted` clearing. The value itself never comes back here: it goes from
        // the person's keyboard into the page, on a path this process is not on.
        const answered = await waitForPerson(
          (state) => state.secretWanted === undefined,
        );
        return {
          ok: true,
          result:
            answered === "answered"
              ? `The person has entered ${label} into the field. It was typed straight into the page and you were not told what it is.`
              : `Nobody entered ${label}. Do not ask for it another way.`,
        };
      },
    },
    {
      name: "computer_request_help",
      description:
        "Ask the person to take control of your computer and do something you cannot: sign in, enter a " +
        "password or a one-time code, or clear a CAPTCHA. Say specifically what you need done. They " +
        "will drive the browser themselves and hand it back, and you carry on in the same session. " +
        "Use this INSTEAD of giving up, and instead of ever asking them to type a password to you.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "What you need the person to do, in one sentence, e.g. 'This page is asking for a code sent to your phone.'",
          },
        },
        required: ["reason"],
      },
      execute: async (args) => {
        const reason =
          requireString(args, "reason") ||
          "The assistant needs a person to continue.";
        const asked = await outcomeOf(() =>
          gateway.requestHelp(botId, botId, actor, reason),
        );
        if (!asked.ok) return asked;

        announce?.({ asked: reason });

        // Resolved when the wheel is back with the Bot and no request is outstanding.
        const answered = await waitForPerson(
          (state) => state.holder === "bot" && !state.requested,
        );
        return {
          ok: true,
          result:
            answered === "answered"
              ? "The person has finished and handed control back. Take a fresh snapshot: the page may have changed while they were driving."
              : "Nobody took control. Say what you still need rather than trying to do it yourself.",
        };
      },
    },
    {
      /**
       * A self-reported decline. Evidence, not enforcement.
       *
       * Nothing is prevented by it: the model calls it because its description says to, so a model
       * that declines silently writes nothing, and a reader must not mistake an empty list for an
       * untroubled Bot.
       */
      name: "report_refusal",
      description:
        "Record that you DECLINED something you were asked to do, because it looked unsafe, was outside " +
        "what you are for, or you judged you should not. Call this whenever you say no to a request, in " +
        "addition to telling the person. It changes nothing about your answer; it exists so an " +
        "administrator can see what this Bot is being asked to do. Do not call it when you simply could " +
        "not do something, only when you chose not to.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Why you declined, in one sentence and in your own words",
          },
          request: {
            type: "string",
            description: "What you were asked to do, in a few words",
          },
        },
        required: ["reason"],
      },
      execute: async (args) => {
        const reason = requireString(args, "reason").trim();
        if (!reason) {
          return {
            ok: false,
            reason: "A reason is required.",
          };
        }
        const request = requireString(args, "request").trim();
        try {
          await context.recordRefusal?.({
            reason,
            ...(request ? { request } : {}),
          });
          return {
            ok: true,
            result: "Recorded. Now tell the person what you decided and why.",
          };
        } catch {
          // Audit bookkeeping must not stop the Bot answering the person in front of it.
          return {
            ok: true,
            result:
              "That could not be recorded. Tell the person what you decided anyway.",
          };
        }
      },
    },
  ];
}
