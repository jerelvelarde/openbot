import { describe, expect, test } from "bun:test";
import { parseRosterStatus } from "../src/roster/query";

describe("parseRosterStatus", () => {
  /*
   * `as const`, so the expectation stays a `RosterStatus` rather than widening to `string`.
   *
   * Widened, `toBe` had a `string` where it wants the narrower type and did not compile — a type
   * error the suite cannot see, because `server/tsconfig.json` excludes `tests`.
   */
  test.each([
    ["active", "active"],
    ["archived", "archived"],
    ["all", "all"],
  ] as const)("reads %p as %p", (input, expected) => {
    expect(parseRosterStatus(input)).toBe(expected);
  });

  test.each([[null], [undefined], [""], ["ACTIVE"], ["deleted"], ["nonsense"]])(
    "reads %p as active",
    (input) => {
      // The same call decodeRosterCursor makes for a malformed cursor: the honest answer to a stale
      // link is the first page, not a 400 a person cannot act on. Case-sensitive on purpose, so the
      // accepted set is exactly the three documented values.
      expect(parseRosterStatus(input)).toBe("active");
    },
  );
});
