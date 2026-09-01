import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
  channelAgents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { recencyCursorText } from "../src/roster/order";
import { DEFAULT_ROSTER_PAGE, MAX_ROSTER_PAGE } from "../src/roster/preview";
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

/**
 * EVERY DROPPED ROW THIS FILE'S READS LEAVE BEHIND, ASSERTED ON, TEST BY TEST.
 *
 * `list` writes a `roster-rows-not-hydrated` line when phase 1 chose a conversation phase 2 could not
 * rebuild, and its docblock says what one means: expected once for a conversation deleted or archived
 * between the two statements, and a disagreement between the phases for any other cause. A
 * disagreement is invisible from the answers alone — the page is simply short, and the row keeps
 * burning its slot on every read — which is how two earlier versions of that bug survived. The line is
 * the only place it shows, so nothing in this file may write one that a test has not claimed.
 *
 * Collected for the whole file rather than around one read, because the check has to be a property of
 * every ordinary read here rather than of the one test that remembered to look. Removing the ownership
 * term from phase 1's bot chat branch left all twenty-two tests green before this existed: phase 2
 * filters on ownership as well, so a stranger's conversation was chosen, dropped, and paid for out of
 * somebody else's page — silently, and permanently.
 *
 * Swallowed rather than printed, and only these lines: anything else the process logs still reaches
 * the suite's output, so this cannot hide a diagnostic that belongs to another test. A test that
 * expects a line drains this with `splice(0)` and asserts on what it took, which is what leaves the
 * check below meaning "unclaimed".
 */
const droppedRowLines: Record<string, unknown>[] = [];
let wasConsoleError: typeof console.error | undefined;

beforeAll(() => {
  wasConsoleError = console.error;
  console.error = (...arguments_: unknown[]) => {
    let line: Record<string, unknown> | undefined;
    try {
      line = JSON.parse(String(arguments_[0])) as Record<string, unknown>;
    } catch {
      // Something else in the process logging prose rather than a structured line. Not ours.
    }
    if (line?.type === "roster-rows-not-hydrated") {
      droppedRowLines.push(line);
      return;
    }
    wasConsoleError?.(...arguments_);
  };
});

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

  // Last, and after the cleanup above rather than before it: a failure here ends the hook, and rows
  // left in the database would then follow this file into every later test that reads the same tables.
  expect(droppedRowLines.splice(0)).toEqual([]);
});

afterAll(async () => {
  if (wasConsoleError) console.error = wasConsoleError;
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

  /**
   * How many pages a walk may take before it gives up and says the cursor is stuck.
   *
   * Far more than any test here needs — the longest walk below pages six conversations two at a time
   * — so reaching it means the cursor stopped advancing rather than that a test outgrew the bound.
   */
  const MAX_WALK_PAGES = 20;

  /**
   * Every conversation the cursor reaches, in the order the pages hand them over.
   *
   * BOUNDED, and it throws at the bound. Six tests below page through this and several exist
   * specifically to prove the cursor advances; as an unbounded `do/while`, a cursor that stopped
   * advancing did not fail on the answer — it spun until the suite's timeout killed the whole file,
   * which says nothing about which claim broke. Both sibling walkers in this change are bounded for
   * exactly this reason: `channel-activity.integration.test.ts`'s, and the one in
   * `channel-routes.test.ts` whose bound is "one more turn than there are visible channels, so a
   * cursor that never advances fails as a wrong answer rather than as a hung test".
   *
   * Thrown rather than broken out of. Returning a truncated list would fail the caller's own
   * `toEqual` with a diff of ids and send whoever reads it hunting for a missing-rows bug, which is
   * the opposite of what happened.
   */
  async function walk(actor: AgentActor, limit: number) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_WALK_PAGES; page += 1) {
      const answer = await rosterStore.list(actor, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...answer.items.map((item) => item.id));
      if (!answer.nextCursor) return seen;
      cursor = answer.nextCursor;
    }
    throw new Error(
      `The roster cursor did not reach the end of the list in ${MAX_WALK_PAGES} pages, so it is not advancing.`,
    );
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

    // One cursor over two tables. Channel and bot-chat ids cannot collide — generated ids are
    // prefixed, and a package's chosen id is refused if it enters one of those namespaces — which is
    // what lets `id` break every tie without the cursor carrying `kind`.
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

  /*
   * The Bot's reply to a question asked BEFORE the archive, on both kinds at once.
   *
   * This belongs here rather than beside either store's own tests because it is a claim about the
   * roster: the two kinds are read by one query and drawn as one list, so a rule that held for a
   * channel and not for a bot chat is the archive implemented twice with two answers — which is what
   * `bot-chats/store.ts`'s header says its shape exists to prevent.
   *
   * The defect this covers: both `recordActivity` implementations cleared `archived_at` for any report
   * that beat the stored `last_message_at`, with no reference to who spoke. A person's message and the
   * Bot's reply are reported separately, so send, archive, and a second later the reply lands and the
   * row is back in the sidebar with every tab refetching. Nobody did that.
   */
  test("keeps both kinds archived when the Bot answers after the archive", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    // The question, then the tidying gesture, then the answer — in the order they actually happen.
    const asked = new Date();
    await channelStore.recordActivity(actor, channel.id, {
      text: "What is our refund policy?",
      agentId: null,
      at: asked,
    });
    await botChatStore.recordActivity(actor, botChat.id, {
      text: "What is our refund policy?",
      agentId: null,
      at: asked,
    });
    await channelStore.setArchived(actor, channel.id, true);
    await botChatStore.setArchived(actor, botChat.id, true);

    const answered = new Date(asked.getTime() + 1000);
    const channelReply = await channelStore.recordActivity(actor, channel.id, {
      text: "Thirty days, unopened.",
      agentId,
      at: answered,
    });
    const botChatReply = await botChatStore.recordActivity(actor, botChat.id, {
      text: "Thirty days, unopened.",
      agentId,
      at: answered,
    });

    // Nothing was restored, so no event carries `archived: false` and neither route writes an
    // `unarchived` row for an unarchiving that did not happen.
    expect(channelReply).toEqual({ restored: false });
    expect(botChatReply).toEqual({ restored: false });

    const active = await rosterStore.list(actor, { status: "active" });
    const archived = await rosterStore.list(actor, { status: "archived" });
    expect(active.items).toEqual([]);
    // Hidden, not frozen: both rows are still archived, and the preview a person finds under
    // Archived is the reply rather than the question it answered.
    expect(
      archived.items.map((item) => [item.id, item.lastMessage]).sort(),
    ).toEqual(
      [
        [channel.id, "Thirty days, unopened."],
        [botChat.id, "Thirty days, unopened."],
      ].sort(),
    );
    expect(archived.items.map((item) => item.lastMessageAgentId)).toEqual([
      agentId,
      agentId,
    ]);

    // And the person can still bring either back by speaking in it, which is what "sending
    // unarchives" was always about.
    await channelStore.recordActivity(actor, channel.id, {
      text: "Thanks",
      agentId: null,
      at: new Date(answered.getTime() + 1000),
    });
    await botChatStore.recordActivity(actor, botChat.id, {
      text: "Thanks",
      agentId: null,
      at: new Date(answered.getTime() + 1000),
    });
    expect(
      (await rosterStore.list(actor, { status: "archived" })).items,
    ).toEqual([]);
    expect(
      (await rosterStore.list(actor, { status: "active" })).items.length,
    ).toBe(2);
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

  test("does not spend a page slot on somebody else's conversation", async () => {
    /*
     * The other half of the claim above, and the half that reads as an empty sidebar rather than as
     * one row too many.
     *
     * "Shows nobody else's conversations" holds as long as ownership is decided ANYWHERE, and phase 2
     * decides it too — so it held with the term missing from phase 1, and so did the whole file. What
     * a missing phase-1 term does instead is let phase 1 choose a row phase 2 cannot rebuild: the row
     * is dropped, its slot is spent, and it is spent again on every read for as long as the stranger's
     * conversation stays newer. This is the permanent slot-burning the module header describes, from
     * the outside: at `limit: 1`, a person's own page stops containing their own conversation.
     *
     * A page of one, because that is the smallest page where a wasted slot is the whole page. The
     * stranger gets one of each kind, so the assertion covers both branches of the union rather than
     * whichever one the mutation happened to be tried on.
     */
    const ownerId = await seedUser();
    const owner = actorFor(ownerId);
    const strangerId = await seedUser();
    const stranger = actorFor(strangerId);
    const agentId = await seedProfile();

    const base = Date.now();
    const mine = await botChatStore.create(owner, agentId);
    createdBotChatIds.push(mine.id);
    await botChatStore.recordActivity(owner, mine.id, {
      text: "Mine",
      agentId: null,
      at: new Date(base - 10_000),
    });

    // Both newer than the owner's, so either one would take the single slot if phase 1 chose the page
    // without asking whose conversation it is.
    const theirChat = await botChatStore.create(stranger, agentId);
    createdBotChatIds.push(theirChat.id);
    await botChatStore.recordActivity(stranger, theirChat.id, {
      text: "Theirs",
      agentId: null,
      at: new Date(base),
    });
    const theirChannel = await channelStore.create(stranger, [agentId]);
    createdChannelIds.push(theirChannel.id);
    await channelStore.recordActivity(stranger, theirChannel.id, {
      text: "Theirs",
      agentId: null,
      at: new Date(base - 1000),
    });

    const page = await rosterStore.list(owner, { limit: 1 });

    // Their conversation is not merely absent from the answer: it never took the slot. An empty page
    // carrying a live cursor is what the defect looked like, and a client that stops at the first
    // empty page shows a person no conversations at all.
    expect(page.items.map((item) => item.id)).toEqual([mine.id]);
    expect(page.nextCursor).toBeNull();
    expect(await walk(owner, 1)).toEqual([mine.id]);
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

  /**
   * One more conversation than the ceiling this module declares — WRITTEN AS A LITERAL, deliberately.
   *
   * `MAX_ROSTER_PAGE + 1` was what stood here, and a fixture derived from the constant under test grows
   * with it: raising the cap from 200 to 400 seeded 401 conversations, the read handed back 400, and
   * the assertion passed. That is the same vacuous shape as the version before it, which seeded one row
   * and asserted the page was no longer than the cap — it held for every value the constant could have
   * had. A literal is what makes raising the cap a failure rather than a bigger page.
   *
   * The coupling that leaves behind is asserted below rather than left as a comment nobody reads: if
   * the ceiling is ever raised past this number, that assertion says so and names this constant.
   */
  const SEEDED_CONVERSATIONS = 201;

  /**
   * More conversations than either page size, inserted rather than created.
   *
   * Two hundred and one rows through `botChatStore.create` is two hundred and one round trips and a
   * thread id minted for each; one `insert ... values` is one. Nothing here needs a real creation —
   * the claim is about how many rows a read hands back — so the columns are the four the store's reads
   * actually require plus an explicit `last_message_at`, which is what makes the recency order
   * deterministic rather than a tie broken by whichever `created_at` Postgres stamped first.
   */
  async function manyBotChats(userId: string, agentId: string, count: number) {
    const base = Date.now();
    const rows = Array.from({ length: count }, (_, index) => ({
      id: `botchat_${testPrefix}-page-${randomUUID()}`,
      userId,
      agentId,
      threadId: randomUUID(),
      lastMessageAt: new Date(base - index * 1000),
      lastMessage: `Conversation ${index}`,
    }));
    await database.insert(botChats).values(rows);
    createdBotChatIds.push(...rows.map((row) => row.id));
    return rows.map((row) => row.id);
  }

  test("caps what a caller may ask for, and pages by default", async () => {
    /*
     * ASKING FOR EVERYTHING MUST NOT BE A WAY TO READ EVERYTHING. The limit arrives over HTTP, so the
     * ceiling is what makes paging a property of the endpoint rather than of the caller —
     * `roster/routes.ts` deliberately passes `?limit=1000` through unchanged for the store to clamp,
     * and this is the clamp.
     *
     * SEEDED PAST BOTH SIZES, because the earlier version of this test seeded one conversation and
     * asserted the page was no longer than `MAX_ROSTER_PAGE`. One row is shorter than any cap, so that
     * assertion held for every value the constant could have had — three review rounds noticed it, and
     * raising `DEFAULT_ROSTER_PAGE` from 50 to 10,000 left both roster test files green. A cap is only
     * tested by a list longer than it.
     *
     * Both sizes, in one seeded list: the ceiling is what a caller cannot talk its way past, and the
     * default is what the sidebar gets when it names no limit at all. Neither is the other's evidence.
     */
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();
    const ids = await manyBotChats(userId, agentId, SEEDED_CONVERSATIONS);

    // The fixture is a literal and the ceiling is not, so this is where the two meeting says so. A
    // list no longer than the cap cannot tell whether the cap was applied.
    expect(MAX_ROSTER_PAGE).toBeLessThan(SEEDED_CONVERSATIONS);

    const capped = await rosterStore.list(actor, { limit: 100_000 });
    expect(capped.items).toHaveLength(MAX_ROSTER_PAGE);
    expect(capped.items.map((item) => item.id)).toEqual(
      ids.slice(0, MAX_ROSTER_PAGE),
    );
    // Capped, not truncated: there is another page and the cursor says so, which is the difference
    // between a ceiling and rows quietly going missing.
    expect(capped.nextCursor).not.toBeNull();

    const byDefault = await rosterStore.list(actor);
    expect(byDefault.items).toHaveLength(DEFAULT_ROSTER_PAGE);
    expect(byDefault.nextCursor).not.toBeNull();
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
  /**
   * Move a conversation's recency to an exact instant, microseconds included.
   *
   * Written as SQL rather than through a store, because the whole point is a stamp a JS `Date` cannot
   * hold: handing drizzle a `Date` would round-trip through milliseconds on the way in and the row
   * would never carry the microseconds the test is about. `last_message_at` is cleared with it so
   * `coalesce` resolves to the stamp rather than to whatever the store last wrote.
   */
  async function setRecency(
    table: "channels" | "bot_chats",
    id: string,
    stamp: string,
  ) {
    const target = table === "channels" ? channels : botChats;
    await database.execute(
      sql`update ${target} set created_at = ${stamp}::timestamptz, last_message_at = null where id = ${id}`,
    );
  }

  test("pages rows whose recency differs by less than a millisecond exactly once", async () => {
    /*
     * A JS `Date` cannot hold a microsecond and `timestamptz` can, so a cursor minted from the decoded
     * `Date` floors the page boundary downward. The next page's strict `<` then excludes every row
     * inside the floored-off remainder, and because a floor only ever loses rows there is no duplicate
     * to notice it by: page two came back empty with `nextCursor: null` and two of these three
     * conversations were reachable from no page at all.
     */
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    // Newest first, all three inside one millisecond.
    const stamps = [
      "2026-08-31T09:00:00.123900Z",
      "2026-08-31T09:00:00.123500Z",
      "2026-08-31T09:00:00.123100Z",
    ];
    const ids: string[] = [];
    for (const stamp of stamps) {
      const chat = await botChatStore.create(actor, agentId);
      createdBotChatIds.push(chat.id);
      await setRecency("bot_chats", chat.id, stamp);
      ids.push(chat.id);
    }

    expect(await walk(actor, 1)).toEqual(ids);
  });

  test("pages conversations made in one transaction exactly once", async () => {
    /*
     * The production trigger, not a contrivance. `tenant-package.ts` inserts every channel a package
     * defines inside a single transaction, so `now()` — and with it `created_at`, and with it the
     * recency of a channel nobody has spoken in — is byte-identical across all of them, microseconds
     * included. A tenant whose package defines more channels than fit on one page lost the remainder
     * from its sidebar permanently.
     */
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const channel = await channelStore.create(actor, [agentId]);
      createdChannelIds.push(channel.id);
      ids.push(channel.id);
      await setRecency("channels", channel.id, "2026-08-31T09:00:00.123456Z");
    }

    // One shared instant, so `id` breaks every tie and the sort key descends throughout.
    const expected = [...ids].sort().reverse();
    expect(await walk(actor, 2)).toEqual(expected);
  });

  test("carries a cursor timestamp that reparses to the same instant in any session", async () => {
    /*
     * `to_char` renders a `timestamptz` in the session's `TimeZone`, and `::text` in its `DateStyle`
     * as well. Neither is ours to set, and this deployment does not: a cursor that only reparsed
     * correctly under `UTC`/`ISO` would page correctly on the author's machine and silently
     * mis-compare on a server configured differently. Asserted against the database rather than
     * reasoned about, because the claim is about Postgres' formatter and not about ours.
     */
    const stamps = [
      "2026-08-31T12:34:56.123456Z",
      "2026-08-31T12:34:56.000001Z",
      "2026-01-02T03:04:05Z",
      "9999-12-31T23:59:59.999999Z",
    ];

    for (const zone of [
      "UTC",
      "America/New_York",
      "Asia/Kolkata",
      "Pacific/Chatham",
    ]) {
      for (const dateStyle of [
        "ISO, MDY",
        "ISO, DMY",
        "Postgres, DMY",
        "SQL, DMY",
        "German, DMY",
      ]) {
        await database.transaction(async (transaction) => {
          // `set local`, so the settings unwind with the transaction rather than staying on a pooled
          // connection for whichever test picks it up next.
          await transaction.execute(sql.raw(`set local time zone '${zone}'`));
          await transaction.execute(
            sql.raw(`set local datestyle to '${dateStyle}'`),
          );
          for (const stamp of stamps) {
            const key = recencyCursorText(sql`${stamp}::timestamptz`);
            const [row] = await transaction.execute(
              sql`select ${key} as key, (${key})::timestamptz = ${stamp}::timestamptz as same`,
            );
            expect(row?.same).toBe(true);
            expect(row?.key).toBe(
              stamp.replace("Z", "").includes(".")
                ? `${stamp.slice(0, -1).padEnd(26, "0")}Z`
                : `${stamp.slice(0, -1)}.000000Z`,
            );
          }
        });
      }
    }
  });

  test("reads a cursor whose timestamp is not one as the first page", async () => {
    /*
     * It reaches Postgres as `'lol'::timestamptz`, which answers `invalid input syntax for type
     * timestamp with time zone` from inside the read. `roster/routes.ts` registers no `onError`, so
     * that surfaced as a bare 500 rather than as the first page both docblocks promise.
     */
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();
    const chat = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(chat.id);

    for (const recency of ["lol", "2026-02-30T00:00:00.000Z", ""]) {
      const cursor = Buffer.from(
        JSON.stringify({ pinned: false, recency, id: "channel_x" }),
        "utf8",
      ).toString("base64url");
      const page = await rosterStore.list(actor, { cursor });
      expect(page.items.map((item) => item.id)).toEqual([chat.id]);
    }
  });

  test("keeps a channel on the roster while it has no Bots", async () => {
    /*
     * `channel_agents` is deleted and reinserted on every tenant-package sync, so a channel with no
     * rows there is reachable. Phase 1 chose the page from `channels` and `channel_memberships`
     * alone while phase 2 inner-joined `channel_agents`, so such a channel was chosen, failed to
     * hydrate, and was dropped — while still consuming its slot on every page, for good. Four
     * channels in this state returned an empty roster across two pages.
     */
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    // The bot chat first, so the channel with no Bots is the newer of the two and therefore the row a
    // page of one has to hold. A slot the roster wastes is only visible when something is behind it.
    const other = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(other.id);
    const channel = await channelStore.create(actor, [agentId]);
    createdChannelIds.push(channel.id);

    await database
      .delete(channelAgents)
      .where(eq(channelAgents.channelId, channel.id));

    const page = await rosterStore.list(actor, { limit: 1 });

    expect(page.items.map((item) => item.id)).toEqual([channel.id]);
    expect(page.items[0]?.agentIds).toEqual([]);
    // Nothing has been retired: a channel with no coworkers in it has none to report as gone.
    expect(page.items[0]?.active).toBe(true);
    expect(await walk(actor, 1)).toEqual([channel.id, other.id]);
  });

  test("names a bot chat after the Bot when its title says nothing", async () => {
    /*
     * `??` does not fire on `""`, so a title that flattened to nothing rendered the row nameless
     * rather than falling back to the Bot's name. Whether `titleOf` can still produce `""` is
     * `roster/preview.ts`'s business; a row that has one must not go out unnamed either way.
     */
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile("Risk Analyst");
    const chat = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(chat.id);

    await database
      .update(botChats)
      .set({ title: "" })
      .where(eq(botChats.id, chat.id));

    expect((await rosterStore.list(actor)).items[0]?.name).toBe("Risk Analyst");
  });

  test("pages a list one branch of the union dominates without losing the other", async () => {
    /*
     * Each branch of the union now carries the order and the limit, so Postgres reads a bounded top-N
     * per kind instead of every conversation this person has before discarding all but a page. The
     * global top-N is always contained in the union of the per-branch top-Ns, so that is exact — but
     * only if each branch really is ordered and limited on its own rather than the ORDER BY binding
     * to the whole set operation, which would make each branch's contribution arbitrary. Six channels
     * ahead of one bot chat is the shape that tells the difference: the bot chat is last in the global
     * order and first in its own branch's.
     */
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const base = Date.now();
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const channel = await channelStore.create(actor, [agentId]);
      createdChannelIds.push(channel.id);
      await channelStore.recordActivity(actor, channel.id, {
        text: `Channel ${index}`,
        agentId: null,
        at: new Date(base - index * 1000),
      });
      ids.push(channel.id);
    }
    const chat = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(chat.id);
    await botChatStore.recordActivity(actor, chat.id, {
      text: "Oldest",
      agentId: null,
      at: new Date(base - 60_000),
    });
    ids.push(chat.id);

    expect(await walk(actor, 2)).toEqual(ids);
  });

  test("does not let a channel with no thread mapping consume a page slot", async () => {
    /*
     * The other half of the same disagreement. A roster row carries a `threadId`, which
     * `hydrateChannels` gets from `intelligence_channel_mappings`, so a channel without that row for
     * this person cannot become a roster item — but phase 1 chose the page without asking, so such a
     * channel was chosen, dropped, and still counted against the page. `channel-archive.integration
     * .test.ts` inserts exactly this shape, a membership with no mapping, which is how it got noticed.
     */
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const other = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(other.id);
    const channel = await channelStore.create(actor, [agentId]);
    createdChannelIds.push(channel.id);

    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channel.id));

    // The channel is the newer of the two and unbuildable, so a page of one must skip past it to the
    // bot chat rather than hand back an empty page that claims there is nothing else.
    const page = await rosterStore.list(actor, { limit: 1 });
    expect(page.items.map((item) => item.id)).toEqual([other.id]);
    expect(await walk(actor, 1)).toEqual([other.id]);
  });
});

/**
 * `list`, with a delete committing between its two statements.
 *
 * The negative every other test in this file now carries — that no read leaves a
 * `roster-rows-not-hydrated` line behind — is only worth something if the line is written when it
 * should be. Delete the `console.error` from `list` and the guard is satisfied by silence, which is
 * the state the module was in when the two phases last disagreed. So this is the case that produces
 * one, and it is the case that is meant to: every join in the statement that rebuilds a page is
 * matched by a term in the statement that chooses it, which leaves a concurrent write as the only way
 * a chosen conversation can fail to be rebuilt.
 *
 * Its own `describe`, outside the guard's reach only in the sense that it drains the line it expects:
 * the guard fails on lines no test claimed, and this test claims exactly one.
 */
describe("the roster, interleaved", () => {
  /**
   * A store whose `list` runs `between` after it has chosen the page and before it rebuilds it.
   *
   * `channel-routes.test.ts`'s hook, unchanged apart from which store it builds — a race between two
   * connections is a test only if the interleaving is chosen rather than hoped for, and `list` takes no
   * locks to time a write against. The database handed to the store hooks every query's `then`, which
   * is what awaiting a drizzle query calls, and runs the write immediately before the second query it
   * is asked to execute. The write therefore lands with phase 1's rows in hand and phase 2 not yet
   * sent.
   *
   * Counted on execution rather than on `select`, because the two are not the same number here either:
   * phase 1 builds both branches of the union and an `exists` subquery inside the channel branch, and
   * a subquery is compiled into SQL rather than awaited. The page below is bot chats only, so phase 2
   * is a single statement and the second execution is unambiguous.
   */
  function storeInterleavedWith(between: () => Promise<void>) {
    let executed = 0;
    const hooked = Object.create(database) as typeof database;
    Object.defineProperty(hooked, "select", {
      value: (...columns: unknown[]) => {
        const builder = (
          database.select as unknown as (
            ...args: unknown[]
          ) => Record<string, unknown>
        )(...columns);
        const from = (
          builder.from as (...args: unknown[]) => Record<string, unknown>
        ).bind(builder);
        builder.from = (...tables: unknown[]) => {
          const query = from(...tables);
          const execute = (query.execute as () => Promise<unknown>).bind(query);
          // Defined rather than assigned, because a drizzle query already is a thenable and this
          // shadows the one it inherits. Awaiting it is what calls this.
          // biome-ignore lint/suspicious/noThenProperty: the thenable is drizzle's, not this test's — shadowing `then` is the only hook the store's own `await` runs through.
          Object.defineProperty(query, "then", {
            value: (onFulfilled: never, onRejected: never) => {
              executed += 1;
              const before = executed === 2 ? between() : Promise.resolve();
              return before.then(execute).then(onFulfilled, onRejected);
            },
          });
          return query;
        };
        return builder;
      },
    });
    return createRosterStore(hooked);
  }

  test("drops a conversation deleted before it could be rebuilt, and says which", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();
    const staying = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(staying.id);
    // Made second, so it leads the page and the drop is not the last row falling off the end.
    const vanishing = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(vanishing.id);

    const store = storeInterleavedWith(async () => {
      await database
        .update(botChats)
        .set({ deletedAt: new Date() })
        .where(eq(botChats.id, vanishing.id));
    });

    const page = await store.list(actor);

    // Dropping it is right — it is deleted, and phase 2 filters on that. The page being short is the
    // part nothing used to say out loud.
    expect(page.items.map((item) => item.id)).toEqual([staying.id]);
    const dropped = droppedRowLines.splice(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      actorUserId: userId,
      status: "active",
      chosen: 2,
      hydrated: 1,
      ids: [vanishing.id],
    });
    // The note is what tells the next reader whether one of these lines is a race or a disagreement
    // between the two phases, which is the only reason the line is worth writing.
    expect(typeof dropped[0]?.note).toBe("string");
  });
});
