import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
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
  withinTimestamptzRange,
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
import { timestampShape } from "../time";
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
   * live, and a person's message through `recordActivity` clears the archive on its own.
   *
   * Throws ChannelNotFoundError for a non-member, an unknown channel, or a deleted one, and
   * ChannelPackageOwnedError for ARCHIVING a channel the tenant package defines. Restoring one is
   * allowed, and the guard in the implementation says why the two directions differ.
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
   * Record the last thing said, and bring the channel back if a PERSON said it, after it was
   * archived, and it was archived.
   *
   * A Bot's reply moves the preview and the recency and leaves an archived channel archived, and so
   * does a person's own report of a message they sent before the archive: the clear is measured
   * against `archived_at` on a statement of its own, because whether a channel is hidden is a
   * different question from what its last message was. The implementation says why at length. Throws
   * ChannelNotFoundError for a non-member, an unknown channel, or a deleted one.
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
          /*
           * ARCHIVING a package channel is refused. RESTORING one is not.
           *
           * Package channels are configuration; the sync that wrote them owns them. Archiving is
           * channel grain, so one member archiving one hides configuration from everybody — and no
           * sync writes `archived_at`, so nothing puts it back. That is a deletion wearing a
           * reversible name, and refusing it is what this guard is for.
           *
           * IT USED TO REFUSE BOTH DIRECTIONS, which turned that argument inside out: restoring is
           * precisely the act that puts it back. The state is reachable — `tenant-package.ts` upserts
           * `package_id` onto channel rows that already exist, the race `softDelete`'s docblock names
           * — so a channel archived before a sync claimed it was hidden from every roster with the one
           * deliberate remedy refused, permanently. The only way back left was `recordActivity`
           * clearing `archived_at`, which needs somebody to hold the URL of a conversation no roster
           * still shows.
           *
           * A restore hides nothing and invents nothing: the write below only ever clears a stamp
           * some member's archive put there, so it cannot resurrect a channel the package deleted or
           * disagree with anything the sync wrote.
           */
          if (archived && row.packageId !== null) {
            throw new ChannelPackageOwnedError(channelId, "archived");
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
              /*
               * The row's own preview, read for the announcement rather than for a decision.
               *
               * Two writes below can leave the row holding something other than what this report
               * carries — a report that is stale for the recency but still lifts the archive, and a
               * message that renders as nothing — and the browser spreads whatever the event carries
               * onto the row it is showing. So the event is built from what the row holds after this
               * transaction, and for the fields this call did not move that is exactly this read.
               * Safe because the lock below is held: nothing else can change them underneath it.
               */
              lastMessage: channels.lastMessage,
              lastMessageAt: channels.lastMessageAt,
              lastMessageAgentId: channels.lastMessageAgentId,
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
             * Locked, because everything below is a decision about the row as this call found it.
             *
             * WHAT THE LOCK USED TO CARRY. `archivedAt` read here was what said whether to announce
             * `archived: false`: an archive committing between this read and the write left the read
             * saying "not archived", the write cleared the flag anyway, and the event omitted the
             * field — and `app/src/lib/channels/use-channel-events.ts` refetches only when it is
             * present, so the conversation was restored in the database and stayed hidden on every
             * viewer. A person saying something in an archived conversation is how it comes back,
             * which makes the restore direction the one that must not be lossy.
             *
             * That fact now comes from the clear's own `returning` rather than from this read, so
             * this snapshot could no longer get it wrong. The lock stays because two other things
             * still rest on it: the refusal below is decided here and neither write carries a
             * `deleted_at` term, so without it a delete committing in the gap gets its channel
             * written to and announced; and the fields this call does not move are announced from
             * this read, which is only the row's true state while nothing else may write it.
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

          const lastMessage = previewOf(activity.text);
          const saidByAPerson = activity.agentId === null;
          /*
           * The preview and the recency, on a guard that only ever moves forwards.
           *
           * A person's message and the agent's reply are reported separately, so they can arrive out
           * of order and a late one must not drag the row's preview backwards.
           *
           * `<=` AND NOT `<`. An equal stamp from a later report is not a regression, and the clamp in
           * `parseActivityInput` is what makes equality ordinary rather than a coincidence: every
           * report from a client further out than `MAX_ACTIVITY_CLOCK_SKEW_MS` is rewritten to the same
           * bound, so two reports made inside one millisecond of this server's clock arrive carrying
           * one instant and the second was dropped as stale. Re-applying an equal stamp costs nothing
           * — the values are the ones already there, unless the report is genuinely a different
           * message, which is the case this is for.
           *
           * `lastMessage` is left out of the `SET` when the message renders as nothing, and
           * `lastMessageAgentId` goes with it. `previewOf` answers null for a message of only format
           * characters, and writing that null blanked the row's preview — a caller can send one,
           * because the parser rejects on `text.trim()` and a zero-width space survives it. The title
           * write in `bot-chats/store.ts` refuses the same write with the same argument. The author
           * moves with the text because the two are halves of one fact, what the row shows and who
           * said it, and moving the author alone leaves a person's words rendering under a Bot's name.
           * `lastMessageAt` still moves: the message is real, and recency is what the sort is for.
           */
          const applied = await transaction
            .update(channels)
            .set({
              ...(lastMessage === null
                ? {}
                : { lastMessage, lastMessageAgentId: activity.agentId }),
              lastMessageAt: activity.at,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(channels.id, channelId),
                or(
                  isNull(channels.lastMessageAt),
                  lte(channels.lastMessageAt, activity.at),
                ),
              ),
            )
            .returning({ id: channels.id });

          /*
           * A PERSON speaking is what brings an archived channel back. A Bot answering is not.
           *
           * The rule is "hidden but live — sending unarchives", and the person sending is what that
           * means. Both halves of one exchange are reported separately, so without this the ordinary
           * sequence was: somebody sends a message, tidies the channel away, and a second later the
           * reply to the question they asked BEFORE archiving lands, clears `archived_at`, and puts
           * the row back on every roster with every tab refetching. They archived it deliberately and
           * it came back on its own, which is the whole of why the archive stopped feeling reliable.
           *
           * A reply that lands after an archive therefore leaves the row archived and still moves the
           * preview and the recency above — the conversation is hidden, not frozen, so the row a
           * person finds under Archived is the up-to-date one and sorts where its last message says.
           * And nothing is stranded: the person can still bring it back by speaking in it, which is
           * the same gesture the rule was always about, or by pressing Restore.
           *
           * ON ITS OWN STATEMENT, and measured against `archived_at` rather than against
           * `last_message_at`. It rode the write above, which made the recency guard decide the
           * archive too, and that is the wrong question asked twice:
           *
           *   - A person's message OLDER than the stored last message failed to lift the archive. The
           *     row stayed hidden, `restored` was false so there was no audit row and no
           *     `archived: false` on the wire, and the POST still answered 204. A tab whose clock is a
           *     couple of seconds behind whoever last wrote `last_message_at` — the Bot's reply,
           *     usually — could not speak the conversation back into view at all, and nothing said why.
           *   - A person's message that PREDATED the archive did lift it, and laid down a
           *     `channel.unarchived` row for a message sent before the archive existed. Excluding the
           *     Bot's reply fixed the half that was noticed; the person's own late report walks the
           *     identical path.
           *
           * Whether a conversation is hidden and what its last message was are different questions
           * about it, so they get a statement each. `archived_at IS NOT NULL` says out loud that only
           * an archived row is being cleared rather than resting on `<` against NULL being unknown, and
           * `archived_at < at` is the whole of the rule: a message said after the archive lifts it, one
           * said before it does not. The two stamps come from different clocks, which is what the
           * parser's clamp is for — it bounds the disagreement to the allowance either side. A message
           * stamped exactly `archived_at`, or one from a clock so wrong that the clamp puts it behind
           * an archive made in the last five minutes, leaves the row hidden and Restore is still there.
           *
           * `restored` therefore comes from this statement's `returning` and not from the read above:
           * it is the fact of what this write did. The event carries it so the browser moves the row
           * between lists, and the route writes `channel.unarchived` from the answer this method
           * returns, so the two cannot disagree about what happened. It is also idempotent for free —
           * a repeated report finds `archived_at` already null and reports nothing — where a `restored`
           * taken from a snapshot could announce `archived: false` for a row still archived and put a
           * trail row on an unarchiving that never happened: confidently wrong, which `audit.ts`
           * argues is worse than silent.
           *
           * `bot-chats/store.ts` guards its own clear identically, from the same reasoning: the two
           * kinds of conversation are read by one roster and a rule that held for only one of them
           * would be this feature implemented twice with two answers.
           */
          const cleared = saidByAPerson
            ? await transaction
                .update(channels)
                .set({ archivedAt: null, updatedAt: new Date() })
                .where(
                  and(
                    eq(channels.id, channelId),
                    isNotNull(channels.archivedAt),
                    lt(channels.archivedAt, activity.at),
                  ),
                )
                .returning({ id: channels.id })
            : [];
          const restored = cleared.length > 0;

          // Nothing was written, so there is nothing to announce and nothing to record: a stale
          // report is not news, and it did not restore anything either. Both terms, because either
          // write can land without the other — that is the point of their being two.
          if (applied.length === 0 && !restored) return { restored: false };

          /*
           * What the row holds now, which is not always what this report carried.
           *
           * The browser spreads these three onto the row it is rendering, so an event that carried
           * this call's values where the write did not take them would stamp a preview the row does
           * not have. Two cases: a report stale for the recency that still lifted the archive, and a
           * message that renders as nothing. In both, the fields that did not move are announced from
           * the locked read, which under the lock above is the row's current state.
           */
          const announced =
            applied.length === 0
              ? {
                  lastMessage: membership.lastMessage,
                  lastMessageAt: membership.lastMessageAt,
                  lastMessageAgentId: membership.lastMessageAgentId,
                }
              : {
                  lastMessage: lastMessage ?? membership.lastMessage,
                  lastMessageAt: activity.at,
                  lastMessageAgentId:
                    lastMessage === null
                      ? membership.lastMessageAgentId
                      : activity.agentId,
                };

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
            lastMessage: announced.lastMessage,
            lastMessageAt: announced.lastMessageAt?.toISOString() ?? null,
            lastMessageAgentId: announced.lastMessageAgentId,
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
 * How large a body that is not a message may be.
 *
 * Six of the nine body-taking routes across this file and `bot-chats/routes.ts` take a fixed handful
 * of fields and nothing that grows: a boolean to pin or archive either kind of conversation, one
 * agent id to start a conversation with a Bot, an agent id and a thread id to adopt one. None of them
 * needs anything close to the room a reported message needs, and that is the whole reason there is
 * more than one number here — a quarter of a megabyte read off the socket and `JSON.parse`d in full
 * to find `{"archived":true}` somewhere in it is what one number for every route costs.
 *
 * Four kilobytes rather than the forty-odd bytes such a body actually is, because every one of these
 * parsers reads the fields it wants and ignores the rest: a client that PUTs back the whole row it
 * was handed — the object `channelDto` returns — is asking for something legal, and a cap trimmed to
 * the shortest legal body would refuse it. Four kilobytes is an order of magnitude above anything a
 * client of these routes sends and three below the megabytes this exists to turn away.
 *
 * Exported for `bot-chats/routes.ts`, whose four small-bodied routes take their cap from here rather
 * than restating it, for the reason `MAX_ACTIVITY_BODY_BYTES` above is exported: a roster's two kinds
 * of row must not refuse the same body at two different sizes.
 */
export const MAX_SMALL_BODY_BYTES = 4 * 1024;

/**
 * How large `POST /` may be — the one body on either file that grows with what is being asked for.
 *
 * `parseChannelInput` bounds every member of `agentIds` and says nothing about how many members there
 * are, so this is the only thing between one request and a transaction that looks up a profile and
 * inserts a `channel_agents` row per id. Sixteen kilobytes is a few hundred ids at any length this
 * deployment mints them — more Bots than a roster holds — and small enough that the work behind an
 * accepted request stays bounded.
 *
 * A CAP ON THE COUNT WOULD BE THE BETTER BOUND, and it does not belong here: it belongs in
 * `parseChannelInput`, which could then answer 400 saying how many Bots one channel may name instead
 * of 413 saying something about bytes. Until it has one, this number is the effective limit on the
 * list — which is the one way this cap is unlike `MAX_ACTIVITY_BODY_BYTES`, whose parser has a cap of
 * its own that always bites first.
 */
export const MAX_CHANNEL_CREATE_BODY_BYTES = 16 * 1024;

/**
 * A body cap, as the JSON refusal every other answer on these routes is.
 *
 * ONE FUNCTION FOR NINE ROUTES rather than nine `bodyLimit` calls differing in a number and a noun.
 * The way this went wrong the first time is the argument for it: the middleware sat on the two
 * activity routes and on none of the other seven, and a decision written out per route is a decision
 * nobody can count.
 *
 * `subject` names what was too large in the words that route's own 400s use — "Pin body is too
 * large." beside "Pin input must be a JSON object." — so a client told its body was refused can tell
 * which call was refused. JSON, and named, because every other refusal on these routes is: the
 * `bodyLimit` default is a plain-text "Payload Too Large" thrown as an exception, and `client()` in
 * the browser reads `body.error` and falls back to its own sentence when the body is not JSON, so
 * the default reaches a person as "the request failed" with none of the server's reason in it.
 *
 * Exported for `bot-chats/routes.ts`, whose five body-taking routes cap themselves with this same
 * function, so the twins cannot come to refuse one oversized body in two different words.
 */
export function limitBody(subject: string, maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (context) =>
      context.json({ error: `${subject} body is too large.` }, 413),
  });
}

/**
 * How far from this server's clock, in either direction, a reported `at` may be.
 *
 * Not zero: the stamp comes from the machine that saw the message, and two clocks a few seconds
 * apart is ordinary rather than an error. Not unbounded, which is what it was — and ABOVE was named
 * as the dangerous direction, because both stores write this value to `last_message_at` under a
 * guard that only ever moves forwards. One report carrying a year-3000 stamp therefore pinned the row
 * to the top of every member's roster permanently, made every later genuine report a no-op, and —
 * because clearing `archived_at` rode that same guarded write — left an archived conversation that
 * saying something in could no longer bring back. There is no API that undoes any of it.
 *
 * BELOW IS DANGEROUS TOO, which is the half this docblock's first line used to leave out. Recency is
 * `coalesce(last_message_at, created_at)`, so the first report on a conversation replaces
 * `created_at` as its sort key and a year-1970 stamp sinks the row below one nobody has ever said
 * anything in — also with no API that undoes it. And a client running behind whoever last wrote
 * `last_message_at` has every report of its own read as stale, so it cannot move the preview at all.
 * The allowance is symmetric because the harm is.
 *
 * Five minutes is generous for a clock and short enough that a client which lies by the whole
 * allowance has pinned or sunk the row for five minutes rather than for good.
 */
export const MAX_ACTIVITY_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Parse a reported message.
 *
 * `at` comes from the client that saw the message, because only it knows when the message arrived,
 * and it is trusted no further than that. Two bounds hold it: the store compares it against what is
 * stored and only ever moves forwards, and this parser refuses a stamp with no zone and clamps one
 * more than `MAX_ACTIVITY_CLOCK_SKEW_MS` from this server's clock in EITHER direction. Between them a
 * wrong clock can lose a report; it cannot leave the row pinned to the top of every roster with every
 * later report a no-op, and it cannot sink the row below every conversation nobody has spoken in.
 *
 * A year the column cannot hold is refused outright rather than clamped, because a stamp naming year
 * 0 is not a clock running slow: see the `withinTimestamptzRange` check below.
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
  /*
   * ONE SHAPE, and it is the shared one: an ISO-8601 date and time carrying an explicit zone.
   *
   * A zone is required because `new Date("2026-08-31T12:00")` is read in the server process's own local
   * zone, so two clients sending the identical string landed at two different instants depending on
   * where the process happened to run — and that instant is then compared against what is stored.
   * `time.ts` holds that argument now, because `auditQueryFromUrl` in `audit.ts` needs it too and had
   * the defect for as long as this parser had the fix.
   *
   * NOTHING LOOSER, because a reported `at` is a machine's record of when a message arrived, not
   * something typed: a bare `2026-08-31` names no time of day, and `12/25/2026` is a date only because
   * `new Date` guesses at it — it was accepted while the refusal here said ISO-8601, so the parser was
   * looser than its own error message. The audit bound reads the same classification and does accept a
   * bare date, because there a person does the typing; the shapes are shared and the acceptance is
   * each reader's own.
   */
  if (timestampShape(object.at) !== "date-time-with-zone") {
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
   * A date this column has no room for, refused here rather than by letting Postgres try.
   *
   * `0000-01-01T00:00:00Z` was the whole of what reached this line: it matches the shape above, `Date`
   * holds it and round-trips it perfectly, and `timestamptz` has no year between 1 BC and AD 1, so it
   * answers `date/time field value out of range`. The extended `±YYYYYY` forms that break the other way
   * now reach it too, and deliberately: the shared shape asks nothing about the year, because this
   * check is the one that can name the range in its refusal, and `+010000-01-02T00:00:00Z` is an
   * instant with a zone on it whose only fault is a year — being told it is not an ISO-8601 date and
   * time is false.
   *
   * The clamp did not catch it when this check was written — year 0 is in the past, and only the
   * ceiling was clamped — and neither does the store's moves-forwards-only guard, which is the trap:
   * `activity.at` is bound in that guard's `WHERE` as well as in the `SET`, so Postgres parses it to
   * decide whether to write rather than because it is writing. The failure therefore came out of the
   * middle of the store's transaction, where the parameter no longer has a name, as a 500 for what is
   * a malformed request.
   *
   * The floor below now covers the crash — with both ends clamped, a stamp that reaches the column is
   * within the allowance of this server's clock whatever year it named on the way in. This stays a
   * refusal anyway,
   * and stays ABOVE the clamp so it is reachable at all: a clamp is what a wrong clock deserves, and
   * year 0 is not a clock running slow. It is a stamp that names no time, and 400 is the only way the
   * client is ever told so.
   *
   * `withinTimestamptzRange` rather than a fourth copy of `year < 1`: it lives in `roster/order.ts`
   * with the range and the reasoning, and `audit.ts` borrows it for the same class of bug on its own
   * query bounds.
   */
  if (!withinTimestamptzRange(reported)) {
    return {
      ok: false,
      error: "Timestamp must name a year between 0001 and 9999.",
    };
  }

  /*
   * Clamped, not refused, at both ends.
   *
   * A report is a message somebody actually sent. The store's guard is built so that a wrong clock
   * loses a report; refusing here would make a wrong clock lose every report that client ever makes,
   * with nothing the person could do about it. Clamped, the stamp is never more than the allowance
   * from this server in either direction, successive reports from that client still advance as long as
   * this server's clock has ticked between them, and the bound is what makes this function's docblock
   * true.
   *
   * IT USED TO HOLD THE CEILING ONLY, on the argument that a stamp in the past needs no defending
   * because "the store's guard already ignores one older than what is stored, and an old stamp cannot
   * pin a row or hide a later message". Both halves of that are true and neither is the whole harm.
   * Recency is `coalesce(last_message_at, created_at)`, so the FIRST report on a conversation replaces
   * `created_at` as its sort key: `at: "1970-01-02T00:00:00Z"` passes the shape check, names a year the
   * column holds, is in the past so was never clamped, and matches the store's `last_message_at IS
   * NULL` guard — so it was written, and the conversation then sorted below one nobody had ever said
   * anything in, with no API that resets it. And "ignores one older than what is stored" is itself the
   * second harm: a browser running behind whoever last wrote `last_message_at` had every report of its
   * own dropped, so it could not move the preview, and before the archive clear was given a guard of
   * its own it could not speak a hidden conversation back into view either.
   *
   * WHAT THE FLOOR COSTS. A report genuinely delayed by more than the allowance — a tab that was
   * offline and is catching up — is stamped at the floor rather than when the message was said, so it
   * sorts a little high and can take a preview from a message that really was later. That is the same
   * trade the ceiling already makes, and it is the cheaper failure: a late report shown slightly out
   * of order is worth less than a conversation nothing can bring back.
   */
  const now = Date.now();
  // One reading of the clock for both ends, so the window is the same window at both edges rather
  // than two reads with a tick in between.
  const clamped = Math.min(
    Math.max(reported.getTime(), now - MAX_ACTIVITY_CLOCK_SKEW_MS),
    now + MAX_ACTIVITY_CLOCK_SKEW_MS,
  );
  const at = clamped === reported.getTime() ? reported : new Date(clamped);

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

  routes.post(
    "/",
    requireUser,
    // The one body on this file that grows with the request: `MAX_CHANNEL_CREATE_BODY_BYTES` says why
    // it gets a number of its own rather than the small one the flag routes below share, and what a
    // cap on the number of Bots would have to look like instead.
    limitBody("Channel", MAX_CHANNEL_CREATE_BODY_BYTES),
    async (context) => {
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
    },
  );

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
        // Omitting the key is what makes `list`'s own page size fire; see `parsePageLimit`.
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
     * parsed the whole body by the time the parser sees an object. This is that half — the place a
     * multi-megabyte report is turned away before it is parsed at all.
     *
     * IT SAID "THE ONLY PLACE", and the sentence was true of a route rather than of the server: this
     * middleware sat here and on the bot-chat twin's activity route and on none of the other seven
     * body-taking routes across the two files, so an 8 MB `{"archived":true}` was read and parsed in
     * full and answered 200. All nine carry a cap now, and this is the widest of the three numbers
     * because a message is the only one of these bodies allowed to be long.
     */
    limitBody("Activity", MAX_ACTIVITY_BODY_BYTES),
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
         * A person saying something in an archived channel restores it (a Bot's reply does not; see
         * the store). That is a real unarchiving with a real actor, and the store cannot write it
         * down — it holds no audit store — so this does, from what the store reports back. `restored`
         * is therefore the only thing this route may key on: it already carries who spoke. Without it
         * the trail shows `channel.archived` and no matching
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

  routes.put(
    "/:channelId/pin",
    requireUser,
    // One boolean, so the small cap: `MAX_SMALL_BODY_BYTES` argues the size. It is here rather than
    // nowhere because the two checks below run on an object `context.req.json()` has already built out
    // of however many bytes arrived, and "Pinned must be true or false." is not an answer that
    // bounded anything.
    limitBody("Pin", MAX_SMALL_BODY_BYTES),
    async (context) => {
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
    },
  );

  routes.put(
    "/:channelId/archive",
    requireUser,
    // One boolean, like the pin route above, and capped from the same constant rather than a second
    // number that means the same thing. This is the route the review actually caught: an 8 MB body
    // was read off the socket, `JSON.parse`d whole, and answered 200 because `archived: true` was
    // somewhere inside it.
    limitBody("Archive", MAX_SMALL_BODY_BYTES),
    async (context) => {
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
    },
  );

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

/**
 * Whatever the store threw, as the JSON shape every refusal on these routes uses.
 *
 * IT USED TO RETHROW whatever it did not recognise. Nothing in this server registered an `onError`
 * then, so Hono answered its own `text/plain "Internal Server Error"` — and `client()` in the browser
 * reads `body.error` and falls back to its own sentence when the body is not JSON. `roster/routes.ts`
 * was fixed to answer `{ error }` with 500 and log a line; leaving these two rethrowing meant a
 * database blip made `GET /api/roster` readable and `PUT /api/channels/:id/archive` unreadable, which
 * is exactly the split `bot-chats/routes.ts`'s header names: one roster whose rows behave differently
 * depending on which kind they are. `app.ts` registers one now, and this function still runs first: a
 * mounted sub-app with no `onError` of its own falls through to the parent's, so that handler only
 * ever sees what this file did not expect.
 *
 * Fixed here rather than with an app-level `onError`, which would have caught the audit reader's
 * `HTTPException` 400s too and answered them 500: those rely on Hono's default handler calling
 * `err.getResponse()`. That objection is answered rather than dropped in the handler `app.ts` now
 * carries — it delegates to `getResponse()` first, duck-typed on the method rather than `instanceof
 * HTTPException` so a sub-app with its own copy of hono is served too — which is why the two
 * co-exist: the translations below are this file's to make, and a backstop that guessed at them would
 * be a second, quieter copy of them.
 *
 * The sentence names the server as the side that failed and says nothing else. What was thrown may
 * carry a connection string or an upstream host, so it goes to the log instead — unconditionally,
 * because everything reaching this line is unexpected, including a bug in this file's own DTO, and a
 * 500 with no log line is an outage indistinguishable from a typo. The method and path go with it
 * because this file serves eight routes, so "which channel call broke" is not otherwise answerable.
 */
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
  console.error(
    JSON.stringify({
      type: "channel-request-failed",
      method: context.req.method,
      path: context.req.path,
      error: String(error),
      note: "A channel route could not be answered. Somebody was shown an error instead of their conversation.",
    }),
  );
  return context.json(
    { error: "The server could not complete that request." },
    500,
  );
}
