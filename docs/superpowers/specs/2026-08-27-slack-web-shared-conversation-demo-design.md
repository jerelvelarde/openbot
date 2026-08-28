# Slack-to-web shared conversation demo

Date: 2026-08-27
Status: approved design for the speed-focused demo

## Summary

OpenBot will expose a Slack conversation as a normal authenticated OpenBot channel after the first
linked Slack turn chooses a coworker. Slack and the OpenBot web application will use the same
CopilotKit Intelligence thread ID and the same pinned coworker; the web application will not copy a
Slack transcript into a second conversation.

For this demo, managed CopilotKit Channels remains the only Slack ingress. A narrow, server-only
Slack Web API publisher mirrors a completed web turn back into the original Slack thread using the
already-installed OpenBot bot. This is the speed-focused option 2: it avoids a second Slack listener
and does not expose provider credentials to the browser or the coworker. The publisher is an
explicit replaceable boundary, so the eventual managed cross-surface turn API proposed in
[CopilotKit/CopilotKit#6751](https://github.com/CopilotKit/CopilotKit/issues/6751) can replace it
without changing conversation identity, web UI, or agent execution.

The demo is accepted only with one continuous MP4 showing the entire Slack-to-web-to-Slack journey.

## Dependency

This work begins after the production Slack repair in
`2026-08-27-slack-production-durability-design.md` is complete. In particular, Railway must run the
deployed migration runner before promotion, and a linked Slack mention must produce a real coworker
reply rather than `Something went wrong`. Building web continuation on a failing ingress would hide
which subsystem caused a demo failure.

## Goals

- A linked Slack thread appears in the linked user's authenticated OpenBot channel roster.
- Opening that channel shows the Slack conversation from the canonical Intelligence thread.
- The channel is permanently pinned to the coworker selected by the first Slack turn.
- A sequential follow-up sent on the web continues that same Intelligence thread.
- The web-authored user message and the resulting coworker reply appear, in order, in the original
  Slack thread as messages from the installed OpenBot bot.
- A retry or page reload does not create duplicate Slack messages.
- A single uncut acceptance video proves the production journey without exposing secrets or private
  identity data.

## Non-goals

- Replacing managed Channels ingress or running a direct Slack Socket Mode listener beside it.
- Impersonating the linked Slack human. Web-authored text is visibly attributed as sent via OpenBot.
- Supporting simultaneous Slack and web turns in the demo. Each surface already serializes its own
  turns, but they do not share an application-owned cross-surface scheduler. The acceptance journey
  is sequential; issue #6751 is the production destination for managed ordering across surfaces.
- Making arbitrary Slack channels visible to OpenBot users who are not members of the canonical
  OpenBot channel.
- Copying provider payloads or maintaining a second transcript in PostgreSQL.
- General-purpose outbound Slack messaging, proactive notifications, scheduled turns, or support
  for providers other than Slack.
- Editing, deleting, or reconciling historical Slack messages from the OpenBot UI.

## Evidence from the current implementation

- Managed ingress is declared by `createOpenBotSlackChannel`. It owns `onMention` and subscribed
  `onMessage` handling, links the provider identity, and invokes the Channels thread.
- `OpenBotChannelAgent` receives the Channels thread ID, selects a coworker on the first linked turn,
  and persists an immutable `external_thread_bindings` row. Later Slack turns reload that binding.
- A normal OpenBot web channel consists of `channels`, `channel_memberships`, `channel_agents`, and
  one `intelligence_channel_mappings` row. `ChannelChat` already accepts an existing thread ID and
  runtime agent ID.
- `intelligence_channel_mappings.thread_id` is globally unique. It can therefore be the join from an
  external binding's `channels_thread_id` to exactly one web channel without adding a second
  conversation identifier.
- `ChannelChat` restores history through `readThreadMessages(threadId, runtimeAgentId)` and runs the
  coworker against that thread.
- The existing `/activity` route is intentionally a best-effort roster preview. It trusts text
  observed by the browser and is not a durable or authoritative external-delivery boundary.
- Channels SDK 0.9 keeps the managed per-conversation queue behind provider ingress; proactive
  delivery to an existing managed conversation is not wired. The direct publisher is therefore a
  temporary adapter, not a second attempt to drive that private queue.

## Architecture

```text
Slack @openbot
  -> managed Channels ingress (only listener)
  -> canonical Intelligence thread
  -> OpenBot router selects and binds coworker
  -> materialize normal OpenBot channel using that same thread ID
  -> coworker reply appears in Slack

Authenticated OpenBot channel
  -> restore and run the same Intelligence thread with the pinned coworker
  -> verify completed canonical user + assistant messages server-side
  -> durable external-delivery queue
  -> server-only Slack Web API publisher
  -> original Slack channel + thread
```

The canonical transcript is the Intelligence thread. PostgreSQL stores authorization, routing, and
delivery state around it, but not another user-visible transcript.

## Design

### 1. Idempotent web-channel materialization

Add an `ExternalChannelMaterializer` application service. After the Slack router establishes or
reloads a binding, and before it runs the coworker, the service ensures that the linked user has a
normal OpenBot channel with:

- `intelligence_channel_mappings.thread_id = external_thread_bindings.channels_thread_id`;
- one membership for `created_by_user_id`;
- one channel-agent row for the immutable bound `agent_id`;
- a stable external-conversation description and a name derived from the current coworker profile.

The materializer runs in a serializable database transaction. It first looks up the globally unique
thread mapping. If present, it verifies that the mapped channel has the same owner and pinned agent
and returns it. If absent, it inserts the channel, membership, agent, and mapping together. A unique
conflict is retried as a lookup and must converge only when owner, thread, and agent all match;
otherwise it fails loudly as an integrity error.

No new relationship column is needed: the existing unique thread mapping is the durable link. This
also makes existing external bindings lazily backfillable. Their next valid Slack turn can
materialize the missing channel without rewriting the canonical thread ID. A one-off idempotent
backfill command may materialize existing bindings before the recorded demo, but it must call the
same service and authorization checks as runtime materialization.

The channel is discoverable only through its membership row. The provider workspace, channel, and
thread identifiers never enter the roster DTO or browser state.

### 2. Transcript compatibility is a release gate

Before implementing outbound delivery, add an integration test using a managed-channel fixture that
records a Slack user turn and coworker reply, then reads
`readThreadMessages(channelsThreadId, boundAgentId)` through the same server path as `ChannelChat`.
The restored messages must preserve their roles, IDs, ordering, and readable text.

If the managed wrapper stores history under an agent identity that the bound coworker cannot read,
stop. The fix must use a supported Intelligence projection so both surfaces address one thread; it
must not copy messages into a new thread or synthesize a PostgreSQL transcript. This test is a hard
gate because the entire design depends on canonical-thread interoperability.

### 3. Web continuation

The materialized channel uses the existing channel route and `ChannelChat`. Its `threadId` is the
managed Channels thread ID and its `runtimeAgentId` is the bound coworker. The browser therefore
restores Slack history and sends its follow-up through the ordinary authenticated Copilot runtime.

The UI labels the channel as connected to Slack and explains that successful web turns are mirrored
to the original Slack thread. It does not receive or render raw provider IDs. If direct egress is not
configured or a delivery becomes ambiguous, the conversation remains usable on the web and the UI
shows an explicit delivery state instead of claiming Slack received the turn.

The demo permits only sequential cross-surface use: finish the Slack turn before sending on the web,
and finish the web turn before sending another Slack message. The product UI should avoid promising
stronger ordering until the managed API in issue #6751 owns both entrances.

### 4. Authoritative completed-turn request

Do not reuse the best-effort activity mutation for Slack publication and do not accept assistant
text asserted by the browser. Add an authenticated endpoint scoped to a channel membership, for
example:

```text
POST /api/channels/:channelId/external-turns
{ userMessageId, assistantMessageId }
```

After a successful web run, `ChannelChat` submits the canonical IDs of the user message it created
and the final assistant message it observed. The server:

1. authorizes the caller's active channel membership;
2. resolves the external binding through the channel's unique Intelligence thread mapping;
3. verifies that the binding owner is the caller and the bound agent belongs to the channel;
4. reads those message IDs from the canonical Intelligence thread scoped to the caller, while the
   channel-agent relationship independently proves which coworker is pinned;
5. derives roles and text from the canonical records, rejecting missing, swapped, empty, or
   non-text messages; and
6. creates the two ordered delivery records in one transaction.

The browser may request delivery but cannot choose a Slack destination, impersonate an assistant,
or replace canonical content. Repeating the request returns the existing delivery state.

### 5. Durable delivery and idempotency

Add `external_message_deliveries` with these logical fields:

- generated delivery ID;
- canonical thread ID referencing `external_thread_bindings`;
- canonical message ID;
- role (`user` or `assistant`);
- sequence within the external turn (`0` then `1`);
- status (`pending`, `delivering`, `sent`, `unknown`, or `failed`);
- attempt count and next-attempt time;
- Slack response message ID when confirmed;
- bounded delivery payload needed while pending;
- created, updated, claimed, and completed timestamps.

A unique constraint on `(channels_thread_id, canonical_message_id)` is the idempotency boundary.
The two records are inserted atomically. The assistant record is not claimable until the user record
is `sent`, which preserves visible order.

The payload is an outbox work item, not a transcript. It is bounded to Slack's supported message
size, is never returned by roster APIs or logged, and is cleared after a confirmed send. Intelligence
remains the long-lived source of truth. Failed or unknown records retain only what operators need to
resolve delivery under the repository's configured retention policy.

A worker claims records with a database lease so multiple Railway replicas cannot publish the same
row concurrently. Known pre-acceptance failures such as an explicit rate limit may be rescheduled.
A timeout, connection break, process death during the request, or other outcome where Slack may have
accepted the message becomes `unknown` and is not automatically reposted. This favors no duplicates
over silent retry. Repeating the browser request finds the same unique record and cannot enqueue a
second post. An unknown user record blocks its assistant record and produces a visible retry/review
state.

### 6. Narrow Slack publisher

Define a small server-side interface such as:

```ts
type SlackThreadPublisher = {
  post(input: {
    channelId: string;
    threadTs: string;
    text: string;
    deliveryId: string;
  }): Promise<{ messageTs: string }>;
};
```

The production implementation calls Slack `chat.postMessage` with the installed OpenBot bot token.
The destination comes only from the immutable external binding:

- `providerConversationId` is the Slack channel;
- `providerThreadId` is the Slack root thread timestamp.

For a web-authored user message, the bot posts a clear attribution such as `Jerel via OpenBot`, plus
the canonical text. It never claims the human posted from Slack. The coworker's reply is posted as
OpenBot and follows the attributed user message. Both remain replies under the original Slack root.

This publisher has no event receiver, Socket Mode connection, mention handler, or subscription
logic. Managed Channels remains sole ingress, preventing duplicate runs. Tests use a fake publisher;
no test calls the live Slack API.

### 7. Configuration and security

Add optional deployment configuration for `OPENBOT_SLACK_BOT_TOKEN`. Its presence enables the direct
web-egress bridge. Absence leaves managed Slack ingress and web conversations running but marks
external delivery unavailable. The token is read only at server boot, never stored in the database,
sent to the browser, passed to a coworker, printed, or included in an error.

The installed bot must have `chat:write` and must already belong to the target channel; the demo uses
the actual existing OpenBot Slack app rather than creating another bot identity. No app-level token
is required because this component does not open Socket Mode.

Logs contain bounded application delivery IDs, status classes, and phase codes only. They exclude
Slack tenant/channel/thread/message IDs, message text, tokens, user email, and signed account-link
URLs. Authorization derives from authenticated OpenBot membership and the immutable binding, never
from provider IDs supplied by the browser.

### 8. Error behavior

- Materialization failure aborts the Slack agent run and is reported through the bounded Slack phase
  diagnostics. It never creates a partially visible web channel.
- Transcript incompatibility blocks this feature's release rather than falling back to a copy.
- A web agent failure enqueues no assistant delivery and does not claim Slack saw a successful turn.
- A deterministic Slack rejection marks the delivery failed with a safe reason class. The web
  transcript remains canonical and readable.
- An ambiguous Slack outcome marks the row unknown and does not auto-retry.
- Failure of the user-message delivery blocks the assistant delivery to preserve order.
- The existing activity mutation remains fire-and-forget and may update roster previews; its success
  is unrelated to external delivery success.

## Testing

### Unit tests

- Materialization inserts exactly one channel, membership, agent, and thread mapping.
- Repeated and concurrent materialization converges to one matching channel.
- Mismatched owner, thread, or agent fails as an integrity error.
- The external-turn endpoint rejects non-members, deleted channels, channels without an external
  binding, swapped roles, missing canonical IDs, and browser text not backed by canonical history.
- Repeated turn requests create no additional delivery rows.
- The dispatcher publishes user before assistant, blocks later sequence rows, and releases expired
  leases safely.
- Known rate limits reschedule; ambiguous outcomes become unknown and are not retried.
- The publisher uses the binding's destination and never accepts provider IDs from its HTTP caller.
- User attribution is explicit and bot-authored; secrets and message content are absent from logs.

### Integration tests

- A managed Slack turn materializes a web channel using the exact Channels thread ID and bound
  coworker.
- The authenticated owner lists and opens that channel; another user cannot discover or read it.
- Managed Slack history restores through the current `ChannelChat` history path with canonical IDs,
  roles, order, and text.
- A web follow-up runs the bound coworker on the same thread.
- A completed web turn creates two authoritative delivery rows; a fake Slack publisher receives the
  attributed user message and coworker reply against the original destination in order.
- Reloading and resubmitting the completion request do not duplicate either post.
- Direct egress disabled leaves managed ingress and web continuation operational and reports an
  unavailable external-delivery state.

### Existing regression suite

The focused Slack identity, ingress, routing, binding, approval, channel-store, transcript, runtime,
configuration, migration-journal, and Railway deployment tests remain green. Formatting, lint,
typecheck, server tests, application tests, and production builds pass before merge.

## Production rollout and acceptance video

Use a linked test account and a non-sensitive prompt. Record one continuous, unedited MP4 and attach
it to the PR or release evidence. The recording must show, in order:

1. Railway's migration pre-deploy step succeeds and the OpenBot deployment becomes healthy.
2. The Slack `#openbot-channels` channel and the existing installed `openbot` bot.
3. A fresh `@openbot` request.
4. A real threaded coworker response with no `Something went wrong` fallback.
5. The authenticated OpenBot production domain.
6. The corresponding channel in the roster, with the expected coworker.
7. The same Slack request and response restored in the web transcript.
8. A distinct follow-up sent from the web.
9. The attributed `<name> via OpenBot` user message appearing in the original Slack thread.
10. The coworker's answer appearing immediately after it in that Slack thread.
11. The same answer visible in the OpenBot web conversation.
12. A full page reload preserving the complete conversation.
13. A retry or reopen that demonstrates no duplicate Slack messages.

Before recording, hide Railway variables, browser password managers, account-link URLs, email
addresses, private DMs, unrelated Slack channels, and logs containing identifiers. The video is
acceptance evidence only if all thirteen observations are visible in one file; edited clips or
separate Slack and web recordings do not establish continuity.

## Migration to managed option 1

Issue #6751 proposes the durable product shape: a managed conversation reference, a programmatic
turn trigger, shared provider ordering, identity attribution, idempotency, and delivery status. When
that API exists:

1. keep the external binding, canonical Intelligence thread, materialized web channel, and web UI;
2. replace `SlackThreadPublisher` and the provider-specific worker with a Channels managed-turn
   implementation;
3. map the existing canonical message ID to the managed idempotency key;
4. let Channels own cross-surface ordering and provider delivery receipts; and
5. remove `OPENBOT_SLACK_BOT_TOKEN` from OpenBot after the managed path passes the same acceptance
   video.

The endpoint and outbox should depend on an `ExternalTurnDelivery` interface rather than Slack Web
API types so this replacement is localized.

## Rollback

The direct publisher is disabled by removing `OPENBOT_SLACK_BOT_TOKEN`; managed ingress and canonical
web history continue to work. Pending deliveries remain visible as unavailable and are not silently
dropped. The materialized channel rows are ordinary authorized OpenBot channels and do not need to
be deleted on rollback. Schema rollback is additive-only: delivery tables may remain unused until a
forward fix. Never delete the Intelligence thread or rewrite its ID.

## Completion criteria

- The production Slack repair dependency is complete.
- The transcript compatibility gate proves one canonical thread works on both surfaces.
- A linked Slack thread materializes as exactly one authorized OpenBot channel.
- A sequential web follow-up continues the bound coworker on that same thread.
- The authoritative user and assistant messages appear once, in order, in the original Slack thread.
- Direct egress uses the existing OpenBot bot and no second Slack ingress connection.
- Security, idempotency, error-path, migration, and regression tests pass.
- The PR or release contains the uncut MP4 satisfying all thirteen acceptance observations.
- The temporary bridge and its migration path to issue #6751 are documented.
