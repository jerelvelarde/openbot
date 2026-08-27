import {
  type CanonicalDraftDocument,
  type DraftSummary,
  TypefullyClientError,
} from "./queries";

export type AutosaveState =
  | { kind: "idle"; version: number; remote: "local" | "confirmed" }
  | { kind: "dirty"; baseVersion: number }
  | { kind: "saving"; baseVersion: number }
  | { kind: "saved"; version: number; remote: "local" | "confirmed" }
  | {
      kind: "conflict";
      local: CanonicalDraftDocument;
      currentVersion: number;
    }
  | { kind: "error"; local: CanonicalDraftDocument; message: string };

export type SaveDraftResult = {
  version: number;
  remote: "local" | "confirmed";
};

export type SaveAsNewDraftResult = SaveDraftResult & {
  draftId: string;
  draft: DraftSummary;
};

export type AutosaveSnapshot = {
  document: CanonicalDraftDocument;
  state: AutosaveState;
  target: { draftId: string; version: number };
  createdDraft: SaveAsNewDraftResult | null;
  actions: Array<"reload" | "saveAsNewDraft" | "retry">;
};

type Scheduler = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

type AutosaveOptions = {
  initialDraftId: string;
  initialDocument: CanonicalDraftDocument;
  initialVersion: number;
  initialRemote?: "local" | "confirmed";
  debounceMs?: number;
  scheduler?: Scheduler;
  save(input: {
    draftId: string;
    document: CanonicalDraftDocument;
    expectedVersion: number;
    signal: AbortSignal;
  }): Promise<SaveDraftResult>;
  saveAsNewDraft?: (
    document: CanonicalDraftDocument,
    signal: AbortSignal,
  ) => Promise<SaveAsNewDraftResult>;
};

const browserScheduler: Scheduler = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function canPublish(state: AutosaveState): boolean {
  return (
    (state.kind === "idle" || state.kind === "saved") &&
    state.remote === "confirmed"
  );
}

function safeSaveMessage(error: unknown): string {
  if (error instanceof TypefullyClientError) return error.message;
  return "This draft could not be saved. Your changes are still here; try again.";
}

export function createAutosaveController(options: AutosaveOptions) {
  const scheduler = options.scheduler ?? browserScheduler;
  const listeners = new Set<(snapshot: AutosaveSnapshot) => void>();
  let targetDraftId = options.initialDraftId;
  let document = options.initialDocument;
  let version = options.initialVersion;
  let state: AutosaveState = {
    kind: "idle",
    version,
    remote: options.initialRemote ?? "local",
  };
  let timer: unknown;
  let disposed = false;
  let pending = false;
  let ready = false;
  let pendingImmediate = false;
  let activeSave: AbortController | undefined;
  let recoveryAbort: AbortController | undefined;
  let recoveryPromise: Promise<SaveAsNewDraftResult | undefined> | undefined;
  let recoveryToken: object | undefined;
  let recoveryFailed = false;
  let createdDraft: SaveAsNewDraftResult | null = null;

  const actions = (): AutosaveSnapshot["actions"] => {
    if (recoveryFailed) return ["retry"];
    if (state.kind === "conflict") return ["reload", "saveAsNewDraft"];
    if (state.kind === "error") return ["retry"];
    return [];
  };
  const buildSnapshot = (): AutosaveSnapshot => ({
    document,
    state,
    target: { draftId: targetDraftId, version },
    createdDraft,
    actions: actions(),
  });
  let currentSnapshot = buildSnapshot();
  const emit = () => {
    currentSnapshot = buildSnapshot();
    for (const listener of listeners) listener(currentSnapshot);
  };
  const clearTimer = () => {
    if (timer !== undefined) scheduler.clearTimeout(timer);
    timer = undefined;
  };
  const runSave = () => {
    if (
      disposed ||
      activeSave ||
      recoveryPromise ||
      recoveryFailed ||
      !pending ||
      !ready
    )
      return;
    clearTimer();
    const baseVersion = version;
    const local = document;
    const abort = new AbortController();
    activeSave = abort;
    pending = false;
    ready = false;
    pendingImmediate = false;
    state = { kind: "saving", baseVersion };
    emit();
    if (disposed || activeSave !== abort || abort.signal.aborted) return;
    let operation: Promise<SaveDraftResult>;
    try {
      operation = options.save({
        draftId: targetDraftId,
        document: local,
        expectedVersion: baseVersion,
        signal: abort.signal,
      });
    } catch (error) {
      operation = Promise.reject(error);
    }
    void operation
      .then((result) => {
        if (disposed || activeSave !== abort) return;
        activeSave = undefined;
        version = result.version;
        if (pending) {
          state = { kind: "dirty", baseVersion: version };
          emit();
          runSave();
          return;
        }
        state = { kind: "saved", version, remote: result.remote };
        emit();
      })
      .catch((error: unknown) => {
        if (disposed || activeSave !== abort || abort.signal.aborted) return;
        activeSave = undefined;
        clearTimer();
        pending = false;
        ready = false;
        pendingImmediate = false;
        if (
          error instanceof TypefullyClientError &&
          error.code === "version_conflict" &&
          error.currentVersion !== undefined
        ) {
          recoveryFailed = false;
          state = {
            kind: "conflict",
            local: document,
            currentVersion: error.currentVersion,
          };
        } else {
          recoveryFailed = false;
          if (error instanceof TypefullyClientError && error.draft) {
            version = error.draft.version;
          }
          state = {
            kind: "error",
            local: document,
            message: safeSaveMessage(error),
          };
        }
        emit();
      });
  };

  const startRecovery = ():
    | Promise<SaveAsNewDraftResult | undefined>
    | undefined => {
    if (recoveryPromise) return recoveryPromise;
    if (
      disposed ||
      (!recoveryFailed && state.kind !== "conflict") ||
      !options.saveAsNewDraft
    )
      return undefined;
    const local = document;
    const abort = new AbortController();
    const token = {};
    clearTimer();
    pending = false;
    ready = false;
    pendingImmediate = false;
    recoveryFailed = false;
    recoveryAbort = abort;
    recoveryToken = token;
    state = { kind: "saving", baseVersion: version };
    emit();
    let shouldDrain = false;
    let operation!: Promise<SaveAsNewDraftResult | undefined>;
    operation = (async () => {
      try {
        // Defer user code until the single-flight handle below is installed. A
        // synchronous throw must not let finally clear state before assignment.
        await Promise.resolve();
        if (disposed || abort.signal.aborted) return undefined;
        const result = await options.saveAsNewDraft?.(local, abort.signal);
        if (!result || disposed || abort.signal.aborted) return undefined;
        targetDraftId = result.draftId;
        version = result.version;
        createdDraft = result;
        const hasQueuedChanges = document !== local || pending;
        if (hasQueuedChanges) {
          state = { kind: "dirty", baseVersion: version };
          emit();
          shouldDrain = true;
        } else {
          state = { kind: "saved", version, remote: result.remote };
          emit();
        }
        return result;
      } catch (error) {
        if (disposed || abort.signal.aborted) return undefined;
        clearTimer();
        pending = false;
        ready = false;
        pendingImmediate = false;
        recoveryFailed = true;
        state = {
          kind: "error",
          local: document,
          message: safeSaveMessage(error),
        };
        emit();
        return undefined;
      } finally {
        if (recoveryPromise === operation && recoveryToken === token) {
          recoveryPromise = undefined;
          recoveryToken = undefined;
        }
        if (recoveryAbort === abort) recoveryAbort = undefined;
        if (shouldDrain) runSave();
      }
    })();
    recoveryPromise = operation;
    return operation;
  };

  return {
    getSnapshot: () => currentSnapshot,
    subscribe(listener: (snapshot: AutosaveSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    textChanged(next: CanonicalDraftDocument) {
      if (disposed) return;
      document = next;
      pending = true;
      state = { kind: "dirty", baseVersion: version };
      emit();
      if (pendingImmediate) return;
      ready = false;
      clearTimer();
      timer = scheduler.setTimeout(() => {
        timer = undefined;
        ready = true;
        runSave();
      }, options.debounceMs ?? 600);
    },
    mediaSettled(next: CanonicalDraftDocument) {
      if (disposed) return;
      document = next;
      pending = true;
      pendingImmediate = true;
      ready = true;
      state = { kind: "dirty", baseVersion: version };
      emit();
      clearTimer();
      runSave();
    },
    retry() {
      if (recoveryFailed) return startRecovery();
      if (disposed || state.kind !== "error") return;
      pending = true;
      ready = true;
      pendingImmediate = true;
      runSave();
    },
    reload(
      authoritative: CanonicalDraftDocument,
      currentVersion: number,
      draftId = targetDraftId,
    ) {
      if (disposed) return;
      clearTimer();
      activeSave?.abort();
      activeSave = undefined;
      recoveryAbort?.abort();
      recoveryAbort = undefined;
      recoveryPromise = undefined;
      recoveryToken = undefined;
      recoveryFailed = false;
      pending = false;
      ready = false;
      pendingImmediate = false;
      document = authoritative;
      targetDraftId = draftId;
      version = currentVersion;
      state = { kind: "idle", version, remote: "local" };
      emit();
    },
    saveAsNewDraft(): Promise<SaveAsNewDraftResult | undefined> | undefined {
      return startRecovery();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      activeSave?.abort();
      activeSave = undefined;
      recoveryAbort?.abort();
      recoveryAbort = undefined;
      recoveryToken = undefined;
      pending = false;
      ready = false;
      listeners.clear();
    },
  };
}
