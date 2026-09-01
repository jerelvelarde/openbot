import { describe, expect, test } from "bun:test";
import {
  decodeRosterCursor,
  encodeRosterCursor,
  withinTimestamptzRange,
} from "../src/roster/order";

describe("the roster cursor", () => {
  test("round-trips every part of the sort key", () => {
    const cursor = {
      pinned: true,
      recency: "2026-08-31T09:00:00.000Z",
      id: "channel_1",
    };
    expect(decodeRosterCursor(encodeRosterCursor(cursor))).toEqual(cursor);
  });

  test("reads a malformed cursor as the first page", () => {
    // The honest answer to a stale link: it names a position in an ordering we no longer have.
    expect(decodeRosterCursor("not-base64url")).toBeUndefined();
    expect(decodeRosterCursor(undefined)).toBeUndefined();
  });

  test("reads a cursor missing part of the sort key as the first page", () => {
    const partial = Buffer.from(
      JSON.stringify({ recency: "2026-08-31T09:00:00.000Z", id: "channel_1" }),
      "utf8",
    ).toString("base64url");
    expect(decodeRosterCursor(partial)).toBeUndefined();
  });

  test("round-trips a timestamp at the precision Postgres stores", () => {
    // Six fractional digits is what `recencyCursorText` mints, and the cursor has to carry all of
    // them: flooring the boundary to what a JS `Date` holds is what served rows on no page at all.
    const cursor = {
      pinned: false,
      recency: "2026-08-31T09:00:00.123456Z",
      id: "botchat_1",
    };
    expect(decodeRosterCursor(encodeRosterCursor(cursor))).toEqual(cursor);
  });

  test.each([
    [
      "2026-08-31T09:00:00.123456Z",
      "six digits, as this deployment mints them",
    ],
    [
      "2026-08-31T09:00:00.123Z",
      "three, as `toISOString` minted them before it",
    ],
    ["2026-08-31T09:00:00Z", "none at all"],
    ["2024-02-29T09:00:00Z", "a leap day that exists"],
    [
      "0001-01-01T00:00:00Z",
      "a year the 0-to-99 mapping in `Date.UTC` would have rejected",
    ],
  ])("accepts %p: %s", (recency) => {
    const cursor = { pinned: true, recency, id: "channel_1" };
    expect(decodeRosterCursor(encodeRosterCursor(cursor))).toEqual(cursor);
  });

  test.each([
    ["lol", "not a timestamp at all"],
    ["", "empty"],
    ["2026-02-30T00:00:00.000Z", "a day that rolled over into March"],
    ["2026-02-29T00:00:00.000Z", "a leap day in a year that has none"],
    ["2026-13-01T00:00:00.000Z", "a thirteenth month"],
    ["2026-08-31T25:00:00.000Z", "a twenty-fifth hour"],
    ["2026-08-31 09:00:00Z", "a space where the `T` goes"],
    ["2026-08-31T09:00:00.1234567Z", "more precision than `timestamptz` keeps"],
    ["2026-08-31T09:00:00+02:00", "an offset rather than the UTC this mints"],
    [
      "0000-01-01T00:00:00Z",
      "a year 0, which a `Date` has and `timestamptz` does not",
    ],
  ])("reads %p as the first page: %s", (recency) => {
    /*
     * Checked here rather than left to Postgres. The value reaches it as `'...'::timestamptz`, so a
     * cursor somebody edited by hand used to fail inside the read with `invalid input syntax for type
     * timestamp with time zone` or `date/time field value out of range`, which `roster/routes.ts` can
     * only answer with a 500 — the opposite of the first page this codec promises.
     *
     * Year 0 is the one on this list that the field-by-field round trip cannot catch on its own:
     * `new Date(0)` with `setUTCFullYear(0, 0, 1)` reads back as year 0 exactly, and Postgres has no
     * such year — `select '0000-01-01T00:00:00Z'::timestamptz` is out of range. `0001-01-01` in the
     * accepted table above is the neighbour it must not be confused with.
     */
    const cursor = encodeRosterCursor({
      pinned: false,
      recency,
      id: "channel_1",
    });
    expect(decodeRosterCursor(cursor)).toBeUndefined();
  });
});

/*
 * The one rule two files and three parameters share.
 *
 * A JS `Date` runs from ISO year -271821 to AD 275760 and `timestamptz` will not be given either end
 * of that, so a bound or a cursor timestamp that parses cleanly still fails inside the read — as an
 * ordinary driver error, which with no `onError` registered in `app.ts` is Hono's bare plain-text
 * 500. `decodeRosterCursor` above, `readsAsCursorTimestamp` in `audit.ts` and `auditQueryFromUrl`'s
 * `from`/`to` each need this answer; the second of them once carried its own copy and lost the year-0
 * line, which is why the rule is asserted here on its own rather than only through its callers.
 *
 * The window is AD 1 through 9999 and the reason is the rendering, not the calendar: both ways a
 * `Date` reaches the column go through a four-digit year, and outside that window `toISOString()`
 * switches to ISO 8601's extended `±YYYYYY` form, whose leading sign Postgres reads as a zone
 * offset.
 */
describe("the range timestamptz can be given", () => {
  const at = (iso: string) => new Date(iso);

  test.each([
    ["0001-01-01T00:00:00.000Z", "the first year in the window"],
    ["2026-08-31T09:00:00.000Z", "an ordinary one"],
    ["9999-12-31T23:59:59.999Z", "the last four-digit year"],
  ])("holds %p: %s", (iso: string) => {
    expect(withinTimestamptzRange(at(iso))).toBe(true);
  });

  test.each([
    [
      "0000-01-01T00:00:00.000Z",
      "a year 0, which JS has and the calendar does not",
    ],
    [
      "-000001-12-31T00:00:00.000Z",
      "a negative ISO year, on the other side of it",
    ],
    ["-271821-04-20T00:00:00.000Z", "the earliest instant a `Date` holds"],
    [
      "+010000-01-02T00:00:00.000Z",
      "a five-digit year, which renders with a sign",
    ],
    ["+275760-09-13T00:00:00.000Z", "the latest instant a `Date` holds"],
  ])("does not hold %p: %s", (iso: string) => {
    // Each of these is a perfectly good `Date`: the point is that being one is not enough.
    expect(Number.isNaN(at(iso).getTime())).toBe(false);
    expect(withinTimestamptzRange(at(iso))).toBe(false);
  });

  test("does not hold an Invalid Date either", () => {
    // So a caller has no separate `Number.isNaN` check to remember: every comparison against the
    // `NaN` year of an Invalid Date is false.
    expect(withinTimestamptzRange(new Date("lol"))).toBe(false);
  });
});
