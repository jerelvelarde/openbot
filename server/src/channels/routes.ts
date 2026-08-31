import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import { type AuditStore, createAuditRecorder } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  agentProfiles,
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
  rosterCursorFilter,
  rosterOrder,
} from "../roster/order";
import {
  DEFAULT_ROSTER_PAGE,
  MAX_ROSTER_PAGE,
  previewOf,
} from "../roster/preview";
import {
  archiveFilter,
  parsePageLimit,
  parseRosterStatus,
  type RosterStatus,
} from "../roster/query";
import {
  CHANNEL_ACTIVITY_TOPIC,
  type ChannelEventHub,
  type RosterActivityEvent,
} from "./events";
import { upgradeWebSocket } from "./socket";
import type { ThreadIdentity } from "./thread-identity";

export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  /**
   * Whether the channel is archived, for every member of it.
   *
   * Reported rather than filtered on a read of one channel: archived is hidden from a roster, not
   * from a direct read, and the URL of an archived conversation still opens it — that is what makes
   * archiving reversible rather than a deletion wearing a gentler name. So the flag has to travel on
   * the row instead, or a caller holding one cannot tell an archived channel from an active one.
   * `BotChatStore.get` reports it the same way, and the roster carries the same field for both kinds.
   */
  archived: boolean;
};

/** A channel plus the last thing said in it, which is what a roster renders. */
export type ChannelSummary = AgentChannel & {
  lastMessage: string | null;
  lastMessageAt: Date | null;
  lastMessageAgentId: string | null;
  createdAt: Date;
  /** Whether the caller pinned this channel. A pin is per-member, so this is the caller's, only. */
  pinned: boolean;
  /** When the caller last had this channel open, or null for never. The caller's, only. */
  lastReadAt: Date | null;
};

/** What a client that ran an agent reports back about the message it just saw. */
export type ChannelActivity = {
  text: string;
  /** The agent that said it, or null when a person did. */
  agentId: string | null;
  at: Date;
};

/** One page of somebody's channels, newest activity first. */
export type ChannelPage = {
  channels: ChannelSummary[];
  /** Where the next page starts, or null at the end. */
  nextCursor: string | null;
};

/**
 * What one page of channels asks for.
 *
 * `status` is the roster's own filter, spelled the same way and parsed by the same function, because
 * this endpoint answers about the same rows: a channel that `GET /api/roster?status=archived` shows
 * and `GET /api/channels?status=archived` does not is one archive feature implemented twice with two
 * different answers.
 */
export type ChannelQuery = {
  cursor?: string;
  limit?: number;
  status?: RosterStatus;
};

/** What `recordActivity` did, for the caller that has to write it down. */
export type ChannelActivityOutcome = {
  /**
   * Whether this report is what brought an archived channel back.
   *
   * An object rather than a bare boolean because the route reads it by name: `restored` is the fact
   * the audit row is written from, and a bare `true` at that call site says nothing about which fact
   * it is.
   */
  restored: boolean;
};

const PINNED_RANK = pinnedRank(channelMemberships.pinnedAt);
const ROSTER_ORDER = rosterOrder(PINNED_RANK, RECENCY, channels.id);

export type ChannelStore = {
  create(actor: AgentActor, agentIds: string[]): Promise<AgentChannel>;
  get(actor: AgentActor, channelId: string): Promise<AgentChannel | null>;
  list(actor: AgentActor, query?: ChannelQuery): Promise<ChannelPage>;
  /** Pin or unpin the caller's own membership. Throws ChannelNotFoundError for a non-member. */
  setPinned(
    actor: AgentActor,
    channelId: string,
    pinned: boolean,
  ): Promise<void>;
  /** Stamp the caller's own membership as read now. Throws ChannelNotFoundError for a non-member. */
  markRead(actor: AgentActor, channelId: string): Promise<void>;
  /**
   * Hide the channel for every member. Soft: the row and the thread survive, every read filters.
   * Throws ChannelNotFoundError for a non-member, an unknown channel, or one already deleted, and
   * ChannelPackageOwnedError for a channel the tenant package defines, which configuration owns
   * rather than any member.
   */
  softDelete(actor: AgentActor, channelId: string): Promise<void>;
  /**
   * Archive or restore the channel for every member. Hidden, not frozen: the conversation stays
   * live, and `recordActivity` clears the archive on its own.
   *
   * Throws ChannelNotFoundError for a non-member, an unknown channel, or a deleted one, and
   * ChannelPackageOwnedError for a channel the tenant package defines.
   *
   * Returns whether anything actually changed.
   *
   * The route needs to know, because it audits the act: a repeat call that neither restamps nor
   * announces must not write a trail row either. `record`'s own docblock says the trail records acts,
   * not attempts, and `softDelete` enforces that by throwing on a repeat — this one returns instead.
   */
  setArchived(
    actor: AgentActor,
    channelId: string,
    archived: boolean,
  ): Promise<boolean>;
  /**
   * Record the last thing said, and bring the channel back if it was archived.
   *
   * Throws ChannelNotFoundError for a non-member, an unknown channel, or a deleted one.
   *
   * Reports whether it restored an archive, for the same reason `setArchived` reports whether it
   * changed anything: the route audits the act, and an unarchiving that happens here is as real as
   * one somebody clicked. A store method cannot write that row itself — this store holds no audit
   * trail — so it has to be able to say what it did.
   */
  recordActivity(
    actor: AgentActor,
    channelId: string,
    activity: ChannelActivity,
  ): Promise<ChannelActivityOutcome>;
};

const PRIVATE_AGENT_CHANNEL_DESCRIPTION = "Private agent channel.";
const MAX_CHANNEL_NAME_CODE_POINTS = 120;

function channelName(names: string[]) {
  const joined = names.join(", ");
  const codePoints = Array.from(joined);
  if (codePoints.length <= MAX_CHANNEL_NAME_CODE_POINTS) return joined;
  return `${codePoints.slice(0, MAX_CHANNEL_NAME_CODE_POINTS - 1).join("")}…`;
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * How much of one `NOTIFY` payload this file will build before it splits it.
 *
 * Postgres refuses a payload over 8000 bytes. Everything below the gap is a deliberate margin: the
 * count is bytes of UTF-8 as measured, and the refusal is on the server's own encoding of the same
 * string, so a budget at the exact limit would be a bet on the two agreeing to the byte.
 *
 * Exported so a test asserts against this budget rather than against Postgres' hard limit. A test
 * that only checks 8000 passes while the margin erodes to nothing, which is the whole of what the
 * margin is for.
 */
export const MAX_NOTIFY_PAYLOAD_BYTES = 7000;

/**
 * One roster announcement, split into payloads each of which fits.
 *
 * WHAT IS BOUNDED AND WHAT IS NOT. Of the fields an event carries, all but one are fixed or capped:
 * `lastMessage` comes from `previewOf`, which caps it at 200 code points, and the ids are one
 * channel id, one agent id and a handful of short literals. `memberIds` is the exception — it is one
 * id per member of the channel, and nothing bounds how many members a channel has. A single payload
 * naming all of them passes 8000 bytes somewhere around two hundred members, and because `pg_notify`
 * runs inside the transaction that wrote the row, the refusal does not lose the announcement: it
 * rolls back the write. Every message, archive and delete in a channel that size would fail
 * permanently and surface as an opaque 500.
 *
 * So the member list is what gets split, and the payload's size is bounded by measuring it rather
 * than by an argument about the half of it that happens to be short. The chunks partition the list:
 * `channel_memberships` is keyed on `(channel_id, user_id)`, so a member appears in it once, appears
 * in exactly one chunk, and hears the change exactly once. A second copy would be a second refetch
 * of the whole roster for nothing.
 *
 * At least one id goes in every payload even when the base event alone is near the budget, which is
 * what makes this terminate rather than loop. It cannot be reached by anything this file sends: the
 * capped fields above come to a few hundred bytes.
 */
export function announcementPayloads(event: RosterActivityEvent): string[] {
  const payloads: string[] = [];
  let batch: string[] = [];
  let batchBytes = Buffer.byteLength(
    JSON.stringify({ ...event, memberIds: [] }),
  );

  for (const memberId of event.memberIds) {
    // The comma as well as the id, because that is what the array actually costs per entry after the
    // first, and the first is charged a comma it does not use.
    const cost = Buffer.byteLength(JSON.stringify(memberId)) + 1;
    if (batch.length > 0 && batchBytes + cost > MAX_NOTIFY_PAYLOAD_BYTES) {
      payloads.push(JSON.stringify({ ...event, memberIds: batch }));
      batch = [];
      batchBytes = Buffer.byteLength(
        JSON.stringify({ ...event, memberIds: [] }),
      );
    }
    batch.push(memberId);
    batchBytes += cost;
  }
  if (batch.length > 0) {
    payloads.push(JSON.stringify({ ...event, memberIds: batch }));
  }
  return payloads;
}

/**
 * Announce a roster change on the caller's own transaction.
 *
 * On the transaction rather than the pool, always, so the announcement rides the commit: a write
 * that rolls back is never announced, and a refused one announces nothing at all.
 *
 * Exported for `bot-chats/store.ts`, which announces onto the same topic for the same roster. A
 * `pg_notify` built inline there is a second answer to the size question `announcementPayloads`
 * already answers by measuring, and the two kinds of row are read by one sidebar.
 */
export async function announce(
  transaction: Pick<Transaction, "execute">,
  event: RosterActivityEvent,
): Promise<void> {
  for (const payload of announcementPayloads(event)) {
    await transaction.execute(
      sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${payload})`,
    );
  }
}

export function createChannelStore(
  database: Database,
  profileStore: AgentProfileStore,
  threadIdentity: ThreadIdentity,
): ChannelStore {
  return {
    create(actor, agentIds) {
      return database.transaction(
        async (transaction) => {
          // Validated on this transaction, not through `profileStore.get`: the read has to share
          // the connection this transaction already holds, and has to hold the profile so an agent
          // cannot be deleted between passing the check and being linked to the new channel.
          //
          // Locks are taken in agent-ID order. Two channels selecting the same pair of agents in
          // opposite orders would otherwise be able to deadlock against each other.
          const profilesById = new Map<string, AgentProfile>();
          for (const agentId of [...agentIds].sort()) {
            const profile = await profileStore.getWithin(
              transaction,
              actor,
              agentId,
            );
            if (!profile) throw new AgentNotFoundError(agentId);
            profilesById.set(agentId, profile);
          }

          const id = `channel_${crypto.randomUUID()}`;
          // Minted rather than a bare random id, so the thread says which deployment it belongs to
          // in a project that may hold more than one. See thread-identity.ts.
          const threadId = threadIdentity.mint();
          // Named from the ids as they were passed. Anything arriving over HTTP has been through
          // `parseChannelInput`, which sorts them, so a channel created that way is named in the same
          // order `get` and `list` return its agents in; a caller into the store that passes its own
          // ordering is named in that ordering instead.
          const name = channelName(
            agentIds.map((agentId) => {
              const profile = profilesById.get(agentId);
              if (!profile) throw new AgentNotFoundError(agentId);
              return profile.name;
            }),
          );

          await transaction.insert(channels).values({
            id,
            name,
            description: PRIVATE_AGENT_CHANNEL_DESCRIPTION,
          });
          await transaction.insert(channelMemberships).values({
            channelId: id,
            userId: actor.id,
          });
          await transaction
            .insert(channelAgents)
            .values(agentIds.map((agentId) => ({ channelId: id, agentId })));
          await transaction.insert(intelligenceChannelMappings).values({
            userId: actor.id,
            channelId: id,
            threadId,
          });

          // Nothing is born archived: `archived_at` defaults to null and the insert above does not
          // set it.
          return {
            id,
            name,
            agentIds,
            threadId,
            active: true,
            archived: false,
          };
        },
        { isolationLevel: "read committed" },
      );
    },

    async get(actor, channelId) {
      const rows = await database
        .select({
          id: channels.id,
          name: channels.name,
          agentId: channelAgents.agentId,
          profileAgentId: agentProfiles.agentId,
          threadId: intelligenceChannelMappings.threadId,
          deletedAt: agentProfiles.deletedAt,
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
        /*
         * The Bots are joined loosely, because they are a fact about the channel rather than a
         * condition of its existence.
         *
         * `channel_agents` is deleted and reinserted on every tenant-package sync, so a channel with
         * no rows there is reachable, and an inner join answered "does this channel exist" with the
         * absence of a Bot row: opening it during a sync was a 404, and for good if the package no
         * longer names a Bot for it. `roster/query.ts`'s `hydrateChannels` and `bot-chats/store.ts`
         * join the same way for the same reason, so all three now agree about whether such a
         * conversation exists.
         *
         * The thread mapping stays an inner join: a channel with no mapping for this person has no
         * thread to open, which is a different thing from having no Bots, and the store has always
         * answered `null` for it.
         */
        .leftJoin(channelAgents, eq(channelAgents.channelId, channels.id))
        .leftJoin(
          agentProfiles,
          eq(agentProfiles.agentId, channelAgents.agentId),
        )
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .orderBy(asc(channelAgents.agentId));

      const first = rows[0];
      if (!first) return null;

      const linked = rows.filter((row) => row.agentId !== null);
      return {
        id: first.id,
        name: first.name,
        agentIds: linked.map((row) => row.agentId as string),
        threadId: first.threadId,
        // A Bot is around when it has a profile and that profile has not been soft-deleted: with the
        // profile joined loosely a null `deletedAt` means either of two things, and only one of them
        // is a Bot that is still there. Vacuously true for a channel with no Bots — there is none to
        // report as gone.
        active: linked.every(
          (row) => row.profileAgentId !== null && row.deletedAt === null,
        ),
        // Reported, not filtered on. See `AgentChannel.archived`: this read is how an archived
        // conversation is opened again.
        archived: first.archivedAt !== null,
      };
    },

    async list(actor, query = {}) {
      const limit = Math.min(
        Math.max(query.limit ?? DEFAULT_ROSTER_PAGE, 1),
        MAX_ROSTER_PAGE,
      );
      const cursor: RosterCursor | undefined = decodeRosterCursor(query.cursor);
      const status = query.status ?? "active";

      /*
       * The page of channels is chosen first, and the agents are joined to that page.
       *
       * The row set below is one row per channel-agent pair, so a limit on rows would cut a channel
       * in half: its second Bot would arrive on the next page as a separate entry with the same id.
       * Limiting the channels and then joining keeps a channel whole whatever it holds.
       */
      const page = await database
        .select({
          id: channels.id,
          // Postgres' own rendering of the sort key's timestamp, carried as text. Never a `Date`:
          // see `recencyCursorText` for the page boundary a millisecond `Date` used to floor, and the
          // rows inside the discarded remainder that were then served on no page at all.
          recencyKey: recencyCursorText(RECENCY),
          pinned: sql<boolean>`${channelMemberships.pinnedAt} is not null`,
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
             * The thread mapping decides visibility, so it is decided here, where the page is chosen.
             *
             * A summary carries a `threadId`, and the statement below gets it by inner-joining
             * `intelligence_channel_mappings` on this channel and this person: a channel without that
             * row cannot become a summary at all. Left out of this statement, this statement could
             * choose such a channel, the one below could not rebuild it, and the row was dropped
             * while still occupying its slot on every page — invisibly, and for as long as the
             * mapping was missing rather than for the width of a race. A page of one holding only
             * that channel came back empty with a live cursor, and a client that stops at an empty
             * page shows no conversations at all.
             *
             * `exists` rather than a join, because nothing here reads the mapping's columns and the
             * primary key on `(user_id, channel_id)` answers it directly. `roster/query.ts` guards
             * its own channel branch with the same term, for the same reason.
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
            // Built by the roster's own function over this query's own expressions, so the two reads
            // cannot come to page by different rules. Absent cursor, absent predicate.
            rosterCursorFilter(cursor, PINNED_RANK, RECENCY, channels.id),
          ),
        )
        .orderBy(...ROSTER_ORDER)
        // One more than asked for, so "is there another page" needs no second count query.
        .limit(limit + 1);

      const wanted = page.slice(0, limit);
      const last = wanted.at(-1);
      const nextCursor =
        page.length > limit && last
          ? encodeRosterCursor({
              pinned: last.pinned,
              // Handed on exactly as Postgres wrote it, unparsed. The `Date` round trip that used to
              // be here is the defect `recencyCursorText` exists to remove.
              recency: last.recencyKey,
              id: last.id,
            })
          : null;

      if (wanted.length === 0) return { channels: [], nextCursor: null };

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
          archivedAt: channels.archivedAt,
          pinnedAt: channelMemberships.pinnedAt,
          lastReadAt: channelMemberships.lastReadAt,
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
        // Loosely, for the reason `get` gives at length: a channel mid-package-sync has no
        // `channel_agents` rows, and an inner join here dropped it after phase 1 had already spent
        // its slot on the page — so it was invisible and it wasted a row of every page it belonged
        // to, permanently. Every join that is still inner above is matched by a term in the statement
        // that chose the page, which is what leaves a concurrent write as the only way to lose a row
        // here. `roster/query.ts` chose the page the same way and hydrates it the same way.
        .leftJoin(channelAgents, eq(channelAgents.channelId, channels.id))
        .leftJoin(
          agentProfiles,
          eq(agentProfiles.agentId, channelAgents.agentId),
        )
        .where(
          and(
            inArray(
              channels.id,
              wanted.map((row) => row.id),
            ),
            // Repeated, not inherited from the query that chose the page: these are two statements
            // on two snapshots, so a delete or an archive that commits between them would otherwise
            // hand back a channel this person can no longer see, or one that has just left the list
            // being read.
            isNull(channels.deletedAt),
            archiveFilter(status, channels.archivedAt),
          ),
        )
        // The same order the page was chosen in, since the rows below are read in order.
        .orderBy(...ROSTER_ORDER, asc(channelAgents.agentId));

      // One row per channel-agent pair — or one row with no agent on it, for a channel that has none
      // — folded into one summary each. The ordering above keeps a channel's rows together and its
      // agents in the same lexicographic order `get` returns.
      const summaries = new Map<string, ChannelSummary>();
      for (const row of rows) {
        const linked = row.agentId !== null;
        // Both halves, for the reason `get` gives: with the profile joined loosely a null
        // `deletedAt` means either "still here" or "never registered as a coworker".
        const around = row.profileAgentId !== null && row.deletedAt === null;
        const summary = summaries.get(row.id);
        if (summary) {
          if (linked) {
            summary.agentIds.push(row.agentId as string);
            summary.active &&= around;
          }
          continue;
        }
        summaries.set(row.id, {
          id: row.id,
          name: row.name,
          agentIds: linked ? [row.agentId as string] : [],
          threadId: row.threadId,
          // Vacuously true for a channel with no Bots in it: there is none to report as gone.
          active: linked ? around : true,
          archived: row.archivedAt !== null,
          lastMessage: row.lastMessage,
          lastMessageAt: row.lastMessageAt,
          lastMessageAgentId: row.lastMessageAgentId,
          createdAt: row.createdAt,
          pinned: row.pinnedAt !== null,
          lastReadAt: row.lastReadAt,
        });
      }

      /*
       * A drop leaves a record, because the last two times this went wrong nothing did.
       *
       * The comments above now argue that the only way to choose a channel here and fail to rebuild
       * it is a delete or an archive committing between the two statements. That argument has been
       * wrong twice — first over `channel_agents`, then over the thread mapping — and both times the
       * damage was not the dropped row but how long it stayed invisible: the page simply came back
       * short. So the argument is checked at runtime as well as made. Under a concurrent write this
       * line appears once for that channel and never again; any other cause repeats it on every read
       * of that page. `roster/query.ts` keeps the same line for the same reason.
       */
      if (summaries.size !== wanted.length) {
        const rebuilt = new Set(summaries.keys());
        console.error(
          JSON.stringify({
            type: "channel-rows-not-hydrated",
            actorUserId: actor.id,
            status,
            chosen: wanted.length,
            hydrated: summaries.size,
            ids: wanted.map((row) => row.id).filter((id) => !rebuilt.has(id)),
            note: "This read chose these channels and could not rebuild them. Expected once for a channel deleted or archived between the two statements; repeated for the same id means the two statements disagree about who can see what.",
          }),
        );
      }

      return { channels: [...summaries.values()], nextCursor };
    },

    async setPinned(actor, channelId, pinned) {
      await database.transaction(
        async (transaction) => {
          /*
           * The channel is held first, and only then is the membership written.
           *
           * A deleted channel is not there to pin, and `get` and `list` filter the same way. That was
           * guarded by an `exists` subquery on the write, which under read committed reads `channels`
           * on the statement's own snapshot and takes no lock on it: a `softDelete` committing
           * between the snapshot and the write left the pin applied and announced, sending this
           * person's tabs to refetch a roster that cannot show the row — the outcome the guard was
           * there to prevent. The bot-chat twin has no such gap because for it the pin and the
           * `deleted_at` are columns of one row, and `isNull(deletedAt)` on the row it updates is
           * therefore atomic. Here they are two tables, so the guarantee has to come from holding the
           * channel across both statements.
           *
           * `of channels`, and nothing else. The channel is the row this decision depends on; the
           * membership row is locked by the write below on its own account, so naming it here too
           * would widen the lock set without adding a guarantee. What matters is the order: this
           * takes the same lock `setArchived` and `recordActivity` take, and takes it before touching
           * the membership, so no path in this file holds a membership row while waiting on a
           * channel — the ordering that would let two of them deadlock.
           */
          const [locked] = await transaction
            .select({ id: channels.id })
            .from(channels)
            .innerJoin(
              channelMemberships,
              and(
                eq(channelMemberships.channelId, channels.id),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
            .for("update", { of: channels });
          // Not a member, no such channel, or a deleted one: the same answer every way, matching
          // recordActivity and `get`.
          if (!locked) throw new ChannelNotFoundError(channelId);

          const updated = await transaction
            .update(channelMemberships)
            .set({ pinnedAt: pinned ? new Date() : null })
            .where(
              and(
                eq(channelMemberships.channelId, channelId),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            .returning({ channelId: channelMemberships.channelId });
          // The answer still comes from the write. The read above holds the channel and has already
          // found the membership, and nothing in this codebase deletes a membership row, so no path
          // reaches this today — but a pin that wrote nothing must not be announced.
          if (updated.length === 0) throw new ChannelNotFoundError(channelId);

          /*
           * Announced to this member alone.
           *
           * A pin is a fact about one membership row, so `memberIds` holds the person who made it
           * and nobody else. The hub delivers by that list, which is what carries the pin across
           * this person's own tabs and replicas without putting it on anybody else's roster.
           */
          await announce(transaction, {
            kind: "channel",
            id: channelId,
            channelId,
            memberIds: [actor.id],
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            pinned,
          });
        },
        { isolationLevel: "read committed" },
      );
    },

    async markRead(actor, channelId) {
      await database.transaction(
        async (transaction) => {
          // The channel is held first, and only then is the marker stamped — the shape `setPinned`
          // explains at length, for the same reason: a deleted channel is gone from every roster, so
          // nothing about it is markable, and an `exists` on the write cannot say that about the row
          // as it is rather than as this statement's snapshot found it. What it leaves behind is a
          // `last_read_at` on a conversation no read will ever return again.
          const [locked] = await transaction
            .select({ id: channels.id })
            .from(channels)
            .innerJoin(
              channelMemberships,
              and(
                eq(channelMemberships.channelId, channels.id),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
            .for("update", { of: channels });
          // Not a member, no such channel, or a deleted one: the same answer every way, matching
          // setPinned.
          if (!locked) throw new ChannelNotFoundError(channelId);

          const updated = await transaction
            .update(channelMemberships)
            .set({
              /*
               * The later of this clock and the channel's own last-message stamp. last_message_at is
               * written from the reporting browser's clock, and although `parseActivityInput` now
               * bounds how far ahead of this server that clock may be, the bound is not zero: a
               * marker stamped plainly "now" by a server running behind would leave the row reading
               * as unseen for every member, re-lighting the dot on each refetch until wall clock
               * catches up.
               */
              lastReadAt: sql`greatest(now(), coalesce((select ${channels.lastMessageAt} from ${channels} where ${channels.id} = ${channelMemberships.channelId}), now()))`,
            })
            .where(
              and(
                eq(channelMemberships.channelId, channelId),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            .returning({ channelId: channelMemberships.channelId });
          // As in `setPinned`: the answer comes from the write, and the locked read above is what
          // makes it unreachable rather than the other way round.
          if (updated.length === 0) throw new ChannelNotFoundError(channelId);
        },
        { isolationLevel: "read committed" },
      );
    },

    async softDelete(actor, channelId) {
      await database.transaction(
        async (transaction) => {
          const [row] = await transaction
            .select({ packageId: channels.packageId })
            .from(channels)
            .innerJoin(
              channelMemberships,
              and(
                eq(channelMemberships.channelId, channels.id),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            // Filtered on `deleted_at` like every sibling read here, so a deleted channel reads as
            // not found in this statement and not only in the write below.
            .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
            /*
             * Locked, the way `setArchived`'s twin of this read is.
             *
             * The two were asymmetric and one of them had to be wrong. This is the one: the write
             * below re-checks `deleted_at` and therefore needs no lock for that, but it cannot
             * re-check `package_id`, and that is the check this read exists for. `tenant-package.ts`
             * upserts `package_id` onto channel rows that already exist, so a sync committing between
             * this read and the write below soft-deleted a channel the deployment package owns —
             * exactly what `ChannelPackageOwnedError` is here to refuse, and nothing puts such a
             * channel back. Holding the row makes the check and the write one decision.
             *
             * `of channels` for the reason `setArchived` gives, and this method waits on nothing else
             * afterwards: it takes one channel row's lock, writes that row, and reads the memberships
             * without locking them.
             */
            .for("update", { of: channels });
          // Not a member, no such channel, or an already deleted one: the same answer every way,
          // matching setPinned, markRead, setArchived, get and recordActivity.
          if (!row) throw new ChannelNotFoundError(channelId);
          // Package channels are configuration; the sync that wrote them owns them.
          if (row.packageId !== null) {
            throw new ChannelPackageOwnedError(channelId);
          }
          /*
           * The answer comes from the write, which is what makes a repeat delete a refusal.
           *
           * The guard on `deleted_at` was always here and always did its job — it wrote nothing the
           * second time. What was missing is anybody looking: the call carried on to announce
           * `deleted: true` to every member and let the route write a second `channel.deleted` row
           * for a deletion that had already happened, and answered 204 as though it had done it.
           * Reading the write's own answer is also what closes the gap the read above cannot: a
           * delete committing between the two statements is refused here rather than announced twice.
           */
          const deleted = await transaction
            .update(channels)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
            .returning({ id: channels.id });
          if (deleted.length === 0) throw new ChannelNotFoundError(channelId);

          // Read on this transaction, so the members told are the ones the channel had when it was
          // hidden. Soft leaves the membership rows in place.
          const members = await transaction
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channelId));

          /*
           * Announced inside the transaction, so it is delivered on commit and a refused delete —
           * a channel the package owns, or one the caller is not in — announces nothing at all.
           *
           * Every member is told, because the deletion hides the channel for all of them: without
           * this, a second tab and a second replica keep rendering a row whose channel no longer
           * resolves until something else makes them refetch.
           */
          await announce(transaction, {
            kind: "channel",
            id: channelId,
            channelId,
            memberIds: members.map((member) => member.userId),
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            deleted: true,
          });
        },
        { isolationLevel: "read committed" },
      );
    },

    setArchived(actor, channelId, archived) {
      return database.transaction(
        async (transaction) => {
          // `archived_at` itself is deliberately not read here: what the call did is decided by the
          // guarded write below, not by this statement. This one answers whether the caller may act
          // on the channel at all, and holds the row while the write settles the rest.
          const [row] = await transaction
            .select({ packageId: channels.packageId })
            .from(channels)
            .innerJoin(
              channelMemberships,
              and(
                eq(channelMemberships.channelId, channels.id),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            // A deleted channel is not there to archive, and `get` and `list` filter the same way. The
            // write below carries the same guard and would refuse the archive on its own; what this
            // one settles is the answer a caller holding a stale roster row gets — "not found", like
            // every other path, rather than "nothing changed".
            .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
            /*
             * Locked, and only the channel row.
             *
             * Read committed gives a plain `select` a snapshot and no lock, so everything below
             * would be a decision about the row as it was rather than as it is: a delete committing
             * in the gap got its channel archived and announced anyway, and a concurrent archive got
             * a second stamp and a second `channel.archived` audit row for one archiving. Holding the
             * row is what makes the read and the write below one decision.
             *
             * `of channels` because the membership row joined here is not what is being changed, and
             * locking it would put this method in the way of `setPinned` and `markRead`, which write
             * that row. This takes the same lock `softDelete`'s and `recordActivity`'s writes take,
             * and takes it first, so the three serialise on one row rather than waiting on each
             * other in a cycle.
             */
            .for("update", { of: channels });
          // Not a member, no such channel, or a deleted one: the same answer every way, matching
          // setPinned, markRead, get and recordActivity, so membership is not probeable.
          if (!row) throw new ChannelNotFoundError(channelId);
          // Package channels are configuration; the sync that wrote them owns them. Archiving is
          // channel grain, so one member archiving one hides configuration from everybody with
          // nothing to put it back — no sync writes archived_at. That is a deletion wearing a
          // reversible name.
          if (row.packageId !== null) {
            throw new ChannelPackageOwnedError(
              channelId,
              archived ? "archived" : "restored",
            );
          }

          /*
           * The state guard is on the write, and the answer comes from the write.
           *
           * `false` means the channel was already where the caller asked for it: the guard matched no
           * row, so nothing was restamped and nothing is announced. The route keeps its audit write
           * conditional on this answer, so clicking Archive twice cannot lay down two
           * `channel.archived` rows for one archiving — and because the answer is what the write did
           * rather than what an earlier statement read, two concurrent calls cannot both be told they
           * did the archiving.
           *
           * The delete guard repeats what the locked read above established. It costs nothing, and it
           * means the statement is right when read on its own.
           */
          const applied = await transaction
            .update(channels)
            .set({
              archivedAt: archived ? new Date() : null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(channels.id, channelId),
                isNull(channels.deletedAt),
                archived
                  ? isNull(channels.archivedAt)
                  : isNotNull(channels.archivedAt),
              ),
            )
            .returning({ id: channels.id });
          if (applied.length === 0) return false;

          // Read on this transaction, so the members told are the ones the channel had when it was
          // archived.
          const members = await transaction
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channelId));

          /*
           * Every member, because archiving is for all of them.
           *
           * Announced inside the transaction, so it is delivered on commit and a refused archive — a
           * channel the package owns, or one the caller is not in — announces nothing at all.
           */
          await announce(transaction, {
            kind: "channel",
            id: channelId,
            channelId,
            memberIds: members.map((member) => member.userId),
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            archived,
          });

          return true;
        },
        { isolationLevel: "read committed" },
      );
    },

    recordActivity(actor, channelId, activity) {
      return database.transaction(
        async (transaction) => {
          const [membership] = await transaction
            .select({
              channelId: channelMemberships.channelId,
              archivedAt: channels.archivedAt,
            })
            .from(channelMemberships)
            // Joined rather than checked on the membership alone, so a deleted channel is refused
            // too. `get` and `list` filter on `deleted_at`, so without this a client holding a stale
            // roster row can bump `last_message` on a channel nobody can see and announce it to
            // every member, each of whom refetches their roster for an invisible row.
            .innerJoin(
              channels,
              and(
                eq(channels.id, channelMemberships.channelId),
                isNull(channels.deletedAt),
              ),
            )
            .where(
              and(
                eq(channelMemberships.channelId, channelId),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            /*
             * Locked, because `archivedAt` read here decides what the event says.
             *
             * The write below clears `archived_at` under its own guard, which is correct on its own.
             * What cannot be decided from a separate earlier snapshot is whether to SAY the
             * conversation came back: an archive committing between the two left this read saying
             * "not archived", the write clearing the flag anyway, and the event omitting
             * `archived: false`. `app/src/lib/channels/use-channel-events.ts` refetches only when
             * that field is present, so the conversation was restored in the database and stayed
             * hidden on every viewer. Saying something in an archived conversation is how it comes
             * back, which makes the restore direction the one that must not be lossy.
             *
             * `of channels` for the reason `setArchived` gives: the membership row is not what
             * changes here, and locking it would collide with the methods that do write it.
             */
            .for("update", { of: channels });
          // Not a member, no such channel, or a deleted one: the same answer every way, so belonging
          // to a channel is not something an outsider can probe for.
          if (!membership) throw new ChannelNotFoundError(channelId);

          if (activity.agentId !== null) {
            const [linked] = await transaction
              .select({ agentId: channelAgents.agentId })
              .from(channelAgents)
              .where(
                and(
                  eq(channelAgents.channelId, channelId),
                  eq(channelAgents.agentId, activity.agentId),
                ),
              );
            if (!linked) throw new AgentNotFoundError(activity.agentId);
          }

          // A person's message and the agent's reply are reported separately, so they can arrive out
          // of order. Only ever move forwards.
          const lastMessage = previewOf(activity.text);
          const applied = await transaction
            .update(channels)
            .set({
              lastMessage,
              lastMessageAt: activity.at,
              lastMessageAgentId: activity.agentId,
              /*
               * Saying something restores an archived channel.
               *
               * On this write rather than a separate one, so it lands under the same
               * moves-forwards-only guard below: a report the store ignores as stale must not
               * unarchive the conversation either. An ignored report is not news.
               */
              archivedAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(channels.id, channelId),
                or(
                  isNull(channels.lastMessageAt),
                  lt(channels.lastMessageAt, activity.at),
                ),
              ),
            )
            .returning({ id: channels.id });
          // Nothing changed, so there is nothing to announce and nothing to record: a stale report is
          // not news, and it did not restore anything either.
          if (applied.length === 0) return { restored: false };

          // One fact, used twice: whether this report is what cleared the archive. The event carries
          // it so the browser moves the row between lists, and the route writes `channel.unarchived`
          // from the answer this method returns, so the two cannot disagree about what happened.
          const restored = membership.archivedAt !== null;

          const members = await transaction
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channelId));

          // The payload carries the members because the writer has already resolved them. See
          // `announcementPayloads` for how its size is kept under NOTIFY's cap — the preview is
          // capped, the member list is not, and it is the member list that is split.
          await announce(transaction, {
            kind: "channel",
            id: channelId,
            channelId,
            memberIds: members.map((member) => member.userId),
            lastMessage,
            lastMessageAt: activity.at.toISOString(),
            lastMessageAgentId: activity.agentId,
            // Only when this report is what restored it. On every other activity event the field is
            // absent, so a client patching a row does not have to distinguish "still not archived"
            // from "just came back".
            ...(restored ? { archived: false } : {}),
          });

          return { restored };
        },
        { isolationLevel: "read committed" },
      );
    },
  };
}

export class ChannelNotFoundError extends Error {
  constructor(id: string) {
    super(`Channel ${id} was not found.`);
    this.name = "ChannelNotFoundError";
  }
}

export class ChannelPackageOwnedError extends Error {
  /**
   * What was refused, for the sentence a person reads.
   *
   * Defaulted to `deleted` so the existing delete path and its test are untouched. Archiving refused
   * with the word "deleted" in it would send somebody looking for a deletion nobody attempted.
   */
  readonly act: string;

  constructor(id: string, act = "deleted") {
    super(`Channel ${id} is defined by the deployment package.`);
    this.name = "ChannelPackageOwnedError";
    this.act = act;
  }
}

type ChannelInputParseResult =
  | { ok: true; value: { agentIds: string[] } }
  | { ok: false; error: string };

type ChannelInputObject = { agentIds?: unknown };

export function parseChannelInput(input: unknown): ChannelInputParseResult {
  if (!isChannelInputObject(input)) {
    return { ok: false, error: "Channel input must be a JSON object." };
  }

  if (!Array.isArray(input.agentIds) || input.agentIds.length === 0) {
    return { ok: false, error: "Agent IDs must be a non-empty array." };
  }

  const agentIds: string[] = [];
  for (const agentId of input.agentIds) {
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "Agent IDs must be non-empty strings." };
    }
    agentIds.push(agentId.trim());
  }

  if (new Set(agentIds).size !== agentIds.length) {
    return { ok: false, error: "Agent IDs must be unique." };
  }

  return { ok: true, value: { agentIds: agentIds.sort() } };
}

function isChannelInputObject(input: unknown): input is ChannelInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

type ActivityInputParseResult =
  | { ok: true; value: ChannelActivity }
  | { ok: false; error: string };

/**
 * How long a reported message may be, in UTF-16 units.
 *
 * Units rather than code points because this is a size bound, and counting code points means walking
 * the whole string to find out how long it is — the work the bound exists to avoid. It is generous
 * for anything a person or a Bot says: `previewOf` keeps 200 code points of it for the roster, and
 * the rest is stored by whoever holds the transcript, not here.
 */
const MAX_ACTIVITY_TEXT_UNITS = 16_000;

/**
 * How large the JSON around it may be.
 *
 * Wider than the cap above on purpose, and by a factor that no accepted message can close: the widest
 * a 16,000-unit string gets inside JSON is six bytes a unit, when every one of them is a control
 * character written as `\u0000`. So nothing `parseActivityInput` would accept is refused here first,
 * and this exists only to stop the `JSON.parse` that runs before the parser is reached at all.
 *
 * Exported for `bot-chats/routes.ts`, whose activity route reads a body of the same shape and has to
 * turn away the same sizes. Imported rather than restated so the two cannot drift apart.
 */
export const MAX_ACTIVITY_BODY_BYTES = 256 * 1024;

/**
 * How far ahead of this server's clock a reported `at` may be.
 *
 * Not zero: the stamp comes from the machine that saw the message, and two clocks a few seconds
 * apart is ordinary rather than an error. Not unbounded, which is what it was — and unbounded above
 * is the dangerous direction, because both stores write this value to `last_message_at` under a
 * guard that only ever moves forwards. One report carrying a year-3000 stamp therefore pinned the row
 * to the top of every member's roster permanently, made every later genuine report a no-op, and —
 * because clearing `archived_at` rides that same guarded write — left an archived conversation that
 * saying something in could no longer bring back. There is no API that undoes any of it.
 *
 * Five minutes is generous for a clock and short enough that a client which lies by the whole
 * allowance has pinned the row for five minutes rather than for good.
 */
export const MAX_ACTIVITY_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The one shape of `at` this parser accepts: a calendar date and time with an explicit zone.
 *
 * A zone is required because `new Date("2026-08-31T12:00")` is read in the server process's own local
 * zone, so two clients sending the identical string landed at two different instants depending on
 * where the process happened to run — and that instant is then compared against what is stored. The
 * bare `new Date` this replaces also accepted "12/25/2026" while the refusal below said ISO-8601, so
 * the parser was looser than its own error message.
 */
const ISO_8601_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Parse a reported message.
 *
 * `at` comes from the client that saw the message, because only it knows when the message arrived,
 * and it is trusted no further than that. Two bounds hold it: the store compares it against what is
 * stored and only ever moves forwards, and this parser refuses a stamp with no zone and clamps one
 * more than `MAX_ACTIVITY_CLOCK_SKEW_MS` ahead of this server's clock. Between them a wrong clock can
 * lose a report; it cannot leave the row pinned to the top of every roster with every later report a
 * no-op and its archive no longer clearable by speaking in it.
 */
export function parseActivityInput(input: unknown): ActivityInputParseResult {
  if (!isChannelInputObject(input)) {
    return { ok: false, error: "Activity must be a JSON object." };
  }
  const object = input as { text?: unknown; agentId?: unknown; at?: unknown };

  if (typeof object.text !== "string" || object.text.trim().length === 0) {
    return { ok: false, error: "Text is required." };
  }
  // Refused rather than truncated. A shortened report is a lie about what was said, and this text is
  // what the roster's preview is derived from and what a person reads back off the row.
  if (object.text.length > MAX_ACTIVITY_TEXT_UNITS) {
    return { ok: false, error: "Text is too long." };
  }
  if (object.agentId !== null && typeof object.agentId !== "string") {
    return { ok: false, error: "Agent ID must be a string or null." };
  }
  /*
   * Whitespace is not an agent, and it is not a person either.
   *
   * Trimmed to `""` it was neither `null` — which is how "a person said this" is spelled — nor an id
   * any store can resolve, so `recordActivity` looked up the empty string in `channel_agents`, failed
   * to find it, and threw `AgentNotFoundError("")`: a malformed request answered 404 "Agent not
   * found." Every sibling parser refuses it outright — `parseChannelInput` here, and both of
   * `bot-chats/routes.ts`'s — and this one was the outlier.
   */
  if (
    typeof object.agentId === "string" &&
    object.agentId.trim().length === 0
  ) {
    return { ok: false, error: "Agent ID must be a non-empty string or null." };
  }
  if (typeof object.at !== "string") {
    return { ok: false, error: "Timestamp is required." };
  }
  if (!ISO_8601_WITH_ZONE.test(object.at)) {
    return {
      ok: false,
      error: "Timestamp must be an ISO-8601 date and time with a time zone.",
    };
  }
  const reported = new Date(object.at);
  // The shape is right and the value is still not a date: "2026-13-01T00:00:00Z" gets this far. An
  // impossible day inside a real month does not — `Date` rolls "2026-02-30" into March, and a stamp
  // that lands a couple of days out is held down by the ceiling below like any other.
  if (Number.isNaN(reported.getTime())) {
    return {
      ok: false,
      error: "Timestamp must be an ISO-8601 date and time with a time zone.",
    };
  }

  /*
   * Clamped, not refused.
   *
   * A report is a message somebody actually sent. The store's guard is built so that a wrong clock
   * loses a report; refusing here would make a wrong clock lose every report that client ever makes,
   * with nothing the person could do about it. Clamped, the stamp is never more than the allowance
   * ahead of this server, successive reports from that client still advance as long as this server's
   * clock has ticked between them, and the bound is what makes this function's docblock true.
   *
   * Only the ceiling. A stamp in the past needs no defending: the store's guard already ignores one
   * older than what is stored, and an old stamp cannot pin a row or hide a later message.
   */
  const ceiling = Date.now() + MAX_ACTIVITY_CLOCK_SKEW_MS;
  const at = reported.getTime() > ceiling ? new Date(ceiling) : reported;

  return {
    ok: true,
    value: {
      agentId:
        typeof object.agentId === "string" ? object.agentId.trim() : null,
      at,
      text: object.text,
    },
  };
}

export function createChannelRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Absent in tests and wherever live updates are not wanted; the routes still work without it. */
  events?: ChannelEventHub,
  /** Where a channel's removal is written. Absent in tests that do not care about the trail. */
  auditStore?: AuditStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Write one audit row, tolerantly. See `createAuditRecorder` for every reason it behaves this way,
   * including why a refused change and a repeat both write nothing.
   */
  const record = createAuditRecorder(auditStore, {
    type: "channel",
    logType: "channel-audit-write-failed",
    logIdKey: "channelId",
  });

  // Before `/:channelId`, or "events" is read as a channel id.
  if (events) {
    routes.get(
      "/events",
      requireUser,
      upgradeWebSocket((context) => {
        // Resolved at upgrade, not per message: the connection belongs to whoever authenticated it,
        // and nothing it later sends can change that.
        const { id: userId } = context.var.actor;
        let detach = () => {};
        return {
          onOpen: (_event, ws) => {
            detach = events.register(userId, (payload) => ws.send(payload));
          },
          onClose: () => detach(),
          onError: () => detach(),
        };
      }),
    );
  }

  routes.post("/", requireUser, async (context) => {
    const parsed = parseChannelInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      const channel = await store.create(
        context.var.actor,
        parsed.value.agentIds,
      );
      return context.json({ channel: channelDto(channel) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/", requireUser, async (context) => {
    try {
      const url = new URL(context.req.url);
      // Refused by the same rule `GET /api/roster` refuses by, from the same function: these two
      // endpoints answer about the same rows, so one paging contract with two behaviours is the
      // failure to avoid. `parsePageLimit` carries the reasoning.
      const limit = parsePageLimit(url.searchParams.get("limit"));
      if (!limit.ok) return context.json({ error: limit.error }, 400);
      const page = await store.list(context.var.actor, {
        // Parsed by the roster's own function, so this endpoint and `GET /api/roster` cannot come to
        // read `?status=` differently. Anything unrecognised reads as `active`.
        status: parseRosterStatus(url.searchParams.get("status")),
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        // Omitting the key is what makes `list`'s own default fire. `Number` rather than
        // Omitting the key is what makes `list`'s own page size fire.
        ...(limit.limit === undefined ? {} : { limit: limit.limit }),
      });

      return context.json({
        channels: page.channels.map(channelSummaryDto),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post(
    "/:channelId/activity",
    requireUser,
    /*
     * Two caps, and they are not interchangeable.
     *
     * `parseActivityInput` bounds the message, which is the semantic limit and the one that answers
     * 400. It cannot bound the work that precedes it: `context.req.json()` below has already read and
     * parsed the whole body by the time the parser sees an object. This is that half — the only place
     * a multi-megabyte body can be turned away before it is parsed at all.
     */
    bodyLimit({
      maxSize: MAX_ACTIVITY_BODY_BYTES,
      // JSON, and named, because every other refusal on these routes is. The default is a plain-text
      // "Payload Too Large" thrown as an exception, which a client parsing our error shape cannot
      // read.
      onError: (context) =>
        context.json({ error: "Activity body is too large." }, 413),
    }),
    async (context) => {
      const parsed = parseActivityInput(
        await context.req.json().catch(() => null),
      );
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);

      const channelId = context.req.param("channelId");
      try {
        const { restored } = await store.recordActivity(
          context.var.actor,
          channelId,
          parsed.value,
        );
        /*
         * The other way a channel is unarchived, and the row it owes the trail.
         *
         * Saying something in an archived channel restores it. That is a real unarchiving with a real
         * actor, and the store cannot write it down — it holds no audit store — so this does, from
         * what the store reports back. Without it the trail shows `channel.archived` and no matching
         * `channel.unarchived` for a channel that is live and on every roster, which is the shape of
         * audit bug `audit.ts` argues is worse than a silent trail: it is used to rule things out.
         *
         * `mechanism` separates it from somebody clicking Restore, because the two are different
         * facts about how a conversation came back and the event type cannot tell them apart.
         */
        if (restored) {
          await record(context.var.actor.id, "channel.unarchived", channelId, {
            mechanism: "activity",
          });
        }
        return context.body(null, 204);
      } catch (error) {
        return mapStoreError(context, error);
      }
    },
  );

  routes.put("/:channelId/pin", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isChannelInputObject(body)) {
      return context.json({ error: "Pin input must be a JSON object." }, 400);
    }
    const { pinned } = body as { pinned?: unknown };
    if (typeof pinned !== "boolean") {
      return context.json({ error: "Pinned must be true or false." }, 400);
    }

    try {
      await store.setPinned(
        context.var.actor,
        context.req.param("channelId"),
        pinned,
      );
      return context.json({ pinned });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/:channelId/archive", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isChannelInputObject(body)) {
      return context.json(
        { error: "Archive input must be a JSON object." },
        400,
      );
    }
    const { archived } = body as { archived?: unknown };
    if (typeof archived !== "boolean") {
      return context.json({ error: "Archived must be true or false." }, 400);
    }

    const channelId = context.req.param("channelId");
    try {
      const changed = await store.setArchived(
        context.var.actor,
        channelId,
        archived,
      );
      // Reached only once the store has resolved, so a refused archive writes nothing. And only when
      // the store actually moved the flag: `setArchived` returns `false` for a repeat call on a
      // channel already in the requested state, and clicking Archive twice must not lay down two
      // `channel.archived` rows for one archiving. The response below is unconditional either way —
      // the caller asked for a state and that state now holds — so a 200 here can coincide with no
      // trail write at all. That is deliberate, not a bug: the HTTP contract answers "is it archived
      // now", not "did this call do the archiving".
      if (changed) {
        await record(
          context.var.actor.id,
          archived ? "channel.archived" : "channel.unarchived",
          channelId,
          // Named the way `channel.deleted` names its mechanism, and for a sharper reason: the
          // activity route writes `channel.unarchived` too, when somebody typing in an archived
          // channel brings it back. Without this a reader cannot tell a decision from a side effect.
          { mechanism: "explicit" },
        );
      }
      return context.json({ archived });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/:channelId/read", requireUser, async (context) => {
    try {
      await store.markRead(context.var.actor, context.req.param("channelId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:channelId", requireUser, async (context) => {
    const channelId = context.req.param("channelId");
    try {
      await store.softDelete(context.var.actor, channelId);
      // Named rather than implied: the channel row and its thread are still there, and a later
      // hard delete would be a different fact about the same channel.
      await record(context.var.actor.id, "channel.deleted", channelId, {
        mechanism: "soft",
      });
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:channelId", requireUser, async (context) => {
    try {
      const channel = await store.get(
        context.var.actor,
        context.req.param("channelId"),
      );
      if (!channel) {
        return context.json({ error: "Channel not found." }, 404);
      }
      return context.json({ channel: channelDto(channel) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

function channelDto(channel: AgentChannel): AgentChannel {
  return {
    id: channel.id,
    name: channel.name,
    agentIds: channel.agentIds,
    threadId: channel.threadId,
    active: channel.active,
    archived: channel.archived,
  };
}

function channelSummaryDto(channel: ChannelSummary) {
  return {
    ...channelDto(channel),
    lastMessage: channel.lastMessage,
    // Serialised as ISO-8601 so the browser gets a string it can sort and format.
    lastMessageAt: channel.lastMessageAt?.toISOString() ?? null,
    lastMessageAgentId: channel.lastMessageAgentId,
    createdAt: channel.createdAt.toISOString(),
    pinned: channel.pinned,
    // Serialised as ISO-8601 like lastMessageAt, so the browser can compare the two as strings.
    lastReadAt: channel.lastReadAt?.toISOString() ?? null,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Agent not found." }, 404);
  }
  if (error instanceof ChannelNotFoundError) {
    return context.json({ error: "Channel not found." }, 404);
  }
  if (error instanceof ChannelPackageOwnedError) {
    return context.json(
      {
        error: `This channel is defined by the deployment package, so it cannot be ${error.act} here.`,
      },
      409,
    );
  }
  throw error;
}
