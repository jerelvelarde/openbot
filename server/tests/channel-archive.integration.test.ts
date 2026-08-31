import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createChannelEventHub,
  startChannelActivityListener,
  type RosterActivityEvent,
} from "../src/channels/events";
import {
  ChannelNotFoundError,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
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

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
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
