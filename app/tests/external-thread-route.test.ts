import { describe, expect, test } from "bun:test";
import { externalThreadTarget } from "../src/lib/external/queries";

describe("external Slack transcript target", () => {
  test("accepts the authenticated read-only target returned by OpenBot", () => {
    expect(
      externalThreadTarget({
        threadId: "channels-thread-1",
        agentId: "risk",
        agentName: "Risk Analyst",
        provider: "slack",
        readOnly: true,
      }),
    ).toEqual({
      threadId: "channels-thread-1",
      agentId: "risk",
      agentName: "Risk Analyst",
      provider: "slack",
      readOnly: true,
    });
  });

  test("rejects writable or malformed targets", () => {
    for (const value of [
      null,
      {},
      { threadId: "t", agentId: "a", agentName: "A", provider: "slack" },
      {
        threadId: "t",
        agentId: "a",
        agentName: "A",
        provider: "slack",
        readOnly: false,
      },
    ]) {
      expect(() => externalThreadTarget(value)).toThrow(
        "Could not load this Slack conversation",
      );
    }
  });
});
