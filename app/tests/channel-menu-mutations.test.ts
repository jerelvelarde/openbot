import { afterEach, expect, test } from "bun:test";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  createChannelMutationOptions,
  deleteChannelMutationOptions,
  markChannelReadMutationOptions,
  setChannelPinnedMutationOptions,
} from "../src/lib/channels/mutations";
import {
  rosterKeys,
  type RosterItem,
  type RosterPage,
} from "../src/lib/roster/queries";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

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
  const queryClient = {
    invalidateQueries: async (filter: unknown) => {
      invalidated.push(filter);
    },
  } as unknown as QueryClient;
  return { queryClient, invalidated };
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
  // Pin and delete both invalidate the roster because the sidebar no longer reads channelKeys.list();
  // creating a channel has to do the same or a freshly started channel never appears in the sidebar.
  expect(invalidated).toEqual([
    { queryKey: ["channels"] },
    { queryKey: ["roster"] },
  ]);
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
});
