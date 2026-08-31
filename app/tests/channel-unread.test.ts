import { expect, test } from "bun:test";
import {
  hasUnseenActivity,
  isUnread,
} from "../src/components/app-sidebar/app-sidebar";
import type { ChannelSummary } from "../src/lib/channels/queries";
import type { RosterItem } from "../src/lib/roster/queries";

/** A minimal but fully-typed summary, so tests build real objects rather than casts. */
function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "channel-1",
    name: "Assistant channel",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
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

test("your own last message never counts as unseen", () => {
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
