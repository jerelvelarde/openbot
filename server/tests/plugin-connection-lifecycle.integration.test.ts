import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createAuditStore, type TransactionalAuditStore } from "../src/audit";
import {
  type CredentialExecutor,
  type CredentialStoreValue,
  createCredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  credentials,
  mcpServers,
  mcpUserCredentials,
  revokedAccess,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const applicationName = `plugin_lifecycle_${randomUUID()}`;
const namedDatabaseUrl = new URL(databaseUrl);
namedDatabaseUrl.searchParams.set("application_name", applicationName);
const database = createDatabase(namedDatabaseUrl.toString(), TEST_POOL);
const observerDatabase = createDatabase(databaseUrl, { max: 1 });
const suite = randomUUID().slice(0, 8);
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const typefullyServerId = "typefully";
const connectAuditUser = `lifecycle-connect-audit-${suite}`;
const oauthAuditUser = `lifecycle-oauth-audit-${suite}`;
const disconnectAuditUser = `lifecycle-disconnect-audit-${suite}`;
const retireAuditUser = `lifecycle-retire-audit-${suite}`;
const offboardingRaceUser = `lifecycle-offboarding-race-${suite}`;
const removalRaceUser = `lifecycle-removal-race-${suite}`;
const removalAuditServer = `lifecycle-removal-audit-${suite}`;
const removalRaceServer = `lifecycle-removal-race-${suite}`;
const oauthAuditServer = `lifecycle-oauth-audit-${suite}`;
const userIds = [
  connectAuditUser,
  oauthAuditUser,
  disconnectAuditUser,
  retireAuditUser,
  offboardingRaceUser,
  removalRaceUser,
];
const baseAuditStore = createAuditStore(database);
const baseCredentials = createCredentialStore(database);
let typefullyExisted = false;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function auditStoreFailingOn(
  eventType:
    | "configuration.changed"
    | "mcp.account_connected"
    | "mcp.account_disconnected",
): TransactionalAuditStore {
  return {
    insert: baseAuditStore.insert,
    inTransaction: (transaction) => {
      const bound = baseAuditStore.inTransaction(transaction);
      return {
        insert: async (event) => {
          if (event.eventType === eventType) {
            throw new Error(`forced ${eventType} audit failure`);
          }
          await bound.insert(event);
        },
      };
    },
  };
}

function pluginStore(input?: {
  auditStore?: TransactionalAuditStore;
  credentialStore?: typeof baseCredentials;
  validateUserApiKey?: () => Promise<void>;
}) {
  return createPluginStore({
    database,
    auditStore: input?.auditStore ?? baseAuditStore,
    credentials: input?.credentialStore ?? baseCredentials,
    encryptionKey,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    validateUserApiKey: async () => {
      await input?.validateUserApiKey?.();
      return {
        accountId: `account-${suite}`,
        accountLabel: "Lifecycle account",
        keyLabel: "Lifecycle key",
      };
    },
  });
}

async function livePersonalCredentials(userId: string) {
  return database
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(
        inArray(credentials.kind, ["mcp_user_token", "mcp_user_api_key"]),
        eq(credentials.keyId, userId),
        isNull(credentials.revokedAt),
      ),
    );
}

async function associationsFor(userId: string) {
  return database
    .select({ credentialId: mcpUserCredentials.credentialId })
    .from(mcpUserCredentials)
    .where(eq(mcpUserCredentials.userId, userId));
}

async function waitForBlockedLifecycleLock(
  mutationSettled: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const blocked = await observerDatabase.execute(sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND cardinality(pg_blocking_pids(pid)) > 0
      LIMIT 1
    `);
    if (blocked.length > 0) return true;
    if (mutationSettled()) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the server-removal lifecycle lock.");
}

beforeAll(async () => {
  typefullyExisted =
    (
      await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, typefullyServerId))
    ).length > 0;
  await database
    .insert(mcpServers)
    .values({
      id: typefullyServerId,
      title: "Typefully",
      vendor: "Typefully",
      url: "https://api.typefully.com/v2",
      provenance: "first-party",
    })
    .onConflictDoNothing();
  await database.insert(users).values(
    userIds.map((id) => ({
      id,
      email: `${id}@openbot.test`,
      name: id,
      emailVerified: false,
    })),
  );
});

afterAll(async () => {
  await database
    .delete(mcpUserCredentials)
    .where(inArray(mcpUserCredentials.userId, userIds));
  await database
    .delete(mcpServers)
    .where(
      inArray(mcpServers.id, [
        oauthAuditServer,
        removalAuditServer,
        removalRaceServer,
      ]),
    );
  await database
    .delete(credentials)
    .where(inArray(credentials.keyId, [...userIds, removalAuditServer]));
  await database.delete(revokedAccess).where(
    inArray(
      revokedAccess.email,
      userIds.map((id) => `${id}@openbot.test`),
    ),
  );
  await database.delete(users).where(inArray(users.id, userIds));
  if (!typefullyExisted) {
    await database
      .delete(mcpServers)
      .where(eq(mcpServers.id, typefullyServerId));
  }
  await observerDatabase.$client.end();
});

describe("connection lifecycle state and audit atomicity", () => {
  test("rolls back API-key creation and rotation when lifecycle audit fails", async () => {
    const failingStore = pluginStore({
      auditStore: auditStoreFailingOn("mcp.account_connected"),
    });

    await expect(
      failingStore.connectUserApiKey({
        serverId: typefullyServerId,
        userId: connectAuditUser,
        apiKey: `connect-audit-${suite}`,
        by: connectAuditUser,
      }),
    ).rejects.toThrow("forced mcp.account_connected audit failure");
    expect(await associationsFor(connectAuditUser)).toEqual([]);
    expect(await livePersonalCredentials(connectAuditUser)).toEqual([]);

    await pluginStore().connectUserApiKey({
      serverId: typefullyServerId,
      userId: connectAuditUser,
      apiKey: `connect-before-failed-rotation-${suite}`,
      by: connectAuditUser,
    });
    const [before] = await associationsFor(connectAuditUser);
    await expect(
      failingStore.connectUserApiKey({
        serverId: typefullyServerId,
        userId: connectAuditUser,
        apiKey: `connect-failed-rotation-${suite}`,
        by: connectAuditUser,
      }),
    ).rejects.toThrow("forced mcp.account_connected audit failure");
    expect(await associationsFor(connectAuditUser)).toEqual([before]);
    expect(await livePersonalCredentials(connectAuditUser)).toEqual([
      { id: before?.credentialId },
    ]);
  });

  test("rolls back an OAuth connection when its lifecycle audit fails", async () => {
    await database.insert(mcpServers).values({
      id: oauthAuditServer,
      title: "OAuth audit",
      vendor: "test",
      url: "https://example.invalid/mcp",
      provenance: "custom",
    });

    await expect(
      pluginStore({
        auditStore: auditStoreFailingOn("mcp.account_connected"),
      }).recordConnection({
        serverId: oauthAuditServer,
        userId: oauthAuditUser,
        refreshToken: `oauth-audit-${suite}`,
        scope: "read",
      }),
    ).rejects.toThrow("forced mcp.account_connected audit failure");

    expect(await associationsFor(oauthAuditUser)).toEqual([]);
    expect(await livePersonalCredentials(oauthAuditUser)).toEqual([]);
  });

  test("rolls back disconnect when its lifecycle audit fails", async () => {
    const normal = pluginStore();
    await normal.connectUserApiKey({
      serverId: typefullyServerId,
      userId: disconnectAuditUser,
      apiKey: `disconnect-audit-${suite}`,
      by: disconnectAuditUser,
    });
    const [before] = await associationsFor(disconnectAuditUser);

    await expect(
      pluginStore({
        auditStore: auditStoreFailingOn("mcp.account_disconnected"),
      }).disconnectUserConnection({
        serverId: typefullyServerId,
        userId: disconnectAuditUser,
        by: disconnectAuditUser,
      }),
    ).rejects.toThrow("forced mcp.account_disconnected audit failure");

    expect(await associationsFor(disconnectAuditUser)).toEqual([before]);
    expect(await livePersonalCredentials(disconnectAuditUser)).toEqual([
      { id: before?.credentialId },
    ]);
  });

  test("rolls back offboarding retirement when its audit fails", async () => {
    const normal = pluginStore();
    await normal.connectUserApiKey({
      serverId: typefullyServerId,
      userId: retireAuditUser,
      apiKey: `retire-audit-${suite}`,
      by: retireAuditUser,
    });
    const [before] = await associationsFor(retireAuditUser);

    await expect(
      pluginStore({
        auditStore: auditStoreFailingOn("mcp.account_disconnected"),
      }).retireConnectionsFor(retireAuditUser, "admin@openbot.test"),
    ).rejects.toThrow("forced mcp.account_disconnected audit failure");

    expect(await associationsFor(retireAuditUser)).toEqual([before]);
    expect(await livePersonalCredentials(retireAuditUser)).toEqual([
      { id: before?.credentialId },
    ]);
  });

  test("rolls back server removal and credential revocation when audit fails", async () => {
    const [credential] = await database
      .insert(credentials)
      .values({
        kind: "mcp",
        provider: removalAuditServer,
        keyId: removalAuditServer,
        encryptedValue: "opaque-deployment-token",
        metadata: {},
      })
      .returning({ id: credentials.id });
    if (!credential) throw new Error("removal credential was not created");
    await database.insert(mcpServers).values({
      id: removalAuditServer,
      title: "Removal audit",
      vendor: "test",
      url: "https://example.invalid/mcp",
      credentialId: credential.id,
      provenance: "custom",
    });

    await expect(
      pluginStore({
        auditStore: auditStoreFailingOn("configuration.changed"),
      }).removeServer(removalAuditServer, "admin@openbot.test"),
    ).rejects.toThrow("forced configuration.changed audit failure");

    expect(
      await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, removalAuditServer)),
    ).toEqual([{ id: removalAuditServer }]);
    expect(
      await database
        .select({ revokedAt: credentials.revokedAt })
        .from(credentials)
        .where(eq(credentials.id, credential.id)),
    ).toEqual([{ revokedAt: null }]);
    expect(
      await database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          inArray(auditEvents.targetId, [removalAuditServer, credential.id]),
        ),
    ).toEqual([]);
  });
});

describe("connection lifecycle races", () => {
  test("connect racing offboarding cannot leave a live key or association", async () => {
    const validationEntered = deferred<void>();
    const releaseValidation = deferred<void>();
    const store = pluginStore({
      validateUserApiKey: async () => {
        validationEntered.resolve();
        await releaseValidation.promise;
      },
    });
    const connect = store.connectUserApiKey({
      serverId: typefullyServerId,
      userId: offboardingRaceUser,
      apiKey: `offboarding-race-${suite}`,
      by: offboardingRaceUser,
    });
    await validationEntered.promise;

    await database.insert(revokedAccess).values({
      email: `${offboardingRaceUser}@openbot.test`,
      revokedBy: "admin@openbot.test",
    });
    const offboarding = store.retireConnectionsFor(
      offboardingRaceUser,
      "admin@openbot.test",
    );
    await offboarding;
    releaseValidation.resolve();

    const [connectResult, offboardingResult] = await Promise.allSettled([
      connect,
      offboarding,
    ]);
    expect(connectResult).toEqual(
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "access_revoked" }),
      }),
    );
    expect(offboardingResult.status).toBe("fulfilled");
    expect(await associationsFor(offboardingRaceUser)).toEqual([]);
    expect(await livePersonalCredentials(offboardingRaceUser)).toEqual([]);
  });

  test("connect racing server removal cannot leave an orphan", async () => {
    await database.insert(mcpServers).values({
      id: removalRaceServer,
      title: "Removal race",
      vendor: "test",
      url: "https://example.invalid/mcp",
      provenance: "custom",
    });
    const credentialCreateEntered = deferred<void>();
    const releaseCredentialCreate = deferred<void>();
    const blockedCredentials = {
      ...baseCredentials,
      create: async (
        value: CredentialStoreValue,
        executor?: CredentialExecutor,
      ) => {
        if (
          value.kind === "mcp_user_token" &&
          value.provider === removalRaceServer
        ) {
          credentialCreateEntered.resolve();
          await releaseCredentialCreate.promise;
        }
        return baseCredentials.create(value, executor);
      },
    };
    const store = pluginStore({ credentialStore: blockedCredentials });
    const connect = store.recordConnection({
      serverId: removalRaceServer,
      userId: removalRaceUser,
      refreshToken: `removal-race-${suite}`,
      scope: "read",
    });
    await credentialCreateEntered.promise;
    let removalSettled = false;
    const removal = store
      .removeServer(removalRaceServer, "admin@openbot.test")
      .finally(() => {
        removalSettled = true;
      });
    const removalBlocked = await waitForBlockedLifecycleLock(
      () => removalSettled,
    );
    releaseCredentialCreate.resolve();

    const results = await Promise.allSettled([connect, removal]);
    expect(removalBlocked).toBe(true);
    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    expect(
      await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, removalRaceServer)),
    ).toEqual([]);
    expect(await associationsFor(removalRaceUser)).toEqual([]);
    expect(await livePersonalCredentials(removalRaceUser)).toEqual([]);
  });
});
