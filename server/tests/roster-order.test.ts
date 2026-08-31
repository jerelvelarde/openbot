import { describe, expect, test } from "bun:test";
import { decodeRosterCursor, encodeRosterCursor } from "../src/roster/order";

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
