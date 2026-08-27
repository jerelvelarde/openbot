import { type CanonicalDraftDocument, TypefullyClientError } from "./queries";

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

export type AutosaveSnapshot = {
  document: CanonicalDraftDocument;
  state: AutosaveState;
  actions: Array<"reload" | "saveAsNewDraft" | "retry">;
};

type Scheduler = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

type AutosaveOptions = {
  initialDocument: CanonicalDraftDocument;
  initialVersion: number;
  initialRemote?: "local" | "confirmed";
  debounceMs?: number;
  scheduler?: Scheduler;
  save(input: {
    document: CanonicalDraftDocument;
    expectedVersion: number;
    signal: AbortSignal;
  }): Promise<SaveDraftResult>;
  saveAsNewDraft?: (
    document: CanonicalDraftDocument,
  ) => Promise<SaveDraftResult>;
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
  let document = options.initialDocument;
  let version = options.initialVersion;
  let state: AutosaveState = {
    kind: "idle",
    version,
    remote: options.initialRemote ?? "local",
  };
  let timer: unknown;
  let disposed = false;
  let sequence = 0;
  const active = new Map<number, AbortController>();

  const actions = (): AutosaveSnapshot["actions"] => {
    if (state.kind === "conflict") return ["reload", "saveAsNewDraft"];
    if (state.kind === "error") return ["retry"];
    return [];
  };
  const snapshot = (): AutosaveSnapshot => ({
    document,
    state,
    actions: actions(),
  });
  const emit = () => {
    const current = snapshot();
    for (const listener of listeners) listener(current);
  };
  const clearTimer = () => {
    if (timer !== undefined) scheduler.clearTimeout(timer);
    timer = undefined;
  };
  const invalidateActive = () => {
    sequence += 1;
    for (const abort of active.values()) abort.abort();
  };

  const runSave = async () => {
    if (disposed) return;
    clearTimer();
    const requestId = ++sequence;
    const baseVersion = version;
    const local = document;
    const abort = new AbortController();
    active.set(requestId, abort);
    state = { kind: "saving", baseVersion };
    emit();
    try {
      const result = await options.save({
        document: local,
        expectedVersion: baseVersion,
        signal: abort.signal,
      });
      if (disposed || requestId !== sequence) return;
      version = result.version;
      state = { kind: "saved", version, remote: result.remote };
      emit();
    } catch (error) {
      if (disposed || abort.signal.aborted || requestId !== sequence) return;
      if (
        error instanceof TypefullyClientError &&
        error.code === "version_conflict" &&
        error.currentVersion !== undefined
      ) {
        state = {
          kind: "conflict",
          local: document,
          currentVersion: error.currentVersion,
        };
      } else {
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
    } finally {
      active.delete(requestId);
    }
  };

  return {
    getSnapshot: snapshot,
    subscribe(listener: (snapshot: AutosaveSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    textChanged(next: CanonicalDraftDocument) {
      if (disposed) return;
      invalidateActive();
      document = next;
      state = { kind: "dirty", baseVersion: version };
      emit();
      clearTimer();
      timer = scheduler.setTimeout(
        () => void runSave(),
        options.debounceMs ?? 600,
      );
    },
    mediaSettled(next: CanonicalDraftDocument) {
      if (disposed) return;
      invalidateActive();
      document = next;
      state = { kind: "dirty", baseVersion: version };
      emit();
      void runSave();
    },
    retry() {
      if (disposed || state.kind !== "error") return;
      void runSave();
    },
    reload(authoritative: CanonicalDraftDocument, currentVersion: number) {
      if (disposed) return;
      clearTimer();
      sequence += 1;
      for (const abort of active.values()) abort.abort();
      active.clear();
      document = authoritative;
      version = currentVersion;
      state = { kind: "idle", version, remote: "local" };
      emit();
    },
    async saveAsNewDraft() {
      if (disposed || state.kind !== "conflict" || !options.saveAsNewDraft)
        return;
      const local = document;
      try {
        const result = await options.saveAsNewDraft(local);
        if (disposed || document !== local) return;
        version = result.version;
        state = { kind: "saved", version, remote: result.remote };
        emit();
        return result;
      } catch (error) {
        if (disposed || document !== local) return;
        state = { kind: "error", local, message: safeSaveMessage(error) };
      }
      emit();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      for (const abort of active.values()) abort.abort();
      active.clear();
      listeners.clear();
    },
  };
}
