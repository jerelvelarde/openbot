import { describe, expect, test } from "bun:test";
import {
  canPublish,
  createAutosaveController,
  type SaveDraftResult,
} from "../src/lib/typefully/autosave";
import { TypefullyClientError } from "../src/lib/typefully/mutations";
import type { CanonicalDraftDocument } from "../src/lib/typefully/queries";

const base: CanonicalDraftDocument = {
  title: "Draft",
  destinations: ["x"],
  socialSetId: "1",
  accountLabel: "OpenBot",
  posts: [{ id: "one", x: "one", linkedin: "" }],
  media: [],
  scheduleAt: null,
};

const edited = (text: string): CanonicalDraftDocument => ({
  ...base,
  posts: [{ ...base.posts[0]!, x: text }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function clock() {
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  let cleared = 0;
  return {
    scheduler: {
      setTimeout(next: () => void, wait: number) {
        callback = next;
        delay = wait;
        return 1;
      },
      clearTimeout() {
        callback = undefined;
        cleared += 1;
      },
    },
    get delay() {
      return delay;
    },
    get cleared() {
      return cleared;
    },
    fire() {
      const next = callback;
      callback = undefined;
      next?.();
    },
  };
}

const saved = (
  version: number,
  remote: "local" | "confirmed" = "confirmed",
): SaveDraftResult => ({
  version,
  remote,
});

describe("Typefully autosave controller", () => {
  test("debounces a burst of text edits into one save after 600 ms", async () => {
    const timer = clock();
    const calls: unknown[] = [];
    const controller = createAutosaveController({
      initialDocument: base,
      initialVersion: 3,
      scheduler: timer.scheduler,
      save: async (input) => {
        calls.push(input);
        return saved(4);
      },
    });

    controller.textChanged(edited("first"));
    controller.textChanged(edited("second"));
    controller.textChanged(edited("third"));
    expect(controller.getSnapshot().state).toEqual({
      kind: "dirty",
      baseVersion: 3,
    });
    expect(timer.delay).toBe(600);
    expect(calls).toHaveLength(0);

    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([
      {
        document: edited("third"),
        expectedVersion: 3,
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(controller.getSnapshot().state).toEqual({
      kind: "saved",
      version: 4,
      remote: "confirmed",
    });
  });

  test("saves immediately after a settled media mutation", async () => {
    const timer = clock();
    const calls: unknown[] = [];
    const withMedia = {
      ...base,
      media: [
        {
          id: "m",
          kind: "image" as const,
          order: 0,
          altText: "alt",
          remoteId: null,
        },
      ],
    };
    const controller = createAutosaveController({
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async (input) => {
        calls.push(input);
        return saved(2, "local");
      },
    });

    controller.mediaSettled(withMedia);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(controller.getSnapshot().state).toEqual({
      kind: "saved",
      version: 2,
      remote: "local",
    });
  });

  test("suppresses stale responses and keeps the latest local document", async () => {
    const timer = clock();
    const first = deferred<SaveDraftResult>();
    const second = deferred<SaveDraftResult>();
    let call = 0;
    const controller = createAutosaveController({
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: () => (++call === 1 ? first.promise : second.promise),
    });

    controller.mediaSettled(edited("first"));
    controller.mediaSettled(edited("latest"));
    second.resolve(saved(3));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().document).toEqual(edited("latest"));
    expect(controller.getSnapshot().state).toEqual({
      kind: "saved",
      version: 3,
      remote: "confirmed",
    });

    first.resolve(saved(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().state).toEqual({
      kind: "saved",
      version: 3,
      remote: "confirmed",
    });
  });

  test("does not mark newly edited text saved when an older request finishes", async () => {
    const timer = clock();
    const first = deferred<SaveDraftResult>();
    const controller = createAutosaveController({
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: () => first.promise,
    });
    controller.mediaSettled(edited("being saved"));
    controller.textChanged(edited("new unsaved text"));
    first.resolve(saved(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      document: edited("new unsaved text"),
      state: { kind: "dirty", baseVersion: 1 },
    });
  });

  test("retains unsaved text on conflict and exposes explicit recovery actions", async () => {
    const timer = clock();
    const local = edited("do not lose me");
    let savedAsNew: CanonicalDraftDocument | undefined;
    const controller = createAutosaveController({
      initialDocument: base,
      initialVersion: 7,
      scheduler: timer.scheduler,
      save: async () => {
        throw new TypefullyClientError("version_conflict", {
          currentVersion: 8,
          currentHash: "current",
        });
      },
      saveAsNewDraft: async (document) => {
        savedAsNew = document;
        return saved(1, "local");
      },
    });

    controller.textChanged(local);
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      document: local,
      state: { kind: "conflict", local, currentVersion: 8 },
    });
    expect(controller.getSnapshot().actions).toEqual([
      "reload",
      "saveAsNewDraft",
    ]);

    await controller.saveAsNewDraft();
    expect(savedAsNew).toEqual(local);
    controller.reload(base, 8);
    expect(controller.getSnapshot()).toMatchObject({
      document: base,
      state: { kind: "idle", version: 8, remote: "local" },
    });
  });

  test("contains save-as-new failures as a safe retryable error", async () => {
    const timer = clock();
    const local = edited("preserved");
    const controller = createAutosaveController({
      initialDocument: base,
      initialVersion: 2,
      scheduler: timer.scheduler,
      save: async () => {
        throw new TypefullyClientError("version_conflict", {
          currentVersion: 3,
        });
      },
      saveAsNewDraft: async () => {
        throw new Error("unsafe internals");
      },
    });
    controller.textChanged(local);
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    await controller.saveAsNewDraft();
    expect(controller.getSnapshot().state).toEqual({
      kind: "error",
      local,
      message:
        "This draft could not be saved. Your changes are still here; try again.",
    });
  });

  test("uses safe errors and disables publish for every unsettled state", async () => {
    const timer = clock();
    const pending = deferred<SaveDraftResult>();
    const controller = createAutosaveController({
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: () => pending.promise,
    });
    expect(canPublish(controller.getSnapshot().state)).toBe(false);
    controller.textChanged(edited("dirty"));
    expect(canPublish(controller.getSnapshot().state)).toBe(false);
    timer.fire();
    expect(controller.getSnapshot().state.kind).toBe("saving");
    expect(canPublish(controller.getSnapshot().state)).toBe(false);
    pending.reject(new Error("token=unsafe backend detail"));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().state).toMatchObject({
      kind: "error",
      local: edited("dirty"),
      message:
        "This draft could not be saved. Your changes are still here; try again.",
    });
    expect(canPublish(controller.getSnapshot().state)).toBe(false);
  });

  test("retries a remote failure from the locally persisted server version", async () => {
    const timer = clock();
    const versions: number[] = [];
    let attempt = 0;
    const controller = createAutosaveController({
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async ({ expectedVersion }) => {
        versions.push(expectedVersion);
        if (++attempt === 1) {
          throw Object.assign(new TypefullyClientError("remote_error"), {
            draft: { version: 2 },
          });
        }
        return saved(3);
      },
    });
    controller.textChanged(edited("local save succeeds"));
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    controller.retry();
    await Promise.resolve();
    await Promise.resolve();
    expect(versions).toEqual([1, 2]);
    expect(controller.getSnapshot().state).toEqual({
      kind: "saved",
      version: 3,
      remote: "confirmed",
    });
  });

  test("allows publish only for a confirmed settled version", () => {
    expect(canPublish({ kind: "idle", version: 1, remote: "confirmed" })).toBe(
      true,
    );
    expect(canPublish({ kind: "saved", version: 2, remote: "confirmed" })).toBe(
      true,
    );
    expect(canPublish({ kind: "saved", version: 2, remote: "local" })).toBe(
      false,
    );
  });

  test("aborts in-flight work and clears timers on unmount cleanup", () => {
    const timer = clock();
    let signal: AbortSignal | undefined;
    const controller = createAutosaveController({
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: ({ signal: next }) => {
        signal = next;
        return new Promise(() => {});
      },
    });
    controller.textChanged(edited("pending"));
    timer.fire();
    controller.dispose();
    expect(signal?.aborted).toBe(true);
    expect(timer.cleared).toBeGreaterThan(0);
  });
});
