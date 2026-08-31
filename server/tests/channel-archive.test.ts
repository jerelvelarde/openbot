import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  type AgentChannel,
  ChannelNotFoundError,
  ChannelPackageOwnedError,
  type ChannelStore,
  createChannelRoutes,
} from "../src/channels/routes";

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

function channel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: "channel_1",
    name: "Assistant channel",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
    ...overrides,
  };
}

type StoreCall = [method: keyof ChannelStore, ...arguments_: unknown[]];

function fakeStore(overrides: Partial<ChannelStore> = {}) {
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
    },
    async softDelete(receivedActor, id) {
      calls.push(["softDelete", receivedActor, id]);
    },
    async recordActivity(receivedActor, id, activity) {
      calls.push(["recordActivity", receivedActor, id, activity]);
    },
  };
  return Object.assign(base, overrides, { calls });
}

/**
 * A recording `AuditStore`, matching the real interface (`insert`, not `record`) rather than the
 * one-off name a fake might otherwise invent — `server/src/audit.ts` is the source of truth and
 * `channel-routes.test.ts`'s own audit fixture uses the same method.
 */
function recordingAuditStore() {
  const written: AuditEventInput[] = [];
  const store: AuditStore = {
    insert: async (event) => void written.push(event),
  };
  return { store, written };
}

function appFor(store: ChannelStore, auditStore?: AuditStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createChannelRoutes(store, requireUser, undefined, auditStore),
  );
  return app;
}

async function archive(app: Hono<{ Variables: AppVariables }>, body: unknown) {
  return app.request("/channel_1/archive", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /:channelId/archive", () => {
  test("archives and answers with the state it reached", async () => {
    const store = fakeStore();
    const response = await archive(appFor(store), { archived: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived: true });
    expect(store.calls).toEqual([["setArchived", actor, "channel_1", true]]);
  });

  test("restores", async () => {
    const store = fakeStore();
    const response = await archive(appFor(store), { archived: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived: false });
    expect(store.calls).toEqual([["setArchived", actor, "channel_1", false]]);
  });

  test.each([[{}], [{ archived: "yes" }], [{ archived: null }], [null]])(
    "refuses a body that does not say which way: %p",
    async (body) => {
      const store = fakeStore();
      const response = await archive(appFor(store), body);

      expect(response.status).toBe(400);
      // Nothing reached the store, so a malformed request cannot half-apply.
      expect(store.calls).toEqual([]);
    },
  );

  test("answers 404 for a channel the caller is not in", async () => {
    const store = fakeStore({
      async setArchived() {
        throw new ChannelNotFoundError("channel_1");
      },
    });
    const response = await archive(appFor(store), { archived: true });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Channel not found." });
  });

  test("names archiving, not deleting, when the package owns the channel", async () => {
    const store = fakeStore({
      async setArchived() {
        throw new ChannelPackageOwnedError("channel_1", "archived");
      },
    });
    const response = await archive(appFor(store), { archived: true });

    expect(response.status).toBe(409);
    // A 409 that says the wrong verb is worse than no message at all.
    expect(await response.json()).toEqual({
      error:
        "This channel is defined by the deployment package, so it cannot be archived here.",
    });
  });

  test("writes the act to the trail", async () => {
    const audit = recordingAuditStore();
    await archive(appFor(fakeStore(), audit.store), { archived: true });

    expect(audit.written).toEqual([
      {
        eventType: "channel.archived",
        targetType: "channel",
        targetId: "channel_1",
        actorUserId: actor.id,
        payload: {},
      },
    ]);
  });

  test("writes a restore as its own act, not as an archive", async () => {
    const audit = recordingAuditStore();
    await archive(appFor(fakeStore(), audit.store), { archived: false });

    expect(audit.written.map((event) => event.eventType)).toEqual([
      "channel.unarchived",
    ]);
  });

  test("writes nothing to the trail when the store refused", async () => {
    const audit = recordingAuditStore();
    const store = fakeStore({
      async setArchived() {
        throw new ChannelNotFoundError("channel_1");
      },
    });
    await archive(appFor(store, audit.store), { archived: true });

    // The trail records acts, not attempts.
    expect(audit.written).toEqual([]);
  });

  test("still answers when the trail is unavailable", async () => {
    const failing: AuditStore = {
      insert: async () => {
        throw new Error("trail unreachable");
      },
    };
    const response = await archive(appFor(fakeStore(), failing), {
      archived: true,
    });

    // The channel is already archived and the caller already told by the time this runs.
    expect(response.status).toBe(200);
  });
});

describe("ChannelPackageOwnedError", () => {
  test("still says deleted when nobody names an act", () => {
    // The existing delete route constructs it with one argument, and its message must not change.
    expect(new ChannelPackageOwnedError("channel_1").act).toBe("deleted");
  });
});
