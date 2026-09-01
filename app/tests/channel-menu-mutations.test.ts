import { afterEach, expect, test } from "bun:test";
import {
  MutationObserver,
  QueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { hasUnseenActivity } from "../src/components/app-sidebar/app-sidebar";
import {
  boundedActivityText,
  createChannelMutationOptions,
  deleteChannelMutationOptions,
  markChannelReadMutationOptions,
  recordChannelActivityMutationOptions,
  setChannelArchivedMutationOptions,
  setChannelPinnedMutationOptions,
} from "../src/lib/channels/mutations";
import { channelKeys, channelQueryOptions } from "../src/lib/channels/queries";
import {
  rosterKeys,
  type RosterItem,
  type RosterPage,
} from "../src/lib/roster/queries";

const realFetch = globalThis.fetch;
const realConsoleError = console.error;

afterEach(() => {
  globalThis.fetch = realFetch;
  // Put back even when a test failed before it could: `bun test` runs every file in one process, so
  // a swapped `console.error` left behind swallows the next file's output as well as this one's.
  console.error = realConsoleError;
});

/** The console lines a failure writes, which is the only place a refused report is said. */
function capturingConsoleError(): string[] {
  const lines: string[] = [];
  console.error = ((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as typeof console.error;
  return lines;
}

function rosterItem(
  id: string,
  overrides: Partial<RosterItem> = {},
): RosterItem {
  return {
    kind: "channel",
    id,
    name: id,
    agentIds: ["agent-1"],
    threadId: `thread-${id}`,
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

function rosterPage(items: RosterItem[]): InfiniteData<RosterPage> {
  return {
    pages: [{ items, nextCursor: null }],
    pageParams: [""],
  };
}

type SeenRequest = { url: string; init: RequestInit | undefined };

function capturingFetch(status: number, body: unknown) {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return seen;
}

function invalidationRecorder() {
  const invalidated: unknown[] = [];
  // Recorded separately from the invalidations, because they are opposites: an invalidation asks for
  // a refetch, and a removal asks for the cache entry to stop existing. Delete does both, to two
  // different keys, and the assertions have to be able to tell them apart.
  const removed: unknown[] = [];
  const queryClient = {
    invalidateQueries: async (filter: unknown) => {
      invalidated.push(filter);
    },
    removeQueries: (filter: unknown) => {
      removed.push(filter);
    },
  } as unknown as QueryClient;
  return { queryClient, invalidated, removed };
}

test("pinning PUTs the flag to the channel's pin route and invalidates the roster", async () => {
  const seen = capturingFetch(200, { pinned: true });
  const { queryClient, invalidated } = invalidationRecorder();
  const options = setChannelPinnedMutationOptions(queryClient);

  await options.mutationFn?.({ channelId: "channel-1", pinned: true });
  await options.onSuccess?.(
    undefined as never,
    { channelId: "channel-1", pinned: true },
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/channels/channel-1/pin");
  expect(seen[0]?.init?.method).toBe("PUT");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ pinned: true });
  // Roster only: a pin doesn't touch the AgentChannel detail payload, so there is nothing under
  // channelKeys worth invalidating over it.
  expect(invalidated).toEqual([{ queryKey: ["roster"] }]);
});

test("deleting sends DELETE to the channel route and invalidates the roster", async () => {
  const seen = capturingFetch(204, undefined);
  const { queryClient, invalidated } = invalidationRecorder();
  const options = deleteChannelMutationOptions(queryClient);

  await options.mutationFn?.("channel-1");
  await options.onSuccess?.(
    undefined as never,
    "channel-1",
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/channels/channel-1");
  expect(seen[0]?.init?.method).toBe("DELETE");
  // Roster only: the sidebar is the only reader of the channel list, and it reads the roster.
  expect(invalidated).toEqual([{ queryKey: ["roster"] }]);
});

test("a refused delete surfaces the server's sentence", async () => {
  capturingFetch(409, {
    error:
      "This channel is defined by the deployment package, so it cannot be deleted here.",
  });
  const { queryClient } = invalidationRecorder();
  const options = deleteChannelMutationOptions(queryClient);

  await expect(options.mutationFn?.("channel-1")).rejects.toThrow(
    "This channel is defined by the deployment package, so it cannot be deleted here.",
  );
});

test("creating a channel invalidates the roster, not just the channels list", async () => {
  const seen = capturingFetch(200, {
    channel: {
      id: "channel-1",
      name: "Assistant channel",
      agentIds: ["agent-1"],
      threadId: "thread-1",
      active: true,
    },
  });
  const { queryClient, invalidated } = invalidationRecorder();
  const options = createChannelMutationOptions(queryClient);

  await options.mutationFn?.(["agent-1"]);
  await options.onSuccess?.(
    undefined as never,
    ["agent-1"],
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/channels");
  expect(seen[0]?.init?.method).toBe("POST");
  // Pin, archive and delete all invalidate the roster because that is what the sidebar reads;
  // creating a channel has to do the same or a freshly started channel never appears in the sidebar.
  expect(invalidated).toEqual([
    { queryKey: ["channels"] },
    { queryKey: ["roster"] },
  ]);
});

/**
 * Archiving a channel, which had no test at all on the branch that introduced it — proven by
 * mutation: switching it to POST, or dropping the body, left the whole app suite green. Its bot-chat
 * twin was covered, so the gap read as an oversight rather than a decision.
 */

test("archiving PUTs the flag to the channel's archive route and invalidates the roster", async () => {
  const seen = capturingFetch(200, { archived: true });
  const { queryClient, invalidated } = invalidationRecorder();
  const options = setChannelArchivedMutationOptions(queryClient);

  await options.mutationFn?.({ archived: true, channelId: "channel-1" });
  await options.onSuccess?.(
    undefined as never,
    { archived: true, channelId: "channel-1" },
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/channels/channel-1/archive");
  expect(seen[0]?.init?.method).toBe("PUT");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ archived: true });
  /*
   * Roster only, matching the bot chat's archive. `AgentChannel` carries `archived` and nothing in
   * the browser reads it off a single-channel read — the sidebar row and its menu read the roster —
   * so a detail invalidation here would be a refetch with no reader, which is invisible in every way
   * except this assertion.
   */
  expect(invalidated).toEqual([{ queryKey: rosterKeys.all }]);
  expect(invalidated).not.toContainEqual({
    queryKey: channelKeys.detail("channel-1"),
  });
});

test("restoring sends the flag back the other way", async () => {
  // One mutation for both directions, so a body built from anything but the variables would archive
  // a channel somebody asked to restore.
  const seen = capturingFetch(200, { archived: false });
  const { queryClient } = invalidationRecorder();
  const options = setChannelArchivedMutationOptions(queryClient);

  await options.mutationFn?.({ archived: false, channelId: "channel-1" });

  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ archived: false });
});

test("a refused archive and a refused restore each say which one failed", async () => {
  // The fallback is only reached when the server sent no sentence of its own, and it is picked from
  // the variables: being told "could not archive" after asking to restore is worse than a bare error.
  capturingFetch(500, {});
  const { queryClient } = invalidationRecorder();
  const options = setChannelArchivedMutationOptions(queryClient);

  await expect(
    options.mutationFn?.({ archived: true, channelId: "channel-1" }),
  ).rejects.toThrow("Could not archive this channel");
  await expect(
    options.mutationFn?.({ archived: false, channelId: "channel-1" }),
  ).rejects.toThrow("Could not restore this channel");
});

test("a refused archive surfaces the server's own sentence over the fallback", async () => {
  capturingFetch(409, {
    error:
      "This channel is defined by the deployment package, so it cannot be archived here.",
  });
  const { queryClient } = invalidationRecorder();
  const options = setChannelArchivedMutationOptions(queryClient);

  await expect(
    options.mutationFn?.({ archived: true, channelId: "channel-1" }),
  ).rejects.toThrow(
    "This channel is defined by the deployment package, so it cannot be archived here.",
  );
});

test("marking read PUTs the read route and patches lastReadAt in place", async () => {
  const seen = capturingFetch(204, undefined);
  const queryClient = new QueryClient();
  // Seeded in two of the three statuses (not just Active) so the ["active","archived","all"] loop
  // inside patchRosterRead is proven to reach more than the first entry it happens to try.
  queryClient.setQueryData(
    rosterKeys.list("active"),
    rosterPage([rosterItem("channel-1")]),
  );
  queryClient.setQueryData(
    rosterKeys.list("archived"),
    rosterPage([rosterItem("channel-1", { archived: true })]),
  );
  const options = markChannelReadMutationOptions(queryClient);

  options.onMutate?.("channel-1");
  await options.mutationFn?.("channel-1");

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/channels/channel-1/read");
  expect(seen[0]?.init?.method).toBe("PUT");
  // The dot clears from the cache before the wire answered, and nothing was invalidated:
  // there is no onSuccess to queue a refetch that would race the socket's own patches.
  expect(options.onSuccess).toBeUndefined();

  // RosterPage's array field is `items`, not `channels` — get that name wrong in the shared patch
  // helper and this silently no-ops (the spread keeps the original, still-null lastReadAt) rather
  // than throwing, which is exactly the class of bug this assertion exists to catch.
  const active = queryClient.getQueryData<InfiniteData<RosterPage>>(
    rosterKeys.list("active"),
  );
  const archived = queryClient.getQueryData<InfiniteData<RosterPage>>(
    rosterKeys.list("archived"),
  );
  expect(active?.pages[0]?.items[0]?.lastReadAt).not.toBeNull();
  expect(archived?.pages[0]?.items[0]?.lastReadAt).not.toBeNull();
});

test("a message stamped by a clock ahead of ours still reads as seen after marking", async () => {
  capturingFetch(204, undefined);
  const queryClient = new QueryClient();
  const futureLastMessageAt = new Date(Date.now() + 60_000).toISOString();
  // The future-clock guard lives inside `patchRosterRead`, the only place this mutation patches a
  // cache: a reader's clock running behind the writer's must not leave the row still reading as
  // unseen, so the patched lastReadAt has to catch up to (or pass) lastMessageAt, not just "now".
  queryClient.setQueryData(
    rosterKeys.list("active"),
    rosterPage([
      rosterItem("channel-1", { lastMessageAt: futureLastMessageAt }),
    ]),
  );
  const options = markChannelReadMutationOptions(queryClient);

  options.onMutate?.("channel-1");

  const rosterPatched = queryClient.getQueryData<InfiniteData<RosterPage>>(
    rosterKeys.list("active"),
  );
  const rosterRow = rosterPatched?.pages[0]?.items[0];
  expect(rosterRow?.lastReadAt).not.toBeNull();
  expect((rosterRow?.lastReadAt as string) >= futureLastMessageAt).toBe(true);
  /*
   * And the join with the predicate that reads the row. The clamp sets `lastReadAt` to EXACTLY
   * `lastMessageAt` here, so the dot clears only because `hasUnseenActivity` compares them with `>`.
   * Under `>=` both halves would still pass their own tests while the dot stayed lit forever on
   * precisely the rows the clamp exists to fix.
   */
  expect(rosterRow).toBeDefined();
  expect(hasUnseenActivity(rosterRow as RosterItem)).toBe(false);
});

/**
 * WHAT A FAILED REQUEST SAYS, which for the most likely failure of all was the browser's own words.
 *
 * `client` only reached its `fallback` sentence inside `if (!response.ok)`, and a `fetch` that never
 * got a response REJECTS rather than answering — offline, DNS, CORS. So the string a person read was
 * Chrome's "Failed to fetch" or Safari's "Load failed", rendered by the sidebar as an `EmptyTitle`
 * with `role="alert"` under a Try again button. Four call sites shared the one root cause, so this
 * pins it at one of them: every `fallback:` in the codebase now means what its docblock says.
 */

test("a request that never reached the server says the endpoint's own sentence", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  const { queryClient } = invalidationRecorder();
  const options = deleteChannelMutationOptions(queryClient);

  let caught: unknown;
  try {
    await options.mutationFn?.("channel-1");
  } catch (error) {
    caught = error;
  }

  expect((caught as Error).message).toBe("Could not delete this channel");
  // The browser's wording is kept rather than thrown away: a console still has it, and anything that
  // needs to tell "the server said no" from "there was no server" still can.
  expect((caught as Error).cause).toBeInstanceOf(TypeError);
});

/**
 * Reporting a channel's activity, and the twin of the bot chat defect: the response was discarded, so
 * a 400 on a bad timestamp, a 413, a 401 on an expired session and any 500 were indistinguishable
 * from the 204 that means it worked. Driven through query-core rather than by hand, because the
 * `onError` that says it out loud is only reached that way.
 */

test("a refused channel report is said out loud instead of vanishing", async () => {
  const seen = capturingFetch(400, {
    error: "Timestamp must be an ISO-8601 date and time with a time zone.",
  });
  const logged = capturingConsoleError();
  const observer = new MutationObserver(
    new QueryClient(),
    recordChannelActivityMutationOptions(),
  );
  const unsubscribe = observer.subscribe(() => {});

  await expect(
    observer.mutate({
      agentId: null,
      at: "2026-08-25T12:00",
      channelId: "channel-1",
      text: "Ship it",
    }),
  ).rejects.toThrow(
    "Timestamp must be an ISO-8601 date and time with a time zone.",
  );
  unsubscribe();

  expect(seen[0]?.url).toBe("/api/channels/channel-1/activity");
  expect(JSON.parse(String(logged[0]))).toMatchObject({
    type: "channel-activity-not-recorded",
    channelId: "channel-1",
    error: "Timestamp must be an ISO-8601 date and time with a time zone.",
  });
});

/**
 * The cap both reporters send through, which exists so a long message loses the preview nobody would
 * have seen rather than losing the whole report — the timestamp and the un-archiving included. The
 * server refuses anything over 16,000 UTF-16 units outright, and it is the whole request it refuses.
 */

test("a message the route would accept is passed through unchanged", () => {
  // Including one that is exactly the length the route allows: the cut is for what it refuses.
  expect(boundedActivityText("Ship it")).toBe("Ship it");
  expect(boundedActivityText("x".repeat(16_000))).toHaveLength(16_000);
});

test("a message over the cap is cut to it", () => {
  expect(boundedActivityText("x".repeat(16_001))).toHaveLength(16_000);
});

test("the cut never lands between the halves of one character", () => {
  /*
   * A cut inside a surrogate pair leaves a lone surrogate on the end, which the server's `flatten`
   * strips to a space — so the row would render a space where a character used to be. The same rule,
   * and the same reason, as `boundedInput` in server/src/roster/preview.ts.
   */
  const pair = "\u{1f680}"; // Two UTF-16 units.
  const splitAtTheCap = `${"x".repeat(15_999)}${pair}${pair}`;

  const cut = boundedActivityText(splitAtTheCap);

  expect(cut).toHaveLength(15_999);
  expect(cut.charCodeAt(15_998)).toBe("x".charCodeAt(0));
  // And the ordinary case, where the cap does not land inside a pair, keeps the whole 16,000.
  expect(boundedActivityText(`${"x".repeat(16_000)}${pair}`)).toHaveLength(
    16_000,
  );
});

/**
 * WHAT MARKING READ LEAVES ALONE, which is a guarantee and not an optimisation.
 *
 * `patchRosterRead` rebuilt `pages`, every page object and every `items` array in all three lists on
 * every call — including the lists that cannot hold the row — while documenting itself as a no-op on
 * those. What hid it is React Query's structural sharing inside `setQueryData`, which puts the old
 * references back where the new value is equal. `applyRosterEvent` refuses to lean on exactly that
 * ("real, but incidental, and gone the moment anybody sets `structuralSharing: false`", because
 * `RosterRow`'s memo wants a guarantee), and this test turns the same knob off so the guarantee is
 * the only thing left holding.
 */

test("marking read returns the identical cache for a list that does not hold the row", async () => {
  capturingFetch(204, undefined);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { structuralSharing: false } },
  });
  // Two pages in Active, the row on the second: a list that holds the row still has pages that do
  // not, and those must survive too.
  queryClient.setQueryData(rosterKeys.list("active"), {
    pageParams: ["", "cursor-1"],
    pages: [
      { items: [rosterItem("channel-9")], nextCursor: "cursor-1" },
      { items: [rosterItem("channel-1")], nextCursor: null },
    ],
  } satisfies InfiniteData<RosterPage>);
  queryClient.setQueryData(
    rosterKeys.list("archived"),
    rosterPage([rosterItem("channel-2", { archived: true })]),
  );
  queryClient.setQueryData(
    rosterKeys.list("all"),
    rosterPage([rosterItem("channel-1")]),
  );
  const before = {
    active: queryClient.getQueryData<InfiniteData<RosterPage>>(
      rosterKeys.list("active"),
    ),
    archived: queryClient.getQueryData<InfiniteData<RosterPage>>(
      rosterKeys.list("archived"),
    ),
  };
  // Through query-core, so `onMutate` is invoked by the machinery that invokes it in the app.
  const observer = new MutationObserver(
    queryClient,
    markChannelReadMutationOptions(queryClient),
  );
  const unsubscribe = observer.subscribe(() => {});

  await observer.mutate("channel-1");
  unsubscribe();

  const after = {
    active: queryClient.getQueryData<InfiniteData<RosterPage>>(
      rosterKeys.list("active"),
    ),
    all: queryClient.getQueryData<InfiniteData<RosterPage>>(
      rosterKeys.list("all"),
    ),
    archived: queryClient.getQueryData<InfiniteData<RosterPage>>(
      rosterKeys.list("archived"),
    ),
  };

  // Archived cannot hold this row, so nothing about it changed — including its identity.
  expect(after.archived).toBe(before.archived);
  // Active holds it on page two, so page one is untouched and page two is rebuilt.
  expect(after.active).not.toBe(before.active);
  expect(after.active?.pages[0]).toBe(before.active?.pages[0]);
  expect(after.active?.pages[1]).not.toBe(before.active?.pages[1]);
  // And the patch itself still happened, in both lists that hold the row.
  expect(after.active?.pages[1]?.items[0]?.lastReadAt).not.toBeNull();
  expect(after.all?.pages[0]?.items[0]?.lastReadAt).not.toBeNull();
});

/**
 * THE ID IN THE PATH, which was interpolated raw at every one of these sites.
 *
 * Not merely unsafe — silently wrong, and wrong in the worst available direction. An id carrying
 * `%3F` arrives at the server as `/api/channels/x?y`, which reads the id as `x` and answers about a
 * DIFFERENT conversation: a pin, an archive or a delete aimed at one channel landing on another.
 * `channelPath` is the only way to build one of these now, so the unencoded form is not a thing a
 * sibling can be written in.
 */

test("every write against a channel encodes the id into its path", async () => {
  const seen = capturingFetch(204, undefined);
  const { queryClient } = invalidationRecorder();
  // A slash and a question mark: the two that change which route, and which row, the server reads.
  const id = "channel/1?other=1";

  await setChannelPinnedMutationOptions(queryClient).mutationFn?.({
    channelId: id,
    pinned: true,
  });
  await setChannelArchivedMutationOptions(queryClient).mutationFn?.({
    archived: true,
    channelId: id,
  });
  await markChannelReadMutationOptions(queryClient).mutationFn?.(id);
  await deleteChannelMutationOptions(queryClient).mutationFn?.(id);
  await recordChannelActivityMutationOptions().mutationFn?.({
    agentId: null,
    at: "2026-08-25T12:00:00.000Z",
    channelId: id,
    text: "Ship it",
  });

  const encoded = encodeURIComponent(id);
  expect(seen.map((request) => request.url)).toEqual([
    `/api/channels/${encoded}/pin`,
    `/api/channels/${encoded}/archive`,
    `/api/channels/${encoded}/read`,
    `/api/channels/${encoded}`,
    `/api/channels/${encoded}/activity`,
  ]);
  // And the whole point of the encoding: no site sent a path the server would read as another id.
  for (const request of seen) {
    expect(request.url).not.toContain("?other=");
  }
});

test("reading one channel encodes the id too", async () => {
  const seen = capturingFetch(200, { channel: { id: "channel-1" } });
  const id = "channel/1?other=1";

  await channelQueryOptions(id).queryFn?.(undefined as never);

  expect(seen[0]?.url).toBe(`/api/channels/${encodeURIComponent(id)}`);
});

/**
 * WHAT CREATING A CHANNEL HANDS BACK, which the caller reads `.threadId` and `.id` off immediately
 * (`useStartChannel` in lib/channels/start.ts seeds, stashes and navigates on all three fields).
 *
 * The envelope used to be unwrapped here, outside `client` and outside every guard: a 200 carrying a
 * proxy's HTML error page threw a raw `SyntaxError`, and a 200 whose envelope had drifted resolved
 * `undefined` typed as `AgentChannel` — a success, with no error for any screen to render, followed by
 * a `TypeError` on the first field read.
 */

test("creating a channel returns the channel out of its envelope", async () => {
  capturingFetch(200, {
    channel: {
      active: true,
      agentIds: ["agent-1"],
      archived: false,
      id: "channel-1",
      name: "Assistant channel",
      threadId: "thread-1",
    },
  });
  const { queryClient } = invalidationRecorder();

  const created = await createChannelMutationOptions(queryClient).mutationFn?.([
    "agent-1",
  ]);

  expect(created?.id).toBe("channel-1");
  expect(created?.threadId).toBe("thread-1");
});

test("a create whose envelope carries no channel fails instead of resolving nothing", async () => {
  capturingFetch(200, { chanel: { id: "channel-1" } });
  const { queryClient } = invalidationRecorder();

  await expect(
    createChannelMutationOptions(queryClient).mutationFn?.(["agent-1"]),
  ).rejects.toThrow("Could not start a channel");
});

test("a create answered with something that is not JSON says the endpoint's sentence", async () => {
  globalThis.fetch = (async () =>
    new Response("<html>502</html>", {
      headers: { "content-type": "text/html" },
      status: 200,
    })) as unknown as typeof fetch;
  const { queryClient } = invalidationRecorder();

  await expect(
    createChannelMutationOptions(queryClient).mutationFn?.(["agent-1"]),
  ).rejects.toThrow("Could not start a channel");
});

/**
 * WHAT DELETING LEAVES BEHIND, which for five minutes was a working copy of the conversation.
 *
 * `confirmDelete` (app-sidebar/roster-row.tsx) navigates home BEFORE it deletes, deliberately and for
 * a good reason of its own. The consequence is that the detail query is unobserved by the time this
 * `onSuccess` runs — so an invalidation would have refetched nothing, and doing nothing left the
 * cached row to sit out the client's default five-minute `gcTime`. Pressing Back inside that window
 * rendered the deleted conversation from cache, complete with a working composer, until the refetch
 * behind it came back 404.
 */

test("deleting removes the deleted channel's detail cache", async () => {
  capturingFetch(204, undefined);
  const queryClient = new QueryClient();
  queryClient.setQueryData(channelKeys.detail("channel-1"), {
    active: true,
    agentIds: ["agent-1"],
    archived: false,
    id: "channel-1",
    name: "Assistant channel",
    threadId: "thread-1",
  });
  const options = deleteChannelMutationOptions(queryClient);

  await options.mutationFn?.("channel-1");
  await options.onSuccess?.(
    undefined as never,
    "channel-1",
    undefined as never,
    undefined as never,
  );

  expect(
    queryClient.getQueryData(channelKeys.detail("channel-1")),
  ).toBeUndefined();
});

test("deleting removes only the deleted channel, and leaves the others alone", async () => {
  capturingFetch(204, undefined);
  const { queryClient, invalidated, removed } = invalidationRecorder();
  const options = deleteChannelMutationOptions(queryClient);

  await options.mutationFn?.("channel-1");
  await options.onSuccess?.(
    undefined as never,
    "channel-1",
    undefined as never,
    undefined as never,
  );

  // The one key, not the `channelKeys.all` prefix: another channel's cached detail is still true, and
  // the sidebar is still the only reader of the list, which is what the roster invalidation serves.
  expect(removed).toEqual([{ queryKey: channelKeys.detail("channel-1") }]);
  expect(invalidated).toEqual([{ queryKey: rosterKeys.all }]);
});
