import { and, eq } from "drizzle-orm";
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
import {
  type CanonicalDraftDocument,
  canonicalizeDraft,
  type DraftSyncStatus,
  syncStatusSchema,
} from "./document";

const LAST_ERROR_MAX_LENGTH = 500;
const DEFAULT_VENDOR_ID = "typefully";

type AuthorizationSurface = {
  decide(kind: PluginKind, ref: string, botId: string): Promise<PluginDecision>;
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

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message).slice(0, LAST_ERROR_MAX_LENGTH).join("");
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

export function createTypefullyStore(options: {
  database: Database;
  plugin: () => AuthorizationSurface;
  auditStore: TransactionalAuditStore;
  vendor?: VendorIdentity;
}) {
  const { database, plugin, auditStore } = options;
  const serverId = serverIdFor(options.vendor);
  const grantRef = (operation: "create_draft" | "update_draft") =>
    `${serverId}/${operation}`;

  async function isGranted(
    operation: "create_draft" | "update_draft",
    botId: string,
  ): Promise<boolean> {
    const decision = await plugin().decide("mcp", grantRef(operation), botId);
    return decision.allowed;
  }

  async function requireRemoteAuthorization(
    executor: Database | AuditTransaction,
    draft: TypefullyDraft,
    granted: boolean,
  ) {
    if (!(await isBotAttached(executor, draft.channelId, draft.botId))) {
      throw new BotNotAttachedError();
    }
    if (!granted) {
      throw new GrantRequiredError(
        grantRef("update_draft"),
        "This Bot no longer has the Typefully update grant.",
      );
    }
  }

  return {
    async createDraft(input: {
      ownerUserId: string;
      channelId: string;
      botId: string;
      document: unknown;
    }): Promise<TypefullyDraft> {
      const canonical = canonicalizeDraft(input.document);
      const granted = await isGranted("create_draft", input.botId);
      return database.transaction(async (transaction) => {
        const [membership] = await transaction
          .select({ userId: channelMemberships.userId })
          .from(channelMemberships)
          .where(
            and(
              eq(channelMemberships.channelId, input.channelId),
              eq(channelMemberships.userId, input.ownerUserId),
            ),
          )
          .limit(1);
        if (!membership) throw new DraftNotFoundError();

        const attached = await isBotAttached(
          transaction,
          input.channelId,
          input.botId,
        );
        if (!attached) throw new BotNotAttachedError();
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
      const granted = await isGranted("update_draft", visible.botId);
      return database.transaction(async (transaction) => {
        const current = await ownedDraft(
          transaction,
          input.draftId,
          input.actorId,
        );
        const attached = await isBotAttached(
          transaction,
          current.channelId,
          current.botId,
        );
        const syncStatus: DraftSyncStatus =
          attached && granted ? "local" : "grant_blocked";
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

    async recordRemoteConfirmation(input: {
      draftId: string;
      actorId: string;
      expectedVersion: number;
      remoteDraftId: string;
    }): Promise<TypefullyDraft> {
      const visible = await ownedDraft(database, input.draftId, input.actorId);
      const granted = await isGranted("update_draft", visible.botId);
      return database.transaction(async (transaction) => {
        const current = await ownedDraft(
          transaction,
          input.draftId,
          input.actorId,
        );
        await requireRemoteAuthorization(transaction, current, granted);
        const [row] = await transaction
          .update(typefullyDrafts)
          .set({
            remoteDraftId: input.remoteDraftId,
            remoteVersion: current.version,
            remoteHash: current.contentHash,
            syncStatus: "synced",
            lastError: null,
            updatedAt: new Date(),
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
      error: unknown;
    }): Promise<TypefullyDraft> {
      const visible = await ownedDraft(database, input.draftId, input.actorId);
      const granted = await isGranted("update_draft", visible.botId);
      return database.transaction(async (transaction) => {
        const current = await ownedDraft(
          transaction,
          input.draftId,
          input.actorId,
        );
        await requireRemoteAuthorization(transaction, current, granted);
        const [row] = await transaction
          .update(typefullyDrafts)
          .set({
            syncStatus: "remote_error",
            lastError: boundedError(input.error),
            updatedAt: new Date(),
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
}

export type TypefullyStore = ReturnType<typeof createTypefullyStore>;
