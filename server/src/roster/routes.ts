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
import { parseRosterStatus, type RosterItem, type RosterStore } from "./query";

export function createRosterRoutes(
  store: RosterStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    try {
      const url = new URL(context.req.url);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const page = await store.list(context.var.actor, {
        status: parseRosterStatus(url.searchParams.get("status")),
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        // `Number.parseInt("lots", 10)` is `NaN`, and `NaN` is a number the store would otherwise
        // have to clamp. The store's `Math.min(Math.max(query.limit ?? DEFAULT, 1), MAX)` propagates
        // a `NaN` input as `NaN` output — `Math.max` and `Math.min` never resolve one away — so
        // handing it through here would silently ask the store for a page of `NaN` rows instead of
        // falling back to its own default. Omitting the key is what makes that fallback run.
        ...(Number.isFinite(limit) ? { limit } : {}),
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
 * `RosterStore.list` is a single read and declares no domain errors of its own to translate — unlike
 * `channels/routes.ts` and `bot-chats/routes.ts`, whose `mapStoreError` catches
 * `ChannelNotFoundError`/`AgentNotFoundError`/etc out of the mutations this file does not have, since
 * writing still happens on `/api/channels` and `/api/bot-chats`. Kept as its own function anyway, in
 * the spot its siblings keep theirs, so the day `list` does throw something this route needs to turn
 * into a status code, it has one obvious home instead of a change to the route body itself.
 */
function mapStoreError(_context: Context, error: unknown): Response {
  throw error;
}
