import { describe, expect, test } from "bun:test";
import {
  assistanceResponseOutcome,
  assistanceToken,
} from "../src/routes/_authed/assist";

describe("Slack assistance route status mapping", () => {
  test("accepts only a non-empty opaque token", () => {
    expect(assistanceToken({ token: "  sealed  " })).toBe("sealed");
    expect(assistanceToken({ token: "" })).toBeNull();
    expect(assistanceToken({ token: 123 })).toBeNull();
  });

  test("maps only a validated agent response to a ready destination", () => {
    expect(assistanceResponseOutcome(200, { agentId: "risk analyst" })).toEqual(
      {
        kind: "ready",
        href: "/bot?agent=risk%20analyst",
      },
    );
    expect(assistanceResponseOutcome(200, { agentId: "" })).toEqual({
      kind: "error",
    });
  });

  test("keeps invalid, wrong-user, and retryable failures non-navigable", () => {
    expect(assistanceResponseOutcome(403, { agentId: "forged" })).toEqual({
      kind: "wrong-user",
    });
    expect(assistanceResponseOutcome(410, { agentId: "stale" })).toEqual({
      kind: "invalid",
    });
    expect(assistanceResponseOutcome(500, { agentId: "leaked" })).toEqual({
      kind: "error",
    });
  });
});
