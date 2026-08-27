import { mutationOptions } from "@tanstack/react-query";
import {
  type CanonicalDraftDocument,
  type DraftSummary,
  type PublicationProposal,
  type RemoteDraftState,
  TypefullyClientError,
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
export type MediaMutationResponse = DraftMutationResponse & {
  media?: CanonicalDraftDocument["media"][number] | null;
};
export type TypefullyConnection = {
  serverId: "typefully";
  authMethod: "api_key";
  accountLabel: string;
  connectedAt: string;
};

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

export function saveDraftMutationOptions() {
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
  });
}

export function syncDraftMutationOptions() {
  return mutationOptions({
    mutationFn: (input: { draftId: string; signal?: AbortSignal }) =>
      typefullyRequest<DraftMutationResponse>(
        `/api/typefully/drafts/${encodeURIComponent(input.draftId)}/sync`,
        { method: "POST", signal: input.signal },
      ),
  });
}

export function reconcileDraftMutationOptions() {
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

export function uploadMediaMutationOptions() {
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
  });
}

export function deleteMediaMutationOptions() {
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
  });
}

export function prepareProposalMutationOptions() {
  return mutationOptions({
    mutationFn: (input: {
      draftId: string;
      expectedVersion: number;
      signal?: AbortSignal;
    }): Promise<ProposalMutationResponse> =>
      typefullyRequest(
        `/api/typefully/drafts/${encodeURIComponent(input.draftId)}/proposals`,
        {
          method: "POST",
          body: { expectedVersion: input.expectedVersion },
          signal: input.signal,
        },
      ),
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

export function connectTypefullyMutationOptions() {
  return mutationOptions({
    mutationFn: async (input: {
      apiKey: string;
      signal?: AbortSignal;
    }): Promise<{ connection: TypefullyConnection }> => {
      let response: unknown;
      try {
        response = await typefullyRequest<unknown>(
          "/api/plugins/connections/typefully/api-key",
          {
            method: "PUT",
            body: { apiKey: input.apiKey },
            signal: input.signal,
          },
        );
      } catch (error) {
        if (error instanceof TypefullyClientError) {
          throw new TypefullyClientError(error.code);
        }
        throw new TypefullyClientError("invalid_request");
      }
      if (
        !response ||
        typeof response !== "object" ||
        Array.isArray(response)
      ) {
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
        typeof record.accountLabel !== "string" ||
        Array.from(record.accountLabel).length > 160 ||
        (input.apiKey.length > 0 &&
          record.accountLabel.includes(input.apiKey)) ||
        typeof record.connectedAt !== "string" ||
        Array.from(record.connectedAt).length > 80 ||
        (input.apiKey.length > 0 && record.connectedAt.includes(input.apiKey))
      ) {
        throw new TypefullyClientError("invalid_request");
      }
      return {
        connection: {
          serverId: "typefully",
          authMethod: "api_key",
          accountLabel: record.accountLabel,
          connectedAt: record.connectedAt,
        },
      };
    },
  });
}

export function disconnectTypefullyMutationOptions() {
  return mutationOptions({
    mutationFn: (): Promise<{ ok: true }> =>
      typefullyRequest("/api/plugins/connections/typefully", {
        method: "DELETE",
      }),
  });
}
