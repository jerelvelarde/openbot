/**
 * What the shape of a timestamp string says about the instant it names.
 *
 * ONE HOME, TWO READERS. `parseActivityInput` in `channels/routes.ts` refuses a reported `at` that
 * names no zone, and `auditQueryFromUrl` in `audit.ts` refuses a `?from=` or `?to=` bound that names
 * no zone, and those are the same rule about the same defect: `new Date("2026-08-31T12:00:00")` is
 * read in the server process's own local zone, so the identical string means a different instant
 * depending on where the process happens to run. Two clients sending the same reported stamp landed
 * at two different instants, and two replicas on different `TZ` settings answered the same audit
 * query as much as a day apart with a 200 on each — neither of them wrong from inside the read. The
 * bound carried that defect for as long as the reported stamp had the fix, with the reasoning written
 * out one file away, which is why the rule now lives here rather than in either reader.
 *
 * A CLASSIFICATION IS EXPORTED AND NOT A REGEXP, because the two readers do not accept the same set
 * and the difference is the interesting part rather than something to paper over. A reported `at` is a
 * machine timestamp and takes `date-time-with-zone` and nothing else; a query bound is typed by a
 * person and takes a bare `date` as well. Each reader names the shapes it accepts in one line, so
 * neither is loose by accident, and a third reader cannot arrive with the rule spelled slightly
 * differently — which is how these two came to disagree in the first place.
 *
 * THE BARE DATE IS NOT THE SAME AMBIGUITY, which is why it is a shape of its own rather than lumped in
 * with the refusals. ECMA-262 gives the two forms two different defaults: a date-only value is UTC,
 * and a date and time with no offset is local. So `2026-08-31` means the same midnight on every
 * replica and `2026-08-31T12:00:00` does not. Refusing everything zone-less would have been the
 * shorter fix and a regression: a bare date is what somebody types when asked "when", and
 * `AuditEventQuery.from` promises it. The specification is not taken on trust either — `audit.test.ts`
 * switches `TZ` under the running process and asserts both halves of that asymmetry.
 *
 * THE YEAR IS NOT ASKED ABOUT HERE. `\d{4}` and the extended `±YYYYYY` form are both shapes, and
 * whether the year is one a `timestamptz` can be given is `withinTimestamptzRange`'s question in
 * `roster/order.ts`, which both readers already ask and which can name the year in its refusal. A
 * shape check that quietly rejected the extended form would answer "that is not an ISO-8601 date" to a
 * string that is one, and a caller can only act on being told which of the two things they got wrong.
 */

/*
 * The ISO-8601 pieces, spelled once each and assembled below.
 *
 * What separates the three shapes is which pieces are present, so three whole regexes would carry the
 * same date half written out three times and a correction to it would land in one of them. That is
 * the failure this module exists to end, at a smaller scale.
 */
const YEAR = String.raw`(?:\d{4}|[+-]\d{6})`;
const MONTH_AND_DAY = String.raw`-\d{2}-\d{2}`;
const TIME_OF_DAY = String.raw`\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?`;
/*
 * `Z`, or an offset carrying the colon ISO-8601 requires.
 *
 * `+0200` is therefore not a zone here, although `new Date` reads it as one. It is the same argument as
 * the shapes below: a parser looser than its own error message is what let the zone-less form in, so
 * the accepted spelling is the documented one.
 */
const ZONE = String.raw`(?:[Zz]|[+-]\d{2}:\d{2})`;

const CALENDAR_DATE = new RegExp(`^${YEAR}${MONTH_AND_DAY}$`);
const DATE_TIME_WITH_ZONE = new RegExp(
  `^${YEAR}${MONTH_AND_DAY}[Tt]${TIME_OF_DAY}${ZONE}$`,
);
const DATE_TIME_WITHOUT_ZONE = new RegExp(
  `^${YEAR}${MONTH_AND_DAY}[Tt]${TIME_OF_DAY}$`,
);

export type TimestampShape =
  /**
   * A calendar date and no time of day: `2026-08-31`.
   *
   * Unambiguous, because ECMA-262 fixes a date-only form to UTC midnight. Portable enough for a bound
   * somebody types, and not a machine's record of when something happened.
   */
  | "date"
  /**
   * A date and time carrying `Z` or an offset: `2026-08-31T12:00:00Z`, `2026-08-31T14:00+02:00`.
   *
   * The only shape that names an instant no reader has to guess at, which is why it is the only one a
   * reported timestamp is allowed to take.
   */
  | "date-time-with-zone"
  /**
   * A date and time naming no zone: `2026-08-31T12:00:00`.
   *
   * The defect. Read in whatever zone the process runs in, which is what `<input
   * type="datetime-local">` submits and what a hand-written stamp looks like. Refused by both readers,
   * and refused with the missing part named, because it is one character away from correct.
   */
  | "date-time-without-zone"
  /**
   * Not ISO-8601 at all: `12/25/2026`, `2026-08-31 12:00:00`, `Sat, 31 Aug 2026 12:00:00 GMT`.
   *
   * `new Date` still reads several of these, in the local zone, by rules the specification leaves to
   * the implementation. So this is not "unparseable" — that is `Number.isNaN` on the parsed value, and
   * a different refusal — it is "parseable by a route nothing here documented", which is the same
   * ambiguity as the shape above wearing a different format.
   */
  | "not-iso-8601";

/**
 * The shape of `value`, saying nothing about whether the fields inside it are real.
 *
 * `2026-13-01T00:00:00Z` is a `date-time-with-zone` and not a date; `2026-02-30` is a `date` that
 * `Date` rolls into March. Both are left to the caller, which has `new Date` in hand and can say so
 * with the value's name attached — as against a shape check that would have to answer both with the
 * one word it has.
 */
export function timestampShape(value: string): TimestampShape {
  if (CALENDAR_DATE.test(value)) return "date";
  if (DATE_TIME_WITH_ZONE.test(value)) return "date-time-with-zone";
  if (DATE_TIME_WITHOUT_ZONE.test(value)) return "date-time-without-zone";
  return "not-iso-8601";
}

/*
 * The cursor timestamp, which is a narrower shape than any of the three above and deliberately so.
 *
 * Not assembled from the pieces above, because it accepts less of each: a four-digit year and not the
 * extended `±YYYYYY` form, seconds always present rather than optional, one to six fractional digits
 * rather than any number of them, and a literal `Z` rather than any zone. That is not a stricter mood
 * about the same subject — it is a different subject. The three shapes above describe what a person or
 * a client may hand in; this one describes what `recencyCursorText` writes, which is the only thing a
 * cursor is ever minted from.
 *
 * ONE TO SIX FRACTIONAL DIGITS, so a cursor minted before that function was used is still accepted:
 * `Date.prototype.toISOString` wrote three, and a link or a page somebody has open across the deploy
 * names a real position in an ordering that has not changed.
 *
 * The capture groups are what `cursorTimestampFields` hands back, and the reason this is one literal
 * rather than a composition: the group positions are the interface.
 */
const CURSOR_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;

/** The fields of a cursor timestamp, as numbers, in the order the string spells them. */
export type CursorTimestampFields = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/**
 * The fields of `value`, or `null` if it is not shaped as a cursor timestamp.
 *
 * TWO READERS AGAIN, AND THE SAME HISTORY. `readsAsTimestamp` in `roster/order.ts` and
 * `readsAsCursorTimestamp` in `audit.ts` each held a copy of this pattern — character for character
 * the same, docblocks included, one carrying capture groups. Two copies of a cursor's format is worse
 * than two copies of most rules: the roster and the audit trail mint their cursors the same way, so a
 * correction landing in one copy means one surface refuses a page the other would have served, and a
 * keyset cursor refused is a 400 on a link somebody had open.
 *
 * WHAT IS NOT SHARED is how each reader then decides the fields are real, and that is not an oversight.
 * `roster/order.ts` rebuilds the instant through `setUTCFullYear` and compares field by field, because
 * `Date.UTC` maps years 0 through 99 onto 1900 through 1999 and would call the year 1 a rollover.
 * `audit.ts` renders the parsed instant back and compares the first nineteen characters. Both catch
 * `2026-02-30T00:00:00Z`, neither can see the year — which is `withinTimestamptzRange`'s question, and
 * both ask it.
 */
export function cursorTimestampFields(
  value: string,
): CursorTimestampFields | null {
  const parts = CURSOR_TIMESTAMP.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  return { year, month, day, hour, minute, second };
}

/**
 * Whether `value` is shaped as a cursor timestamp, for the reader that does not need the fields.
 *
 * `audit.ts` reads the instant with `new Date` and compares the rendering, so it wants the shape and
 * nothing else. Spelled here rather than as `cursorTimestampFields(v) !== null` at the call site so
 * that both readers name the rule the same way.
 */
export function isCursorTimestamp(value: string): boolean {
  return CURSOR_TIMESTAMP.test(value);
}
