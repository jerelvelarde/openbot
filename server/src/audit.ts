import { type SQL, and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Database } from "./db/client";
import { auditEvents } from "./db/schema";
import { recencyCursorText, withinTimestamptzRange } from "./roster/order";
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
   *
   * Absent means every type. A value that is present and names no type at all does not:
   * `auditQueryFromUrl` refuses it rather than let a narrowing request answer with the whole trail.
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
   * SWAPPING THE COMPARATOR FIXED ONLY THE LOWER END, and the reason is the precision the two ends
   * are read at. A bound is a string, so it becomes a `Date`, so it carries milliseconds;
   * `created_at` defaults from `now()` and carries microseconds. Flooring a boundary to the
   * millisecond moves it downward, which is inside the window at the bottom and outside it at the
   * top — so `gte` kept the row it named and `lte` went on dropping it, on the same screen, from the
   * same pasted timestamp. It is the same defect this docblock was written about, surviving in the
   * half the fix did not touch.
   *
   * SO A MILLISECOND MEANS THE WHOLE MILLISECOND at the top end: `to` ends after the last microsecond
   * of the millisecond it names. That is what the value means to whoever typed it, because a
   * millisecond is the finest thing anything outside the read can say — `createdAt` on the wire is
   * `toISOString()`, and the screen prints what it is given. `interval '1 millisecond'` in SQL was
   * rejected: it would have Postgres parse the bound, and a zone-less bound is read in whatever zone
   * the session is set to rather than the one `new Date` uses, which is a live question on this
   * parser and not one to answer accidentally here.
   *
   * Both ends therefore round outward, and that is the direction to err on a trail whose argument for
   * existing is that it gets read to rule things out: a window slightly wider than asked for shows a
   * row somebody has to dismiss, and a window narrower than asked for is a row they conclude does not
   * exist. `auditQueryFromUrl` refuses anything it cannot read as an instant at all, and anything
   * naming a year outside the range `timestamptz` can be given.
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
 *
 * THE YEAR IS ASKED OF `withinTimestamptzRange`, not of the round trip, which cannot see it: JS has a
 * year 0, so `0000-01-01T00:00:00Z` parses, renders back byte-for-byte and satisfies every line
 * below, while `select '0000-01-01T00:00:00Z'::timestamptz` is out of range. Such a cursor therefore
 * reached the keyset comparison and failed inside the read as a `DrizzleQueryError` rather than as the
 * `HTTPException` `refuseAuditQuery` mints — a third door into the bare 500 `decodeCursor` exists to
 * shut. `readsAsTimestamp` in `roster/order.ts` calls the same function for the same reason; this
 * check once carried its own copy of that rule and lost it, which is why the rule now has one home.
 *
 * The fraction is not compared, because `Date` cannot hold it; the shape above is what constrains it.
 */
function readsAsCursorTimestamp(value: string): boolean {
  if (!CURSOR_TIMESTAMP.test(value)) return false;
  const at = new Date(value);
  return (
    withinTimestamptzRange(at) &&
    at.toISOString().startsWith(value.slice(0, 19))
  );
}

/**
 * The `to` bound as the column has to be asked about it: the last microsecond of the millisecond named.
 *
 * `AuditEventQuery.to` has the argument for why the whole millisecond is what the value means. This is
 * the mechanics, and they are deliberately the cursor's mechanics: the boundary is rendered to
 * microseconds as text and cast in the predicate, exactly as `AuditCursor` describes, rather than
 * handed to drizzle's timestamp mapper as a `Date` that cannot hold the digits being asked about.
 *
 * `new Date(...)` still does the parsing, because that is what accepts the several shapes a bound
 * arrives in — a plain `2026-08-31` and a full ISO instant are both honest answers to "when" and
 * `auditQueryFromUrl` says so. What changes is only how the parsed instant is spelled on the way to
 * Postgres.
 *
 * `.999` RATHER THAN A MILLISECOND ADDED TO THE `Date`. Adding one would push a `to` of
 * `9999-12-31T23:59:59.999Z` — a year `auditQueryFromUrl` accepts — into year 10000, where
 * `toISOString` switches to the `±YYYYYY` form Postgres reads as a zone displacement and fails on
 * from inside the read. Widening the fraction cannot leave the second it started in.
 *
 * An unparseable `to` throws here, from `toISOString`, as it previously threw from drizzle's mapper on
 * the same value: `auditQueryFromUrl` is where that is refused with the parameter's name on it, and a
 * caller reaching `list` directly with an Invalid Date is as wrong as it was before.
 */
function inclusiveUpperBound(to: string): SQL {
  const millisecond = new Date(to).toISOString();
  return sql`${auditEvents.createdAt} <= ${`${millisecond.slice(0, -1)}999Z`}::timestamptz`;
}

/**
 * A refusal an administrator can act on, rather than a 500 that says nothing.
 *
 * `app.ts` registers an `onError` now, so an ordinary `Error` thrown anywhere under these routes no
 * longer reaches Hono's plain-text default — but that handler answers one generic sentence for every
 * failure it sees, so whatever the thrower had to say is still discarded. An `HTTPException` carrying
 * its own response is what survives it: the app-level handler delegates to `getResponse()`, so the
 * status is 400 and the body is the `{ error }` shape every other refusal on these routes uses.
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

/**
 * The event types an `eventType` parameter names, in the order it named them.
 *
 * ONE HOME FOR THE SPLIT, because the two places that need it disagreeing is the defect itself:
 * `auditQueryFromUrl` refuses a value that names nothing and `createAuditReader` builds the filter
 * from what it names, so a separator one treated as a name and the other did not would refuse a
 * filter at the edge and drop it in the read, or the reverse.
 */
function requestedEventTypes(eventType: string | undefined): string[] {
  return (eventType ?? "")
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);
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

/**
 * The four shapes whose whole state lives somewhere other than their own enumerable keys.
 *
 * `Object.entries` is empty for every one of them, so the entries pass rebuilt each as `{}` and the
 * row recorded that a field had been there and nothing whatever about what it held. REDACTION IS NOT
 * DESTRUCTION, and the difference matters here for the reason `mcp.call_failed` gives at length: a
 * `[REDACTED]` tells a reader something was withheld, and an empty object tells them the payload was
 * empty. One is a trail with a gap in it and the other is a trail that is confidently wrong, which is
 * the shape this file goes out of its way to avoid.
 *
 * Each rendering is the one JSON would have written if it could, because that is the form the column
 * is going to hold and the form the screen already knows how to print. A `Date` is its instant, which
 * is exactly what `JSON.stringify` does with one via `toJSON` — including `null` for an unreadable
 * one, where `toISOString()` throws and this function may not. A `Set` is its members written down,
 * which is an array. A `Map` is its entries, which is an object; the keys go through
 * `isSensitiveKey` like any other keys, because a Map of headers is the likeliest one to arrive and
 * `authorization` is in that set. An `Error` is what it says, `name` and `message`, plus whatever
 * provoked it — `refuseAuditQuery` keeps `cause` for the same reason, and the failed-write line in
 * `createAuditRecorder` already logs errors as `String(error)`, so name-and-message is the form this
 * module already reads them in.
 *
 * NOT THE STACK. It is the one part of an error that names paths inside the deployment, it is long
 * enough to bury the fields around it, and nothing that reads this trail asks for it.
 */
function redactStructuredValue(
  value: object,
  redact: (nested: unknown) => unknown,
): { rendered: unknown } | undefined {
  if (value instanceof Date) {
    return {
      rendered: Number.isNaN(value.getTime()) ? null : value.toISOString(),
    };
  }

  if (value instanceof Map) {
    return {
      rendered: Object.fromEntries(
        [...value.entries()].map(([key, nested]) => {
          // Stringified because a Map key need not be one, and an object column key has to be.
          const name = String(key);
          return [name, isSensitiveKey(name) ? "[REDACTED]" : redact(nested)];
        }),
      ),
    };
  }

  if (value instanceof Set) {
    return { rendered: [...value].map(redact) };
  }

  if (value instanceof Error) {
    return {
      rendered: {
        name: value.name,
        message: value.message,
        ...(value.cause === undefined ? {} : { cause: redact(value.cause) }),
      },
    };
  }

  return undefined;
}

/**
 * Anything the entries pass would have rebuilt as `{}`, described rather than erased.
 *
 * The general case behind the four above, and the reason they are four cases rather than a list that
 * grows: `Date`, `Map`, `Set` and `Error` are the ones that turn up in a payload often enough to earn
 * a rendering of their own, and the hole they were falling into belongs to every object that keeps its
 * state off its own keys. A `RegExp`, a `URL`, a `URLSearchParams` all did the same thing and none of
 * them is worth a branch, so the last resort is to say what the value was.
 *
 * ONLY WHEN THE ENTRIES PASS FOUND NOTHING, so an ordinary object is never described instead of
 * walked, and only when the prototype is not `Object.prototype` — an empty `{}` in a payload means an
 * empty object and has to stay one.
 *
 * `String(value)` is not redacted, and that is the same trade every string in a payload already makes:
 * redaction is decided by the key a value sits under, and this value's key was checked before it got
 * here. It is wrapped because a hostile or exotic `toString` may throw, and this function is the one
 * that may not — the string is a courtesy, and losing it is not worth taking a route down with it.
 */
function describeOpaqueValue(value: object): unknown {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return {};
  try {
    return String(value);
  } catch {
    return "[UNPRINTABLE]";
  }
}

/**
 * The payload as the trail may hold it: sensitive values withheld, everything else still legible.
 *
 * TOTAL AND NON-THROWING, because of where it sits. `recordAuditEvent` redacts BEFORE the store is
 * reached, so a throw here is not a failed audit write — `createAuditRecorder` catches those and says
 * so — it is an exception raised inside a route that has already archived the channel, already told
 * the caller it did, and is now only writing down that it happened. A payload is assembled from
 * whatever a caller had to hand, so "exotic input" is not a hypothetical.
 *
 * A CYCLE IS THE CASE THAT USED TO THROW. `payload.self = payload` recursed until the stack ran out,
 * and a `RangeError` from here reaches the route as an ordinary `Error`, which `app.ts` answers with
 * Hono's bare plain-text 500. The seen set is per top-level call and holds only the objects on the
 * current path — released on the way back out — so a value that legitimately appears twice in a
 * payload is still rendered twice, and only a value that contains itself is cut.
 */
export function redactAuditPayload(value: unknown): unknown {
  return redactValue(value, new Set<object>());
}

function redactValue(value: unknown, seen: Set<object>): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    const redact = (nested: unknown) => redactValue(nested, seen);

    if (Array.isArray(value)) {
      return value.map(redact);
    }

    const structured = redactStructuredValue(value, redact);
    if (structured) return structured.rendered;

    const entries = Object.entries(value);
    if (entries.length === 0) return describeOpaqueValue(value);

    return Object.fromEntries(
      entries.map(([key, nestedValue]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : redact(nestedValue),
      ]),
    );
  } finally {
    seen.delete(value);
  }
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
      const requestedTypes = requestedEventTypes(query.eventType);
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
        query.to ? inclusiveUpperBound(query.to) : undefined,
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
 * fault, so it reached the caller as Hono's default plain-text 500 and now reaches them as `app.ts`'s
 * one generic sentence, which names no parameter either. So the refusal is made here, at the edge,
 * where the offending parameter still has a name.
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
  /*
   * A PARAMETER THAT SAYS NOTHING IS NOT A PARAMETER, resolved here rather than by each reader being
   * separately falsy about emptiness.
   *
   * That is `parsePageLimit`'s rule, in its words — it applies it to `?limit=` deliberately, and the
   * filters here followed it by accident: `""` is falsy, so an empty `?cursor=`, `?eventType=`,
   * `?actorUserId=`, `?targetType=` or `?targetId=` reached the read as no filter at all. `?from=`
   * and `?to=` were the exceptions, because
   * `new Date("")` is an Invalid Date — so a client clearing its date filter, which is how a filter is
   * cleared, was answered `from must be a date, and "" is not one.` while clearing any other filter
   * on the same screen answered a page.
   */
  const optional = (name: string) => {
    const value = url.searchParams.get(name);
    return value === null || value === "" ? undefined : value;
  };
  /*
   * Anything `Date` can read, which is deliberately more than one format: a bound typed by hand is
   * usually a plain `2026-08-31` and a bound copied off the screen is a full ISO instant, and both
   * are honest answers to "when". What is refused is a string that names no instant at all, and a
   * string that names one `timestamptz` cannot be given.
   *
   * TWO REFUSALS, because they are two different things to have got wrong and a reader can only act on
   * being told which. `from=yesterday` is not a date. `from=0000-01-01` and
   * `from=-271821-04-20T00:00:00Z` are dates, and are dates this column has no room for: both parse,
   * both used to reach drizzle's timestamp mapper, and Postgres answers `date/time field value out of
   * range` for the first and `time zone displacement out of range` for the second — from inside the
   * read, where the parameter no longer has a name, so the caller is told only that the server could
   * not complete the request. `withinTimestamptzRange` carries the range and the reasoning.
   */
  const instant = (name: string) => {
    const value = optional(name);
    if (value === undefined) return undefined;
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) {
      refuseAuditQuery(`${name} must be a date, and "${value}" is not one.`);
    }
    if (!withinTimestamptzRange(at)) {
      refuseAuditQuery(
        `${name} must name a year between 0001 and 9999, and "${value}" does not.`,
      );
    }
    return value;
  };
  /*
   * A filter that names no event type is refused, not silently dropped.
   *
   * `?eventType=,` and `?eventType=%20,%20` are non-empty values that `requestedEventTypes` reduces to
   * nothing, and nothing is how the read spells "no filter" — so an administrator who asked to narrow
   * the trail was handed every row, with a 200 on it. On a surface whose whole argument is that it
   * gets used to rule things out, an unfiltered answer to a filter request is the same class of
   * failure as a wrong one. An absent or empty `?eventType=` is a different thing and still reads as
   * absent: see `optional` above.
   */
  const eventType = optional("eventType");
  if (eventType !== undefined && requestedEventTypes(eventType).length === 0) {
    refuseAuditQuery(
      `eventType must name at least one event type, and "${eventType}" names none.`,
    );
  }

  return {
    cursor: optional("cursor"),
    limit,
    eventType,
    actorUserId: optional("actorUserId"),
    targetType: optional("targetType"),
    targetId: optional("targetId"),
    from: instant("from"),
    to: instant("to"),
  };
}
