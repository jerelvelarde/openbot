/**
 * The devices that have asked to be told.
 *
 * A push token is a standing capability to interrupt somebody, on a device that is usually in their
 * pocket. Two consequences run through this file:
 *
 *  - It is registered, never inferred, and revocable. A person can see what is registered to them
 *    and take it away, which is the only way "stop notifying me" can be a thing they control rather
 *    than a thing they ask for.
 *  - It cannot be created while the deployment is running without authentication. `OPENBOT_DEV_NO_AUTH`
 *    admits every caller as one administrator, which is defensible on loopback and is not defensible
 *    for something that reaches a phone: the next caller would be registering a device against
 *    somebody they are not.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "./db/client";
import { pushDevices } from "./db/schema";
import type { Device } from "./notify";

export type DeviceStore = {
  /** Register, or revive and refresh a token this person already had. */
  register(input: {
    userId: string;
    platform: string;
    token: string;
  }): Promise<Device>;
  /** Everything currently live for one person. */
  list(userId: string): Promise<(Device & { lastSeenAt: string | null })[]>;
  /** All live devices for a set of people, for a notification about to be sent. */
  forUsers(userIds: string[]): Promise<Device[]>;
  /** Revoke one, if it is this person's to revoke. */
  revoke(userId: string, id: string): Promise<boolean>;
};

export function createDeviceStore(database: Database): DeviceStore {
  return {
    async register({ userId, platform, token }) {
      /**
       * The same token registering twice is one device, not two.
       *
       * A phone re-registers on every launch, and on a token rotation. Inserting each time would
       * push the same message several times to the same handset, and revoking one row would leave
       * the others notifying. Matched on the token, which is the identity the push service uses.
       */
      const [existing] = await database
        .select()
        .from(pushDevices)
        .where(eq(pushDevices.token, token))
        .limit(1);

      if (existing) {
        if (existing.userId !== userId) {
          /**
           * The same handset, now somebody else's.
           *
           * A shared or re-issued phone. The old owner's registration is replaced rather than kept
           * alongside, because keeping it would send one person's approvals to another's lock screen.
           */
          const [moved] = await database
            .update(pushDevices)
            .set({
              userId,
              platform,
              revokedAt: null,
              lastSeenAt: new Date(),
            })
            .where(eq(pushDevices.id, existing.id))
            .returning();
          if (!moved) throw new Error("The device could not be registered.");
          return toDevice(moved);
        }

        const [refreshed] = await database
          .update(pushDevices)
          .set({ platform, revokedAt: null, lastSeenAt: new Date() })
          .where(eq(pushDevices.id, existing.id))
          .returning();
        if (!refreshed) throw new Error("The device could not be registered.");
        return toDevice(refreshed);
      }

      const [row] = await database
        .insert(pushDevices)
        .values({
          id: `device_${crypto.randomUUID()}`,
          userId,
          platform,
          token,
          lastSeenAt: new Date(),
        })
        .returning();
      if (!row) throw new Error("The device could not be registered.");
      return toDevice(row);
    },

    async list(userId) {
      const rows = await database
        .select()
        .from(pushDevices)
        .where(
          and(eq(pushDevices.userId, userId), isNull(pushDevices.revokedAt)),
        );
      return rows.map((row) => ({
        ...toDevice(row),
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      }));
    },

    async forUsers(userIds) {
      if (userIds.length === 0) return [];
      const rows = await database
        .select()
        .from(pushDevices)
        .where(
          and(
            inArray(pushDevices.userId, userIds),
            isNull(pushDevices.revokedAt),
          ),
        );
      return rows.map(toDevice);
    },

    async revoke(userId, id) {
      // Scoped to the owner in the WHERE rather than checked first, so one person cannot revoke
      // another's device by guessing an id.
      const rows = await database
        .update(pushDevices)
        .set({ revokedAt: new Date() })
        .where(and(eq(pushDevices.id, id), eq(pushDevices.userId, userId)))
        .returning({ id: pushDevices.id });
      return rows.length > 0;
    },
  };
}

function toDevice(row: typeof pushDevices.$inferSelect): Device {
  return {
    id: row.id,
    userId: row.userId,
    platform: row.platform,
    token: row.token,
  };
}

/** The platforms a token can be for. Anything else is a typo, not a new platform. */
const PLATFORMS = new Set(["expo", "ios", "android"]);

export type DeviceRegistration =
  | { ok: true; platform: string; token: string }
  | { ok: false; reason: string };

/**
 * Read a registration request.
 *
 * Strict about the token's shape on purpose: a value that is not a push token cannot be delivered
 * to, and storing it would leave a row that looks like a working registration and never rings.
 */
export function readRegistration(body: unknown): DeviceRegistration {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "Send a platform and a token." };
  }
  const { platform, token } = body as Record<string, unknown>;
  if (typeof platform !== "string" || !PLATFORMS.has(platform)) {
    return {
      ok: false,
      reason: `platform must be one of ${[...PLATFORMS].join(", ")}.`,
    };
  }
  if (typeof token !== "string" || token.trim().length < 8) {
    return { ok: false, reason: "token is missing." };
  }
  return { ok: true, platform, token: token.trim() };
}
