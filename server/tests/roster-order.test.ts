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
});
