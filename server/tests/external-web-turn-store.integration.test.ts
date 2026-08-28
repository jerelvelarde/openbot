import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  externalThreadConversationRefs,
  users,
} from "../src/db/schema";
import { createExternalThreadStore } from "../src/external/thread-store";
import { createExternalWebTurnStore } from "../src/external/web-turn-store";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createExternalWebTurnStore(database);
const suite = randomUUID().slice(0, 8);
const creatorId = `web_turn_creator_${suite}`;
const agentId = `web_turn_agent_${suite}`;
const writableThreadId = `channels_web_turn_writable_${suite}`;
const readOnlyThreadId = `channels_web_turn_readonly_${suite}`;

async function bind(channelsThreadId: string, label: string): Promise<void> {
  await createExternalThreadStore(database).bind({
    channelsThreadId,
    provider: "slack",
    providerTenantId: `T${suite}`,
    providerConversationId: `C${label}_${suite}`,
    providerThreadId: `P${label}_${suite}`,
    agentId,
    agentName: "Risk Analyst",
    createdByUserId: creatorId,
  });
}

beforeAll(async () => {
  await database
    .insert(users)
    .values([{ id: creatorId, email: `${creatorId}@example.test` }]);
  await database.insert(agents).values([
    {
      id: agentId,
      name: "Risk Analyst",
      type: "remote_ag_ui",
      configuration: {},
    },
  ]);
  await bind(writableThreadId, "writable");
  await bind(readOnlyThreadId, "readonly");
  await database.insert(externalThreadConversationRefs).values({
    channelsThreadId: writableThreadId,
    conversationRef: `cref_v1_${suite}`,
  });
});

afterAll(async () => {
  /* Bindings are append-only in production; a fixture is removed only with the user trigger
   * temporarily disabled, matching external-thread-store.integration.test.ts. */
  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`ALTER TABLE "external_thread_bindings" DISABLE TRIGGER USER`,
    );
    await transaction.execute(sql`
      DELETE FROM "external_thread_bindings"
      WHERE "created_by_user_id" = ${creatorId}
    `);
    await transaction.execute(
      sql`ALTER TABLE "external_thread_bindings" ENABLE TRIGGER USER`,
    );
  });
  await database.delete(agents).where(eq(agents.id, agentId));
  await database.delete(users).where(eq(users.id, creatorId));
  await database.$client.end();
});

test("reports the capability only for a thread holding a reference", async () => {
  expect(await store.conversationRef(writableThreadId)).toBe(
    `cref_v1_${suite}`,
  );
  // The live production state for every thread: no reference, so read-only.
  expect(await store.conversationRef(readOnlyThreadId)).toBeNull();

  expect(
    await store.threadsWithConversationRef([
      writableThreadId,
      readOnlyThreadId,
    ]),
  ).toEqual(new Set([writableThreadId]));
  // An empty page must not build `in ()`, which is a syntax error.
  expect(await store.threadsWithConversationRef([])).toEqual(new Set());
});

test("claims one operation per idempotency key and replays it on retry", async () => {
  const first = await store.claim({
    channelsThreadId: writableThreadId,
    idempotencyKey: "turn-a",
    authorUserId: creatorId,
  });
  expect(first.kind).toBe("claimed");

  const retry = await store.claim({
    channelsThreadId: writableThreadId,
    idempotencyKey: "turn-a",
    authorUserId: creatorId,
  });
  expect(retry).toEqual({
    kind: "duplicate",
    operationId: first.operationId,
    status: "accepted",
    failureCategory: null,
  });

  // A different key is a different turn, so it must claim rather than replay.
  const second = await store.claim({
    channelsThreadId: writableThreadId,
    idempotencyKey: "turn-b",
    authorUserId: creatorId,
  });
  expect(second.kind).toBe("claimed");
  expect(second.operationId).not.toBe(first.operationId);
});

test("lets exactly one concurrent submission of a key win", async () => {
  // The real race: a double tap where both requests reach the database before
  // either has committed. Separate pools so they are genuinely concurrent
  // rather than serialised on one connection.
  const left = createDatabase(databaseUrl, { max: 1 });
  const right = createDatabase(databaseUrl, { max: 1 });
  try {
    const results = await Promise.all([
      createExternalWebTurnStore(left).claim({
        channelsThreadId: writableThreadId,
        idempotencyKey: "turn-race",
        authorUserId: creatorId,
      }),
      createExternalWebTurnStore(right).claim({
        channelsThreadId: writableThreadId,
        idempotencyKey: "turn-race",
        authorUserId: creatorId,
      }),
    ]);

    // One claim, one replay — never two claims, which would be two Slack
    // messages and two agent runs for one thing the person typed once.
    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(
      1,
    );
    expect(
      results.filter((result) => result.kind === "duplicate"),
    ).toHaveLength(1);
    expect(new Set(results.map((result) => result.operationId)).size).toBe(1);
  } finally {
    await left.$client.end();
    await right.$client.end();
  }
});
