import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A repository this deployment can reach, and the credential it reaches it with.
 *
 * CONNECTING IS ACCOUNT-WIDE; REACHING IS PER BOT. The same split plugins make, and for the same
 * reason: the credential is the deployment's, and which Bots may spend it is a separate decision an
 * administrator makes later. So this table holds no Bot, and reachability is an ordinary row in
 * `plugin_grants` under the kinds `repo` and `repo_push`.
 *
 * `id` is `owner/name`, which is also the grant's `ref`. One spelling for one thing: a surrogate key
 * would mean the grant table carried an id nobody reading it could resolve, and every screen showing
 * a grant would need a join to say which repository it was about.
 *
 * NO TOKEN HERE. `credential_id` points at the write-only credential store, which is where every
 * other secret in this deployment lives. A column of tokens on a table an administrator screen lists
 * is how a token ends up in a log.
 */
export const repositories = pgTable(
  "repositories",
  {
    /** `owner/name`. Also the grant ref, so a grant row is readable on its own. */
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    /**
     * What a task branches from unless it says otherwise.
     *
     * Stored rather than asked for each time, because the answer comes from the forge and a task
     * that guessed `main` against a repository still on `master` fails at the first checkout.
     */
    defaultBranch: text("default_branch").notNull(),
    /** The credential this repository is reached with. Null while one has not been chosen. */
    credentialId: uuid("credential_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("repositories_owner_idx").on(table.owner)],
);

/**
 * One piece of work handed to a coworker on a repository.
 *
 * WHY A TABLE AND NOT JUST A WORK ITEM. `work_items` is a claim with a lease: it says who is doing a
 * thing right now and nothing about what came of it. A task outlives its claim — it has a branch
 * somebody can find, a pull request that is the whole point of it, and a failure a person needs to
 * read tomorrow. Keeping that in the queue row would mean a finished task either sits in the queue
 * forever or takes its own history with it when it leaves.
 *
 * `branch` is the task's own, and it is what a push is checked against. A Bot that could push
 * anywhere it liked would make the grant meaningless, so the branch is written here when the task
 * is created and the push tool compares against this row rather than against anything the model
 * said.
 */
export const repoTasks = pgTable(
  "repo_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repo: text("repo")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * Whose authorization the run carries.
     *
     * Not a foreign key to `users`, for the reason the audit table's payload is not either: the
     * local development actor is not a row there, and a task started in single-user mode must not
     * fail to insert. Who it was is still recorded, which is what a reader needs.
     */
    actorId: text("actor_id").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    /** Where the work came from: an issue, a pull request, or a person who just described it. */
    source: jsonb("source").notNull(),
    base: text("base").notNull(),
    branch: text("branch").notNull(),
    /** `queued`, `running`, `opened`, `failed`, `cancelled`. */
    state: text("state").notNull(),
    /** Said in a sentence, on `failed` and `cancelled`. Never a stack. */
    failure: text("failure"),
    pullRequestUrl: text("pull_request_url"),
    /** The conversation the work is narrated into, so a person can read it and interrupt. */
    threadId: text("thread_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("repo_tasks_state_idx").on(table.state),
    index("repo_tasks_repo_idx").on(table.repo),
    index("repo_tasks_agent_idx").on(table.agentId),
  ],
);
