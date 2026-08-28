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

const newDraftResult = {
  draftId: "new-draft",
  version: 1,
  remote: "local" as const,
  draft: {
    id: "new-draft",
    title: "Draft",
    destinations: ["x"] as Array<"x" | "linkedin">,
    socialSetLabel: "OpenBot",
    mediaCount: 0,
    version: 1,
    syncStatus: "local" as const,
    proposalStatus: null,
  },
};

describe("Typefully autosave controller", () => {
  test("rebinds an authoritative external media version without losing its remote confirmation", () => {
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      save: async () => saved(2),
    });

    controller.reload(
      edited("media authority"),
      3,
      "draft-current",
      "confirmed",
    );

    expect(controller.getSnapshot()).toMatchObject({
      document: edited("media authority"),
      target: { draftId: "draft-current", version: 3 },
      state: { kind: "idle", version: 3, remote: "confirmed" },
    });
  });

  test("retains a server-committed media document as retryable when remote confirmation fails", () => {
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      save: async () => saved(2),
    });

    controller.remoteFailed(
      edited("committed locally"),
      2,
      new TypefullyClientError("remote_unavailable"),
    );

    expect(controller.getSnapshot()).toMatchObject({
      document: edited("committed locally"),
      target: { draftId: "draft-current", version: 2 },
      state: {
        kind: "error",
        local: edited("committed locally"),
        message: "Typefully is temporarily unavailable. Try again.",
      },
      actions: ["retry"],
    });
  });

  test("keeps snapshots stable between subscribed state transitions", () => {
    const timer = clock();
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async () => saved(2),
    });
    const initial = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(initial);

    const observed: Array<ReturnType<typeof controller.getSnapshot>> = [];
    controller.subscribe((next) => {
      expect(next).toBe(controller.getSnapshot());
      expect(controller.getSnapshot()).toBe(next);
      observed.push(next);
    });
    controller.textChanged(edited("transition"));

    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toBe(initial);
    expect(observed[0]).toMatchObject({
      document: edited("transition"),
      state: { kind: "dirty", baseVersion: 1 },
    });
    expect(controller.getSnapshot()).toBe(observed[0]);
  });

  test("does not call save after a saving subscriber reloads", () => {
    const timer = clock();
    let calls = 0;
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async () => {
        calls += 1;
        return saved(2);
      },
    });
    controller.subscribe(({ state }) => {
      if (state.kind === "saving") controller.reload(base, 7, "reloaded");
    });

    controller.mediaSettled(edited("obsolete"));

    expect(calls).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      document: base,
      target: { draftId: "reloaded", version: 7 },
      state: { kind: "idle", version: 7 },
    });
  });

  test("never delivers a stale outer snapshot after a nested transition", () => {
    const timer = clock();
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async () => saved(2),
    });
    const listenerA: string[] = [];
    const listenerB: Array<{ delivered: string; current: string }> = [];
    controller.subscribe(({ state }) => {
      listenerA.push(state.kind);
      if (state.kind === "saving") controller.reload(base, 7, "reloaded");
    });
    controller.subscribe(({ state }) => {
      listenerB.push({
        delivered: state.kind,
        current: controller.getSnapshot().state.kind,
      });
    });

    controller.mediaSettled(edited("obsolete"));

    expect(listenerA).toEqual(["dirty", "saving", "idle"]);
    expect(listenerB).toEqual([
      { delivered: "dirty", current: "dirty" },
      { delivered: "idle", current: "idle" },
    ]);
    expect(controller.getSnapshot().state.kind).toBe("idle");
  });

  test("does not call save after a saving subscriber disposes", () => {
    const timer = clock();
    let calls = 0;
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async () => {
        calls += 1;
        return saved(2);
      },
    });
    controller.subscribe(({ state }) => {
      if (state.kind === "saving") controller.dispose();
    });

    controller.mediaSettled(edited("obsolete"));

    expect(calls).toBe(0);
  });

  test("debounces a burst of text edits into one save after 600 ms", async () => {
    const timer = clock();
    const calls: unknown[] = [];
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
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
        draftId: "draft-current",
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
      initialDraftId: "draft-current",
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

  test("serializes and coalesces edits behind an in-flight save", async () => {
    const timer = clock();
    const first = deferred<SaveDraftResult>();
    const second = deferred<SaveDraftResult>();
    const calls: Array<{
      document: CanonicalDraftDocument;
      expectedVersion: number;
      signal: AbortSignal;
    }> = [];
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: (input) => {
        calls.push(input);
        return calls.length === 1 ? first.promise : second.promise;
      },
    });

    controller.mediaSettled(edited("first"));
    const firstSignal = calls[0]?.signal;
    controller.mediaSettled(edited("middle"));
    controller.mediaSettled(edited("latest"));
    expect(calls).toHaveLength(1);
    expect(firstSignal?.aborted).toBe(false);

    first.resolve(saved(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      document: edited("latest"),
      expectedVersion: 2,
    });

    second.resolve(saved(3));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().document).toEqual(edited("latest"));
    expect(controller.getSnapshot().state).toEqual({
      kind: "saved",
      version: 3,
      remote: "confirmed",
    });
  });

  test("queues debounced text behind a server-committed request without aborting it", async () => {
    const timer = clock();
    const first = deferred<SaveDraftResult>();
    const calls: Array<{ expectedVersion: number; signal: AbortSignal }> = [];
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: (input) => {
        calls.push(input);
        return calls.length === 1 ? first.promise : Promise.resolve(saved(3));
      },
    });
    controller.mediaSettled(edited("being saved"));
    controller.textChanged(edited("new unsaved text"));
    expect(calls[0]?.signal.aborted).toBe(false);
    timer.fire();
    first.resolve(saved(2));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.map(({ expectedVersion }) => expectedVersion)).toEqual([1, 2]);
    expect(controller.getSnapshot()).toMatchObject({
      document: edited("new unsaved text"),
      state: { kind: "saved", version: 3 },
    });
  });

  test("stops a queued write on conflict and preserves its latest local document", async () => {
    const timer = clock();
    const first = deferred<SaveDraftResult>();
    let calls = 0;
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: () => {
        calls += 1;
        return first.promise;
      },
    });
    controller.mediaSettled(edited("first"));
    controller.mediaSettled(edited("latest queued"));
    first.reject(
      new TypefullyClientError("version_conflict", { currentVersion: 4 }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      document: edited("latest queued"),
      state: {
        kind: "conflict",
        local: edited("latest queued"),
        currentVersion: 4,
      },
    });
  });

  test("retains unsaved text on conflict and exposes explicit recovery actions", async () => {
    const timer = clock();
    const local = edited("do not lose me");
    let savedAsNew: CanonicalDraftDocument | undefined;
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 7,
      scheduler: timer.scheduler,
      save: async () => {
        throw new TypefullyClientError("version_conflict", {
          currentVersion: 8,
          currentHash: "current",
        });
      },
      saveAsNewDraft: async (document, signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        savedAsNew = document;
        return newDraftResult;
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

    const recovered = await controller.saveAsNewDraft();
    expect(recovered?.draftId).toBe("new-draft");
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
      initialDraftId: "draft-current",
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

  test("makes save-as-new single-flight and aborts recovery on dispose", async () => {
    const timer = clock();
    const recovery = deferred<{
      draftId: string;
      version: number;
      remote: "local" | "confirmed";
      draft: typeof newDraftResult.draft;
    }>();
    let recoverySignal: AbortSignal | undefined;
    let calls = 0;
    let normalSaves = 0;
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 2,
      scheduler: timer.scheduler,
      save: async () => {
        normalSaves += 1;
        throw new TypefullyClientError("version_conflict", {
          currentVersion: 3,
        });
      },
      saveAsNewDraft: (_document, signal) => {
        calls += 1;
        recoverySignal = signal;
        return recovery.promise;
      },
    });
    controller.textChanged(edited("preserved"));
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    const first = controller.saveAsNewDraft();
    const second = controller.saveAsNewDraft();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(calls).toBe(1);
    controller.mediaSettled(edited("queued before dispose"));
    expect(normalSaves).toBe(1);
    controller.dispose();
    expect(recoverySignal?.aborted).toBe(true);
    recovery.reject(new DOMException("Aborted", "AbortError"));
    expect(await first).toBeUndefined();
    expect(normalSaves).toBe(1);
  });

  test("does not start deferred recovery after dispose", async () => {
    const timer = clock();
    let recoveryCalls = 0;
    let normalSaves = 0;
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 2,
      scheduler: timer.scheduler,
      save: async () => {
        normalSaves += 1;
        throw new TypefullyClientError("version_conflict", {
          currentVersion: 3,
        });
      },
      saveAsNewDraft: async () => {
        recoveryCalls += 1;
        return newDraftResult;
      },
    });
    controller.textChanged(edited("preserved"));
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();

    const operation = controller.saveAsNewDraft();
    controller.dispose();
    expect(await operation).toBeUndefined();
    expect(recoveryCalls).toBe(0);
    expect(normalSaves).toBe(1);
  });

  test("rebinding recovery queues in-flight edits onto the new draft target", async () => {
    const timer = clock();
    const recovery = deferred<typeof newDraftResult>();
    const followup = deferred<SaveDraftResult>();
    const saves: Array<{
      draftId?: string;
      document: CanonicalDraftDocument;
      expectedVersion: number;
    }> = [];
    const controller = createAutosaveController({
      initialDraftId: "old-draft",
      initialDocument: base,
      initialVersion: 4,
      scheduler: timer.scheduler,
      save: async (input) => {
        saves.push(input);
        if (saves.length === 1) {
          throw new TypefullyClientError("version_conflict", {
            currentVersion: 5,
          });
        }
        return followup.promise;
      },
      saveAsNewDraft: () => recovery.promise,
    });
    controller.textChanged(edited("conflicted"));
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    const creating = controller.saveAsNewDraft();
    controller.textChanged(edited("during create"));
    controller.mediaSettled({
      ...edited("latest on new draft"),
      media: [
        {
          id: "media-new",
          kind: "image",
          order: 0,
          altText: "new",
          remoteId: null,
        },
      ],
    });
    expect(saves).toHaveLength(1);

    recovery.resolve(newDraftResult);
    expect((await creating)?.draftId).toBe("new-draft");
    await Promise.resolve();
    await Promise.resolve();
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({
      draftId: "new-draft",
      expectedVersion: 1,
      document: {
        posts: [{ x: "latest on new draft" }],
        media: [{ id: "media-new" }],
      },
    });
    expect(controller.getSnapshot()).toMatchObject({
      target: { draftId: "new-draft", version: 1 },
      createdDraft: newDraftResult,
    });
    followup.resolve(saved(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().target).toEqual({
      draftId: "new-draft",
      version: 2,
    });
  });

  test("retries failed recovery as create, then retries normal saves on the rebound target", async () => {
    const timer = clock();
    const saveTargets: Array<string | undefined> = [];
    let createAttempts = 0;
    const controller = createAutosaveController({
      initialDraftId: "old-draft",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async (input) => {
        saveTargets.push(input.draftId);
        if (saveTargets.length === 1) {
          throw new TypefullyClientError("version_conflict", {
            currentVersion: 2,
          });
        }
        if (saveTargets.length === 2) throw new Error("temporary");
        return saved(3);
      },
      saveAsNewDraft: async () => {
        createAttempts += 1;
        if (createAttempts === 1) throw new Error("temporary create failure");
        return newDraftResult;
      },
    });
    controller.textChanged(edited("conflict"));
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    await controller.saveAsNewDraft();
    expect(createAttempts).toBe(1);

    const recovered = await controller.retry();
    expect(recovered?.draftId).toBe("new-draft");
    expect(createAttempts).toBe(2);
    expect(saveTargets).toEqual(["old-draft"]);

    controller.mediaSettled(edited("new target edit"));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().state.kind).toBe("error");
    controller.retry();
    await Promise.resolve();
    await Promise.resolve();
    expect(saveTargets).toEqual(["old-draft", "new-draft", "new-draft"]);
    expect(controller.getSnapshot().target).toEqual({
      draftId: "new-draft",
      version: 3,
    });
  });

  test("retries recovery after a synchronous create throw without wedging single-flight state", async () => {
    const timer = clock();
    let createAttempts = 0;
    const controller = createAutosaveController({
      initialDraftId: "old-draft",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async () => {
        throw new TypefullyClientError("version_conflict", {
          currentVersion: 2,
        });
      },
      saveAsNewDraft: () => {
        createAttempts += 1;
        if (createAttempts === 1) throw new Error("synchronous create failure");
        return Promise.resolve(newDraftResult);
      },
    });
    controller.textChanged(edited("conflict"));
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();

    const first = controller.saveAsNewDraft();
    const duplicate = controller.saveAsNewDraft();
    expect(first).toBe(duplicate);
    expect(await first).toBeUndefined();
    expect(createAttempts).toBe(1);
    expect(controller.getSnapshot().state.kind).toBe("error");

    const retried = await controller.retry();
    expect(createAttempts).toBe(2);
    expect(retried?.draftId).toBe("new-draft");
    expect(controller.getSnapshot()).toMatchObject({
      target: { draftId: "new-draft", version: 1 },
      createdDraft: newDraftResult,
      state: { kind: "saved", version: 1 },
    });
  });

  test("uses safe errors and disables publish for every unsettled state", async () => {
    const timer = clock();
    const pending = deferred<SaveDraftResult>();
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
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

  test("contains a synchronous save failure without escaping the controller", async () => {
    const timer = clock();
    const local = edited("still safe");
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: () => {
        throw new Error("unsafe synchronous detail");
      },
    });
    controller.textChanged(local);
    expect(() => timer.fire()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().state).toEqual({
      kind: "error",
      local,
      message:
        "This draft could not be saved. Your changes are still here; try again.",
    });
  });

  test("retries a remote failure from the locally persisted server version", async () => {
    const timer = clock();
    const versions: number[] = [];
    let attempt = 0;
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
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

  test("adopts canonical server authority for the exact settled save generation", async () => {
    const timer = clock();
    const saving = deferred<SaveDraftResult>();
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: () => saving.promise,
    });
    controller.textChanged(edited("client spelling"));
    timer.fire();
    expect(
      controller.adoptAuthoritative(
        edited("canonical spelling"),
        2,
        "draft-current",
        "confirmed",
      ),
    ).toBe(false);
    saving.resolve(saved(2));
    await saving.promise;
    await Promise.resolve();
    expect(
      controller.adoptAuthoritative(
        edited("canonical spelling"),
        2,
        "draft-current",
        "confirmed",
      ),
    ).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      document: edited("canonical spelling"),
      state: { kind: "idle", version: 2, remote: "confirmed" },
    });
  });

  test("ignores delayed authority while newer local content is dirty", async () => {
    const timer = clock();
    const saving = deferred<SaveDraftResult>();
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: () => saving.promise,
    });
    controller.textChanged(edited("being saved"));
    timer.fire();
    controller.textChanged(edited("newer local"));
    expect(controller.adoptAuthoritative(edited("stale refetch"), 2)).toBe(
      false,
    );
    saving.resolve(saved(2));
    await saving.promise;
    await Promise.resolve();
    expect(controller.getSnapshot().document).toEqual(edited("newer local"));
  });

  test("adopts a later authoritative refetch after local work settles", async () => {
    const timer = clock();
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async () => saved(2),
    });
    controller.textChanged(edited("local"));
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      controller.adoptAuthoritative(
        edited("canonical"),
        2,
        "draft-current",
        "confirmed",
      ),
    ).toBe(true);
    expect(controller.getSnapshot().document).toEqual(edited("canonical"));
  });

  test("adopts a genuinely newer clean authority and saves from that version", async () => {
    const timer = clock();
    const expectedVersions: number[] = [];
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async ({ expectedVersion }) => {
        expectedVersions.push(expectedVersion);
        return saved(3);
      },
    });

    expect(
      controller.adoptAuthoritative(
        edited("new remote authority"),
        2,
        "draft-current",
        "confirmed",
      ),
    ).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      document: edited("new remote authority"),
      target: { version: 2 },
      state: { kind: "idle", version: 2, remote: "confirmed" },
    });
    controller.textChanged(edited("edit after authority"));
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(expectedVersions).toEqual([2]);
  });

  test("never adopts newer authority while local content is dirty", () => {
    const timer = clock();
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
      initialDocument: base,
      initialVersion: 1,
      scheduler: timer.scheduler,
      save: async () => saved(2),
    });
    controller.textChanged(edited("unsaved local"));
    expect(
      controller.adoptAuthoritative(edited("remote v2"), 2, "draft-current"),
    ).toBe(false);
    expect(controller.getSnapshot().document).toEqual(edited("unsaved local"));
  });

  test("aborts in-flight work and clears timers on unmount cleanup", () => {
    const timer = clock();
    let signal: AbortSignal | undefined;
    const controller = createAutosaveController({
      initialDraftId: "draft-current",
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
    controller.textChanged(edited("still pending"));
    controller.dispose();
    expect(signal?.aborted).toBe(true);
    expect(timer.cleared).toBeGreaterThan(0);
  });
});
