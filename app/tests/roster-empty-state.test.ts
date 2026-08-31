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
    });
    const all = emptyStateFor({
      status: "all",
      searching: false,
      total: 0,
      search: "",
      loaded: true,
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
    });
    // A search that matched nothing is a fact about the search, whichever list it ran against.
    expect(state?.description).toContain("budget");
  });

  test("says nothing while the roster hasn't answered yet, even though total reads 0", () => {
    // `matchingItems(undefined, …)` returns `[]`, so a pending (or errored) roster arrives here as
    // `total: 0` — indistinguishable from a genuinely empty one unless `loaded` says otherwise. This
    // is the fifth nothing: "not known yet" is not "nothing", and rendering "No conversations yet"
    // for it is precisely the regression this field exists to prevent — see the block comment above
    // the `loaded` guard in `emptyStateFor` for the accidentally-safe code it replaced.
    expect(
      emptyStateFor({
        status: "active",
        searching: false,
        total: 0,
        search: "",
        loaded: false,
      }),
    ).toBeNull();
  });
});
