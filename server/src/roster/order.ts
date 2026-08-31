import { desc, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { channels } from "../db/schema";

/**
 * The order the roster is drawn in, and where a page stopped.
 *
 * ONE HOME, ON PURPOSE. This rule is mirrored in the browser twice, by `byRecency` in
 * `use-channel-events.ts` and `pinnedFirst` in `app-sidebar.tsx`, and each of those carries a comment
 * saying it must agree with this or the list reorders itself the moment a socket event arrives. Two
 * entity kinds now sort by it. Leaving the SQL half inside `channels/routes.ts` would have left a
 * second server-side definition that bot chats had to be kept in step with by hand.
 */

/**
 * Most recent first, where starting a conversation counts as activity.
 *
 * A conversation somebody just made has nothing said in it yet and is the one they are about to type
 * in, so ordering on the message alone would bury it under everything that has one.
 *
 * Written against `channels` because that is where it started and where the matching index is
 * declared. The bot chat branch builds the same expression over its own two columns; the shape is
 * what has to agree, not the identifiers.
 */
export const RECENCY = sql`coalesce(${channels.lastMessageAt}, ${channels.createdAt})`;

/**
 * A pin as a number, so the whole sort key can descend.
 *
 * Takes the column rather than naming one, because the two kinds keep their pin in different places:
 * a channel's is on `channel_memberships`, a bot chat's is on the row itself.
 */
export function pinnedRank(pinnedAt: PgColumn): SQL {
  return sql`case when ${pinnedAt} is not null then 1 else 0 end`;
}

/**
 * The sort key, in sort order, every part descending.
 *
 * Descending throughout is what lets the cursor below be one row comparison rather than a nest of
 * ORs: a pin is 1 and no pin is 0, so `desc` puts pinned rows first, and both remaining parts already
 * wanted `desc`.
 */
export function rosterOrder(rank: SQL, recency: SQL, id: PgColumn): SQL[] {
  return [sql`${rank} desc`, sql`${recency} desc`, sql`${desc(id)}`];
}

/**
 * Where a page stopped: every part of the sort, in sort order.
 *
 * `pinned` leads because the ordering does. A keyset cursor has to name the whole sort key or the
 * next page is selected by a different rule than the page it follows, which serves some rows twice
 * and others never. `recency` and `id` are both here for the same reason: two rows can share a
 * timestamp.
 *
 * No `kind`. Ids are prefixed (`channel_...`, `botchat_...`) and therefore globally unique, so `id`
 * still breaks every tie on its own. That is what lets one cursor page through a mixed list.
 */
export type RosterCursor = { pinned: boolean; recency: string; id: string };

export function encodeRosterCursor(cursor: RosterCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * A malformed cursor reads as the first page, which is the honest answer to a stale link.
 *
 * A cursor minted before part of the sort key existed is malformed by this definition, and
 * deliberately: it describes a position in an ordering this query no longer has.
 */
export function decodeRosterCursor(
  value: string | undefined,
): RosterCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as RosterCursor;
    return typeof parsed?.id === "string" &&
      typeof parsed?.recency === "string" &&
      typeof parsed?.pinned === "boolean"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
