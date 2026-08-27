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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "typefully_drafts_id_owner_key" UNIQUE("id","owner_user_id"),
	CONSTRAINT "typefully_drafts_version_positive" CHECK ("typefully_drafts"."version" > 0)
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "typefully_proposals_draft_version_positive" CHECK ("typefully_publication_proposals"."draft_version" > 0),
	CONSTRAINT "typefully_proposals_status_valid" CHECK ("typefully_publication_proposals"."status" IN ('pending', 'declined', 'expired', 'published', 'failed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ALTER COLUMN "scope" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ADD COLUMN "auth_method" "mcp_user_auth_method";--> statement-breakpoint
UPDATE "mcp_user_credentials" SET "auth_method" = 'oauth' WHERE "auth_method" IS NULL;--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ALTER COLUMN "auth_method" SET DEFAULT 'oauth';--> statement-breakpoint
ALTER TABLE "mcp_user_credentials" ALTER COLUMN "auth_method" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD CONSTRAINT "typefully_drafts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD CONSTRAINT "typefully_drafts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD CONSTRAINT "typefully_drafts_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD CONSTRAINT "typefully_publication_proposals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD CONSTRAINT "typefully_publication_proposals_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD CONSTRAINT "typefully_publication_proposals_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD CONSTRAINT "typefully_proposals_draft_owner_fk" FOREIGN KEY ("draft_id","owner_user_id") REFERENCES "public"."typefully_drafts"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "typefully_drafts_owner_channel_idx" ON "typefully_drafts" USING btree ("owner_user_id","channel_id");--> statement-breakpoint
CREATE INDEX "typefully_proposals_draft_status_idx" ON "typefully_publication_proposals" USING btree ("draft_id","status");
