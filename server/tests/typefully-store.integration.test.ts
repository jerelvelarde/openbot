import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  type AuditEventInput,
  createAuditStore,
  type TransactionalAuditStore,
} from "../src/audit";
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
  VersionConflictError,
} from "../src/typefully/store";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const suffix = randomUUID().slice(0, 8);
const ownerId = `typefully-store-owner-${suffix}`;
const otherId = `typefully-store-other-${suffix}`;
const outsiderId = `typefully-store-outsider-${suffix}`;
const botId = `typefully-store-bot-${suffix}`;
const channelId = `typefully-store-channel-${suffix}`;
const otherChannelId = `typefully-store-other-channel-${suffix}`;
const draftIds: string[] = [];
let updateGranted = true;
let createGranted = true;
const decidedRefs: string[] = [];

const plugin = {
  decide: async (_kind: "mcp" | "skill", ref: string, agentId: string) => {
    decidedRefs.push(ref);
    const granted = ref.endsWith("/create_draft")
      ? createGranted
      : updateGranted;
    return agentId === botId && granted
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: "Grant removed." } as const);
  },
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

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function waitForMutationBlock(
  applicationName: string,
  mutationSettled: () => boolean,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows = await database.execute(sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND cardinality(pg_blocking_pids(pid)) > 0
      LIMIT 1
    `);
    if (rows.length > 0) return true;
    if (mutationSettled()) return false;
  }
  throw new Error(`Timed out observing blocked session ${applicationName}.`);
}

function pausingAuditStore(
  entered: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>,
): TransactionalAuditStore {
  const base = createAuditStore(database);
  return {
    insert: base.insert,
    inTransaction: (transaction) => {
      const transactional = base.inTransaction(transaction);
      return {
        insert: async (event: AuditEventInput) => {
          try {
            await transactional.insert(event);
            entered.resolve();
            await release.promise;
          } catch (error) {
            entered.reject(error);
            throw error;
          }
        },
      };
    },
  };
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
      () => store.readDraft(randomUUID(), ownerId),
      () => store.readDraft(created.id, otherId),
      () => store.readDraft(created.id, outsiderId),
    ]) {
      await expect(operation()).rejects.toEqual(
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
    const preflight = await store.authorizeRemoteOperation({
      draftId: created.id,
      actorId: ownerId,
    });
    expect(preflight).toMatchObject({
      ref: "typefully/create_draft",
      draft: { id: created.id, version: 1 },
    });
    createGranted = false;
    updateGranted = false;
    try {
      await expect(
        store.authorizeRemoteOperation({
          draftId: created.id,
          actorId: ownerId,
        }),
      ).rejects.toMatchObject({
        code: "grant_required",
        status: 403,
        ref: "typefully/create_draft",
      });

      const saved = await store.saveDraft({
        draftId: created.id,
        actorId: ownerId,
        expectedVersion: 1,
        document: document("Preserved after grant removal."),
      });
      expect(saved).toMatchObject({ version: 2, syncStatus: "grant_blocked" });

      const confirmed = await store.recordRemoteConfirmation({
        draftId: created.id,
        actorId: ownerId,
        expectedVersion: 2,
        remoteDraftId: "remote-after-revocation",
      });
      expect(confirmed).toMatchObject({
        remoteDraftId: "remote-after-revocation",
        remoteVersion: 2,
        syncStatus: "synced",
      });

      const failed = await store.recordRemoteFailure({
        draftId: created.id,
        actorId: ownerId,
        expectedVersion: 2,
        error: "Vendor failed after authorization.",
      });
      expect(failed.syncStatus).toBe("remote_error");
    } finally {
      createGranted = true;
      updateGranted = true;
    }
  });

  test("uses asymmetric create and update grants for preflight and advisory local-save status", async () => {
    const localOnly = await createOwnedDraft();
    createGranted = false;
    updateGranted = true;
    try {
      await expect(
        store.authorizeRemoteOperation({
          draftId: localOnly.id,
          actorId: ownerId,
        }),
      ).rejects.toMatchObject({
        code: "grant_required",
        status: 403,
        ref: "typefully/create_draft",
      });
      const locallySaved = await store.saveDraft({
        draftId: localOnly.id,
        actorId: ownerId,
        expectedVersion: 1,
        document: document("Create denied, local save retained."),
      });
      expect(locallySaved).toMatchObject({
        version: 2,
        syncStatus: "grant_blocked",
      });
    } finally {
      createGranted = true;
      updateGranted = true;
    }

    const remoteBacked = await createOwnedDraft();
    await store.recordRemoteConfirmation({
      draftId: remoteBacked.id,
      actorId: ownerId,
      expectedVersion: 1,
      remoteDraftId: "remote-asymmetric",
    });
    createGranted = true;
    updateGranted = false;
    try {
      await expect(
        store.authorizeRemoteOperation({
          draftId: remoteBacked.id,
          actorId: ownerId,
        }),
      ).rejects.toMatchObject({
        code: "grant_required",
        status: 403,
        ref: "typefully/update_draft",
      });
      const locallySaved = await store.saveDraft({
        draftId: remoteBacked.id,
        actorId: ownerId,
        expectedVersion: 1,
        document: document("Update denied, local save retained."),
      });
      expect(locallySaved).toMatchObject({
        version: 2,
        syncStatus: "grant_blocked",
        remoteDraftId: "remote-asymmetric",
      });
    } finally {
      createGranted = true;
      updateGranted = true;
    }
  });

  test("preflights create versus update grants and refuses a detached originating Bot", async () => {
    const created = await createOwnedDraft();
    decidedRefs.length = 0;
    expect(
      await store.authorizeRemoteOperation({
        draftId: created.id,
        actorId: ownerId,
      }),
    ).toMatchObject({ ref: "typefully/create_draft" });

    await store.recordRemoteConfirmation({
      draftId: created.id,
      actorId: ownerId,
      expectedVersion: 1,
      remoteDraftId: "remote-for-update",
    });
    expect(
      await store.authorizeRemoteOperation({
        draftId: created.id,
        actorId: ownerId,
      }),
    ).toMatchObject({ ref: "typefully/update_draft" });
    expect(decidedRefs).toEqual([
      "typefully/create_draft",
      "typefully/update_draft",
    ]);

    await database
      .delete(channelAgents)
      .where(eq(channelAgents.agentId, botId));
    try {
      await expect(
        store.authorizeRemoteOperation({
          draftId: created.id,
          actorId: ownerId,
        }),
      ).rejects.toMatchObject({ code: "bot_not_attached", status: 409 });

      const recorded = await store.recordRemoteFailure({
        draftId: created.id,
        actorId: ownerId,
        expectedVersion: 1,
        error: "The already-started vendor attempt failed.",
      });
      expect(recorded.syncStatus).toBe("remote_error");
    } finally {
      await database
        .insert(channelAgents)
        .values({ channelId, agentId: botId })
        .onConflictDoNothing();
    }
  });

  test("rechecks membership and Bot attachment after the grant decision", async () => {
    const created = await createOwnedDraft();
    const detachingStore = createTypefullyStore({
      database,
      auditStore: createAuditStore(database),
      plugin: () => ({
        decide: async () => {
          await database
            .delete(channelAgents)
            .where(eq(channelAgents.agentId, botId));
          return { allowed: true } as const;
        },
      }),
      vendor: "typefully",
    });
    try {
      await expect(
        detachingStore.authorizeRemoteOperation({
          draftId: created.id,
          actorId: ownerId,
        }),
      ).rejects.toMatchObject({ code: "bot_not_attached", status: 409 });
    } finally {
      await database
        .insert(channelAgents)
        .values({ channelId, agentId: botId })
        .onConflictDoNothing();
    }

    const revokingStore = createTypefullyStore({
      database,
      auditStore: createAuditStore(database),
      plugin: () => ({
        decide: async () => {
          await database
            .delete(channelMemberships)
            .where(
              sql`${channelMemberships.channelId} = ${channelId} AND ${channelMemberships.userId} = ${ownerId}`,
            );
          return { allowed: true } as const;
        },
      }),
      vendor: "typefully",
    });
    try {
      await expect(
        revokingStore.authorizeRemoteOperation({
          draftId: created.id,
          actorId: ownerId,
        }),
      ).rejects.toMatchObject({
        code: "draft_not_found",
        status: 404,
        message: "Draft not found",
      });
    } finally {
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: ownerId })
        .onConflictDoNothing();
    }
  });

  test("keeps save and remote bookkeeping ownership failures non-disclosing", async () => {
    const created = await createOwnedDraft();
    const operations = [
      () =>
        store.saveDraft({
          draftId: created.id,
          actorId: otherId,
          expectedVersion: 1,
          document: document("Cross-owner save."),
        }),
      () =>
        store.saveDraft({
          draftId: created.id,
          actorId: outsiderId,
          expectedVersion: 1,
          document: document("Non-member save."),
        }),
      () =>
        store.recordRemoteConfirmation({
          draftId: created.id,
          actorId: otherId,
          expectedVersion: 1,
          remoteDraftId: "must-not-land",
        }),
      () =>
        store.recordRemoteConfirmation({
          draftId: created.id,
          actorId: outsiderId,
          expectedVersion: 1,
          remoteDraftId: "must-not-land",
        }),
      () =>
        store.recordRemoteFailure({
          draftId: created.id,
          actorId: otherId,
          expectedVersion: 1,
          error: "must not land",
        }),
      () =>
        store.recordRemoteFailure({
          draftId: created.id,
          actorId: outsiderId,
          expectedVersion: 1,
          error: "must not land",
        }),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({
        code: "draft_not_found",
        status: 404,
        message: "Draft not found",
      });
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

  test("sanitizes control characters and credential-shaped remote errors", async () => {
    const created = await createOwnedDraft();
    const failed = await store.recordRemoteFailure({
      draftId: created.id,
      actorId: ownerId,
      expectedVersion: 1,
      error:
        'Vendor\0 refused\u0007 Authorization: Bearer sk-live-secret api_key=tf-live-secret API\0key tf-third-secret token="generic-token-secret"; token budget stays readable',
    });

    expect(failed.lastError).toContain("Vendor refused");
    expect(failed.lastError).toContain("[redacted]");
    expect(failed.lastError).not.toContain("sk-live-secret");
    expect(failed.lastError).not.toContain("tf-live-secret");
    expect(failed.lastError).not.toContain("tf-third-secret");
    expect(failed.lastError).not.toContain("generic-token-secret");
    expect(failed.lastError).toContain("token budget stays readable");
    expect(failed.lastError).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(Array.from(failed.lastError ?? "").length).toBeLessThanOrEqual(500);
  });

  test("holds membership and attachment references through committing local mutations", async () => {
    const created = await createOwnedDraft();
    const entered = deferred();
    const release = deferred();
    const pausingStore = createTypefullyStore({
      database,
      auditStore: pausingAuditStore(entered, release),
      plugin: () => plugin,
      vendor: "typefully",
    });
    const save = pausingStore.saveDraft({
      draftId: created.id,
      actorId: ownerId,
      expectedVersion: 1,
      document: document("Save while membership retirement waits."),
    });
    await entered.promise;

    const applicationName = `typefully_membership_lock_${randomUUID()}`;
    const namedUrl = new URL(databaseUrl);
    namedUrl.searchParams.set("application_name", applicationName);
    const namedDatabase = createDatabase(namedUrl.toString(), TEST_POOL);
    let deletionSettled = false;
    const deletion = namedDatabase
      .delete(channelMemberships)
      .where(
        sql`${channelMemberships.channelId} = ${channelId} AND ${channelMemberships.userId} = ${ownerId}`,
      )
      .finally(() => {
        deletionSettled = true;
      });
    try {
      expect(
        await waitForMutationBlock(applicationName, () => deletionSettled),
      ).toBe(true);
      release.resolve();
      expect((await save).version).toBe(2);
      await deletion;
    } finally {
      release.resolve();
      await save.catch(() => undefined);
      await deletion.catch(() => undefined);
      await namedDatabase.$client.close();
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: ownerId })
        .onConflictDoNothing();
    }

    const createEntered = deferred();
    const releaseCreate = deferred();
    const pausingCreateStore = createTypefullyStore({
      database,
      auditStore: pausingAuditStore(createEntered, releaseCreate),
      plugin: () => plugin,
      vendor: "typefully",
    });
    const creation = pausingCreateStore.createDraft({
      ownerUserId: ownerId,
      channelId,
      botId,
      document: document("Create while detachment waits."),
    });
    await createEntered.promise;

    const detachApplication = `typefully_attachment_lock_${randomUUID()}`;
    const detachUrl = new URL(databaseUrl);
    detachUrl.searchParams.set("application_name", detachApplication);
    const detachDatabase = createDatabase(detachUrl.toString(), TEST_POOL);
    let detachSettled = false;
    const detachment = detachDatabase
      .delete(channelAgents)
      .where(
        sql`${channelAgents.channelId} = ${channelId} AND ${channelAgents.agentId} = ${botId}`,
      )
      .finally(() => {
        detachSettled = true;
      });
    try {
      expect(
        await waitForMutationBlock(detachApplication, () => detachSettled),
      ).toBe(true);
      releaseCreate.resolve();
      const createdDuringRace = await creation;
      draftIds.push(createdDuringRace.id);
      await detachment;
    } finally {
      releaseCreate.resolve();
      const result = await creation.catch(() => undefined);
      if (result && !draftIds.includes(result.id)) draftIds.push(result.id);
      await detachment.catch(() => undefined);
      await detachDatabase.$client.close();
      await database
        .insert(channelAgents)
        .values({ channelId, agentId: botId })
        .onConflictDoNothing();
    }
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
