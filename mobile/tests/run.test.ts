import { describe, expect, test } from "bun:test";
import { createTurnFold, toolLineOf } from "../src/data/run";

/**
 * Folding a run's events into the turn on screen.
 *
 * This is the part of the companion that has no server and no React in it, and it is the part that
 * decides what a person watching a Bot work actually sees. The events are AG-UI's; the shapes here
 * are the ones the runtime emits.
 *
 * The rule these tests exist to hold: a line drawn while a call is in flight and the line drawn once
 * its result arrives are the SAME line. If the label changes as it resolves, a transcript rewrites
 * itself in front of somebody, which reads as a bug in the product rather than as progress.
 */

describe("a turn as it arrives", () => {
  test("text accumulates from deltas", () => {
    const fold = createTurnFold();
    fold({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" });
    fold({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "The total" });
    const turn = fold({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: " is £48,210.00.",
    });
    expect(turn.text).toBe("The total is £48,210.00.");
    expect(turn.done).toBe(false);
  });

  test("a call is drawn while it is running, and resolves in place", () => {
    const fold = createTurnFold();
    const started = fold({
      type: "TOOL_CALL_START",
      toolCallId: "c1",
      toolCallName: "computer_click",
    });
    // The id is the call's own, so the running line and the resolved line are one element.
    expect(started.toolLines).toEqual([
      { id: "c1", label: "click", outcome: "running" },
    ]);

    const done = fold({
      type: "TOOL_CALL_RESULT",
      toolCallId: "c1",
      content: JSON.stringify({
        tool: "computer_click",
        ok: true,
        element: { name: "Submit payment run" },
      }),
    });
    // One line, not two: the same call, now with an outcome.
    expect(done.toolLines).toHaveLength(1);
    expect(done.toolLines[0]).toEqual({
      id: "c1",
      label: "click",
      outcome: "allowed",
      detail: "Submit payment run",
    });
  });

  test("a refusal keeps the rule that caused it", () => {
    const fold = createTurnFold();
    fold({
      type: "TOOL_CALL_START",
      toolCallId: "c1",
      toolCallName: "computer_click",
    });
    const turn = fold({
      type: "TOOL_CALL_RESULT",
      toolCallId: "c1",
      content: JSON.stringify({
        tool: "computer_click",
        refused: true,
        reason: "The policy asks before anything called submit is activated.",
        rule: 'intent == "activate" && contains(element.name, "submit")',
      }),
    });
    expect(turn.toolLines[0]?.outcome).toBe("refused");
    expect(turn.toolLines[0]?.rule).toBe(
      'intent == "activate" && contains(element.name, "submit")',
    );
  });

  test("two calls in flight resolve to their own lines", () => {
    const fold = createTurnFold();
    fold({
      type: "TOOL_CALL_START",
      toolCallId: "a",
      toolCallName: "computer_navigate",
    });
    fold({
      type: "TOOL_CALL_START",
      toolCallId: "b",
      toolCallName: "computer_read_file",
    });
    const turn = fold({
      type: "TOOL_CALL_RESULT",
      toolCallId: "b",
      content: JSON.stringify({
        tool: "computer_read_file",
        ok: false,
        reason: "No such file.",
      }),
    });
    expect(turn.toolLines).toEqual([
      { id: "a", label: "navigate", outcome: "running" },
      {
        id: "b",
        label: "read file",
        outcome: "failed",
        detail: "No such file.",
      },
    ]);
  });

  test("a result for a call nobody announced is kept, not dropped", () => {
    // Something happened. A transcript that hides what it cannot explain is worse than one that
    // shows it without a matching call.
    const fold = createTurnFold();
    const turn = fold({
      type: "TOOL_CALL_RESULT",
      toolCallId: "unknown",
      content: JSON.stringify({ tool: "search_docs", ok: true }),
    });
    expect(turn.toolLines).toEqual([
      { id: "unknown", label: "search docs", outcome: "allowed" },
    ]);
  });

  test("a run that fails says why, and says it is over", () => {
    const fold = createTurnFold();
    const turn = fold({
      type: "RUN_ERROR",
      message: "The provider refused the request.",
    });
    expect(turn.failure).toBe("The provider refused the request.");
    expect(turn.done).toBe(true);
  });

  test("a run that fails without a message still says it is over", () => {
    const fold = createTurnFold();
    const turn = fold({ type: "RUN_ERROR" });
    expect(turn.failure).toBe("The Bot stopped without saying why.");
    expect(turn.done).toBe(true);
  });

  test("events this app draws nothing for change nothing", () => {
    const fold = createTurnFold();
    fold({ type: "TEXT_MESSAGE_CONTENT", delta: "Hello" });
    const turn = fold({ type: "STATE_SNAPSHOT", snapshot: { anything: true } });
    expect(turn.text).toBe("Hello");
    expect(turn.done).toBe(false);
  });

  test("a finished run is finished", () => {
    const fold = createTurnFold();
    expect(fold({ type: "RUN_FINISHED" }).done).toBe(true);
  });
});

describe("a tool result", () => {
  test("that is not JSON is a failure, not a success", () => {
    // The runtime stringifies a thrown handler this way. The alternative is a line claiming it worked.
    const line = toolLineOf("Error: boom");
    expect(line?.outcome).toBe("failed");
  });

  test("with no name is no line at all", () => {
    // An anonymous outcome is a line nobody can audit.
    expect(toolLineOf(JSON.stringify({ ok: true }))).toBeUndefined();
  });
});
