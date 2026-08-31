import { describe, expect, test } from "bun:test";
import {
  mostRecentBotChat,
  resolveBotChat,
  shouldAttemptAdoption,
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

describe("mostRecentBotChat", () => {
  // Defect 4: the roster arrives pinned-first, then by recency (see `RECENCY` in
  // server/src/roster/order.ts), so a naive "first matching row" reads as "the pinned one," not "the
  // one this person actually used most recently." `BotChatStore.mostRecent` orders on recency alone
  // (`coalesce(last_message_at, created_at)`), so this has to agree with that, not with roster order.
  const OLDER_PINNED: RosterItem = {
    ...ROW,
    id: "botchat_pinned_old",
    pinned: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const NEWER_UNPINNED: RosterItem = {
    ...ROW,
    id: "botchat_unpinned_new",
    pinned: false,
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  test("a newer unpinned chat beats an older pinned one, even sitting first in roster order", () => {
    // The array below is in the order the roster actually arrives: pinned first. Taking the first
    // entry would return the pinned-but-stale row; this must not.
    const roster = [OLDER_PINNED, NEWER_UNPINNED];
    expect(mostRecentBotChat(roster, "agent_1")?.id).toBe(
      "botchat_unpinned_new",
    );
  });

  test("order in the input does not matter — same answer either way", () => {
    const roster = [NEWER_UNPINNED, OLDER_PINNED];
    expect(mostRecentBotChat(roster, "agent_1")?.id).toBe(
      "botchat_unpinned_new",
    );
  });

  test("falls back to createdAt when lastMessageAt is null on both — today's only signal", () => {
    // Until a separate fix lands, nothing stamps `lastMessageAt` on a bot chat, so this is the
    // ordinary shape of the data, not an edge case.
    expect(OLDER_PINNED.lastMessageAt).toBeNull();
    expect(NEWER_UNPINNED.lastMessageAt).toBeNull();
    const roster = [OLDER_PINNED, NEWER_UNPINNED];
    expect(mostRecentBotChat(roster, "agent_1")?.id).toBe(
      "botchat_unpinned_new",
    );
  });

  test("lastMessageAt outranks createdAt when present", () => {
    const recentlyMessaged: RosterItem = {
      ...OLDER_PINNED,
      id: "botchat_old_but_just_messaged",
      lastMessageAt: "2026-08-31T00:00:00.000Z",
    };
    const roster = [recentlyMessaged, NEWER_UNPINNED];
    expect(mostRecentBotChat(roster, "agent_1")?.id).toBe(
      "botchat_old_but_just_messaged",
    );
  });

  test("ignores rows for a different Bot and rows that are channels, not bot chats", () => {
    const otherAgent: RosterItem = {
      ...NEWER_UNPINNED,
      id: "botchat_other_agent",
      agentIds: ["agent_2"],
    };
    const channel: RosterItem = {
      ...NEWER_UNPINNED,
      id: "channel_1",
      kind: "channel",
      createdAt: "2026-08-31T00:00:00.000Z",
    };
    expect(
      mostRecentBotChat([otherAgent, channel, OLDER_PINNED], "agent_1")?.id,
    ).toBe("botchat_pinned_old");
  });

  test("nothing matching returns null", () => {
    expect(mostRecentBotChat([], "agent_1")).toBeNull();
  });
});

describe("shouldAttemptAdoption", () => {
  // Defect 2: a browser upgrading into this feature has no `bot_chats` rows yet — `mostRecent` reads
  // `null` — and used to go straight to create, before the remembered thread ever got a chance to be
  // rescued. This is the pure decision behind the fix: "about to create, and something is
  // remembered" is the one case that must not create without trying to adopt first.
  test("a browser upgrading in — no rows yet, but a remembered thread — attempts adoption before create", () => {
    expect(
      shouldAttemptAdoption({ mostRecent: null, remembered: "thread_1" }),
    ).toBe(true);
  });

  test("a genuinely first visit — no rows, nothing remembered — has nothing to adopt", () => {
    expect(shouldAttemptAdoption({ mostRecent: null, remembered: null })).toBe(
      false,
    );
  });

  test("a row already exists — nothing to gain from checking; the chat screen's hook is the belt", () => {
    expect(
      shouldAttemptAdoption({
        mostRecent: "botchat_1",
        remembered: "thread_1",
      }),
    ).toBe(false);
  });

  test("a row already exists and nothing is remembered either — plainly nothing to do", () => {
    expect(
      shouldAttemptAdoption({ mostRecent: "botchat_1", remembered: null }),
    ).toBe(false);
  });
});

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
