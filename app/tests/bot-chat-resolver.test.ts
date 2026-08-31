import { describe, expect, test } from "bun:test";
import {
  resolveBotChat,
  shouldResolveBotChat,
} from "../src/routes/_authed/_app/bot";
import type { RosterItem } from "../src/lib/roster/queries";

describe("resolveBotChat", () => {
  test("opens the conversation this person was last in", () => {
    expect(resolveBotChat({ mostRecent: "botchat_1" })).toEqual({
      open: "botchat_1",
    });
  });

  test("starts one when there is nothing to open", () => {
    // A first visit, or a person who archived everything: `?agent=` must still land somewhere usable.
    expect(resolveBotChat({ mostRecent: null })).toEqual({ create: true });
  });
});

const ROW: RosterItem = {
  kind: "bot_chat",
  id: "botchat_1",
  name: "Bot",
  agentIds: ["agent_1"],
  threadId: "thread_1",
  active: true,
  archived: false,
  lastMessage: null,
  lastMessageAt: null,
  lastMessageAgentId: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  pinned: false,
  lastReadAt: null,
};

describe("shouldResolveBotChat", () => {
  /*
   * This is the regression test for the duplicate-conversation defect: `roster.isPending` reads
   * `false` in the *error* state too, where `data` is still `undefined`, so a guard written against
   * `isPending` misreads a failed load as "nothing to open" and forks a second `bot_chats` row. If
   * `shouldResolveBotChat` is ever rewritten to treat `data: undefined` as "safe to act" — which is
   * what a revert to `isPending`-shaped reasoning would do — this assertion fails.
   */
  test("a failed roster load (data undefined) does not act", () => {
    expect(shouldResolveBotChat({ data: undefined, started: false })).toBe(
      false,
    );
  });

  // The case the fix must not break: a first visit, or a person who archived everything, resolves
  // the roster to a genuinely empty array rather than to `undefined`, and that has to act — it is
  // the entire reason this resolver exists.
  test("a genuinely empty roster ([]) still acts", () => {
    expect(shouldResolveBotChat({ data: [], started: false })).toBe(true);
  });

  test("a resolved roster with rows acts", () => {
    expect(shouldResolveBotChat({ data: [ROW], started: false })).toBe(true);
  });

  test("does not act twice, once a run has already started", () => {
    expect(shouldResolveBotChat({ data: [ROW], started: true })).toBe(false);
  });
});
