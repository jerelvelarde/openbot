import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import {
  type AuditTransaction,
  recordAuditEvent,
  type TransactionalAuditStore,
} from "../audit";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  typefullyDrafts,
  typefullyPublicationProposals,
} from "../db/schema";
import type {
  PluginCallResult,
  PluginDecision,
  PluginKind,
} from "../plugins/store";
import { typefullyBotContracts } from "../plugins/typefully-contracts";
import {
  type CanonicalDraftDocument,
  canonicalizeDraft,
  type DraftSyncStatus,
  draftSummary,
  proposalStatusSchema,
  syncStatusSchema,
} from "./document";
import {
  changedProposalError,
  ProposalStateError,
  type PublicationOutcome,
  type PublicationProposal,
  type PublicationVendor,
  proposalSummary,
  remoteMatchesSnapshot,
  safePublicationOutcome,
} from "./publication";

const LAST_ERROR_MAX_LENGTH = 500;
const DEFAULT_VENDOR_ID = "typefully";
const MAX_TYPEFULLY_DRAFT_ID = BigInt(Number.MAX_SAFE_INTEGER);
type RemoteDraftOperation = "create_draft" | "update_draft";
type RemoteAttemptKind = RemoteDraftOperation | "upload_media" | "remove_media";
type RemoteAttemptState = "in_flight" | "outcome_uncertain";
const DEFAULT_ATTEMPT_LEASE_MS = 60_000;

const SENSITIVE_ERROR_FIELD =
  /\b(api[\p{P}\p{Z}\s]*key|authorization|access[\p{P}\p{Z}\s]*token|refresh[\p{P}\p{Z}\s]*token|client[\p{P}\p{Z}\s]*secret|id[\p{P}\p{Z}\s]*token|token|secret)(\s*(?:[:=]\s*)+|\s+)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;&]+)/giu;
const SENSITIVE_JSON_FIELD =
  /(["'])(api[\p{P}\p{Z}\s]*key|authorization|access[\p{P}\p{Z}\s]*token|refresh[\p{P}\p{Z}\s]*token|client[\p{P}\p{Z}\s]*secret|id[\p{P}\p{Z}\s]*token|token|secret)\1(\s*:\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,}\]]+)/giu;

type AuthorizationSurface = {
  decide(kind: PluginKind, ref: string, botId: string): Promise<PluginDecision>;
  dispatchVendor?(input: {
    ref: string;
    args: Record<string, unknown>;
    botId: string;
    actorId: string;
  }): Promise<PluginCallResult>;
  authorizeOperation?(input: {
    requiredGrantRef: string;
    ref: string;
    botId: string;
    actorId: string;
    context: {
      intent: "write_tool";
      mcp: { server: string; tool: string; effect: "write" };
    };
  }): Promise<{ token: string; decision: unknown }>;
};

type VendorIdentity =
  | string
  | {
      serverId?: string;
      [key: string]: unknown;
    };

export type TypefullyDraft = {
  id: string;
  ownerUserId: string;
  channelId: string;
  botId: string;
  remoteDraftId: string | null;
  document: CanonicalDraftDocument;
  version: number;
  contentHash: string;
  remoteVersion: number | null;
  remoteHash: string | null;
  syncStatus: DraftSyncStatus;
  lastError: string | null;
  attemptId: string | null;
  attemptKind: RemoteAttemptKind | null;
  attemptState: RemoteAttemptState | null;
  attemptVersion: number | null;
  attemptHash: string | null;
  attemptRemoteDraftId: string | null;
  attemptLeaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export class DraftNotFoundError extends Error {
  readonly code = "draft_not_found" as const;
  readonly status = 404 as const;

  constructor() {
    super("Draft not found");
    this.name = "DraftNotFoundError";
  }
}

export class VersionConflictError extends Error {
  readonly code = "version_conflict" as const;
  readonly status = 409 as const;

  constructor(
    readonly currentVersion: number,
    readonly currentHash: string,
  ) {
    super("The draft changed after this version was loaded.");
    this.name = "VersionConflictError";
  }
}

export class BotNotAttachedError extends Error {
  readonly code = "bot_not_attached" as const;
  readonly status = 409 as const;

  constructor() {
    super("The originating Bot is no longer attached to this channel.");
    this.name = "BotNotAttachedError";
  }
}

export class GrantRequiredError extends Error {
  readonly code = "grant_required" as const;
  readonly status = 403 as const;

  constructor(
    readonly ref: string,
    message: string,
  ) {
    super(message);
    this.name = "GrantRequiredError";
  }
}

export class InvalidRemoteDraftIdError extends Error {
  readonly code = "invalid_remote_draft_id" as const;
  readonly status = 400 as const;

  constructor() {
    super("Typefully returned an invalid draft id.");
    this.name = "InvalidRemoteDraftIdError";
  }
}

export class RemoteConfirmationConflictError extends Error {
  readonly code = "remote_confirmation_conflict" as const;
  readonly status = 409 as const;

  constructor(readonly currentRemoteDraftId: string) {
    super("This draft revision is already attached to another remote draft.");
    this.name = "RemoteConfirmationConflictError";
  }
}

export class SyncInProgressError extends Error {
  readonly code = "sync_in_progress" as const;
  readonly status = 409 as const;
  constructor() {
    super("This draft revision is already syncing.");
    this.name = "SyncInProgressError";
  }
}

export class ReconciliationRequiredError extends Error {
  readonly code = "reconciliation_required" as const;
  readonly status = 409 as const;
  constructor(readonly draftId: string) {
    super(
      "Typefully may have created this draft. Confirm it in Typefully and attach its draft id before retrying.",
    );
    this.name = "ReconciliationRequiredError";
  }
}

class StaleRemoteAttemptError extends Error {}
class StaleAuthorizationError extends Error {}

const draftSelection = {
  id: typefullyDrafts.id,
  ownerUserId: typefullyDrafts.ownerUserId,
  channelId: typefullyDrafts.channelId,
  botId: typefullyDrafts.botId,
  remoteDraftId: typefullyDrafts.remoteDraftId,
  document: typefullyDrafts.document,
  version: typefullyDrafts.version,
  contentHash: typefullyDrafts.contentHash,
  remoteVersion: typefullyDrafts.remoteVersion,
  remoteHash: typefullyDrafts.remoteHash,
  syncStatus: typefullyDrafts.syncStatus,
  lastError: typefullyDrafts.lastError,
  attemptId: typefullyDrafts.attemptId,
  attemptKind: typefullyDrafts.attemptKind,
  attemptState: typefullyDrafts.attemptState,
  attemptVersion: typefullyDrafts.attemptVersion,
  attemptHash: typefullyDrafts.attemptHash,
  attemptRemoteDraftId: typefullyDrafts.attemptRemoteDraftId,
  attemptLeaseExpiresAt: typefullyDrafts.attemptLeaseExpiresAt,
  createdAt: typefullyDrafts.createdAt,
  updatedAt: typefullyDrafts.updatedAt,
};

const proposalSelection = {
  id: typefullyPublicationProposals.id,
  draftId: typefullyPublicationProposals.draftId,
  ownerUserId: typefullyPublicationProposals.ownerUserId,
  botId: typefullyPublicationProposals.botId,
  channelId: typefullyPublicationProposals.channelId,
  draftVersion: typefullyPublicationProposals.draftVersion,
  contentHash: typefullyPublicationProposals.contentHash,
  snapshot: typefullyPublicationProposals.snapshot,
  status: typefullyPublicationProposals.status,
  expiresAt: typefullyPublicationProposals.expiresAt,
  decidedAt: typefullyPublicationProposals.decidedAt,
  completedAt: typefullyPublicationProposals.completedAt,
  vendorResultId: typefullyPublicationProposals.vendorResultId,
  publishedUrl: typefullyPublicationProposals.publishedUrl,
  failureDetail: typefullyPublicationProposals.failureDetail,
  createdAt: typefullyPublicationProposals.createdAt,
  updatedAt: typefullyPublicationProposals.updatedAt,
};

type SelectedProposal = typeof typefullyPublicationProposals.$inferSelect;

function asProposal(row: SelectedProposal): PublicationProposal {
  const snapshot = canonicalizeDraft(row.snapshot).document;
  return {
    ...proposalSummary({
      id: row.id,
      draftId: row.draftId,
      draftVersion: row.draftVersion,
      snapshot,
      expiresAt: row.expiresAt,
      status: proposalStatusSchema.parse(row.status),
    }),
    ownerUserId: row.ownerUserId,
    botId: row.botId,
    channelId: row.channelId,
    contentHash: row.contentHash,
    snapshot,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    vendorResultId: row.vendorResultId,
    publishedUrl: row.publishedUrl,
    failureDetail: row.failureDetail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type SelectedDraft = {
  id: string;
  ownerUserId: string;
  channelId: string;
  botId: string;
  remoteDraftId: string | null;
  document: unknown;
  version: number;
  contentHash: string;
  remoteVersion: number | null;
  remoteHash: string | null;
  syncStatus: string;
  lastError: string | null;
  attemptId: string | null;
  attemptKind: string | null;
  attemptState: string | null;
  attemptVersion: number | null;
  attemptHash: string | null;
  attemptRemoteDraftId: string | null;
  attemptLeaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function asDraft(row: SelectedDraft): TypefullyDraft {
  const canonical = canonicalizeDraft(row.document);
  if (
    row.attemptKind !== null &&
    !["create_draft", "update_draft", "upload_media", "remove_media"].includes(
      row.attemptKind,
    )
  ) {
    throw new Error("Stored Typefully attempt kind is invalid.");
  }
  if (
    row.attemptState !== null &&
    row.attemptState !== "in_flight" &&
    row.attemptState !== "outcome_uncertain"
  ) {
    throw new Error("Stored Typefully attempt state is invalid.");
  }
  return {
    ...row,
    document: canonical.document,
    syncStatus: syncStatusSchema.parse(row.syncStatus),
    attemptKind: row.attemptKind as RemoteAttemptKind | null,
    attemptState: row.attemptState as RemoteAttemptState | null,
  };
}

function serverIdFor(vendor: VendorIdentity | undefined): string {
  if (typeof vendor === "string" && vendor.trim()) return vendor;
  if (
    vendor &&
    typeof vendor === "object" &&
    typeof vendor.serverId === "string" &&
    vendor.serverId.trim()
  ) {
    return vendor.serverId;
  }
  return DEFAULT_VENDOR_ID;
}

function redactSensitiveErrorFields(value: string): string {
  return value.replace(
    SENSITIVE_ERROR_FIELD,
    (match, label: string, separator: string) => {
      const normalizedLabel = label
        .replaceAll(/[^a-zA-Z0-9]/g, "")
        .toLowerCase();
      if (!separator.includes(":") && !separator.includes("=")) {
        // Keep ordinary prose ("token budget", "secret sauce") readable. The API-key form is
        // also commonly emitted as "API key abc123", so it is the one whitespace-only label.
        if (normalizedLabel !== "apikey") return match;
      }
      return `${label.replaceAll(/\s+/g, " ")}=[redacted]`;
    },
  );
}

function redactSensitiveJsonFields(value: string): string {
  return value.replace(
    SENSITIVE_JSON_FIELD,
    (
      _match,
      keyQuote: string,
      label: string,
      separator: string,
      sensitiveValue: string,
    ) => {
      const valueQuote =
        sensitiveValue.startsWith('"') || sensitiveValue.startsWith("'")
          ? sensitiveValue[0]
          : '"';
      return `${keyQuote}${label}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`;
    },
  );
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\bBearer\s+[^\s,;&]+/giu, "Bearer [redacted]")
    .replace(/\s+/g, " ");
  const redacted = redactSensitiveErrorFields(
    redactSensitiveJsonFields(normalized),
  )
    .replace(/\s+/g, " ")
    .trim();
  const safe = Array.from(redacted).slice(0, LAST_ERROR_MAX_LENGTH).join("");
  return safe || "The remote operation failed.";
}

function validRemoteDraftId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    value.length > String(Number.MAX_SAFE_INTEGER).length ||
    BigInt(value) > MAX_TYPEFULLY_DRAFT_ID
  ) {
    throw new InvalidRemoteDraftIdError();
  }
  return value;
}

function validRemoteMediaId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length > 240 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  ) {
    throw new Error("Typefully returned an invalid media id.");
  }
  return value;
}

async function ownedDraft(
  executor: Database | AuditTransaction,
  draftId: string,
  actorId: string,
): Promise<TypefullyDraft> {
  const [row] = await executor
    .select(draftSelection)
    .from(typefullyDrafts)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, typefullyDrafts.channelId),
        eq(channelMemberships.userId, actorId),
      ),
    )
    .where(
      and(
        eq(typefullyDrafts.id, draftId),
        eq(typefullyDrafts.ownerUserId, actorId),
      ),
    )
    .limit(1);
  if (!row) throw new DraftNotFoundError();
  return asDraft(row);
}

async function lockedOwnedDraft(
  transaction: AuditTransaction,
  draftId: string,
  actorId: string,
): Promise<TypefullyDraft> {
  const [row] = await transaction
    .select(draftSelection)
    .from(typefullyDrafts)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, typefullyDrafts.channelId),
        eq(channelMemberships.userId, actorId),
      ),
    )
    .where(
      and(
        eq(typefullyDrafts.id, draftId),
        eq(typefullyDrafts.ownerUserId, actorId),
      ),
    )
    .limit(1)
    .for("update", { of: typefullyDrafts });
  if (!row) throw new DraftNotFoundError();
  return asDraft(row);
}

async function ownedProposal(
  executor: Database | AuditTransaction,
  proposalId: string,
  actorId: string,
): Promise<PublicationProposal> {
  const [row] = await executor
    .select(proposalSelection)
    .from(typefullyPublicationProposals)
    .innerJoin(
      channelMemberships,
      and(
        eq(
          channelMemberships.channelId,
          typefullyPublicationProposals.channelId,
        ),
        eq(channelMemberships.userId, actorId),
      ),
    )
    .where(
      and(
        eq(typefullyPublicationProposals.id, proposalId),
        eq(typefullyPublicationProposals.ownerUserId, actorId),
      ),
    )
    .limit(1);
  if (!row) throw new DraftNotFoundError();
  return asProposal(row as SelectedProposal);
}

async function lockedOwnedProposal(
  transaction: AuditTransaction,
  proposalId: string,
  actorId: string,
): Promise<PublicationProposal> {
  const [row] = await transaction
    .select(proposalSelection)
    .from(typefullyPublicationProposals)
    .innerJoin(
      channelMemberships,
      and(
        eq(
          channelMemberships.channelId,
          typefullyPublicationProposals.channelId,
        ),
        eq(channelMemberships.userId, actorId),
      ),
    )
    .where(
      and(
        eq(typefullyPublicationProposals.id, proposalId),
        eq(typefullyPublicationProposals.ownerUserId, actorId),
      ),
    )
    .limit(1)
    .for("update", { of: typefullyPublicationProposals });
  if (!row) throw new DraftNotFoundError();
  return asProposal(row as SelectedProposal);
}

async function isBotAttached(
  executor: Database | AuditTransaction,
  channelId: string,
  botId: string,
): Promise<boolean> {
  const [attachment] = await executor
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(
      and(
        eq(channelAgents.channelId, channelId),
        eq(channelAgents.agentId, botId),
      ),
    )
    .limit(1);
  return Boolean(attachment);
}

/**
 * Keep an authorization row present until the transaction using it commits. A concurrent delete
 * either wins before this read (and the mutation refuses) or waits for this transaction; it cannot
 * disappear between the check and the write.
 */
async function lockMembership(
  executor: AuditTransaction,
  channelId: string,
  actorId: string,
): Promise<boolean> {
  const [membership] = await executor
    .select({ userId: channelMemberships.userId })
    .from(channelMemberships)
    .where(
      and(
        eq(channelMemberships.channelId, channelId),
        eq(channelMemberships.userId, actorId),
      ),
    )
    .limit(1)
    .for("key share");
  return Boolean(membership);
}

async function lockBotAttachment(
  executor: AuditTransaction,
  channelId: string,
  botId: string,
): Promise<boolean> {
  const [attachment] = await executor
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(
      and(
        eq(channelAgents.channelId, channelId),
        eq(channelAgents.agentId, botId),
      ),
    )
    .limit(1)
    .for("key share");
  return Boolean(attachment);
}

function auditPayload(draft: TypefullyDraft) {
  return {
    ownerUserId: draft.ownerUserId,
    channelId: draft.channelId,
    botId: draft.botId,
    version: draft.version,
    hash: draft.contentHash,
    status: draft.syncStatus,
    destinations: draft.document.destinations,
  };
}

function remoteOperationFor(draft: TypefullyDraft): RemoteDraftOperation {
  return draft.remoteDraftId ? "update_draft" : "create_draft";
}

function isCurrentRevisionConfirmed(draft: TypefullyDraft): boolean {
  return (
    draft.remoteDraftId !== null &&
    draft.remoteVersion === draft.version &&
    draft.remoteHash === draft.contentHash
  );
}

export function createTypefullyStore(options: {
  database: Database;
  plugin: () => AuthorizationSurface;
  auditStore: TransactionalAuditStore;
  vendor?: VendorIdentity;
  now?: () => Date;
  attemptLeaseMs?: number;
  publicationVendor?: PublicationVendor;
  proposalTtlMs?: number;
}) {
  const { database, plugin, auditStore } = options;
  const serverId = serverIdFor(options.vendor);
  const now = options.now ?? (() => new Date());
  const attemptLeaseMs = options.attemptLeaseMs ?? DEFAULT_ATTEMPT_LEASE_MS;
  const proposalTtlMs = options.proposalTtlMs ?? 15 * 60_000;
  const publicationVendor = options.publicationVendor;
  const grantRef = (operation: RemoteDraftOperation) =>
    `${serverId}/${operation}`;

  const clearedAttempt = {
    attemptId: null,
    attemptKind: null,
    attemptState: null,
    attemptVersion: null,
    attemptHash: null,
    attemptRemoteDraftId: null,
    attemptLeaseExpiresAt: null,
  } as const;

  async function isGranted(
    operation: RemoteDraftOperation,
    botId: string,
  ): Promise<boolean> {
    const decision = await plugin().decide("mcp", grantRef(operation), botId);
    return decision.allowed;
  }

  async function authorizePublication(input: {
    botId: string;
    actorId: string;
    operation: "prepare_publication" | "publish_now";
  }): Promise<{ token: string }> {
    const authorizeOperation = plugin().authorizeOperation;
    if (!authorizeOperation) {
      throw new GrantRequiredError(
        `${serverId}/prepare_publication`,
        "Typefully publication authorization is unavailable.",
      );
    }
    return authorizeOperation({
      requiredGrantRef: `${serverId}/prepare_publication`,
      ref: `${serverId}/${input.operation}`,
      botId: input.botId,
      actorId: input.actorId,
      context: {
        intent: "write_tool",
        mcp: { server: serverId, tool: input.operation, effect: "write" },
      },
    });
  }

  function remotePublicationIdentity(draft: TypefullyDraft) {
    const socialSetId = Number(draft.document.socialSetId);
    const remoteDraftId = Number(draft.remoteDraftId);
    if (
      !Number.isSafeInteger(socialSetId) ||
      socialSetId <= 0 ||
      !Number.isSafeInteger(remoteDraftId) ||
      remoteDraftId <= 0
    ) {
      throw changedProposalError();
    }
    return { socialSetId, remoteDraftId };
  }

  function remoteArgs(draft: TypefullyDraft): Record<string, unknown> {
    const socialSetId = Number(draft.document.socialSetId);
    if (!Number.isSafeInteger(socialSetId) || socialSetId <= 0) {
      throw new Error("Choose a valid Typefully social set before syncing.");
    }
    const mediaIds = draft.document.media
      .map((media) => media.remoteId)
      .filter((id): id is string => id !== null);
    const platforms = Object.fromEntries(
      draft.document.destinations.map((destination) => [
        destination,
        {
          enabled: true,
          posts: draft.document.posts.map((post) => ({
            text: post[destination],
            ...(mediaIds.length > 0 ? { mediaIds } : {}),
          })),
        },
      ]),
    );
    return {
      socialSetId,
      platforms,
      draftTitle: draft.document.title || null,
      planAt: draft.document.scheduleAt,
      ...(draft.remoteDraftId === null
        ? {}
        : { draftId: Number(draft.remoteDraftId) }),
    };
  }

  async function claimSyncAttempt(
    authorized: TypefullyDraft,
    actorId: string,
  ): Promise<
    | { kind: "noop"; draft: TypefullyDraft }
    | { kind: "claimed"; draft: TypefullyDraft; attemptId: string }
    | { kind: "uncertain"; draft: TypefullyDraft }
  > {
    return database.transaction(async (transaction) => {
      let current = await lockedOwnedDraft(transaction, authorized.id, actorId);
      const instant = now();
      if (current.attemptId !== null) {
        if (current.attemptState === "outcome_uncertain") {
          throw new ReconciliationRequiredError(current.id);
        }
        if (
          current.attemptLeaseExpiresAt !== null &&
          current.attemptLeaseExpiresAt.getTime() > instant.getTime()
        ) {
          throw new SyncInProgressError();
        }
        if (
          current.attemptKind === "create_draft" ||
          current.attemptKind === "upload_media"
        ) {
          const [uncertain] = await transaction
            .update(typefullyDrafts)
            .set({
              attemptState: "outcome_uncertain",
              syncStatus: "remote_error",
              lastError:
                "The previous remote operation may have completed and must be reconciled before retrying.",
              updatedAt: instant,
            })
            .where(
              and(
                eq(typefullyDrafts.id, current.id),
                eq(typefullyDrafts.attemptId, current.attemptId),
              ),
            )
            .returning(draftSelection);
          if (uncertain) current = asDraft(uncertain);
          // Surface reconciliation only after this transaction commits; throwing here would roll
          // the quarantine write back and make the unsafe create look retryable again.
          return { kind: "uncertain", draft: current };
        }
        const [reclaimed] = await transaction
          .update(typefullyDrafts)
          .set(clearedAttempt)
          .where(
            and(
              eq(typefullyDrafts.id, current.id),
              eq(typefullyDrafts.attemptId, current.attemptId),
            ),
          )
          .returning(draftSelection);
        if (!reclaimed) throw new SyncInProgressError();
        current = asDraft(reclaimed);
      }
      if (isCurrentRevisionConfirmed(current)) {
        return { kind: "noop", draft: current };
      }
      if (
        current.version !== authorized.version ||
        current.contentHash !== authorized.contentHash ||
        current.remoteDraftId !== authorized.remoteDraftId ||
        remoteOperationFor(current) !== remoteOperationFor(authorized)
      ) {
        throw new StaleAuthorizationError();
      }
      const attemptId = randomUUID();
      const [claimed] = await transaction
        .update(typefullyDrafts)
        .set({
          attemptId,
          attemptKind: remoteOperationFor(current),
          attemptState: "in_flight",
          attemptVersion: current.version,
          attemptHash: current.contentHash,
          attemptRemoteDraftId: current.remoteDraftId,
          attemptLeaseExpiresAt: new Date(
            instant.getTime() + Math.max(1, attemptLeaseMs),
          ),
          syncStatus: "syncing",
          lastError: null,
          updatedAt: instant,
        })
        .where(
          and(
            eq(typefullyDrafts.id, current.id),
            isNull(typefullyDrafts.attemptId),
          ),
        )
        .returning(draftSelection);
      if (!claimed) throw new SyncInProgressError();
      return { kind: "claimed", draft: asDraft(claimed), attemptId };
    });
  }

  async function releaseAttempt(
    draftId: string,
    actorId: string,
    attemptId: string,
    syncStatus: DraftSyncStatus,
  ) {
    const [released] = await database
      .update(typefullyDrafts)
      .set({ ...clearedAttempt, syncStatus, updatedAt: now() })
      .where(
        and(
          eq(typefullyDrafts.id, draftId),
          eq(typefullyDrafts.ownerUserId, actorId),
          eq(typefullyDrafts.attemptId, attemptId),
        ),
      )
      .returning(draftSelection);
    if (!released) throw new StaleRemoteAttemptError();
    return asDraft(released);
  }

  async function markCreateOutcomeUncertain(
    draftId: string,
    actorId: string,
    attemptId: string,
    error: unknown,
  ): Promise<never> {
    const [marked] = await database
      .update(typefullyDrafts)
      .set({
        attemptState: "outcome_uncertain",
        syncStatus: "remote_error",
        lastError: boundedError(error),
        updatedAt: now(),
      })
      .where(
        and(
          eq(typefullyDrafts.id, draftId),
          eq(typefullyDrafts.ownerUserId, actorId),
          eq(typefullyDrafts.attemptId, attemptId),
          eq(typefullyDrafts.attemptKind, "create_draft"),
        ),
      )
      .returning({ id: typefullyDrafts.id });
    if (!marked) throw new StaleRemoteAttemptError();
    throw new ReconciliationRequiredError(draftId);
  }

  const store = {
    async callBotTool(input: {
      serverId: string;
      toolName: string;
      args: Record<string, unknown>;
      botId: string;
      actorId: string;
    }): Promise<{ text: string; isError: boolean } | null> {
      if (input.serverId !== serverId) return null;
      if (input.toolName === "create_draft") {
        const parsed = typefullyBotContracts.create_draft.safeParse(input.args);
        if (!parsed.success) {
          return {
            text:
              parsed.error.issues[0]?.message ??
              "Invalid local draft arguments",
            isError: true,
          };
        }
        const draft = await store.createDraft({
          ownerUserId: input.actorId,
          channelId: parsed.data.channelId,
          botId: input.botId,
          document: parsed.data.document,
        });
        return {
          text: JSON.stringify(
            draftSummary({
              id: draft.id,
              document: draft.document,
              version: draft.version,
              syncStatus: draft.syncStatus,
              socialSetLabel: draft.document.accountLabel,
            }),
          ),
          isError: false,
        };
      }
      if (input.toolName === "update_draft") {
        const parsed = typefullyBotContracts.update_draft.safeParse(input.args);
        if (!parsed.success) {
          return {
            text:
              parsed.error.issues[0]?.message ??
              "Invalid local draft arguments",
            isError: true,
          };
        }
        const draft = await store.saveDraft({
          draftId: parsed.data.draftId,
          actorId: input.actorId,
          expectedVersion: parsed.data.expectedVersion,
          document: parsed.data.document,
          requiredBotId: input.botId,
        });
        return {
          text: JSON.stringify(
            draftSummary({
              id: draft.id,
              document: draft.document,
              version: draft.version,
              syncStatus: draft.syncStatus,
              socialSetLabel: draft.document.accountLabel,
            }),
          ),
          isError: false,
        };
      }
      if (input.toolName === "prepare_publication") {
        const parsed = typefullyBotContracts.prepare_publication.safeParse(
          input.args,
        );
        if (!parsed.success) {
          return {
            text:
              parsed.error.issues[0]?.message ??
              "Invalid publication proposal arguments",
            isError: true,
          };
        }
        const proposal = await store.prepareProposal({
          draftId: parsed.data.draftId,
          actorId: input.actorId,
          expectedVersion: parsed.data.expectedVersion,
          requiredBotId: input.botId,
        });
        return { text: JSON.stringify(proposal), isError: false };
      }
      return null;
    },

    async prepareProposal(input: {
      draftId: string;
      actorId: string;
      expectedVersion: number;
      requiredBotId?: string;
    }) {
      const visible = await ownedDraft(database, input.draftId, input.actorId);
      if (
        visible.version !== input.expectedVersion ||
        !isCurrentRevisionConfirmed(visible) ||
        visible.syncStatus !== "synced" ||
        (input.requiredBotId !== undefined &&
          visible.botId !== input.requiredBotId)
      ) {
        throw changedProposalError();
      }
      if (
        visible.document.destinations.length === 0 ||
        visible.document.destinations.some(
          (destination) => destination !== "x" && destination !== "linkedin",
        )
      ) {
        throw changedProposalError();
      }
      await authorizePublication({
        botId: visible.botId,
        actorId: input.actorId,
        operation: "prepare_publication",
      });

      return database.transaction(async (transaction) => {
        const draft = await lockedOwnedDraft(
          transaction,
          input.draftId,
          input.actorId,
        );
        if (
          draft.version !== input.expectedVersion ||
          draft.contentHash !== visible.contentHash ||
          !isCurrentRevisionConfirmed(draft) ||
          draft.syncStatus !== "synced" ||
          (input.requiredBotId !== undefined &&
            draft.botId !== input.requiredBotId)
        ) {
          throw changedProposalError();
        }
        if (
          !(await lockMembership(
            transaction,
            draft.channelId,
            input.actorId,
          )) ||
          !(await lockBotAttachment(transaction, draft.channelId, draft.botId))
        ) {
          throw new DraftNotFoundError();
        }
        const instant = now();
        await transaction
          .update(typefullyPublicationProposals)
          .set({
            status: "expired",
            decidedAt: instant,
            completedAt: instant,
            failureDetail: "Superseded by a newer review proposal.",
            updatedAt: instant,
          })
          .where(
            and(
              eq(typefullyPublicationProposals.draftId, draft.id),
              eq(typefullyPublicationProposals.status, "pending"),
            ),
          );
        const [row] = await transaction
          .insert(typefullyPublicationProposals)
          .values({
            draftId: draft.id,
            ownerUserId: draft.ownerUserId,
            botId: draft.botId,
            channelId: draft.channelId,
            draftVersion: draft.version,
            contentHash: draft.contentHash,
            snapshot: draft.document,
            status: "pending",
            expiresAt: new Date(instant.getTime() + Math.max(1, proposalTtlMs)),
          })
          .returning(proposalSelection);
        if (!row) throw new Error("The publication proposal was not stored.");
        const proposal = asProposal(row as SelectedProposal);
        await recordAuditEvent(auditStore.inTransaction(transaction), {
          eventType: "configuration.changed",
          targetType: "typefully_publication_proposal",
          targetId: proposal.id,
          actorUserId: input.actorId,
          payload: {
            draftId: proposal.draftId,
            botId: proposal.botId,
            channelId: proposal.channelId,
            version: proposal.version,
            hash: proposal.contentHash,
            destinations: proposal.destinations,
            decision: "prepared",
          },
        });
        return proposalSummary({
          id: row.id,
          draftId: row.draftId,
          draftVersion: row.draftVersion,
          snapshot: proposal.snapshot,
          expiresAt: row.expiresAt,
          status: proposal.status,
        });
      });
    },

    async readProposal(proposalId: string, actorId: string) {
      return ownedProposal(database, proposalId, actorId);
    },

    async declineProposal(proposalId: string, actorId: string) {
      return database.transaction(async (transaction) => {
        const proposal = await lockedOwnedProposal(
          transaction,
          proposalId,
          actorId,
        );
        if (proposal.status !== "pending") {
          throw new ProposalStateError(
            "proposal_not_pending",
            "This proposal is no longer pending.",
          );
        }
        const instant = now();
        const [row] = await transaction
          .update(typefullyPublicationProposals)
          .set({
            status: "declined",
            decidedAt: instant,
            completedAt: instant,
            updatedAt: instant,
          })
          .where(
            and(
              eq(typefullyPublicationProposals.id, proposal.id),
              eq(typefullyPublicationProposals.status, "pending"),
            ),
          )
          .returning(proposalSelection);
        if (!row) {
          throw new ProposalStateError(
            "proposal_not_pending",
            "This proposal is no longer pending.",
          );
        }
        await recordAuditEvent(auditStore.inTransaction(transaction), {
          eventType: "configuration.changed",
          targetType: "typefully_publication_proposal",
          targetId: proposal.id,
          actorUserId: actorId,
          payload: {
            draftId: proposal.draftId,
            botId: proposal.botId,
            channelId: proposal.channelId,
            version: proposal.version,
            hash: proposal.contentHash,
            destinations: proposal.destinations,
            decision: "declined",
          },
        });
        return asProposal(row as SelectedProposal);
      });
    },

    async approveAndPublish(input: { proposalId: string; actorId: string }) {
      if (!publicationVendor) {
        throw new Error("Typefully publication is unavailable.");
      }
      let proposal = await ownedProposal(
        database,
        input.proposalId,
        input.actorId,
      );
      if (proposal.status !== "pending") {
        if (
          proposal.status === "expired" &&
          proposal.failureDetail === "Draft changed after proposal creation."
        ) {
          throw changedProposalError();
        }
        throw new ProposalStateError(
          "proposal_not_pending",
          "This proposal is no longer pending.",
        );
      }
      if (new Date(proposal.expiresAt).getTime() <= now().getTime()) {
        await database
          .update(typefullyPublicationProposals)
          .set({
            status: "expired",
            decidedAt: now(),
            completedAt: now(),
            failureDetail: "The review proposal expired.",
            updatedAt: now(),
          })
          .where(
            and(
              eq(typefullyPublicationProposals.id, proposal.id),
              eq(typefullyPublicationProposals.status, "pending"),
            ),
          );
        throw new ProposalStateError(
          "proposal_expired",
          "This proposal expired. Review the draft again.",
        );
      }
      let draft = await ownedDraft(database, proposal.draftId, input.actorId);
      if (
        draft.version !== proposal.version ||
        draft.contentHash !== proposal.contentHash ||
        !isCurrentRevisionConfirmed(draft)
      ) {
        throw changedProposalError();
      }
      const authorized = await authorizePublication({
        botId: proposal.botId,
        actorId: input.actorId,
        operation: "publish_now",
      });
      const identity = remotePublicationIdentity(draft);
      const remote = await publicationVendor.fetchDraft({
        token: authorized.token,
        ...identity,
      });
      if (
        !remoteMatchesSnapshot(
          remote.document,
          proposal.snapshot,
          proposal.contentHash,
        )
      ) {
        await database
          .update(typefullyPublicationProposals)
          .set({
            status: "expired",
            decidedAt: now(),
            completedAt: now(),
            failureDetail: "The remote draft changed after review.",
            updatedAt: now(),
          })
          .where(
            and(
              eq(typefullyPublicationProposals.id, proposal.id),
              eq(typefullyPublicationProposals.status, "pending"),
            ),
          );
        throw changedProposalError();
      }

      proposal = await database.transaction(async (transaction) => {
        // Draft before proposal is the global mutation lock order. `saveDraft` already holds the
        // draft before it invalidates proposals; reversing that order here deadlocks an edit racing
        // the approval claim.
        draft = await lockedOwnedDraft(
          transaction,
          proposal.draftId,
          input.actorId,
        );
        const locked = await lockedOwnedProposal(
          transaction,
          input.proposalId,
          input.actorId,
        );
        if (locked.status !== "pending") {
          throw new ProposalStateError(
            "proposal_not_pending",
            "This proposal is no longer pending.",
          );
        }
        if (new Date(locked.expiresAt).getTime() <= now().getTime()) {
          throw new ProposalStateError(
            "proposal_expired",
            "This proposal expired. Review the draft again.",
          );
        }
        if (
          draft.version !== locked.version ||
          draft.contentHash !== locked.contentHash ||
          !isCurrentRevisionConfirmed(draft) ||
          !(await lockBotAttachment(
            transaction,
            locked.channelId,
            locked.botId,
          ))
        ) {
          throw changedProposalError();
        }
        const instant = now();
        const [claimed] = await transaction
          .update(typefullyPublicationProposals)
          .set({
            // `unknown` is the durable fence. A crash after this commit is never automatically
            // retried; reconciliation must prove the vendor state first.
            status: "unknown",
            decidedAt: instant,
            completedAt: instant,
            failureDetail: "Publishing status unknown.",
            updatedAt: instant,
          })
          .where(
            and(
              eq(typefullyPublicationProposals.id, locked.id),
              eq(typefullyPublicationProposals.status, "pending"),
            ),
          )
          .returning(proposalSelection);
        if (!claimed) {
          throw new ProposalStateError(
            "proposal_not_pending",
            "This proposal is no longer pending.",
          );
        }
        await recordAuditEvent(auditStore.inTransaction(transaction), {
          eventType: "configuration.changed",
          targetType: "typefully_publication_proposal",
          targetId: locked.id,
          actorUserId: input.actorId,
          payload: {
            draftId: locked.draftId,
            botId: locked.botId,
            channelId: locked.channelId,
            version: locked.version,
            hash: locked.contentHash,
            destinations: locked.destinations,
            decision: "approved",
            outcome: "unknown",
          },
        });
        return asProposal(claimed as SelectedProposal);
      });

      let outcome: PublicationOutcome;
      try {
        outcome = safePublicationOutcome(
          await publicationVendor.publishDraft({
            token: authorized.token,
            ...identity,
          }),
        );
      } catch (error) {
        outcome = {
          outcome: "unknown" as const,
          detail: boundedError(error),
        };
      }
      const instant = now();
      const status = outcome.outcome;
      return database.transaction(async (transaction) => {
        const [completed] = await transaction
          .update(typefullyPublicationProposals)
          .set({
            status,
            completedAt: instant,
            vendorResultId: outcome.vendorResultId ?? null,
            publishedUrl: outcome.publishedUrl ?? null,
            failureDetail:
              status === "published"
                ? null
                : (outcome.detail ??
                  (status === "unknown"
                    ? "Publishing status unknown."
                    : "Typefully refused publication.")),
            updatedAt: instant,
          })
          .where(
            and(
              eq(typefullyPublicationProposals.id, proposal.id),
              eq(typefullyPublicationProposals.status, "unknown"),
            ),
          )
          .returning(proposalSelection);
        if (!completed) {
          throw new ProposalStateError(
            "proposal_not_pending",
            "This proposal is no longer pending.",
          );
        }
        await recordAuditEvent(auditStore.inTransaction(transaction), {
          eventType: "configuration.changed",
          targetType: "typefully_publication_proposal",
          targetId: proposal.id,
          actorUserId: input.actorId,
          payload: {
            draftId: proposal.draftId,
            botId: proposal.botId,
            channelId: proposal.channelId,
            version: proposal.version,
            hash: proposal.contentHash,
            destinations: proposal.destinations,
            decision: "approved",
            outcome: status,
          },
        });
        return asProposal(completed as SelectedProposal);
      });
    },

    async reconcileProposal(input: { proposalId: string; actorId: string }) {
      if (!publicationVendor) {
        throw new Error("Typefully publication is unavailable.");
      }
      const proposal = await ownedProposal(
        database,
        input.proposalId,
        input.actorId,
      );
      if (proposal.status !== "unknown") {
        throw new ProposalStateError(
          "proposal_not_reconcilable",
          "Only an unknown publication outcome can be reconciled.",
        );
      }
      const draft = await ownedDraft(database, proposal.draftId, input.actorId);
      const authorized = await authorizePublication({
        botId: proposal.botId,
        actorId: input.actorId,
        operation: "publish_now",
      });
      const outcome = safePublicationOutcome(
        await publicationVendor.reconcileDraft({
          token: authorized.token,
          ...remotePublicationIdentity(draft),
        }),
      );
      if (outcome.outcome === "unknown") return proposal;
      const instant = now();
      return database.transaction(async (transaction) => {
        const [row] = await transaction
          .update(typefullyPublicationProposals)
          .set({
            status: outcome.outcome,
            completedAt: instant,
            vendorResultId: outcome.vendorResultId ?? null,
            publishedUrl: outcome.publishedUrl ?? null,
            failureDetail:
              outcome.outcome === "published"
                ? null
                : (outcome.detail ?? "Typefully reports publication failed."),
            updatedAt: instant,
          })
          .where(
            and(
              eq(typefullyPublicationProposals.id, proposal.id),
              eq(typefullyPublicationProposals.status, "unknown"),
            ),
          )
          .returning(proposalSelection);
        if (!row) {
          return ownedProposal(transaction, proposal.id, input.actorId);
        }
        await recordAuditEvent(auditStore.inTransaction(transaction), {
          eventType: "configuration.changed",
          targetType: "typefully_publication_proposal",
          targetId: proposal.id,
          actorUserId: input.actorId,
          payload: {
            draftId: proposal.draftId,
            botId: proposal.botId,
            channelId: proposal.channelId,
            version: proposal.version,
            hash: proposal.contentHash,
            destinations: proposal.destinations,
            decision: "reconciled",
            outcome: outcome.outcome,
          },
        });
        return asProposal(row as SelectedProposal);
      });
    },

    async createDraft(input: {
      ownerUserId: string;
      channelId: string;
      botId: string;
      document: unknown;
      requireGrant?: boolean;
    }): Promise<TypefullyDraft> {
      const canonical = canonicalizeDraft(input.document);
      const granted = await isGranted("create_draft", input.botId);
      return database.transaction(async (transaction) => {
        if (
          !(await lockMembership(
            transaction,
            input.channelId,
            input.ownerUserId,
          ))
        ) {
          throw new DraftNotFoundError();
        }
        const attached = await lockBotAttachment(
          transaction,
          input.channelId,
          input.botId,
        );
        if (!attached) throw new BotNotAttachedError();
        if (input.requireGrant && !granted) {
          throw new GrantRequiredError(
            grantRef("create_draft"),
            "This Bot no longer has permission to create Typefully drafts.",
          );
        }
        const syncStatus = granted ? "local" : "grant_blocked";
        const [row] = await transaction
          .insert(typefullyDrafts)
          .values({
            ownerUserId: input.ownerUserId,
            channelId: input.channelId,
            botId: input.botId,
            document: canonical.document,
            version: 1,
            contentHash: canonical.hash,
            syncStatus,
          })
          .returning(draftSelection);
        if (!row) throw new Error("The draft was not stored.");
        const draft = asDraft(row);
        await recordAuditEvent(auditStore.inTransaction(transaction), {
          eventType: "configuration.changed",
          targetType: "typefully_draft",
          targetId: draft.id,
          actorUserId: input.ownerUserId,
          payload: auditPayload(draft),
        });
        return draft;
      });
    },

    async readDraft(draftId: string, actorId: string): Promise<TypefullyDraft> {
      return ownedDraft(database, draftId, actorId);
    },

    async saveDraft(input: {
      draftId: string;
      actorId: string;
      expectedVersion: number;
      document: unknown;
      /** Signed callback identity; when set, mismatch and detachment are non-disclosing. */
      requiredBotId?: string;
    }): Promise<TypefullyDraft> {
      const canonical = canonicalizeDraft(input.document);
      const visible = await ownedDraft(database, input.draftId, input.actorId);
      let grantOperation = remoteOperationFor(visible);
      // A grant is advisory for a local save. It is read immediately before the transaction so no
      // database transaction spans a plugin call. A revocation after this decision is unavoidable;
      // Task 6 preflights again before any vendor action, so it can never authorize remote work.
      let granted = await isGranted(grantOperation, visible.botId);
      const refreshed = await ownedDraft(
        database,
        input.draftId,
        input.actorId,
      );
      const refreshedOperation = remoteOperationFor(refreshed);
      if (refreshedOperation !== grantOperation) {
        grantOperation = refreshedOperation;
        granted = await isGranted(grantOperation, refreshed.botId);
      }
      return database.transaction(async (transaction) => {
        const current = await lockedOwnedDraft(
          transaction,
          input.draftId,
          input.actorId,
        );
        const [unresolvedPublication] = await transaction
          .select({ id: typefullyPublicationProposals.id })
          .from(typefullyPublicationProposals)
          .where(
            and(
              eq(typefullyPublicationProposals.draftId, current.id),
              eq(typefullyPublicationProposals.status, "unknown"),
            ),
          )
          .limit(1);
        if (unresolvedPublication) {
          throw new ReconciliationRequiredError(current.id);
        }
        if (
          !(await lockMembership(transaction, current.channelId, input.actorId))
        ) {
          throw new DraftNotFoundError();
        }
        const attached = await lockBotAttachment(
          transaction,
          current.channelId,
          current.botId,
        );
        if (
          input.requiredBotId !== undefined &&
          (current.botId !== input.requiredBotId || !attached)
        ) {
          throw new DraftNotFoundError();
        }
        const syncStatus: DraftSyncStatus =
          current.syncStatus === "syncing"
            ? "syncing"
            : attached &&
                granted &&
                remoteOperationFor(current) === grantOperation
              ? "local"
              : "grant_blocked";
        const now = new Date();
        const [row] = await transaction
          .update(typefullyDrafts)
          .set({
            document: canonical.document,
            contentHash: canonical.hash,
            version: current.version + 1,
            syncStatus,
            lastError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(typefullyDrafts.id, input.draftId),
              eq(typefullyDrafts.ownerUserId, input.actorId),
              eq(typefullyDrafts.version, input.expectedVersion),
            ),
          )
          .returning(draftSelection);
        if (!row) {
          const latest = await ownedDraft(
            transaction,
            input.draftId,
            input.actorId,
          );
          throw new VersionConflictError(latest.version, latest.contentHash);
        }

        await transaction
          .update(typefullyPublicationProposals)
          .set({
            status: "expired",
            decidedAt: now,
            completedAt: now,
            failureDetail: "Draft changed after proposal creation.",
            updatedAt: now,
          })
          .where(
            and(
              eq(typefullyPublicationProposals.draftId, input.draftId),
              eq(typefullyPublicationProposals.status, "pending"),
            ),
          );

        const draft = asDraft(row);
        await recordAuditEvent(auditStore.inTransaction(transaction), {
          eventType: "configuration.changed",
          targetType: "typefully_draft",
          targetId: draft.id,
          actorUserId: input.actorId,
          payload: auditPayload(draft),
        });
        return draft;
      });
    },

    /**
     * Authorize immediately before a vendor request. The remote id chooses the exact grant: the
     * first synchronization creates and every later one updates. No transaction is held over the
     * plugin decision or the following network request, so grants and attachments can change after
     * this preflight. The record methods deliberately persist the already-observed vendor outcome
     * even if that happens.
     */
    async authorizeRemoteOperation(input: {
      draftId: string;
      actorId: string;
      expectedVersion?: number;
      expectedHash?: string;
    }): Promise<{ draft: TypefullyDraft; ref: string }> {
      let draft = await ownedDraft(database, input.draftId, input.actorId);
      let operation = remoteOperationFor(draft);
      let ref = grantRef(operation);
      let decision = await plugin().decide("mcp", ref, draft.botId);
      if (!decision.allowed) {
        throw new GrantRequiredError(ref, decision.reason);
      }

      // Re-read after the plugin decision. Membership or attachment retirement must win if it
      // completed while authorization was being evaluated, and a concurrent first sync may have
      // changed the required grant from create to update.
      draft = await ownedDraft(database, input.draftId, input.actorId);
      const currentOperation = remoteOperationFor(draft);
      if (currentOperation !== operation) {
        operation = currentOperation;
        ref = grantRef(operation);
        decision = await plugin().decide("mcp", ref, draft.botId);
        if (!decision.allowed) {
          throw new GrantRequiredError(ref, decision.reason);
        }
        draft = await ownedDraft(database, input.draftId, input.actorId);
      }
      if (!(await isBotAttached(database, draft.channelId, draft.botId))) {
        throw new BotNotAttachedError();
      }
      if (
        (input.expectedVersion !== undefined &&
          draft.version !== input.expectedVersion) ||
        (input.expectedHash !== undefined &&
          draft.contentHash !== input.expectedHash)
      ) {
        throw new VersionConflictError(draft.version, draft.contentHash);
      }
      return { draft, ref };
    },

    async syncDraft(input: {
      draftId: string;
      actorId: string;
      expectedVersion?: number;
      expectedHash?: string;
      attemptId?: string;
    }): Promise<{
      draft: TypefullyDraft;
      result: PluginCallResult;
    }> {
      let authorized: { draft: TypefullyDraft; ref: string } | null = null;
      let claim:
        | { kind: "noop"; draft: TypefullyDraft }
        | { kind: "claimed"; draft: TypefullyDraft; attemptId: string }
        | { kind: "uncertain"; draft: TypefullyDraft }
        | null = null;
      for (let pass = 0; pass < 2; pass += 1) {
        authorized = await store.authorizeRemoteOperation(input);
        try {
          if (input.attemptId) {
            const current = await ownedDraft(
              database,
              input.draftId,
              input.actorId,
            );
            if (
              current.attemptId !== input.attemptId ||
              current.attemptState !== "in_flight" ||
              current.version !== input.expectedVersion ||
              current.contentHash !== input.expectedHash
            )
              throw new StaleRemoteAttemptError();
            authorized.draft = current;
            claim = {
              kind: "claimed",
              draft: current,
              attemptId: input.attemptId,
            };
          } else {
            claim = await claimSyncAttempt(authorized.draft, input.actorId);
          }
          break;
        } catch (error) {
          if (error instanceof StaleAuthorizationError && pass === 0) continue;
          throw error;
        }
      }
      if (!authorized || !claim) throw new SyncInProgressError();
      if (claim.kind === "uncertain") {
        throw new ReconciliationRequiredError(claim.draft.id);
      }
      if (claim.kind === "noop") {
        return {
          draft: claim.draft,
          result: {
            text: JSON.stringify({ id: claim.draft.remoteDraftId }),
            isError: false,
          },
        };
      }
      authorized.draft = claim.draft;
      const attemptId = claim.attemptId;
      const dispatchVendor = plugin().dispatchVendor;
      let result: PluginCallResult;
      try {
        if (!dispatchVendor) {
          throw new Error("Typefully remote calls are unavailable.");
        }
        result = await dispatchVendor({
          ref: authorized.ref,
          args: remoteArgs(authorized.draft),
          botId: authorized.draft.botId,
          actorId: input.actorId,
        });
      } catch (error) {
        if (
          (error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "connection_required") ||
          error instanceof GrantRequiredError ||
          error instanceof BotNotAttachedError ||
          (error instanceof Error && error.name === "PluginRefusedError")
        ) {
          await releaseAttempt(
            authorized.draft.id,
            input.actorId,
            attemptId,
            error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "connection_required"
              ? "connection_required"
              : "grant_blocked",
          );
          throw error;
        }
        if (authorized.draft.remoteDraftId === null) {
          return await markCreateOutcomeUncertain(
            input.draftId,
            input.actorId,
            attemptId,
            error,
          );
        }
        const draft = await store.recordRemoteFailure({
          draftId: input.draftId,
          actorId: input.actorId,
          expectedVersion: authorized.draft.version,
          expectedHash: authorized.draft.contentHash,
          attemptId,
          error,
        });
        return {
          draft,
          result: { text: boundedError(error), isError: true },
        };
      }
      if (result.isError) {
        if (
          result.sideEffectOutcome === "uncertain" &&
          authorized.draft.remoteDraftId === null
        ) {
          return await markCreateOutcomeUncertain(
            input.draftId,
            input.actorId,
            attemptId,
            result.text,
          );
        }
        const draft = await store.recordRemoteFailure({
          draftId: input.draftId,
          actorId: input.actorId,
          expectedVersion: authorized.draft.version,
          expectedHash: authorized.draft.contentHash,
          attemptId,
          error: result.text,
        });
        return { draft, result };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.text);
      } catch {
        parsed = null;
      }
      const remoteId =
        parsed && typeof parsed === "object" && "id" in parsed
          ? String(parsed.id)
          : authorized.draft.remoteDraftId;
      if (!remoteId) {
        return await markCreateOutcomeUncertain(
          input.draftId,
          input.actorId,
          attemptId,
          "Typefully returned success without a draft id.",
        );
      }
      try {
        const draft = await store.recordRemoteConfirmation({
          draftId: input.draftId,
          actorId: input.actorId,
          expectedVersion: authorized.draft.version,
          expectedHash: authorized.draft.contentHash,
          remoteDraftId: remoteId,
          attemptId,
        });
        return { draft, result };
      } catch (error) {
        if (!(error instanceof InvalidRemoteDraftIdError)) throw error;
        if (authorized.draft.remoteDraftId === null) {
          return await markCreateOutcomeUncertain(
            input.draftId,
            input.actorId,
            attemptId,
            error,
          );
        }
        const draft = await store.recordRemoteFailure({
          draftId: input.draftId,
          actorId: input.actorId,
          expectedVersion: authorized.draft.version,
          expectedHash: authorized.draft.contentHash,
          attemptId,
          error,
        });
        return {
          draft,
          result: { text: boundedError(error), isError: true },
        };
      }
    },

    async callRemoteTool(input: {
      draftId: string;
      actorId: string;
      toolName: "upload_media" | "remove_media";
      args: Record<string, unknown>;
      attemptId?: string;
    }): Promise<{ draft: TypefullyDraft } & PluginCallResult> {
      const draft = await store.authorizeTool({
        draftId: input.draftId,
        actorId: input.actorId,
        toolName: input.toolName,
      });
      if (
        input.attemptId &&
        (draft.attemptId !== input.attemptId ||
          draft.attemptState !== "in_flight")
      )
        throw new StaleRemoteAttemptError();
      const dispatchVendor = plugin().dispatchVendor;
      if (!dispatchVendor)
        throw new Error("Typefully remote calls are unavailable.");
      const result = await dispatchVendor({
        ref: `${serverId}/${input.toolName}`,
        args: input.args,
        botId: draft.botId,
        actorId: input.actorId,
      });
      return { draft, ...result };
    },

    async authorizeTool(input: {
      draftId: string;
      actorId: string;
      toolName: "upload_media" | "remove_media";
    }): Promise<TypefullyDraft> {
      const draft = await ownedDraft(database, input.draftId, input.actorId);
      if (!(await isBotAttached(database, draft.channelId, draft.botId))) {
        throw new BotNotAttachedError();
      }
      const ref = `${serverId}/${input.toolName}`;
      const decision = await plugin().decide("mcp", ref, draft.botId);
      if (!decision.allowed) throw new GrantRequiredError(ref, decision.reason);
      return draft;
    },

    async beginMediaAttempt(input: {
      draftId: string;
      actorId: string;
      toolName: "upload_media" | "remove_media";
      expectedVersion: number;
      expectedHash: string;
    }): Promise<{ draft: TypefullyDraft; attemptId: string }> {
      await store.authorizeTool(input);
      const outcome = await database.transaction(async (transaction) => {
        const current = await lockedOwnedDraft(
          transaction,
          input.draftId,
          input.actorId,
        );
        const instant = now();
        if (
          current.version !== input.expectedVersion ||
          current.contentHash !== input.expectedHash
        ) {
          throw new VersionConflictError(current.version, current.contentHash);
        }
        if (current.attemptId !== null) {
          const reconcilesUncertainUpload =
            input.toolName === "remove_media" &&
            current.attemptKind === "upload_media" &&
            current.attemptState === "outcome_uncertain";
          if (!reconcilesUncertainUpload) {
            if (current.attemptState === "outcome_uncertain") {
              throw new ReconciliationRequiredError(current.id);
            }
            if (
              current.attemptLeaseExpiresAt !== null &&
              current.attemptLeaseExpiresAt.getTime() > instant.getTime()
            ) {
              throw new SyncInProgressError();
            }
            if (
              current.attemptKind === "create_draft" ||
              current.attemptKind === "upload_media"
            ) {
              const [uncertain] = await transaction
                .update(typefullyDrafts)
                .set({
                  attemptState: "outcome_uncertain",
                  syncStatus: "remote_error",
                  lastError:
                    "The previous remote operation may have completed and must be reconciled before retrying.",
                  updatedAt: instant,
                })
                .where(
                  and(
                    eq(typefullyDrafts.id, current.id),
                    eq(typefullyDrafts.attemptId, current.attemptId),
                  ),
                )
                .returning(draftSelection);
              if (!uncertain) throw new SyncInProgressError();
              // As in draft sync, commit the quarantine before surfacing reconciliation.
              return { kind: "uncertain" as const, draft: asDraft(uncertain) };
            }
          }
          await transaction
            .update(typefullyDrafts)
            .set(clearedAttempt)
            .where(
              and(
                eq(typefullyDrafts.id, current.id),
                eq(typefullyDrafts.attemptId, current.attemptId),
              ),
            );
        }
        const attemptId = randomUUID();
        const [row] = await transaction
          .update(typefullyDrafts)
          .set({
            attemptId,
            attemptKind: input.toolName,
            attemptState: "in_flight",
            attemptVersion: current.version,
            attemptHash: current.contentHash,
            attemptRemoteDraftId: current.remoteDraftId,
            attemptLeaseExpiresAt: new Date(
              instant.getTime() + Math.max(1, attemptLeaseMs),
            ),
            syncStatus: "syncing",
            lastError: null,
            updatedAt: instant,
          })
          .where(
            and(
              eq(typefullyDrafts.id, current.id),
              isNull(typefullyDrafts.attemptId),
            ),
          )
          .returning(draftSelection);
        if (!row) throw new SyncInProgressError();
        return { kind: "claimed" as const, draft: asDraft(row), attemptId };
      });
      if (outcome.kind === "uncertain") {
        throw new ReconciliationRequiredError(outcome.draft.id);
      }
      return { draft: outcome.draft, attemptId: outcome.attemptId };
    },

    async markMediaOutcomeUncertain(input: {
      draftId: string;
      actorId: string;
      attemptId: string;
      error: unknown;
    }): Promise<TypefullyDraft> {
      const [row] = await database
        .update(typefullyDrafts)
        .set({
          attemptState: "outcome_uncertain",
          syncStatus: "remote_error",
          lastError: boundedError(input.error),
          updatedAt: now(),
        })
        .where(
          and(
            eq(typefullyDrafts.id, input.draftId),
            eq(typefullyDrafts.ownerUserId, input.actorId),
            eq(typefullyDrafts.attemptId, input.attemptId),
            eq(typefullyDrafts.attemptKind, "upload_media"),
          ),
        )
        .returning(draftSelection);
      if (!row) throw new StaleRemoteAttemptError();
      return asDraft(row);
    },

    async renewMediaAttempt(input: {
      draftId: string;
      actorId: string;
      attemptId: string;
    }): Promise<{ draft: TypefullyDraft; renewAfterMs: number }> {
      const instant = now();
      const [row] = await database
        .update(typefullyDrafts)
        .set({
          attemptLeaseExpiresAt: new Date(
            instant.getTime() + Math.max(1, attemptLeaseMs),
          ),
          updatedAt: instant,
        })
        .where(
          and(
            eq(typefullyDrafts.id, input.draftId),
            eq(typefullyDrafts.ownerUserId, input.actorId),
            eq(typefullyDrafts.attemptId, input.attemptId),
            eq(typefullyDrafts.attemptState, "in_flight"),
            or(
              eq(typefullyDrafts.attemptKind, "upload_media"),
              eq(typefullyDrafts.attemptKind, "remove_media"),
            ),
          ),
        )
        .returning(draftSelection);
      if (!row) throw new StaleRemoteAttemptError();
      return {
        draft: asDraft(row),
        renewAfterMs: Math.max(1, Math.floor(attemptLeaseMs / 3)),
      };
    },

    async recordMediaInitiation(input: {
      draftId: string;
      actorId: string;
      attemptId: string;
      remoteMediaId: string;
    }): Promise<TypefullyDraft> {
      const instant = now();
      const [row] = await database
        .update(typefullyDrafts)
        .set({
          attemptRemoteDraftId: validRemoteMediaId(input.remoteMediaId),
          attemptLeaseExpiresAt: new Date(
            instant.getTime() + Math.max(1, attemptLeaseMs),
          ),
          updatedAt: instant,
        })
        .where(
          and(
            eq(typefullyDrafts.id, input.draftId),
            eq(typefullyDrafts.ownerUserId, input.actorId),
            eq(typefullyDrafts.attemptId, input.attemptId),
            eq(typefullyDrafts.attemptKind, "upload_media"),
            eq(typefullyDrafts.attemptState, "in_flight"),
          ),
        )
        .returning(draftSelection);
      if (!row) throw new StaleRemoteAttemptError();
      return asDraft(row);
    },

    async reconcileUncertainCreate(input: {
      draftId: string;
      actorId: string;
      expectedVersion: number;
      remoteDraftId: string;
    }): Promise<TypefullyDraft> {
      const remoteDraftId = validRemoteDraftId(input.remoteDraftId);
      return database.transaction(async (transaction) => {
        const current = await lockedOwnedDraft(
          transaction,
          input.draftId,
          input.actorId,
        );
        if (current.version !== input.expectedVersion) {
          throw new VersionConflictError(current.version, current.contentHash);
        }
        if (
          current.attemptState !== "outcome_uncertain" ||
          current.attemptKind !== "create_draft" ||
          current.attemptVersion === null ||
          current.attemptHash === null
        ) {
          throw new ReconciliationRequiredError(current.id);
        }
        const confirmsCurrent =
          current.version === current.attemptVersion &&
          current.contentHash === current.attemptHash;
        const [row] = await transaction
          .update(typefullyDrafts)
          .set({
            ...clearedAttempt,
            remoteDraftId,
            remoteVersion: current.attemptVersion,
            remoteHash: current.attemptHash,
            syncStatus: confirmsCurrent ? "synced" : "local",
            lastError: null,
            updatedAt: now(),
          })
          .where(
            and(
              eq(typefullyDrafts.id, current.id),
              eq(typefullyDrafts.attemptId, current.attemptId ?? ""),
              eq(typefullyDrafts.attemptState, "outcome_uncertain"),
            ),
          )
          .returning(draftSelection);
        if (!row) throw new ReconciliationRequiredError(current.id);
        return asDraft(row);
      });
    },

    async recordRemoteConfirmation(input: {
      draftId: string;
      actorId: string;
      expectedVersion: number;
      expectedHash?: string;
      remoteDraftId: string;
      attemptId?: string;
    }): Promise<TypefullyDraft> {
      const remoteDraftId = validRemoteDraftId(input.remoteDraftId);
      return database.transaction(async (transaction) => {
        const current = await lockedOwnedDraft(
          transaction,
          input.draftId,
          input.actorId,
        );
        if (
          !(await lockMembership(transaction, current.channelId, input.actorId))
        ) {
          throw new DraftNotFoundError();
        }
        const expectedHash = input.expectedHash ?? current.contentHash;
        if (
          input.attemptId !== undefined &&
          current.attemptId !== input.attemptId
        ) {
          throw new StaleRemoteAttemptError();
        }
        if (
          current.remoteDraftId !== null &&
          current.remoteDraftId !== remoteDraftId
        ) {
          throw new RemoteConfirmationConflictError(current.remoteDraftId);
        }
        if (
          current.remoteDraftId === remoteDraftId &&
          current.remoteVersion !== null &&
          current.remoteVersion > input.expectedVersion
        ) {
          return current;
        }
        const confirmsCurrent =
          current.version === input.expectedVersion &&
          current.contentHash === expectedHash;
        const [row] = await transaction
          .update(typefullyDrafts)
          .set({
            ...(input.attemptId === undefined ? {} : clearedAttempt),
            remoteDraftId,
            remoteVersion: input.expectedVersion,
            remoteHash: expectedHash,
            syncStatus: confirmsCurrent ? "synced" : "local",
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(typefullyDrafts.id, input.draftId),
              eq(typefullyDrafts.ownerUserId, input.actorId),
              or(
                isNull(typefullyDrafts.remoteDraftId),
                eq(typefullyDrafts.remoteDraftId, remoteDraftId),
              ),
              or(
                isNull(typefullyDrafts.remoteVersion),
                ne(typefullyDrafts.remoteVersion, input.expectedVersion),
                isNull(typefullyDrafts.remoteHash),
                ne(typefullyDrafts.remoteHash, expectedHash),
                ne(
                  typefullyDrafts.syncStatus,
                  confirmsCurrent ? "synced" : "local",
                ),
              ),
              ...(input.attemptId === undefined
                ? []
                : [eq(typefullyDrafts.attemptId, input.attemptId)]),
            ),
          )
          .returning(draftSelection);
        if (!row) {
          const latest = await ownedDraft(
            transaction,
            input.draftId,
            input.actorId,
          );
          if (
            latest.remoteDraftId !== null &&
            latest.remoteDraftId !== remoteDraftId
          ) {
            throw new RemoteConfirmationConflictError(latest.remoteDraftId);
          }
          if (
            latest.remoteDraftId === remoteDraftId &&
            latest.remoteVersion === input.expectedVersion &&
            latest.remoteHash === expectedHash
          ) {
            return latest;
          }
          throw new VersionConflictError(latest.version, latest.contentHash);
        }
        const draft = asDraft(row);
        await recordAuditEvent(auditStore.inTransaction(transaction), {
          eventType: "connector.sync_succeeded",
          targetType: "typefully_draft",
          targetId: draft.id,
          actorUserId: input.actorId,
          payload: auditPayload(draft),
        });
        return draft;
      });
    },

    async recordRemoteFailure(input: {
      draftId: string;
      actorId: string;
      expectedVersion: number;
      expectedHash?: string;
      attemptId?: string;
      error: unknown;
    }): Promise<TypefullyDraft> {
      const lastError = boundedError(input.error);
      return database.transaction(async (transaction) => {
        const current = await lockedOwnedDraft(
          transaction,
          input.draftId,
          input.actorId,
        );
        if (
          !(await lockMembership(transaction, current.channelId, input.actorId))
        ) {
          throw new DraftNotFoundError();
        }
        const expectedHash = input.expectedHash ?? current.contentHash;
        if (
          input.attemptId !== undefined &&
          current.attemptId !== input.attemptId
        ) {
          throw new StaleRemoteAttemptError();
        }
        if (
          current.version !== input.expectedVersion ||
          current.contentHash !== expectedHash
        ) {
          if (current.syncStatus !== "syncing") return current;
          const [released] = await transaction
            .update(typefullyDrafts)
            .set({
              ...(input.attemptId === undefined ? {} : clearedAttempt),
              syncStatus: "local",
              lastError: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(typefullyDrafts.id, input.draftId),
                eq(typefullyDrafts.ownerUserId, input.actorId),
                eq(typefullyDrafts.version, current.version),
                eq(typefullyDrafts.contentHash, current.contentHash),
                eq(typefullyDrafts.syncStatus, "syncing"),
                ...(input.attemptId === undefined
                  ? []
                  : [eq(typefullyDrafts.attemptId, input.attemptId)]),
              ),
            )
            .returning(draftSelection);
          return released ? asDraft(released) : current;
        }
        const [row] = await transaction
          .update(typefullyDrafts)
          .set({
            ...(input.attemptId === undefined ? {} : clearedAttempt),
            syncStatus: "remote_error",
            lastError,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(typefullyDrafts.id, input.draftId),
              eq(typefullyDrafts.ownerUserId, input.actorId),
              eq(typefullyDrafts.version, input.expectedVersion),
              eq(typefullyDrafts.contentHash, expectedHash),
              or(
                isNull(typefullyDrafts.remoteVersion),
                ne(typefullyDrafts.remoteVersion, current.version),
                isNull(typefullyDrafts.remoteHash),
                ne(typefullyDrafts.remoteHash, current.contentHash),
              ),
              or(
                ne(typefullyDrafts.syncStatus, "remote_error"),
                isNull(typefullyDrafts.lastError),
                ne(typefullyDrafts.lastError, lastError),
              ),
              ...(input.attemptId === undefined
                ? []
                : [eq(typefullyDrafts.attemptId, input.attemptId)]),
            ),
          )
          .returning(draftSelection);
        if (!row) {
          const latest = await ownedDraft(
            transaction,
            input.draftId,
            input.actorId,
          );
          if (
            latest.version !== input.expectedVersion ||
            latest.contentHash !== current.contentHash
          ) {
            throw new VersionConflictError(latest.version, latest.contentHash);
          }
          if (
            isCurrentRevisionConfirmed(latest) ||
            (latest.syncStatus === "remote_error" &&
              latest.lastError === lastError)
          ) {
            return latest;
          }
          throw new VersionConflictError(latest.version, latest.contentHash);
        }
        const draft = asDraft(row);
        await recordAuditEvent(auditStore.inTransaction(transaction), {
          eventType: "connector.sync_failed",
          targetType: "typefully_draft",
          targetId: draft.id,
          actorUserId: input.actorId,
          payload: auditPayload(draft),
        });
        return draft;
      });
    },
  };
  return store;
}

export type TypefullyStore = ReturnType<typeof createTypefullyStore>;
