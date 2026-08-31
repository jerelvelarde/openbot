import { expect, test } from "bun:test";
import {
  hasUnseenActivity,
  isUnread,
} from "../src/components/app-sidebar/app-sidebar";
import type { RosterItem } from "../src/lib/roster/queries";

/** A minimal but fully-typed roster row, so tests build real objects rather than casts. */
function channel(overrides: Partial<RosterItem>): RosterItem {
  return {
    kind: "channel",
    id: "channel-1",
    name: "Assistant channel",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
    archived: false,
    lastMessage: "hello",
    lastMessageAt: "2026-08-25T12:00:00.000Z",
    lastMessageAgentId: "agent-1",
    createdAt: "2026-08-25T11:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

/** Same idea as `channel`, but a `bot_chat` roster row, for the two kinds `isUnread` must treat alike. */
function botChat(overrides: Partial<RosterItem>): RosterItem {
  return {
    kind: "bot_chat",
    id: "botchat_1",
    name: "My Bot",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
    archived: false,
    lastMessage: "hello",
    lastMessageAt: "2026-08-25T12:00:00.000Z",
    lastMessageAgentId: "agent-1",
    createdAt: "2026-08-25T11:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

test("a Bot message in a never-opened channel is unseen", () => {
  expect(hasUnseenActivity(channel({}))).toBe(true);
});

test("a Bot message newer than the read marker is unseen", () => {
  expect(
    hasUnseenActivity(channel({ lastReadAt: "2026-08-25T11:30:00.000Z" })),
  ).toBe(true);
});

test("a read marker after the last message means nothing is unseen", () => {
  expect(
    hasUnseenActivity(channel({ lastReadAt: "2026-08-25T12:30:00.000Z" })),
  ).toBe(false);
});

test("a read marker stamped at exactly the last message means nothing is unseen", () => {
  // The boundary is not academic: `patchRosterRead` (app/src/lib/roster/read-marker.ts) deliberately
  // stamps `lastReadAt` to *exactly* `lastMessageAt` when the writer's clock is ahead of the
  // reader's, so this is the one comparison the read marker manufactures on purpose. Relax the
  // predicate's `>` to `>=` and the dot would stay lit forever on precisely the rows that guard
  // exists to fix — and every other test here would still pass.
  expect(
    hasUnseenActivity(
      channel({
        lastMessageAt: "2026-08-25T12:00:00.000Z",
        lastReadAt: "2026-08-25T12:00:00.000Z",
      }),
    ),
  ).toBe(false);
});

test("a null agent id means a person, and today that person can only be you", () => {
  /*
   * NOT "your own message". `lastMessageAgentId` is null for a person — any person: the column
   * stores which agent spoke and no user id at all (see `Null for a person` on `messages` in
   * server/src/db/schema/core.ts), while `channel_memberships` is keyed on (channel_id, user_id) and
   * is multi-member by design, which is why deleting and archiving are worded "for everyone in it".
   *
   * So this asserts the predicate's behaviour, not the reading a person would put on it. It happens
   * to be the same thing today only because the server's one membership insert
   * (server/src/channels/routes.ts) writes the creator and nobody else, so a channel has exactly one
   * member. The first time a second member exists, a teammate's message will raise no dot — and this
   * test is the place to notice that rather than a place that has quietly sanctioned it.
   */
  expect(hasUnseenActivity(channel({ lastMessageAgentId: null }))).toBe(false);
});

test("a silent channel has nothing unseen", () => {
  expect(
    hasUnseenActivity(
      channel({
        lastMessage: null,
        lastMessageAt: null,
        lastMessageAgentId: null,
      }),
    ),
  ).toBe(false);
});

test("the open channel is never unread, however unseen its activity", () => {
  expect(isUnread(channel({}), "channel-1")).toBe(false);
  expect(isUnread(channel({}), "channel-2")).toBe(true);
  expect(isUnread(channel({}), undefined)).toBe(true);
});

/**
 * The row this defect was actually about: a bot chat is a `RosterItem` too, and its route param
 * is `botChatId`, not `channelId`. A caller that only ever resolved `params.channelId` handed
 * `isUnread` `undefined` for an open bot chat, which never equals the bot chat's own id — so the
 * conversation on screen lit its own dot the moment its Bot replied. `isUnread` itself is
 * kind-agnostic; these two cases exist so a caller that regresses this resolution has something to
 * fail against.
 */
test("the open bot chat is never unread, however unseen its activity", () => {
  expect(isUnread(botChat({}), "botchat_1")).toBe(false);
});

test("a bot chat that is not the open conversation is unread", () => {
  expect(isUnread(botChat({}), "botchat_2")).toBe(true);
});
