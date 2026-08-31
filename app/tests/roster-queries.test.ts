import { describe, expect, test } from "bun:test";
import {
  type RosterItem,
  type RosterPage,
  rosterKeys,
  rosterListQueryOptions,
} from "../src/lib/roster/queries";

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
    createdAt: "2026-08-31T09:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

describe("rosterKeys", () => {
  test("gives each status its own cache", () => {
    // Three statuses mean three cached infinite queries. Sharing a key would have Archived overwrite
    // Active's pages the moment either is fetched.
    expect(rosterKeys.list("active")).not.toEqual(rosterKeys.list("archived"));
    expect(rosterKeys.list("all")).toEqual(["roster", "list", "all"]);
  });

  test("nests every list under one prefix, so one invalidate reaches all three", () => {
    for (const status of ["active", "archived", "all"] as const) {
      expect(rosterKeys.list(status).slice(0, 1)).toEqual([...rosterKeys.all]);
    }
  });
});

describe("rosterListQueryOptions", () => {
  test("flattens pages for the caller", () => {
    const options = rosterListQueryOptions("active");
    const pages: RosterPage[] = [
      { items: [item("channel_1")], nextCursor: "one" },
      { items: [item("botchat_2", { kind: "bot_chat" })], nextCursor: null },
    ];

    // The sidebar and the socket both see one array in roster order; neither has to know it is paged.
    expect(
      options.select?.({ pages, pageParams: ["", "one"] })?.map((row) => row.id),
    ).toEqual(["channel_1", "botchat_2"]);
  });

  test("stops paging when the server says there is no next cursor", () => {
    const options = rosterListQueryOptions("active");
    expect(
      options.getNextPageParam({ items: [], nextCursor: null }),
    ).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: "more" })).toBe(
      "more",
    );
  });
});
