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
