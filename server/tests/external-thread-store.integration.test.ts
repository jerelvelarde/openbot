import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema";
import {
  createExternalThreadStore,
  type ExternalThreadBindingInput,
} from "../src/external/thread-store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createExternalThreadStore(database);
const suite = randomUUID().slice(0, 8);
const creatorId = `external_thread_creator_${suite}`;
const riskAgentId = `external_thread_risk_${suite}`;
const knowledgeAgentId = `external_thread_knowledge_${suite}`;

function binding(
  label: string,
  overrides: Partial<ExternalThreadBindingInput> = {},
): ExternalThreadBindingInput {
  return {
    channelsThreadId: `channels_${label}_${suite}`,
    provider: "slack",
    providerTenantId: `T${suite}`,
    providerConversationId: `C${label}_${suite}`,
    providerThreadId: `P${label}_${suite}`,
    agentId: riskAgentId,
    agentName: "Risk Analyst",
    createdByUserId: creatorId,
    ...overrides,
  };
}

function expectAssignedToRisk(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) {
    expect(error.message).toBe(
      "This Slack thread is already assigned to Risk Analyst.",
    );
  }
}

beforeAll(async () => {
  await database.insert(users).values({
    id: creatorId,
    email: `${creatorId}@example.test`,
  });
  await database.insert(agents).values([
    {
      id: riskAgentId,
      name: "Risk Analyst",
      type: "remote_ag_ui",
      configuration: {},
    },
    {
      id: knowledgeAgentId,
      name: "Knowledge Analyst",
      type: "remote_ag_ui",
      configuration: {},
    },
  ]);
});

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM "external_thread_bindings" WHERE "created_by_user_id" = ${creatorId}`,
  );
  await database.delete(agents).where(eq(agents.id, riskAgentId));
  await database.delete(agents).where(eq(agents.id, knowledgeAgentId));
  await database.delete(users).where(eq(users.id, creatorId));
  await database.$client.end();
});

describe("external thread bindings", () => {
  test("binds and reloads a canonical Channels thread id", async () => {
    const input = binding("canonical");
    const bound = await store.bind(input);

    await expect(
      store.getByChannelsThreadId(input.channelsThreadId),
    ).resolves.toEqual(bound);
  });

  test("reloads a binding by its provider thread identity", async () => {
    const input = binding("provider_lookup");
    const bound = await store.bind(input);

    await expect(
      store.getByProviderThread({
        provider: input.provider,
        providerTenantId: input.providerTenantId,
        providerConversationId: input.providerConversationId,
        providerThreadId: input.providerThreadId,
      }),
    ).resolves.toEqual(bound);
  });

  test("makes the same binding idempotent", async () => {
    const input = binding("idempotent");
    const bound = await store.bind(input);

    await expect(store.bind(input)).resolves.toEqual(bound);
  });

  test("never switches an established thread to another agent", async () => {
    const input = binding("agent_immutable");
    await store.bind(input);

    const error = await store
      .bind({
        ...input,
        agentId: knowledgeAgentId,
        agentName: "Knowledge Analyst",
      })
      .catch((reason: unknown) => reason);

    expectAssignedToRisk(error);
  });

  test("does not let a provider thread create a second canonical binding", async () => {
    const input = binding("provider_unique");
    const first = await store.bind(input);

    const error = await store
      .bind({
        ...input,
        channelsThreadId: `channels_provider_unique_other_${suite}`,
        agentId: knowledgeAgentId,
        agentName: "Knowledge Analyst",
      })
      .catch((reason: unknown) => reason);

    expectAssignedToRisk(error);
    await expect(
      store.getByProviderThread({
        provider: input.provider,
        providerTenantId: input.providerTenantId,
        providerConversationId: input.providerConversationId,
        providerThreadId: input.providerThreadId,
      }),
    ).resolves.toEqual(first);
  });

  test("does not let a canonical thread replace its provider identity", async () => {
    const input = binding("channels_unique");
    const first = await store.bind(input);

    const error = await store
      .bind({
        ...input,
        providerConversationId: `Cchannels_unique_other_${suite}`,
        providerThreadId: `Pchannels_unique_other_${suite}`,
        agentId: knowledgeAgentId,
        agentName: "Knowledge Analyst",
      })
      .catch((reason: unknown) => reason);

    expectAssignedToRisk(error);
    await expect(
      store.getByChannelsThreadId(input.channelsThreadId),
    ).resolves.toEqual(first);
  });

  test("keeps the winner when first deliveries race", async () => {
    const input = binding("agent_race");
    const [left, right] = await Promise.all([
      store.bind(input),
      store.bind({
        ...input,
        agentId: knowledgeAgentId,
        agentName: "Knowledge Analyst",
      }),
    ]);

    expect(left.agentId).toBe(right.agentId);
    expect([riskAgentId, knowledgeAgentId]).toContain(left.agentId);
  });

  test("converges concurrent provider identity conflicts on one durable binding", async () => {
    const input = binding("provider_race");
    const [left, right] = await Promise.all([
      store.bind(input),
      store.bind({
        ...input,
        channelsThreadId: `channels_provider_race_other_${suite}`,
      }),
    ]);

    expect(left).toEqual(right);
  });

  test("converges concurrent canonical identity conflicts on one durable binding", async () => {
    const input = binding("canonical_race");
    const [left, right] = await Promise.all([
      store.bind(input),
      store.bind({
        ...input,
        providerConversationId: `Ccanonical_race_other_${suite}`,
        providerThreadId: `Pcanonical_race_other_${suite}`,
      }),
    ]);

    expect(left).toEqual(right);
  });

  test("returns the current agent profile name rather than a duplicate binding name", async () => {
    const input = binding("current_name");
    await store.bind(input);
    await database
      .update(agents)
      .set({ name: "Renamed Risk Analyst" })
      .where(eq(agents.id, riskAgentId));

    await expect(
      store.getByChannelsThreadId(input.channelsThreadId),
    ).resolves.toMatchObject({ agentName: "Renamed Risk Analyst" });

    await database
      .update(agents)
      .set({ name: "Risk Analyst" })
      .where(eq(agents.id, riskAgentId));
  });

  test("restricts deletion of the binding's agent and creator", async () => {
    const input = binding("restrict");
    await store.bind(input);

    await expect(
      Promise.resolve(
        database.delete(agents).where(eq(agents.id, riskAgentId)),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(database.delete(users).where(eq(users.id, creatorId))),
    ).rejects.toThrow();
  });
});
