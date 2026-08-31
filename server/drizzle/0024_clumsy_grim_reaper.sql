CREATE TABLE "external_thread_conversation_refs" (
	"channels_thread_id" text PRIMARY KEY NOT NULL,
	"conversation_ref" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_thread_conversation_refs_ref_present_check" CHECK (length("external_thread_conversation_refs"."conversation_ref") > 0)
);
--> statement-breakpoint
CREATE TABLE "external_web_turns" (
	"operation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channels_thread_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"author_user_id" text NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"failure_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_web_turns_status_check" CHECK ("external_web_turns"."status" IN ('accepted', 'delivered', 'failed')),
	CONSTRAINT "external_web_turns_failure_category_check" CHECK (("external_web_turns"."status" = 'failed') = ("external_web_turns"."failure_category" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "external_thread_conversation_refs" ADD CONSTRAINT "external_thread_conversation_refs_channels_thread_id_external_thread_bindings_channels_thread_id_fk" FOREIGN KEY ("channels_thread_id") REFERENCES "public"."external_thread_bindings"("channels_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_web_turns" ADD CONSTRAINT "external_web_turns_channels_thread_id_external_thread_bindings_channels_thread_id_fk" FOREIGN KEY ("channels_thread_id") REFERENCES "public"."external_thread_bindings"("channels_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_web_turns" ADD CONSTRAINT "external_web_turns_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_web_turns_thread_idempotency_idx" ON "external_web_turns" USING btree ("channels_thread_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "external_web_turns_thread_created_idx" ON "external_web_turns" USING btree ("channels_thread_id","created_at" DESC NULLS LAST);