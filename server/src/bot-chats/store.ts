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
import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { RosterActivityEvent } from "../channels/events";
import { announce, type ChannelActivity } from "../channels/routes";
import type { ThreadIdentity } from "../channels/thread-identity";
import type { Database } from "../db/client";
import {
  agentProfiles,
  botChats,
  intelligenceChannelMappings,
} from "../db/schema";
import { recencyOf } from "../roster/order";
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
   * orphaned in Intelligence. Idempotent for the person who owns it with the same Bot; throws
   * `BotChatThreadTakenError` when somebody else owns it, when they deleted it themselves, when the
   * thread is already a conversation with a different Bot, and when the thread is a channel's rather
   * than a bot chat's at all.
   */
  adopt(actor: AgentActor, agentId: string, threadId: string): Promise<BotChat>;
  /** The caller's own chat, or null for an unknown, deleted, or somebody else's one. */
  get(actor: AgentActor, id: string): Promise<BotChat | null>;
  /**
   * The caller's newest non-archived chat with this Bot, or null when there is none.
   *
   * No route reads this today, and the browser reaches the same answer for itself over the roster it
   * has already loaded (`mostRecentBotChat` in `app/src/routes/_authed/_app/bot.tsx`, whose comment
   * records that the two once disagreed). Kept, and said out loud rather than left to be discovered,
   * because two definitions of one ordering is how they drifted the first time.
   */
  mostRecent(actor: AgentActor, agentId: string): Promise<BotChat | null>;
  /**
   * Record the last thing said, and report whether doing so brought an archived conversation back.
   *
   * `last_message` moves forwards only, so a report that arrives late is dropped. Two things do not
   * ride that guard, and each has a statement of its own: the title, which is written from the
   * person's first message whenever that message arrives, because which message names a conversation
   * has nothing to do with which one arrived last; and the archive clear, which is measured against
   * `archived_at`, because whether a conversation is hidden is a different question from what its
   * last message was.
   *
   * Only a PERSON's message clears the archive, and only one said after the archive. A Bot's reply
   * moves the preview and the recency and leaves an archived conversation archived, so the reply to a
   * question asked before the archive cannot undo it — and neither can the person's own report of a
   * message they sent before it. The implementation argues both at length.
   *
   * `restored` is for the route above, which writes the trail: a person speaking in an archived
   * conversation clears the archive, and that is a restore nobody performed as such.
   */
  recordActivity(
    actor: AgentActor,
    id: string,
    activity: ChannelActivity,
  ): Promise<{ restored: boolean }>;
  /** Pin or unpin. Throws `BotChatNotFoundError` for anything the caller does not own. */
  setPinned(actor: AgentActor, id: string, pinned: boolean): Promise<void>;
  /** Stamp the caller's chat as read now. Throws `BotChatNotFoundError` as above. */
  markRead(actor: AgentActor, id: string): Promise<void>;
  /**
   * Archive or restore. Hidden, not frozen: the conversation stays live, and a person's message
   * through `recordActivity` clears the archive on its own.
   *
   * Returns whether anything actually changed, matching `ChannelStore.setArchived` — the two are one
   * idea applied twice, and letting only one of them report change is exactly how they would drift.
   * The route above audits the act on this boolean, so it has to be the answer to "did this call move
   * the flag" and not "is the flag now where the caller asked": a repeat click must leave one row on
   * the trail, not two.
   */
  setArchived(
    actor: AgentActor,
    id: string,
    archived: boolean,
  ): Promise<boolean>;
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
  /**
   * The joined profile's own key, or null when this Bot has no profile row at all.
   *
   * Selected alongside `profileDeletedAt` because the profile is joined loosely everywhere, and a
   * loose join answers "no such row" with nulls in every one of its columns. Without this column
   * there is nothing to tell that apart from a row that is there and not deleted.
   */
  profileAgentId: string | null;
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
     *
     * Two conditions rather than one, and both load-bearing. `profileDeletedAt === null` alone means
     * either "the Bot is alive" or "the Bot has no profile row at all", which are opposite answers to
     * the question this field asks — and the second is what a loose join produces. The roster's own
     * bot-chat hydration tests the same pair, so a row's `active` reads the same whichever of the two
     * built it.
     */
    active: row.profileAgentId !== null && row.profileDeletedAt === null,
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
  profileAgentId: agentProfiles.agentId,
  profileDeletedAt: agentProfiles.deletedAt,
};

/**
 * Most recent first, where starting a conversation counts as activity.
 *
 * `roster/order.ts`'s rule, applied to this table's own two columns, rather than a third hand-written
 * copy of it. There were three: that module's header argues that a second server-side spelling of the
 * sort is exactly what lets the two kinds of conversation drift apart, and then the module left the
 * expression un-exported and the spellings accumulated anyway. It is exported now.
 *
 * `bot_chats_recent_activity_idx` is declared on this expression, so it is the leading part of
 * `mostRecent`'s ordering that comes out of the index in order. NOT THE WHOLE ORDERING, and an
 * earlier version of this comment said "an index read rather than a sort": `mostRecent` orders by
 * `RECENCY desc, id desc` and the index carries no `id`, so the plan is `Limit → Incremental Sort →
 * Index Scan` — the sort is real, and what makes it cheap is that the index delivers groups of equal
 * recency already in place, so only one such group is ever sorted under the `limit 1`.
 *
 * `roster/query.ts` retracts the same claim for the union's two branches, whose sort key leads with
 * the pin — which is in neither index. The retraction did not reach this line the first time.
 */
const RECENCY = recencyOf(botChats.lastMessageAt, botChats.createdAt);

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
          // ever becomes `FOR UPDATE`, the two adopters would serialize instead. Note what would NOT
          // happen: the insert below is unconditional and nothing reads `bot_chats` before it — the
          // one statement in between is the channel-thread check, which reads a table no adoption
          // writes and so cannot send one adopter down a different path from the other — so the
          // second adopter would still reach the insert, and it would still land in the conflict path
          // — against a row committed before it began rather than one racing it. The conflict path
          // does not become dead code, so do not delete it on that reasoning. What breaks is the
          // test: "gives one row to two adoptions that race" in bot-chat-store.integration.test.ts
          // would keep passing while no longer distinguishing this insert-first shape from a naive
          // read-then-write.
          const profile = await profileStore.getWithin(
            transaction,
            actor,
            agentId,
          );
          if (!profile) throw new AgentNotFoundError(agentId);

          /*
           * A thread that is already a channel's is not a thread this table may claim, and this read
           * is the only thing that says so.
           *
           * The uniqueness the insert below leans on is `bot_chats_thread_idx`, and it sees one
           * table. A channel's thread is claimed under a separate unique index on
           * `intelligence_channel_mappings.thread_id`, and nothing crosses the two — so without this
           * the insert conflicted with nothing and succeeded, leaving two roster rows (one `channel`,
           * one `bot_chat`) backed by one Intelligence transcript, the bot chat free to name a
           * different Bot. That is the harm the fourth bullet below refuses inside this table,
           * arriving from the other one.
           *
           * Reachable rather than theoretical: `threadId` is a field on `AgentChannel` and comes back
           * from `GET /api/channels/:id`, so an adopter is handed the value instead of having to
           * guess it.
           *
           * A plain read, and what it does and does not settle. A channel's thread is minted and
           * never adopted (`create` in channels/routes.ts), so the only order that gets here is
           * channel-first: by the time anything can name that thread id, the row this reads is
           * committed, which is the whole of the path a caller can walk. What a read cannot exclude
           * is a mapping that commits after it — there is no row yet to lock, no constraint spans the
           * two tables, and the channel side does not consult `bot_chats` either. Closing that would
           * take one index over both thread columns, which is a change to a table this file does not
           * own.
           */
          const [channelThread] = await transaction
            .select({ channelId: intelligenceChannelMappings.channelId })
            .from(intelligenceChannelMappings)
            .where(eq(intelligenceChannelMappings.threadId, threadId));
          // The same error and the same 409 the three cases below answer with, so which of the four
          // happened is not something a caller can tell apart.
          if (channelThread) throw new BotChatThreadTakenError(threadId);

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
            // The profile in hand is this row's, because this row was just written naming `agentId`,
            // and `getWithin` resolved it — so it is present and not retired.
            return chatFrom({
              ...row,
              profileAgentId: agentId,
              profileDeletedAt: profile.deletedAt,
            });
          }

          // Somebody already has a `bot_chats` row on it. There are four shapes that row can take,
          // and only one of them is an outcome this call should hand back:
          //
          //   - the caller's own live row with the Bot they named: return it. Two tabs adopting the
          //     same remembered thread is exactly the race this function exists to survive, so
          //     idempotence here is the point.
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
          //   - the caller's own live row, but with a different Bot: refuse. A thread carries one
          //     transcript and a bot chat has one Bot, so this request cannot be satisfied: the row
          //     that exists is not a conversation with the Bot that was asked for. Returning it would
          //     answer a request about one Bot with another Bot's conversation, and the obvious next
          //     move for a client holding a `BotChat` is to navigate to it — so the person would land
          //     in a transcript with a coworker they never opened. Repointing the row at `agentId`
          //     instead would be worse: the transcript stays and its Bot changes underneath it, which
          //     attributes everything already said to somebody who did not say it.
          //
          // The profile is joined loosely, matching `get` below and the roster's own bot-chat
          // hydration: no read of a chat withholds a row because a profile is missing, and the
          // decision below comes from the `bot_chats` columns alone — ownership, the Bot, and
          // `deleted_at`. Here that join is belt rather than load-bearing, because the Bot is compared
          // and `getWithin` has already proved that Bot's profile is present and not retired.
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
            existing.agentId !== agentId ||
            existing.deletedAt !== null
          ) {
            throw new BotChatThreadTakenError(threadId);
          }
          // Its Bot is the one `getWithin` just resolved, so what this hands back is a conversation
          // `get` will open: the row is live, it is the caller's, and its profile is present and not
          // retired.
          return chatFrom(existing);
        },
        { isolationLevel: "read committed" },
      );
    },

    async get(actor, id) {
      const [row] = await database
        .select(chatProjection)
        .from(botChats)
        /*
         * Loosely, matching `adopt` above and the roster's own bot-chat hydration, because whether a
         * Bot has a profile row is something to report and not a reason to withhold a conversation.
         *
         * An inner join here answered "not found" for a chat the roster lists and `adopt` hands back,
         * which is the one disagreement between these reads a client actually feels: it navigates to
         * what it was given and is told the conversation is not there. `chatFrom` is what makes the
         * loose join safe — it asks whether the profile row is present, rather than reading a null
         * that could mean either.
         */
        .leftJoin(agentProfiles, eq(agentProfiles.agentId, botChats.agentId))
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
        // Loosely, for the reason `get` gives: a read that answers "which conversation with this Bot"
        // must not skip one the roster is showing, whatever state the Bot's profile is in.
        .leftJoin(agentProfiles, eq(agentProfiles.agentId, botChats.agentId))
        .where(
          and(
            eq(botChats.userId, actor.id),
            eq(botChats.agentId, agentId),
            isNull(botChats.deletedAt),
            /*
             * Archived rows are skipped here, and only here.
             *
             * WOULD-BE, not is: no route mounts this method, and the browser resolves `?agent=` for
             * itself over the roster it has already loaded — `mostRecentBotChat` in
             * `app/src/routes/_authed/_app/bot.tsx`, which gets the same exclusion from reading the
             * `active` list rather than from a filter of its own. The interface docblock above says
             * the same thing; an earlier version of this comment said
             * "this is what the `?agent=` resolver uses", which pointed anybody changing `archived_at`
             * semantics at a method nothing calls.
             *
             * Kept, and the filter with it, because the day a route does mount this the answer has to
             * be the browser's: handing back a conversation the person put away would restore it by
             * navigation — the next thing they said would clear `archived_at` — and the archive would
             * have been undone by an act nobody meant as one. A fresh conversation is the honest
             * answer. Two definitions of one ordering is how these drifted the first time.
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
              lastMessage: botChats.lastMessage,
              lastMessageAt: botChats.lastMessageAt,
              lastMessageAgentId: botChats.lastMessageAgentId,
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
            )
            /*
             * Locked, because everything below is a decision about the row as this call found it.
             *
             * WHAT THE LOCK USED TO CARRY. `archived_at` read here was what decided whether the
             * announcement said `archived: false`. Unlocked, an archive committing between this
             * statement and the update read here as "was not archived"; the update cleared
             * `archived_at` regardless, and the event went out without the field. The conversation was
             * then restored in the database and still hidden in every tab until something unrelated
             * made them refetch — and a person saying something in an archived conversation is exactly
             * how it is meant to come back, which `app/src/lib/channels/use-channel-events.ts` argues
             * at length is the direction that must not be lossy.
             *
             * That fact now comes from the clear's own `returning` rather than from this read, so this
             * snapshot could no longer get it wrong. The lock stays because two other things still
             * rest on it: the refusals below are decided here and neither write carries a `deleted_at`
             * term, so without it a delete committing in the gap gets its chat written to and
             * announced; and the fields this call does not move are announced from this read, which is
             * the row's true state only while nothing else may write it.
             *
             * `FOR UPDATE` and not `FOR SHARE`: an archive must block on it rather than commit
             * underneath it. Note this is a `bot_chats` row and has nothing to do with the share lock
             * `adopt` takes on `agent_profiles`, which the adoption-race test depends on staying
             * shared.
             */
            .for("update");
          // Not a chat, not this person's, or a deleted one: the same answer every way, matching
          // `get`.
          if (!row) throw new BotChatNotFoundError(id);

          // A bot chat has exactly one Bot, so an id naming a different one is a report about a
          // conversation this is not. Refused rather than recorded, because recording it would
          // attribute somebody else's Bot's words to this transcript.
          if (activity.agentId !== null && activity.agentId !== row.agentId) {
            throw new AgentNotFoundError(activity.agentId);
          }

          /*
           * Titled once, from the person's first message, on a statement of its own.
           *
           * Its own statement because it must not ride the moves-forwards-only guard below. The two
           * halves of one exchange are reported separately and can arrive in either order, so a
           * person's first message can turn up after the Bot's reply — and under that guard the whole
           * report was discarded as stale and the conversation was never named. Which message names a
           * conversation has nothing to do with which one arrived last; the guard exists to stop a
           * late report rewinding `last_message_at`.
           *
           * Never from the Bot's message: the same greeting opens every chat, so titling from it would
           * make every row in the roster identical.
           *
           * `title IS NULL` in the `WHERE` rather than a decision taken from the read above, so
           * "titled once, never re-titled" survives two first messages arriving at once: the second
           * statement blocks, re-checks against what the first committed, and writes nothing instead
           * of renaming a conversation somebody is already reading.
           *
           * Skipped when `titleOf` finds nothing worth showing — a message of invisible characters —
           * which leaves the chat untitled so the next thing the person says gets to name it. Writing
           * that null would be a write that changed nothing and stamped `updated_at` for it.
           */
          const title =
            activity.agentId === null ? titleOf(activity.text) : null;
          if (title !== null) {
            await transaction
              .update(botChats)
              .set({ title, updatedAt: new Date() })
              .where(and(eq(botChats.id, id), isNull(botChats.title)));
          }

          const lastMessage = previewOf(activity.text);
          const saidByAPerson = activity.agentId === null;
          /*
           * The preview and the recency, on a guard that only ever moves forwards.
           *
           * A person's message and the Bot's reply are reported separately, so they can arrive out of
           * order and a late one must not drag the row's preview backwards.
           *
           * `<=` AND NOT `<`. An equal stamp from a later report is not a regression, and the clamp in
           * `parseActivityInput` is what makes equality ordinary rather than a coincidence: every
           * report from a client further out than `MAX_ACTIVITY_CLOCK_SKEW_MS` is rewritten to the same
           * bound, so two reports made inside one millisecond of the server's clock arrive carrying one
           * instant and the second was dropped as stale. Re-applying an equal stamp costs nothing — the
           * values are the ones already there, unless the report is genuinely a different message,
           * which is the case this is for.
           *
           * `lastMessage` is left out of the `SET` when the message renders as nothing, and
           * `lastMessageAgentId` goes with it. `previewOf` answers null for a message of only format
           * characters, and writing that null blanked the row's preview — the same write the title
           * above refuses, for the same reason, two statements away. A caller can send one: the parser
           * rejects on `text.trim()` and a zero-width space survives it. The author moves with the text
           * because the two are halves of one fact, what the row shows and who said it, and moving the
           * author alone leaves a person's words rendering under the Bot's name. `lastMessageAt` still
           * moves: the message is real, and recency is what the sort is for.
           */
          const applied = await transaction
            .update(botChats)
            .set({
              ...(lastMessage === null
                ? {}
                : { lastMessage, lastMessageAgentId: activity.agentId }),
              lastMessageAt: activity.at,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(botChats.id, id),
                or(
                  isNull(botChats.lastMessageAt),
                  lte(botChats.lastMessageAt, activity.at),
                ),
              ),
            )
            .returning({ id: botChats.id });

          /*
           * A PERSON speaking is how an archived conversation comes back. The Bot answering is not.
           *
           * The rule is "hidden but live — sending unarchives", and the person sending is what that
           * means. The two halves of one exchange are reported separately, so without this the
           * ordinary sequence was: ask the Bot something, put the conversation away, and a second
           * later the reply to the question asked BEFORE the archive lands, clears `archived_at`, and
           * the row is back in the sidebar with every tab refetching. Nobody did that, and it is why
           * the archive stopped feeling like it held.
           *
           * A reply that arrives after an archive therefore leaves the row archived and still moves
           * the preview, `last_message_at` and `last_message_agent_id` above: hidden, not frozen, so
           * the row found under Archived is the current one and sorts where its last message says. The
           * person can still bring it back by speaking in it, or with Restore.
           *
           * ON ITS OWN STATEMENT, and measured against `archived_at` rather than against
           * `last_message_at`. It rode the write above, which made the recency guard decide the archive
           * too, and that is the wrong question asked twice:
           *
           *   - A person's message OLDER than the stored last message failed to lift the archive. The
           *     row stayed hidden, `restored` was false so there was no trail row and no
           *     `archived: false` on the wire, and the POST still answered 204. A tab whose clock is a
           *     couple of seconds behind whatever last wrote `last_message_at` — the Bot's reply,
           *     usually — could not speak the conversation back into view at all, and nothing said why.
           *   - A person's message that PREDATED the archive did lift it, and put a
           *     `bot_chat.unarchived` row on the trail for a message sent before the archive existed.
           *     Excluding the Bot's reply fixed the half that was noticed; the person's own late report
           *     walks the identical path.
           *
           * Whether a conversation is hidden and what its last message was are different questions
           * about it, so they get a statement each. `archived_at IS NOT NULL` says out loud that only
           * an archived row is being cleared rather than resting on `<` against NULL being unknown, and
           * `archived_at < at` is the whole of the rule: a message said after the archive lifts it, one
           * said before it does not. The two stamps come from different clocks, which is what the
           * parser's clamp is for — it bounds the disagreement to the allowance either side. A message
           * stamped exactly `archived_at`, or one from a clock so wrong that the clamp puts it behind an
           * archive made in the last five minutes, leaves the row hidden and Restore is still there.
           *
           * `restored` therefore comes from this statement's `returning` and not from the read above:
           * it is the fact of what this write did. The event carries it so the browser moves the row
           * between lists, and the route writes `bot_chat.unarchived` from what this method returns, so
           * the two cannot disagree about what happened. It is idempotent for free — a repeated report
           * finds `archived_at` already null and reports nothing — where a `restored` taken from a
           * snapshot could announce `archived: false` for a row that is still archived and put a trail
           * row on an unarchiving that never happened: confidently wrong, which `audit.ts` argues is
           * worse than a silent one.
           *
           * `channels/routes.ts`'s `recordActivity` guards its own clear identically. This file's
           * header is why: one roster reads both kinds, and a rule that held for only one of them is
           * the archive implemented twice with two answers.
           */
          const cleared = saidByAPerson
            ? await transaction
                .update(botChats)
                .set({ archivedAt: null, updatedAt: new Date() })
                .where(
                  and(
                    eq(botChats.id, id),
                    isNotNull(botChats.archivedAt),
                    lt(botChats.archivedAt, activity.at),
                  ),
                )
                .returning({ id: botChats.id })
            : [];
          const restored = cleared.length > 0;

          /*
           * Neither write landed, so there is nothing to announce: a stale report is not news, and it
           * restored nothing either. Both terms, because either write can land without the other —
           * that is the point of their being two.
           *
           * A title may still have been written above. Deliberately not announced: this event carries
           * no title, and the browser spreads whatever arrives onto the row it holds, so an event sent
           * for a title alone would stamp this call's `lastMessage` over the preview the roster is
           * rendering (`applyRosterEvent` in use-channel-events.ts, which guards the pin path against
           * exactly that). The name is picked up by the next refetch, and by the next report that is
           * not stale.
           */
          if (applied.length === 0 && !restored) return { restored: false };

          /*
           * What the row holds now, which is not always what this report carried.
           *
           * The browser spreads these three onto the row it is rendering, so an event that carried
           * this call's values where the write did not take them would stamp a preview the row does not
           * have. Two cases: a report stale for the recency that still lifted the archive, and a
           * message that renders as nothing. In both, the fields that did not move are announced from
           * the locked read, which under that lock is the row's current state.
           */
          const announced =
            applied.length === 0
              ? {
                  lastMessage: row.lastMessage,
                  lastMessageAt: row.lastMessageAt,
                  lastMessageAgentId: row.lastMessageAgentId,
                }
              : {
                  lastMessage: lastMessage ?? row.lastMessage,
                  lastMessageAt: activity.at,
                  lastMessageAgentId:
                    lastMessage === null
                      ? row.lastMessageAgentId
                      : activity.agentId,
                };

          /*
           * Announced through the channel side's `announce`, on this transaction, so it is delivered
           * on commit and a write that rolls back is never announced.
           *
           * The channel side's helper and not a `pg_notify` of this file's own, which is what every
           * announcement in this file used to be. `announce` measures each payload against a budget
           * under NOTIFY's 8000-byte cap and splits the member list to fit; over the cap, `pg_notify`
           * fails inside the transaction and takes the write with it, so an announcement that does
           * not fit is a message that was never recorded. A bot chat's list is one id and its preview
           * is capped by `previewOf`, so nothing here reaches that budget — but that is an argument
           * about today's fields, and this file's header says a second spelling of the twin's
           * behaviour is exactly what lets the two kinds of row drift apart. There is one spelling.
           *
           * `memberIds` is the owner and nobody else, because a bot chat has exactly one interested
           * party. No `channelId`: there is no channel, and an old replica reading that field finds
           * it undefined and refetches, which is the harmless path a stale roster already takes.
           */
          const event: RosterActivityEvent = {
            kind: "bot_chat",
            id,
            memberIds: [actor.id],
            lastMessage: announced.lastMessage,
            lastMessageAt: announced.lastMessageAt?.toISOString() ?? null,
            lastMessageAgentId: announced.lastMessageAgentId,
            // Only when this write actually restored something, so an ordinary message does not
            // carry an archive state the receiver then has to decide to ignore.
            ...(restored ? { archived: false } : {}),
          };
          await announce(transaction, event);

          // The same fact the event above carries, for the route, which writes it to the trail: this
          // write is how an archived conversation comes back, and nobody performed that as an act.
          return { restored };
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
          //
          // Through `announce` on this transaction, for the reasons `recordActivity` gives above.
          const event: RosterActivityEvent = {
            kind: "bot_chat",
            id,
            memberIds: [actor.id],
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            pinned,
          };
          await announce(transaction, event);
        },
        { isolationLevel: "read committed" },
      );
    },

    async markRead(actor, id) {
      const updated = await database
        .update(botChats)
        .set({
          /*
           * The later of this clock and the conversation's own last-message stamp. last_message_at is
           * written from the reporting browser's clock, and although `parseActivityInput` now bounds
           * how far ahead of this server that clock may be, the bound is not zero: a marker stamped
           * plainly "now" by a server running behind would leave the row reading as unseen,
           * re-lighting the dot on every refetch until wall clock catches up. The channel twin's
           * `markRead` carries this same paragraph, and this copy had not been brought forward.
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

    setArchived(actor, id, archived) {
      return database.transaction(
        async (transaction) => {
          /*
           * The state this call is moving away from is a term in the `WHERE`, not a decision taken
           * from an earlier read.
           *
           * Written this way for the reason `adopt` inserts before it reads: a read and then a write
           * is two statements on two snapshots. Under READ COMMITTED two callers archiving the same
           * conversation at once both read `archived_at` null, both write, and both report they
           * changed something — and this boolean is what gates the route's audit row and this method's
           * announcement, so one archiving became two rows on the trail and two whole-roster refetches
           * in every tab. With the term here, the second statement blocks on the first, re-checks
           * against the row the first committed, matches nothing, and says honestly that it changed
           * nothing. A repeat call is the same shape as a race and gets the same answer.
           */
          const applied = await transaction
            .update(botChats)
            .set({
              archivedAt: archived ? new Date() : null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(botChats.id, id),
                eq(botChats.userId, actor.id),
                // A deleted chat is not there to archive, the same way it is not there to pin.
                isNull(botChats.deletedAt),
                archived
                  ? isNull(botChats.archivedAt)
                  : isNotNull(botChats.archivedAt),
              ),
            )
            .returning({ id: botChats.id });

          if (applied.length === 0) {
            /*
             * Nothing was written, and there are two reasons for that. Told apart here, after the
             * write rather than before it, so no decision this method makes ever comes from a read
             * that could go stale underneath it.
             *
             * A row that is there and already where the caller wants it is a no-op: `false`, no
             * stamp, no announcement, no trail row. Anything else — not a chat, not this person's, or
             * one deleted, including one deleted while this ran — is the same "not found" every other
             * method in this store gives, so ownership stays unprobeable.
             */
            const [row] = await transaction
              .select({ id: botChats.id })
              .from(botChats)
              .where(
                and(
                  eq(botChats.id, id),
                  eq(botChats.userId, actor.id),
                  isNull(botChats.deletedAt),
                ),
              );
            if (!row) throw new BotChatNotFoundError(id);
            return false;
          }

          // Announced through `announce` on this transaction, so it rides the commit and a refused
          // archive announces nothing at all. See `recordActivity` for why the helper rather than a
          // `pg_notify` written here.
          const event: RosterActivityEvent = {
            kind: "bot_chat",
            id,
            memberIds: [actor.id],
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            archived,
          };
          await announce(transaction, event);

          return true;
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
           * Announced through `announce` on this transaction, so it is delivered on commit and a
           * refused delete announces nothing. See `recordActivity` for why the helper rather than a
           * `pg_notify` written here.
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
          await announce(transaction, event);
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
