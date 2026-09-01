import { afterEach, describe, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import {
  deleteWarningFor,
  linkFor,
  menuFor,
  openConversationId,
  reportingRefusal,
  rowMarkers,
} from "../src/components/app-sidebar/roster-row";
import { setChannelPinnedMutationOptions } from "../src/lib/channels/mutations";

describe("openConversationId", () => {
  test("resolves a channel route from channelId alone", () => {
    expect(openConversationId({ channelId: "channel_1" })).toBe("channel_1");
  });

  test("resolves a bot chat route from botChatId alone", () => {
    expect(openConversationId({ botChatId: "botchat_1" })).toBe("botchat_1");
  });

  test("resolves to undefined when neither param is present", () => {
    expect(openConversationId({})).toBeUndefined();
  });

  test("prefers channelId when both are present, an arbitrary but fixed choice", () => {
    // No route ever matches both params at once, so this case cannot occur in the app — the
    // precedence just has to be fixed, not meaningful, so the two callers agree on it.
    expect(
      openConversationId({ channelId: "channel_1", botChatId: "botchat_1" }),
    ).toBe("channel_1");
  });
});

describe("linkFor", () => {
  test("sends a channel row to the channel screen", () => {
    expect(linkFor({ kind: "channel", id: "channel_1" })).toEqual({
      to: "/channel/$channelId",
      params: { channelId: "channel_1" },
    });
  });

  test("sends a bot chat row to its own screen", () => {
    // A roster row that does not open what it names is worse than no row at all.
    expect(linkFor({ kind: "bot_chat", id: "botchat_1" })).toEqual({
      to: "/bot/$botChatId",
      params: { botChatId: "botchat_1" },
    });
  });
});

describe("menuFor", () => {
  test("offers Archive on a live row", () => {
    expect(menuFor({ archived: false, pinned: false })).toEqual([
      "pin",
      "archive",
      "delete",
    ]);
  });

  test("offers Restore in place of Archive on an archived row", () => {
    expect(menuFor({ archived: true, pinned: false })).toEqual([
      "pin",
      "restore",
      "delete",
    ]);
  });

  test("offers Unpin in place of Pin on a pinned row", () => {
    expect(menuFor({ archived: false, pinned: true })).toEqual([
      "unpin",
      "archive",
      "delete",
    ]);
  });
});

describe("rowMarkers", () => {
  test("marks an archived row, so the All list can tell one from a live row", () => {
    // The All tab holds both kinds of row. Without this marker the only way to tell an archived
    // conversation from a live one was to right-click it and read whether the menu said Archive or
    // Restore — which is the tri-state filter's whole point, undone.
    const live = rowMarkers({ unread: false, archived: false, pinned: false });
    const archived = rowMarkers({
      unread: false,
      archived: true,
      pinned: false,
    });
    expect(archived).toEqual(["archived"]);
    expect(live).toEqual([]);
  });

  test("puts state about the message before state about the row", () => {
    expect(rowMarkers({ unread: true, archived: true, pinned: true })).toEqual([
      "unread",
      "archived",
      "pinned",
    ]);
  });
});

describe("deleteWarningFor", () => {
  test("a channel's delete is described as reaching everyone in it", () => {
    // `channel_memberships` is keyed on (channel_id, user_id) and multi-member by design, so this is
    // the rule a channel's delete follows even while the server still creates one membership each.
    expect(deleteWarningFor("channel")).toBe(
      "The conversation will no longer appear for anyone in it.",
    );
  });

  test("a bot chat's delete does not invent a teammate it cannot have", () => {
    // One dialog serves both kinds, and it used to say "for anyone in it" for both. A `bot_chats` row
    // carries a single `user_id` and every server read and write filters on it, so for a Bot chat
    // that describes a group of one — and reads as though somebody else is about to lose something.
    const warning = deleteWarningFor("bot_chat");
    expect(warning).not.toContain("anyone in it");
    expect(warning).toBe(
      "The conversation is yours alone, and will no longer appear in your list.",
    );
  });
});

/**
 * Where the refusal handler for a pin, archive or restore lives.
 *
 * These drive a real `MutationObserver` rather than calling `onError` by hand, for the reason the
 * same-shaped tests in bot-chat-mutations.test.ts give: `useMutation` is one observer shared by
 * every call from one component (@tanstack/react-query's useMutation.js holds
 * `new MutationObserver(client, options)` in state and has `mutate` call `observer.mutate(…)`), and
 * the defect lived in that machinery. A hand-driven test could not see it.
 */

const realFetch = globalThis.fetch;
const REFUSAL = "Pinning is off today";

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch that refuses at once, for the single-click control. */
function refusingFetch() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: REFUSAL }), {
      headers: { "content-type": "application/json" },
      status: 503,
    })) as unknown as typeof fetch;
}

/**
 * A fetch whose first call hangs until released and then refuses, and whose second answers at once.
 *
 * That is one round trip with two clicks in it: the person pins, nothing moves, they open the menu
 * again and click, and only then does the first attempt come back with a no.
 */
function refusingFirstCall() {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      await gate;
      return new Response(JSON.stringify({ error: REFUSAL }), {
        headers: { "content-type": "application/json" },
        status: 503,
      });
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { release: () => release?.() };
}

test("a refusal reported through the mutation's own options survives a second click", async () => {
  const { release } = refusingFirstCall();
  const problems: string[] = [];
  const queryClient = new QueryClient();
  const observer = new MutationObserver(
    queryClient,
    reportingRefusal(setChannelPinnedMutationOptions(queryClient), (message) =>
      problems.push(message),
    ),
  );
  // `useMutation` subscribes through `useSyncExternalStore`; the harness matches its shape.
  const unsubscribe = observer.subscribe(() => {});

  const first = observer.mutate({ channelId: "channel_1", pinned: true });
  const second = observer.mutate({ channelId: "channel_1", pinned: false });
  await second;
  release();
  // Rejects, as `mutate` does on a refusal. The row reads the sentence, not this promise.
  await first.catch(() => undefined);
  unsubscribe();

  expect(problems).toEqual([REFUSAL]);
});

test("a per-call handler does fire on a lone refusal, so the control below means something", async () => {
  // Without this, the control could pass because this harness never fires per-call callbacks at all
  // — a missing `subscribe`, say, since `#notify` skips them when the observer has no listeners.
  // What it is really recording is that only the OVERLAP loses them.
  refusingFetch();
  const problems: string[] = [];
  const queryClient = new QueryClient();
  const observer = new MutationObserver(
    queryClient,
    setChannelPinnedMutationOptions(queryClient),
  );
  const unsubscribe = observer.subscribe(() => {});

  await observer
    .mutate(
      { channelId: "channel_1", pinned: true },
      { onError: (thrown) => problems.push(thrown.message) },
    )
    .catch(() => undefined);
  unsubscribe();

  expect(problems).toEqual([REFUSAL]);
});

test("the same refusal handed to mutate per call is lost, which is why it is not", async () => {
  /*
   * THE CONTROL, and a canary for the day query-core changes. `MutationObserver.mutate` does
   * `this.#mutateOptions = options` and then `this.#currentMutation?.removeObserver(this)`
   * (@tanstack/query-core 5.102.2, `mutationObserver.js`), so the second click both overwrote the
   * stored callbacks and detached the observer from the first mutation — and `#notify`, the only
   * caller of a per-call `onError`, runs on observer updates that no longer arrive. The row cleared
   * its sentence on the second click and then had nothing to replace it with, so a refused pin
   * looked exactly like a pin that worked.
   *
   * If this ever starts reporting the refusal, the per-call form has become safe and
   * `reportingRefusal` is free to go — the assertion is written to fail loudly in that direction
   * rather than quietly keep passing.
   */
  const { release } = refusingFirstCall();
  const problems: string[] = [];
  const queryClient = new QueryClient();
  const observer = new MutationObserver(
    queryClient,
    setChannelPinnedMutationOptions(queryClient),
  );
  const unsubscribe = observer.subscribe(() => {});

  const first = observer.mutate(
    { channelId: "channel_1", pinned: true },
    { onError: (thrown) => problems.push(thrown.message) },
  );
  const second = observer.mutate({ channelId: "channel_1", pinned: false });
  await second;
  release();
  await first.catch(() => undefined);
  unsubscribe();

  expect(problems).toEqual([]);
});
