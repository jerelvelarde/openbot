import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * The whole path an administrator's request actually takes, with nothing stubbed between the request
 * and the row.
 *
 * The two halves are covered on their own: the store's refusals against a real database, and the
 * route's mapping of them against a stubbed store. Both passing does not prove the pair is wired
 * together, and the failure that would live in the gap is quiet in exactly the way that matters: a
 * refusal that reaches the browser as a 500 reads as a broken deployment rather than a correctable
 * mistake, and a refusal that stops short of the write leaves a row pointing at a credential the
 * next refresh spends. So this asks the question end to end and then looks in the table.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const suffix = randomUUID().slice(0, 8);

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  validateUserApiKey: async () => ({
    accountId: `route-account-${suffix}`,
    accountLabel: "Route Typefully",
    keyLabel: "OpenBot",
  }),
});

const ADMIN = {
  id: `route-admin-${suffix}`,
  email: `route-admin-${suffix}@openbot.test`,
  name: "An Administrator",
  image: null,
};

function request(
  body: unknown,
  role: "admin" | "user" = "admin",
  path = "/api/plugins/servers",
  method = "POST",
) {
  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; the real one is 15, pluginStore.
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );

  return app.request(`http://openbot.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const serverId = "google-drive";
const personalCredentialId = randomUUID();
const customServerId = `route-custom-${suffix}`;
const foreignCredentialId = randomUUID();
const ownCredentialId = randomUUID();

/** What this deployment already had, so a database somebody is using is left as it was found. */
let existing: { credentialId: string | null } | null = null;
let adminExisted = false;
let typefullyExisted = false;

beforeAll(async () => {
  adminExisted =
    (
      await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, ADMIN.id))
    ).length > 0;
  await database
    .insert(users)
    .values({ id: ADMIN.id, email: ADMIN.email, name: ADMIN.name })
    .onConflictDoNothing();
  typefullyExisted =
    (
      await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, "typefully"))
    ).length > 0;
  const [row] = await database
    .select({ credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  existing = row ?? null;

  const encrypted = await encryptSecret(`${"A".repeat(43)}=`, "not-read-here");
  await database.insert(credentials).values([
    {
      id: personalCredentialId,
      kind: "mcp_user_token",
      provider: serverId,
      keyId: `user_someone_else_${suffix}`,
      encryptedValue: encrypted,
      metadata: {},
    },
    {
      id: foreignCredentialId,
      kind: "mcp",
      // Minted for a different server, which is what makes it somebody else's to spend.
      provider: `route-elsewhere-${suffix}`,
      keyId: `mcp-elsewhere-${suffix}`,
      encryptedValue: encrypted,
      metadata: {},
    },
    {
      id: ownCredentialId,
      kind: "mcp",
      provider: customServerId,
      keyId: `mcp-${customServerId}`,
      encryptedValue: encrypted,
      metadata: {},
    },
  ]);
});

afterAll(async () => {
  await database
    .delete(mcpUserCredentials)
    .where(eq(mcpUserCredentials.userId, ADMIN.id));
  if (existing) {
    await database
      .update(mcpServers)
      .set({ credentialId: existing.credentialId })
      .where(eq(mcpServers.id, serverId));
  } else {
    await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
  await database.delete(mcpTools).where(eq(mcpTools.serverId, customServerId));
  await database.delete(mcpServers).where(eq(mcpServers.id, customServerId));
  await database.delete(credentials).where(eq(credentials.keyId, ADMIN.id));
  await database
    .delete(credentials)
    .where(
      inArray(credentials.id, [
        personalCredentialId,
        foreignCredentialId,
        ownCredentialId,
      ]),
    );
  if (!typefullyExisted) {
    await database.delete(mcpTools).where(eq(mcpTools.serverId, "typefully"));
    await database.delete(mcpServers).where(eq(mcpServers.id, "typefully"));
  }
  if (!adminExisted) {
    await database.delete(users).where(eq(users.id, ADMIN.id));
  }
});

async function serverRow() {
  const [row] = await database
    .select({ credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  return row ?? null;
}

describe("adding a curated server over HTTP", () => {
  test("a credential of the wrong kind is refused, and nothing is written", async () => {
    const before = await serverRow();

    const response = await request({
      key: serverId,
      credentialId: personalCredentialId,
    });

    // Not a 500. An administrator who picked the wrong row is told what to do about it.
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(
      "takes no credential when it is added",
    );

    // And the refusal stopped the write rather than reporting on it.
    expect(await serverRow()).toEqual(before);
  });

  test("a malformed credential id is refused the same way, not as a database error", async () => {
    const response = await request({ key: serverId, credentialId: "nonsense" });

    expect(response.status).toBe(400);
  });

  test("the add the admin screen makes still works and writes the row", async () => {
    const response = await request({ key: serverId });

    expect(response.status).toBe(200);
    expect((await response.json()).server.id).toBe(serverId);
    // Whatever the column held before, not null: an add that names no credential leaves a registered
    // OAuth client alone, so asserting null here would pass on a fresh database and fail on the one
    // deployment shape that behaviour exists for.
    expect(await serverRow()).toEqual({
      credentialId: existing?.credentialId ?? null,
    });
  });

  test("somebody who is not an administrator is refused before the store", async () => {
    const response = await request({ key: serverId }, "user");

    expect(response.status).toBe(403);
  });
});

/**
 * The same two rules, asked over HTTP against the real store.
 *
 * Both are refusals an administrator has to be able to act on, so what they must never be is a 500:
 * "something went wrong" sends somebody to look at the deployment when the answer is to pick a
 * different token or remove the server first.
 */
describe("adding a server by URL over HTTP", () => {
  const custom = "/api/plugins/servers/custom";

  test("another server's token is refused rather than spent", async () => {
    const response = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://collector.attacker.example/mcp",
        credentialId: foreignCredentialId,
      },
      "admin",
      custom,
    );

    expect(response.status).toBe(400);

    const rows = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, customServerId));
    expect(rows).toHaveLength(0);
  });

  test("re-addressing a server that holds a token is refused", async () => {
    const added = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://legit.vendor.example/mcp",
        credentialId: ownCredentialId,
      },
      "admin",
      custom,
    );
    expect(added.status).toBe(200);

    const moved = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://collector.attacker.example/mcp",
        credentialId: ownCredentialId,
      },
      "admin",
      custom,
    );
    expect(moved.status).toBe(400);

    const [row] = await database
      .select({ url: mcpServers.url })
      .from(mcpServers)
      .where(eq(mcpServers.id, customServerId));
    expect(row?.url).toBe("https://legit.vendor.example/mcp");
  });
});

describe("connecting a personal Typefully key over HTTP", () => {
  test("stores and returns only the signed-in person's safe connection metadata", async () => {
    const enabled = await request({ key: "typefully" });
    expect(enabled.status).toBe(200);

    const secret = `tf-route-${suffix}`;
    const connected = await request(
      { apiKey: secret },
      "user",
      "/api/plugins/connections/typefully/api-key",
      "PUT",
    );
    expect(connected.status).toBe(200);
    const responseText = await connected.text();
    expect(responseText).not.toContain(secret);
    expect(JSON.parse(responseText)).toMatchObject({
      connection: {
        serverId: "typefully",
        authMethod: "api_key",
        accountLabel: "Route Typefully",
      },
    });

    const [association] = await database
      .select({
        userId: mcpUserCredentials.userId,
        authMethod: mcpUserCredentials.authMethod,
        scope: mcpUserCredentials.scope,
      })
      .from(mcpUserCredentials)
      .where(eq(mcpUserCredentials.userId, ADMIN.id));
    expect(association).toEqual({
      userId: ADMIN.id,
      authMethod: "api_key",
      scope: null,
    });

    const disconnected = await request(
      {},
      "user",
      "/api/plugins/connections/typefully",
      "DELETE",
    );
    expect(disconnected.status).toBe(200);
    const repeated = await request(
      {},
      "user",
      "/api/plugins/connections/typefully",
      "DELETE",
    );
    expect(repeated.status).toBe(404);
    expect(await repeated.json()).toMatchObject({ code: "not_connected" });
  });
});
