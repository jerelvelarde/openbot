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
  typefullyDrafts,
  users,
} from "../src/db/schema";
import { createTypefullyRoutes } from "../src/typefully/routes";
import { createTypefullyStore } from "../src/typefully/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const suffix = randomUUID().slice(0, 8);
const ownerId = `typefully-sync-owner-${suffix}`;
const botId = `typefully-sync-bot-${suffix}`;
const channelId = `typefully-sync-channel-${suffix}`;
const draftIds: string[] = [];
const calls: { ref: string; args: Record<string, unknown> }[] = [];
let nextRemoteId = "501";
let failure: { text: string } | null = null;
let thrownFailure: Error | null = null;
const queuedResults: { text: string; isError: boolean }[] = [];

const plugin = {
  decide: async () => ({ allowed: true }) as const,
  callTool: async (input: { ref: string; args: Record<string, unknown> }) => {
    calls.push({ ref: input.ref, args: input.args });
    const queued = queuedResults.shift();
    if (queued) return queued;
    if (thrownFailure) throw thrownFailure;
    if (failure) return { text: failure.text, isError: true };
    return { text: JSON.stringify({ id: nextRemoteId }), isError: false };
  },
};
const store = createTypefullyStore({
  database,
  auditStore: createAuditStore(database),
  plugin: () => plugin,
});
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: ownerId,
    email: `${ownerId}@openbot.test`,
    role: "user",
  });
  await next();
};
const app = new Hono<{ Variables: AppVariables }>();
app.route("/api/typefully", createTypefullyRoutes(store, requireUser));

const document = (text = "First") => ({
  title: "Sync",
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
    .values({ id: ownerId, email: `${ownerId}@openbot.test` });
  await database.insert(agents).values({
    id: botId,
    name: "Typefully Sync Bot",
    type: "remote_ag_ui",
    configuration: {},
  });
  await database.insert(channels).values({
    id: channelId,
    name: channelId,
    description: "Typefully sync fixture",
  });
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: ownerId });
  await database.insert(channelAgents).values({ channelId, agentId: botId });
});

afterAll(async () => {
  await database
    .delete(typefullyDrafts)
    .where(inArray(typefullyDrafts.id, draftIds));
  await database.delete(channelAgents).where(eq(channelAgents.agentId, botId));
  await database
    .delete(channelMemberships)
    .where(eq(channelMemberships.channelId, channelId));
  await database.delete(channels).where(eq(channels.id, channelId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(eq(users.id, ownerId));
});

async function createDraft() {
  const response = await app.request("/api/typefully/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId, botId, document: document() }),
  });
  const body = (await response.json()) as {
    draft: { id: string };
    code?: string;
    message?: string;
  };
  if (!body.draft)
    throw new Error(JSON.stringify({ status: response.status, body }));
  draftIds.push(body.draft.id);
  return body.draft.id;
}

describe("Typefully synchronization", () => {
  test("first sync creates remotely and the next revision updates the same remote id", async () => {
    const id = await createDraft();
    const initial = await app.request(`/api/typefully/drafts/${id}/sync`, {
      method: "POST",
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      draft: { id, version: 1, syncStatus: "synced" },
      remote: { state: "synced", remoteDraftId: "501", confirmedVersion: 1 },
    });
    expect(calls.at(-1)).toMatchObject({ ref: "typefully/create_draft" });

    const save = await app.request(`/api/typefully/drafts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        document: document("Second"),
      }),
    });
    expect(save.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      ref: "typefully/update_draft",
      args: { draftId: 501 },
    });
    const body = await save.json();
    expect(body).toMatchObject({
      draft: { version: 2, syncStatus: "synced" },
      remote: { remoteDraftId: "501", confirmedVersion: 2 },
    });
  });

  test("vendor failure preserves the local revision, records a bounded error, and retry confirms it", async () => {
    const id = await createDraft();
    failure = { text: `vendor failed ${"x".repeat(800)}` };
    const failed = await app.request(`/api/typefully/drafts/${id}/sync`, {
      method: "POST",
    });
    expect(failed.status).toBe(502);
    const failedBody = await failed.json();
    expect(failedBody).toMatchObject({ code: "remote_error" });
    expect(failedBody.message.length).toBeLessThanOrEqual(500);

    const local = await app.request(`/api/typefully/drafts/${id}`);
    expect(await local.json()).toMatchObject({
      draft: { version: 1, document: document(), syncStatus: "remote_error" },
    });

    failure = null;
    nextRemoteId = "502";
    const retried = await app.request(`/api/typefully/drafts/${id}/sync`, {
      method: "POST",
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      draft: { version: 1, syncStatus: "synced" },
      remote: { remoteDraftId: "502", confirmedVersion: 1 },
    });
  });

  test("429 returns one bounded retry time and performs no automatic loop", async () => {
    const id = await createDraft();
    const before = calls.length;
    failure = {
      text: "Typefully rate limited this request (429). Retry-After: 60.",
    };
    const response = await app.request(`/api/typefully/drafts/${id}/sync`, {
      method: "POST",
    });
    failure = null;
    expect(response.status).toBe(502);
    expect(calls.length).toBe(before + 1);
    expect(await response.json()).toMatchObject({
      code: "remote_error",
      retryAt: expect.any(String),
    });
  });

  test("a thrown vendor transport failure is persisted as remote_error", async () => {
    const id = await createDraft();
    thrownFailure = new Error("socket closed before Typefully answered");
    const response = await app.request(`/api/typefully/drafts/${id}/sync`, {
      method: "POST",
    });
    thrownFailure = null;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "remote_error",
      message: "socket closed before Typefully answered",
      draft: { version: 1, syncStatus: "remote_error" },
    });
  });

  test("failed bounded multipart media remains removable", async () => {
    const id = await createDraft();
    failure = { text: "Upload initiation failed." };
    const form = new FormData();
    form.set("expectedVersion", "1");
    form.set("kind", "image");
    form.set("altText", "Release image");
    form.set("file", new File(["image"], "release.png", { type: "image/png" }));
    const uploaded = await app.request(`/api/typefully/drafts/${id}/media`, {
      method: "POST",
      body: form,
    });
    failure = null;
    expect(uploaded.status).toBe(502);
    const uploadedBody = await uploaded.json();
    expect(uploadedBody).toMatchObject({
      code: "remote_error",
      draft: { version: 2, mediaCount: 1 },
      media: { remoteId: null },
    });

    const removed = await app.request(
      `/api/typefully/drafts/${id}/media/${uploadedBody.media.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2 }),
      },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      draft: { version: 3, mediaCount: 0 },
    });
  });

  test("a failed media descriptor can be retried without duplicating it", async () => {
    const id = await createDraft();
    failure = { text: "Upload initiation failed." };
    const first = new FormData();
    first.set("expectedVersion", "1");
    first.set("kind", "image");
    first.set("altText", "Release image");
    first.set(
      "file",
      new File(["image"], "release.png", { type: "image/png" }),
    );
    const failed = await app.request(`/api/typefully/drafts/${id}/media`, {
      method: "POST",
      body: first,
    });
    const failedBody = await failed.json();
    failure = null;

    queuedResults.push(
      {
        text: JSON.stringify({
          id: "media-1",
          upload_url: "https://uploads.typefully.test/presigned",
        }),
        isError: false,
      },
      { text: JSON.stringify({ id: "503" }), isError: false },
    );
    const originalFetch = globalThis.fetch;
    const byteUploads: Request[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      byteUploads.push(new Request(input, init));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const retry = new FormData();
      retry.set("expectedVersion", "2");
      retry.set("mediaId", failedBody.media.id);
      retry.set("kind", "image");
      retry.set("altText", "Release image");
      retry.set(
        "file",
        new File(["image"], "release.png", { type: "image/png" }),
      );
      const retried = await app.request(`/api/typefully/drafts/${id}/media`, {
        method: "POST",
        body: retry,
      });
      expect(retried.status).toBe(201);
      expect(await retried.json()).toMatchObject({
        draft: { version: 3, mediaCount: 1, syncStatus: "synced" },
        media: { id: failedBody.media.id, remoteId: "media-1" },
      });
      expect(byteUploads).toHaveLength(1);
      expect(byteUploads[0]?.method).toBe("PUT");
      expect(byteUploads[0]?.headers.get("content-type")).toBe("image/png");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
