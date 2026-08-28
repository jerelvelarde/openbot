import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connectionsQueryOptions } from "@/lib/plugins/queries";
import { createAutosaveController } from "@/lib/typefully/autosave";
import {
  copyDraftMutationOptions,
  deleteMediaMutationOptions,
  prepareProposalMutationOptions,
  saveDraftMutationOptions,
  uploadMediaMutationOptions,
} from "@/lib/typefully/mutations";
import { nextMediaOrder } from "@/lib/typefully/preview";
import {
  type AuthoritativeDraft,
  asLocalTypefullyDraft,
  type CanonicalDraftDocument,
  draftQueryOptions,
  type ProposalSummary,
  TypefullyClientError,
  typefullyKeys,
} from "@/lib/typefully/queries";
import { CanvasShell } from "./canvas-shell";
import {
  ConnectTypefully,
  type PendingTypefullyOperation,
  resumeTypefullyAfterConnection,
} from "./connect-typefully";
import type { MediaItemState } from "./media-editor";

function DraftRefusal({ error }: { error: unknown }) {
  if (error instanceof TypefullyClientError) {
    if (
      error.code === "draft_not_found" ||
      error.code === "channel_forbidden" ||
      error.code === "bot_not_attached"
    ) {
      return (
        <p role="alert">
          Draft unavailable. It may have moved or you may not have access.
        </p>
      );
    }
    if (
      error.code === "connection_required" ||
      error.code === "not_connected" ||
      error.code === "access_revoked" ||
      error.code === "connection_mismatch"
    ) {
      return <p role="alert">Connect Typefully to load this draft.</p>;
    }
    if (error.code === "grant_required") {
      return <p role="alert">Typefully access is unavailable for this Bot.</p>;
    }
  }
  return <p role="alert">This draft could not load. Try again.</p>;
}

export function DraftCanvas({
  draftId,
  onDraftCreated,
}: {
  draftId: string;
  onDraftCreated?: (draftId: string) => void;
}) {
  const draft = useQuery(draftQueryOptions(draftId));
  const connections = useQuery({
    ...connectionsQueryOptions(),
    refetchOnMount: "always",
  });
  const remoteConnected =
    connections.isSuccess &&
    !connections.isFetching &&
    connections.data.connections.some(
      (connection) => connection.serverId === "typefully",
    );
  const connectionConfirmedDisconnected =
    connections.isSuccess &&
    !connections.isFetching &&
    !connections.data.connections.some(
      (connection) => connection.serverId === "typefully",
    );

  if (draft.isPending) {
    return (
      <div className="p-4 text-sm text-muted-foreground" role="status">
        Loading draft…
      </div>
    );
  }
  if (draft.error || !draft.data) {
    return (
      <div className="p-4 text-sm text-destructive">
        <DraftRefusal error={draft.error} />
      </div>
    );
  }
  return (
    <EditableDraftCanvas
      draft={draft.data.draft}
      key={draft.data.draft.id}
      onDraftCreated={onDraftCreated}
      connectionConfirmedDisconnected={connectionConfirmedDisconnected}
      remoteConnected={remoteConnected}
    />
  );
}

function remoteSaveState(result: {
  draft: { version: number; syncStatus: string };
  remote?: { confirmedVersion: number | null; state: string };
}): "local" | "confirmed" {
  return result.draft.syncStatus === "synced" &&
    result.remote?.state === "synced" &&
    result.remote.confirmedVersion === result.draft.version
    ? "confirmed"
    : "local";
}

function replaceMedia(
  document: CanonicalDraftDocument,
  media: CanonicalDraftDocument["media"][number],
) {
  return {
    ...document,
    media: [
      ...document.media.filter((item) => item.id !== media.id),
      media,
    ].sort((left, right) => left.order - right.order),
  };
}

function replaceMediaIdentity(
  document: CanonicalDraftDocument,
  previousId: string,
  media: CanonicalDraftDocument["media"][number],
) {
  return {
    ...document,
    media: [
      ...document.media.filter(
        (item) => item.id !== previousId && item.id !== media.id,
      ),
      media,
    ].sort((left, right) => left.order - right.order),
  };
}

function EditableDraftCanvas({
  draft,
  onDraftCreated,
  connectionConfirmedDisconnected,
  remoteConnected,
}: {
  draft: AuthoritativeDraft;
  onDraftCreated?: (draftId: string) => void;
  connectionConfirmedDisconnected: boolean;
  remoteConnected: boolean;
}) {
  const queryClient = useQueryClient();
  const save = useMutation(saveDraftMutationOptions(queryClient));
  const upload = useMutation(uploadMediaMutationOptions(queryClient));
  const remove = useMutation(deleteMediaMutationOptions(queryClient));
  const copy = useMutation(copyDraftMutationOptions());
  const prepareProposal = useMutation(
    prepareProposalMutationOptions(queryClient),
  );
  const resetPrepareProposal = prepareProposal.reset;
  const [proposal, setProposal] = useState<ProposalSummary | null>(null);
  const [mediaStates, setMediaStates] = useState<
    Record<string, MediaItemState>
  >({});
  const [localMediaUrls, setLocalMediaUrls] = useState<Record<string, string>>(
    {},
  );
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaOperationError, setMediaOperationError] = useState<string | null>(
    null,
  );
  const [pendingConnection, setPendingConnection] =
    useState<PendingTypefullyOperation | null>(() =>
      draft.syncStatus === "connection_required"
        ? draft.document.scheduleAt
          ? {
              kind: "schedule",
              draftId: draft.id,
              expectedVersion: draft.version,
            }
          : {
              kind: "sync",
              draftId: draft.id,
              expectedVersion: draft.version,
            }
        : null,
    );
  const [connectionDismissed, setConnectionDismissed] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const mediaBusyRef = useRef(false);
  const mediaOperation = useRef(0);
  const connectionResume = useRef(0);
  const connectionResumeAbort = useRef<AbortController | null>(null);
  const proposalAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const routedDraft = useRef<string | null>(null);
  const files = useRef(new Map<string, File>());
  const urls = useRef(new Map<string, string>());
  const initialConfirmed =
    draft.syncStatus === "synced" &&
    draft.remoteDraftId !== null &&
    draft.remoteVersion === draft.version &&
    draft.remoteHash === draft.contentHash;
  const [controller] = useState(() =>
    createAutosaveController({
      initialDraftId: draft.id,
      initialDocument: draft.document,
      initialVersion: draft.version,
      initialRemote: initialConfirmed ? "confirmed" : "local",
      debounceMs: 600,
      save: async (input) => {
        const result = await save.mutateAsync(input);
        return {
          version: result.draft.version,
          remote: remoteSaveState(result),
        };
      },
      saveAsNewDraft: async (
        document: CanonicalDraftDocument,
        signal: AbortSignal,
      ) => {
        const result = await copy.mutateAsync({
          sourceDraftId: draft.id,
          document,
          signal,
        });
        return {
          draftId: result.draft.id,
          draft: result.draft,
          version: result.draft.version,
          remote: "local" as const,
        };
      },
    }),
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    if (mediaBusy) return;
    const settled =
      snapshot.state.kind === "idle" || snapshot.state.kind === "saved";
    if (!settled || snapshot.target.version > draft.version) return;
    const confirmed =
      draft.syncStatus === "synced" &&
      draft.remoteVersion === draft.version &&
      draft.remoteHash === draft.contentHash;
    controller.adoptAuthoritative(
      draft.document,
      draft.version,
      draft.id,
      confirmed ? "confirmed" : "local",
    );
  }, [
    controller,
    draft,
    mediaBusy,
    snapshot.state.kind,
    snapshot.target.version,
  ]);

  useEffect(() => {
    const createdId = snapshot.createdDraft?.draftId;
    const settled =
      snapshot.state.kind === "idle" || snapshot.state.kind === "saved";
    if (
      !createdId ||
      !settled ||
      snapshot.target.draftId !== createdId ||
      routedDraft.current === createdId
    )
      return;
    routedDraft.current = createdId;
    onDraftCreated?.(createdId);
  }, [onDraftCreated, snapshot]);

  useEffect(() => {
    if (!proposal) return;
    const settled =
      snapshot.state.kind === "idle" || snapshot.state.kind === "saved";
    if (!settled || snapshot.target.version !== proposal.version)
      setProposal(null);
  }, [proposal, snapshot.state.kind, snapshot.target.version]);

  useEffect(() => {
    if (draft.syncStatus !== "connection_required") {
      setPendingConnection(null);
      setConnectionDismissed(false);
      return;
    }
    if (connectionDismissed) return;
    setPendingConnection(
      (current) =>
        current ??
        (draft.document.scheduleAt
          ? {
              kind: "schedule",
              draftId: draft.id,
              expectedVersion: draft.version,
            }
          : {
              kind: "sync",
              draftId: draft.id,
              expectedVersion: draft.version,
            }),
    );
  }, [connectionDismissed, draft]);

  useEffect(() => {
    if (!connectionConfirmedDisconnected) return;
    connectionResume.current += 1;
    connectionResumeAbort.current?.abort();
    connectionResumeAbort.current = null;
    proposalAbort.current?.abort();
    proposalAbort.current = null;
    resetPrepareProposal();
    setPendingConnection(null);
    setConnectionDismissed(true);
    setConnectionNotice(
      "Typefully disconnected. Your draft remains saved in OpenBot.",
    );
    setProposal(null);
    queryClient.setQueryData<{ draft: AuthoritativeDraft }>(
      typefullyKeys.draft(draft.id),
      (cached) =>
        cached ? { draft: asLocalTypefullyDraft(cached.draft) } : cached,
    );
    const current = controller.getSnapshot();
    controller.adoptAuthoritative(
      current.document,
      current.target.version,
      current.target.draftId,
      "local",
    );
  }, [
    connectionConfirmedDisconnected,
    controller,
    draft.id,
    queryClient,
    resetPrepareProposal,
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      connectionResumeAbort.current?.abort();
      proposalAbort.current?.abort();
      controller.dispose();
      for (const url of urls.current.values()) URL.revokeObjectURL?.(url);
      urls.current.clear();
      files.current.clear();
    };
  }, [controller]);

  const bindUrl = (mediaId: string, file: File) => {
    if (typeof URL.createObjectURL !== "function") return;
    const previous = urls.current.get(mediaId);
    if (previous) URL.revokeObjectURL?.(previous);
    const url = URL.createObjectURL(file);
    urls.current.set(mediaId, url);
    setLocalMediaUrls((current) => ({ ...current, [mediaId]: url }));
  };
  const forgetLocal = (mediaId: string) => {
    files.current.delete(mediaId);
    const url = urls.current.get(mediaId);
    if (url) URL.revokeObjectURL?.(url);
    urls.current.delete(mediaId);
    setLocalMediaUrls((current) => {
      const next = { ...current };
      delete next[mediaId];
      return next;
    });
  };

  const rekeyLocal = (previousId: string, mediaId: string) => {
    if (previousId === mediaId) return;
    const file = files.current.get(previousId);
    if (file) {
      files.current.delete(previousId);
      files.current.set(mediaId, file);
    }
    const url = urls.current.get(previousId);
    if (url) {
      urls.current.delete(previousId);
      urls.current.set(mediaId, url);
    }
    setLocalMediaUrls((current) => {
      const next = { ...current };
      const previous = next[previousId];
      delete next[previousId];
      if (previous) next[mediaId] = previous;
      return next;
    });
    setMediaStates((current) => {
      const next = { ...current };
      const previous = next[previousId];
      delete next[previousId];
      if (previous) next[mediaId] = previous;
      return next;
    });
  };

  const uploadOne = async (file: File, existingId?: string) => {
    if (mediaBusyRef.current) return;
    const stable = controller.getSnapshot();
    if (stable.state.kind !== "idle" && stable.state.kind !== "saved") return;
    const existing = existingId
      ? stable.document.media.find((item) => item.id === existingId)
      : undefined;
    const allocatedOrder = existing
      ? existing.order
      : nextMediaOrder(stable.document.media);
    if (allocatedOrder === undefined) {
      setMediaOperationError(
        "Media capacity reached. Remove an attachment before adding another.",
      );
      return;
    }
    const mediaId = existingId ?? `media-${crypto.randomUUID()}`;
    const descriptor = existing ?? {
      id: mediaId,
      kind: file.type.startsWith("video/")
        ? ("video" as const)
        : ("image" as const),
      order: allocatedOrder,
      altText: "",
      remoteId: null,
    };
    if (!existing) {
      const optimistic = replaceMedia(stable.document, descriptor);
      files.current.set(mediaId, file);
      bindUrl(mediaId, file);
      controller.reload(
        optimistic,
        stable.target.version,
        stable.target.draftId,
        stable.state.remote,
      );
    }
    const operation = ++mediaOperation.current;
    mediaBusyRef.current = true;
    setMediaBusy(true);
    if (!existing) {
      setMediaStates((current) => ({
        ...current,
        [mediaId]: {
          kind: "uploading",
          previewUrl: urls.current.get(mediaId),
        },
      }));
    }
    try {
      const result = await upload.mutateAsync({
        draftId: stable.target.draftId,
        expectedVersion: stable.target.version,
        expectedMediaOrder: descriptor.order,
        expectedMediaCount: existing
          ? stable.document.media.length
          : stable.document.media.length + 1,
        kind: descriptor.kind,
        altText: descriptor.altText,
        file,
        ...(existing ? { mediaId } : {}),
      });
      const settled = result.media ?? (existing ? descriptor : null);
      if (!settled)
        throw new Error("The upload returned no authoritative media ID.");
      rekeyLocal(mediaId, settled.id);
      const current = controller.getSnapshot();
      if (
        mediaOperation.current !== operation ||
        current.target.draftId !== stable.target.draftId
      )
        return;
      const next = replaceMediaIdentity(current.document, mediaId, settled);
      controller.reload(
        next,
        result.draft.version,
        stable.target.draftId,
        remoteSaveState(result),
      );
      setMediaStates((current) => ({
        ...current,
        [settled.id]: settled.remoteId
          ? { kind: "ready", previewUrl: urls.current.get(settled.id) }
          : {
              kind: "uncertain",
              message: "Typefully could not confirm this upload.",
              previewUrl: urls.current.get(settled.id),
            },
      }));
      setMediaOperationError(null);
    } catch (error) {
      const clientError =
        error instanceof TypefullyClientError ? error : undefined;
      if (
        existing &&
        clientError?.code === "remote_invalid_response" &&
        clientError.draft === undefined &&
        clientError.media === undefined
      ) {
        setMediaOperationError(
          "Typefully returned an invalid media response. Retry the upload.",
        );
        return;
      }
      if (!existing && !clientError?.media) {
        controller.reload(
          stable.document,
          stable.target.version,
          stable.target.draftId,
          stable.state.remote,
        );
        forgetLocal(mediaId);
        setMediaStates((current) => {
          const next = { ...current };
          delete next[mediaId];
          return next;
        });
        setMediaOperationError(
          "Media could not be uploaded. Select the file again to retry.",
        );
        return;
      }
      const failed = clientError?.media ?? descriptor;
      rekeyLocal(mediaId, failed.id);
      const current = controller.getSnapshot();
      if (
        mediaOperation.current !== operation ||
        current.target.draftId !== stable.target.draftId
      )
        return;
      const next = replaceMediaIdentity(current.document, mediaId, failed);
      const committedVersion = clientError?.draft?.version;
      if (committedVersion !== undefined) {
        controller.reload(
          next,
          committedVersion,
          stable.target.draftId,
          "local",
        );
      } else {
        controller.reload(
          existing ? next : stable.document,
          stable.target.version,
          stable.target.draftId,
          "local",
        );
        if (!existing) forgetLocal(failed.id);
      }
      const uncertain =
        clientError?.code === "outcome_unknown" ||
        clientError?.code === "remote_timeout" ||
        clientError?.code === "remote_error";
      setMediaStates((current) => ({
        ...current,
        [failed.id]: {
          kind: uncertain ? "uncertain" : "failed",
          message:
            clientError?.message ?? "This upload failed. Retry or remove it.",
          previewUrl: urls.current.get(failed.id),
        },
      }));
    } finally {
      mediaBusyRef.current = false;
      setMediaBusy(false);
    }
  };

  const selectMedia = async (selected: File[]) => {
    for (const file of selected) await uploadOne(file);
  };
  const retryMedia = (mediaId: string) => {
    const file = files.current.get(mediaId);
    if (!file) {
      setMediaStates((current) => ({
        ...current,
        [mediaId]: {
          kind: "failed",
          message: "Choose this file again to retry the upload.",
        },
      }));
      return;
    }
    void uploadOne(file, mediaId);
  };
  const removeMedia = async (mediaId: string) => {
    if (mediaBusyRef.current) return;
    const stable = controller.getSnapshot();
    if (stable.state.kind !== "idle" && stable.state.kind !== "saved") return;
    const previous = stable.document;
    const next = {
      ...previous,
      media: previous.media.filter((item) => item.id !== mediaId),
    };
    controller.reload(
      next,
      stable.target.version,
      stable.target.draftId,
      stable.state.remote,
    );
    const operation = ++mediaOperation.current;
    mediaBusyRef.current = true;
    setMediaBusy(true);
    try {
      const result = await remove.mutateAsync({
        draftId: stable.target.draftId,
        mediaId,
        expectedVersion: stable.target.version,
      });
      const current = controller.getSnapshot();
      if (
        mediaOperation.current !== operation ||
        current.target.draftId !== stable.target.draftId
      )
        return;
      controller.reload(
        next,
        result.draft.version,
        stable.target.draftId,
        remoteSaveState(result),
      );
      setMediaStates((current) => {
        const updated = { ...current };
        delete updated[mediaId];
        return updated;
      });
      forgetLocal(mediaId);
    } catch (error) {
      const clientError =
        error instanceof TypefullyClientError ? error : undefined;
      const current = controller.getSnapshot();
      if (
        mediaOperation.current !== operation ||
        current.target.draftId !== stable.target.draftId
      )
        return;
      if (clientError?.draft?.version !== undefined) {
        controller.reload(
          next,
          clientError.draft.version,
          stable.target.draftId,
          "local",
        );
        setMediaStates((current) => {
          const updated = { ...current };
          delete updated[mediaId];
          return updated;
        });
        forgetLocal(mediaId);
      } else {
        controller.reload(
          previous,
          stable.target.version,
          stable.target.draftId,
          stable.state.remote,
        );
        setMediaStates((current) => ({
          ...current,
          [mediaId]: {
            kind: "failed",
            message: "This attachment could not be removed. Try again.",
            previewUrl: urls.current.get(mediaId),
          },
        }));
      }
    } finally {
      mediaBusyRef.current = false;
      setMediaBusy(false);
    }
  };
  const reload = async (signal?: AbortSignal) => {
    const targetDraftId = controller.getSnapshot().target.draftId;
    try {
      signal?.throwIfAborted();
      const result = await queryClient.fetchQuery(
        draftQueryOptions(targetDraftId),
      );
      signal?.throwIfAborted();
      const authority = result.draft;
      const confirmed =
        authority.syncStatus === "synced" &&
        authority.remoteVersion === authority.version &&
        authority.remoteHash === authority.contentHash;
      controller.reload(
        authority.document,
        authority.version,
        authority.id,
        confirmed ? "confirmed" : "local",
      );
    } catch (error) {
      if (signal?.aborted || !mounted.current) return;
      const current = controller.getSnapshot();
      controller.remoteFailed(
        current.document,
        current.target.version,
        error,
        current.target.draftId,
      );
    }
  };
  const preparePublication = async () => {
    const current = controller.getSnapshot();
    proposalAbort.current?.abort();
    const abort = new AbortController();
    proposalAbort.current = abort;
    try {
      const result = await prepareProposal.mutateAsync({
        draftId: current.target.draftId,
        expectedVersion: current.target.version,
        signal: abort.signal,
      });
      if (!mounted.current || abort.signal.aborted) return;
      setProposal(result.proposal);
    } catch (error) {
      if (
        mounted.current &&
        !abort.signal.aborted &&
        error instanceof TypefullyClientError &&
        error.code === "connection_required"
      ) {
        setConnectionDismissed(false);
        setPendingConnection({
          kind: "prepare_publication",
          draftId: current.target.draftId,
          expectedVersion: current.target.version,
        });
      }
      // The mutation exposes a bounded client error below; it never publishes.
    } finally {
      if (proposalAbort.current === abort) proposalAbort.current = null;
    }
  };

  const resumeAfterConnection = async () => {
    const pending = pendingConnection;
    if (!pending) return;
    connectionResumeAbort.current?.abort();
    const abort = new AbortController();
    connectionResumeAbort.current = abort;
    const operation = ++connectionResume.current;
    setConnectionNotice("Rechecking the draft and Typefully access…");
    try {
      const result = await resumeTypefullyAfterConnection(
        queryClient,
        pending,
        { signal: abort.signal },
      );
      if (
        !mounted.current ||
        abort.signal.aborted ||
        connectionResume.current !== operation
      )
        return;
      setPendingConnection(null);
      setConnectionDismissed(true);
      if (result.outcome === "stale") {
        setConnectionNotice(
          `The draft changed to version ${result.currentVersion}. Review it before retrying ${result.operation.replaceAll("_", " ")}.`,
        );
        await reload(abort.signal);
        return;
      }
      setConnectionNotice(
        "Typefully connected and the draft operation resumed.",
      );
      await reload(abort.signal);
    } catch {
      if (
        !mounted.current ||
        abort.signal.aborted ||
        connectionResume.current !== operation
      )
        return;
      setConnectionNotice(
        "Typefully connected, but this draft operation could not resume. Review the draft and try again.",
      );
      setPendingConnection(null);
      setConnectionDismissed(true);
    } finally {
      if (connectionResumeAbort.current === abort) {
        connectionResumeAbort.current = null;
      }
    }
  };

  return (
    <div className="space-y-2">
      {pendingConnection ? (
        <section
          aria-label="Connect Typefully to resume"
          className="rounded-[8px] border-2 border-border bg-card/50 p-4"
        >
          <ConnectTypefully
            connection={null}
            onCancel={() => {
              connectionResume.current += 1;
              connectionResumeAbort.current?.abort();
              connectionResumeAbort.current = null;
              setPendingConnection(null);
              setConnectionDismissed(true);
              setConnectionNotice(
                "Connection cancelled. Your draft remains saved in OpenBot.",
              );
            }}
            onConnected={() => resumeAfterConnection()}
          />
        </section>
      ) : connectionNotice ? (
        <div
          className="flex items-center justify-between gap-3 rounded-[8px] border border-border bg-card px-4 py-3 text-sm"
          role="status"
        >
          <span>{connectionNotice}</span>
          {draft.syncStatus === "connection_required" ||
          remoteConnected === false ? (
            <button
              className="shrink-0 rounded-[4px] border border-border px-2 py-1 text-xs"
              onClick={() => {
                setConnectionDismissed(false);
                setConnectionNotice(null);
                if (remoteConnected === false) {
                  const current = controller.getSnapshot();
                  setPendingConnection(
                    current.document.scheduleAt
                      ? {
                          kind: "schedule",
                          draftId: current.target.draftId,
                          expectedVersion: current.target.version,
                        }
                      : {
                          kind: "sync",
                          draftId: current.target.draftId,
                          expectedVersion: current.target.version,
                        },
                  );
                }
              }}
              type="button"
            >
              Connect Typefully
            </button>
          ) : null}
        </div>
      ) : null}
      <CanvasShell
        autosave={snapshot}
        document={snapshot.document}
        draft={draft}
        localMediaUrls={localMediaUrls}
        mediaBusy={mediaBusy}
        mediaOperationError={mediaOperationError}
        mediaStates={mediaStates}
        onMediaReorder={(next) => {
          if (!mediaBusyRef.current) controller.textChanged(next);
        }}
        onMediaTextChange={(next) => {
          if (!mediaBusyRef.current) controller.textChanged(next);
        }}
        onDismissMediaOperationError={() => setMediaOperationError(null)}
        onReload={() => void reload()}
        onRemoveMedia={(mediaId) => void removeMedia(mediaId)}
        onRetryMedia={retryMedia}
        onRetrySave={controller.retry}
        onSaveAsNew={() => {
          void controller.saveAsNewDraft();
        }}
        onSelectMedia={(selected) => void selectMedia(selected)}
        onTextChange={(next) => {
          if (!mediaBusyRef.current) controller.textChanged(next);
        }}
        onPreparePublication={() => void preparePublication()}
        proposal={proposal}
        proposalError={
          prepareProposal.error instanceof TypefullyClientError
            ? prepareProposal.error.message
            : prepareProposal.error
              ? "This review could not be prepared. Try again."
              : null
        }
        proposalPreparing={prepareProposal.isPending}
        remoteConnected={remoteConnected}
      />
    </div>
  );
}
