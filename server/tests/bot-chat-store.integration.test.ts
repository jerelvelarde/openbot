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
import {
  agentProfiles,
  agents,
  botChats,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
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
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const botChatId of createdBotChatIds.splice(0)) {
    await database.delete(botChats).where(eq(botChats.id, botChatId));
  }
  // Before the users below, and it takes the thread mapping with it: the mapping row cascades from
  // both `channels` and `users`, and leaving it behind would leave a thread id claimed for the rest
  // of the run.
  for (const channelId of createdChannelIds.splice(0)) {
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

/**
 * A Bot with no `agent_profiles` row at all, which is not the same thing as a retired one.
 *
 * Retirement soft-deletes the profile and leaves the row behind; this is the absence of the row. The
 * two used to be indistinguishable to a caller, because both left the joined `deleted_at` null, and
 * that is the confusion these seeds exist to tell apart.
 */
async function seedAgentWithoutProfile(): Promise<string> {
  const id = `${testPrefix}-agent-${randomUUID()}`;
  await database.insert(agents).values({
    id,
    name: "Bot With No Profile",
    type: "remote_ag_ui",
    configuration: { endpoint: "https://agent.example.test/ag-ui" },
  });
  createdAgentIds.push(id);
  return id;
}

/**
 * A channel that already holds a thread, and the thread id it holds.
 *
 * Inserted rather than created through `createChannelStore`, so this file does not take a dependency
 * on the channel store to state a fact about `bot_chats`. What matters is the pair of rows: a channel
 * and its `intelligence_channel_mappings` row, which is where a channel's thread id lives and where
 * the unique index that guards it is declared.
 */
async function seedChannelThread(userId: string): Promise<string> {
  const id = `channel_${randomUUID()}`;
  const threadId = randomUUID();
  await database.insert(channels).values({
    id,
    name: "Expense Manager",
    description: "Private agent channel.",
  });
  await database
    .insert(intelligenceChannelMappings)
    .values({ userId, channelId: id, threadId });
  createdChannelIds.push(id);
  return threadId;
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

  test("refuses a Bot that has been retired", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, agentId));

    /*
     * The interesting path through `getWithin`, as opposed to a name that was never a Bot: the
     * `agents` row is still there and the foreign key would accept it, so what refuses this is the
     * profile filter and nothing else.
     *
     * It has to refuse. A retired Bot's existing conversations stay readable and report `active`
     * false, which is what keeps a retirement from taking a transcript with it — but a new
     * conversation with a coworker who has been retired is one nobody can ever get an answer in.
     */
    await expect(store.create(actorFor(userId), agentId)).rejects.toThrow(
      AgentNotFoundError,
    );

    const rows = await database
      .select({ id: botChats.id })
      .from(botChats)
      .where(eq(botChats.agentId, agentId));
    expect(rows).toEqual([]);
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
     *
     * That depends on the two calls actually reaching their inserts concurrently rather than
     * serializing earlier. `adopt` locks the agent's profile row with `profileStore.getWithin`, which
     * takes `SELECT ... FOR SHARE` — and share locks do not exclude each other, so both adopters pass
     * that point together. If that lock ever became `FOR UPDATE`, the second adopter would block until
     * the first committed and then still reach the insert — `adopt` reads nothing before it — but that
     * insert would conflict against an already-committed row instead of a concurrent one. This test
     * would stay green while no longer distinguishing insert-first from a naive read-then-write, which
     * is the only thing it exists to prove.
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

  test("refuses a thread that is the caller's own conversation with a different Bot", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const otherAgentId = await seedProfile("Travel Desk");
    const threadId = randomUUID();

    const chat = await store.adopt(actorFor(userId), agentId, threadId);
    createdBotChatIds.push(chat.id);

    /*
     * The caller's own live row, on the thread they named, but with the wrong Bot. Handing it back
     * would answer a request about one Bot with a conversation belonging to another — and a `BotChat`
     * this call returns is one the client navigates straight to, so the person would land in a
     * transcript with a coworker they never opened.
     */
    await expect(
      store.adopt(actorFor(userId), otherAgentId, threadId),
    ).rejects.toThrow(BotChatThreadTakenError);

    const [row] = await database
      .select({ agentId: botChats.agentId })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // And the refusal left the conversation pointing where it did: the insert conflicts and does
    // nothing, so nothing re-points a live transcript at a Bot that did not say any of it.
    expect(row?.agentId).toBe(agentId);
  });

  test("refuses to adopt onto a Bot that has been retired", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const threadId = randomUUID();
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, agentId));

    // The same answer `create` gives, through the same `getWithin`, and it matters more here: this
    // call is made on a thread id a browser remembered, so refusing it is what stops a retirement
    // being worked around by whatever the last tab had in storage.
    await expect(
      store.adopt(actorFor(userId), agentId, threadId),
    ).rejects.toThrow(AgentNotFoundError);

    const rows = await database
      .select({ id: botChats.id })
      .from(botChats)
      .where(eq(botChats.threadId, threadId));
    expect(rows).toEqual([]);
  });

  test("refuses a thread that is already a channel's", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const threadId = await seedChannelThread(userId);

    /*
     * The uniqueness that decides every other adoption race is `bot_chats_thread_idx`, and it sees
     * one table. A channel's thread is claimed by a separate unique index on
     * `intelligence_channel_mappings.thread_id`, so the insert inside `adopt` conflicts with nothing
     * and used to succeed here: two roster rows — one `channel`, one `bot_chat` — backed by one
     * Intelligence transcript, with the bot chat free to name a Bot that is not in the channel.
     *
     * Reachable, and it is `adopt`'s own caller who reaches it: `threadId` is a field on
     * `AgentChannel` and comes back from `GET /api/channels/:id`, so an adopter is handed the value
     * rather than having to guess 74 bits of it.
     */
    await expect(
      store.adopt(actorFor(userId), agentId, threadId),
    ).rejects.toThrow(BotChatThreadTakenError);

    // And nothing was written on the way to the refusal, so the thread has one conversation on it.
    const rows = await database
      .select({ id: botChats.id })
      .from(botChats)
      .where(eq(botChats.threadId, threadId));
    expect(rows).toEqual([]);
  });

  test("refuses to hand back a thread the same person deleted", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const threadId = randomUUID();

    const chat = await store.adopt(actorFor(userId), agentId, threadId);
    createdBotChatIds.push(chat.id);
    await store.softDelete(actorFor(userId), chat.id);

    // Not resurrected, and not handed back either. A `BotChat` this call returned would be one the
    // caller navigates straight to, and `get` answers null for a deleted row — so returning it here
    // would be an id no read honours and no roster shows. Refusing is what lets the route above
    // answer 409, which the client already treats as clearing the remembered thread id.
    await expect(
      store.adopt(actorFor(userId), agentId, threadId),
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

  test("reads a chat whose Bot has no profile row, and says the Bot is gone", async () => {
    const userId = await seedUser();
    const agentId = await seedAgentWithoutProfile();
    const id = `botchat_${randomUUID()}`;
    // Inserted directly, because neither `create` nor `adopt` will make one: both hold a live profile
    // before they write. This is the shape the reads have to agree about, not a path a caller takes.
    await database
      .insert(botChats)
      .values({ id, userId, agentId, threadId: randomUUID() });
    createdBotChatIds.push(id);

    const read = await store.get(actorFor(userId), id);

    /*
     * `active` is "this conversation's Bot is still around", and a Bot with no profile row is not
     * around. It used to arrive as the same null a live profile produces, so this chat reported
     * itself usable — while an inner join in this very method dropped it, answering "not found" for
     * a conversation the roster lists. The roster shows this row, so this read must open it.
     */
    expect(read).not.toBeNull();
    expect(read?.active).toBe(false);
    // And the `?agent=` belt does not skip it either, so the two reads of a chat agree about which
    // conversations exist as well as about what `active` means.
    const opened = await store.mostRecent(actorFor(userId), agentId);
    expect(opened?.id).toBe(id);
    expect(opened?.active).toBe(false);
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

  test("skips a deleted chat, so ?agent= does not land on one that is gone", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.softDelete(actorFor(userId), chat.id);

    /*
     * A separate filter from the archive one above, and it fails differently. An archived chat handed
     * back here would be restored by navigation; a deleted one handed back here is an id `get`
     * answers null for, so the `?agent=` resolver would send the person straight to "this
     * conversation is not here any more" instead of opening a fresh one.
     */
    expect(await store.mostRecent(actorFor(userId), agentId)).toBeNull();
  });

  test("finds nothing for somebody else's chat with the same Bot", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(owner), agentId);
    createdBotChatIds.push(chat.id);

    // The `?agent=` resolver runs for whoever opened the Bot, and a public Bot is opened by
    // everybody: without the owner filter it would land each of them in the first person's
    // transcript.
    expect(await store.mostRecent(actorFor(stranger), agentId)).toBeNull();
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

  test("names the chat from the person's message reported after the Bot's reply", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const replyAt = new Date();
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Hello, how can I help?",
      agentId,
      at: replyAt,
    });
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "What is our refund policy?",
      agentId: null,
      at: new Date(replyAt.getTime() - 1000),
    });

    /*
     * The two halves of one exchange are reported by separate calls and can arrive in either order.
     * The title used to ride the moves-forwards-only guard, so a person's first message reported
     * after the Bot's reply was discarded whole and the conversation was never named — while the
     * spec says a chat is named after the person's first message, which this is.
     */
    expect((await store.get(actorFor(userId), chat.id))?.title).toBe(
      "What is our refund policy?",
    );
    const [row] = await database
      .select({ lastMessage: botChats.lastMessage })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // And the late report still did not drag the preview backwards, which is what that guard is for.
    expect(row?.lastMessage).toBe("Hello, how can I help?");
  });

  test("leaves the chat unnamed when the first thing said renders as nothing", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const at = new Date();
    await store.recordActivity(actorFor(userId), chat.id, {
      // Written as escapes, because a message whose whole content is invisible is not something a
      // reader of this file could otherwise see is here.
      text: "\u200b \u200b",
      agentId: null,
      at,
    });

    // Untitled rather than titled the empty string, because a chat is named once and an empty name
    // is a conversation called nothing for good. See `titleOf` in roster/preview.ts.
    expect((await store.get(actorFor(userId), chat.id))?.title).toBeNull();

    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Now a real question",
      agentId: null,
      at: new Date(at.getTime() + 1000),
    });

    // So the next thing the person says gets to name it.
    expect((await store.get(actorFor(userId), chat.id))?.title).toBe(
      "Now a real question",
    );
  });

  test("keeps the preview a row has when the next message renders as nothing", async () => {
    /*
     * The same message the title write above refuses, on the preview path, which took it.
     *
     * `previewOf` answers null for a message of nothing but invisible characters and that null was
     * written straight onto the row — two lines from a title write that refuses it with an argument
     * for why. So any caller could blank their own roster preview: the parser rejects on
     * `text.trim()`, and `"\u200b".trim()` is one character long, so a message of zero-width spaces
     * is accepted as text and renders as nothing.
     *
     * `last_message_agent_id` is held back with it, because the two are halves of one fact — what the
     * row shows and who said it — and moving the author alone leaves the row rendering a person's
     * words under a Bot's name. `last_message_at` does move: the message is real, and recency is what
     * the sort is for.
     */
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const said = new Date();
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "What is our refund policy?",
      agentId: null,
      at: said,
    });
    const invisible = new Date(said.getTime() + 1000);
    await store.recordActivity(actorFor(userId), chat.id, {
      // Written as escapes, for the reason the title test above gives.
      text: "\u200b \u200b",
      agentId,
      at: invisible,
    });

    const [row] = await database
      .select({
        lastMessage: botChats.lastMessage,
        lastMessageAt: botChats.lastMessageAt,
        lastMessageAgentId: botChats.lastMessageAgentId,
      })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    expect(row?.lastMessage).toBe("What is our refund policy?");
    expect(row?.lastMessageAgentId).toBeNull();
    expect(row?.lastMessageAt).toEqual(invisible);
  });

  test("says it restored a conversation archived while it was deciding", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    /*
     * The archive commits between the read that decides what to announce and the write that clears
     * the flag — the one interleaving this method used to lose.
     *
     * Held open here rather than raced, so the ordering is this test's and not the scheduler's. The
     * defect: `archived_at` was read on an earlier statement, so the recording saw "not archived",
     * cleared it anyway, and left `archived: false` off its announcement. Restored in the database
     * and still hidden in every tab until something unrelated made them refetch — and saying
     * something in an archived conversation is precisely how it is meant to come back.
     */
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let archiveWritten = () => {};
    const written = new Promise<void>((resolve) => {
      archiveWritten = resolve;
    });
    const archiving = database.transaction(async (transaction) => {
      await transaction
        .update(botChats)
        .set({ archivedAt: new Date() })
        .where(eq(botChats.id, chat.id));
      archiveWritten();
      await held;
    });
    // Awaited, so the archive is uncommitted-but-written before the recording starts. Without this the
    // recording can take the row first and the archive queues behind it, which is a different (and
    // already correct) interleaving.
    await written;

    const recording = store.recordActivity(actorFor(userId), chat.id, {
      text: "One more thing",
      agentId: null,
      at: new Date(),
    });
    // Long enough for the recording to have reached its first statement and blocked there on the
    // archive's row lock. Nothing observable happens on either side while it waits.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await archiving;

    // Reported as a restore, because the pre-image it is reported from is the one this write
    // actually overwrote.
    expect(await recording).toEqual({ restored: true });
    expect((await store.get(actorFor(userId), chat.id))?.archived).toBe(false);
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
     * The clear's own guard is what carries this: the report predates `archived_at`. Saying something
     * in an archived conversation restores it, so a report that arrives late — a message the client
     * only got round to announcing after the person put the conversation away — would otherwise pull
     * it back onto the roster, and the archive would have been undone by nothing anybody did.
     *
     * The report here is also stale for the preview, which is why this test passed while the two
     * questions shared one guard. The three tests below are the cases where they disagree.
     */
    expect((await store.get(actorFor(userId), chat.id))?.archived).toBe(true);
  });

  test("restores a chat on a message newer than the archive but behind the stored last message", async () => {
    /*
     * The archive silently failing to lift, which is the direction that strands somebody.
     *
     * The clear used to ride the moves-forwards-only guard, so a person's message was measured
     * against `last_message_at` and never against `archived_at` at all. Here the Bot's reply is
     * reported first and carries the later stamp — a clock a couple of seconds slow on the tab the
     * person is typing in is all it takes — so their message reads as stale, the row stays archived,
     * `restored` is false so no `bot_chat.unarchived` row is written and no `archived: false` goes on
     * the wire, and the POST still answers 204.
     */
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);
    // Taken after the archive committed, so both stamps below are newer than `archived_at` whatever
    // this machine's clock did in between.
    const afterArchive = new Date();

    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Thirty days, unopened.",
      agentId,
      at: new Date(afterArchive.getTime() + 2000),
    });
    const outcome = await store.recordActivity(actorFor(userId), chat.id, {
      text: "One more thing",
      agentId: null,
      at: new Date(afterArchive.getTime() + 1000),
    });

    expect(outcome).toEqual({ restored: true });
    expect((await store.get(actorFor(userId), chat.id))?.archived).toBe(false);

    const [row] = await database
      .select({ lastMessage: botChats.lastMessage })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // And the preview did not go backwards. The report is still stale for the recency write, which is
    // the whole reason these are two statements: whether a conversation is hidden and what its last
    // message was are different questions about it.
    expect(row?.lastMessage).toBe("Thirty days, unopened.");
  });

  test("leaves the archive in place for a person's own message that predates it", async () => {
    /*
     * The same root cause, the opposite symptom: the archive lifting on its own.
     *
     * The Bot's reply was excluded from clearing `archived_at`, and the person's own late report walks
     * the identical path. Sent at T1, archived at T2, reported at T3: newer than `last_message_at`, so
     * the old single guard let it through, and it cleared an archive that did not exist when the
     * message was said — with a `bot_chat.unarchived` row on the trail for it, which `audit.ts` argues
     * is worse than no row at all.
     */
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const asked = new Date(Date.now() - 60_000);
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "What is our refund policy?",
      agentId: null,
      at: asked,
    });
    await store.setArchived(actorFor(userId), chat.id, true);

    const outcome = await store.recordActivity(actorFor(userId), chat.id, {
      text: "And one more thing",
      agentId: null,
      at: new Date(asked.getTime() + 1000),
    });

    expect(outcome).toEqual({ restored: false });
    expect((await store.get(actorFor(userId), chat.id))?.archived).toBe(true);

    const [row] = await database
      .select({ lastMessage: botChats.lastMessage })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // Hidden, not frozen: the message still moves the preview and the recency. Only the clear is
    // refused.
    expect(row?.lastMessage).toBe("And one more thing");
  });

  test("takes a report whose stamp equals the one already stored", async () => {
    /*
     * An equal stamp from a later report is not a regression, and the guard read it as one.
     *
     * `>` on `last_message_at` dropped the second of two reports carrying one instant, and the skew
     * clamp in `parseActivityInput` is what manufactures that: every report from a client more than
     * the allowance out is rewritten to the same bound, so two reports made inside one millisecond of
     * the server's clock arrive identical. Dropped, the second report lost its preview AND — before
     * the clear was given its own statement — its unarchiving with it.
     */
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);
    const at = new Date(Date.now() + 1000);

    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Thirty days, unopened.",
      agentId,
      at,
    });
    const outcome = await store.recordActivity(actorFor(userId), chat.id, {
      text: "One more thing",
      agentId: null,
      at,
    });

    expect(outcome).toEqual({ restored: true });
    expect((await store.get(actorFor(userId), chat.id))?.archived).toBe(false);

    const [row] = await database
      .select({ lastMessage: botChats.lastMessage })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    expect(row?.lastMessage).toBe("One more thing");
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
 * PostgreSQL accepts.
 *
 * Both also stand as the assertion that neither method consults `archived_at`, and both archive the
 * conversation before the call under test for that claim to hold: an earlier version of this file
 * made the claim while the `markRead` test never archived anything, so an `archived_at` term added to
 * `markRead` would have left this file green. Both then assert the stamp is still there afterwards,
 * because neither method has any business touching it.
 *
 * What they do consult is `deleted_at`, and the four tests after them are that pair: a deleted chat
 * and somebody else's are refused by both, which is what keeps either call from announcing — or, for
 * `markRead`, stamping — a row no roster can show.
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
    /*
     * Archived after the message and before the read, which is the only order that leaves it
     * archived: `recordActivity` clears `archived_at`, because saying something in a conversation is
     * how it comes back.
     *
     * Here so this test carries the claim its describe makes. `markRead` deliberately does not
     * consult `archived_at` — reading is the caller's own state and archived is hidden, not frozen —
     * and without a stamp on the row an `archived_at` term added to that `WHERE` would match anyway
     * and this file would stay green.
     */
    await store.setArchived(actorFor(userId), chat.id, true);
    await store.markRead(actorFor(userId), chat.id);

    const [row] = await database
      .select({
        lastReadAt: botChats.lastReadAt,
        archivedAt: botChats.archivedAt,
      })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // A marker stamped plainly "now" by a server running behind that clock would leave the row
    // reading as unseen, re-lighting the dot on every refetch until wall clock catches up.
    expect(row?.lastReadAt?.getTime()).toBeGreaterThanOrEqual(ahead.getTime());
    // And the read did not touch the archive. Asserted as a stamp rather than with `not.toBeNull()`,
    // which would hold just as happily for a row that had gone missing.
    expect(row?.archivedAt).toBeInstanceOf(Date);
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
    /*
     * A stamp, asserted as a stamp. `not.toBeNull()` passes for `undefined` too, so it passed just
     * as happily when the row was not there at all — which is the one outcome this test is supposed
     * to catch, since a chat this store refused to pin would leave no row to read.
     */
    expect(pinned?.pinnedAt).toBeInstanceOf(Date);

    await store.setPinned(actorFor(userId), chat.id, false);

    const [unpinned] = await database
      .select({ pinnedAt: botChats.pinnedAt, archivedAt: botChats.archivedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    expect(unpinned?.pinnedAt).toBeNull();
    // And neither call touched the archive. Only the roster query reads `archived_at`. Asserted as a
    // stamp for the reason above: `not.toBeNull()` would hold for a row that had gone missing.
    expect(unpinned?.archivedAt).toBeInstanceOf(Date);
  });

  test("refuses to pin a deleted chat", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.softDelete(actorFor(userId), chat.id);

    /*
     * The `deleted_at` guard on the write, which is the one thing separating this from the archive
     * case above. Without it the pin succeeds and announces, and the announcement sends this person's
     * every tab to refetch a roster that cannot show the row — a refetch storm over a conversation
     * nobody can see.
     */
    await expect(
      store.setPinned(actorFor(userId), chat.id, true),
    ).rejects.toThrow(BotChatNotFoundError);

    const [row] = await database
      .select({ pinnedAt: botChats.pinnedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // The row outlives the deletion, and the refusal left it unstamped.
    expect(row?.pinnedAt).toBeNull();
  });

  test("refuses to pin somebody else's chat", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(owner), agentId);
    createdBotChatIds.push(chat.id);

    // The same "not found" a deleted chat gets, so ownership is not probeable — and the stranger's
    // pin does not land on the owner's row.
    await expect(
      store.setPinned(actorFor(stranger), chat.id, true),
    ).rejects.toThrow(BotChatNotFoundError);

    const [row] = await database
      .select({ pinnedAt: botChats.pinnedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    expect(row?.pinnedAt).toBeNull();
  });

  test("refuses to mark a deleted chat read", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.softDelete(actorFor(userId), chat.id);

    // The same guard `setPinned` carries, for the same reason: the row is gone from every roster, so
    // nothing about it is markable.
    await expect(store.markRead(actorFor(userId), chat.id)).rejects.toThrow(
      BotChatNotFoundError,
    );

    const [row] = await database
      .select({ lastReadAt: botChats.lastReadAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    expect(row?.lastReadAt).toBeNull();
  });

  test("refuses to mark somebody else's chat read", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(owner), agentId);
    createdBotChatIds.push(chat.id);

    await expect(store.markRead(actorFor(stranger), chat.id)).rejects.toThrow(
      BotChatNotFoundError,
    );

    const [row] = await database
      .select({ lastReadAt: botChats.lastReadAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // A bot chat keeps `last_read_at` on the conversation itself rather than on a membership row, so
    // an unscoped write here would stamp the owner's own unread dot away.
    expect(row?.lastReadAt).toBeNull();
  });
});

describe("archiving a bot chat", () => {
  test("is a no-op the second time", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    expect(await store.setArchived(actorFor(userId), chat.id, true)).toBe(true);
    const [first] = await database
      .select({ archivedAt: botChats.archivedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));

    // `false` is the answer the route reads to decide whether to write the trail, so a repeat click
    // is not merely harmless here — it must say it changed nothing.
    expect(await store.setArchived(actorFor(userId), chat.id, true)).toBe(
      false,
    );
    const [second] = await database
      .select({ archivedAt: botChats.archivedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));

    // A repeat call must not restamp, or the row's archive time drifts on every click.
    expect(second?.archivedAt).toEqual(first?.archivedAt);
  });

  test("gives one archiving to two callers that race", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    /*
     * Started together, not one after the other, which is the case the guard exists for.
     *
     * The decision used to be taken from a read on an earlier statement: under READ COMMITTED both
     * callers read `archived_at` null, both wrote, and both reported they had changed something. The
     * route above turns that boolean into an audit row and an announcement, so one archiving became
     * two rows saying it happened and two whole-roster refetches in every tab. Exactly one of these
     * may claim it.
     */
    const claimed = await Promise.all([
      store.setArchived(actorFor(userId), chat.id, true),
      store.setArchived(actorFor(userId), chat.id, true),
    ]);

    expect(claimed.filter(Boolean)).toHaveLength(1);
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

describe("deleting a bot chat", () => {
  /*
   * A repeat delete is not found, not a second deletion.
   *
   * The audit trail rests on this. `DELETE /api/bot-chats/:id` writes `bot_chat.deleted` after
   * `softDelete` returns, and its comment says so out loud: "`softDelete` throws for a repeat, so
   * reaching this line is itself the 'it happened this time' gate the archive route needs a boolean
   * for." Nothing pinned that here — `setArchived` has its own no-op test and this did not — so a
   * `deleted_at` term quietly dropped from the write would answer a second click 204, lay down a
   * second `bot_chat.deleted` row, and announce `deleted: true` again to every one of the owner's
   * tabs. `ChannelStore.softDelete` is pinned the same way in channel-routes.test.ts, whose comment
   * names this method as the reason the two kinds now answer alike.
   */
  test("deleting again is not found, not a second deletion", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.softDelete(actorFor(userId), chat.id);
    const [afterFirst] = await database
      .select({ deletedAt: botChats.deletedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // Soft: the row is still there, stamped rather than gone, which is what makes a second call
    // reachable at all.
    expect(afterFirst?.deletedAt).toBeInstanceOf(Date);

    await expect(store.softDelete(actorFor(userId), chat.id)).rejects.toThrow(
      BotChatNotFoundError,
    );

    const [afterSecond] = await database
      .select({ deletedAt: botChats.deletedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // And the refusal left the first deletion's own stamp where it was, rather than restamping the
    // row with the time of a click that deleted nothing.
    expect(afterSecond?.deletedAt).toEqual(afterFirst?.deletedAt);
  });

  test("refuses somebody else's chat", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(owner), agentId);
    createdBotChatIds.push(chat.id);

    await expect(store.softDelete(actorFor(stranger), chat.id)).rejects.toThrow(
      BotChatNotFoundError,
    );

    const [row] = await database
      .select({ deletedAt: botChats.deletedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    expect(row?.deletedAt).toBeNull();
  });
});
