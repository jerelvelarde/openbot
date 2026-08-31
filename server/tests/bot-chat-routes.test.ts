import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { AgentNotFoundError } from "../src/agents/profile-store";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createBotChatRoutes, parseAdoptInput } from "../src/bot-chats/routes";
import {
  type BotChat,
  BotChatNotFoundError,
  type BotChatStore,
  BotChatThreadTakenError,
} from "../src/bot-chats/store";

/**
 * `AuthenticatedActor`, because that is what this goes into.
 *
 * It is stored as the Hono context's `actor`, whose type is `AppVariables["actor"]`, and it carries
 * an `email` — which `AgentActor` does not have a field for. Annotated `AgentActor` it was two things
 * at once: an object the annotation forbids the `email` of, and a value the middleware below assigns
 * where a wider type is required. `server/tsconfig.json` excludes `tests`, so nothing said so. The
 * store methods take `AgentActor` and receive this unchanged, which is what the assertions on
 * `store.calls` compare against.
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
      return { restored: false };
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

/**
 * A recording `AuditStore`, matching the real interface (`insert`, not `record`) rather than a name a
 * fake might invent — `server/src/audit.ts` is the source of truth, and `channel-archive.test.ts`'s
 * own fixture is the same shape.
 */
function recordingAuditStore() {
  const written: AuditEventInput[] = [];
  const store: AuditStore = {
    insert: async (event) => void written.push(event),
  };
  return { store, written };
}

function appFor(store: BotChatStore, auditStore?: AuditStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createBotChatRoutes(store, requireUser, auditStore));
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

  // `parseCreateInput` is not exported, and asserted through the route it parses for rather than
  // exported to be tested: what matters is that a malformed body is refused before the store is
  // reached, which is a fact about the route and not about the function.
  test.each([[null], [[]], ["input"], [42]])(
    "refuses a body that is not a JSON object: %p",
    async (body) => {
      const store = fakeStore();
      const response = await post(appFor(store), "/", body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Bot chat input must be a JSON object.",
      });
      expect(store.calls).toEqual([]);
    },
  );

  test.each([[{}], [{ agentId: "" }], [{ agentId: "   " }], [{ agentId: 7 }]])(
    "refuses a body that names no Bot: %p",
    async (body) => {
      const store = fakeStore();
      const response = await post(appFor(store), "/", body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Agent ID must be a non-empty string.",
      });
      // Nothing reached the store, so a request naming no Bot cannot mint a thread.
      expect(store.calls).toEqual([]);
    },
  );

  test("trims the Bot id before it reaches the store", async () => {
    const store = fakeStore();
    await post(appFor(store), "/", { agentId: "  agent-1  " });

    expect(store.calls).toEqual([["create", actor, "agent-1"]]);
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

  // The store throws BotChatThreadTakenError for four different situations — a thread that belongs to
  // somebody else, the caller's own thread but one they soft-deleted themselves, the caller's own live
  // thread with a different Bot, and a thread that is a channel's rather than a bot chat's (see the
  // comment on mapStoreError in ../src/bot-chats/routes.ts and on `adopt` in
  // ../src/bot-chats/store.ts). All four answer with the same 409 and the same message, deliberately,
  // so which one happened is not something this response lets a caller tell apart.
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

  test.each([[{}], [{ archived: "yes" }], [{ archived: null }], [null]])(
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

  test("writes the act to the trail", async () => {
    const audit = recordingAuditStore();
    await put(appFor(fakeStore(), audit.store), "/botchat_1/archive", {
      archived: true,
    });

    expect(audit.written).toEqual([
      {
        eventType: "bot_chat.archived",
        targetType: "bot_chat",
        targetId: "botchat_1",
        actorUserId: actor.id,
        // Named, so a restore somebody pressed stays distinguishable from one a message caused —
        // the activity route below writes the same event type with `activity`.
        payload: { mechanism: "explicit" },
      },
    ]);
  });

  test("writes a restore as its own act, not as an archive", async () => {
    const audit = recordingAuditStore();
    await put(appFor(fakeStore(), audit.store), "/botchat_1/archive", {
      archived: false,
    });

    expect(audit.written.map((event) => event.eventType)).toEqual([
      "bot_chat.unarchived",
    ]);
  });

  test("answers 200 and writes no trail row for a chat already archived", async () => {
    const audit = recordingAuditStore();
    // `false` is what the store answers when the chat was already in the requested state — the same
    // no-op it refuses to restamp or announce.
    const store = fakeStore({
      async setArchived() {
        return false;
      },
    });
    const response = await put(
      appFor(store, audit.store),
      "/botchat_1/archive",
      { archived: true },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived: true });
    // Pressing Archive twice must not lay down a second `bot_chat.archived` row for one archiving.
    expect(audit.written).toEqual([]);
  });

  test("writes nothing to the trail when the store refused", async () => {
    const audit = recordingAuditStore();
    const store = fakeStore({
      async setArchived() {
        throw new BotChatNotFoundError("botchat_1");
      },
    });
    await put(appFor(store, audit.store), "/botchat_1/archive", {
      archived: true,
    });

    // The trail records acts, not attempts.
    expect(audit.written).toEqual([]);
  });

  test("archives anyway when the trail cannot be written, and says so", async () => {
    const failing: AuditStore = {
      insert: async () => {
        throw new Error("the trail is unavailable");
      },
    };
    const store = fakeStore();
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
      response = await put(appFor(store, failing), "/botchat_1/archive", {
        archived: true,
      });
    } finally {
      console.error = wasConsoleError;
    }

    // The conversation is already archived by the time the trail is written, so failing here would
    // report a failure that did not happen.
    expect(response.status).toBe(200);
    expect(store.calls).toEqual([["setArchived", actor, "botchat_1", true]]);
    // Swallowed, and said out loud: a trail that quietly stops recording is worse than one that is
    // briefly unavailable, and nothing else can tell.
    expect(
      lines.filter((line) => line.type === "bot-chat-audit-write-failed"),
    ).toEqual([
      {
        type: "bot-chat-audit-write-failed",
        eventType: "bot_chat.archived",
        botChatId: "botchat_1",
        error: "Error: the trail is unavailable",
      },
    ]);
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

  test("refuses an activity body too large to parse", async () => {
    const store = fakeStore();
    const response = await post(appFor(store), "/botchat_1/activity", {
      text: "a".repeat(400_000),
      agentId: null,
      at: "2026-08-31T09:00:00.000Z",
    });

    /*
     * 413 from the middleware, not 400 from the parser, and the same 413 the channel twin's activity
     * route answers.
     *
     * `parseActivityInput`'s own 16,000-unit cap cannot prevent this: it runs after
     * `context.req.json()` has already read and parsed the whole body, so the body above was
     * materialised and parsed before the parser saw an object and only then refused. The two caps are
     * not interchangeable, and the body limit is the wider of the two on purpose — no message the
     * parser would accept can be refused here first.
     */
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Activity body is too large.",
    });
    expect(store.calls).toEqual([]);
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

  test("records a restore nobody asked for, when the message cleared the archive", async () => {
    const audit = recordingAuditStore();
    const store = fakeStore({
      async recordActivity() {
        return { restored: true };
      },
    });
    const response = await post(
      appFor(store, audit.store),
      "/botchat_1/activity",
      { text: "One more thing", agentId: null, at: "2026-08-31T09:00:00.000Z" },
    );

    expect(response.status).toBe(204);
    expect(audit.written).toEqual([
      {
        eventType: "bot_chat.unarchived",
        targetType: "bot_chat",
        targetId: "botchat_1",
        actorUserId: actor.id,
        // `activity`, not `explicit`: saying something in an archived conversation is how it comes
        // back, and nobody performed that as an act.
        payload: { mechanism: "activity" },
      },
    ]);
  });

  test("writes nothing to the trail for a message that restored nothing", async () => {
    const audit = recordingAuditStore();
    await post(appFor(fakeStore(), audit.store), "/botchat_1/activity", {
      text: "Hello",
      agentId: null,
      at: "2026-08-31T09:00:00.000Z",
    });

    // Every message would otherwise be a trail row, which is a transcript wearing an audit trail's
    // clothes.
    expect(audit.written).toEqual([]);
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

  test("writes who ended the conversation, and how", async () => {
    const audit = recordingAuditStore();
    await appFor(fakeStore(), audit.store).request("/botchat_1", {
      method: "DELETE",
    });

    expect(audit.written).toEqual([
      {
        eventType: "bot_chat.deleted",
        targetType: "bot_chat",
        targetId: "botchat_1",
        actorUserId: actor.id,
        // The row and its thread survive, so a later hard delete has to stay a different fact.
        payload: { mechanism: "soft" },
      },
    ]);
  });

  test("writes nothing to the trail for a delete the store refused", async () => {
    const audit = recordingAuditStore();
    const store = fakeStore({
      async softDelete() {
        throw new BotChatNotFoundError("botchat_1");
      },
    });
    const response = await appFor(store, audit.store).request("/botchat_1", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    // A repeat delete throws in the store, which is what keeps one removal to one row.
    expect(audit.written).toEqual([]);
  });
});
