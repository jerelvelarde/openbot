# Archiving branch — review handover

Branch `jerel/channel-thread-archiving-b2f3f1`, 117 commits, nothing pushed.

**Gate:** 2361 pass / 10 skip / 0 fail across 165 files (`main` was 1871 across 158).
`bun run typecheck`, `lint`, `format:check` and `build` all clean. Tree clean. Every commit verified
as an ancestor of HEAD — see §4 for why that is a separate check from "the content is there".

Four review rounds found the defects; five fix waves landed them. **§1 and §2 of the previous version
of this document are done.** What is left is in §5, and none of it is in this PR's subject.

---

## 1. What the last wave fixed

Sixteen commits, one per subject. Every item was reproduced before the fix and had the fix reverted
alone afterwards to prove the test fails without it.

| what | commit |
|---|---|
| The archive clear rides its own statement, guarded on `archived_at` rather than on recency — so a late message no longer fails to un-archive, and one that predates the archive no longer lifts it | `59e357a` |
| The clock clamp has a floor as well as a ceiling; the first report on a conversation can no longer sink it below one with no activity at all | `59e357a` |
| An invisible message no longer blanks a row's stored preview — and drops `lastMessageAgentId` with it, because the pair is one fact | `59e357a` |
| A retired Bot you only ever direct-messaged is registered as a tombstone, so its screen keeps its banner instead of falling to the error boundary | `0a0e093` |
| `GET /api/roster` has tests that observe who it is read as; deleting `requireUser` now fails 8 | `59739f1` |
| The roster tests can tell phase 1 from phase 2; removing phase 1's ownership term now fails 21 | `671c772` |
| `MAX_ROSTER_PAGE` has a list behind it | `671c772` |
| `/api/capabilities` no longer closes sign-in when one optional read fails, and `app.ts`'s own handlers answer JSON with a log line | `f7e2b92` |
| A malformed percent-escape in the stream path no longer escapes `serve.fetch` into Bun's own HTML 500 | `f7e2b92` |
| The audit append-only guard matches trigger names, not a literal the house style walks past | `3ba3dc8` |
| The audit window ends after the millisecond it names; `redactAuditPayload` renders `Date`/`Map`/`Set`/`Error` instead of erasing them, and no longer throws on a cycle | `3ba3dc8` |
| `client()` parses inside the guard that owns its sentence, and a missing envelope key is an error rather than `undefined` cast to `T` | `aab0ec5` |
| Twelve conversation ids are encoded into request paths, via `channelPath()`/`botChatPath()` | `aab0ec5` |
| Deleting removes the detail query instead of leaving it cached for `gcTime` | `aab0ec5` |
| The needs-you dismissal is keyed on the prompt it was made about, not on a tab-local run counter | `c4b7330` |
| `byRecency` mirrors the server's whole sort key; the socket believes a connection only once it holds; teardown detaches all four handlers | `d8a25d2` |
| A package id inside a generated namespace (`agent_`, `botchat_`, `channel_`) is refused at load | `a15b13a` |
| The resync event's sentinel id is reserved, so a package cannot name a channel it | `7918e4f` |
| The roster is a real list; the unread dot and the pin are words as well as colours | `b5e92b4` |
| Every one of the nine body-taking conversation routes has a cap, through one `limitBody` helper | `1186bba` |
| The comments this branch's own fixes made false | `b33a59a` |
| An audit bound that names no zone is refused, and the timestamp shape rule has one home in `server/src/time.ts` | `933d975` |
| The cursor's format has one home too, in the same module | `5eb2ea5` |

### The premise in the design doc is now enforced, not restated
The spec called it "the single piece of luck in this design": ids are prefixed and therefore globally
unique. **Package channels are not prefixed** — `tenant-package.ts` inserted `channels.yaml`'s id
verbatim, and `examples/fintech` produces `general-assistant`, `risk-and-compliance`,
`company-knowledge`. Rather than restate the premise, `validateTenantPackage` now refuses a chosen id
inside a namespace this deployment mints, for package **agents** as well as channels. The claim was
stated in **seven** places, not the three this document previously said; all seven now say the true
thing, which is that the server keeps a total order over ids across the two tables.

That fix also closed a hole nobody had looked for: the channel upsert has no `setWhere`, unlike the
agent and skill upserts beside it, so a package id equal to a user-created `channel_<uuid>` would have
silently adopted that channel — rewriting its name, description and allowed groups.

---

## 2. Three things worth knowing about the code that came out

**The five-instance pattern from the last round did not recur.** Every brief in this wave ended with
"where else is this true?", and that question is what found: the second toothless assertion in the
audit test (a `toContain` over a migration chain that only grows, so it was permanently satisfied by
migration 0000 and could never fail again); two `tryClient` callers where envelope drift would have
read as an adoption that *worked*; five defensive `.slice()` copies where the review had named three;
and seven unbounded routes where the review had counted them but not the helper.

**Two fixes needed a restructure, not a patch.** The socket loop came out of its effect as an exported
`startRosterSocket(hooks)`, because a backoff and a teardown are facts about *when* handlers run and
nothing inside an effect closure can assert them. And `shouldRecordDismissal` became
`dismissalForClose`, returning the record rather than a boolean: the predicate was right that every
close counts, the caller stamped the wrong identity, and **neither half was wrong alone**, which is
exactly why no test of either could see it.

**One behaviour change to be aware of on review.** needs-you now polls while the pane is open. It has
to: the old gate forced `needsYou` false exactly while somebody was answering the prompt, so the first
poll after they closed the pane read the standing prompt as a fresh arrival and retired the dismissal
they had just made. The cost is a second reader of `/control` at 3s beside the screen card's 1s poll,
while the pane is open.

---

## 3. What I got wrong

The pattern from the previous round held: my write-ups were reliable about *what* was broken and
repeatedly wrong about *why*.

- **§1.5's justification was invented.** "`.catch(() => [])`, as every other optional read there does"
  — `/api/capabilities` has no other async read. And "with no `onError` registered the client cannot
  read `body.error` either" was half wrong: Hono's default handler does `console.error(err)`, so there
  was a line, just the raw error object with no method or path.
- **§1.13's audit `to=` bound was not a `gt`→`gte` omission.** An earlier commit changed both ends.
  The surviving defect was precision, and the direction matters: flooring a boundary to the
  millisecond moves it *downward*, which is inside the window at the bottom and outside it at the top.
- **§1.8's suggested fix would have reintroduced a defect.** Narrowing the rule back to "only the
  screen" restores the wave-3 bug *and* leaves the mis-keying. The *when* rule was already right.
- **§1.6 was not a two-sided fix.** `CopilotChat` calls `useAgent` itself and throws inside a `useMemo`
  during render, and the route renders it unconditionally — so the client-side guard I asked for would
  have lost the screen a beat later, banner included. It is unreachable after the server fix.
- **I overstated `pinnedFirst`.** `select` flattens with `flatMap`, so the cached pages are never
  aliased, and default structural sharing undoes an in-place sort on the next render. Latent, not live.
- **I undercounted twice** — five `.slice()` copies, not three; seven statements of the id premise, not
  three.

Two agents corrected me on their own initiative and were right both times, and one declined an
instruction of mine as out of its brief and was also right. The useful lesson is narrower than "verify
everything": claims about a slot's **own** files were reliable throughout, and claims about a
neighbour's file needed checking every time. I verified four cross-file claims myself this wave; three
held, and the fourth (a route-collision hazard) was correctly classified as pre-existing only after I
checked `main`.

---

## 4. Verified sound — do not re-review

- **Ordering, paging and the cursor.** ~70,000 differential inputs against the preview flattener; 25
  randomised paging rounds with deliberate microsecond collisions across both kinds and all three
  statuses; 40,000 candidates fuzzing the cursor validator against Postgres. Zero mismatches.
- **The microsecond class is swept.** It produced four problems on this branch (the roster cursor, the
  audit cursor, the audit `to` bound, and one test flake), so every place a `timestamptz` boundary
  passes through a JS `Date` was checked. Clean, with the reason each is safe: `archivedAt` is written
  from a JS `Date`, so that guard is milliseconds on both sides; `lastMessageAt` only ever holds a
  client-supplied millisecond stamp; `page-frames.purge` computes its cutoff in SQL; the work-queue
  cutoffs are retention sweeps; and the audit `from` bound floors *outward* on a lower bound. One real
  find, outside this PR's subject — see §5.
- **The SSO admin gate is not bypassable.** rou3 gives no match for a percent-encoded segment,
  better-call rejects a trailing-slash mismatch, and `skipTrailingSlashes` is set neither in our source
  nor by better-auth.
- **Migrations.** Snapshot chain intact, no drift, both new indexes declared so `generate` cannot drop
  them, rolling-deploy safe.
- **Two rules that had two homes now have one**, in `server/src/time.ts`: the timestamp shape a reported
  `at` and an audit bound must agree on, and the cursor format the roster and the audit trail both mint
  through `recencyCursorText`. Each is known to be load-bearing for both of its readers by mutation —
  narrowing the cursor pattern to three fractional digits fails 2 tests on the audit trail and 8 on the
  roster. `server/src/time.ts` exports classifications and predicates rather than regexps, so a third
  reader cannot arrive with the rule spelled slightly differently, which is how these came to disagree.
- **Commit reachability.** One slot's `git add` swept another's staged files; the resulting amend and
  reset left two orphaned commits and one slot's finished work uncommitted in the tree. Nothing was
  lost, and it is committed as `3ba3dc8` — but "the content is present" and "the commit is reachable"
  came apart, so all fourteen commits were checked with `git merge-base --is-ancestor`. Worth repeating
  after any wave that runs agents concurrently.

---

## 5. Follow-up PR — real, and none of it this PR's subject

Ranked. The first is a silent-data-loss bug of the same class as the one this review opened with.

1. **The People list cursor floors microseconds.** `server/src/people/store.ts` ~253 mints it as
   `new Date(last.lastSignedInAt).toISOString()` and compares it with strict `<` against
   `max(sessions.created_at)`, which is `timestamptz DEFAULT now()`. Page 2 asks for `max < floor(R)`,
   so a person whose most recent session began in the same millisecond as the boundary row but earlier
   than it is served **on no page at all**. No commits on that file, so it is pre-existing; the fix is
   the helper this branch already built — select the boundary as text at Postgres precision, as
   `recencyCursorText` does.
2. **`active` ignores profile visibility.** A Bot flipped public→private stays `active: true` for
   someone who still has history, while the runtime stops registering it and no tombstone applies —
   error boundary, and no banner, because `active` is true. `main` already has this on the channel
   path, so this branch added a second surface rather than the bug. Fix it once for both kinds.
3. **No body limit anywhere else in the server.** 28 body reads across seven files with no cap, and
   `computer/routes.ts` carries screenshot-sized payloads while checking `MAX_FRAME_BYTES` only *after*
   the parse. `limitBody` and `MAX_SMALL_BODY_BYTES` are exported and reusable; they may want a home
   less channel-specific than `channels/routes.ts`.
4. **`client()`'s parse gap and path encoding, repo-wide.** 11 sites parse outside the guard, 16
   interpolate an unencoded segment. `unwrap` and the `null` key form are exported and ready, and an
   `agentPath`/`personPath` beside `channelPath` closes the two biggest clusters.
5. **`/channel/new` shadows a package channel called `new`.** Static beats dynamic in the route tree,
   so that row navigates to the create screen. The reserved name is a filename in the app's route tree,
   so the fix is to export the reserved segments from a module beside the routes and have the server
   import it — reserving it server-side would hardcode the other half of the system.
6. **`live-screen.tsx`'s teardown detaches no handlers at all**, and its `closed` flag is only checked
   inside `onmessage`'s async decode path.
7. **A count cap on `agentIds` in `parseChannelInput`.** The 16 KiB body limit is standing in for it;
   the constant's docblock says so.
8. **The audit `eventType` filter accepts a value outside the taxonomy**, so a typo reads as "it never
   happened". Needs a decision about whether the taxonomy is closed — historical rows keep retired type
   strings — not a mechanical fix.
9. **The UUID shape has five homes** — `audit.ts`, `bot-chats/routes.ts`, `channels/thread-identity.ts`,
   `channels/thread-routes.ts`, `plugins/store.ts` — and `server/src/time.ts` is the precedent for what
   to do about it. Four of the five files are outside this PR's subject.
10. **Server collation vs client code-unit ordering.** The new `id desc` tie-break compares in JS code
   units; the server compares under Postgres collation, and package ids are arbitrary strings.
11. **A `bunfig.toml` preload registering happy-dom before module evaluation** would make motion-driven
    assertions testable and remove the `beforeAll` dance the DOM test files carry.
12. **The Base UI `nativeButton` warning** fires on every render wherever `Button` renders as `Link`
    (~14 route files). `nativeButton={false}` is not the fix — it stamps `role="button"` on the anchor.
13. Plus the eight subjects already listed before this wave: the audit query surface, server-wide error
    handling, the sidebar never paging, exposing the server-side bot-chat resolver, one uniqueness
    constraint spanning both thread columns, retiring `GET /api/channels`, index tuning
    (`channels_recent_activity_idx` has no reader and blocks HOT updates — measured 0 of 5000 HOT with
    it, 3365 without), and test-harness consolidation.

**One trap for whoever takes the roster `staleTime` idea:** `setQueryData` sets `isInvalidated: false`,
so `patchRosterRead` un-invalidates lists an archive marked stale but has not refetched. It is inert
only because `staleTime` is 0 today. Adding one turns it into a stale Archived tab.

---

## 6. Next steps

1. `copilotkit-internal:pre-push-quality`.
2. `superpowers:finishing-a-development-branch` — its commit redo also repairs the scrambled
   attribution from the build's first wave (`2d9ce1f` holds another task's files), and two message-level
   slips this wave: `aab0ec5`'s body says "eleven" where the code encodes twelve, and the audit work's
   reasoning had to be re-committed by hand after the index race in §4.
3. PR **to the fork** (`jerelvelarde/openbot`). There is no push access to `CopilotKit/openbot`, and
   nothing is pushed until you say so.
4. Spin off §5 — items 1 through 3 are worth their own PR each; the rest can travel together.
