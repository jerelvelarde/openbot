CREATE TABLE "external_thread_bindings" (
	"channels_thread_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_tenant_id" text NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_thread_bindings" ADD CONSTRAINT "external_thread_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_thread_bindings" ADD CONSTRAINT "external_thread_bindings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_thread_bindings_provider_thread_idx" ON "external_thread_bindings" USING btree ("provider","provider_tenant_id","provider_conversation_id","provider_thread_id");