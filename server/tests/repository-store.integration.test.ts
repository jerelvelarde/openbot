import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  pluginGrants,
  repositories,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import {
  createRepositoryStore,
  parseRepositoryId,
} from "../src/repositories/store";

/**
 * What the repository store must guarantee.
 *
 * The level a Bot holds is stored as two grant rows rather than a column, so the properties worth
 * pinning are the ones that arrangement makes easy to get wrong: that two rows fold back into one
 * answer, that downgrading actually removes the push row rather than merely not adding it, and that
 * a grant change leaves a trail like every other grant change does.
 *
 * `parseRepositoryId` is here too, because its output becomes a directory under a Bot's workspace
 * and a `ref` policy rules are written against.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  2,
);

const suite = randomUUID().slice(0, 8);
const REPO = `openbot-test-${suite}/widgets`;
const BOT_A = `repo-store-${suite}-a`;
const BOT_B = `repo-store-${suite}-b`;

const auditStore = createAuditStore(database);
const pluginStore = createPluginStore({ database, auditStore });
const store = createRepositoryStore(database, pluginStore);

beforeAll(async () => {
  await database
    .insert(agents)
    .values(
      [BOT_A, BOT_B].map((id) => ({
        id,
        name: id,
        type: "built_in" as const,
        configuration: {},
      })),
    )
    .onConflictDoNothing();
});

afterAll(async () => {
  /*
   * Scoped to this suite's own Bots and its own repository, never to the ref alone: a delete by ref
   * would reach grants an administrator made for a Bot people actually use.
   */
  await database
    .delete(pluginGrants)
    .where(inArray(pluginGrants.agentId, [BOT_A, BOT_B]));
  await database.delete(repositories).where(eq(repositories.id, REPO));
  await database.delete(agents).where(inArray(agents.id, [BOT_A, BOT_B]));
});

describe("naming a repository", () => {
  test("two ordinary segments are accepted, and split", () => {
    expect(parseRepositoryId(" CopilotKit/openbot ")).toEqual({
      id: "CopilotKit/openbot",
      owner: "CopilotKit",
      name: "openbot",
    });
  });

  test("anything that would escape a path or break a rule is refused", () => {
    // This string becomes a directory under the Bot's workspace and a ref a policy matches on.
    for (const bad of [
      "../etc",
      "owner/../../etc",
      "owner",
      "owner/name/extra",
      "owner/ name",
      ".hidden/name",
      "owner/.git",
      "own er/name",
      "",
    ]) {
      expect(parseRepositoryId(bad)).toBeNull();
    }
  });
});

describe("who may reach a repository", () => {
  test("a connected repository starts with nobody on it", async () => {
    await store.connect({
      id: REPO,
      owner: REPO.split("/")[0] as string,
      name: "widgets",
      defaultBranch: "main",
    });

    const found = await store.find(REPO);
    expect(found?.defaultBranch).toBe("main");
    // Absence is the refusal, the same as every other grant in this deployment.
    expect(found?.grants).toEqual([]);
    expect(await store.accessFor(BOT_A, REPO)).toBeNull();
  });

  test("two rows fold back into one answer", async () => {
    await store.setGrants({
      repo: REPO,
      grants: [
        { agentId: BOT_A, access: "contribute" },
        { agentId: BOT_B, access: "read" },
      ],
      by: "tester",
    });

    expect(await store.accessFor(BOT_A, REPO)).toBe("contribute");
    expect(await store.accessFor(BOT_B, REPO)).toBe("read");

    const found = await store.find(REPO);
    expect(
      [...(found?.grants ?? [])].sort((a, b) =>
        a.agentId.localeCompare(b.agentId),
      ),
    ).toEqual([
      { agentId: BOT_A, access: "contribute" },
      { agentId: BOT_B, access: "read" },
    ]);
  });

  test("downgrading removes the push row rather than leaving it behind", async () => {
    await store.setGrants({
      repo: REPO,
      grants: [
        { agentId: BOT_A, access: "read" },
        { agentId: BOT_B, access: "read" },
      ],
      by: "tester",
    });

    expect(await store.accessFor(BOT_A, REPO)).toBe("read");

    // The property, checked at the row rather than through the fold: a stale `repo_push` row would
    // keep answering "contribute" the moment anything else read it directly.
    const rows = await database
      .select({ kind: pluginGrants.kind })
      .from(pluginGrants)
      .where(and(eq(pluginGrants.ref, REPO), eq(pluginGrants.agentId, BOT_A)));
    expect(rows.map((row) => row.kind).sort()).toEqual(["repo"]);
  });

  test("a Bot dropped from the set loses both rows", async () => {
    await store.setGrants({
      repo: REPO,
      grants: [{ agentId: BOT_A, access: "read" }],
      by: "tester",
    });

    expect(await store.accessFor(BOT_B, REPO)).toBeNull();
  });

  test("granting leaves a trail, like every other grant", async () => {
    const rows = await database
      .select({
        targetType: auditEvents.targetType,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, REPO));

    expect(rows.length).toBeGreaterThan(0);
    // Filed as a repository, not silently as a skill, which is what a ternary would have done.
    expect(rows.every((row) => row.targetType === "repository")).toBe(true);
  });
});
