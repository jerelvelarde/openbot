import { describe, expect, test } from "bun:test";
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

  test("omits a limit that is not a number rather than passing NaN", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?limit=lots");

    // The store clamps a limit it is given; it must not be handed NaN to clamp.
    expect(store.queries).toEqual([{ status: "active" }]);
  });

  test("carries the next cursor", async () => {
    const store = fakeStore({ items: [item()], nextCursor: "next" });
    const response = await appFor(store).request("/");

    expect((await response.json()).nextCursor).toBe("next");
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
