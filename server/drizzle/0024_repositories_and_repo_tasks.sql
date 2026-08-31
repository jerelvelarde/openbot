CREATE TABLE "repo_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"agent_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"source" jsonb NOT NULL,
	"base" text NOT NULL,
	"branch" text NOT NULL,
	"state" text NOT NULL,
	"failure" text,
	"pull_request_url" text,
	"thread_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_tasks" ADD CONSTRAINT "repo_tasks_repo_repositories_id_fk" FOREIGN KEY ("repo") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_tasks" ADD CONSTRAINT "repo_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_tasks_state_idx" ON "repo_tasks" USING btree ("state");--> statement-breakpoint
CREATE INDEX "repo_tasks_repo_idx" ON "repo_tasks" USING btree ("repo");--> statement-breakpoint
CREATE INDEX "repo_tasks_agent_idx" ON "repo_tasks" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "repositories_owner_idx" ON "repositories" USING btree ("owner");