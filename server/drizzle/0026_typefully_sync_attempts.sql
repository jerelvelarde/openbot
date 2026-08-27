ALTER TABLE "typefully_drafts" ADD COLUMN "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD COLUMN "attempt_kind" text;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD COLUMN "attempt_state" text;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD COLUMN "attempt_version" integer;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD COLUMN "attempt_hash" text;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD COLUMN "attempt_remote_draft_id" text;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD COLUMN "attempt_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD CONSTRAINT "typefully_drafts_attempt_complete" CHECK (("typefully_drafts"."attempt_id" IS NULL AND "typefully_drafts"."attempt_kind" IS NULL AND "typefully_drafts"."attempt_state" IS NULL AND "typefully_drafts"."attempt_version" IS NULL AND "typefully_drafts"."attempt_hash" IS NULL AND "typefully_drafts"."attempt_lease_expires_at" IS NULL) OR ("typefully_drafts"."attempt_id" IS NOT NULL AND "typefully_drafts"."attempt_kind" IS NOT NULL AND "typefully_drafts"."attempt_state" IS NOT NULL AND "typefully_drafts"."attempt_version" IS NOT NULL AND "typefully_drafts"."attempt_hash" IS NOT NULL AND "typefully_drafts"."attempt_lease_expires_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "typefully_drafts" ADD CONSTRAINT "typefully_drafts_attempt_state_valid" CHECK ("typefully_drafts"."attempt_state" IS NULL OR "typefully_drafts"."attempt_state" IN ('in_flight', 'outcome_uncertain'));