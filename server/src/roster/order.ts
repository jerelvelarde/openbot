import { desc, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { channels } from "../db/schema";

/**
 * The order the roster is drawn in, and where a page stopped.
 *
 * ONE HOME, ON PURPOSE. This rule is mirrored in the browser twice, by `byRecency` in
 * `use-channel-events.ts` and `pinnedFirst` in `app-sidebar.tsx`, and each of those carries a comment
 * saying it must agree with this or the list reorders itself the moment a socket event arrives.
 *
 * Every piece a server-side reader needs is exported from here: the recency expression, the pin rank,
 * the ORDER BY, the keyset predicate, and the text the cursor carries. Three reads apply the rule —
 * `roster/query.ts`'s two union branches and `ChannelStore.list` — and an earlier draft exported only
 * the first three, which left each of those three spelling out the same row comparison inline. Two
 * kinds paging by two hand-copied predicates is the failure this module exists to prevent, so the
 * predicate is a function here rather than a comment asking callers to keep four lines in step.
 */

/**
 * Most recent first, where starting a conversation counts as activity.
 *
 * A conversation somebody just made has nothing said in it yet and is the one they are about to type
 * in, so ordering on the message alone would bury it under everything that has one.
 *
 * Takes the two columns rather than naming one table's, because every table the roster reads keeps
 * this pair under the same two names and declares its own index on this expression:
 * `channels_recent_activity_idx` and `bot_chats_recent_activity_idx`. The shape is what has to agree,
 * not the identifiers, and taking the columns is what makes agreeing the only available option.
 */
export function recencyOf(lastMessageAt: PgColumn, createdAt: PgColumn): SQL {
  return sql`coalesce(${lastMessageAt}, ${createdAt})`;
}

/** The recency expression over `channels`, which is the table two of the three reads want. */
export const RECENCY = recencyOf(channels.lastMessageAt, channels.createdAt);

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
 * The sort key's timestamp as the cursor carries it: text, at the precision Postgres actually stores.
 *
 * A JS `Date` holds milliseconds and `timestamptz` holds microseconds, and the driver decodes one
 * into the other. `created_at` defaults from `now()`, which carries microseconds, so minting the
 * cursor from the decoded `Date` floored the page boundary downward; the next page's strict `<` then
 * excluded every row whose true recency fell inside the discarded remainder. Those rows were served
 * on no page at all, and because a floor only ever loses rows there was no duplicate to notice it by.
 *
 * That is not a contrived race. `tenant-package.ts` inserts every channel a package defines inside
 * one transaction, so `now()` — and with it `created_at`, and with it the recency of a channel nobody
 * has spoken in — is byte-identical across all of them. A tenant whose package defines more channels
 * than fit on one page lost the remainder from its sidebar permanently.
 *
 * So the value never becomes a `Date`. Postgres formats it, the string is carried through the cursor
 * unparsed, and `rosterCursorFilter` hands it back for `::timestamptz` to read again.
 *
 * ANCHORED TO UTC, AND STAMPED WITH A LITERAL `Z`, rather than rendered with `OF` or a bare `::text`.
 * Both of those render in the session's `TimeZone`, and `::text` in its `DateStyle` as well, neither
 * of which is ours to depend on; `OF` additionally truncates a zone offset to whole minutes, which
 * loses the seconds an LMT-era offset carries and reparses to a different instant. `at time zone
 * 'UTC'` fixes the rendering to one zone instead. `roster-union.integration.test.ts` asserts the
 * round trip against the database under four `TimeZone` values and five `DateStyle` values rather
 * than taking this paragraph's word for it.
 */
export function recencyCursorText(recency: SQL): SQL<string> {
  return sql<string>`to_char(${recency} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Where a page stopped: every part of the sort, in sort order.
 *
 * `pinned` leads because the ordering does. A keyset cursor has to name the whole sort key or the
 * next page is selected by a different rule than the page it follows, which serves some rows twice
 * and others never. `recency` and `id` are both here for the same reason: two rows can share a
 * timestamp.
 *
 * `recency` is a string because it is Postgres' own rendering of the boundary, kept out of JS number
 * types on purpose. See `recencyCursorText`.
 *
 * No `kind`. What that needs is a total order over ids across the two tables: no channel id may
 * equal a bot-chat id, or two rows share a complete sort key and the strict `<` excludes both.
 * Generated ids carry it by construction (`channel_...`, `botchat_...`); a package channel's id is
 * chosen in `channels.yaml`, so `validateTenantPackage` refuses one inside a generated namespace
 * rather than leaving the order to hope. That is what lets one cursor page through a mixed list.
 */
export type RosterCursor = { pinned: boolean; recency: string; id: string };

export function encodeRosterCursor(cursor: RosterCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Where a page starts, as a predicate over whichever read is asking.
 *
 * One row comparison over the whole sort key, which only reads as "everything after the cursor"
 * because every part of that key descends. See `rosterOrder`.
 *
 * Takes the expressions rather than naming columns, for the reason `pinnedRank` gives: the two kinds
 * keep their pin and their recency in different places.
 *
 * The boundary timestamp is bound as the string the cursor carries and cast here, never parsed in
 * TypeScript on the way past. That is the whole point of `recencyCursorText`, and doing the cast in
 * this one function is what keeps a caller from undoing it.
 */
export function rosterCursorFilter(
  cursor: RosterCursor | undefined,
  rank: SQL,
  recency: SQL,
  id: PgColumn,
): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${rank}, ${recency}, ${id}) < (${cursor.pinned ? 1 : 0}::int, ${cursor.recency}::timestamptz, ${cursor.id})`;
}

/**
 * A cursor timestamp, shaped as `recencyCursorText` writes it.
 *
 * One to six fractional digits, so a cursor minted before that function existed is still accepted:
 * `Date.prototype.toISOString` wrote three, and a link somebody has open across the deploy names a
 * real position in an ordering that has not changed.
 */
const CURSOR_RECENCY =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;

/**
 * The instants a `timestamptz` can be given, which is narrower than the instants a `Date` can hold.
 *
 * A `Date` runs from ISO year -271821 to AD 275760 and Postgres will take neither end of that, so a
 * bound or a cursor timestamp that parses cleanly here can still fail inside the read — where nothing
 * knows which parameter was at fault, and where an ordinary `Error` becomes a bare plain-text 500 as
 * `app.ts` registers no `onError`. Every timestamp check in this file and in `audit.ts` exists so the
 * value is judged before it is bound, and each of them needs this same rule, so there is one copy.
 *
 * AD 1 THROUGH 9999, which is a smaller window than Postgres' documented 4713 BC to AD 294276, and the
 * difference is mostly the rendering rather than the calendar. Both ways a `Date` reaches the column
 * go through a four-digit year: drizzle's timestamp mapper calls `toISOString()`, and a cursor carries
 * `recencyCursorText`'s `YYYY`. Outside AD 1..9999 `toISOString` switches to ISO 8601's extended
 * `±YYYYYY` form, and Postgres reads that leading sign as a zone rather than a year —
 * `select '+010000-01-02T00:00:00.000Z'::timestamptz` answers `time zone displacement out of range`,
 * and so does `-271821-04-20T00:00:00.000Z` at the other end. Year 0 fails differently and for the
 * older reason: there is no year between 1 BC and AD 1 in the calendar `timestamptz` implements, so
 * `select '0000-01-01T00:00:00Z'::timestamptz` is out of range even though a `Date` has that year and
 * round-trips it perfectly.
 *
 * An Invalid Date is refused too, so a caller that has one has no separate `Number.isNaN` check to
 * remember: `getUTCFullYear()` on one is `NaN`, and every comparison against `NaN` is false.
 *
 * IN THIS MODULE because this is where the cursor timestamp rules already live and `audit.ts` already
 * borrows `recencyCursorText` from here rather than restating it. The same trade as that borrowing:
 * one function reached across a module boundary, against two hand-copied spellings of a rule that has
 * already been dropped once on the way past.
 */
export function withinTimestamptzRange(at: Date): boolean {
  const year = at.getUTCFullYear();
  return year >= 1 && year <= 9999;
}

/**
 * Whether Postgres will read this as a timestamp, decided here rather than by letting it try.
 *
 * The shape alone is not enough: `2026-02-30T00:00:00Z` matches it and `timestamptz` answers `date/
 * time field value out of range`. So the fields are put back together and compared against what came
 * in, which is what catches a component that rolled over into the following month.
 *
 * Built through `setUTCFullYear` rather than `Date.UTC`, which maps years 0 through 99 onto 1900
 * through 1999 and would therefore reject the year 1 as a rollover it is not.
 *
 * The year is asked of `withinTimestamptzRange` rather than of the round trip, because the round trip
 * cannot see it: year 0 rebuilds perfectly and Postgres has no such year. `readsAsCursorTimestamp` in
 * `audit.ts` asks the same function about the same thing, having once carried a copy of this check
 * that then went missing.
 */
function readsAsTimestamp(value: string): boolean {
  const parts = CURSOR_RECENCY.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, 0);
  return (
    withinTimestamptzRange(at) &&
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second
  );
}

/**
 * A malformed cursor reads as the first page, which is the honest answer to a stale link.
 *
 * A cursor minted before part of the sort key existed is malformed by this definition, and
 * deliberately: it describes a position in an ordering this query no longer has.
 *
 * `recency` is checked for what it is and not merely for being a string, because it reaches Postgres
 * as `'...'::timestamptz`. A cursor somebody edited by hand used to fail there, deep inside the read,
 * with `invalid input syntax for type timestamp with time zone`, and `roster/routes.ts` answered
 * Hono's bare 500 — the opposite of the first page this docblock promises. That route now answers a
 * failed read as JSON, but a 500 of any shape is still the wrong answer to a stale link, so the
 * check belongs here, where the cursor is read rather than where the read fails.
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
      readsAsTimestamp(parsed.recency) &&
      typeof parsed?.pinned === "boolean"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
