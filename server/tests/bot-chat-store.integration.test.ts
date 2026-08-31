import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  AgentNotFoundError,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  BotChatNotFoundError,
  BotChatThreadTakenError,
  createBotChatStore,
} from "../src/bot-chats/store";
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

const testPrefix = `bot-chat-store-${randomUUID()}`;
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
    name: "Bot Chat Store Test User",
  });
  createdUserIds.push(id);
  return id;
}

/**
 * A Bot with the `agent_profiles` row `create` resolves it through.
 *
 * Inserted rather than created through `profileStore.create`, because that would need an owning
 * actor and would make the agent private to them. Public, so `getWithin` resolves it for whichever
 * seeded person a test uses — several of these tests hand the same Bot to two different people.
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

function actorFor(userId: string): AgentActor {
  return { id: userId, role: "user" };
}

describe("creating a bot chat", () => {
  test("mints a thread this deployment can recognise as its own", async () => {
    const identity = createThreadIdentity("test-deployment");
    const userId = await seedUser();
    const agentId = await seedProfile();

    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    expect(chat.id.startsWith("botchat_")).toBe(true);
    // Prefixed ids are what let one roster cursor page a mixed list, so the prefix is asserted.
    expect(identity.owns(chat.threadId)).toBe(true);
    expect(chat.title).toBeNull();
    expect(chat.archived).toBe(false);
    expect(chat.active).toBe(true);
  });

  test("gives every chat its own thread", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();

    const first = await store.create(actorFor(userId), agentId);
    const second = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(first.id, second.id);

    expect(first.threadId).not.toBe(second.threadId);
  });

  test("refuses a Bot the caller cannot see", async () => {
    const userId = await seedUser();

    await expect(
      store.create(actorFor(userId), "no-such-agent"),
    ).rejects.toThrow(AgentNotFoundError);
  });
});

describe("adopting a remembered thread", () => {
  test("takes a thread the browser already had", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const threadId = randomUUID();

    const chat = await store.adopt(actorFor(userId), agentId, threadId);
    createdBotChatIds.push(chat.id);

    expect(chat.threadId).toBe(threadId);
  });

  test("is idempotent for the person who owns it", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const threadId = randomUUID();

    const first = await store.adopt(actorFor(userId), agentId, threadId);
    const second = await store.adopt(actorFor(userId), agentId, threadId);
    createdBotChatIds.push(first.id);

    expect(second.id).toBe(first.id);
  });

  test("gives one row to two adoptions that race", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const threadId = randomUUID();

    /*
     * Started together, not one after the other, which is the case the constraint exists for.
     * Sequentially, the second call finds the first's row and returns it — that is the test above, and
     * it passes even against a naive read-then-write. Concurrently, both find nothing and both insert,
     * and only the unique index stops one conversation becoming two rows pointing at one transcript.
     */
    const [first, second] = await Promise.all([
      store.adopt(actorFor(userId), agentId, threadId),
      store.adopt(actorFor(userId), agentId, threadId),
    ]);
    createdBotChatIds.push(first.id);

    expect(second.id).toBe(first.id);

    const rows = await database
      .select({ id: botChats.id })
      .from(botChats)
      .where(eq(botChats.threadId, threadId));
    expect(rows).toHaveLength(1);
  });

  test("refuses a thread that belongs to somebody else", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const threadId = randomUUID();

    const chat = await store.adopt(actorFor(owner), agentId, threadId);
    createdBotChatIds.push(chat.id);

    await expect(
      store.adopt(actorFor(stranger), agentId, threadId),
    ).rejects.toThrow(BotChatThreadTakenError);
  });
});

describe("reading a bot chat", () => {
  test("answers null for somebody else's", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(owner), agentId);
    createdBotChatIds.push(chat.id);

    // Null rather than a refusal, so the route answers 404 and ownership is not probeable.
    expect(await store.get(actorFor(stranger), chat.id)).toBeNull();
  });

  test("answers null for a deleted one", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.softDelete(actorFor(userId), chat.id);

    expect(await store.get(actorFor(userId), chat.id)).toBeNull();
  });

  test("reads an archived one, because archived is hidden and not gone", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);

    const read = await store.get(actorFor(userId), chat.id);
    expect(read?.archived).toBe(true);
  });

  test("reports a retired Bot as inactive rather than hiding the conversation", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, agentId));

    const read = await store.get(actorFor(userId), chat.id);
    // A Bot is retired by soft-deleting its profile, so the transcript must stay readable.
    expect(read?.active).toBe(false);
  });
});

describe("mostRecent", () => {
  test("finds the newest non-archived chat for a Bot", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const older = await store.create(actorFor(userId), agentId);
    const newer = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(older.id, newer.id);

    await store.recordActivity(actorFor(userId), newer.id, {
      text: "Most recent",
      agentId: null,
      at: new Date(),
    });

    expect((await store.mostRecent(actorFor(userId), agentId))?.id).toBe(
      newer.id,
    );
  });

  test("skips archived chats, so ?agent= does not reopen something put away", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);

    expect(await store.mostRecent(actorFor(userId), agentId)).toBeNull();
  });
});

describe("recording activity", () => {
  test("titles the chat from the first thing the person said", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.recordActivity(actorFor(userId), chat.id, {
      text: "What is our refund policy?",
      agentId: null,
      at: new Date(),
    });

    expect((await store.get(actorFor(userId), chat.id))?.title).toBe(
      "What is our refund policy?",
    );
  });

  test("does not title it from the Bot's opening message", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Hello, how can I help?",
      agentId,
      at: new Date(),
    });

    // The same greeting opens every chat, so titling from it makes every row identical.
    expect((await store.get(actorFor(userId), chat.id))?.title).toBeNull();
  });

  test("keeps the first title when more is said", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const at = new Date();
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "First question",
      agentId: null,
      at,
    });
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Second question",
      agentId: null,
      at: new Date(at.getTime() + 1000),
    });

    expect((await store.get(actorFor(userId), chat.id))?.title).toBe(
      "First question",
    );
  });

  test("only ever moves the last message forwards", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const now = new Date();
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Recent",
      agentId: null,
      at: now,
    });
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Older",
      agentId: null,
      at: new Date(now.getTime() - 60_000),
    });

    const [row] = await database
      .select({ lastMessage: botChats.lastMessage })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // A person's message and the Bot's reply are reported separately and can arrive out of order.
    expect(row?.lastMessage).toBe("Recent");
  });

  test("restores an archived chat", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "One more thing",
      agentId: null,
      at: new Date(),
    });

    expect((await store.get(actorFor(userId), chat.id))?.archived).toBe(false);
  });

  test("does not let a stale report restore an archived chat", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const now = new Date();
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Recent",
      agentId: null,
      at: now,
    });
    await store.setArchived(actorFor(userId), chat.id, true);
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Older",
      agentId: null,
      at: new Date(now.getTime() - 60_000),
    });

    /*
     * The moves-forwards-only guard is what carries this. Saying something in an archived
     * conversation restores it, so a report that arrives late — a reply the client only got round to
     * announcing after the person put the conversation away — would otherwise pull it back onto the
     * roster, and the archive would have been undone by nothing anybody did.
     */
    expect((await store.get(actorFor(userId), chat.id))?.archived).toBe(true);
  });

  test("refuses an agent id that is not this chat's Bot", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const otherAgentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await expect(
      store.recordActivity(actorFor(userId), chat.id, {
        text: "Not from this Bot",
        agentId: otherAgentId,
        at: new Date(),
      }),
    ).rejects.toThrow(AgentNotFoundError);
  });

  test("refuses somebody else's chat", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(owner), agentId);
    createdBotChatIds.push(chat.id);

    await expect(
      store.recordActivity(actorFor(stranger), chat.id, {
        text: "Not mine",
        agentId: null,
        at: new Date(),
      }),
    ).rejects.toThrow(BotChatNotFoundError);
  });
});

/**
 * The two methods that write only the caller's own state.
 *
 * Not in the plan's list, and added because nothing else runs them: `markRead` is hand-written SQL,
 * and a `greatest(...)` expression that has never executed is a statement nobody has checked
 * PostgreSQL accepts. Both also stand as the assertion that neither method consults `archived_at`.
 */
describe("the caller's own state", () => {
  test("marks read no earlier than the last message, whatever this clock says", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    // An hour ahead, because `at` comes from the reporting browser's clock and nothing bounds it.
    const ahead = new Date(Date.now() + 3_600_000);
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "From a fast clock",
      agentId: null,
      at: ahead,
    });
    await store.markRead(actorFor(userId), chat.id);

    const [row] = await database
      .select({ lastReadAt: botChats.lastReadAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // A marker stamped plainly "now" by a server running behind that clock would leave the row
    // reading as unseen, re-lighting the dot on every refetch until wall clock catches up.
    expect(row?.lastReadAt?.getTime()).toBeGreaterThanOrEqual(ahead.getTime());
  });

  test("pins an archived chat, because archived is hidden and not frozen", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);
    await store.setPinned(actorFor(userId), chat.id, true);

    const [pinned] = await database
      .select({ pinnedAt: botChats.pinnedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    expect(pinned?.pinnedAt).not.toBeNull();

    await store.setPinned(actorFor(userId), chat.id, false);

    const [unpinned] = await database
      .select({ pinnedAt: botChats.pinnedAt, archivedAt: botChats.archivedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    expect(unpinned?.pinnedAt).toBeNull();
    // And neither call touched the archive. Only the roster query reads `archived_at`.
    expect(unpinned?.archivedAt).not.toBeNull();
  });
});

describe("archiving a bot chat", () => {
  test("is a no-op the second time", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);
    const [first] = await database
      .select({ archivedAt: botChats.archivedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));

    await store.setArchived(actorFor(userId), chat.id, true);
    const [second] = await database
      .select({ archivedAt: botChats.archivedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));

    // A repeat call must not restamp, or the row's archive time drifts on every click.
    expect(second?.archivedAt).toEqual(first?.archivedAt);
  });

  test("refuses a deleted chat", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.softDelete(actorFor(userId), chat.id);

    await expect(
      store.setArchived(actorFor(userId), chat.id, true),
    ).rejects.toThrow(BotChatNotFoundError);
  });
});
