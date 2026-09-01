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
