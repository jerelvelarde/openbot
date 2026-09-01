import { describe, expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createApp } from "../src/app";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { createRosterRoutes } from "../src/roster/routes";
import type { RosterItem, RosterPage, RosterStore } from "../src/roster/query";
import { testEnvironment } from "./support/environment";

/**
 * `AuthenticatedActor`, not `AgentActor`: this is set as the Hono context `actor`, which is the wider
 * of the two, and it carries an email the narrower type has no field for. Annotated `AgentActor` it
 * did not compile — `context.set("actor", …)` wants the wider type — and nothing said so, because
 * `server/tsconfig.json` excludes `tests`. `RosterStore.list` takes the narrower type and receives
 * this unchanged, which is what the assertions on `store.calls` below are about.
 *
 * The third of three fixtures in this change with the same defect; `channel-archive.test.ts` and
 * `bot-chat-routes.test.ts` are the two that were already annotated this way.
 */
const actor: AuthenticatedActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

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

type StoreCall = [method: keyof RosterStore, ...arguments_: unknown[]];

/**
 * Records the actor and the query it was given rather than answering from a database, so the
 * assertions below are about what the route asked for and who it asked as, not about anything a real
 * `RosterStore` would compute.
 *
 * `calls`, WITH THE ACTOR IN EVERY ONE, is `channel-routes.test.ts`'s and `bot-chat-routes.test.ts`'s
 * shape rather than a third spelling of it. This file used to record the query alone —
 * `async list(_actor, …)` — and discard the actor, which is the one thing `GET /api/roster` has to get
 * right: it is the sidebar's only read and its entire authorization is that the store is handed
 * whoever the middleware authenticated. Nothing here observed that, so deleting `requireUser` from
 * the route left all nineteen tests green, and so did handing the store somebody else's actor, while
 * the same deletion fails two tests on channels and five on bot chats.
 */
function fakeStore(page: RosterPage): RosterStore & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  return {
    async list(receivedActor, query = {}) {
      calls.push(["list", receivedActor, query]);
      return page;
    },
    calls,
  };
}

/**
 * The middleware is a parameter, the way it is in `channel-routes.test.ts`, so a test can authenticate
 * somebody other than this file's one actor. Without that, "the store is read as the authenticated
 * actor" and "the store is read as the actor this file happens to declare" are the same assertion.
 */
function appFor(
  store: RosterStore,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createRosterRoutes(store, middleware));
  return app;
}

describe("GET /", () => {
  /*
   * WHO THE ROSTER IS READ AS, which on this endpoint is the whole of the authorization.
   *
   * `RosterStore.list` is scoped to the actor it is handed and there is no other check anywhere on
   * this route: no membership term, no ownership term, nothing to refuse. So the one thing that can go
   * wrong here is the actor not arriving, and until this file recorded the actor nothing could tell.
   * Asserted on every call below as well, the way both sibling fixtures do it, rather than only here —
   * a route that forwarded the actor for a plain read and dropped it for a filtered one would pass a
   * single test at the top of the file.
   */
  test("reads the roster as the authenticated actor", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/");

    expect(store.calls).toEqual([["list", actor, { status: "active" }]]);
  });

  test("reads it as whoever the middleware authenticated, not as a fixed actor", async () => {
    /*
     * The half the test above cannot make: it compares against the only actor this file declares, so
     * a route that ignored `context.var.actor` and read as some constant of its own would satisfy it
     * as long as the constant matched. A second actor is what separates "forwards the actor" from
     * "happens to agree with this fixture".
     */
    const somebodyElse: AuthenticatedActor = {
      id: "user-2",
      email: "other@openbot.test",
      role: "admin",
    };
    const store = fakeStore({ items: [item()], nextCursor: null });

    const response = await appFor(store, async (context, next) => {
      context.set("actor", somebodyElse);
      await next();
    }).request("/");

    expect(response.status).toBe(200);
    expect(store.calls).toEqual([["list", somebodyElse, { status: "active" }]]);
  });

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

    expect(store.calls).toEqual([["list", actor, { status: "archived" }]]);
  });

  test("reads an unrecognised status as active", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?status=nonsense");

    expect(store.calls).toEqual([["list", actor, { status: "active" }]]);
  });

  test("passes a cursor and a limit through", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?cursor=abc&limit=10");

    expect(store.calls).toEqual([
      ["list", actor, { status: "active", cursor: "abc", limit: 10 }],
    ]);
  });

  test("passes a limit above the page cap through for the store to clamp", async () => {
    // The cap is the store's to apply — `MAX_ROSTER_PAGE` lives beside it — so the route's job is to
    // pass on what was asked for rather than to quietly ask for something else.
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?limit=1000");

    expect(store.calls).toEqual([
      ["list", actor, { status: "active", limit: 1000 }],
    ]);
  });

  test("reads a leading zero as a digit, not as a refusal", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?limit=007");

    expect(store.calls).toEqual([
      ["list", actor, { status: "active", limit: 7 }],
    ]);
  });

  test("reads an empty ?limit= as absent", async () => {
    // A parameter that says nothing is not a parameter, which is how an empty `?cursor=` reads too.
    // Omitting the key is what makes the store's own default page size fire.
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?limit=");

    expect(store.calls).toEqual([["list", actor, { status: "active" }]]);
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
    expect(store.calls).toEqual([]);
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
