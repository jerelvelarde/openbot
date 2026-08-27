import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
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

const plugin = {
  decide: async (_kind: "mcp" | "skill", _ref: string, agentId: string) =>
    granted && agentId === botId
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: "Grant removed." } as const),
  callTool: async () => {
    throw new ConnectionRequiredError("typefully", "Typefully");
  },
};
const store = createTypefullyStore({
  database,
  auditStore: createAuditStore(database),
  plugin: () => plugin,
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
