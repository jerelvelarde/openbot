import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import type { AuditEventInput, TransactionalAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import type {
  ExternalLinkCreationStore,
  ExternalLinkStore,
} from "../src/external/link-store";
import { mintExternalLinkToken } from "../src/external/link-token";
import { createExternalLinkRoutes } from "../src/external/routes";
import type {
  ExternalThreadBinding,
  ExternalThreadPage,
  ExternalThreadStore,
} from "../src/external/thread-store";
import type { ExternalWebTurnStore } from "../src/external/web-turn-store";
import { testEnvironment } from "./support/environment";

const KEY = "external-link-routes-test-key";
const NOW = 1_700_000_000_000;
const INVALID = "This Slack link has expired or is invalid.";
const CONFLICT = "That Slack identity is already linked.";
const identity = {
  provider: "slack" as const,
  providerTenantId: "T1",
  providerUserId: "U1",
  providerEmail: "person@example.com",
};
const actor = {
  id: "openbot-user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

function fakeAgentProfileStore(
  accessibleIds: readonly string[] = ["risk"],
): Pick<AgentProfileStore, "get" | "listAccessibleIds"> & {
  getCalls: Parameters<AgentProfileStore["get"]>[];
  listAccessibleIdsCalls: Parameters<AgentProfileStore["listAccessibleIds"]>[];
} {
  const getCalls: Parameters<AgentProfileStore["get"]>[] = [];
  const listAccessibleIdsCalls: Parameters<
    AgentProfileStore["listAccessibleIds"]
  >[] = [];
  return {
    getCalls,
    listAccessibleIdsCalls,
    get: async (...args) => {
      getCalls.push(args);
      const id = args[1];
      return id === "risk"
        ? ({ id: "risk", name: "Risk Analyst" } as Awaited<
            ReturnType<AgentProfileStore["get"]>
          >)
        : null;
    },
    listAccessibleIds: async (...args) => {
      listAccessibleIdsCalls.push(args);
      return accessibleIds;
    },
  };
}

const externalThread: ExternalThreadBinding = {
  channelsThreadId: "channels-thread-1",
  provider: "slack",
  providerTenantId: "T1",
  providerConversationId: "C1",
  providerThreadId: "1712345.6789",
  agentId: "risk",
  agentName: "Risk Analyst",
  createdByUserId: actor.id,
  createdAt: new Date(NOW),
};

const externalThreadSummary: ExternalThreadPage["threads"][number] = {
  threadId: externalThread.channelsThreadId,
  provider: "slack",
  agentId: externalThread.agentId,
  agentName: externalThread.agentName,
  lastMessage: "Review the queue",
  lastMessageAt: new Date(NOW + 1_000),
  createdAt: externalThread.createdAt,
};

function fakeThreadStore(
  found: ExternalThreadBinding | null = externalThread,
  messages: Awaited<ReturnType<ExternalThreadStore["getTranscript"]>> = [],
  page: ExternalThreadPage = { threads: [], nextCursor: null },
): ExternalThreadStore & {
  listCalls: Parameters<ExternalThreadStore["listForCreator"]>[];
} {
  const listCalls: Parameters<ExternalThreadStore["listForCreator"]>[] = [];
  return {
    listCalls,
    listForCreator: async (...args) => {
      listCalls.push(args);
      return page;
    },
    getByChannelsThreadId: async (id) =>
      id === found?.channelsThreadId ? found : null,
    getByProviderThread: async () => null,
    bind: async () => {
      throw new Error("unused");
    },
    appendTranscriptTurn: async () => undefined,
    getTranscript: async () => messages,
  };
}

function authenticatedAs(
  authenticatedActor = actor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", authenticatedActor);
    await next();
  };
}

const unauthenticated: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
) => context.json({ error: "Authentication required." }, 401);

function linkFor(openbotUserId: string) {
  return {
    ...identity,
    openbotUserId,
    linkedAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
}

function fakeStore(
  overrides: Partial<ExternalLinkCreationStore> = {},
): ExternalLinkCreationStore & { links: ReturnType<typeof linkFor>[] } {
  const links: ReturnType<typeof linkFor>[] = [];
  async function linkWithStatus(
    input: Parameters<ExternalLinkStore["link"]>[0],
  ) {
    const found = links.find(
      (link) =>
        link.provider === input.provider &&
        link.providerTenantId === input.providerTenantId &&
        link.providerUserId === input.providerUserId,
    );
    if (found?.openbotUserId === input.openbotUserId) {
      return { link: found, created: false };
    }
    if (found) throw new Error(CONFLICT);
    const link = linkFor(input.openbotUserId);
    links.push(link);
    return { link, created: true };
  }
  async function linkWithStatusAndAudit(
    input: Parameters<ExternalLinkStore["link"]>[0],
    recordAudit: () => Promise<void>,
  ) {
    const found = links.find(
      (link) =>
        link.provider === input.provider &&
        link.providerTenantId === input.providerTenantId &&
        link.providerUserId === input.providerUserId,
    );
    if (found?.openbotUserId === input.openbotUserId) {
      return { link: found, created: false };
    }
    if (found) throw new Error(CONFLICT);
    const link = linkFor(input.openbotUserId);
    await recordAudit();
    links.push(link);
    return { link, created: true };
  }
  return Object.assign(
    {
      links,
      async find() {
        return null;
      },
      async findVerifiedUserByEmail() {
        return null;
      },
      linkWithStatus,
      linkWithStatusAndAudit,
      async link(input) {
        return (await linkWithStatus(input)).link;
      },
    } satisfies ExternalLinkCreationStore,
    overrides,
  );
}

/**
 * No thread holds a managed conversation reference by default, which is the
 * live production state: until the managed upstream support ships, every Slack
 * conversation is read-only and the POST route refuses.
 */
function fakeWebTurnStore(
  refs: ReadonlyMap<string, string> = new Map(),
): ExternalWebTurnStore {
  const claims = new Map<string, string>();
  return {
    conversationRef: async (threadId) => refs.get(threadId) ?? null,
    threadsWithConversationRef: async (threadIds) =>
      new Set(threadIds.filter((id) => refs.has(id))),
    claim: async ({ channelsThreadId, idempotencyKey }) => {
      const key = `${channelsThreadId}\u0000${idempotencyKey}`;
      const seen = claims.get(key);
      if (seen) {
        return {
          kind: "duplicate",
          operationId: seen,
          status: "accepted",
          failureCategory: null,
        };
      }
      const operationId = `op-${claims.size + 1}`;
      claims.set(key, operationId);
      return { kind: "claimed", operationId };
    },
  };
}

function appFor(
  store = fakeStore(),
  requireUser = authenticatedAs(),
  rows: AuditEventInput[] = [],
  auditStore: TransactionalAuditStore = {
    insert: async (event) => void rows.push(event),
    inTransaction: () => ({ insert: async (event) => void rows.push(event) }),
  },
  threadStore: ExternalThreadStore = fakeThreadStore(),
  agentProfileStore = fakeAgentProfileStore(),
  webTurnStore: ExternalWebTurnStore = fakeWebTurnStore(),
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/external-links",
    createExternalLinkRoutes({
      store,
      encryptionKey: KEY,
      requireUser,
      auditStore,
      agentProfileStore,
      threadStore,
      webTurnStore,
    }),
  );
  return { app, agentProfileStore, rows, store, webTurnStore };
}

const baseStore: ExternalLinkStore = {
  find: async () => null,
  findVerifiedUserByEmail: async () => null,
  link: async (input) => linkFor(input.openbotUserId),
};

function requestToken(token: string) {
  return `?token=${encodeURIComponent(token)}`;
}

async function liveToken() {
  return mintExternalLinkToken(identity, KEY);
}

describe("external Slack link confirmation routes", () => {
  test("GET /threads returns safe authorized Slack thread summaries", async () => {
    const unsafeSummary = {
      ...externalThreadSummary,
      providerTenantId: "T1",
      providerConversationId: "C1",
      providerThreadId: "1712345.6789",
      createdByUserId: actor.id,
    };
    const { app } = appFor(
      fakeStore(),
      authenticatedAs(),
      [],
      undefined,
      fakeThreadStore(externalThread, [], {
        threads: [unsafeSummary],
        nextCursor: "opaque-next",
      }),
    );

    const response = await app.request(
      "http://openbot.test/api/external-links/threads?limit=1&cursor=opaque-cursor",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      threads: [
        {
          threadId: "channels-thread-1",
          provider: "slack",
          agentId: "risk",
          agentName: "Risk Analyst",
          lastMessage: "Review the queue",
          lastMessageAt: new Date(NOW + 1_000).toISOString(),
          createdAt: new Date(NOW).toISOString(),
          readOnly: true,
        },
      ],
      nextCursor: "opaque-next",
    });
  });

  test("GET /threads passes actor, cursor, limit, and accessible agent ids in one store call", async () => {
    const threadStore = fakeThreadStore();
    const profileStore = fakeAgentProfileStore(["risk", "helper"]);
    const { app } = appFor(
      fakeStore(),
      authenticatedAs(),
      [],
      undefined,
      threadStore,
      profileStore,
    );

    const response = await app.request(
      "http://openbot.test/api/external-links/threads?limit=200&cursor=opaque-cursor",
    );

    expect(response.status).toBe(200);
    expect(threadStore.listCalls).toEqual([
      [
        actor.id,
        { agentIds: ["risk", "helper"], cursor: "opaque-cursor", limit: 200 },
      ],
    ]);
    expect(profileStore.listAccessibleIdsCalls).toEqual([
      [{ id: actor.id, role: actor.role }],
    ]);
    expect(profileStore.getCalls).toEqual([]);
  });

  test("GET /threads rejects unauthenticated callers", async () => {
    const threadStore = fakeThreadStore(externalThread, [], {
      threads: [externalThreadSummary],
      nextCursor: null,
    });
    const { app } = appFor(
      fakeStore(),
      unauthenticated,
      [],
      undefined,
      threadStore,
    );

    const response = await app.request(
      "http://openbot.test/api/external-links/threads",
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(threadStore.listCalls).toEqual([]);
  });

  test("GET /threads rejects invalid limit values", async () => {
    const { app } = appFor();

    for (const limit of ["0", "abc", "201"]) {
      const response = await app.request(
        `http://openbot.test/api/external-links/threads?limit=${limit}`,
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: "Invalid conversation page.",
      });
    }
  });

  test("GET returns an authenticated creator's canonical Slack transcript target", async () => {
    const { app } = appFor();

    const response = await app.request(
      "http://openbot.test/api/external-links/threads/channels-thread-1",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      threadId: "channels-thread-1",
      agentId: "risk",
      agentName: "Risk Analyst",
      provider: "slack",
      readOnly: true,
    });
  });

  test("GET returns the OpenBot-owned durable transcript for an authorized creator", async () => {
    const messages = [
      { id: "user-1", role: "user" as const, content: "Hello" },
      { id: "reply-1", role: "assistant" as const, content: "Hi" },
    ];
    const { app } = appFor(
      fakeStore(),
      authenticatedAs(),
      [],
      undefined,
      fakeThreadStore(externalThread, messages),
    );

    const response = await app.request(
      "http://openbot.test/api/external-links/threads/channels-thread-1/messages",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ messages });
  });

  test("GET hides external transcripts from other users and revoked coworkers", async () => {
    const otherUser = { ...actor, id: "openbot-user-2" } as const;
    const otherUserApp = appFor(fakeStore(), authenticatedAs(otherUser)).app;
    expect(
      (
        await otherUserApp.request(
          "http://openbot.test/api/external-links/threads/channels-thread-1",
        )
      ).status,
    ).toBe(404);

    const revoked = { ...externalThread, agentId: "revoked" };
    const revokedApp = appFor(
      fakeStore(),
      authenticatedAs(),
      [],
      undefined,
      fakeThreadStore(revoked),
    ).app;
    expect(
      (
        await revokedApp.request(
          "http://openbot.test/api/external-links/threads/channels-thread-1",
        )
      ).status,
    ).toBe(404);
  });

  test("POST refuses a web turn while the managed capability is absent", async () => {
    // The live production state. No thread holds a conversation reference, so
    // nothing composed here could reach Slack, and the surface stays read-only
    // rather than accepting a turn it cannot deliver.
    const { app } = appFor();

    const response = await app.request(
      "http://openbot.test/api/external-links/threads/channels-thread-1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "turn-1", text: "follow-up" }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This Slack conversation cannot accept messages from OpenBot yet.",
    });
  });

  test("GET reports the thread writable once a conversation reference exists", async () => {
    const { app } = appFor(
      fakeStore(),
      authenticatedAs(),
      [],
      undefined,
      fakeThreadStore(),
      fakeAgentProfileStore(),
      fakeWebTurnStore(new Map([["channels-thread-1", "cref_v1_managed"]])),
    );

    const response = await app.request(
      "http://openbot.test/api/external-links/threads/channels-thread-1",
    );

    expect(await response.json()).toMatchObject({ readOnly: false });
  });

  test("POST accepts one turn and answers a retry with the same operation", async () => {
    const rows: AuditEventInput[] = [];
    const { app } = appFor(
      fakeStore(),
      authenticatedAs(),
      rows,
      undefined,
      fakeThreadStore(),
      fakeAgentProfileStore(),
      fakeWebTurnStore(new Map([["channels-thread-1", "cref_v1_managed"]])),
    );
    const send = () =>
      app.request(
        "http://openbot.test/api/external-links/threads/channels-thread-1/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "turn-1", text: "follow-up" }),
        },
      );

    const first = await send();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({
      operationId: "op-1",
      status: "accepted",
    });

    // A double tap, a flaky network, a reloaded tab. The same key must return
    // the original operation rather than mint a second Slack message and run.
    const retry = await send();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      operationId: "op-1",
      status: "accepted",
      duplicate: true,
    });

    // One audit record, because only one turn was authored.
    const authored = rows.filter(
      (row) => row.eventType === "external_thread.turn_authored",
    );
    expect(authored).toHaveLength(1);
    // The trail says a turn happened; it must not carry what it said.
    expect(JSON.stringify(authored[0])).not.toContain("follow-up");
  });

  test("POST hides another user's thread and a revoked coworker behind one refusal", async () => {
    const refs = new Map([["channels-thread-1", "cref_v1_managed"]]);
    const body = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "turn-1", text: "follow-up" }),
    };

    const otherUser = { ...actor, id: "openbot-user-2" } as const;
    const otherApp = appFor(
      fakeStore(),
      authenticatedAs(otherUser),
      [],
      undefined,
      fakeThreadStore(),
      fakeAgentProfileStore(),
      fakeWebTurnStore(refs),
    ).app;
    const foreign = await otherApp.request(
      "http://openbot.test/api/external-links/threads/channels-thread-1/messages",
      body,
    );
    expect(foreign.status).toBe(404);

    // Access is re-checked per turn, so losing the coworker stops the sender
    // even though they started the thread.
    const revokedApp = appFor(
      fakeStore(),
      authenticatedAs(),
      [],
      undefined,
      fakeThreadStore({ ...externalThread, agentId: "revoked" }),
      fakeAgentProfileStore(),
      fakeWebTurnStore(refs),
    ).app;
    const revoked = await revokedApp.request(
      "http://openbot.test/api/external-links/threads/channels-thread-1/messages",
      body,
    );
    expect(revoked.status).toBe(404);
  });

  test("POST bounds the turn before anything is claimed", async () => {
    const { app } = appFor(
      fakeStore(),
      authenticatedAs(),
      [],
      undefined,
      fakeThreadStore(),
      fakeAgentProfileStore(),
      fakeWebTurnStore(new Map([["channels-thread-1", "cref_v1_managed"]])),
    );

    for (const payload of [
      null,
      {},
      { id: "turn-1" },
      { id: "turn-1", text: "   " },
      { id: "turn-1", text: "x".repeat(4001) },
      { text: "hello" },
      { id: "", text: "hello" },
      { id: "../escape", text: "hello" },
      { id: "a".repeat(129), text: "hello" },
    ]) {
      const response = await app.request(
        "http://openbot.test/api/external-links/threads/channels-thread-1/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      expect(response.status).toBe(422);
    }
  });

  test("GET shows only the safe Slack display metadata after authentication", async () => {
    const { app } = appFor();
    const token = await liveToken();

    const response = await app.request(
      `http://openbot.test/api/external-links/slack${requestToken(token)}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providerTenantId: "T1",
      providerUserId: "U1",
      providerEmail: "person@example.com",
    });
  });

  test("GET maps a missing or invalid claim to one stable public refusal", async () => {
    const { app } = appFor();
    const expired = await mintExternalLinkToken(identity, KEY, NOW);

    for (const suffix of ["", "?token=invalid", requestToken(expired)]) {
      const response = await app.request(
        `http://openbot.test/api/external-links/slack${suffix}`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: INVALID });
    }
  });

  test("POST uses the authenticated actor rather than a body-supplied user id", async () => {
    const { app, rows, store } = appFor();
    const token = await liveToken();

    const response = await app.request(
      "http://openbot.test/api/external-links/slack",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, openbotUserId: "forged-user" }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: true });
    expect(store.links).toEqual([linkFor(actor.id)]);
    expect(rows).toEqual([
      {
        eventType: "external_identity.linked",
        targetType: "user",
        targetId: actor.id,
        actorUserId: actor.id,
        payload: {
          provider: "slack",
          providerTenantId: "T1",
          providerUserId: "U1",
        },
      },
    ]);
  });

  test("POST is idempotent without duplicating audit when the store returns an existing same-actor link", async () => {
    const { app, store, rows } = appFor();
    const token = await liveToken();

    for (let call = 0; call < 2; call += 1) {
      const response = await app.request(
        "http://openbot.test/api/external-links/slack",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ linked: true });
    }

    expect(store.links).toEqual([linkFor(actor.id)]);
    expect(rows).toHaveLength(1);
  });

  test("rolls back an unauditable creation so a successful retry writes exactly one audit event", async () => {
    const rows: AuditEventInput[] = [];
    let failuresRemaining = 1;
    const auditStore: TransactionalAuditStore = {
      insert: async (event) => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("audit table unavailable");
        }
        rows.push(event);
      },
      inTransaction: () => auditStore,
    };
    const { app, store } = appFor(
      fakeStore(),
      authenticatedAs(),
      rows,
      auditStore,
    );
    const token = await liveToken();
    const request = () =>
      app.request("http://openbot.test/api/external-links/slack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });

    expect((await request()).status).toBe(500);
    expect(store.links).toEqual([]);

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(store.links).toEqual([linkFor(actor.id)]);
    expect(rows).toHaveLength(1);
  });

  test("POST refuses a replay for another actor without reassigning the link", async () => {
    const { app, store, rows } = appFor();
    const token = await liveToken();
    await app.request("http://openbot.test/api/external-links/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

    const differentActor = { ...actor, id: "openbot-user-2" } as const;
    const replay = appFor(store, authenticatedAs(differentActor), rows).app;
    const response = await replay.request(
      "http://openbot.test/api/external-links/slack",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: CONFLICT });
    expect(store.links).toEqual([linkFor(actor.id)]);
    expect(rows).toHaveLength(1);
  });

  test("GET and POST are both rejected without authentication", async () => {
    const { app, store } = appFor(fakeStore(), unauthenticated);
    const token = await liveToken();

    const get = await app.request(
      `http://openbot.test/api/external-links/slack${requestToken(token)}`,
    );
    const post = await app.request(
      "http://openbot.test/api/external-links/slack",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );

    expect(get.status).toBe(401);
    expect(post.status).toBe(401);
    expect(store.links).toEqual([]);
  });

  test("POST maps missing, malformed, and expired tokens to the same public refusal", async () => {
    const { app } = appFor();
    const expired = await mintExternalLinkToken(identity, KEY, NOW);
    const requests = [
      {},
      { body: "{not-json" },
      { body: JSON.stringify({ token: expired }) },
    ];

    for (const request of requests) {
      const response = await app.request(
        "http://openbot.test/api/external-links/slack",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          ...request,
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: INVALID });
    }
  });

  test("createApp mounts the optional external link routes under its authenticated API prefix", async () => {
    const token = await liveToken();
    const externalLinkRoutes = createExternalLinkRoutes({
      store: fakeStore(),
      encryptionKey: KEY,
      requireUser: authenticatedAs(),
      auditStore: {
        insert: async () => undefined,
        inTransaction: () => ({ insert: async () => undefined }),
      },
      agentProfileStore: fakeAgentProfileStore(),
      threadStore: fakeThreadStore(),
    });
    const app = createApp(
      loadConfig(testEnvironment()),
      undefined,
      undefined,
      ...(Array.from({ length: 18 }) as never[]),
      externalLinkRoutes,
    );

    const response = await app.request(
      `http://openbot.test/api/external-links/slack${requestToken(token)}`,
    );

    expect(response.status).toBe(200);
  });

  test("keeps the base external link store usable without confirmation-only methods", async () => {
    await expect(
      baseStore.link({ ...identity, openbotUserId: actor.id }),
    ).resolves.toEqual(linkFor(actor.id));
  });
});
