import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { RosterActivityEvent } from "../src/channels/events";
import {
  type AgentChannel,
  announcementPayloads,
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
    archived: false,
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
      return true;
    },
    async softDelete(receivedActor, id) {
      calls.push(["softDelete", receivedActor, id]);
    },
    async recordActivity(receivedActor, id, activity) {
      calls.push(["recordActivity", receivedActor, id, activity]);
      return { restored: false };
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

async function reportActivity(app: Hono<{ Variables: AppVariables }>) {
  return app.request("/channel_1/activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "One more thing",
      agentId: null,
      at: "2026-01-01T00:00:00.000Z",
    }),
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
        // Named the way `channel.deleted` names its mechanism, and for a sharper reason: somebody
        // typing in an archived channel restores it and writes `channel.unarchived` too, so without
        // this a reader cannot tell a decision from a side effect.
        payload: { mechanism: "explicit" },
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

  test("answers 200 and writes no audit row for a channel already archived", async () => {
    const audit = recordingAuditStore();
    // `false` is what the store returns when the channel was already in the requested state — the
    // same no-op the store itself refuses to restamp or announce.
    const store = fakeStore({
      async setArchived() {
        return false;
      },
    });
    const response = await archive(appFor(store, audit.store), {
      archived: true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived: true });
    // Clicking Archive twice must not lay down a second `channel.archived` row for one archiving.
    expect(audit.written).toEqual([]);
  });

  test("answers 200 and writes no audit row for a channel already active", async () => {
    const audit = recordingAuditStore();
    const store = fakeStore({
      async setArchived() {
        return false;
      },
    });
    const response = await archive(appFor(store, audit.store), {
      archived: false,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived: false });
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

/**
 * The other way a channel comes back, and the row it owes the trail.
 *
 * Saying something in an archived channel restores it, which is a real unarchiving with a real
 * actor. The store cannot write it — it holds no audit store — so the route does, from what the
 * store reports back. Without the row the trail shows `channel.archived` with no matching
 * `channel.unarchived` while the channel is live and visible on every roster: a trail that is
 * confidently wrong, which `audit.ts` argues at length is worse than a silent one because it is used
 * to rule things out.
 */
describe("POST /:channelId/activity", () => {
  test("records the unarchiving when the report is what restored the channel", async () => {
    const audit = recordingAuditStore();
    const store = fakeStore({
      async recordActivity() {
        return { restored: true };
      },
    });

    const response = await reportActivity(appFor(store, audit.store));

    expect(response.status).toBe(204);
    expect(audit.written).toEqual([
      {
        eventType: "channel.unarchived",
        targetType: "channel",
        targetId: "channel_1",
        actorUserId: actor.id,
        // Named, because the same event type is written by somebody clicking Restore. A reader who
        // cannot tell those apart cannot tell whether anybody decided anything.
        payload: { mechanism: "activity" },
      },
    ]);
  });

  test("writes nothing for a report that restored nothing", async () => {
    const audit = recordingAuditStore();

    const response = await reportActivity(appFor(fakeStore(), audit.store));

    expect(response.status).toBe(204);
    // Every message in an unarchived channel would otherwise lay down an unarchiving. The trail
    // records acts, not messages.
    expect(audit.written).toEqual([]);
  });

  test("writes nothing when the store refused the report", async () => {
    const audit = recordingAuditStore();
    const store = fakeStore({
      async recordActivity() {
        throw new ChannelNotFoundError("channel_1");
      },
    });

    const response = await reportActivity(appFor(store, audit.store));

    expect(response.status).toBe(404);
    expect(audit.written).toEqual([]);
  });

  test("still answers 204 when the trail is unavailable", async () => {
    const failing: AuditStore = {
      insert: async () => {
        throw new Error("trail unreachable");
      },
    };
    const store = fakeStore({
      async recordActivity() {
        return { restored: true };
      },
    });

    // The message is already stored and the channel already restored by the time this runs. A trail
    // that is briefly unavailable is not a reason to report a failure that did not happen.
    expect((await reportActivity(appFor(store, failing))).status).toBe(204);
  });
});

/**
 * The size of what gets announced, without a database in the way.
 *
 * `pg_notify` refuses a payload over 8000 bytes, and it runs inside the transaction that wrote the
 * row, so an overflow does not lose the announcement — it loses the write.
 */
describe("announcementPayloads", () => {
  function event(memberIds: string[]): RosterActivityEvent {
    return {
      kind: "channel",
      id: "channel_1",
      channelId: "channel_1",
      memberIds,
      // The longest preview `previewOf` can produce, in the widest characters it can produce it in.
      lastMessage: "😀".repeat(200),
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      lastMessageAgentId: "agent_00000000-0000-4000-8000-000000000000",
    };
  }

  test("stays one notification for a channel of the size channels are", () => {
    // What the round-trip tests describe and depend on: one NOTIFY, delivered to both members of a
    // shared channel through one `deliver`. Splitting is what happens past the cap, not by default.
    expect(announcementPayloads(event(["user-1", "user-2"]))).toHaveLength(1);
  });

  test("keeps every payload under the cap however many members hear it", () => {
    const memberIds = Array.from(
      { length: 5_000 },
      (_, at) => `user_${"9".repeat(60)}_${at}`,
    );

    const payloads = announcementPayloads(event(memberIds));

    expect(payloads.length).toBeGreaterThan(1);
    for (const payload of payloads) {
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(8000);
    }
    // The chunks partition the list: everybody is named once, in order, and nobody is named twice. A
    // second copy is a second whole-roster refetch in somebody's tab for nothing.
    expect(
      payloads.flatMap(
        (payload) => (JSON.parse(payload) as RosterActivityEvent).memberIds,
      ),
    ).toEqual(memberIds);
  });

  test("carries the whole event on every payload, not only the first", () => {
    const memberIds = Array.from(
      { length: 500 },
      (_, at) => `user_${"9".repeat(60)}_${at}`,
    );

    const payloads = announcementPayloads({
      ...event(memberIds),
      archived: false,
    });

    expect(payloads.length).toBeGreaterThan(1);
    for (const payload of payloads) {
      // A chunk that dropped `archived` would leave the members it names knowing a message arrived
      // and not knowing the conversation came back, which is the half that moves the row.
      expect(JSON.parse(payload)).toMatchObject({
        kind: "channel",
        id: "channel_1",
        channelId: "channel_1",
        lastMessage: "😀".repeat(200),
        archived: false,
      });
    }
  });
});

describe("ChannelPackageOwnedError", () => {
  test("still says deleted when nobody names an act", () => {
    // The existing delete route constructs it with one argument, and its message must not change.
    expect(new ChannelPackageOwnedError("channel_1").act).toBe("deleted");
  });
});
