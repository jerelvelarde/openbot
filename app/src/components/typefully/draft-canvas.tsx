import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createAutosaveController } from "@/lib/typefully/autosave";
import {
  copyDraftMutationOptions,
  deleteMediaMutationOptions,
  prepareProposalMutationOptions,
  saveDraftMutationOptions,
  uploadMediaMutationOptions,
} from "@/lib/typefully/mutations";
import {
  type AuthoritativeDraft,
  type CanonicalDraftDocument,
  draftQueryOptions,
  type ProposalSummary,
  TypefullyClientError,
} from "@/lib/typefully/queries";
import { CanvasShell } from "./canvas-shell";
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

function EditableDraftCanvas({
  draft,
  onDraftCreated,
}: {
  draft: AuthoritativeDraft;
  onDraftCreated?: (draftId: string) => void;
}) {
  const queryClient = useQueryClient();
  const save = useMutation(saveDraftMutationOptions(queryClient));
  const upload = useMutation(uploadMediaMutationOptions(queryClient));
  const remove = useMutation(deleteMediaMutationOptions(queryClient));
  const copy = useMutation(copyDraftMutationOptions());
  const prepareProposal = useMutation(
    prepareProposalMutationOptions(queryClient),
  );
  const [proposal, setProposal] = useState<ProposalSummary | null>(null);
  const [mediaStates, setMediaStates] = useState<
    Record<string, MediaItemState>
  >({});
  const [localMediaUrls, setLocalMediaUrls] = useState<Record<string, string>>(
    {},
  );
  const [mediaBusy, setMediaBusy] = useState(false);
  const mediaBusyRef = useRef(false);
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
  }, [controller, draft]);

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

  useEffect(
    () => () => {
      controller.dispose();
      for (const url of urls.current.values()) URL.revokeObjectURL?.(url);
      urls.current.clear();
      files.current.clear();
    },
    [controller],
  );

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

  const uploadOne = async (file: File, existingId?: string) => {
    if (mediaBusyRef.current) return;
    const stable = controller.getSnapshot();
    if (
      stable.state.kind !== "idle" &&
      stable.state.kind !== "saved" &&
      stable.state.kind !== "error"
    )
      return;
    const mediaId = existingId ?? `media-${crypto.randomUUID()}`;
    const existing = stable.document.media.find((item) => item.id === mediaId);
    const descriptor = existing ?? {
      id: mediaId,
      kind: file.type.startsWith("video/")
        ? ("video" as const)
        : ("image" as const),
      order: stable.document.media.reduce(
        (highest, item) => Math.max(highest, item.order + 1),
        0,
      ),
      altText: "",
      remoteId: null,
    };
    const optimistic = replaceMedia(stable.document, descriptor);
    files.current.set(mediaId, file);
    bindUrl(mediaId, file);
    controller.reload(
      optimistic,
      stable.target.version,
      stable.target.draftId,
      stable.state.kind === "error" ? "local" : stable.state.remote,
    );
    mediaBusyRef.current = true;
    setMediaBusy(true);
    setMediaStates((current) => ({
      ...current,
      [mediaId]: { kind: "uploading", previewUrl: urls.current.get(mediaId) },
    }));
    try {
      const result = await upload.mutateAsync({
        draftId: stable.target.draftId,
        expectedVersion: stable.target.version,
        kind: descriptor.kind,
        altText: descriptor.altText,
        file,
        mediaId,
      });
      const settled = result.media ?? descriptor;
      const next = replaceMedia(controller.getSnapshot().document, settled);
      controller.reload(
        next,
        result.draft.version,
        stable.target.draftId,
        remoteSaveState(result),
      );
      setMediaStates((current) => ({
        ...current,
        [mediaId]: settled.remoteId
          ? { kind: "ready", previewUrl: urls.current.get(mediaId) }
          : {
              kind: "uncertain",
              message: "Typefully could not confirm this upload.",
              previewUrl: urls.current.get(mediaId),
            },
      }));
    } catch (error) {
      const clientError =
        error instanceof TypefullyClientError ? error : undefined;
      const failed = clientError?.media ?? descriptor;
      const next = replaceMedia(controller.getSnapshot().document, failed);
      const committedVersion = clientError?.draft?.version;
      if (committedVersion !== undefined) {
        controller.remoteFailed(
          next,
          committedVersion,
          clientError,
          stable.target.draftId,
        );
      } else {
        controller.reload(
          next,
          stable.target.version,
          stable.target.draftId,
          "local",
        );
      }
      const uncertain =
        clientError?.code === "outcome_unknown" ||
        clientError?.code === "remote_timeout" ||
        clientError?.code === "remote_error";
      setMediaStates((current) => ({
        ...current,
        [mediaId]: {
          kind: uncertain ? "uncertain" : "failed",
          message:
            clientError?.message ?? "This upload failed. Retry or remove it.",
          previewUrl: urls.current.get(mediaId),
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
    if (
      stable.state.kind !== "idle" &&
      stable.state.kind !== "saved" &&
      stable.state.kind !== "error"
    )
      return;
    const previous = stable.document;
    const next = {
      ...previous,
      media: previous.media.filter((item) => item.id !== mediaId),
    };
    controller.reload(
      next,
      stable.target.version,
      stable.target.draftId,
      stable.state.kind === "error" ? "local" : stable.state.remote,
    );
    mediaBusyRef.current = true;
    setMediaBusy(true);
    try {
      const result = await remove.mutateAsync({
        draftId: stable.target.draftId,
        mediaId,
        expectedVersion: stable.target.version,
      });
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
      if (clientError?.draft?.version !== undefined) {
        controller.remoteFailed(
          next,
          clientError.draft.version,
          clientError,
          stable.target.draftId,
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
          stable.state.kind === "error" ? "local" : stable.state.remote,
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
  const reload = async () => {
    const targetDraftId = controller.getSnapshot().target.draftId;
    try {
      const result = await queryClient.fetchQuery(
        draftQueryOptions(targetDraftId),
      );
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
    try {
      const result = await prepareProposal.mutateAsync({
        draftId: current.target.draftId,
        expectedVersion: current.target.version,
      });
      setProposal(result.proposal);
    } catch {
      // The mutation exposes a bounded client error below; it never publishes.
    }
  };

  return (
    <CanvasShell
      autosave={snapshot}
      document={snapshot.document}
      draft={draft}
      localMediaUrls={localMediaUrls}
      mediaBusy={mediaBusy}
      mediaStates={mediaStates}
      onMediaReorder={controller.textChanged}
      onMediaTextChange={controller.textChanged}
      onReload={() => void reload()}
      onRemoveMedia={(mediaId) => void removeMedia(mediaId)}
      onRetryMedia={retryMedia}
      onRetrySave={controller.retry}
      onSaveAsNew={() => {
        void controller.saveAsNewDraft();
      }}
      onSelectMedia={(selected) => void selectMedia(selected)}
      onTextChange={controller.textChanged}
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
    />
  );
}
