import { afterEach, expect, test } from "bun:test";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  AdoptConflictError,
  adoptBotChatMutationOptions,
  markBotChatReadMutationOptions,
  setBotChatArchivedMutationOptions,
} from "../src/lib/bot-chats/mutations";
import { botChatKeys } from "../src/lib/bot-chats/queries";
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
    kind: "bot_chat",
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

test("marking read PUTs the read route and patches lastReadAt in every roster status list", async () => {
  const seen = capturingFetch(204, undefined);
  const queryClient = new QueryClient();
  // Seeded in all three statuses: a bot chat's row only ever lives in the roster (unlike a channel,
  // which also has channelKeys.list()), so the loop over ["active","archived","all"] is the only
  // thing that clears the dot, and this proves it reaches more than the first status it tries.
  queryClient.setQueryData(
    rosterKeys.list("active"),
    rosterPage([rosterItem("botchat-1")]),
  );
  queryClient.setQueryData(
    rosterKeys.list("archived"),
    rosterPage([rosterItem("botchat-1", { archived: true })]),
  );
  queryClient.setQueryData(
    rosterKeys.list("all"),
    rosterPage([rosterItem("botchat-1")]),
  );
  const options = markBotChatReadMutationOptions(queryClient);

  options.onMutate?.("botchat-1");
  await options.mutationFn?.("botchat-1");

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/bot-chats/botchat-1/read");
  expect(seen[0]?.init?.method).toBe("PUT");

  // RosterPage's array field is `items`, not `channels` — get that name wrong in the shared patch
  // helper and this silently no-ops (the spread keeps the original, still-null lastReadAt) rather
  // than throwing, which is exactly the class of bug this assertion exists to catch.
  const active = queryClient.getQueryData<InfiniteData<RosterPage>>(
    rosterKeys.list("active"),
  );
  const archived = queryClient.getQueryData<InfiniteData<RosterPage>>(
    rosterKeys.list("archived"),
  );
  const all = queryClient.getQueryData<InfiniteData<RosterPage>>(
    rosterKeys.list("all"),
  );
  expect(active?.pages[0]?.items[0]?.lastReadAt).not.toBeNull();
  expect(archived?.pages[0]?.items[0]?.lastReadAt).not.toBeNull();
  expect(all?.pages[0]?.items[0]?.lastReadAt).not.toBeNull();
  // No onSuccess: a mark-read that did not land is a dot that returns on the next refetch, and an
  // invalidation here would race the socket's own patches for nothing.
  expect(options.onSuccess).toBeUndefined();
});

test("a message stamped by a clock ahead of ours still reads as seen after marking", async () => {
  capturingFetch(204, undefined);
  const queryClient = new QueryClient();
  const futureLastMessageAt = new Date(Date.now() + 60_000).toISOString();
  queryClient.setQueryData(
    rosterKeys.list("active"),
    rosterPage([
      rosterItem("botchat-1", { lastMessageAt: futureLastMessageAt }),
    ]),
  );
  const options = markBotChatReadMutationOptions(queryClient);

  options.onMutate?.("botchat-1");

  const patched = queryClient.getQueryData<InfiniteData<RosterPage>>(
    rosterKeys.list("active"),
  );
  const row = patched?.pages[0]?.items[0];
  // A reader's clock running behind the writer's must not leave the row still reading as unseen:
  // the patched lastReadAt has to catch up to (or pass) lastMessageAt, not just "now".
  expect(row?.lastReadAt).not.toBeNull();
  expect((row?.lastReadAt as string) >= futureLastMessageAt).toBe(true);
});

test("archiving invalidates both the roster and the bot chat's own detail query", async () => {
  const seen = capturingFetch(200, { archived: true });
  const { queryClient, invalidated } = invalidationRecorder();
  const options = setBotChatArchivedMutationOptions(queryClient);

  await options.mutationFn?.({ botChatId: "botchat-1", archived: true });
  await options.onSuccess?.(
    undefined as never,
    { botChatId: "botchat-1", archived: true },
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/bot-chats/botchat-1/archive");
  expect(seen[0]?.init?.method).toBe("PUT");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ archived: true });
  // Unlike delete, archive invalidates the detail query too: the Bot chat screen renders `archived`
  // straight off it, and a tab holding that screen open needs the refetch to stop showing stale state.
  expect(invalidated).toEqual([
    { queryKey: ["roster"] },
    { queryKey: botChatKeys.detail("botchat-1") },
  ]);
});

/**
 * `adoptBotChatMutationOptions` goes through `tryClient` rather than `client` specifically so a 409
 * can be told apart from every other failure by status rather than by matching the server's exact
 * sentence. These three cases are what that buys: a normal success still comes back as the unwrapped
 * `BotChat`, a 409 comes back as `AdoptConflictError` (which `useLegacyThreadAdoption` treats as
 * success — see app/src/lib/copilot/bot-thread.ts), and every other failure status must NOT produce
 * that type, or a network blip or a real bug would look like "somebody already has this thread" and
 * the remembered id would be discarded instead of kept for a retry.
 */

test("adopting a thread returns the unwrapped bot chat and invalidates the roster", async () => {
  const seen = capturingFetch(200, {
    botChat: {
      id: "botchat-1",
      agentId: "agent-1",
      threadId: "thread-1",
      title: null,
      active: true,
      archived: false,
    },
  });
  const { queryClient, invalidated } = invalidationRecorder();
  const options = adoptBotChatMutationOptions(queryClient);

  const botChat = await options.mutationFn?.({
    agentId: "agent-1",
    threadId: "thread-1",
  });
  await options.onSuccess?.(
    botChat as never,
    { agentId: "agent-1", threadId: "thread-1" },
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/bot-chats/adopt");
  expect(seen[0]?.init?.method).toBe("POST");
  expect(botChat).toEqual({
    id: "botchat-1",
    agentId: "agent-1",
    threadId: "thread-1",
    title: null,
    active: true,
    archived: false,
  });
  expect(invalidated).toEqual([{ queryKey: rosterKeys.all }]);
});

test("a 409 on adopt throws AdoptConflictError, not a plain Error the caller has to parse", async () => {
  capturingFetch(409, { error: "That conversation is no longer available." });
  const { queryClient } = invalidationRecorder();
  const options = adoptBotChatMutationOptions(queryClient);

  await expect(
    options.mutationFn?.({ agentId: "agent-1", threadId: "thread-1" }),
  ).rejects.toBeInstanceOf(AdoptConflictError);
});

test("a non-409 failure on adopt does NOT throw AdoptConflictError — the asymmetry the retry loop depends on", async () => {
  // Any status other than 409 (offline surfaces the same way as a 5xx here: the fetch still resolves
  // with a non-ok Response in this harness) must leave the remembered thread id alone so the next
  // visit can try adoption again. If this ever threw AdoptConflictError too, `useLegacyThreadAdoption`
  // would `forget` the id on a failure that never actually claimed the thread, orphaning it.
  capturingFetch(500, { error: "Intelligence is unreachable." });
  const { queryClient } = invalidationRecorder();
  const options = adoptBotChatMutationOptions(queryClient);

  let caught: unknown;
  try {
    await options.mutationFn?.({ agentId: "agent-1", threadId: "thread-1" });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(AdoptConflictError);
});
