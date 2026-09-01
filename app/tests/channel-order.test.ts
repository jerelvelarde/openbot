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

test("leaves the array it was handed in the order it arrived", () => {
  /*
   * The copy inside `pinnedFirst`, which every assertion above passes without.
   *
   * `Array.prototype.sort` sorts in place, and the array this function is handed is not its own: with
   * an empty search box `matchingItems` returns the caller's array unchanged, and the caller's array
   * is the one React Query's `select` memoized for the sidebar's roster observer. So dropping the copy
   * reorders the query's own data from inside a render — and no test above can notice, because they
   * all read the return value and this is a fact about the argument.
   *
   * Asserted on ids rather than on identity: `expect(arrived).not.toBe(sorted)` is the same trivial
   * pass under aliasing that the review found in `applyRosterEvent`'s copies, since an in-place sort
   * returns the same array it mutated and a copy returns a different one either way. The order of the
   * argument afterwards is the thing that is actually true or false.
   *
   * app/tests/roster-sidebar.test.ts is the other half: that the array reaching this function really
   * is the query's, asserted through a rendered sidebar rather than claimed in this comment.
   */
  const arrived = [channel("a", false), channel("b", true)];

  expect(pinnedFirst(arrived).map((c) => c.id)).toEqual(["b", "a"]);
  expect(arrived.map((c) => c.id)).toEqual(["a", "b"]);
});
