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
} from "../src/typefully/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const suffix = randomUUID().slice(0, 8);
const ownerId = `publication-owner-${suffix}`;
const otherId = `publication-other-${suffix}`;
const botId = `publication-bot-${suffix}`;
const channelId = `publication-channel-${suffix}`;
const draftIds: string[] = [];
let publishCalls = 0;
let publishBarrier: Promise<void> | null = null;
let authorizeError: Error | null = null;
let publishAuthorizationCalls = 0;
let failSecondPublishAuthorization = false;
let remoteDocument: unknown;
let publishResult: {
  outcome: "published" | "failed" | "unknown";
  vendorResultId?: string;
  publishedUrl?: string;
  detail?: string;
} = { outcome: "published", vendorResultId: "result-1" };

const plugin = {
  decide: async (_kind: "mcp" | "skill", ref: string, actorBotId: string) =>
    actorBotId === botId && ref === "typefully/prepare_publication"
      ? ({ allowed: true } as const)
      : ({ allowed: false, reason: "Grant removed." } as const),
  authorizeOperation: async (input: { ref: string }) => {
    if (authorizeError) throw authorizeError;
    if (input.ref.endsWith("/publish_now")) {
      publishAuthorizationCalls += 1;
      if (failSecondPublishAuthorization && publishAuthorizationCalls === 2) {
        throw Object.assign(
          new Error(
            "Grant changed before publication personal-key Approved exact content",
          ),
          { code: "grant_required" },
        );
      }
    }
    return {
      token: "personal-key",
      decision: {
        allowed: true,
        forward: true,
        mode: "enforce",
        matched: "mcp.effect == 'write'",
        source: "allow",
        reason: "Permitted by policy.",
      },
    };
  },
};

const store = createTypefullyStore({
  database,
  auditStore: createAuditStore(database),
  plugin: () => plugin,
  publicationVendor: {
    fetchDraft: async () => ({ document: remoteDocument }),
    publishDraft: async () => {
      publishCalls += 1;
      if (publishBarrier) await publishBarrier;
      return publishResult;
    },
    reconcileDraft: async () => publishResult,
  },
});

const document = (text = "Approved exact content") => ({
  title: "Launch",
  destinations: ["x", "linkedin"] as const,
  socialSetId: "1",
  accountLabel: "OpenBot",
  posts: [{ id: "post-1", x: text, linkedin: text }],
  media: [],
  scheduleAt: null,
});

beforeAll(async () => {
  await database
    .insert(users)
    .values(
      [ownerId, otherId].map((id) => ({ id, email: `${id}@openbot.test` })),
    );
  await database.insert(agents).values({
    id: botId,
    name: "Publication Bot",
    type: "remote_ag_ui",
    configuration: {},
  });
  await database.insert(channels).values({
    id: channelId,
    name: channelId,
    description: "Publication fixture",
  });
  await database.insert(channelMemberships).values([
    { channelId, userId: ownerId },
    { channelId, userId: otherId },
  ]);
  await database.insert(channelAgents).values({ channelId, agentId: botId });
});

afterAll(async () => {
  if (draftIds.length) {
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
    .where(inArray(channelMemberships.userId, [ownerId, otherId]));
  await database.delete(channels).where(eq(channels.id, channelId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(inArray(users.id, [ownerId, otherId]));
});

async function syncedDraft() {
  const created = await store.createDraft({
    ownerUserId: ownerId,
    channelId,
    botId,
    document: document(),
  });
  draftIds.push(created.id);
  remoteDocument = created.document;
  return store.recordRemoteConfirmation({
    draftId: created.id,
    actorId: ownerId,
    expectedVersion: created.version,
    expectedHash: created.contentHash,
    remoteDraftId: "101",
  });
}

async function proposalAudits(proposalId: string) {
  return database
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(eq(auditEvents.targetId, proposalId));
}

function expectAuditIsSafe(audit: unknown) {
  const serialized = JSON.stringify(audit);
  expect(serialized).not.toContain("Approved exact content");
  expect(serialized).not.toContain("Edited after review");
  expect(serialized).not.toContain("Changed in Typefully");
  expect(serialized).not.toContain("personal-key");
  expect(serialized).not.toContain("snapshot");
}

describe("immutable Typefully publication proposals", () => {
  test("prepares a bounded immutable summary, reads it privately, and declines once", async () => {
    const draft = await syncedDraft();
    const proposal = await store.prepareProposal({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
    });

    expect(proposal).toEqual({
      id: expect.any(String),
      draftId: draft.id,
      version: draft.version,
      destinations: ["x", "linkedin"],
      expiresAt: expect.any(String),
      status: "pending",
    });
    expect(await store.readProposal(proposal.id, ownerId)).toMatchObject({
      ...proposal,
      snapshot: draft.document,
    });
    await expect(
      store.readProposal(proposal.id, otherId),
    ).rejects.toBeInstanceOf(DraftNotFoundError);

    expect(await store.declineProposal(proposal.id, ownerId)).toMatchObject({
      status: "declined",
    });
    await expect(
      store.declineProposal(proposal.id, ownerId),
    ).rejects.toMatchObject({
      code: "proposal_not_pending",
    });
    const lifecycle = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, proposal.id));
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "prepared",
          policy: {
            operation: "prepare_publication",
            matchedRule: "mcp.effect == 'write'",
            matchedRuleId: null,
            source: "allow",
            mode: "enforce",
            effect: "write",
            decision: "allowed",
          },
        }),
        expect.objectContaining({
          decision: "declined",
          policy: {
            operation: "human_decline",
            matchedRule: null,
            matchedRuleId: null,
            source: "not_applicable",
            mode: "unknown",
            effect: "human_decision",
            decision: "not_required",
          },
        }),
      ]),
    );
  });

  test("claims two concurrent approvals durably and calls the vendor exactly once", async () => {
    const draft = await syncedDraft();
    const proposal = await store.prepareProposal({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
    });
    publishCalls = 0;
    publishResult = {
      outcome: "published",
      vendorResultId: "result-concurrent",
      publishedUrl: "https://typefully.com/t/result-concurrent",
    };

    const results = await Promise.allSettled([
      store.approveAndPublish({ proposalId: proposal.id, actorId: ownerId }),
      store.approveAndPublish({ proposalId: proposal.id, actorId: ownerId }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(publishCalls).toBe(1);
    expect(await store.readProposal(proposal.id, ownerId)).toMatchObject({
      status: "published",
      vendorResultId: "result-concurrent",
    });
  });

  test("marks edits and remote changes as Changed — review again", async () => {
    const draft = await syncedDraft();
    const localProposal = await store.prepareProposal({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
    });
    await store.saveDraft({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
      document: document("Edited after review"),
    });
    await expect(
      store.approveAndPublish({
        proposalId: localProposal.id,
        actorId: ownerId,
      }),
    ).rejects.toMatchObject({ code: "proposal_changed" });
    const localAudit = await proposalAudits(localProposal.id);
    expect(localAudit.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "publication_refused",
          stage: "local_revision",
          failureClass: "draft_changed",
          vendorWrite: "not_attempted",
          outcome: "expired",
          policy: expect.objectContaining({
            operation: "publish_now",
            decision: "not_evaluated",
          }),
        }),
      ]),
    );
    expectAuditIsSafe(localAudit);

    const fresh = await syncedDraft();
    const remoteProposal = await store.prepareProposal({
      draftId: fresh.id,
      actorId: ownerId,
      expectedVersion: fresh.version,
    });
    remoteDocument = document("Changed in Typefully");
    await expect(
      store.approveAndPublish({
        proposalId: remoteProposal.id,
        actorId: ownerId,
      }),
    ).rejects.toMatchObject({ code: "proposal_changed" });
    const remoteAudit = await proposalAudits(remoteProposal.id);
    expect(remoteAudit.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "publication_refused",
          stage: "remote_revision",
          failureClass: "remote_changed",
          vendorWrite: "not_attempted",
          outcome: "expired",
          policy: expect.objectContaining({ decision: "allowed" }),
        }),
      ]),
    );
    expectAuditIsSafe(remoteAudit);
    expect(publishCalls).toBe(1);
  });

  test("keeps an in-progress acknowledgement unknown and reconciles published without re-execution", async () => {
    const draft = await syncedDraft();
    const proposal = await store.prepareProposal({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
    });
    publishCalls = 0;
    publishResult = { outcome: "unknown", detail: "Publishing in progress" };

    expect(
      await store.approveAndPublish({
        proposalId: proposal.id,
        actorId: ownerId,
      }),
    ).toMatchObject({ status: "unknown" });
    expect(publishCalls).toBe(1);
    await expect(
      store.approveAndPublish({ proposalId: proposal.id, actorId: ownerId }),
    ).rejects.toMatchObject({ code: "proposal_not_pending" });

    publishResult = { outcome: "published", vendorResultId: "reconciled" };
    expect(
      await store.reconcileProposal({
        proposalId: proposal.id,
        actorId: ownerId,
      }),
    ).toMatchObject({ status: "published", vendorResultId: "reconciled" });
    expect(publishCalls).toBe(1);
    const reconciliationAudit = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, proposal.id));
    expect(reconciliationAudit.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "reconciled",
          outcome: "published",
          policy: {
            operation: "publish_now",
            matchedRule: "mcp.effect == 'write'",
            matchedRuleId: null,
            source: "allow",
            mode: "enforce",
            effect: "write",
            decision: "allowed",
          },
        }),
      ]),
    );
  });

  test("reconciles an acknowledged publication to a known vendor error without re-execution", async () => {
    const draft = await syncedDraft();
    const proposal = await store.prepareProposal({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
    });
    publishCalls = 0;
    publishResult = { outcome: "unknown", detail: "Publishing in progress" };
    expect(
      await store.approveAndPublish({
        proposalId: proposal.id,
        actorId: ownerId,
      }),
    ).toMatchObject({ status: "unknown" });
    publishResult = { outcome: "failed", detail: "Vendor publication failed" };
    expect(
      await store.reconcileProposal({
        proposalId: proposal.id,
        actorId: ownerId,
      }),
    ).toMatchObject({
      status: "failed",
      failureDetail: "Vendor publication failed",
    });
    expect(publishCalls).toBe(1);
  });

  test("fences local edits while an approved publication is in flight", async () => {
    const draft = await syncedDraft();
    const proposal = await store.prepareProposal({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
    });
    publishCalls = 0;
    let release!: () => void;
    publishBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    publishResult = { outcome: "published", vendorResultId: "fenced" };
    const publishing = store.approveAndPublish({
      proposalId: proposal.id,
      actorId: ownerId,
    });
    while (publishCalls === 0)
      await new Promise((resolve) => setTimeout(resolve, 1));

    await expect(
      store.saveDraft({
        draftId: draft.id,
        actorId: ownerId,
        expectedVersion: draft.version,
        document: document("Must wait for publication outcome"),
      }),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    release();
    publishBarrier = null;
    expect(await publishing).toMatchObject({ status: "published" });
  });

  test("audits credential, grant, and policy refusals before any vendor publish", async () => {
    publishCalls = 0;
    for (const [code, failureClass] of [
      ["connection_required", "connection_required"],
      ["grant_required", "grant_or_policy_refused"],
      ["policy_denied", "grant_or_policy_refused"],
    ] as const) {
      const draft = await syncedDraft();
      const proposal = await store.prepareProposal({
        draftId: draft.id,
        actorId: ownerId,
        expectedVersion: draft.version,
      });
      authorizeError = Object.assign(
        new Error(`${code} personal-key Approved exact content`),
        { code },
      );
      try {
        await expect(
          store.approveAndPublish({
            proposalId: proposal.id,
            actorId: ownerId,
          }),
        ).rejects.toMatchObject({ code });
        expect(await store.readProposal(proposal.id, ownerId)).toMatchObject({
          status: "pending",
        });
        const audit = await proposalAudits(proposal.id);
        expect(audit.map(({ payload }) => payload)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              decision: "publication_refused",
              stage: "preclaim_authorization",
              failureClass,
              vendorWrite: "not_attempted",
              outcome: "pending",
              policy: expect.objectContaining({
                operation: "publish_now",
                decision: "not_evaluated",
              }),
            }),
          ]),
        );
        expectAuditIsSafe(audit);
      } finally {
        authorizeError = null;
      }
    }
    expect(publishCalls).toBe(0);
  });

  test("expires an unspent proposal without contacting Typefully", async () => {
    const expiringStore = createTypefullyStore({
      database,
      auditStore: createAuditStore(database),
      plugin: () => plugin,
      proposalTtlMs: 1,
      publicationVendor: {
        fetchDraft: async () => ({ document: remoteDocument }),
        publishDraft: async () => {
          publishCalls += 1;
          return { outcome: "published" as const };
        },
        reconcileDraft: async () => ({ outcome: "unknown" as const }),
      },
    });
    const draft = await syncedDraft();
    const proposal = await expiringStore.prepareProposal({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
    });
    publishCalls = 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      expiringStore.approveAndPublish({
        proposalId: proposal.id,
        actorId: ownerId,
      }),
    ).rejects.toMatchObject({ code: "proposal_expired" });
    expect(publishCalls).toBe(0);
    expect(await store.readProposal(proposal.id, ownerId)).toMatchObject({
      status: "expired",
    });
    const audit = await proposalAudits(proposal.id);
    expect(audit.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "publication_refused",
          stage: "ttl_expiry",
          failureClass: "proposal_expired",
          vendorWrite: "not_attempted",
          outcome: "expired",
          policy: expect.objectContaining({
            operation: "publish_now",
            decision: "not_evaluated",
          }),
        }),
      ]),
    );
    expectAuditIsSafe(audit);
  });

  test("commits and audits expiry if the TTL elapses while approval is being claimed", async () => {
    const base = Date.parse("2099-08-27T12:00:00Z");
    let clockReads = 0;
    const racingStore = createTypefullyStore({
      database,
      auditStore: createAuditStore(database),
      plugin: () => plugin,
      proposalTtlMs: 100,
      now: () => {
        clockReads += 1;
        return new Date(base + (clockReads >= 3 ? 200 : 0));
      },
      publicationVendor: {
        fetchDraft: async () => ({ document: remoteDocument }),
        publishDraft: async () => {
          publishCalls += 1;
          return { outcome: "published" as const };
        },
        reconcileDraft: async () => ({ outcome: "unknown" as const }),
      },
    });
    const draft = await syncedDraft();
    const proposal = await racingStore.prepareProposal({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
    });
    publishCalls = 0;

    await expect(
      racingStore.approveAndPublish({
        proposalId: proposal.id,
        actorId: ownerId,
      }),
    ).rejects.toMatchObject({ code: "proposal_expired" });
    expect(publishCalls).toBe(0);
    expect(await store.readProposal(proposal.id, ownerId)).toMatchObject({
      status: "expired",
    });
    const audit = await proposalAudits(proposal.id);
    expect(audit.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "ttl_expiry",
          outcome: "expired",
          vendorWrite: "not_attempted",
          policy: expect.objectContaining({ decision: "allowed" }),
        }),
      ]),
    );
    expectAuditIsSafe(audit);
  });

  test("rechecks authorization after the durable claim and before the vendor write", async () => {
    const draft = await syncedDraft();
    const proposal = await store.prepareProposal({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
    });
    publishCalls = 0;
    publishAuthorizationCalls = 0;
    failSecondPublishAuthorization = true;
    try {
      await expect(
        store.approveAndPublish({ proposalId: proposal.id, actorId: ownerId }),
      ).rejects.toMatchObject({ code: "grant_required" });
      expect(publishAuthorizationCalls).toBe(2);
      expect(publishCalls).toBe(0);
      expect(await store.readProposal(proposal.id, ownerId)).toMatchObject({
        status: "unknown",
      });
      const audit = await proposalAudits(proposal.id);
      expect(audit.map(({ payload }) => payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            decision: "publication_refused",
            stage: "postclaim_authorization",
            failureClass: "grant_or_policy_refused",
            vendorWrite: "not_attempted",
            outcome: "unknown",
            policy: expect.objectContaining({
              operation: "publish_now",
              decision: "not_evaluated",
            }),
          }),
        ]),
      );
      expectAuditIsSafe(audit);
    } finally {
      failSecondPublishAuthorization = false;
    }
  });

  test("records known vendor refusal as failed and audits metadata without content", async () => {
    const draft = await syncedDraft();
    const proposal = await store.prepareProposal({
      draftId: draft.id,
      actorId: ownerId,
      expectedVersion: draft.version,
    });
    publishResult = { outcome: "failed", detail: "Typefully refused" };
    const failed = await store.approveAndPublish({
      proposalId: proposal.id,
      actorId: ownerId,
    });
    expect(failed).toMatchObject({
      status: "failed",
      failureDetail: "Typefully refused",
    });

    const audit = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, proposal.id));
    const serialized = JSON.stringify(audit);
    expect(audit.length).toBeGreaterThanOrEqual(3);
    for (const event of audit) {
      expect(event.payload).toMatchObject({
        policy: {
          matchedRule: "mcp.effect == 'write'",
          matchedRuleId: null,
          source: "allow",
          mode: "enforce",
          effect: "write",
          decision: "allowed",
        },
      });
    }
    expect(serialized).toContain(draft.contentHash);
    expect(serialized).not.toContain("Approved exact content");
    expect(serialized).not.toContain("snapshot");
    expect(serialized).not.toContain("personal-key");
  });
});
