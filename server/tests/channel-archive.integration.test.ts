import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createChannelEventHub,
  startChannelActivityListener,
  type RosterActivityEvent,
} from "../src/channels/events";
import {
  ChannelNotFoundError,
  ChannelPackageOwnedError,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);

const testPrefix = `channel-archive-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdPackageIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  // After the channels, because a channel row references the package that defines it.
  for (const packageId of createdPackageIds.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, packageId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Channel Archive Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor, name = "Expense Manager") {
  const profile = await profileStore.create(owner, {
    name,
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createChannel(owner: AgentActor, agentIds: string[]) {
  const channel = await store.create(owner, agentIds);
  createdChannelIds.push(channel.id);
  return channel;
}

/** A deployment package, for the ownership check that refuses to touch what configuration owns. */
async function createPackage() {
  const [row] = await database
    .insert(deploymentPackages)
    .values({
      tenantId: `${testPrefix}-tenant-${randomUUID()}`,
      sourcePath: "/tmp/none",
      checksum: "0",
    })
    .returning({ id: deploymentPackages.id });
  if (!row) throw new Error("package row was not created");
  createdPackageIds.push(row.id);
  return row.id;
}

/**
 * A crowd of members, inserted directly: `create` adds only the caller.
 *
 * The ids are the shape every other user in this file gets, because their length is the point. An
 * announcement carries one id per member, so a test that shortened them would prove a size bound
 * for ids nothing produces.
 */
async function createMembers(channelId: string, count: number) {
  const memberIds = Array.from(
    { length: count },
    () => `${testPrefix}-user-${randomUUID()}`,
  );
  await database.insert(users).values(
    memberIds.map((id) => ({
      id,
      email: `${id}@example.test`,
      name: "Channel Archive Crowd Member",
    })),
  );
  createdUserIds.push(...memberIds);
  await database
    .insert(channelMemberships)
    .values(memberIds.map((userId) => ({ channelId, userId })));
  return memberIds;
}

/**
 * Hold one uncommitted write to a channel open, and hand back the commit.
 *
 * The shape `channel-routes.test.ts`'s "deletion committing mid-creation" test uses, for the reason
 * it gives: a race between two connections is a test only if the interleaving is chosen rather than
 * hoped for. The returned transaction has already taken the row's write lock and does not commit
 * until `finish` runs, so a store call started in between reads the pre-image on its own snapshot
 * and then blocks on the write. That gap — between what a call read and what it writes — is where
 * every finding below lives.
 *
 * `TEST_POOL` is two connections, which is exactly this and the store call. Nothing else may touch
 * the database until `finish` has resolved.
 */
async function heldWrite(
  channelId: string,
  values: {
    archivedAt?: Date | null;
    deletedAt?: Date | null;
    /** What a tenant-package sync writes onto a channel row that already exists. */
    packageId?: string | null;
  },
) {
  let markApplied: () => void = () => {};
  let release: () => void = () => {};
  const applied = new Promise<void>((resolve) => {
    markApplied = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed = database.transaction(async (transaction) => {
    await transaction
      .update(channels)
      .set(values)
      .where(eq(channels.id, channelId));
    markApplied();
    await held;
  });
  await applied;
  return {
    finish: async () => {
      release();
      await committed;
    },
  };
}

/** Long enough for a store call to have reached the write it must block on. */
const REACHED_THE_WRITE = 250;

/**
 * The other half of "hidden, not frozen": an archived channel is not a dead end, because saying
 * something in it is how it comes back.
 */
describe("activity in an archived channel", () => {
  test("brings it back", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.setArchived(owner, channel.id, true);
    await store.recordActivity(owner, channel.id, {
      text: "One more thing",
      agentId: null,
      at: new Date(),
    });

    const [row] = await database
      .select({
        archivedAt: channels.archivedAt,
        lastMessage: channels.lastMessage,
      })
      .from(channels)
      .where(eq(channels.id, channel.id));

    // Hidden, not frozen: the archive is a tidying gesture, and typing in it undoes it.
    expect(row?.archivedAt).toBeNull();
    expect(row?.lastMessage).toBe("One more thing");
  });

  test("leaves a channel that was not archived alone", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.recordActivity(owner, channel.id, {
      text: "First thing",
      agentId: null,
      at: new Date(),
    });

    const [row] = await database
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, channel.id));

    expect(row?.archivedAt).toBeNull();
  });

  test("still refuses a deleted channel", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.softDelete(owner, channel.id);

    // Deleting and archiving are different acts, and only archiving is undone by typing.
    await expect(
      store.recordActivity(owner, channel.id, {
        text: "Anybody there",
        agentId: null,
        at: new Date(),
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  test("does not restore on a report the store rejected as stale", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    const now = new Date();
    await store.recordActivity(owner, channel.id, {
      text: "Recent",
      agentId: null,
      at: now,
    });
    await store.setArchived(owner, channel.id, true);

    // Older than what is stored, so the store ignores it as stale. An ignored report is not news,
    // and must not quietly unarchive the conversation either.
    await store.recordActivity(owner, channel.id, {
      text: "Older",
      agentId: null,
      at: new Date(now.getTime() - 60_000),
    });

    const [row] = await database
      .select({
        archivedAt: channels.archivedAt,
        lastMessage: channels.lastMessage,
      })
      .from(channels)
      .where(eq(channels.id, channel.id));

    expect(row?.archivedAt).not.toBeNull();
    expect(row?.lastMessage).toBe("Recent");
  });
});

/**
 * The route test proves the endpoint calls the store. These prove what the store actually writes,
 * which a fake store cannot.
 */
describe("archiving a channel, in the database", () => {
  test("does not restamp on a repeat call", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.setArchived(owner, channel.id, true);
    const [first] = await database
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, channel.id));

    await store.setArchived(owner, channel.id, true);
    const [second] = await database
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, channel.id));

    // Otherwise the row's archive time drifts forward on every click of an already-archived row.
    expect(second?.archivedAt).toEqual(first?.archivedAt);
  });

  test("reports whether the call actually changed anything", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    // A genuine transition, in each direction, reports true.
    await expect(store.setArchived(owner, channel.id, true)).resolves.toBe(
      true,
    );
    await expect(store.setArchived(owner, channel.id, false)).resolves.toBe(
      true,
    );

    // A repeat call in the state already reached reports false — the route's audit write depends on
    // this to tell "changed" from "already there".
    await expect(store.setArchived(owner, channel.id, false)).resolves.toBe(
      false,
    );
    await store.setArchived(owner, channel.id, true);
    await expect(store.setArchived(owner, channel.id, true)).resolves.toBe(
      false,
    );
  });

  test("restores by clearing the column, not by writing a second flag", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.setArchived(owner, channel.id, true);
    await store.setArchived(owner, channel.id, false);

    const [row] = await database
      .select({
        archivedAt: channels.archivedAt,
        deletedAt: channels.deletedAt,
      })
      .from(channels)
      .where(eq(channels.id, channel.id));

    expect(row?.archivedAt).toBeNull();
    expect(row?.deletedAt).toBeNull();
  });

  test("refuses a deleted channel", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.softDelete(owner, channel.id);

    // A deleted channel is in no roster, so nothing about it is archivable.
    await expect(
      store.setArchived(owner, channel.id, true),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  test("refuses a channel the caller is not in", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await expect(
      store.setArchived(stranger, channel.id, true),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });
});

/**
 * The decision and the write, under a writer that commits between them.
 *
 * Every test here is the same shape: something else changes the channel while the call is in flight,
 * and the call has to answer about the row as it is when it writes rather than as it was when it
 * looked. Read committed gives a plain `select` a snapshot and no lock, so a call that decides from
 * one and then writes on `id` alone decides about a row that no longer exists.
 *
 * `softDelete`, `setPinned` and `markRead` are tested here too, rather than beside the rest of their
 * own tests in `channel-routes.test.ts`: all three share this hazard exactly and share the helper
 * above. The last two are the shape the others are not — the row they write is the membership and the
 * row they have to decide from is the channel, so no guard on the row being written can close the gap
 * and holding the channel across both statements is the only thing that does.
 */
describe("deciding from a read, and writing on it", () => {
  test("does not stamp again when another archive commits mid-call", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    const stamp = new Date(Date.now() - 60_000);
    const other = await heldWrite(channel.id, { archivedAt: stamp });
    const archiving = store.setArchived(owner, channel.id, true);
    await Bun.sleep(REACHED_THE_WRITE);
    await other.finish();

    /*
     * Nothing changed, because it was already archived by the time this call could write.
     *
     * Two concurrent archives used to report `true` twice: each read `archived_at is null` on its own
     * snapshot, and the update was keyed on the channel id alone, so the second overwrote the first's
     * stamp and announced again. The route audits on that answer, so one archiving laid down two
     * `channel.archived` rows — the thing the route's own comment says it prevents.
     */
    await expect(archiving).resolves.toBe(false);

    const [row] = await database
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(row?.archivedAt).toEqual(stamp);
  });

  test("refuses a channel whose deletion commits mid-call", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    const other = await heldWrite(channel.id, { deletedAt: new Date() });
    const archiving = store.setArchived(owner, channel.id, true);
    await Bun.sleep(REACHED_THE_WRITE);
    await other.finish();

    // The same answer a delete that had already committed gets. Without the guard on the write, the
    // deleted channel was archived anyway and announced to every member, each of whom refetched a
    // roster that cannot show the row — the exact case the read's own comment claims to prevent.
    await expect(archiving).rejects.toBeInstanceOf(ChannelNotFoundError);

    const [row] = await database
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(row?.archivedAt).toBeNull();
  });

  test("refuses a delete whose twin commits mid-call", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    const stamp = new Date(Date.now() - 60_000);
    const other = await heldWrite(channel.id, { deletedAt: stamp });
    const deleting = store.softDelete(owner, channel.id);
    await Bun.sleep(REACHED_THE_WRITE);
    await other.finish();

    // The read said the channel was there and the write found it already gone. Nobody looked at that
    // answer before, so the call announced `deleted: true` to every member and let the route write a
    // second `channel.deleted` row for a deletion it had not done.
    await expect(deleting).rejects.toBeInstanceOf(ChannelNotFoundError);

    const [row] = await database
      .select({ deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(row?.deletedAt).toEqual(stamp);
  });

  test("refuses a delete once a package claims the channel mid-call", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const packageId = await createPackage();

    const other = await heldWrite(channel.id, { packageId });
    const deleting = store.softDelete(owner, channel.id);
    await Bun.sleep(REACHED_THE_WRITE);
    await other.finish();

    /*
     * The ownership check is the one thing here that the write cannot re-check for itself.
     *
     * `deleted_at` is a term in the update, so a delete landing in the gap is caught by the write. But
     * `package_id` is not, and cannot be — the check is "does configuration own this", and the answer
     * decides whether to refuse rather than what to write. Read on a plain `select` under read
     * committed, that answer came from a snapshot with no lock behind it, and
     * `synchronizeTenantPackage` upserts `package_id` onto channel rows that already exist: a sync
     * committing in the gap got its channel soft-deleted anyway, which is the one thing
     * `ChannelPackageOwnedError` exists to prevent and which no sync puts back. `setArchived`'s twin
     * of this read has always held the row; the two were asymmetric, and this was the one that was
     * wrong.
     */
    await expect(deleting).rejects.toBeInstanceOf(ChannelPackageOwnedError);

    const [row] = await database
      .select({ deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(row?.deletedAt).toBeNull();
  });

  test("refuses a pin whose channel's deletion commits mid-call", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    const other = await heldWrite(channel.id, { deletedAt: new Date() });
    const pinning = store.setPinned(owner, channel.id, true);
    await Bun.sleep(REACHED_THE_WRITE);
    await other.finish();

    /*
     * A pin writes `channel_memberships` and its guard is about `channels`, which is what made this
     * the one guard in the file that a lock on the row being written could not close.
     *
     * It was an `exists` subquery on the write. Under read committed that subquery reads `channels` on
     * the writing statement's own snapshot and takes no lock there, so a delete committing in the gap
     * left the pin applied and announced for a channel that is gone from every roster — every tab of
     * this person's refetching a roster that cannot show the row, which is the outcome the guard's own
     * comment says it prevents. The bot-chat twin has no such gap: for it the pin and the `deleted_at`
     * are columns of one row.
     */
    await expect(pinning).rejects.toBeInstanceOf(ChannelNotFoundError);

    const [row] = await database
      .select({ pinnedAt: channelMemberships.pinnedAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channel.id),
          eq(channelMemberships.userId, owner.id),
        ),
      );
    expect(row?.pinnedAt).toBeNull();
  });

  test("refuses a read marker whose channel's deletion commits mid-call", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    const other = await heldWrite(channel.id, { deletedAt: new Date() });
    const marking = store.markRead(owner, channel.id);
    await Bun.sleep(REACHED_THE_WRITE);
    await other.finish();

    // The same two-table gap `setPinned` had, and the same fix. What it left behind was a
    // `last_read_at` on a conversation no read will ever return again.
    await expect(marking).rejects.toBeInstanceOf(ChannelNotFoundError);

    const [row] = await database
      .select({ lastReadAt: channelMemberships.lastReadAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channel.id),
          eq(channelMemberships.userId, owner.id),
        ),
      );
    expect(row?.lastReadAt).toBeNull();
  });

  test("refuses a report whose channel's deletion commits mid-call", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    const other = await heldWrite(channel.id, { deletedAt: new Date() });
    const reporting = store.recordActivity(owner, channel.id, {
      text: "Anybody there",
      agentId: null,
      at: new Date(),
    });
    await Bun.sleep(REACHED_THE_WRITE);
    await other.finish();

    /*
     * The delete direction of the same method the restore test below covers.
     *
     * `recordActivity`'s update names the channel id and the moves-forwards-only comparison and
     * nothing else — no `deleted_at` term — so everything keeping a report off a deleted channel rests
     * on the locked read above it. Without the lock the read decides from a snapshot taken before the
     * delete, and a client holding a stale roster row bumps `last_message` on a channel nobody can
     * see and announces it to every member, each of whom refetches for an invisible row.
     */
    await expect(reporting).rejects.toBeInstanceOf(ChannelNotFoundError);

    const [row] = await database
      .select({ lastMessage: channels.lastMessage })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(row?.lastMessage).toBeNull();
  });

  /*
   * The restore direction, which is the one that must not be lossy.
   *
   * `recordActivity` clears `archived_at` on its own write, correctly. What it has to get right as
   * well is SAYING SO: `app/src/lib/channels/use-channel-events.ts` refetches only when the event
   * carries `archived`, so an event that omits it leaves the conversation restored in the database
   * and hidden on every viewer until something unrelated makes them refetch. Deciding that from a
   * read taken before the write is how the field goes missing.
   */
  test("still says the conversation came back when the archive lands after its read", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    const hub = createChannelEventHub();
    const received: RosterActivityEvent[] = [];
    const arrived = new Promise<void>((resolve) => {
      hub.register(owner.id, (payload) => {
        received.push(JSON.parse(payload) as RosterActivityEvent);
        resolve();
      });
    });
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      const other = await heldWrite(channel.id, { archivedAt: new Date() });
      const reporting = store.recordActivity(owner, channel.id, {
        text: "One more thing",
        agentId: null,
        at: new Date(),
      });
      await Bun.sleep(REACHED_THE_WRITE);
      await other.finish();

      // The report restored it, so it has to report that it did: the route writes
      // `channel.unarchived` from this answer, and the event carries `archived: false` from it.
      await expect(reporting).resolves.toEqual({ restored: true });
      await within5s(arrived);
    } finally {
      await listener.stop();
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ archived: false });
  });
});

/**
 * How big an announcement is allowed to get.
 *
 * `pg_notify` refuses a payload over 8000 bytes, and it runs inside the transaction that wrote the
 * row, so the overflow does not lose the announcement — it loses the write.
 */
describe("announcing to a channel with many members", () => {
  test("tells every member, and the message survives", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    // Past the point where one id per member overflows the cap: these ids run to about 95
    // characters, so a single payload naming all of them is some 15KB of the 8000 allowed.
    const memberIds = await createMembers(channel.id, 150);
    const everybody = [owner.id, ...memberIds];

    const hub = createChannelEventHub();
    const heard = new Map<string, number>();
    const allHeard = new Promise<void>((resolve) => {
      for (const memberId of everybody) {
        hub.register(memberId, () => {
          heard.set(memberId, (heard.get(memberId) ?? 0) + 1);
          if (heard.size === everybody.length) resolve();
        });
      }
    });
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await store.recordActivity(owner, channel.id, {
        text: "Said to a crowd",
        agentId: null,
        at: new Date(),
      });
      await within5s(allHeard);
    } finally {
      await listener.stop();
    }

    // The write, first. Over the cap, `pg_notify` raises payload-too-long inside the transaction and
    // rolls it back, so every message, archive and delete in a channel this size failed permanently
    // and surfaced as an opaque 500.
    const [row] = await database
      .select({ lastMessage: channels.lastMessage })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(row?.lastMessage).toBe("Said to a crowd");

    // Once each. The notifications partition the member list rather than repeating it: a tab that
    // hears one refetches the whole roster, so a second copy is a second refetch for nothing.
    expect(heard.size).toBe(everybody.length);
    expect([...heard.values()].filter((times) => times !== 1)).toEqual([]);
  });
});

function within5s(arrived: Promise<void>) {
  return Promise.race([
    arrived,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("no event within 5s")), 5000),
    ),
  ]);
}

/**
 * Real delivery, not the fake hub the route test drives. Archiving is channel grain — for everyone
 * in it — so this proves every member hears it, through the same `LISTEN`/`NOTIFY` round trip a
 * second server instance would take.
 */
describe("the archive announcement", () => {
  test("reaches every member, because archiving is for all of them", async () => {
    const owner = await createUser();
    const second = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    // A second member, inserted directly: `create` adds only the caller.
    await database
      .insert(channelMemberships)
      .values({ channelId: channel.id, userId: second.id });

    const hub = createChannelEventHub();
    const received: RosterActivityEvent[] = [];
    const arrived = new Promise<void>((resolve) => {
      hub.register(second.id, (payload) => {
        received.push(JSON.parse(payload) as RosterActivityEvent);
        resolve();
      });
    });
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await store.setArchived(owner, channel.id, true);
      await within5s(arrived);
    } finally {
      await listener.stop();
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: "channel",
      id: channel.id,
      // Carried alongside `id` for one release, so an old replica mid-rollout can still read it.
      channelId: channel.id,
      archived: true,
    });
  });

  test("announces nothing when the archive was refused", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    const hub = createChannelEventHub();
    const received: unknown[] = [];
    hub.register(owner.id, (payload) => received.push(payload));
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await expect(
        store.setArchived(stranger, channel.id, true),
      ).rejects.toBeInstanceOf(ChannelNotFoundError);
      // The refusal rolls the transaction back, so there is nothing to wait for. A window long
      // enough for a notify that did happen to arrive is what makes the empty assertion mean
      // something.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await listener.stop();
    }

    expect(received).toEqual([]);
  });

  test("announces nothing when the channel was already archived", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    await store.setArchived(owner, channel.id, true);

    const hub = createChannelEventHub();
    const received: unknown[] = [];
    hub.register(owner.id, (payload) => received.push(payload));
    const listener = await startChannelActivityListener(databaseUrl, hub);

    try {
      await store.setArchived(owner, channel.id, true);
      // A no-op returns before it announces, so there is nothing to wait for; the window is what
      // makes the empty assertion mean something.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await listener.stop();
    }

    // A no-op is not news. Announcing it would send every member's tabs to refetch for nothing.
    expect(received).toEqual([]);
  });
});
