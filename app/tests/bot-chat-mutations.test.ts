import { afterEach, expect, test } from "bun:test";
import {
  MutationObserver,
  QueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { hasUnseenActivity } from "../src/components/app-sidebar/app-sidebar";
import {
  AdoptConflictError,
  adoptBotChatMutationOptions,
  deleteBotChatMutationOptions,
  markBotChatReadMutationOptions,
  recordBotChatActivityMutationOptions,
  setBotChatArchivedMutationOptions,
} from "../src/lib/bot-chats/mutations";
import {
  BotChatMissingError,
  botChatKeys,
  botChatQueryOptions,
} from "../src/lib/bot-chats/queries";
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

/**
 * A real `QueryClient` that records what was invalidated — needed where the mutation has to be run
 * by query-core rather than by hand, since that machinery reaches into the client's mutation cache.
 */
function spyingQueryClient() {
  const invalidated: unknown[] = [];
  const queryClient = new QueryClient();
  queryClient.invalidateQueries = (async (filter: unknown) => {
    invalidated.push(filter);
  }) as unknown as QueryClient["invalidateQueries"];
  return { queryClient, invalidated };
}

test("marking read PUTs the read route and patches lastReadAt in every roster status list", async () => {
  const seen = capturingFetch(204, undefined);
  const queryClient = new QueryClient();
  // Seeded in all three statuses: the roster is the only place a bot chat's row lives, so the loop
  // over ["active","archived","all"] inside patchRosterRead is the only thing that clears the dot,
  // and this proves it reaches more than the first status it happens to try.
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
  /*
   * And the join with the predicate that reads it, which is the half a string comparison cannot see.
   * `patchRosterRead` clamps `lastReadAt` up to EXACTLY `lastMessageAt` in this case, so the dot
   * clears only because `hasUnseenActivity` compares them with `>`. Under `>=` the two would still
   * each pass their own test while the dot stayed lit forever on precisely the rows this clamp exists
   * to fix.
   */
  expect(row).toBeDefined();
  expect(hasUnseenActivity(row as RosterItem)).toBe(false);
});

test("archiving PUTs the flag and invalidates the roster, which is the only reader of it", async () => {
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
  /*
   * Roster only, and the same shape as the channel's archive. This used to invalidate
   * `botChatKeys.detail` as well, on the grounds that the Bot chat screen renders `archived` off the
   * detail payload — it does not: the sidebar row and its menu are the only readers of `archived`
   * anywhere in the browser, both off `RosterItem`. Pinned here rather than left to the comment,
   * because a refetch nobody reads is invisible in every other way.
   */
  expect(invalidated).toEqual([{ queryKey: ["roster"] }]);
});

test("restoring says so in its own words when the server sends none", async () => {
  // Both directions go through one mutation, so the sentence a person reads is picked from the
  // variables. Restoring a conversation and being told archiving failed is worse than saying nothing.
  capturingFetch(500, {});
  const { queryClient } = invalidationRecorder();
  const options = setBotChatArchivedMutationOptions(queryClient);

  await expect(
    options.mutationFn?.({ botChatId: "botchat-1", archived: false }),
  ).rejects.toThrow("Could not restore this conversation");
});

test("deleting invalidates the roster and deliberately NOT the detail query", async () => {
  /*
   * The asymmetry with archive, which is documented as deliberate and was pinned by nothing: a
   * well-meaning "make these two consistent" edit would have passed. The open chat's detail query
   * would refetch into the fresh 404 and flash an error before the navigate-home lands.
   */
  const seen = capturingFetch(204, undefined);
  const { queryClient, invalidated } = invalidationRecorder();
  const options = deleteBotChatMutationOptions(queryClient);

  await options.mutationFn?.("botchat-1");
  await options.onSuccess?.(
    undefined as never,
    "botchat-1",
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/bot-chats/botchat-1");
  expect(seen[0]?.init?.method).toBe("DELETE");
  expect(invalidated).toEqual([{ queryKey: rosterKeys.all }]);
  expect(invalidated).not.toContainEqual({
    queryKey: botChatKeys.detail("botchat-1"),
  });
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
  // Any status other than 409 must leave the remembered thread id alone so the next visit can try
  // adoption again. If this ever threw AdoptConflictError too, `useLegacyThreadAdoption` would
  // `forget` the id on a failure that never actually claimed the thread, orphaning it.
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

test("a browser that is offline never reaches the status check at all", async () => {
  /*
   * The other half of the case above, and a genuinely different path: `tryClient` is a bare `fetch`,
   * so being offline REJECTS rather than answering with a status. Nothing in the mutation catches
   * that, which is the behaviour wanted — it surfaces as a plain `Error`, so the remembered thread id
   * is kept — but a test that only ever hands the code a non-ok `Response` would not have noticed if
   * it were otherwise.
   */
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
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

/**
 * Reporting activity, and the one refetch that hangs off it.
 *
 * These run the mutation through `MutationObserver` rather than calling `mutationFn`/`onSuccess` by
 * hand, because the defect they exist for lived in that machinery and was invisible to a hand-driven
 * test: `useMutation` is one observer shared by every call from one component
 * (node_modules/@tanstack/react-query/build/modern/useMutation.js — `new MutationObserver(client,
 * options)` held in state, `mutate` calling `observer.mutate(...)`), and this harness is the same
 * shape, subscription included.
 */

/** A fetch whose first call hangs until released, so two reports really are in flight at once. */
function gatedFetch() {
  const seen: SeenRequest[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    if (seen.length === 1) await gate;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { release: () => release?.(), seen };
}

const REPORTED_AT = "2026-08-25T12:00:00.000Z";

function report(overrides: { agentId: string | null; derivesTitle: boolean }) {
  return {
    at: REPORTED_AT,
    botChatId: "botchat-1",
    text: "Book the Tuesday flight",
    ...overrides,
  };
}

test("reporting POSTs the activity route, and the title flag stays out of the body", async () => {
  // `derivesTitle` is a decision about this browser's caches; the server derives the title from the
  // message itself. Sending it would invite a reader to think the server is being told what to do.
  const seen = capturingFetch(204, undefined);
  const { queryClient } = spyingQueryClient();
  const options = recordBotChatActivityMutationOptions(queryClient);

  await options.mutationFn?.(report({ agentId: null, derivesTitle: true }));

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/bot-chats/botchat-1/activity");
  expect(seen[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
    agentId: null,
    at: REPORTED_AT,
    text: "Book the Tuesday flight",
  });
});

test("the Bot's reply being reported mid-flight does not cancel the person's title refetch", async () => {
  /*
   * THE DEFECT. The refetch used to be handed to `mutate` as per-call options, and query-core keeps
   * those in a single field: `MutationObserver.mutate` does `this.#mutateOptions = options` and then
   * `this.#currentMutation?.removeObserver(this)` (@tanstack/query-core 5.102.2). So the Bot's reply
   * — reported with no callbacks of its own, moments after the person's turn and before a slow POST
   * could answer — both detached the observer from the person's mutation and overwrote the stored
   * callbacks, and the refetch was dropped in silence. What that looks like to a person: the
   * conversation never gains its title, so the sidebar goes on showing the Bot's name for every
   * conversation with that Bot for the rest of the session.
   */
  const { release } = gatedFetch();
  const { queryClient, invalidated } = spyingQueryClient();
  const observer = new MutationObserver(
    queryClient,
    recordBotChatActivityMutationOptions(queryClient),
  );
  // `useMutation` subscribes through `useSyncExternalStore`; without a listener, per-call callbacks
  // would not fire even for a single report and this test would pass for the wrong reason.
  const unsubscribe = observer.subscribe(() => {});

  const person = observer.mutate(report({ agentId: null, derivesTitle: true }));
  const bot = observer.mutate(
    report({ agentId: "agent-1", derivesTitle: false }),
  );

  await bot;
  release();
  await person;
  unsubscribe();

  expect(invalidated).toEqual([
    { queryKey: botChatKeys.detail("botchat-1") },
    { queryKey: rosterKeys.all },
  ]);
});

test("a report that is not the conversation's first words refetches nothing", async () => {
  // Every message a Bot says would otherwise refetch the detail query and the whole roster, and an
  // ordinary browsing turn is several messages.
  capturingFetch(204, undefined);
  const { queryClient, invalidated } = spyingQueryClient();
  const observer = new MutationObserver(
    queryClient,
    recordBotChatActivityMutationOptions(queryClient),
  );
  const unsubscribe = observer.subscribe(() => {});

  await observer.mutate(report({ agentId: "agent-1", derivesTitle: false }));
  unsubscribe();

  expect(invalidated).toEqual([]);
});

/**
 * Reading one conversation, which lives here beside the writes because it shares their whole point:
 * the browser needs the STATUS, not just a sentence. `client` throws a plain `Error` built from the
 * body's message and drops the status, so this read goes through `tryClient` the way
 * `adoptBotChatMutationOptions` does — and what hangs off it is which sentence a person reads when a
 * conversation will not open.
 */

test("a conversation that loads comes back unwrapped from its envelope", async () => {
  const seen = capturingFetch(200, {
    botChat: {
      active: true,
      agentId: "agent-1",
      archived: false,
      id: "botchat-1",
      threadId: "thread-1",
      title: "Tuesday flights",
    },
  });

  const botChat = await botChatQueryOptions("botchat-1").queryFn?.(
    undefined as never,
  );

  expect(seen[0]?.url).toBe("/api/bot-chats/botchat-1");
  expect(botChat).toMatchObject({ id: "botchat-1", title: "Tuesday flights" });
});

test("a 404 is the one failure that means the conversation is gone", async () => {
  // The screen says "This conversation is not here any more" for exactly this, and something else
  // for everything below. A stale link and somebody else's chat both land here — the server answers
  // 404 rather than 403 for the second, deliberately.
  capturingFetch(404, { error: "That conversation is no longer available." });

  await expect(
    botChatQueryOptions("botchat-1").queryFn?.(undefined as never),
  ).rejects.toBeInstanceOf(BotChatMissingError);
});

test("a 500 is NOT reported as a conversation that is gone", async () => {
  /*
   * The defect this pins. Told apart by "there is no data", a first load that failed for any reason
   * — offline, a 500, a request aborted by a navigation — read as a deletion, and told somebody
   * their conversation had been deleted when the server had merely fallen over. Only the status can
   * tell those apart, and only a type can carry the status out of here.
   */
  capturingFetch(500, { error: "The database is unreachable." });

  let caught: unknown;
  try {
    await botChatQueryOptions("botchat-1").queryFn?.(undefined as never);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(BotChatMissingError);
  // The server's own sentence, which the screen shows under its own: it names the reason.
  expect((caught as Error).message).toBe("The database is unreachable.");
});

test("a failure with nothing to say still says something", async () => {
  // The fallback is the detail line under the screen's own "Could not load this conversation", so it
  // is deliberately not a second copy of that sentence.
  capturingFetch(503, undefined);

  await expect(
    botChatQueryOptions("botchat-1").queryFn?.(undefined as never),
  ).rejects.toThrow("The server did not say why.");
});

test("being offline is not a deletion either", async () => {
  // `tryClient` is a bare `fetch`, which REJECTS when the browser is offline rather than answering
  // with a status, so this never reaches the 404 branch at all — and must not be mistaken for it.
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;

  let caught: unknown;
  try {
    await botChatQueryOptions("botchat-1").queryFn?.(undefined as never);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(BotChatMissingError);
});
