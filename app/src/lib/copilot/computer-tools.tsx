import { useRenderTool } from "@copilotkit/react-core/v2";
import { useEffect } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { ComputerView } from "@/components/computer/computer-view";
import { useActiveBotHolder } from "./active-bot";
import { reportComputerActivity } from "./computer-activity";

/**
 * How the transcript draws a Bot using its computer.
 *
 * Rendering only. These tools used to be registered here with `useFrontendTool`, and each handler
 * fetched `/api/computers/:botId/...` — a round trip from the browser back to the server that was
 * going to call the gateway anyway. That made an open tab load-bearing: close the window and the Bot
 * had no browser, no workspace and no MCP, because the only thing that could carry out a tool call
 * had gone away. An unattended run could not exist at all.
 *
 * Execution now lives in `server/src/computer/tools.ts`, next to the gateway, and the model-facing
 * descriptions live there with it — one place, so a Bot cannot be told two different things about the
 * same tool. What stays here is the part that genuinely belongs to a browser: the picture.
 *
 * The parameter schemas below are deliberately partial. They exist to type what a render reads, not
 * to describe the tool; the tool's contract is the JSON Schema on the server. Declaring the full
 * shape twice is how the two copies would drift.
 */

/** What a computer tool's render can read back out of its own result. */
type ComputerOutcome = {
  ok?: boolean;
  stopped?: boolean;
  humanHasControl?: boolean;
  entries?: unknown[];
  refused?: boolean;
  reason?: string;
  staleRefs?: boolean;
  elements?: unknown[];
  element?: { role?: string; name?: string };
};

/**
 * Parse the result string so the transcript can distinguish success, refusal, and failure.
 */
function outcomeOf(result: string | undefined): ComputerOutcome {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ComputerOutcome)
      : {};
  } catch {
    // A thrown handler reaches the transcript as "Error: <message>". The server-side tools return a
    // refusal as an outcome rather than throwing, so this is now only reached when something below
    // the tools fails outright — which is still worth showing rather than swallowing.
    return result.startsWith("Error:")
      ? { ok: false, reason: result.slice("Error:".length).trim() }
      : {};
  }
}

/**
 * The label of the element an action touched, as the gateway resolved it server-side.
 *
 * Not taken from the model's arguments: those carry only a ref. The server looked the element up in
 * the snapshot it took itself, which is the same value it wrote to the audit trail, so the transcript
 * and the audit row name the thing identically.
 */
function labelOf(result: string | undefined): string | undefined {
  const element = (outcomeOf(result) as { element?: { name?: unknown } })
    .element;
  const name = element?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * Open the computer screen while an action is in flight.
 *
 * It used to happen as a side effect of making the call, because the browser made the call. Now the
 * tool call arriving in the transcript is the browser's first news of it, so the screen is opened
 * from here. Without this the panel stays shut and a person watching sees a Bot claim to have
 * clicked something they never saw.
 */
function OpenTheScreen({ botId }: { botId: string }) {
  useEffect(() => {
    reportComputerActivity(botId);
  }, [botId]);
  return null;
}

/**
 * A compact transcript line that distinguishes policy refusals from ordinary failures.
 */
function ActionLine({
  botId,
  label,
  detail,
  running,
  refused,
  failed,
}: {
  botId: string;
  label: string;
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
}) {
  return (
    <>
      <OpenTheScreen botId={botId} />
      <ToolLine
        detail={detail}
        failed={failed}
        label={label}
        refused={refused}
        running={running}
      />
    </>
  );
}

/** Whether a result is an ordinary failure rather than a refusal, so the two can render differently. */
function didNotWork(outcome: ComputerOutcome): boolean {
  return outcome.ok === false && outcome.refused !== true;
}

const NOTHING = z.object({});
/** Optional, because a render must cope with arguments that are still streaming in. */
const REF = z.object({ ref: z.string().optional() });

export function ComputerTools() {
  const bot = useActiveBotHolder();

  useRenderTool(
    {
      name: "computer_navigate",
      parameters: NOTHING,
      render: ({ status }) => (
        <div className="my-2">
          <OpenTheScreen botId={bot.current} />
          <ComputerView
            active={status !== "complete"}
            computerId={bot.current}
          />
        </div>
      ),
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "computer_read",
      parameters: NOTHING,
      // Reading the open page changes nothing and needs no line; navigate owns the screen.
      render: () => <OpenTheScreen botId={bot.current} />,
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "computer_snapshot",
      parameters: NOTHING,
      render: ({ result, status }) => {
        const outcome = outcomeOf(result);
        const elements = Array.isArray(outcome.elements)
          ? outcome.elements
          : [];
        return (
          <ActionLine
            botId={bot.current}
            detail={
              elements.length
                ? `${elements.length} thing${elements.length === 1 ? "" : "s"} it can act on`
                : undefined
            }
            label="Read the page"
            running={status !== "complete"}
          />
        );
      },
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "computer_type",
      parameters: REF,
      render: ({ parameters, result, status }) => (
        <ActionLine
          botId={bot.current}
          // Never show typed values; identify only the target field.
          detail={labelOf(result) ?? parameters?.ref}
          failed={didNotWork(outcomeOf(result))}
          label="Filled in"
          refused={outcomeOf(result).refused === true}
          running={status !== "complete"}
        />
      ),
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "computer_click",
      parameters: REF,
      render: ({ parameters, result, status }) => {
        const outcome = outcomeOf(result);
        return (
          <ActionLine
            botId={bot.current}
            detail={
              // Show the refusal reason instead of an internal element ref.
              outcome.refused === true
                ? String(outcome.reason ?? "")
                : (labelOf(result) ?? parameters?.ref)
            }
            failed={didNotWork(outcome)}
            label="Clicked"
            refused={outcome.refused === true}
            running={status !== "complete"}
          />
        );
      },
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "computer_key",
      parameters: z.object({ key: z.string().optional() }),
      render: ({ parameters, result, status }) => (
        <ActionLine
          botId={bot.current}
          detail={parameters?.key}
          failed={didNotWork(outcomeOf(result))}
          label="Pressed"
          refused={outcomeOf(result).refused === true}
          running={status !== "complete"}
        />
      ),
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "computer_request_secret",
      parameters: NOTHING,
      // The masked prompt is drawn by ComputerView, which reads the computer's own control state.
      // Nothing about a secret passes through the transcript, including the fact one was asked for.
      render: () => <OpenTheScreen botId={bot.current} />,
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "report_refusal",
      parameters: NOTHING,
      // A self-reported decline is audit evidence. The Bot says the same thing in its own words in
      // the message beside this, so a line here would say it twice.
      render: () => <></>,
    },
    [],
  );

  useRenderTool(
    {
      name: "computer_request_help",
      parameters: NOTHING,
      // Drawn by ComputerView as the take-the-wheel prompt.
      render: () => <OpenTheScreen botId={bot.current} />,
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "computer_list_files",
      parameters: NOTHING,
      render: ({ result, status }) => {
        const outcome = outcomeOf(result);
        const entries = Array.isArray(outcome.entries) ? outcome.entries : [];
        return (
          <ActionLine
            botId={bot.current}
            detail={
              outcome.refused === true || didNotWork(outcome)
                ? String(outcome.reason ?? "")
                : entries.length
                  ? `${entries.length} item${entries.length === 1 ? "" : "s"} in the workspace`
                  : "nothing saved yet"
            }
            failed={didNotWork(outcome)}
            label="Listed files"
            refused={outcome.refused === true}
            running={status !== "complete"}
          />
        );
      },
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "computer_read_file",
      parameters: z.object({ path: z.string().optional() }),
      render: ({ parameters, result, status }) => {
        const outcome = outcomeOf(result);
        return (
          <ActionLine
            botId={bot.current}
            detail={
              outcome.refused === true
                ? String(outcome.reason ?? "")
                : parameters?.path
            }
            failed={didNotWork(outcome)}
            label="Read file"
            refused={outcome.refused === true}
            running={status !== "complete"}
          />
        );
      },
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "computer_write_file",
      parameters: z.object({
        path: z.string().optional(),
        append: z.boolean().optional(),
      }),
      render: ({ parameters, result, status }) => {
        const outcome = outcomeOf(result);
        return (
          <ActionLine
            botId={bot.current}
            // Show the path, never file contents.
            detail={
              outcome.refused === true
                ? String(outcome.reason ?? "")
                : parameters?.path
            }
            failed={didNotWork(outcome)}
            label={parameters?.append === true ? "Added to file" : "Saved file"}
            refused={outcome.refused === true}
            running={status !== "complete"}
          />
        );
      },
    },
    [bot.current],
  );

  useRenderTool(
    {
      name: "computer_scroll",
      parameters: NOTHING,
      render: ({ result, status }) => (
        <ActionLine
          botId={bot.current}
          failed={didNotWork(outcomeOf(result))}
          label="Scrolled"
          refused={outcomeOf(result).refused === true}
          running={status !== "complete"}
        />
      ),
    },
    [bot.current],
  );

  return null;
}
