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
import {
  ConnectionRequiredError,
  PluginRefusedError,
} from "../src/plugins/store";
import { createTypefullyRestTransport } from "../src/plugins/typefully-rest";
import { createTypefullyRoutes } from "../src/typefully/routes";
import {
  BotNotAttachedError,
  createTypefullyStore,
} from "../src/typefully/store";
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
const restStatuses: number[] = [];
const queuedResults: Array<
  | {
      text: string;
      isError: boolean;
      sideEffectOutcome?: "definitely_not_applied" | "uncertain";
    }
  | Error
> = [];
const deniedRefs = new Set<string>();
let vendorGate: { entered: () => void; wait: Promise<void> } | null = null;
let decisionHook: ((ref: string) => Promise<void>) | null = null;

const plugin = {
  decide: async (_kind: "mcp" | "skill", ref: string) => {
    await decisionHook?.(ref);
    return deniedRefs.has(ref)
      ? ({ allowed: false, reason: "Grant removed." } as const)
      : ({ allowed: true } as const);
  },
  dispatchVendor: async (input: {
    ref: string;
    args: Record<string, unknown>;
  }) => {
    calls.push({ ref: input.ref, args: input.args });
    if (vendorGate) {
      vendorGate.entered();
      await vendorGate.wait;
    }
    const queued = queuedResults.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    const restStatus = restStatuses.shift();
    if (restStatus !== undefined) {
      const transport = createTypefullyRestTransport(
        (async () =>
          new Response(JSON.stringify({ message: "temporary failure" }), {
            status: restStatus,
            headers: restStatus === 429 ? { "retry-after": "60" } : undefined,
          })) as typeof fetch,
      );
      return transport.callTool(
        { url: "https://api.typefully.com/v2", token: "tf-test-key" },
        input.ref.split("/").at(-1) ?? "",
        input.args,
      );
    }
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
let uploadStatus = 200;
const byteUploads: Array<{ url: string; address: string; bytes: number }> = [];
app.route(
  "/api/typefully",
  createTypefullyRoutes(store, requireUser, {
    mediaUpload: {
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      put: async ({ url, address, bytes }) => {
        byteUploads.push({
          url: url.toString(),
          address: address.address,
          bytes: bytes.byteLength,
        });
        return uploadStatus;
      },
    },
  }),
);

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

async function syncDraft(id: string) {
  const loaded = await app.request(`/api/typefully/drafts/${id}`);
  const authority = (await loaded.json()) as {
    draft: { version: number; contentHash: string };
  };
  return app.request(`/api/typefully/drafts/${id}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: authority.draft.version,
      expectedHash: authority.draft.contentHash,
    }),
  });
}

describe("Typefully synchronization", () => {
  function deferred() {
    let resolve!: () => void;
    const wait = new Promise<void>((done) => {
      resolve = done;
    });
    return { wait, resolve };
  }
  test("first sync creates remotely and the next revision updates the same remote id", async () => {
    const id = await createDraft();
    const initial = await syncDraft(id);
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
    const failed = await syncDraft(id);
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
    const retried = await syncDraft(id);
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
    const response = await syncDraft(id);
    failure = null;
    expect(response.status).toBe(502);
    expect(calls.length).toBe(before + 1);
    expect(await response.json()).toMatchObject({
      code: "remote_error",
      retryAt: expect.any(String),
    });
  });

  test("accepts a valid HTTP-date Retry-After without retrying", async () => {
    const id = await createDraft();
    const date = new Date(Date.now() + 30_000).toUTCString();
    const before = calls.length;
    failure = {
      text: `Typefully rate limited this request (429). Retry-After: ${date}.`,
    };
    const response = await syncDraft(id);
    failure = null;
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(Date.parse(body.retryAt)).toBeGreaterThan(Date.now());
    expect(calls.length).toBe(before + 1);
  });

  test("makes malformed successful create ids require reconciliation", async () => {
    for (const invalid of ["", "0", "9007199254740992"]) {
      const id = await createDraft();
      queuedResults.push({
        text: JSON.stringify({ id: invalid }),
        isError: false,
      });
      const response = await syncDraft(id);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "reconciliation_required",
        draftId: id,
      });
      const callsAfter = calls.length;
      const retry = await syncDraft(id);
      expect(retry.status).toBe(409);
      expect(calls.length).toBe(callsAfter);
    }
  });

  test("an ambiguous create transport failure cannot be blindly retried", async () => {
    const id = await createDraft();
    queuedResults.push({
      text: "Typefully could not be reached.",
      isError: true,
      sideEffectOutcome: "uncertain",
    });
    const response = await syncDraft(id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "reconciliation_required",
      draftId: id,
    });
  });

  test("real REST write statuses quarantine uncertain creates and retry explicit refusals", async () => {
    for (const status of [408, 500, 502, 503, 504]) {
      const id = await createDraft();
      const before = calls.length;
      restStatuses.push(status);
      const uncertain = await syncDraft(id);
      expect(uncertain.status).toBe(409);
      expect(await uncertain.json()).toMatchObject({
        code: "reconciliation_required",
        draftId: id,
      });
      const repeated = await syncDraft(id);
      expect(repeated.status).toBe(409);
      expect(calls).toHaveLength(before + 1);
    }

    for (const status of [422, 429]) {
      const id = await createDraft();
      const before = calls.length;
      restStatuses.push(status);
      const refused = await syncDraft(id);
      expect(refused.status).toBe(502);
      expect((await store.readDraft(id, ownerId)).attemptId).toBeNull();
      const retried = await syncDraft(id);
      expect(retried.status).toBe(200);
      expect(calls).toHaveLength(before + 2);
    }
  });

  test("reconciles one uncertain create without a second POST and updates that attached id thereafter", async () => {
    const id = await createDraft();
    const before = calls.length;
    queuedResults.push({
      text: "Typefully could not be reached.",
      isError: true,
      sideEffectOutcome: "uncertain",
    });
    const uncertain = await syncDraft(id);
    expect(uncertain.status).toBe(409);
    expect(calls.length).toBe(before + 1);

    const repeated = await syncDraft(id);
    expect(repeated.status).toBe(409);
    expect(calls.length).toBe(before + 1);

    const reconciled = await app.request(
      `/api/typefully/drafts/${id}/reconcile`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 1, remoteDraftId: "901" }),
      },
    );
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({
      draft: { id, version: 1, syncStatus: "synced" },
      remote: { remoteDraftId: "901", confirmedVersion: 1 },
    });

    nextRemoteId = "901";
    const updated = await app.request(`/api/typefully/drafts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        document: document("After owner reconciliation"),
      }),
    });
    expect(updated.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      ref: "typefully/update_draft",
      args: { draftId: 901 },
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

  test.each([
    { existingOrders: [1], expectedOrder: 2 },
    { existingOrders: [0, 5], expectedOrder: 6 },
  ])(
    "allocates a new media descriptor after gapped orders $existingOrders",
    async ({ existingOrders, expectedOrder }) => {
      const id = await createDraft();
      const current = await store.readDraft(id, ownerId);
      const seededMedia = existingOrders.map((order) => ({
        id: `seed-${order}`,
        kind: "image" as const,
        order,
        altText: `Seed ${order}`,
        remoteId: `remote-seed-${order}`,
      }));
      const seeded = await store.saveDraft({
        draftId: id,
        actorId: ownerId,
        expectedVersion: current.version,
        document: { ...current.document, media: seededMedia },
      });
      failure = { text: "Upload initiation failed." };
      try {
        const form = new FormData();
        form.set("expectedVersion", String(seeded.version));
        form.set("kind", "image");
        form.set("altText", "Gap-safe upload");
        form.set("file", new File(["image"], "gap.png", { type: "image/png" }));
        const response = await app.request(
          `/api/typefully/drafts/${id}/media`,
          { method: "POST", body: form },
        );
        expect(response.status).toBe(502);
        const body = await response.json();
        expect(body).toMatchObject({
          code: "remote_error",
          draft: {
            version: seeded.version + 1,
            mediaCount: seededMedia.length + 1,
          },
          media: { order: expectedOrder, remoteId: null },
        });
        const stored = await store.readDraft(id, ownerId);
        expect(stored.document.media.map((media) => media.order)).toEqual([
          ...existingOrders,
          expectedOrder,
        ]);
        expect(
          new Set(stored.document.media.map((media) => media.order)).size,
        ).toBe(stored.document.media.length);
      } finally {
        failure = null;
      }
    },
  );

  test.each([
    {
      name: "maximum order",
      orders: [19],
    },
    {
      name: "media capacity",
      orders: Array.from({ length: 20 }, (_, order) => order),
    },
  ])(
    "refuses $name before persisting or calling Typefully",
    async ({ orders }) => {
      const id = await createDraft();
      const current = await store.readDraft(id, ownerId);
      const seeded = await store.saveDraft({
        draftId: id,
        actorId: ownerId,
        expectedVersion: current.version,
        document: {
          ...current.document,
          media: orders.map((order) => ({
            id: `capacity-${order}`,
            kind: "image" as const,
            order,
            altText: "",
            remoteId: `remote-capacity-${order}`,
          })),
        },
      });
      const beforeCalls = calls.length;
      const form = new FormData();
      form.set("expectedVersion", String(seeded.version));
      form.set("kind", "image");
      form.set("altText", "Refused upload");
      form.set(
        "file",
        new File(["image"], "refused.png", { type: "image/png" }),
      );

      const response = await app.request(`/api/typefully/drafts/${id}/media`, {
        method: "POST",
        body: form,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
      expect(calls).toHaveLength(beforeCalls);
      const unchanged = await store.readDraft(id, ownerId);
      expect(unchanged.version).toBe(seeded.version);
      expect(unchanged.document.media.map((media) => media.order)).toEqual(
        orders,
      );
    },
  );

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
    byteUploads.length = 0;
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
    expect(byteUploads[0]?.bytes).toBe(5);
  });

  test("does not forward media bytes through a presigned redirect", async () => {
    const id = await createDraft();
    queuedResults.push({
      text: JSON.stringify({
        id: "media-redirect",
        upload_url: "https://uploads.typefully.test/presigned",
      }),
      isError: false,
    });
    byteUploads.length = 0;
    uploadStatus = 307;
    const form = new FormData();
    form.set("expectedVersion", "1");
    form.set("kind", "image");
    form.set("altText", "Release image");
    form.set("file", new File(["image"], "release.png", { type: "image/png" }));
    const response = await app.request(`/api/typefully/drafts/${id}/media`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(409);
    const uncertain = await response.json();
    expect(uncertain).toMatchObject({
      code: "reconciliation_required",
      draftId: id,
      draft: { version: 3, syncStatus: "remote_error" },
    });
    expect(byteUploads).toHaveLength(1);
    const retry = new FormData();
    retry.set("expectedVersion", "3");
    retry.set("mediaId", uncertain.media.id);
    retry.set("kind", "image");
    retry.set("altText", "Release image");
    retry.set(
      "file",
      new File(["image"], "release.png", { type: "image/png" }),
    );
    const blocked = await app.request(`/api/typefully/drafts/${id}/media`, {
      method: "POST",
      body: retry,
    });
    expect(blocked.status).toBe(409);
    expect(byteUploads).toHaveLength(1);
    uploadStatus = 200;
  });

  test("quarantines ambiguous and malformed media initiation without a second allocation", async () => {
    for (const result of [
      {
        text: "Typefully could not be reached.",
        isError: true,
        sideEffectOutcome: "uncertain" as const,
      },
      { text: '{"unexpected":true}', isError: false },
    ]) {
      const id = await createDraft();
      queuedResults.push(result);
      byteUploads.length = 0;
      const before = calls.filter(
        (call) => call.ref === "typefully/upload_media",
      ).length;
      const form = new FormData();
      form.set("expectedVersion", "1");
      form.set("kind", "image");
      form.set("altText", "Uncertain allocation");
      form.set(
        "file",
        new File(["image"], "uncertain.png", { type: "image/png" }),
      );
      const first = await app.request(`/api/typefully/drafts/${id}/media`, {
        method: "POST",
        body: form,
      });
      expect(first.status).toBe(409);
      const body = await first.json();
      expect(body).toMatchObject({
        code: "reconciliation_required",
        draft: { version: 2, syncStatus: "remote_error" },
      });
      const quarantined = await store.readDraft(id, ownerId);
      const descriptor = quarantined.document.media[0];
      const mediaId = descriptor?.id;
      expect(mediaId).toBeString();
      expect(body.media).toEqual(descriptor);

      const retry = new FormData();
      retry.set("expectedVersion", "2");
      retry.set("mediaId", mediaId as string);
      retry.set("kind", "image");
      retry.set("altText", "Uncertain allocation");
      retry.set(
        "file",
        new File(["image"], "uncertain.png", { type: "image/png" }),
      );
      const repeated = await app.request(`/api/typefully/drafts/${id}/media`, {
        method: "POST",
        body: retry,
      });
      expect(repeated.status).toBe(409);
      expect(
        calls.filter((call) => call.ref === "typefully/upload_media"),
      ).toHaveLength(before + 1);
      expect(byteUploads).toHaveLength(0);
    }
  });

  test("real REST timeout and server statuses quarantine media allocation without retrying bytes", async () => {
    for (const status of [408, 500, 502, 503, 504]) {
      const id = await createDraft();
      restStatuses.push(status);
      byteUploads.length = 0;
      const before = calls.length;
      const form = new FormData();
      form.set("expectedVersion", "1");
      form.set("kind", "image");
      form.set("altText", "Uncertain REST allocation");
      form.set(
        "file",
        new File(["image"], "uncertain.png", { type: "image/png" }),
      );
      const first = await app.request(`/api/typefully/drafts/${id}/media`, {
        method: "POST",
        body: form,
      });
      expect(first.status).toBe(409);
      expect(await first.json()).toMatchObject({
        code: "reconciliation_required",
        draftId: id,
      });
      const quarantined = await store.readDraft(id, ownerId);
      const mediaId = quarantined.document.media[0]?.id;
      expect(mediaId).toBeString();

      const retry = new FormData();
      retry.set("expectedVersion", String(quarantined.version));
      retry.set("mediaId", mediaId as string);
      retry.set("kind", "image");
      retry.set("altText", "Uncertain REST allocation");
      retry.set(
        "file",
        new File(["image"], "uncertain.png", { type: "image/png" }),
      );
      const repeated = await app.request(`/api/typefully/drafts/${id}/media`, {
        method: "POST",
        body: retry,
      });
      expect(repeated.status).toBe(409);
      expect(calls).toHaveLength(before + 1);
      expect(byteUploads).toHaveLength(0);
    }
  });

  test("uses upload and remove grants independently from draft update", async () => {
    const id = await createDraft();
    deniedRefs.add("typefully/upload_media");
    const deniedUpload = new FormData();
    deniedUpload.set("expectedVersion", "1");
    deniedUpload.set("kind", "image");
    deniedUpload.set("altText", "Release image");
    deniedUpload.set(
      "file",
      new File(["image"], "release.png", { type: "image/png" }),
    );
    const upload = await app.request(`/api/typefully/drafts/${id}/media`, {
      method: "POST",
      body: deniedUpload,
    });
    deniedRefs.delete("typefully/upload_media");
    expect(upload.status).toBe(403);
    expect(await upload.json()).toEqual({
      code: "grant_required",
      ref: "typefully/upload_media",
    });

    const afterDenied = await store.readDraft(id, ownerId);
    expect(afterDenied).toMatchObject({ version: 1 });
    expect(afterDenied.document.media).toEqual([]);
    const mediaId = "media-remove-grant";
    await store.saveDraft({
      draftId: id,
      actorId: ownerId,
      expectedVersion: afterDenied.version,
      document: {
        ...afterDenied.document,
        media: [
          {
            id: mediaId,
            kind: "image",
            order: 0,
            altText: "Remove grant",
            remoteId: null,
          },
        ],
      },
    });
    deniedRefs.add("typefully/update_draft");
    const removed = await app.request(
      `/api/typefully/drafts/${id}/media/${mediaId}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2 }),
      },
    );
    deniedRefs.delete("typefully/update_draft");
    expect(removed.status).toBe(200);

    const secondId = await createDraft();
    failure = { text: "Upload failed." };
    const failedForm = new FormData();
    failedForm.set("expectedVersion", "1");
    failedForm.set("kind", "image");
    failedForm.set("altText", "Release image");
    failedForm.set(
      "file",
      new File(["image"], "release.png", { type: "image/png" }),
    );
    const failed = await app.request(
      `/api/typefully/drafts/${secondId}/media`,
      {
        method: "POST",
        body: failedForm,
      },
    );
    failure = null;
    const failedBody = await failed.json();
    deniedRefs.add("typefully/remove_media");
    const deniedRemove = await app.request(
      `/api/typefully/drafts/${secondId}/media/${failedBody.media.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2 }),
      },
    );
    deniedRefs.delete("typefully/remove_media");
    expect(deniedRemove.status).toBe(403);
    expect(await deniedRemove.json()).toEqual({
      code: "grant_required",
      ref: "typefully/remove_media",
    });
  });

  test("media upload connection failure returns its persisted authoritative descriptor", async () => {
    const id = await createDraft();
    thrownFailure = new ConnectionRequiredError("typefully", "Typefully");
    const form = new FormData();
    form.set("expectedVersion", "1");
    form.set("kind", "image");
    form.set("altText", "Disconnected upload");
    form.set(
      "file",
      new File(["image"], "disconnected.png", { type: "image/png" }),
    );
    const response = await app.request(`/api/typefully/drafts/${id}/media`, {
      method: "POST",
      body: form,
    });
    thrownFailure = null;
    expect(response.status).toBe(409);
    const body = await response.json();
    const stored = await store.readDraft(id, ownerId);
    const descriptor = stored.document.media[0];
    expect(body).toMatchObject({
      code: "connection_required",
      draftId: id,
      draft: { id, version: 2, mediaCount: 1 },
      media: { remoteId: null },
    });
    expect(body.media).toEqual(descriptor);
    expect(stored).toMatchObject({ version: 2, syncStatus: "remote_error" });
  });

  test("media upload plugin refusal returns its persisted authoritative descriptor", async () => {
    const id = await createDraft();
    queuedResults.push(new PluginRefusedError("Policy refused upload.", null));
    const form = new FormData();
    form.set("expectedVersion", "1");
    form.set("kind", "image");
    form.set("altText", "Policy refused upload");
    form.set("file", new File(["image"], "refused.png", { type: "image/png" }));
    const response = await app.request(`/api/typefully/drafts/${id}/media`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    const stored = await store.readDraft(id, ownerId);
    expect(body).toMatchObject({
      code: "remote_refused",
      draft: { id, version: 2, mediaCount: 1 },
      media: { altText: "Policy refused upload", remoteId: null },
    });
    expect(body.media).toEqual(stored.document.media[0]);
    expect(stored).toMatchObject({ version: 2, syncStatus: "remote_error" });
  });

  test("a detached Bot blocks media upload without recording a remote failure", async () => {
    const id = await createDraft();
    await database
      .delete(channelAgents)
      .where(eq(channelAgents.agentId, botId));
    try {
      const form = new FormData();
      form.set("expectedVersion", "1");
      form.set("kind", "image");
      form.set("altText", "Release image");
      form.set(
        "file",
        new File(["image"], "release.png", { type: "image/png" }),
      );
      const response = await app.request(`/api/typefully/drafts/${id}/media`, {
        method: "POST",
        body: form,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "bot_not_attached" });
      const local = await app.request(`/api/typefully/drafts/${id}`);
      expect(await local.json()).toMatchObject({
        draft: {
          version: 1,
          syncStatus: "local",
          document: { media: [] },
        },
      });
    } finally {
      await database.insert(channelAgents).values({
        channelId,
        agentId: botId,
      });
    }
  });

  test("a failed old snapshot releases a newer local revision for retry", async () => {
    const id = await createDraft();
    const entered = deferred();
    const release = deferred();
    vendorGate = { entered: entered.resolve, wait: release.wait };
    failure = { text: "The claimed revision failed remotely." };
    const firstSync = syncDraft(id);
    await entered.wait;
    const saved = await app.request(`/api/typefully/drafts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        document: document("Newer after failure"),
      }),
    });
    expect(saved.status).toBe(200);
    release.resolve();
    vendorGate = null;
    const failed = await firstSync;
    failure = null;
    expect(failed.status).toBe(502);

    const local = await app.request(`/api/typefully/drafts/${id}`);
    expect(await local.json()).toMatchObject({
      draft: {
        version: 2,
        syncStatus: "local",
        document: document("Newer after failure"),
      },
    });
    nextRemoteId = "602";
    const retry = await syncDraft(id);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      draft: { version: 2, syncStatus: "synced" },
      remote: { remoteDraftId: "602", confirmedVersion: 2 },
    });
  });

  test("pins the outbound snapshot and reconciles a first remote id across a concurrent local save", async () => {
    const id = await createDraft();
    const entered = deferred();
    const release = deferred();
    vendorGate = { entered: entered.resolve, wait: release.wait };
    nextRemoteId = "601";
    const firstSync = syncDraft(id);
    await entered.wait;
    const saved = await app.request(`/api/typefully/drafts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        document: document("Newer local"),
      }),
    });
    expect(saved.status).toBe(200);
    release.resolve();
    vendorGate = null;
    expect((await firstSync).status).toBe(200);

    const local = await app.request(`/api/typefully/drafts/${id}`);
    expect(await local.json()).toMatchObject({
      draft: {
        version: 2,
        remoteDraftId: "601",
        remoteVersion: 1,
        syncStatus: "local",
        document: document("Newer local"),
      },
    });
    const reconciled = await syncDraft(id);
    expect(reconciled.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      ref: "typefully/update_draft",
      args: { draftId: 601 },
    });
  });

  test("admits only one concurrent first remote create", async () => {
    const id = await createDraft();
    const entered = deferred();
    const release = deferred();
    vendorGate = { entered: entered.resolve, wait: release.wait };
    const before = calls.length;
    const first = syncDraft(id);
    await entered.wait;
    const second = await syncDraft(id);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ code: "sync_in_progress" });
    expect(calls.length).toBe(before + 1);
    release.resolve();
    vendorGate = null;
    expect((await first).status).toBe(200);
  });

  test("serializes existing-draft updates until the older snapshot settles", async () => {
    const id = await createDraft();
    nextRemoteId = "701";
    expect((await syncDraft(id)).status).toBe(200);
    const firstEntered = deferred();
    const overlap = deferred();
    const release = deferred();
    let entries = 0;
    vendorGate = {
      entered: () => {
        entries += 1;
        if (entries === 1) firstEntered.resolve();
        if (entries === 2) overlap.resolve();
      },
      wait: release.wait,
    };
    const before = calls.length;
    const older = app.request(`/api/typefully/drafts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        document: document("Older outbound update"),
      }),
    });
    await firstEntered.wait;
    const newer = app.request(`/api/typefully/drafts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 2,
        document: document("Newer local update"),
      }),
    });
    const winner = await Promise.race([
      newer.then(() => "saved" as const),
      overlap.wait.then(() => "overlap" as const),
    ]);
    const callsBeforeRelease = calls.length;
    release.resolve();
    vendorGate = null;
    expect((await older).status).toBe(200);
    expect((await newer).status).toBe(200);
    expect(winner).toBe("saved");
    expect(callsBeforeRelease).toBe(before + 1);

    const local = await app.request(`/api/typefully/drafts/${id}`);
    expect(await local.json()).toMatchObject({
      draft: {
        version: 3,
        remoteVersion: 2,
        syncStatus: "local",
        document: document("Newer local update"),
      },
    });
    const retry = await syncDraft(id);
    expect(retry.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      ref: "typefully/update_draft",
      args: {
        draftId: 701,
        platforms: {
          x: { posts: [{ text: "Newer local update" }] },
          linkedin: { posts: [{ text: "Newer local update" }] },
        },
      },
    });
  });

  test("keeps sync and a second media workflow off the vendor while an upload claim is held", async () => {
    const id = await createDraft();
    nextRemoteId = "910";
    expect((await syncDraft(id)).status).toBe(200);

    const entered = deferred();
    const release = deferred();
    vendorGate = { entered: entered.resolve, wait: release.wait };
    queuedResults.push({
      text: JSON.stringify({
        id: "remote-overlap-first",
        upload_url: "https://uploads.typefully.example/overlap-first",
      }),
      isError: false,
    });
    const first = new FormData();
    first.set("expectedVersion", "1");
    first.set("kind", "image");
    first.set("altText", "First overlap");
    first.set("file", new File(["first"], "first.png", { type: "image/png" }));
    const uploading = app.request(`/api/typefully/drafts/${id}/media`, {
      method: "POST",
      body: first,
    });
    await entered.wait;
    const callsWhileHeld = calls.length;

    const sync = await syncDraft(id);
    expect(sync.status).toBe(409);
    expect(await sync.json()).toEqual({ code: "sync_in_progress" });

    const second = new FormData();
    second.set("expectedVersion", "2");
    second.set("kind", "image");
    second.set("altText", "Second overlap");
    second.set(
      "file",
      new File(["second"], "second.png", { type: "image/png" }),
    );
    const overlappingMedia = await app.request(
      `/api/typefully/drafts/${id}/media`,
      { method: "POST", body: second },
    );
    expect(overlappingMedia.status).toBe(409);
    expect(await overlappingMedia.json()).toMatchObject({
      code: "sync_in_progress",
      draft: { id, version: 3, mediaCount: 2 },
      media: { altText: "Second overlap", remoteId: null },
    });
    expect(calls.length).toBe(callsWhileHeld);

    release.resolve();
    vendorGate = null;
    const quarantined = await uploading;
    expect(quarantined.status).toBe(409);
    expect(await quarantined.json()).toMatchObject({
      code: "reconciliation_required",
    });
    const local = await store.readDraft(id, ownerId);
    expect(local).toMatchObject({
      version: 3,
      syncStatus: "remote_error",
      attemptKind: "upload_media",
      attemptState: "outcome_uncertain",
      attemptRemoteDraftId: "remote-overlap-first",
    });
    expect(local.document.media).toHaveLength(2);
    expect(local.document.media.every((media) => media.remoteId === null)).toBe(
      true,
    );
    const firstMediaId = local.document.media[0]?.id;
    expect(firstMediaId).toBeString();
    const recovered = await app.request(
      `/api/typefully/drafts/${id}/media/${firstMediaId}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: local.version }),
      },
    );
    expect(recovered.status).toBe(200);
    expect(await store.readDraft(id, ownerId)).toMatchObject({
      attemptId: null,
      syncStatus: "synced",
    });
  });

  test("returns the re-read quarantined authority when an expired upload lease is discovered", async () => {
    const id = await createDraft();
    const base = await store.readDraft(id, ownerId);
    const media = {
      id: "expired-upload-media",
      kind: "image" as const,
      order: 0,
      altText: "Expired upload",
      remoteId: null,
    };
    const saved = await store.saveDraft({
      draftId: id,
      actorId: ownerId,
      expectedVersion: base.version,
      document: { ...base.document, media: [media] },
    });
    await database
      .update(typefullyDrafts)
      .set({
        attemptId: randomUUID(),
        attemptKind: "upload_media",
        attemptState: "in_flight",
        attemptVersion: saved.version,
        attemptHash: saved.contentHash,
        attemptLeaseExpiresAt: new Date(Date.now() - 60_000),
        syncStatus: "syncing",
      })
      .where(eq(typefullyDrafts.id, id));

    const form = new FormData();
    form.set("expectedVersion", String(saved.version));
    form.set("mediaId", media.id);
    form.set("kind", media.kind);
    form.set("altText", media.altText);
    form.set("file", new File(["image"], "expired.png", { type: "image/png" }));
    const response = await app.request(`/api/typefully/drafts/${id}/media`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    const current = await store.readDraft(id, ownerId);
    expect(body).toMatchObject({
      code: "reconciliation_required",
      draft: {
        id,
        version: current.version,
        syncStatus: "remote_error",
      },
      media,
    });
    expect(current).toMatchObject({
      attemptKind: "upload_media",
      attemptState: "outcome_uncertain",
      syncStatus: "remote_error",
    });
    expect(body.media).toEqual(current.document.media[0]);
  });

  test("does not return a captured media descriptor after a concurrent removal", async () => {
    const id = await createDraft();
    let uploadDecisions = 0;
    decisionHook = async (ref) => {
      if (ref !== "typefully/upload_media" || ++uploadDecisions !== 2) return;
      decisionHook = null;
      const current = await store.readDraft(id, ownerId);
      await store.saveDraft({
        draftId: id,
        actorId: ownerId,
        expectedVersion: current.version,
        document: { ...current.document, media: [] },
      });
    };
    try {
      const form = new FormData();
      form.set("expectedVersion", "1");
      form.set("kind", "image");
      form.set("altText", "Concurrently removed");
      form.set(
        "file",
        new File(["image"], "removed.png", { type: "image/png" }),
      );
      const response = await app.request(`/api/typefully/drafts/${id}/media`, {
        method: "POST",
        body: form,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "version_conflict",
        currentVersion: 3,
      });
      const current = await store.readDraft(id, ownerId);
      expect(current.version).toBe(3);
      expect(current.document.media).toEqual([]);
    } finally {
      decisionHook = null;
    }
  });

  test("releases a first-create claim after connection loss advances the local revision", async () => {
    const id = await createDraft();
    const entered = deferred();
    const release = deferred();
    vendorGate = { entered: entered.resolve, wait: release.wait };
    thrownFailure = new ConnectionRequiredError("typefully", "Typefully");
    const syncing = syncDraft(id);
    await entered.wait;
    const saved = await app.request(`/api/typefully/drafts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        document: document("Saved while disconnected"),
      }),
    });
    expect(saved.status).toBe(200);
    release.resolve();
    vendorGate = null;
    const refusal = await syncing;
    thrownFailure = null;
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toMatchObject({
      code: "connection_required",
      draftId: id,
    });
    const local = await app.request(`/api/typefully/drafts/${id}`);
    expect(await local.json()).toMatchObject({
      draft: {
        version: 2,
        syncStatus: "connection_required",
        document: document("Saved while disconnected"),
      },
    });
    nextRemoteId = "702";
    expect((await syncDraft(id)).status).toBe(200);
  });

  test("releases a first-create claim after policy refusal advances the local revision", async () => {
    const id = await createDraft();
    const entered = deferred();
    const release = deferred();
    vendorGate = { entered: entered.resolve, wait: release.wait };
    thrownFailure = new PluginRefusedError("Policy changed.", null);
    const syncing = syncDraft(id);
    await entered.wait;
    const saved = await app.request(`/api/typefully/drafts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        document: document("Saved after refusal"),
      }),
    });
    expect(saved.status).toBe(200);
    release.resolve();
    vendorGate = null;
    const refusal = await syncing;
    thrownFailure = null;
    expect(refusal.status).toBe(403);
    const local = await app.request(`/api/typefully/drafts/${id}`);
    expect(await local.json()).toMatchObject({
      draft: {
        version: 2,
        syncStatus: "grant_blocked",
        document: document("Saved after refusal"),
      },
    });
    nextRemoteId = "703";
    expect((await syncDraft(id)).status).toBe(200);
  });

  test("releases a first-create claim after attachment loss advances the local revision", async () => {
    const id = await createDraft();
    const entered = deferred();
    const release = deferred();
    vendorGate = { entered: entered.resolve, wait: release.wait };
    thrownFailure = new BotNotAttachedError();
    const syncing = syncDraft(id);
    await entered.wait;
    const saved = await app.request(`/api/typefully/drafts/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 1,
        document: document("Saved after attachment loss"),
      }),
    });
    expect(saved.status).toBe(200);
    release.resolve();
    vendorGate = null;
    const refusal = await syncing;
    thrownFailure = null;
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toEqual({ code: "bot_not_attached" });
    const local = await app.request(`/api/typefully/drafts/${id}`);
    expect(await local.json()).toMatchObject({
      draft: {
        version: 2,
        syncStatus: "grant_blocked",
        document: document("Saved after attachment loss"),
      },
    });
  });

  test("media DELETE is stale-safe, local-first, exhaustive, and syncs its exact revision", async () => {
    const id = await createDraft();
    nextRemoteId = "704";
    expect((await syncDraft(id)).status).toBe(200);
    const current = await store.readDraft(id, ownerId);
    const withMedia = await store.saveDraft({
      draftId: id,
      actorId: ownerId,
      expectedVersion: current.version,
      document: {
        ...document("One"),
        posts: [
          { id: "post-1", x: "One", linkedin: "One" },
          { id: "post-2", x: "Two", linkedin: "Two" },
        ],
        media: [
          {
            id: "media-all",
            kind: "image",
            order: 0,
            altText: "Every post",
            remoteId: "remote-media-all",
          },
        ],
      },
    });
    expect((await syncDraft(id)).status).toBe(200);

    const beforeStale = calls.length;
    const stale = await app.request(
      `/api/typefully/drafts/${id}/media/media-all`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: withMedia.version - 1 }),
      },
    );
    expect(stale.status).toBe(409);
    expect(calls.length).toBe(beforeStale);

    const beforeDelete = calls.length;
    const removed = await app.request(
      `/api/typefully/drafts/${id}/media/media-all`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: withMedia.version }),
      },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      draft: { version: withMedia.version + 1, mediaCount: 0 },
      remote: { confirmedVersion: withMedia.version + 1, state: "synced" },
    });
    const deleteCalls = calls.slice(beforeDelete);
    expect(
      deleteCalls
        .filter((call) => call.ref === "typefully/remove_media")
        .map((call) => [call.args.platform, call.args.postIndex]),
    ).toEqual([
      ["x", 0],
      ["x", 1],
      ["linkedin", 0],
      ["linkedin", 1],
    ]);
    expect(deleteCalls.at(-1)).toMatchObject({
      ref: "typefully/update_draft",
      args: {
        platforms: {
          x: { posts: [{ text: "One" }, { text: "Two" }] },
          linkedin: { posts: [{ text: "One" }, { text: "Two" }] },
        },
      },
    });
  });

  test("failed remote media removal is explicit and retryable from the saved local revision", async () => {
    const id = await createDraft();
    nextRemoteId = "705";
    expect((await syncDraft(id)).status).toBe(200);
    const current = await store.readDraft(id, ownerId);
    const withMedia = await store.saveDraft({
      draftId: id,
      actorId: ownerId,
      expectedVersion: current.version,
      document: {
        ...current.document,
        media: [
          {
            id: "media-failure",
            kind: "image",
            order: 0,
            altText: "Retry me",
            remoteId: "remote-media-failure",
          },
        ],
      },
    });
    failure = { text: "Remote remove failed." };
    const removed = await app.request(
      `/api/typefully/drafts/${id}/media/media-failure`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: withMedia.version }),
      },
    );
    failure = null;
    expect(removed.status).toBe(502);
    expect(await removed.json()).toMatchObject({
      code: "remote_error",
      draft: { version: withMedia.version + 1, syncStatus: "remote_error" },
    });
    const local = await store.readDraft(id, ownerId);
    expect(local.document.media).toEqual([]);
    const retry = await syncDraft(id);
    expect(retry.status).toBe(200);
  });

  test("a partial remote removal exception releases its claim and remains recoverable", async () => {
    const id = await createDraft();
    nextRemoteId = "911";
    expect((await syncDraft(id)).status).toBe(200);
    const current = await store.readDraft(id, ownerId);
    const withMedia = await store.saveDraft({
      draftId: id,
      actorId: ownerId,
      expectedVersion: current.version,
      document: {
        ...current.document,
        media: [
          {
            id: "media-partial",
            kind: "image",
            order: 0,
            altText: "Partially removed",
            remoteId: "remote-media-partial",
          },
        ],
      },
    });
    queuedResults.push(
      { text: '{"removed":true}', isError: false },
      new ConnectionRequiredError("typefully", "Typefully"),
    );
    const before = calls.length;
    const removed = await app.request(
      `/api/typefully/drafts/${id}/media/media-partial`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: withMedia.version }),
      },
    );
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({
      code: "connection_required",
      draftId: id,
    });
    const local = await store.readDraft(id, ownerId);
    expect(local).toMatchObject({
      version: withMedia.version + 1,
      syncStatus: "remote_error",
      attemptId: null,
      lastError: expect.stringContaining("partial remote media removal"),
    });
    expect(local.document.media).toEqual([]);
    expect(
      calls
        .slice(before)
        .filter((call) => call.ref === "typefully/remove_media"),
    ).toHaveLength(2);

    nextRemoteId = "911";
    const reconciled = await syncDraft(id);
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({
      draft: { version: local.version, syncStatus: "synced", mediaCount: 0 },
      remote: { remoteDraftId: "911", confirmedVersion: local.version },
    });
    expect(calls.at(-1)).toMatchObject({
      ref: "typefully/update_draft",
      args: { draftId: 911 },
    });
  });

  test("media DELETE connection_required includes the saved draft id", async () => {
    const id = await createDraft();
    nextRemoteId = "706";
    expect((await syncDraft(id)).status).toBe(200);
    const current = await store.readDraft(id, ownerId);
    const withMedia = await store.saveDraft({
      draftId: id,
      actorId: ownerId,
      expectedVersion: current.version,
      document: {
        ...current.document,
        media: [
          {
            id: "media-disconnected",
            kind: "image",
            order: 0,
            altText: "Disconnected",
            remoteId: "remote-media-disconnected",
          },
        ],
      },
    });
    thrownFailure = new ConnectionRequiredError("typefully", "Typefully");
    const removed = await app.request(
      `/api/typefully/drafts/${id}/media/media-disconnected`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: withMedia.version }),
      },
    );
    thrownFailure = null;
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({
      code: "connection_required",
      serverId: "typefully",
      draftId: id,
      connectPath: "/settings/connected-accounts/typefully",
    });
    const released = await store.readDraft(id, ownerId);
    expect(released).toMatchObject({
      syncStatus: "remote_error",
      attemptId: null,
    });
    nextRemoteId = "706";
    const immediate = await syncDraft(id);
    expect(immediate.status).toBe(200);
  });
});
