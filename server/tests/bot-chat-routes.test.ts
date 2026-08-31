import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { AgentNotFoundError } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { createBotChatRoutes, parseAdoptInput } from "../src/bot-chats/routes";
import {
  type BotChat,
  BotChatNotFoundError,
  type BotChatStore,
  BotChatThreadTakenError,
} from "../src/bot-chats/store";

const actor: AgentActor = {
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

function chat(overrides: Partial<BotChat> = {}): BotChat {
  return {
    id: "botchat_1",
    agentId: "agent-1",
    threadId: "11111111-1111-4111-8111-111111111111",
    title: null,
    active: true,
    archived: false,
    ...overrides,
  };
}

type StoreCall = [method: keyof BotChatStore, ...arguments_: unknown[]];

function fakeStore(
  overrides: Partial<BotChatStore> = {},
): BotChatStore & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const base: BotChatStore = {
    async create(receivedActor, agentId) {
      calls.push(["create", receivedActor, agentId]);
      return chat({ agentId });
    },
    async adopt(receivedActor, agentId, threadId) {
      calls.push(["adopt", receivedActor, agentId, threadId]);
      return chat({ agentId, threadId });
    },
    async get(receivedActor, id) {
      calls.push(["get", receivedActor, id]);
      return chat({ id });
    },
    async mostRecent(receivedActor, agentId) {
      calls.push(["mostRecent", receivedActor, agentId]);
      return chat({ agentId });
    },
    async recordActivity(receivedActor, id, activity) {
      calls.push(["recordActivity", receivedActor, id, activity]);
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
  };
  return Object.assign(base, overrides, { calls });
}

function appFor(store: BotChatStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createBotChatRoutes(store, requireUser));
  return app;
}

function put(
  app: Hono<{ Variables: AppVariables }>,
  path: string,
  body?: unknown,
) {
  return app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function post(
  app: Hono<{ Variables: AppVariables }>,
  path: string,
  body: unknown,
) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the adopt input parser", () => {
  test.each([[null], [[]], ["input"], [42]])(
    "rejects a non-object root: %p",
    (input) => {
      expect(parseAdoptInput(input)).toEqual({
        ok: false,
        error: "Adopt input must be a JSON object.",
      });
    },
  );

  test("rejects a missing agent id", () => {
    expect(
      parseAdoptInput({ threadId: "11111111-1111-4111-8111-111111111111" }),
    ).toEqual({ ok: false, error: "Agent ID must be a non-empty string." });
  });

  test.each([
    ["not-a-uuid"],
    [""],
    ["11111111-1111-4111-8111"],
    ["11111111111141118111111111111111"],
  ])("rejects a thread id that could not be one: %p", (threadId) => {
    // Only a shape check. This route also has to accept a thread another deployment minted, so it
    // cannot ask whether we minted it — it can only refuse a string that is not a thread id at all.
    expect(parseAdoptInput({ agentId: "agent-1", threadId })).toEqual({
      ok: false,
      error: "Thread ID must be a thread id.",
    });
  });

  test("trims and accepts a plausible pair", () => {
    expect(
      parseAdoptInput({
        agentId: "  agent-1  ",
        threadId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      ok: true,
      value: {
        agentId: "agent-1",
        threadId: "11111111-1111-4111-8111-111111111111",
      },
    });
  });
});

describe("POST /", () => {
  test("creates a chat and answers 201", async () => {
    const store = fakeStore();
    const response = await post(appFor(store), "/", { agentId: "agent-1" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      botChat: {
        id: "botchat_1",
        agentId: "agent-1",
        threadId: "11111111-1111-4111-8111-111111111111",
        title: null,
        active: true,
        archived: false,
      },
    });
    expect(store.calls).toEqual([["create", actor, "agent-1"]]);
  });

  test("answers 404 for a Bot the caller cannot see", async () => {
    const store = fakeStore({
      async create() {
        throw new AgentNotFoundError("agent-1");
      },
    });
    const response = await post(appFor(store), "/", { agentId: "agent-1" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found." });
  });
});

describe("POST /adopt", () => {
  test("adopts a remembered thread", async () => {
    const store = fakeStore();
    const response = await post(appFor(store), "/adopt", {
      agentId: "agent-1",
      threadId: "11111111-1111-4111-8111-111111111111",
    });

    expect(response.status).toBe(200);
    expect(store.calls).toEqual([
      ["adopt", actor, "agent-1", "11111111-1111-4111-8111-111111111111"],
    ]);
  });

  // The store throws BotChatThreadTakenError for two different situations — a thread that belongs
  // to somebody else, and the caller's own thread but one they soft-deleted themselves (see the
  // comment on mapStoreError in ../src/bot-chats/routes.ts and on `adopt` in ../src/bot-chats/store.ts).
  // Both answer with the same 409 and the same message, deliberately, so which of the two happened
  // is not something this response lets a caller tell apart.
  test("answers 409 for a thread that cannot be adopted", async () => {
    const store = fakeStore({
      async adopt() {
        throw new BotChatThreadTakenError("thread");
      },
    });
    const response = await post(appFor(store), "/adopt", {
      agentId: "agent-1",
      threadId: "11111111-1111-4111-8111-111111111111",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "That conversation is no longer available.",
    });
  });

  test("answers 400 without reaching the store for an implausible thread id", async () => {
    const store = fakeStore();
    const response = await post(appFor(store), "/adopt", {
      agentId: "agent-1",
      threadId: "not-a-thread",
    });

    expect(response.status).toBe(400);
    expect(store.calls).toEqual([]);
  });
});

describe("GET /:id", () => {
  test("answers with the chat", async () => {
    const response = await appFor(fakeStore()).request("/botchat_1");
    expect(response.status).toBe(200);
  });

  test("answers 404 rather than 403 for somebody else's", async () => {
    const store = fakeStore({
      async get() {
        return null;
      },
    });
    const response = await appFor(store).request("/botchat_1");

    // The same answer every way, so ownership is not probeable.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Bot chat not found." });
  });
});

describe("PUT /:id/archive", () => {
  test.each([[true], [false]])("sets it to %p", async (archived) => {
    const store = fakeStore();
    const response = await put(appFor(store), "/botchat_1/archive", {
      archived,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived });
    expect(store.calls).toEqual([
      ["setArchived", actor, "botchat_1", archived],
    ]);
  });

  test.each([[{}], [{ archived: "yes" }], [null]])(
    "refuses a body that does not say which way: %p",
    async (body) => {
      const store = fakeStore();
      const response = await put(appFor(store), "/botchat_1/archive", body);

      expect(response.status).toBe(400);
      expect(store.calls).toEqual([]);
    },
  );

  test("answers 404 for a chat that is not the caller's", async () => {
    const store = fakeStore({
      async setArchived() {
        throw new BotChatNotFoundError("botchat_1");
      },
    });
    const response = await put(appFor(store), "/botchat_1/archive", {
      archived: true,
    });

    expect(response.status).toBe(404);
  });
});

describe("PUT /:id/pin and /:id/read", () => {
  test("pins", async () => {
    const store = fakeStore();
    const response = await put(appFor(store), "/botchat_1/pin", {
      pinned: true,
    });

    expect(response.status).toBe(200);
    expect(store.calls).toEqual([["setPinned", actor, "botchat_1", true]]);
  });

  test("marks read with no body", async () => {
    const store = fakeStore();
    const response = await put(appFor(store), "/botchat_1/read");

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["markRead", actor, "botchat_1"]]);
  });
});

describe("POST /:id/activity", () => {
  test("reports what was said", async () => {
    const store = fakeStore();
    const at = "2026-08-31T09:00:00.000Z";
    const response = await post(appFor(store), "/botchat_1/activity", {
      text: "Hello",
      agentId: null,
      at,
    });

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([
      [
        "recordActivity",
        actor,
        "botchat_1",
        { text: "Hello", agentId: null, at: new Date(at) },
      ],
    ]);
  });

  test("refuses a report with no timestamp", async () => {
    const store = fakeStore();
    const response = await post(appFor(store), "/botchat_1/activity", {
      text: "Hello",
      agentId: null,
    });

    expect(response.status).toBe(400);
    expect(store.calls).toEqual([]);
  });
});

describe("DELETE /:id", () => {
  test("soft-deletes and answers 204", async () => {
    const store = fakeStore();
    const response = await appFor(store).request("/botchat_1", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["softDelete", actor, "botchat_1"]]);
  });
});
