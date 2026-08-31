import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  type RosterItem,
  type RosterPage,
  rosterKeys,
} from "@/lib/roster/queries";

/**
 * Keep the roster live.
 *
 * The query remains the source of truth; socket events only patch its cache. Reconnects refetch the
 * list to recover events missed while disconnected.
 */

export type RosterActivityEvent = {
  kind: "channel" | "bot_chat";
  /** The row's id. Globally unique across kinds, so nothing looks a row up by anything else. */
  id: string;
  /**
   * The channel's id, on a channel event from a server that still sends it.
   *
   * @deprecated Nothing here should read it.
   *
   * The wire keeps this field for one release for the sake of browser tabs still running the
   * PREVIOUS bundle, which look for `channelId` and know nothing of `id`. It is not for old
   * replicas: one of those emits `{channelId, ...}` with no `id` at all, which is a shape this file
   * cannot read whatever we do here. `server/src/channels/events.ts` carries the server half of the
   * reasoning.
   */
  channelId?: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** The row is gone from every member's roster. Absent on an ordinary activity event. */
  deleted?: true;
  /**
   * This member's pin, changed. Absent on an ordinary activity event.
   *
   * The server scopes a pin to the member who made it, so one arriving here is the reader's own,
   * made in another tab or on another replica.
   */
  pinned?: boolean;
  /** The row's archive state changed, so it has moved between lists. */
  archived?: boolean;
};

/** The infinite query's cache, which holds pages rather than one array. */
type RosterCache = { pages: RosterPage[]; pageParams: unknown[] };

/**
 * Apply one event to the cached pages.
 *
 * Pure, and exported, because the patching rules are the whole of what a socket event does to the
 * screen and they should be provable without a socket. Returns the cache it was given when nothing
 * changed, so React re-renders nothing, `"unknown"` when the event names a row no page holds — which
 * the caller answers with a refetch rather than a patch — and `"refetch"` when the row moved between
 * lists rather than merely changing a field.
 *
 * Rows are found by `activity.id` alone: the server prefixes ids so they are globally unique across
 * kinds, and `kind` is needed only for rendering, never for locating a row.
 */
export function applyRosterEvent(
  data: RosterCache,
  activity: RosterActivityEvent,
): RosterCache | "unknown" | "refetch" {
  const holdingPage = data.pages.findIndex((page) =>
    page.items.some((item) => item.id === activity.id),
  );

  // Must run before the patch below, which spreads the event onto the existing row — reaching that
  // first would stamp `deleted: true` on the row instead of removing it. An unknown row here is
  // already gone from this cache, so there is nothing to patch or invalidate for, unlike the
  // "unknown row" case below for an ordinary event.
  if (activity.deleted) {
    if (holdingPage === -1) return data;
    const page = data.pages[holdingPage] as RosterPage;
    const pages = data.pages.slice();
    pages[holdingPage] = {
      ...page,
      items: page.items.filter((item) => item.id !== activity.id),
    };
    return { ...data, pages };
  }

  /*
   * An archive or a restore is a move, not a field change.
   *
   * Three statuses mean three cached lists, and this row now belongs to a different set of them.
   * Patching the field in place would leave it in the list it just left as well as the one it joined,
   * so the caller refetches instead. That is the same answer the "unknown row" case below gets, for
   * the same reason: page membership is not something a patch can express.
   *
   * Checked before the spread below, which would otherwise carry `archived` onto the row and make it
   * look handled. And checked even on an activity event, because an event that carries
   * `archived: false` is a report that restored the conversation — the move matters more than the
   * preview, and the refetch brings the preview too.
   *
   * Note the branch does NOT skip a list that lacks the row. See the branch body for why.
   */
  if (activity.archived !== undefined) {
    /*
     * Unconditional, including when this list does not hold the row.
     *
     * An earlier draft returned `data` here when `holdingPage === -1`, reasoning that a list without
     * the row has nothing to move. That is exactly backwards: the list that must *gain* the row is
     * the one that does not hold it yet. Restoring was the broken direction — an archived row is
     * absent from Active by definition, so a restore found nothing, refetched nothing, and the
     * conversation did not reappear until the next refocus or reconnect. Saying something in an
     * archived conversation is how it comes back, so that is the one path that must not be lossy.
     *
     * The cost is one refetch per archive event per member, and `memberIds` already scopes delivery.
     */
    return "refetch";
  }

  // An unknown row id means the roster is stale; refetch rather than patch.
  if (holdingPage === -1) return "unknown";

  const page = data.pages[holdingPage] as RosterPage;
  const index = page.items.findIndex((item) => item.id === activity.id);
  const previous = page.items[index];
  if (!previous) return data;

  /*
   * A pin patches the one field it is about.
   *
   * The spread below would carry this event's null message onto the row and wipe the preview the
   * roster renders. No re-sort either: a pin is not activity, and pinned rows are lifted at render
   * time by `pinnedFirst`, not by the order they sit in here.
   */
  if (activity.pinned !== undefined) {
    if (previous.pinned === activity.pinned) return data;
    const items = page.items.slice();
    items[index] = { ...previous, pinned: activity.pinned };
    const pages = data.pages.slice();
    pages[holdingPage] = { ...page, items };
    return { ...data, pages };
  }

  // Preserve object identity for unchanged rows so memoized rows do not re-render.
  const next = page.items.slice();
  next[index] = { ...previous, ...activity };
  next.sort(byRecency);

  // An event that changes nothing visible, a duplicate, or a report the server ignored as stale,
  // returns the original object, so React re-renders nothing at all.
  if (next.every((item, at) => item === page.items[at])) return data;

  const pages = data.pages.slice();
  pages[holdingPage] = { ...page, items: next };
  return { ...data, pages };
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

function socketUrl() {
  const url = new URL("/api/channels/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

const ROSTER_STATUSES = ["active", "archived", "all"] as const;

/**
 * No status argument.
 *
 * The sidebar is not the only reader of the roster — the channel screen reads it too — so the status
 * the sidebar happens to have on screen is not knowable from inside this hook. Instead every event is
 * applied to all three cached lists; each one no-ops on a row it never held, so patching the two the
 * event does not concern is free.
 */
export function useRosterEvents() {
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let retryDelay = FIRST_RETRY_MS;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(socketUrl());

      socket.onopen = () => {
        retryDelay = FIRST_RETRY_MS;
        // Recover events missed while the socket was disconnected.
        void queryClient.invalidateQueries({ queryKey: rosterKeys.all });
      };

      socket.onmessage = (message) => {
        let activity: RosterActivityEvent;
        try {
          activity = JSON.parse(message.data as string);
        } catch {
          return;
        }

        /*
         * The list is paged, so the cache holds pages rather than one array.
         *
         * The row is patched inside whichever page holds it and that page is re-sorted. Sorting
         * across pages is deliberately not attempted: a row that has just become the most recent
         * belongs at the top of page one, and moving a row between pages would fight the cursors the
         * next fetch uses. The page it is on stays correct, and the next refetch puts it in order.
         */
        let refetch = false;
        for (const status of ROSTER_STATUSES) {
          queryClient.setQueryData(
            rosterKeys.list(status),
            (data: RosterCache | undefined) => {
              if (!data) return data;
              const patched = applyRosterEvent(data, activity);
              if (patched === "unknown" || patched === "refetch") {
                refetch = true;
                return data;
              }
              return patched;
            },
          );
        }
        if (refetch) {
          // An unknown row, or one that moved between lists, means the roster is stale; refetch
          // rather than patch. All three lists share one prefix, so one invalidation reaches whichever
          // of them the row actually landed in.
          void queryClient.invalidateQueries({ queryKey: rosterKeys.all });
        }

        /*
         * A tab looking at the channel somebody just deleted in another tab.
         *
         * The tab that issued the delete moves itself once the request returns. Every other tab only
         * ever hears about it here, and dropping the row without moving leaves that tab on a route
         * whose channel no longer resolves: an error, or an empty conversation, depending on which
         * query answers first.
         *
         * Read off the router at event time rather than through `useParams`, so the effect does not
         * have to be torn down and reconnected on every navigation just to keep this value fresh.
         */
        if (activity.deleted) {
          const { pathname } = router.state.location;
          const path =
            activity.kind === "bot_chat"
              ? `/bot/${activity.id}`
              : `/channel/${activity.id}`;
          if (pathname === path) {
            void router.navigate({ to: "/" });
          }
        }
      };

      // WebSocket needs explicit reconnect handling.
      socket.onclose = () => {
        if (stopped) return;
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      // Cleared first: the close below must not schedule a reconnect for a screen that is gone.
      if (socket) socket.onclose = null;
      socket?.close();
    };
  }, [queryClient, router]);
}

/**
 * Most recent first, where starting a conversation counts as activity.
 *
 * Deliberately the same rule the roster query uses, `coalesce(last_message_at, created_at) desc` in
 * channels/routes.ts. If these two disagree the list reorders itself the moment an event arrives,
 * which looks like rows jumping for no reason.
 */
function byRecency(left: RosterItem, right: RosterItem) {
  const at = (item: RosterItem) => item.lastMessageAt ?? item.createdAt;
  return at(right).localeCompare(at(left));
}
