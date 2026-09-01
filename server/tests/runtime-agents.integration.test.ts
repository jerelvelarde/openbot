import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createBotChatStore } from "../src/bot-chats/store";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { standingRoleMessage } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import {
  agentProfiles,
  agents,
  botChats,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const managedEndpoint = new URL("https://managed.example.test/ag-ui");
const profileStore = createAgentProfileStore(database, managedEndpoint);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const botChatStore = createBotChatStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const managedAgentToken = "managed-agent-token";
const loadAgents = createRuntimeAgentLoader(database, undefined, {
  endpoint: managedEndpoint,
  token: managedAgentToken,
});

const testPrefix = `runtime-agents-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdBotChatIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  // Before the agents, which is what these rows name. `bot_chats.agent_id` cascades, so the delete
  // below would take them anyway; it is written out so a conversation this file created is never
  // left behind by a change to how agents are cleaned up.
  for (const botChatId of createdBotChatIds.splice(0)) {
    await database.delete(botChats).where(eq(botChats.id, botChatId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(role: AgentActor["role"] = "user") {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Runtime Agents Test User",
  });
  createdUserIds.push(id);
  return { id, role } satisfies AgentActor;
}

async function createCoworker(
  owner: AgentActor,
  overrides: { name?: string; visibility?: "public" | "private" } = {},
) {
  const profile = await profileStore.create(owner, {
    name: overrides.name ?? "Expense Manager",
    title: "Finance Operations",
    roleDescription:
      "Review receipts, categorize expenses, and prepare reimbursement reports.",
    visibility: overrides.visibility ?? "private",
  });
  createdAgentIds.push(profile.id);
  return profile;
}

function idsOf(loaded: Awaited<ReturnType<typeof loadAgents>>) {
  return loaded.map((agent) => agent.id);
}

/**
 * Which coworkers exist is a per-person question, answered on every request. These assertions are
 * against the database rather than a fake, because the whole point of resolving here is that the
 * filtering happens in the query and not in JavaScript after every row has already been read.
 */
describe("runtime agent loading", () => {
  test("carries the owner's coworker with its standing role and managed endpoint", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    const loaded = await loadAgents(owner);

    expect(loaded).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "remote_ag_ui",
      endpoint: managedEndpoint.toString(),
      headers: { "x-openbot-agent-token": managedAgentToken },
      standingMessage: standingRoleMessage({
        id: profile.id,
        name: "Expense Manager",
        title: "Finance Operations",
        roleDescription:
          "Review receipts, categorize expenses, and prepare reimbursement reports.",
      }),
    });
  });

  test("hides a private coworker from everybody but its owner and administrators", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const administrator = await createUser("admin");
    const profile = await createCoworker(owner);

    expect(idsOf(await loadAgents(owner))).toContain(profile.id);
    expect(idsOf(await loadAgents(otherUser))).not.toContain(profile.id);
    expect(idsOf(await loadAgents(administrator))).toContain(profile.id);
  });

  test("shares a public coworker with everybody", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const profile = await createCoworker(owner, {
      name: "Company Helper",
      visibility: "public",
    });

    expect(idsOf(await loadAgents(otherUser))).toContain(profile.id);
  });

  test("drops a deleted coworker that has no history to restore", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    await profileStore.softDelete(owner, profile.id);

    expect(idsOf(await loadAgents(owner))).not.toContain(profile.id);
  });

  test("keeps a deleted coworker as a tombstone for a channel member", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const profile = await createCoworker(owner);
    const channel = await channelStore.create(owner, [profile.id]);
    createdChannelIds.push(channel.id);

    await profileStore.softDelete(owner, profile.id);

    expect(await loadAgents(owner)).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "unavailable",
      reason:
        "Expense Manager has been deleted and can no longer run. Its conversations remain readable.",
    });
    // Somebody with no channel of their own gets no tombstone: history is what authorizes it.
    expect(idsOf(await loadAgents(otherUser))).not.toContain(profile.id);
  });

  /**
   * THE OTHER KIND OF HISTORY, which used to authorize nothing.
   *
   * The tombstone arm joined `channel_agents` to `channel_memberships` and knew nothing about
   * `bot_chats`, so a retired Bot somebody had only ever direct-messaged was registered nowhere.
   * `useAgent` throws in the browser for an id the runtime does not hold — and the packaged
   * `CopilotChat` resolves the same id the same way — so that screen fell to the error boundary,
   * taking down the "this Bot has been retired, the conversation stays readable" banner written for
   * exactly this case.
   */
  test("keeps a deleted coworker as a tombstone for somebody who only direct-messaged it", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const profile = await createCoworker(owner);
    const chat = await botChatStore.create(owner, profile.id);
    createdBotChatIds.push(chat.id);

    await profileStore.softDelete(owner, profile.id);

    expect(await loadAgents(owner)).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "unavailable",
      reason:
        "Expense Manager has been deleted and can no longer run. Its conversations remain readable.",
    });
    // No channel anywhere in this test, and somebody else's conversation is not this person's
    // history: the bot chat arm is scoped to the owner exactly as the channel arm is to a member.
    expect(idsOf(await loadAgents(otherUser))).not.toContain(profile.id);
  });

  /**
   * Archived is hidden from the roster, not from a direct read — the conversation's URL still opens
   * it. So it still needs the tombstone, and a filter on `archived_at` in the arm above would crash
   * precisely the screen archiving promises stays readable.
   */
  test("keeps the tombstone for an archived direct conversation", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);
    const chat = await botChatStore.create(owner, profile.id);
    createdBotChatIds.push(chat.id);
    await botChatStore.setArchived(owner, chat.id, true);

    await profileStore.softDelete(owner, profile.id);

    expect(idsOf(await loadAgents(owner))).toContain(profile.id);
  });

  /**
   * A deleted conversation is the opposite case, and it is why the arm filters `deleted_at`: `get`
   * refuses the row, so there is no screen left to register an agent for.
   */
  test("drops the tombstone once the only direct conversation has been deleted", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);
    const chat = await botChatStore.create(owner, profile.id);
    createdBotChatIds.push(chat.id);
    await botChatStore.softDelete(owner, chat.id);

    await profileStore.softDelete(owner, profile.id);

    expect(idsOf(await loadAgents(owner))).not.toContain(profile.id);
  });

  test("applies an edited role to the next load without a restart", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    await profileStore.update(owner, profile.id, {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Reconcile corporate card statements.",
      visibility: "private",
    });

    const reloaded = (await loadAgents(owner)).find(
      (agent) => agent.id === profile.id,
    );
    expect(
      reloaded?.type === "remote_ag_ui" && reloaded.standingMessage.content,
    ).toContain("Reconcile corporate card statements.");
  });
});
