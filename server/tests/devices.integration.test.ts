import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { pushDevices, users } from "../src/db/schema";
import { createDeviceStore, readRegistration } from "../src/devices";
import { TEST_POOL } from "./support/database";

/**
 * What registering a device must guarantee.
 *
 * A push token is a standing capability to interrupt somebody, usually on a device in their pocket.
 * The properties worth pinning are the ones whose absence is a person receiving somebody else's
 * approvals:
 *
 *  - the same token registering twice is one device, not two
 *  - a handset that changes hands stops notifying the old owner
 *  - revoking is scoped to the owner, so an id cannot be guessed
 *  - a revoked device is not in the list a notification is addressed to
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createDeviceStore(database);

afterAll(async () => {
  await database.$client.close();
});

/** Two real users, rolled back afterwards. The table has a foreign key, so these must exist. */
async function withTwoPeople(
  body: (a: string, b: string) => Promise<void>,
): Promise<void> {
  const a = `user_${randomUUID()}`;
  const b = `user_${randomUUID()}`;
  await database.insert(users).values([
    { id: a, name: "A", email: `${a}@example.test`, emailVerified: true },
    { id: b, name: "B", email: `${b}@example.test`, emailVerified: true },
  ]);
  try {
    await body(a, b);
  } finally {
    await database.delete(pushDevices).where(inArray(pushDevices.userId, [a, b]));
    await database.delete(users).where(inArray(users.id, [a, b]));
  }
}

describe("the devices that have asked to be told", () => {
  test("the same token registering twice is one device", async () => {
    await withTwoPeople(async (person) => {
      const token = `ExponentPushToken[${randomUUID()}]`;

      const first = await store.register({
        userId: person,
        platform: "expo",
        token,
      });
      const second = await store.register({
        userId: person,
        platform: "expo",
        token,
      });

      // A phone re-registers on every launch. Two rows would push the same message twice to the same
      // handset, and revoking one would leave the other notifying.
      expect(second.id).toBe(first.id);
      expect(await store.list(person)).toHaveLength(1);
    });
  });

  test("a handset that changes hands stops notifying the old owner", async () => {
    await withTwoPeople(async (older, newer) => {
      const token = `ExponentPushToken[${randomUUID()}]`;
      await store.register({ userId: older, platform: "expo", token });
      await store.register({ userId: newer, platform: "expo", token });

      // A shared or re-issued phone. Keeping both registrations would send one person's approvals to
      // another person's lock screen.
      expect(await store.list(older)).toEqual([]);
      expect(await store.list(newer)).toHaveLength(1);
    });
  });

  test("revoking is scoped to the owner", async () => {
    await withTwoPeople(async (mine, theirs) => {
      const device = await store.register({
        userId: mine,
        platform: "expo",
        token: `ExponentPushToken[${randomUUID()}]`,
      });

      // Scoped in the WHERE rather than checked first, so guessing an id achieves nothing.
      expect(await store.revoke(theirs, device.id)).toBe(false);
      expect(await store.list(mine)).toHaveLength(1);

      expect(await store.revoke(mine, device.id)).toBe(true);
      expect(await store.list(mine)).toEqual([]);
    });
  });

  test("a revoked device is not addressed, and re-registering brings it back", async () => {
    await withTwoPeople(async (person) => {
      const token = `ExponentPushToken[${randomUUID()}]`;
      const device = await store.register({
        userId: person,
        platform: "expo",
        token,
      });
      await store.revoke(person, device.id);

      expect(await store.forUsers([person])).toEqual([]);

      // "Stop notifying me" has to be reversible from the phone itself, or turning it back on means
      // asking an administrator.
      const again = await store.register({
        userId: person,
        platform: "expo",
        token,
      });
      expect(again.id).toBe(device.id);
      expect(await store.forUsers([person])).toHaveLength(1);
    });
  });

  test("asking about nobody asks the database nothing", async () => {
    expect(await store.forUsers([])).toEqual([]);
  });
});

describe("reading a registration request", () => {
  test("accepts a platform it can deliver to", () => {
    expect(
      readRegistration({ platform: "expo", token: "  a-real-looking-token  " }),
    ).toEqual({ ok: true, platform: "expo", token: "a-real-looking-token" });
  });

  test("refuses what cannot be delivered to", () => {
    // A stored value that is not a push token leaves a row that looks like a working registration
    // and never rings, which is worse than a refusal at the door.
    expect(readRegistration({ platform: "carrier-pigeon", token: "xxxxxxxx" }).ok).toBe(false);
    expect(readRegistration({ platform: "expo", token: "short" }).ok).toBe(false);
    expect(readRegistration({ platform: "expo" }).ok).toBe(false);
    expect(readRegistration(null).ok).toBe(false);
    expect(readRegistration("expo").ok).toBe(false);
  });
});
