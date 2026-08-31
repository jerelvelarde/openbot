import { afterEach, describe, expect, test } from "bun:test";
import {
  ROSTER_STATUSES,
  type RosterItem,
  type RosterPage,
  rosterKeys,
  rosterListQueryOptions,
} from "../src/lib/roster/queries";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type SeenRequest = { url: string; init: RequestInit | undefined };

function capturingFetch(body: RosterPage) {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return seen;
}

/** What React Query hands a `queryFn`, narrowed to the one field this one reads. */
function fetchPage(
  options: ReturnType<typeof rosterListQueryOptions>,
  pageParam: string,
) {
  return options.queryFn({ pageParam } as never) as Promise<RosterPage>;
}

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
    // Walks the exported list rather than a copy of it, so a fourth status is covered here the day it
    // is added instead of being silently skipped.
    for (const status of ROSTER_STATUSES) {
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
      options
        .select?.({ pages, pageParams: ["", "one"] })
        ?.map((row) => row.id),
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

/**
 * The fetch itself, which was the untested half.
 *
 * Forwarding `status` is what makes three separate caches mean anything: with it hardcoded or dropped,
 * `rosterKeys.list(status)` still looks perfectly correct while the Archived and All tabs quietly
 * render Active rows. Mutation showed both of those surviving the suite, so both are asserted here.
 */
describe("rosterListQueryOptions' queryFn", () => {
  test("asks the server for the status this list is for", async () => {
    const seen = capturingFetch({ items: [], nextCursor: null });

    await fetchPage(rosterListQueryOptions("archived"), "");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/api/roster?status=archived");
  });

  test("asks for each status separately, so no two lists share a request", async () => {
    const seen = capturingFetch({ items: [], nextCursor: null });

    for (const status of ROSTER_STATUSES) {
      await fetchPage(rosterListQueryOptions(status), "");
    }

    expect(seen.map((request) => request.url)).toEqual([
      "/api/roster?status=active",
      "/api/roster?status=archived",
      "/api/roster?status=all",
    ]);
  });

  test("sends the cursor on for a later page, and nothing for the first", async () => {
    const seen = capturingFetch({ items: [], nextCursor: null });
    const options = rosterListQueryOptions("active");

    // The first page's param is the empty string, which is absence rather than a cursor: sent, the
    // server would page from "" and the list would fetch the same first page forever.
    await fetchPage(options, "");
    await fetchPage(options, "cursor-2");

    expect(seen[0]?.url).toBe("/api/roster?status=active");
    expect(seen[1]?.url).toBe("/api/roster?status=active&cursor=cursor-2");
  });

  test("returns the page the server sent", async () => {
    capturingFetch({ items: [item("channel_1")], nextCursor: "more" });

    const page = await fetchPage(rosterListQueryOptions("all"), "");

    expect(page.items.map((row) => row.id)).toEqual(["channel_1"]);
    expect(page.nextCursor).toBe("more");
  });

  test("throws the sentence a person reads when the server refuses", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    // The server sent no JSON message of its own, so the fallback is what reaches the screen. It names
    // the thing that failed, which "Request failed" would not.
    await expect(
      fetchPage(rosterListQueryOptions("active"), ""),
    ).rejects.toThrow("Could not load your conversations");
  });
});
