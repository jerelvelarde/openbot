import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { inArray, sql } from "drizzle-orm";
import { createApp } from "../src/app";
import {
  auditEventTypes,
  createAuditReader,
  createAuditRecorder,
  recordAuditEvent,
  redactAuditPayload,
} from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

const config = loadConfig({
  ...testEnvironment(),
});

const adminAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "admin", email: "admin@openbot.test" },
    }),
  },
};

const memberAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "member", email: "member@openbot.test" },
    }),
  },
};

describe("audit payload redaction", () => {
  test("defines the v1 audit event taxonomy", () => {
    expect(auditEventTypes).toEqual(
      expect.arrayContaining([
        "configuration.changed",
        "credential.created",
        "credential.rotated",
        "credential.revoked",
        "connector.sync_succeeded",
        "connector.sync_failed",
        "knowledge.searched",
        "agent.invoked",
        "mcp.call_succeeded",
        "mcp.call_rejected",
      ]),
    );
  });

  test("names both halves of the roster archive, and the removal", () => {
    /*
     * Named here rather than left to `arrayContaining` above, which asserts nothing about a type it
     * does not mention: the five this change adds could all be deleted and every line above would
     * still pass. A type removed from this list is an event the recorders below cannot be given —
     * `AuditEventType` is this array — so a screen that still archives writes no row, which is the
     * failure "where did that conversation go" is answered from.
     */
    expect(auditEventTypes).toEqual(
      expect.arrayContaining([
        "channel.archived",
        "channel.unarchived",
        "bot_chat.archived",
        "bot_chat.unarchived",
        "bot_chat.deleted",
      ]),
    );
  });

  test("removes secret values and document content recursively", () => {
    expect(
      redactAuditPayload({
        connector: "google_drive",
        accessToken: "sensitive-token",
        nested: {
          content: "full document body",
          resultCategory: "succeeded",
        },
      }),
    ).toEqual({
      connector: "google_drive",
      accessToken: "[REDACTED]",
      nested: {
        content: "[REDACTED]",
        resultCategory: "succeeded",
      },
    });
  });

  /*
   * Redaction is not destruction, asserted one shape at a time.
   *
   * `Object.entries` is empty for all four of these, so the pass rebuilt each of them as `{}` and the
   * row said a field had been there and nothing about what it held. That is worse than dropping the
   * key: a reader is shown a fact that is missing and cannot tell whether the payload was empty or the
   * trail ate it, on the surface whose whole argument is that it gets read to rule things out.
   *
   * Each case asserts the value survives AND that a sensitive key inside it is still redacted, because
   * the cheap way to make these pass is to hand the value back untouched.
   */
  test("keeps a Date as the instant it names", () => {
    expect(
      redactAuditPayload({ at: new Date("2026-08-31T12:00:00.123Z") }),
    ).toEqual({ at: "2026-08-31T12:00:00.123Z" });
  });

  test("keeps an unreadable Date as the null JSON would have written", () => {
    // `toISOString()` throws on one, and `JSON.stringify(new Date(NaN))` is `null`, so this is the
    // answer the payload would have carried had redaction never looked at it.
    expect(redactAuditPayload({ at: new Date(Number.NaN) })).toEqual({
      at: null,
    });
  });

  test("keeps a Map's entries, redacting the sensitive ones", () => {
    expect(
      redactAuditPayload({
        headers: new Map([
          ["authorization", "Bearer secret"],
          ["content-type", "application/json"],
        ]),
      }),
    ).toEqual({
      headers: {
        authorization: "[REDACTED]",
        "content-type": "application/json",
      },
    });
  });

  test("keeps a Set's members, redacting inside them", () => {
    expect(
      redactAuditPayload({
        attempts: new Set([{ tool: "search", token: "secret" }, "plain"]),
      }),
    ).toEqual({
      attempts: [{ tool: "search", token: "[REDACTED]" }, "plain"],
    });
  });

  test("keeps what an Error says, and what provoked it", () => {
    const cause = new Error("password rejected");
    expect(
      redactAuditPayload({ error: new TypeError("bad bound", { cause }) }),
    ).toEqual({
      error: {
        name: "TypeError",
        message: "bad bound",
        cause: { name: "Error", message: "password rejected" },
      },
    });
  });

  test("describes an object whose state no key would have shown", () => {
    /*
     * The general case behind the four above, rather than a fifth special case. Anything holding its
     * state somewhere other than its own enumerable keys came back as `{}`, and `Date`, `Map`, `Set`
     * and `Error` are the four of those that turn up in a payload often enough to be worth a shape of
     * their own. A `RegExp` is not, and being told what it was still beats being told nothing.
     */
    expect(redactAuditPayload({ pattern: /^bot_/i })).toEqual({
      pattern: "/^bot_/i",
    });
  });

  test("survives a payload that contains itself", () => {
    /*
     * Not a hypothetical shape. `createAuditRecorder` catches a failed write, but `recordAuditEvent`
     * redacts BEFORE the store is reached and several callers reach it directly, so a stack overflow
     * here is thrown out of the route that had already done the thing it was auditing.
     */
    const payload: Record<string, unknown> = { tool: "search" };
    payload.self = payload;
    payload.token = "secret";

    expect(redactAuditPayload(payload)).toEqual({
      tool: "search",
      self: "[CIRCULAR]",
      token: "[REDACTED]",
    });
  });

  test("writes only the redacted payload to the audit store", async () => {
    const writes: unknown[] = [];

    await recordAuditEvent(
      {
        insert: async (event) => {
          writes.push(event);
        },
      },
      {
        eventType: "credential.created",
        targetType: "credential",
        targetId: "credential-1",
        payload: { apiKey: "plaintext-key", provider: "openai" },
      },
    );

    expect(writes).toEqual([
      {
        eventType: "credential.created",
        targetType: "credential",
        targetId: "credential-1",
        payload: { apiKey: "[REDACTED]", provider: "openai" },
      },
    ]);
  });
});

/**
 * The two triggers that carry the append-only guarantee, and what each has to be firing on.
 *
 * One trigger per operation because a row-level trigger cannot fire on TRUNCATE — 0012 has the
 * argument. Both fire the same function, so the refusal is written once, and both are named here so a
 * chain that installs one and loses the other fails on the half that went missing.
 */
const GUARD_TRIGGERS = [
  {
    trigger: "audit_events_append_only",
    // Once per row, because UPDATE and DELETE are operations on rows.
    definition: "BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW",
  },
  {
    trigger: "audit_events_no_truncate",
    // Once per statement, because TRUNCATE takes the whole table and has no rows to be given.
    definition: "BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT",
  },
];

/**
 * Every statement in the chain that installs or removes one named trigger, in chain order.
 *
 * A GUARD ON A LITERAL SQL STRING IS NOT A GUARD, which is what this function exists to stop being
 * true here. The check used to be `not.toContain("DROP TRIGGER audit_events_append_only")`, and the
 * repo's own house style walks straight past it: 0012 writes `DROP TRIGGER IF EXISTS
 * audit_events_no_truncate ON audit_events;`, so the two words the assertion looks for never appear
 * adjacent. Verified rather than reasoned about — a probe migration dropping both triggers in that
 * style passed the old assertions. So the trigger is matched by NAME, through a pattern that survives
 * `IF EXISTS`, the `ON <table>` clause, a quoted identifier, any whitespace including a newline mid-
 * statement, and either case.
 *
 * BOTH KINDS, because "does the chain contain a drop" is the wrong question. 0012 legitimately drops
 * `audit_events_no_truncate` and creates it again in the next statement, which is how an idempotent
 * re-install is written and must not be a failure. What has to hold is that the LAST thing the chain
 * says about each trigger is that it exists, so the assertion is about order rather than presence.
 * `CREATE OR REPLACE TRIGGER` is matched as well as plain `CREATE TRIGGER`: nothing in the chain uses
 * it today, and a guard that only recognises the spelling currently in use is the defect above again.
 */
function guardTriggerStatements(
  chain: string,
  trigger: string,
): { verb: "create" | "drop"; statement: string }[] {
  const pattern = new RegExp(
    String.raw`\b(drop|create)\s+(?:or\s+replace\s+)?trigger\s+(?:if\s+(?:not\s+)?exists\s+)?"?${trigger}"?\b`,
    "gi",
  );
  return [...chain.matchAll(pattern)].map((match) => {
    const end = chain.indexOf(";", match.index);
    return {
      verb: match[1]?.toLowerCase() === "drop" ? "drop" : "create",
      statement: chain
        .slice(match.index, end === -1 ? undefined : end)
        .replaceAll(/\s+/g, " "),
    };
  });
}

describe("audit event immutability", () => {
  /*
   * The matcher above, against chains this file writes, so its teeth do not depend on the migrations.
   *
   * The assertion below can only fail when somebody writes the migration that breaks it, which is
   * exactly when nobody is reading this file. These cases fail the moment the pattern stops
   * recognising a spelling — including the four the old literal missed, each named here so a later
   * simplification of the regex cannot quietly drop one.
   */
  test.each([
    ["CREATE TRIGGER audit_events_append_only\nBEFORE UPDATE ON x", ["create"]],
    ["DROP TRIGGER audit_events_append_only;", ["drop"]],
    // The house style, which is the spelling that defeated the literal assertion.
    [
      "DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;",
      ["drop"],
    ],
    ["drop trigger if exists audit_events_append_only;", ["drop"]],
    ['DROP TRIGGER IF EXISTS "audit_events_append_only";', ["drop"]],
    ["DROP  TRIGGER\n  IF EXISTS\n  audit_events_append_only", ["drop"]],
    ["CREATE OR REPLACE TRIGGER audit_events_append_only", ["create"]],
    // A drop and a re-install is one statement about the trigger followed by another, in that order.
    [
      "DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;\nCREATE TRIGGER audit_events_append_only BEFORE UPDATE ON audit_events",
      ["drop", "create"],
    ],
    // A different trigger with the same prefix is not this trigger.
    ["DROP TRIGGER audit_events_append_only_v2 ON audit_events;", []],
    ["-- audit_events_append_only is installed by 0000", []],
  ])("reads %p as %p", (chain: string, expected: string[]) => {
    expect(
      guardTriggerStatements(chain, "audit_events_append_only").map(
        (statement) => statement.verb,
      ),
    ).toEqual(expected);
  });

  /*
   * The statement is captured, not only counted, because the assertion below reads it.
   *
   * Whitespace-collapsed on the way out so a definition broken across lines — which is how every one
   * in this chain is written — can be compared against the single-line clause it is expected to carry.
   */
  test("captures the definition a trigger was installed with", () => {
    expect(
      guardTriggerStatements(
        "CREATE TRIGGER audit_events_append_only\nBEFORE UPDATE OR DELETE ON audit_events\nFOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();\n",
        "audit_events_append_only",
      ),
    ).toEqual([
      {
        verb: "create",
        statement:
          "CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation()",
      },
    ]);
  });

  /*
   * What the guard DOES is proved against a real database in
   * audit-retention.integration.test.ts. This asserts only that it is still installed by some
   * migration, and it reads the whole chain to do it.
   *
   * Reading 0000 alone stopped being true a while ago: 0007 replaced the function and 0012 replaced
   * it again and added the truncate trigger, so the old assertions described a definition no
   * database runs and would have gone on passing if the current one were edited out from under
   * them. A mirror test pinned to one file is a test of that file, not of the deployment.
   *
   * Reported by @beardthelion, alongside the TRUNCATE hole itself.
   */
  test("some migration still installs the append-only guard", async () => {
    const directory = new URL("../drizzle/", import.meta.url);
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const chain = (
      await Promise.all(
        files.map((name) => readFile(new URL(name, directory), "utf8")),
      )
    ).join("\n");

    /*
     * The refusal itself, which is the one thing here a whole-chain search can honestly assert.
     *
     * `CREATE OR REPLACE FUNCTION` means the function has one name and the newest definition wins, so
     * "this text is somewhere in the chain" is a weak claim about it either way — 0007 and 0012 both
     * defined it and both spellings are still in the files. It stays because losing the phrase
     * entirely would mean nothing raises, and that is worth a line.
     */
    expect(chain).toContain("Audit events are append-only");

    /*
     * A later migration removing either trigger would otherwise satisfy every line above.
     *
     * Said as "the chain ends with each trigger installed, firing on what it has to fire on" rather
     * than "the chain contains no drop", which was both too weak and too strong: it missed the house
     * style entirely, and had it not, it would have failed on 0012's own legitimate drop-and-recreate.
     *
     * THE DEFINITION IS READ FROM THE LAST INSTALL, not looked for anywhere in the chain, and that is
     * the other half of the same defect. A migration chain only grows, so `toContain` over the join
     * can never fail once a string has been written once: `expect(chain).toContain("BEFORE UPDATE OR
     * DELETE ON audit_events")` was satisfied by 0000 for good, and would have gone on passing while a
     * later migration re-created the trigger `BEFORE INSERT`. An assertion that cannot fail is not
     * weaker than the one it replaced, it is the same tautology the drop check was.
     *
     * Compared as one string per trigger so a failure says which trigger and what it ended up firing
     * on, rather than that two arrays of booleans differ.
     */
    expect(
      GUARD_TRIGGERS.map(({ trigger }) => {
        const last = guardTriggerStatements(chain, trigger).at(-1);
        if (!last || last.verb === "drop") {
          return `${trigger}: ${last ? "dropped" : "never installed"}`;
        }
        return `${trigger}: ${last.statement}`;
      }),
    ).toEqual(
      GUARD_TRIGGERS.map(
        ({ trigger, definition }) =>
          `${trigger}: CREATE TRIGGER ${trigger} ${definition} EXECUTE FUNCTION prevent_audit_event_mutation()`,
      ),
    );
  });
});

describe("admin audit API", () => {
  test("returns a filtered audit page to an administrator", async () => {
    const queries: unknown[] = [];
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      {
        list: async (query) => {
          queries.push(query);
          return {
            events: [
              {
                id: "event-1",
                eventType: "connector.sync_succeeded",
                targetType: "connector",
                targetId: "drive-1",
                actorUserId: "admin",
                payload: { itemCount: 3 },
                createdAt: "2026-08-13T12:00:00.000Z",
              },
            ],
            nextCursor: "next-page",
          };
        },
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events?eventType=connector.sync_succeeded&limit=10",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [
        {
          id: "event-1",
          eventType: "connector.sync_succeeded",
          targetType: "connector",
          targetId: "drive-1",
          actorUserId: "admin",
          payload: { itemCount: 3 },
          createdAt: "2026-08-13T12:00:00.000Z",
        },
      ],
      nextCursor: "next-page",
    });
    expect(queries).toEqual([
      { eventType: "connector.sync_succeeded", limit: 10 },
    ]);
  });

  test("denies a non-admin caller", async () => {
    const app = createApp(
      config,
      memberAuth,
      { rolesForUser: async () => ["user"] },
      { list: async () => ({ events: [] }) },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events",
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access required.",
    });
  });
});

describe("the tolerant recorder", () => {
  const recorderOver = (writes: unknown[]) =>
    createAuditRecorder(
      { insert: async (event) => void writes.push(event) },
      {
        type: "channel",
        logType: "channel_audit_failed",
        logIdKey: "channelId",
      },
    );

  test("attributes a row to whoever caused it", async () => {
    const writes: unknown[] = [];

    await recorderOver(writes)("person-1", "channel.archived", "channel-1", {
      mechanism: "explicit",
    });

    expect(writes).toEqual([
      {
        eventType: "channel.archived",
        targetType: "channel",
        targetId: "channel-1",
        actorUserId: "person-1",
        payload: { mechanism: "explicit" },
      },
    ]);
  });

  test("leaves the actor unset when there is nobody to name", async () => {
    /*
     * A callback refused before the caller proved which Bot it was has no actor, and the empty string
     * is not one either: it would be a claim about somebody called "". The field is absent, which is
     * how such a row was written before the recorder existed.
     */
    const writes: Record<string, unknown>[] = [];

    await recorderOver(writes)(null, "mcp.callback_refused", "tool-1", {
      reason: "unverified",
    });

    expect(writes).toEqual([
      {
        eventType: "mcp.callback_refused",
        targetType: "channel",
        targetId: "tool-1",
        payload: { reason: "unverified" },
      },
    ]);
    expect(Object.hasOwn(writes[0] as object, "actorUserId")).toBe(false);
  });
});

/*
 * Paging the trail against a real database, because nothing else can see the defect this covers.
 *
 * `audit_events.created_at` is a `timestamptz` defaulted from `now()`, which carries microseconds. A
 * JS `Date` does not, so a cursor minted from the decoded `Date` floored the page boundary and the
 * next page's comparison then skipped every row inside the discarded remainder. A fake store cannot
 * show that: it takes Postgres holding a stamp Postgres alone can hold, which is why the rows below
 * are inserted as SQL rather than through the store.
 */
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

/*
 * Handed back at the end, like every other file here that opens one.
 *
 * The suite runs in one process, so a pool this file opens is held for the whole run whether or not
 * this file is still using it, and the totals add up rather than take turns — `TEST_POOL`'s docblock
 * has the accounting. File-level rather than inside the describe below, because the URL tests further
 * down read through this same database after that describe has finished.
 */
afterAll(async () => {
  await database.$client.close();
});

/** Rows are found by their target, because the id is a uuid the test does not choose. */
const PAGING = "audit-paging-test";
const RANGE = "audit-range-test";

/*
 * Dated 2020 so the cleanup below is allowed to happen at all.
 *
 * The trail is append-only and the trigger refuses a delete inside the retention window, so a test
 * that wants its rows back out has to write them outside the shortest window it can declare. They are
 * literals rather than offsets from `now()` for the same reason the insert is SQL: the microseconds
 * are the whole point and they have to be exact.
 *
 * Newest first, and all but the first inside one millisecond. Under the floored cursor the boundary
 * row of page two rendered as `...500Z`, and the three rows after it were reachable from no page.
 */
const PAGED_STAMPS = [
  "2020-03-04T05:06:07.501001Z",
  "2020-03-04T05:06:07.500999Z",
  "2020-03-04T05:06:07.500003Z",
  "2020-03-04T05:06:07.500002Z",
  "2020-03-04T05:06:07.500001Z",
];

async function seedEvent(
  targetType: string,
  stamp: string,
  index: number,
): Promise<void> {
  await database.execute(
    sql`insert into ${auditEvents} (event_type, target_type, target_id, payload, created_at)
        values ('computer.action_allowed', ${targetType}, ${`${targetType}-${index}`}, '{}'::jsonb, ${stamp}::timestamptz)`,
  );
}

/** Every page, in order, until the reader says there are none left. */
async function walk(limit: number, targetType: string): Promise<string[]> {
  const reader = createAuditReader(database);
  const seen: string[] = [];
  let cursor: string | undefined;

  // A bound rather than `while (true)`: a cursor that failed to advance would otherwise hang the run
  // rather than fail it.
  for (let page = 0; page < 20; page += 1) {
    const result = await reader.list({ cursor, limit, targetType });
    seen.push(...result.events.map((event) => event.targetId ?? "(none)"));
    if (!result.nextCursor) return seen;
    cursor = result.nextCursor;
  }
  throw new Error("paging never ran out of pages over a five row window");
}

const cursorFor = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/*
 * Take the seeded rows back out, obeying the same rule as everything else.
 *
 * A plain delete is refused: the trail is append-only and the database enforces it. So the window is
 * declared the way the retention sweep declares it, which the rows above are old enough to fall
 * outside of.
 *
 * Run before the seed as well as after it, and not only out of tidiness. A run that dies between the
 * two leaves its rows behind, and the next run then pages ten where it asserts five — a failure about
 * the previous run, reported against this one.
 */
async function removeSeededEvents(): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('openbot.audit_retention_days', '1', true)`,
    );
    await tx
      .delete(auditEvents)
      .where(inArray(auditEvents.targetType, [PAGING, RANGE]));
  });
}

describe("paging the audit trail", () => {
  beforeAll(async () => {
    await removeSeededEvents();
    for (const [index, stamp] of PAGED_STAMPS.entries()) {
      await seedEvent(PAGING, stamp, index);
    }
    /*
     * The newer of the two carries microseconds, and that is the whole point of it.
     *
     * Both used to sit on a whole millisecond, which is the one case where a millisecond-precision
     * bound and the column agree exactly — so the test below asserted both ends and could only ever
     * have caught an end that was exclusive, never an end that was truncating. `.000456` is what an
     * ordinary row looks like: `created_at` defaults from `now()`, so every row written by the
     * product has a remainder, and a whole millisecond is the unrepresentative case.
     */
    await seedEvent(RANGE, "2020-05-06T07:08:09.000456Z", 0);
    await seedEvent(RANGE, "2020-05-06T07:08:08.000000Z", 1);
  });

  afterAll(removeSeededEvents);

  test("serves every row exactly once at the smallest page size", async () => {
    const expected = PAGED_STAMPS.map((_stamp, index) => `${PAGING}-${index}`);

    expect(await walk(1, PAGING)).toEqual(expected);
    expect(await walk(2, PAGING)).toEqual(expected);
    expect(await walk(5, PAGING)).toEqual(expected);
  });

  test("carries the boundary at the precision the column stores", async () => {
    const page = await createAuditReader(database).list({
      limit: 1,
      targetType: PAGING,
    });

    expect(page.nextCursor).toBeString();
    expect(
      JSON.parse(
        Buffer.from(page.nextCursor as string, "base64url").toString("utf8"),
      ),
    ).toEqual({
      createdAt: "2020-03-04T05:06:07.501001Z",
      id: expect.any(String),
    });
  });

  test("includes a row at exactly the requested bound", async () => {
    const instant = "2020-05-06T07:08:09.000Z";
    const reader = createAuditReader(database);

    // Both ends, because a filter that omits its own boundary omits it whichever end is asked for.
    const from = await reader.list({
      limit: 10,
      targetType: RANGE,
      from: instant,
    });
    expect(from.events.map((event) => event.targetId)).toEqual([`${RANGE}-0`]);

    const to = await reader.list({ limit: 10, targetType: RANGE, to: instant });
    expect(to.events.map((event) => event.targetId)).toEqual([
      `${RANGE}-0`,
      `${RANGE}-1`,
    ]);
  });

  /*
   * The bound as a reader can actually name it, rather than as a literal this file chose.
   *
   * The test above hard-codes the millisecond, which is right for pinning the rule and leaves the
   * story that produces the bug untold: nobody types `.000Z`, they copy a timestamp off the trail and
   * paste it into the other end of the filter. `createdAt` is millisecond-precision by construction —
   * `row.createdAt.toISOString()`, and a `Date` holds no more — so the value on the screen is the
   * column floored, and a floor only ever cuts downward. That is the asymmetry: it lands a `from`
   * below its own row and a `to` below it too, which includes the row at one end and drops it at the
   * other.
   *
   * Asserted through the reader's own output so it cannot drift from the format the screen is given.
   */
  test("includes the row a bound was copied from, at either end", async () => {
    const reader = createAuditReader(database);
    const page = await reader.list({ limit: 10, targetType: RANGE });
    const newest = page.events.find(
      (event) => event.targetId === `${RANGE}-0`,
    ) as { createdAt: string };

    expect(newest.createdAt).toBe("2020-05-06T07:08:09.000Z");

    for (const bound of ["from", "to"] as const) {
      const filtered = await reader.list({
        limit: 10,
        targetType: RANGE,
        [bound]: newest.createdAt,
      });
      expect(filtered.events.map((event) => event.targetId)).toContain(
        `${RANGE}-0`,
      );
    }
  });

  test("refuses a malformed cursor with a message rather than a 500", async () => {
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      createAuditReader(database),
    );

    for (const cursor of [
      "not-a-cursor",
      cursorFor({ createdAt: "2020-03-04T05:06:07.501001Z" }),
      // A number where the id belongs used to reach the comparison as one: `uuid < integer`.
      cursorFor({ createdAt: "2020-03-04T05:06:07.501001Z", id: 123 }),
      cursorFor({
        createdAt: "2020-03-04T05:06:07.501001Z",
        id: "hand-edited",
      }),
      // Right shape, no such day: `timestamptz` answers `date/time field value out of range`.
      cursorFor({
        createdAt: "2020-02-30T05:06:07.501001Z",
        id: "6f27a2a6-d449-4b0f-abb7-6cb5f48d331b",
      }),
      /*
       * A year 0, which JS has and `timestamptz` does not.
       *
       * The one on this list the round trip cannot catch: `new Date("0000-01-01T00:00:00Z")` is a
       * valid instant that renders back byte-for-byte, so this cursor used to reach the keyset
       * comparison and fail there with `date/time field value out of range` — a `DrizzleQueryError`
       * rather than the `HTTPException` a refusal mints, and therefore the bare plain-text 500 every
       * other entry here exists to prevent, through a door the other entries do not open.
       * `0001-01-01` below is the neighbour it must not be confused with.
       */
      cursorFor({
        createdAt: "0000-01-01T00:00:00.000000Z",
        id: "6f27a2a6-d449-4b0f-abb7-6cb5f48d331b",
      }),
    ]) {
      const response = await app.request(
        `http://openbot.local/api/admin/audit-events?cursor=${encodeURIComponent(cursor)}`,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "cursor must be a valid audit page cursor",
      });
    }
  });

  test("accepts the year Postgres does have, next door to the one it does not", async () => {
    /*
     * `0001-01-01` against the real database, so the refusal above is proved to be about the year
     * `timestamptz` has no room for and not about every small year. A rule that refused this one
     * would turn an in-range cursor into a 400, which is the same defect pointing the other way.
     *
     * No rows come back because every seeded row is later than AD 1, and a 200 is the whole
     * assertion: the boundary was bound, cast and compared rather than refused.
     */
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      createAuditReader(database),
    );

    const response = await app.request(
      `http://openbot.local/api/admin/audit-events?cursor=${encodeURIComponent(
        cursorFor({
          createdAt: "0001-01-01T00:00:00.000000Z",
          id: "6f27a2a6-d449-4b0f-abb7-6cb5f48d331b",
        }),
      )}&targetType=${PAGING}`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ events: [] });
  });

  test("still reads a cursor minted before the boundary carried microseconds", async () => {
    /*
     * `toISOString` wrote three fractional digits, and a link somebody has open across the deploy
     * names a real position in an ordering that has not changed. Refusing those would turn every open
     * page of the trail into an error on the way past.
     */
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      createAuditReader(database),
    );

    const response = await app.request(
      `http://openbot.local/api/admin/audit-events?cursor=${encodeURIComponent(
        cursorFor({
          createdAt: "2020-03-04T05:06:07.501Z",
          id: "6f27a2a6-d449-4b0f-abb7-6cb5f48d331b",
        }),
      )}&targetType=${PAGING}`,
    );

    expect(response.status).toBe(200);
    await expect(
      response.json() as Promise<{ events: { targetId: string }[] }>,
    ).resolves.toMatchObject({
      events: [
        { targetId: `${PAGING}-1` },
        { targetId: `${PAGING}-2` },
        { targetId: `${PAGING}-3` },
        { targetId: `${PAGING}-4` },
      ],
    });
  });
});

describe("reading an audit query off the URL", () => {
  const appWith = (list: (query: unknown) => Promise<unknown>) =>
    createApp(config, adminAuth, { rolesForUser: async () => ["admin"] }, {
      list,
    } as never);

  test("refuses a date it cannot read, naming the parameter", async () => {
    for (const [parameter, value] of [
      ["from", "yesterday"],
      ["to", "the end of last week"],
    ] as const) {
      const app = appWith(async () => ({ events: [] }));
      const response = await app.request(
        `http://openbot.local/api/admin/audit-events?${parameter}=${encodeURIComponent(value)}`,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: `${parameter} must be a date, and "${value}" is not one.`,
      });
    }
  });

  test("refuses it before the read that would throw a RangeError", async () => {
    /*
     * The same refusal against the shipped reader rather than a stub, because the stub is what makes
     * the test above cheap and also what hides the reason this matters: `from` reaches drizzle's
     * timestamp mapper, which calls `toISOString()` on an Invalid Date and throws from inside the
     * query. Nothing catches that, so it used to answer a plain-text 500 with no parameter named.
     */
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      createAuditReader(database),
    );

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events?from=yesterday",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'from must be a date, and "yesterday" is not one.',
    });
  });

  test.each([
    ["0000-01-01", "a year 0, which JS has and `timestamptz` does not"],
    [
      "-271821-04-20T00:00:00Z",
      "the earliest instant a `Date` holds, which Postgres reads as a zone",
    ],
    [
      "+010000-01-02T00:00:00Z",
      "a five-digit year, rendered back the same way",
    ],
  ])("refuses ?from=%p: %s", async (value: string) => {
    /*
     * A date `timestamptz` cannot be given, refused at the edge and named as such.
     *
     * Against the shipped reader rather than a stub, because the stub is what would hide the point: a
     * `Date` spans ISO year -271821 to AD 275760 and the column does not, so each of these parses,
     * reaches drizzle's timestamp mapper and fails inside the read — `date/time field value out of
     * range` for the year 0, `time zone displacement out of range` for the two whose `toISOString()`
     * renders an extended `±YYYYYY` year Postgres reads as a zone offset. No `onError` is registered
     * in `app.ts`, so all three used to answer Hono's plain-text 500 with no parameter named.
     *
     * A separate message from "is not one", because these ARE dates and a reader can only act on
     * being told which of the two things they got wrong.
     */
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      createAuditReader(database),
    );

    const response = await app.request(
      `http://openbot.local/api/admin/audit-events?from=${encodeURIComponent(value)}`,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: `from must name a year between 0001 and 9999, and "${value}" does not.`,
    });
  });

  test("reads an empty ?from= as absent, the way every other parameter reads", async () => {
    /*
     * A parameter that says nothing is not a parameter — `parsePageLimit`'s words for the rule the
     * rest of this surface already followed. `""` is falsy, so an empty `?cursor=` or `?eventType=`
     * always reached the read as no filter; `?from=` was the exception, because `new Date("")` is an
     * Invalid Date, so a client clearing its date filter was answered
     * `from must be a date, and "" is not one.` while clearing any other filter answered a page.
     */
    const queries: unknown[] = [];
    const app = appWith(async (query) => {
      queries.push(query);
      return { events: [] };
    });

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events?from=&to=&cursor=&eventType=&actorUserId=&targetType=&targetId=",
    );

    expect(response.status).toBe(200);
    expect(queries).toEqual([{ limit: 50 }]);
  });

  test.each([
    [",", "a bare separator"],
    [" , ", "separators and spaces"],
    [",,", "nothing between two of them"],
  ])("refuses ?eventType=%p: %s", async (value: string) => {
    /*
     * A filter request answered with the unfiltered trail is the failure this surface can least
     * afford. Each of these is non-empty and names no type, and no types is exactly how the read
     * spells "every row" — so an administrator narrowing the trail was handed all of it, with a 200
     * on it and nothing to reveal the difference. The trail's argument for existing is that it gets
     * used to rule things out.
     */
    const queries: unknown[] = [];
    const app = appWith(async (query) => {
      queries.push(query);
      return { events: [] };
    });

    const response = await app.request(
      `http://openbot.local/api/admin/audit-events?eventType=${encodeURIComponent(value)}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: `eventType must name at least one event type, and "${value}" names none.`,
    });
    // And no page was read. A refusal that still served rows would be the same unfiltered answer
    // with a status code on top of it.
    expect(queries).toEqual([]);
  });

  test("passes several event types through as it was given them", async () => {
    // The accepted side of the refusal above: a separator between two names still names two.
    const queries: unknown[] = [];
    const app = appWith(async (query) => {
      queries.push(query);
      return { events: [] };
    });

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events?eventType=channel.archived,channel.unarchived",
    );

    expect(response.status).toBe(200);
    expect(queries).toEqual([
      { limit: 50, eventType: "channel.archived,channel.unarchived" },
    ]);
  });

  /*
   * `?limit=`, on the surface `parsePageLimit` was hardest to get right on.
   *
   * `Number.parseInt` stopped at the first character it could not read and kept the digits in front
   * of it, so `?limit=1e3` meant one row on the trail whose whole argument for existing is that it
   * gets used to rule things out: a caller asking for a thousand rows was served one, with a 200 on
   * it. Nothing in this file pinned the parser after it was fixed.
   */
  test.each([
    ["1e3", "a thousand in exponent form, which parsed as 1"],
    ["0x10", "sixteen in hex, which parsed as 0"],
    ["50abc", "digits with a tail, which parsed as 50"],
    ["-5", "negative, which the clamp below would have pulled up to 1"],
    ["0", "no rows, which the clamp would have pulled up to 1"],
    ["5.5", "not a whole number"],
    ["+5", "signed"],
    [" 5", "a space where a digit goes"],
    ["lots", "not a number at all"],
  ])("refuses ?limit=%p: %s", async (value: string) => {
    const queries: unknown[] = [];
    const app = appWith(async (query) => {
      queries.push(query);
      return { events: [] };
    });

    const response = await app.request(
      `http://openbot.local/api/admin/audit-events?limit=${encodeURIComponent(value)}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Limit must be a whole number of at least 1.",
    });
    expect(queries).toEqual([]);
  });

  test.each([
    ["", 50, "absent, so the surface's own page size fires"],
    ["007", 7, "a leading zero, which is a digit and not a refusal"],
    ["10", 10, "what was asked for"],
    ["1000", 100, "capped at a hundred rather than refused"],
  ])("reads ?limit=%p as %p: %s", async (value: string, expected: number) => {
    // A value this can read is capped rather than reinterpreted: the caller gets rows it asked for
    // and a cursor saying there are more, which is a different thing from being told one row is a
    // thousand.
    const queries: unknown[] = [];
    const app = appWith(async (query) => {
      queries.push(query);
      return { events: [] };
    });

    const response = await app.request(
      `http://openbot.local/api/admin/audit-events?limit=${encodeURIComponent(value)}`,
    );

    expect(response.status).toBe(200);
    expect(queries).toEqual([{ limit: expected }]);
  });

  test("passes a date it can read straight through", async () => {
    const queries: unknown[] = [];
    const app = appWith(async (query) => {
      queries.push(query);
      return { events: [] };
    });

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events?from=2020-03-04T05:06:07.000Z&to=2020-03-05",
    );

    expect(response.status).toBe(200);
    expect(queries).toEqual([
      { limit: 50, from: "2020-03-04T05:06:07.000Z", to: "2020-03-05" },
    ]);
  });
});
