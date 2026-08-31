/**
 * One roster over two kinds of conversation.
 *
 * TWO PHASES, AND THE UNION IS IN THE FIRST. `channels.list` is already built this way and its own
 * comment says why: the hydrated row set is one row per conversation-agent pair, so a limit applied
 * there "would cut a channel in half: its second Bot would arrive on the next page as a separate
 * entry with the same id." Phase 1 chooses the page — five narrow columns, the cursor, the order, the
 * limit. Phase 2 hydrates each kind with its own query. Phase 1's order is then the only ordering
 * authority in the module, which is the whole reason this file exists.
 *
 * WHICH MEANS PHASE 1 HAS TO DECIDE VISIBILITY ON ITS OWN. Anything phase 2 requires that phase 1
 * does not is a row phase 1 can choose and phase 2 cannot produce: it is dropped, and it keeps
 * consuming its slot on every page for as long as the condition holds. So every term that decides
 * whether a person can see a conversation is in phase 1, and phase 2's remaining joins are the ones
 * that only add facts — left joins, so a missing fact costs a fact rather than the row.
 *
 * WHY THE UNION IS CHEAP HERE. Both branches of phase 1 project the same five columns, with no arrays
 * and no aggregates, so it is a union of two identically-shaped narrow selects rather than of two
 * fully-hydrated ones — and each branch is ordered and limited before the union rather than after it.
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
  exists,
  inArray,
  isNotNull,
  isNull,
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
  recencyCursorText,
  recencyOf,
  rosterCursorFilter,
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
 * Built by `recencyOf`, the same function `RECENCY` is built by, so the two cannot come to mean
 * different things. `bot_chats_recent_activity_idx` is declared on `(user_id, this expression desc)`,
 * which serves `BotChatStore.mostRecent` because that read leads with recency. It does not serve this
 * module's ordering; see the note on the union below for why not.
 */
const BOT_CHAT_RECENCY = recencyOf(botChats.lastMessageAt, botChats.createdAt);

/**
 * What the status means, as a predicate.
 *
 * One helper taking the column, so the two branches of the union cannot disagree about what
 * `archived` means — a roster where one kind honoured the filter and the other did not would look
 * exactly like an archive that does not work. Phase 2 applies it again for the reason it repeats the
 * delete guard: two statements, two snapshots.
 *
 * `deletedAt` is filtered separately and unconditionally everywhere: `all` is a filter over archive
 * state only and is never a way to see deleted conversations.
 *
 * Exported for `ChannelStore.list`, which answers the same `?status=` over one of these two tables.
 * It was left private and a second spelling of these three lines duly appeared there within the
 * hour — the same drift this module's own header warns about, so the reason it is exported now is
 * that being right twice is not a thing anybody maintains.
 */
export function archiveFilter(status: RosterStatus, archivedAt: PgColumn) {
  if (status === "active") return isNull(archivedAt);
  if (status === "archived") return isNotNull(archivedAt);
  return undefined;
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
       * columns are nameable from the enclosing select, so `rosterOrder` applies to the union's
       * aliased output columns unchanged. Merging the two branches in TypeScript would have been the
       * other way out and is exactly what this module exists to prevent — it would put the sort rule
       * in a second place inside the file that owns it.
       *
       * EACH BRANCH CARRIES THE ORDER AND THE LIMIT TOO. A branch's own `orderBy`/`limit` is an
       * ordinary select's, not a set operator's, and drizzle parenthesises each branch — `(select ...
       * order by ... limit $2) union all (select ... order by ... limit $4)` — so the bounds bind per
       * branch rather than to the whole set operation. Without them both branches were unbounded:
       * Postgres read every channel this person is in and every bot chat they own, sorted the whole
       * union, and threw away all but `limit + 1` rows on every sidebar draw, which is the cost
       * `DEFAULT_ROSTER_PAGE` exists to remove. The outer sort and limit stay, because each branch
       * only knows its own top-N. That is exact rather than approximate: a row that loses to
       * `limit + 1` rows of its own kind cannot be in the top `limit + 1` overall, so the global
       * top-N is always contained in the union of the per-branch top-Ns, and the outer select
       * re-sorts at most `2 * (limit + 1)` rows.
       *
       * NEITHER BRANCH'S ORDERING IS AN INDEX READ, and an earlier version of this comment claimed
       * it was. `channels_recent_activity_idx` and `bot_chats_recent_activity_idx` are declared on
       * the recency expression, but this sort key *leads* with the pin, which is in neither index and,
       * for a channel, is not even in the same table. Both branches sort. What keeps that affordable
       * is the per-branch limit and the fact that each branch is already narrowed to one person's
       * conversations.
       */
      const channelBranch = database
        .select({
          kind: sql<RosterKind>`'channel'`.as("kind"),
          id: channels.id,
          recency: sql<Date>`${RECENCY}`.as("recency"),
          // The sort key's timestamp as text, at Postgres' own precision, because a `Date` cannot
          // hold it. See `recencyCursorText`; this column is the only thing the cursor is minted
          // from, and the `recency` column above exists solely for the outer ORDER BY.
          recencyKey: recencyCursorText(RECENCY).as("recency_key"),
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
            /*
             * The thread mapping decides visibility, so it is decided here.
             *
             * A roster row carries a `threadId`, and `hydrateChannels` gets it by joining
             * `intelligence_channel_mappings` on this channel and this person: a channel without
             * that row cannot become a roster item at all. Leaving the term out of phase 1 meant
             * phase 1 could choose such a channel, phase 2 could not build it, and the row was
             * dropped while still occupying its slot on every page — invisibly and for as long as
             * the mapping was missing.
             *
             * `exists` rather than a join, because nothing in this branch reads the mapping's
             * columns and the primary key on `(user_id, channel_id)` answers it directly.
             */
            exists(
              database
                .select({ present: sql`1` })
                .from(intelligenceChannelMappings)
                .where(
                  and(
                    eq(intelligenceChannelMappings.channelId, channels.id),
                    eq(intelligenceChannelMappings.userId, actor.id),
                  ),
                ),
            ),
            rosterCursorFilter(
              cursor,
              pinnedRank(channelMemberships.pinnedAt),
              RECENCY,
              channels.id,
            ),
          ),
        )
        .orderBy(
          ...rosterOrder(
            pinnedRank(channelMemberships.pinnedAt),
            RECENCY,
            channels.id,
          ),
        )
        .limit(limit + 1);

      const botChatBranch = database
        .select({
          kind: sql<RosterKind>`'bot_chat'`.as("kind"),
          id: botChats.id,
          recency: sql<Date>`${BOT_CHAT_RECENCY}`.as("recency"),
          recencyKey: recencyCursorText(BOT_CHAT_RECENCY).as("recency_key"),
          pinned: sql<boolean>`${botChats.pinnedAt} is not null`.as("pinned"),
        })
        .from(botChats)
        .where(
          and(
            eq(botChats.userId, actor.id),
            isNull(botChats.deletedAt),
            archiveFilter(status, botChats.archivedAt),
            rosterCursorFilter(
              cursor,
              pinnedRank(botChats.pinnedAt),
              BOT_CHAT_RECENCY,
              botChats.id,
            ),
          ),
        )
        .orderBy(
          ...rosterOrder(
            pinnedRank(botChats.pinnedAt),
            BOT_CHAT_RECENCY,
            botChats.id,
          ),
        )
        .limit(limit + 1);

      const roster = unionAll(channelBranch, botChatBranch).as("roster");
      const page = await database
        .select({
          kind: roster.kind,
          id: roster.id,
          recencyKey: roster.recencyKey,
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
      /*
       * Postgres' own rendering of the boundary, handed back untouched.
       *
       * `new Date(last.recency).toISOString()` was what stood here, and it is the whole of the bug
       * `recencyCursorText` documents: a `Date` floors the boundary to milliseconds and the next
       * page's strict `<` then excludes every row inside the discarded remainder. The `recency`
       * column is deliberately not selected above, so there is no `Date` in scope to reach for.
       */
      const nextCursor =
        page.length > limit && last
          ? encodeRosterCursor({
              pinned: last.pinned,
              recency: last.recencyKey,
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
          ? hydrateChannels(database, actor, status, channelIds)
          : new Map<string, RosterItem>(),
        botChatIds.length > 0
          ? hydrateBotChats(database, actor, status, botChatIds)
          : new Map<string, RosterItem>(),
      ]);

      /*
       * Phase 1's order is the only ordering authority. Reassembling in its order rather than sorting
       * the hydrated rows again is what keeps the two phases from being able to disagree.
       *
       * `filter` rather than an assertion, because an absent row is still legitimate: phase 2 repeats
       * the delete guard and the archive filter, so a conversation somebody deleted or archived
       * between the two statements is correctly missing here and dropping it is the answer. Throwing
       * would turn somebody else's ordinary delete into a failed page load.
       */
      const hydrated = chosen.map((row) => ({
        id: row.id,
        item:
          row.kind === "channel"
            ? channelItems.get(row.id)
            : botChatItems.get(row.id),
      }));
      const items = hydrated
        .map((row) => row.item)
        .filter((item): item is RosterItem => item !== undefined);

      /*
       * A drop leaves a record, because the last time this went wrong nothing did.
       *
       * The paragraph above used to assert that a concurrent delete was the only way to get here,
       * and it was not: phase 2 required joins phase 1 did not, so a row could be unhydratable
       * permanently rather than for the width of a race. That is fixed above by making phase 1 decide
       * visibility, but the assertion is the part that made it invisible for as long as it lasted. So
       * the claim is now checked at runtime as well as argued: under a concurrent delete or archive
       * this line appears once and never again for that row, and any other cause repeats it on every
       * read of that page.
       */
      if (items.length !== chosen.length) {
        console.error(
          JSON.stringify({
            type: "roster-rows-not-hydrated",
            actorUserId: actor.id,
            status,
            chosen: chosen.length,
            hydrated: items.length,
            ids: hydrated.filter((row) => !row.item).map((row) => row.id),
            note: "Phase 1 chose these conversations and phase 2 could not rebuild them. Expected once for a conversation deleted or archived between the two statements; repeated for the same id means the two phases disagree about who can see what.",
          }),
        );
      }

      return { items, nextCursor };
    },
  };
}

/**
 * The channel half of phase 2: the second query in `channels.list`, near-verbatim apart from which
 * joins are inner.
 *
 * Ordered by the agent id and nothing else. `channels.list` also orders this read by the sort key,
 * because it folds a run of rows into summaries as it walks them; here the fold is into a map keyed by
 * id and the order the page is drawn in comes from phase 1, so repeating the sort rule would be a
 * second copy of it in the module that exists to hold one. The agent order stays, because it is what
 * makes `agentIds` arrive in the same lexicographic order `ChannelStore.get` returns.
 *
 * `channel_agents` and `agent_profiles` are joined loosely. They say which Bots are in the channel
 * and whether each is still around, which are facts about the row rather than reasons to hide it, and
 * `channel_agents` is deleted and reinserted wholesale on every tenant-package sync — an inner join
 * therefore made a channel vanish from the sidebar for the length of a sync, and for good if the
 * package no longer names any Bot for it. `bot-chats/store.ts` joins the profile loosely for the same
 * class of reason: an inner join answers a question about the row with the absence of the row.
 */
async function hydrateChannels(
  database: Database,
  actor: AgentActor,
  status: RosterStatus,
  ids: string[],
): Promise<Map<string, RosterItem>> {
  const rows = await database
    .select({
      id: channels.id,
      name: channels.name,
      agentId: channelAgents.agentId,
      profileAgentId: agentProfiles.agentId,
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
    .leftJoin(channelAgents, eq(channelAgents.channelId, channels.id))
    .leftJoin(agentProfiles, eq(agentProfiles.agentId, channelAgents.agentId))
    .where(
      and(
        inArray(channels.id, ids),
        // Repeated, not inherited from the query that chose the page: these are two statements on
        // two snapshots, so a delete or an archive that commits between them would otherwise hand
        // back a conversation this person can no longer see, or hand an archived one to a page that
        // asked for active conversations and would render it as one.
        isNull(channels.deletedAt),
        archiveFilter(status, channels.archivedAt),
      ),
    )
    .orderBy(asc(channelAgents.agentId));

  // One row per channel-agent pair, folded into one item per channel — or a single row with no agent
  // on it, for a channel that currently has none.
  const items = new Map<string, RosterItem>();
  for (const row of rows) {
    const present = row.agentId !== null;
    // A Bot is around when it has a profile and that profile has not been soft-deleted. With the
    // profile joined loosely, a missing one is a Bot that was never registered as a coworker, which
    // is not something to report as present.
    const around = row.profileAgentId !== null && row.deletedAt === null;
    const item = items.get(row.id);
    if (item) {
      if (present) {
        item.agentIds.push(row.agentId as string);
        item.active &&= around;
      }
      continue;
    }
    items.set(row.id, {
      kind: "channel",
      id: row.id,
      name: row.name,
      agentIds: present ? [row.agentId as string] : [],
      threadId: row.threadId,
      // Vacuously true for a channel with no Bots in it: there is none to report as gone.
      active: present ? around : true,
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
 * on `agents`, and its retirement is the soft delete on `agent_profiles`. The name is joined tightly
 * because `bot_chats.agent_id` is `not null` and references `agents.id`, so the row is always there;
 * the profile is joined loosely, the way `BotChatStore.adopt` joins it, because whether a Bot has a
 * profile is something to report and not a reason to withhold the conversation.
 * That is the same thing a channel reports about a deleted coworker, and it is what keeps a
 * retirement from silently taking a transcript with it.
 */
async function hydrateBotChats(
  database: Database,
  actor: AgentActor,
  status: RosterStatus,
  ids: string[],
): Promise<Map<string, RosterItem>> {
  const rows = await database
    .select({
      id: botChats.id,
      title: botChats.title,
      agentName: agents.name,
      agentId: botChats.agentId,
      profileAgentId: agentProfiles.agentId,
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
    .leftJoin(agentProfiles, eq(agentProfiles.agentId, botChats.agentId))
    .where(
      and(
        inArray(botChats.id, ids),
        // Repeated for the reason the channel hydration above gives: two statements, two snapshots.
        // The ownership term is repeated with it, since it is the same class of guard.
        eq(botChats.userId, actor.id),
        isNull(botChats.deletedAt),
        archiveFilter(status, botChats.archivedAt),
      ),
    );

  return new Map(
    rows.map((row) => [
      row.id,
      {
        kind: "bot_chat" as const,
        id: row.id,
        /*
         * The Bot's name until the person has said something. A conversation with nothing in it has
         * no subject to name it after.
         *
         * The fallback fires on `""` as well as on null, because `??` does not: a title that
         * flattened to nothing left the row rendering nameless. `titleOf` returns null for that case
         * today, so this is belt as well as braces — but a stored `""` predates that and outlives it,
         * and a roster row that renders as no name at all is worth two conditions.
         */
        name: row.title || row.agentName,
        agentIds: [row.agentId],
        threadId: row.threadId,
        active: row.profileAgentId !== null && row.profileDeletedAt === null,
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
