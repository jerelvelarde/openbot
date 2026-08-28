# Slack conversations in the sidebar

## Goal

Show Slack-origin conversations in OpenBot's existing conversation sidebar so a person can discover and reopen the same read-only transcript without first returning to Slack for its deep link.

Success means a newly active Slack thread appears among native OpenBot conversations by activity time, carries a visible `Slack` chip beside the agent name, and opens `/slack/thread/:threadId` for the signed-in user who created the binding.

## Existing system

Slack delivery and transcript viewing already work. A managed Channels SDK delivery binds the provider thread to an opaque Channels thread, records provider-visible user and assistant messages in `external_thread_messages`, posts an OpenBot deep link in Slack, and serves the authenticated transcript at `/slack/thread/:threadId`.

The sidebar currently queries only `/api/channels`. External-thread routes support lookup by thread ID but have no user-scoped list, so working Slack conversations are undiscoverable from OpenBot unless the person retained the deep link.

This feature does not change Slack ingress, execution, transcript capture, identity linking, computer tools, or native channel persistence.

## User experience

The sidebar presents one interleaved roster ordered by latest activity. Native channels retain their current appearance and behavior. A Slack row shows:

- the existing agent avatar;
- the current agent name;
- a compact `Slack` chip on the title line beside the agent name;
- the latest durable transcript message as its preview;
- the latest transcript-message timestamp; and
- a link to `/slack/thread/:threadId`.

The chip uses a quiet outlined treatment consistent with existing sidebar density. It does not replace or shorten the message-preview line.

Slack rows remain read-only. They do not expose native pin or delete actions, and this feature does not invent Slack read/unread state. Selecting a Slack row opens the existing canonical transcript page.

Search matches agent name and latest-message preview for both native and Slack rows. An empty search result keeps the existing language and behavior.

## Server design

`ExternalThreadStore` gains a bounded, user-scoped list operation. It returns Slack-thread summaries ordered by activity descending, using the binding timestamp when a thread has no persisted message and otherwise the newest `external_thread_messages` sequence/timestamp. Each summary contains only sidebar-safe data:

- opaque Channels thread ID;
- provider discriminator (`slack`);
- current agent ID and name;
- latest message preview and activity timestamp; and
- binding creation timestamp.

The query filters `external_thread_bindings.created_by_user_id` to the authenticated actor before returning rows. It joins the current agent record rather than trusting a historical name. The route additionally rechecks current agent access using the same profile authorization used by transcript lookup, so a revoked coworker does not remain discoverable.

`GET /api/external-links/threads` exposes the summaries behind `requireUser`. It accepts the same bounded page-size posture as the channel roster and uses an opaque keyset cursor over activity time and thread ID. Provider tenant, conversation, thread, and user identifiers are never returned.

The endpoint response is:

```ts
type ExternalThreadPage = {
  threads: Array<{
    threadId: string;
    provider: "slack";
    agentId: string;
    agentName: string;
    lastMessage: string | null;
    lastMessageAt: string | null;
    createdAt: string;
    readOnly: true;
  }>;
  nextCursor: string | null;
};
```

The preview follows the native roster's bounded preview convention rather than returning an unbounded message body.

## Client design

The external client module gains an infinite-query option and runtime validation for the list response. The sidebar loads the native and Slack first pages independently, converts them to a small discriminated roster-row model, and performs a stable merge:

1. pinned native channels first, preserving current behavior;
2. all remaining rows by `lastMessageAt ?? createdAt`, newest first; and
3. source plus ID as a deterministic tie-breaker.

Rendering branches on `source`:

- native rows continue through the existing `Channel` component unchanged;
- Slack rows use a focused read-only row component with the approved chip and Slack route.

This boundary prevents native channel mutations or route assumptions from leaking into external rows. Existing channel socket updates continue to patch native data. Slack rows refresh on normal query invalidation/page load; live Slack roster events are outside this feature.

## Failure handling

Native and Slack roster requests fail independently. A Slack-list failure must not remove or block native conversations. The sidebar renders the native roster and an inline, accessible error explaining that Slack conversations could not be loaded, with a retry action wired to the failed query.

Malformed external summaries fail the Slack query rather than being silently dropped. Authentication and authorization failures remain fail-closed. A Slack row whose transcript becomes unavailable follows the existing transcript-page error state.

The empty-sidebar state appears only after both sources have loaded successfully and both are empty. A failed Slack request is not represented as an empty Slack roster.

## Testing

Server tests cover:

- creator ownership filtering;
- current agent-access rechecks;
- latest-message preview and activity selection;
- deterministic newest-first ordering and cursor behavior;
- bounded page sizes and malformed cursors;
- authentication and response-field minimization; and
- empty results without data leakage.

App tests cover:

- stable interleaving by activity time;
- pinned native channels remaining first;
- search across both source types;
- the title-line `Slack` chip;
- the `/slack/thread/:threadId` destination;
- absence of native mutation actions on Slack rows;
- combined empty state; and
- explicit Slack failure and retry while native rows remain available.

Implementation follows red-green-refactor: each store, route, merge, and render behavior receives a failing test before production code.

Production acceptance is one complete journey: mention `@openbot` in Slack, wait for its response, confirm that conversation appears in the OpenBot sidebar with the Slack chip, open it, and verify both messages in the read-only transcript.

## Non-goals

- Writing to Slack from the OpenBot transcript page.
- Converting external bindings into native channel rows.
- Pinning, deleting, renaming, or marking Slack threads read.
- Real-time Slack roster push events.
- Changing Channels SDK delivery or the durable transcript ledger.
