import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { revokedAccess, users } from "../src/db/schema";
import { createExternalLinkStore } from "../src/external/link-store";
import { TEST_POOL } from "./support/database";

function testDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot"
  );
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createExternalLinkStore(database);
const suite = randomUUID().slice(0, 8);
const createdUsers: string[] = [];
const createdRevocations: string[] = [];

function userId(label: string): string {
  const id = `external_link_${label}_${suite}`;
  createdUsers.push(id);
  return id;
}

function email(label: string): string {
  return `${label}_${suite}@example.test`;
}

async function createUser(input: {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
}) {
  await database.insert(users).values({
    ...input,
    emailVerified: input.emailVerified ?? true,
  });
}

afterAll(async () => {
  if (createdRevocations.length) {
    await database
      .delete(revokedAccess)
      .where(inArray(revokedAccess.email, createdRevocations));
  }
  if (createdUsers.length) {
    await database.delete(users).where(inArray(users.id, createdUsers));
  }
  await database.$client.end();
});

describe("external user links", () => {
  test("links one Slack identity to one OpenBot user and reads its provider email", async () => {
    const openbotUserId = userId("linked");
    const teamId = `T${suite}`;
    await createUser({
      id: openbotUserId,
      email: email("linked"),
      name: "Linked person",
    });

    await store.link({
      provider: "slack",
      providerTenantId: teamId,
      providerUserId: "U123",
      openbotUserId,
      providerEmail: "person@example.com",
    });

    expect(await store.find("slack", teamId, "U123")).toMatchObject({
      provider: "slack",
      providerTenantId: teamId,
      providerUserId: "U123",
      openbotUserId,
      providerEmail: "person@example.com",
    });
  });

  test("idempotently links the same provider identity to the same OpenBot user", async () => {
    const openbotUserId = userId("idempotent");
    const teamId = `T${suite}`;
    await createUser({
      id: openbotUserId,
      email: email("idempotent"),
      name: "Idempotent person",
    });

    const input = {
      provider: "slack" as const,
      providerTenantId: teamId,
      providerUserId: "U456",
      openbotUserId,
      providerEmail: "person@example.com",
    };
    const linked = await store.link(input);
    const repeated = await store.link(input);

    expect(repeated).toEqual(linked);
  });

  test("never silently reassigns an existing provider identity to another user", async () => {
    const firstUserId = userId("first");
    const secondUserId = userId("second");
    const teamId = `T${suite}`;
    await createUser({
      id: firstUserId,
      email: email("first"),
      name: "First person",
    });
    await createUser({
      id: secondUserId,
      email: email("second"),
      name: "Second person",
    });
    await store.link({
      provider: "slack",
      providerTenantId: teamId,
      providerUserId: "U789",
      openbotUserId: firstUserId,
      providerEmail: "first@example.com",
    });

    await expect(
      store.link({
        provider: "slack",
        providerTenantId: teamId,
        providerUserId: "U789",
        openbotUserId: secondUserId,
        providerEmail: "second@example.com",
      }),
    ).rejects.toThrow("That Slack identity is already linked.");
    expect(await store.find("slack", teamId, "U789")).toMatchObject({
      openbotUserId: firstUserId,
      providerEmail: "first@example.com",
    });
  });

  test("finds exactly one active verified OpenBot user by a normalized email", async () => {
    const openbotUserId = userId("normalized");
    const address = email("normalized");
    await createUser({
      id: openbotUserId,
      email: address,
      name: "Normalized person",
    });

    await expect(
      store.findVerifiedUserByEmail(`  ${address.toUpperCase()}  `),
    ).resolves.toEqual({ id: openbotUserId, name: "Normalized person" });
  });

  test("does not find an unverified OpenBot user by email", async () => {
    const openbotUserId = userId("unverified");
    const address = email("unverified");
    await createUser({
      id: openbotUserId,
      email: address,
      name: "Unverified person",
      emailVerified: false,
    });

    await expect(store.findVerifiedUserByEmail(address)).resolves.toBeNull();
  });

  test("excludes a user whose lower-cased email is revoked", async () => {
    const openbotUserId = userId("revoked");
    const address = email("revoked");
    await createUser({
      id: openbotUserId,
      email: address.toUpperCase(),
      name: "Revoked person",
    });
    const normalized = address.toLowerCase();
    createdRevocations.push(normalized);
    await database
      .insert(revokedAccess)
      .values({ email: normalized, revokedBy: "test" });

    await expect(store.findVerifiedUserByEmail(address)).resolves.toBeNull();
  });

  test("returns null for ambiguous active verified users", async () => {
    const firstUserId = userId("ambiguous_first");
    const secondUserId = userId("ambiguous_second");
    const address = email("ambiguous");
    await createUser({
      id: firstUserId,
      email: address,
      name: "First ambiguous person",
    });
    await createUser({
      id: secondUserId,
      email: address.toUpperCase(),
      name: "Second ambiguous person",
    });

    await expect(store.findVerifiedUserByEmail(address)).resolves.toBeNull();
  });
});
