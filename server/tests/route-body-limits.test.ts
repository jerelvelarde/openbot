import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createBotChatRoutes } from "../src/bot-chats/routes";
import type { BotChat, BotChatStore } from "../src/bot-chats/store";
import {
  type AgentChannel,
  type ChannelStore,
  createChannelRoutes,
  MAX_ACTIVITY_BODY_BYTES,
  MAX_CHANNEL_CREATE_BODY_BYTES,
  MAX_SMALL_BODY_BYTES,
} from "../src/channels/routes";

/**
 * Every route on the two conversation route files that reads a body, and the cap in front of it.
 *
 * ONE FILE FOR BOTH, deliberately. `channel-routes.test.ts` and `bot-chat-routes.test.ts` each own
 * their file's behaviour, and a body cap is not behaviour of one route: it is a property that has to
 * hold for all nine of them, and the way it failed was seven routes having no cap while the two that
 * did sat in those two files looking like the rule. A table here answers "which routes have one" in
 * one place, which is the question that was not being asked.
 */

const actor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const channel: AgentChannel = {
  id: "channel-1",
  name: "Assistant channel",
  agentIds: ["agent-1"],
  threadId: "thread-1",
  active: true,
  archived: false,
};

const botChat: BotChat = {
  id: "chat-1",
  agentId: "agent-1",
  threadId: "8f14e45f-ceea-467a-9d3a-3f0b9e1a2c4d",
  title: null,
  active: true,
  archived: false,
};

/**
 * Fakes that record only that they were reached.
 *
 * Which arguments arrived is the sibling files' question. The one thing these have to be able to say
 * is whether a request that should have been turned away in front of the handler got as far as the
 * store, because "refused before it is parsed" is unobservable from the response alone on a route
 * whose parser would have refused the same body with a 400.
 */
function fakeChannelStore(reached: string[]): ChannelStore {
  return {
    async create() {
      reached.push("create");
      return channel;
    },
    async get() {
      reached.push("get");
      return channel;
    },
    async list() {
      reached.push("list");
      return { channels: [], nextCursor: null };
    },
    async setPinned() {
      reached.push("setPinned");
    },
    async markRead() {
      reached.push("markRead");
    },
    async softDelete() {
      reached.push("softDelete");
    },
    async setArchived() {
      reached.push("setArchived");
      return true;
    },
    async recordActivity() {
      reached.push("recordActivity");
      return { restored: false };
    },
  };
}

function fakeBotChatStore(reached: string[]): BotChatStore {
  return {
    async create() {
      reached.push("create");
      return botChat;
    },
    async adopt() {
      reached.push("adopt");
      return botChat;
    },
    async get() {
      reached.push("get");
      return botChat;
    },
    async mostRecent() {
      reached.push("mostRecent");
      return botChat;
    },
    async recordActivity() {
      reached.push("recordActivity");
      return { restored: false };
    },
    async setPinned() {
      reached.push("setPinned");
    },
    async markRead() {
      reached.push("markRead");
    },
    async setArchived() {
      reached.push("setArchived");
      return true;
    },
    async softDelete() {
      reached.push("softDelete");
    },
  };
}

type BodyRoute = {
  /** How the failure reads when the table row is the one that broke. */
  readonly name: string;
  readonly mount: "channels" | "bot-chats";
  readonly method: "POST" | "PUT";
  readonly path: string;
  /** The cap this route was given, read from the source rather than restated as a number here. */
  readonly maxSize: number;
  /** What the 413 says, which is per-route because the 400s these parsers answer are. */
  readonly error: string;
  /** A body the route's parser accepts, before padding. */
  readonly accepted: Record<string, unknown>;
};

const ACCEPTED_ACTIVITY = {
  text: "hello",
  agentId: null,
  at: "2026-01-01T00:00:00.000Z",
};

const BODY_ROUTES: readonly BodyRoute[] = [
  {
    name: "POST /api/channels",
    mount: "channels",
    method: "POST",
    path: "/",
    maxSize: MAX_CHANNEL_CREATE_BODY_BYTES,
    error: "Channel body is too large.",
    accepted: { agentIds: ["agent-1"] },
  },
  {
    name: "POST /api/channels/:channelId/activity",
    mount: "channels",
    method: "POST",
    path: "/channel-1/activity",
    maxSize: MAX_ACTIVITY_BODY_BYTES,
    error: "Activity body is too large.",
    accepted: ACCEPTED_ACTIVITY,
  },
  {
    name: "PUT /api/channels/:channelId/pin",
    mount: "channels",
    method: "PUT",
    path: "/channel-1/pin",
    maxSize: MAX_SMALL_BODY_BYTES,
    error: "Pin body is too large.",
    accepted: { pinned: true },
  },
  {
    name: "PUT /api/channels/:channelId/archive",
    mount: "channels",
    method: "PUT",
    path: "/channel-1/archive",
    maxSize: MAX_SMALL_BODY_BYTES,
    error: "Archive body is too large.",
    accepted: { archived: true },
  },
  {
    name: "POST /api/bot-chats",
    mount: "bot-chats",
    method: "POST",
    path: "/",
    maxSize: MAX_SMALL_BODY_BYTES,
    error: "Bot chat body is too large.",
    accepted: { agentId: "agent-1" },
  },
  {
    name: "POST /api/bot-chats/adopt",
    mount: "bot-chats",
    method: "POST",
    path: "/adopt",
    maxSize: MAX_SMALL_BODY_BYTES,
    error: "Adopt body is too large.",
    accepted: {
      agentId: "agent-1",
      threadId: "8f14e45f-ceea-467a-9d3a-3f0b9e1a2c4d",
    },
  },
  {
    name: "POST /api/bot-chats/:id/activity",
    mount: "bot-chats",
    method: "POST",
    path: "/chat-1/activity",
    maxSize: MAX_ACTIVITY_BODY_BYTES,
    error: "Activity body is too large.",
    accepted: ACCEPTED_ACTIVITY,
  },
  {
    name: "PUT /api/bot-chats/:id/pin",
    mount: "bot-chats",
    method: "PUT",
    path: "/chat-1/pin",
    maxSize: MAX_SMALL_BODY_BYTES,
    error: "Pin body is too large.",
    accepted: { pinned: true },
  },
  {
    name: "PUT /api/bot-chats/:id/archive",
    mount: "bot-chats",
    method: "PUT",
    path: "/chat-1/archive",
    maxSize: MAX_SMALL_BODY_BYTES,
    error: "Archive body is too large.",
    accepted: { archived: true },
  },
];

function appFor(route: BodyRoute, reached: string[]) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    route.mount === "channels"
      ? createChannelRoutes(fakeChannelStore(reached), requireUser)
      : createBotChatRoutes(fakeBotChatStore(reached), requireUser),
  );
  return app;
}

/**
 * A body of exactly `size` bytes that the route's own parser would accept.
 *
 * Padded with a key none of these parsers reads, because every one of them whitelists the fields it
 * wants and ignores the rest — so the padding cannot be what a route refuses, and a refusal is the
 * cap or nothing. ASCII throughout, so a character is a byte and the assertion below can say so.
 */
function bodyOfSize(accepted: Record<string, unknown>, size: number) {
  const empty = JSON.stringify({ ...accepted, padding: "" });
  const room = size - empty.length;
  if (room < 0) {
    throw new Error(
      `${size} bytes is too small to hold ${empty.length} bytes of accepted body.`,
    );
  }
  const body = JSON.stringify({ ...accepted, padding: "a".repeat(room) });
  if (new TextEncoder().encode(body).length !== size) {
    throw new Error("padding did not land on the requested size.");
  }
  return body;
}

async function request(route: BodyRoute, body: string, reached: string[]) {
  return appFor(route, reached).request(`http://openbot.test${route.path}`, {
    method: route.method,
    headers: { "content-type": "application/json" },
    body,
  });
}

const rows = BODY_ROUTES.map((route) => [route.name, route] as const);

describe("every route that reads a body has a cap in front of it", () => {
  test.each(rows)("%s refuses a body over its cap", async (_name, route) => {
    const reached: string[] = [];
    const response = await request(
      route,
      bodyOfSize(route.accepted, route.maxSize + 1),
      reached,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: route.error });
    // The store is the proof that nothing downstream ran: a 413 the handler produced itself would
    // look identical from outside.
    expect(reached).toEqual([]);
  });

  test.each(rows)(
    "%s refuses an oversized body BEFORE parsing it",
    async (_name, route) => {
      const reached: string[] = [];
      /*
       * Not JSON at all, and over the cap.
       *
       * This is the property the `bodyLimit` comment claims and the only way to see it from outside:
       * were the cap missing, `context.req.json()` would run first, fail to parse this, and the
       * handler would answer its own 400 "must be a JSON object" — so a 413 here means the body was
       * turned away before anything parsed it. With `content-length` set, as it is for a string body,
       * the middleware does not even read the stream.
       */
      const response = await request(
        route,
        "a".repeat(route.maxSize + 1),
        reached,
      );

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: route.error });
      expect(reached).toEqual([]);
    },
  );

  test.each(rows)(
    "%s still accepts a body exactly at its cap",
    async (_name, route) => {
      const reached: string[] = [];
      const response = await request(
        route,
        bodyOfSize(route.accepted, route.maxSize),
        reached,
      );

      // Whatever the route answers on success — 200, 201 or 204 — as long as the cap is not the thing
      // that answered. A cap sized below what the route accepts is a cap that refuses real requests.
      expect(response.status).toBeLessThan(400);
      expect(reached).not.toEqual([]);
    },
  );
});

test("a flag route does not inherit the activity route's cap", async () => {
  /*
   * The sizes are judged per route, and this is what that buys.
   *
   * One number for all nine would have to be the activity route's — it is the only one that carries a
   * message — and then a body a quarter of a megabyte long would be read and `JSON.parse`d in full to
   * find one boolean in it. This body is over the flag cap and well under the activity one, and the
   * two routes answer it differently, which is the whole claim.
   */
  const oversizedForAFlag = bodyOfSize(
    { archived: true },
    MAX_SMALL_BODY_BYTES + 1,
  );
  expect(oversizedForAFlag.length).toBeLessThan(MAX_ACTIVITY_BODY_BYTES);

  const flagReached: string[] = [];
  const flag = await request(
    BODY_ROUTES.find(
      (route) => route.path === "/channel-1/archive",
    ) as BodyRoute,
    oversizedForAFlag,
    flagReached,
  );
  expect(flag.status).toBe(413);
  expect(flagReached).toEqual([]);

  const activityReached: string[] = [];
  const activity = await request(
    BODY_ROUTES.find(
      (route) => route.path === "/channel-1/activity",
    ) as BodyRoute,
    bodyOfSize(ACCEPTED_ACTIVITY, MAX_SMALL_BODY_BYTES + 1),
    activityReached,
  );
  expect(activity.status).toBe(204);
  expect(activityReached).toEqual(["recordActivity"]);
});

/**
 * The table above pins the routes that exist today; this pins the next one somebody adds.
 *
 * Read as text, the way `cull-sweep-wiring.test.ts` reads its script, because the failure being
 * guarded against is not a wrong answer from a route — it is a route added with no cap at all, which
 * no test of the nine routes that do have one can see. A tenth body-reading route makes the counts
 * disagree and this fails naming the file.
 *
 * WHAT THIS CANNOT SEE. Whether the number chosen is the right number — that is what the table's
 * at-the-cap and over-the-cap rows are for — and it can only recognise a body read spelled
 * `context.req.json()`, which is why the other spellings are asserted absent rather than assumed.
 */
describe("no body read without a cap", () => {
  /**
   * Comments stripped before anything is counted.
   *
   * Both files argue about `context.req.json()` in prose — that is what the caps exist to get in
   * front of, so of course they name it — and counting those mentions had this reading five body
   * reads in a file with four. Neither file contains a `://` or a `//` inside a string, which is what
   * makes stripping to end of line safe here rather than in general.
   */
  const withoutComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const sources = {
    "channels/routes.ts": withoutComments(
      readFileSync(
        join(import.meta.dir, "..", "src", "channels", "routes.ts"),
        "utf8",
      ),
    ),
    "bot-chats/routes.ts": withoutComments(
      readFileSync(
        join(import.meta.dir, "..", "src", "bot-chats", "routes.ts"),
        "utf8",
      ),
    ),
  } as const;

  test.each(Object.entries(sources))(
    "%s caps every body it reads",
    (_file, source) => {
      const reads = source.match(/context\.req\.json\(\)/g) ?? [];
      // Call sites only. `limitBody(` alone also matches the declaration in `channels/routes.ts`,
      // which is not a cap on anything; every call passes its subject as a string literal first.
      const caps = source.match(/limitBody\("/g) ?? [];
      expect(caps).toHaveLength(reads.length);
    },
  );

  test.each(Object.entries(sources))(
    "%s reads a body no other way",
    (_file, source) => {
      // Each of these reaches the whole body before any handler of ours sees it, and `limitBody` in
      // front of it is not enough to make the count above meaningful — the count is over
      // `context.req.json()` alone.
      for (const spelling of [
        "req.text()",
        "req.parseBody()",
        "req.arrayBuffer()",
        "req.blob()",
        "req.formData()",
        "req.raw.body",
      ]) {
        expect(source).not.toInclude(spelling);
      }
    },
  );
});
