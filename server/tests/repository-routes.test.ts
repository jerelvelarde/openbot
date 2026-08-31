import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createRepositoryRoutes } from "../src/repositories/routes";
import {
  branchFor,
  createRepoTaskRoutes,
  sourceFrom,
  titleFrom,
} from "../src/repositories/task-routes";
import type {
  RepositoryRecord,
  RepositoryStore,
  RepoTaskRecord,
  RepoTaskStore,
} from "../src/repositories/store";

/**
 * What these routes must hold, before anything runs a task.
 *
 * The properties are the ones a reviewer would want checked at the door rather than discovered by a
 * Bot twenty minutes into a run: that connecting is an administrator's decision and listing is not,
 * that a repository whose id contains a slash is still found, that a coworker without a contribute
 * grant cannot be handed work, and that one person cannot read another's task.
 */

const admin = {
  id: "user-admin",
  email: "admin@openbot.test",
  role: "admin",
} as const;
const member = {
  id: "user-member",
  email: "member@openbot.test",
  role: "user",
} as const;

const asActor =
  (
    actor: typeof admin | typeof member,
  ): MiddlewareHandler<{ Variables: AppVariables }> =>
  async (context, next) => {
    context.set("actor", actor);
    await next();
  };

function repository(
  overrides: Partial<RepositoryRecord> = {},
): RepositoryRecord {
  return {
    id: "CopilotKit/openbot",
    owner: "CopilotKit",
    name: "openbot",
    defaultBranch: "main",
    hasAuth: true,
    grants: [{ agentId: "eng", access: "contribute" }],
    ...overrides,
  };
}

function fakeRepositories(overrides: Partial<RepositoryStore> = {}) {
  const calls: [string, ...unknown[]][] = [];
  const base = {
    async list() {
      return [repository()];
    },
    async find(id: string) {
      return id === "CopilotKit/openbot" ? repository() : null;
    },
    async connect(input: unknown) {
      calls.push(["connect", input]);
    },
    async forget(id: string) {
      calls.push(["forget", id]);
    },
    async setGrants(input: unknown) {
      calls.push(["setGrants", input]);
    },
    async accessFor(agentId: string) {
      return agentId === "eng" ? ("contribute" as const) : null;
    },
  } as unknown as RepositoryStore;
  return Object.assign(base, overrides, { calls });
}

function fakeTasks(overrides: Partial<RepoTaskStore> = {}) {
  const created: RepoTaskRecord[] = [];
  const updates: [string, unknown][] = [];
  const base = {
    async listFor() {
      return created;
    },
    async find(id: string) {
      return created.find((task) => task.id === id) ?? null;
    },
    async create(input: Record<string, unknown>) {
      const task = {
        ...input,
        id: "11111111-2222-3333-4444-555555555555",
        state: "queued",
        createdAt: new Date().toISOString(),
      } as RepoTaskRecord;
      created.push(task);
      return task;
    },
    async update(id: string, change: unknown) {
      updates.push([id, change]);
    },
  } as unknown as RepoTaskStore;
  return Object.assign(base, overrides, { created, updates });
}

const repoApp = (
  store: RepositoryStore,
  actor: typeof admin | typeof member = admin,
) =>
  new Hono<{ Variables: AppVariables }>().route(
    "/api/repositories",
    createRepositoryRoutes(store, asActor(actor)),
  );

const taskApp = (
  tasks: RepoTaskStore,
  repositories: RepositoryStore,
  actor: typeof admin | typeof member = member,
) =>
  new Hono<{ Variables: AppVariables }>().route(
    "/api/repo-tasks",
    createRepoTaskRoutes({ tasks, repositories }, asActor(actor)),
  );

describe("naming what a task will be", () => {
  test("a branch is the Bot's, the work's, and nobody else's", () => {
    const branch = branchFor(
      "eng",
      "11111111-2222-3333-4444-555555555555",
      "Keep a computer with a claimed task awake",
    );
    // The Bot first, so an administrator reading the forge can tell a coworker's branches apart.
    expect(branch.startsWith("bot/eng/")).toBe(true);
    // The task id, so two tasks with the same words do not collide on one branch.
    expect(branch.endsWith("-11111111")).toBe(true);
    expect(branch).not.toMatch(/[^a-z0-9/-]/);
  });

  test("a title is the first sentence, and stays a title", () => {
    expect(titleFrom("Fix the culler. Add a test.")).toBe("Fix the culler");
    expect(titleFrom("x".repeat(200)).length).toBeLessThanOrEqual(72);
  });

  test("a reference is read for its number, never given one it does not have", () => {
    expect(sourceFrom("https://github.com/o/r/issues/271")).toEqual({
      kind: "issue",
      number: 271,
      url: "https://github.com/o/r/issues/271",
    });
    expect(sourceFrom("https://github.com/o/r/pull/9")).toMatchObject({
      kind: "pull_request",
      number: 9,
    });
    // A link to somewhere else is a fact about the request, not an error in it.
    expect(sourceFrom("https://example.test/notes")).toEqual({
      kind: "manual",
      url: "https://example.test/notes",
    });
    expect(sourceFrom("  ")).toEqual({ kind: "manual" });
  });
});

describe("the repositories screen", () => {
  test("anybody may see what exists, because the compose dialog needs it", async () => {
    const response = await repoApp(fakeRepositories(), member).request(
      "http://t/api/repositories",
    );
    expect(response.status).toBe(200);
    expect((await response.json()).repositories).toHaveLength(1);
  });

  test("connecting one is an administrator's decision", async () => {
    const response = await repoApp(fakeRepositories(), member).request(
      "http://t/api/repositories",
      {
        method: "POST",
        body: JSON.stringify({ repo: "CopilotKit/openbot" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(response.status).toBe(403);
  });

  test("a name that would escape a path is refused before it reaches the store", async () => {
    const store = fakeRepositories();
    const response = await repoApp(store).request("http://t/api/repositories", {
      method: "POST",
      body: JSON.stringify({ repo: "owner/../../etc" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
    expect(store.calls).toHaveLength(0);
  });

  test("a repository whose id has a slash in it is still found", async () => {
    const store = fakeRepositories();
    const response = await repoApp(store).request(
      "http://t/api/repositories/CopilotKit/openbot/grants",
      {
        method: "PUT",
        body: JSON.stringify({
          grants: [{ agentId: "eng", access: "contribute" }],
        }),
        headers: { "content-type": "application/json" },
      },
    );
    // Matched as one parameter this is a 404 on a repository that plainly exists.
    expect(response.status).toBe(200);
    expect(store.calls[0]?.[0]).toBe("setGrants");
  });

  test("an access level that is neither read nor contribute is refused", async () => {
    const store = fakeRepositories();
    const response = await repoApp(store).request(
      "http://t/api/repositories/CopilotKit/openbot/grants",
      {
        method: "PUT",
        body: JSON.stringify({ grants: [{ agentId: "eng", access: "admin" }] }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(response.status).toBe(400);
    expect(store.calls).toHaveLength(0);
  });
});

describe("handing work over", () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    method: "POST",
    body: JSON.stringify({
      repo: "CopilotKit/openbot",
      agentId: "eng",
      instructions: "Keep a computer with a claimed task awake. Add a test.",
      ...extra,
    }),
    headers: { "content-type": "application/json" },
  });

  test("a task gets a branch of its own, written after the id exists", async () => {
    const tasks = fakeTasks();
    const response = await taskApp(tasks, fakeRepositories()).request(
      "http://t/api/repo-tasks",
      body(),
    );

    expect(response.status).toBe(200);
    const task = (await response.json()).task as RepoTaskRecord;
    expect(task.branch.startsWith("bot/eng/")).toBe(true);
    expect(task.base).toBe("main");
    // Written in a second statement, because the name needs the id the insert handed out.
    expect(tasks.updates[0]?.[1]).toEqual({ branch: task.branch });
  });

  test("a coworker that may only read cannot be handed work", async () => {
    const store = fakeRepositories({
      async accessFor() {
        return "read";
      },
    } as Partial<RepositoryStore>);

    const response = await taskApp(fakeTasks(), store).request(
      "http://t/api/repo-tasks",
      body(),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("not contribute");
  });

  test("a coworker with no grant at all cannot be handed work", async () => {
    const response = await taskApp(fakeTasks(), fakeRepositories()).request(
      "http://t/api/repo-tasks",
      body({ agentId: "risk" }),
    );
    expect(response.status).toBe(403);
  });

  test("one person cannot read another's task", async () => {
    const tasks = fakeTasks();
    await taskApp(tasks, fakeRepositories()).request(
      "http://t/api/repo-tasks",
      body(),
    );
    const id = tasks.created[0]?.id as string;

    const other = taskApp(tasks, fakeRepositories(), admin);
    const response = await other.request(`http://t/api/repo-tasks/${id}`);
    // "No such task", not "forbidden": a 403 confirms the id names something real.
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("No such task.");
  });
});
