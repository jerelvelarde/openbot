import { queryOptions } from "@tanstack/react-query";

export type TypefullyDestination = "x" | "linkedin";
export type DraftSyncStatus =
  | "local"
  | "syncing"
  | "synced"
  | "connection_required"
  | "remote_error"
  | "grant_blocked";
export type ProposalStatus =
  | "pending"
  | "in_flight"
  | "declined"
  | "expired"
  | "published"
  | "failed"
  | "unknown";

export type CanonicalDraftDocument = {
  title: string;
  destinations: TypefullyDestination[];
  socialSetId: string | null;
  accountLabel: string | null;
  posts: Array<{ id: string; x: string; linkedin: string }>;
  media: Array<{
    id: string;
    kind: "image" | "video";
    order: number;
    altText: string;
    remoteId: string | null;
  }>;
  scheduleAt: string | null;
};

export type DraftSummary = {
  id: string;
  title: string;
  destinations: TypefullyDestination[];
  socialSetLabel: string | null;
  mediaCount: number;
  version: number;
  syncStatus: DraftSyncStatus;
  proposalStatus: ProposalStatus | null;
};

export type RemoteDraftState = {
  state: DraftSyncStatus;
  remoteDraftId: string | null;
  confirmedVersion: number | null;
  confirmedHash: string | null;
};

export type AuthoritativeDraft = {
  id: string;
  document: CanonicalDraftDocument;
  version: number;
  contentHash: string;
  remoteDraftId: string | null;
  remoteVersion: number | null;
  remoteHash: string | null;
  syncStatus: DraftSyncStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicationProposal = {
  id: string;
  draftId: string;
  version: number;
  destinations: TypefullyDestination[];
  expiresAt: string;
  status: ProposalStatus;
  snapshot: CanonicalDraftDocument;
  contentHash: string;
  decidedAt: string | null;
  completedAt: string | null;
  vendorResultId: string | null;
  publishedUrl: string | null;
  failureDetail: string | null;
};

export type ProposalSummary = Pick<
  PublicationProposal,
  "id" | "draftId" | "version" | "destinations" | "expiresAt" | "status"
>;

export type TypefullyErrorCode =
  | "access_revoked"
  | "bot_not_attached"
  | "channel_forbidden"
  | "connection_mismatch"
  | "connection_required"
  | "connector_not_enabled"
  | "draft_not_found"
  | "grant_required"
  | "in_flight"
  | "invalid_api_key"
  | "invalid_request"
  | "media_too_large"
  | "not_connected"
  | "outcome_unknown"
  | "proposal_changed"
  | "proposal_expired"
  | "proposal_not_pending"
  | "proposal_not_reconcilable"
  | "rate_limited"
  | "reconciliation_required"
  | "remote_error"
  | "remote_invalid_response"
  | "remote_refused"
  | "remote_timeout"
  | "remote_unavailable"
  | "sync_in_progress"
  | "unsupported_media"
  | "validation_timeout"
  | "validation_unavailable"
  | "version_conflict";

export type TypefullyErrorDetails = {
  currentVersion?: number;
  currentHash?: string;
  serverId?: string;
  draftId?: string;
  connectPath?: string;
  ref?: string;
  retryAt?: string;
  draft?: DraftSummary;
  remote?: RemoteDraftState;
  media?: CanonicalDraftDocument["media"][number] | null;
};

const ERROR_MESSAGES: Partial<Record<TypefullyErrorCode, string>> = {
  access_revoked: "Your access to this connection was revoked.",
  bot_not_attached: "This Bot is no longer attached to the channel.",
  channel_forbidden: "This channel is not available.",
  connection_mismatch: "This account uses a different connection method.",
  connection_required: "Connect your Typefully account to continue.",
  connector_not_enabled: "Typefully is not enabled for this workspace.",
  draft_not_found: "This draft is no longer available.",
  grant_required: "This Bot needs access to the required Typefully action.",
  in_flight: "This operation is already in progress.",
  invalid_api_key: "Typefully did not accept that API key.",
  media_too_large: "Typefully media must be no larger than 25 MB.",
  not_connected: "No Typefully account is connected.",
  outcome_unknown: "Typefully's publication outcome must be reconciled.",
  proposal_changed: "The draft changed. Review it again before publishing.",
  proposal_expired: "This approval expired. Review the draft again.",
  proposal_not_pending: "This approval is no longer pending.",
  proposal_not_reconcilable:
    "This publication cannot be reconciled in its current state.",
  rate_limited: "Typefully is rate limiting requests. Try again later.",
  reconciliation_required:
    "The remote outcome is uncertain and must be reconciled.",
  remote_error:
    "Typefully could not confirm this change. Your local draft is preserved.",
  remote_invalid_response: "Typefully returned an invalid response. Try again.",
  remote_refused: "Typefully refused this operation.",
  remote_timeout: "Typefully did not respond in time. Try again.",
  remote_unavailable: "Typefully is temporarily unavailable. Try again.",
  sync_in_progress: "This draft is already syncing.",
  unsupported_media: "Use a supported image or video format.",
  validation_timeout: "Typefully did not validate the key in time. Try again.",
  validation_unavailable: "Typefully could not validate the key. Try again.",
  version_conflict:
    "This draft changed elsewhere. Review the latest version before saving again.",
};

function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return Array.from(value).length <= limit ? value : undefined;
}

function errorCode(value: unknown): TypefullyErrorCode {
  if (typeof value !== "string") return "invalid_request";
  return value in ERROR_MESSAGES || value === "invalid_request"
    ? (value as TypefullyErrorCode)
    : "invalid_request";
}

const SYNC_STATUSES = new Set<DraftSyncStatus>([
  "local",
  "syncing",
  "synced",
  "connection_required",
  "remote_error",
  "grant_blocked",
]);
const PROPOSAL_STATUSES = new Set<ProposalStatus>([
  "pending",
  "in_flight",
  "declined",
  "expired",
  "published",
  "failed",
  "unknown",
]);

function draftSummary(value: unknown): DraftSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    Array.from(item.id).length > 120 ||
    typeof item.title !== "string" ||
    Array.from(item.title).length > 160 ||
    !Array.isArray(item.destinations) ||
    !item.destinations.every(
      (destination) => destination === "x" || destination === "linkedin",
    ) ||
    (item.socialSetLabel !== null &&
      (typeof item.socialSetLabel !== "string" ||
        Array.from(item.socialSetLabel).length > 160)) ||
    !Number.isSafeInteger(item.mediaCount) ||
    (item.mediaCount as number) < 0 ||
    (item.mediaCount as number) > 20 ||
    !Number.isSafeInteger(item.version) ||
    (item.version as number) < 1 ||
    !SYNC_STATUSES.has(item.syncStatus as DraftSyncStatus) ||
    (item.proposalStatus !== null &&
      !PROPOSAL_STATUSES.has(item.proposalStatus as ProposalStatus))
  ) {
    return undefined;
  }
  return {
    id: item.id,
    title: item.title,
    destinations: item.destinations as TypefullyDestination[],
    socialSetLabel: item.socialSetLabel as string | null,
    mediaCount: item.mediaCount as number,
    version: item.version as number,
    syncStatus: item.syncStatus as DraftSyncStatus,
    proposalStatus: item.proposalStatus as ProposalStatus | null,
  };
}

function remoteDraftState(value: unknown): RemoteDraftState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const item = value as Record<string, unknown>;
  if (!SYNC_STATUSES.has(item.state as DraftSyncStatus)) return undefined;
  const remoteDraftId = boundedString(item.remoteDraftId, 240);
  const confirmedHash = boundedString(item.confirmedHash, 128);
  if (
    (item.remoteDraftId !== null && remoteDraftId === undefined) ||
    (item.confirmedHash !== null && confirmedHash === undefined) ||
    (item.confirmedVersion !== null &&
      !Number.isSafeInteger(item.confirmedVersion))
  ) {
    return undefined;
  }
  return {
    state: item.state as DraftSyncStatus,
    remoteDraftId: item.remoteDraftId === null ? null : (remoteDraftId ?? null),
    confirmedVersion:
      item.confirmedVersion === null ? null : (item.confirmedVersion as number),
    confirmedHash: item.confirmedHash === null ? null : (confirmedHash ?? null),
  };
}

function mediaDescriptor(
  value: unknown,
): CanonicalDraftDocument["media"][number] | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const item = value as Record<string, unknown>;
  const id = boundedString(item.id, 120);
  const altText = boundedString(item.altText, 10_000);
  const remoteId = boundedString(item.remoteId, 240);
  if (
    id === undefined ||
    (item.kind !== "image" && item.kind !== "video") ||
    !Number.isSafeInteger(item.order) ||
    (item.order as number) < 0 ||
    (item.order as number) >= 20 ||
    altText === undefined ||
    (item.remoteId !== null && remoteId === undefined)
  ) {
    return undefined;
  }
  return {
    id,
    kind: item.kind,
    order: item.order as number,
    altText,
    remoteId: item.remoteId === null ? null : (remoteId ?? null),
  };
}

export class TypefullyClientError extends Error {
  readonly code: TypefullyErrorCode;
  readonly currentVersion?: number;
  readonly currentHash?: string;
  readonly serverId?: string;
  readonly draftId?: string;
  readonly connectPath?: string;
  readonly ref?: string;
  readonly retryAt?: string;
  readonly draft?: DraftSummary;
  readonly remote?: RemoteDraftState;
  readonly media?: CanonicalDraftDocument["media"][number] | null;

  constructor(code: TypefullyErrorCode, details: TypefullyErrorDetails = {}) {
    super(
      ERROR_MESSAGES[code] ?? "That Typefully request could not be completed.",
    );
    this.name = "TypefullyClientError";
    this.code = code;
    Object.assign(this, details);
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
};

export async function typefullyRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "include",
    headers:
      options.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body:
      options.form ??
      (options.body === undefined ? undefined : JSON.stringify(options.body)),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.ok) return payload as T;

  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const code = errorCode(record.code);
  throw new TypefullyClientError(code, {
    ...(Number.isSafeInteger(record.currentVersion)
      ? { currentVersion: record.currentVersion as number }
      : {}),
    ...(boundedString(record.currentHash, 128)
      ? { currentHash: boundedString(record.currentHash, 128) }
      : {}),
    ...(boundedString(record.serverId, 120)
      ? { serverId: boundedString(record.serverId, 120) }
      : {}),
    ...(boundedString(record.draftId, 120)
      ? { draftId: boundedString(record.draftId, 120) }
      : {}),
    ...(boundedString(record.connectPath, 500)
      ? { connectPath: boundedString(record.connectPath, 500) }
      : {}),
    ...(boundedString(record.ref, 240)
      ? { ref: boundedString(record.ref, 240) }
      : {}),
    ...(boundedString(record.retryAt, 80)
      ? { retryAt: boundedString(record.retryAt, 80) }
      : {}),
    ...(draftSummary(record.draft)
      ? { draft: draftSummary(record.draft) }
      : {}),
    ...(remoteDraftState(record.remote)
      ? { remote: remoteDraftState(record.remote) }
      : {}),
    ...(mediaDescriptor(record.media) !== undefined
      ? { media: mediaDescriptor(record.media) }
      : {}),
  });
}

export const typefullyKeys = {
  all: ["typefully"] as const,
  draft: (draftId: string) => ["typefully", "draft", draftId] as const,
  proposal: (proposalId: string) =>
    ["typefully", "proposal", proposalId] as const,
};

export function draftQueryOptions(draftId: string) {
  return queryOptions({
    queryKey: typefullyKeys.draft(draftId),
    enabled: draftId.length > 0,
    queryFn: ({ signal }): Promise<{ draft: AuthoritativeDraft }> =>
      typefullyRequest(`/api/typefully/drafts/${encodeURIComponent(draftId)}`, {
        signal,
      }),
  });
}

export function proposalQueryOptions(proposalId: string) {
  return queryOptions({
    queryKey: typefullyKeys.proposal(proposalId),
    enabled: proposalId.length > 0,
    queryFn: ({ signal }): Promise<{ proposal: PublicationProposal }> =>
      typefullyRequest(
        `/api/typefully/proposals/${encodeURIComponent(proposalId)}`,
        { signal },
      ),
  });
}
