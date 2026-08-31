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
   * Globally unique across both kinds, because ids are prefixed (`channel_...`, `botchat_...`). That
   * is what lets one cursor page a mixed list and one patch function find a row without being told
   * its kind.
   */
  id: string;
  /**
   * The channel's id, on a channel event only.
   *
   * @deprecated Carried alongside `id` for exactly one release, then removed.
   *
   * WHY IT IS STILL HERE. A rolling deploy runs new and old replicas at once. The old ones LISTEN on
   * this topic and read `channelId`; a straight rename would have them deliver malformed events to
   * every client they hold, and renaming the topic instead would drop events for the length of the
   * rollout. So this release is additive and the field goes in the next one, once no replica predates
   * `id`. `accounts.issuer` in core.ts ships nullable for the same reason.
   *
   * A bot chat event has no `channelId`, so an old replica delivers one with the field undefined. Its
   * clients read the channels list, find no such row, and refetch — which is the same harmless path a
   * stale roster already takes.
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

/** @deprecated Use {@link RosterActivityEvent}. Kept so existing imports keep compiling. */
export type ChannelActivityEvent = RosterActivityEvent;

type Send = (payload: string) => void;

export type ChannelEventHub = {
  /** Attach a connection for a person. Returns the detach. */
  register(userId: string, send: Send): () => void;
  /** Fan one event out to this instance's own connections. */
  deliver(event: RosterActivityEvent): void;
  connectionCount(userId: string): number;
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
      for (const userId of event.memberIds) {
        for (const send of connections.get(userId) ?? []) {
          try {
            send(JSON.stringify(event));
          } catch {
            // A connection that cannot be written to is one that is closing. Its own close handler
            // detaches it; failing here would deny the event to everybody after it in the set.
          }
        }
      }
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

  await connection.listen(CHANNEL_ACTIVITY_TOPIC, (payload) => {
    try {
      hub.deliver(JSON.parse(payload) as RosterActivityEvent);
    } catch {
      // A payload we cannot read is not a reason to tear down the subscription: the roster query is
      // still correct, and the next refetch shows whatever this event would have.
    }
  });

  return {
    stop: async () => {
      await connection.end();
    },
  };
}
