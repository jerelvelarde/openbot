import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore, decryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  credentials,
  mcpServers,
  mcpUserCredentials,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { TypefullyApiKeyValidationError } from "../src/plugins/typefully-rest";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const suffix = randomUUID().slice(0, 8);
const userId = `typefully-key-owner-${suffix}`;
const secondUserId = `typefully-key-other-${suffix}`;
const serverId = "typefully";
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const apiKey = `tf-personal-${suffix}`;
let serverExisted = false;

const validated: string[] = [];
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  validateUserApiKey: async ({ serverId: validatingServer, apiKey: value }) => {
    expect(validatingServer).toBe(serverId);
    validated.push(value);
    const refused = value.match(
      /^refuse-(invalid_api_key|validation_timeout|rate_limited)-/,
    );
    if (refused?.[1]) {
      throw new TypefullyApiKeyValidationError(
        refused[1] as "invalid_api_key" | "validation_timeout" | "rate_limited",
        "Safe validation failure.",
      );
    }
    return {
      accountId: `acct-${suffix}`,
      accountLabel: "Typefully Test Account",
      keyLabel: "OpenBot",
    };
  },
});

beforeAll(async () => {
  serverExisted =
    (
      await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
    ).length > 0;
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Typefully",
      vendor: "Typefully",
      url: "https://api.typefully.com/v2",
      provenance: "first-party",
    })
    .onConflictDoNothing();
  await database.insert(users).values([
    { id: userId, email: `${userId}@openbot.test` },
    { id: secondUserId, email: `${secondUserId}@openbot.test` },
  ]);
});

afterAll(async () => {
  await database
    .delete(mcpUserCredentials)
    .where(inArray(mcpUserCredentials.userId, [userId, secondUserId]));
  await database
    .delete(credentials)
    .where(
      and(
        eq(credentials.provider, serverId),
        inArray(credentials.keyId, [userId, secondUserId]),
      ),
    );
  await database.delete(users).where(inArray(users.id, [userId, secondUserId]));
  if (!serverExisted) {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
});

describe("personal Typefully API-key connections", () => {
  test("validates before storing an encrypted key and only safe metadata", async () => {
    const connection = await store.connectUserApiKey({
      serverId,
      userId,
      apiKey,
      by: `${userId}@openbot.test`,
    });

    expect(validated).toEqual([apiKey]);
    expect(connection).toEqual({
      serverId,
      authMethod: "api_key",
      accountLabel: "Typefully Test Account",
      connectedAt: expect.any(String),
    });

    const [row] = await database
      .select({
        credentialId: mcpUserCredentials.credentialId,
        authMethod: mcpUserCredentials.authMethod,
        scope: mcpUserCredentials.scope,
      })
      .from(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, serverId),
          eq(mcpUserCredentials.userId, userId),
        ),
      );
    expect(row).toMatchObject({ authMethod: "api_key", scope: null });

    const [vault] = await database
      .select()
      .from(credentials)
      .where(eq(credentials.id, row?.credentialId ?? ""));
    expect(vault).toMatchObject({
      kind: "mcp_user_api_key",
      provider: serverId,
      keyId: userId,
      revokedAt: null,
      metadata: {
        server: serverId,
        accountId: `acct-${suffix}`,
        accountLabel: "Typefully Test Account",
        keyLabel: "OpenBot",
      },
    });
    expect(vault?.encryptedValue).not.toContain(apiKey);
    expect(
      await decryptSecret(encryptionKey, vault?.encryptedValue ?? ""),
    ).toBe(apiKey);
    expect(JSON.stringify(vault?.metadata)).not.toContain(apiKey);
    const audit = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, serverId));
    expect(JSON.stringify(audit)).not.toContain(apiKey);
  });

  test("rotates the exact prior key and leaves one live credential", async () => {
    const first = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_user_api_key"),
          eq(credentials.provider, serverId),
          eq(credentials.keyId, userId),
          isNull(credentials.revokedAt),
        ),
      );
    expect(first).toHaveLength(1);

    await store.connectUserApiKey({
      serverId,
      userId,
      apiKey: `${apiKey}-rotated`,
      by: `${userId}@openbot.test`,
    });

    const all = await database
      .select({ id: credentials.id, revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_user_api_key"),
          eq(credentials.provider, serverId),
          eq(credentials.keyId, userId),
        ),
      );
    expect(all.filter((row) => row.revokedAt === null)).toHaveLength(1);
    expect(
      all.find((row) => row.id === first[0]?.id)?.revokedAt,
    ).not.toBeNull();
  });

  test("failed validation writes nothing and never retains the submitted key", async () => {
    for (const code of [
      "invalid_api_key",
      "validation_timeout",
      "rate_limited",
    ] as const) {
      const secret = `refuse-${code}-${suffix}`;
      const error = await store
        .connectUserApiKey({
          serverId,
          userId: secondUserId,
          apiKey: secret,
          by: `${secondUserId}@openbot.test`,
        })
        .catch((caught) => caught);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain(secret);
    }

    const associations = await database
      .select()
      .from(mcpUserCredentials)
      .where(eq(mcpUserCredentials.userId, secondUserId));
    expect(associations).toEqual([]);
    const vault = await database
      .select()
      .from(credentials)
      .where(eq(credentials.keyId, secondUserId));
    expect(vault).toEqual([]);
    const audit = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, serverId));
    const rendered = JSON.stringify(audit);
    expect(rendered).not.toContain(`refuse-invalid_api_key-${suffix}`);
    expect(rendered).not.toContain(`refuse-validation_timeout-${suffix}`);
    expect(rendered).not.toContain(`refuse-rate_limited-${suffix}`);
  });

  test("serializes concurrent rotations and points at the only live key", async () => {
    await Promise.all([
      store.connectUserApiKey({
        serverId,
        userId,
        apiKey: `${apiKey}-concurrent-a`,
        by: `${userId}@openbot.test`,
      }),
      store.connectUserApiKey({
        serverId,
        userId,
        apiKey: `${apiKey}-concurrent-b`,
        by: `${userId}@openbot.test`,
      }),
    ]);

    const live = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_user_api_key"),
          eq(credentials.provider, serverId),
          eq(credentials.keyId, userId),
          isNull(credentials.revokedAt),
        ),
      );
    expect(live).toHaveLength(1);
    const [association] = await database
      .select({ credentialId: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, serverId),
          eq(mcpUserCredentials.userId, userId),
        ),
      );
    expect(association?.credentialId).toBe(live[0]?.id);
  });

  test("offboarding revokes personal API keys and removes their associations", async () => {
    await store.connectUserApiKey({
      serverId,
      userId: secondUserId,
      apiKey: `${apiKey}-offboarded`,
      by: secondUserId,
    });

    const result = await store.retireConnectionsFor(
      secondUserId,
      "admin@openbot.test",
    );
    expect(result.retired).toBe(1);
    const live = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_user_api_key"),
          eq(credentials.provider, serverId),
          eq(credentials.keyId, secondUserId),
          isNull(credentials.revokedAt),
        ),
      );
    expect(live).toEqual([]);
    expect(await store.connectionsFor(secondUserId)).toEqual([]);
  });

  test("disconnect revokes only the exact connection and repeats as not_connected", async () => {
    const [before] = await database
      .select({ credentialId: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, serverId),
          eq(mcpUserCredentials.userId, userId),
        ),
      );
    await store.disconnectUserConnection({
      serverId,
      userId,
      by: userId,
    });

    expect(await store.connectionsFor(userId)).toEqual([]);
    const [retired] = await database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, before?.credentialId ?? ""));
    expect(retired?.revokedAt).not.toBeNull();
    await expect(
      store.disconnectUserConnection({ serverId, userId, by: userId }),
    ).rejects.toMatchObject({ code: "not_connected" });
  });
});
