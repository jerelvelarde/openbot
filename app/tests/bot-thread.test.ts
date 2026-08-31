import { describe, expect, test } from "bun:test";
import {
  botThreadKey,
  shouldAdopt,
  threadToUse,
} from "../src/lib/copilot/bot-thread";

/**
 * The decisions `useLegacyThreadAdoption` makes that do not need a browser to test: which
 * localStorage key belongs to which Bot, whether a remembered thread id is still safe to use once
 * Intelligence has said whether it knows about it, and — built on that same answer — whether it is
 * worth adopting into a `bot_chats` row at all.
 */

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

describe("threadToUse", () => {
  test("a remembered thread Intelligence confirms it has is kept", () => {
    expect(threadToUse({ remembered: "t1", known: true })).toBe("remembered");
  });

  test("a remembered thread Intelligence says it does not have is replaced", () => {
    expect(threadToUse({ remembered: "t1", known: false })).toBe("fresh");
  });

  test("a remembered thread is kept when the check itself could not be completed", () => {
    // known: undefined means the lookup failed, not that the thread is gone. Discarding a
    // perfectly good thread id because Intelligence was briefly unreachable would be worse than
    // the failure it was reacting to.
    expect(threadToUse({ remembered: "t1", known: undefined })).toBe(
      "remembered",
    );
  });

  test("with nothing remembered, every outcome of the check starts fresh", () => {
    expect(threadToUse({ remembered: null, known: true })).toBe("fresh");
    expect(threadToUse({ remembered: null, known: false })).toBe("fresh");
    expect(threadToUse({ remembered: null, known: undefined })).toBe("fresh");
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
