import { describe, expect, test } from "bun:test";
import { emptyStateFor } from "../src/components/app-sidebar/app-sidebar";

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
    // indistinguishable from a genuinely empty one unless `loaded` says otherwise. This is the fifth
    // nothing: "not known yet" is not "nothing", and rendering "No conversations yet" for it is
    // precisely the regression this field exists to prevent — see the block comment above the
    // `loaded` guard in `emptyStateFor` for the accidentally-safe code it replaced.
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
    // The sixth case, and the only one that is not a nothing. A failed `GET /api/roster` also
    // arrives as `loaded: false, total: 0`, so before this the sidebar rendered a search box, three
    // status buttons and nothing else — with `retry: 1` and `refetchOnWindowFocus: false`, forever.
    // The sentence the roster query already constructs is the one said here.
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

  test("marks the five nothings as not failures, so only a failure offers a retry", () => {
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
    // A background refetch can fail with rows already in hand. Those rows are the true thing; an
    // alarm over the top of them would be the fifth mistake again, in the other direction.
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
