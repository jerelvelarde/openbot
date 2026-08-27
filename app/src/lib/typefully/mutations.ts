import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  type AuthoritativeDraft,
  type CanonicalDraftDocument,
  type DraftSummary,
  type ProposalStatus,
  type ProposalSummary,
  type PublicationProposal,
  type RemoteDraftState,
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

function patchDraftCache(
  queryClient: QueryClient | undefined,
  draftId: string,
  result: DraftMutationResponse | TypefullyClientError,
  updateDocument?: (document: CanonicalDraftDocument) => CanonicalDraftDocument,
) {
  if (!queryClient || !result.draft) return;
  const key = typefullyKeys.draft(draftId);
  queryClient.setQueryData<CachedDraft>(key, (current) => {
    if (!current) return current;
    const remote = "remote" in result ? result.remote : undefined;
    return {
      draft: {
        ...current.draft,
        document: updateDocument
          ? updateDocument(current.draft.document)
          : current.draft.document,
        version: result.draft?.version ?? current.draft.version,
        syncStatus: result.draft?.syncStatus ?? current.draft.syncStatus,
        ...(remote
          ? {
              remoteDraftId: remote.remoteDraftId,
              remoteVersion: remote.confirmedVersion,
              remoteHash: remote.confirmedHash,
            }
          : {}),
      },
    };
  });
  void queryClient.invalidateQueries({ queryKey: key, exact: true });
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
      patchDraftCache(queryClient, input.draftId, result, () => input.document),
    onError: (error, input) => {
      if (error instanceof TypefullyClientError) {
        patchDraftCache(
          queryClient,
          input.draftId,
          error,
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
      patchDraftCache(queryClient, input.draftId, result),
    onError: (error, input) => {
      if (error instanceof TypefullyClientError)
        patchDraftCache(queryClient, input.draftId, error);
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
      patchDraftCache(queryClient, input.draftId, result),
    onError: (error, input) => {
      if (error instanceof TypefullyClientError)
        patchDraftCache(queryClient, input.draftId, error);
    },
  });
}

const MAX_MEDIA_BYTES = 25_000_000;
const ALLOWED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
]);

export function uploadMediaMutationOptions(queryClient?: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      draftId: string;
      expectedVersion: number;
      kind: "image" | "video";
      altText: string;
      file: File;
      mediaId?: string;
      signal?: AbortSignal;
    }): Promise<MediaMutationResponse> => {
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
      return typefullyRequest(
        `/api/typefully/drafts/${encodeURIComponent(input.draftId)}/media`,
        { method: "POST", form, signal: input.signal },
      );
    },
    onSuccess: (result, input) =>
      patchDraftCache(queryClient, input.draftId, result, (document) => ({
        ...document,
        media: result.media
          ? [
              ...document.media.filter((item) => item.id !== result.media?.id),
              result.media,
            ].sort((left, right) => left.order - right.order)
          : document.media,
      })),
    onError: (error, input) => {
      if (!(error instanceof TypefullyClientError)) return;
      patchDraftCache(queryClient, input.draftId, error, (document) => ({
        ...document,
        media: error.media
          ? [
              ...document.media.filter((item) => item.id !== error.media?.id),
              error.media,
            ].sort((left, right) => left.order - right.order)
          : document.media,
      }));
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
      patchDraftCache(queryClient, input.draftId, result, (document) => ({
        ...document,
        media: document.media.filter((item) => item.id !== input.mediaId),
      })),
    onError: (error, input) => {
      if (error instanceof TypefullyClientError)
        patchDraftCache(queryClient, input.draftId, error);
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

export function prepareProposalMutationOptions() {
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
  });
}

function proposalAction(action: "publish" | "reconcile" | "decline") {
  return mutationOptions({
    mutationFn: (input: {
      proposalId: string;
      signal?: AbortSignal;
    }): Promise<ProposalMutationResponse> =>
      typefullyRequest(
        `/api/typefully/proposals/${encodeURIComponent(input.proposalId)}/${action}`,
        { method: "POST", signal: input.signal },
      ),
  });
}

export const publishProposalMutationOptions = () => proposalAction("publish");
export const reconcileProposalMutationOptions = () =>
  proposalAction("reconcile");
export const declineProposalMutationOptions = () => proposalAction("decline");

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
