import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  ROSTER_STATUSES,
  type RosterItem,
  type RosterPage,
  rosterKeys,
} from "@/lib/roster/queries";

/**
 * Keep the roster live.
 *
 * The query remains the source of truth; socket events only patch its cache. A reconnection that
 * holds refetches the list to recover events missed while disconnected — `ESTABLISHED_AFTER_MS`
 * carries why holding, rather than merely opening, is the condition.
 */

/**
 * What arrives on the socket, which is narrower than what the server holds.
 *
 * The server's `RosterActivityEvent` also carries `memberIds`, the list its hub routes by, and
 * `deliver` strips it before sending: a member has no use for every other member's internal user id
 * and this file has never declared the field. So nothing is missing here — the wire shape is the
 * server's `DeliveredRosterEvent`, and these two are the two halves of it.
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
export type RosterCache = { pages: RosterPage[]; pageParams: unknown[] };

/**
 * Apply one event to the cached pages.
 *
 * Pure, and exported, because the patching rules are the whole of what a socket event does to the
 * screen and they should be provable without a socket. Returns the cache it was given when nothing
 * changed, so React re-renders nothing, `"unknown"` when the event names a row no page holds, and
 * `"refetch"` when the row moved between lists rather than merely changing a field.
 *
 * `"unknown"` is this one cache's answer and not a verdict on the roster: three lists mean a row is
 * legitimately absent from two of them. `applyRosterEventToCaches` is what turns the three answers
 * into a decision, and only a row that NO cached list holds is a stale roster worth refetching.
 *
 * Rows are found by `activity.id` alone: the server keeps ids unique across kinds — generated ones
 * are prefixed, and a package channel's chosen id is refused if it enters a generated namespace — and
 * `kind` is needed only for rendering, never for locating a row.
 */
export function applyRosterEvent(
  data: RosterCache,
  activity: RosterActivityEvent,
): RosterCache | "unknown" | "refetch" {
  const holdingPage = data.pages.findIndex((page) =>
    page.items.some((item) => item.id === activity.id),
  );

  // Must run before the activity patch below. A delete carries the same three activity fields every
  // other event does, so falling through would freshen the row's preview and leave it on the roster
  // instead of removing it. An unknown row here is already gone from this cache, so there is nothing
  // to patch or invalidate for, unlike the "unknown row" case below for an ordinary event.
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
   * so the caller refetches instead: page membership is not something a patch can express. Unlike the
   * "unknown row" case below, this is a verdict and not a report — one list saying the row moved is
   * enough, however confidently the other two answer.
   *
   * Checked before the activity patch below, which would otherwise treat the move as an ordinary
   * field change and leave every list exactly as it found it. And checked even on an activity event,
   * because an event that carries `archived: false` is a report that restored the conversation — the
   * move matters more than the preview, and the refetch brings the preview too.
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

  // This list does not hold the row. Reported, not decided: whether that means a stale roster or
  // simply the wrong one of the three lists is only answerable across all of them.
  if (holdingPage === -1) return "unknown";

  const page = data.pages[holdingPage] as RosterPage;
  const index = page.items.findIndex((item) => item.id === activity.id);
  const previous = page.items[index];
  if (!previous) return data;

  /*
   * A pin patches the one field it is about.
   *
   * The activity patch below would copy this event's null message onto the row and wipe the preview
   * the roster renders, because a pin event carries the activity fields empty rather than omitting
   * them. No re-sort either: a pin is not activity, and pinned rows are lifted at render time by
   * `pinnedFirst`, not by the order they sit in here.
   */
  if (activity.pinned !== undefined) {
    if (previous.pinned === activity.pinned) return data;
    const items = page.items.slice();
    items[index] = { ...previous, pinned: activity.pinned };
    const pages = data.pages.slice();
    pages[holdingPage] = { ...page, items };
    return { ...data, pages };
  }

  /*
   * A duplicate, or a report the server ignored as stale, returns the cache it was given — so React
   * re-renders nothing at all.
   *
   * Compared before anything is allocated, which is the only place this check can live. An earlier
   * version of this function spread first and then asked whether any row had kept its identity;
   * a spread always allocates, so no row ever could, and that branch was unreachable from the day
   * a second field was added to it. What kept identity in practice was React Query's structural
   * sharing inside `setQueryData` — real, but incidental, and gone the moment anybody sets
   * `structuralSharing: false`. `RosterRow`'s memo wants a guarantee, so this is the guarantee.
   */
  if (
    previous.lastMessage === activity.lastMessage &&
    previous.lastMessageAt === activity.lastMessageAt &&
    previous.lastMessageAgentId === activity.lastMessageAgentId
  ) {
    return data;
  }

  /*
   * The three activity fields, named, rather than the event spread whole.
   *
   * Spreading the event copied every wire-only field onto the cached row: the deprecated `channelId`,
   * and `kind` — which is what the sidebar builds the row's link from. A row is found by id, but it is
   * *opened* by kind, so an event whose `kind` was wrong or mis-serialised would silently repoint the
   * row at `/bot/...` instead of `/channel/...`. Nothing on the wire should be able to do that, and
   * naming the fields is what stops it.
   */
  const next = page.items.slice();
  next[index] = {
    ...previous,
    lastMessage: activity.lastMessage,
    lastMessageAt: activity.lastMessageAt,
    lastMessageAgentId: activity.lastMessageAgentId,
  };
  /*
   * Re-sorted within its own page, and deliberately not across pages.
   *
   * A row that has just become the most recent belongs at the top of page one, but moving a row
   * between pages would fight the cursors the next fetch uses. The page it is on stays internally
   * correct, and the next refetch puts the list in order.
   */
  next.sort(byRecency);

  const pages = data.pages.slice();
  pages[holdingPage] = { ...page, items: next };
  return { ...data, pages };
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

/**
 * How long a socket has to hold open before this tab believes in it.
 *
 * THE SIGNAL `onopen` IS NOT. A server that completes the upgrade and then closes without saying
 * anything — a proxy that mangles WebSockets, a replica shutting down, an authorization check that
 * fails after the handshake — fires `onopen` every single time. So a backoff reset there never
 * engages, and a roster refetch there runs on every attempt: the loop sat at this file's first retry
 * delay indefinitely, refetching three lists twice a second, each refetch discarded by the next.
 *
 * WHY NOT "DELIVERED A FRAME" ALONE, which is the other signal available and the one the reset below
 * also reads. A frame proves the connection works; no frame proves nothing. A quiet roster says
 * nothing for hours, so judging a connection by frames alone would let an idle proxy timeout climb
 * the backoff to its 30-second ceiling on a network that is working perfectly, and skip the recovery
 * refetch that is the entire point of reconnecting. The two are read together instead — a frame, or
 * having held this long, either one.
 *
 * ITS OWN NUMBER, not `FIRST_RETRY_MS` reused, though the two were within a factor of two of each
 * other when this was written and will be tempting to fold together. This one is "long enough that a
 * socket the server accepts and drops cannot reach it, short enough that the recovery refetch is not
 * visibly late"; that is not the same question as how soon to retry, and the two answers stopped
 * agreeing the moment either was tuned.
 */
const ESTABLISHED_AFTER_MS = 1_000;

function socketUrl() {
  const url = new URL("/api/channels/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Read one socket frame, or say why it could not be read.
 *
 * The shape guard is not paranoia about types. `JSON.parse("null")` succeeds, and `null` then throws
 * a TypeError on `item.id === activity.id` deep inside a `setQueryData` updater — out of a socket
 * handler, where nothing catches it and the only symptom is a tab that stops updating. So a frame is
 * an event only once it is an object carrying a string `id`, which is the one field every branch of
 * `applyRosterEvent` reads.
 *
 * The failure is said out loud, for the reason the server half of this path states at length in
 * `server/src/channels/events.ts`: nothing else can tell. A frame dropped in silence leaves this tab
 * without live updates until something unrelated makes it refetch, and that is a bug report of "the
 * sidebar stops moving" with nothing in the log under it. The payload goes in truncated, because its
 * first 200 characters name the kind and the id and that is what tells the cases apart.
 */
export function readRosterEvent(
  data: unknown,
): RosterActivityEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch (error) {
    reportUnreadableFrame(data, error);
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { id?: unknown }).id !== "string"
  ) {
    reportUnreadableFrame(data, "no string id, so no row can be found");
    return undefined;
  }

  return parsed as RosterActivityEvent;
}

function reportUnreadableFrame(data: unknown, error: unknown) {
  console.error(
    JSON.stringify({
      type: "roster-event-unreadable",
      payload: String(data).slice(0, 200),
      error: String(error),
      note: "This tab heard a roster event it could not read. Its sidebar will not show that change until it refetches.",
    }),
  );
}

/**
 * Apply one event to every cached list, and invalidate only when a patch could not do the job.
 *
 * NO STATUS ARGUMENT. The sidebar is not the only reader of the roster — the channel screen reads it
 * too — so the status the sidebar happens to have on screen is not knowable from here. Every event is
 * offered to all three cached lists instead.
 *
 * WHAT THE TWO FLAGS ARE FOR, and this is the whole point of the function. `applyRosterEvent` answers
 * `"unknown"` for any cache that does not hold the row, and a caller that cannot tell that apart from
 * a genuinely stale roster invalidates on every event: an active row is *by definition* absent from
 * the Archived list, so once somebody has opened the Archived tab and all three lists are cached,
 * every ordinary message invalidated `rosterKeys.all` — refetching every fetched page of every list
 * and throwing away the patch the same event had just applied. That is the socket patching this file
 * exists for, bypassed.
 *
 * So the question asked of the three lists together is not "did this one know the row" but "did ANY
 * of them". `handled` says a cached list gave a real answer — it patched a row, or it had nothing left
 * to do with one, which is what a delete for an already-absent row means. A refetch for a row no
 * cached list knows is the stale-roster recovery, and it stays.
 *
 * `moved` is deliberately a second reason and not a case of the first, and it is worth saying that it
 * is redundant today: an archive is answered `"refetch"` by every cached list, so `!handled` alone
 * would already catch it. That equivalence holds only because the archive branch refuses to skip a
 * list that does not hold the row — and that branch has been written the other way once already, as
 * its own comment recounts. Under `handled` alone, that regression coming back would silently stop
 * refetching restores; with `moved`, the one list that does hold the row still forces the refetch.
 */
export function applyRosterEventToCaches(
  queryClient: QueryClient,
  activity: RosterActivityEvent,
) {
  let handled = false;
  let moved = false;

  for (const status of ROSTER_STATUSES) {
    queryClient.setQueryData(
      rosterKeys.list(status),
      (data: RosterCache | undefined) => {
        if (!data) return data;
        const patched = applyRosterEvent(data, activity);
        if (patched === "refetch") {
          moved = true;
          return data;
        }
        if (patched === "unknown") return data;
        handled = true;
        return patched;
      },
    );
  }

  // With no list cached at all this matches no query and does nothing, which is the right answer:
  // there is no roster on screen to bring up to date.
  if (moved || !handled) {
    void queryClient.invalidateQueries({ queryKey: rosterKeys.all });
  }
}

/**
 * The part of a `WebSocket` this loop drives.
 *
 * Declared, and the loop below takes a factory for it, for the reason `applyRosterEvent` is exported:
 * the connect-retry-teardown rules are the other half of what a socket event does to the screen, and
 * they should be provable without a socket. The two defects this shape was written for are both
 * lifecycle bugs — a backoff that never engaged, a handler that outlived its screen — and neither is
 * a fact about any expression, so neither could be asserted while the whole loop lived inside an
 * effect closure.
 *
 * The event types are the DOM's rather than something narrower this file would prefer, so that a real
 * `WebSocket` satisfies this by construction: with `strictFunctionTypes` a handler declared to take
 * less than a `MessageEvent` is not something a `WebSocket` can be assigned to, so narrowing here
 * would mean a cast at the one place that matters.
 */
export type RosterSocket = {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: () => void;
};

/** Everything the loop needs from outside itself: a socket, a clock, and what to do with an event. */
export type RosterSocketHooks = {
  connect: () => RosterSocket;
  schedule: (run: () => void, delayMs: number) => number;
  cancel: (handle: number) => void;
  /** One readable event, already parsed. */
  onEvent: (activity: RosterActivityEvent) => void;
  /** Bring the roster up to date after a gap the socket could not cover. */
  recoverMissedEvents: () => void;
};

/**
 * Keep one socket connected, reconnect it when it drops, and stop cleanly. Returns the teardown.
 *
 * Two rules live here and nowhere else, both of which used to be wrong in ways no test could reach.
 * WHAT COUNTS AS A CONNECTION, which is what the backoff and the recovery refetch both hang off —
 * see `ESTABLISHED_AFTER_MS`. And WHAT TEARDOWN DETACHES: every handler, because a frame that
 * arrives after the screen is gone still runs whatever is still attached.
 *
 * Takes its socket, its clock and its two callbacks rather than reaching for `WebSocket`,
 * `window.setTimeout` and a `QueryClient`, so the rules above are assertable in a plain test:
 * `app/tests/roster-socket.test.ts` drives the whole loop with a fake socket and timers as values.
 * That is the same argument `applyRosterEvent` above makes for being pure and exported.
 */
export function startRosterSocket(hooks: RosterSocketHooks): () => void {
  let socket: RosterSocket | undefined;
  let retryTimer: number | undefined;
  /** Pending while a socket is open and has not yet held long enough to count as a connection. */
  let establishedTimer: number | undefined;
  let retryDelay = FIRST_RETRY_MS;
  let stopped = false;

  /** A connection worked, so the delay the failures before it earned is no longer owed. */
  const established = () => {
    retryDelay = FIRST_RETRY_MS;
  };

  const connect = () => {
    if (stopped) return;
    const live = hooks.connect();
    socket = live;

    live.onopen = () => {
      /*
       * The recovery refetch waits for the socket to prove it can hold.
       *
       * It used to run here, on the open itself, and that is what turned a server that accepts and
       * drops into a three-list roster refetch twice a second. A socket that closes before this
       * timer fires never reaches it, so that loop now costs the reconnects and nothing else.
       */
      establishedTimer = hooks.schedule(() => {
        establishedTimer = undefined;
        established();
        // Recover events missed while the socket was disconnected.
        hooks.recoverMissedEvents();
      }, ESTABLISHED_AFTER_MS);

      /*
       * Except at the ceiling, where the attempt is the only clock this tab has left.
       *
       * A tab whose sockets never hold has no other route back to a fresh roster: this deployment
       * turns `refetchOnWindowFocus` off, the sidebar outlives navigation so its query does not
       * remount, and this socket is the only thing that invalidates it. Dropping the refetch
       * entirely for that tab would trade a storm for a roster frozen at whatever the mount fetched,
       * which is the worse of the two. Once the backoff has bottomed out the attempts are 30 seconds
       * apart, and one refetch per attempt at that spacing is a poll rather than a storm — so this
       * reads the delay rather than counting failures, because the delay is the thing that bounds
       * the rate.
       */
      if (retryDelay >= MAX_RETRY_MS) hooks.recoverMissedEvents();
    };

    live.onmessage = (message) => {
      // A frame is proof the connection works and does not wait for the timer above to agree. Read
      // before the frame is parsed, deliberately: an unreadable frame is a bug in what was sent, not
      // evidence against the socket that carried it.
      established();

      const activity = readRosterEvent(message.data);
      if (!activity) return;
      hooks.onEvent(activity);
    };

    /*
     * Nothing to recover here, and that is why it needs saying.
     *
     * An error is always followed by a close, and `onclose` below is what schedules the reconnect,
     * so there is no handling to do. Without this the failure is invisible: the spec deliberately
     * withholds the reason from the event, so the browser's own console line names neither the
     * socket nor the application, and the only other symptom is the sidebar going quiet. One line
     * saying which socket broke is the difference between that and a reproducible report.
     */
    live.onerror = () => {
      console.error(
        JSON.stringify({
          type: "roster-socket-error",
          note: "The roster event socket failed. A reconnect follows; live sidebar updates pause until it succeeds.",
        }),
      );
    };

    // WebSocket needs explicit reconnect handling.
    live.onclose = () => {
      // Whatever this socket was going to prove, it is not going to prove it now. Cancelled before
      // the `stopped` check below, because a timer must not outlive the socket it was measuring
      // whatever the reason the socket went away.
      if (establishedTimer !== undefined) {
        hooks.cancel(establishedTimer);
        establishedTimer = undefined;
      }
      if (stopped) return;
      retryTimer = hooks.schedule(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    };
  };

  connect();

  return () => {
    stopped = true;
    if (retryTimer !== undefined) hooks.cancel(retryTimer);
    if (establishedTimer !== undefined) hooks.cancel(establishedTimer);
    /*
     * Cleared first: the close below must not schedule a reconnect for a screen that is gone, and
     * a socket torn down mid-connect must not log an error about a screen nobody is looking at.
     *
     * EVERY HANDLER, not the two this used to name. `onmessage` was left attached, so a frame
     * already queued behind this cleanup still ran the whole handler — patching caches for a tree
     * that has unmounted and, on a `deleted` frame, navigating a router the screen no longer has.
     * `onopen` was left attached for the same reason and is the same shape of hazard: it now
     * schedules a timer, and one scheduled after this point is one nobody cancels.
     *
     * Detached rather than gated on `stopped`, because detaching is what this teardown already does
     * about a handler outliving its screen — one mechanism, and the `stopped` checks stay about
     * whether to reconnect rather than becoming a second liveness rule about whether to deliver.
     */
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
    socket?.close();
  };
}

export function useRosterEvents() {
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(
    () =>
      startRosterSocket({
        connect: () => new WebSocket(socketUrl()),
        schedule: (run, delayMs) => window.setTimeout(run, delayMs),
        cancel: (handle) => window.clearTimeout(handle),
        recoverMissedEvents: () => {
          void queryClient.invalidateQueries({ queryKey: rosterKeys.all });
        },
        onEvent: (activity) => {
          applyRosterEventToCaches(queryClient, activity);

          /*
           * A tab looking at the channel somebody just deleted in another tab.
           *
           * The tab that issued the delete moves itself once the request returns. Every other tab
           * only ever hears about it here, and dropping the row without moving leaves that tab on a
           * route whose channel no longer resolves: an error, or an empty conversation, depending on
           * which query answers first.
           *
           * Read off the router at event time rather than through `useParams`, so the effect does
           * not have to be torn down and reconnected on every navigation just to keep this value
           * fresh.
           */
          if (!activity.deleted) return;
          const { pathname } = router.state.location;
          const path =
            activity.kind === "bot_chat"
              ? `/bot/${activity.id}`
              : `/channel/${activity.id}`;
          if (pathname === path) {
            void router.navigate({ to: "/" });
          }
        },
      }),
    [queryClient, router],
  );
}

/**
 * Most recent first, where starting a conversation counts as activity.
 *
 * Deliberately the same rule the roster reads use, `coalesce(last_message_at, created_at) desc`,
 * which server/src/roster/order.ts owns and names this function as one of its two browser mirrors.
 * If these two disagree the list reorders itself the moment an event arrives, which looks like rows
 * jumping for no reason.
 *
 * Compared with `>`, the same way `hasUnseenActivity`, `patchRosterRead` and `mostRecentBotChat`
 * compare their timestamps. `localeCompare` was the odd one out here, and it is the wrong instrument
 * for this: it answers in the reader's locale and disagrees with a plain comparison on non-canonical
 * ISO forms. Every timestamp on the wire is `toISOString()` today, so the two agreed in practice —
 * which is exactly the kind of agreement that stops holding without anybody noticing.
 *
 * TIES GO TO THE GREATER ID, because `rosterOrder` there is `[pinned desc, recency desc, id desc]`
 * and this has to mirror the whole key, not the middle term of it. Returning `0` instead — which this
 * did — is not neutrality: `Array.prototype.sort` is stable, so tied rows kept whatever order the
 * page already held, the next refetch put them in the server's order, and the rows moved for no
 * reason a reader could see. That is the symptom the paragraph above is about, arriving through the
 * one term that was missing rather than through disagreement about the terms that were there.
 *
 * The tie is ordinary, not hypothetical. `server/src/tenant-package.ts` inserts every channel a
 * package defines in one transaction, so `created_at` — and with it the recency of a channel nobody
 * has spoken in — is byte-identical across all of them; `roster/order.ts` has its own paragraph on
 * what that same fact did to the cursor.
 *
 * COMPARED AS STRINGS, with the caveat worth writing down rather than discovering. `mostRecentBotChat`
 * can argue this exactly: bot chat ids are one fixed length of lowercase hex, so a code-unit
 * comparison and Postgres's `desc` cannot disagree. Channel ids are weaker — a package supplies its
 * own, unprefixed and arbitrary (`general-assistant`), so a database collation that ignores
 * punctuation could order two of those differently from this. The cost of that residual disagreement
 * is one page of one list drawn in a different order from the next refetch's, for rows that share a
 * timestamp; the alternative is shipping a collation-aware comparator to the browser to sort at most
 * a page, which buys less than it costs. What matters here is that the order is TOTAL and stable
 * across tabs, and code-unit order is both.
 */
function byRecency(left: RosterItem, right: RosterItem) {
  const at = (item: RosterItem) => item.lastMessageAt ?? item.createdAt;
  const [first, second] = [at(left), at(right)];
  if (first !== second) return first > second ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}
