import { describe, expect, test } from "bun:test";
import {
  emptyStateFor,
  relativeScale,
  rosterAnimation,
} from "../src/components/app-sidebar/app-sidebar";

describe("emptyStateFor", () => {
  test("says nothing at all when there are rows to show", () => {
    expect(
      emptyStateFor({
        status: "active",
        searching: false,
        total: 3,
        search: "",
        loaded: true,
        failure: null,
      }),
    ).toBeNull();
  });

  test("tells a new person how to start", () => {
    const state = emptyStateFor({
      status: "active",
      searching: false,
      total: 0,
      search: "",
      loaded: true,
      failure: null,
    });
    expect(state?.title).toBe("No conversations yet");
  });

  test("quotes the search back rather than claiming there is nothing", () => {
    const state = emptyStateFor({
      status: "active",
      searching: true,
      total: 0,
      search: "  refnud  ",
      loaded: true,
      failure: null,
    });
    // Told "you don't have conversations yet" while holding a typo, a person reads their history as
    // gone. The search text is quoted so they can see what was actually looked for.
    expect(state?.description).toContain("refnud");
  });

  test("says the archive is empty rather than that nothing exists", () => {
    const state = emptyStateFor({
      status: "archived",
      searching: false,
      total: 0,
      search: "",
      loaded: true,
      failure: null,
    });
    expect(state?.title).toBe("Nothing archived");
  });

  test("distinguishes an empty archive from an empty account", () => {
    const archived = emptyStateFor({
      status: "archived",
      searching: false,
      total: 0,
      search: "",
      loaded: true,
      failure: null,
    });
    const all = emptyStateFor({
      status: "all",
      searching: false,
      total: 0,
      search: "",
      loaded: true,
      failure: null,
    });
    expect(archived?.title).not.toBe(all?.title);
  });

  test("prefers the search wording over the status wording", () => {
    const state = emptyStateFor({
      status: "archived",
      searching: true,
      total: 0,
      search: "budget",
      loaded: true,
      failure: null,
    });
    // A search that matched nothing is a fact about the search, whichever list it ran against.
    expect(state?.description).toContain("budget");
  });

  test("says nothing while the roster hasn't answered yet, even though total reads 0", () => {
    // `matchingItems(undefined, …)` returns `[]`, so a pending roster arrives here as `total: 0` —
    // indistinguishable from a genuinely empty one unless `loaded` says otherwise. "Not known yet"
    // is not "nothing", and rendering "No conversations yet" for it is precisely the regression this
    // field exists to prevent — see the docblock on `emptyStateFor` for the accidentally-safe code
    // it replaced.
    expect(
      emptyStateFor({
        status: "active",
        searching: false,
        total: 0,
        search: "",
        loaded: false,
        failure: null,
      }),
    ).toBeNull();
  });

  test("says the roster failed rather than showing the void it used to", () => {
    // A failed `GET /api/roster` also arrives as `loaded: false, total: 0`, so before this the
    // sidebar rendered a search box, three status buttons and nothing else — with `retry: 1` and
    // `refetchOnWindowFocus: false`, forever. The sentence the roster query already constructs is
    // the one said here.
    const state = emptyStateFor({
      status: "active",
      searching: false,
      total: 0,
      search: "",
      loaded: false,
      failure: "Could not load your conversations",
    });
    expect(state?.title).toBe("Could not load your conversations");
    expect(state?.failed).toBe(true);
  });

  test("a failure outranks the search and status wording, which describe a list that never arrived", () => {
    const state = emptyStateFor({
      status: "archived",
      searching: true,
      total: 0,
      search: "budget",
      loaded: false,
      failure: "Could not load your conversations",
    });
    expect(state?.failed).toBe(true);
  });

  test("marks every emptiness as not a failure, so only a failure offers a retry", () => {
    for (const status of ["active", "archived", "all"] as const) {
      expect(
        emptyStateFor({
          status,
          searching: false,
          total: 0,
          search: "",
          loaded: true,
          failure: null,
        })?.failed,
      ).toBe(false);
    }
    expect(
      emptyStateFor({
        status: "active",
        searching: true,
        total: 0,
        search: "refnud",
        loaded: true,
        failure: null,
      })?.failed,
    ).toBe(false);
  });

  test("leaves loaded rows alone when a refetch fails, rather than replacing them with an alarm", () => {
    // A background refetch can fail with rows already in hand — `channels.data` is still defined, so
    // `loaded` is still true. Those rows are the true thing on screen; an alarm over the top of them
    // would be the same mistake as saying "no conversations yet" to a pending roster, made in the
    // other direction. The `loaded` param doc says so; this pins it.
    expect(
      emptyStateFor({
        status: "active",
        searching: false,
        total: 3,
        search: "",
        loaded: true,
        failure: "Could not load your conversations",
      }),
    ).toBeNull();
  });
});

describe("rosterAnimation", () => {
  /*
   * The comment on `rosterAnimation` says filtering does not animate. It used to say that while
   * gating only `layout`, so every keystroke still faded non-matching rows out and slid re-matching
   * ones back in — the thrashing the sentence claimed to prevent, minus the relayout. `entrance` is
   * the half that was missing, so it is the half these assert hardest.
   */
  test("nothing animates while somebody is typing", () => {
    expect(
      rosterAnimation({ searching: true, status: "active", rows: 5 }),
    ).toEqual({ entrance: false, order: false });
  });

  test("nothing animates outside Active, where the list itself was swapped out", () => {
    for (const status of ["archived", "all"] as const) {
      expect(rosterAnimation({ searching: false, status, rows: 5 })).toEqual({
        entrance: false,
        order: false,
      });
    }
  });

  test("an unfiltered Active roster animates both ways", () => {
    expect(
      rosterAnimation({ searching: false, status: "active", rows: 5 }),
    ).toEqual({ entrance: true, order: true });
  });

  test("past the row cap, rows still fade but the list stops reordering", () => {
    // The cap is about `layout`, which measures every animated row on each reorder. A fade costs a
    // row that is mounting anyway nothing, so it is not what the cap takes away.
    const capped = rosterAnimation({
      searching: false,
      status: "active",
      rows: 61,
    });
    expect(capped).toEqual({ entrance: true, order: false });
  });
});

describe("relativeScale", () => {
  const MINUTE = 60_000;
  const DAY = 86_400_000;

  test("says a year-old conversation in years, not in 52 weeks", () => {
    // Weeks used to be the last unit, so anything older than one was said in them: a year read
    // "52 weeks ago" and three years read "157 weeks ago" — numbers nobody converts at a glance.
    expect(relativeScale(365 * DAY)).toEqual({ value: -1, unit: "year" });
    expect(relativeScale(3 * 365 * DAY)).toEqual({ value: -3, unit: "year" });
  });

  test("says a two-month-old conversation in months", () => {
    expect(relativeScale(61 * DAY)).toEqual({ value: -2, unit: "month" });
  });

  test("still says weeks for the gaps weeks are the right unit for", () => {
    expect(relativeScale(14 * DAY)).toEqual({ value: -2, unit: "week" });
  });

  test("rolls up to a year before months can round to twelve of themselves", () => {
    // The month limit stops half a month short of a year for exactly this: 360 days is 11.8 months,
    // and left in months it would round to "12 months ago" — "52 weeks ago" one unit further along.
    expect(relativeScale(360 * DAY)).toEqual({ value: -1, unit: "year" });
    // The unit below it is still reached, so the early stop did not swallow the whole of months.
    expect(relativeScale(300 * DAY)).toEqual({ value: -10, unit: "month" });
  });

  test("picks the smallest unit the gap fits in", () => {
    expect(relativeScale(2 * MINUTE)).toEqual({ value: -2, unit: "minute" });
    expect(relativeScale(5 * 3_600_000)).toEqual({ value: -5, unit: "hour" });
    expect(relativeScale(3 * DAY)).toEqual({ value: -3, unit: "day" });
  });

  test("a clock that is ahead reads forwards rather than crashing", () => {
    // `lastMessageAt` arrives over a socket from a writer whose clock may be ahead of this reader's,
    // so the gap can genuinely be negative. `Intl.RelativeTimeFormat` says "in 2 minutes" for it.
    expect(relativeScale(-2 * MINUTE)).toEqual({ value: 2, unit: "minute" });
  });

  test("an unparseable date is nothing to say, not a RangeError", () => {
    // `new Date("nonsense").getTime()` is NaN, and `Intl.RelativeTimeFormat.format` throws
    // `RangeError` on a non-finite number. There is no error boundary in this app, so one bad
    // timestamp would take the whole sidebar down rather than one row's caption.
    expect(relativeScale(Number.NaN)).toBeNull();
    expect(relativeScale(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
