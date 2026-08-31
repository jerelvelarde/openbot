import { describe, expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor } from "../src/agents/profile-types";
import { createApp } from "../src/app";
import type { AppVariables } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { createRosterRoutes } from "../src/roster/routes";
import type {
  RosterItem,
  RosterPage,
  RosterQuery,
  RosterStore,
} from "../src/roster/query";
import { testEnvironment } from "./support/environment";

const actor: AgentActor = { id: "user-1", role: "user" };

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function item(overrides: Partial<RosterItem> = {}): RosterItem {
  return {
    kind: "channel",
    id: "channel_1",
    name: "Assistant channel",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
    archived: false,
    lastMessage: "Hello",
    lastMessageAt: new Date("2026-08-31T09:00:00.000Z"),
    lastMessageAgentId: "agent-1",
    createdAt: new Date("2026-08-30T09:00:00.000Z"),
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

/**
 * Records the query it was given rather than answering from a database, so the assertions below are
 * about what the route asked for, not about anything a real `RosterStore` would compute.
 */
function fakeStore(page: RosterPage): RosterStore & { queries: RosterQuery[] } {
  const queries: RosterQuery[] = [];
  return {
    async list(_actor, query = {}) {
      queries.push(query);
      return page;
    },
    queries,
  };
}

function appFor(store: RosterStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createRosterRoutes(store, requireUser));
  return app;
}

describe("GET /", () => {
  test("serialises every timestamp as ISO-8601", async () => {
    const store = fakeStore({ items: [item()], nextCursor: null });
    const response = await appFor(store).request("/");

    expect(await response.json()).toEqual({
      items: [
        {
          kind: "channel",
          id: "channel_1",
          name: "Assistant channel",
          agentIds: ["agent-1"],
          threadId: "thread-1",
          active: true,
          archived: false,
          lastMessage: "Hello",
          // Strings the browser can sort and compare, which is the bet the sort rule already makes.
          lastMessageAt: "2026-08-31T09:00:00.000Z",
          lastMessageAgentId: "agent-1",
          createdAt: "2026-08-30T09:00:00.000Z",
          pinned: false,
          lastReadAt: null,
        },
      ],
      nextCursor: null,
    });
  });

  test("passes the status through", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?status=archived");

    expect(store.queries).toEqual([{ status: "archived" }]);
  });

  test("reads an unrecognised status as active", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?status=nonsense");

    expect(store.queries).toEqual([{ status: "active" }]);
  });

  test("passes a cursor and a limit through", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?cursor=abc&limit=10");

    expect(store.queries).toEqual([
      { status: "active", cursor: "abc", limit: 10 },
    ]);
  });

  test("passes a limit above the page cap through for the store to clamp", async () => {
    // The cap is the store's to apply — `MAX_ROSTER_PAGE` lives beside it — so the route's job is to
    // pass on what was asked for rather than to quietly ask for something else.
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?limit=1000");

    expect(store.queries).toEqual([{ status: "active", limit: 1000 }]);
  });

  test("reads a leading zero as a digit, not as a refusal", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?limit=007");

    expect(store.queries).toEqual([{ status: "active", limit: 7 }]);
  });

  test("reads an empty ?limit= as absent", async () => {
    // A parameter that says nothing is not a parameter, which is how an empty `?cursor=` reads too.
    // Omitting the key is what makes the store's own default page size fire.
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?limit=");

    expect(store.queries).toEqual([{ status: "active" }]);
  });

  /*
   * A limit that is not a whole number is refused, not reinterpreted.
   *
   * `Number.parseInt` stopped at the first character it could not read and kept the digits in front
   * of it, so each of these used to mean something the caller did not ask for, with a 200 on it and
   * nothing to reveal the difference. The sharpest is `1e3`: a caller asking for a thousand rows was
   * served one.
   */
  test.each([
    ["1e3", "a thousand in exponent form, which parsed as 1"],
    ["0x10", "sixteen in hex, which parsed as 0"],
    ["50abc", "digits with a tail, which parsed as 50"],
    ["-5", "negative, which the store clamped up to 1"],
    ["0", "no rows, which the store clamped up to 1"],
    ["5.5", "not a whole number"],
    ["+5", "signed"],
    [" 5", "a space where a digit goes"],
    ["lots", "not a number at all"],
  ])("refuses ?limit=%p: %s", async (value: string) => {
    const store = fakeStore({ items: [], nextCursor: null });
    const response = await appFor(store).request(
      `/?limit=${encodeURIComponent(value)}`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Limit must be a whole number of at least 1.",
    });
    // And no page was read. A refusal that still served rows would be the same misreading with a
    // status code on top of it.
    expect(store.queries).toEqual([]);
  });

  test("carries the next cursor", async () => {
    const store = fakeStore({ items: [item()], nextCursor: "next" });
    const response = await appFor(store).request("/");

    expect((await response.json()).nextCursor).toBe("next");
  });

  test("answers a failed read as JSON, not as Hono's bare 500", async () => {
    /*
     * This is the sidebar's only read, so whatever it answers is the whole screen. `client()` in the
     * browser takes its message from `body.error` and falls back to its own "Could not load your
     * conversations" when the body is not JSON, and Hono's default 500 body is `text/plain` — so an
     * unreachable database reached a person as the client's own sentence, carrying nothing of the
     * server's reason and indistinguishable from any other way this read can fail.
     */
    const store: RosterStore = {
      async list() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await appFor(store).request("/");

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.json()).toEqual({
        error: "The server could not read your conversations.",
      });
      // What was thrown may name a host or carry a connection string, so the browser gets none of
      // it and the log gets all of it. A 500 with no log line would be an outage nobody could tell
      // from a typo in this file.
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain("ECONNREFUSED");
    } finally {
      consoleError.mockRestore();
    }
  });
});

/*
 * A deployment that mounted no roster store.
 *
 * Built through `createApp` rather than through this file's own `appFor`, because the behaviour under
 * test belongs to the mount and not to the routes: `appFor` mounts `createRosterRoutes`, which is
 * exactly the branch that is absent here.
 */
describe("GET /api/roster with no store mounted", () => {
  function appWithoutRoster() {
    return createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: {
              id: "user-1",
              email: "somebody@openbot.test",
              name: "Somebody",
              image: null,
            },
          }),
        },
      } as never,
      { rolesForUser: async () => ["user"] },
    );
  }

  /*
   * 503 and a reason, not Hono's bare `notFound()`.
   *
   * The sidebar has one read, so whatever this answers is the whole screen. `client()` in the browser
   * takes its message from `body.error` and falls back to its own sentence when the body is not JSON,
   * so a 404 carrying Hono's text body reaches somebody as "Could not load your conversations" with
   * nothing in it about why — indistinguishable, from the outside, from having no conversations.
   */
  test("says the roster is unavailable rather than that it does not exist", async () => {
    const response = await appWithoutRoster().request(
      "http://openbot.test/api/roster",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "The roster is not available.",
    });
  });
});
