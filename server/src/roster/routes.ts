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

/**
 * `?limit=` as this route reads it: a whole number of at least one, written in decimal digits.
 *
 * A shape check rather than a parse, because the parse was the bug. `Number.parseInt` stops at the
 * first character it cannot read and keeps what came before, so `?limit=1e3` was 1, `?limit=0x10` was
 * 0, and `?limit=50abc` was 50 — a caller asking for a thousand rows got one row and a 200, and the
 * `NaN` fallback that was supposed to catch a malformed value never fired for any of them.
 *
 * `0*[1-9]\d*` and not `\d+`, so a leading zero is fine and a value of zero is not: nought rows is a
 * request this endpoint cannot honour — the store clamps it up to one — and answering it with a row
 * is the same silent reinterpretation as the rest of them.
 */
const LIMIT_PARAM = /^0*[1-9]\d*$/;

export function createRosterRoutes(
  store: RosterStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    try {
      const url = new URL(context.req.url);
      const limit = url.searchParams.get("limit") ?? "";
      // Refused, not reinterpreted. A caller cannot see through a page of one row answered 200 to a
      // request for a thousand, so the only two outcomes for `?limit=` are the number it says and a
      // 400. Empty reads as absent, the way an empty `cursor` does below: a parameter that says
      // nothing is not a parameter.
      if (limit !== "" && !LIMIT_PARAM.test(limit)) {
        return context.json(
          { error: "Limit must be a whole number of at least 1." },
          400,
        );
      }
      const page = await store.list(context.var.actor, {
        status: parseRosterStatus(url.searchParams.get("status")),
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        // Omitting the key is what makes the store's own default fire; the check above is what keeps
        // it from being handed a `NaN` to clamp instead, which the clamp cannot resolve — neither
        // `Math.max` nor `Math.min` ever turns a `NaN` back into a number, so a page of `NaN` rows
        // would have been asked for silently. A number too large to hold is not that problem: more
        // digits than a `double` carries reads as `Infinity`, which the store's
        // `Math.min(..., MAX_ROSTER_PAGE)` resolves to the same page a merely large number gets.
        ...(limit === "" ? {} : { limit: Number(limit) }),
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
 * registered an `onError` to turn a throw into JSON, so Hono answered its own `text/plain "Internal
 * Server Error"`: `client()` in the browser reads `body.error` and falls back to its own sentence
 * when the body is not JSON, and `GET /api/roster` is the one read the sidebar has, so an unreachable
 * database reached a person as "Could not load your conversations" — the client's words, carrying
 * nothing of the server's reason, and the same for every other way this read can fail. `app.ts`
 * answers `{ error }` with 503 for the rarer case of no store being mounted at all, for exactly that
 * reason; the common case now says something of its own too.
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
