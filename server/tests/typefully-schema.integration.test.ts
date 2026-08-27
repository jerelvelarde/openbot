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
const channelId = `typefully_channel_${suite}`;
const serverId = `typefully-${suite}`;
let credentialId: string | undefined;
let draftId: string | undefined;

beforeAll(async () => {
  await database.insert(users).values([
    { id: ownerId, email: `${ownerId}@openbot.test` },
    { id: otherOwnerId, email: `${otherOwnerId}@openbot.test` },
  ]);
  await database.insert(agents).values({
    id: botId,
    name: botId,
    type: "remote_ag_ui",
    configuration: {},
  });
  await database.insert(channels).values({
    id: channelId,
    name: channelId,
    description: "Typefully schema integration fixture",
  });
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Typefully",
    vendor: "Typefully",
    url: "https://api.typefully.com",
  });
});

afterAll(async () => {
  if (draftId) {
    await database
      .delete(typefullyPublicationProposals)
      .where(eq(typefullyPublicationProposals.draftId, draftId));
    await database
      .delete(typefullyDrafts)
      .where(eq(typefullyDrafts.id, draftId));
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
  await database.delete(channels).where(eq(channels.id, channelId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database
    .delete(users)
    .where(inArray(users.id, [ownerId, otherOwnerId]));
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
    await database.insert(mcpUserCredentials).values(connection);

    await expect(
      (async () => {
        await database.insert(mcpUserCredentials).values(connection);
      })(),
    ).rejects.toThrow();
  });

  test("ties publication proposals to the draft owner in the database", async () => {
    const [draft] = await database
      .insert(typefullyDrafts)
      .values({
        ownerUserId: ownerId,
        channelId,
        botId,
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
    draftId = draft.id;
    expect(draft.remoteDraftId).toBeNull();

    await database.insert(typefullyPublicationProposals).values({
      draftId,
      ownerUserId: ownerId,
      botId,
      channelId,
      draftVersion: 1,
      contentHash: `sha256:${suite}`,
      snapshot: { blocks: [{ type: "paragraph", text: "Ship it." }] },
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      (async () => {
        await database.insert(typefullyPublicationProposals).values({
          draftId,
          ownerUserId: otherOwnerId,
          botId,
          channelId,
          draftVersion: 1,
          contentHash: `sha256:${suite}`,
          snapshot: { blocks: [{ type: "paragraph", text: "Ship it." }] },
          status: "pending",
          expiresAt: new Date(Date.now() + 60_000),
        });
      })(),
    ).rejects.toThrow();
  });
});
