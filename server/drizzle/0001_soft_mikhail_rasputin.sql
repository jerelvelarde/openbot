CREATE TYPE "public"."approval_state" AS ENUM('pending', 'allowed', 'denied', 'expired');--> statement-breakpoint
CREATE TABLE "pending_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text,
	"actor_user_id" text,
	"tool_name" text NOT NULL,
	"intent" text,
	"subject_kind" text NOT NULL,
	"subject_label" text NOT NULL,
	"subject_host" text,
	"rule" text NOT NULL,
	"reason" text NOT NULL,
	"state" "approval_state" DEFAULT 'pending' NOT NULL,
	"answered_by_user_id" text,
	"answered_at" timestamp with time zone,
	"scoped_rule" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_policy" ADD COLUMN "ask" text[];--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_answered_by_user_id_users_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_approvals_state_created_idx" ON "pending_approvals" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "pending_approvals_agent_idx" ON "pending_approvals" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "push_devices_user_idx" ON "push_devices" USING btree ("user_id");