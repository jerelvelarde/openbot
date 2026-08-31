import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, botChats, channels, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const prefix = `bot-chat-schema-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];

afterEach(async () => {
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
  for (const id of createdAgentIds.splice(0)) {
    await database.delete(agents).where(eq(agents.id, id));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function seedUser() {
  const id = `${prefix}-user-${createdUserIds.length}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@openbot.test`, name: "Member" });
  createdUserIds.push(id);
  return id;
}

async function seedAgent() {
  const id = `${prefix}-agent-${createdAgentIds.length}`;
  await database
    .insert(agents)
    .values({ id, name: "Bot", type: "built_in", configuration: {} });
  createdAgentIds.push(id);
  return id;
}

describe("the bot_chats table", () => {
  test("holds a chat with nulls for everything not yet said", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const id = `botchat_${randomUUID()}`;

    await database
      .insert(botChats)
      .values({ id, userId, agentId, threadId: randomUUID() });

    const [row] = await database
      .select()
      .from(botChats)
      .where(eq(botChats.id, id));

    expect(row?.title).toBeNull();
    expect(row?.archivedAt).toBeNull();
    expect(row?.deletedAt).toBeNull();
    expect(row?.pinnedAt).toBeNull();
    expect(row?.lastReadAt).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  test("refuses two chats claiming one thread", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const threadId = randomUUID();

    await database
      .insert(botChats)
      .values({ id: `botchat_${randomUUID()}`, userId, agentId, threadId });

    // The constraint is what decides an adoption race, so it is asserted rather than assumed.
    await expect(
      Promise.resolve(
        database
          .insert(botChats)
          .values({ id: `botchat_${randomUUID()}`, userId, agentId, threadId }),
      ),
    ).rejects.toThrow();
  });

  test("keeps several chats with one Bot", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();

    for (let index = 0; index < 3; index += 1) {
      await database.insert(botChats).values({
        id: `botchat_${randomUUID()}`,
        userId,
        agentId,
        threadId: randomUUID(),
      });
    }

    const rows = await database
      .select({ id: botChats.id })
      .from(botChats)
      .where(eq(botChats.userId, userId));

    expect(rows).toHaveLength(3);
  });

  test("removes a person's chats with them", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    await database.insert(botChats).values({
      id: `botchat_${randomUUID()}`,
      userId,
      agentId,
      threadId: randomUUID(),
    });

    await database.delete(users).where(eq(users.id, userId));
    createdUserIds.splice(createdUserIds.indexOf(userId), 1);

    const rows = await database
      .select({ id: botChats.id })
      .from(botChats)
      .where(eq(botChats.userId, userId));

    expect(rows).toEqual([]);
  });
});

describe("the channels table", () => {
  test("archives without deleting", async () => {
    const id = `channel_${randomUUID()}`;
    await database
      .insert(channels)
      .values({ id, name: "Channel", description: "Test channel." });

    const archivedAt = new Date();
    await database
      .update(channels)
      .set({ archivedAt })
      .where(eq(channels.id, id));

    const [row] = await database
      .select({
        archivedAt: channels.archivedAt,
        deletedAt: channels.deletedAt,
      })
      .from(channels)
      .where(eq(channels.id, id));

    expect(row?.archivedAt).toEqual(archivedAt);
    // Archiving is not deleting, and the two columns must be independently readable.
    expect(row?.deletedAt).toBeNull();

    await database.delete(channels).where(eq(channels.id, id));
  });
});
