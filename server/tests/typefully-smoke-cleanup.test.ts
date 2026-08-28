import { expect, test } from "bun:test";
import { settleSmokeCleanup } from "./support/typefully-smoke-cleanup";

test("a cleanup failure cannot prevent fetch, vendor, and database restoration", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ smoke: true })) as typeof fetch;
  let vendorClosed = false;
  let databaseRestored = false;
  const errors = await settleSmokeCleanup([
    {
      name: "first resource",
      run: () => {
        throw new Error("cleanup refused");
      },
    },
    {
      name: "fetch",
      run: () => {
        globalThis.fetch = originalFetch;
      },
    },
    {
      name: "vendor",
      run: () => {
        vendorClosed = true;
      },
    },
    {
      name: "database",
      run: () => {
        databaseRestored = true;
      },
    },
  ]);

  expect(globalThis.fetch).toBe(originalFetch);
  expect(vendorClosed).toBe(true);
  expect(databaseRestored).toBe(true);
  expect(errors.map(({ message }) => message)).toEqual([
    "first resource: cleanup refused",
  ]);
});
