import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  typefullyDrafts,
  typefullyPublicationProposals,
  users,
} from "../src/db/schema";
import {
  createTypefullyStore,
  DraftNotFoundError,
  GrantRequiredError,
  VersionConflictError,
} from "../src/typefully/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suffix = randomUUID().slice(0, 8);
const ownerId = `typefully-store-owner-${suffix}`;
const otherId = `typefully-store-other-${suffix}`;
const outsiderId = `typefully-store-outsider-${suffix}`;
const botId = `typefully-store-bot-${suffix}`;
const channelId = `typefully-store-channel-${suffix}`;
const otherChannelId = `typefully-store-other-channel-${suffix}`;
const draftIds: string[] = [];
let updateGranted = true;

const plugin = {
  decide: async (_kind: "mcp" | "skill", ref: string, agentId: string) =>
    agentId === botId && (ref !== "typefully/update_draft" || updateGranted)
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: "Grant removed." } as const),
};

const store = createTypefullyStore({
  database,
  auditStore: createAuditStore(database),
  plugin: () => plugin,
  vendor: "typefully",
});

const document = (text = "Ship the local-first editor.") => ({
  title: "Launch",
  destinations: ["linkedin", "x"] as const,
  socialSetId: "social-set-1",
  accountLabel: "OpenBot",
  posts: [{ id: "post-1", x: text, linkedin: text }],
  media: [],
  scheduleAt: null,
});

beforeAll(async () => {
  await database.insert(users).values(
    [ownerId, otherId, outsiderId].map((id) => ({
      id,
      email: `${id}@openbot.test`,
    })),
  );
  await database.insert(agents).values({
    id: botId,
    name: "Typefully Bot",
    type: "remote_ag_ui",
    configuration: {},
  });
  await database.insert(channels).values(
    [channelId, otherChannelId].map((id) => ({
      id,
      name: id,
      description: "Typefully store fixture",
    })),
  );
  await database.insert(channelMemberships).values([
    { channelId, userId: ownerId },
    { channelId, userId: otherId },
    { channelId: otherChannelId, userId: ownerId },
  ]);
  await database.insert(channelAgents).values({ channelId, agentId: botId });
});

afterAll(async () => {
  if (draftIds.length > 0) {
    await database
      .delete(typefullyPublicationProposals)
      .where(inArray(typefullyPublicationProposals.draftId, draftIds));
    await database
      .delete(typefullyDrafts)
      .where(inArray(typefullyDrafts.id, draftIds));
    await database
      .delete(auditEvents)
      .where(inArray(auditEvents.targetId, draftIds));
  }
  await database.delete(channelAgents).where(eq(channelAgents.agentId, botId));
  await database
    .delete(channelMemberships)
    .where(inArray(channelMemberships.userId, [ownerId, otherId, outsiderId]));
  await database
    .delete(channels)
    .where(inArray(channels.id, [channelId, otherChannelId]));
  await database.delete(agents).where(eq(agents.id, botId));
  await database
    .delete(users)
    .where(inArray(users.id, [ownerId, otherId, outsiderId]));
});

async function createOwnedDraft() {
  const created = await store.createDraft({
    ownerUserId: ownerId,
    channelId,
    botId,
    document: document(),
  });
  draftIds.push(created.id);
  return created;
}

describe("owned local Typefully drafts", () => {
  test("creates, reads, canonicalizes, hashes, and retains its originating Bot", async () => {
    const created = await createOwnedDraft();

    expect(created).toMatchObject({
      ownerUserId: ownerId,
      channelId,
      botId,
      version: 1,
      syncStatus: "local",
      remoteDraftId: null,
      remoteVersion: null,
      remoteHash: null,
      lastError: null,
      document: {
        destinations: ["x", "linkedin"],
      },
    });
    expect(created.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.readDraft(created.id, ownerId)).toEqual(created);
  });

  test("uses indistinguishable not-found failures for absent, cross-owner, and non-member reads", async () => {
    const created = await createOwnedDraft();

    for (const operation of [
      store.readDraft(randomUUID(), ownerId),
      store.readDraft(created.id, otherId),
      store.readDraft(created.id, outsiderId),
    ]) {
      await expect(operation).rejects.toEqual(
        expect.objectContaining({
          name: DraftNotFoundError.name,
          code: "draft_not_found",
          status: 404,
          message: "Draft not found",
        }),
      );
    }
  });

  test("refuses creation without membership or the originating Bot attached", async () => {
    await expect(
      store.createDraft({
        ownerUserId: outsiderId,
        channelId,
        botId,
        document: document(),
      }),
    ).rejects.toMatchObject({ code: "draft_not_found", status: 404 });

    await expect(
      store.createDraft({
        ownerUserId: ownerId,
        channelId: otherChannelId,
        botId,
        document: document(),
      }),
    ).rejects.toMatchObject({ code: "bot_not_attached", status: 409 });
  });

  test("saves with optimistic concurrency and invalidates pending proposals atomically", async () => {
    const created = await createOwnedDraft();
    await database.insert(typefullyPublicationProposals).values({
      draftId: created.id,
      ownerUserId: ownerId,
      botId,
      channelId,
      draftVersion: created.version,
      contentHash: created.contentHash,
      snapshot: created.document,
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const saved = await store.saveDraft({
      draftId: created.id,
      actorId: ownerId,
      expectedVersion: 1,
      document: document("Edited locally."),
    });

    expect(saved.version).toBe(2);
    expect(saved.contentHash).not.toBe(created.contentHash);
    expect(saved.document.posts[0]?.x).toBe("Edited locally.");
    expect(saved.syncStatus).toBe("local");
    const [proposal] = await database
      .select({ status: typefullyPublicationProposals.status })
      .from(typefullyPublicationProposals)
      .where(eq(typefullyPublicationProposals.draftId, created.id));
    expect(proposal?.status).toBe("expired");

    await expect(
      store.saveDraft({
        draftId: created.id,
        actorId: ownerId,
        expectedVersion: 1,
        document: document("A stale overwrite."),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: VersionConflictError.name,
        code: "version_conflict",
        status: 409,
        currentVersion: 2,
        currentHash: saved.contentHash,
      }),
    );
    expect((await store.readDraft(created.id, ownerId)).version).toBe(2);
  });

  test("permits local saves after grant revocation and marks remote sync blocked", async () => {
    const created = await createOwnedDraft();
    updateGranted = false;
    try {
      const saved = await store.saveDraft({
        draftId: created.id,
        actorId: ownerId,
        expectedVersion: 1,
        document: document("Preserved after grant removal."),
      });
      expect(saved).toMatchObject({ version: 2, syncStatus: "grant_blocked" });

      await expect(
        store.recordRemoteConfirmation({
          draftId: created.id,
          actorId: ownerId,
          expectedVersion: 2,
          remoteDraftId: "remote-1",
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          name: GrantRequiredError.name,
          code: "grant_required",
          status: 403,
          ref: "typefully/update_draft",
        }),
      );
    } finally {
      updateGranted = true;
    }
  });

  test("records exact remote confirmation and bounded remote failure without changing local content", async () => {
    const created = await createOwnedDraft();
    const confirmed = await store.recordRemoteConfirmation({
      draftId: created.id,
      actorId: ownerId,
      expectedVersion: 1,
      remoteDraftId: "remote-1",
    });
    expect(confirmed).toMatchObject({
      version: 1,
      remoteDraftId: "remote-1",
      remoteVersion: 1,
      remoteHash: created.contentHash,
      syncStatus: "synced",
      lastError: null,
    });

    const failed = await store.recordRemoteFailure({
      draftId: created.id,
      actorId: ownerId,
      expectedVersion: 1,
      error: `vendor refused ${"x".repeat(5_000)}`,
    });
    expect(failed).toMatchObject({
      version: 1,
      contentHash: created.contentHash,
      document: created.document,
      syncStatus: "remote_error",
    });
    expect(failed.lastError?.length).toBeLessThanOrEqual(500);
  });

  test("writes only bounded draft metadata to audit rows", async () => {
    const secretText = `unpublished-${suffix}`;
    const created = await store.createDraft({
      ownerUserId: ownerId,
      channelId,
      botId,
      document: document(secretText),
    });
    draftIds.push(created.id);
    await store.saveDraft({
      draftId: created.id,
      actorId: ownerId,
      expectedVersion: 1,
      document: document(`${secretText}-edited`),
    });

    const rows = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, created.id));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const encoded = JSON.stringify(row.payload);
      expect(encoded).not.toContain(secretText);
      expect(Object.keys(row.payload).sort()).toEqual([
        "botId",
        "channelId",
        "destinations",
        "hash",
        "ownerUserId",
        "status",
        "version",
      ]);
    }
  });
});
