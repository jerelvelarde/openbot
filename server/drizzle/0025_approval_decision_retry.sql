-- Rows created before subject binding cannot be re-authorized safely. Their Channels actions remain
-- one-use capabilities, but this application gate now fails them closed instead of guessing a user
-- or thread.
DELETE FROM "approval_decisions";--> statement-breakpoint
ALTER TABLE "approval_decisions" ALTER COLUMN "action_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_decisions" ALTER COLUMN "approved" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD COLUMN "channels_thread_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD COLUMN "conversation_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD COLUMN "agent_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD COLUMN "created_by_user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD COLUMN "decided_by_user_id" text;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_channels_thread_id_external_thread_bindings_channels_thread_id_fk" FOREIGN KEY ("channels_thread_id") REFERENCES "public"."external_thread_bindings"("channels_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_decisions_created_at_idx" ON "approval_decisions" USING btree ("created_at");
