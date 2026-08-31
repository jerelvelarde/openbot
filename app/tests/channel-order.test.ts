import { expect, test } from "bun:test";
import { pinnedFirst } from "../src/components/app-sidebar/app-sidebar";
import type { RosterItem } from "../src/lib/roster/queries";

/** A minimal but fully-typed roster row, so tests build real objects rather than casts. */
function channel(id: string, pinned: boolean): RosterItem {
  return {
    kind: "channel",
    id,
    name: id,
    agentIds: [],
    threadId: `thread-${id}`,
    active: true,
    archived: false,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    pinned,
    lastReadAt: null,
  };
}

test("holds pinned channels at the top, leaving each group in its arrival order", () => {
  /*
   * Interleaved, which is what the cache can hold between refetches: the server hands back
   * pinned-first, and then the socket patches a pin onto a loaded row without moving it, or re-sorts
   * a page by recency alone. This function is the render-level mirror that closes that window.
   *
   * A STABLE PARTITION IS ALL THIS CLAIMS. Recency is the server's rule and the socket patcher's; it
   * is not this function's, and these fixtures could not test it if it were — every row here shares a
   * `createdAt` and has no `lastMessageAt` at all. What is asserted is that a, c, e come out in that
   * order and b, d in theirs, which is what "whatever arrived" means.
   */
  const channels = [
    channel("a", false),
    channel("b", true),
    channel("c", false),
    channel("d", true),
    channel("e", false),
  ];

  expect(pinnedFirst(channels).map((c) => c.id)).toEqual([
    "b",
    "d",
    "a",
    "c",
    "e",
  ]);
});

test("leaves an all-unpinned roster in its original order", () => {
  const channels = [
    channel("a", false),
    channel("b", false),
    channel("c", false),
  ];

  expect(pinnedFirst(channels).map((c) => c.id)).toEqual(["a", "b", "c"]);
});
