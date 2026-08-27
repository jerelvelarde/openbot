import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, channels, users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** A locally editable Typefully document and the remote revision it most recently matched. */
export const typefullyDrafts = pgTable(
  "typefully_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    remoteDraftId: text("remote_draft_id"),
    document: jsonb("document").notNull(),
    version: integer("version").notNull().default(1),
    contentHash: text("content_hash").notNull(),
    remoteVersion: integer("remote_version"),
    remoteHash: text("remote_hash"),
    syncStatus: text("sync_status").notNull(),
    /** Length is bounded when application input is validated; Postgres keeps the full diagnostic. */
    lastError: text("last_error"),
    /** Durable single-flight ownership for remote draft/media work. Never exposed to Bots. */
    attemptId: uuid("attempt_id"),
    attemptKind: text("attempt_kind"),
    attemptState: text("attempt_state"),
    attemptVersion: integer("attempt_version"),
    attemptHash: text("attempt_hash"),
    attemptRemoteDraftId: text("attempt_remote_draft_id"),
    attemptLeaseExpiresAt: timestamp("attempt_lease_expires_at", {
      withTimezone: true,
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("typefully_drafts_identity_key").on(
      table.id,
      table.ownerUserId,
      table.botId,
      table.channelId,
    ),
    index("typefully_drafts_owner_channel_idx").on(
      table.ownerUserId,
      table.channelId,
    ),
    check("typefully_drafts_version_positive", sql`${table.version} > 0`),
    check(
      "typefully_drafts_attempt_complete",
      sql`(${table.attemptId} IS NULL AND ${table.attemptKind} IS NULL AND ${table.attemptState} IS NULL AND ${table.attemptVersion} IS NULL AND ${table.attemptHash} IS NULL AND ${table.attemptLeaseExpiresAt} IS NULL) OR (${table.attemptId} IS NOT NULL AND ${table.attemptKind} IS NOT NULL AND ${table.attemptState} IS NOT NULL AND ${table.attemptVersion} IS NOT NULL AND ${table.attemptHash} IS NOT NULL AND ${table.attemptLeaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "typefully_drafts_attempt_state_valid",
      sql`${table.attemptState} IS NULL OR ${table.attemptState} IN ('in_flight', 'outcome_uncertain')`,
    ),
  ],
);

/** An immutable candidate for publishing one exact revision of a Typefully draft. */
export const typefullyPublicationProposals = pgTable(
  "typefully_publication_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    draftVersion: integer("draft_version").notNull(),
    contentHash: text("content_hash").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    status: text("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Vendor-returned text is bounded by application validation before persistence. */
    vendorResultId: text("vendor_result_id"),
    publishedUrl: text("published_url"),
    failureDetail: text("failure_detail"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "typefully_proposals_draft_identity_fk",
      columns: [table.draftId, table.ownerUserId, table.botId, table.channelId],
      foreignColumns: [
        typefullyDrafts.id,
        typefullyDrafts.ownerUserId,
        typefullyDrafts.botId,
        typefullyDrafts.channelId,
      ],
    }).onDelete("cascade"),
    index("typefully_proposals_draft_status_idx").on(
      table.draftId,
      table.status,
    ),
    check(
      "typefully_proposals_draft_version_positive",
      sql`${table.draftVersion} > 0`,
    ),
    check(
      "typefully_proposals_status_valid",
      sql`${table.status} IN ('pending', 'declined', 'expired', 'published', 'failed', 'unknown')`,
    ),
  ],
);
