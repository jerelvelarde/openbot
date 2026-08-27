import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createApp } from "../src/app";
import { createAuditStore, type TransactionalAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  mcpServers,
  mcpTools,
  pluginGrants,
  typefullyDrafts,
  users,
} from "../src/db/schema";
import {
  ConnectionRequiredError,
  createPluginStore,
} from "../src/plugins/store";
import { createTypefullyRoutes } from "../src/typefully/routes";
import { createTypefullyStore } from "../src/typefully/store";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const suffix = randomUUID().slice(0, 8);
const ownerId = `typefully-route-owner-${suffix}`;
const outsiderId = `typefully-route-outsider-${suffix}`;
const botId = `typefully-route-bot-${suffix}`;
const channelId = `typefully-route-channel-${suffix}`;
const draftIds: string[] = [];
let actorId = ownerId;
let granted = true;
let routeRemoteDocument: unknown;
let routePublishCalls = 0;

const plugin = {
  decide: async (_kind: "mcp" | "skill", _ref: string, agentId: string) =>
    granted && agentId === botId
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: "Grant removed." } as const),
  dispatchVendor: async () => {
    throw new ConnectionRequiredError("typefully", "Typefully");
  },
  authorizeOperation: async () => ({ token: "route-personal-key" }),
};
const store = createTypefullyStore({
  database,
  auditStore: createAuditStore(database),
  plugin: () => plugin,
  publicationVendor: {
    fetchDraft: async () => ({ document: routeRemoteDocument }),
    publishDraft: async () => {
      routePublishCalls += 1;
      return { outcome: "published", vendorResultId: "route-published" };
    },
    reconcileDraft: async () => ({ outcome: "unknown" }),
  },
});
const governedPluginStore = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async () => {
      throw new Error("local Typefully drafting must not resolve a credential");
    },
    create: async () => {
      throw new Error("not used");
    },
    updateSecret: async () => {
      throw new Error("not used");
    },
    revoke: async () => new Date(),
  },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
  firstPartyTool: store.callBotTool,
});
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: actorId,
    email: `${actorId}@openbot.test`,
    role: "user",
  });
  await next();
};
const app = new Hono<{ Variables: AppVariables }>();
app.route("/api/typefully", createTypefullyRoutes(store, requireUser));

const document = (text = "Local-first drafting") => ({
  title: "Launch",
  destinations: ["x", "linkedin"],
  socialSetId: "12",
  accountLabel: "OpenBot",
  posts: [{ id: "post-1", x: text, linkedin: text }],
  media: [],
  scheduleAt: null,
});

beforeAll(async () => {
  await database
    .insert(users)
    .values(
      [ownerId, outsiderId].map((id) => ({ id, email: `${id}@openbot.test` })),
    );
  await database.insert(agents).values({
    id: botId,
    name: "Typefully Route Bot",
    type: "remote_ag_ui",
    configuration: {},
  });
  await database.insert(channels).values({
    id: channelId,
    name: channelId,
    description: "Typefully route fixture",
  });
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: ownerId });
  await database.insert(channelAgents).values({ channelId, agentId: botId });
  await database
    .insert(mcpServers)
    .values({
      id: "typefully",
      title: "Typefully",
      vendor: "Typefully",
      url: "https://api.typefully.com/v2",
      provenance: "first-party",
    })
    .onConflictDoNothing();
  for (const name of ["create_draft", "update_draft"]) {
    await database
      .insert(mcpTools)
      .values({ serverId: "typefully", name, description: name })
      .onConflictDoNothing();
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: `typefully/${name}`, agentId: botId })
      .onConflictDoNothing();
  }
});

afterAll(async () => {
  await database
    .delete(typefullyDrafts)
    .where(inArray(typefullyDrafts.id, draftIds));
  await database.delete(channelAgents).where(eq(channelAgents.agentId, botId));
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database
    .delete(channelMemberships)
    .where(eq(channelMemberships.channelId, channelId));
  await database.delete(channels).where(eq(channels.id, channelId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(inArray(users.id, [ownerId, outsiderId]));
});

async function createDraft() {
  const response = await app.request("/api/typefully/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId, botId, document: document() }),
  });
  const body = (await response.json()) as {
    draft: { id: string; version: number };
    code?: string;
    message?: string;
  };
  if (!body.draft)
    throw new Error(JSON.stringify({ status: response.status, body }));
  draftIds.push(body.draft.id);
  return { response, body };
}

describe("Typefully draft routes", () => {
  test("proposal routes prepare, privately load, and publish only after the human endpoint", async () => {
    const { body } = await createDraft();
    const local = await store.readDraft(body.draft.id, ownerId);
    routeRemoteDocument = local.document;
    const synced = await store.recordRemoteConfirmation({
      draftId: local.id,
      actorId: ownerId,
      expectedVersion: local.version,
      expectedHash: local.contentHash,
      remoteDraftId: "222",
    });
    routePublishCalls = 0;
    const prepared = await app.request(
      `/api/typefully/drafts/${local.id}/proposals`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: synced.version }),
      },
    );
    expect(prepared.status).toBe(201);
    const preparedBody = (await prepared.json()) as {
      proposal: { id: string; status: string; snapshot?: unknown };
    };
    expect(preparedBody.proposal).toMatchObject({ status: "pending" });
    expect(preparedBody.proposal).not.toHaveProperty("snapshot");
    expect(routePublishCalls).toBe(0);

    actorId = outsiderId;
    const hidden = await app.request(
      `/api/typefully/proposals/${preparedBody.proposal.id}`,
    );
    actorId = ownerId;
    expect(hidden.status).toBe(404);

    const loaded = await app.request(
      `/api/typefully/proposals/${preparedBody.proposal.id}`,
    );
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toMatchObject({
      proposal: { snapshot: local.document, status: "pending" },
    });

    const published = await app.request(
      `/api/typefully/proposals/${preparedBody.proposal.id}/publish`,
      { method: "POST" },
    );
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({
      proposal: { status: "published", vendorResultId: "route-published" },
    });
    expect(routePublishCalls).toBe(1);
  });

  test("a stale publish grant cannot surface or cross the signed plugin boundary", async () => {
    const staleRef = "typefully/publish_now";
    await governedPluginStore.refreshTools("typefully");
    const refreshed = await database
      .select({ name: mcpTools.name })
      .from(mcpTools)
      .where(eq(mcpTools.serverId, "typefully"));
    expect(refreshed.map((tool) => tool.name)).toContain("prepare_publication");
    expect(
      refreshed.some(
        (tool) =>
          tool.name !== "prepare_publication" &&
          /publish|publication/i.test(tool.name),
      ),
    ).toBe(false);
    await database.insert(pluginGrants).values({
      kind: "mcp",
      ref: staleRef,
      agentId: botId,
    });
    try {
      const listed = await governedPluginStore.listForAgent(botId);
      expect(listed.tools.map((tool) => tool.ref)).not.toContain(staleRef);
      await expect(
        governedPluginStore.callTool({
          ref: staleRef,
          args: {},
          botId,
          actorId: ownerId,
        }),
      ).rejects.toMatchObject({ name: "PluginRefusedError" });
    } finally {
      await database
        .delete(pluginGrants)
        .where(
          and(eq(pluginGrants.ref, staleRef), eq(pluginGrants.agentId, botId)),
        );
    }
  });

  test("create returns a bounded summary and GET returns the authoritative document", async () => {
    const { response, body } = await createDraft();
    expect(response.status).toBe(201);
    expect(body.draft).toMatchObject({
      title: "Launch",
      destinations: ["x", "linkedin"],
      version: 1,
      syncStatus: "local",
    });
    expect(body.draft).not.toHaveProperty("document");
    expect(body.draft).not.toHaveProperty("ownerUserId");

    const get = await app.request(`/api/typefully/drafts/${body.draft.id}`);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      draft: { id: body.draft.id, document: document(), version: 1 },
    });
  });

  test("a non-owner cannot discover or read the full draft", async () => {
    const { body } = await createDraft();
    actorId = outsiderId;
    const response = await app.request(
      `/api/typefully/drafts/${body.draft.id}`,
    );
    actorId = ownerId;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "draft_not_found" });
  });

  test("creation distinguishes channel access and Bot attachment refusals", async () => {
    actorId = outsiderId;
    const channelRefusal = await app.request("/api/typefully/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId, botId, document: document() }),
    });
    actorId = ownerId;
    expect(channelRefusal.status).toBe(403);
    expect(await channelRefusal.json()).toEqual({ code: "channel_forbidden" });

    const botRefusal = await app.request("/api/typefully/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId,
        botId: `not-attached-${suffix}`,
        document: document(),
      }),
    });
    expect(botRefusal.status).toBe(409);
    expect(await botRefusal.json()).toEqual({ code: "bot_not_attached" });
  });

  test("creation requires the current create grant and persists nothing when refused", async () => {
    const whereOwnerChannel = and(
      eq(typefullyDrafts.ownerUserId, ownerId),
      eq(typefullyDrafts.channelId, channelId),
    );
    const before = await database
      .select({ id: typefullyDrafts.id })
      .from(typefullyDrafts)
      .where(whereOwnerChannel);
    granted = false;
    try {
      const response = await app.request("/api/typefully/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, botId, document: document() }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        code: "grant_required",
        ref: "typefully/create_draft",
      });
    } finally {
      granted = true;
    }
    const after = await database
      .select({ id: typefullyDrafts.id })
      .from(typefullyDrafts)
      .where(whereOwnerChannel);
    expect(after).toHaveLength(before.length);
  });

  test("PUT saves locally and stale updates expose only the current version and hash", async () => {
    const { body } = await createDraft();
    const saved = await app.request(`/api/typefully/drafts/${body.draft.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        document: document("Revision two"),
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      draft: { id: body.draft.id, version: 2 },
      remote: { state: "connection_required" },
    });

    const stale = await app.request(`/api/typefully/drafts/${body.draft.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, document: document("Stale") }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "version_conflict",
      currentVersion: 2,
      currentHash: expect.any(String),
    });
  });

  test("sync without a personal key returns stable connection_required JSON", async () => {
    const { body } = await createDraft();
    const response = await app.request(
      `/api/typefully/drafts/${body.draft.id}/sync`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "connection_required",
      serverId: "typefully",
      draftId: body.draft.id,
      connectPath: "/settings/connected-accounts/typefully",
    });
  });

  test("the governed agent-tool seam creates and updates locally before any key exists", async () => {
    const created = await governedPluginStore.callTool({
      ref: "typefully/create_draft",
      args: { channelId, document: document("From a signed run") },
      botId,
      actorId: ownerId,
    });
    expect(created.isError).toBe(false);
    const createdSummary = JSON.parse(created.text);
    draftIds.push(createdSummary.id);
    expect(createdSummary).toMatchObject({
      title: "Launch",
      version: 1,
      syncStatus: "local",
    });
    expect(createdSummary).not.toHaveProperty("document");

    const updated = await governedPluginStore.callTool({
      ref: "typefully/update_draft",
      args: {
        draftId: createdSummary.id,
        expectedVersion: 1,
        document: document("Revised by the same signed actor"),
      },
      botId,
      actorId: ownerId,
    });
    expect(JSON.parse(updated.text)).toMatchObject({
      id: createdSummary.id,
      version: 2,
    });
  });

  test("outcome-audit failure cannot turn completed local or vendor work into a retryable failure", async () => {
    const baseAudit = createAuditStore(database);
    const failingOutcomeAudit: TransactionalAuditStore = {
      insert: async () => {
        throw new Error("audit storage unavailable");
      },
      inTransaction: baseAudit.inTransaction,
    };
    const remoteServerId = `audit-outcome-${suffix}`;
    const remoteRef = `${remoteServerId}/mutate`;
    await database.insert(mcpServers).values({
      id: remoteServerId,
      title: "Outcome audit fixture",
      vendor: "test",
      url: "https://vendor.invalid/mcp",
      provenance: "custom",
    });
    await database.insert(mcpTools).values({
      serverId: remoteServerId,
      name: "mutate",
      description: "Completes one remote mutation.",
      inputSchema: { type: "object", additionalProperties: false },
    });
    await database.insert(pluginGrants).values({
      kind: "mcp",
      ref: remoteRef,
      agentId: botId,
    });
    let vendorCalls = 0;
    let privateVendorDispatch:
      | ((input: {
          ref: string;
          args: Record<string, unknown>;
          botId: string;
          actorId: string;
        }) => Promise<{ text: string; isError: boolean }>)
      | undefined;
    const hardened = createPluginStore({
      database,
      auditStore: failingOutcomeAudit,
      credentials: {
        readSecret: async () => null,
        create: async () => {
          throw new Error("not used");
        },
        updateSecret: async () => {
          throw new Error("not used");
        },
        revoke: async () => new Date(),
      },
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
      firstPartyTool: store.callBotTool,
      callVendor: async () => {
        vendorCalls += 1;
        return {
          text: JSON.stringify({ completed: vendorCalls }),
          isError: false,
        };
      },
      vendorDispatcherReady: (dispatch) => {
        privateVendorDispatch = dispatch;
      },
    });
    const originalConsoleError = console.error;
    const operationalErrors: string[] = [];
    console.error = (message?: unknown) => {
      operationalErrors.push(String(message));
    };
    try {
      const local = await hardened.callTool({
        ref: "typefully/create_draft",
        args: { channelId, document: document("Audit write failed locally") },
        botId,
        actorId: ownerId,
        // Public, string-keyed flags are data only. They cannot select the private vendor path.
        vendorDispatch: true,
        __vendorDispatch: true,
      } as Parameters<typeof hardened.callTool>[0]);
      expect(local.isError).toBe(false);
      const localId = JSON.parse(local.text).id as string;
      draftIds.push(localId);
      expect((await store.readDraft(localId, ownerId)).version).toBe(1);
      expect(vendorCalls).toBe(0);

      const remote = await hardened.callTool({
        ref: remoteRef,
        args: {},
        botId,
        actorId: ownerId,
      });
      expect(remote).toEqual({ text: '{"completed":1}', isError: false });
      expect(vendorCalls).toBe(1);
      expect(privateVendorDispatch).toBeDefined();
      const closureResult = await privateVendorDispatch?.({
        ref: remoteRef,
        args: {},
        botId,
        actorId: ownerId,
      });
      expect(closureResult).toEqual({
        text: '{"completed":2}',
        isError: false,
      });
      expect(vendorCalls).toBe(2);

      const auditRows = await database
        .select({ eventType: auditEvents.eventType })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, remoteRef));
      expect(auditRows).toEqual([]);
      expect(operationalErrors).toHaveLength(3);
      for (const error of operationalErrors) {
        expect(JSON.parse(error)).toMatchObject({
          type: "mcp-outcome-audit-write-failed",
          eventType: "mcp.call_succeeded",
          failureClass: "Error",
        });
      }
    } finally {
      console.error = originalConsoleError;
      await database
        .delete(pluginGrants)
        .where(eq(pluginGrants.ref, remoteRef));
      await database
        .delete(mcpTools)
        .where(eq(mcpTools.serverId, remoteServerId));
      await database
        .delete(mcpServers)
        .where(eq(mcpServers.id, remoteServerId));
    }
  });

  test("the signed agent callback preserves actor and Bot identity for local drafts", async () => {
    const token = "typefully-agent-callback-token";
    const config = loadConfig(
      testEnvironment({
        AGENT_TOOL_TOKEN: token,
        KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
      }),
    );
    const callbackApp = createApp(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { agentForCallbackToken: async () => null } as never,
      undefined,
      undefined,
      createAuditStore(database),
      undefined,
      governedPluginStore,
    );
    const run = mintRunAssertion(
      { botId, actorId: ownerId, runId: `typefully-run-${suffix}` },
      config.keyEncryptionKey,
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await callbackApp.request("/api/agent-tools/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": token,
        },
        body: JSON.stringify({ name, args, run }),
      });
      return await response.json();
    };
    const created = await call("mcp__typefully__create_draft", {
      channelId,
      document: document("Signed callback"),
    });
    const createdSummary = JSON.parse(created.text);
    draftIds.push(createdSummary.id);
    expect(createdSummary).toMatchObject({
      title: "Launch",
      socialSetLabel: "OpenBot",
      version: 1,
    });
    expect(createdSummary).not.toHaveProperty("document");
    const persisted = await store.readDraft(createdSummary.id, ownerId);
    expect(persisted).toMatchObject({ ownerUserId: ownerId, botId });

    const updated = await call("mcp__typefully__update_draft", {
      draftId: createdSummary.id,
      expectedVersion: 1,
      document: document("Signed callback update"),
    });
    expect(JSON.parse(updated.text)).toMatchObject({
      id: createdSummary.id,
      version: 2,
      socialSetLabel: "OpenBot",
    });
    await database
      .delete(channelAgents)
      .where(eq(channelAgents.agentId, botId));
    const detached = await call("mcp__typefully__update_draft", {
      draftId: createdSummary.id,
      expectedVersion: 2,
      document: document("Must not persist"),
    });
    expect(detached.isError).toBe(true);
    expect(detached.text).not.toContain("Must not persist");
    expect((await store.readDraft(createdSummary.id, ownerId)).version).toBe(2);
    await database
      .insert(channelAgents)
      .values({ channelId, agentId: botId })
      .onConflictDoNothing();
  });

  test("generic MCP audit rows never retain vendor error text", async () => {
    const unpublished = `unpublished-post-${randomUUID()}`;
    const leakServerId = `audit-leak-${suffix}`;
    const leakRef = `${leakServerId}/echo_error`;
    await database.insert(mcpServers).values({
      id: leakServerId,
      title: "Audit leak test",
      vendor: "test",
      url: "https://vendor.invalid/mcp",
      provenance: "custom",
    });
    await database.insert(mcpTools).values({
      serverId: leakServerId,
      name: "echo_error",
      description: "Returns a vendor error.",
      inputSchema: { type: "object", additionalProperties: true },
    });
    await database.insert(pluginGrants).values({
      kind: "mcp",
      ref: leakRef,
      agentId: botId,
    });
    const leakingStore = createPluginStore({
      database,
      auditStore: createAuditStore(database),
      credentials: {
        readSecret: async () => null,
        create: async () => {
          throw new Error("not used");
        },
        updateSecret: async () => {
          throw new Error("not used");
        },
        revoke: async () => new Date(),
      },
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
      callVendor: async () => ({ text: unpublished, isError: true }),
    });
    try {
      await leakingStore.callTool({
        ref: leakRef,
        args: { draft: unpublished },
        botId,
        actorId: ownerId,
      });
      const rows = await database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, leakRef));
      const latest = rows.at(-1)?.payload;
      expect(JSON.stringify(latest)).not.toContain(unpublished);
      expect(latest).toMatchObject({ failureClass: "tool_reported_error" });
    } finally {
      await database.delete(pluginGrants).where(eq(pluginGrants.ref, leakRef));
      await database
        .delete(mcpTools)
        .where(eq(mcpTools.serverId, leakServerId));
      await database.delete(mcpServers).where(eq(mcpServers.id, leakServerId));
    }
  });

  test("bounds multipart streams before parsing without trusting Content-Length", async () => {
    const oversizedRequest = (declared?: string) => {
      const chunk = new Uint8Array(13_100_000);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Request(
        "http://openbot.test/api/typefully/drafts/nope/media",
        {
          method: "POST",
          headers: {
            "content-type": "multipart/form-data; boundary=bounded-test",
            ...(declared === undefined ? {} : { "content-length": declared }),
          },
          body,
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      );
    };
    for (const declared of [undefined, "not-a-number"]) {
      const response = await app.request(oversizedRequest(declared));
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ code: "media_too_large" });
    }
  });

  test("a revoked grant blocks remote sync but preserves a local PUT", async () => {
    const { body } = await createDraft();
    granted = false;
    const saved = await app.request(`/api/typefully/drafts/${body.draft.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        document: document("Safe locally"),
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      draft: { version: 2, syncStatus: "grant_blocked" },
      remote: { state: "grant_blocked" },
    });
    const sync = await app.request(
      `/api/typefully/drafts/${body.draft.id}/sync`,
      {
        method: "POST",
      },
    );
    granted = true;
    expect(sync.status).toBe(403);
    expect(await sync.json()).toEqual({
      code: "grant_required",
      ref: "typefully/create_draft",
    });
  });
});
