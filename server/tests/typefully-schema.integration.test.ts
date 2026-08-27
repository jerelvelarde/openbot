import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channels,
  credentials,
  mcpServers,
  mcpUserCredentials,
  typefullyDrafts,
  typefullyPublicationProposals,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const ownerId = `typefully_owner_${suite}`;
const otherOwnerId = `typefully_other_${suite}`;
const botId = `typefully_bot_${suite}`;
const otherBotId = `typefully_other_bot_${suite}`;
const channelId = `typefully_channel_${suite}`;
const otherChannelId = `typefully_other_channel_${suite}`;
const serverId = `typefully-${suite}`;
let credentialId: string | undefined;
const draftIds: string[] = [];

beforeAll(async () => {
  await database.insert(users).values([
    { id: ownerId, email: `${ownerId}@openbot.test` },
    { id: otherOwnerId, email: `${otherOwnerId}@openbot.test` },
  ]);
  await database.insert(agents).values(
    [botId, otherBotId].map((id) => ({
      id,
      name: id,
      type: "remote_ag_ui" as const,
      configuration: {},
    })),
  );
  await database.insert(channels).values(
    [channelId, otherChannelId].map((id) => ({
      id,
      name: id,
      description: "Typefully schema integration fixture",
    })),
  );
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Typefully",
    vendor: "Typefully",
    url: "https://api.typefully.com",
  });
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
  await database
    .delete(mcpUserCredentials)
    .where(
      and(
        eq(mcpUserCredentials.serverId, serverId),
        eq(mcpUserCredentials.userId, ownerId),
      ),
    );
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  if (credentialId) {
    await database.delete(credentials).where(eq(credentials.id, credentialId));
  }
  await database
    .delete(channels)
    .where(inArray(channels.id, [channelId, otherChannelId]));
  await database.delete(agents).where(inArray(agents.id, [botId, otherBotId]));
  await database
    .delete(users)
    .where(inArray(users.id, [ownerId, otherOwnerId]));
});

async function createDraft(input?: {
  ownerUserId?: string;
  botId?: string;
  channelId?: string;
}) {
  const [draft] = await database
    .insert(typefullyDrafts)
    .values({
      ownerUserId: input?.ownerUserId ?? ownerId,
      channelId: input?.channelId ?? channelId,
      botId: input?.botId ?? botId,
      document: { blocks: [{ type: "paragraph", text: "Ship it." }] },
      version: 1,
      contentHash: `sha256:${suite}`,
      syncStatus: "local",
    })
    .returning({
      id: typefullyDrafts.id,
      remoteDraftId: typefullyDrafts.remoteDraftId,
    });
  if (!draft) throw new Error("draft fixture was not stored");
  draftIds.push(draft.id);
  return draft;
}

const proposalValues = (
  draftId: string,
  input?: {
    ownerUserId?: string;
    botId?: string;
    channelId?: string;
  },
) => ({
  draftId,
  ownerUserId: input?.ownerUserId ?? ownerId,
  botId: input?.botId ?? botId,
  channelId: input?.channelId ?? channelId,
  draftVersion: 1,
  contentHash: `sha256:${suite}`,
  snapshot: { blocks: [{ type: "paragraph", text: "Ship it." }] },
  status: "pending" as const,
  expiresAt: new Date(Date.now() + 60_000),
});

describe("Typefully persistence ownership", () => {
  test("stores an API-key connection and refuses duplicate ownership", async () => {
    const [credential] = await database
      .insert(credentials)
      .values({
        kind: "mcp_user_api_key",
        provider: "typefully",
        keyId: ownerId,
        encryptedValue: "encrypted-test-fixture",
        metadata: {},
      })
      .returning({ id: credentials.id });
    if (!credential) throw new Error("credential fixture was not stored");
    credentialId = credential.id;

    const connection = {
      serverId,
      userId: ownerId,
      credentialId,
      authMethod: "api_key" as const,
      scope: null,
    };
    const [stored] = await database
      .insert(mcpUserCredentials)
      .values(connection)
      .returning({
        authMethod: mcpUserCredentials.authMethod,
        scope: mcpUserCredentials.scope,
      });
    expect(stored).toEqual({ authMethod: "api_key", scope: null });

    await expect(
      (async () => {
        await database.insert(mcpUserCredentials).values(connection);
      })(),
    ).rejects.toThrow();
  });

  test("ties publication proposals to the draft owner, Bot, and channel", async () => {
    const draft = await createDraft();
    expect(draft.remoteDraftId).toBeNull();

    await database
      .insert(typefullyPublicationProposals)
      .values(proposalValues(draft.id));

    await expect(
      (async () => {
        await database
          .insert(typefullyPublicationProposals)
          .values(proposalValues(draft.id, { ownerUserId: otherOwnerId }));
      })(),
    ).rejects.toThrow();

    await expect(
      (async () => {
        await database
          .insert(typefullyPublicationProposals)
          .values(proposalValues(draft.id, { botId: otherBotId }));
      })(),
    ).rejects.toThrow();

    await expect(
      (async () => {
        await database
          .insert(typefullyPublicationProposals)
          .values(proposalValues(draft.id, { channelId: otherChannelId }));
      })(),
    ).rejects.toThrow();
  });

  test("keeps proposal review data immutable while lifecycle results advance", async () => {
    const draft = await createDraft();
    const otherDraft = await createDraft({
      ownerUserId: otherOwnerId,
      botId: otherBotId,
      channelId: otherChannelId,
    });
    const [proposal] = await database
      .insert(typefullyPublicationProposals)
      .values(proposalValues(draft.id))
      .returning({ id: typefullyPublicationProposals.id });
    if (!proposal) throw new Error("proposal fixture was not stored");

    const rejectMutation = async (
      mutation: Partial<typeof typefullyPublicationProposals.$inferInsert>,
    ) => {
      let causeMessage: string | undefined;
      try {
        await database
          .update(typefullyPublicationProposals)
          .set(mutation)
          .where(eq(typefullyPublicationProposals.id, proposal.id));
      } catch (error) {
        if (!(error instanceof Error) || !(error.cause instanceof Error)) {
          throw error;
        }
        causeMessage = error.cause.message;
      }
      expect(causeMessage).toContain("immutable review data");
    };

    await rejectMutation({ snapshot: { blocks: [] } });
    await rejectMutation({ draftVersion: 2 });
    await rejectMutation({ contentHash: `sha256:changed-${suite}` });
    await rejectMutation({ expiresAt: new Date(Date.now() + 120_000) });
    await rejectMutation({
      draftId: otherDraft.id,
      ownerUserId: otherOwnerId,
      botId: otherBotId,
      channelId: otherChannelId,
    });
    await rejectMutation({ id: randomUUID() });
    await rejectMutation({ createdAt: new Date(0) });

    const decidedAt = new Date();
    const [published] = await database
      .update(typefullyPublicationProposals)
      .set({
        status: "published",
        decidedAt,
        completedAt: decidedAt,
        vendorResultId: `result-${suite}`,
        publishedUrl: `https://typefully.test/${suite}`,
        failureDetail: null,
        updatedAt: decidedAt,
      })
      .where(eq(typefullyPublicationProposals.id, proposal.id))
      .returning({
        status: typefullyPublicationProposals.status,
        vendorResultId: typefullyPublicationProposals.vendorResultId,
        publishedUrl: typefullyPublicationProposals.publishedUrl,
      });
    expect(published).toEqual({
      status: "published",
      vendorResultId: `result-${suite}`,
      publishedUrl: `https://typefully.test/${suite}`,
    });
  });

  test("requires complete durable attempt state for in-flight and attempted unknown proposals", async () => {
    const draft = await createDraft();
    const [proposal] = await database
      .insert(typefullyPublicationProposals)
      .values(proposalValues(draft.id))
      .returning({ id: typefullyPublicationProposals.id });
    if (!proposal) throw new Error("proposal fixture was not stored");

    await expect(
      (async () => {
        await database
          .update(typefullyPublicationProposals)
          .set({ status: "in_flight" })
          .where(eq(typefullyPublicationProposals.id, proposal.id));
      })(),
    ).rejects.toThrow();

    const attemptId = randomUUID();
    const lease = new Date(Date.now() + 60_000);
    const [claimed] = await database
      .update(typefullyPublicationProposals)
      .set({ status: "in_flight", attemptId, attemptLeaseExpiresAt: lease })
      .where(eq(typefullyPublicationProposals.id, proposal.id))
      .returning({ status: typefullyPublicationProposals.status });
    expect(claimed?.status).toBe("in_flight");

    await expect(
      (async () => {
        await database
          .update(typefullyPublicationProposals)
          .set({ status: "unknown" })
          .where(eq(typefullyPublicationProposals.id, proposal.id));
      })(),
    ).rejects.toThrow();

    const writeStartedAt = new Date();
    const [unknown] = await database
      .update(typefullyPublicationProposals)
      .set({ status: "unknown", vendorWriteStartedAt: writeStartedAt })
      .where(eq(typefullyPublicationProposals.id, proposal.id))
      .returning({ status: typefullyPublicationProposals.status });
    expect(unknown?.status).toBe("unknown");

    await expect(
      (async () => {
        await database
          .update(typefullyPublicationProposals)
          .set({ status: "published" })
          .where(eq(typefullyPublicationProposals.id, proposal.id));
      })(),
    ).rejects.toThrow();

    const [published] = await database
      .update(typefullyPublicationProposals)
      .set({
        status: "published",
        attemptId: null,
        attemptLeaseExpiresAt: null,
        vendorWriteStartedAt: null,
      })
      .where(eq(typefullyPublicationProposals.id, proposal.id))
      .returning({ status: typefullyPublicationProposals.status });
    expect(published?.status).toBe("published");
  });
});
