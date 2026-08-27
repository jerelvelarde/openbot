ALTER TABLE "typefully_publication_proposals" DROP CONSTRAINT "typefully_proposals_status_valid";--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD COLUMN "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD COLUMN "attempt_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD COLUMN "vendor_write_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD CONSTRAINT "typefully_proposals_attempt_complete" CHECK (("typefully_publication_proposals"."status" <> 'in_flight' AND "typefully_publication_proposals"."attempt_id" IS NULL AND "typefully_publication_proposals"."attempt_lease_expires_at" IS NULL AND "typefully_publication_proposals"."vendor_write_started_at" IS NULL) OR ("typefully_publication_proposals"."attempt_id" IS NOT NULL AND "typefully_publication_proposals"."attempt_lease_expires_at" IS NOT NULL AND ("typefully_publication_proposals"."status" = 'in_flight' OR ("typefully_publication_proposals"."status" = 'unknown' AND "typefully_publication_proposals"."vendor_write_started_at" IS NOT NULL))));--> statement-breakpoint
ALTER TABLE "typefully_publication_proposals" ADD CONSTRAINT "typefully_proposals_status_valid" CHECK ("typefully_publication_proposals"."status" IN ('pending', 'in_flight', 'declined', 'expired', 'published', 'failed', 'unknown'));
--> statement-breakpoint
DELETE FROM "plugin_grants" WHERE "kind" = 'mcp' AND "ref" IN ('typefully/schedule_draft', 'typefully/schedule', 'typefully/publish', 'typefully/publish_now');
--> statement-breakpoint
DELETE FROM "mcp_tools" WHERE "server_id" = 'typefully' AND "name" IN ('schedule_draft', 'schedule', 'publish', 'publish_now');
