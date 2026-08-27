CREATE TABLE "external_user_links" (
	"provider" text NOT NULL,
	"provider_tenant_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"openbot_user_id" text NOT NULL,
	"provider_email" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_user_links_provider_provider_tenant_id_provider_user_id_pk" PRIMARY KEY("provider","provider_tenant_id","provider_user_id")
);
--> statement-breakpoint
ALTER TABLE "external_user_links" ADD CONSTRAINT "external_user_links_openbot_user_id_users_id_fk" FOREIGN KEY ("openbot_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_user_links_openbot_workspace_idx" ON "external_user_links" USING btree ("provider","provider_tenant_id","openbot_user_id");