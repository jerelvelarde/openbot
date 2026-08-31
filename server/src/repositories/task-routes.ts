import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type {
  RepoTaskRecord,
  RepoTaskSource,
  RepoTaskStore,
  RepositoryStore,
} from "./store";

/**
 * Handing work to a coworker on a repository, and reading what came of it.
 *
 * WHAT THE MODEL NEVER DECIDES. The branch, the base and the coworker's access are all settled here,
 * before a run exists. A push is later checked against the branch on the task row, so a Bot that
 * invented a branch name mid-run would be refused; letting the model name it would make that check
 * a formality.
 */

/** How long a title may be before it stops being a title. */
const TITLE_LIMIT = 72;

/**
 * A branch nobody else owns.
 *
 * Prefixed with the Bot rather than the person, because what the prefix protects against is a Bot
 * writing over another Bot's work, and because an administrator reading the forge should be able to
 * tell at a glance which branches are a coworker's. The task id makes it unique without the
 * deployment having to ask the forge what already exists.
 */
export function branchFor(
  agentId: string,
  taskId: string,
  title: string,
): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-");
  const safeAgent = agentId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return `bot/${safeAgent}/${slug || "task"}-${taskId.slice(0, 8)}`;
}

/** The first sentence of what somebody asked for, as the thing a list can show. */
export function titleFrom(instructions: string): string {
  const first = instructions.split(/[.\n]/)[0]?.trim() ?? "";
  const text = first || instructions.trim();
  return text.length > TITLE_LIMIT
    ? `${text.slice(0, TITLE_LIMIT - 1).trimEnd()}…`
    : text;
}

/**
 * Where the work came from.
 *
 * A URL is read for its number rather than trusted to be a forge link, because the number is the
 * only part anything here uses and a link to somewhere else is a fact about the request rather than
 * an error in it. What must not happen is a number invented from a URL that has none.
 */
export function sourceFrom(reference: string): RepoTaskSource {
  const trimmed = reference.trim();
  if (!trimmed) return { kind: "manual" };
  const match = trimmed.match(/\/(issues|pull)\/(\d+)/);
  if (!match) return { kind: "manual", url: trimmed };
  return {
    kind: match[1] === "pull" ? "pull_request" : "issue",
    number: Number(match[2]),
    url: trimmed,
  };
}

export function createRepoTaskRoutes(
  options: {
    tasks: RepoTaskStore;
    repositories: RepositoryStore;
    /** Puts the task in front of a runner. Absent leaves it queued, which is honest. */
    enqueue?: (task: RepoTaskRecord) => Promise<void>;
  },
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { tasks, repositories, enqueue } = options;

  routes.get("/", requireUser, async (context) =>
    context.json({ tasks: await tasks.listFor(context.var.actor.id) }),
  );

  routes.get("/:taskId", requireUser, async (context) => {
    const task = await tasks.find(context.req.param("taskId"));
    /*
     * A task belonging to somebody else is "no such task", not "forbidden".
     *
     * The instructions on it are theirs, and so is the fact that they asked for it at all. A 403
     * would confirm the id names something real, which is the half of the answer worth withholding.
     */
    if (!task || task.actorId !== context.var.actor.id) {
      return context.json({ error: "No such task." }, 404);
    }
    return context.json({ task });
  });

  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      repo?: unknown;
      agentId?: unknown;
      base?: unknown;
      reference?: unknown;
      instructions?: unknown;
    } | null;

    const repo = typeof body?.repo === "string" ? body.repo : "";
    const agentId = typeof body?.agentId === "string" ? body.agentId : "";
    const instructions =
      typeof body?.instructions === "string" ? body.instructions.trim() : "";

    if (!repo || !agentId || !instructions) {
      return context.json(
        { error: "A repository, a coworker and what to do are all required." },
        400,
      );
    }

    const repository = await repositories.find(repo);
    if (!repository) return context.json({ error: "No such repository." }, 404);

    /*
     * The grant is checked here as well as at the tool.
     *
     * Not because the tool's check is unreliable, but because a task accepted now and refused
     * twenty minutes into a run is a worse answer than a refusal at the moment somebody asked. The
     * tool keeps its own check, since a grant can be revoked between the two.
     */
    const access = await repositories.accessFor(agentId, repo);
    if (access !== "contribute") {
      return context.json(
        {
          error:
            access === "read"
              ? "That coworker may read this repository but not contribute to it."
              : "That coworker has not been granted this repository.",
        },
        403,
      );
    }

    const title = titleFrom(instructions);
    const created = await tasks.create({
      repo,
      agentId,
      actorId: context.var.actor.id,
      title,
      instructions,
      source: sourceFrom(
        typeof body?.reference === "string" ? body.reference : "",
      ),
      base:
        typeof body?.base === "string" && body.base.trim()
          ? body.base.trim()
          : repository.defaultBranch,
      // Replaced below: the branch needs the id, and the id is the database's to hand out.
      branch: "pending",
    });

    /*
     * The branch is written in a second statement because its name needs the task id, and the id is
     * the database's to hand out. Minting one here instead would move identity away from the only
     * thing that can guarantee it is unique.
     */
    const branch = branchFor(agentId, created.id, title);
    await tasks.update(created.id, { branch });
    const task: RepoTaskRecord = { ...created, branch };

    if (enqueue) await enqueue(task);
    return context.json({ task });
  });

  routes.post("/:taskId/cancel", requireUser, async (context) => {
    const task = await tasks.find(context.req.param("taskId"));
    if (!task || task.actorId !== context.var.actor.id) {
      return context.json({ error: "No such task." }, 404);
    }
    if (task.state !== "queued" && task.state !== "running") {
      // Already finished. Saying so beats rewriting a finished task's outcome.
      return context.json({ task });
    }

    await tasks.update(task.id, {
      state: "cancelled",
      failure: `Stopped by ${context.var.actor.email}.`,
      finishedAt: new Date(),
    });
    return context.json({ task: await tasks.find(task.id) });
  });

  return routes;
}
