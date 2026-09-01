import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AgentNotFoundError,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createApp } from "../src/app";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  type AgentChannel,
  type ChannelActivity,
  ChannelNotFoundError,
  ChannelPackageOwnedError,
  type ChannelStore,
  createChannelRoutes,
  createChannelStore,
  MAX_ACTIVITY_CLOCK_SKEW_MS,
  parseActivityInput,
  parseChannelInput,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

const actor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

function channel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: "channel-1",
    name: "Assistant channel",
    agentIds: ["agent-1", "agent-2"],
    threadId: "thread-1",
    active: true,
    archived: false,
    ...overrides,
  };
}

type StoreCall = [method: keyof ChannelStore, ...arguments_: unknown[]];

function fakeStore(
  overrides: Partial<ChannelStore> = {},
): ChannelStore & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const base: ChannelStore = {
    async create(receivedActor, agentIds) {
      calls.push(["create", receivedActor, agentIds]);
      return channel({ agentIds });
    },
    async get(receivedActor, id) {
      calls.push(["get", receivedActor, id]);
      return channel({ id });
    },
    async list(receivedActor, query) {
      calls.push(["list", receivedActor, query]);
      return { channels: [], nextCursor: null };
    },
    async setPinned(receivedActor, id, pinned) {
      calls.push(["setPinned", receivedActor, id, pinned]);
    },
    async markRead(receivedActor, id) {
      calls.push(["markRead", receivedActor, id]);
    },
    async setArchived(receivedActor, id, archived) {
      calls.push(["setArchived", receivedActor, id, archived]);
      return true;
    },
    async softDelete(receivedActor, id) {
      calls.push(["softDelete", receivedActor, id]);
    },
    async recordActivity(receivedActor, id, activity) {
      calls.push(["recordActivity", receivedActor, id, activity]);
      // The outcome the interface promises, which the route destructures. Returning nothing type-
      // checked as `Promise<void>` and answered a bare 500 from a `TypeError` the moment a request
      // actually reached this method; the only activity test in the file was turned away at 413 by
      // the body limit first, so nothing noticed. Both sibling fakes return the same shape.
      return { restored: false };
    },
  };

  return Object.assign(base, overrides, { calls });
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function appFor(
  store: ChannelStore,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelRoutes(store, middleware));
  return app;
}

async function json(response: Response) {
  return response.json();
}

describe("channel input parser", () => {
  test.each([[null], [[]], ["input"], [42], [true]])(
    "rejects a non-object root: %p",
    (input) => {
      expect(parseChannelInput(input)).toEqual({
        ok: false,
        error: "Channel input must be a JSON object.",
      });
    },
  );

  test.each([
    [undefined, "Agent IDs must be a non-empty array."],
    [null, "Agent IDs must be a non-empty array."],
    ["agent-1", "Agent IDs must be a non-empty array."],
    [{}, "Agent IDs must be a non-empty array."],
    [[], "Agent IDs must be a non-empty array."],
  ])("rejects invalid agentIds: %p", (agentIds, error) => {
    expect(parseChannelInput({ agentIds })).toEqual({ ok: false, error });
  });

  test.each([
    [[""], "Agent IDs must be non-empty strings."],
    [["  "], "Agent IDs must be non-empty strings."],
    [[1], "Agent IDs must be non-empty strings."],
    [[false], "Agent IDs must be non-empty strings."],
    [[null], "Agent IDs must be non-empty strings."],
    [[{}], "Agent IDs must be non-empty strings."],
    [["agent-1", " agent-1 "], "Agent IDs must be unique."],
  ])("rejects invalid agent ID members: %p", (agentIds, error) => {
    expect(parseChannelInput({ agentIds })).toEqual({ ok: false, error });
  });

  test("trims, sorts, and whitelists channel input", () => {
    expect(
      parseChannelInput({
        agentIds: [" agent-2 ", "agent-1"],
        id: "forged-channel",
        name: "forged name",
        threadId: "forged-thread",
        active: false,
      }),
    ).toEqual({ ok: true, value: { agentIds: ["agent-1", "agent-2"] } });
  });
});

/**
 * One cap, in the one parser both activity routes use: `bot-chats/routes.ts` imports this function
 * rather than repeating it, so a bound here bounds that route too.
 */
describe("activity input parser", () => {
  const at = "2026-01-01T00:00:00.000Z";

  test("takes a message at the cap", () => {
    expect(
      parseActivityInput({ text: "a".repeat(16_000), agentId: null, at }).ok,
    ).toBe(true);
  });

  test("refuses one over the cap rather than shortening it", () => {
    // Refused, not truncated. A report the store shortened is a lie about what was said, and the
    // preview it feeds is derived from the text rather than being the text.
    expect(
      parseActivityInput({ text: "a".repeat(16_001), agentId: null, at }),
    ).toEqual({ ok: false, error: "Text is too long." });
  });

  test("measures the cap in UTF-16 units, not code points", () => {
    // A size bound counted in code points means walking the whole string to find out how long it is,
    // which is the work the bound exists to avoid. An astral character is two units, so 8,001 of
    // them is over a cap of 16,000 units and well under it counted as characters.
    expect(
      parseActivityInput({ text: "😀".repeat(8_001), agentId: null, at }),
    ).toEqual({ ok: false, error: "Text is too long." });
  });

  test("takes a report a person made, with no agent on it", () => {
    // Stamped from this clock rather than with the fixed `at` every shape test above uses, because
    // this is the one assertion here about the VALUE that comes back: the clamp holds a report to
    // the allowance either side of this server, and a stamp from January is outside it.
    const reported = new Date().toISOString();

    expect(
      parseActivityInput({
        text: "One more thing",
        agentId: null,
        at: reported,
      }),
    ).toEqual({
      ok: true,
      value: {
        text: "One more thing",
        agentId: null,
        at: new Date(reported),
      },
    });
  });

  test("trims a real agent ID", () => {
    expect(
      parseActivityInput({ text: "One more thing", agentId: " agent-1 ", at }),
    ).toMatchObject({ ok: true, value: { agentId: "agent-1" } });
  });

  test.each([[" "], ["   "], ["\t\n"]])(
    "refuses a whitespace-only agent ID: %p",
    (agentId) => {
      /*
       * Trimmed to `""` this was accepted, and `""` is neither `null` — which is how "a person said
       * this" is spelled — nor an id any store can resolve. So `recordActivity` looked the empty
       * string up in `channel_agents`, threw `AgentNotFoundError("")`, and a malformed request came
       * back as 404 "Agent not found." Every sibling parser refuses it outright.
       */
      expect(
        parseActivityInput({ text: "One more thing", agentId, at }),
      ).toEqual({
        ok: false,
        error: "Agent ID must be a non-empty string or null.",
      });
    },
  );

  test.each([[42], [{}], [[]], [false], [undefined]])(
    "refuses an agent ID that is neither a string nor null: %p",
    (agentId) => {
      expect(
        parseActivityInput({ text: "One more thing", agentId, at }),
      ).toEqual({ ok: false, error: "Agent ID must be a string or null." });
    },
  );

  test("refuses a report with no timestamp at all", () => {
    expect(
      parseActivityInput({ text: "One more thing", agentId: null }),
    ).toEqual({ ok: false, error: "Timestamp is required." });
  });

  test("refuses a timestamp with no zone, whose instant depends on where the server runs", () => {
    // `new Date("2026-08-31T12:00")` is read in the server process's own local zone, so two clients
    // sending the identical string landed at two different instants depending on where the process
    // happened to run — and that instant is what the store's moves-forwards-only guard compares.
    expect(
      parseActivityInput({
        text: "One more thing",
        agentId: null,
        at: "2026-08-31T12:00",
      }),
    ).toEqual({
      ok: false,
      error: "Timestamp must be an ISO-8601 date and time with a time zone.",
    });
  });

  test.each([
    // Accepted by a bare `new Date` while the refusal said "ISO-8601": the parser was looser than its
    // own error message.
    ["12/25/2026"],
    ["Sat, 31 Aug 2026 12:00:00 GMT"],
    // A date with no time of day, and an offset with no colon: neither is a reported message time.
    ["2026-08-31"],
    ["2026-08-31T12:00:00+0200"],
    // The right shape and an impossible month.
    ["2026-13-01T00:00:00Z"],
    [""],
  ])(
    "refuses a timestamp that is not a zoned ISO-8601 date and time: %p",
    (value) => {
      expect(
        parseActivityInput({
          text: "One more thing",
          agentId: null,
          at: value,
        }),
      ).toEqual({
        ok: false,
        error: "Timestamp must be an ISO-8601 date and time with a time zone.",
      });
    },
  );

  test("refuses a year `timestamptz` has no room for", () => {
    /*
     * `0000-01-01T00:00:00Z` is one of three things that get this far: it matches the shape above,
     * `Date` holds it and round-trips it perfectly, and `timestamptz` has no year between 1 BC and AD
     * 1. The extended `±YYYYYY` forms that break the other way reach it too now, and the test below
     * covers them — the shared shape in `time.ts` asks nothing about years, because this check is the
     * one that can name the range.
     *
     * Neither existing bound caught it when this was written. The clamp held the ceiling only and
     * this is in the past, and the store's moves-forwards-only guard does not save it either —
     * `activity.at` is bound in that guard's `WHERE` as well as in the `SET`, so Postgres parses it
     * to decide whether to write rather than because it is writing. So `date/time field value out of
     * range` came out of the middle of the store's transaction, where the parameter no longer has a
     * name, as a 500 for a request that is simply malformed.
     *
     * THE FLOOR NOW COVERS THE CRASH, and this stays a refusal anyway. With both ends clamped, a stamp
     * that reaches the column is within the allowance of this server's clock whatever year it named on
     * the way in. But a clamp is what a wrong clock deserves, and year 0 is not a clock running slow — it is a
     * stamp that names no time at all, and 400 is the only way the client is ever told so. The check
     * runs on what was reported, before the clamp, which is what keeps that answer reachable.
     */
    expect(
      parseActivityInput({
        text: "One more thing",
        agentId: null,
        at: "0000-01-01T00:00:00Z",
      }),
    ).toEqual({
      ok: false,
      error: "Timestamp must name a year between 0001 and 9999.",
    });
  });

  test.each([
    [
      "+010000-01-02T00:00:00Z",
      "a five-digit year, which `toISOString` renders back as a zone",
    ],
    ["-271821-04-20T00:00:00Z", "the earliest instant a `Date` holds"],
  ])("refuses a reported %p: %s", (value: string) => {
    /*
     * The extended `±YYYYYY` forms, refused for the year they name rather than for their shape.
     *
     * The shape refused them before, as a side effect of admitting exactly four digits of year, and the
     * client was told its timestamp was not an ISO-8601 date and time with a time zone — which is false
     * of both of these. Each names a zone, each is an instant `Date` holds and round-trips, and what is
     * actually wrong with them is that `timestamptz` has no room for the year: `+010000-01-02T00:00:00Z`
     * comes back out of `toISOString` as an extended year Postgres reads as a zone displacement.
     *
     * The shape now lives in `time.ts` and asks nothing about years, deliberately, because this refusal
     * can name the range and a shape check cannot. `audit.ts` makes the same distinction on its query
     * bounds, and that is the point of the two readers sharing one shape: the shape says what form the
     * value takes, and each reader says what it can hold.
     */
    expect(
      parseActivityInput({ text: "One more thing", agentId: null, at: value }),
    ).toEqual({
      ok: false,
      error: "Timestamp must name a year between 0001 and 9999.",
    });
  });

  test.each([
    ["a minute behind this server", -60_000],
    ["half the allowance behind it", -MAX_ACTIVITY_CLOCK_SKEW_MS / 2],
    ["half the allowance ahead of it", MAX_ACTIVITY_CLOCK_SKEW_MS / 2],
  ])("keeps a timestamp %s exactly as reported", (_label, offset) => {
    const reported = new Date(Date.now() + offset).toISOString();

    expect(
      parseActivityInput({
        text: "One more thing",
        agentId: null,
        at: reported,
      }),
    ).toMatchObject({ ok: true, value: { at: new Date(reported) } });
  });

  test("clamps a timestamp further ahead than the allowance", () => {
    /*
     * The one direction that could corrupt the row rather than lose a report.
     *
     * Both stores write this value to `last_message_at` under a guard that only moves forwards, so an
     * unbounded `at` in the year 3000 pinned the row to the top of every member's roster for good,
     * turned every later genuine report into a no-op, and — because clearing `archived_at` rides that
     * same guarded write — left an archived conversation that speaking in it could no longer bring
     * back. Nothing in the API undoes any of it.
     */
    const before = Date.now();
    const parsed = parseActivityInput({
      text: "One more thing",
      agentId: null,
      at: "3000-01-01T00:00:00.000Z",
    });
    const after = Date.now();

    if (!parsed.ok) throw new Error(parsed.error);
    // Clamped rather than refused: a report is a message somebody sent, and turning away every report
    // a fast-clocked client makes loses all of them instead of bounding one.
    expect(parsed.value.at.getTime()).toBeGreaterThanOrEqual(
      before + MAX_ACTIVITY_CLOCK_SKEW_MS,
    );
    expect(parsed.value.at.getTime()).toBeLessThanOrEqual(
      after + MAX_ACTIVITY_CLOCK_SKEW_MS,
    );
  });

  test("clamps a timestamp further behind than the allowance", () => {
    /*
     * The end that was left open, on the argument that "an old stamp cannot pin a row or hide a later
     * message". True, and not the whole harm.
     *
     * Recency is `coalesce(last_message_at, created_at)`, so the FIRST report on a conversation
     * replaces `created_at` as its sort key. This stamp has the right shape, names a year the column
     * holds, is in the past so was never clamped, and matches the store's `last_message_at IS NULL`
     * guard — so it was written, and the conversation then sorted BELOW one nobody had ever said
     * anything in, with nothing in the API to reset it. Any signed-in caller could do it to their own
     * conversations.
     *
     * The same missing floor is why a browser running behind whoever last wrote `last_message_at`
     * had every report of its own ignored as stale, and — before the archive clear was given a guard
     * of its own — could not speak an archived conversation back into view.
     */
    const before = Date.now();
    const parsed = parseActivityInput({
      text: "One more thing",
      agentId: null,
      at: "1970-01-02T00:00:00.000Z",
    });
    const after = Date.now();

    if (!parsed.ok) throw new Error(parsed.error);
    // Clamped rather than refused, for the same reason the ceiling is: a slow-clocked client would
    // otherwise lose every report it ever makes rather than have one held to the allowance.
    expect(parsed.value.at.getTime()).toBeGreaterThanOrEqual(
      before - MAX_ACTIVITY_CLOCK_SKEW_MS,
    );
    expect(parsed.value.at.getTime()).toBeLessThanOrEqual(
      after - MAX_ACTIVITY_CLOCK_SKEW_MS,
    );
  });
});

describe("channel routes", () => {
  test("attaches authentication middleware to every route before calling the store", async () => {
    const store = fakeStore();
    const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      Promise.resolve(context.json({ error: "denied" }, 401));
    const app = appFor(store, denied);

    const created = await app.request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: ["agent-1"] }),
    });
    const fetched = await app.request("http://openbot.test/channel-1");

    expect(created.status).toBe(401);
    expect(fetched.status).toBe(401);
    expect(store.calls).toEqual([]);
  });

  test("uses the authenticated context actor and canonical agent IDs", async () => {
    const store = fakeStore();
    const app = appFor(store);

    const created = await app.request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [" agent-2 ", "agent-1"] }),
    });
    const fetched = await app.request("http://openbot.test/channel-1");

    expect(created.status).toBe(201);
    expect(fetched.status).toBe(200);
    expect(store.calls).toEqual([
      ["create", actor, ["agent-1", "agent-2"]],
      ["get", actor, "channel-1"],
    ]);
  });

  test("returns only the channel DTO for create and get", async () => {
    const store = fakeStore({
      async create(_actor, agentIds) {
        return Object.assign(channel({ agentIds }), { ownerUserId: "user-1" });
      },
      async get() {
        return Object.assign(channel(), { internalState: "hidden" });
      },
    });
    const app = appFor(store);

    const created = await app.request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: ["agent-1"] }),
    });
    const fetched = await app.request("http://openbot.test/channel-1");

    expect(created.status).toBe(201);
    expect(await json(created)).toEqual({
      channel: {
        id: "channel-1",
        name: "Assistant channel",
        agentIds: ["agent-1"],
        threadId: "thread-1",
        active: true,
        archived: false,
      },
    });
    expect(fetched.status).toBe(200);
    expect(await json(fetched)).toEqual({ channel: channel() });
  });

  test.each([
    ["{", "Channel input must be a JSON object."],
    [JSON.stringify([]), "Channel input must be a JSON object."],
    [JSON.stringify({ agentIds: [] }), "Agent IDs must be a non-empty array."],
  ])(
    "returns safe validation errors for malformed POST bodies",
    async (body, error) => {
      const store = fakeStore();
      const response = await appFor(store).request("http://openbot.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({ error });
      expect(store.calls).toEqual([]);
    },
  );

  test("returns 404 when get returns null", async () => {
    const store = fakeStore({ get: async () => null });

    const response = await appFor(store).request("http://openbot.test/missing");

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "Channel not found." });
  });

  test.each([
    ["create", new AgentNotFoundError("agent-1"), 404, "Agent not found."],
    ["get", new ChannelNotFoundError("channel-1"), 404, "Channel not found."],
  ] as const)(
    "maps known store errors from %s",
    async (method, error, status, message) => {
      const store = fakeStore({
        ...(method === "create"
          ? {
              create: async () => {
                throw error;
              },
            }
          : {
              get: async () => {
                throw error;
              },
            }),
      });
      const app = appFor(store);
      const response =
        method === "create"
          ? await app.request("http://openbot.test/", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agentIds: ["agent-1"] }),
            })
          : await app.request("http://openbot.test/channel-1");

      expect(response.status).toBe(status);
      expect(await json(response)).toEqual({ error: message });
    },
  );

  test("answers an unexpected error as JSON itself, without reaching an outer handler", async () => {
    /*
     * THIS TEST USED TO ASSERT THE OPPOSITE, and the seam it pinned was closed deliberately.
     *
     * It registered an `onError` answering 418 and proved that an error `mapStoreError` could not
     * classify reached it. That seam was theoretical: nothing in this server registers an `onError`
     * (`app.ts` does not), so in production the rethrow reached Hono's default handler and became a
     * `text/plain "Internal Server Error"` — and `client()` in the browser reads `body.error` and
     * falls back to its own sentence when the body is not JSON. `roster/routes.ts` was fixed for
     * exactly that, so while these routes still rethrew, one unreachable database made `GET
     * /api/roster` readable and `PUT /api/channels/:id/archive` unreadable: a roster whose rows behave
     * differently depending on which kind they are, which `bot-chats/routes.ts`'s header calls the
     * failure its shape exists to prevent.
     *
     * Not fixed with an app-level `onError`, which is why that was not the alternative: the audit
     * reader answers its 400s as `HTTPException`s that work only because Hono's DEFAULT handler calls
     * `err.getResponse()`, and registering one would have turned those into 500s.
     *
     * The `onError` below stays, inverted into a guard. It is what makes "this route answered for
     * itself" an assertion rather than an inference from a status code that a passing rethrow could
     * also produce.
     */
    const store = fakeStore({
      create: async () => {
        throw new Error("database disconnected");
      },
    });
    const app = appFor(store);
    // Reached only by a rethrow. 418 because no channel route can produce it — and because Hono types
    // the statuses it will serialise, so the 599 that was here first was a type error the suite cannot
    // see, not compiling its own tests.
    app.onError((error, context) =>
      context.json({ sentinel: error.message }, 418),
    );
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await app.request("http://openbot.test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentIds: ["agent-1"] }),
      });

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await json(response)).toEqual({
        error: "The server could not complete that request.",
      });
      // What was thrown may name a host or carry a connection string, so the browser gets none of it
      // and the log gets all of it. A 500 with no log line is an outage nobody can tell from a typo.
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain(
        "database disconnected",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test.each([
    // Every one of these was answered 200 with a page nobody asked for. `Number.parseInt` keeps what
    // it could read before the first character it could not — `1e3` was 1, `50abc` was 50 — and a
    // value it cannot read at all fell through to the default page instead. Either way the answer
    // looks exactly like an answer, and the caller cannot tell it was rewritten.
    ["1e3"],
    ["0x10"],
    ["50abc"],
    ["-5"],
    ["5.5"],
    ["+5"],
    [" 5"],
    ["lots"],
    // Nought rows is a request this endpoint cannot honour: the store clamps it up to one, which is
    // the same reinterpretation wearing a rounder number.
    ["0"],
  ])(
    "refuses a limit that is not a whole number of at least 1: %p",
    async (limit) => {
      const store = fakeStore();

      const response = await appFor(store).request(
        `http://openbot.test/?limit=${encodeURIComponent(limit)}`,
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        error: "Limit must be a whole number of at least 1.",
      });
      // Refused before the read, so a malformed page request cannot come back looking like an answer.
      expect(store.calls).toEqual([]);
    },
  );

  test("passes a limit it accepts, and treats an empty one as absent", async () => {
    const store = fakeStore();
    const app = appFor(store);

    await app.request("http://openbot.test/?limit=25");
    // A leading zero is a whole number written oddly, not a malformed one.
    await app.request("http://openbot.test/?limit=007");
    // A parameter that says nothing is not a parameter, which is how an empty `cursor` is read too.
    await app.request("http://openbot.test/?limit=");

    expect(store.calls).toEqual([
      ["list", actor, { status: "active", limit: 25 }],
      ["list", actor, { status: "active", limit: 7 }],
      ["list", actor, { status: "active" }],
    ]);
  });

  test("reads the archive status the caller asked for, and defaults to active", async () => {
    const store = fakeStore();
    const app = appFor(store);

    await app.request("http://openbot.test/?status=archived");
    await app.request("http://openbot.test/");
    await app.request("http://openbot.test/?status=nonsense");

    expect(store.calls).toEqual([
      ["list", actor, { status: "archived" }],
      ["list", actor, { status: "active" }],
      // Unrecognised reads as active, which is the answer `parseRosterStatus` already gives the
      // roster: a stale bookmark should show somebody their conversations rather than an error they
      // cannot act on.
      ["list", actor, { status: "active" }],
    ]);
  });

  test("says whether each listed channel is archived", async () => {
    const store = fakeStore({
      async list() {
        return {
          channels: [
            {
              ...channel({ id: "channel-9", archived: true }),
              lastMessage: "Filed away",
              lastMessageAt: new Date("2026-01-01T00:00:00.000Z"),
              lastMessageAgentId: "agent-1",
              createdAt: new Date("2025-12-01T00:00:00.000Z"),
              pinned: false,
              lastReadAt: null,
            },
          ],
          nextCursor: null,
        };
      },
    });

    const response = await appFor(store).request("http://openbot.test/");

    expect(response.status).toBe(200);
    // Without the field the endpoint hands an archived channel back as an ordinary active row and no
    // caller can tell the difference. The roster reports it, and this is the same fact about the
    // same row.
    expect(await json(response)).toMatchObject({
      channels: [{ id: "channel-9", archived: true }],
    });
  });

  test("reports activity through the authenticated actor and answers 204", async () => {
    const store = fakeStore();
    const app = appFor(store);
    // From this clock, because the assertion below is about the value the store was handed and the
    // parser holds a report to the allowance either side of this server. A fixed stamp here proved
    // whatever the calendar happened to say on the day it was read.
    const at = new Date().toISOString();

    const response = await app.request(
      "http://openbot.test/channel-1/activity",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "One more thing", agentId: null, at }),
      },
    );

    /*
     * The half the body-limit test below cannot reach.
     *
     * That request is turned away at 413 before the store is called at all, which is why it was the
     * only activity test here for so long — and why the fake above could return `undefined` where the
     * interface promises an outcome, leaving the route to destructure `restored` off it and answer a
     * bare 500 for every well-formed report. A route test that never reaches the store cannot notice
     * that the store it was handed is not one.
     */
    expect(response.status).toBe(204);
    expect(store.calls).toEqual([
      [
        "recordActivity",
        actor,
        "channel-1",
        { text: "One more thing", agentId: null, at: new Date(at) },
      ],
    ]);
  });

  test("holds a report from a slow clock to the allowance before the store sees it", async () => {
    /*
     * The clamp is route-reachable, in the direction that had no bound at all.
     *
     * A stamp in 1970 passes the shape check and names a year the column holds, so before the floor
     * existed this exact request reached the store verbatim — and the store writes it to
     * `last_message_at`, which is `coalesce(last_message_at, created_at)`, the roster's sort key. Any
     * signed-in caller could sink their own conversation below one nobody had ever said anything in.
     * The parser test above proves the clamp; this proves nothing on the way in undoes it.
     */
    const store = fakeStore();
    const before = Date.now();

    const response = await appFor(store).request(
      "http://openbot.test/channel-1/activity",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "One more thing",
          agentId: null,
          at: "1970-01-02T00:00:00.000Z",
        }),
      },
    );

    expect(response.status).toBe(204);
    const [call] = store.calls;
    const reported = call?.[3] as ChannelActivity | undefined;
    expect(reported?.at.getTime()).toBeGreaterThanOrEqual(
      before - MAX_ACTIVITY_CLOCK_SKEW_MS,
    );
  });

  test("refuses an activity body too large to parse", async () => {
    const store = fakeStore();
    const app = appFor(store);

    const response = await app.request(
      "http://openbot.test/channel-1/activity",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "a".repeat(400_000),
          agentId: null,
          at: "2026-01-01T00:00:00.000Z",
        }),
      },
    );

    /*
     * 413 from the middleware, not 400 from the parser.
     *
     * The parser's own cap cannot prevent this: it runs after `context.req.json()` has already
     * materialised and parsed the whole body. The two caps are not interchangeable, and the body
     * limit is the wider of the two on purpose — it is sized so that no message the parser would
     * accept can be refused here first.
     */
    expect(response.status).toBe(413);
    expect(await json(response)).toEqual({
      error: "Activity body is too large.",
    });
    expect(store.calls).toEqual([]);
  });

  test("pins through the authenticated actor and reports the new state", async () => {
    const store = fakeStore();
    const app = appFor(store);

    const response = await app.request("http://openbot.test/channel-1/pin", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ pinned: true });
    expect(store.calls).toEqual([["setPinned", actor, "channel-1", true]]);
  });

  test.each([
    ["{", "Pin input must be a JSON object."],
    [JSON.stringify([]), "Pin input must be a JSON object."],
    [JSON.stringify({}), "Pinned must be true or false."],
    [JSON.stringify({ pinned: "yes" }), "Pinned must be true or false."],
  ])("rejects malformed pin bodies: %p", async (body, error) => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/channel-1/pin",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      },
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error });
    expect(store.calls).toEqual([]);
  });

  test("keeps authentication in front of pinning", async () => {
    const store = fakeStore();
    const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      Promise.resolve(context.json({ error: "denied" }, 401));
    const app = appFor(store, denied);

    const response = await app.request("http://openbot.test/channel-1/pin", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });

  test("marks read through the authenticated actor and answers 204", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/channel-1/read",
      { method: "PUT" },
    );

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["markRead", actor, "channel-1"]]);
  });

  test("maps an unknown channel to 404 for marking read", async () => {
    const store = fakeStore({
      markRead: async () => {
        throw new ChannelNotFoundError("channel-1");
      },
    });
    const response = await appFor(store).request(
      "http://openbot.test/channel-1/read",
      { method: "PUT" },
    );

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "Channel not found." });
  });

  test("keeps authentication in front of marking read", async () => {
    const store = fakeStore();
    const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      Promise.resolve(context.json({ error: "denied" }, 401));
    const response = await appFor(store, denied).request(
      "http://openbot.test/channel-1/read",
      { method: "PUT" },
    );

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });

  test("deletes through the authenticated actor and answers 204", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/channel-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["softDelete", actor, "channel-1"]]);
  });

  test("maps a package-owned refusal to 409", async () => {
    const store = fakeStore({
      softDelete: async () => {
        throw new ChannelPackageOwnedError("channel-1");
      },
    });
    const response = await appFor(store).request(
      "http://openbot.test/channel-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      error:
        "This channel is defined by the deployment package, so it cannot be deleted here.",
    });
  });

  test("keeps authentication in front of deleting", async () => {
    const store = fakeStore();
    const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      Promise.resolve(context.json({ error: "denied" }, 401));
    const app = appFor(store, denied);

    const response = await app.request("http://openbot.test/channel-1", {
      method: "DELETE",
    });

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });
});

/**
 * The channel row survives a soft delete, but nothing on it says who hid it or when.
 *
 * "Where did that conversation go" is the question this answers, and the row is the only thing that
 * can: `deleted_at` is a timestamp with no actor. Untested, it is also the easiest thing to drop in
 * a later refactor without anything going red — which is exactly how it was lost once already.
 */
describe("channel delete audit", () => {
  /** Rows written by the route under test, in order. */
  let audited: AuditEventInput[] = [];

  beforeEach(() => {
    audited = [];
  });

  function appWithAudit(
    store: ChannelStore,
    auditStore: AuditStore = {
      insert: async (event) => void audited.push(event),
    },
  ) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createChannelRoutes(store, requireUser, undefined, auditStore),
    );
    return app;
  }

  test("writes an attributed row naming the mechanism", async () => {
    const response = await appWithAudit(fakeStore()).request(
      "http://openbot.test/channel-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(audited).toEqual([
      {
        eventType: "channel.deleted",
        targetType: "channel",
        targetId: "channel-1",
        actorUserId: actor.id,
        payload: { mechanism: "soft" },
      },
    ]);
  });

  /* Same discipline as bot-lifecycle-audit.test.ts: the trail records acts, not attempts. */
  test("a refused change writes nothing", async () => {
    const store = fakeStore({
      softDelete: async () => {
        throw new ChannelPackageOwnedError("channel-1");
      },
    });

    const response = await appWithAudit(store).request(
      "http://openbot.test/channel-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(409);
    expect(audited).toEqual([]);
  });

  test("a delete of somebody else's channel writes nothing", async () => {
    const store = fakeStore({
      softDelete: async () => {
        throw new ChannelNotFoundError("channel-1");
      },
    });

    const response = await appWithAudit(store).request(
      "http://openbot.test/channel-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
    expect(audited).toEqual([]);
  });

  /*
   * Single-user is the mode `.env.example` ships switched on, so this is the row a fork sees by
   * default. The other audited surfaces drop the id here, believing `audit_events.actor_user_id`
   * has a foreign key into `users`; it has none, and `initializeDevActorUser` writes that row at
   * start-up regardless. An unattributed row would answer "was this conversation deleted" and not
   * "by whom", which is the half worth keeping.
   */
  test("attributes the local development actor rather than dropping it", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createChannelRoutes(
        fakeStore(),
        async (context, next) => {
          context.set("actor", DEV_ACTOR);
          await next();
        },
        undefined,
        { insert: async (event) => void audited.push(event) },
      ),
    );

    await app.request("http://openbot.test/channel-1", { method: "DELETE" });

    expect(audited[0]?.actorUserId).toBe(DEV_ACTOR.id);
  });

  /*
   * The channel is already hidden and the caller has already been told so by the time this runs. A
   * trail that is briefly unavailable is not a reason to report a failure that did not happen.
   */
  test("still answers when the audit write throws, and says so", async () => {
    const lines: Record<string, unknown>[] = [];
    const wasConsoleError = console.error;
    console.error = (line: unknown) => {
      try {
        lines.push(JSON.parse(String(line)) as Record<string, unknown>);
      } catch {
        // Something else in the process logging prose rather than a structured line. Not ours.
      }
    };
    let response: Response;
    try {
      response = await appWithAudit(fakeStore(), {
        insert: async () => {
          throw new Error("audit table is unreachable");
        },
      }).request("http://openbot.test/channel-1", { method: "DELETE" });
    } finally {
      console.error = wasConsoleError;
    }

    expect(response.status).toBe(204);
    // Swallowed, and said out loud. Collected rather than left to print into the suite's output,
    // where nobody was checking its shape and the line was noise either way.
    expect(
      lines.filter((line) => line.type === "channel-audit-write-failed"),
    ).toEqual([
      {
        type: "channel-audit-write-failed",
        eventType: "channel.deleted",
        channelId: "channel-1",
        error: "Error: audit table is unreachable",
      },
    ]);
  });

  test("deletes without a trail when the deployment keeps none", async () => {
    const store = fakeStore();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createChannelRoutes(store, requireUser));

    const response = await app.request("http://openbot.test/channel-1", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["softDelete", actor, "channel-1"]]);
  });
});

describe("channel route composition", () => {
  test("mounts the store behind createApp authentication with the derived actor", async () => {
    const store = fakeStore();
    let session: {
      user: { id: string; email: string; name: string; image: string };
    } | null = null;
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: { getSession: async () => session },
      },
      { rolesForUser: async () => ["user"] },
      // Positions 4-10, ending at agentProfileStore. `store` is position 11, channelStore. One
      // shorter than either side of the merge that produced this: see agent-routes.test.ts for why
      // a wrong count here fails silently rather than as a type error.
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    const unauthenticated = await app.request(
      "http://openbot.test/api/channels/channel-1",
    );
    expect(unauthenticated.status).toBe(401);
    expect(store.calls).toEqual([]);

    session = {
      user: {
        id: actor.id,
        email: actor.email,
        name: "OpenBot Member",
        image: "https://example.test/member.png",
      },
    };
    const authenticated = await app.request(
      "http://openbot.test/api/channels/channel-1",
    );

    expect(authenticated.status).toBe(200);
    expect(store.calls).toEqual([
      [
        "get",
        {
          ...actor,
          name: "OpenBot Member",
          image: "https://example.test/member.png",
        },
        "channel-1",
      ],
    ]);
  });

  test("leaves channel routes unmounted when createApp has no store", async () => {
    const app = createApp(loadConfig(testEnvironment()));

    const response = await app.request(
      "http://openbot.test/api/channels/channel-1",
    );

    expect(response.status).toBe(404);
  });
});

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const persistentStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const testPrefix = `channel-store-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdPackageIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const packageId of createdPackageIds.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, packageId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

function persistentId(kind: string) {
  return `${testPrefix}-${kind}-${randomUUID()}`;
}

/**
 * A user, described the way the routes describe one.
 *
 * `AuthenticatedActor` rather than `AgentActor`, and it carries the email the row actually has: these
 * fixtures are handed to the store, which asks for the narrower `AgentActor`, and also set as the
 * Hono context `actor`, which is the wider type. Annotated as the narrow one, the fixture that has to
 * be set on a context does not compile — a type error the suite cannot see, because it does not
 * compile its own tests.
 */
async function createPersistentUser(): Promise<AuthenticatedActor> {
  const userId = persistentId("user");
  const email = `${userId}@example.test`;
  await database.insert(users).values({
    id: userId,
    email,
    name: "Channel Store Test User",
  });
  createdUserIds.push(userId);
  return { id: userId, email, role: "user" };
}

async function createPersistentAgent(options: {
  id?: string;
  name: string;
  owner: AgentActor;
  visibility?: "public" | "private";
}) {
  const agentId = options.id ?? persistentId("agent");
  await database.insert(agents).values({
    id: agentId,
    name: options.name,
    type: "remote_ag_ui",
    configuration: { endpoint: "https://agent.example.test/ag-ui" },
  });
  createdAgentIds.push(agentId);
  await database.insert(agentProfiles).values({
    agentId,
    ownerUserId: options.owner.id,
    title: `${options.name} title`,
    roleDescription: `${options.name} role description`,
    avatarSeed: agentId,
    visibility: options.visibility ?? "private",
  });
  return agentId;
}

async function persistedChannel(channelId: string) {
  const [channelRow] = await database
    .select()
    .from(channels)
    .where(eq(channels.id, channelId));
  const memberships = await database
    .select()
    .from(channelMemberships)
    .where(eq(channelMemberships.channelId, channelId));
  const linkedAgents = await database
    .select()
    .from(channelAgents)
    .where(eq(channelAgents.channelId, channelId));
  const mappings = await database
    .select()
    .from(intelligenceChannelMappings)
    .where(eq(intelligenceChannelMappings.channelId, channelId));
  return { channelRow, memberships, linkedAgents, mappings };
}

async function channelTableSnapshot() {
  return {
    channels: (await database.select({ id: channels.id }).from(channels))
      .map(({ id }) => id)
      .sort(),
    memberships: (
      await database
        .select({
          channelId: channelMemberships.channelId,
          userId: channelMemberships.userId,
        })
        .from(channelMemberships)
    )
      .map(({ channelId, userId }) => `${channelId}:${userId}`)
      .sort(),
    agents: (
      await database
        .select({
          agentId: channelAgents.agentId,
          channelId: channelAgents.channelId,
        })
        .from(channelAgents)
    )
      .map(({ agentId, channelId }) => `${channelId}:${agentId}`)
      .sort(),
    mappings: (
      await database
        .select({
          channelId: intelligenceChannelMappings.channelId,
          threadId: intelligenceChannelMappings.threadId,
          userId: intelligenceChannelMappings.userId,
        })
        .from(intelligenceChannelMappings)
    )
      .map(
        ({ channelId, threadId, userId }) =>
          `${channelId}:${threadId}:${userId}`,
      )
      .sort(),
  };
}

describe("channel store integration", () => {
  test("reads the creator's persisted channel exactly", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Historical agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    expect(await persistentStore.get(actor, created.id)).toEqual(created);
  });

  test("does not expose a member's channel to another user through public agents", async () => {
    const creator = await createPersistentUser();
    const otherUser = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Public historical agent",
      owner: creator,
      visibility: "public",
    });
    const created = await persistentStore.create(creator, [agentId]);
    createdChannelIds.push(created.id);
    const otherUserMiddleware: MiddlewareHandler<{
      Variables: AppVariables;
    }> = async (context, next) => {
      context.set("actor", otherUser);
      await next();
    };

    expect(await persistentStore.get(otherUser, created.id)).toBeNull();
    const response = await appFor(persistentStore, otherUserMiddleware).request(
      `http://openbot.test/${created.id}`,
    );
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: "Channel not found." });
  });

  test("reads linked agent IDs in lexicographic order", async () => {
    const actor = await createPersistentUser();
    const agentIdBase = persistentId("ordered-agent");
    const laterAgentId = await createPersistentAgent({
      id: `${agentIdBase}-zulu`,
      name: "Zulu",
      owner: actor,
    });
    const earlierAgentId = await createPersistentAgent({
      id: `${agentIdBase}-alpha`,
      name: "Alpha",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [
      laterAgentId,
      earlierAgentId,
    ]);
    createdChannelIds.push(created.id);

    expect((await persistentStore.get(actor, created.id))?.agentIds).toEqual(
      [earlierAgentId, laterAgentId].sort(),
    );
  });

  test("keeps a historical channel readable but inactive after a linked profile is deleted", async () => {
    const actor = await createPersistentUser();
    const activeAgentId = await createPersistentAgent({
      name: "Active historical agent",
      owner: actor,
    });
    const deletedAgentId = await createPersistentAgent({
      name: "Deleted historical agent",
      owner: actor,
    });
    const created = await persistentStore.create(
      actor,
      [activeAgentId, deletedAgentId].sort(),
    );
    createdChannelIds.push(created.id);
    await profileStore.softDelete(actor, deletedAgentId);

    expect(await persistentStore.get(actor, created.id)).toEqual({
      ...created,
      active: false,
    });
  });

  test("returns null when the member's channel mapping is missing", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Unmapped historical agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, created.id));

    expect(await persistentStore.get(actor, created.id)).toBeNull();
  });

  test("creates independent persisted channels for repeated agent selections", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Solo Agent",
      owner: actor,
    });

    const first = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(first.id);
    const second = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(second.id);

    expect(first).toMatchObject({
      name: "Solo Agent",
      agentIds: [agentId],
      active: true,
    });
    expect(second).toMatchObject({
      name: "Solo Agent",
      agentIds: [agentId],
      active: true,
    });
    expect(first.id).toMatch(/^channel_[0-9a-f-]{36}$/);
    expect(second.id).toMatch(/^channel_[0-9a-f-]{36}$/);
    expect(first.id).not.toBe(second.id);
    expect(first.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.threadId).not.toBe(second.threadId);

    for (const created of [first, second]) {
      const persisted = await persistedChannel(created.id);
      expect(persisted.channelRow).toMatchObject({
        id: created.id,
        name: "Solo Agent",
        description: "Private agent channel.",
        suggestedPrompts: [],
        allowedGroups: [],
        packageId: null,
        override: null,
      });
      expect(persisted.memberships).toHaveLength(1);
      expect(persisted.memberships[0]).toMatchObject({
        channelId: created.id,
        userId: actor.id,
      });
      expect(persisted.linkedAgents).toHaveLength(1);
      expect(persisted.linkedAgents[0]).toMatchObject({
        channelId: created.id,
        agentId,
      });
      expect(persisted.mappings).toHaveLength(1);
      expect(persisted.mappings[0]).toMatchObject({
        userId: actor.id,
        channelId: created.id,
        threadId: created.threadId,
      });
    }
  });

  test("persists every canonical agent and derives its name in canonical order", async () => {
    const actor = await createPersistentUser();
    const firstId = await createPersistentAgent({
      id: persistentId("agent-a"),
      name: "Zulu",
      owner: actor,
    });
    const secondId = await createPersistentAgent({
      id: persistentId("agent-b"),
      name: "Alpha",
      owner: actor,
    });
    const canonicalAgentIds = [firstId, secondId].sort();

    const created = await persistentStore.create(actor, canonicalAgentIds);
    createdChannelIds.push(created.id);

    expect(created).toEqual({
      id: created.id,
      name: "Zulu, Alpha",
      agentIds: canonicalAgentIds,
      threadId: created.threadId,
      active: true,
      // Nothing is born archived.
      archived: false,
    });
    const persisted = await persistedChannel(created.id);
    expect(persisted.channelRow?.name).toBe("Zulu, Alpha");
    expect(persisted.linkedAgents.map(({ agentId }) => agentId).sort()).toEqual(
      canonicalAgentIds,
    );
  });

  test("truncates derived names to 120 Unicode code points with an ellipsis", async () => {
    const actor = await createPersistentUser();
    const longName = "😀".repeat(121);
    const agentId = await createPersistentAgent({
      name: longName,
      owner: actor,
    });

    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    expect(Array.from(created.name)).toHaveLength(120);
    expect(created.name).toBe(`${"😀".repeat(119)}…`);
    expect((await persistedChannel(created.id)).channelRow?.name).toBe(
      created.name,
    );
  });

  test.each(["inaccessible private", "soft-deleted"] as const)(
    "rejects an %s agent and leaves every channel table unchanged",
    async (scenario) => {
      const actor = await createPersistentUser();
      const owner =
        scenario === "inaccessible private"
          ? await createPersistentUser()
          : actor;
      const accessibleAgentId = await createPersistentAgent({
        name: "Accessible agent",
        owner: actor,
      });
      const agentId = await createPersistentAgent({
        name: `${scenario} agent`,
        owner,
      });
      if (scenario === "soft-deleted") {
        await profileStore.softDelete(actor, agentId);
      }
      const before = await channelTableSnapshot();

      await expect(
        persistentStore.create(actor, [accessibleAgentId, agentId].sort()),
      ).rejects.toBeInstanceOf(AgentNotFoundError);

      expect(await channelTableSnapshot()).toEqual(before);
    },
  );

  test("keeps the preview a row has when the next message renders as nothing", async () => {
    /*
     * `previewOf` answers null for a message of nothing but invisible characters, and that null was
     * written straight onto the row — while the bot-chat twin's title write two lines away refuses
     * the same write, with an argument for why. So any caller could blank their own roster preview:
     * the parser rejects on `text.trim()`, and `"\u200b".trim()` is one character long, so a message
     * of zero-width spaces is accepted as text and rendered as nothing.
     *
     * `last_message_agent_id` is held back with it, because the two are halves of one fact — what the
     * row shows and who said it — and moving the author alone leaves the row rendering a person's
     * words under a Bot's name. `last_message_at` does move: the message is real, and recency is what
     * the sort is for.
     */
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Invisible-message agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    const said = new Date();
    await persistentStore.recordActivity(actor, created.id, {
      text: "What is our refund policy?",
      agentId: null,
      at: said,
    });
    const invisible = new Date(said.getTime() + 1000);
    await persistentStore.recordActivity(actor, created.id, {
      // Written as escapes, because a message whose whole content is invisible is not something a
      // reader of this file could otherwise see is here.
      text: "\u200b \u200b",
      agentId,
      at: invisible,
    });

    const [row] = await database
      .select({
        lastMessage: channels.lastMessage,
        lastMessageAt: channels.lastMessageAt,
        lastMessageAgentId: channels.lastMessageAgentId,
      })
      .from(channels)
      .where(eq(channels.id, created.id));
    expect(row?.lastMessage).toBe("What is our refund policy?");
    expect(row?.lastMessageAgentId).toBeNull();
    expect(row?.lastMessageAt).toEqual(invisible);
  });
});

describe("channel pinning", () => {
  test("stamps and clears pinned_at on the caller's own membership", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Pinnable agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await persistentStore.setPinned(actor, created.id, true);
    let [row] = await database
      .select({ pinnedAt: channelMemberships.pinnedAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, created.id),
          eq(channelMemberships.userId, actor.id),
        ),
      );
    expect(row?.pinnedAt).not.toBeNull();

    await persistentStore.setPinned(actor, created.id, false);
    [row] = await database
      .select({ pinnedAt: channelMemberships.pinnedAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, created.id),
          eq(channelMemberships.userId, actor.id),
        ),
      );
    expect(row?.pinnedAt).toBeNull();
  });

  test("refuses to pin a channel the caller is not a member of", async () => {
    const member = await createPersistentUser();
    const outsider = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Members-only agent",
      owner: member,
    });
    const created = await persistentStore.create(member, [agentId]);
    createdChannelIds.push(created.id);

    await expect(
      persistentStore.setPinned(outsider, created.id, true),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  test("pins and unpins through the caller's own membership", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Pinnable agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await persistentStore.setPinned(actor, created.id, true);
    let page = await persistentStore.list(actor);
    expect(
      page.channels.find((channel) => channel.id === created.id)?.pinned,
    ).toBe(true);

    await persistentStore.setPinned(actor, created.id, false);
    page = await persistentStore.list(actor);
    expect(
      page.channels.find((channel) => channel.id === created.id)?.pinned,
    ).toBe(false);
  });

  test("one member's pin is invisible to another member", async () => {
    const pinner = await createPersistentUser();
    const other = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Shared pinnable agent",
      owner: pinner,
      visibility: "public",
    });
    const created = await persistentStore.create(pinner, [agentId]);
    createdChannelIds.push(created.id);
    // The store only creates the creator's membership; give the other user one directly,
    // plus the thread mapping the list join requires.
    await database.insert(channelMemberships).values({
      channelId: created.id,
      userId: other.id,
    });
    await database.insert(intelligenceChannelMappings).values({
      userId: other.id,
      channelId: created.id,
      // thread_id is globally unique; the pinner's own mapping row already claimed
      // created.threadId, so the other member's row needs one of its own.
      threadId: randomUUID(),
    });

    await persistentStore.setPinned(pinner, created.id, true);

    const otherPage = await persistentStore.list(other);
    expect(
      otherPage.channels.find((channel) => channel.id === created.id)?.pinned,
    ).toBe(false);
  });

  test("reports pinned false for a channel nobody pinned", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Unpinned agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    expect(
      (await persistentStore.list(actor)).channels.find(
        (channel) => channel.id === created.id,
      )?.pinned,
    ).toBe(false);
  });
});

describe("channel read markers", () => {
  // Two members of one channel, which is what a per-member marker has to be tested against.
  async function sharedChannel() {
    const reader = await createPersistentUser();
    const other = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Shared readable agent",
      owner: reader,
      visibility: "public",
    });
    const created = await persistentStore.create(reader, [agentId]);
    createdChannelIds.push(created.id);
    // The store only creates the creator's membership; give the other user one directly,
    // plus the thread mapping the list join requires.
    await database.insert(channelMemberships).values({
      channelId: created.id,
      userId: other.id,
    });
    await database.insert(intelligenceChannelMappings).values({
      userId: other.id,
      channelId: created.id,
      // thread_id is globally unique; the reader's own mapping row already claimed
      // created.threadId, so the other member's row needs one of its own.
      threadId: randomUUID(),
    });
    return { reader, other, channelId: created.id };
  }

  test("stamps last_read_at on the caller's own membership only", async () => {
    const { reader, other, channelId } = await sharedChannel();

    await persistentStore.markRead(reader, channelId);

    const rows = await database
      .select({
        userId: channelMemberships.userId,
        lastReadAt: channelMemberships.lastReadAt,
      })
      .from(channelMemberships)
      .where(eq(channelMemberships.channelId, channelId));
    expect(
      rows.find((row) => row.userId === reader.id)?.lastReadAt,
    ).not.toBeNull();
    expect(rows.find((row) => row.userId === other.id)?.lastReadAt).toBeNull();
  });

  test("the list carries the caller's lastReadAt and nobody else's", async () => {
    const { reader, other, channelId } = await sharedChannel();

    await persistentStore.markRead(reader, channelId);

    const forReader = await persistentStore.list(reader);
    const forOther = await persistentStore.list(other);
    expect(
      forReader.channels.find((channel) => channel.id === channelId)
        ?.lastReadAt,
    ).not.toBeNull();
    expect(
      forOther.channels.find((channel) => channel.id === channelId)?.lastReadAt,
    ).toBeNull();
  });

  test("refuses to mark read a channel the caller is not a member of", async () => {
    const { channelId } = await sharedChannel();
    const outsider = await createPersistentUser();

    await expect(
      persistentStore.markRead(outsider, channelId),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  test("stamps a read no earlier than the channel's own last-message clock", async () => {
    const { reader, channelId } = await sharedChannel();
    // last_message_at is written from the reporting browser's clock and is not bounded; simulate
    // one running ahead of the server so a plain "now" stamp would still read as unseen.
    const future = new Date(Date.now() + 60_000);
    await database
      .update(channels)
      .set({ lastMessageAt: future })
      .where(eq(channels.id, channelId));

    await persistentStore.markRead(reader, channelId);

    const [row] = await database
      .select({ lastReadAt: channelMemberships.lastReadAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, reader.id),
        ),
      );
    expect(row?.lastReadAt).not.toBeNull();
    expect(row?.lastReadAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
      future.getTime(),
    );
  });

  test("refuses to mark a soft-deleted channel read, mirroring setPinned", async () => {
    const { reader, channelId } = await sharedChannel();

    await persistentStore.softDelete(reader, channelId);

    await expect(
      persistentStore.markRead(reader, channelId),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);

    const [row] = await database
      .select({ lastReadAt: channelMemberships.lastReadAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, reader.id),
        ),
      );
    // The membership row outlives the channel, but its marker was never stamped.
    expect(row?.lastReadAt).toBeNull();
  });
});

describe("channel soft delete", () => {
  test("hides a deleted channel from list and get", async () => {
    const actor = await createPersistentUser();
    const other = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Deletable agent",
      owner: actor,
      visibility: "public",
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);
    // The store only creates the creator's membership; give the other user one directly,
    // plus the thread mapping the list join requires.
    await database.insert(channelMemberships).values({
      channelId: created.id,
      userId: other.id,
    });
    await database.insert(intelligenceChannelMappings).values({
      userId: other.id,
      channelId: created.id,
      // thread_id is globally unique; the actor's own mapping row already claimed
      // created.threadId, so the other member's row needs one of its own.
      threadId: randomUUID(),
    });

    await persistentStore.softDelete(actor, created.id);

    expect(await persistentStore.get(actor, created.id)).toBeNull();
    const page = await persistentStore.list(actor);
    expect(
      page.channels.find((channel) => channel.id === created.id),
    ).toBeUndefined();

    expect(await persistentStore.get(other, created.id)).toBeNull();
    const otherPage = await persistentStore.list(other);
    expect(
      otherPage.channels.find((channel) => channel.id === created.id),
    ).toBeUndefined();
  });

  test("stamps deleted_at on the channel", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Deletable agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await persistentStore.softDelete(actor, created.id);

    // Soft: the row is still there, stamped rather than gone.
    const [row] = await database
      .select({ deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, created.id));
    expect(row?.deletedAt).not.toBeNull();
  });

  /*
   * A repeat delete is not found, not a second deletion.
   *
   * This test asserted the opposite until the archive work went over it, and the old assertion was
   * the behaviour rather than the intent. The second call found the row — its read carried no
   * `deleted_at` filter — wrote nothing, because the update does carry one, and then went on to
   * announce `deleted: true` to every member and let the route write a second `channel.deleted`
   * audit row for a deletion that had already happened. Every sibling on this store answers
   * `ChannelNotFoundError` for a deleted channel, and so does `BotChatStore.softDelete`, so the two
   * kinds of conversation now answer a repeat delete the same way instead of 204 against 404.
   */
  test("deleting again is not found, not a second deletion", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Twice-deleted agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await persistentStore.softDelete(actor, created.id);
    const [afterFirst] = await database
      .select({ deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, created.id));

    await expect(
      persistentStore.softDelete(actor, created.id),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);

    // And the refusal left the first deletion's own stamp where it was.
    const [afterSecond] = await database
      .select({ deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, created.id));
    expect(afterSecond?.deletedAt).toEqual(afterFirst?.deletedAt);
  });

  test("refuses to delete a channel the caller is not a member of", async () => {
    const member = await createPersistentUser();
    const outsider = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Guarded agent",
      owner: member,
    });
    const created = await persistentStore.create(member, [agentId]);
    createdChannelIds.push(created.id);

    await expect(
      persistentStore.softDelete(outsider, created.id),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  /*
   * A deleted channel is gone as far as every other path is concerned.
   *
   * `get` and `list` filter on `deleted_at`, so a member who still has a stale roster row, or a
   * client that reports the reply to a message sent moments before the delete, would otherwise be
   * writing to and announcing a channel nobody can see: every member's browser refetches its roster
   * for a row that resolves to nothing.
   */
  test("refuses activity on a deleted channel and leaves the last message alone", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Silenced agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);
    await persistentStore.recordActivity(actor, created.id, {
      agentId,
      at: new Date(Date.now() - 60_000),
      text: "Said before the delete.",
    });
    await persistentStore.softDelete(actor, created.id);

    await expect(
      persistentStore.recordActivity(actor, created.id, {
        agentId,
        at: new Date(),
        text: "Said after the delete.",
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);

    // Same answer `get` gives, and the row the roster would have shown is untouched.
    const [row] = await database
      .select({
        lastMessage: channels.lastMessage,
        lastMessageAt: channels.lastMessageAt,
      })
      .from(channels)
      .where(eq(channels.id, created.id));
    expect(row?.lastMessage).toBe("Said before the delete.");
  });

  test("refuses to pin a deleted channel and leaves the membership alone", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Unpinnable agent",
      owner: actor,
    });
    const created = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);
    await persistentStore.softDelete(actor, created.id);

    await expect(
      persistentStore.setPinned(actor, created.id, true),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);

    const [row] = await database
      .select({ pinnedAt: channelMemberships.pinnedAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, created.id),
          eq(channelMemberships.userId, actor.id),
        ),
      );
    expect(row?.pinnedAt).toBeNull();
  });

  test("refuses to delete a package-defined channel", async () => {
    const actor = await createPersistentUser();
    const [pkg] = await database
      .insert(deploymentPackages)
      .values({
        tenantId: persistentId("tenant"),
        sourcePath: "/tmp/none",
        checksum: "0",
      })
      .returning({ id: deploymentPackages.id });
    if (!pkg) throw new Error("package row was not created");
    createdPackageIds.push(pkg.id);
    const channelId = persistentId("package-channel");
    await database.insert(channels).values({
      id: channelId,
      name: "Package channel",
      description: "Defined by the tenant package.",
      packageId: pkg.id,
    });
    createdChannelIds.push(channelId);
    await database.insert(channelMemberships).values({
      channelId,
      userId: actor.id,
    });

    await expect(
      persistentStore.softDelete(actor, channelId),
    ).rejects.toBeInstanceOf(ChannelPackageOwnedError);
  });
});

/**
 * `GET /api/channels` is a second implementation of the roster's read, and the archive is a feature
 * the roster has. Filtering only on `deleted_at` handed an archived channel back as an ordinary
 * active row, with nothing on it for a caller to tell by — a second implementation quietly ignoring
 * the feature the first one added.
 */
describe("channel store archive visibility", () => {
  async function twoChannels() {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Archivable agent",
      owner: actor,
    });
    const active = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(active.id);
    const archived = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(archived.id);
    await persistentStore.setArchived(actor, archived.id, true);
    return { actor, active, archived };
  }

  test("answers the status the caller asked for", async () => {
    const { actor, active, archived } = await twoChannels();
    const idsOf = async (status?: "active" | "archived" | "all") =>
      (await persistentStore.list(actor, status ? { status } : {})).channels
        .map((row) => row.id)
        .sort();

    expect(await idsOf()).toEqual([active.id]);
    expect(await idsOf("archived")).toEqual([archived.id]);
    expect(await idsOf("all")).toEqual([active.id, archived.id].sort());
  });

  test("does not spend a page slot on a channel the status excludes", async () => {
    // The archived one is created second, so it is the newer of the two.
    const { actor, active } = await twoChannels();

    const page = await persistentStore.list(actor, { limit: 1 });

    /*
     * The archived channel is the newer of the two, so it sorts first.
     *
     * The read is two statements — one chooses the page, the other rebuilds the rows on it — and both
     * have to filter. A page chosen without the filter picks the archived channel, and the second
     * statement then drops it: an empty page, with a cursor, while the channel somebody was actually
     * looking for sits on the next one. `expect([])` is what that looks like from here.
     */
    expect(page.channels.map((row) => row.id)).toEqual([active.id]);
    expect(page.nextCursor).toBeNull();
  });

  test("says which of the channels it returns is archived", async () => {
    const { actor, active, archived } = await twoChannels();

    const page = await persistentStore.list(actor, { status: "all" });
    const archiveStateById = new Map(
      page.channels.map((row) => [row.id, row.archived]),
    );

    expect(archiveStateById.get(archived.id)).toBe(true);
    expect(archiveStateById.get(active.id)).toBe(false);
  });

  test("still reads an archived channel by id, and says that it is", async () => {
    const { actor, archived } = await twoChannels();

    // Deliberately not filtered: archived is hidden from a roster, not from a direct read, and the
    // URL of an archived conversation still opens it. That is what makes archiving reversible rather
    // than a deletion wearing a gentler name, and it is why the flag has to travel on the row.
    // `BotChatStore.get` answers the same way.
    expect(await persistentStore.get(actor, archived.id)).toMatchObject({
      id: archived.id,
      archived: true,
    });
  });
});

/**
 * A channel whose Bots are momentarily gone.
 *
 * `channel_agents` is deleted and reinserted on every tenant-package sync, so a channel with no rows
 * there is reachable. Both reads here inner-joined it, which answered "does this channel exist" with
 * the absence of a Bot row: `get` said not found, and `list` chose the channel in its first statement
 * and dropped it in its second — invisible, while still spending a slot on every page it belonged to.
 * `roster/query.ts` was fixed the same way, and these assertions are its assertions, so the two
 * endpoints cannot answer differently about the same channel.
 */
describe("channel store with no Bots linked", () => {
  async function channelWithoutBots() {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Unlinked agent",
      owner: actor,
    });
    // The other channel first, so the Bot-less one is the newer of the two and therefore the row a
    // page of one has to hold. A slot a read wastes is only visible when something is behind it.
    const other = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(other.id);
    const orphan = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(orphan.id);
    await database
      .delete(channelAgents)
      .where(eq(channelAgents.channelId, orphan.id));
    return { actor, orphan, other };
  }

  test("still reads it by id, with no Bots on it", async () => {
    const { actor, orphan } = await channelWithoutBots();

    expect(await persistentStore.get(actor, orphan.id)).toMatchObject({
      id: orphan.id,
      agentIds: [],
      // Nothing has been retired: a channel with no coworkers in it has none to report as gone.
      active: true,
    });
  });

  test("does not report a Bot with no coworker profile as still around", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Registered agent",
      owner: actor,
    });
    const channel = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(channel.id);

    /*
     * A Bot linked to the channel with no coworker profile at all.
     *
     * `channel_agents` references `agents`; a profile is a separate row. Joined loosely, a missing
     * profile leaves `deleted_at` null, which is exactly what "not soft-deleted" cannot tell apart
     * from a Bot that is still there — so the read has to test that the profile row is present as
     * well, or a channel whose Bot was never registered renders as fully staffed.
     */
    const unregistered = persistentId("agent");
    await database.insert(agents).values({
      id: unregistered,
      name: "Unregistered agent",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://agent.example.test/ag-ui" },
    });
    createdAgentIds.push(unregistered);
    await database
      .insert(channelAgents)
      .values({ channelId: channel.id, agentId: unregistered });

    expect(await persistentStore.get(actor, channel.id)).toMatchObject({
      active: false,
    });
    const page = await persistentStore.list(actor);
    expect(page.channels.map((row) => row.active)).toEqual([false]);
  });

  test("keeps it on the page, and does not spend the slot twice", async () => {
    const { actor, orphan, other } = await channelWithoutBots();

    const first = await persistentStore.list(actor, { limit: 1 });

    expect(first.channels.map((row) => row.id)).toEqual([orphan.id]);
    expect(first.channels[0]?.agentIds).toEqual([]);
    expect(first.channels[0]?.active).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await persistentStore.list(actor, {
      limit: 1,
      cursor: first.nextCursor as string,
    });
    expect(second.channels.map((row) => row.id)).toEqual([other.id]);
  });
});

/**
 * A channel this person has no thread mapping for.
 *
 * `intelligence_channel_mappings` carries the `threadId` a summary needs, and the statement that
 * rebuilds a page inner-joins it on `(channel, person)`: without that row there is nothing to build a
 * summary from, and `get` has always answered null for the same reason. Choosing the page without the
 * same term meant the first statement picked such a channel and the second dropped it — so the
 * channel was on no page while still spending its slot on every page it belonged to, permanently
 * rather than for the width of a race. A page of one holding only that channel came back empty with a
 * live cursor, and a client that stops at an empty page shows no conversations at all.
 * `roster/query.ts` guards its own channel branch with the same term, so the two endpoints cannot
 * answer differently about the same channel.
 */
describe("channel store with no thread mapping", () => {
  async function channelWithoutMapping() {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Unmapped agent",
      owner: actor,
    });
    // The other channel first, so the unmapped one is the newer of the two and therefore the row a
    // page of one is built around. A slot a read wastes is only visible when something is behind it.
    const other = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(other.id);
    const unmapped = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(unmapped.id);
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, unmapped.id));
    return { actor, unmapped, other };
  }

  test("does not spend a page slot on it", async () => {
    const { actor, other } = await channelWithoutMapping();

    const page = await persistentStore.list(actor, { limit: 1 });

    // The channel behind it, rather than an empty page carrying a live cursor.
    expect(page.channels.map((row) => row.id)).toEqual([other.id]);
    expect(page.nextCursor).toBeNull();
  });

  test("is on no page of the walk, and leaves no page empty", async () => {
    const { actor, unmapped, other } = await channelWithoutMapping();

    const pages: { ids: string[]; more: boolean }[] = [];
    let cursor: string | undefined;
    // One more turn than there are visible channels, so a cursor that never advances fails as a wrong
    // answer rather than as a hung test.
    for (let page = 0; page < 3; page += 1) {
      const answer = await persistentStore.list(actor, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      pages.push({
        ids: answer.channels.map((row) => row.id),
        more: answer.nextCursor !== null,
      });
      if (!answer.nextCursor) break;
      cursor = answer.nextCursor;
    }

    const walked = pages.flatMap((page) => page.ids);
    expect(walked).toEqual([other.id]);
    expect(walked).not.toContain(unmapped.id);
    // And no page came back empty. A slot spent on a channel that cannot be rebuilt looks from
    // outside like a page of nothing carrying a live cursor, and a client that stops there shows no
    // conversations at all — so walking to the end is not enough to say the read is right.
    expect(pages.filter((page) => page.ids.length === 0)).toEqual([]);
  });
});

/**
 * `list`, with a delete committing between its two statements.
 *
 * Every inner join in the statement that rebuilds a page is now matched by a term in the statement
 * that chooses it, which leaves a concurrent write as the only way for a chosen channel to fail to be
 * rebuilt. What that looks like from outside is a page that is simply short — which is exactly how
 * the two earlier versions of this bug stayed invisible for as long as they did. So a short page now
 * leaves a structured line behind, and this is the case that produces one.
 */
describe("channel store list, interleaved", () => {
  /**
   * A store whose `list` runs `between` after it has chosen the page and before it rebuilds it.
   *
   * A race between two connections is a test only if the interleaving is chosen rather than hoped
   * for, and `list` takes no locks to block on, so there is no write to time this against. The
   * database handed to the store hooks every query's `then` — which is what awaiting a drizzle query
   * calls — and runs the write immediately before the second query it is asked to execute. The write
   * therefore lands with the first statement's rows in hand and the second not yet sent.
   *
   * Counted on execution rather than on `select`, because the two are not the same number: the
   * statement that chooses the page builds a subquery for its `exists` term, and a subquery is
   * compiled into SQL rather than awaited.
   */
  function storeInterleavedWith(between: () => Promise<void>) {
    let executed = 0;
    const hooked = Object.create(database) as typeof database;
    Object.defineProperty(hooked, "select", {
      value: (...columns: unknown[]) => {
        const builder = (
          database.select as unknown as (
            ...args: unknown[]
          ) => Record<string, unknown>
        )(...columns);
        const from = (
          builder.from as (...args: unknown[]) => Record<string, unknown>
        ).bind(builder);
        builder.from = (...tables: unknown[]) => {
          const query = from(...tables);
          const execute = (query.execute as () => Promise<unknown>).bind(query);
          // Defined rather than assigned, because a drizzle query already is a thenable and this
          // shadows the one it inherits. Awaiting it is what calls this.
          // biome-ignore lint/suspicious/noThenProperty: the thenable is drizzle's, not this test's — shadowing `then` is the only hook the store's own `await` runs through.
          Object.defineProperty(query, "then", {
            value: (onFulfilled: never, onRejected: never) => {
              executed += 1;
              const before = executed === 2 ? between() : Promise.resolve();
              return before.then(execute).then(onFulfilled, onRejected);
            },
          });
          return query;
        };
        return builder;
      },
    });
    return createChannelStore(
      hooked,
      profileStore,
      createThreadIdentity("test-deployment"),
    );
  }

  test("drops a channel deleted before it could be rebuilt, and says which", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Vanishing agent",
      owner: actor,
    });
    const staying = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(staying.id);
    const vanishing = await persistentStore.create(actor, [agentId]);
    createdChannelIds.push(vanishing.id);

    const store = storeInterleavedWith(async () => {
      await database
        .update(channels)
        .set({ deletedAt: new Date() })
        .where(eq(channels.id, vanishing.id));
    });

    const lines: Record<string, unknown>[] = [];
    const wasConsoleError = console.error;
    console.error = (line: unknown) => {
      try {
        lines.push(JSON.parse(String(line)) as Record<string, unknown>);
      } catch {
        // Something else in the process logging prose rather than a structured line. Not ours.
      }
    };
    let page: Awaited<ReturnType<typeof persistentStore.list>>;
    try {
      page = await store.list(actor);
    } finally {
      console.error = wasConsoleError;
    }

    // Dropping it is right — it is deleted, and the second statement filters on that. The page being
    // short is the part nothing used to say out loud.
    expect(page.channels.map((row) => row.id)).toEqual([staying.id]);
    const dropped = lines.filter(
      (line) => line.type === "channel-rows-not-hydrated",
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      actorUserId: actor.id,
      status: "active",
      chosen: 2,
      hydrated: 1,
      ids: [vanishing.id],
    });
    // The note is what tells the next reader whether one of these lines is a race or a disagreement
    // between the two statements, which is the only reason the line is worth writing.
    expect(typeof dropped[0]?.note).toBe("string");
  });
});

/**
 * Paging, over the case that made the cursor lose rows silently.
 *
 * `GET /api/channels` mints its cursor from the same sort key the roster does, and used to mint it
 * from a JavaScript `Date`: milliseconds, where `timestamptz` holds microseconds. That floors the
 * page boundary below the rows just served, and the next page's strict `<` then excludes every row
 * inside the discarded remainder. A floor only ever loses rows, so there is no duplicate to notice
 * it by — the rows are simply on no page at all.
 */
describe("channel store paging", () => {
  test("walks channels whose recency is identical to the microsecond", async () => {
    const actor = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Paging agent",
      owner: actor,
    });
    const ids: string[] = [];
    for (let made = 0; made < 3; made += 1) {
      const created = await persistentStore.create(actor, [agentId]);
      createdChannelIds.push(created.id);
      ids.push(created.id);
    }
    /*
     * Byte-identical recency, with a fractional part no millisecond clock can hold.
     *
     * Not contrived: `now()` carries microseconds, `tenant-package.ts` inserts every channel a
     * package defines inside one transaction, and the recency of a channel nobody has spoken in is
     * its `created_at`. A tenant whose package defines more channels than fit on one page lost the
     * remainder from its sidebar permanently.
     */
    await database
      .update(channels)
      .set({ createdAt: sql`'2026-01-01 00:00:00.123456+00'::timestamptz` })
      .where(inArray(channels.id, ids));

    const walked: string[] = [];
    let cursor: string | undefined;
    // One more turn than there are pages, so a cursor that never advances fails as a wrong answer
    // rather than as a hung test.
    for (let page = 0; page < ids.length + 1; page += 1) {
      const answer = await persistentStore.list(actor, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      walked.push(...answer.channels.map((row) => row.id));
      if (!answer.nextCursor) break;
      cursor = answer.nextCursor;
    }

    expect(walked.sort()).toEqual([...ids].sort());
  });
});

/**
 * Channel creation validates each selected agent through the profile store while its own
 * transaction is open. If that read runs on a second pooled connection it is both a deadlock (the
 * transaction holds a connection while waiting for one) and a time-of-check race (the read sees a
 * different snapshot and takes no lock, so a concurrent deletion lands between check and insert).
 */
describe("channel store concurrency", () => {
  test("creates a channel without borrowing a second connection", async () => {
    const singleConnection = createDatabase(databaseUrl, { max: 1 });
    const store = createChannelStore(
      singleConnection,
      createAgentProfileStore(
        singleConnection,
        new URL("https://managed.example.test/ag-ui"),
      ),
      createThreadIdentity("test-deployment"),
    );
    const owner = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Single connection agent",
      owner,
    });

    try {
      const created = await store.create(owner, [agentId]);
      createdChannelIds.push(created.id);

      expect(created.agentIds).toEqual([agentId]);
    } finally {
      await singleConnection.$client.close();
    }
  });

  test("refuses an agent whose deletion commits mid-creation", async () => {
    const owner = await createPersistentUser();
    const agentId = await createPersistentAgent({
      name: "Concurrently deleted agent",
      owner,
    });

    let markDeleted: () => void = () => {};
    let releaseDeletion: () => void = () => {};
    const deletionApplied = new Promise<void>((resolve) => {
      markDeleted = resolve;
    });
    const deletionHeld = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const deletion = database.transaction(async (transaction) => {
      await transaction
        .update(agentProfiles)
        .set({ deletedAt: new Date() })
        .where(eq(agentProfiles.agentId, agentId));
      markDeleted();
      await deletionHeld;
    });

    await deletionApplied;
    const creation = persistentStore.create(owner, [agentId]);
    // Long enough for a correct implementation to reach the row lock and block on it.
    await Bun.sleep(250);
    releaseDeletion();
    await deletion;

    const outcome = await creation.then(
      (created) => {
        createdChannelIds.push(created.id);
        return created;
      },
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(AgentNotFoundError);
    expect(
      await database
        .select({ channelId: channelAgents.channelId })
        .from(channelAgents)
        .where(eq(channelAgents.agentId, agentId)),
    ).toEqual([]);
  });
});
