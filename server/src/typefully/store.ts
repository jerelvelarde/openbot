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
import type { PluginDecision, PluginKind } from "../plugins/store";
import { typefullyBotContracts } from "../plugins/typefully-contracts";
import {
  type CanonicalDraftDocument,
  canonicalizeDraft,
  type DraftSyncStatus,
  draftSummary,
  syncStatusSchema,
} from "./document";

const LAST_ERROR_MAX_LENGTH = 500;
const DEFAULT_VENDOR_ID = "typefully";
const MAX_TYPEFULLY_DRAFT_ID = BigInt(Number.MAX_SAFE_INTEGER);
type RemoteDraftOperation = "create_draft" | "update_draft";

const SENSITIVE_ERROR_FIELD =
  /\b(api[\p{P}\p{Z}\s]*key|authorization|access[\p{P}\p{Z}\s]*token|refresh[\p{P}\p{Z}\s]*token|client[\p{P}\p{Z}\s]*secret|id[\p{P}\p{Z}\s]*token|token|secret)(\s*(?:[:=]\s*)+|\s+)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;&]+)/giu;
const SENSITIVE_JSON_FIELD =
  /(["'])(api[\p{P}\p{Z}\s]*key|authorization|access[\p{P}\p{Z}\s]*token|refresh[\p{P}\p{Z}\s]*token|client[\p{P}\p{Z}\s]*secret|id[\p{P}\p{Z}\s]*token|token|secret)\1(\s*:\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,}\]]+)/giu;

type AuthorizationSurface = {
  decide(kind: PluginKind, ref: string, botId: string): Promise<PluginDecision>;
  callTool?(input: {
    ref: string;
    args: Record<string, unknown>;
    botId: string;
    actorId: string;
    _vendorDispatch?: boolean;
  }): Promise<{ text: string; isError: boolean }>;
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
  createdAt: typefullyDrafts.createdAt,
  updatedAt: typefullyDrafts.updatedAt,
};

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
  createdAt: Date;
  updatedAt: Date;
};

function asDraft(row: SelectedDraft): TypefullyDraft {
  const canonical = canonicalizeDraft(row.document);
  return {
    ...row,
    document: canonical.document,
    syncStatus: syncStatusSchema.parse(row.syncStatus),
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
}) {
  const { database, plugin, auditStore } = options;
  const serverId = serverIdFor(options.vendor);
  const grantRef = (operation: RemoteDraftOperation) =>
    `${serverId}/${operation}`;

  async function isGranted(
    operation: RemoteDraftOperation,
    botId: string,
  ): Promise<boolean> {
    const decision = await plugin().decide("mcp", grantRef(operation), botId);
    return decision.allowed;
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
      return null;
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
        const current = await ownedDraft(
          transaction,
          input.draftId,
          input.actorId,
        );
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
        const syncStatus: DraftSyncStatus =
          current.syncStatus === "syncing" && current.remoteDraftId === null
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
    }): Promise<{
      draft: TypefullyDraft;
      result: { text: string; isError: boolean };
    }> {
      const authorized = await store.authorizeRemoteOperation(input);
      const [claimed] = await database
        .update(typefullyDrafts)
        .set({ syncStatus: "syncing", updatedAt: new Date() })
        .where(
          and(
            eq(typefullyDrafts.id, authorized.draft.id),
            eq(typefullyDrafts.ownerUserId, input.actorId),
            eq(typefullyDrafts.version, authorized.draft.version),
            eq(typefullyDrafts.contentHash, authorized.draft.contentHash),
            ne(typefullyDrafts.syncStatus, "syncing"),
          ),
        )
        .returning(draftSelection);
      if (!claimed) {
        const latest = await ownedDraft(database, input.draftId, input.actorId);
        if (
          latest.version === authorized.draft.version &&
          latest.contentHash === authorized.draft.contentHash &&
          latest.syncStatus === "syncing"
        ) {
          throw new SyncInProgressError();
        }
        throw new VersionConflictError(latest.version, latest.contentHash);
      }
      authorized.draft = asDraft(claimed);
      const callTool = plugin().callTool;
      let result: { text: string; isError: boolean };
      try {
        if (!callTool) {
          throw new Error("Typefully remote calls are unavailable.");
        }
        result = await callTool({
          ref: authorized.ref,
          args: remoteArgs(authorized.draft),
          botId: authorized.draft.botId,
          actorId: input.actorId,
          _vendorDispatch: true,
        });
      } catch (error) {
        if (
          (error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "connection_required") ||
          (error instanceof Error && error.name === "PluginRefusedError")
        ) {
          await database
            .update(typefullyDrafts)
            .set({
              syncStatus:
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "connection_required"
                  ? "connection_required"
                  : "grant_blocked",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(typefullyDrafts.id, authorized.draft.id),
                eq(typefullyDrafts.version, authorized.draft.version),
                eq(typefullyDrafts.contentHash, authorized.draft.contentHash),
                eq(typefullyDrafts.syncStatus, "syncing"),
              ),
            );
          throw error;
        }
        const draft = await store.recordRemoteFailure({
          draftId: input.draftId,
          actorId: input.actorId,
          expectedVersion: authorized.draft.version,
          expectedHash: authorized.draft.contentHash,
          error,
        });
        return {
          draft,
          result: { text: boundedError(error), isError: true },
        };
      }
      if (result.isError) {
        const draft = await store.recordRemoteFailure({
          draftId: input.draftId,
          actorId: input.actorId,
          expectedVersion: authorized.draft.version,
          expectedHash: authorized.draft.contentHash,
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
        const failure = {
          text: "Typefully did not return a draft id.",
          isError: true,
        };
        const draft = await store.recordRemoteFailure({
          draftId: input.draftId,
          actorId: input.actorId,
          expectedVersion: authorized.draft.version,
          expectedHash: authorized.draft.contentHash,
          error: failure.text,
        });
        return { draft, result: failure };
      }
      try {
        const draft = await store.recordRemoteConfirmation({
          draftId: input.draftId,
          actorId: input.actorId,
          expectedVersion: authorized.draft.version,
          expectedHash: authorized.draft.contentHash,
          remoteDraftId: remoteId,
        });
        return { draft, result };
      } catch (error) {
        if (!(error instanceof InvalidRemoteDraftIdError)) throw error;
        const failure = {
          text: "Typefully returned an invalid draft id.",
          isError: true,
        };
        const draft = await store.recordRemoteFailure({
          draftId: input.draftId,
          actorId: input.actorId,
          expectedVersion: authorized.draft.version,
          expectedHash: authorized.draft.contentHash,
          error: failure.text,
        });
        return { draft, result: failure };
      }
    },

    async callRemoteTool(input: {
      draftId: string;
      actorId: string;
      toolName: "upload_media" | "remove_media";
      args: Record<string, unknown>;
    }): Promise<{ draft: TypefullyDraft; text: string; isError: boolean }> {
      const draft = await store.authorizeTool({
        draftId: input.draftId,
        actorId: input.actorId,
        toolName: input.toolName,
      });
      const callTool = plugin().callTool;
      if (!callTool) throw new Error("Typefully remote calls are unavailable.");
      const result = await callTool({
        ref: `${serverId}/${input.toolName}`,
        args: input.args,
        botId: draft.botId,
        actorId: input.actorId,
        _vendorDispatch: true,
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

    async recordRemoteConfirmation(input: {
      draftId: string;
      actorId: string;
      expectedVersion: number;
      expectedHash?: string;
      remoteDraftId: string;
    }): Promise<TypefullyDraft> {
      const remoteDraftId = validRemoteDraftId(input.remoteDraftId);
      return database.transaction(async (transaction) => {
        const current = await ownedDraft(
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
      error: unknown;
    }): Promise<TypefullyDraft> {
      const lastError = boundedError(input.error);
      return database.transaction(async (transaction) => {
        const current = await ownedDraft(
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
          current.version !== input.expectedVersion ||
          current.contentHash !== expectedHash
        ) {
          if (current.syncStatus !== "syncing") return current;
          const [released] = await transaction
            .update(typefullyDrafts)
            .set({
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
              ),
            )
            .returning(draftSelection);
          return released ? asDraft(released) : current;
        }
        const [row] = await transaction
          .update(typefullyDrafts)
          .set({
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
