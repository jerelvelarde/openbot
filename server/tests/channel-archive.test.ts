import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createChannelEventHub,
  RESYNC_ROSTER_ID,
  type RosterActivityEvent,
} from "../src/channels/events";
import {
  type AgentChannel,
  announcementPayloads,
  ChannelNotFoundError,
  ChannelPackageOwnedError,
  type ChannelStore,
  createChannelRoutes,
  MAX_NOTIFY_PAYLOAD_BYTES,
} from "../src/channels/routes";

/**
 * The caller, described the way the routes describe one.
 *
 * `AuthenticatedActor`, not `AgentActor`: this fixture is set as the Hono context `actor`, which is
 * the wider of the two, and it carries an email the narrower type has no field for. Annotated as
 * `AgentActor` it did not compile — a type error the suite cannot see, because it does not compile its
 * own tests. The store methods below take the narrower type and this is assignable to it.
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

/**
 * Run one request with `console.error` collected, and hand back this surface's structured lines.
 *
 * The tolerant audit recorder swallows a failed write and logs it, which is the whole of what makes
 * a silent trail detectable. Left unstubbed, that line printed into the suite's output on every run
 * and its shape was never checked — which is what `bot-chat-routes.test.ts` does for its own side.
 *
 * Two kinds of line come out of these routes and they are handed back separately, because each test
 * asserts one list is exactly what it expects: `lines` is the audit recorder's, and `failures` is
 * `mapStoreError`'s terminal branch, which logs whatever it could not translate into a status of its
 * own before answering 500.
 */
async function loggedDuring(run: () => Promise<Response>) {
  const lines: Record<string, unknown>[] = [];
  const wasConsoleError = console.error;
  console.error = (line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      // Something else in the process logging prose rather than a structured line. Not ours.
    }
  };
  try {
    const response = await run();
    return {
      response,
      lines: lines.filter((line) => line.type === "channel-audit-write-failed"),
      failures: lines.filter((line) => line.type === "channel-request-failed"),
    };
  } finally {
    console.error = wasConsoleError;
  }
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
      // Stamped at call time, as a real client stamps it. A fixed literal here used to read as though
      // the tests asserted something about that instant; they never did — this file asserts status
      // and audit rows, never the stamp — and `parseActivityInput`'s floor would now rewrite it
      // anyway, so the literal had become actively misleading.
      at: new Date().toISOString(),
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

  test("answers a failed store as JSON, not as Hono's bare 500", async () => {
    /*
     * `client()` in the browser takes its message from `body.error` and falls back to its own sentence
     * when the body is not JSON — and nothing in this server registers an `onError`, so a rethrow from
     * `mapStoreError` reached Hono's default `text/plain "Internal Server Error"`. `GET /api/roster`
     * was fixed to answer `{ error }` with 500 and log a line; while these routes still rethrew, one
     * database blip made the roster readable and the archive on the same row unreadable, which is the
     * split `bot-chats/routes.ts`'s header calls a roster whose rows behave differently depending on
     * which kind they are.
     */
    const store = fakeStore({
      async setArchived() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
    });
    const logged = await loggedDuring(() =>
      archive(appFor(store), { archived: true }),
    );

    expect(logged.response.status).toBe(500);
    expect(logged.response.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(await logged.response.json()).toEqual({
      error: "The server could not complete that request.",
    });
    // What was thrown may name a host or carry a connection string, so the browser gets none of it
    // and the log gets all of it, along with which route it was. A 500 with no log line is an outage
    // nobody can tell from a typo.
    expect(logged.failures).toEqual([
      {
        type: "channel-request-failed",
        method: "PUT",
        path: "/channel_1/archive",
        error: "Error: connect ECONNREFUSED 127.0.0.1:5432",
        note: "A channel route could not be answered. Somebody was shown an error instead of their conversation.",
      },
    ]);
  });

  test("still answers when the trail is unavailable, and says so", async () => {
    const failing: AuditStore = {
      insert: async () => {
        throw new Error("trail unreachable");
      },
    };
    const logged = await loggedDuring(() =>
      archive(appFor(fakeStore(), failing), { archived: true }),
    );

    // The channel is already archived and the caller already told by the time this runs.
    expect(logged.response.status).toBe(200);
    // Swallowed, and said out loud: a trail that quietly stops recording is worse than one that is
    // briefly unavailable, and nothing else can tell. Asserted rather than left to print into the
    // suite's output, where its shape was never checked.
    expect(logged.lines).toEqual([
      {
        type: "channel-audit-write-failed",
        eventType: "channel.archived",
        channelId: "channel_1",
        error: "Error: trail unreachable",
      },
    ]);
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

  test("still answers 204 when the trail is unavailable, and says so", async () => {
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

    const logged = await loggedDuring(() =>
      reportActivity(appFor(store, failing)),
    );

    // The message is already stored and the channel already restored by the time this runs. A trail
    // that is briefly unavailable is not a reason to report a failure that did not happen.
    expect(logged.response.status).toBe(204);
    // And the unarchiving that went unrecorded is named, with the mechanism that distinguishes it
    // from somebody clicking Restore — a reader of the log has the same question a reader of the
    // trail would have had.
    expect(logged.lines).toEqual([
      {
        type: "channel-audit-write-failed",
        eventType: "channel.unarchived",
        channelId: "channel_1",
        error: "Error: trail unreachable",
      },
    ]);
  });
});

/**
 * The size of what gets announced, without a database in the way.
 *
 * `pg_notify` refuses a payload over 8000 bytes, and it runs inside the transaction that wrote the
 * row, so an overflow does not lose the announcement — it loses the write. What is asserted below is
 * `MAX_NOTIFY_PAYLOAD_BYTES` rather than the 8000: the gap between them is a deliberate margin, and a
 * test that only checks the hard limit passes while the margin erodes to nothing.
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

  test("announces nothing at all to nobody", () => {
    /*
     * No members, no payloads — so `announce` sends no `NOTIFY` whatsoever.
     *
     * Unreachable from every caller in `channels/routes.ts` today: `setPinned` names the caller
     * alone, and the other three read `channel_memberships` on a channel whose membership they have
     * just verified, so the list always holds at least the person who acted. Pinned here because the
     * function is exported and tested on its own, and because the emptiness is the one input for
     * which "every member hears it exactly once" and "nothing is sent" are the same sentence.
     */
    expect(announcementPayloads(event([]))).toEqual([]);
  });

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
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(
        MAX_NOTIFY_PAYLOAD_BYTES,
      );
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

/**
 * What this instance sends when its own subscription comes back, and who gets it.
 *
 * `startChannelActivityListener` calls this from `onlisten`, because a NOTIFY published while this
 * server's connection was down is simply gone and the browser cannot tell: its socket stays open
 * across a database reconnect on this side, so its own `onopen` recovery never fires.
 *
 * Asserted without a database, because what matters is the shape rather than the round trip. The
 * payload is what decides what every attached tab does, and the browser's rule for it lives in
 * `applyRosterEventToCaches` (`app/src/lib/channels/use-channel-events.ts`): an event whose `id` no
 * cached list holds is the stale-roster recovery and invalidates the roster, while `deleted` would
 * navigate a tab away from the conversation it names and `pinned`/`archived` would patch or move a
 * row. So the fields that must be absent are what this pins down.
 */
describe("the event hub's resync", () => {
  test("tells every connection of every person, once, and says how many", () => {
    const hub = createChannelEventHub();
    const first: string[] = [];
    const second: string[] = [];
    const other: string[] = [];
    hub.register("user-1", (payload) => first.push(payload));
    // A second tab for the same person, because the reconnect gap is theirs too.
    hub.register("user-1", (payload) => second.push(payload));
    hub.register("user-2", (payload) => other.push(payload));

    expect(hub.resyncAll()).toBe(3);

    for (const heard of [first, second, other]) {
      expect(heard).toHaveLength(1);
      const event = JSON.parse(heard[0] as string) as RosterActivityEvent;
      // An id no roster row can carry: every generated id is prefixed `channel_` or `botchat_`, and
      // `validateTenantPackage` refuses this one as a package channel id, against the same constant
      // asserted here rather than a second copy of the string. It has to miss every cached list for
      // the browser to treat it as a stale roster rather than a row.
      expect(event.id).toBe(RESYNC_ROSTER_ID);
      expect(event.deleted).toBeUndefined();
      expect(event.pinned).toBeUndefined();
      expect(event.archived).toBeUndefined();
    }
  });

  test("tells nobody, and says so, when nothing is attached", () => {
    // The ordinary case at startup, where there is no gap to repair and no socket to repair it on.
    expect(createChannelEventHub().resyncAll()).toBe(0);
  });

  test("does not let one closing connection deny the rest", () => {
    const hub = createChannelEventHub();
    const heard: string[] = [];
    hub.register("user-1", () => {
      throw new Error("socket is closing");
    });
    hub.register("user-2", (payload) => heard.push(payload));

    // A connection that cannot be written to is one whose own close handler will detach it. Counted
    // as not told, because the count is what the log line reports.
    expect(hub.resyncAll()).toBe(1);
    expect(heard).toHaveLength(1);
  });
});
