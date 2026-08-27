ALTER TABLE "components" ADD COLUMN "grant_mode" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
DELETE FROM "component_exclusions" WHERE "component_name" = 'connectTypefullyAccount';--> statement-breakpoint
UPDATE "components"
SET "grant_mode" = 'explicit',
    "published" = false,
    "published_description" = NULL,
    "published_at" = NULL,
    "updated_by" = 'security migration',
    "updated_at" = now()
WHERE "name" = 'connectTypefullyAccount';
