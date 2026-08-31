/**
 * One roster over two kinds of conversation.
 *
 * TWO PHASES, AND THE UNION IS IN THE FIRST. `channels.list` is already built this way and its own
 * comment says why: the hydrated row set is one row per conversation-agent pair, so a limit applied
 * there "would cut a channel in half: its second Bot would arrive on the next page as a separate
 * entry with the same id." Phase 1 chooses the page — four narrow columns, the cursor, the order, the
 * limit. Phase 2 hydrates each kind with its own query. Phase 1's order is then the only ordering
 * authority in the module, which is the whole reason this file exists.
 *
 * WHY THE UNION IS CHEAP HERE. Both branches of phase 1 project the same four columns, with no arrays
 * and no aggregates, so it is a union of two identically-shaped narrow selects rather than of two
 * fully-hydrated ones.
 *
 * WHY ONE CURSOR IS ENOUGH. Ids are prefixed — `channel_...` and `botchat_...` — and therefore
 * globally unique, so `id` still breaks every tie and the cursor needs no `kind` term. That is the
 * one piece of luck in this design, and it is what lets the existing cursor codec serve a mixed list
 * unchanged.
 */
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { unionAll } from "drizzle-orm/pg-core";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  botChats,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";
import {
  decodeRosterCursor,
  encodeRosterCursor,
  pinnedRank,
  RECENCY,
  type RosterCursor,
  rosterOrder,
} from "./order";
import { DEFAULT_ROSTER_PAGE, MAX_ROSTER_PAGE } from "./preview";

export type RosterKind = "channel" | "bot_chat";
export type RosterStatus = "active" | "archived" | "all";

/** One row of the roster, whichever kind it came from. */
export type RosterItem = {
  kind: RosterKind;
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  /** Whether every Bot in this conversation is still around. False once one has been retired. */
  active: boolean;
  archived: boolean;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  lastMessageAgentId: string | null;
  createdAt: Date;
  pinned: boolean;
  lastReadAt: Date | null;
};

export type RosterPage = { items: RosterItem[]; nextCursor: string | null };
export type RosterQuery = {
  cursor?: string;
  limit?: number;
  status?: RosterStatus;
};

export type RosterStore = {
  list(actor: AgentActor, query?: RosterQuery): Promise<RosterPage>;
};

const STATUSES = new Set<RosterStatus>(["active", "archived", "all"]);

/**
 * Anything unrecognised reads as `"active"`.
 *
 * The same call `decodeRosterCursor` makes for a malformed cursor: the honest answer to a stale link
 * is the first page rather than a 400 a person cannot act on. A stale bookmark carrying a status this
 * deployment no longer has should show somebody their conversations, not an error.
 *
 * Case-sensitive, so the accepted set is exactly the three documented values and `ACTIVE` is a typo
 * rather than a second spelling anybody has to keep working.
 */
export function parseRosterStatus(
  value: string | null | undefined,
): RosterStatus {
  return value && STATUSES.has(value as RosterStatus)
    ? (value as RosterStatus)
    : "active";
}

/**
 * Most recent first, over `bot_chats`' own two columns.
 *
 * The same shape as `RECENCY` in `order.ts`, which is written against `channels` and says so, and the
 * same shape `bot-chats/store.ts` builds for its own reads. `bot_chats_recent_activity_idx` is
 * declared on this expression, so the ordering is an index read rather than a sort.
 */
const BOT_CHAT_RECENCY = sql`coalesce(${botChats.lastMessageAt}, ${botChats.createdAt})`;

/**
 * What the status means, as a predicate.
 *
 * One helper taking the column, so the two branches of the union cannot disagree about what
 * `archived` means — a roster where one kind honoured the filter and the other did not would look
 * exactly like an archive that does not work.
 *
 * `deletedAt` is filtered separately and unconditionally in both branches: `all` is a filter over
 * archive state only and is never a way to see deleted conversations.
 */
function archiveFilter(status: RosterStatus, archivedAt: PgColumn) {
  if (status === "active") return isNull(archivedAt);
  if (status === "archived") return isNotNull(archivedAt);
  return undefined;
}

/**
 * Where the page starts, as a predicate over whichever branch is asking.
 *
 * One row comparison over the whole sort key, which only reads as "everything after the cursor"
 * because every part of that key descends. See `rosterOrder`. The same comparison `channels.list`
 * makes; it takes the expressions rather than naming columns because the two kinds keep their pin and
 * their recency in different places.
 */
function cursorFilter(
  cursor: RosterCursor | undefined,
  rank: SQL,
  recency: SQL,
  id: PgColumn,
) {
  if (!cursor) return undefined;
  return sql`(${rank}, ${recency}, ${id}) < (${cursor.pinned ? 1 : 0}::int, ${cursor.recency}::timestamptz, ${cursor.id})`;
}

export function createRosterStore(database: Database): RosterStore {
  return {
    async list(actor, query = {}) {
      const limit = Math.min(
        Math.max(query.limit ?? DEFAULT_ROSTER_PAGE, 1),
        MAX_ROSTER_PAGE,
      );
      const status = query.status ?? "active";
      const cursor: RosterCursor | undefined = decodeRosterCursor(query.cursor);

      /*
       * PHASE 1: CHOOSE THE PAGE.
       *
       * drizzle's `unionAll`, not the raw-`sql` fallback the plan allowed for — with one wrinkle
       * worth naming, because it is the reason for the extra `select ... from` around the union.
       *
       * Postgres will only let a set operation's ORDER BY name the union's *output* columns:
       * `order by "channels"."id" desc` over a union is `invalid reference to FROM-clause entry`.
       * drizzle-orm 0.45.2 rewrites a bare column handed to a set operator's `orderBy` into an
       * unqualified identifier, but not one nested inside an expression, and `rosterOrder` nests all
       * three parts of the key. Ordering the union directly was therefore tried and does not run.
       *
       * Wrapping the union in a derived table fixes that without touching the sort rule: `roster`'s
       * columns are nameable from the enclosing select, so `rosterOrder` applies to the union's four
       * aliased output columns unchanged. Merging the two branches in TypeScript would have been the
       * other way out and is exactly what this module exists to prevent — it would put the sort rule
       * in a second place inside the file that owns it.
       */
      const channelBranch = database
        .select({
          kind: sql<RosterKind>`'channel'`.as("kind"),
          id: channels.id,
          recency: sql<Date>`${RECENCY}`.as("recency"),
          pinned: sql<boolean>`${channelMemberships.pinnedAt} is not null`.as(
            "pinned",
          ),
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .where(
          and(
            isNull(channels.deletedAt),
            archiveFilter(status, channels.archivedAt),
            cursorFilter(
              cursor,
              pinnedRank(channelMemberships.pinnedAt),
              RECENCY,
              channels.id,
            ),
          ),
        );

      const botChatBranch = database
        .select({
          kind: sql<RosterKind>`'bot_chat'`.as("kind"),
          id: botChats.id,
          recency: sql<Date>`${BOT_CHAT_RECENCY}`.as("recency"),
          pinned: sql<boolean>`${botChats.pinnedAt} is not null`.as("pinned"),
        })
        .from(botChats)
        .where(
          and(
            eq(botChats.userId, actor.id),
            isNull(botChats.deletedAt),
            archiveFilter(status, botChats.archivedAt),
            cursorFilter(
              cursor,
              pinnedRank(botChats.pinnedAt),
              BOT_CHAT_RECENCY,
              botChats.id,
            ),
          ),
        );

      const roster = unionAll(channelBranch, botChatBranch).as("roster");
      const page = await database
        .select({
          kind: roster.kind,
          id: roster.id,
          recency: roster.recency,
          pinned: roster.pinned,
        })
        .from(roster)
        .orderBy(
          ...rosterOrder(
            sql`${roster.pinned}`,
            sql`${roster.recency}`,
            roster.id,
          ),
        )
        // One more than asked for, so "is there another page" needs no second count query.
        .limit(limit + 1);

      const chosen = page.slice(0, limit);
      const last = chosen.at(-1);
      const nextCursor =
        page.length > limit && last
          ? encodeRosterCursor({
              pinned: last.pinned,
              recency: new Date(last.recency).toISOString(),
              id: last.id,
            })
          : null;

      if (chosen.length === 0) return { items: [], nextCursor: null };

      /*
       * PHASE 2: HYDRATE, ONE READ PER KIND.
       *
       * Each read covers only the ids phase 1 chose, and is skipped altogether when that kind chose
       * none: a person with no bot chats pays for one statement, not two.
       */
      const channelIds = chosen
        .filter((row) => row.kind === "channel")
        .map((row) => row.id);
      const botChatIds = chosen
        .filter((row) => row.kind === "bot_chat")
        .map((row) => row.id);

      const [channelItems, botChatItems] = await Promise.all([
        channelIds.length > 0
          ? hydrateChannels(database, actor, channelIds)
          : new Map<string, RosterItem>(),
        botChatIds.length > 0
          ? hydrateBotChats(database, actor, botChatIds)
          : new Map<string, RosterItem>(),
      ]);

      /*
       * Phase 1's order is the only ordering authority. Reassembling in its order rather than sorting
       * the hydrated rows again is what keeps the two phases from being able to disagree.
       *
       * `filter` rather than an assertion, because an absent row is legitimate rather than a bug:
       * phase 2 repeats the delete guard, so a conversation deleted between the two statements is
       * correctly missing here and dropping it is the answer. Throwing would turn somebody else's
       * ordinary delete into a failed page load.
       */
      const items = chosen
        .map((row) =>
          row.kind === "channel"
            ? channelItems.get(row.id)
            : botChatItems.get(row.id),
        )
        .filter((item): item is RosterItem => item !== undefined);

      return { items, nextCursor };
    },
  };
}

/**
 * The channel half of phase 2: the second query in `channels.list`, near-verbatim.
 *
 * Ordered by the agent id and nothing else. `channels.list` also orders this read by the sort key,
 * because it folds a run of rows into summaries as it walks them; here the fold is into a map keyed by
 * id and the order the page is drawn in comes from phase 1, so repeating the sort rule would be a
 * second copy of it in the module that exists to hold one. The agent order stays, because it is what
 * makes `agentIds` arrive in the same lexicographic order `ChannelStore.get` returns.
 */
async function hydrateChannels(
  database: Database,
  actor: AgentActor,
  ids: string[],
): Promise<Map<string, RosterItem>> {
  const rows = await database
    .select({
      id: channels.id,
      name: channels.name,
      agentId: channelAgents.agentId,
      threadId: intelligenceChannelMappings.threadId,
      deletedAt: agentProfiles.deletedAt,
      lastMessage: channels.lastMessage,
      lastMessageAt: channels.lastMessageAt,
      lastMessageAgentId: channels.lastMessageAgentId,
      createdAt: channels.createdAt,
      pinnedAt: channelMemberships.pinnedAt,
      lastReadAt: channelMemberships.lastReadAt,
      archivedAt: channels.archivedAt,
    })
    .from(channels)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, actor.id),
      ),
    )
    .innerJoin(
      intelligenceChannelMappings,
      and(
        eq(intelligenceChannelMappings.channelId, channels.id),
        eq(intelligenceChannelMappings.userId, actor.id),
      ),
    )
    .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, channelAgents.agentId))
    .where(
      and(
        inArray(channels.id, ids),
        // Repeated, not inherited from the query that chose the page: these are two statements on
        // two snapshots, so a delete that commits between them would otherwise hand back a
        // conversation this person can no longer see.
        isNull(channels.deletedAt),
      ),
    )
    .orderBy(asc(channelAgents.agentId));

  // One row per channel-agent pair, folded into one item per channel.
  const items = new Map<string, RosterItem>();
  for (const row of rows) {
    const item = items.get(row.id);
    if (item) {
      item.agentIds.push(row.agentId);
      item.active &&= row.deletedAt === null;
      continue;
    }
    items.set(row.id, {
      kind: "channel",
      id: row.id,
      name: row.name,
      agentIds: [row.agentId],
      threadId: row.threadId,
      active: row.deletedAt === null,
      archived: row.archivedAt !== null,
      lastMessage: row.lastMessage,
      lastMessageAt: row.lastMessageAt,
      lastMessageAgentId: row.lastMessageAgentId,
      createdAt: row.createdAt,
      pinned: row.pinnedAt !== null,
      lastReadAt: row.lastReadAt,
    });
  }
  return items;
}

/**
 * The bot chat half of phase 2. One row per conversation, so there is nothing to fold.
 *
 * Two joins rather than the one the plan sketched, because the two facts live apart: the Bot's name is
 * on `agents`, and its retirement is the soft delete on `agent_profiles`. `bot-chats/store.ts` joins
 * the profile the same way, and for the same reason a channel does — a retired Bot leaves the
 * conversation readable and merely reports its coworker as gone.
 */
async function hydrateBotChats(
  database: Database,
  actor: AgentActor,
  ids: string[],
): Promise<Map<string, RosterItem>> {
  const rows = await database
    .select({
      id: botChats.id,
      title: botChats.title,
      agentName: agents.name,
      agentId: botChats.agentId,
      threadId: botChats.threadId,
      profileDeletedAt: agentProfiles.deletedAt,
      lastMessage: botChats.lastMessage,
      lastMessageAt: botChats.lastMessageAt,
      lastMessageAgentId: botChats.lastMessageAgentId,
      createdAt: botChats.createdAt,
      pinnedAt: botChats.pinnedAt,
      lastReadAt: botChats.lastReadAt,
      archivedAt: botChats.archivedAt,
    })
    .from(botChats)
    .innerJoin(agents, eq(agents.id, botChats.agentId))
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, botChats.agentId))
    .where(
      and(
        inArray(botChats.id, ids),
        // Repeated for the reason the channel hydration above gives: two statements, two snapshots.
        // The ownership term is repeated with it, since it is the same class of guard.
        eq(botChats.userId, actor.id),
        isNull(botChats.deletedAt),
      ),
    );

  return new Map(
    rows.map((row) => [
      row.id,
      {
        kind: "bot_chat" as const,
        id: row.id,
        // The Bot's name until the person has said something. A conversation with nothing in it has
        // no subject to name it after.
        name: row.title ?? row.agentName,
        agentIds: [row.agentId],
        threadId: row.threadId,
        active: row.profileDeletedAt === null,
        archived: row.archivedAt !== null,
        lastMessage: row.lastMessage,
        lastMessageAt: row.lastMessageAt,
        lastMessageAgentId: row.lastMessageAgentId,
        createdAt: row.createdAt,
        pinned: row.pinnedAt !== null,
        lastReadAt: row.lastReadAt,
      },
    ]),
  );
}
