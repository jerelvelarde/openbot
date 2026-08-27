CREATE TABLE "approval_decisions" (
	"presentation_id" uuid PRIMARY KEY NOT NULL,
	"channels_thread_id" text NOT NULL,
	"conversation_key" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"action_id" text,
	"approved" boolean,
	"decided_by_user_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_thread_bindings" (
	"channels_thread_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_tenant_id" text NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_thread_bindings_provider_slack_check" CHECK ("external_thread_bindings"."provider" = 'slack')
);
--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_channels_thread_id_external_thread_bindings_channels_thread_id_fk" FOREIGN KEY ("channels_thread_id") REFERENCES "public"."external_thread_bindings"("channels_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_thread_bindings" ADD CONSTRAINT "external_thread_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_thread_bindings" ADD CONSTRAINT "external_thread_bindings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_decisions_created_at_idx" ON "approval_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_thread_bindings_provider_thread_idx" ON "external_thread_bindings" USING btree ("provider","provider_tenant_id","provider_conversation_id","provider_thread_id");