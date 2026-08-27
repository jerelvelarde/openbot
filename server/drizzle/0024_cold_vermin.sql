CREATE TABLE "approval_decisions" (
	"presentation_id" uuid PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"approved" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
