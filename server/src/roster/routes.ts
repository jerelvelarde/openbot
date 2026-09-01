/**
 * HTTP surface for the roster: one paged read over channels and bot chats together.
 *
 * SHAPED AFTER `createChannelRoutes` and `createBotChatRoutes`, deliberately, for the reason
 * `bot-chats/routes.ts` gives for copying `channels/routes.ts`: this file has to read exactly like
 * its siblings or a person auditing one has no reason to trust the others. That includes the
 * conditional spreads for an absent `cursor`/`limit` below, which come from `channels/routes.ts`'s
 * `GET /` unchanged.
 *
 * Only a read lives here. `RosterStore.list` is the only method `roster/query.ts` exports, so this
 * file mounts one route rather than the create/pin/archive/delete surface its siblings carry —
 * those stay on `/api/channels` and `/api/bot-chats`, which is what actually writes each kind.
 */
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  parsePageLimit,
  parseRosterStatus,
  type RosterItem,
  type RosterStore,
} from "./query";

export function createRosterRoutes(
  store: RosterStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    try {
      const url = new URL(context.req.url);
      // Refused, not reinterpreted; `parsePageLimit` carries the reasoning and the rule.
      const limit = parsePageLimit(url.searchParams.get("limit"));
      if (!limit.ok) return context.json({ error: limit.error }, 400);
      const page = await store.list(context.var.actor, {
        status: parseRosterStatus(url.searchParams.get("status")),
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        // Omitting the key is what makes the store's own page size fire. Why a rejected value never
        // reaches this line, and why `NaN` would be unrecoverable if one did, is at `parsePageLimit`.
        ...(limit.limit === undefined ? {} : { limit: limit.limit }),
      });

      return context.json({
        items: page.items.map(rosterItemDto),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

/** The one place a `Date` on a `RosterItem` becomes a string. */
function rosterItemDto(item: RosterItem) {
  return {
    kind: item.kind,
    id: item.id,
    name: item.name,
    agentIds: item.agentIds,
    threadId: item.threadId,
    active: item.active,
    archived: item.archived,
    lastMessage: item.lastMessage,
    // ISO-8601 so the browser gets strings it can sort and compare, which is the same bet the sort
    // rule makes on the server.
    lastMessageAt: item.lastMessageAt?.toISOString() ?? null,
    lastMessageAgentId: item.lastMessageAgentId,
    createdAt: item.createdAt.toISOString(),
    pinned: item.pinned,
    lastReadAt: item.lastReadAt?.toISOString() ?? null,
  };
}

/**
 * Whatever went wrong under the read, as the JSON shape every other refusal on these routes uses.
 *
 * `RosterStore.list` is a single read and declares no domain errors of its own to translate — unlike
 * `channels/routes.ts` and `bot-chats/routes.ts`, whose `mapStoreError` catches
 * `ChannelNotFoundError`/`AgentNotFoundError`/etc out of the mutations this file does not have, since
 * writing still happens on `/api/channels` and `/api/bot-chats`. Kept as its own function anyway, in
 * the spot its siblings keep theirs, so the day `list` does throw something this route needs to turn
 * into a status code of its own, it has one obvious home instead of a change to the route body.
 *
 * IT USED TO RETHROW, which is what its `never` return type described. Nothing in this server
 * registered an `onError` to turn a throw into JSON at the time, so Hono answered its own
 * `text/plain "Internal Server Error"`: `client()` in the browser reads `body.error` and falls back to its own sentence
 * when the body is not JSON, and `GET /api/roster` is the one read the sidebar has, so an unreachable
 * database reached a person as "Could not load your conversations" — the client's words, carrying
 * nothing of the server's reason, and the same for every other way this read can fail. `app.ts`
 * answers `{ error }` with 503 for the rarer case of no store being mounted at all, for exactly that
 * reason; the common case now says something of its own too. `app.ts` registers an `onError` as
 * well now, so a throw from here would reach the caller as JSON rather than as plain text — but as
 * one sentence for every failure in the server, which is what this function exists to improve on.
 *
 * The sentence names the server as the side that failed and says nothing else. What was thrown may
 * carry a connection string or an upstream host, so it goes to the log instead — unconditionally,
 * because everything reaching here is unexpected, including a bug in this file's own DTO, and a 500
 * with no log line is an outage indistinguishable from a typo.
 */
function mapStoreError(context: Context, error: unknown): Response {
  console.error(
    JSON.stringify({
      type: "roster-read-failed",
      error: String(error),
      note: "GET /api/roster could not be answered. This is the sidebar's only read, so somebody was shown an error instead of their conversations.",
    }),
  );
  return context.json(
    { error: "The server could not read your conversations." },
    500,
  );
}
