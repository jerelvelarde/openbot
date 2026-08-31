/**
 * What a bot chat announces, and to whom.
 *
 * Its own file, next to `channel-events.integration.test.ts`, because the announcements are the half
 * of this store nothing else reaches: every other test asserts the row the write left behind, and a
 * write that lands correctly and tells nobody is a roster that stops moving until something makes it
 * refetch. Four writes announce — a message, a pin, an archive and a delete — and none of the fields
 * they carry was covered anywhere.
 *
 * Delivery goes through Postgres, so these run the round trip a second server instance would take: a
 * write announces, and a listener sharing nothing with the writer but the database hears it.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createBotChatStore } from "../src/bot-chats/store";
import {
  createChannelEventHub,
  type DeliveredRosterEvent,
  startChannelActivityListener,
} from "../src/channels/events";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, botChats, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createBotChatStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);

const testPrefix = `bot-chat-events-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdBotChatIds: string[] = [];

afterEach(async () => {
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

async function seedUser(): Promise<string> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Bot Chat Events Test User",
  });
  createdUserIds.push(id);
  return id;
}

/** A public Bot, so `getWithin` resolves it for whichever seeded person a test uses. */
async function seedProfile(): Promise<string> {
  const id = `${testPrefix}-agent-${randomUUID()}`;
  await database.insert(agents).values({
    id,
    name: "Expense Manager",
    type: "remote_ag_ui",
    configuration: { endpoint: "https://agent.example.test/ag-ui" },
  });
  await database.insert(agentProfiles).values({
    agentId: id,
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed: id,
    visibility: "public",
  });
  createdAgentIds.push(id);
  return id;
}

function actorFor(userId: string): AgentActor {
  return { id: userId, role: "user" };
}

/**
 * Run `act` with a listener attached, and return what each of two people heard.
 *
 * `expected` is how many events the owner should receive; waited for rather than slept on, so the
 * test is not a race against the round trip. A stranger is registered alongside because `memberIds`
 * is not on the wire — the hub strips it — so the only observable form of "who this was for" is who
 * got it.
 */
async function announced(
  expected: number,
  owner: string,
  stranger: string,
  act: () => Promise<void>,
) {
  const hub = createChannelEventHub();
  const heard: DeliveredRosterEvent[] = [];
  const overheard: DeliveredRosterEvent[] = [];
  let enough = () => {};
  const arrived = new Promise<void>((resolve) => {
    enough = resolve;
  });
  hub.register(owner, (payload) => {
    heard.push(JSON.parse(payload));
    if (heard.length >= expected) enough();
  });
  hub.register(stranger, (payload) => overheard.push(JSON.parse(payload)));
  const listener = await startChannelActivityListener(databaseUrl, hub);

  try {
    await act();
    await Promise.race([
      arrived,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`fewer than ${expected} events within 5s`)),
          5000,
        ),
      ),
    ]);
  } finally {
    await listener.stop();
  }

  return { heard, overheard };
}

describe("what a bot chat announces", () => {
  test("a message, to the one person whose conversation it is", async () => {
    const userId = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const at = new Date();
    const { heard, overheard } = await announced(1, userId, stranger, () =>
      store
        .recordActivity(actorFor(userId), chat.id, {
          text: "What is our refund policy?",
          agentId: null,
          at,
        })
        .then(() => undefined),
    );

    expect(heard).toHaveLength(1);
    expect(heard[0]).toEqual({
      // The browser needs the kind to render the row, and a bot chat is not a channel.
      kind: "bot_chat",
      id: chat.id,
      lastMessage: "What is our refund policy?",
      lastMessageAt: at.toISOString(),
      lastMessageAgentId: null,
    });
    /*
     * No `channelId`, because there is no channel. A browser tab still running the previous bundle
     * finds no such row in its channels list and refetches, which is the harmless path a stale roster
     * already takes.
     *
     * No `archived`, because this message restored nothing: an ordinary message must not carry an
     * archive state the receiver then has to decide to ignore.
     */
    expect(Object.keys(heard[0] ?? {})).not.toContain("channelId");
    /*
     * A bot chat has exactly one interested party, and `memberIds` is how the writer says so. It is
     * an instruction to the hub and stops there, so the assertion is on both halves: it is not on the
     * wire, and it routed to the one person it named.
     */
    expect(Object.keys(heard[0] ?? {})).not.toContain("memberIds");
    expect(overheard).toEqual([]);
  });

  test("a restore, on the message that caused it", async () => {
    const userId = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);
    await store.setArchived(actorFor(userId), chat.id, true);

    const { heard, overheard } = await announced(1, userId, stranger, () =>
      store
        .recordActivity(actorFor(userId), chat.id, {
          text: "One more thing",
          agentId: null,
          at: new Date(),
        })
        .then(() => undefined),
    );

    /*
     * The field the browser needs to un-hide the row live. Archiving is a move between three cached
     * lists rather than a field change, so the client answers `archived` with a refetch — and without
     * this flag on the event, a conversation restored by somebody speaking in it stayed hidden in
     * every tab until an unrelated refetch. Saying something in an archived conversation is how it
     * comes back, so this is the one path that must not be lossy.
     */
    expect(heard[0]).toMatchObject({
      kind: "bot_chat",
      id: chat.id,
      archived: false,
      lastMessage: "One more thing",
    });
    expect(overheard).toEqual([]);
  });

  test("a pin, with no message to overwrite the row's preview", async () => {
    const userId = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const { heard, overheard } = await announced(2, userId, stranger, () =>
      store
        .setPinned(actorFor(userId), chat.id, true)
        .then(() => store.setPinned(actorFor(userId), chat.id, false)),
    );

    // Both ways round, because a pin event carries the state it reached rather than the fact that
    // something happened, and the client patches that one field from it.
    expect(heard.map((event) => event.pinned)).toEqual([true, false]);
    expect(heard[0]).toMatchObject({
      kind: "bot_chat",
      id: chat.id,
      // Null, and the client's pin branch is what keeps it from being spread over the row: an event
      // that carried no preview must not wipe the preview the roster is rendering.
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
    });
    expect(overheard).toEqual([]);
  });

  test("an archive, and the restore that undoes it", async () => {
    const userId = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const { heard, overheard } = await announced(
      2,
      userId,
      stranger,
      async () => {
        await store.setArchived(actorFor(userId), chat.id, true);
        // A repeat of the first, which the store reports as no change: it must announce nothing, or
        // every tab refetches the whole roster for an archiving that already happened.
        await store.setArchived(actorFor(userId), chat.id, true);
        await store.setArchived(actorFor(userId), chat.id, false);
      },
    );

    expect(heard.map((event) => event.archived)).toEqual([true, false]);
    expect(heard[0]).toMatchObject({ kind: "bot_chat", id: chat.id });
    expect(overheard).toEqual([]);
  });

  test("a delete, to the owner who asked for it", async () => {
    const userId = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const { heard, overheard } = await announced(1, userId, stranger, () =>
      store.softDelete(actorFor(userId), chat.id),
    );

    /*
     * Told even though they asked for it, because they may have several tabs and several replicas
     * open: without this the others keep rendering a row whose conversation no longer resolves.
     *
     * `deleted` is what makes the client remove the row rather than patch it — the field is checked
     * before the spread that would otherwise stamp `deleted: true` onto a row it left in place.
     */
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      kind: "bot_chat",
      id: chat.id,
      deleted: true,
    });
    expect(overheard).toEqual([]);
  });
});
