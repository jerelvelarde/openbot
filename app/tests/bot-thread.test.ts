import { afterEach, describe, expect, test } from "bun:test";
import { AdoptConflictError } from "../src/lib/bot-chats/mutations";
import type { BotChat } from "../src/lib/bot-chats/queries";
import {
  attemptAdoption,
  botThreadKey,
  shouldAdopt,
} from "../src/lib/copilot/bot-thread";

/**
 * The rescue of a conversation a browser remembers from before Bot chats had rows: which
 * localStorage key belongs to which Bot, whether a remembered thread id is worth adopting once
 * Intelligence has said whether it knows about it, and — the part only the whole sequence can show —
 * which answers retire the key and which ones keep it for the next visit.
 *
 * That last one is the reason these go through `attemptAdoption` rather than stopping at the
 * predicate. `shouldAdopt` said "no" to both a thread Intelligence has never heard of and a check
 * that failed, correctly, and for a while the sequence treated those two identically as well: the
 * key survived a proven "no" for the life of the browser profile, and every Bot chat mount asked the
 * same question again and got the same answer. A predicate cannot notice that.
 */

const BOT = "risk-analyst";
const THREAD = "thread-1";

const realFetch = globalThis.fetch;
let restoreStorage: (() => void) | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreStorage?.();
  restoreStorage = null;
});

/**
 * A localStorage these tests can read back, for the duration of one test.
 *
 * `bun test` runs every file in one process, so anything installed on `globalThis` outlives this
 * file: the window object is only created when nothing else has installed one, the previous
 * `localStorage` descriptor is put back afterwards, and neither is left behind for whichever file
 * runs next. (app/tests/auth-client.test.ts installs a plain-object window of its own at module
 * scope, so "a window already exists" and "no window exists" both really happen here, depending on
 * the order the suite is walked.)
 */
function stubStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(seed));
  const host = globalThis as { window?: Record<string, unknown> };
  const created = host.window === undefined;
  host.window ??= {};
  const previous = Object.getOwnPropertyDescriptor(host.window, "localStorage");

  Object.defineProperty(host.window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => {
        store.delete(key);
      },
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
    writable: true,
  });

  restoreStorage = () => {
    if (created) {
      delete host.window;
      return;
    }
    if (previous) {
      Object.defineProperty(host.window as object, "localStorage", previous);
      return;
    }
    delete (host.window as Record<string, unknown>).localStorage;
  };

  return store;
}

/** What `GET /api/threads/:threadId` answers, and how many times it was asked. */
function answerCheck(status: number, body: unknown): { asked: string[] } {
  const asked: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    asked.push(String(url));
    return new Response(body === undefined ? null : JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  }) as unknown as typeof fetch;
  return { asked };
}

const adopted: BotChat = {
  active: true,
  agentId: BOT,
  archived: false,
  id: "botchat-1",
  threadId: THREAD,
  title: null,
};

describe("botThreadKey", () => {
  test("is the same key for the same agent every time", () => {
    expect(botThreadKey("bot-a")).toBe(botThreadKey("bot-a"));
  });

  test("is namespaced rather than the bare agent id", () => {
    // A raw agent id used directly as a localStorage key would collide with anything else in the
    // app that happens to key storage by agent id.
    const key = botThreadKey("bot-a");
    expect(key).not.toBe("bot-a");
    expect(key).toContain("bot-a");
  });

  test("two agents never collide", () => {
    expect(botThreadKey("bot-a")).not.toBe(botThreadKey("bot-b"));
  });
});

describe("shouldAdopt", () => {
  test("adopts a remembered thread Intelligence still has", () => {
    expect(shouldAdopt({ remembered: "thread-1", known: true })).toBe(true);
  });

  test("does not adopt a thread Intelligence has never heard of", () => {
    // Adopting a forgotten thread manufactures a roster row with no history behind it: a
    // conversation that looks recoverable and is empty when opened.
    expect(shouldAdopt({ remembered: "thread-1", known: false })).toBe(false);
  });

  test("does not adopt when the check could not get an answer", () => {
    // `undefined` is the check failing, not the thread being gone. Creating a row on the strength of
    // a network blip is the worse mistake, and the key survives for the next attempt.
    expect(shouldAdopt({ remembered: "thread-1", known: undefined })).toBe(
      false,
    );
  });

  test("has nothing to adopt when nothing was remembered", () => {
    expect(shouldAdopt({ remembered: null, known: true })).toBe(false);
  });
});

describe("attemptAdoption", () => {
  test("a thread Intelligence still has is adopted, and the key is cleared behind it", async () => {
    const store = stubStorage({ [botThreadKey(BOT)]: THREAD });
    const { asked } = answerCheck(200, { known: true });

    const outcome = await attemptAdoption(
      BOT,
      async () => adopted,
      () => true,
    );

    expect(asked).toEqual([`/api/threads/${THREAD}`]);
    expect(outcome).toEqual({ adopted: "botchat-1" });
    expect(store.has(botThreadKey(BOT))).toBe(false);
  });

  test("a thread Intelligence has never heard of clears the key rather than asking again forever", async () => {
    /*
     * The key's other exit. `useLegacyThreadAdoption` runs on every Bot chat mount, so a key that
     * can never be adopted is a `GET /api/threads/:threadId` on every visit, answered `known: false`
     * every time, for the life of the browser profile. Nothing else clears it — there is no adopt to
     * succeed and no 409 to fall through.
     */
    const store = stubStorage({ [botThreadKey(BOT)]: THREAD });
    answerCheck(200, { known: false });
    let adoptCalls = 0;

    const outcome = await attemptAdoption(
      BOT,
      async () => {
        adoptCalls += 1;
        return adopted;
      },
      () => true,
    );

    expect(outcome).toEqual({ adopted: null });
    // Cleared, but nothing was manufactured: a row with no transcript behind it is the mistake the
    // check exists to prevent, so "gone" must not turn into "adopt anyway".
    expect(adoptCalls).toBe(0);
    expect(store.has(botThreadKey(BOT))).toBe(false);
  });

  test("a check that could not get an answer keeps the key for the next visit", async () => {
    // The distinction the whole check turns on: a 502 is not Intelligence saying the thread is gone,
    // and discarding somebody's conversation on a network blip is the worse of the two mistakes.
    const store = stubStorage({ [botThreadKey(BOT)]: THREAD });
    answerCheck(502, { error: "Intelligence is unreachable." });
    let adoptCalls = 0;

    const outcome = await attemptAdoption(
      BOT,
      async () => {
        adoptCalls += 1;
        return adopted;
      },
      () => true,
    );

    expect(outcome).toEqual({ adopted: null });
    expect(adoptCalls).toBe(0);
    expect(store.get(botThreadKey(BOT))).toBe(THREAD);
  });

  test("a 404 on the check is no thread reader on this deployment, not a missing thread", async () => {
    // A deployment with no reader configured answers 404 for every id, so reading that as "gone"
    // would clear the key of every browser upgrading into this feature before it could be rescued.
    const store = stubStorage({ [botThreadKey(BOT)]: THREAD });
    answerCheck(404, { error: "Not found" });

    const outcome = await attemptAdoption(
      BOT,
      async () => adopted,
      () => true,
    );

    expect(outcome).toEqual({ adopted: null });
    expect(store.get(botThreadKey(BOT))).toBe(THREAD);
  });

  test("a 200 that does not answer the question is not an answer", async () => {
    const store = stubStorage({ [botThreadKey(BOT)]: THREAD });
    answerCheck(200, { threadId: THREAD });

    const outcome = await attemptAdoption(
      BOT,
      async () => adopted,
      () => true,
    );

    expect(outcome).toEqual({ adopted: null });
    expect(store.get(botThreadKey(BOT))).toBe(THREAD);
  });

  test("a 409 on adopt clears the key, because somebody already holds the thread", async () => {
    const store = stubStorage({ [botThreadKey(BOT)]: THREAD });
    answerCheck(200, { known: true });

    const outcome = await attemptAdoption(
      BOT,
      async () => {
        throw new AdoptConflictError(
          "That conversation is no longer available.",
        );
      },
      () => true,
    );

    // No id to hand back — whoever holds the thread now is not necessarily this call — but the
    // outcome adoption wanted has happened, so the key has nothing left to protect.
    expect(outcome).toEqual({ adopted: null });
    expect(store.has(botThreadKey(BOT))).toBe(false);
  });

  test("any other adopt failure keeps the key, so the next visit can try again", async () => {
    const store = stubStorage({ [botThreadKey(BOT)]: THREAD });
    answerCheck(200, { known: true });

    const outcome = await attemptAdoption(
      BOT,
      async () => {
        throw new Error("Intelligence is unreachable.");
      },
      () => true,
    );

    expect(outcome).toEqual({ adopted: null });
    expect(store.get(botThreadKey(BOT))).toBe(THREAD);
  });

  test("a stale answer adopts nothing and forgets nothing", async () => {
    // The Bot changed, or the caller unmounted, while the check was in flight. Committing either
    // side effect on behalf of a screen nobody is looking at any more is what `isCurrent` prevents.
    const store = stubStorage({ [botThreadKey(BOT)]: THREAD });
    answerCheck(200, { known: false });

    const outcome = await attemptAdoption(
      BOT,
      async () => adopted,
      () => false,
    );

    expect(outcome).toEqual({ adopted: null });
    expect(store.get(botThreadKey(BOT))).toBe(THREAD);
  });

  test("nothing remembered asks Intelligence nothing at all", async () => {
    // Which is every browser after the first visit, so this is the path that actually runs.
    stubStorage();
    const { asked } = answerCheck(200, { known: true });

    const outcome = await attemptAdoption(
      BOT,
      async () => adopted,
      () => true,
    );

    expect(outcome).toEqual({ adopted: null });
    expect(asked).toEqual([]);
  });
});
