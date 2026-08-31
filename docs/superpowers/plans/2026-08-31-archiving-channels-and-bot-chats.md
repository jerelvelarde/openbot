# Archiving channels and Bot chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person archive a channel or a direct Bot chat so it leaves the sidebar roster without being deleted, behind one Active / Archived / All filter over both kinds.

**Architecture:** Two tables, not one. `channels` gains `archived_at` alongside its existing `deleted_at`; a new `bot_chats` table gives direct Bot chats the durable rows they have never had. A new `server/src/roster/` module unions the two into one paged list, as a two-phase read whose first phase — narrow, four columns, cursor and limit — is the only place the sort rule lives. Archived is hidden, not frozen: saying something in an archived conversation restores it.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle ORM 0.45 on PostgreSQL, TanStack Query + TanStack Router, React, Tailwind, Biome. Tests are `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-31-archiving-channels-and-bot-chats-design.md`

## Global Constraints

- Package manager is `bun@1.3.14`. Never run `npm` or `yarn` in this repo.
- Run all commands from the repository root. This is a git worktree; do not `cd` to the original checkout.
- Push target is `origin` (`https://github.com/jerelvelarde/openbot.git`). There is no push access to `upstream` (`CopilotKit/openbot`).
- Never add an Anthropic co-author trailer to a commit.
- Migrations: new tables go in `server/src/db/schema/coworker.ts`. That file's header says "Add tables here; never edit core.ts or computer.ts to do it." Columns on existing tables are the exception and go in the file that owns the table.
- Every index must be declared in the Drizzle schema, not only in the migration SQL. An index present in the database but absent from the schema is invisible to `drizzle-kit generate`, so the next generated migration proposes a schema without it and silently drops it.
- Migration journal timestamps must strictly increase and must never be in the future. `server/tests/migration-journal.test.ts` enforces both.
- Ownership and membership failures answer **404, never 403**. The channels module does this deliberately so membership is not probeable. Match it.
- `all` as a roster status means active + archived. It never includes soft-deleted rows.
- Client data access follows the `openbot-data-access` skill: every read is a `queryOptions` factory in `lib/<entity>/queries.ts`, every write a `mutationOptions` factory in `lib/<entity>/mutations.ts`, and every request goes through `client` / `tryClient` from `app/src/lib/client.ts`. Never call `fetch` directly from a component.
- Comments in this repo explain *why*, at length, and often name the bug they prevent. Match that register. Do not add comments that restate the code.
- Formatter and linter: `bun run format` and `bun run lint` (Biome, `--error-on-warnings`).

## Commands

| Purpose | Command |
| --- | --- |
| All tests | `bun test` |
| One file | `bun test server/tests/channel-archive.test.ts` |
| One test by name | `bun test server/tests/channel-archive.test.ts -t "restores"` |
| Typecheck | `bun run typecheck` |
| Lint | `bun run lint` |
| Format | `bun run format` |
| Generate a migration | `bun run --filter server db:generate` |
| Apply migrations | `bun run --filter server db:migrate` |

Integration tests (`*.integration.test.ts`) need PostgreSQL at `DATABASE_URL`, defaulting to
`postgres://openbot:openbot@localhost:5432/openbot`. Start it with `docker compose up -d postgres`.

---

## File Structure

### Created

| File | Responsibility |
| --- | --- |
| `server/src/roster/preview.ts` | `previewOf`, `titleOf`, and the page-size limits, shared by channels, bot chats, and the roster |
| `server/src/roster/order.ts` | `RECENCY` / `PINNED_RANK` SQL fragments and the cursor codec — the one home for the sort rule |
| `server/src/roster/query.ts` | The two-phase union read and `RosterStore` |
| `server/src/roster/routes.ts` | `GET /api/roster` |
| `server/src/bot-chats/store.ts` | `BotChatStore`: create, adopt, get, mostRecent, activity, pin, read, archive, delete |
| `server/src/bot-chats/routes.ts` | The `/api/bot-chats` Hono routes and their input parsers |
| `app/src/lib/roster/queries.ts` | `RosterItem`, `RosterStatus`, `rosterListQueryOptions` |
| `app/src/lib/bot-chats/queries.ts` | `botChatQueryOptions` |
| `app/src/lib/bot-chats/mutations.ts` | Bot chat writes |
| `app/src/components/app-sidebar/roster-row.tsx` | The roster row, branching on `kind` (replaces `channel.tsx`) |
| `app/src/components/app-sidebar/status-filter.tsx` | The Active / Archived / All control |
| `app/src/routes/_authed/_app/bot.$botChatId.tsx` | One Bot chat, at its own URL |

### Modified

| File | Change |
| --- | --- |
| `server/src/db/schema/coworker.ts` | Add `botChats` |
| `server/src/db/schema/core.ts` | Add `channels.archivedAt` |
| `server/src/channels/events.ts` | `RosterActivityEvent` with `kind` / `id` / `archived`; `ChannelActivityEvent` becomes a deprecated alias |
| `server/src/channels/routes.ts` | `setArchived`; `recordActivity` restores; import order and preview helpers from `roster/`; `ChannelPackageOwnedError` carries the act |
| `server/src/app.ts` | Mount `/api/bot-chats` and `/api/roster` |
| `server/src/index.ts` | Build `botChatStore` and `rosterStore` |
| `app/src/lib/channels/mutations.ts` | Add `setChannelArchivedMutationOptions` |
| `app/src/lib/channels/use-channel-events.ts` | `kind`; archive invalidates rather than patches |
| `app/src/components/app-sidebar/app-sidebar.tsx` | Read the roster, hold the status, four empty states |
| `app/src/routes/_authed/_app/bot.tsx` | Becomes the `?agent=` resolver that redirects |
| `app/src/lib/copilot/bot-thread.ts` | Loses its storage role; adopts a remembered thread once |

### Deleted

| File | Reason |
| --- | --- |
| `app/src/components/app-sidebar/channel.tsx` | Becomes `roster-row.tsx` |

### Task dependency order

```
1 schema ──> 2 preview/order ──> 3 channel archive ──> 4 activity restores
                             \
                              ├─> 5 bot chat store ──> 6 bot chat routes
                              \
                               └─> 7 roster query ──> 8 roster route
                                                        │
   9 client data layer <────────────────────────────────┘
   │
   ├─> 10 event patching
   ├─> 11 roster row
   ├─> 12 status filter
   └─> 13 bot chat screen ──> 14 legacy adoption
```

Tasks 3+4 and 5+6 are independent of each other and may be done in either order. Task 7 needs both.

---

### Task 1: Schema and migration

**Files:**
- Modify: `server/src/db/schema/coworker.ts`
- Modify: `server/src/db/schema/core.ts:250` (the `channels` table, after `deletedAt`)
- Create: `server/drizzle/0020_archive_channels_and_bot_chats.sql` (generated, then renamed)
- Test: `server/tests/bot-chat-schema.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `botChats` table object exported from `server/src/db/schema`, with columns `id`, `userId`, `agentId`, `threadId`, `title`, `lastMessage`, `lastMessageAt`, `lastMessageAgentId`, `pinnedAt`, `lastReadAt`, `archivedAt`, `deletedAt`, `createdAt`, `updatedAt`. `channels.archivedAt` as `timestamp with time zone | null`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/bot-chat-schema.integration.test.ts`:

```ts
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, botChats, channels, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const prefix = `bot-chat-schema-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];

afterEach(async () => {
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
  for (const id of createdAgentIds.splice(0)) {
    await database.delete(agents).where(eq(agents.id, id));
  }
});

afterAll(async () => {
  await database.$client.end();
});

async function seedUser() {
  const id = `${prefix}-user-${createdUserIds.length}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@openbot.test`, name: "Member" });
  createdUserIds.push(id);
  return id;
}

async function seedAgent() {
  const id = `${prefix}-agent-${createdAgentIds.length}`;
  await database
    .insert(agents)
    .values({ id, name: "Bot", type: "built_in", configuration: {} });
  createdAgentIds.push(id);
  return id;
}

describe("the bot_chats table", () => {
  test("holds a chat with nulls for everything not yet said", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const id = `botchat_${randomUUID()}`;

    await database
      .insert(botChats)
      .values({ id, userId, agentId, threadId: randomUUID() });

    const [row] = await database
      .select()
      .from(botChats)
      .where(eq(botChats.id, id));

    expect(row?.title).toBeNull();
    expect(row?.archivedAt).toBeNull();
    expect(row?.deletedAt).toBeNull();
    expect(row?.pinnedAt).toBeNull();
    expect(row?.lastReadAt).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  test("refuses two chats claiming one thread", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const threadId = randomUUID();

    await database
      .insert(botChats)
      .values({ id: `botchat_${randomUUID()}`, userId, agentId, threadId });

    /*
     * The constraint is what decides an adoption race, so it is asserted rather than assumed.
     *
     * `Promise.resolve` is load-bearing, not decoration. Drizzle's insert builder is a *thenable*
     * (`PgInsertBase`), not a `Promise`, and Bun 1.3.14's `rejects` matcher checks for a real
     * Promise — handed the builder it fails with `Expected promise, Received: PgInsertBase` before
     * ever running the insert, so the test would pass or fail for the wrong reason. Wrapping it
     * converts the thenable without changing what is asserted.
     */
    await expect(
      Promise.resolve(
        database
          .insert(botChats)
          .values({ id: `botchat_${randomUUID()}`, userId, agentId, threadId }),
      ),
    ).rejects.toThrow();
  });

  test("keeps several chats with one Bot", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();

    for (let index = 0; index < 3; index += 1) {
      await database.insert(botChats).values({
        id: `botchat_${randomUUID()}`,
        userId,
        agentId,
        threadId: randomUUID(),
      });
    }

    const rows = await database
      .select({ id: botChats.id })
      .from(botChats)
      .where(eq(botChats.userId, userId));

    expect(rows).toHaveLength(3);
  });

  test("removes a person's chats with them", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    await database.insert(botChats).values({
      id: `botchat_${randomUUID()}`,
      userId,
      agentId,
      threadId: randomUUID(),
    });

    await database.delete(users).where(eq(users.id, userId));
    createdUserIds.splice(createdUserIds.indexOf(userId), 1);

    const rows = await database
      .select({ id: botChats.id })
      .from(botChats)
      .where(eq(botChats.userId, userId));

    expect(rows).toEqual([]);
  });
});

describe("the channels table", () => {
  test("archives without deleting", async () => {
    const id = `channel_${randomUUID()}`;
    await database
      .insert(channels)
      .values({ id, name: "Channel", description: "Test channel." });

    const archivedAt = new Date();
    await database
      .update(channels)
      .set({ archivedAt })
      .where(eq(channels.id, id));

    const [row] = await database
      .select({ archivedAt: channels.archivedAt, deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, id));

    expect(row?.archivedAt).toEqual(archivedAt);
    // Archiving is not deleting, and the two columns must be independently readable.
    expect(row?.deletedAt).toBeNull();

    await database.delete(channels).where(eq(channels.id, id));
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test server/tests/bot-chat-schema.integration.test.ts`
Expected: FAIL. `botChats` is not exported from `../src/db/schema`, so this is a TypeScript/import failure, not an assertion failure.

- [ ] **Step 3: Add the table to the schema**

In `server/src/db/schema/coworker.ts`, extend the imports and append the table.

Change the import block at the top of the file to add `sql`, `uniqueIndex`:

```ts
import { sql } from "drizzle-orm";
import {
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
```

Append at the end of the file:

```ts
/**
 * One conversation between one person and one Bot, on the direct Bot screen.
 *
 * WHY THIS TABLE EXISTS AT ALL. The direct Bot chat used to keep its thread id in `localStorage` and
 * nowhere else, one per Bot, and `New chat` overwrote it. The transcript stayed in Intelligence and
 * nothing in this deployment could ever name it again: a conversation destroyed by a button whose
 * label does not say so. A row per conversation is what makes that button non-destructive, and it is
 * the thing an archive can be hung on.
 *
 * NOT A CHANNEL, DELIBERATELY. A channel with one agent and one member is very nearly this, and
 * collapsing the two was considered and rejected — see the design's "Alternative considered". These
 * stay a distinct kind: never shareable, never multi-member.
 *
 * `pinned_at` and `last_read_at` sit here, where a channel keeps them on `channel_memberships`. A
 * bot chat has exactly one interested party, so a membership table would be a second row per
 * conversation able to hold only ever one member. The roster query is what flattens that asymmetry.
 */
export const botChats = pgTable(
  "bot_chats",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /*
     * Cascades, matching `channel_agents.agent_id`, and that is safe because a Bot is retired by
     * soft-deleting its `agent_profiles` row rather than by deleting the `agents` row. A retired Bot
     * therefore leaves this conversation readable with `active` false, the same way a channel reports
     * a coworker who has been deleted.
     */
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** The Intelligence thread, minted by thread-identity.ts so it says which deployment made it. */
    threadId: text("thread_id").notNull(),
    /**
     * What the roster calls this conversation, taken from the first thing the person said.
     *
     * Null until then, and the roster falls back to the Bot's name, because a conversation with
     * nothing in it has no subject to name it after. A Bot's opening message does not count: it is
     * the same greeting in every chat, so titling from it would make every row identical.
     */
    title: text("title"),
    lastMessage: text("last_message"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Which side spoke last. Null for the person, which is what leaves the unread dot unlit. */
    lastMessageAgentId: text("last_message_agent_id").references(
      () => agents.id,
      { onDelete: "set null" },
    ),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    /**
     * When this was archived, or null. Hidden, not frozen: the conversation stays live and saying
     * something in it clears this. Only the roster query reads it.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** When this was deleted, or null. Soft, like a channel's, and every read path filters on it. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * One chat per thread.
     *
     * This is the constraint that decides an adoption race. Two tabs holding the same remembered
     * thread id both try to adopt it; without this they succeed twice and one conversation becomes
     * two rows pointing at one transcript. The loser catches the violation and reads the winner.
     */
    uniqueIndex("bot_chats_thread_idx").on(table.threadId),
    /**
     * The roster's own read, per person.
     *
     * On the expression, not the column, for the reason `channels_recent_activity_idx` gives: the
     * list sorts by the last thing said and falls back to when the conversation was made, so an
     * index on `last_message_at` alone does not serve that ordering.
     *
     * Declared here rather than only in the migration. An index that exists in the database and not
     * in the schema is invisible to `generate`, so the next generated migration proposes a schema
     * without it and silently drops it.
     */
    index("bot_chats_recent_activity_idx").on(
      table.userId,
      sql`COALESCE(${table.lastMessageAt}, ${table.createdAt}) DESC`,
    ),
  ],
);

/**
 * Deliberately no unique constraint on `(user_id, agent_id)`. Several conversations with one Bot is
 * the whole point of the table.
 */
```

- [ ] **Step 4: Add the column to `channels`**

In `server/src/db/schema/core.ts`, in the `channels` table, immediately after the `deletedAt` field and its comment, add:

```ts
    /**
     * When this channel was archived, or null.
     *
     * Channel grain, like `deletedAt` and for the same reason: archiving is for everyone in the
     * channel. Per-member hiding would be a membership fact instead, and would enter the roster's
     * sort key, which this grain deliberately avoids.
     *
     * Archived is hidden, not frozen. Reads and writes stay open — `setPinned`, `markRead` and
     * `recordActivity` do not consult this — and saying something clears it. The roster query is the
     * only read path that filters on it.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
```

- [ ] **Step 5: Generate the migration**

Run: `bun run --filter server db:generate`

Expected: a new `server/drizzle/0020_<random_words>.sql` and a new `_journal.json` entry with `idx: 20`.

Read the generated SQL. It must contain exactly a `CREATE TABLE "bot_chats"`, its two indexes, the two foreign keys on `bot_chats`, and one `ALTER TABLE "channels" ADD COLUMN "archived_at"`. If it proposes dropping anything, stop: something in the schema disagrees with the database, and generating over it would delete it.

- [ ] **Step 6: Rename the migration to say what it does**

Every migration in this repo carries a descriptive tag rather than the generated words — `0016_pin_and_soft_delete_channels`, `0019_channel_read_marker`. Match that. Rename the file and change the matching `tag` in `server/drizzle/meta/_journal.json` (leave `when` exactly as generated):

```bash
mv server/drizzle/0020_*.sql server/drizzle/0020_archive_channels_and_bot_chats.sql
```

Then edit the `idx: 20` entry's `tag` to `"0020_archive_channels_and_bot_chats"`.

- [ ] **Step 7: Apply it and run the tests**

```bash
docker compose up -d postgres
bun run --filter server db:migrate
bun test server/tests/bot-chat-schema.integration.test.ts server/tests/migration-journal.test.ts
```

Expected: PASS. Five bot-chat/channel assertions and both journal guards.

- [ ] **Step 8: Confirm nothing else moved**

Run: `bun test server/tests/schema.test.ts && bun run typecheck`
Expected: PASS. If `schema.test.ts` enumerates tables, add `bot_chats` to its list.

- [ ] **Step 9: Commit**

```bash
bun run format
git add server/src/db/schema/coworker.ts server/src/db/schema/core.ts server/drizzle server/tests/bot-chat-schema.integration.test.ts
git commit -m "Give direct Bot chats a row, and channels somewhere to be archived"
```

---

### Task 2: One home for the preview rules and the sort rule

A pure refactor. Nothing behaves differently at the end of it; three modules that are about to need
these helpers can reach them without copying them.

**Files:**
- Create: `server/src/roster/preview.ts`
- Create: `server/src/roster/order.ts`
- Modify: `server/src/channels/routes.ts` (delete the moved definitions, import them back)
- Test: `server/tests/roster-preview.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `previewOf(text: string): string` — one line of plain text, at most 200 code points.
  - `titleOf(text: string): string` — as `previewOf`, capped at 80 code points.
  - `DEFAULT_ROSTER_PAGE: 50`, `MAX_ROSTER_PAGE: 200`
  - `RECENCY: SQL`, `pinnedRank(pinnedAt: PgColumn): SQL`, `rosterOrder(rank, recency, id): SQL[]`
  - `type RosterCursor = { pinned: boolean; recency: string; id: string }`
  - `encodeRosterCursor(cursor: RosterCursor): string`
  - `decodeRosterCursor(value: string | undefined): RosterCursor | undefined`

- [ ] **Step 1: Write the failing test**

Create `server/tests/roster-preview.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decodeRosterCursor, encodeRosterCursor } from "../src/roster/order";
import { previewOf, titleOf } from "../src/roster/preview";

describe("previewOf", () => {
  test("collapses a message to one line", () => {
    expect(previewOf("first\nsecond   third")).toBe("first second third");
  });

  test("strips control characters rather than rendering them", () => {
    // A terminal escape somebody put in a message must not follow it into a log. The escape byte
    // goes and the run collapses to a space; the printable tail it introduced is left alone, which
    // is what the existing regex already does.
    expect(previewOf(`before\u001b[31mafter`)).toBe("before [31mafter");
  });

  test("truncates to 200 code points with an ellipsis", () => {
    const preview = previewOf("a".repeat(500));
    expect(Array.from(preview)).toHaveLength(200);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("counts code points, not UTF-16 units", () => {
    // 199 plain characters plus one astral character is 200 code points, and must survive whole.
    const text = `${"a".repeat(199)}\u{1f600}`;
    expect(previewOf(text)).toBe(text);
  });
});

describe("titleOf", () => {
  test("is shorter than a preview, because a roster row is not a transcript", () => {
    const title = titleOf("a".repeat(500));
    expect(Array.from(title)).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  test("leaves a short first message alone", () => {
    expect(titleOf("  What is our refund policy?  ")).toBe(
      "What is our refund policy?",
    );
  });
});

describe("the roster cursor", () => {
  test("round-trips every part of the sort key", () => {
    const cursor = {
      pinned: true,
      recency: "2026-08-31T09:00:00.000Z",
      id: "channel_1",
    };
    expect(decodeRosterCursor(encodeRosterCursor(cursor))).toEqual(cursor);
  });

  test("reads a malformed cursor as the first page", () => {
    // The honest answer to a stale link: it names a position in an ordering we no longer have.
    expect(decodeRosterCursor("not-base64url")).toBeUndefined();
    expect(decodeRosterCursor(undefined)).toBeUndefined();
  });

  test("reads a cursor missing part of the sort key as the first page", () => {
    const partial = Buffer.from(
      JSON.stringify({ recency: "2026-08-31T09:00:00.000Z", id: "channel_1" }),
      "utf8",
    ).toString("base64url");
    expect(decodeRosterCursor(partial)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test server/tests/roster-preview.test.ts`
Expected: FAIL — cannot resolve `../src/roster/preview`.

- [ ] **Step 3: Write `server/src/roster/preview.ts`**

Move `previewOf`'s body out of `channels/routes.ts` **verbatim** — including its `biome-ignore` line
and its control-character regex — and generalise only the cap. Copy that regex line rather than
retyping it, or the two functions will strip different characters.

```ts
/**
 * What a roster row says, and how much of a list one read returns.
 *
 * Here rather than in `channels/routes.ts`, where these started, because bot chats and the roster
 * query both need them now. A second `previewOf` that stripped control characters slightly
 * differently would be a preview that rendered differently depending on which kind of row it was:
 * the same fact told two ways, which is what this module exists to prevent.
 */

const MAX_ACTIVITY_CODE_POINTS = 200;

/**
 * How long a title may be.
 *
 * Shorter than a preview because it shares a roster row with one: the title is the line a person
 * scans, and a title running to 200 characters would push the preview off the row it names.
 */
const MAX_TITLE_CODE_POINTS = 80;

/**
 * How many conversations one page holds.
 *
 * The sidebar asked for all of them on every render and nothing removed a channel, so somebody who
 * talks to their Bot daily accumulates thousands: a query that is instant in a demo returns
 * thousands of rows on every page load for every employee, and grows monotonically. A page is what a
 * sidebar can show anyway.
 */
export const DEFAULT_ROSTER_PAGE = 50;

/** The most a caller may ask for, so the endpoint cannot be talked back into reading everything. */
export const MAX_ROSTER_PAGE = 200;

/**
 * Reduce a message to one line of plain text, capped.
 *
 * A preview is rendered as text wherever a roster appears, so control characters have nothing to do
 * there: at best they are invisible, at worst a terminal escape somebody put in a message follows it
 * into a log. Newlines collapse to spaces because a preview is one line by definition.
 *
 * Counted in code points rather than UTF-16 units, so a cap never lands inside an astral character
 * and leaves half of one behind.
 */
function flatten(text: string, cap: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const flattened = text.replace(CONTROL_CHARACTERS, " ").trim();
  const collapsed = flattened.replace(/\s+/g, " ");
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= cap) return collapsed;
  return `${codePoints.slice(0, cap - 1).join("")}…`;
}

export function previewOf(text: string): string {
  return flatten(text, MAX_ACTIVITY_CODE_POINTS);
}

/** What a bot chat is called, taken from the first thing the person said in it. */
export function titleOf(text: string): string {
  return flatten(text, MAX_TITLE_CODE_POINTS);
}
```

Two things above are written defensively so this plan survives being piped through a shell. Write
them as the real thing in the source file:

| In this plan | In `preview.ts` |
| --- | --- |
| `CONTROL_CHARACTERS` | the character-class regex literal copied unchanged from `channels/routes.ts` |
| `…` | the single-character ellipsis, as `channels/routes.ts` writes it today |

- [ ] **Step 4: Write `server/src/roster/order.ts`**

```ts
import { desc, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { channels } from "../db/schema";

/**
 * The order the roster is drawn in, and where a page stopped.
 *
 * ONE HOME, ON PURPOSE. This rule is mirrored in the browser twice, by `byRecency` in
 * `use-channel-events.ts` and `pinnedFirst` in `app-sidebar.tsx`, and each of those carries a comment
 * saying it must agree with this or the list reorders itself the moment a socket event arrives. Two
 * entity kinds now sort by it. Leaving the SQL half inside `channels/routes.ts` would have left a
 * second server-side definition that bot chats had to be kept in step with by hand.
 */

/**
 * Most recent first, where starting a conversation counts as activity.
 *
 * A conversation somebody just made has nothing said in it yet and is the one they are about to type
 * in, so ordering on the message alone would bury it under everything that has one.
 *
 * Written against `channels` because that is where it started and where the matching index is
 * declared. The bot chat branch builds the same expression over its own two columns; the shape is
 * what has to agree, not the identifiers.
 */
export const RECENCY = sql`coalesce(${channels.lastMessageAt}, ${channels.createdAt})`;

/**
 * A pin as a number, so the whole sort key can descend.
 *
 * Takes the column rather than naming one, because the two kinds keep their pin in different places:
 * a channel's is on `channel_memberships`, a bot chat's is on the row itself.
 */
export function pinnedRank(pinnedAt: PgColumn): SQL {
  return sql`case when ${pinnedAt} is not null then 1 else 0 end`;
}

/**
 * The sort key, in sort order, every part descending.
 *
 * Descending throughout is what lets the cursor below be one row comparison rather than a nest of
 * ORs: a pin is 1 and no pin is 0, so `desc` puts pinned rows first, and both remaining parts already
 * wanted `desc`.
 */
export function rosterOrder(rank: SQL, recency: SQL, id: PgColumn): SQL[] {
  return [sql`${rank} desc`, sql`${recency} desc`, sql`${desc(id)}`];
}

/**
 * Where a page stopped: every part of the sort, in sort order.
 *
 * `pinned` leads because the ordering does. A keyset cursor has to name the whole sort key or the
 * next page is selected by a different rule than the page it follows, which serves some rows twice
 * and others never. `recency` and `id` are both here for the same reason: two rows can share a
 * timestamp.
 *
 * No `kind`. Ids are prefixed (`channel_...`, `botchat_...`) and therefore globally unique, so `id`
 * still breaks every tie on its own. That is what lets one cursor page through a mixed list.
 */
export type RosterCursor = { pinned: boolean; recency: string; id: string };

export function encodeRosterCursor(cursor: RosterCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * A malformed cursor reads as the first page, which is the honest answer to a stale link.
 *
 * A cursor minted before part of the sort key existed is malformed by this definition, and
 * deliberately: it describes a position in an ordering this query no longer has.
 */
export function decodeRosterCursor(
  value: string | undefined,
): RosterCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as RosterCursor;
    return typeof parsed?.id === "string" &&
      typeof parsed?.recency === "string" &&
      typeof parsed?.pinned === "boolean"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 5: Run the new test**

Run: `bun test server/tests/roster-preview.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Point `channels/routes.ts` at the new modules**

1. Delete from `channels/routes.ts`: `previewOf`, `MAX_ACTIVITY_CODE_POINTS`, `DEFAULT_CHANNEL_PAGE`,
   `MAX_CHANNEL_PAGE`, `PINNED_RANK`, `RECENCY`, `ROSTER_ORDER`, `type ChannelCursor`,
   `encodeChannelCursor`, `decodeChannelCursor`.
2. Add the imports:

```ts
import {
  decodeRosterCursor,
  encodeRosterCursor,
  pinnedRank,
  RECENCY,
  type RosterCursor,
  rosterOrder,
} from "../roster/order";
import {
  DEFAULT_ROSTER_PAGE,
  MAX_ROSTER_PAGE,
  previewOf,
} from "../roster/preview";
```

3. Re-establish two module-local bindings, so every call site below reads exactly as it did:

```ts
const PINNED_RANK = pinnedRank(channelMemberships.pinnedAt);
const ROSTER_ORDER = rosterOrder(PINNED_RANK, RECENCY, channels.id);
```

4. In `list`, rename `DEFAULT_CHANNEL_PAGE` to `DEFAULT_ROSTER_PAGE`, `MAX_CHANNEL_PAGE` to
   `MAX_ROSTER_PAGE`, both cursor calls to their `Roster` names, and the `ChannelCursor` annotation
   to `RosterCursor`.
5. `channelName` stays where it is. It is a channel's own naming rule, not a roster rule, and nothing
   else needs it.

- [ ] **Step 7: Prove the refactor changed nothing**

Run:

```bash
bun test server/tests/channel-routes.test.ts server/tests/channel-activity.integration.test.ts server/tests/channel-events.integration.test.ts && bun run typecheck
```

Expected: PASS, **with no edits to any of those three test files**. A refactor that needed its tests
changed moved behaviour, which this one must not.

- [ ] **Step 8: Commit**

```bash
bun run format && bun run lint
git add server/src/roster server/src/channels/routes.ts server/tests/roster-preview.test.ts
git commit -m "Move the preview and sort rules where two kinds of conversation can reach them"
```

---

### Task 3: Archive and restore a channel

**Files:**
- Modify: `server/src/channels/events.ts` (the event type)
- Modify: `server/src/channels/routes.ts` (`setArchived`, the route, the audit writer, the error)
- Test: `server/tests/channel-archive.test.ts`

**Interfaces:**
- Consumes: `RosterCursor` and friends from Task 2.
- Produces:
  - `type RosterActivityEvent` in `channels/events.ts`, with `kind: "channel" | "bot_chat"`, `id: string`, optional `channelId?: string`, and optional `archived?: boolean`. `ChannelActivityEvent` remains exported as a deprecated alias of it.
  - `ChannelStore.setArchived(actor: AgentActor, channelId: string, archived: boolean): Promise<void>`
  - `ChannelPackageOwnedError` gains a public readonly `act: string`, defaulting to `"deleted"`.
  - `PUT /api/channels/:channelId/archive` accepting `{archived: boolean}` and answering `{archived: boolean}`.
  - Audit event types `channel.archived` and `channel.unarchived`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/channel-archive.test.ts`. This is a route-and-store test using the same
`fakeStore` / `appFor` harness as `channel-routes.test.ts` — read that file's top 110 lines first and
copy its shape, including the `actor`, `requireUser`, and `json` helpers.

```ts
import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  type AgentChannel,
  ChannelNotFoundError,
  ChannelPackageOwnedError,
  type ChannelStore,
  createChannelRoutes,
} from "../src/channels/routes";

const actor: AgentActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function channel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: "channel_1",
    name: "Assistant channel",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
    ...overrides,
  };
}

type StoreCall = [method: keyof ChannelStore, ...arguments_: unknown[]];

function fakeStore(overrides: Partial<ChannelStore> = {}) {
  const calls: StoreCall[] = [];
  const base: ChannelStore = {
    async create(receivedActor, agentIds) {
      calls.push(["create", receivedActor, agentIds]);
      return channel({ agentIds });
    },
    async get(receivedActor, id) {
      calls.push(["get", receivedActor, id]);
      return channel({ id });
    },
    async list(receivedActor, query) {
      calls.push(["list", receivedActor, query]);
      return { channels: [], nextCursor: null };
    },
    async setPinned(receivedActor, id, pinned) {
      calls.push(["setPinned", receivedActor, id, pinned]);
    },
    async markRead(receivedActor, id) {
      calls.push(["markRead", receivedActor, id]);
    },
    async setArchived(receivedActor, id, archived) {
      calls.push(["setArchived", receivedActor, id, archived]);
    },
    async softDelete(receivedActor, id) {
      calls.push(["softDelete", receivedActor, id]);
    },
    async recordActivity(receivedActor, id, activity) {
      calls.push(["recordActivity", receivedActor, id, activity]);
    },
  };
  return Object.assign(base, overrides, { calls });
}

function recordingAuditStore() {
  const written: AuditEventInput[] = [];
  const store: AuditStore = {
    async record(event) {
      written.push(event);
    },
  };
  return { store, written };
}

function appFor(store: ChannelStore, auditStore?: AuditStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createChannelRoutes(store, requireUser, undefined, auditStore),
  );
  return app;
}

async function archive(app: Hono<{ Variables: AppVariables }>, body: unknown) {
  return app.request("/channel_1/archive", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /:channelId/archive", () => {
  test("archives and answers with the state it reached", async () => {
    const store = fakeStore();
    const response = await archive(appFor(store), { archived: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived: true });
    expect(store.calls).toEqual([["setArchived", actor, "channel_1", true]]);
  });

  test("restores", async () => {
    const store = fakeStore();
    const response = await archive(appFor(store), { archived: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived: false });
    expect(store.calls).toEqual([["setArchived", actor, "channel_1", false]]);
  });

  test.each([[{}], [{ archived: "yes" }], [{ archived: null }], [null]])(
    "refuses a body that does not say which way: %p",
    async (body) => {
      const store = fakeStore();
      const response = await archive(appFor(store), body);

      expect(response.status).toBe(400);
      // Nothing reached the store, so a malformed request cannot half-apply.
      expect(store.calls).toEqual([]);
    },
  );

  test("answers 404 for a channel the caller is not in", async () => {
    const store = fakeStore({
      async setArchived() {
        throw new ChannelNotFoundError("channel_1");
      },
    });
    const response = await archive(appFor(store), { archived: true });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Channel not found." });
  });

  test("names archiving, not deleting, when the package owns the channel", async () => {
    const store = fakeStore({
      async setArchived() {
        throw new ChannelPackageOwnedError("channel_1", "archived");
      },
    });
    const response = await archive(appFor(store), { archived: true });

    expect(response.status).toBe(409);
    // A 409 that says the wrong verb is worse than no message at all.
    expect(await response.json()).toEqual({
      error:
        "This channel is defined by the deployment package, so it cannot be archived here.",
    });
  });

  test("writes the act to the trail", async () => {
    const audit = recordingAuditStore();
    await archive(appFor(fakeStore(), audit.store), { archived: true });

    expect(audit.written).toEqual([
      {
        eventType: "channel.archived",
        targetType: "channel",
        targetId: "channel_1",
        actorUserId: actor.id,
        payload: {},
      },
    ]);
  });

  test("writes a restore as its own act, not as an archive", async () => {
    const audit = recordingAuditStore();
    await archive(appFor(fakeStore(), audit.store), { archived: false });

    expect(audit.written.map((event) => event.eventType)).toEqual([
      "channel.unarchived",
    ]);
  });

  test("writes nothing to the trail when the store refused", async () => {
    const audit = recordingAuditStore();
    const store = fakeStore({
      async setArchived() {
        throw new ChannelNotFoundError("channel_1");
      },
    });
    await archive(appFor(store, audit.store), { archived: true });

    // The trail records acts, not attempts.
    expect(audit.written).toEqual([]);
  });

  test("still answers when the trail is unavailable", async () => {
    const failing: AuditStore = {
      async record() {
        throw new Error("trail unreachable");
      },
    };
    const response = await archive(appFor(fakeStore(), failing), {
      archived: true,
    });

    // The channel is already archived and the caller already told by the time this runs.
    expect(response.status).toBe(200);
  });
});

describe("ChannelPackageOwnedError", () => {
  test("still says deleted when nobody names an act", () => {
    // The existing delete route constructs it with one argument, and its message must not change.
    expect(new ChannelPackageOwnedError("channel_1").act).toBe("deleted");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test server/tests/channel-archive.test.ts`
Expected: FAIL. `setArchived` is not on `ChannelStore`, and `ChannelPackageOwnedError` takes one
argument.

- [ ] **Step 3: Widen the event type**

In `server/src/channels/events.ts`, replace the `ChannelActivityEvent` type with:

```ts
/**
 * Live roster activity, from whoever ran an agent to everybody who can see the conversation.
 *
 * TWO KINDS NOW. A channel has members; a bot chat has exactly one owner. Both are rows in one
 * roster, so both announce through here, and `memberIds` carries whoever may receive it either way —
 * the hub's delivery rule needs no knowledge of which kind it is holding.
 */
export type RosterActivityEvent = {
  /** Which kind of row this is about. The browser needs it to render, not to find the row. */
  kind: "channel" | "bot_chat";
  /**
   * The row's id.
   *
   * Globally unique across both kinds, because ids are prefixed (`channel_...`, `botchat_...`). That
   * is what lets one cursor page a mixed list and one patch function find a row without being told
   * its kind.
   */
  id: string;
  /**
   * The channel's id, on a channel event only.
   *
   * @deprecated Carried alongside `id` for exactly one release, then removed.
   *
   * WHY IT IS STILL HERE. A rolling deploy runs new and old replicas at once. The old ones LISTEN on
   * this topic and read `channelId`; a straight rename would have them deliver malformed events to
   * every client they hold, and renaming the topic instead would drop events for the length of the
   * rollout. So this release is additive and the field goes in the next one, once no replica predates
   * `id`. `accounts.issuer` in core.ts ships nullable for the same reason.
   *
   * A bot chat event has no `channelId`, so an old replica delivers one with the field undefined. Its
   * clients read the channels list, find no such row, and refetch — which is the same harmless path a
   * stale roster already takes.
   */
  channelId?: string;
  /** Who may receive it. Resolved by the writer, which already had to check who that is. */
  memberIds: string[];
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** The conversation is hidden from every roster. Absent on an ordinary activity event. */
  deleted?: true;
  /**
   * One member's pin, changed. Absent on an ordinary activity event.
   *
   * A channel pin lives on one membership row, so the writer names that member alone in `memberIds`
   * and the hub's delivery rule does the rest: nobody else in the channel hears a pin they did not
   * make. A bot chat's owner is the only candidate either way.
   */
  pinned?: boolean;
  /**
   * The conversation's archive state, changed. Absent on an ordinary activity event.
   *
   * Also set to `false` on an activity event that restored an archived conversation, because saying
   * something in one is how it comes back.
   */
  archived?: boolean;
};

/** @deprecated Use {@link RosterActivityEvent}. Kept so existing imports keep compiling. */
export type ChannelActivityEvent = RosterActivityEvent;
```

Leave `CHANNEL_ACTIVITY_TOPIC`, `createChannelEventHub`, and `startChannelActivityListener`
untouched. The topic name does not change, and the hub already fans out by an explicit id list.

Update the two type annotations inside `startChannelActivityListener` and `ChannelEventHub` to
`RosterActivityEvent`.

- [ ] **Step 4: Teach `ChannelPackageOwnedError` the act**

In `server/src/channels/routes.ts`:

```ts
export class ChannelPackageOwnedError extends Error {
  /**
   * What was refused, for the sentence a person reads.
   *
   * Defaulted to `deleted` so the existing delete path and its test are untouched. Archiving refused
   * with the word "deleted" in it would send somebody looking for a deletion nobody attempted.
   */
  readonly act: string;

  constructor(id: string, act = "deleted") {
    super(`Channel ${id} is defined by the deployment package.`);
    this.name = "ChannelPackageOwnedError";
    this.act = act;
  }
}
```

And in `mapStoreError`:

```ts
  if (error instanceof ChannelPackageOwnedError) {
    return context.json(
      {
        error: `This channel is defined by the deployment package, so it cannot be ${error.act} here.`,
      },
      409,
    );
  }
```

- [ ] **Step 5: Add `setArchived` to the store type and the store**

Add to the `ChannelStore` type, next to `softDelete`:

```ts
  /**
   * Archive or restore the channel for every member. Hidden, not frozen: the conversation stays
   * live, and `recordActivity` clears the archive on its own.
   *
   * Throws ChannelNotFoundError for a non-member, an unknown channel, or a deleted one, and
   * ChannelPackageOwnedError for a channel the tenant package defines.
   */
  setArchived(
    actor: AgentActor,
    channelId: string,
    archived: boolean,
  ): Promise<void>;
```

And the implementation, next to `softDelete`:

```ts
    async setArchived(actor, channelId, archived) {
      await database.transaction(
        async (transaction) => {
          const [row] = await transaction
            .select({
              packageId: channels.packageId,
              archivedAt: channels.archivedAt,
            })
            .from(channels)
            .innerJoin(
              channelMemberships,
              and(
                eq(channelMemberships.channelId, channels.id),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            // A deleted channel is not there to archive. `get` and `list` filter the same way, so
            // without this a client holding a stale roster row could archive something invisible and
            // announce it to every member, each of whom refetches for a row that cannot appear.
            .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
          // Not a member, no such channel, or a deleted one: the same answer every way, matching
          // setPinned, markRead, get and recordActivity, so membership is not probeable.
          if (!row) throw new ChannelNotFoundError(channelId);
          // Package channels are configuration; the sync that wrote them owns them. Archiving is
          // channel grain, so one member archiving one hides configuration from everybody with
          // nothing to put it back — no sync writes archived_at. That is a deletion wearing a
          // reversible name.
          if (row.packageId !== null) {
            throw new ChannelPackageOwnedError(
              channelId,
              archived ? "archived" : "restored",
            );
          }

          // Already where the caller wants it. Returning here rather than writing is what makes a
          // repeat call a no-op instead of a fresh stamp and a second announcement.
          const alreadyThere = archived
            ? row.archivedAt !== null
            : row.archivedAt === null;
          if (alreadyThere) return;

          await transaction
            .update(channels)
            .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
            .where(eq(channels.id, channelId));

          // Read on this transaction, so the members told are the ones the channel had when it was
          // archived.
          const members = await transaction
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channelId));

          /*
           * Every member, because archiving is for all of them.
           *
           * Announced inside the transaction, so it is delivered on commit and a refused archive — a
           * channel the package owns, or one the caller is not in — announces nothing at all.
           */
          const event: RosterActivityEvent = {
            kind: "channel",
            id: channelId,
            channelId,
            memberIds: members.map((member) => member.userId),
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            archived,
          };
          await transaction.execute(
            sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
          );
        },
        { isolationLevel: "read committed" },
      );
    },
```

Change the `import type { ChannelActivityEvent }` in this file to `RosterActivityEvent`, and update
the three existing event literals (`setPinned`, `softDelete`, `recordActivity`) to carry
`kind: "channel"` and `id: channelId` alongside the `channelId` they already set.

- [ ] **Step 6: Generalise the audit writer and add the route**

Replace the `recordDeleted` helper inside `createChannelRoutes` with one that takes the event type.
Keep its docblock, which explains why an audit failure is never fatal here, and keep the long comment
about attributing the actor even in single-user mode.

```ts
  const record = async (
    context: Context<{ Variables: AppVariables }>,
    eventType: string,
    channelId: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (!auditStore) return;
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "channel",
        targetId: channelId,
        actorUserId: context.var.actor.id,
        payload,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "channel-audit-write-failed",
          eventType,
          channelId,
          error: String(error),
        }),
      );
    }
  };
```

The existing delete route's call becomes
`await record(context, "channel.deleted", channelId, { mechanism: "soft" });`.

Add the route immediately after the pin route, so the two read together:

```ts
  routes.put("/:channelId/archive", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isChannelInputObject(body)) {
      return context.json(
        { error: "Archive input must be a JSON object." },
        400,
      );
    }
    const { archived } = body as { archived?: unknown };
    if (typeof archived !== "boolean") {
      return context.json({ error: "Archived must be true or false." }, 400);
    }

    const channelId = context.req.param("channelId");
    try {
      await store.setArchived(context.var.actor, channelId, archived);
      // Reached only once the store has resolved, so a refused archive writes nothing.
      await record(
        context,
        archived ? "channel.archived" : "channel.unarchived",
        channelId,
        {},
      );
      return context.json({ archived });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });
```

- [ ] **Step 7: Run the test**

Run: `bun test server/tests/channel-archive.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 8: Fix the fake stores the change broke**

`ChannelStore` gained a method, so every hand-built fake of it now fails typecheck.

Run: `bun run typecheck`

Add `async setArchived() {}` (recording the call, matching the file's own style) to the fake stores in
`server/tests/channel-routes.test.ts` and any other file the typecheck names.

- [ ] **Step 9: Prove the whole suite still passes**

Run: `bun test && bun run lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
bun run format
git add server/src/channels server/tests/channel-archive.test.ts server/tests/channel-routes.test.ts
git commit -m "Archive a channel for everyone in it, reversibly"
```

---

### Task 4: Archiving a channel, end to end

The other half of "hidden, not frozen". Small, and separate from Task 3 because a reviewer could
reasonably accept the archive and reject this rule.

**Files:**
- Modify: `server/src/channels/routes.ts` (`recordActivity`)
- Test: `server/tests/channel-archive.integration.test.ts` (the name the spec's Testing section uses)

**Interfaces:**
- Consumes: `setArchived` and `RosterActivityEvent` from Task 3.
- Produces: no new exports. `recordActivity` now clears `channels.archivedAt` and sets `archived: false` on the event when it cleared one.

- [ ] **Step 1: Write the failing test**

Create `server/tests/channel-archive.integration.test.ts`. Copy the seeding and cleanup
scaffolding from the top of `server/tests/channel-activity.integration.test.ts` — the `databaseUrl`,
`createDatabase`, `profileStore`, `store`, the `createdUserIds` / `createdAgentIds` /
`createdChannelIds` arrays, and the `afterEach` / `afterAll` blocks.

```ts
describe("activity in an archived channel", () => {
  test("brings it back", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const actor = { id: userId, email: `${userId}@openbot.test`, role: "user" } as const;
    const created = await store.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await store.setArchived(actor, created.id, true);
    await store.recordActivity(actor, created.id, {
      text: "One more thing",
      agentId: null,
      at: new Date(),
    });

    const [row] = await database
      .select({ archivedAt: channels.archivedAt, lastMessage: channels.lastMessage })
      .from(channels)
      .where(eq(channels.id, created.id));

    // Hidden, not frozen: the archive is a tidying gesture, and typing in it undoes it.
    expect(row?.archivedAt).toBeNull();
    expect(row?.lastMessage).toBe("One more thing");
  });

  test("leaves a channel that was not archived alone", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const actor = { id: userId, email: `${userId}@openbot.test`, role: "user" } as const;
    const created = await store.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await store.recordActivity(actor, created.id, {
      text: "First thing",
      agentId: null,
      at: new Date(),
    });

    const [row] = await database
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, created.id));

    expect(row?.archivedAt).toBeNull();
  });

  test("still refuses a deleted channel", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const actor = { id: userId, email: `${userId}@openbot.test`, role: "user" } as const;
    const created = await store.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await store.softDelete(actor, created.id);

    // Deleting and archiving are different acts, and only one of them is undone by typing.
    await expect(
      store.recordActivity(actor, created.id, {
        text: "Anybody there",
        agentId: null,
        at: new Date(),
      }),
    ).rejects.toThrow(ChannelNotFoundError);
  });

  test("does not restore on a report the store rejected as stale", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const actor = { id: userId, email: `${userId}@openbot.test`, role: "user" } as const;
    const created = await store.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    const now = new Date();
    await store.recordActivity(actor, created.id, {
      text: "Recent",
      agentId: null,
      at: now,
    });
    await store.setArchived(actor, created.id, true);

    // Older than what is stored, so the store ignores it as stale. An ignored report is not news,
    // and must not quietly unarchive the conversation either.
    await store.recordActivity(actor, created.id, {
      text: "Older",
      agentId: null,
      at: new Date(now.getTime() - 60_000),
    });

    const [row] = await database
      .select({ archivedAt: channels.archivedAt, lastMessage: channels.lastMessage })
      .from(channels)
      .where(eq(channels.id, created.id));

    expect(row?.archivedAt).not.toBeNull();
    expect(row?.lastMessage).toBe("Recent");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test server/tests/channel-archive.integration.test.ts`
Expected: FAIL on the first test — `archivedAt` is still set after activity.

- [ ] **Step 3: Read the archive state in the membership check**

In `recordActivity`, extend the first select so the prior state is known:

```ts
          const [membership] = await transaction
            .select({
              channelId: channelMemberships.channelId,
              archivedAt: channels.archivedAt,
            })
            .from(channelMemberships)
```

The `innerJoin` on `channels` with `isNull(channels.deletedAt)` stays exactly as it is. Deleting and
archiving are different acts and only archiving is undone here.

- [ ] **Step 4: Clear the archive with the same write**

In the `update(channels)` call inside `recordActivity`, add `archivedAt: null` to the `set`:

```ts
            .set({
              lastMessage,
              lastMessageAt: activity.at,
              lastMessageAgentId: activity.agentId,
              /*
               * Saying something restores an archived channel.
               *
               * On this write rather than a separate one, so it lands under the same
               * moves-forwards-only guard below: a report the store ignores as stale must not
               * unarchive the conversation either. An ignored report is not news.
               */
              archivedAt: null,
              updatedAt: new Date(),
            })
```

The existing `where` — which only applies the update when `activity.at` is newer than what is stored —
is what makes the stale case correct, and needs no change.

- [ ] **Step 5: Say so on the event**

After the `applied.length === 0` early return, when building the event, add the field only when
something was actually restored:

```ts
          const event: RosterActivityEvent = {
            kind: "channel",
            id: channelId,
            channelId,
            memberIds: members.map((member) => member.userId),
            lastMessage,
            lastMessageAt: activity.at.toISOString(),
            lastMessageAgentId: activity.agentId,
            // Only when this report is what restored it. On every other activity event the field is
            // absent, so a client patching a row does not have to distinguish "still not archived"
            // from "just came back".
            ...(membership.archivedAt !== null ? { archived: false } : {}),
          };
```

- [ ] **Step 5a: Add the store-level archive tests to the same file**

The route test in Task 3 proves the endpoint calls the store. These prove what the store actually
writes and announces, which a fake store cannot.

```ts
describe("archiving a channel, in the database", () => {
  test("does not restamp on a repeat call", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const actor = actorFor(userId);
    const created = await channelStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await channelStore.setArchived(actor, created.id, true);
    const [first] = await database
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, created.id));

    await channelStore.setArchived(actor, created.id, true);
    const [second] = await database
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, created.id));

    // Otherwise the row's archive time drifts forward on every click of an already-archived row.
    expect(second?.archivedAt).toEqual(first?.archivedAt);
  });

  test("restores by clearing the column, not by writing a second flag", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const actor = actorFor(userId);
    const created = await channelStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await channelStore.setArchived(actor, created.id, true);
    await channelStore.setArchived(actor, created.id, false);

    const [row] = await database
      .select({ archivedAt: channels.archivedAt, deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, created.id));

    expect(row?.archivedAt).toBeNull();
    expect(row?.deletedAt).toBeNull();
  });

  test("refuses a deleted channel", async () => {
    const userId = await seedUser();
    const agentId = await seedAgent();
    const actor = actorFor(userId);
    const created = await channelStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await channelStore.softDelete(actor, created.id);

    // A deleted channel is in no roster, so nothing about it is archivable.
    await expect(
      channelStore.setArchived(actor, created.id, true),
    ).rejects.toThrow(ChannelNotFoundError);
  });

  test("refuses a channel the caller is not in", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedAgent();
    const created = await channelStore.create(actorFor(owner), [agentId]);
    createdChannelIds.push(created.id);

    await expect(
      channelStore.setArchived(actorFor(stranger), created.id, true),
    ).rejects.toThrow(ChannelNotFoundError);
  });
});
```

- [ ] **Step 5b: Prove the announcement reaches every member**

Follow `server/tests/channel-events.integration.test.ts` for how it listens: it starts a real
`startChannelActivityListener` against `DATABASE_URL` and registers a hub connection per user. Copy
that setup rather than inventing one.

```ts
describe("the archive announcement", () => {
  test("reaches every member, because archiving is for all of them", async () => {
    const owner = await seedUser();
    const second = await seedUser();
    const agentId = await seedAgent();
    const created = await channelStore.create(actorFor(owner), [agentId]);
    createdChannelIds.push(created.id);
    // A second member, inserted directly: `create` adds only the caller.
    await database
      .insert(channelMemberships)
      .values({ channelId: created.id, userId: second });

    const received: RosterActivityEvent[] = [];
    const detach = hub.register(second, (payload) =>
      received.push(JSON.parse(payload) as RosterActivityEvent),
    );

    await channelStore.setArchived(actorFor(owner), created.id, true);
    // The listener is a real LISTEN on its own connection, so give the notify a moment to arrive.
    await waitFor(() => received.length > 0);
    detach();

    expect(received[0]).toMatchObject({
      kind: "channel",
      id: created.id,
      // Carried alongside `id` for one release, so an old replica mid-rollout can still read it.
      channelId: created.id,
      archived: true,
    });
  });

  test("announces nothing when the archive was refused", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedAgent();
    const created = await channelStore.create(actorFor(owner), [agentId]);
    createdChannelIds.push(created.id);

    const received: unknown[] = [];
    const detach = hub.register(owner, (payload) => received.push(payload));

    await channelStore
      .setArchived(actorFor(stranger), created.id, true)
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    detach();

    // Announced inside the transaction, so a refused archive rolls back its own announcement.
    expect(received).toEqual([]);
  });

  test("announces nothing when the channel was already archived", async () => {
    const owner = await seedUser();
    const agentId = await seedAgent();
    const actor = actorFor(owner);
    const created = await channelStore.create(actor, [agentId]);
    createdChannelIds.push(created.id);

    await channelStore.setArchived(actor, created.id, true);

    const received: unknown[] = [];
    const detach = hub.register(owner, (payload) => received.push(payload));
    await channelStore.setArchived(actor, created.id, true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    detach();

    // A no-op is not news. Announcing it would send every member's tabs to refetch for nothing.
    expect(received).toEqual([]);
  });
});
```

`waitFor` is a small local helper — poll a predicate every 10ms up to a second, then throw. If
`channel-events.integration.test.ts` already has one, import or copy it rather than writing a second.

- [ ] **Step 6: Run the test**

Run: `bun test server/tests/channel-archive.integration.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Prove nothing else moved**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
bun run format
git add server/src/channels/routes.ts server/tests/channel-archive.integration.test.ts
git commit -m "Bring an archived channel back when somebody says something in it"
```

---

### Task 5: The bot chat store

**Files:**
- Create: `server/src/bot-chats/store.ts`
- Test: `server/tests/bot-chat-store.integration.test.ts`

**Interfaces:**
- Consumes: `previewOf` and `titleOf` from Task 2; `ThreadIdentity` from `channels/thread-identity`; `AgentProfileStore.getWithin` and `AgentNotFoundError` from `agents/profile-store`; `ChannelActivity` from `channels/routes`; `RosterActivityEvent` and `CHANNEL_ACTIVITY_TOPIC` from Task 3.
- Produces:

```ts
export type BotChat = {
  id: string;
  agentId: string;
  threadId: string;
  title: string | null;
  active: boolean;
  archived: boolean;
};

export type BotChatStore = {
  create(actor: AgentActor, agentId: string): Promise<BotChat>;
  adopt(actor: AgentActor, agentId: string, threadId: string): Promise<BotChat>;
  get(actor: AgentActor, id: string): Promise<BotChat | null>;
  mostRecent(actor: AgentActor, agentId: string): Promise<BotChat | null>;
  recordActivity(actor: AgentActor, id: string, activity: ChannelActivity): Promise<void>;
  setPinned(actor: AgentActor, id: string, pinned: boolean): Promise<void>;
  markRead(actor: AgentActor, id: string): Promise<void>;
  setArchived(actor: AgentActor, id: string, archived: boolean): Promise<void>;
  softDelete(actor: AgentActor, id: string): Promise<void>;
};

export class BotChatNotFoundError extends Error {}
export class BotChatThreadTakenError extends Error {}

export function createBotChatStore(
  database: Database,
  profileStore: AgentProfileStore,
  threadIdentity: ThreadIdentity,
): BotChatStore;
```

- [ ] **Step 1: Write the failing test**

Create `server/tests/bot-chat-store.integration.test.ts`. Copy the scaffolding at the top of
`server/tests/channel-activity.integration.test.ts` — `databaseUrl`, `createDatabase`, `profileStore`,
the created-id arrays, `afterEach`, `afterAll` — and add a `seedProfile` helper, because `create`
resolves the agent through `profileStore.getWithin` and so needs an `agent_profiles` row, not only an
`agents` row.

```ts
const store = createBotChatStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);

function actorFor(userId: string): AgentActor {
  return { id: userId, email: `${userId}@openbot.test`, role: "user" };
}

describe("creating a bot chat", () => {
  test("mints a thread this deployment can recognise as its own", async () => {
    const identity = createThreadIdentity("test-deployment");
    const userId = await seedUser();
    const agentId = await seedProfile();

    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    expect(chat.id.startsWith("botchat_")).toBe(true);
    // Prefixed ids are what let one roster cursor page a mixed list, so the prefix is asserted.
    expect(identity.owns(chat.threadId)).toBe(true);
    expect(chat.title).toBeNull();
    expect(chat.archived).toBe(false);
    expect(chat.active).toBe(true);
  });

  test("gives every chat its own thread", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();

    const first = await store.create(actorFor(userId), agentId);
    const second = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(first.id, second.id);

    expect(first.threadId).not.toBe(second.threadId);
  });

  test("refuses a Bot the caller cannot see", async () => {
    const userId = await seedUser();

    await expect(
      store.create(actorFor(userId), "no-such-agent"),
    ).rejects.toThrow(AgentNotFoundError);
  });
});

describe("adopting a remembered thread", () => {
  test("takes a thread the browser already had", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const threadId = randomUUID();

    const chat = await store.adopt(actorFor(userId), agentId, threadId);
    createdBotChatIds.push(chat.id);

    expect(chat.threadId).toBe(threadId);
  });

  test("is idempotent for the person who owns it", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const threadId = randomUUID();

    const first = await store.adopt(actorFor(userId), agentId, threadId);
    const second = await store.adopt(actorFor(userId), agentId, threadId);
    createdBotChatIds.push(first.id);

    expect(second.id).toBe(first.id);
  });

  test("gives one row to two adoptions that race", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const threadId = randomUUID();

    /*
     * Started together, not one after the other, which is the case the constraint exists for.
     * Sequentially, the second call finds the first's row and returns it — that is the test above, and
     * it passes even against a naive read-then-write. Concurrently, both find nothing and both insert,
     * and only the unique index stops one conversation becoming two rows pointing at one transcript.
     */
    const [first, second] = await Promise.all([
      store.adopt(actorFor(userId), agentId, threadId),
      store.adopt(actorFor(userId), agentId, threadId),
    ]);
    createdBotChatIds.push(first.id);

    expect(second.id).toBe(first.id);

    const rows = await database
      .select({ id: botChats.id })
      .from(botChats)
      .where(eq(botChats.threadId, threadId));
    expect(rows).toHaveLength(1);
  });

  test("refuses a thread that belongs to somebody else", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const threadId = randomUUID();

    const chat = await store.adopt(actorFor(owner), agentId, threadId);
    createdBotChatIds.push(chat.id);

    await expect(
      store.adopt(actorFor(stranger), agentId, threadId),
    ).rejects.toThrow(BotChatThreadTakenError);
  });
});

describe("reading a bot chat", () => {
  test("answers null for somebody else's", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(owner), agentId);
    createdBotChatIds.push(chat.id);

    // Null rather than a refusal, so the route answers 404 and ownership is not probeable.
    expect(await store.get(actorFor(stranger), chat.id)).toBeNull();
  });

  test("answers null for a deleted one", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.softDelete(actorFor(userId), chat.id);

    expect(await store.get(actorFor(userId), chat.id)).toBeNull();
  });

  test("reads an archived one, because archived is hidden and not gone", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);

    const read = await store.get(actorFor(userId), chat.id);
    expect(read?.archived).toBe(true);
  });

  test("reports a retired Bot as inactive rather than hiding the conversation", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, agentId));

    const read = await store.get(actorFor(userId), chat.id);
    // A Bot is retired by soft-deleting its profile, so the transcript must stay readable.
    expect(read?.active).toBe(false);
  });
});

describe("mostRecent", () => {
  test("finds the newest non-archived chat for a Bot", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const older = await store.create(actorFor(userId), agentId);
    const newer = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(older.id, newer.id);

    await store.recordActivity(actorFor(userId), newer.id, {
      text: "Most recent",
      agentId: null,
      at: new Date(),
    });

    expect((await store.mostRecent(actorFor(userId), agentId))?.id).toBe(newer.id);
  });

  test("skips archived chats, so ?agent= does not reopen something put away", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);

    expect(await store.mostRecent(actorFor(userId), agentId)).toBeNull();
  });
});

describe("recording activity", () => {
  test("titles the chat from the first thing the person said", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.recordActivity(actorFor(userId), chat.id, {
      text: "What is our refund policy?",
      agentId: null,
      at: new Date(),
    });

    expect((await store.get(actorFor(userId), chat.id))?.title).toBe(
      "What is our refund policy?",
    );
  });

  test("does not title it from the Bot's opening message", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Hello, how can I help?",
      agentId,
      at: new Date(),
    });

    // The same greeting opens every chat, so titling from it makes every row identical.
    expect((await store.get(actorFor(userId), chat.id))?.title).toBeNull();
  });

  test("keeps the first title when more is said", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const at = new Date();
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "First question",
      agentId: null,
      at,
    });
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Second question",
      agentId: null,
      at: new Date(at.getTime() + 1000),
    });

    expect((await store.get(actorFor(userId), chat.id))?.title).toBe(
      "First question",
    );
  });

  test("only ever moves the last message forwards", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    const now = new Date();
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Recent",
      agentId: null,
      at: now,
    });
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "Older",
      agentId: null,
      at: new Date(now.getTime() - 60_000),
    });

    const [row] = await database
      .select({ lastMessage: botChats.lastMessage })
      .from(botChats)
      .where(eq(botChats.id, chat.id));
    // A person's message and the Bot's reply are reported separately and can arrive out of order.
    expect(row?.lastMessage).toBe("Recent");
  });

  test("restores an archived chat", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);
    await store.recordActivity(actorFor(userId), chat.id, {
      text: "One more thing",
      agentId: null,
      at: new Date(),
    });

    expect((await store.get(actorFor(userId), chat.id))?.archived).toBe(false);
  });

  test("refuses an agent id that is not this chat's Bot", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const otherAgentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await expect(
      store.recordActivity(actorFor(userId), chat.id, {
        text: "Not from this Bot",
        agentId: otherAgentId,
        at: new Date(),
      }),
    ).rejects.toThrow(AgentNotFoundError);
  });

  test("refuses somebody else's chat", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(owner), agentId);
    createdBotChatIds.push(chat.id);

    await expect(
      store.recordActivity(actorFor(stranger), chat.id, {
        text: "Not mine",
        agentId: null,
        at: new Date(),
      }),
    ).rejects.toThrow(BotChatNotFoundError);
  });
});

describe("archiving a bot chat", () => {
  test("is a no-op the second time", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.setArchived(actorFor(userId), chat.id, true);
    const [first] = await database
      .select({ archivedAt: botChats.archivedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));

    await store.setArchived(actorFor(userId), chat.id, true);
    const [second] = await database
      .select({ archivedAt: botChats.archivedAt })
      .from(botChats)
      .where(eq(botChats.id, chat.id));

    // A repeat call must not restamp, or the row's archive time drifts on every click.
    expect(second?.archivedAt).toEqual(first?.archivedAt);
  });

  test("refuses a deleted chat", async () => {
    const userId = await seedUser();
    const agentId = await seedProfile();
    const chat = await store.create(actorFor(userId), agentId);
    createdBotChatIds.push(chat.id);

    await store.softDelete(actorFor(userId), chat.id);

    await expect(
      store.setArchived(actorFor(userId), chat.id, true),
    ).rejects.toThrow(BotChatNotFoundError);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test server/tests/bot-chat-store.integration.test.ts`
Expected: FAIL — cannot resolve `../src/bot-chats/store`.

- [ ] **Step 3: Write the store**

Create `server/src/bot-chats/store.ts`. Structure it as `channels/routes.ts` structures
`createChannelStore`: one factory returning an object of methods, transactions at
`{ isolationLevel: "read committed" }`, and `pg_notify` inside the transaction so an announcement
rides the commit.

Module docblock:

```ts
/**
 * Direct Bot chats, as durable rows.
 *
 * WHAT THIS REPLACES. A thread id in one browser's `localStorage`, one per Bot, overwritten by a
 * button labelled "New chat". The transcript stayed in Intelligence and nothing in this deployment
 * could name it again.
 *
 * SHAPED AFTER `createChannelStore`, deliberately, because the two are read by one query and any
 * behaviour that differs between them shows up as a roster whose rows behave differently depending on
 * which kind they are. Where a rule here looks arbitrary, the reason is usually that channels already
 * do it that way.
 *
 * Every method is scoped to `actor.id`. A row belonging to somebody else is reported exactly as a row
 * that does not exist, so ownership is not something an outsider can probe for.
 */
```

The pieces that need stating precisely:

**`create`** — one transaction. Resolve the profile with `profileStore.getWithin(transaction, actor,
agentId)` and throw `AgentNotFoundError` when absent, so an agent cannot be retired between the check
and the insert. Then `id = \`botchat_${crypto.randomUUID()}\``, `threadId = threadIdentity.mint()`,
insert, and return.

**`adopt`** — one transaction.

```ts
      // Insert first and let the constraint answer, rather than reading and then writing. A read
      // followed by a write is two statements on two snapshots: two tabs adopting the same remembered
      // thread both find it absent and both insert, and one conversation becomes two rows pointing at
      // one transcript.
      const inserted = await transaction
        .insert(botChats)
        .values({ id, userId: actor.id, agentId, threadId })
        .onConflictDoNothing({ target: botChats.threadId })
        .returning({ id: botChats.id });

      if (inserted.length > 0) return { ... };

      // Somebody already has it. Whether that is this person calling twice or a different person
      // entirely decides between idempotence and a refusal.
      const [existing] = await transaction
        .select({ ...  })
        .from(botChats)
        .where(eq(botChats.threadId, threadId));
      if (!existing || existing.userId !== actor.id) {
        throw new BotChatThreadTakenError(threadId);
      }
      return { ... };
```

**`get`** — join `agentProfiles` for `active`, filter `isNull(botChats.deletedAt)` and
`eq(botChats.userId, actor.id)`, return null when there is no row. Does **not** filter on
`archivedAt`: archived is hidden from the roster, not from a direct read.

**`mostRecent`** — same filters plus `isNull(botChats.archivedAt)`, ordered by
`coalesce(last_message_at, created_at) desc, id desc`, limit 1. Comment why archived rows are skipped:
the `?agent=` resolver uses this, and reopening something the person put away would undo the archive
by navigation.

**`recordActivity`** — one transaction.

1. Select `{ agentId, title, archivedAt }` where the id, the owner, and `isNull(deletedAt)` all match.
   Throw `BotChatNotFoundError` when absent.
2. If `activity.agentId !== null && activity.agentId !== row.agentId`, throw `AgentNotFoundError`.
   Comment: a bot chat has one Bot, so an id naming a different one is a report about a conversation
   this is not.
3. Update with `lastMessage: previewOf(activity.text)`, `lastMessageAt`, `lastMessageAgentId`,
   `archivedAt: null`, `updatedAt`, and `title` set only when `row.title === null && activity.agentId
   === null`, to `titleOf(activity.text)`. Guard the update with
   `or(isNull(botChats.lastMessageAt), lt(botChats.lastMessageAt, activity.at))` — the same
   moves-forwards-only rule channels use, which is also what keeps a stale report from unarchiving the
   row.
4. `if (applied.length === 0) return;` — a stale report is not news.
5. Notify with `kind: "bot_chat"`, `id`, `memberIds: [actor.id]`, and `archived: false` only when
   `row.archivedAt !== null`. No `channelId` field at all.

**`setPinned`** / **`markRead`** / **`setArchived`** / **`softDelete`** — each an update guarded on
the id, the owner, and `isNull(deletedAt)`, throwing `BotChatNotFoundError` when nothing matched.

- `setPinned` sets `pinnedAt`, notifies with `pinned`.
- `markRead` sets `lastReadAt` using the same `greatest(now(), coalesce(last_message_at, now()))`
  expression channels use, and copy that comment: a marker stamped plainly "now" by a server running
  behind the reporting browser's clock leaves the row reading as unseen and re-lights the dot on every
  refetch.
- `setArchived` reads `archivedAt` first and returns early when already there, so a repeat call
  neither restamps nor announces; then notifies with `archived`.
- `softDelete` sets `deletedAt`, guarded on `isNull(deletedAt)` so a repeat call is a no-op, and
  notifies with `deleted: true`.

None of `setPinned`, `markRead`, or `recordActivity` consults `archivedAt`. Archived is hidden, not
frozen, and the roster query is the only read path that filters on it.

- [ ] **Step 4: Run the test**

Run: `bun test server/tests/bot-chat-store.integration.test.ts`
Expected: PASS. The block above holds 22 cases — count `test(` rather than trusting this sentence.

Three further cases belong here and are deliberately left for the implementer to add, because the
block above never exercises the paths they cover:

- **A stale report must not restore an archived chat.** The self-review below asks for it; the block
  does not contain it.
- **`markRead`.** Nothing above ever calls it, and its `greatest(now(), coalesce(...))` is
  hand-written SQL. An expression that has never executed is one nobody has checked Postgres accepts.
- **`setPinned` on an archived chat.** Nothing above calls it either, and the case doubles as the
  assertion that pinning neither consults nor clears `archived_at`.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run lint && bun run typecheck
git add server/src/bot-chats server/tests/bot-chat-store.integration.test.ts
git commit -m "Give a direct Bot chat a row that outlives the browser that started it"
```

---

### Task 6: The bot chat routes, mounted

**Files:**
- Create: `server/src/bot-chats/routes.ts`
- Modify: `server/src/app.ts` (parameter and mount)
- Modify: `server/src/index.ts` (build the store)
- Test: `server/tests/bot-chat-routes.test.ts`

**Interfaces:**
- Consumes: everything Task 5 produced.
- Produces:
  - `createBotChatRoutes(store: BotChatStore, requireUser: MiddlewareHandler<{ Variables: AppVariables }>): Hono<{ Variables: AppVariables }>`
  - `parseAdoptInput(input: unknown): { ok: true; value: { agentId: string; threadId: string } } | { ok: false; error: string }`
  - The eight routes listed in the spec, mounted at `/api/bot-chats`.
  - `createApp` gains a `botChatStore?: BotChatStore` parameter.

- [ ] **Step 1: Write the failing test**

Create `server/tests/bot-chat-routes.test.ts`, using the same fake-store-and-`app.request` harness as
`channel-archive.test.ts`.

```ts
import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { AgentNotFoundError } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import {
  createBotChatRoutes,
  parseAdoptInput,
} from "../src/bot-chats/routes";
import {
  type BotChat,
  BotChatNotFoundError,
  type BotChatStore,
  BotChatThreadTakenError,
} from "../src/bot-chats/store";

const actor: AgentActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function chat(overrides: Partial<BotChat> = {}): BotChat {
  return {
    id: "botchat_1",
    agentId: "agent-1",
    threadId: "11111111-1111-4111-8111-111111111111",
    title: null,
    active: true,
    archived: false,
    ...overrides,
  };
}

type StoreCall = [method: keyof BotChatStore, ...arguments_: unknown[]];

function fakeStore(overrides: Partial<BotChatStore> = {}) {
  const calls: StoreCall[] = [];
  const base: BotChatStore = {
    async create(receivedActor, agentId) {
      calls.push(["create", receivedActor, agentId]);
      return chat({ agentId });
    },
    async adopt(receivedActor, agentId, threadId) {
      calls.push(["adopt", receivedActor, agentId, threadId]);
      return chat({ agentId, threadId });
    },
    async get(receivedActor, id) {
      calls.push(["get", receivedActor, id]);
      return chat({ id });
    },
    async mostRecent(receivedActor, agentId) {
      calls.push(["mostRecent", receivedActor, agentId]);
      return chat({ agentId });
    },
    async recordActivity(receivedActor, id, activity) {
      calls.push(["recordActivity", receivedActor, id, activity]);
    },
    async setPinned(receivedActor, id, pinned) {
      calls.push(["setPinned", receivedActor, id, pinned]);
    },
    async markRead(receivedActor, id) {
      calls.push(["markRead", receivedActor, id]);
    },
    async setArchived(receivedActor, id, archived) {
      calls.push(["setArchived", receivedActor, id, archived]);
    },
    async softDelete(receivedActor, id) {
      calls.push(["softDelete", receivedActor, id]);
    },
  };
  return Object.assign(base, overrides, { calls });
}

function appFor(store: BotChatStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createBotChatRoutes(store, requireUser));
  return app;
}

function put(app: Hono<{ Variables: AppVariables }>, path: string, body?: unknown) {
  return app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function post(app: Hono<{ Variables: AppVariables }>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the adopt input parser", () => {
  test.each([[null], [[]], ["input"], [42]])(
    "rejects a non-object root: %p",
    (input) => {
      expect(parseAdoptInput(input)).toEqual({
        ok: false,
        error: "Adopt input must be a JSON object.",
      });
    },
  );

  test("rejects a missing agent id", () => {
    expect(
      parseAdoptInput({ threadId: "11111111-1111-4111-8111-111111111111" }),
    ).toEqual({ ok: false, error: "Agent ID must be a non-empty string." });
  });

  test.each([
    ["not-a-uuid"],
    [""],
    ["11111111-1111-4111-8111"],
    ["11111111111141118111111111111111"],
  ])("rejects a thread id that could not be one: %p", (threadId) => {
    // Only a shape check. This route also has to accept a thread another deployment minted, so it
    // cannot ask whether we minted it — it can only refuse a string that is not a thread id at all.
    expect(parseAdoptInput({ agentId: "agent-1", threadId })).toEqual({
      ok: false,
      error: "Thread ID must be a thread id.",
    });
  });

  test("trims and accepts a plausible pair", () => {
    expect(
      parseAdoptInput({
        agentId: "  agent-1  ",
        threadId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      ok: true,
      value: {
        agentId: "agent-1",
        threadId: "11111111-1111-4111-8111-111111111111",
      },
    });
  });
});

describe("POST /", () => {
  test("creates a chat and answers 201", async () => {
    const store = fakeStore();
    const response = await post(appFor(store), "/", { agentId: "agent-1" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      botChat: {
        id: "botchat_1",
        agentId: "agent-1",
        threadId: "11111111-1111-4111-8111-111111111111",
        title: null,
        active: true,
        archived: false,
      },
    });
    expect(store.calls).toEqual([["create", actor, "agent-1"]]);
  });

  test("answers 404 for a Bot the caller cannot see", async () => {
    const store = fakeStore({
      async create() {
        throw new AgentNotFoundError("agent-1");
      },
    });
    const response = await post(appFor(store), "/", { agentId: "agent-1" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found." });
  });
});

describe("POST /adopt", () => {
  test("adopts a remembered thread", async () => {
    const store = fakeStore();
    const response = await post(appFor(store), "/adopt", {
      agentId: "agent-1",
      threadId: "11111111-1111-4111-8111-111111111111",
    });

    expect(response.status).toBe(200);
    expect(store.calls).toEqual([
      ["adopt", actor, "agent-1", "11111111-1111-4111-8111-111111111111"],
    ]);
  });

  test("answers 409 for a thread somebody else already has", async () => {
    const store = fakeStore({
      async adopt() {
        throw new BotChatThreadTakenError("thread");
      },
    });
    const response = await post(appFor(store), "/adopt", {
      agentId: "agent-1",
      threadId: "11111111-1111-4111-8111-111111111111",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "That conversation already belongs to somebody else.",
    });
  });

  test("answers 400 without reaching the store for an implausible thread id", async () => {
    const store = fakeStore();
    const response = await post(appFor(store), "/adopt", {
      agentId: "agent-1",
      threadId: "not-a-thread",
    });

    expect(response.status).toBe(400);
    expect(store.calls).toEqual([]);
  });
});

describe("GET /:id", () => {
  test("answers with the chat", async () => {
    const response = await appFor(fakeStore()).request("/botchat_1");
    expect(response.status).toBe(200);
  });

  test("answers 404 rather than 403 for somebody else's", async () => {
    const store = fakeStore({
      async get() {
        return null;
      },
    });
    const response = await appFor(store).request("/botchat_1");

    // The same answer every way, so ownership is not probeable.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Bot chat not found." });
  });
});

describe("PUT /:id/archive", () => {
  test.each([[true], [false]])("sets it to %p", async (archived) => {
    const store = fakeStore();
    const response = await put(appFor(store), "/botchat_1/archive", {
      archived,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archived });
    expect(store.calls).toEqual([["setArchived", actor, "botchat_1", archived]]);
  });

  test.each([[{}], [{ archived: "yes" }], [null]])(
    "refuses a body that does not say which way: %p",
    async (body) => {
      const store = fakeStore();
      const response = await put(appFor(store), "/botchat_1/archive", body);

      expect(response.status).toBe(400);
      expect(store.calls).toEqual([]);
    },
  );

  test("answers 404 for a chat that is not the caller's", async () => {
    const store = fakeStore({
      async setArchived() {
        throw new BotChatNotFoundError("botchat_1");
      },
    });
    const response = await put(appFor(store), "/botchat_1/archive", {
      archived: true,
    });

    expect(response.status).toBe(404);
  });
});

describe("PUT /:id/pin and /:id/read", () => {
  test("pins", async () => {
    const store = fakeStore();
    const response = await put(appFor(store), "/botchat_1/pin", {
      pinned: true,
    });

    expect(response.status).toBe(200);
    expect(store.calls).toEqual([["setPinned", actor, "botchat_1", true]]);
  });

  test("marks read with no body", async () => {
    const store = fakeStore();
    const response = await put(appFor(store), "/botchat_1/read");

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["markRead", actor, "botchat_1"]]);
  });
});

describe("POST /:id/activity", () => {
  test("reports what was said", async () => {
    const store = fakeStore();
    const at = "2026-08-31T09:00:00.000Z";
    const response = await post(appFor(store), "/botchat_1/activity", {
      text: "Hello",
      agentId: null,
      at,
    });

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([
      [
        "recordActivity",
        actor,
        "botchat_1",
        { text: "Hello", agentId: null, at: new Date(at) },
      ],
    ]);
  });

  test("refuses a report with no timestamp", async () => {
    const store = fakeStore();
    const response = await post(appFor(store), "/botchat_1/activity", {
      text: "Hello",
      agentId: null,
    });

    expect(response.status).toBe(400);
    expect(store.calls).toEqual([]);
  });
});

describe("DELETE /:id", () => {
  test("soft-deletes and answers 204", async () => {
    const store = fakeStore();
    const response = await appFor(store).request("/botchat_1", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["softDelete", actor, "botchat_1"]]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test server/tests/bot-chat-routes.test.ts`
Expected: FAIL — cannot resolve `../src/bot-chats/routes`.

- [ ] **Step 3: Write the routes**

Create `server/src/bot-chats/routes.ts`, following `channels/routes.ts`'s `createChannelRoutes`:
parsers as exported pure functions above the factory, a `mapStoreError` at the bottom, and every route
behind `requireUser`.

Reuse `parseActivityInput` by importing it from `../channels/routes` — the body shape is identical and
a second parser would drift. Its error sentences mention neither channels nor bot chats, so they read
correctly here.

The thread-id shape check is the same regex `channels/thread-routes.ts` uses, and the reason is the
same. Copy that comment:

```ts
/**
 * A UUID-shaped string, nothing more.
 *
 * Not the format `thread-identity.ts` mints: adoption also has to accept a thread minted by a
 * different deployment, or minted before this one had a name, and `identity.owns` is false for both
 * without either meaning the thread is not real. The shape check exists only to keep a string that
 * could not possibly be a thread id from reaching the database at all.
 */
const PLAUSIBLE_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

Route ordering matters: register `POST /adopt` **before** `POST /:id/activity` and `GET /:id`, or
`adopt` is read as an id. `channels/routes.ts` has the same hazard and says so above its `/events`
route.

`mapStoreError`:

```ts
function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Agent not found." }, 404);
  }
  if (error instanceof BotChatNotFoundError) {
    return context.json({ error: "Bot chat not found." }, 404);
  }
  if (error instanceof BotChatThreadTakenError) {
    return context.json(
      { error: "That conversation already belongs to somebody else." },
      409,
    );
  }
  throw error;
}
```

A DTO function, so the route never hands back whatever the store happens to select:

```ts
function botChatDto(botChat: BotChat) {
  return {
    id: botChat.id,
    agentId: botChat.agentId,
    threadId: botChat.threadId,
    title: botChat.title,
    active: botChat.active,
    archived: botChat.archived,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test server/tests/bot-chat-routes.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Mount it in `app.ts`**

Add a parameter to `createApp`, after `channelEvents` and documented in the same register as its
neighbours:

```ts
  /** A person's own conversations with one Bot. Absent leaves the routes unmounted. */
  botChatStore?: BotChatStore,
```

And the mount, next to the channels one:

```ts
  if (botChatStore) {
    app.route("/api/bot-chats", createBotChatRoutes(botChatStore, requireUser));
  }
```

`createApp` takes positional parameters, so a new one must go at the end of the list or every existing
call site shifts. Check where `channelEvents` sits and append after the last existing parameter rather
than inserting mid-list; then verify with `bun run typecheck` that no call site broke.

- [ ] **Step 6: Build the store in `index.ts`**

After `channelStore` is built, and reusing the same `agentProfileStore` and `threadIdentity`:

```ts
// The same thread identity the channels use, so a bot chat's thread says which deployment minted it
// in a project that may hold more than one.
const botChatStore = createBotChatStore(
  database,
  agentProfileStore,
  threadIdentity,
);
```

Then pass it to `createApp` in the matching position.

- [ ] **Step 7: Prove the server still starts and everything passes**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
bun run format
git add server/src/bot-chats server/src/app.ts server/src/index.ts server/tests/bot-chat-routes.test.ts
git commit -m "Expose a person's Bot chats over HTTP"
```

---

### Task 7: The union query

The structural core. Two phases: phase 1 chooses the page across both kinds, phase 2 hydrates each
kind separately, and phase 1's order is the only ordering authority.

**Files:**
- Create: `server/src/roster/query.ts`
- Test: `server/tests/roster-union.integration.test.ts`

**Interfaces:**
- Consumes: `RECENCY`, `pinnedRank`, `rosterOrder`, the cursor codec, `DEFAULT_ROSTER_PAGE`, `MAX_ROSTER_PAGE` from Task 2; the `botChats` table from Task 1.
- Produces:

```ts
export type RosterKind = "channel" | "bot_chat";
export type RosterStatus = "active" | "archived" | "all";

/** One row of the roster, whichever kind it came from. */
export type RosterItem = {
  kind: RosterKind;
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  archived: boolean;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  lastMessageAgentId: string | null;
  createdAt: Date;
  pinned: boolean;
  lastReadAt: Date | null;
};

export type RosterPage = { items: RosterItem[]; nextCursor: string | null };
export type RosterQuery = { cursor?: string; limit?: number; status?: RosterStatus };
export type RosterStore = {
  list(actor: AgentActor, query?: RosterQuery): Promise<RosterPage>;
};

/** Anything unrecognised reads as `"active"`. */
export function parseRosterStatus(value: string | null | undefined): RosterStatus;

export function createRosterStore(database: Database): RosterStore;
```

- [ ] **Step 1: Write the failing test for the status parser first**

This part is pure, so it gets a unit test rather than an integration one. Create
`server/tests/roster-status.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseRosterStatus } from "../src/roster/query";

describe("parseRosterStatus", () => {
  test.each([
    ["active", "active"],
    ["archived", "archived"],
    ["all", "all"],
  ])("reads %p as %p", (input, expected) => {
    expect(parseRosterStatus(input)).toBe(expected);
  });

  test.each([[null], [undefined], [""], ["ACTIVE"], ["deleted"], ["nonsense"]])(
    "reads %p as active",
    (input) => {
      // The same call decodeRosterCursor makes for a malformed cursor: the honest answer to a stale
      // link is the first page, not a 400 a person cannot act on. Case-sensitive on purpose, so the
      // accepted set is exactly the three documented values.
      expect(parseRosterStatus(input)).toBe("active");
    },
  );
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test server/tests/roster-status.test.ts`
Expected: FAIL — cannot resolve `../src/roster/query`.

- [ ] **Step 3: Write the failing integration test for the union**

Create `server/tests/roster-union.integration.test.ts`. Copy the scaffolding from
`channel-activity.integration.test.ts` and add `createdBotChatIds` cleanup plus a `seedProfile`
helper.

```ts
const rosterStore = createRosterStore(database);
const channelStore = createChannelStore(database, profileStore, identity);
const botChatStore = createBotChatStore(database, profileStore, identity);

describe("the roster", () => {
  test("holds both kinds in one list", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    const page = await rosterStore.list(actor);

    expect(page.items.map((item) => item.kind).sort()).toEqual([
      "bot_chat",
      "channel",
    ]);
  });

  test("names a bot chat after the Bot until somebody says something", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile("Risk Analyst");
    const botChat = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(botChat.id);

    const [item] = (await rosterStore.list(actor)).items;

    // A conversation with nothing in it has no subject to name it after.
    expect(item?.name).toBe("Risk Analyst");
  });

  test("names a bot chat after its title once there is one", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile("Risk Analyst");
    const botChat = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(botChat.id);

    await botChatStore.recordActivity(actor, botChat.id, {
      text: "What is our refund policy?",
      agentId: null,
      at: new Date(),
    });

    const [item] = (await rosterStore.list(actor)).items;
    expect(item?.name).toBe("What is our refund policy?");
  });

  test("orders both kinds by one rule", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    const now = Date.now();
    // The channel spoke more recently, so it must lead, even though the bot chat was made later.
    await botChatStore.recordActivity(actor, botChat.id, {
      text: "Earlier",
      agentId: null,
      at: new Date(now - 60_000),
    });
    await channelStore.recordActivity(actor, channel.id, {
      text: "Later",
      agentId: null,
      at: new Date(now),
    });

    const page = await rosterStore.list(actor);
    expect(page.items.map((item) => item.id)).toEqual([channel.id, botChat.id]);
  });

  test("lifts a pinned row of either kind above a more recent unpinned one", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    const now = Date.now();
    await botChatStore.recordActivity(actor, botChat.id, {
      text: "Older but pinned",
      agentId: null,
      at: new Date(now - 60_000),
    });
    await channelStore.recordActivity(actor, channel.id, {
      text: "Newer",
      agentId: null,
      at: new Date(now),
    });
    await botChatStore.setPinned(actor, botChat.id, true);

    const page = await rosterStore.list(actor);
    // A pin is 1 and no pin is 0, and the sort key descends, so pinned leads whatever its recency.
    expect(page.items.map((item) => item.id)).toEqual([botChat.id, channel.id]);
  });

  test("pages through a mixed list without repeating or skipping a row", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const expected: string[] = [];
    const base = Date.now();
    for (let index = 0; index < 6; index += 1) {
      if (index % 2 === 0) {
        const channel = await channelStore.create(actor, [agentId]);
        createdChannelIds.push(channel.id);
        await channelStore.recordActivity(actor, channel.id, {
          text: `Channel ${index}`,
          agentId: null,
          at: new Date(base - index * 1000),
        });
        expected.push(channel.id);
      } else {
        const botChat = await botChatStore.create(actor, agentId);
        createdBotChatIds.push(botChat.id);
        await botChatStore.recordActivity(actor, botChat.id, {
          text: `Bot chat ${index}`,
          agentId: null,
          at: new Date(base - index * 1000),
        });
        expected.push(botChat.id);
      }
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await rosterStore.list(actor, { limit: 2, cursor });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    // One cursor over two tables. Ids are prefixed and therefore globally unique, which is what lets
    // `id` break every tie without the cursor carrying `kind`.
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });

  test("hides archived rows from active, and only archived rows from archived", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    await channelStore.setArchived(actor, channel.id, true);

    const active = await rosterStore.list(actor, { status: "active" });
    const archived = await rosterStore.list(actor, { status: "archived" });
    const all = await rosterStore.list(actor, { status: "all" });

    expect(active.items.map((item) => item.id)).toEqual([botChat.id]);
    expect(archived.items.map((item) => item.id)).toEqual([channel.id]);
    expect(all.items).toHaveLength(2);
  });

  test("keeps deleted rows out of every status", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    await channelStore.softDelete(actor, channel.id);
    await botChatStore.softDelete(actor, botChat.id);

    for (const status of ["active", "archived", "all"] as const) {
      // `all` is a filter over archive state only. It is never a way to see deleted conversations.
      expect((await rosterStore.list(actor, { status })).items).toEqual([]);
    }
  });

  test("shows nobody else's conversations", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const agentId = await seedProfile();

    const channel = await channelStore.create(actorFor(owner), [agentId]);
    const botChat = await botChatStore.create(actorFor(owner), agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    expect((await rosterStore.list(actorFor(stranger))).items).toEqual([]);
  });

  test("keeps a channel whole when its agents outnumber the page", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const first = await seedProfile("First");
    const second = await seedProfile("Second");
    const third = await seedProfile("Third");

    const channel = await channelStore.create(actor, [first, second, third]);
    createdChannelIds.push(channel.id);

    const page = await rosterStore.list(actor, { limit: 1 });

    // The limit applies to conversations, not to hydrated rows. A limit applied to the join would
    // cut this channel up and serve its other Bots as separate entries with the same id.
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.agentIds).toHaveLength(3);
  });

  test("caps what a caller may ask for", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();
    const chat = await botChatStore.create(actor, agentId);
    createdBotChatIds.push(chat.id);

    // Asking for everything must not be a way to read everything.
    await expect(
      rosterStore.list(actor, { limit: 100_000 }),
    ).resolves.toBeDefined();
  });

  test("reports a retired Bot as inactive on both kinds", async () => {
    const userId = await seedUser();
    const actor = actorFor(userId);
    const agentId = await seedProfile();

    const channel = await channelStore.create(actor, [agentId]);
    const botChat = await botChatStore.create(actor, agentId);
    createdChannelIds.push(channel.id);
    createdBotChatIds.push(botChat.id);

    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, agentId));

    const page = await rosterStore.list(actor, { status: "all" });
    expect(page.items.every((item) => item.active === false)).toBe(true);
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `bun test server/tests/roster-union.integration.test.ts`
Expected: FAIL — cannot resolve `../src/roster/query`.

- [ ] **Step 5: Write `server/src/roster/query.ts`**

Module docblock:

```ts
/**
 * One roster over two kinds of conversation.
 *
 * TWO PHASES, AND THE UNION IS IN THE FIRST. `channels.list` is already built this way and its own
 * comment says why: the hydrated row set is one row per conversation-agent pair, so a limit applied
 * there "would cut a channel in half: its second Bot would arrive on the next page as a separate
 * entry with the same id." Phase 1 chooses the page — four narrow columns, the cursor, the order, the
 * limit. Phase 2 hydrates each kind with its own query. Phase 1's order is then the only ordering
 * authority in the module, which is the whole reason this file exists.
 *
 * WHY THE UNION IS CHEAP HERE. Both branches of phase 1 project the same four columns, with no arrays
 * and no aggregates, so it is a union of two identically-shaped narrow selects rather than of two
 * fully-hydrated ones.
 *
 * WHY ONE CURSOR IS ENOUGH. Ids are prefixed — `channel_...` and `botchat_...` — and therefore
 * globally unique, so `id` still breaks every tie and the cursor needs no `kind` term. That is the
 * one piece of luck in this design, and it is what lets the existing cursor codec serve a mixed list
 * unchanged.
 */
```

**`parseRosterStatus`:**

```ts
const STATUSES = new Set<RosterStatus>(["active", "archived", "all"]);

/**
 * Anything unrecognised reads as `"active"`.
 *
 * The same call `decodeRosterCursor` makes for a malformed cursor: the honest answer to a stale link
 * is the first page rather than a 400 a person cannot act on. A stale bookmark carrying a status this
 * deployment no longer has should show somebody their conversations, not an error.
 */
export function parseRosterStatus(
  value: string | null | undefined,
): RosterStatus {
  return value && STATUSES.has(value as RosterStatus)
    ? (value as RosterStatus)
    : "active";
}
```

**Phase 1.** Build two `select` queries and combine with `unionAll` from `drizzle-orm`. Each branch
projects exactly `{ kind, id, recency, pinned }`.

Channel branch: `channels` inner-joined to `channelMemberships` on the actor, filtered by
`isNull(channels.deletedAt)`, the archive predicate for the status, and the cursor predicate.

Bot chat branch: `botChats` filtered by `eq(botChats.userId, actor.id)`, `isNull(botChats.deletedAt)`,
the archive predicate, and the cursor predicate.

The archive predicate is one small helper so the two branches cannot disagree:

```ts
/**
 * What the status means, as a predicate.
 *
 * `deletedAt` is filtered separately and unconditionally: `all` is a filter over archive state only
 * and is never a way to see deleted conversations.
 */
function archiveFilter(status: RosterStatus, archivedAt: PgColumn) {
  if (status === "active") return isNull(archivedAt);
  if (status === "archived") return isNotNull(archivedAt);
  return undefined;
}
```

The cursor predicate is likewise one helper, taking the rank, recency, and id expressions for whichever
branch is asking, and producing the same single row comparison `channels.list` already uses:

```ts
sql`(${rank}, ${recency}, ${id}) < (${cursor.pinned ? 1 : 0}::int, ${cursor.recency}::timestamptz, ${cursor.id})`
```

Order the union by `rosterOrder(...)` over the union's own aliased columns, and `.limit(limit + 1)` —
one more than asked for, so "is there another page" needs no second count query.

Then slice to `limit`, and build `nextCursor` from the last kept row exactly as `channels.list` does.

**If `unionAll` fights the ordering.** drizzle-orm 0.45 orders a union by the *aliased* output columns,
not by the underlying expressions, so both branches must give the four columns the same aliases.
If it still will not compose, replace phase 1 — and only phase 1 — with one raw parameterised
`sql` union executed through `database.execute`. Do **not** fall back to running the two branches
separately and merging in TypeScript: that would put the sort rule in a second place inside the module
that exists to own it. Record whichever path was taken in a comment at the top of phase 1.

**Phase 2.** Two hydrations, each returning a `Map<string, RosterItem>`, run only for the ids phase 1
actually chose, and skipped entirely when that kind chose none.

The channel hydration is the existing second query in `channels.list`, near-verbatim: the same joins to
`channelMemberships`, `intelligenceChannelMappings`, `channelAgents` and `agentProfiles`, the same
`inArray` on the chosen ids, the same repeated `isNull(channels.deletedAt)` — copy that comment, since
its reason is unchanged: these are two statements on two snapshots, and a delete committing between
them would otherwise hand back a conversation this person can no longer see — and the same fold that
pushes `agentIds` and ands `active` together. Add `archived: row.archivedAt !== null`.

The bot chat hydration is one join to `agentProfiles`, with `name: row.title ?? row.agentName` and
`agentIds: [row.agentId]`.

**Reassembly.** Map over phase 1's rows in order and take each from whichever map holds it:

```ts
      // Phase 1's order is the only ordering authority. Reassembling in its order rather than sorting
      // the hydrated rows again is what keeps the two phases from being able to disagree.
      const items = chosen
        .map((row) =>
          row.kind === "channel"
            ? channelItems.get(row.id)
            : botChatItems.get(row.id),
        )
        .filter((item): item is RosterItem => item !== undefined);
```

Note why the `filter` is there rather than an assertion: phase 2 repeats the delete guard, so a
conversation deleted between the two statements is legitimately absent, and dropping it is correct.

- [ ] **Step 6: Run both tests**

Run: `bun test server/tests/roster-status.test.ts server/tests/roster-union.integration.test.ts`
Expected: PASS — 9 status tests and 13 union tests.

- [ ] **Step 7: Commit**

```bash
bun run format && bun run lint && bun run typecheck
git add server/src/roster/query.ts server/tests/roster-status.test.ts server/tests/roster-union.integration.test.ts
git commit -m "Read channels and Bot chats as one ordered roster"
```

---

### Task 8: The roster route

**Files:**
- Create: `server/src/roster/routes.ts`
- Modify: `server/src/app.ts`, `server/src/index.ts`
- Test: `server/tests/roster-routes.test.ts`

**Interfaces:**
- Consumes: `RosterStore`, `RosterItem`, `parseRosterStatus` from Task 7.
- Produces: `createRosterRoutes(store, requireUser)`, mounted at `/api/roster`. Answers `{items, nextCursor}` with every timestamp as ISO-8601.

- [ ] **Step 1: Write the failing test**

Create `server/tests/roster-routes.test.ts`, with a fake `RosterStore` recording the query it was
given.

```ts
function item(overrides: Partial<RosterItem> = {}): RosterItem {
  return {
    kind: "channel",
    id: "channel_1",
    name: "Assistant channel",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
    archived: false,
    lastMessage: "Hello",
    lastMessageAt: new Date("2026-08-31T09:00:00.000Z"),
    lastMessageAgentId: "agent-1",
    createdAt: new Date("2026-08-30T09:00:00.000Z"),
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

describe("GET /", () => {
  test("serialises every timestamp as ISO-8601", async () => {
    const store = fakeStore({ items: [item()], nextCursor: null });
    const response = await appFor(store).request("/");

    expect(await response.json()).toEqual({
      items: [
        {
          kind: "channel",
          id: "channel_1",
          name: "Assistant channel",
          agentIds: ["agent-1"],
          threadId: "thread-1",
          active: true,
          archived: false,
          lastMessage: "Hello",
          // Strings the browser can sort and compare, which is the bet the sort rule already makes.
          lastMessageAt: "2026-08-31T09:00:00.000Z",
          lastMessageAgentId: "agent-1",
          createdAt: "2026-08-30T09:00:00.000Z",
          pinned: false,
          lastReadAt: null,
        },
      ],
      nextCursor: null,
    });
  });

  test("passes the status through", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?status=archived");

    expect(store.queries).toEqual([{ status: "archived" }]);
  });

  test("reads an unrecognised status as active", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?status=nonsense");

    expect(store.queries).toEqual([{ status: "active" }]);
  });

  test("passes a cursor and a limit through", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?cursor=abc&limit=10");

    expect(store.queries).toEqual([
      { status: "active", cursor: "abc", limit: 10 },
    ]);
  });

  test("omits a limit that is not a number rather than passing NaN", async () => {
    const store = fakeStore({ items: [], nextCursor: null });
    await appFor(store).request("/?limit=lots");

    // The store clamps a limit it is given; it must not be handed NaN to clamp.
    expect(store.queries).toEqual([{ status: "active" }]);
  });

  test("carries the next cursor", async () => {
    const store = fakeStore({ items: [item()], nextCursor: "next" });
    const response = await appFor(store).request("/");

    expect((await response.json()).nextCursor).toBe("next");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test server/tests/roster-routes.test.ts`
Expected: FAIL — cannot resolve `../src/roster/routes`.

- [ ] **Step 3: Write the route**

Model it on the `GET /` in `channels/routes.ts`, which already reads `cursor` and `limit` off the URL
and spreads them conditionally so an absent value is absent rather than `undefined`.

```ts
  routes.get("/", requireUser, async (context) => {
    try {
      const url = new URL(context.req.url);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const page = await store.list(context.var.actor, {
        status: parseRosterStatus(url.searchParams.get("status")),
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      });

      return context.json({
        items: page.items.map(rosterItemDto),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });
```

And the DTO, which is the one place a `Date` becomes a string:

```ts
function rosterItemDto(item: RosterItem) {
  return {
    kind: item.kind,
    id: item.id,
    name: item.name,
    agentIds: item.agentIds,
    threadId: item.threadId,
    active: item.active,
    archived: item.archived,
    lastMessage: item.lastMessage,
    // ISO-8601 so the browser gets strings it can sort and compare, which is the same bet the sort
    // rule makes on the server.
    lastMessageAt: item.lastMessageAt?.toISOString() ?? null,
    lastMessageAgentId: item.lastMessageAgentId,
    createdAt: item.createdAt.toISOString(),
    pinned: item.pinned,
    lastReadAt: item.lastReadAt?.toISOString() ?? null,
  };
}
```

- [ ] **Step 4: Mount it**

In `app.ts`, add a `rosterStore?: RosterStore` parameter at the end of the list and:

```ts
  if (rosterStore) {
    app.route("/api/roster", createRosterRoutes(rosterStore, requireUser));
  }
```

In `index.ts`, `const rosterStore = createRosterStore(database);` and pass it through.

`GET /api/channels` stays exactly as it is. It is still the channels list, and narrowing what the
sidebar reads is not a reason to remove it.

- [ ] **Step 5: Run everything**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Check it by hand once**

```bash
bun run dev
```

Then, signed in, confirm each of these answers a JSON body with an `items` array:

```bash
curl -s --cookie-jar /dev/null 'http://localhost:3000/api/roster?status=active' | head -c 400
```

Expected: `{"items":[...],"nextCursor":null}`. A 401 means the request carried no session, which is
the guard working — use the browser's devtools network tab instead.

- [ ] **Step 7: Commit**

```bash
bun run format
git add server/src/roster/routes.ts server/src/app.ts server/src/index.ts server/tests/roster-routes.test.ts
git commit -m "Serve the roster over one endpoint"
```

---

### Task 9: The client data layer

**Files:**
- Create: `app/src/lib/roster/queries.ts`
- Create: `app/src/lib/bot-chats/queries.ts`
- Create: `app/src/lib/bot-chats/mutations.ts`
- Modify: `app/src/lib/channels/mutations.ts`
- Test: `app/tests/roster-queries.test.ts`

Follows the `openbot-data-access` skill: every read a `queryOptions` factory, every write a
`mutationOptions` factory, every request through `client` / `tryClient`. No component calls `fetch`.

**Interfaces:**
- Consumes: the `/api/roster`, `/api/bot-chats`, and `/api/channels/:id/archive` endpoints.
- Produces:

```ts
// app/src/lib/roster/queries.ts
export type RosterKind = "channel" | "bot_chat";
export type RosterStatus = "active" | "archived" | "all";
export type RosterItem = {
  kind: RosterKind;
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  archived: boolean;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  createdAt: string;
  pinned: boolean;
  lastReadAt: string | null;
};
export type RosterPage = { items: RosterItem[]; nextCursor: string | null };
export const rosterKeys: {
  all: readonly ["roster"];
  list: (status: RosterStatus) => readonly ["roster", "list", RosterStatus];
};
export function rosterListQueryOptions(status: RosterStatus): ...;

// app/src/lib/bot-chats/queries.ts
export type BotChat = { id: string; agentId: string; threadId: string; title: string | null; active: boolean; archived: boolean };
export const botChatKeys: { all: readonly ["bot-chats"]; detail: (id: string) => readonly ["bot-chats", "detail", string] };
export function botChatQueryOptions(id: string): ...;

// app/src/lib/bot-chats/mutations.ts
export function createBotChatMutationOptions(queryClient: QueryClient): ...;   // variables: string (agentId)
export function adoptBotChatMutationOptions(queryClient: QueryClient): ...;    // { agentId, threadId }
export function recordBotChatActivityMutationOptions(): ...;                   // { botChatId, text, agentId, at }
export function setBotChatPinnedMutationOptions(queryClient: QueryClient): ...;
export function markBotChatReadMutationOptions(queryClient: QueryClient): ...;
export function setBotChatArchivedMutationOptions(queryClient: QueryClient): ...;
export function deleteBotChatMutationOptions(queryClient: QueryClient): ...;

// app/src/lib/channels/mutations.ts
export function setChannelArchivedMutationOptions(queryClient: QueryClient): ...; // { channelId, archived }
```

- [ ] **Step 1: Write the failing test**

Create `app/tests/roster-queries.test.ts`. The query keys and the flattening `select` are the parts
worth pinning, because three cached lists hang off them.

```ts
import { describe, expect, test } from "bun:test";
import {
  type RosterItem,
  type RosterPage,
  rosterKeys,
  rosterListQueryOptions,
} from "../src/lib/roster/queries";

function item(id: string, overrides: Partial<RosterItem> = {}): RosterItem {
  return {
    kind: "channel",
    id,
    name: id,
    agentIds: [],
    threadId: `thread-${id}`,
    active: true,
    archived: false,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2026-08-31T09:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

describe("rosterKeys", () => {
  test("gives each status its own cache", () => {
    // Three statuses mean three cached infinite queries. Sharing a key would have Archived overwrite
    // Active's pages the moment either is fetched.
    expect(rosterKeys.list("active")).not.toEqual(rosterKeys.list("archived"));
    expect(rosterKeys.list("all")).toEqual(["roster", "list", "all"]);
  });

  test("nests every list under one prefix, so one invalidate reaches all three", () => {
    for (const status of ["active", "archived", "all"] as const) {
      expect(rosterKeys.list(status).slice(0, 1)).toEqual([...rosterKeys.all]);
    }
  });
});

describe("rosterListQueryOptions", () => {
  test("flattens pages for the caller", () => {
    const options = rosterListQueryOptions("active");
    const pages: RosterPage[] = [
      { items: [item("channel_1")], nextCursor: "one" },
      { items: [item("botchat_2", { kind: "bot_chat" })], nextCursor: null },
    ];

    // The sidebar and the socket both see one array in roster order; neither has to know it is paged.
    expect(
      options.select?.({ pages, pageParams: ["", "one"] })?.map((row) => row.id),
    ).toEqual(["channel_1", "botchat_2"]);
  });

  test("stops paging when the server says there is no next cursor", () => {
    const options = rosterListQueryOptions("active");
    expect(
      options.getNextPageParam({ items: [], nextCursor: null }),
    ).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: "more" })).toBe(
      "more",
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test app/tests/roster-queries.test.ts`
Expected: FAIL — cannot resolve `../src/lib/roster/queries`.

- [ ] **Step 3: Write `app/src/lib/roster/queries.ts`**

Model it on `app/src/lib/channels/queries.ts`, whose `channelListQueryOptions` is an
`infiniteQueryOptions` with a `select` that flattens pages.

```ts
import { infiniteQueryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * One roster over two kinds of conversation.
 *
 * `kind` is for rendering, not for finding a row: ids are prefixed on the server and therefore
 * globally unique, so everything that looks a row up does it by id alone.
 *
 * `archived` is carried on the row rather than inferred from which list it arrived in, because the
 * menu on the row has to offer Archive or Restore and a row can be sitting in the All list.
 */
export type RosterKind = "channel" | "bot_chat";

/** Which conversations a list holds. `all` is active plus archived, and never deleted. */
export type RosterStatus = "active" | "archived" | "all";

export type RosterItem = {
  kind: RosterKind;
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  /** False once the Bot has been retired: the transcript stays readable, nothing more can be said. */
  active: boolean;
  archived: boolean;
  lastMessage: string | null;
  /** ISO-8601, or null for a conversation nobody has used yet. */
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** ISO-8601. Ordering falls back to this, so a conversation just made sorts to the top. */
  createdAt: string;
  pinned: boolean;
  /** ISO-8601 when this person last had it open, or null for never. Theirs, only. */
  lastReadAt: string | null;
};

export type RosterPage = { items: RosterItem[]; nextCursor: string | null };

/**
 * The status is part of the key, so the three lists are three caches.
 *
 * Sharing one key would have Archived's pages overwrite Active's the moment either was fetched. All
 * three sit under one prefix so a single `invalidateQueries` on `rosterKeys.all` reaches every one of
 * them, which is what an archive has to do — see `use-channel-events.ts` for why an archive
 * invalidates rather than patches.
 */
export const rosterKeys = {
  all: ["roster"] as const,
  list: (status: RosterStatus) => ["roster", "list", status] as const,
};

export function rosterListQueryOptions(status: RosterStatus) {
  return infiniteQueryOptions({
    queryKey: rosterKeys.list(status),
    initialPageParam: "",
    queryFn: async ({ pageParam }): Promise<RosterPage> => {
      const parameters = new URLSearchParams({ status });
      if (pageParam) parameters.set("cursor", pageParam as string);
      const response = await client(`/api/roster?${parameters.toString()}`, {
        fallback: "Could not load your conversations",
      });
      return (await response.json()) as RosterPage;
    },
    getNextPageParam: (page: RosterPage) => page.nextCursor ?? undefined,
    select: (data): RosterItem[] => data.pages.flatMap((page) => page.items),
  });
}
```

- [ ] **Step 4: Run the test**

Run: `bun test app/tests/roster-queries.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write `app/src/lib/bot-chats/queries.ts`**

Mirror `channelQueryOptions`, which uses the `client(path, key, options)` overload to unwrap the
envelope:

```ts
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One direct conversation with one Bot. `threadId` is what the chat component talks in. */
export type BotChat = {
  id: string;
  agentId: string;
  threadId: string;
  /** Null until the person has said something. The roster falls back to the Bot's name. */
  title: string | null;
  active: boolean;
  archived: boolean;
};

export const botChatKeys = {
  all: ["bot-chats"] as const,
  detail: (id: string) => ["bot-chats", "detail", id] as const,
};

export function botChatQueryOptions(id: string) {
  return queryOptions({
    queryKey: botChatKeys.detail(id),
    queryFn: (): Promise<BotChat> =>
      client(`/api/bot-chats/${id}`, "botChat", {
        fallback: "Could not load this conversation",
      }),
  });
}
```

- [ ] **Step 6: Write `app/src/lib/bot-chats/mutations.ts`**

Each factory mirrors its channel counterpart, including the reasons in the comments — those reasons
are unchanged, and a bot chat behaving differently from a channel in the same roster is the bug this
symmetry prevents.

- `createBotChatMutationOptions` — `POST /api/bot-chats`, unwraps `botChat`, invalidates
  `rosterKeys.all`. Deliberately not idempotent: every call starts a conversation.
- `adoptBotChatMutationOptions` — `POST /api/bot-chats/adopt`, unwraps `botChat`, invalidates
  `rosterKeys.all`.
- `recordBotChatActivityMutationOptions` — `POST /api/bot-chats/:id/activity` through `tryClient`,
  fire-and-forget. Copy the channel version's reasoning verbatim: the client that ran the agent
  already has the message before platform replay can return it, the runtime exposes no
  run-completion hook, and a failed preview update is a stale roster line rather than a lost message.
- `setBotChatPinnedMutationOptions` — `PUT .../pin`, invalidates `rosterKeys.all`.
- `markBotChatReadMutationOptions` — `PUT .../read`, patching the cache in `onMutate` exactly as
  `markChannelReadMutationOptions` does, including the `lastMessageAt > now` guard and its comment.
  It must patch **all three** lists, not just Active. Do it by iterating the statuses:

```ts
    onMutate: (botChatId) => {
      const now = new Date().toISOString();
      for (const status of ["active", "archived", "all"] as const) {
        queryClient.setQueryData(
          rosterKeys.list(status),
          (data: InfiniteData<RosterPage> | undefined) => /* ...as the channel version... */,
        );
      }
    },
```

- `setBotChatArchivedMutationOptions` — `PUT .../archive`, invalidates `rosterKeys.all`. Comment why
  it invalidates rather than patches: the row moves between lists, which is a page-membership change.
- `deleteBotChatMutationOptions` — `DELETE`, invalidates `rosterKeys.all` only, leaving the detail
  query alone for the reason the channel version gives: refetching it would hit the fresh 404 and
  flash an error before the navigate-home lands.

- [ ] **Step 7: Add the channel archive mutation**

In `app/src/lib/channels/mutations.ts`:

```ts
/**
 * Archive or restore a channel for everyone in it. Hidden, not frozen: the conversation stays live.
 *
 * Invalidates rather than patches, because the row moves between the Active, Archived, and All lists
 * and a patch would leave it in two of them at once. `rosterKeys.all` is the prefix all three share.
 */
export function setChannelArchivedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { channelId: string; archived: boolean }) => {
      await client(`/api/channels/${variables.channelId}/archive`, {
        method: "PUT",
        body: { archived: variables.archived },
        fallback: variables.archived
          ? "Could not archive this channel"
          : "Could not restore this channel",
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rosterKeys.all }),
  });
}
```

The existing channel mutations still invalidate `channelKeys`. Add `rosterKeys.all` to
`createChannelMutationOptions`, `setChannelPinnedMutationOptions`, and
`deleteChannelMutationOptions` as well, since the sidebar now reads the roster rather than the
channels list. Leave the `channelKeys` invalidations in place: `channelQueryOptions` still backs the
open channel screen.

- [ ] **Step 8: Prove it typechecks and nothing regressed**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
bun run format
git add app/src/lib/roster app/src/lib/bot-chats app/src/lib/channels/mutations.ts app/tests/roster-queries.test.ts
git commit -m "Read the roster and write Bot chats from the browser"
```

---

### Task 10: Socket events for two kinds

**Files:**
- Modify: `app/src/lib/channels/use-channel-events.ts`
- Test: `app/tests/roster-event-patch.test.ts` (extends `app/tests/channel-event-patch.test.ts`)

**Interfaces:**
- Consumes: `RosterItem`, `RosterPage`, `rosterKeys` from Task 9.
- Produces:
  - `type RosterActivityEvent = { kind: "channel" | "bot_chat"; id: string; channelId?: string; lastMessage: string | null; lastMessageAt: string | null; lastMessageAgentId: string | null; deleted?: true; pinned?: boolean; archived?: boolean }`
  - `applyRosterEvent(data: RosterCache, activity: RosterActivityEvent): RosterCache | "unknown" | "refetch"`
  - `useRosterEvents()` replacing `useChannelEvents()`.

- [ ] **Step 1: Write the failing test**

Rename `app/tests/channel-event-patch.test.ts` to `app/tests/roster-event-patch.test.ts`, change its
`channel()` helper to build a `RosterItem` (adding `kind`, `archived`, and `lastReadAt`), and add these
cases to the ones it already has.

```ts
describe("applyRosterEvent", () => {
  test("patches a bot chat row by id, without being told its kind", () => {
    const data = cache([item("botchat_1", { kind: "bot_chat" })]);
    const patched = applyRosterEvent(
      data,
      event({ kind: "bot_chat", id: "botchat_1", lastMessage: "Hello" }),
    );

    // Ids are globally unique, so a row is found by id and `kind` is only needed to render it.
    expect(patched).not.toBe("unknown");
    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    expect(patched.pages[0]?.items[0]?.lastMessage).toBe("Hello");
  });

  test("asks for a refetch when a row is archived", () => {
    const data = cache([item("channel_1")]);

    // The row moves between the Active, Archived, and All lists. That is a page-membership change,
    // not a field change, and patching it would leave the row in two lists at once.
    expect(
      applyRosterEvent(data, event({ id: "channel_1", archived: true })),
    ).toBe("refetch");
  });

  test("asks for a refetch when a row is restored", () => {
    const data = cache([item("channel_1", { archived: true })]);
    expect(
      applyRosterEvent(data, event({ id: "channel_1", archived: false })),
    ).toBe("refetch");
  });

  test("asks for a refetch when activity restored an archived row", () => {
    const data = cache([item("channel_1", { archived: true })]);

    // An activity event that carries `archived: false` did two things at once. The move matters more.
    expect(
      applyRosterEvent(
        data,
        event({ id: "channel_1", lastMessage: "Back", archived: false }),
      ),
    ).toBe("refetch");
  });

  test("still patches ordinary activity without a refetch", () => {
    const data = cache([item("channel_1"), item("channel_2")]);
    const patched = applyRosterEvent(
      data,
      event({
        id: "channel_2",
        lastMessage: "Newest",
        lastMessageAt: "2026-08-31T10:00:00.000Z",
      }),
    );

    expect(patched).not.toBe("refetch");
    if (patched === "unknown" || patched === "refetch") return;
    // Re-sorted inside its page, as before: activity is the one thing that reorders the list.
    expect(patched.pages[0]?.items[0]?.id).toBe("channel_2");
  });

  test("removes a deleted row rather than asking for a refetch", () => {
    const data = cache([item("channel_1"), item("channel_2")]);
    const patched = applyRosterEvent(
      data,
      event({ id: "channel_1", deleted: true }),
    );

    // Deleted rows are in no list at all, so removal is complete and a refetch would be wasted work.
    if (patched === "unknown" || patched === "refetch") throw new Error("patched");
    expect(patched.pages[0]?.items.map((row) => row.id)).toEqual(["channel_2"]);
  });

  test("refetches an archive for a row this cache does not hold", () => {
    const data = cache([item("channel_1")]);

    /*
     * The list that must GAIN the row is the one that does not hold it. Returning `data` here was
     * the bug that made restoring silently not propagate: an archived row is absent from Active by
     * definition, so a restore refetched nothing and the conversation stayed invisible.
     */
    expect(
      applyRosterEvent(data, event({ id: "botchat_9", archived: true })),
    ).toBe("refetch");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test app/tests/roster-event-patch.test.ts`
Expected: FAIL — `applyRosterEvent` is not exported.

- [ ] **Step 3: Widen the event type in the browser**

In `app/src/lib/channels/use-channel-events.ts`, replace `ChannelActivityEvent` with:

```ts
export type RosterActivityEvent = {
  kind: "channel" | "bot_chat";
  /** The row's id. Globally unique across kinds, so nothing looks a row up by anything else. */
  id: string;
  /**
   * The channel's id, on a channel event from a server that still sends it.
   *
   * @deprecated Nothing here should read it.
   *
   * The wire keeps this field for one release for the sake of browser tabs still running the
   * PREVIOUS bundle, which look for `channelId` and know nothing of `id`. It is not for old
   * replicas: one of those emits `{channelId, ...}` with no `id` at all, which is a shape this file
   * cannot read whatever we do here. `server/src/channels/events.ts` carries the server half of the
   * reasoning.
   */
  channelId?: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  deleted?: true;
  pinned?: boolean;
  /** The row's archive state changed, so it has moved between lists. */
  archived?: boolean;
};
```

- [ ] **Step 4: Add the third outcome to the patch function**

Rename `applyChannelEvent` to `applyRosterEvent`, change `ChannelCache` to hold `RosterPage`s, and add
the archive branch. Its return type gains `"refetch"`.

Keep the existing ordering of the branches and its comment — the `deleted` check must stay above the
spread, or the spread stamps `deleted: true` onto the row instead of removing it. The archive branch
goes immediately after `deleted`:

```ts
  /*
   * An archive or a restore is a move, not a field change.
   *
   * Three statuses mean three cached lists, and this row now belongs to a different set of them.
   * Patching the field in place would leave it in the list it just left as well as the one it joined,
   * so the caller refetches instead. That is the same answer the "unknown row" case below gets, for
   * the same reason: page membership is not something a patch can express.
   *
   * Checked before the spread below, which would otherwise carry `archived` onto the row and make it
   * look handled. And checked even on an activity event, because an event that carries
   * `archived: false` is a report that restored the conversation — the move matters more than the
   * preview, and the refetch brings the preview too.
   *
   * Note the branch does NOT skip a list that lacks the row. See the branch body for why.
   */
  if (activity.archived !== undefined) {
    /*
     * Unconditional, including when this list does not hold the row.
     *
     * An earlier draft returned `data` here when `holdingPage === -1`, reasoning that a list without
     * the row has nothing to move. That is exactly backwards: the list that must *gain* the row is
     * the one that does not hold it yet. Restoring was the broken direction — an archived row is
     * absent from Active by definition, so a restore found nothing, refetched nothing, and the
     * conversation did not reappear until the next refocus or reconnect. Saying something in an
     * archived conversation is how it comes back, so that is the one path that must not be lossy.
     *
     * The cost is one refetch per archive event per member, and `memberIds` already scopes delivery.
     */
    return "refetch";
  }
```

Everything else in the function — the pin branch, the identity-preserving patch, the `byRecency`
re-sort, and the "returns the original object so React re-renders nothing" rule — stays exactly as it
is, with `channel` renamed to `item` throughout.

- [ ] **Step 5: Handle the third outcome in the hook**

Rename `useChannelEvents` to `useRosterEvents`, and give it the status so it patches the list on
screen. The socket path stays `/api/channels/events`: the endpoint has not moved and renaming it would
be a second wire change for no gain.

```ts
export function useRosterEvents(status: RosterStatus) {
```

In `onmessage`, replace the single `setQueryData` with one that handles `"refetch"`:

```ts
        let refetch = false;
        queryClient.setQueryData(
          rosterKeys.list(status),
          (data: RosterCache | undefined) => {
            if (!data) return data;
            const patched = applyRosterEvent(data, activity);
            if (patched === "unknown" || patched === "refetch") {
              refetch = true;
              return data;
            }
            return patched;
          },
        );
        if (refetch) {
          /*
           * Every list, not just the one on screen.
           *
           * A row that has been archived has left one list and joined another, and the one it joined
           * may well be the one this tab is not looking at. Invalidating the shared prefix marks all
           * three stale; React Query refetches only the ones actually mounted.
           */
          void queryClient.invalidateQueries({ queryKey: rosterKeys.all });
        }
```

Keep the deleted-and-currently-open navigation block below, updating it to read `activity.id` and to
navigate away from `/channel/:id` or `/bot/:id` depending on `activity.kind`.

Also update the reconnect handler to invalidate `rosterKeys.all` rather than `channelKeys.list()`.

- [ ] **Step 6: Run the tests**

Run: `bun test app/tests/roster-event-patch.test.ts`
Expected: PASS — the file's original cases plus the seven new ones.

- [ ] **Step 7: Fix the callers**

Run: `bun run typecheck`. `app-sidebar.tsx` calls `useChannelEvents()`; leave it broken for now if
Task 11 is next, or pass `"active"` as a placeholder to keep the build green. Note it in the commit
message either way.

- [ ] **Step 8: Commit**

```bash
bun run format && bun run lint
git add app/src/lib/channels/use-channel-events.ts app/tests/roster-event-patch.test.ts
git rm app/tests/channel-event-patch.test.ts
git commit -m "Patch both kinds of roster row, and refetch when one moves list"
```

---

### Task 11: The roster row

**Files:**
- Create: `app/src/components/app-sidebar/roster-row.tsx` (from `channel.tsx`)
- Delete: `app/src/components/app-sidebar/channel.tsx`
- Test: `app/tests/roster-row-menu.test.ts` (extends `app/tests/channel-menu-mutations.test.ts`)

Follows `openbot-screen-layout` for the `Item`/`Button` size and variant vocabulary.

**Interfaces:**
- Consumes: `RosterItem` and `rosterKeys` from Task 9; the archive mutations from Task 9.
- Produces: `RosterRow`, a memoized component taking `{ kind, id, participantIds, name, lastMessage, lastMessageAt, pinned, unread, archived, active }`.

- [ ] **Step 1: Write the failing test**

Read `app/tests/channel-menu-mutations.test.ts` first and follow its approach — it tests the mutation
wiring rather than rendering, which is the right level here too. Create
`app/tests/roster-row-menu.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { linkFor, menuFor } from "../src/components/app-sidebar/roster-row";

describe("linkFor", () => {
  test("sends a channel row to the channel screen", () => {
    expect(linkFor({ kind: "channel", id: "channel_1" })).toEqual({
      to: "/channel/$channelId",
      params: { channelId: "channel_1" },
    });
  });

  test("sends a bot chat row to its own screen", () => {
    // A roster row that does not open what it names is worse than no row at all.
    expect(linkFor({ kind: "bot_chat", id: "botchat_1" })).toEqual({
      to: "/bot/$botChatId",
      params: { botChatId: "botchat_1" },
    });
  });
});

describe("menuFor", () => {
  test("offers Archive on a live row", () => {
    expect(menuFor({ archived: false, pinned: false })).toEqual([
      "pin",
      "archive",
      "delete",
    ]);
  });

  test("offers Restore in place of Archive on an archived row", () => {
    expect(menuFor({ archived: true, pinned: false })).toEqual([
      "pin",
      "restore",
      "delete",
    ]);
  });

  test("offers the same three on both kinds", () => {
    // A menu whose Delete works on half the rows is worse than a second soft-delete column, which is
    // why bot_chats has deleted_at.
    expect(menuFor({ archived: false, pinned: true })).toEqual([
      "unpin",
      "archive",
      "delete",
    ]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test app/tests/roster-row-menu.test.ts`
Expected: FAIL — cannot resolve `../src/components/app-sidebar/roster-row`.

- [ ] **Step 3: Move the file and extract the two pure functions**

```bash
git mv app/src/components/app-sidebar/channel.tsx app/src/components/app-sidebar/roster-row.tsx
```

Rename the component `Channel` to `RosterRow`, and add the two pure helpers above it so the branching
is testable without rendering:

```ts
/**
 * Where a row goes when it is clicked.
 *
 * Pure and exported so the branching is provable without a router: a roster row that does not open
 * what it names is the failure this guards against.
 */
export function linkFor(row: { kind: RosterKind; id: string }) {
  return row.kind === "channel"
    ? { to: "/channel/$channelId" as const, params: { channelId: row.id } }
    : { to: "/bot/$botChatId" as const, params: { botChatId: row.id } };
}

/**
 * What the context menu offers, as a list of acts.
 *
 * The same three on both kinds. A menu whose Delete worked on channel rows and not on bot chat rows
 * would be a menu that changed shape depending on which identical-looking row was right-clicked,
 * which is why `bot_chats` carries `deleted_at` at all.
 */
export function menuFor(row: { archived: boolean; pinned: boolean }) {
  return [
    row.pinned ? "unpin" : "pin",
    row.archived ? "restore" : "archive",
    "delete",
  ] as const;
}
```

- [ ] **Step 4: Branch the component on kind**

Add `kind` and `archived` to the props. **Not `active`** — the row renders nothing for it, and
`ChannelSummary` has carried `active` all along without the sidebar ever using it; the place it is
actionable is the screen the click leads to, which already shows a banner and disables the composer.
A prop the row does not render is a prop the row should not take. Then:

1. Replace the hardcoded `<Link to="/channel/$channelId" params={{ channelId }}>` with
   `<Link {...linkFor({ kind, id })}>`. The `className` and `activeProps` stay as they are — the row's
   markup, its `memo`, and its `content-visibility` treatment are unchanged, and the reasons those
   exist have not changed.
2. Replace the two hardcoded mutations with a pair chosen by kind:

```ts
  // One row, two kinds, and the endpoints differ. Chosen here rather than inside the handlers so the
  // handlers stay about what the person asked for rather than about which table it lands in.
  const channelPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const botChatPinned = useMutation(setBotChatPinnedMutationOptions(queryClient));
  const setPinned = kind === "channel" ? channelPinned : botChatPinned;
```

Do the same for archive and delete. Both hooks must be called unconditionally — hooks cannot be called
conditionally, and picking between two already-created mutations is what keeps that true.

3. Add the archive menu item between Pin and Delete:

```tsx
          <ContextMenuItem
            onClick={() => {
              setArchiveProblem(null);
              setArchived.mutate(
                { id, archived: !archived },
                { onError: (thrown) => setArchiveProblem(thrown.message) },
              );
            }}
          >
            {archived ? <IconArchiveOff /> : <IconArchive />}
            {archived ? "Restore" : "Archive"}
          </ContextMenuItem>
```

No confirmation dialog. Archiving is reversible and hides nothing permanently; the Delete dialog stays
exactly as it is, naming the conversation, because that row is one of several identical-looking rows.

4. A failed archive gets the same treatment a failed pin already has — a sentence on the row, replaced
   by the next attempt. Reuse the existing `pinProblem` pattern with its own state, and copy the
   reason: there is no toast in this app, and silence reads as the app ignoring the click.

5. `IconArchive` and `IconArchiveOff` come from `@tabler/icons-react`, matching the existing
   `IconPin` / `IconPinnedOff` pairing.

- [ ] **Step 5: Update the delete confirmation for two kinds**

`confirmDelete` navigates to `/` when the row's conversation is the one on screen. `isOpen` currently
reads `params.channelId`; it must now match either param:

```ts
  const isOpen = useParams({
    strict: false,
    select: (params) => {
      const held = params as { channelId?: string; botChatId?: string };
      return held.channelId === id || held.botChatId === id;
    },
  });
```

Keep the whole "away first" comment. Its reasoning is unchanged: the roster invalidates the moment the
delete lands, so this row and the dialog inside it unmount while the rest of the function is still
owed.

- [ ] **Step 6: Run the tests**

Run: `bun test app/tests/roster-row-menu.test.ts app/tests/channel-menu-mutations.test.ts`
Expected: PASS. Update `channel-menu-mutations.test.ts`'s import path to `roster-row` if it imports the
component.

- [ ] **Step 7: Commit**

```bash
bun run format && bun run lint
git add app/src/components/app-sidebar app/tests/roster-row-menu.test.ts
git commit -m "One roster row that archives, whichever kind it is"
```

---

### Task 12: The status filter and four empty states

**Files:**
- Create: `app/src/components/app-sidebar/status-filter.tsx`
- Modify: `app/src/components/app-sidebar/app-sidebar.tsx`
- Test: `app/tests/roster-empty-state.test.ts`

**Interfaces:**
- Consumes: `RosterStatus`, `rosterListQueryOptions` from Task 9; `useRosterEvents` from Task 10; `RosterRow` from Task 11.
- Produces:
  - `StatusFilter`, taking `{ value: RosterStatus; onChange: (next: RosterStatus) => void }`.
  - `emptyStateFor(input: { status: RosterStatus; searching: boolean; total: number; search: string }): { title: string; description: string } | null`, exported from `app-sidebar.tsx`.
  - `pinnedFirst` and `isUnread` keep their names and signatures, retyped to `RosterItem`.

- [ ] **Step 1: Write the failing test**

Create `app/tests/roster-empty-state.test.ts`. The four nothings are the part worth pinning, because
the existing code already carries a comment about how alarming the wrong one is.

```ts
import { describe, expect, test } from "bun:test";
import { emptyStateFor } from "../src/components/app-sidebar/app-sidebar";

describe("emptyStateFor", () => {
  test("says nothing at all when there are rows to show", () => {
    expect(
      emptyStateFor({ status: "active", searching: false, total: 3, search: "" }),
    ).toBeNull();
  });

  test("tells a new person how to start", () => {
    const state = emptyStateFor({
      status: "active",
      searching: false,
      total: 0,
      search: "",
    });
    expect(state?.title).toBe("No conversations yet");
  });

  test("quotes the search back rather than claiming there is nothing", () => {
    const state = emptyStateFor({
      status: "active",
      searching: true,
      total: 0,
      search: "  refnud  ",
    });
    // Told "you don't have conversations yet" while holding a typo, a person reads their history as
    // gone. The search text is quoted so they can see what was actually looked for.
    expect(state?.description).toContain("refnud");
  });

  test("says the archive is empty rather than that nothing exists", () => {
    const state = emptyStateFor({
      status: "archived",
      searching: false,
      total: 0,
      search: "",
    });
    expect(state?.title).toBe("Nothing archived");
  });

  test("distinguishes an empty archive from an empty account", () => {
    const archived = emptyStateFor({
      status: "archived",
      searching: false,
      total: 0,
      search: "",
    });
    const all = emptyStateFor({
      status: "all",
      searching: false,
      total: 0,
      search: "",
    });
    expect(archived?.title).not.toBe(all?.title);
  });

  test("prefers the search wording over the status wording", () => {
    const state = emptyStateFor({
      status: "archived",
      searching: true,
      total: 0,
      search: "budget",
    });
    // A search that matched nothing is a fact about the search, whichever list it ran against.
    expect(state?.description).toContain("budget");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test app/tests/roster-empty-state.test.ts`
Expected: FAIL — `emptyStateFor` is not exported.

- [ ] **Step 3: Write the filter control**

Create `app/src/components/app-sidebar/status-filter.tsx`. Three buttons in a row, the current one
filled, using the repo's `Button` with `size="sm"` and `variant="secondary"` for the selected one and
`variant="ghost"` for the others.

```tsx
const STATUSES: { value: RosterStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

/**
 * Which conversations the roster is showing.
 *
 * ALWAYS VISIBLE, ALWAYS LABELLED. A checkbox somebody left ticked is a hidden mode: the roster is
 * quietly missing their live conversations and nothing on screen says which state it is in. Three
 * labelled buttons cannot be in a state a person cannot see.
 */
export function StatusFilter({
  value,
  onChange,
}: {
  value: RosterStatus;
  onChange: (next: RosterStatus) => void;
}) {
  return (
    <div aria-label="Show conversations" className="flex flex-row gap-1" role="group">
      {STATUSES.map((status) => (
        <Button
          aria-pressed={status.value === value}
          key={status.value}
          onClick={() => onChange(status.value)}
          size="sm"
          variant={status.value === value ? "secondary" : "ghost"}
        >
          {status.label}
        </Button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Write `emptyStateFor`**

In `app-sidebar.tsx`, replacing the two inline empty blocks:

```ts
/**
 * Which nothing to say, of four.
 *
 * FOUR DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has used yet needs
 * telling how to start. A roster that simply does not match what is in the box has to say so and
 * quote it back — told "you don't have conversations yet" while holding a typo, a person reads their
 * conversations as gone. An empty archive is not an empty account. And `All` being empty is the only
 * one of the four that really does mean there is nothing anywhere.
 *
 * The search wording wins over the status wording, because a search that matched nothing is a fact
 * about the search whichever list it ran against.
 */
export function emptyStateFor(input: {
  status: RosterStatus;
  searching: boolean;
  total: number;
  search: string;
}): { title: string; description: string } | null {
  if (input.total > 0) return null;

  if (input.searching) {
    return {
      title: "No conversations match your search",
      description: `Nothing here is named “${input.search.trim()}”, and nobody has said it recently either.`,
    };
  }

  if (input.status === "archived") {
    return {
      title: "Nothing archived",
      description:
        "Archiving a conversation takes it out of this list without deleting anything. You can bring it back at any time.",
    };
  }

  if (input.status === "active") {
    return {
      title: "No conversations yet",
      description:
        "Start one with a coworker, or open a Bot chat. Anything you archive will still be here under Archived.",
    };
  }

  return {
    title: "No conversations at all",
    description: "Nothing here, archived or otherwise. Start one to get going.",
  };
}
```

The `“”` characters are the typographic quotes the existing empty state already uses; keep them.

- [ ] **Step 5: Rewire the sidebar**

In `AppSidebar`:

```ts
  const [status, setStatus] = useState<RosterStatus>("active");
  const roster = useInfiniteQuery(rosterListQueryOptions(status));
  // One socket for the app, opened where the roster is kept live. It needs the status so it patches
  // the list actually on screen.
  useRosterEvents(status);
  const [search, setSearch] = useState("");
  const searching = search.trim().length > 0;
  const visibleItems = pinnedFirst(matchingItems(roster.data, search));
```

Rename `matchingChannels` to `matchingItems` and retype it to `RosterItem[]`. Its body needs **no**
change: both kinds project `name` and `lastMessage`, so the existing filter over those two fields
already searches both. Keep its whole docblock, and add one line saying why it did not have to change.

Render the filter under the search input:

```tsx
            <SidebarMenuItem>
              <StatusFilter onChange={setStatus} value={status} />
            </SidebarMenuItem>
```

Replace the two inline empty blocks with one:

```tsx
            {(() => {
              const empty = emptyStateFor({
                status,
                searching,
                total: visibleItems.length,
                search,
              });
              return empty ? (
                <div className="py-4">
                  <Empty className="border border-dashed min-h-[40dvh]">
                    <EmptyHeader>
                      <EmptyTitle>{empty.title}</EmptyTitle>
                      <EmptyDescription className="text-pretty">
                        {empty.description}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </div>
              ) : null;
            })()}
```

And pass the new props through `ChannelRow` (rename it `Row`) to `RosterRow`: `kind`, `archived`, and
`active`.

`animateOrder` keeps its rule and its comment. Add `status` to what disables animation — switching
status replaces the whole list, and animating that is the same thrash filtering was.

```ts
  const animateOrder =
    !searching && (roster.data?.length ?? 0) <= MAX_ANIMATED_ROWS;
```

- [ ] **Step 6: Run the tests**

Run: `bun test app/tests/roster-empty-state.test.ts app/tests/channel-order.test.ts app/tests/channel-unread.test.ts`
Expected: PASS. `channel-order` and `channel-unread` test `pinnedFirst` and `isUnread`, which keep
their names and behaviour; update only their imports and the type of the objects they build.

- [ ] **Step 7: See it work**

```bash
bun run dev
```

In the browser: right-click a conversation, Archive it, confirm it leaves the list; switch to Archived
and confirm it is there; open it and send a message; confirm it returns to Active on its own.

- [ ] **Step 8: Commit**

```bash
bun run format && bun run lint && bun run typecheck
git add app/src/components/app-sidebar app/tests/roster-empty-state.test.ts
git commit -m "Filter the roster by Active, Archived, or All"
```

---

### Task 13: A Bot chat at its own URL

**Files:**
- Create: `app/src/routes/_authed/_app/bot_.$botChatId.tsx` — **note the trailing underscore on `bot_`**
- Modify: `app/src/routes/_authed/_app/bot.tsx`
- Test: `app/tests/bot-chat-resolver.test.ts`

**Interfaces:**
- Consumes: `botChatQueryOptions`, `createBotChatMutationOptions` from Task 9.
- Produces:
  - The route `/bot/$botChatId`, rendering `CopilotChat` for that chat's thread.
  - `resolveBotChat(input: { mostRecent: string | null }): { open: string } | { create: true }`, exported from `bot.tsx`.

- [ ] **Step 1: Write the failing test**

Create `app/tests/bot-chat-resolver.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveBotChat } from "../src/routes/_authed/_app/bot";

describe("resolveBotChat", () => {
  test("opens the conversation this person was last in", () => {
    expect(resolveBotChat({ mostRecent: "botchat_1" })).toEqual({
      open: "botchat_1",
    });
  });

  test("starts one when there is nothing to open", () => {
    // A first visit, or a person who archived everything: `?agent=` must still land somewhere usable.
    expect(resolveBotChat({ mostRecent: null })).toEqual({ create: true });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test app/tests/bot-chat-resolver.test.ts`
Expected: FAIL — `resolveBotChat` is not exported.

- [ ] **Step 3: Write the new route**

Create `app/src/routes/_authed/_app/bot.$botChatId.tsx`. It is the body of the existing `BotChat`
component with the thread coming from the server instead of `localStorage`.

```tsx
/**
 * One direct conversation with one Bot.
 *
 * The thread comes from the row now, not from `localStorage`. What that buys: this URL is shareable,
 * survives a different browser, and `New chat` no longer destroys what it replaces — the previous
 * conversation is a roster row somebody can click.
 */
export const Route = createFileRoute("/_authed/_app/bot/$botChatId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { botChatId } = Route.useParams();
  const { data: botChat, isPending, error } = useQuery(
    botChatQueryOptions(botChatId),
  );

  if (isPending) return null;
  if (error || !botChat) {
    /*
     * A sentence rather than a throw, for the reason `bot.tsx` already gives about a named Bot this
     * deployment does not have: a stale link is not a crash. Reached for somebody else's chat too,
     * which the server answers 404 for rather than 403.
     */
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">
          This conversation is not here any more.
        </p>
      </div>
    );
  }

  return <BotChatScreen botChat={botChat} key={botChat.id} />;
}
```

`BotChatScreen` keeps everything the current `BotChat` component does and why:

- `useActiveBot(botChat.agentId)` — tool calls act on this Bot's own computer.
- `useStoppedTurn(botChat.agentId)` and its banner. Keep the whole comment: the packaged chat reports
  a failed run to `onError` and otherwise carries on as though the turn finished, so the sentence has
  to be said here.
- The `history === "unavailable"` banner is **gone**, and this is the one real deletion. It existed
  because a remembered `localStorage` id could name a thread Intelligence had forgotten. The thread
  now comes from a row this deployment wrote, so there is nothing to have gone stale between visits.
  Say that in a comment where the banner was, so its absence reads as a decision.
- `<CopilotChat agentId={...} key={`${agentId}:${threadId}`} threadId={...} />` keeps its key and its
  comment about the packaged chat's `startNewThread` being a no-op once `threadId` is controlled.
- The header's `New chat` becomes `createBotChat.mutateAsync(botChat.agentId)` followed by
  `navigate({ to: "/bot/$botChatId", params: { botChatId: created.id } })`. It is no longer
  destructive, so the "a click with that consequence deserves a word, not just a glyph" comment no
  longer applies — replace it with one saying why the label stays anyway: it is still the control that
  starts a conversation, and the roster is where the old one now lives.
- The header gains the conversation's name: `botChat.title ?? "Browser Bot"`.
- When `botChat.active` is false, say so and disable the composer. The channel surface already
  distinguishes this; a Bot that has been retired leaves a readable transcript and nothing more.

- [ ] **Step 4: Turn `bot.tsx` into the resolver**

Replace its body. It keeps `validateSearch` and the two guards — a deployment with no Bots, and a
named Bot it does not have — because both are still the honest answers and both are still reachable.

```tsx
/**
 * Where `?agent=` lands, now that a Bot has more than one conversation.
 *
 * Kept rather than removed, because links to this route exist and the default-Bot behaviour is still
 * wanted: somebody who has never opened a Bot chat should get one, not a chooser. It resolves and
 * redirects, so every conversation is reached by its own URL either way.
 */
export function resolveBotChat(input: { mostRecent: string | null }) {
  return input.mostRecent === null
    ? ({ create: true } as const)
    : ({ open: input.mostRecent } as const);
}
```

The component reads `mostRecent` from the roster it already has — filter
`rosterListQueryOptions("active")` for `kind === "bot_chat"` and this `agentId`, taking the first,
since the roster is already in recency order and already loaded by the sidebar. That avoids a second
endpoint for a question the roster can answer.

Then, in an effect: `resolveBotChat` and either `navigate` to the chat or create one and navigate to
that. Render nothing while it resolves — the same rule the current screen follows, and for the same
reason: rendering the chat before the thread is known lets the packaged component mint an id of its
own, and that is the one this deployment would then be stuck with.

Note in a comment that `mostRecent` deliberately reads the **active** list, so `?agent=` does not
reopen a conversation somebody archived. The store's `mostRecent` applies the same rule server-side,
and both are stated because either alone would be a rule somebody could remove without noticing.

- [ ] **Step 5: Regenerate the route tree**

The route tree is generated. Run `bun run dev` once, or the app's own generate step, and confirm
`app/src/routeTree.gen.ts` picks up `/bot/$botChatId`. Commit the regenerated file with the change —
it is checked in.

- [ ] **Step 6: Run the tests**

Run: `bun test app/tests/bot-chat-resolver.test.ts app/tests/router.test.ts`
Expected: PASS. `router.test.ts` may enumerate routes; add the new one if so.

- [ ] **Step 7: See it work**

```bash
bun run dev
```

Open `/bot`, confirm it redirects to `/bot/botchat_…`, send a message, press `New chat`, confirm the
URL changes and the previous conversation is a roster row you can click back to.

- [ ] **Step 8: Commit**

```bash
bun run format && bun run lint && bun run typecheck
git add app/src/routes app/src/routeTree.gen.ts app/tests/bot-chat-resolver.test.ts
git commit -m "Give every Bot conversation its own URL, and stop New chat destroying one"
```

---

### Task 14: Adopt the conversation the browser remembers

The last task, and the one that decides whether upgrading loses anybody's history.

**Files:**
- Modify: `app/src/lib/copilot/bot-thread.ts`
- Test: `app/tests/bot-thread.test.ts` (extends the existing file)

**Interfaces:**
- Consumes: `adoptBotChatMutationOptions` from Task 9.
- Produces:
  - `threadToUse` and `botThreadKey` keep their current signatures and behaviour.
  - `useLegacyThreadAdoption(agentId: string): void` — runs once per Bot, adopts a remembered thread that Intelligence still has, and clears the key.
  - `useBotThread` is deleted.

- [ ] **Step 1: Write the failing test**

Add to `app/tests/bot-thread.test.ts`, keeping every existing `threadToUse` case exactly as it is —
that decision logic is unchanged and is the reason this task is safe.

```ts
import { shouldAdopt } from "../src/lib/copilot/bot-thread";

describe("shouldAdopt", () => {
  test("adopts a remembered thread Intelligence still has", () => {
    expect(shouldAdopt({ remembered: "thread-1", known: true })).toBe(true);
  });

  test("does not adopt a thread Intelligence has never heard of", () => {
    // Adopting a forgotten thread manufactures a roster row with no history behind it: a
    // conversation that looks recoverable and is empty when opened.
    expect(shouldAdopt({ remembered: "thread-1", known: false })).toBe(false);
  });

  test("does not adopt when the check could not get an answer", () => {
    // `undefined` is the check failing, not the thread being gone. Creating a row on the strength of
    // a network blip is the worse mistake, and the key survives for the next attempt.
    expect(shouldAdopt({ remembered: "thread-1", known: undefined })).toBe(
      false,
    );
  });

  test("has nothing to adopt when nothing was remembered", () => {
    expect(shouldAdopt({ remembered: null, known: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test app/tests/bot-thread.test.ts`
Expected: FAIL — `shouldAdopt` is not exported.

- [ ] **Step 3: Rewrite the module's purpose, keeping its knowledge**

Replace the module docblock. The old one explains why a remembered id needs verifying; the new one
explains that the verification is now used once, to rescue a thread rather than to keep using it.

```ts
/**
 * The conversation a browser remembers from before Bot chats had rows.
 *
 * WHAT THIS USED TO BE. The one place a direct Bot chat's thread id lived: `localStorage`, one per
 * Bot, re-verified on every mount because Intelligence is free to forget the thread behind an id —
 * expiry, environment reset, a wiped development database — and a remembered id nobody upstream
 * recognises does not fail loudly. Every send just opens a new, empty thread under the old id and
 * the chat answers as if nothing had ever been said.
 *
 * WHAT IT IS NOW. Threads come from `bot_chats` rows, so none of that applies going forward. What
 * remains is one release-crossing job: a browser upgrading into this feature is holding an id for a
 * real conversation that has no row, and without adopting it that transcript is orphaned in
 * Intelligence for good.
 *
 * The check is what makes adoption safe rather than merely enthusiastic. Adopting an id Intelligence
 * has forgotten would manufacture a roster row with nothing behind it: a conversation that looks
 * recoverable and is empty when opened. So only a provable "yes" adopts.
 */
```

Keep `botThreadKey`, `remembered`, `checkKnown`, and `threadToUse` exactly as they are, including all
their comments. `threadToUse` is still the right decision and is still tested; `shouldAdopt` is
expressed in terms of it so there is one rule, not two:

```ts
/**
 * Whether a remembered thread is worth adopting.
 *
 * The inverse of `threadToUse`'s question, and deliberately built on it rather than beside it: there
 * is one rule about when a remembered id can be trusted, and two spellings of it would drift.
 */
export function shouldAdopt(input: {
  remembered: string | null;
  known: boolean | undefined;
}): boolean {
  return (
    input.remembered !== null &&
    input.known === true &&
    threadToUse(input) === "remembered"
  );
}
```

- [ ] **Step 4: Write the hook and delete `useBotThread`**

```ts
/**
 * Rescue a remembered conversation, once per Bot.
 *
 * Runs on the Bot screen. `forget` only after the adoption has landed, so an adoption that failed —
 * offline, a 500, the tab closing — is retried next time rather than losing the id that is the only
 * remaining pointer to that transcript.
 *
 * A 409 is a success for this purpose: somebody already has the thread, which is the outcome adoption
 * wanted. Only an error that leaves the thread unclaimed is worth keeping the key for.
 */
export function useLegacyThreadAdoption(agentId: string): void {
```

Its effect: read `remembered(agentId)`; return if null; `checkKnown`; `shouldAdopt`; if so
`adopt.mutateAsync({ agentId, threadId })`, then `forget(agentId)`. Guard with the same
still-mounted / still-this-agent `current` flag pattern the existing effect uses, and copy that reason:
the agent may have changed or the component may have unmounted while the request was in flight.

Add `forget`, mirroring `remember`, with the same try/catch and the same reasoning about storage being
unavailable or full.

Delete `useBotThread` and the `BotThread` type. Its `mint`, `startNew`, `mountedRef`, `mintingRef`, and
`startedNewRef` machinery all existed to manage a thread id in storage, which nothing does now.
`POST /api/threads/mint` and `GET /api/threads/:threadId` stay on the server: the mint route is still
used by nothing here but is not this change's to remove, and the status route is what `checkKnown`
calls.

- [ ] **Step 5: Call it from the Bot screen**

In `bot.$botChatId.tsx`'s screen component, `useLegacyThreadAdoption(botChat.agentId)`. It is a no-op
for every browser that has no remembered key, which is every browser after the first visit.

- [ ] **Step 6: Run the tests**

Run: `bun test app/tests/bot-thread.test.ts`
Expected: PASS — the existing `threadToUse` cases plus the four new ones.

- [ ] **Step 7: Test the upgrade by hand**

This is the one path no test covers end to end.

1. `git stash` this branch, run `bun run dev` on `main`, open `/bot`, send a message.
2. In devtools, note `localStorage`'s `openbot.bot-thread.<agentId>` value.
3. Restore the branch, run `bun run dev`, open `/bot`.
4. Confirm a roster row appears carrying that conversation, that opening it shows the old messages,
   and that the `localStorage` key is gone.

- [ ] **Step 8: Full suite and commit**

```bash
bun test && bun run typecheck && bun run lint && bun run build
```

```bash
bun run format
git add app/src/lib/copilot/bot-thread.ts app/src/routes app/tests/bot-thread.test.ts
git commit -m "Adopt the Bot conversation a browser remembers, rather than orphaning it"
```

---

## Out of scope, on purpose

Recorded so nobody adds them mid-plan:

- **Removing `channelId` from the roster event.** A later release, once no replica predates `id`. The spec says why.
- **Per-member archiving.** Would be an `archived_at` on `channel_memberships` and would enter the cursor's sort key, which the channel grain deliberately avoids.
- **Automatic archiving on an idle window.** `work_items` already has the machinery.
- **Archiving Slack threads.** That surface does not exist yet.
- **Merging bot chats into the channels table.** Considered and rejected in the spec's "Alternative considered". If it is ever revisited, it deletes `roster/query.ts` and the `bot-chats` module rather than adding to them.

## Verification before calling it done

```bash
bun test && bun run typecheck && bun run lint && bun run build
```

Then by hand, because these are the paths tests do not cover:

| Check | Expected |
| --- | --- |
| Archive a channel, in two browser tabs at once | Leaves both rosters without a reload |
| Send a message in an archived conversation | It returns to Active on its own |
| Right-click a package-defined channel, Archive | Refused, and the sentence says "archived", not "deleted" |
| Switch to Archived with an empty archive | "Nothing archived", not "No conversations yet" |
| Search while on Archived, matching nothing | Quotes the search text back |
| `/bot?agent=<id>` | Redirects to `/bot/botchat_…` |
| `New chat`, then look at the sidebar | The previous conversation is still a row |
| Upgrade with a pre-existing `localStorage` thread | Adopted, openable, key cleared |
| A retired Bot's conversation | Readable, composer disabled |
