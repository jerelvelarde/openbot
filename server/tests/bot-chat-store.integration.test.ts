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
