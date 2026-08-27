import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ALLOWED_MEDIA_TYPES, MAX_MEDIA_BYTES } from "./preview";
import {
  type AuthoritativeDraft,
  type CanonicalDraftDocument,
  type DraftSummary,
  draftSummary,
  mediaDescriptor,
  type ProposalStatus,
  type ProposalSummary,
  type PublicationProposal,
  type RemoteDraftState,
  remoteDraftState,
  TypefullyClientError,
  typefullyKeys,
  typefullyRequest,
} from "./queries";

export { TypefullyClientError } from "./queries";

export type DraftMutationResponse = {
  draft: DraftSummary;
  remote?: RemoteDraftState;
  code?: "remote_error";
  retryAt?: string;
  message?: string;
};
export type ProposalMutationResponse = { proposal: PublicationProposal };
export type PrepareProposalResponse = { proposal: ProposalSummary };
export type MediaMutationResponse = DraftMutationResponse & {
  media?: CanonicalDraftDocument["media"][number] | null;
};
export type TypefullyConnection = {
  serverId: "typefully";
  authMethod: "api_key";
  accountLabel: string | null;
  connectedAt: string;
};

type CachedDraft = { draft: AuthoritativeDraft };
type UploadMutationInput = {
  draftId: string;
  expectedVersion: number;
  expectedMediaOrder: number;
  expectedMediaCount: number;
  kind: "image" | "video";
  altText: string;
  file: File;
  mediaId?: string;
  signal?: AbortSignal;
};

function requestBoundUploadAuthority(
  record: { draft: unknown; media: unknown; remote?: unknown },
  input: UploadMutationInput,
  contract: {
    allowedVersionDeltas: readonly number[];
    requireCompleted?: boolean;
    requireSynced?: boolean;
  },
): MediaMutationResponse | undefined {
  const draft = draftSummary(record.draft);
  const media = mediaDescriptor(record.media);
  const hasRemote = record.remote !== undefined;
  const remote = hasRemote ? remoteDraftState(record.remote) : undefined;
  if (!draft || !media) return;
  const versionDelta = draft.version - input.expectedVersion;
  if (
    !contract.allowedVersionDeltas.includes(versionDelta) ||
    draft.id !== input.draftId ||
    (input.mediaId !== undefined && media.id !== input.mediaId) ||
    draft.mediaCount !== input.expectedMediaCount ||
    media.order !== input.expectedMediaOrder ||
    media.kind !== input.kind ||
    media.altText !== input.altText ||
    (contract.requireCompleted && media.remoteId === null) ||
    (contract.requireSynced && draft.syncStatus !== "synced") ||
    (hasRemote &&
      (!remote ||
        remote.state !== draft.syncStatus ||
        (remote.confirmedVersion !== null &&
          remote.confirmedVersion > draft.version) ||
        (remote.state === "synced" &&
          (remote.remoteDraftId === null ||
            remote.confirmedVersion !== draft.version ||
            remote.confirmedHash === null))))
  ) {
    return;
  }
  return { draft, media, ...(remote ? { remote } : {}) };
}

function parseMediaMutationSuccess(
  payload: unknown,
  input: UploadMutationInput,
): MediaMutationResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypefullyClientError("remote_invalid_response");
  }
  const record = payload as Record<string, unknown>;
  const allowed = new Set(["draft", "remote", "media"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypefullyClientError("remote_invalid_response");
  }
  const authority = requestBoundUploadAuthority(
    {
      draft: record.draft,
      media: record.media,
      ...(record.remote === undefined ? {} : { remote: record.remote }),
    },
    input,
    {
      allowedVersionDeltas: [input.mediaId === undefined ? 2 : 1],
      requireCompleted: true,
      requireSynced: true,
    },
  );
  if (!authority) {
    throw new TypefullyClientError("remote_invalid_response");
  }
  return authority;
}

function boundMediaMutationFailure(
  error: TypefullyClientError,
  input: { draftId: string; mediaId?: string },
): TypefullyClientError {
  const hasRecovery =
    error.draft !== undefined ||
    error.media !== undefined ||
    error.remote !== undefined;
  if (!hasRecovery) return error;
  if (
    !error.draft ||
    !error.media ||
    error.draft.id !== input.draftId ||
    (input.mediaId !== undefined && error.media.id !== input.mediaId)
  ) {
    return new TypefullyClientError("remote_invalid_response");
  }
  return error;
}

const uploadErrorCommonShape = {
  error: z.string().min(1).max(500).optional(),
  message: z.string().min(1).max(500).optional(),
};
const uploadPrePersistenceErrorSchema = z.strictObject({
  ...uploadErrorCommonShape,
  code: z.enum([
    "media_too_large",
    "unsupported_media",
    "invalid_request",
    "draft_not_found",
    "version_conflict",
    "bot_not_attached",
    "grant_required",
  ]),
  currentVersion: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  currentHash: z.string().min(1).max(128).optional(),
  ref: z.string().trim().min(1).max(240).optional(),
});
const uploadCommittedErrorSchema = z.strictObject({
  ...uploadErrorCommonShape,
  code: z.enum([
    "remote_error",
    "reconciliation_required",
    "connection_required",
    "grant_required",
    "bot_not_attached",
    "remote_refused",
    "sync_in_progress",
  ]),
  serverId: z.string().trim().min(1).max(120).optional(),
  draftId: z.string().trim().min(1).max(120).optional(),
  connectPath: z.string().min(1).max(500).startsWith("/").optional(),
  ref: z.string().trim().min(1).max(240).optional(),
  retryAt: z.string().datetime().optional(),
  draft: z.unknown(),
  media: z.unknown(),
  remote: z.unknown().optional(),
});
const uploadErrorEnvelopeSchema = z.union([
  uploadCommittedErrorSchema,
  uploadPrePersistenceErrorSchema,
]);
const uploadEarlyFailureCodes = new Set([
  "connection_required",
  "grant_required",
  "bot_not_attached",
  "remote_refused",
  "sync_in_progress",
]);

function normalizeMediaMutationErrorPayload(
  payload: unknown,
  input: UploadMutationInput,
): unknown {
  const parsed = uploadErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TypefullyClientError("remote_invalid_response");
  }
  const record = parsed.data;
  const hasRecovery = "draft" in record;
  if (!hasRecovery) {
    const conflictFieldsPresent =
      record.currentVersion !== undefined || record.currentHash !== undefined;
    if (
      (record.currentVersion === undefined) !==
        (record.currentHash === undefined) ||
      (record.code === "version_conflict") !== conflictFieldsPresent ||
      (record.code === "grant_required") !== (record.ref !== undefined) ||
      (record.ref !== undefined && record.ref !== "typefully/upload_media")
    ) {
      throw new TypefullyClientError("remote_invalid_response");
    }
    return record;
  }
  const hasRemote = "remote" in record;
  const authority = requestBoundUploadAuthority(record, input, {
    allowedVersionDeltas: input.mediaId ? [0, 1] : [1, 2],
  });
  const draft = authority?.draft;
  const media = authority?.media;
  const remote = authority?.remote;
  const versionDelta = draft
    ? draft.version - input.expectedVersion
    : Number.NaN;
  const lateVersionDelta = input.mediaId ? 1 : 2;
  const isEarlyFailure = uploadEarlyFailureCodes.has(record.code);
  const requiresDraftId =
    record.code === "connection_required" ||
    record.code === "reconciliation_required";
  const connectionFieldsPresent =
    record.serverId !== undefined || record.connectPath !== undefined;
  if (
    !draft ||
    !media ||
    (record.draftId !== undefined && record.draftId !== draft.id) ||
    (versionDelta === lateVersionDelta && media.remoteId === null) ||
    (isEarlyFailure && versionDelta === lateVersionDelta) ||
    (isEarlyFailure &&
      input.mediaId === undefined &&
      media.remoteId !== null) ||
    (record.serverId !== undefined && record.serverId !== "typefully") ||
    (record.connectPath !== undefined &&
      record.connectPath !== "/settings/connected-accounts/typefully") ||
    (record.serverId === undefined) !== (record.connectPath === undefined) ||
    (record.code === "connection_required") !== connectionFieldsPresent ||
    (record.code === "grant_required") !== (record.ref !== undefined) ||
    (record.ref !== undefined && record.ref !== "typefully/upload_media") ||
    (requiresDraftId
      ? record.draftId !== input.draftId
      : record.draftId !== undefined) ||
    (record.retryAt !== undefined && record.code !== "remote_error") ||
    (hasRemote && !remote)
  ) {
    throw new TypefullyClientError("remote_invalid_response");
  }
  return { ...record, draft, media, ...(hasRemote ? { remote } : {}) };
}

async function convergeDraftCache(
  queryClient: QueryClient | undefined,
  draftId: string,
  result?: DraftMutationResponse | TypefullyClientError,
  expectedVersion?: number,
  updateDocument?: (document: CanonicalDraftDocument) => CanonicalDraftDocument,
  documentVersionOffsets: readonly number[] = [1],
) {
  if (!queryClient) return;
  const key = typefullyKeys.draft(draftId);
  const resultDraft = result?.draft;
  if (resultDraft) {
    queryClient.setQueryData<CachedDraft>(key, (current) => {
      if (!current) return current;
      if (resultDraft.id !== draftId) return current;
      const incomingVersion = resultDraft.version;
      if (incomingVersion < current.draft.version) return current;
      const remote = "remote" in result ? result.remote : undefined;
      const equalVersion = incomingVersion === current.draft.version;
      const incomingRemoteVersion = remote?.confirmedVersion ?? null;
      const currentRemoteVersion = current.draft.remoteVersion;
      const remoteProgress =
        equalVersion &&
        incomingRemoteVersion !== null &&
        (currentRemoteVersion === null ||
          incomingRemoteVersion > currentRemoteVersion);
      const confirmedUpgrade =
        equalVersion &&
        resultDraft.syncStatus === "synced" &&
        current.draft.syncStatus !== "synced" &&
        (incomingRemoteVersion === null ||
          currentRemoteVersion === null ||
          incomingRemoteVersion >= currentRemoteVersion);
      const replaceDocument =
        updateDocument !== undefined &&
        expectedVersion !== undefined &&
        current.draft.version >= expectedVersion &&
        current.draft.version < incomingVersion &&
        documentVersionOffsets.some(
          (offset) => incomingVersion === expectedVersion + offset,
        );
      const syncStatus = equalVersion
        ? current.draft.syncStatus === "synced"
          ? "synced"
          : remoteProgress || confirmedUpgrade
            ? resultDraft.syncStatus
            : current.draft.syncStatus
        : resultDraft.syncStatus;
      return {
        draft: {
          ...current.draft,
          document: replaceDocument
            ? updateDocument(current.draft.document)
            : current.draft.document,
          version: incomingVersion,
          syncStatus,
          ...(remote && (!equalVersion || remoteProgress)
            ? {
                remoteDraftId: remote.remoteDraftId,
                remoteVersion: remote.confirmedVersion,
                remoteHash: remote.confirmedHash,
              }
            : {}),
        },
      };
    });
  }
  await queryClient.invalidateQueries({
    queryKey: key,
    exact: true,
    refetchType: "all",
  });
}

export function createDraftMutationOptions() {
  return mutationOptions({
    mutationFn: (input: {
      channelId: string;
      botId: string;
      document: CanonicalDraftDocument;
      signal?: AbortSignal;
    }): Promise<{ draft: DraftSummary }> =>
      typefullyRequest("/api/typefully/drafts", {
        method: "POST",
        body: {
          channelId: input.channelId,
          botId: input.botId,
          document: input.document,
        },
        signal: input.signal,
      }),
  });
}

export function copyDraftMutationOptions() {
  return mutationOptions({
    mutationFn: async (input: {
      sourceDraftId: string;
      document: CanonicalDraftDocument;
      signal?: AbortSignal;
    }): Promise<{ draft: DraftSummary }> => {
      const payload = await typefullyRequest<unknown>(
        `/api/typefully/drafts/${encodeURIComponent(input.sourceDraftId)}/copy`,
        {
          method: "POST",
          body: { document: input.document },
          signal: input.signal,
        },
      );
      const value =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? draftSummary((payload as Record<string, unknown>).draft)
          : undefined;
      if (!value) throw new TypefullyClientError("remote_invalid_response");
      return { draft: value };
    },
  });
}

export function saveDraftMutationOptions(queryClient?: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      draftId: string;
      expectedVersion: number;
      document: CanonicalDraftDocument;
      signal?: AbortSignal;
    }): Promise<DraftMutationResponse> =>
      typefullyRequest(
        `/api/typefully/drafts/${encodeURIComponent(input.draftId)}`,
        {
          method: "PUT",
          body: {
            expectedVersion: input.expectedVersion,
            document: input.document,
          },
          signal: input.signal,
        },
      ),
    onSuccess: (result, input) =>
      convergeDraftCache(
        queryClient,
        input.draftId,
        result,
        input.expectedVersion,
        () => input.document,
      ),
    onError: (error, input) => {
      if (error instanceof TypefullyClientError) {
        return convergeDraftCache(
          queryClient,
          input.draftId,
          error,
          input.expectedVersion,
          () => input.document,
        );
      }
    },
  });
}

export function syncDraftMutationOptions(queryClient?: QueryClient) {
  return mutationOptions({
    mutationFn: (input: { draftId: string; signal?: AbortSignal }) =>
      typefullyRequest<DraftMutationResponse>(
        `/api/typefully/drafts/${encodeURIComponent(input.draftId)}/sync`,
        { method: "POST", signal: input.signal },
      ),
    onSuccess: (result, input) =>
      convergeDraftCache(queryClient, input.draftId, result),
    onError: (error, input) => {
      if (error instanceof TypefullyClientError)
        return convergeDraftCache(queryClient, input.draftId, error);
    },
  });
}

export function reconcileDraftMutationOptions(queryClient?: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      draftId: string;
      expectedVersion: number;
      remoteDraftId: string;
      signal?: AbortSignal;
    }) =>
      typefullyRequest<DraftMutationResponse>(
        `/api/typefully/drafts/${encodeURIComponent(input.draftId)}/reconcile`,
        {
          method: "POST",
          body: {
            expectedVersion: input.expectedVersion,
            remoteDraftId: input.remoteDraftId,
          },
          signal: input.signal,
        },
      ),
    onSuccess: (result, input) =>
      convergeDraftCache(
        queryClient,
        input.draftId,
        result,
        input.expectedVersion,
      ),
    onError: (error, input) => {
      if (error instanceof TypefullyClientError)
        return convergeDraftCache(
          queryClient,
          input.draftId,
          error,
          input.expectedVersion,
        );
    },
  });
}

export function uploadMediaMutationOptions(queryClient?: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      input: UploadMutationInput,
    ): Promise<MediaMutationResponse> => {
      if (input.file.size > MAX_MEDIA_BYTES) {
        throw new Error("Typefully media must be no larger than 25 MB.");
      }
      if (!ALLOWED_MEDIA_TYPES.has(input.file.type)) {
        throw new Error("Use a supported image or video format.");
      }
      const form = new FormData();
      form.set("file", input.file);
      form.set("expectedVersion", String(input.expectedVersion));
      form.set("kind", input.kind);
      form.set("altText", input.altText);
      if (input.mediaId !== undefined) form.set("mediaId", input.mediaId);
      try {
        const payload = await typefullyRequest<unknown>(
          `/api/typefully/drafts/${encodeURIComponent(input.draftId)}/media`,
          {
            method: "POST",
            form,
            signal: input.signal,
            normalizeErrorPayload: (payload) =>
              normalizeMediaMutationErrorPayload(payload, input),
          },
        );
        return parseMediaMutationSuccess(payload, input);
      } catch (error) {
        if (error instanceof TypefullyClientError) {
          throw boundMediaMutationFailure(error, input);
        }
        throw error;
      }
    },
    onSuccess: (result, input) =>
      convergeDraftCache(
        queryClient,
        input.draftId,
        result,
        input.expectedVersion,
        (document) => ({
          ...document,
          media:
            result.media &&
            (input.mediaId === undefined || result.media.id === input.mediaId)
              ? [
                  ...document.media.filter(
                    (item) => item.id !== result.media?.id,
                  ),
                  result.media,
                ].sort((left, right) => left.order - right.order)
              : document.media,
        }),
        [1, 2],
      ),
    onError: (error, input) => {
      if (!(error instanceof TypefullyClientError))
        return convergeDraftCache(queryClient, input.draftId);
      if (
        error.code === "remote_invalid_response" &&
        error.draft === undefined &&
        error.media === undefined &&
        error.remote === undefined
      ) {
        return;
      }
      return convergeDraftCache(
        queryClient,
        input.draftId,
        error,
        input.expectedVersion,
        (document) => ({
          ...document,
          media:
            error.media &&
            (input.mediaId === undefined || error.media.id === input.mediaId)
              ? [
                  ...document.media.filter(
                    (item) => item.id !== error.media?.id,
                  ),
                  error.media,
                ].sort((left, right) => left.order - right.order)
              : document.media,
        }),
        [1, 2],
      );
    },
  });
}

export function deleteMediaMutationOptions(queryClient?: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      draftId: string;
      mediaId: string;
      expectedVersion: number;
      signal?: AbortSignal;
    }): Promise<DraftMutationResponse> =>
      typefullyRequest(
        `/api/typefully/drafts/${encodeURIComponent(input.draftId)}/media/${encodeURIComponent(input.mediaId)}`,
        {
          method: "DELETE",
          body: { expectedVersion: input.expectedVersion },
          signal: input.signal,
        },
      ),
    onSuccess: (result, input) =>
      convergeDraftCache(
        queryClient,
        input.draftId,
        result,
        input.expectedVersion,
        (document) => ({
          ...document,
          media: document.media.filter((item) => item.id !== input.mediaId),
        }),
      ),
    onError: (error, input) => {
      if (error instanceof TypefullyClientError)
        return convergeDraftCache(
          queryClient,
          input.draftId,
          error,
          input.expectedVersion,
        );
      return convergeDraftCache(queryClient, input.draftId);
    },
  });
}

const PREPARE_STATUSES = new Set<ProposalStatus>([
  "pending",
  "in_flight",
  "declined",
  "expired",
  "published",
  "failed",
  "unknown",
]);

function bounded(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return Array.from(value).length <= limit ? value : undefined;
}

function preparedProposal(value: unknown): PrepareProposalResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypefullyClientError("invalid_request");
  const proposal = (value as Record<string, unknown>).proposal;
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal))
    throw new TypefullyClientError("invalid_request");
  const item = proposal as Record<string, unknown>;
  const id = bounded(item.id, 120);
  const draftId = bounded(item.draftId, 120);
  const expiresAt = bounded(item.expiresAt, 80);
  const destinations = Array.isArray(item.destinations)
    ? item.destinations
    : null;
  if (
    !id ||
    !draftId ||
    !expiresAt ||
    !Number.isSafeInteger(item.version) ||
    (item.version as number) < 1 ||
    !destinations ||
    destinations.length < 1 ||
    destinations.length > 2 ||
    new Set(destinations).size !== destinations.length ||
    !destinations.every(
      (destination) => destination === "x" || destination === "linkedin",
    ) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    !PREPARE_STATUSES.has(item.status as ProposalStatus)
  ) {
    throw new TypefullyClientError("invalid_request");
  }
  return {
    proposal: {
      id,
      draftId,
      version: item.version as number,
      destinations: destinations as Array<"x" | "linkedin">,
      expiresAt,
      status: item.status as ProposalStatus,
    },
  };
}

export function prepareProposalMutationOptions(queryClient?: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      draftId: string;
      expectedVersion: number;
      signal?: AbortSignal;
    }): Promise<PrepareProposalResponse> =>
      typefullyRequest<unknown>(
        `/api/typefully/drafts/${encodeURIComponent(input.draftId)}/proposals`,
        {
          method: "POST",
          body: { expectedVersion: input.expectedVersion },
          signal: input.signal,
        },
      ).then(preparedProposal),
    onSuccess: async (result, input) => {
      if (!queryClient) return;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: typefullyKeys.draft(input.draftId),
          exact: true,
          refetchType: "all",
        }),
        queryClient.invalidateQueries({
          queryKey: typefullyKeys.proposal(result.proposal.id),
          exact: true,
          refetchType: "all",
        }),
        queryClient.invalidateQueries({
          queryKey: typefullyKeys.lists(),
          refetchType: "all",
        }),
      ]);
    },
  });
}

function proposalAction(
  action: "publish" | "reconcile" | "decline",
  queryClient?: QueryClient,
) {
  return mutationOptions({
    mutationFn: (input: {
      proposalId: string;
      signal?: AbortSignal;
    }): Promise<ProposalMutationResponse> =>
      typefullyRequest(
        `/api/typefully/proposals/${encodeURIComponent(input.proposalId)}/${action}`,
        { method: "POST", signal: input.signal },
      ),
    onSuccess: async (result, input) => {
      if (!queryClient) return;
      queryClient.setQueryData(
        typefullyKeys.proposal(input.proposalId),
        result,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: typefullyKeys.proposal(input.proposalId),
          exact: true,
          refetchType: "all",
        }),
        queryClient.invalidateQueries({
          queryKey: typefullyKeys.lists(),
          refetchType: "all",
        }),
      ]);
    },
    onError: (_error, input) =>
      queryClient?.invalidateQueries({
        queryKey: typefullyKeys.proposal(input.proposalId),
        exact: true,
        refetchType: "all",
      }),
  });
}

export const publishProposalMutationOptions = (queryClient?: QueryClient) =>
  proposalAction("publish", queryClient);
export const reconcileProposalMutationOptions = (queryClient?: QueryClient) =>
  proposalAction("reconcile", queryClient);
export const declineProposalMutationOptions = (queryClient?: QueryClient) =>
  proposalAction("decline", queryClient);

export async function connectTypefully(
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ connection: TypefullyConnection }> {
  let response: unknown;
  try {
    response = await typefullyRequest<unknown>(
      "/api/plugins/connections/typefully/api-key",
      {
        method: "PUT",
        body: { apiKey },
        signal,
      },
    );
  } catch (error) {
    if (error instanceof TypefullyClientError) {
      throw new TypefullyClientError(error.code);
    }
    throw new TypefullyClientError("invalid_request");
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new TypefullyClientError("invalid_request");
  }
  const connection = (response as Record<string, unknown>).connection;
  if (
    !connection ||
    typeof connection !== "object" ||
    Array.isArray(connection)
  ) {
    throw new TypefullyClientError("invalid_request");
  }
  const record = connection as Record<string, unknown>;
  if (
    record.serverId !== "typefully" ||
    record.authMethod !== "api_key" ||
    (record.accountLabel !== null &&
      (typeof record.accountLabel !== "string" ||
        Array.from(record.accountLabel).length > 160 ||
        (apiKey.length > 0 && record.accountLabel.includes(apiKey)))) ||
    typeof record.connectedAt !== "string" ||
    Array.from(record.connectedAt).length > 80 ||
    (apiKey.length > 0 && record.connectedAt.includes(apiKey))
  ) {
    throw new TypefullyClientError("invalid_request");
  }
  return {
    connection: {
      serverId: "typefully",
      authMethod: "api_key",
      accountLabel: record.accountLabel as string | null,
      connectedAt: record.connectedAt,
    },
  };
}

export function disconnectTypefullyMutationOptions() {
  return mutationOptions({
    mutationFn: (): Promise<{ ok: true }> =>
      typefullyRequest("/api/plugins/connections/typefully", {
        method: "DELETE",
      }),
  });
}
