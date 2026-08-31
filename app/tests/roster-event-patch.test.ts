import { describe, expect, test } from "bun:test";
import type { RosterItem, RosterPage } from "../src/lib/roster/queries";
import {
  applyRosterEvent,
  type RosterActivityEvent,
} from "../src/lib/channels/use-channel-events";

/** A minimal but fully-typed roster item, so tests build real objects rather than casts. */
function item(id: string, overrides: Partial<RosterItem> = {}): RosterItem {
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
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

function cache(...pages: RosterItem[][]) {
  return {
    pages: pages.map((items): RosterPage => ({ items, nextCursor: null })),
    pageParams: pages.map(() => ""),
  };
}

function event(
  overrides: Partial<RosterActivityEvent> & { id: string },
): RosterActivityEvent {
  return {
    kind: "channel",
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    ...overrides,
  };
}

describe("an ordinary activity event", () => {
  test("patches the row inside the page that holds it and re-sorts that page", () => {
    const data = cache([
      item("a", { lastMessageAt: "2024-03-01T00:00:00.000Z" }),
      item("b"),
    ]);

    const patched = applyRosterEvent(
      data,
      event({
        id: "b",
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
      }),
    );

    expect(patched).not.toBe("unknown");
    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    expect(patched.pages[0]?.items.map((row) => row.id)).toEqual(["b", "a"]);
    expect(patched.pages[0]?.items[0]?.lastMessage).toBe("Said something.");
  });

  test("is unknown when no page holds the row, so the caller refetches", () => {
    expect(applyRosterEvent(cache([item("a")]), event({ id: "z" }))).toBe(
      "unknown",
    );
  });
});

/**
 * A row somebody deleted in another tab, or on another replica.
 *
 * The tab that issued the delete moves itself; every other tab only ever hears about it here, so
 * without this the row stays on their roster until something else makes them refetch.
 */
describe("a deleted row", () => {
  test("is removed from the page that held it", () => {
    const data = cache([item("a"), item("b")], [item("c")]);

    const patched = applyRosterEvent(data, event({ id: "b", deleted: true }));

    expect(patched).not.toBe("unknown");
    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    expect(patched.pages[0]?.items.map((row) => row.id)).toEqual(["a"]);
    // The other page is untouched, object identity included, so its rows do not re-render.
    expect(patched.pages[1]).toBe(data.pages[1]);
  });

  test("is never spread onto the row instead of removing it", () => {
    const patched = applyRosterEvent(
      cache([item("a")]),
      event({ id: "a", deleted: true }),
    );

    expect(patched).not.toBe("unknown");
    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    // The failure this guards is a row left on the roster carrying `deleted: true`, which renders
    // as an ordinary conversation whose every query now 404s.
    expect(patched.pages[0]?.items).toEqual([]);
  });

  test("changes nothing when this cache never had the row", () => {
    const data = cache([item("a")]);

    // Unlike an ordinary event, an unknown id here is not a stale roster: the row is already gone
    // from this cache, so there is nothing to patch and nothing to refetch for.
    expect(applyRosterEvent(data, event({ id: "z", deleted: true }))).toBe(
      data,
    );
  });
});

/**
 * A pin this person made in one of their own tabs.
 *
 * Scoped to them by the server, so arriving here means it is the reader's own pin.
 */
describe("a pin", () => {
  test("patches only the pinned flag, leaving the last message alone", () => {
    const data = cache([
      item("a", {
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
        lastMessageAgentId: "agent-1",
      }),
    ]);

    const patched = applyRosterEvent(data, event({ id: "a", pinned: true }));

    expect(patched).not.toBe("unknown");
    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    expect(patched.pages[0]?.items[0]).toEqual({
      ...(data.pages[0]?.items[0] as RosterItem),
      pinned: true,
    });
  });

  test("unpins the same way", () => {
    const patched = applyRosterEvent(
      cache([item("a", { pinned: true })]),
      event({ id: "a", pinned: false }),
    );

    expect(patched).not.toBe("unknown");
    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    expect(patched.pages[0]?.items[0]?.pinned).toBe(false);
  });

  test("returns the same cache when the row already says so", () => {
    const data = cache([item("a", { pinned: true })]);

    // A duplicate, or the tab that made the pin hearing its own event back. Identity preserved, so
    // React re-renders nothing at all.
    expect(applyRosterEvent(data, event({ id: "a", pinned: true }))).toBe(data);
  });
});

describe("applyRosterEvent", () => {
  test("patches a bot chat row by id, without being told its kind", () => {
    const data = cache([item("botchat_1", { kind: "bot_chat" })]);
    const patched = applyRosterEvent(
      data,
      event({ kind: "bot_chat", id: "botchat_1", lastMessage: "Hello" }),
    );

    // Ids are globally unique, so a row is found by id and `kind` is only needed to render it.
    expect(patched).not.toBe("unknown");
    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    expect(patched.pages[0]?.items[0]?.lastMessage).toBe("Hello");
  });

  test("asks for a refetch when a row is archived", () => {
    const data = cache([item("channel_1")]);

    // The row moves between the Active, Archived, and All lists. That is a page-membership change,
    // not a field change, and patching it would leave the row in two lists at once.
    expect(
      applyRosterEvent(data, event({ id: "channel_1", archived: true })),
    ).toBe("refetch");
  });

  test("asks for a refetch when a row is restored", () => {
    const data = cache([item("channel_1", { archived: true })]);
    expect(
      applyRosterEvent(data, event({ id: "channel_1", archived: false })),
    ).toBe("refetch");
  });

  test("asks for a refetch when activity restored an archived row", () => {
    const data = cache([item("channel_1", { archived: true })]);

    // An activity event that carries `archived: false` did two things at once. The move matters more.
    expect(
      applyRosterEvent(
        data,
        event({ id: "channel_1", lastMessage: "Back", archived: false }),
      ),
    ).toBe("refetch");
  });

  test("still patches ordinary activity without a refetch", () => {
    const data = cache([item("channel_1"), item("channel_2")]);
    const patched = applyRosterEvent(
      data,
      event({
        id: "channel_2",
        lastMessage: "Newest",
        lastMessageAt: "2026-08-31T10:00:00.000Z",
      }),
    );

    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    // Re-sorted inside its page, as before: activity is the one thing that reorders the list.
    expect(patched.pages[0]?.items[0]?.id).toBe("channel_2");
  });

  test("removes a deleted row rather than asking for a refetch", () => {
    const data = cache([item("channel_1"), item("channel_2")]);
    const patched = applyRosterEvent(
      data,
      event({ id: "channel_1", deleted: true }),
    );

    // Deleted rows are in no list at all, so removal is complete and a refetch would be wasted work.
    if (patched === "unknown" || patched === "refetch")
      throw new Error("patched");
    expect(patched.pages[0]?.items.map((row) => row.id)).toEqual(["channel_2"]);
  });

  test("ignores an archive for a row this cache does not hold", () => {
    const data = cache([item("channel_1")]);

    // Already absent from this list, so there is nothing to move and nothing to refetch for.
    expect(
      applyRosterEvent(data, event({ id: "botchat_9", archived: true })),
    ).toBe(data);
  });
});
