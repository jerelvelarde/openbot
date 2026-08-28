CREATE TABLE "external_thread_messages" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"channels_thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_thread_messages_role_check" CHECK ("external_thread_messages"."role" IN ('user', 'assistant'))
);
--> statement-breakpoint
ALTER TABLE "external_thread_messages" ADD CONSTRAINT "external_thread_messages_channels_thread_id_external_thread_bindings_channels_thread_id_fk" FOREIGN KEY ("channels_thread_id") REFERENCES "public"."external_thread_bindings"("channels_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_thread_messages_thread_message_idx" ON "external_thread_messages" USING btree ("channels_thread_id","message_id");