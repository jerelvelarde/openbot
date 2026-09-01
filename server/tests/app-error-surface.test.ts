import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { IdentityProviderStore } from "../src/auth/identity-provider-store";
import type { AuditReader } from "../src/audit";
import { loadConfig } from "../src/config";
import type { PackageStatusReader } from "../src/tenant-package";
import { testEnvironment } from "./support/environment";

/**
 * What `app.ts` answers when something under it throws.
 *
 * The three route files each grew a `mapStoreError` so a database blip reaches the browser as
 * `{ error }` rather than as Hono's `text/plain "Internal Server Error"` — `client()` reads
 * `body.error` and falls back to its own sentence when the body is not JSON, so the server's reason
 * is lost on a text body. `app.ts`'s own dozen handlers were left out of that change, along with the
 * session middleware every one of them runs behind, which is what these pin.
 *
 * The audit trail's 400s are pinned here too, and deliberately: they are the reason
 * `channels/routes.ts` gives for NOT reaching for an app-level `onError`, so the handler that now
 * exists has to leave them alone or that objection was right.
 */

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

/** A signed-in administrator, so the admin routes below are reached rather than refused. */
const adminAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: { getSession: async () => ({ user: ADMIN }) },
} as never;

const requestOn =
  (app: { request: (url: string) => Promise<Response> }) => (path: string) =>
    app.request(`http://openbot.test${path}`);

describe("GET /api/capabilities when the SSO read fails", () => {
  /*
   * Positions 4-18 are the other stores; `identityProviders` is 19.
   *
   * Counted the way `people-routes.test.ts` counts, and for the reason it gives: every parameter
   * from 4 on is optional, so getting the count wrong is a silent type-check pass that lands the
   * store somewhere else entirely and fails the test for a reason that is not the one under test.
   */
  const appWith = (identityProviders: IdentityProviderStore) =>
    requestOn(
      createApp(
        loadConfig(testEnvironment()),
        undefined,
        undefined,
        ...(Array.from({ length: 15 }) as never[]),
        identityProviders as never,
      ),
    );

  /*
   * This endpoint is what the sign-in screen reads to know which buttons to draw, and it has no
   * authentication because nobody has signed in yet. So one unreachable table behind one boolean
   * used to mean nobody could sign in at all — and with the body a `text/plain` 500, the screen
   * could not even say why.
   */
  test("still tells the sign-in screen which providers to draw", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await appWith({
        list: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
        },
        remove: async () => false,
      })("/api/capabilities");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        mode: "intelligence",
        durableHistory: true,
        authProviders: ["google"],
        // False, not absent: the boolean says whether to offer the box that routes by domain, and a
        // deployment that cannot read its providers has none it can promise to route to.
        ssoConfigured: false,
      });
      // Degraded, not silent. Somebody with an Okta tenant registered is being shown a sign-in
      // screen that does not offer it, and nothing else on this path would say so.
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain("ECONNREFUSED");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("the app's own error surface", () => {
  const appWith = (packageStatusReader: PackageStatusReader) =>
    requestOn(
      createApp(
        loadConfig(testEnvironment()),
        adminAuth,
        { rolesForUser: async () => ["admin"] },
        undefined,
        undefined,
        packageStatusReader,
      ),
    );

  test("answers a handler's failed read as JSON, not as Hono's bare 500", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await appWith({
        active: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
        },
      })("/api/admin/package");

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.json()).toEqual({
        error: "The server could not complete that request.",
      });
      // The same split the route files' `mapStoreError` keeps: the sentence names the server as the
      // side that failed, and what was thrown — which may carry a connection string — goes to the
      // log with the method and path that provoked it.
      const logged = String(consoleError.mock.calls.at(-1)?.[0]);
      expect(logged).toContain("ECONNREFUSED");
      expect(logged).toContain("/api/admin/package");
    } finally {
      consoleError.mockRestore();
    }
  });

  /*
   * The session middleware, not a handler.
   *
   * Wrapping each handler in its own try/catch would not have covered this: `createRequireUser` runs
   * in front of every route in this file and reads the role repository, so an unreachable database
   * throws there for `/api/me` as readily as for anything else.
   */
  test("answers a failed session check as JSON too", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await requestOn(
        createApp(loadConfig(testEnvironment()), adminAuth, {
          rolesForUser: async () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
          },
        }),
      )("/api/me");

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.json()).toEqual({
        error: "The server could not complete that request.",
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  /*
   * And the case that made `channels/routes.ts` refuse an app-level handler in the first place.
   *
   * `refuseAuditQuery` mints an `HTTPException` carrying its own `{ error }` 400 response, which
   * Hono's default handler serves by calling `getResponse()`. A handler that answered 500 for
   * everything it caught would turn every named-parameter refusal on the trail into a 500 that says
   * nothing about which parameter was wrong, which is the failure `audit.ts` exists to prevent.
   */
  test("leaves the audit trail's own refusals at the status they carry", async () => {
    const reader: AuditReader = {
      list: async () => {
        throw new Error("The refused query must never reach the read.");
      },
    };
    const response = await requestOn(
      createApp(
        loadConfig(testEnvironment()),
        adminAuth,
        { rolesForUser: async () => ["admin"] },
        reader,
      ),
    )("/api/admin/audit-events?from=yesterday");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'from must be a date, and "yesterday" is not one.',
    });
  });
});

/**
 * The stream path's own decode, asserted against the script's own source.
 *
 * `index.ts` cannot be imported to be tested: it loads configuration, opens a database, starts the
 * listeners and calls `serve` as a side effect of loading. `cull-sweep-wiring.test.ts` reads
 * `scripts/cull-idle-computers.ts` as text for the same reason, and this follows it.
 *
 * WHAT THIS CANNOT SEE. It proves the decode is guarded and that nothing else calls the bare one; it
 * does not exercise `serve.fetch`. The behaviour it stands in for is the one thing no test in this
 * suite can reach: a throw there is outside Hono, so `app.onError` never runs and Bun answers its
 * own 500 with an HTML body — the one response shape in this deployment that no part of the server
 * chose.
 */
describe("the serve entry's stream path", () => {
  const script = readFileSync(
    join(import.meta.dir, "..", "src", "index.ts"),
    "utf8",
  );

  /**
   * One declaration's own text, so a failure prints the function and not the whole boot script.
   *
   * Sliced from `const <name>` to the line that closes it, which is how both of these are written.
   */
  const declaration = (name: string) => {
    const start = script.indexOf(`const ${name}`);
    if (start === -1) return `there is no ${name} in index.ts`;
    return script.slice(start, script.indexOf("\n};", start) + 3);
  };

  test("decodes the Bot id through a guard rather than bare", () => {
    expect(declaration("streamPathBotId")).toContain(
      "decodeStreamSegment(match[1])",
    );
    // The bare call is what threw, and a malformed escape in a path is a request anybody can send.
    expect(declaration("streamPathBotId")).not.toContain("decodeURIComponent(");
  });

  test("and the guard answers rather than throwing", () => {
    expect(declaration("decodeStreamSegment")).toContain("} catch {");
  });
});
