import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { draftSummary as parseDraftSummary } from "../../app/src/lib/typefully/queries";
import {
  and,
  eq,
  inArray,
} from "../../server/node_modules/drizzle-orm/index.js";
import { createAuditStore } from "../../server/src/audit";
import { createCredentialStore } from "../../server/src/credentials";
import { createDatabase } from "../../server/src/db/client";
import {
  agents,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  typefullyDrafts,
  typefullyPublicationProposals,
  users,
} from "../../server/src/db/schema";
import {
  ConnectionRequiredError,
  createPluginStore,
  type PluginStoreOptions,
} from "../../server/src/plugins/store";
import type { CanonicalDraftDocument } from "../../server/src/typefully/document";
import { createTypefullyStore } from "../../server/src/typefully/store";
import { TEST_POOL } from "../../server/tests/support/database";

const asked = process.env.OPENBOT_SMOKE === "1";
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

afterAll(async () => database.$client.close());

test.skipIf(!asked)(
  "the fake Typefully journey stays local-first and publishes exactly once",
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const ownerId = `typefully-smoke-owner-${suffix}`;
    const botId = `typefully-smoke-bot-${suffix}`;
    const channelId = `typefully-smoke-channel-${suffix}`;
    const apiKey = `tf-smoke-secret-${suffix}`;
    const firstBody = `SMOKE_FULL_DRAFT_BODY_${suffix}`;
    const changedBody = `SMOKE_CHANGED_DRAFT_BODY_${suffix}`;
    const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const draftIds: string[] = [];
    const vendorCalls: Array<{ tool: string; args: unknown }> = [];
    const componentArgs: Array<{
      name: string;
      args: unknown;
    }> = [];
    const transcript: Array<{ role: string; content: string }> = [];
    let remoteDocument: unknown = null;
    let publishCalls = 0;
    type VendorDispatch = Parameters<
      NonNullable<PluginStoreOptions["vendorDispatcherReady"]>
    >[0];
    let vendorDispatch!: VendorDispatch;
    let pluginStore!: ReturnType<typeof createPluginStore>;
    const typefullyStore = createTypefullyStore({
      database,
      auditStore: createAuditStore(database),
      plugin: () => ({ ...pluginStore, dispatchVendor: vendorDispatch }),
      publicationVendor: {
        fetchDraft: async () => ({ document: remoteDocument }),
        publishDraft: async () => {
          publishCalls += 1;
          return {
            outcome: "published",
            vendorResultId: `fake-published-${suffix}`,
            publishedUrl: `https://typefully.com/t/fake-${suffix}`,
          };
        },
        reconcileDraft: async () => ({ outcome: "unknown" }),
      },
    });
    pluginStore = createPluginStore({
      database,
      auditStore: createAuditStore(database),
      credentials: createCredentialStore(database),
      encryptionKey,
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      firstPartyTool: typefullyStore.callBotTool,
      vendorDispatcherReady: (dispatch) => {
        vendorDispatch = dispatch;
      },
      validateUserApiKey: async ({ apiKey: candidate }) => {
        expect(candidate).toBe(apiKey);
        return {
          accountId: `fake-account-${suffix}`,
          accountLabel: "Fake Typefully account",
          keyLabel: "Smoke only",
        };
      },
      callVendor: async (_connection, tool, args) => {
        vendorCalls.push({ tool, args });
        return {
          text: JSON.stringify({ id: "7001" }),
          isError: false,
        };
      },
    });

    try {
      await database.insert(users).values({
        id: ownerId,
        email: `${ownerId}@openbot.test`,
      });
      await database.insert(agents).values({
        id: botId,
        name: "Typefully Smoke Bot",
        type: "remote_ag_ui",
        configuration: {},
      });
      await database.insert(channels).values({
        id: channelId,
        name: channelId,
        description: "Fake Typefully journey",
      });
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: ownerId });
      await database
        .insert(channelAgents)
        .values({ channelId, agentId: botId });
      await database.insert(mcpServers).values({
        id: "typefully",
        title: "Typefully",
        vendor: "Typefully",
        url: "https://api.typefully.com/v2",
        provenance: "first-party",
      });
      for (const name of [
        "get_draft",
        "create_draft",
        "update_draft",
        "prepare_publication",
      ]) {
        await database.insert(mcpTools).values({
          serverId: "typefully",
          name,
          description: name,
        });
        await database.insert(pluginGrants).values({
          kind: "mcp",
          ref: `typefully/${name}`,
          agentId: botId,
        });
      }

      const initialDocument: CanonicalDraftDocument = {
        title: "Launch post",
        destinations: ["x", "linkedin"],
        socialSetId: "12",
        accountLabel: "Fake Typefully account",
        posts: [{ id: "post-1", x: "Initial X", linkedin: "Initial LinkedIn" }],
        media: [],
        scheduleAt: null,
      };
      const createdResult = await pluginStore.callTool({
        ref: "typefully/create_draft",
        args: { channelId, document: initialDocument },
        botId,
        actorId: ownerId,
      });
      expect(createdResult.isError).toBe(false);
      const created = parseDraftSummary(JSON.parse(createdResult.text));
      if (!created) throw new Error("Local draft returned an invalid summary.");
      draftIds.push(created.id);
      componentArgs.push({
        name: "showTypefullyDraft",
        args: {
          draftId: created.id,
          title: created.title,
          destinations: created.destinations,
          socialSetLabel: "Fake Typefully account",
          mediaCount: created.mediaCount,
          version: created.version,
          status: created.syncStatus,
        },
      });
      expect((await typefullyStore.readDraft(created.id, ownerId)).id).toBe(
        created.id,
      );

      const edited = await typefullyStore.saveDraft({
        draftId: created.id,
        actorId: ownerId,
        expectedVersion: created.version,
        document: {
          ...initialDocument,
          posts: [{ id: "post-1", x: firstBody, linkedin: firstBody }],
          media: [
            {
              id: "media-1",
              kind: "image",
              order: 0,
              altText: "Accessible launch graphic",
              remoteId: null,
            },
          ],
        },
      });
      expect(edited.syncStatus).toBe("local");

      await expect(
        typefullyStore.syncDraft({
          draftId: edited.id,
          actorId: ownerId,
          expectedVersion: edited.version,
          expectedHash: edited.contentHash,
        }),
      ).rejects.toBeInstanceOf(ConnectionRequiredError);
      componentArgs.push({
        name: "connectTypefullyAccount",
        args: {
          draftId: edited.id,
          operation: "sync",
          expectedVersion: edited.version,
        },
      });

      await pluginStore.connectUserApiKey({
        serverId: "typefully",
        userId: ownerId,
        apiKey,
        by: `${ownerId}@openbot.test`,
      });
      const firstSync = await typefullyStore.syncDraft({
        draftId: edited.id,
        actorId: ownerId,
        expectedVersion: edited.version,
        expectedHash: edited.contentHash,
      });
      expect(firstSync.draft.syncStatus).toBe("synced");
      expect(
        vendorCalls.filter(({ tool }) => tool === "create_draft"),
      ).toHaveLength(1);
      remoteDocument = firstSync.draft.document;

      const firstProposal = await typefullyStore.prepareProposal({
        draftId: edited.id,
        actorId: ownerId,
        expectedVersion: firstSync.draft.version,
        requiredBotId: botId,
      });
      const changed = await typefullyStore.saveDraft({
        draftId: edited.id,
        actorId: ownerId,
        expectedVersion: firstSync.draft.version,
        document: {
          ...firstSync.draft.document,
          posts: [{ id: "post-1", x: changedBody, linkedin: changedBody }],
        },
      });
      expect(
        (await typefullyStore.readProposal(firstProposal.id, ownerId)).status,
      ).toBe("expired");
      const secondSync = await typefullyStore.syncDraft({
        draftId: changed.id,
        actorId: ownerId,
        expectedVersion: changed.version,
        expectedHash: changed.contentHash,
      });
      remoteDocument = secondSync.draft.document;
      const secondProposal = await typefullyStore.prepareProposal({
        draftId: changed.id,
        actorId: ownerId,
        expectedVersion: secondSync.draft.version,
        requiredBotId: botId,
      });
      componentArgs.push({
        name: "approveTypefullyPublication",
        args: {
          proposalId: secondProposal.id,
          draftId: secondProposal.draftId,
          destinations: secondProposal.destinations,
          version: secondProposal.version,
          expiresAt: secondProposal.expiresAt,
        },
      });
      const published = await typefullyStore.approveAndPublish({
        proposalId: secondProposal.id,
        actorId: ownerId,
      });
      expect(published.status).toBe("published");
      expect(publishCalls).toBe(1);
      transcript.push({
        role: "assistant",
        content: "Published to X and LinkedIn.",
      });

      const audits = await database
        .select({
          eventType: auditEvents.eventType,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(eq(auditEvents.actorUserId, ownerId));
      expect(
        audits.some(
          ({ payload }) =>
            payload !== null &&
            typeof payload === "object" &&
            "outcome" in payload &&
            payload.outcome === "published",
        ),
      ).toBe(true);
      const privateSurfaces = JSON.stringify({
        transcript,
        componentArgs,
        audits,
      });
      expect(privateSurfaces).not.toContain(apiKey);
      expect(privateSurfaces).not.toContain(firstBody);
      expect(privateSurfaces).not.toContain(changedBody);
      expect(privateSurfaces).not.toContain("snapshot");
      expect(componentArgs.map(({ name }) => name)).toEqual([
        "showTypefullyDraft",
        "connectTypefullyAccount",
        "approveTypefullyPublication",
      ]);
    } finally {
      if (draftIds.length) {
        await database
          .delete(typefullyPublicationProposals)
          .where(inArray(typefullyPublicationProposals.draftId, draftIds));
        await database
          .delete(typefullyDrafts)
          .where(inArray(typefullyDrafts.id, draftIds));
      }
      const [connection] = await database
        .select({ userId: mcpUserCredentials.userId })
        .from(mcpUserCredentials)
        .where(
          and(
            eq(mcpUserCredentials.serverId, "typefully"),
            eq(mcpUserCredentials.userId, ownerId),
          ),
        );
      if (connection) {
        await pluginStore.disconnectUserConnection({
          serverId: "typefully",
          userId: ownerId,
          by: `${ownerId}@openbot.test`,
        });
      }
      await database
        .delete(credentials)
        .where(
          and(
            eq(credentials.provider, "typefully"),
            eq(credentials.keyId, ownerId),
          ),
        );
      await database
        .delete(channelAgents)
        .where(eq(channelAgents.agentId, botId));
      await database
        .delete(pluginGrants)
        .where(eq(pluginGrants.agentId, botId));
      await database
        .delete(channelMemberships)
        .where(eq(channelMemberships.channelId, channelId));
      await database.delete(channels).where(eq(channels.id, channelId));
      await database.delete(agents).where(eq(agents.id, botId));
      await database.delete(users).where(eq(users.id, ownerId));
      await database.delete(mcpTools).where(eq(mcpTools.serverId, "typefully"));
      await database.delete(mcpServers).where(eq(mcpServers.id, "typefully"));
    }
  },
  30_000,
);
