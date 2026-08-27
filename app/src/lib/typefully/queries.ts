import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

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

const stableIdSchema = z.string().trim().min(1).max(120);
const destinationSchema = z.enum(["x", "linkedin"]);
const uniqueDestinationsSchema = z
  .array(destinationSchema)
  .min(1)
  .max(2)
  .refine((items) => new Set(items).size === items.length);
const postSchema = z.strictObject({
  id: stableIdSchema,
  x: z.string().max(100_000),
  linkedin: z.string().max(100_000),
});
const postsSchema = z
  .array(postSchema)
  .min(1)
  .max(50)
  .refine((items) => new Set(items.map(({ id }) => id)).size === items.length);
const mediaSchema = z
  .array(
    z.strictObject({
      id: stableIdSchema,
      kind: z.enum(["image", "video"]),
      order: z
        .number()
        .int()
        .min(Number.MIN_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
      altText: z.string().max(10_000),
      remoteId: z.string().trim().min(1).max(240).nullable(),
    }),
  )
  .max(20)
  .refine(
    (items) =>
      new Set(items.map(({ id }) => id)).size === items.length &&
      new Set(items.map(({ order }) => order)).size === items.length,
  );
const canonicalDraftDocumentSchema = z.strictObject({
  title: z.string().trim().max(160),
  destinations: uniqueDestinationsSchema,
  socialSetId: z.string().trim().max(120).nullable(),
  accountLabel: z.string().trim().max(160).nullable(),
  posts: postsSchema,
  media: mediaSchema,
  scheduleAt: z.string().datetime().nullable(),
});
const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const authoritativeDraftResponseSchema = z.strictObject({
  draft: z.strictObject({
    id: z.string().uuid(),
    document: canonicalDraftDocumentSchema,
    version: positiveSafeInteger,
    contentHash: z.string().min(1).max(128),
    remoteDraftId: z.string().trim().min(1).max(240).nullable(),
    remoteVersion: positiveSafeInteger.nullable(),
    remoteHash: z.string().min(1).max(128).nullable(),
    syncStatus: z.enum([
      "local",
      "syncing",
      "synced",
      "connection_required",
      "remote_error",
      "grant_blocked",
    ]),
    lastError: z.string().max(500).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
});

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
  return typefullyErrorCode(value) ?? "invalid_request";
}

const ERROR_CODES = new Set<string>([
  ...Object.keys(ERROR_MESSAGES),
  "invalid_request",
]);

export function typefullyErrorCode(
  value: unknown,
): TypefullyErrorCode | undefined {
  return typeof value === "string" && ERROR_CODES.has(value)
    ? (value as TypefullyErrorCode)
    : undefined;
}

const draftSummarySchema = z.strictObject({
  id: stableIdSchema,
  title: z.string().max(160),
  destinations: uniqueDestinationsSchema,
  socialSetLabel: z.string().max(160).nullable(),
  mediaCount: z.number().int().min(0).max(20),
  version: positiveSafeInteger,
  syncStatus: z.enum([
    "local",
    "syncing",
    "synced",
    "connection_required",
    "remote_error",
    "grant_blocked",
  ]),
  proposalStatus: z
    .enum([
      "pending",
      "in_flight",
      "declined",
      "expired",
      "published",
      "failed",
      "unknown",
    ])
    .nullable(),
});

const remoteDraftStateSchema = z.strictObject({
  state: draftSummarySchema.shape.syncStatus,
  remoteDraftId: z.string().trim().min(1).max(240).nullable(),
  confirmedVersion: positiveSafeInteger.nullable(),
  confirmedHash: z.string().min(1).max(128).nullable(),
});

const mediaDescriptorSchema = z.strictObject({
  id: stableIdSchema,
  kind: z.enum(["image", "video"]),
  order: z.number().int().min(0).max(19),
  altText: z.string().max(10_000),
  remoteId: z.string().trim().min(1).max(240).nullable(),
});

export function draftSummary(value: unknown): DraftSummary | undefined {
  const parsed = draftSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function remoteDraftState(value: unknown): RemoteDraftState | undefined {
  const parsed = remoteDraftStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function mediaDescriptor(
  value: unknown,
): CanonicalDraftDocument["media"][number] | null | undefined {
  if (value === null) return null;
  const parsed = mediaDescriptorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  normalizeErrorPayload?: (payload: unknown) => unknown;
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

  const normalizedPayload = options.normalizeErrorPayload
    ? options.normalizeErrorPayload(payload)
    : payload;

  const record =
    normalizedPayload &&
    typeof normalizedPayload === "object" &&
    !Array.isArray(normalizedPayload)
      ? (normalizedPayload as Record<string, unknown>)
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
  lists: () => ["typefully", "list"] as const,
  draft: (draftId: string) => ["typefully", "draft", draftId] as const,
  proposal: (proposalId: string) =>
    ["typefully", "proposal", proposalId] as const,
};

export function asLocalTypefullyDraft(
  draft: AuthoritativeDraft,
): AuthoritativeDraft {
  return {
    ...draft,
    remoteDraftId: null,
    remoteVersion: null,
    remoteHash: null,
    syncStatus: "local",
    lastError: null,
  };
}

export async function loadAuthoritativeDraft(
  draftId: string,
  signal?: AbortSignal,
): Promise<{ draft: AuthoritativeDraft }> {
  const payload = await typefullyRequest<unknown>(
    `/api/typefully/drafts/${encodeURIComponent(draftId)}`,
    { signal },
  );
  const parsed = authoritativeDraftResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.draft.id !== draftId) {
    throw new TypefullyClientError("remote_invalid_response");
  }
  return parsed.data;
}

export function draftQueryOptions(draftId: string) {
  return queryOptions({
    queryKey: typefullyKeys.draft(draftId),
    enabled: draftId.length > 0,
    gcTime: 0,
    queryFn: ({ signal }): Promise<{ draft: AuthoritativeDraft }> =>
      loadAuthoritativeDraft(draftId, signal),
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
