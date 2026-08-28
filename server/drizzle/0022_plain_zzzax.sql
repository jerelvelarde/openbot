CREATE TYPE "public"."mcp_user_auth_method" AS ENUM('oauth', 'api_key');--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE 'mcp_user_api_key';--> statement-breakpoint
CREATE TABLE "typefully_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"remote_draft_id" text,
	"document" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"remote_version" integer,
	"remote_hash" text,
	"sync_status" text NOT NULL,
	"last_error" text,
	"attempt_id" uuid,
	"attempt_kind" text,
	"attempt_state" text,
	"attempt_version" integer,
	"attempt_hash" text,
	"attempt_remote_draft_id" text,
	"attempt_lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "typefully_drafts_identity_key" UNIQUE("id","owner_user_id","bot_id","channel_id"),
	CONSTRAINT "typefully_drafts_version_positive" CHECK ("typefully_drafts"."version" > 0),
	CONSTRAINT "typefully_drafts_attempt_complete" CHECK (("typefully_drafts"."attempt_id" IS NULL AND "typefully_drafts"."attempt_kind" IS NULL AND "typefully_drafts"."attempt_state" IS NULL AND "typefully_drafts"."attempt_version" IS NULL AND "typefully_drafts"."attempt_hash" IS NULL AND "typefully_drafts"."attempt_lease_expires_at" IS NULL) OR ("typefully_drafts"."attempt_id" IS NOT NULL AND "typefully_drafts"."attempt_kind" IS NOT NULL AND "typefully_drafts"."attempt_state" IS NOT NULL AND "typefully_drafts"."attempt_version" IS NOT NULL AND "typefully_drafts"."attempt_hash" IS NOT NULL AND "typefully_drafts"."attempt_lease_expires_at" IS NOT NULL)),
	CONSTRAINT "typefully_drafts_attempt_state_valid" CHECK ("typefully_drafts"."attempt_state" IS NULL OR "typefully_drafts"."attempt_state" IN ('in_flight', 'outcome_uncertain'))
);
--> statement-breakpoint
CREATE TABLE "typefully_publication_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"draft_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"vendor_result_id" text,
	"published_url" text,
	"failure_detail" text,
	"attempt_id" uuid,
	"attempt_lease_expires_at" timestamp with time zone,
	"vendor_write_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "typefully_proposals_draft_version_positive" CHECK ("typefully_publication_proposals"."draft_version" > 0),
	CONSTRAINT "typefully_proposals_status_valid" CHECK ("typefully_publication_proposals"."status" IN ('pending', 'in_flight', 'declined', 'expired', 'published', 'failed', 'unknown')),
	CONSTRAINT "typefully_proposals_attempt_complete" CHECK (("typefully_publication_proposals"."status" <> 'in_flight' AND "typefully_publication_proposals"."attempt_id" IS NULL AND "typefully_publication_proposals"."attempt_lease_expires_at" IS NULL AND "typefully_publication_proposals"."vendor_write_started_at" IS NULL) OR ("typefully_publication_proposals"."attempt_id" IS NOT NULL AND "typefully_publication_proposals"."attempt_lease_expires_at" IS NOT NULL AND ("typefully_publication_proposals"."status" = 'in_flight' OR ("typefully_publication_proposals"."status" = 'unknown' AND "typefully_publication_proposals"."vendor_write_started_at" IS NOT NULL))))
);
--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ALTER COLUMN "scope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "grant_mode" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ADD COLUMN "auth_method" "mcp_user_auth_method" DEFAULT 'oauth' NOT NULL;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD CONSTRAINT "typefully_drafts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD CONSTRAINT "typefully_drafts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD CONSTRAINT "typefully_drafts_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD CONSTRAINT "typefully_publication_proposals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD CONSTRAINT "typefully_publication_proposals_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD CONSTRAINT "typefully_publication_proposals_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD CONSTRAINT "typefully_proposals_draft_identity_fk" FOREIGN KEY ("draft_id","owner_user_id","bot_id","channel_id") REFERENCES "public"."typefully_drafts"("id","owner_user_id","bot_id","channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "typefully_drafts_owner_channel_idx" ON "typefully_drafts" USING btree ("owner_user_id","channel_id");--> statement-breakpoint
CREATE INDEX "typefully_proposals_draft_status_idx" ON "typefully_publication_proposals" USING btree ("draft_id","status");--> statement-breakpoint
CREATE FUNCTION "reject_typefully_proposal_review_data_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."draft_id" IS DISTINCT FROM OLD."draft_id"
		OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
		OR NEW."bot_id" IS DISTINCT FROM OLD."bot_id"
		OR NEW."channel_id" IS DISTINCT FROM OLD."channel_id"
		OR NEW."draft_version" IS DISTINCT FROM OLD."draft_version"
		OR NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
		OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
		OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
	THEN
		RAISE EXCEPTION 'typefully proposal immutable review data cannot change'
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "typefully_proposals_immutable_review_data"
BEFORE UPDATE ON "typefully_publication_proposals"
FOR EACH ROW
EXECUTE FUNCTION "reject_typefully_proposal_review_data_update"();--> statement-breakpoint
DELETE FROM "plugin_grants" WHERE "kind" = 'mcp' AND "ref" IN ('typefully/schedule_draft', 'typefully/schedule', 'typefully/publish', 'typefully/publish_now');--> statement-breakpoint
DELETE FROM "mcp_tools" WHERE "server_id" = 'typefully' AND "name" IN ('schedule_draft', 'schedule', 'publish', 'publish_now');--> statement-breakpoint
DELETE FROM "component_exclusions" WHERE "component_name" = 'connectTypefullyAccount';--> statement-breakpoint
UPDATE "components"
SET "grant_mode" = 'explicit',
    "published" = false,
    "published_description" = NULL,
    "published_at" = NULL,
    "updated_by" = 'security migration',
    "updated_at" = now()
WHERE "name" = 'connectTypefullyAccount';--> statement-breakpoint
-- Rows written while this component was treated as open are exclusions. Under explicit governance
-- the same rows mean grants, so retaining them would invert an old denial into publication access.
DELETE FROM "component_exclusions" WHERE "component_name" = 'approveTypefullyPublication';--> statement-breakpoint
UPDATE "components"
SET "grant_mode" = 'explicit',
    "published" = false,
    "published_description" = NULL,
    "published_at" = NULL,
    "updated_by" = 'security migration',
    "updated_at" = now()
WHERE "name" = 'approveTypefullyPublication';
