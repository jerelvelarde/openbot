import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  applyRosterEvent,
  applyRosterEventToCaches,
  type RosterActivityEvent,
  type RosterCache,
  readRosterEvent,
} from "../src/lib/channels/use-channel-events";
import {
  ROSTER_STATUSES,
  type RosterItem,
  type RosterPage,
  rosterKeys,
} from "../src/lib/roster/queries";

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

  test("orders a conversation nobody has used yet by when it was made", () => {
    const data = cache([
      item("older", { createdAt: "2024-01-01T00:00:00.000Z" }),
      item("newer", { createdAt: "2024-06-01T00:00:00.000Z" }),
    ]);

    // `byRecency` mirrors the server's `coalesce(last_message_at, created_at) desc`, and this is the
    // coalesce half of it: a row with no message at all still has to sort somewhere sensible, or the
    // list reorders itself the moment an event arrives and rows look like they jump for no reason.
    const patched = applyRosterEvent(
      data,
      event({ id: "older", lastMessage: "First words" }),
    );

    expect(patched).not.toBe("unknown");
    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    expect(patched.pages[0]?.items.map((row) => row.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  test("is unknown when no page in this list holds the row", () => {
    // Reported, not decided: three lists mean a row is legitimately absent from two of them, so what
    // the caller does about it is `applyRosterEventToCaches`'s business, tested below.
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

    // Both, because the narrowing guard below would otherwise swallow the whole assertion: a
    // regression to `"unknown"` on this path used to leave this test passing with nothing checked.
    expect(patched).not.toBe("unknown");
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

  test("refetches an archive for a row this cache does not hold", () => {
    const data = cache([item("channel_1")]);

    /*
     * The list that must GAIN the row is the one that does not hold it. Returning `data` here was
     * the bug that made restoring silently not propagate: an archived row is absent from Active by
     * definition, so a restore refetched nothing and the conversation stayed invisible.
     */
    expect(
      applyRosterEvent(data, event({ id: "botchat_9", archived: true })),
    ).toBe("refetch");
  });
});

/**
 * A duplicate of an event this cache has already applied.
 *
 * The pin branch has had this test since it was written; the activity branch never did, and that is
 * why nobody noticed its "nothing changed" branch could not be reached. A spread allocates, so no row
 * could ever still be identical afterwards, and the identity the memoized row relies on was coming
 * from React Query's structural sharing by accident rather than from this function by design.
 */
describe("a repeated activity event", () => {
  test("returns the same cache object when all three activity fields already match", () => {
    const data = cache([
      item("channel_1", {
        lastMessage: "Said something.",
        lastMessageAt: "2026-08-31T10:00:00.000Z",
        lastMessageAgentId: "agent-1",
      }),
      item("channel_2"),
    ]);

    expect(
      applyRosterEvent(
        data,
        event({
          id: "channel_1",
          lastMessage: "Said something.",
          lastMessageAt: "2026-08-31T10:00:00.000Z",
          lastMessageAgentId: "agent-1",
        }),
      ),
    ).toBe(data);
  });

  test("patches when any one of the three differs", () => {
    const data = cache([
      item("channel_1", { lastMessage: "Old", lastMessageAgentId: "agent-1" }),
    ]);
    const patched = applyRosterEvent(
      data,
      event({ id: "channel_1", lastMessage: "Old", lastMessageAgentId: null }),
    );

    // The agent changed and nothing else did. The row renders who spoke, so this is visible.
    expect(patched).not.toBe(data);
    expect(patched).not.toBe("unknown");
    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    expect(patched.pages[0]?.items[0]?.lastMessageAgentId).toBeNull();
  });
});

/**
 * The wire fields an event carries that a cached row must never learn.
 *
 * `kind` is the one that matters: the sidebar builds the row's link from it, so a row that took its
 * `kind` from an event would be opened at whichever route that event happened to name.
 */
describe("the fields copied onto a patched row", () => {
  test("takes only the three activity fields, never kind or the deprecated channelId", () => {
    const data = cache([item("channel_1", { kind: "channel" })]);

    const patched = applyRosterEvent(data, {
      // A mis-serialised or mismatched event: it names a channel row but claims to be a bot chat.
      kind: "bot_chat",
      id: "channel_1",
      channelId: "channel_1",
      lastMessage: "Said something.",
      lastMessageAt: "2026-08-31T10:00:00.000Z",
      lastMessageAgentId: "agent-1",
    });

    expect(patched).not.toBe("unknown");
    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    const row = patched.pages[0]?.items[0];
    // Still a channel, so `linkFor` still sends it to /channel/$channelId.
    expect(row?.kind).toBe("channel");
    expect(row).not.toHaveProperty("channelId");
    expect(row?.lastMessage).toBe("Said something.");
  });
});

/**
 * The loop over the three cached lists, which is where the interesting mistake lived.
 *
 * `applyRosterEvent` is pure and covered above. What was not covered was the caller that turns three
 * per-list answers into one decision — and that is exactly where every ordinary message came to
 * invalidate the entire roster.
 */
describe("applyRosterEventToCaches", () => {
  /** A real QueryClient, so structural sharing and key matching behave as they do in the app. */
  function recordingQueryClient() {
    const queryClient = new QueryClient();
    const invalidated: unknown[] = [];
    const invalidate = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((filters?: never) => {
      invalidated.push(filters);
      return invalidate(filters);
    }) as typeof queryClient.invalidateQueries;
    return { queryClient, invalidated };
  }

  function seed(
    queryClient: QueryClient,
    status: (typeof ROSTER_STATUSES)[number],
    data: RosterCache,
  ) {
    queryClient.setQueryData(rosterKeys.list(status), data);
  }

  test("does not invalidate anything for an ordinary event with all three lists cached", () => {
    const { queryClient, invalidated } = recordingQueryClient();
    const archived = item("channel_9", { archived: true });
    // The cache shape after one click on the Archived tab: the sidebar mounted Active, an open
    // conversation cached All, and Archived is now cached too — legitimately without the live row.
    seed(queryClient, "active", cache([item("channel_1"), item("channel_2")]));
    seed(queryClient, "archived", cache([archived]));
    seed(
      queryClient,
      "all",
      cache([item("channel_1"), item("channel_2"), archived]),
    );

    applyRosterEventToCaches(
      queryClient,
      event({
        id: "channel_2",
        lastMessage: "Newest",
        lastMessageAt: "2026-08-31T10:00:00.000Z",
      }),
    );

    // Zero. An active row missing from the Archived list is not a stale roster, and answering it with
    // an invalidation refetched every fetched page of every list on every message — and discarded the
    // patch the same event had just applied, which is the socket bypassing itself.
    expect(invalidated).toEqual([]);
    const active = queryClient.getQueryData<RosterCache>(
      rosterKeys.list("active"),
    );
    expect(active?.pages[0]?.items[0]?.id).toBe("channel_2");
    expect(active?.pages[0]?.items[0]?.lastMessage).toBe("Newest");
  });

  test("still refetches once for a row no cached list holds", () => {
    const { queryClient, invalidated } = recordingQueryClient();
    for (const status of ROSTER_STATUSES) {
      seed(queryClient, status, cache([item("channel_1")]));
    }

    // The stale-roster recovery, and the reason the fix cannot simply drop the "unknown" case: a row
    // in none of the three lists is one this tab has never heard of.
    applyRosterEventToCaches(
      queryClient,
      event({ id: "channel_404", lastMessage: "Who?" }),
    );

    expect(invalidated).toEqual([{ queryKey: rosterKeys.all }]);
  });

  test("refetches exactly once when a row moved between lists", () => {
    const { queryClient, invalidated } = recordingQueryClient();
    for (const status of ROSTER_STATUSES) {
      seed(queryClient, status, cache([item("channel_1")]));
    }

    applyRosterEventToCaches(
      queryClient,
      event({ id: "channel_1", archived: true }),
    );

    // One, not three: all three lists report the move, and one invalidation on the shared prefix
    // reaches every one of them.
    expect(invalidated).toEqual([{ queryKey: rosterKeys.all }]);
  });

  test("removes a deleted row from every list that held it, without a refetch", () => {
    const { queryClient, invalidated } = recordingQueryClient();
    for (const status of ROSTER_STATUSES) {
      seed(queryClient, status, cache([item("channel_1"), item("channel_2")]));
    }

    applyRosterEventToCaches(
      queryClient,
      event({ id: "channel_1", deleted: true }),
    );

    // A deleted row is in no list at all, so removal is complete and a refetch would be wasted work.
    expect(invalidated).toEqual([]);
    for (const status of ROSTER_STATUSES) {
      const list = queryClient.getQueryData<RosterCache>(
        rosterKeys.list(status),
      );
      expect(list?.pages[0]?.items.map((row) => row.id)).toEqual(["channel_2"]);
    }
  });
});

/**
 * Frames that are not events.
 *
 * A socket handler is not somewhere a throw can go: nothing catches it, and the tab simply stops
 * updating. And a frame dropped without a word is the same symptom with nothing in the log under it.
 */
describe("readRosterEvent", () => {
  const realError = console.error;

  afterEach(() => {
    console.error = realError;
  });

  function capturingConsole() {
    const lines: string[] = [];
    console.error = ((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }) as typeof console.error;
    return lines;
  }

  test("reads an ordinary frame and says nothing", () => {
    const lines = capturingConsole();

    expect(
      readRosterEvent(JSON.stringify(event({ id: "channel_1" })))?.id,
    ).toBe("channel_1");
    expect(lines).toEqual([]);
  });

  test("refuses a valid-JSON non-object rather than throwing inside setQueryData", () => {
    const lines = capturingConsole();

    // `JSON.parse("null")` succeeds, and `null` then throws a TypeError on `item.id === activity.id`
    // deep inside an updater — out of the socket handler, where nothing catches it.
    expect(readRosterEvent("null")).toBeUndefined();
    expect(lines).toHaveLength(1);
  });

  test("refuses a frame with no string id, which is the only way a row is found", () => {
    const lines = capturingConsole();

    expect(
      readRosterEvent(JSON.stringify({ kind: "channel" })),
    ).toBeUndefined();
    expect(lines).toHaveLength(1);
  });

  test("logs a structured line with a truncated payload, matching the server half", () => {
    const lines = capturingConsole();

    expect(readRosterEvent(`{"id":"${"x".repeat(500)}`)).toBeUndefined();
    const line = JSON.parse(lines[0] as string) as {
      type: string;
      payload: string;
      note: string;
    };
    // Named, so a log search finds it, and truncated, because the first 200 characters name the kind
    // and the id and that is what tells one cause apart from another.
    expect(line.type).toBe("roster-event-unreadable");
    expect(line.payload).toHaveLength(200);
    expect(line.note).toContain("could not read");
  });
});
