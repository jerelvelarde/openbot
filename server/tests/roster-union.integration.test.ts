import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createBotChatStore } from "../src/bot-chats/store";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  botChats,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { MAX_ROSTER_PAGE } from "../src/roster/preview";
import { createRosterStore } from "../src/roster/query";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const identity = createThreadIdentity("test-deployment");

const rosterStore = createRosterStore(database);
const channelStore = createChannelStore(database, profileStore, identity);
const botChatStore = createBotChatStore(database, profileStore, identity);

const testPrefix = `roster-union-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdBotChatIds: string[] = [];

afterEach(async () => {
  for (const botChatId of createdBotChatIds.splice(0)) {
    await database.delete(botChats).where(eq(botChats.id, botChatId));
  }
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
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

function actorFor(id: string): AgentActor {
  return { id, role: "user" };
}

async function seedUser(): Promise<string> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Roster Test User",
  });
  createdUserIds.push(id);
  return id;
}

/**
 * A Bot with the `agent_profiles` row both stores resolve it through.
 *
 * Inserted rather than created through `profileStore.create`, because that would make the Bot private
 * to one owner and several of these tests hand the same Bot to two different people. `agents.name` is
 * what a roster row falls back to for an untitled bot chat, so it is the name a test names.
 */
async function seedProfile(name = "Expense Manager"): Promise<string> {
  const id = `${testPrefix}-agent-${randomUUID()}`;
  await database.insert(agents).values({
    id,
    name,
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

/**
 * Two kinds of conversation, one ordered list, one cursor.
 *
 * The sidebar shows channels and direct Bot chats together, so the ordering and the paging have to
 * hold across both tables at once. Two separate paged reads merged in the browser would put the sort
 * rule in a second place and page each half by its own cursor: rows would repeat, and rows would
 * disappear, depending on where the two pages happened to end.
 */
describe("the roster", () => {
  /**
   * Alternating channels and bot chats with explicit, second-apart activity, newest first.
   *
   * Explicit stamps rather than whatever the clock does: the activity time comes from this process and
   * `created_at` comes from Postgres, so conversations made in the same instant would be ordered by
   * whichever clock is marginally ahead, and a paging test would be asserting the tie-break.
   */
  async function mixedConversations(
    actor: AgentActor,
    agentId: string,
    count: number,
  ) {
    const ids: string[] = [];
    const base = Date.now();
    for (let index = 0; index < count; index += 1) {
      if (index % 2 === 0) {
        const channel = await channelStore.create(actor, [agentId]);
        createdChannelIds.push(channel.id);
        await channelStore.recordActivity(actor, channel.id, {
          text: `Channel ${index}`,
          agentId: null,
          at: new Date(base - index * 1000),
        });
        ids.push(channel.id);
      } else {
        const botChat = await botChatStore.create(actor, agentId);
        createdBotChatIds.push(botChat.id);
        await botChatStore.recordActivity(actor, botChat.id, {
          text: `Bot chat ${index}`,
          agentId: null,
          at: new Date(base - index * 1000),
        });
        ids.push(botChat.id);
      }
    }
    return ids;
  }

  /** Every conversation the cursor reaches, in the order the pages hand them over. */
  async function walk(actor: AgentActor, limit: number) {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await rosterStore.list(actor, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return seen;
  }

  test("holds both kinds in one list", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    const page = await rosterStore.list(actor);

    expect(page.items.map((item) => item.kind).sort()).toEqual([
      "bot_chat",
      "channel",
    ]);
  });

  test("names a bot chat after the Bot until somebody says something", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile("Risk Analyst");
    const botChat = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(botChat.id);

    const [item] = (await rosterStore.list(actor)).items;

    // A conversation with nothing in it has no subject to name it after.
    expect(item?.name).toBe("Risk Analyst");
  });

  test("names a bot chat after its title once there is one", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile("Risk Analyst");
    const botChat = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(botChat.id);

    await botChatStore.recordActivity(actor, botChat.id, {
      text: "What is our refund policy?",
      agentId: null,
      at: new Date(),
    });

    const [item] = (await rosterStore.list(actor)).items;
    expect(item?.name).toBe("What is our refund policy?");
  });

  test("orders both kinds by one rule", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    const now = Date.now();
    // The channel spoke more recently, so it must lead, even though the bot chat was made later.
    await botChatStore.recordActivity(actor, botChat.id, {
      text: "Earlier",
      agentId: null,
      at: new Date(now - 60_000),
    });
    await channelStore.recordActivity(actor, channel.id, {
      text: "Later",
      agentId: null,
      at: new Date(now),
    });

    const page = await rosterStore.list(actor);
    expect(page.items.map((item) => item.id)).toEqual([channel.id, botChat.id]);
  });

  test("lifts a pinned row of either kind above a more recent unpinned one", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    const now = Date.now();
    await botChatStore.recordActivity(actor, botChat.id, {
      text: "Older but pinned",
      agentId: null,
      at: new Date(now - 60_000),
    });
    await channelStore.recordActivity(actor, channel.id, {
      text: "Newer",
      agentId: null,
      at: new Date(now),
    });
    await botChatStore.setPinned(actor, botChat.id, true);

    const page = await rosterStore.list(actor);
    // A pin is 1 and no pin is 0, and the sort key descends, so pinned leads whatever its recency.
    expect(page.items.map((item) => item.id)).toEqual([botChat.id, channel.id]);
  });

  test("pages through a mixed list without repeating or skipping a row", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const expected = await mixedConversations(actor, agentId, 6);

    const seen = await walk(actor, 2);

    // One cursor over two tables. Ids are prefixed and therefore globally unique, which is what lets
    // `id` break every tie without the cursor carrying `kind`.
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });

  test("pages a mixed list with pins on it exactly once", async () => {
    /*
     * The pinned half of the same claim, and it is not covered by the test above.
     *
     * `pinned` LEADS the sort key, so it has to lead the cursor as well. A cursor that carried only
     * `(recency, id)` pages the second page by a different rule than the first was drawn by, and the
     * pinned rows are precisely the ones whose recency does not match their position: some are served
     * twice and others never at all. Every other test here pages an unpinned list, where that bug is
     * invisible.
     */
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();
    const ids = await mixedConversations(actor, agentId, 6);

    // Three pins across both kinds, so the group boundary lands inside a page rather than between two.
    await botChatStore.setPinned(actor, ids[1] as string, true);
    await channelStore.setPinned(actor, ids[2] as string, true);
    await channelStore.setPinned(actor, ids[4] as string, true);

    const seen = await walk(actor, 2);

    // Pinned first, recency within each group, whichever table a row came from.
    expect(seen).toEqual([
      ids[1] as string,
      ids[2] as string,
      ids[4] as string,
      ids[0] as string,
      ids[3] as string,
      ids[5] as string,
    ]);
    expect(new Set(seen).size).toBe(ids.length);
  });

  test("hides archived rows from active, and only archived rows from archived", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    await channelStore.setArchived(actor, channel.id, true);

    const active = await rosterStore.list(actor, { status: "active" });
    const archived = await rosterStore.list(actor, { status: "archived" });
    const all = await rosterStore.list(actor, { status: "all" });

    expect(active.items.map((item) => item.id)).toEqual([botChat.id]);
    expect(archived.items.map((item) => item.id)).toEqual([channel.id]);
    expect(all.items).toHaveLength(2);
  });

  test("keeps deleted rows out of every status", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    await channelStore.softDelete(actor, channel.id);
    await botChatStore.softDelete(actor, botChat.id);

    for (const status of ["active", "archived", "all"] as const) {
      // `all` is a filter over archive state only. It is never a way to see deleted conversations.
      expect((await rosterStore.list(actor, { status })).items).toEqual([]);
    }
  });

  test("shows nobody else's conversations", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();

    const channel = await channelStore.create(actorFor(owner), [agentId]);
    const botChat = await botChatStore.create(actorFor(owner), agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    expect((await rosterStore.list(actorFor(stranger))).items).toEqual([]);
  });

  test("keeps a channel whole when its agents outnumber the page", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const first = await seedProfile("First");
    const second = await seedProfile("Second");
    const third = await seedProfile("Third");

    const channel = await channelStore.create(actor, [first, second, third]);
    createdChannelIds.push(channel.id);

    const page = await rosterStore.list(actor, { limit: 1 });

    // The limit applies to conversations, not to hydrated rows. A limit applied to the join would
    // cut this channel up and serve its other Bots as separate entries with the same id.
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.agentIds).toHaveLength(3);
  });

  test("caps what a caller may ask for", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();
    const chat = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(chat.id);

    // Asking for everything must not be a way to read everything. The limit arrives over HTTP, so the
    // ceiling is what makes paging a property of the endpoint rather than of the caller.
    const page = await rosterStore.list(actor, { limit: 100_000 });

    expect(page.items.map((item) => item.id)).toEqual([chat.id]);
    expect(page.items.length).toBeLessThanOrEqual(MAX_ROSTER_PAGE);
  });

  test("reports a retired Bot as inactive on both kinds", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, agentId));

    const page = await rosterStore.list(actor, { status: "all" });
    // Both kinds report a retired coworker the same way: the conversation stays readable, and says so.
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.active === false)).toBe(true);
  });
});
