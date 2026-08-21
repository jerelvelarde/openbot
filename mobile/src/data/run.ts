/**
 * A turn as it happens.
 *
 * Starting a run is an HTTP POST whose response is an AG-UI event stream, and until now this app
 * threw that stream away and waited for the next poll — so a reply landed as a lump, seconds late,
 * with no sign that anything was happening in between. This reads it.
 *
 * Two things are deliberate:
 *
 *  - **It is not a source of truth.** The deployment's own thread is, and the transcript redraws from
 *    it a moment later. What is folded here is the same turn while it is still being written, so the
 *    labels and outcomes are derived by the SAME code the durable thread goes through — otherwise a
 *    line would change its wording the instant the poll caught up, which reads as a glitch.
 *  - **It is XHR, not `fetch`.** React Native's `fetch` has no streaming body: `response.body` is
 *    null, so there is nothing to read incrementally. `XMLHttpRequest` exposes `responseText` as it
 *    arrives on both React Native and the browser, which is also how every SSE library for React
 *    Native works underneath. No dependency, one code path, both targets.
 */

import type { LiveTurn, ToolLine } from "./types";

/**
 * A tool's name, as a person reads it.
 *
 * Shared between a call that has only started and the result that resolves it, so the line does not
 * appear to rename itself halfway through.
 */
export function labelOf(name: string): string {
  return name.replace(/^computer_/, "").replace(/_/g, " ");
}

/**
 * Turn a tool call and its result into the one line a transcript shows.
 *
 * The outcome keys are the ones the gateway produces, so a refusal keeps its rule and a failure stays
 * distinguishable from a refusal. Arguments are never rendered: the label and the resolved element
 * are enough, and a transcript is not a place for whatever was typed into a password field.
 */
export function toolLineOf(result: string): ToolLine | undefined {
  let parsed: {
    tool?: string;
    action?: string;
    ok?: boolean;
    refused?: boolean;
    reason?: string;
    rule?: string;
    element?: { name?: string };
    text?: string;
  };
  try {
    parsed = JSON.parse(result) as typeof parsed;
  } catch {
    // Not JSON: the runtime stringifies a thrown handler this way. Shown as a failure rather than
    // guessed at, because the alternative is a line that claims something worked.
    return {
      label: "tool",
      outcome: "failed",
      detail: result.slice(0, 120),
    };
  }

  const name = parsed.tool ?? parsed.action;
  // Without a name there is nothing to say. Drawing an anonymous outcome would be a line a person
  // cannot audit, which is worse than no line.
  if (!name) return undefined;

  const label = labelOf(name);

  if (parsed.refused) {
    return {
      label,
      outcome: "refused",
      ...(parsed.element?.name || parsed.reason
        ? { detail: parsed.element?.name ?? parsed.reason }
        : {}),
      ...(typeof parsed.rule === "string" ? { rule: parsed.rule } : {}),
    };
  }
  if (parsed.ok === false) {
    return {
      label,
      outcome: "failed",
      ...(parsed.reason ? { detail: parsed.reason } : {}),
    };
  }
  return {
    label,
    outcome: "allowed",
    // The element as the SERVER resolved it, never the ref the model sent.
    ...(parsed.element?.name ? { detail: parsed.element.name } : {}),
  };
}

/** The AG-UI events this app has anything to draw for. Everything else is ignored, not mishandled. */
type AguiEvent = {
  type?: string;
  delta?: string;
  toolCallId?: string;
  toolCallName?: string;
  content?: string;
  message?: string;
  role?: string;
};

/**
 * Fold a run's events into the turn so far.
 *
 * Stateful on purpose: a delta is meaningless without what came before it, and a tool result arrives
 * long after the call it belongs to. Returns the whole turn each time rather than a patch, because
 * the caller renders it and React wants a value, not instructions.
 */
export function createTurnFold(): (event: unknown) => LiveTurn {
  let text = "";
  let failure: string | undefined;
  let done = false;
  const toolLines: ToolLine[] = [];
  /** Where each call's line sits, so its result resolves that line rather than adding another. */
  const lineOf = new Map<string, number>();

  return (raw: unknown) => {
    const event = (raw ?? {}) as AguiEvent;
    switch (event.type) {
      case "TEXT_MESSAGE_CONTENT":
      case "TEXT_MESSAGE_CHUNK":
        if (typeof event.delta === "string") text += event.delta;
        break;

      case "TOOL_CALL_START": {
        if (!event.toolCallId) break;
        // Drawn the moment it starts, which is the whole point: the several seconds a Bot spends
        // reading a page used to be several seconds of a blank screen.
        toolLines.push({
          id: event.toolCallId,
          label: labelOf(event.toolCallName ?? "tool"),
          outcome: "running",
        });
        lineOf.set(event.toolCallId, toolLines.length - 1);
        break;
      }

      case "TOOL_CALL_RESULT": {
        const at = event.toolCallId ? lineOf.get(event.toolCallId) : undefined;
        const resolved = toolLineOf(String(event.content ?? ""));
        if (at === undefined) {
          // A result for a call this stream never announced. Kept rather than dropped: something
          // happened, and a trail that hides what it cannot explain is worse than one that shows it.
          if (resolved) {
            toolLines.push({
              ...resolved,
              id: event.toolCallId ?? `orphan_${toolLines.length}`,
            });
          }
          break;
        }
        // The label and the id survive from the call, so the line neither renames itself nor becomes
        // a different element as it resolves.
        const started = toolLines[at];
        toolLines[at] = resolved
          ? {
              ...resolved,
              id: started?.id,
              label: started?.label ?? resolved.label,
            }
          : {
              id: started?.id,
              label: started?.label ?? "tool",
              outcome: "allowed",
            };
        break;
      }

      case "RUN_ERROR":
        failure =
          typeof event.message === "string" && event.message
            ? event.message
            : "The Bot stopped without saying why.";
        done = true;
        break;

      case "RUN_FINISHED":
        done = true;
        break;

      default:
        break;
    }

    return {
      text,
      toolLines: [...toolLines],
      ...(failure ? { failure } : {}),
      done,
    };
  };
}

export type StreamOptions = {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** One decoded `data:` payload. Called as the stream arrives. */
  onData: (data: string) => void;
  /** Navigating away, or the screen going. Aborts the request. */
  signal?: AbortSignal;
};

/**
 * POST something, and read the event stream it answers with.
 *
 * Resolves when the stream ends. Rejects only on a transport failure or a non-2xx status: a run that
 * fails *inside* the stream says so as a `RUN_ERROR` event, and that is the turn's business rather
 * than the request's.
 */
export function streamRun(options: StreamOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", options.url);
    // The cookie, where there is one. Same-origin in a browser is how the web build is known.
    request.withCredentials = true;
    for (const [name, value] of Object.entries(options.headers)) {
      request.setRequestHeader(name, value);
    }

    /** How much of `responseText` has already been handed over. */
    let consumed = 0;
    /** A frame that arrived in pieces, waiting for its blank line. */
    let pending = "";

    const drain = () => {
      const whole = request.responseText;
      if (whole.length <= consumed) return;
      pending += whole.slice(consumed);
      consumed = whole.length;

      /*
       * Frames are separated by a blank line, and the last piece of the buffer is usually half of
       * one. Splitting and keeping the tail is what makes a partial frame wait rather than parse as
       * a broken one.
       */
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) options.onData(data);
      }
    };

    request.onreadystatechange = () => {
      // 3 is LOADING: some of the body has arrived and there is more coming. This is the only place
      // a stream can be read from an XHR, and it is why this is not `fetch`.
      if (request.readyState === 3) drain();
      if (request.readyState !== 4) return;
      drain();
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        reject(
          new Error(
            request.status === 0
              ? "This deployment could not be reached."
              : `That did not work (${request.status}).`,
          ),
        );
      }
    };
    request.onerror = () =>
      reject(new Error("This deployment could not be reached."));
    request.onabort = () => resolve();

    options.signal?.addEventListener("abort", () => request.abort());
    request.send(options.body);
  });
}
