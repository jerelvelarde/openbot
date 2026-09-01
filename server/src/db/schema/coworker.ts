/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 */
import { sql } from "drizzle-orm";
import {
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const agentVisibility = pgEnum("agent_visibility", [
  "public",
  "private",
]);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    roleDescription: text("role_description").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    visibility: agentVisibility("visibility").notNull(),
    /*
     * The credential this Bot's agent presents when it calls a tool back.
     *
     * A hash, never the token. We issue it, the agent's owner holds it, and this side only ever needs
     * to check one: storing the token itself would mean a database dump is a set of working
     * credentials for every registered agent.
     *
     * Null means the agent has not been issued one and may not call tools back, which is the right
     * default: a URL somebody pasted gets no capability until an administrator hands it one.
     */
    callbackTokenHash: text("callback_token_hash"),
    callbackTokenIssuedAt: timestamp("callback_token_issued_at", {
      withTimezone: true,
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agent_profiles_visibility_deleted_idx").on(
      table.visibility,
      table.deletedAt,
    ),
  ],
);

export const agentPreferences = pgTable(
  "agent_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

/**
 * One conversation between one person and one Bot, on the direct Bot screen.
 *
 * WHY THIS TABLE EXISTS AT ALL. The direct Bot chat used to keep its thread id in `localStorage` and
 * nowhere else, one per Bot, and `New chat` overwrote it. The transcript stayed in Intelligence and
 * nothing in this deployment could ever name it again: a conversation destroyed by a button whose
 * label does not say so. A row per conversation is what makes that button non-destructive, and it is
 * the thing an archive can be hung on.
 *
 * NOT A CHANNEL, DELIBERATELY. A channel with one agent and one member is very nearly this, and
 * collapsing the two was considered and rejected — see the design's "Alternative considered". These
 * stay a distinct kind: never shareable, never multi-member.
 *
 * `pinned_at` and `last_read_at` sit here, where a channel keeps them on `channel_memberships`. A
 * bot chat has exactly one interested party, so a membership table would be a second row per
 * conversation able to hold only ever one member. The roster query is what flattens that asymmetry.
 *
 * MANY PER PAIR, DELIBERATELY. There is no unique constraint on `(user_id, agent_id)`, and there is
 * not meant to be: several conversations with one Bot is the whole point of the table, and it is what
 * `New chat` does. The only uniqueness it carries beyond its primary key is on `thread_id`, below,
 * which is there to decide an adoption race rather than to say anything about how many of these a
 * person may have.
 */
export const botChats = pgTable(
  "bot_chats",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /*
     * Cascades, matching `channel_agents.agent_id`, and that is safe because a Bot is retired by
     * soft-deleting its `agent_profiles` row rather than by deleting the `agents` row. A retired Bot
     * therefore leaves this conversation readable with `active` false, the same way a channel reports
     * a coworker who has been deleted.
     */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** The Intelligence thread, minted by thread-identity.ts so it says which deployment made it. */
    threadId: text("thread_id").notNull(),
    /**
     * What the roster calls this conversation, taken from the first thing the person said.
     *
     * Null until then, and the roster falls back to the Bot's name, because a conversation with
     * nothing in it has no subject to name it after. A Bot's opening message does not count: it is
     * the same greeting in every chat, so titling from it would make every row identical.
     */
    title: text("title"),
    lastMessage: text("last_message"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Which side spoke last. Null for the person, which is what leaves the unread dot unlit. */
    lastMessageAgentId: text("last_message_agent_id").references(
      () => agents.id,
      { onDelete: "set null" },
    ),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    /**
     * When this was archived, or null.
     *
     * Hidden, not frozen, the same way `channels.archived_at` is: nothing refuses a write because of
     * it, and `recordActivity` clears it when a PERSON speaks, because that is how a conversation
     * comes back. A Bot's reply does not clear it — it moves the preview and the recency and leaves
     * the row archived, so the answer to a question asked before the archive cannot undo the archive.
     * `get` deliberately does not filter on it either, which is what leaves an archived
     * conversation's URL working.
     *
     * ONE ROUTE-REACHABLE READ FILTERS ON IT TODAY: the roster's list. `mostRecent` filters too, and an
     * earlier version of this line called it "what the `?agent=` resolver lands on" — it is not. No
     * route mounts that method; the browser resolves `?agent=` over `/api/roster`'s active list with
     * its own rule (`mostRecentBotChat` in `app/src/routes/_authed/_app/bot.tsx`). Its filter is the
     * belt for a server-side resolver nobody has written, and this line pointed anybody changing
     * these semantics at a method nothing calls.
     *
     * Every row this table hands out carries the state as `archived`, so a row's menu can offer
     * Archive or Restore.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** When this was deleted, or null. Soft, like a channel's, and every read path filters on it. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * One chat per thread.
     *
     * This is the constraint that decides an adoption race. Two tabs holding the same remembered
     * thread id both try to adopt it; without this they succeed twice and one conversation becomes
     * two rows pointing at one transcript. The loser catches the violation and reads the winner.
     */
    uniqueIndex("bot_chats_thread_idx").on(table.threadId),
    /**
     * One person's conversations, most recent first.
     *
     * The leading `user_id` is most of what this buys. The reads that are not by id — `mostRecent`,
     * and the roster's bot chat branch — start from the owner and nothing else, and without it they
     * walk everybody's conversations to find one person's.
     *
     * The trailing expression rather than the column, because recency is the last thing said falling
     * back to when the conversation was made; it orders that person's rows inside the index, so
     * `mostRecent` reads them already in recency order instead of sorting everything the person has.
     * NOT "a walk that stops at the first row", which is what this line used to say: `mostRecent`
     * orders by `RECENCY desc, id desc` and `id` is not in this index, so the plan is `Limit →
     * Incremental Sort → Index Scan`. The sort is real. What the index buys is that it is incremental
     * — rows arrive grouped by equal recency, and under `limit 1` only the first such group is ever
     * sorted.
     *
     * The roster's branch is NOT that read either, though its shape looks the same: its sort key leads with
     * the pin, and `pinned_at` is not in this index, so that branch sorts. `roster/query.ts` says the
     * same thing from the query's side. A wider index could serve it — unlike a channel's, every part
     * of a bot chat's sort key is on this one table, so `(user_id, pin rank desc, recency desc, id
     * desc)` would answer that branch's own top-N from the index. It is not declared because what the
     * branch sorts is already one person's conversations under a per-branch limit: the wider index
     * would be earned by a profile of a deployment where that is a great many conversations, not by
     * this paragraph.
     *
     * Declared here rather than only in the migration. An index that exists in the database and not
     * in the schema is invisible to `generate`, so the next generated migration proposes a schema
     * without it and silently drops it.
     */
    index("bot_chats_recent_activity_idx").on(
      table.userId,
      sql`COALESCE(${table.lastMessageAt}, ${table.createdAt}) DESC`,
    ),
  ],
);
