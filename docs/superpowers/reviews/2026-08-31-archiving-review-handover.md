# Archiving branch — review handover

Branch `jerel/channel-thread-archiving-b2f3f1`, 98 commits, nothing pushed.

**Gate as it stands:** 2204 pass / 10 skip / 0 fail across 160 files (`main` was 1871 across 158).
`bun run typecheck`, `lint`, `format:check` and `build` all clean.

Four review rounds ran: roughly 45, 45, 25 and — this round — 30 mandatory findings. Three fix waves
landed. Each round found real, verified defects; each wave introduced fewer than it fixed but never
zero. I stopped the loop here rather than spend a fourth wave without you, because the remaining set
is no longer small enough to call finishing.

---

## 1. Fix before this merges

Ranked by what a person actually experiences. Every one was reproduced or verified against the code
by an agent, and the ones marked ✅ I re-verified myself.

### 1.1 The archive can silently fail to lift, and can silently lift on its own ✅
`server/src/bot-chats/store.ts` ~:546-599 · `server/src/channels/routes.ts` ~:1063-1101

One root cause, two opposite symptoms: the archive clear is gated on recency against
`last_message_at` and is **never compared against `archived_at` itself**.

- A person's message *older* than the stored last message fails to un-archive. Reproduced for both
  kinds — the row stays archived, `restored` is false so no audit row and no socket event, and the
  POST answers 204. **The likeliest trigger is a slow clock**: `MAX_ACTIVITY_CLOCK_SKEW_MS` clamps
  the ceiling and has no floor, so a browser running behind whatever last wrote `last_message_at`
  has *every* report dropped and can never speak a conversation back into view.
- A person's message that *predates the archive* (sent T1, archived T2, report commits T3) **does**
  un-archive it and writes an `unarchived` row for a message sent before the archive existed.

The store's comment describes the second failure for the Bot's reply — "it is why the archive stopped
feeling like it held" — and wave 3's fix excluded only `agentId !== null`. The person's own late
report walks the identical path.

**Fix:** clear `archived_at` on its own statement, guarded on `archived_at IS NOT NULL` and on the
report being newer than `archived_at`; derive `restored` from that statement's `returning`. This is
the same shape as the title write, which was moved out from under the recency guard for exactly this
reason — the precedent is already in the file.

### 1.2 The audit append-only guard does not guard ✅
`server/tests/audit.test.ts` ~:154

Asserts the migration chain lacks `"DROP TRIGGER audit_events_append_only"`, but migration 0012
already writes drops as `DROP TRIGGER IF EXISTS … ON audit_events;`. The repo's own house style walks
past it — verified by adding a probe migration with both drops, which passed. Match the trigger
**names** with a regex instead.

### 1.3 `GET /api/roster` has no authentication or tenancy assertion ✅
`server/tests/roster-routes.test.ts` ~:66

Deleting `requireUser` from the route leaves all 19 tests green; so does passing a different actor.
The same deletion fails 2 tests on channels and 5 on bot-chats. The fake is `async list(_actor, …)`,
so no test observes who the roster is read as — on the sidebar's only read, whose entire
authorization is "the store is scoped to the actor". Both sibling fixtures already record and assert
the actor; copy them.

### 1.4 The roster tests cannot tell phase 1 from phase 2
`server/tests/roster-union.integration.test.ts` ~:463, ~:482

Removing the ownership term from **phase 1** leaves all 22 tests green, because phase 2 filters
again. A probe showed the real consequence: at `limit: 1`, a person's own page no longer contains
their own conversation — the permanent slot-burning the module header describes. Assert that no
`roster-rows-not-hydrated` line is logged during the ordinary reads, and add the positive
counterpart that `channel-routes.test.ts` already has.

### 1.5 `/api/capabilities` fails entirely when one optional read fails
`server/src/app.ts` ~:238 — `((await identityProviders?.list()) ?? []).length > 0`, no `.catch`.
That is the endpoint the sign-in screen reads to choose provider buttons, so a database blip on one
boolean means nobody can sign in — and with no `onError` registered the client cannot read
`body.error` either. `.catch(() => [])`, as every other optional read there does.

### 1.6 A retired Bot's direct chat crashes the screen
`app/src/lib/bot-chats/activity.ts` ~:261 (and `stopped-turn.ts`, which runs first)

`useAgent({ agentId })` is called unconditionally, including when `botChat.active === false`, and it
throws for an id the runtime does not hold. The server only registers "unavailable" tombstones
through **channel** membership (`selectTombstoneAgents` joins `channelAgents` ⋈ `channelMemberships`
and knows nothing about `bot_chats`), so somebody whose only history with a retired Bot is a direct
chat gets no registration — the screen falls to the error boundary, taking down the "This Bot has
been retired, the conversation stays readable" banner written for exactly that case.
**Durable fix is server-side:** give `selectTombstoneAgents` a bot-chat arm.

### 1.7 Seven of nine body-taking routes have no body limit ✅
`bodyLimit` is on the two activity routes only, and there is no app-level limit. Verified: 8 MB
bodies to `PUT /:id/archive`, `PUT /:id/pin` and `POST /` all answered 2xx. The file's own comment
calls that middleware "the only place a multi-megabyte body can be turned away before it is parsed at
all" — the argument was applied to one route in five.

### 1.8 The needs-you pane can be permanently suppressed
`app/src/routes/_authed/_app/channel/$channelId.tsx` — `shouldRecordDismissal`

Wave 3 changed the rule to `next === null && isPaneOpen`, so **any** close of the shared pane records
a dismissal — including a settings pane closed when no prompt has ever existed. Since `runEpoch` only
moves when this tab runs a computer tool, the dismissal stamps `null`, and `null !== null` suppresses
every later prompt for the life of the mount. The code it replaced only recorded a dismissal when the
*screen* was closed. The dismissal is keyed on the wrong identity: `needsYou` is server state,
`runEpoch` is tab-local.

### 1.9 `client()`'s fallback is bypassed by every caller that parses JSON itself
`app/src/lib/client.ts` ~:145, callers in `roster/queries.ts`, `channels/mutations.ts`,
`bot-chats/mutations.ts`, `bot-chats/queries.ts`

`client()` returns the raw `Response` when given no envelope key, and each caller then does
`await response.json()` outside every guard. A 200 carrying HTML — proxy error page, captive portal —
becomes a `SyntaxError` rendered as the sidebar's `role="alert"` headline:
`Unexpected token '<', "<html>"… is not valid JSON`, under "Nothing has been lost."
Related, same file: `client(path, key)` unwraps the envelope without checking the key exists, so
drift yields `undefined` typed as `T` — the resolver then reads `created.id`, throws into an empty
catch, and because the *mutation succeeded* there is no error to render. Permanently blank screen,
no console output, after a row was written.

### 1.10 `byRecency` is missing the server's third sort term
`app/src/lib/channels/use-channel-events.ts` ~:427

The server orders `[pinned desc, recency desc, id desc]`. `pinnedFirst` mirrors the first,
`byRecency` mirrors the second and returns `0` on a tie — so tied rows hold their old order until the
next refetch reorders them, which is the symptom its own docblock says it prevents. `mostRecentBotChat`
in this same branch *does* implement the tie-break. Ties are ordinary here: package channels are
inserted in one transaction, so their `created_at` is byte-identical.

### 1.11 Smaller, all verified
- Conversation ids are interpolated into request paths **unencoded** at ~12 sites. `/bot/x%3Fy` →
  `/api/bot-chats/x?y` → the server reads id `x` and answers with a **different conversation**.
  `checkKnown` already encodes; its siblings do not.
- Deleting leaves the detail query cached for `gcTime`, and delete navigates home *before* deleting —
  so Back within five minutes renders the deleted conversation with a working composer.
  `removeQueries` gets both properties the comments want.
- The audit `to=` bound still drops the row whose timestamp it names; `gt`→`gte` fixed `from` only.
- `?from=`/`?to=` accept a zone-less date-time, read in the **server process's** local zone — two
  replicas answer the same query 16 hours apart. `parseActivityInput` already refuses this shape.
- An unguarded `decodeURIComponent` at the top of `serve.fetch`, outside any try and before the
  upgrade check, so a malformed escape bypasses every error shape the server maintains.
- The reconnect backoff never engages against a socket that opens and immediately closes, and each
  `onopen` invalidates the whole roster — a full three-list refetch twice a second.
- `socket.onmessage` survives teardown while `onclose`/`onerror` are nulled, so a queued `deleted`
  frame can still navigate a screen that is gone.
- The roster is inside invalid list markup (`<ul>` → `<div>` → `<li>`, rows as bare `motion.div`), so
  the app's primary navigation exposes no list semantics, count or position to assistive tech.
- `MAX_ROSTER_PAGE` is still never exercised — three independent confirmations — and raising
  `DEFAULT_ROSTER_PAGE` from 50 to 10,000 leaves both roster test files green.

---

## 2. A premise in the design doc that is false

The spec calls it "the single piece of luck in this design": ids are prefixed (`channel_…`,
`botchat_…`) and therefore globally unique, which is what lets one cursor page a mixed list with no
`kind` term.

**Package channels are not prefixed.** `server/src/tenant-package.ts` ~:695 inserts `id: channel.id`
verbatim from `channels.yaml`, validated at ~:428 as a non-empty string and nothing more. The shipped
`examples/fintech/channels.yaml` produces `general-assistant`, `risk-and-compliance`,
`company-knowledge`. ✅ verified.

If a package id ever equalled a bot-chat id, both rows would share a complete sort key and the strict
`<` would exclude **both** — silent row loss, the same failure mode as the cursor bug this review
opened with, and package channels are the rows *most* exposed to the id tie-break because they are
inserted in one transaction with identical recency. A collision needs somebody to write
`botchat_<uuid>` as a channel id, so it is unlikely — but it is unenforced, and stated as settled fact
in three places including the spec. Either enforce the namespace where package ids are read, or
restate the premise as needing a total order over ids rather than a prefix packages do not carry.

---

## 3. What I got wrong

- **I shipped a no-op with a comment claiming it worked.** A finding said the unmounted-roster stub
  answered a bare 404 on a trailing slash. I implemented the fix *and wrote the comment*, then
  measured: identical output before and after. Reverted. Had I not measured, I would have added
  exactly the defect class this review exists to remove.
- **I filed a real test flake as "not reproducible."** Three green runs on an idle machine. It is
  load-dependent — the library's 1000 ms default timeout — and CI runs app, server and worker in one
  process, which is the worst case. "Couldn't reproduce" is not "doesn't happen."
- **I downgraded two findings out of the mandatory bucket on stories I had not checked** — "no
  motivating defect" when the defect was documented in the file above, and "unexploitable, ~74 random
  bits" when the value is returned by a GET the caller is authorised for.
- **I misrouted two coordination messages**, sending each agent the other's instructions. One caught
  it and refused; the cursor fix went unapplied for a round.
- **I framed three findings as instances instead of rules**, so each fix was applied to one of two
  places that needed it: the archive clear (§1.1), the audit `to` bound, and the body limit (§1.7).
  In every case the precedent was already in the file.
- **Two findings I recorded in earlier rounds never made it into a brief** — the page cap (§1.11) and
  the whitespace-title fallback.

---

## 4. Verified sound — do not re-review

- **Ordering, paging and the cursor.** ~70,000 differential inputs against the preview flattener; 25
  randomised paging rounds with deliberate microsecond collisions across both kinds and all three
  statuses; 40,000 candidates fuzzing the cursor validator against Postgres. Zero mismatches. The
  per-branch `LIMIT` argument, the derived-table sort, and the boolean/integer pin-rank agreement were
  each checked against generated SQL and `EXPLAIN`.
- **The SSO admin gate is not bypassable.** ✅ Two agents disagreed; I settled it: rou3 gives no match
  for a percent-encoded segment, better-call rejects a trailing-slash mismatch, and
  `skipTrailingSlashes` is set neither in our source nor by better-auth.
- **Migrations.** Snapshot chain intact, no drift, both new indexes declared so `generate` cannot drop
  them, rolling-deploy safe.
- **The replay discrimination in the activity watcher**, re-verified against `@ag-ui/client` 0.0.57.
- **`reportingRefusal`** survives query-core's observer detach, verified in the library source.

---

## 5. Follow-up PR (out of this PR's subject)

Eight coherent subjects, each with its own shape: audit query surface; server-wide error handling
(no app-level `onError` anywhere); the sidebar never paging; exposing the server-side bot-chat
resolver; one uniqueness constraint spanning both thread columns; retiring `GET /api/channels`;
index tuning (`channels_recent_activity_idx` has **no reader** and blocks HOT updates — measured
0 of 5000 HOT with it, 3365 without); and test-harness consolidation.

**One trap for whoever takes the roster `staleTime` idea:** `setQueryData` sets `isInvalidated: false`,
so `patchRosterRead` un-invalidates lists an archive marked stale but has not refetched. It is inert
only because `staleTime` is 0 today. Adding one turns it into a stale Archived tab.

---

## 6. Next steps when you pick this up

1. Fix §1 (or tell me which parts to take).
2. Deferred-findings audit, then `copilotkit-internal:pre-push-quality`.
3. `superpowers:finishing-a-development-branch` — its commit redo also repairs the scrambled
   attribution from the build's first wave (`2d9ce1f` holds another task's files).
4. PR **to the fork** (`jerelvelarde/openbot`). There is no push access to `CopilotKit/openbot`, and
   nothing is pushed until you say so.
