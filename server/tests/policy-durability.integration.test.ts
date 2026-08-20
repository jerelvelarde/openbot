import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import { actionPolicy } from "../src/db/schema";

/**
 * The boundary has to survive a restart.
 *
 * A policy held only in memory means a rule an administrator adds is gone the next time the process
 * comes up, and nothing says so. The persisted row is the contract that keeps the boundary active
 * across process replacement.
 *
 * A restart is simulated by building a second store, which is what a restart is from this module's
 * point of view: a fresh process, the same configured default, the same database. Asserting through
 * one store would only prove it remembers what it was told a moment ago.
 *
 * It uses its OWN row, not `current`. Locally `DATABASE_URL` is the database a running deployment is
 * using, and this file both writes and deletes the row it works on — so on `current` it would remove
 * the boundary that deployment is enforcing, and the next restart would come up permissive with
 * nothing in the trail saying the rule had stopped applying. Which is the failure this very file
 * exists to prove cannot happen.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const ROW = "test-policy-durability";
const configured = DEFAULT_ACTION_POLICY;
const rule = 'intent == "activate" && contains(element.name, "submit")';

afterEach(async () => {
  await database.delete(actionPolicy).where(eq(actionPolicy.id, ROW));
});

describe("a boundary set while running", () => {
  test("is still there after a restart", async () => {
    const before = createPolicyStore(configured, database, ROW);
    await before.load();
    await before.set(
      { mode: "enforce", deny: [rule], allow: ["true"] },
      "admin@example.test",
    );

    const after = createPolicyStore(configured, database, ROW);
    expect(await after.load()).toBe("the database");
    expect(after.get().deny).toEqual([rule]);
  });

  test("a deployment that never set one gets its configured default", async () => {
    const store = createPolicyStore(configured, database, ROW);
    expect(await store.load()).toBe("configuration");
    expect(store.get()).toEqual(configured);
  });

  test("resetting forgets it, so a restart returns to configuration", async () => {
    const store = createPolicyStore(configured, database, ROW);
    await store.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    await store.reset();

    // The saved row is removed rather than overwritten, so changing what configuration says then
    // changes what is enforced, which is what an operator expects a reset to mean.
    const after = createPolicyStore(configured, database, ROW);
    expect(await after.load()).toBe("configuration");
    expect(after.get().deny).toEqual([]);
  });

  test("setting twice keeps one row and the latest rule", async () => {
    const store = createPolicyStore(configured, database, ROW);
    await store.set({ mode: "enforce", deny: ["first"], allow: ["true"] });
    await store.set({ mode: "dry-run", deny: ["second"], allow: ["true"] });

    // Scoped to this test's own row. Selecting the whole table would also see the boundary a
    // deployment on this machine is enforcing, which is the coupling this file exists to avoid.
    const rows = await database
      .select()
      .from(actionPolicy)
      .where(eq(actionPolicy.id, ROW));
    // One row per boundary, by construction: the write is an upsert on the id. Two would mean
    // something has to choose which one is in force.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mode).toBe("dry-run");
    expect(rows[0]?.deny).toEqual(["second"]);
  });

  test("records who changed it", async () => {
    const store = createPolicyStore(configured, database, ROW);
    await store.set(
      { mode: "enforce", deny: [rule], allow: ["true"] },
      "admin@example.test",
    );

    const [row] = await database
      .select()
      .from(actionPolicy)
      .where(eq(actionPolicy.id, ROW));
    expect(row?.updatedBy).toBe("admin@example.test");
  });

  test("without a database it still works, in memory", async () => {
    // A test about the decision logic must not need Postgres, and a deployment with no database has
    // bigger problems than an unsaved rule.
    const store = createPolicyStore(configured);
    expect(await store.load()).toBe("configuration");
    await store.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    expect(store.get().deny).toEqual([rule]);
    await store.reset();
    expect(store.get()).toEqual(configured);
  });
});

describe("the row a store works on", () => {
  test("two stores on different rows do not see each other", async () => {
    const other = `${ROW}-other`;
    const mine = createPolicyStore(configured, database, ROW);
    const theirs = createPolicyStore(configured, database, other);

    await mine.set({ mode: "enforce", deny: [rule], allow: ["true"] });
    await theirs.reset();

    // The property that matters locally: something sharing a deployment's database can write and
    // delete its own boundary without touching the one that deployment is enforcing.
    const reloaded = createPolicyStore(configured, database, ROW);
    expect(await reloaded.load()).toBe("the database");
    expect(reloaded.get().deny).toEqual([rule]);

    await database.delete(actionPolicy).where(eq(actionPolicy.id, other));
  });
});
