import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Database } from "./db/client";
import { auditEvents } from "./db/schema";
import { recencyCursorText } from "./roster/order";
import { parsePageLimit } from "./roster/query";

const sensitiveKeys = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "clientsecret",
  "content",
  "credential",
  "credentials",
  "document_content",
  "documentcontent",
  "encrypted_value",
  "encryptedvalue",
  "id_token",
  "idtoken",
  "password",
  "prompt",
  "refresh_token",
  "refreshtoken",
  "result",
  "secret",
  "secrets",
  "token",
  "tokens",
  "tool_arguments",
  "tool_result",
]);

export const auditEventTypes = [
  "configuration.changed",
  "credential.created",
  "credential.rotated",
  /**
   * A rotation the vault refused, and why.
   *
   * Recorded because the refusals are the interesting ones. A rotation aimed at a key other than the
   * one the credential belongs to, or at a credential already revoked, is either a caller with a bug
   * or somebody trying to retire a key they were not asked to retire, and neither left a trace while
   * only the successes were written.
   */
  "credential.rotation_refused",
  "credential.revoked",
  "connector.sync_succeeded",
  "connector.sync_failed",
  "knowledge.searched",
  /**
   * Which coworker an untagged message was routed to, and why.
   *
   * A channel is pinned to one coworker before its first turn, so when the person did not name one
   * with `@`, something chooses. This is that choice, made visible: the row names the coworker it
   * went to, whether it was an inferred match or the default it fell back to, and the coworkers it
   * chose between. The message itself is not here (the payload redaction drops it either way) — a
   * routing decision is a fact about where a conversation went, not a copy of what was said.
   */
  "channel.routed",
  /**
   * A channel was removed from every member's roster, and by whom.
   *
   * The removal is soft, so the row and its thread survive and `channels.deleted_at` records that it
   * happened. What it cannot record is who did it: a timestamp answers "when did that conversation
   * disappear" and not "who ended it for everybody in it", which is the half somebody asks about.
   * `payload.mechanism` names how, so a later hard delete is distinguishable from this one.
   */
  "channel.deleted",
  /**
   * A channel hidden from every roster, or restored — the reversible sibling of `channel.deleted`.
   *
   * Archiving is hidden, not frozen, so a channel comes back two ways: somebody restoring it, and
   * somebody saying something in it, which clears the archive on its own. Both are recorded, and
   * `payload.mechanism` is what separates them — `explicit` for the decision, `activity` for the side
   * effect — because the event type cannot. A trail showing `channel.archived` and no matching
   * restore for a channel that is live on every roster is the shape of audit bug this file argues is
   * worse than a silent one: it gets used to rule things out.
   */
  "channel.archived",
  "channel.unarchived",
  /**
   * A person's own conversation with one Bot, hidden or restored.
   *
   * Both halves of the roster archive, and a trail that records only one of them answers "where did
   * that conversation go" for a channel and shrugs at a bot chat. That is the same gap
   * `channel.deleted` exists to close, left open for half the rows on the screen.
   *
   * `payload.mechanism` carries the same two words its channel twin uses, because they are the same
   * two facts. `explicit` is somebody pressing Archive or Restore. `activity` is a restore nobody
   * performed as such: saying something in an archived conversation is how it comes back, so an
   * ordinary message clears `archived_at` and the conversation reappears. That one earns a row
   * precisely because nobody did it on purpose — it is the answer to "I archived that, why is it
   * back".
   */
  "bot_chat.archived",
  "bot_chat.unarchived",
  /**
   * A bot chat taken off its owner's roster, and when.
   *
   * The removal is soft, so the row and its thread survive and `bot_chats.deleted_at` records that it
   * happened. `channel.deleted` sets out why a timestamp on the row is not enough on its own, and the
   * argument carries over with one difference: a bot chat has exactly one interested party, so "who
   * ended it" is rarely the question and "whether it happened, and when" is. Somebody says a
   * conversation is gone; this is the row that agrees with them. `payload.mechanism` names how, so a
   * later hard delete stays distinguishable from this one.
   */
  "bot_chat.deleted",
  "agent.invoked",
  /**
   * An address this deployment declined to dial for a Bot, and why.
   *
   * The stored endpoint is re-checked on the way out of every run, and so is each address it
   * redirects to. When one of those is refused the run fails and the person sees why, which is the
   * whole of what anybody learns without this row.
   *
   * That is the wrong shape for the thing worth knowing. A registration is one person at one moment;
   * a stored agent quietly beginning to redirect somewhere it should not is a fact about an endpoint,
   * happening on every run, with nobody watching. It reads as an agent being flaky until somebody can
   * count it. The row names the address and the reason, so a reader can tell an agent that moved from
   * one aimed at the metadata endpoint.
   */
  "agent.dial_refused",
  /**
   * A Bot's stream stopped producing anything and the turn was ended for it.
   *
   * Recorded because a Bot is somebody else's infrastructure and this is the failure it has that
   * nothing else in the trail can show. Every other row here is something that happened; this one is
   * the absence of anything happening, which leaves no trace of its own.
   *
   * It is also the sort of thing nobody notices is happening repeatedly. One hung turn reads as a
   * bad afternoon and gets a shrug; the same Bot hanging twice a day for a month is a fact about an
   * endpoint, and it only becomes visible when somebody can count it. The row names the Bot, how
   * long its stream was silent, and how many chunks it managed first, so a reader can tell an
   * endpoint that dies mid-answer from one that never answers at all.
   */
  "agent.stream_stalled",
  /*
   * Which of a Bot's tools were put in front of the model for one run, and why those.
   *
   * Discovery, recorded as its own fact, because a run is now offered a subset of what the Bot holds
   * and every other row here answers a question about a call that happened. This one answers "why
   * did it call that", and its harder twin, "why did it not call anything" — a Bot that had the
   * right tool granted, was not offered it, and answered from memory leaves no other trace at all.
   * Without this row that failure is indistinguishable from a model that simply chose badly.
   *
   * DISCOVERY IS NOT PERMISSION, and the row is not an authorization record. Everything named here
   * was already granted; being offered is what changed. A tool still goes through the grant, the
   * policy and `mcp.call_succeeded` or `mcp.call_rejected` before anything happens, so this row
   * never appears in place of one of those, only before it.
   *
   * `reason` is the part worth reading. It separates a deployment that narrowed from one that never
   * declared anything and one whose selector was unreachable, which look identical from outside.
   */
  "mcp.tools_discovered",
  "mcp.call_succeeded",
  "mcp.call_rejected",
  /*
   * A call this deployment permitted and the vendor did not complete.
   *
   * The third outcome, and the one the trail was missing. `call_rejected` is this deployment
   * declining; `call_succeeded` is a vendor answering. Between them sits a call that passed every
   * check here and then failed out there — a credential the vendor would not take, an API not
   * enabled, a timeout — and without a row of its own it was invisible.
   *
   * Worse than invisible. `call_succeeded` used to be written before the network call rather than
   * after, so a call that died at the vendor left a row saying it had succeeded, and the Admin page
   * agreed. That is the one shape of audit bug worth going out of the way to avoid: a trail that is
   * confidently wrong is more dangerous than one that is silent, because it is used to rule things
   * out.
   */
  "mcp.call_failed",
  /*
   * Something presenting itself as a Bot asked to spend a grant and was turned away at the door.
   *
   * The fourth outcome, and the only one that used to leave nothing behind. The three above are all
   * written inside `callTool`, which is reached only after the caller has proved which Bot it is.
   * A caller that fails THAT check never reaches `callTool`, so a refused callback was invisible:
   * no row, no log, nothing to count.
   *
   * Which made the most confusing failure in the product completely silent. A Bot holding a stale
   * token — the deployment's secret rotated, a container not recreated with it — has every call
   * rejected at this line, returns nothing to its own model, and the model tells the person "no
   * files were found". A false negative, delivered as an answer, about a Drive that has the files.
   * Every place a person would look to check agreed that nothing had happened.
   *
   * It is a security row as much as a diagnostic one. This endpoint is how a Bot spends grants, and
   * an unauthenticated caller probing it generated no evidence at all.
   *
   * The row deliberately does NOT name a Bot or an actor. Both arrive in the credential that just
   * failed to verify, so writing them down would be recording an unproven claim in the one place
   * that is supposed to be believed. What is recorded is what is known: that a call was attempted,
   * which tool it named, and why it was refused.
   */
  "mcp.callback_refused",
  /*
   * An administrator registered this deployment's OAuth client with a vendor.
   *
   * Recorded because it decides what every subsequent consent screen belongs to. If a client is
   * replaced, every person who connects afterwards is granting access to a different registration,
   * and the row is what lets somebody reading the trail line a connection up against the client that
   * was current when it was made. The client id, never the secret.
   */
  "mcp.oauth_client_registered",
  /*
   * One person connected their own account to one server.
   *
   * Its own row rather than a credential event, because what happened is not "a secret was stored" —
   * it is a person granting a deployment continuing access to their documents, which is the kind of
   * thing they are entitled to see a record of. Carries the scope the vendor actually granted.
   */
  "mcp.account_connected",
  /*
   * One person's connector access retired, by them or on their behalf.
   *
   * The counterpart to the row above, and the one an auditor reaches for when asked "what happened to
   * their access". `reason` distinguishes somebody disconnecting their own account from an
   * administrator removing them, because those are the same effect and very different events.
   *
   * `vendorRevoked` says whether the grant at the vendor was withdrawn as well, and is currently
   * false: removing somebody stops this deployment holding a usable secret, and the grant at Google
   * outlives it until it is revoked there. Recorded rather than glossed, because a row that implied
   * otherwise would be worse than no row.
   */
  "mcp.account_disconnected",
  // Every action a Bot takes on its computer, allowed or refused. Both, always: a trail that records
  // only what was permitted cannot answer whether the Bot tried.
  "computer.action_allowed",
  "computer.action_refused",
  // Permitted by policy, attempted, and did not succeed. Its own type because "allowed" reads as
  // "happened", and a trail that cannot tell those apart misleads exactly when it matters most.
  "computer.action_failed",
  // A person taking the wheel and giving it back. Recorded as a period rather than as keystrokes: the
  // useful fact for an investigator is that a human drove this browser between these two times, and
  // logging every click a person made would bury it while telling nobody anything.
  "computer.help_requested",
  "computer.control_taken",
  "computer.control_released",
  // A credential a person entered by hand. The row records that it happened, what it was called and
  // which field it went in; the value is on a path this trail is not on.
  "computer.secret_requested",
  "computer.secret_supplied",
  // The computer itself being stopped or wiped. `reset` destroys every login the Bot had, which is
  // both the recovery path and the most consequential button on the admin page, so who pressed it and
  // when is exactly the sort of thing an investigator needs and nothing else records.
  "computer.stopped",
  "computer.reset",
  /**
   * The boundary this deployment booted with.
   *
   * The live policy is held in memory, so a restart returns to the configured default unless the
   * saved row is loaded again. This boot event records the boundary that is actually in force, so an
   * audit reader can interpret earlier policy changes against the deployment state that followed.
   *
   * Written on every boot rather than only when something was lost, because the trail cannot know
   * what the previous process had, and "the deployment restarted with this boundary" is the fact that
   * matters either way.
   */
  "computer.policy_loaded",
  /**
   * Whether this deployment gives each Bot a computer of its own, said out loud at boot.
   *
   * Without a supervisor every Bot shares one browser, which is a legitimate way to run on a laptop
   * and the opposite of what per-Bot isolation promises. The difference is invisible: the screens look
   * identical, the trail looks identical, and a Bot acting on another Bot's session looks exactly like
   * a Bot acting on its own. Nothing in the product distinguishes them, so nothing would.
   *
   * So the deployment states which one it is, once, where it cannot be argued with later. Same reason
   * as `computer.policy_loaded`: the trail records the boundary that is actually in force.
   */
  "computer.isolation_loaded",
  /**
   * The Bot declined something it was asked to do.
   *
   * Every event above records an action a Bot took, decided on by the gateway. A model that refuses
   * before calling any tool takes no action, so the gateway never sees it. This event is the audit
   * trail's record that the Bot was asked to do something and declined before acting.
   *
   * For governance, "this Bot was probed six times last week" is a question the trail answers, and a
   * refusal is the evidence of the attempt.
   *
   * Self-reported. The Bot calls this because it was told to, so a model
   * that declines and says nothing still writes nothing. It records more than zero, which is what
   * there was, and it is not a control, nothing here is enforced by it.
   */
  "bot.declined",

  /*
   * What a Bot may answer with, decided per Bot and recorded like anything else it is trusted with.
   *
   * A component is a capability you grant, so the trail has to answer the same questions a connector
   * or a skill does: who gave this Bot this, when, and who took it away again. Publishing is here for
   * the same reason, it changes what every Bot in the deployment is offered at once, which is the
   * largest single change anybody can make on this surface.
   *
   * `component.refused` records a Bot reaching for something it does not hold. Everything else is a decision somebody made
   * on purpose; this is a Bot reaching for something it does not hold. It is written by the same
   * decision point the app asks before every render, so a grant revoked mid-conversation leaves a row
   * rather than a component that quietly stops appearing.
   */
  "component.granted",
  "component.revoked",
  "component.published",
  "component.unpublished",
  "component.draft_saved",
  "component.refused",

  /*
   * A component reading real data, rather than being handed figures by a model.
   *
   * Recorded like any other tool call because that is what it is: something acting on this
   * deployment's data on a Bot's behalf. `reads` names the source in a few words, so a reader can see
   * what a component actually touched without opening it.
   *
   * `component.function_failed` is deliberately not a refusal. Nothing was forbidden, the read
   * broke, and filing a broken query as a policy event teaches a reader to distrust the policy
   * events that are real.
   */
  "component.function_granted",
  "component.function_revoked",
  "component.function_called",
  "component.function_refused",
  "component.function_failed",
  /*
   * Who may use this deployment, and at what level.
   *
   * On the trail rather than only in the table, because the table holds the current answer and this
   * is the only place that says who changed it and when. "Why does this person have admin" and "who
   * removed them" are questions a table of current state cannot answer at all.
   */
  "person.role_changed",
  "person.access_revoked",
  "person.access_restored",
  /*
   * Getting in, and being turned away.
   *
   * The trail had nothing about sign-in at all, which left two questions unanswerable. Anybody who
   * could edit `INITIAL_ADMIN_EMAILS` granted themselves the administrator role on their next
   * sign-in and no row anywhere said it had happened, because the floor is re-applied silently by
   * design. And revoking somebody deletes their sessions, which were the only record that they had
   * ever been here: after a revocation the deployment could not show that the person had signed in,
   * let alone when or how often.
   *
   * `session.refused` is the one somebody investigating actually reaches for. A revoked person still
   * holding a bookmark, or an address outside the deployment trying the front door, produces nothing
   * else anywhere.
   */
  "session.signed_in",
  "session.refused",
  "person.admin_by_configuration",
  /*
   * A company's own identity provider, added or taken away.
   *
   * Whoever holds this decides who can sign in at all, so the two ends of its life belong on the
   * trail next to the roles it hands out.
   */
  "identity_provider.registered",
  "identity_provider.removed",
  /*
   * What a Bot is and what it may reach.
   *
   * The trail recorded every mouse movement a Bot made and could not answer "who pointed this Bot at
   * that host, and when", which is the first question asked in an incident. A Bot's endpoint is
   * where conversation content is sent and its callback token is a capability handed to somebody
   * else's infrastructure, so the two ends of both belong here.
   *
   * `bot.updated` carries what changed rather than the new values: the endpoint is worth naming, and
   * a key never is.
   */
  "bot.created",
  "bot.updated",
  "bot.duplicated",
  "bot.hidden",
  "bot.unhidden",
  "bot.deleted",
  "bot.callback_token_issued",
  "bot.callback_token_revoked",
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];

export type AuditEventInput = {
  eventType: AuditEventType;
  targetType: string;
  targetId?: string;
  actorUserId?: string;
  payload: Record<string, unknown>;
};

export type AuditStore = {
  insert: (event: AuditEventInput) => Promise<void>;
};

export type AuditEvent = {
  id: string;
  actorUserId: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AuditEventQuery = {
  cursor?: string;
  limit: number;
  /**
   * One event type, or several separated by commas.
   *
   * Several, because the questions people arrive with cut across the events that answer them: "was
   * anything blocked" is a computer action refused, a component refused AND an MCP call rejected,
   * and a filter that returns only the first quietly hides two thirds of the refusals.
   */
  eventType?: string;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  /**
   * The window, inclusive at both ends: a row written at exactly this instant is on the page.
   *
   * Both were exclusive, which is not what a date filter implies and was worst where somebody is
   * most likely to reach for one: a `from` naming the instant a row was written excluded that row, so
   * a date taken off the screen and used as a bound dropped the row it was taken from.
   *
   * As precise as the string given and no more: a `to` naming a millisecond still ends before a row
   * 456 microseconds into it, because that is what asking for that instant means. `auditQueryFromUrl`
   * refuses anything it cannot read as an instant at all.
   */
  from?: string;
  to?: string;
};

export type AuditReader = {
  list: (query: AuditEventQuery) => Promise<{
    events: AuditEvent[];
    nextCursor?: string;
  }>;
};

/**
 * Where a page stopped: the boundary row's timestamp and its id, in sort order.
 *
 * `createdAt` IS NEVER A `Date`, IN EITHER DIRECTION. It is Postgres' own rendering of the boundary to
 * microseconds, carried as text and cast back to `timestamptz` in the predicate. A JS `Date` holds
 * milliseconds and `audit_events.created_at` is a `timestamptz` defaulted from `now()`, which carries
 * microseconds, so minting the cursor from the decoded `Date` floored the boundary downward. The next
 * page then asked for rows before the floor and skipped every row inside the discarded remainder:
 * served on no page at all, and because a floor only ever loses rows, with no duplicate anywhere to
 * notice it by.
 *
 * The same defect and the same fix as `roster/order.ts`, whose `recencyCursorText` this file uses
 * rather than repeating the format string — including its evidence for why `::text` and `to_char(...,
 * 'OF')` were both rejected. A hand-copied second copy of a rule like that one is what that module
 * was factored to prevent, so borrowing one function across a module boundary is the lesser of two
 * couplings.
 *
 * It matters more here than on a sidebar, for the reason `mcp.call_failed` above sets out at length:
 * this trail is used to rule things out. A missing row on the roster is a conversation somebody
 * scrolls for; a missing row here is an investigator concluding something did not happen. The trail is
 * also the largest table in the deployment, so pages past the first are the normal way it is read.
 *
 * `audit.test.ts` walks five rows written inside one millisecond. Before this, paging them one at a
 * time served two.
 */
type AuditCursor = {
  createdAt: string;
  id: string;
};

/** The boundary timestamp as the cursor carries it. See `AuditCursor`. */
const CURSOR_CREATED_AT = recencyCursorText(sql`${auditEvents.createdAt}`);

/**
 * A cursor timestamp, shaped as `recencyCursorText` writes it.
 *
 * One to six fractional digits, so a cursor minted before that function was used here is still
 * accepted: `Date.prototype.toISOString` wrote three, and a page somebody has open across the deploy
 * names a real position in an ordering that has not changed.
 */
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** The canonical rendering of a `uuid`, which is the only form this column is ever read back as. */
const CURSOR_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether Postgres will read this as a timestamp, decided here rather than by letting it try.
 *
 * The shape alone is not enough: `2026-02-30T00:00:00Z` matches it and `timestamptz` answers
 * `date/time field value out of range`. So the parsed instant is rendered back and compared against
 * the seconds it came from, which is what catches a component that rolled over into the next month.
 * `readsAsTimestamp` in `roster/order.ts` makes the same check the other way round, by rebuilding the
 * fields it read.
 *
 * The fraction is not compared, because `Date` cannot hold it; the shape above is what constrains it.
 */
function readsAsCursorTimestamp(value: string): boolean {
  if (!CURSOR_TIMESTAMP.test(value)) return false;
  const at = new Date(value);
  return (
    !Number.isNaN(at.getTime()) &&
    at.toISOString().startsWith(value.slice(0, 19))
  );
}

/**
 * A refusal an administrator can act on, rather than a 500 that says nothing.
 *
 * `app.ts` registers no `onError`, so an ordinary `Error` thrown anywhere under these routes becomes
 * Hono's default plain-text "Internal Server Error" and whatever the thrower had to say is discarded.
 * An `HTTPException` carrying its own response does not: the status is 400 and the body is the
 * `{ error }` shape every other refusal on these routes uses.
 *
 * The message is on the exception as well as in the body, so a log of the throw says the same thing
 * the caller was told, and `cause` keeps the parse error that provoked it rather than dropping it.
 */
function refuseAuditQuery(message: string, cause?: unknown): never {
  throw new HTTPException(400, {
    message,
    cause,
    res: Response.json({ error: message }, { status: 400 }),
  });
}

function normalizedKey(key: string) {
  return key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isSensitiveKey(key: string) {
  return (
    sensitiveKeys.has(key.toLowerCase()) ||
    sensitiveKeys.has(normalizedKey(key))
  );
}

export function redactAuditPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuditPayload);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : redactAuditPayload(nestedValue),
    ]),
  );
}

export async function recordAuditEvent(
  store: AuditStore,
  event: AuditEventInput,
) {
  await store.insert({
    ...event,
    payload: redactAuditPayload(event.payload) as Record<string, unknown>,
  });
}

/**
 * A tolerant writer of one row, for a route that has already done the thing.
 *
 * WHY THIS IS NOT INLINE IN EACH ROUTE FILE. It was, twice, and both copies carried a comment saying
 * they mirrored each other down to the reasoning — which is an accurate description of two things
 * that drift the first time somebody changes one. The attribution argument below is the part that
 * would drift silently: it is a decision about which rows are worth attributing, not a detail of
 * either surface.
 *
 * NEVER FATAL. Every caller reaches this after its store call has resolved, so the archive, restore
 * or removal has already happened and the caller has already been told so. A trail that is briefly
 * unavailable is not a reason to report a failure that did not occur. It is said out loud instead, as
 * one structured line, because nothing else can tell.
 *
 * ACTS, NOT ATTEMPTS. Reaching this at all is the caller's guarantee: a refused change writes
 * nothing, and neither does a repeat, which is why the stores answer whether they changed anything.
 *
 * ATTRIBUTED, INCLUDING IN SINGLE-USER MODE. Other audited surfaces drop the actor id when it is the
 * local development one, on the grounds that `audit_events.actor_user_id` has a foreign key into
 * `users` that it would violate. It has no foreign key, and `initializeDevActorUser` writes that row
 * at start-up anyway, so neither half of that reason holds. It matters here more than most:
 * single-user is the mode `.env.example` ships switched on, so an unattributed row is what a fork
 * sees by default, and "somebody put this conversation away" is the whole point of the row.
 *
 * `record` in agents/routes.ts is deliberately NOT folded in here: it drops the development actor,
 * so folding it would change what it writes rather than where the code lives.
 *
 * NULL IS FOR A WRITE WITH NOBODY TO NAME, and it is not the same as the development actor above. A
 * callback refused before the caller proved which Bot it was has no actor to record: the Bot id and
 * the actor both arrive in the credential that just failed to verify, so writing either down would
 * put an unproven claim in the one place that is supposed to be believed. A null leaves the column
 * unset, which is the shape such a row already had; an empty string would be a claim about somebody
 * called "".
 */
export function createAuditRecorder(
  auditStore: AuditStore | undefined,
  target: {
    /** `audit_events.target_type` for every row this writes. */
    type: string;
    /** The `type` of the structured line logged when a write fails. */
    logType: string;
    /** What the failed-write line calls the id, kept per-surface so the logs read as they always did. */
    logIdKey: string;
  },
) {
  return async (
    actorUserId: string | null,
    eventType: AuditEventType,
    targetId: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (!auditStore) return;
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: target.type,
        targetId,
        // Omitted rather than sent as null, so a row with no actor is written exactly as a caller
        // that never mentioned one would have written it.
        ...(actorUserId === null ? {} : { actorUserId }),
        payload,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: target.logType,
          eventType,
          [target.logIdKey]: targetId,
          error: String(error),
        }),
      );
    }
  };
}

export function createAuditStore(database: Database): AuditStore {
  return {
    insert: async (event) => {
      await database.insert(auditEvents).values(event);
    },
  };
}

function encodeCursor(cursor: AuditCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * A malformed cursor is refused, where the roster degrades one to its first page.
 *
 * `decodeRosterCursor` answers `undefined` and serves page one on purpose, and its reasoning is right
 * for a sidebar: a link somebody has open across a deploy names a position in an ordering that
 * changed, and the honest answer to a stale link is the top of a list they can see for themselves.
 *
 * The trail is the other case. Page one in place of the page that was asked for is a screen of rows
 * with nothing on it to say they are not the rows after the boundary, and this trail's value is that
 * it gets used to rule things out. A reader who cannot tell "the newest rows" from "the rows after
 * yours" cannot rule anything out, so the refusal is said out loud instead.
 *
 * The rest of the roster's reasoning does not reach here either. That cursor goes stale because part
 * of its sort key was added after it was minted; this one's two fields are unchanged, and the
 * millisecond form `toISOString` used to mint is still accepted, so a deploy does not make one
 * malformed. One that is malformed was truncated in transit or edited by hand.
 *
 * `id` IS CHECKED FOR BEING A UUID, not merely for being there. It reaches Postgres as `::uuid` in the
 * keyset comparison, and the two ways a cursor can carry the wrong thing both used to arrive there:
 * `{"id":123}` was truthy enough for the old check and answered `operator does not exist: uuid <
 * integer`, and an id edited by hand answered `invalid input syntax for type uuid`. Both from inside
 * the read, and both therefore the bare 500 the rest of this docblock is about.
 */
function decodeCursor(cursor: string): AuditCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error) {
    refuseAuditQuery("cursor must be a valid audit page cursor", error);
  }

  const { createdAt, id } = (parsed ?? {}) as Partial<AuditCursor>;
  if (
    typeof id !== "string" ||
    !CURSOR_ID.test(id) ||
    typeof createdAt !== "string" ||
    !readsAsCursorTimestamp(createdAt)
  ) {
    refuseAuditQuery("cursor must be a valid audit page cursor");
  }
  return { createdAt, id };
}

export function createAuditReader(database: Database): AuditReader {
  return {
    list: async (query) => {
      const requestedTypes = (query.eventType ?? "")
        .split(",")
        .map((type) => type.trim())
        .filter(Boolean);
      const conditions = [
        requestedTypes.length === 1
          ? eq(auditEvents.eventType, requestedTypes[0] as string)
          : requestedTypes.length > 1
            ? inArray(auditEvents.eventType, requestedTypes)
            : undefined,
        query.actorUserId
          ? eq(auditEvents.actorUserId, query.actorUserId)
          : undefined,
        query.targetType
          ? eq(auditEvents.targetType, query.targetType)
          : undefined,
        query.targetId ? eq(auditEvents.targetId, query.targetId) : undefined,
        query.from
          ? gte(auditEvents.createdAt, new Date(query.from))
          : undefined,
        query.to ? lte(auditEvents.createdAt, new Date(query.to)) : undefined,
      ];
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

      if (cursor) {
        /*
         * One row comparison over the whole sort key, which reads as "everything after the cursor"
         * only because both parts of that key descend. `rosterCursorFilter` pages the roster the same
         * way.
         *
         * No new index, and none needed: `audit_events_type_time_idx` and its two siblings each carry
         * `created_at desc, id desc` after the columns they filter on, and Postgres takes the row
         * comparison as an index condition on them — `explain` on a filtered page answers `Index Only
         * Scan ... Index Cond: (event_type = ... AND ROW(created_at, id) < ROW(...))`.
         *
         * The boundary is bound as the text the cursor carries and cast here, never parsed in
         * TypeScript on the way past. That is the whole point of `AuditCursor`.
         */
        conditions.push(
          sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const rows = await database
        .select({
          id: auditEvents.id,
          actorUserId: auditEvents.actorUserId,
          eventType: auditEvents.eventType,
          targetType: auditEvents.targetType,
          targetId: auditEvents.targetId,
          payload: auditEvents.payload,
          createdAt: auditEvents.createdAt,
          // Selected alongside the decoded column rather than instead of it: the two are the same
          // instant at two precisions, and each is read by something that cannot use the other.
          cursorAt: CURSOR_CREATED_AT,
        })
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(query.limit + 1);
      const hasNextPage = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);

      return {
        /*
         * The millisecond form for the reader, the microsecond one for the cursor.
         *
         * `createdAt` is what the screen prints and what `new Date(...)` in the browser parses, and
         * nothing compares it against the column again. The cursor does exactly that, which is why it
         * is the half that cannot afford to lose the remainder.
         */
        events: page.map((row) => ({
          id: row.id,
          actorUserId: row.actorUserId,
          eventType: row.eventType,
          targetType: row.targetType,
          targetId: row.targetId,
          payload: row.payload as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor:
          hasNextPage && last
            ? encodeCursor({ id: last.id, createdAt: last.cursorAt })
            : undefined,
      };
    },
  };
}

/**
 * The query as the URL asked for it, with the two parameters that cannot be clamped refused instead.
 *
 * `limit` is clamped, because every number is either in range or nearest to one end of it. A date is
 * not: `from=yesterday` is an Invalid Date, drizzle's timestamp mapper calls `toISOString()` on it,
 * and that throws a `RangeError` from inside the read — where nothing knows which parameter was at
 * fault and, with no `onError` registered in `app.ts`, Hono answered its default plain-text 500. So
 * the refusal is made here, at the edge, where the offending parameter still has a name.
 *
 * A cursor is refused by `decodeCursor` rather than here, because that is where it is read as
 * something other than text. Both refusals go through `refuseAuditQuery`, so the trail's two ways of
 * being asked a question wrong answer in the one shape.
 */
export function auditQueryFromUrl(url: URL): AuditEventQuery {
  // The same rule the two roster reads refuse by. This surface had the prefix parse longest and is
  // the one it mattered on most: `?limit=1e3` answered one row with a 200 on the trail whose whole
  // argument for existing is that it gets used to rule things out.
  const requested = parsePageLimit(url.searchParams.get("limit"));
  if (!requested.ok) refuseAuditQuery(requested.error);
  const limit = Math.min(Math.max(requested.limit ?? 50, 1), 100);
  const optional = (name: string) => url.searchParams.get(name) ?? undefined;
  /*
   * Anything `Date` can read, which is deliberately more than one format: a bound typed by hand is
   * usually a plain `2026-08-31` and a bound copied off the screen is a full ISO instant, and both
   * are honest answers to "when". What is refused is a string that names no instant at all.
   */
  const instant = (name: string) => {
    const value = optional(name);
    if (value !== undefined && Number.isNaN(new Date(value).getTime())) {
      refuseAuditQuery(`${name} must be a date, and "${value}" is not one.`);
    }
    return value;
  };

  return {
    cursor: optional("cursor"),
    limit,
    eventType: optional("eventType"),
    actorUserId: optional("actorUserId"),
    targetType: optional("targetType"),
    targetId: optional("targetId"),
    from: instant("from"),
    to: instant("to"),
  };
}
