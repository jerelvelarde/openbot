import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { createRosterRoutes } from "../src/roster/routes";
import type {
  RosterItem,
  RosterPage,
  RosterQuery,
  RosterStore,
} from "../src/roster/query";

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
