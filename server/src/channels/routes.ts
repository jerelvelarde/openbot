import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import {
  type AuditEventType,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
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
  rosterOrder,
} from "../roster/order";
import {
  DEFAULT_ROSTER_PAGE,
  MAX_ROSTER_PAGE,
  previewOf,
} from "../roster/preview";
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

export type ChannelQuery = { cursor?: string; limit?: number };

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
   * Throws ChannelNotFoundError for a non-member and ChannelPackageOwnedError for a channel the
   * tenant package defines, which configuration owns rather than any member.
   */
  softDelete(actor: AgentActor, channelId: string): Promise<void>;
  /**
   * Archive or restore the channel for every member. Hidden, not frozen: the conversation stays
   * live, and `recordActivity` clears the archive on its own.
   *
   * Throws ChannelNotFoundError for a non-member, an unknown channel, or a deleted one, and
   * ChannelPackageOwnedError for a channel the tenant package defines.
   */
  setArchived(
    actor: AgentActor,
    channelId: string,
    archived: boolean,
  ): Promise<void>;
  recordActivity(
    actor: AgentActor,
    channelId: string,
    activity: ChannelActivity,
  ): Promise<void>;
};

const PRIVATE_AGENT_CHANNEL_DESCRIPTION = "Private agent channel.";
const MAX_CHANNEL_NAME_CODE_POINTS = 120;

function channelName(names: string[]) {
  const joined = names.join(", ");
  const codePoints = Array.from(joined);
  if (codePoints.length <= MAX_CHANNEL_NAME_CODE_POINTS) return joined;
  return `${codePoints.slice(0, MAX_CHANNEL_NAME_CODE_POINTS - 1).join("")}…`;
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
          // Named from the caller's ordering, which is the order the channel presents its agents in.
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

          return { id, name, agentIds, threadId, active: true };
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
          threadId: intelligenceChannelMappings.threadId,
          deletedAt: agentProfiles.deletedAt,
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
        .innerJoin(
          agentProfiles,
          eq(agentProfiles.agentId, channelAgents.agentId),
        )
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .orderBy(asc(channelAgents.agentId));

      const first = rows[0];
      if (!first) return null;

      return {
        id: first.id,
        name: first.name,
        agentIds: rows.map((row) => row.agentId),
        threadId: first.threadId,
        active: rows.every((row) => row.deletedAt === null),
      };
    },

    async list(actor, query = {}) {
      const limit = Math.min(
        Math.max(query.limit ?? DEFAULT_ROSTER_PAGE, 1),
        MAX_ROSTER_PAGE,
      );
      const cursor: RosterCursor | undefined = decodeRosterCursor(query.cursor);

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
          recency: sql<Date>`${RECENCY}`,
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
            // One row comparison over the whole sort key, which only reads as "everything after the
            // cursor" because every part of that key descends. See ROSTER_ORDER.
            cursor
              ? sql`(${PINNED_RANK}, ${RECENCY}, ${channels.id}) < (${cursor.pinned ? 1 : 0}::int, ${cursor.recency}::timestamptz, ${cursor.id})`
              : undefined,
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
              recency: new Date(last.recency).toISOString(),
              id: last.id,
            })
          : null;

      if (wanted.length === 0) return { channels: [], nextCursor: null };

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
        .innerJoin(
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
            // on two snapshots, so a delete that commits between them would otherwise hand back a
            // channel this person can no longer see.
            isNull(channels.deletedAt),
          ),
        )
        // The same order the page was chosen in, since the rows below are read in order.
        .orderBy(...ROSTER_ORDER, asc(channelAgents.agentId));

      // One row per channel-agent pair; the ordering above keeps each channel's rows together and
      // its agents in the same lexicographic order `get` returns.
      const summaries = new Map<string, ChannelSummary>();
      for (const row of rows) {
        const summary = summaries.get(row.id);
        if (summary) {
          summary.agentIds.push(row.agentId);
          summary.active &&= row.deletedAt === null;
          continue;
        }
        summaries.set(row.id, {
          id: row.id,
          name: row.name,
          agentIds: [row.agentId],
          threadId: row.threadId,
          active: row.deletedAt === null,
          lastMessage: row.lastMessage,
          lastMessageAt: row.lastMessageAt,
          lastMessageAgentId: row.lastMessageAgentId,
          createdAt: row.createdAt,
          pinned: row.pinnedAt !== null,
          lastReadAt: row.lastReadAt,
        });
      }
      return { channels: [...summaries.values()], nextCursor };
    },

    async setPinned(actor, channelId, pinned) {
      await database.transaction(
        async (transaction) => {
          const updated = await transaction
            .update(channelMemberships)
            .set({ pinnedAt: pinned ? new Date() : null })
            .where(
              and(
                eq(channelMemberships.channelId, channelId),
                eq(channelMemberships.userId, actor.id),
                // A deleted channel is not there to pin. Without this, pinning one succeeds and
                // announces, and the announcement sends this person's tabs to refetch a roster that
                // cannot show the row. `get` and `list` filter the same way.
                exists(
                  transaction
                    .select({ one: sql`1` })
                    .from(channels)
                    .where(
                      and(
                        eq(channels.id, channelId),
                        isNull(channels.deletedAt),
                      ),
                    ),
                ),
              ),
            )
            .returning({ channelId: channelMemberships.channelId });
          // Not a member, no such channel, or a deleted one: the same answer every way, matching
          // recordActivity and `get`.
          if (updated.length === 0) throw new ChannelNotFoundError(channelId);

          /*
           * Announced to this member alone.
           *
           * A pin is a fact about one membership row, so `memberIds` holds the person who made it
           * and nobody else. The hub delivers by that list, which is what carries the pin across
           * this person's own tabs and replicas without putting it on anybody else's roster.
           */
          const event: RosterActivityEvent = {
            kind: "channel",
            id: channelId,
            channelId,
            memberIds: [actor.id],
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            pinned,
          };
          await transaction.execute(
            sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
          );
        },
        { isolationLevel: "read committed" },
      );
    },

    async markRead(actor, channelId) {
      const updated = await database
        .update(channelMemberships)
        .set({
          /*
           * The later of this clock and the channel's own last-message stamp. last_message_at is
           * written from the reporting browser's clock and is not bounded; a marker stamped
           * plainly "now" by a server running behind it would leave the row reading as unseen for
           * every member, re-lighting the dot on each refetch until wall clock catches up.
           */
          lastReadAt: sql`greatest(now(), coalesce((select ${channels.lastMessageAt} from ${channels} where ${channels.id} = ${channelMemberships.channelId}), now()))`,
        })
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, actor.id),
            // A deleted channel is not there to read. The same guard `setPinned` carries, for the
            // same reason: the row is gone from every roster, so nothing about it is markable.
            exists(
              database
                .select({ one: sql`1` })
                .from(channels)
                .where(
                  and(eq(channels.id, channelId), isNull(channels.deletedAt)),
                ),
            ),
          ),
        )
        .returning({ channelId: channelMemberships.channelId });
      // Not a member, or no such channel: the same answer either way, matching setPinned.
      if (updated.length === 0) throw new ChannelNotFoundError(channelId);
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
            .where(eq(channels.id, channelId));
          // Not a member, or no such channel: the same answer either way.
          if (!row) throw new ChannelNotFoundError(channelId);
          // Package channels are configuration; the sync that wrote them owns them.
          if (row.packageId !== null) {
            throw new ChannelPackageOwnedError(channelId);
          }
          // The guard on deletedAt is what makes a repeat call a no-op rather than a new stamp.
          await transaction
            .update(channels)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));

          // Read on this transaction, so the members told are the ones the channel had when it was
          // hidden. Soft leaves the membership rows in place, so this reads the same list a repeat
          // call would.
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
          const event: RosterActivityEvent = {
            kind: "channel",
            id: channelId,
            channelId,
            memberIds: members.map((member) => member.userId),
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            deleted: true,
          };
          await transaction.execute(
            sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
          );
        },
        { isolationLevel: "read committed" },
      );
    },

    async setArchived(actor, channelId, archived) {
      await database.transaction(
        async (transaction) => {
          const [row] = await transaction
            .select({
              packageId: channels.packageId,
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
            // A deleted channel is not there to archive. `get` and `list` filter the same way, so
            // without this a client holding a stale roster row could archive something invisible and
            // announce it to every member, each of whom refetches for a row that cannot appear.
            .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
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

          // Already where the caller wants it. Returning here rather than writing is what makes a
          // repeat call a no-op instead of a fresh stamp and a second announcement.
          const alreadyThere = archived
            ? row.archivedAt !== null
            : row.archivedAt === null;
          if (alreadyThere) return;

          await transaction
            .update(channels)
            .set({
              archivedAt: archived ? new Date() : null,
              updatedAt: new Date(),
            })
            .where(eq(channels.id, channelId));

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
          const event: RosterActivityEvent = {
            kind: "channel",
            id: channelId,
            channelId,
            memberIds: members.map((member) => member.userId),
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            archived,
          };
          await transaction.execute(
            sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
          );
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
            );
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
          // Nothing changed, so there is nothing to announce: a stale report is not news.
          if (applied.length === 0) return;

          const members = await transaction
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channelId));

          // Announced inside the transaction, so it is delivered on commit and a write that rolls
          // back is never announced. The payload carries the members because the writer has already
          // resolved them; NOTIFY caps at 8000 bytes, which a 200-character preview leaves room in.
          const event: RosterActivityEvent = {
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
            ...(membership.archivedAt !== null ? { archived: false } : {}),
          };
          await transaction.execute(
            sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
          );
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
 * Parse a reported message.
 *
 * `at` comes from the client that saw the message, because only it knows when the message arrived, * but it is never trusted as a clock: the store compares it against what is stored and only ever
 * moves forwards, so a wrong one can lose a report, not corrupt the row.
 */
export function parseActivityInput(input: unknown): ActivityInputParseResult {
  if (!isChannelInputObject(input)) {
    return { ok: false, error: "Activity must be a JSON object." };
  }
  const object = input as { text?: unknown; agentId?: unknown; at?: unknown };

  if (typeof object.text !== "string" || object.text.trim().length === 0) {
    return { ok: false, error: "Text is required." };
  }
  if (object.agentId !== null && typeof object.agentId !== "string") {
    return { ok: false, error: "Agent ID must be a string or null." };
  }
  if (typeof object.at !== "string") {
    return { ok: false, error: "Timestamp is required." };
  }
  const at = new Date(object.at);
  if (Number.isNaN(at.getTime())) {
    return { ok: false, error: "Timestamp must be an ISO-8601 date." };
  }

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
   * Write the one audit row this file ever writes, tolerantly.
   *
   * Mirrors `record` in agents/routes.ts: never fatal, because the channel is already hidden and the
   * caller has already been told so by the time this runs. A trail that is briefly unavailable is
   * not a reason to report a failure that did not happen.
   *
   * Reached only after the store call resolves, so a refused change — a channel the package owns, or
   * one the caller is not in — writes nothing. The trail records acts, not attempts.
   */
  const record = async (
    context: Context<{ Variables: AppVariables }>,
    eventType: AuditEventType,
    channelId: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (!auditStore) return;
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "channel",
        targetId: channelId,
        /*
         * Attributed, including in single-user mode.
         *
         * The other audited surfaces drop this id when the actor is the local development one, on
         * the grounds that `audit_events.actor_user_id` has a foreign key into `users` that it would
         * violate. It has no foreign key, and `initializeDevActorUser` writes that row at start-up
         * anyway, so neither half of the reason holds. It matters here more than most: single-user
         * is the mode `.env.example` ships switched on, so an unattributed row is what a fork sees
         * by default, and "somebody archived this conversation" is the whole point of the row.
         */
        actorUserId: context.var.actor.id,
        payload,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "channel-audit-write-failed",
          eventType,
          channelId,
          error: String(error),
        }),
      );
    }
  };

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
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const page = await store.list(context.var.actor, {
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      });

      return context.json({
        channels: page.channels.map(channelSummaryDto),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:channelId/activity", requireUser, async (context) => {
    const parsed = parseActivityInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      await store.recordActivity(
        context.var.actor,
        context.req.param("channelId"),
        parsed.value,
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

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
      await store.setArchived(context.var.actor, channelId, archived);
      // Reached only once the store has resolved, so a refused archive writes nothing.
      await record(
        context,
        archived ? "channel.archived" : "channel.unarchived",
        channelId,
        {},
      );
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
      await record(context, "channel.deleted", channelId, {
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
