/**
 * Direct Bot chats, as durable rows.
 *
 * WHAT THIS REPLACES. A thread id in one browser's `localStorage`, one per Bot, overwritten by a
 * button labelled "New chat". The transcript stayed in Intelligence and nothing in this deployment
 * could name it again.
 *
 * SHAPED AFTER `createChannelStore`, deliberately, because the two are read by one query and any
 * behaviour that differs between them shows up as a roster whose rows behave differently depending on
 * which kind they are. Where a rule here looks arbitrary, the reason is usually that channels already
 * do it that way.
 *
 * Every method is scoped to `actor.id`. A row belonging to somebody else is reported exactly as a row
 * that does not exist, so ownership is not something an outsider can probe for.
 */
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import {
  CHANNEL_ACTIVITY_TOPIC,
  type RosterActivityEvent,
} from "../channels/events";
import type { ChannelActivity } from "../channels/routes";
import type { ThreadIdentity } from "../channels/thread-identity";
import type { Database } from "../db/client";
import { agentProfiles, botChats } from "../db/schema";
import { previewOf, titleOf } from "../roster/preview";

export type BotChat = {
  id: string;
  agentId: string;
  threadId: string;
  /** What the roster calls it, or null until the person has said something. */
  title: string | null;
  /** Whether this conversation's Bot is still around. False for a retired one. */
  active: boolean;
  archived: boolean;
};

export type BotChatStore = {
  /** Start a conversation with a Bot, on a thread nothing else has. */
  create(actor: AgentActor, agentId: string): Promise<BotChat>;
  /**
   * Take over a thread the browser already had, so a conversation that predates this table is not
   * orphaned in Intelligence. Idempotent for the person who owns it; throws
   * `BotChatThreadTakenError` when somebody else does.
   */
  adopt(actor: AgentActor, agentId: string, threadId: string): Promise<BotChat>;
  /** The caller's own chat, or null for an unknown, deleted, or somebody else's one. */
  get(actor: AgentActor, id: string): Promise<BotChat | null>;
  /** The caller's newest non-archived chat with this Bot, or null when there is none. */
  mostRecent(actor: AgentActor, agentId: string): Promise<BotChat | null>;
  /**
   * Record the last thing said. Moves forwards only, titles the conversation from the person's
   * first message, and restores it if it was archived.
   */
  recordActivity(
    actor: AgentActor,
    id: string,
    activity: ChannelActivity,
  ): Promise<void>;
  /** Pin or unpin. Throws `BotChatNotFoundError` for anything the caller does not own. */
  setPinned(actor: AgentActor, id: string, pinned: boolean): Promise<void>;
  /** Stamp the caller's chat as read now. Throws `BotChatNotFoundError` as above. */
  markRead(actor: AgentActor, id: string): Promise<void>;
  /**
   * Archive or restore. Hidden, not frozen: the conversation stays live and `recordActivity` clears
   * the archive on its own.
   */
  setArchived(actor: AgentActor, id: string, archived: boolean): Promise<void>;
  /** Hide the conversation. Soft: the row and the thread survive, every read filters. */
  softDelete(actor: AgentActor, id: string): Promise<void>;
};

/** What every read of a chat selects, so one function can turn any of them into a {@link BotChat}. */
type ChatRow = {
  id: string;
  agentId: string;
  threadId: string;
  title: string | null;
  archivedAt: Date | null;
  /** When this chat's Bot was retired, or null. Joined, not stored here. */
  profileDeletedAt: Date | null;
};

function chatFrom(row: ChatRow): BotChat {
  return {
    id: row.id,
    agentId: row.agentId,
    threadId: row.threadId,
    title: row.title,
    /*
     * A Bot is retired by soft-deleting its `agent_profiles` row, never by deleting the `agents`
     * row, so this conversation stays readable and merely reports its coworker as gone. That is the
     * same thing a channel reports about a deleted coworker, and it is what keeps a retirement from
     * silently taking a transcript with it.
     */
    active: row.profileDeletedAt === null,
    archived: row.archivedAt !== null,
  };
}

/** Every column a chat is rebuilt from, for the reads that join the profile in. */
const chatProjection = {
  id: botChats.id,
  agentId: botChats.agentId,
  threadId: botChats.threadId,
  title: botChats.title,
  archivedAt: botChats.archivedAt,
  profileDeletedAt: agentProfiles.deletedAt,
};

/**
 * Most recent first, where starting a conversation counts as activity.
 *
 * The same shape as `RECENCY` in `roster/order.ts`, over this table's own two columns; that module's
 * expression is written against `channels` and says so. `bot_chats_recent_activity_idx` is declared
 * on this expression, so the ordering is an index read rather than a sort.
 */
const RECENCY = sql`coalesce(${botChats.lastMessageAt}, ${botChats.createdAt})`;

export function createBotChatStore(
  database: Database,
  profileStore: AgentProfileStore,
  threadIdentity: ThreadIdentity,
): BotChatStore {
  return {
    create(actor, agentId) {
      return database.transaction(
        async (transaction) => {
          // Validated on this transaction, not through `profileStore.get`: the read has to share the
          // connection this transaction already holds, and has to hold the profile so the Bot cannot
          // be retired between passing the check and being named by the new row.
          const profile = await profileStore.getWithin(
            transaction,
            actor,
            agentId,
          );
          if (!profile) throw new AgentNotFoundError(agentId);

          const id = `botchat_${crypto.randomUUID()}`;
          // Minted rather than a bare random id, so the thread says which deployment it belongs to
          // in a project that may hold more than one. See thread-identity.ts.
          const threadId = threadIdentity.mint();

          await transaction
            .insert(botChats)
            .values({ id, userId: actor.id, agentId, threadId });

          // `getWithin` filters out a retired profile, so having one in hand is what makes this true.
          return {
            id,
            agentId,
            threadId,
            title: null,
            active: true,
            archived: false,
          };
        },
        { isolationLevel: "read committed" },
      );
    },

    adopt(actor, agentId, threadId) {
      return database.transaction(
        async (transaction) => {
          // Held for the same reason `create` holds it: this row names the agent, so the agent must
          // not be retired between the check and the insert. It also means an agent that does not
          // exist is refused by name rather than by a foreign-key violation from the driver.
          //
          // Load-bearing and easy to miss: `getWithin` takes its lock with `SELECT ... FOR SHARE`
          // (see `lockProfileReadRow` in `profile-store.ts`), and share locks are compatible with
          // each other. Two concurrent adopters of the same Bot both pass this line and both reach
          // the insert below — they do not serialize here. What decides their race is the unique
          // index on `bot_chats.thread_id`, exercised in the conflict path a few lines down. If this
          // ever becomes `FOR UPDATE`, the two adopters would serialize instead, the second one's
          // insert would stop conflicting, and the "gives one row to two adoptions that race" test in
          // bot-chat-store.integration.test.ts would keep passing while no longer testing the thing
          // its name says it tests.
          const profile = await profileStore.getWithin(
            transaction,
            actor,
            agentId,
          );
          if (!profile) throw new AgentNotFoundError(agentId);

          const id = `botchat_${crypto.randomUUID()}`;

          // Insert first and let the constraint answer, rather than reading and then writing. A read
          // followed by a write is two statements on two snapshots: two tabs adopting the same
          // remembered thread both find it absent and both insert, and one conversation becomes two
          // rows pointing at one transcript.
          const inserted = await transaction
            .insert(botChats)
            .values({ id, userId: actor.id, agentId, threadId })
            .onConflictDoNothing({ target: botChats.threadId })
            .returning({
              id: botChats.id,
              agentId: botChats.agentId,
              threadId: botChats.threadId,
              title: botChats.title,
              archivedAt: botChats.archivedAt,
            });

          const [row] = inserted;
          if (row) {
            return chatFrom({ ...row, profileDeletedAt: profile.deletedAt });
          }

          // Somebody already has it. There are three shapes that row can take, and only one of them
          // is an outcome this call should hand back:
          //
          //   - the caller's own live row: return it. Two tabs adopting the same remembered thread is
          //     exactly the race this function exists to survive, so idempotence here is the point.
          //   - the caller's own row, but soft-deleted: refuse. Do NOT clear `deleted_at` and
          //     resurrect it — that is the same "undone by navigation" mistake `mostRecent` already
          //     refuses for archived rows, applied to a stronger act: a person who deleted this
          //     conversation should not get it back because a background adoption they never asked
          //     for found the thread id still sitting in a browser's storage. And returning it plain,
          //     un-resurrected, is worse than refusing: a `BotChat` this function hands back is a
          //     `BotChat` the obvious next move is to navigate to, and `get` filters deleted rows out,
          //     so that move would land on "this conversation is not here any more." Refusing here
          //     means the route above can answer 409, which the client already treats as success —
          //     the refusal itself is what clears the remembered thread id.
          //   - somebody else's row, live or deleted: refuse. This is the case the function is named
          //     for, and it answers the same `BotChatThreadTakenError` as the case above so that
          //     which one happened is not something the response lets a caller tell apart — ownership
          //     and not-found read alike everywhere else in this store, and this is no exception.
          //
          // The profile is joined loosely, because the decision below has to come from the
          // `bot_chats` row alone: an inner join would turn a row whose Bot has no profile at all
          // into "taken by somebody else", which is a refusal for the wrong reason.
          const [existing] = await transaction
            .select({
              ...chatProjection,
              userId: botChats.userId,
              deletedAt: botChats.deletedAt,
            })
            .from(botChats)
            .leftJoin(
              agentProfiles,
              eq(agentProfiles.agentId, botChats.agentId),
            )
            .where(eq(botChats.threadId, threadId));
          if (
            !existing ||
            existing.userId !== actor.id ||
            existing.deletedAt !== null
          ) {
            throw new BotChatThreadTakenError(threadId);
          }
          return chatFrom(existing);
        },
        { isolationLevel: "read committed" },
      );
    },

    async get(actor, id) {
      const [row] = await database
        .select(chatProjection)
        .from(botChats)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, botChats.agentId))
        .where(
          and(
            eq(botChats.id, id),
            // Not a chat, not this person's chat, or a deleted one: the same answer every way, so
            // whether a conversation exists is not something an outsider can probe for.
            eq(botChats.userId, actor.id),
            isNull(botChats.deletedAt),
          ),
        );
      // Deliberately no filter on `archived_at`. Archived is hidden from the roster, not from a
      // direct read: the URL of an archived conversation still opens it, which is what makes
      // archiving reversible rather than a deletion wearing a gentler name.
      return row ? chatFrom(row) : null;
    },

    async mostRecent(actor, agentId) {
      const [row] = await database
        .select(chatProjection)
        .from(botChats)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, botChats.agentId))
        .where(
          and(
            eq(botChats.userId, actor.id),
            eq(botChats.agentId, agentId),
            isNull(botChats.deletedAt),
            /*
             * Archived rows are skipped here, and only here.
             *
             * This is what the `?agent=` resolver uses to decide which conversation opening a Bot
             * lands on. Handing back something the person put away would restore it by navigation:
             * the next thing they said would clear `archived_at`, and the archive would have been
             * undone by an act nobody meant as one. A fresh conversation is the honest answer.
             */
            isNull(botChats.archivedAt),
          ),
        )
        .orderBy(sql`${RECENCY} desc`, desc(botChats.id))
        .limit(1);
      return row ? chatFrom(row) : null;
    },

    recordActivity(actor, id, activity) {
      return database.transaction(
        async (transaction) => {
          const [row] = await transaction
            .select({
              agentId: botChats.agentId,
              title: botChats.title,
              archivedAt: botChats.archivedAt,
            })
            .from(botChats)
            .where(
              and(
                eq(botChats.id, id),
                eq(botChats.userId, actor.id),
                // A deleted chat is not there to report on. `get` filters the same way, so without
                // this a client holding a stale roster row could bump `last_message` on a
                // conversation nobody can see and announce it, sending its owner's tabs to refetch
                // a row that cannot appear.
                isNull(botChats.deletedAt),
              ),
            );
          // Not a chat, not this person's, or a deleted one: the same answer every way, matching
          // `get`.
          if (!row) throw new BotChatNotFoundError(id);

          // A bot chat has exactly one Bot, so an id naming a different one is a report about a
          // conversation this is not. Refused rather than recorded, because recording it would
          // attribute somebody else's Bot's words to this transcript.
          if (activity.agentId !== null && activity.agentId !== row.agentId) {
            throw new AgentNotFoundError(activity.agentId);
          }

          const lastMessage = previewOf(activity.text);
          const applied = await transaction
            .update(botChats)
            .set({
              lastMessage,
              lastMessageAt: activity.at,
              lastMessageAgentId: activity.agentId,
              /*
               * Saying something in an archived conversation is how it comes back. Cleared
               * unconditionally rather than only when set, because the guard below is what decides
               * whether this write happens at all, and a second clear of an already-null column
               * changes nothing.
               */
              archivedAt: null,
              updatedAt: new Date(),
              /*
               * Titled once, from the person's first message.
               *
               * Never from the Bot's: the same greeting opens every chat, so titling from it would
               * make every row in the roster identical. And never again after the first, so the
               * name of a conversation does not change under somebody mid-conversation.
               */
              ...(row.title === null && activity.agentId === null
                ? { title: titleOf(activity.text) }
                : {}),
            })
            .where(
              and(
                eq(botChats.id, id),
                // A person's message and the Bot's reply are reported separately, so they can arrive
                // out of order. Only ever move forwards. This is also what keeps a stale report from
                // clearing `archived_at`: a late arrival cannot un-archive what it predates.
                or(
                  isNull(botChats.lastMessageAt),
                  lt(botChats.lastMessageAt, activity.at),
                ),
              ),
            )
            .returning({ id: botChats.id });
          // Nothing changed, so there is nothing to announce: a stale report is not news.
          if (applied.length === 0) return;

          /*
           * Announced inside the transaction, so it is delivered on commit and a write that rolls
           * back is never announced.
           *
           * `memberIds` is the owner and nobody else, because a bot chat has exactly one interested
           * party. No `channelId`: there is no channel, and an old replica reading that field finds
           * it undefined and refetches, which is the harmless path a stale roster already takes.
           */
          const event: RosterActivityEvent = {
            kind: "bot_chat",
            id,
            memberIds: [actor.id],
            lastMessage,
            lastMessageAt: activity.at.toISOString(),
            lastMessageAgentId: activity.agentId,
            // Only when this write actually restored something, so an ordinary message does not
            // carry an archive state the receiver then has to decide to ignore.
            ...(row.archivedAt !== null ? { archived: false } : {}),
          };
          await transaction.execute(
            sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
          );
        },
        { isolationLevel: "read committed" },
      );
    },

    async setPinned(actor, id, pinned) {
      await database.transaction(
        async (transaction) => {
          const updated = await transaction
            .update(botChats)
            // No `updatedAt`. A pin is the caller's own state, which on a channel lives on the
            // membership row and does not touch the conversation's `updated_at`; a bot chat keeps
            // both on one row, and that is not a reason for the fact to start behaving differently.
            .set({ pinnedAt: pinned ? new Date() : null })
            .where(
              and(
                eq(botChats.id, id),
                eq(botChats.userId, actor.id),
                // A deleted chat is not there to pin. Without this, pinning one succeeds and
                // announces, and the announcement sends this person's tabs to refetch a roster that
                // cannot show the row.
                isNull(botChats.deletedAt),
              ),
            )
            .returning({ id: botChats.id });
          // Not a chat, not this person's, or a deleted one: the same answer every way.
          if (updated.length === 0) throw new BotChatNotFoundError(id);

          // Deliberately no consultation of `archived_at`. Archived is hidden, not frozen, and a
          // person may well pin something they have put away.
          const event: RosterActivityEvent = {
            kind: "bot_chat",
            id,
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

    async markRead(actor, id) {
      const updated = await database
        .update(botChats)
        .set({
          /*
           * The later of this clock and the conversation's own last-message stamp. last_message_at
           * is written from the reporting browser's clock and is not bounded; a marker stamped
           * plainly "now" by a server running behind it would leave the row reading as unseen,
           * re-lighting the dot on every refetch until wall clock catches up.
           */
          lastReadAt: sql`greatest(now(), coalesce(${botChats.lastMessageAt}, now()))`,
        })
        .where(
          and(
            eq(botChats.id, id),
            eq(botChats.userId, actor.id),
            // A deleted chat is not there to read. The same guard `setPinned` carries, for the same
            // reason: the row is gone from every roster, so nothing about it is markable.
            isNull(botChats.deletedAt),
          ),
        )
        .returning({ id: botChats.id });
      // Not a chat, not this person's, or a deleted one: the same answer every way.
      //
      // No consultation of `archived_at` and no announcement, matching channels: reading is the
      // caller's own state, and the tab that did it already knows.
      if (updated.length === 0) throw new BotChatNotFoundError(id);
    },

    async setArchived(actor, id, archived) {
      await database.transaction(
        async (transaction) => {
          const [row] = await transaction
            .select({ archivedAt: botChats.archivedAt })
            .from(botChats)
            .where(
              and(
                eq(botChats.id, id),
                eq(botChats.userId, actor.id),
                // A deleted chat is not there to archive, the same way it is not there to pin.
                isNull(botChats.deletedAt),
              ),
            );
          // Not a chat, not this person's, or a deleted one: the same answer every way.
          if (!row) throw new BotChatNotFoundError(id);

          // Already where the caller wants it. Returning here rather than writing is what makes a
          // repeat call a no-op instead of a fresh stamp and a second announcement.
          const alreadyThere = archived
            ? row.archivedAt !== null
            : row.archivedAt === null;
          if (alreadyThere) return;

          await transaction
            .update(botChats)
            .set({
              archivedAt: archived ? new Date() : null,
              updatedAt: new Date(),
            })
            .where(eq(botChats.id, id));

          // Announced inside the transaction, so it rides the commit and a refused archive announces
          // nothing at all.
          const event: RosterActivityEvent = {
            kind: "bot_chat",
            id,
            memberIds: [actor.id],
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

    async softDelete(actor, id) {
      await database.transaction(
        async (transaction) => {
          const deleted = await transaction
            .update(botChats)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(botChats.id, id),
                eq(botChats.userId, actor.id),
                // The guard on `deleted_at` is what makes a repeat call write nothing rather than
                // lay down a second stamp. The caller is then told the same "not found" every other
                // path gives for a deleted row, which is the honest answer: it is already gone.
                isNull(botChats.deletedAt),
              ),
            )
            .returning({ id: botChats.id });
          if (deleted.length === 0) throw new BotChatNotFoundError(id);

          /*
           * Announced inside the transaction, so it is delivered on commit and a refused delete
           * announces nothing.
           *
           * The owner is told even though they asked for it, because they may have several tabs and
           * several replicas open: without this the others keep rendering a row whose conversation
           * no longer resolves until something else makes them refetch.
           */
          const event: RosterActivityEvent = {
            kind: "bot_chat",
            id,
            memberIds: [actor.id],
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
  };
}

export class BotChatNotFoundError extends Error {
  constructor(id: string) {
    super(`Bot chat ${id} was not found.`);
    this.name = "BotChatNotFoundError";
  }
}

export class BotChatThreadTakenError extends Error {
  constructor(threadId: string) {
    super(`Thread ${threadId} already belongs to another conversation.`);
    this.name = "BotChatThreadTakenError";
  }
}
