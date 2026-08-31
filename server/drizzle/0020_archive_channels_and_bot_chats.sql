CREATE TABLE "bot_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"title" text,
	"last_message" text,
	"last_message_at" timestamp with time zone,
	"last_message_agent_id" text,
	"pinned_at" timestamp with time zone,
	"last_read_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_chats" ADD CONSTRAINT "bot_chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_chats" ADD CONSTRAINT "bot_chats_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_chats" ADD CONSTRAINT "bot_chats_last_message_agent_id_agents_id_fk" FOREIGN KEY ("last_message_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_chats_thread_idx" ON "bot_chats" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "bot_chats_recent_activity_idx" ON "bot_chats" USING btree ("user_id",COALESCE("last_message_at", "created_at") DESC);