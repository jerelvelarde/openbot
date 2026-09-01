import postgres from "postgres";

/**
 * Live channel activity, from whoever ran an agent to everybody else in the channel.
 *
 * The person who ran it already has the reply and reports it over HTTP; this is the other direction,
 * telling the channel's other members that something was said. It is an optimisation and never a
 * source of truth: the roster query stays authoritative, and a client that misses events while
 * disconnected recovers by refetching on reconnect. Nothing may be knowable only through the socket.
 *
 * Delivery goes through Postgres rather than an in-process list, because an in-process list is
 * silently wrong the moment a second server instance exists: the writer is on one and the listener
 * on the other, and the message is never delivered.
 */

export const CHANNEL_ACTIVITY_TOPIC = "channel_activity";

/**
 * Live roster activity, from whoever ran an agent to everybody who can see the conversation.
 *
 * TWO KINDS NOW. A channel has members; a bot chat has exactly one owner. Both are rows in one
 * roster, so both announce through here, and `memberIds` carries whoever may receive it either way —
 * the hub's delivery rule needs no knowledge of which kind it is holding.
 */
export type RosterActivityEvent = {
  /** Which kind of row this is about. The browser needs it to render, not to find the row. */
  kind: "channel" | "bot_chat";
  /**
   * The row's id.
   *
   * Unique across both kinds: generated ids are prefixed (`channel_...`, `botchat_...`), and a
   * package channel's chosen id is refused by `validateTenantPackage` if it enters one of those
   * namespaces. That is what lets one cursor page a mixed list and one patch function find a row
   * without being told its kind.
   */
  id: string;
  /**
   * The channel's id, on a channel event only.
   *
   * @deprecated Carried alongside `id` for exactly one release, then removed.
   *
   * WHY IT IS STILL HERE. For browser tabs still running the PREVIOUS bundle, which find a row by
   * `channelId` and know nothing of `id`. A deploy replaces replicas, not the page somebody left
   * open, so the far end of a socket can be a bundle that predates `id` long after every replica
   * carries it. The field goes in the next release, once no such tab can still be holding one.
   *
   * NOT for old replicas, though it reads as if it might be. An old replica does LISTEN on this
   * topic, but it routes by `memberIds` and hands its own clients the payload it parsed, so it never
   * reads `channelId` on the way past: keeping the field here changes nothing it does. The direction
   * that genuinely cannot be helped is the other one — an old replica emits `{channelId, ...}` with
   * no `id` at all, a shape no new bundle can read whatever this release sends.
   * `app/src/lib/channels/use-channel-events.ts` states this reasoning authoritatively; this is its
   * server half. `accounts.issuer` in core.ts ships nullable for the same class of reason.
   *
   * A bot chat event has no `channelId` to carry, so a previous bundle hearing one finds no such row
   * in the channels list and refetches — the same harmless path a stale roster already takes.
   */
  channelId?: string;
  /** Who may receive it. Resolved by the writer, which already had to check who that is. */
  memberIds: string[];
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** The conversation is hidden from every roster. Absent on an ordinary activity event. */
  deleted?: true;
  /**
   * One member's pin, changed. Absent on an ordinary activity event.
   *
   * A channel pin lives on one membership row, so the writer names that member alone in `memberIds`
   * and the hub's delivery rule does the rest: nobody else in the channel hears a pin they did not
   * make. A bot chat's owner is the only candidate either way.
   */
  pinned?: boolean;
  /**
   * The conversation's archive state, changed. Absent on an ordinary activity event.
   *
   * Also set to `false` on an activity event that restored an archived conversation, because saying
   * something in one is how it comes back.
   */
  archived?: boolean;
};

/**
 * What a browser is actually sent: the event without the list the hub routed it by.
 *
 * `memberIds` is an instruction to `deliver` and nobody's business on the far end. Sent, it would
 * hand every member the internal user id of every other member of the conversation, on every message,
 * archive and delete, for no purpose — the browser's mirror of this type in
 * `app/src/lib/channels/use-channel-events.ts` has never declared the field and nothing there reads
 * it. So this is the shape that goes out, and `RosterActivityEvent` is the shape that goes in.
 */
export type DeliveredRosterEvent = Omit<RosterActivityEvent, "memberIds">;

type Send = (payload: string) => void;

export type ChannelEventHub = {
  /** Attach a connection for a person. Returns the detach. */
  register(userId: string, send: Send): () => void;
  /** Fan one event out to this instance's own connections. */
  deliver(event: RosterActivityEvent): void;
  /**
   * Tell every connection this instance holds to re-read the roster. Returns how many were told.
   *
   * For the one case a live announcement cannot cover: this instance was not listening when
   * something was announced. See `startChannelActivityListener`, its only caller, for when that is
   * and why a push is the repair rather than a re-read on the server.
   */
  resyncAll(): number;
  connectionCount(userId: string): number;
};

/**
 * The id the resync event carries, and a name no conversation may take.
 *
 * Exported because two places have to agree on it and only one of them sends it: this event uses it
 * to name no row at all, and `validateTenantPackage` refuses it as a package channel id. That second
 * half is what makes the first half true — a `channels.yaml` chooses its ids by hand, so "no real row
 * is called this" holds only while something enforces it, and the enforcement has to be able to name
 * the same string this does. A channel that were called this would take the patch meant for nobody:
 * the three null activity fields below would land on it, and the recovery this event exists to
 * trigger would not happen for anybody whose roster holds that row.
 */
export const RESYNC_ROSTER_ID = "roster-resync";

/**
 * What a resync is sent as: an event naming a row that does not exist.
 *
 * There is no "refetch" frame on this wire and this server cannot add one, because the far end of a
 * socket is a browser bundle already deployed. What that bundle does with an event whose `id` no
 * cached list holds is documented and deliberate — `applyRosterEventToCaches` in
 * `app/src/lib/channels/use-channel-events.ts` invalidates the whole roster, calling it "the
 * stale-roster recovery", and does nothing at all when no roster is on screen. A gap in this
 * server's subscription IS a stale roster, so this uses that path rather than inventing one.
 *
 * Every field that would make the browser do something else is absent: no `deleted`, which navigates
 * a tab away from the conversation it names; no `pinned` or `archived`, which patch or move a row;
 * and an `id` no real row can carry, because every generated id is prefixed `channel_` or `botchat_`
 * and a package naming this one as a channel id is refused at load. `kind` is required by the wire
 * shape and is read only when a row is rendered, which this one never is.
 */
const RESYNC_EVENT: DeliveredRosterEvent = {
  kind: "channel",
  id: RESYNC_ROSTER_ID,
  lastMessage: null,
  lastMessageAt: null,
  lastMessageAgentId: null,
};

export function createChannelEventHub(): ChannelEventHub {
  const connections = new Map<string, Set<Send>>();

  return {
    register(userId, send) {
      const existing = connections.get(userId) ?? new Set<Send>();
      existing.add(send);
      connections.set(userId, existing);

      return () => {
        const remaining = connections.get(userId);
        if (!remaining) return;
        remaining.delete(send);
        // Dropped entirely rather than left empty, so a long-lived process does not accumulate a
        // set per person who ever connected.
        if (remaining.size === 0) connections.delete(userId);
      };
    },

    deliver(event) {
      // Serialised once for the whole fan-out, and without `memberIds`: see `DeliveredRosterEvent`
      // for why the routing list stops here.
      const { memberIds, ...delivered } = event;
      const payload = JSON.stringify(delivered);

      /*
       * Once per connection, not once per entry in `memberIds`.
       *
       * The writers build that list from a query — `select user_id from channel_memberships where
       * channel_id = ...` — so a name appearing in it twice is one join away, and delivering twice to
       * one socket is not a harmless duplicate: an archive event makes each tab that hears it refetch
       * the whole roster.
       */
      const sent = new Set<Send>();
      for (const userId of memberIds) {
        for (const send of connections.get(userId) ?? []) {
          if (sent.has(send)) continue;
          sent.add(send);
          try {
            send(payload);
          } catch {
            // A connection that cannot be written to is one that is closing. Its own close handler
            // detaches it; failing here would deny the event to everybody after it in the set.
          }
        }
      }
    },

    resyncAll() {
      const payload = JSON.stringify(RESYNC_EVENT);
      let told = 0;
      // Every connection of every person, because the gap this repairs is one in the subscription
      // itself: nothing says which announcements were missed, so nothing says whose they were.
      for (const sends of connections.values()) {
        for (const send of sends) {
          try {
            send(payload);
            told += 1;
          } catch {
            // A connection that cannot be written to is one that is closing; its own close handler
            // detaches it. Not counted, because the count is what the log line reports as told, and
            // failing here would deny the resync to everybody after it.
          }
        }
      }
      return told;
    },

    connectionCount(userId) {
      return connections.get(userId)?.size ?? 0;
    },
  };
}

export type ChannelActivityListener = { stop: () => Promise<void> };

/**
 * Listen for activity announced by any instance, including this one.
 *
 * On its own connection, because `LISTEN` holds one for the life of the subscription: taken from the
 * pool, it would be a connection the rest of the server never gets back.
 */
export async function startChannelActivityListener(
  databaseUrl: string,
  hub: ChannelEventHub,
): Promise<ChannelActivityListener> {
  const connection = postgres(databaseUrl, { max: 1 });

  /*
   * RE-ESTABLISHED, which is the case a live notification cannot cover.
   *
   * A NOTIFY reaches whoever is listening at the time. An instance whose connection had dropped is
   * not: postgres.js re-establishes the subscription on reconnect, but everything announced during
   * the gap is gone. `computer/policy-listener.ts` passes `onlisten` for exactly this reason, and its
   * docblock names it — "That is the original bug wearing a smaller hat, and it is worse for being
   * intermittent."
   *
   * WHY THE CLIENTS' OWN RECOVERY DOES NOT COVER IT. A browser refetches the roster on its socket's
   * `onopen` (`use-channel-events.ts`), and that socket stays open across a database reconnect on
   * this side — nothing closes it. So the browser never learns it missed anything, and archives,
   * deletes and other members' messages simply stop arriving until an unrelated refocus.
   *
   * A PUSH, NOT A RE-READ, which is where this differs from the policy listener. That one owns a
   * cache and can refresh it; this one owns nothing — the roster query is authoritative and its cache
   * lives in the browser. So the repair is to tell the attached clients to re-read, which is what
   * `RESYNC_EVENT` is for.
   *
   * NOT ON THE FIRST SUBSCRIPTION, and the flag is what tells the two apart. `onlisten` fires when the
   * subscription is established as well as when it is re-established, and on the first there is no gap
   * to repair: `index.ts` builds the hub and starts this listener during module initialisation, before
   * `Bun.serve` can accept the socket that would attach a connection to it. Resyncing there would send
   * a refetch to whoever happened to be attached — in the tests below, everybody — for a subscription
   * that had missed nothing.
   *
   * Said out loud, because a reconnect is otherwise invisible from this side and the symptom it
   * produces, "the sidebar stopped moving for a while", is unreportable without it. Only on the
   * reconnect: a line on every listener start would print in every test that starts one, for a
   * non-event.
   */
  let subscribed = false;
  const onListen = () => {
    if (!subscribed) {
      subscribed = true;
      return;
    }
    const resynced = hub.resyncAll();
    console.error(
      JSON.stringify({
        type: "channel-activity-listener-reattached",
        resynced,
        note: "This instance's roster subscription dropped and came back. Anything announced while it was gone was missed, so the clients it holds were told to re-read the roster.",
      }),
    );
  };

  await connection.listen(
    CHANNEL_ACTIVITY_TOPIC,
    (payload) => {
      try {
        hub.deliver(JSON.parse(payload) as RosterActivityEvent);
      } catch (error) {
        /*
         * Swallowed, and said out loud.
         *
         * Swallowed because a payload we cannot read is not a reason to tear down the subscription:
         * the roster query is still correct, the next refetch shows whatever this event would have,
         * and every later event still needs delivering.
         *
         * Said out loud because nothing else can tell. Anything that reaches here — a malformed
         * payload, a shape one replica writes and another cannot read mid-rollout, a throw from
         * `deliver` outside its own per-send guard — leaves every client this instance holds silently
         * without live updates until something unrelated makes them refetch, which is a bug report of
         * "the sidebar stops moving" with nothing in the log under it. The payload goes in truncated,
         * because its first 200 characters name the kind and the id and that is what tells those cases
         * apart.
         */
        console.error(
          JSON.stringify({
            type: "channel-activity-delivery-failed",
            payload: payload.slice(0, 200),
            error: String(error),
            note: "This instance heard a roster announcement it could not deliver. The clients it holds will not see that change until they refetch.",
          }),
        );
      }
    },
    onListen,
  );

  return {
    stop: async () => {
      await connection.end();
    },
  };
}
