# Archiving channels and Bot chats

Date: 2026-08-31

## Summary

OpenBot will let a person archive a conversation so it leaves the sidebar roster without being
deleted. Archiving applies to two kinds of conversation: channels, which already exist as rows, and
direct Bot chats, which today exist only as a thread id in one browser's `localStorage`.

The roster becomes a union of both kinds behind one filter with three states — Active, Archived, All
— replacing the channels-only list the sidebar draws now. Direct Bot chats therefore gain server-side
rows, a list they appear in, and deep links, which they have never had.

Archived is hidden, not frozen. An archived conversation stays fully usable; saying something in it
lifts the archive. The only read path that treats it specially is the roster query.

## Goals

- Archive and restore a channel, for everyone in it.
- Archive and restore a direct Bot chat, which belongs to one person.
- Show both kinds in one roster, ordered by one rule, behind an Active / Archived / All filter.
- Give direct Bot chats durable rows, so `New chat` stops destroying the conversation it replaces.
- Preserve the conversation a browser already remembers, rather than orphaning it in Intelligence.
- Keep the roster's existing keyset paging, live updates, and search working unchanged.

## Non-goals

- Hard deletion. Archiving and deleting are both soft; the transcript and the Intelligence thread
  survive both.
- Per-member archiving. Archiving a channel hides it for every member, like the existing soft delete.
- Archiving Slack threads. The Slack surface in
  `2026-08-27-slack-openbot-channels-design.md` is a design, not an implementation, and has no
  `external_thread_bindings` table to hang an archive on.
- Retention or automatic archiving on an idle window.
- Replacing the packaged `CopilotChat` on the Bot screen with the app's own transcript.
- Merging the two kinds into one entity. That alternative was considered and rejected; see
  "Alternative considered".

## Decisions

These were settled before design and are recorded because the rest of the document depends on them.

| Decision | Choice | Consequence |
| --- | --- | --- |
| What "threads" means | Channels **and** direct Bot chats | Bot chats need persistence before they can be archived |
| Archive grain for channels | Per channel, on `channels` | Mirrors `deleted_at`; one member archives for everyone |
| Archived semantics | Hidden but live; saying something restores it | One read path filters; writes stay open |
| Roster shape | One list, two kinds, tri-state filter | Union query, new `/api/roster` |
| Entity model | Two tables unioned, not one merged entity | Larger change, kept because bot chats stay a distinct kind |

## User experience

### Archiving

A right-click on a roster row offers Pin, Archive, and Delete. Archive takes effect immediately and
needs no confirmation, because it is reversible and hides nothing permanently — unlike Delete, which
keeps its confirmation dialog naming the channel.

An archived row leaves the Active roster. It is still reachable by its own URL, and the conversation
in it is live: the composer works, the Bot answers, and history is intact.

### The filter

A control under the search box selects Active, Archived, or All. Active is the default and the state
a fresh session starts in. The control is always visible and always labelled, so the roster is never
in a hidden mode a person has forgotten they left it in.

`All` means active and archived together. It never includes deleted conversations.

Search composes with the filter: it narrows whichever status is selected.

### Restoring

An archived row's menu offers Restore in place of Archive. Saying something in an archived
conversation also restores it, without a separate act — the archive is a tidying gesture, not a lock.

### Direct Bot chats

The Bot screen gains what it has never had: more than one conversation. Each is a roster row, opens
at its own URL, and can be pinned, archived, or deleted like a channel.

`New chat` creates a new Bot chat and navigates to it. The conversation it replaces stays in the
roster. Today that button discards the current conversation with no way back, which is the defect
this change fixes as a side effect.

A conversation a browser already remembers is adopted on first load, so upgrading does not orphan it.

## Persistence

### `bot_chats`

A new table, in `server/src/db/schema/coworker.ts`. That file's own instruction is to add tables
there rather than editing `core.ts`, and this is a coworker-owned table.

| Column | Meaning |
| --- | --- |
| `id` | `botchat_<uuid>`, primary key |
| `user_id` | Owner. References `users`, `on delete cascade` |
| `agent_id` | The Bot. References `agents`, `on delete cascade` |
| `thread_id` | The Intelligence thread, minted by `thread-identity.ts`. Unique |
| `title` | Derived from the first message a person sends. Null until then |
| `last_message` | Preview of the last thing said, as `previewOf` produces for channels |
| `last_message_at` | When it was said |
| `last_message_agent_id` | The Bot, or null when the owner spoke. Feeds the unread marker. References `agents`, `on delete set null`, as `channels.last_message_agent_id` does |
| `pinned_at` | When the owner pinned it, or null |
| `last_read_at` | When the owner last had it open, or null |
| `archived_at` | When it was archived, or null |
| `deleted_at` | When it was deleted, or null. Soft, like a channel's |
| `created_at` / `updated_at` | |

`pinned_at` and `last_read_at` sit on the row itself, where for a channel they sit on
`channel_memberships`. That asymmetry is deliberate and is the one thing the union query has to
flatten: a bot chat has exactly one interested party, so a membership table would be a second row
per conversation that could only ever hold one member.

`thread_id` is unique because it is what adoption races on. Two tabs adopting the same remembered
thread must produce one row, and the constraint is what decides that rather than application
ordering.

`agent_id` cascades, matching `channel_agents.agent_id`. That is safe because a Bot is retired by
soft-deleting its `agent_profiles` row, not by deleting the `agents` row, so a retired Bot leaves the
conversation readable with `active` false — the same way a channel reports a deleted coworker.

Indexes:

- `unique (thread_id)`
- `(user_id, coalesce(last_message_at, created_at) desc)` — the roster's own read, per person.
  Declared in the schema rather than only in the migration, because an index that exists in the
  database and not in the schema is invisible to `drizzle-kit generate` and the next generated
  migration silently drops it. `channels_recent_activity_idx` carries the same note.

There is deliberately **no** unique constraint on `(user_id, agent_id)`. Several conversations with
one Bot is the point.

### `channels.archived_at`

One column added to `channels` in `core.ts`, alongside `deleted_at` and read the same way.

Channel grain, not membership grain, because archiving is for everyone in the channel. Per-member
hiding would be a `channel_memberships` fact and a different feature.

### Migration

One migration, `0020`, adding the table and the column. The journal timestamp must be later than
`0019` and not in the future; `server/tests/migration-journal.test.ts` enforces both, and exists
because a migration once stamped a day ahead silently swallowed every migration authored after it
while `drizzle-kit migrate` reported success.

## The roster query

A new module, `server/src/roster/query.ts`, owning the union and the cursor.

It exists as its own module so the sort rule has exactly one home. That rule is currently mirrored in
three places on purpose — `PINNED_RANK` / `RECENCY` in `channels/routes.ts`, `byRecency` in
`use-channel-events.ts`, and `pinnedFirst` in `app-sidebar.tsx` — each carrying a comment that it
must agree with the others or the list reorders itself when an event arrives. Adding a second entity
kind without a single owner for the rule would make that four.

### Shape

`UNION ALL` of two projections into one row shape:

| Field | Channel branch | Bot chat branch |
| --- | --- | --- |
| `kind` | `'channel'` | `'bot_chat'` |
| `id` | `channels.id` | `bot_chats.id` |
| `name` | `channels.name` | `coalesce(bot_chats.title, agent name)` |
| `agent_ids` | aggregated from `channel_agents` | `array[bot_chats.agent_id]` |
| `thread_id` | from `intelligence_channel_mappings` | `bot_chats.thread_id` |
| `pinned` | `channel_memberships.pinned_at is not null` | `bot_chats.pinned_at is not null` |
| `last_read_at` | `channel_memberships.last_read_at` | `bot_chats.last_read_at` |
| `archived` | `channels.archived_at is not null` | `bot_chats.archived_at is not null` |
| `active` | every linked agent profile undeleted | the agent profile is undeleted |

`last_message`, `last_message_at`, `last_message_agent_id`, and `created_at` project directly from
each side.

Ordering is the existing rule, unchanged:

```
order by pinned_rank desc, coalesce(last_message_at, created_at) desc, id desc
```

### The cursor's shape is unchanged; its encoding was not fit to reuse

`ChannelCursor` — `{pinned, recency, id}` — keeps working across both kinds, with no `kind` term,
because `id` still breaks every tie on its own. What that requires is a **total order over ids across
the two tables**: no channel id may equal a bot-chat id. If two rows shared one, they would share a
*complete* sort key and the cursor's strict `<` would exclude **both** — silent row loss, the same
failure mode as the encoding defect below.

This is worth stating because everything downstream spends that order: the cursor's encode, decode,
stale-cursor rule, and the "a cursor that names a different ordering reads as the first page"
behaviour all survive untouched.

**Amended after review: this section claimed the order as luck, and for package channels the claim
was not even true.** What it said was that ids are prefixed (`channel_…`, `botchat_…`) and therefore
globally unique, and it called that the single piece of luck in the design. Every *generated* id is
prefixed — `channel_<uuid>` in `channels/routes.ts`, `botchat_<uuid>` in `bot-chats/store.ts` — but a
package channel's id comes out of `channels.yaml` verbatim, validated as a non-empty string and
nothing more, which is how the shipped fintech package gets `general-assistant`,
`risk-and-compliance` and `company-knowledge`. Nothing stopped a package writing `botchat_<uuid>` as
a channel id, and package channels are the rows *most* exposed to the id tie-break in the first
place, because a sync inserts them in one transaction with byte-identical `created_at`.

The premise is now enforced rather than hoped for. `validateTenantPackage` refuses a package agent or
channel id beginning with `agent_`, `botchat_` or `channel_`, in a message naming the file and the id,
and there are exactly two channel insert paths — the package's and `channels/routes.ts`'s. So every
channel id is either generated under `channel_` or proven to sit in no generated namespace at all,
every bot-chat id is generated under `botchat_`, and the two sets cannot meet. Read the prefix as
evidence of the total order, not as the thing being relied on: the requirement is the order, and any
future id a person gets to choose has to be checked against it the same way.

**Amended after review, and this section is why the defect was missed.** The *shape* survived
untouched, and this section said so approvingly enough that nobody looked inside the encoding. The
encoding was broken before this work and reusing it verbatim routed the whole roster through it: the
recency term was minted with `new Date(row.recency).toISOString()`, which is milliseconds, while
`timestamptz` stores microseconds and `COALESCE` falls back to `created_at` — defaulted from `now()`
— for every conversation nobody has spoken in yet. The cursor therefore always named an instant
strictly below the row it was built from, and every row inside the discarded window was served on no
page at all. Two reviewers reproduced it independently; `tenant-package.ts` creates every package
channel inside one transaction, so a package with more channels than a page lost the remainder from
the sidebar permanently.

The cursor value never becomes a `Date` now. Phase 1 projects it as text at microsecond precision
with an explicit UTC `Z`, and the `timestamptz` column is deliberately kept out of the outer select
so there is nothing to reach for. `to_char`'s `OF` was tried and rejected on evidence: it renders
LMT-era sub-minute offsets lossily. `decodeRosterCursor` also validated `typeof` only, so a recency
of `"lol"` reached Postgres and raised a bare 500 against the contract two docblocks state; it now
round-trips the value's date fields, because `Date.parse` accepts `2026-02-30` and Postgres does not.

The general lesson, recorded because this design made the mistake twice: "unchanged" is a claim about
a boundary, not a warrant that what is on the far side of it is correct. Reusing a codec is inheriting
it.

### Status filter

`status` is one of `active` (default), `archived`, `all`.

- `active` — `archived_at is null`
- `archived` — `archived_at is not null`
- `all` — no archive term

`deleted_at is null` applies to all three. **`all` is a filter over archive state only, never a way
to see deleted conversations.**

An unrecognised `status` reads as `active`. That follows the local convention set by
`decodeChannelCursor`, where a malformed value reads as the first page because that is the honest
answer to a stale link, rather than a 400 that a person cannot act on.

### Two phases, and the union sits in the first

`channels.list` is already two-phase, and this is the structural fact the whole query rests on
(`channels/routes.ts:305-435`):

1. **Choose the page.** A narrow select — `(id, recency, pinned)` — carrying the cursor, the order,
   and `limit + 1`. One row per channel. Its own comment explains why: the hydrated row set is one
   row per channel-agent pair, so a limit applied there "would cut a channel in half: its second Bot
   would arrive on the next page as a separate entry with the same id."
2. **Hydrate.** Join the chosen ids to agents and mappings, then fold one-row-per-pair into
   summaries in TypeScript.

The union belongs in phase 1 only, where both branches project the same four narrow columns —
`(kind, id, recency, pinned)` — with no arrays and no aggregates:

```
select 'channel' as kind, channels.id, <recency>, <pinned> from channels ⋈ memberships(actor)
union all
select 'bot_chat' as kind, bot_chats.id, <recency>, <pinned> from bot_chats where user_id = actor
order by pinned desc, recency desc, id desc
limit n + 1
```

Phase 2 stays two separate hydrations, one per kind, each shaped exactly like the query it replaces.
Their results are then interleaved back into the order phase 1 returned, which is the only ordering
authority in the module.

This removes the risk that a straight `unionAll` over two fully-hydrated, differently-shaped selects
would have carried.

**What it actually took, once built.** Ordering the union directly does not run. Postgres lets a set
operation's `ORDER BY` name only the union's *output* columns, and drizzle-orm 0.45.2 rewrites a bare
column handed to a set operator's `orderBy` into an unqualified identifier but not one nested inside
an expression — and `rosterOrder` nests all three parts of the key. The attempt fails with an
invalid-FROM-clause reference.

The resolution is a derived table: wrap the union as `.as("roster")` and select from it, which makes
the four aliased output columns nameable so `rosterOrder` applies unchanged. The sort rule is still
expressed exactly once, in phase 1, and TypeScript never merges anything. This is better than the raw
`sql` fallback this section originally reached for, and it is what shipped.

One drizzle hazard found alongside it, worth knowing before touching this file: **`unionAll` mutates
its left argument**, pushing onto `config.setOperators`. A branch builder must never be reused; both
branches are built fresh per call.

The `RECENCY` and `PINNED_RANK` fragments move here from `channels/routes.ts`, and the channels list
route imports them back. That keeps one definition rather than two that must agree.

## Routes

### Channels

```
PUT /api/channels/:channelId/archive   {archived: boolean} -> {archived}
```

Shaped after the existing pin route, which takes `{pinned}` and answers `{pinned}`.

`ChannelStore` gains `setArchived(actor, channelId, archived)`:

- Member required. A non-member, an unknown channel, and a deleted channel all answer the same way,
  matching `setPinned`, `markRead`, `get`, and `recordActivity`, so belonging to a channel is not
  something an outsider can probe for.
- A channel the deployment package defines is refused with 409, as deletion already is. Archiving is
  channel grain, so one member archiving a package channel hides configuration from everyone with
  nothing to put it back — no package sync writes `archived_at`. That is a deletion of configuration
  wearing a reversible name.
- `ChannelPackageOwnedError` must carry the act refused. Its message currently hardcodes "deleted",
  and a 409 that says the wrong verb is worse than no message.
- Idempotent by guarding on the column: archiving guards `archived_at is null`, restoring guards
  `archived_at is not null`, so a repeated call is a no-op rather than a fresh stamp. This mirrors
  `softDelete`, where the same guard is what makes a repeat call a no-op.
- Announced inside the transaction to every member, so it is delivered on commit and a refused
  archive announces nothing.
- Audited as `channel.archived` and `channel.unarchived`, through the same tolerant writer
  `recordDeleted` uses: never fatal, because the channel is already archived and the caller already
  told, by the time the trail is written.

### Bot chats

A new module, `server/src/bot-chats/`, mirroring the shape of `channels/`.

```
POST   /api/bot-chats               {agentId}            -> row
POST   /api/bot-chats/adopt         {agentId, threadId}  -> row
GET    /api/bot-chats/:id                                -> row (agentId, threadId, title, active, archived)
POST   /api/bot-chats/:id/activity  {text, agentId, at}  -> 204
PUT    /api/bot-chats/:id/pin       {pinned}             -> {pinned}
PUT    /api/bot-chats/:id/read                           -> 204
PUT    /api/bot-chats/:id/archive   {archived}           -> {archived}
DELETE /api/bot-chats/:id                                -> 204
```

Every route is scoped to `user_id = actor.id`. A row belonging to somebody else answers **404, not
403**, for the reason the channels module already gives: the same answer every way means ownership
is not probeable.

`POST /` mints the thread through `ThreadIdentity.mint()` and validates the agent is visible to the
caller on the same transaction, via `profileStore.getWithin` — the way `channels.create` does, so an
agent cannot be deleted between passing the check and being linked.

`POST /activity` carries `agentId: string | null` rather than a boolean, matching
`parseActivityInput` for channels, so the union projects one field. A non-null `agentId` must equal
the row's own `agent_id`. Like the channel path, `at` comes from the client that saw the message and
is never trusted as a clock: the store only ever moves `last_message_at` forwards, so a wrong
timestamp loses a report rather than corrupting the row.

`previewOf` and the page-size constants `DEFAULT_CHANNEL_PAGE` / `MAX_CHANNEL_PAGE` are currently
private to `channels/routes.ts`. Both the bot chat store and the roster query need them, so they move
to a shared module rather than being copied — a second `previewOf` that strips control characters
slightly differently is a preview that renders differently depending on which kind of row it is.

`title` is derived from the first message whose `agentId` is null — the first thing the person said —
and only when `title` is still null. A Bot's opening message does not name the conversation.

### Adoption

`POST /adopt` exists for one release-crossing case: a browser holding a thread id in `localStorage`
from before this feature.

- `threadId` must match the plausible-thread-id shape `thread-routes.ts` already applies, so an
  arbitrary string cannot become a thread id.
- If `thread_id` is unknown, insert and return the row.
- If it is known and owned by the caller, return the existing row. Adoption is idempotent.
- If it is known and owned by somebody else, refuse with 409.
- The unique constraint on `thread_id` decides races. The loser catches the violation and re-reads
  the winner rather than overwriting it.

The client calls it only when `checkKnown` has confirmed Intelligence still has the thread. Adopting
a forgotten thread would manufacture a row with no history behind it, which is the exact failure
`bot-thread.ts` already exists to prevent.

### Roster

```
GET /api/roster?status=active|archived|all&cursor=&limit= -> {items, nextCursor}
```

`GET /api/channels` stays as it is. It is still the channels list, and narrowing the sidebar's read
is not a reason to remove it.

## Live updates

`ChannelActivityEvent` is keyed on `channelId`. A bot chat needs the same events with a different
id, so the payload gains `kind` and `id`.

### Two releases, not one

The change is additive for one release. New replicas emit `kind` and `id` **alongside** the existing
`channelId`, and the `channel_activity` topic name does not change.

A rolling deploy is why. Mid-deploy, new replicas `NOTIFY` while old replicas still `LISTEN` and
parse `channelId`, so a straight rename would have old replicas delivering malformed events to every
client they hold, and a renamed topic would drop events entirely for the length of the rollout. This
repo already reasons this way: `accounts.issuer` ships nullable for exactly this reason, even though
every write fills it.

`channelId` is removed in a later release, once no replica predates the column. That is a stated
follow-up, not an implicit one.

### Delivery

A bot chat's event carries `memberIds: [ownerId]`. The hub's existing delivery rule needs no change —
it already fans out by an explicit id list, which is what carries a pin across one person's own tabs
without putting it on anybody else's roster.

An archive or restore carries `archived: boolean`, the way a pin carries `pinned`.

### Client patching

`applyChannelEvent` finds rows by `id` alone, which still works because of the same total order over
ids the cursor needs: a channel id and a bot-chat id can never be equal, which for a package channel
is enforced by `validateTenantPackage` rather than assumed. `kind` is needed only for rendering.

`hasUnseenActivity` and `isUnread` in `app-sidebar.tsx` need no change either. Both read
`last_message_agent_id`, `last_message_at`, and `last_read_at`, which both branches of the union
project, so the unread dot means the same thing on both kinds of row.

The one new rule: **archive and restore invalidate the roster lists; ordinary activity still
patches.** Three filter states mean three cached infinite queries, and an archive moves a row between
them. That is a page-membership change, which is already the case the function answers with
`"unknown"` and the caller answers with a refetch. Patching a row across lists is how a row ends up
in two of them at once.

## Client structure

Following `openbot-data-access`: every read is a `queryOptions` factory, every write a
`mutationOptions` factory, everything through `client`.

```
app/src/lib/roster/queries.ts      RosterItem, rosterListQueryOptions(status)
app/src/lib/bot-chats/queries.ts   botChatQueryOptions(id)
app/src/lib/bot-chats/mutations.ts create, adopt, pin, read, archive, delete, activity
app/src/lib/channels/mutations.ts  + setChannelArchivedMutationOptions
```

The roster query key carries the status: `["roster", "list", status]`.

### Sidebar

`app/src/components/app-sidebar/channel.tsx` becomes `roster-row.tsx`, branching on `kind` for its
link target and its menu. The row's markup, its memoization, and its `content-visibility` treatment
are unchanged — the reasons those exist have not changed.

The menu gains Archive and Restore. Archive needs no confirmation dialog; Delete keeps the one it
has, which names the channel because the row it was invoked on is one of several identical-looking
rows.

Empty states go from two to four, and saying the wrong one is the failure mode the existing comment
already warns about ("told 'you don't have channels yet' while holding a typo, a person reads their
conversations as gone"):

- nothing at all, in Active
- nothing matches the search, in any status
- nothing archived, in Archived
- nothing at all, in All

### The Bot screen

`/bot/$botChatId` becomes canonical and renders one Bot chat.

`/bot?agent=x` survives as a resolver: it finds the caller's most recent non-archived chat for that
Bot, creates one if there is none, and redirects. That keeps existing links, the `?agent=` search
param, and the current "first Bot this deployment has" default working.

`useBotThread` keeps `checkKnown` and `threadToUse`, whose decision logic is still exactly right, and
loses its storage role. Once per Bot, a remembered `localStorage` id that `checkKnown` confirms is
adopted, and the key is then cleared.

The guards on that screen stay: a named Bot this deployment does not have is still answered in a
sentence rather than thrown, because a mistyped link is not a crash.

## Failure handling

| Case | Answer |
| --- | --- |
| Archive a channel you are not in | 404 |
| Archive a deleted channel | 404 |
| Archive a package-owned channel | 409, naming archiving |
| Archive an already-archived channel | 200 `{archived: true}`, no restamp, no event |
| Bot chat route on somebody else's row | 404 |
| Adopt a thread another person owns | 409 |
| Adopt an implausible thread id | 400 |
| Unrecognised `status` | Reads as `active` |
| Activity on an archived conversation | Succeeds, and restores it |
| Audit write fails | Logged, not fatal |

A failed archive has to be said out loud on the row, the way a failed pin already is. There is no
toast in this app, and silence reads as the app ignoring the click.

## Testing

Unit where the logic is pure, `.integration.test.ts` where it needs Postgres, matching the existing
split in `server/tests`.

### Unit tests

- `channel-archive` — idempotent restamping, package refusal with the right verb, deleted refusal,
  event emitted with `archived`, audit row written, activity restores
- `bot-chat-routes` — ownership 404s, adopt idempotence, adopt cross-owner 409, implausible thread id
  400, title derived from the first person message and not from the Bot's
- `roster-status` — the three statuses' predicates, deleted excluded from all three, unrecognised
  status reads as active
- `roster-event-patch` — extends `channel-event-patch`: `kind` handling, and archive invalidating
  rather than patching
- `bot-thread` — extends the existing file: `threadToUse` unchanged, adopt-once, key cleared

### Integration tests

- `roster-union.integration` — ordering across both kinds, a cursor paging through a mixed list,
  pinned rows first regardless of recency, the status filter, deleted excluded
- `channel-archive.integration` — the event reaching every member through `pg_notify`
- `bot-chat-store.integration` — the `thread_id` unique constraint deciding two concurrent adoptions

### Existing tests to extend

- `schema.test.ts`, if it enumerates tables
- `migration-journal.test.ts` covers the new migration's stamp with no change

## Delivery sequence

1. Migration `0020`: `bot_chats`, `channels.archived_at`, indexes.
2. `channels.setArchived`, its route, audit events, and the additive event field.
3. `bot-chats` store and routes.
4. `roster/query.ts` and `GET /api/roster`, as a two-phase read whose phase 1 is the union.
5. Client: roster queries, bot chat queries and mutations, channel archive mutation.
6. Sidebar: `roster-row.tsx`, the tri-state filter, the four empty states.
7. Bot screen: `/bot/$botChatId`, the `?agent=` resolver, adoption on first load.
8. Remove `channelId` from the event payload — **a later release**, not this one.

Steps 2, 3, and 4 are independently testable and land in that order because 4 reads what 2 and 3
write.

## Alternative considered

**Direct Bot chats become channels.** A channel with one agent and one member already is a direct Bot
chat: the same minted thread namespace, and `channel-chat.tsx:186` already calls
`useActiveBot(runtimeAgentId)` exactly as `bot.tsx:58` does, so the computer tools route identically.
Under that model there is no second table, no union, no second sort key, and no event change at all;
archiving is one column and the unification is free.

It was rejected in favour of keeping bot chats a distinct kind — they are never shareable, never
multi-member, and keep the packaged `CopilotChat` rather than the app's own transcript. The cost of
that choice is this document: a union query, a second set of routes, two archive columns that have to
keep meaning the same thing, and a two-release event migration.

It remains available later. Collapsing the two kinds would delete `roster/query.ts` and the
`bot-chats` module rather than add to them.

## Future extensions

- Remove `channelId` from the roster event payload.
- Per-member archiving, if hiding a shared channel for one person is ever wanted. It would be an
  `archived_at` on `channel_memberships` and would enter the cursor's sort key, which the channel
  grain chosen here deliberately avoids.
- Automatic archiving on an idle window, which `work_items` already has the machinery for.
- Archiving Slack threads, once that surface exists.
