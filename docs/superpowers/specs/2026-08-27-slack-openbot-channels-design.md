# Slack access to OpenBot coworkers through Channels SDK

Date: 2026-08-27

## Summary

OpenBot will expose one native Slack assistant, `@OpenBot`, through CopilotKit Channels SDK. A person starts a Slack thread by mentioning `@OpenBot` and naming or describing the coworker they want. OpenBot resolves that person to an OpenBot account, selects one coworker, and pins the Slack thread to that coworker. Replies in the thread continue with the pinned coworker without another mention.

Channels SDK owns Slack ingress, subscriptions, provider delivery, streaming, files, deduplication, and reconnects. OpenBot remains the authority for coworkers, visibility, models, tools, computers, credentials, policy, and audit attribution.

The first release uses one Slack bot identity. Separate native Slack identities for individual coworkers remain possible later, but require a Slack app installation and credential lifecycle for every identity and are outside this scope.

## Goals

- Let a Slack user mention `@OpenBot` and run an existing OpenBot coworker.
- Route an explicit coworker name without a model decision; otherwise reuse OpenBot's intent router.
- Pin one OpenBot coworker to each Slack thread.
- Apply the current speaker's OpenBot authorization, private-coworker visibility, grants, policy, and audit identity on every turn.
- Preserve OpenBot's governed MCP/plugin and computer capabilities from Slack.
- Stream responses and accept files through Channels SDK.
- Send secrets, login control, and 2FA to OpenBot's existing secure web surface rather than collecting them in Slack.
- Leave a clean extension point for separately provisioned coworker Slack identities.

## Non-goals

- Creating a Slack app or native bot user for every OpenBot coworker.
- Making one Slack app impersonate multiple mentionable bot users.
- Mirroring Slack conversations into OpenBot's web channel roster in the first release.
- Rendering arbitrary OpenBot React or sandboxed HTML components inside Slack.
- Allowing a Slack thread to switch coworkers after its first run.
- Replacing OpenBot's current web chat or CopilotKit Intelligence threads.
- Collecting passwords, one-time codes, card numbers, or other secrets in Slack.

## User experience

### Start a conversation

A person writes a top-level Slack message:

```text
@OpenBot ask Risk Analyst to review the attached report
```

Channels delivers the mention to OpenBot. OpenBot links the Slack speaker to an OpenBot user, resolves `Risk Analyst` against that user's visible roster, writes the thread binding, subscribes to the Slack thread, and starts the agent. The reply streams into the thread.

If the message does not explicitly name a visible coworker, OpenBot applies its existing intent router to the speaker's visible roster. The selected coworker and routing reason are audited through the same `channel.routed` event used by the web product.

### Continue a conversation

Once bound, ordinary replies in the Slack thread run the same coworker. The person does not need to mention `@OpenBot` again. A request for a different coworker must start a new top-level mention and therefore a new Slack thread.

### Multiple people in one thread

The coworker and conversation history are shared by the Slack thread. Authorization is not shared. Each turn resolves the current Slack speaker to an OpenBot user and reloads that person's access and grants.

If another participant cannot access the pinned private coworker, OpenBot refuses that turn with a clear message. It does not run as the thread creator, reveal the coworker's configuration, or silently reroute to another coworker.

### Unlinked people

An unlinked Slack user receives a short explanation and a signed, expiring account-link URL. The agent does not run. After the user authenticates in OpenBot and confirms the link, they can retry the Slack message.

An exact match between a verified Slack email and one active OpenBot user may create the initial link automatically. Missing, ambiguous, or conflicting matches require explicit confirmation. Existing links are never silently reassigned by a later email match.

### Human assistance

When a coworker needs login control, 2FA, or a secret, Slack receives a native message or card explaining what is needed and an expiring link to the coworker's OpenBot control screen. The existing bounded assistance wait continues on the server. The run resumes when control is released or the secure prompt is completed in OpenBot, and ends cleanly when cancelled or expired.

## Architecture

The OpenBot server will host one long-running managed Channels declaration alongside its existing Intelligence runtime:

```text
Slack event
  -> CopilotKit Intelligence managed Slack provider
  -> @copilotkit/channels
  -> OpenBot Slack identity and routing bridge
  -> existing OpenBot agent construction
  -> built-in agent or remote AG-UI endpoint
  -> Channels run renderer
  -> streamed Slack reply
```

### `OpenBotSlackChannel`

`OpenBotSlackChannel` constructs one `createChannel` declaration named `openbot`. It uses managed Slack delivery and is passed to the existing Intelligence-mode `CopilotRuntime` through its `channels` option. The Node/Bun host awaits Channels readiness at startup and reports both transport and provider attachment status.

The channel registers:

- `onMention`: subscribe to the Slack thread and run the delegating agent.
- `onMessage`: run only when the Slack thread is already subscribed and bound.
- `onInterrupt`: render supported approvals or assistance links and resume through Channels continuation handling.
- Channel computer tools backed by OpenBot's `ComputerGateway`.
- Portable approval components that have an intentional Slack representation.

The existing Hono Copilot endpoint remains mounted for the web application. Both surfaces share the Intelligence project, OpenBot stores, agent definitions, and policy services.

### `SlackIdentityLinker`

Channels' `identifyUser` callback receives Slack tenant and actor information. `SlackIdentityLinker` resolves that provider identity to an OpenBot user and returns the application user to Channels. Resolution is scoped by provider, Slack workspace ID, and Slack user ID.

The linker may query the Slack profile through the adapter-provided identity lookup. Automatic email matching requires a verified Slack email and exactly one active OpenBot account with the normalized email. Explicit linking uses OpenBot's existing signed-value mechanism, includes the provider identity and expiry, and binds only to the authenticated OpenBot user completing the flow.

An unlinked identity returns no application user. Channel handlers detect that state, post the link card, and do not call `thread.runAgent`.

### `OpenBotChannelAgent`

Channels accepts one agent or agent factory per Channel, and its factory receives only the canonical thread ID. `OpenBotChannelAgent` therefore acts as a small delegating `AbstractAgent`, not as a new model-backed agent.

For each run it:

1. Reads a server-created execution context containing the current linked OpenBot user and provider metadata. The bridge removes this private context before delegating so internal identity data is not included in the model prompt.
2. Loads the durable binding by the canonical Channels thread ID.
3. If no binding exists, resolves an explicit visible coworker from the first message or invokes OpenBot's existing intent router, then inserts the binding before starting the target agent.
4. Reloads the selected coworker for the current user. A missing or inaccessible coworker refuses the run; it never changes the binding.
5. Reuses OpenBot's existing agent construction to apply the standing role, current model credential, current grants, tool selection, connected-vendor guidance, stall guard, remote-agent authorization, and signed run assertion.
6. Delegates the AG-UI run and returns its event stream to Channels.

The agent implements `clone()` so Channels can isolate each turn safely. Same-thread turn concurrency is configured as serial.

### Reusable OpenBot agent resolver

OpenBot currently constructs agents through a request-oriented factory because web authorization arrives on an HTTP request. This logic will be factored behind a reusable service boundary:

```text
resolveAgentForActor(actor, agentId, runContext) -> AbstractAgent
```

The web runtime continues to call it after resolving the HTTP request actor. `OpenBotChannelAgent` calls it after resolving the Slack actor. There must be one implementation of coworker visibility, grants, standing roles, tool selection, and signed run identity; the Slack path must not reproduce those rules.

## Persistence

### Slack user links

Add `external_user_links`:

| Column | Meaning |
| --- | --- |
| `provider` | `slack` for this integration |
| `provider_tenant_id` | Slack workspace/team ID |
| `provider_user_id` | Slack user ID |
| `openbot_user_id` | OpenBot user reference |
| `provider_email` | Last verified provider email, informational |
| `linked_at` | Link timestamp |
| `updated_at` | Last confirmed profile/link update |

The primary key is `(provider, provider_tenant_id, provider_user_id)`. A provider identity has one OpenBot user. A separate uniqueness constraint on `(provider, provider_tenant_id, openbot_user_id)` prevents one OpenBot account from being linked to multiple Slack identities in the same workspace without an explicit future schema change.

### Slack thread bindings

Add `external_thread_bindings`:

| Column | Meaning |
| --- | --- |
| `channels_thread_id` | Canonical Channels/Intelligence thread ID |
| `provider` | `slack` |
| `provider_tenant_id` | Slack workspace/team ID |
| `provider_conversation_id` | Slack channel or DM ID |
| `provider_thread_id` | Slack thread timestamp/root ID |
| `agent_id` | Pinned OpenBot coworker |
| `created_by_user_id` | OpenBot user who selected the coworker |
| `created_at` | Binding timestamp |

`channels_thread_id` is the primary key. `(provider, provider_tenant_id, provider_conversation_id, provider_thread_id)` is unique. The `agent_id` is immutable after insertion. Concurrent first deliveries use one transaction and the unique constraint; the losing request reloads the winner rather than overwriting it.

Provider metadata is stored so a future admin screen or native-coworker Slack connection can find the source conversation without parsing a Channels thread identifier.

## Coworker routing

Explicit routing takes precedence. The router normalizes visible coworker names and recognizes a direct name in the first message after removing the `@OpenBot` mention. An explicit name that is ambiguous produces a short choice list rather than selecting arbitrarily.

When there is no explicit match, the existing OpenBot intent router receives the current user's visible coworkers and their reachable systems. It retains its present safe fallback and audit semantics. The first binding and `channel.routed` audit row are written before the target agent receives the message.

Existing Slack bot user IDs may later become routing aliases, but only through an explicit administrator-owned mapping. The first release does not infer ownership of another installed bot or act as it. Mentioning another bot can independently trigger that bot, so `@OpenBot` does not encourage that syntax until the identity is actually connected.

## Tools and OpenBot governance

### MCP and plugin tools

Existing granted tools already execute server-side through OpenBot's plugin store. The reusable agent resolver loads them for the current OpenBot user and coworker exactly as the web runtime does. Tool selection, policy checks, and audit writes remain unchanged.

### Computer tools

Computer tool schemas and model-facing descriptions currently live with React registrations. Extract their platform-neutral definitions into a shared module. The web surface keeps its current React renderers and HTTP handlers. The Slack surface registers equivalent Channels `ChannelTool` handlers that call `ComputerGateway` directly.

Direct calls must pass the same coworker ID, `ActionActor`, abort signal, and tool-call ID as the web route. They must use the gateway rather than the lower-level computer provider, preserving target resolution, CEL policy, audit-before-action, stale-reference checks, human-control refusal, and page-frame capture.

The initial Slack tool set includes navigation, read, snapshot, click, type, key, scroll, workspace list/read/write, and shell execution. Results are concise structured values for the model. Channels displays tool progress and policy refusals without exposing typed secrets or file contents beyond what the user explicitly requested in the conversation.

### Components and decisions

Portable approval/choice components receive native Slack representations through Channels. An interaction is bound to the originating thread and resumes only the persisted continuation that created it.

Compiled React gallery components and sandboxed HTML do not automatically become Slack UI. For a display-only component, the tool returns a textual summary and an authenticated `Open in OpenBot` link when a corresponding web view exists. A component that requires a decision must have an explicit Channels component definition before it is offered on Slack. The agent must never be told that an unsupported component was displayed.

### Secrets and control

`computer_request_secret` and control-taking flows never ask for the value in Slack. They post an expiring OpenBot URL and use the existing assistance state machine. Slack messages and audit payloads contain only the kind of assistance requested and status, never the secret value.

## Files and messages

Channels normalizes Slack attachments into AG-UI content parts. OpenBot forwards supported files to the selected agent. Outbound files use `thread.postFile` when Slack supports them. Oversized or unsupported files produce an explicit error rather than being silently omitted.

Channels owns streamed text rendering and reply continuation. OpenBot does not implement a second Slack chunker or edit loop.

## Failure handling

- **Channels setup incomplete:** startup status is `setup_required`; the server remains available for web chat but readiness and logs state that Slack is not attached.
- **Slack transport disconnected:** Channels reports `reconnecting`; no new provider turn is claimed as runnable until the connection recovers.
- **Unlinked user:** post the account-link card and do not create a coworker binding or run an agent.
- **No visible coworker:** explain that no coworker is available; do not invoke the model router.
- **Ambiguous explicit name:** present visible matches and require a new top-level request naming one.
- **Private coworker inaccessible to a later participant:** refuse that turn without revealing configuration or changing the binding.
- **Coworker deleted after binding:** report that the coworker is unavailable and preserve the binding and history.
- **Model or remote AG-UI failure:** use OpenBot's existing stopped-turn language and retain the Slack thread for retry.
- **Silent AG-UI stream:** OpenBot's existing stall guard terminates it and Channels posts the failure.
- **Policy refusal:** return the gateway's reason and rule classification without retrying the denied action.
- **Computer unavailable:** report the unavailable computer without converting the turn into an ungoverned action.
- **Assistance expired or cancelled:** resolve the tool with a bounded failure so the agent can explain or stop.
- **Duplicate provider delivery:** Channels deduplication and managed delivery claims prevent a second run. OpenBot does not add a competing event ledger.
- **Overlapping messages:** per-thread serial concurrency queues the later turn. Different Slack threads may run concurrently.

Before any side-effecting tool call, the managed Channels delivery is committed according to its canonical run contract. OpenBot tool handlers remain responsible for their existing idempotency and audit behavior.

## Security

- Request the minimum Slack scopes needed for mentions, thread messages, files, profile identity, and replies.
- Treat Slack workspace and user IDs as provider identifiers, not OpenBot authorization by themselves.
- Use verified email only for an unambiguous initial match; persist the resulting provider link.
- Sign account-link URLs with the existing signed-value facility and a short expiry.
- Recheck coworker access and tool grants on every turn.
- Strip server-private execution context before the target agent sees the input.
- Never place OpenBot session cookies, model keys, connector credentials, run assertions, or secrets in Slack messages or Channels state visible to the provider.
- Continue using OpenBot's write-only credential store and signed agent callback assertions.
- Audit routing, tool decisions, assistance requests, and provider-link changes without storing message bodies in audit payloads.

## Operational behavior

The OpenBot server is a long-running Channels host. Its shutdown path awaits `channels.stop()` before database and process teardown. Readiness exposes separate web-runtime, Channels transport, and Slack provider states. A connected Channels socket with no attached Slack provider is not reported as Slack-ready.

The deployment uses `npx copilotkit@latest channels setup` or the equivalent Intelligence configuration to attach the Slack app to the `openbot` Channel code. Slack provider credentials remain managed by CopilotKit Intelligence on the managed path; OpenBot stores no Slack bot token.

## Testing

### Unit tests

- Provider identity lookup and exact verified-email linking.
- Ambiguous, conflicting, expired, and replayed account links.
- Explicit coworker-name routing and ambiguity handling.
- Intent-router fallback restricted to the current user's visible roster.
- Immutable thread binding and concurrent first-turn insertion.
- Later-participant access to public and private coworkers.
- `OpenBotChannelAgent.clone()` and per-turn actor isolation.
- Removal of private execution context before delegation.
- Correct standing role, grants, tool selection, and signed run assertion for the selected actor and coworker.
- Computer ChannelTool schemas and outcomes against a fake `ComputerGateway`.
- Policy refusal, stale reference, abort, human-control, and unavailable-computer outcomes.
- Assistance link expiry and secret redaction.

### Integration tests

- Channels fake adapter: mention, subscription, first binding, streamed reply, and ordinary thread follow-up.
- Two Slack users in one thread with different coworker/tool access.
- Duplicate delivery and overlapping same-thread turns.
- Remote AG-UI coworker receiving the same standing role and governed tools as the web runtime.
- Slack file input and outbound file delivery.
- Approval interaction and persisted continuation resume.
- Graceful startup in `setup_required` and reconnection status transitions.

### Real Slack smoke test

In a test workspace:

1. Install and attach `@OpenBot`.
2. Link one Slack user to OpenBot.
3. Mention an explicit coworker and receive a streamed threaded answer.
4. Reply without another mention and retain the same coworker.
5. Run one governed browser action.
6. Trigger and display a policy refusal.
7. Request human assistance and complete it through the OpenBot web link.
8. Verify the routing and tool audit rows identify the linked OpenBot user and selected coworker.

## Delivery sequence

1. Refactor OpenBot's agent construction into the reusable actor-and-coworker resolver, with no web behavior change.
2. Add provider identity links and the authenticated Slack account-link flow.
3. Add durable external thread bindings and the routing service.
4. Add `OpenBotChannelAgent` and Channels fake-adapter tests.
5. Extract platform-neutral computer tool definitions and add `ComputerGateway`-backed ChannelTools.
6. Add the managed `OpenBotSlackChannel` to the existing Intelligence runtime and lifecycle.
7. Add Slack-native assistance and approval messages.
8. Configure a test Slack provider and run the smoke test.
9. Document setup, scopes, account linking, operations, and current UI limitations.

## Future extensions

- Mirror Slack threads into OpenBot's web channel roster using the same Intelligence thread.
- Attach an administrator-owned Slack bot identity to a specific coworker.
- Map owned Slack bot user IDs as explicit coworker routing aliases.
- Add Slack renderers for more OpenBot component types.
- Support an administrator-defined default coworker per Slack channel.
- Add channel-specific policy context once OpenBot has a product rule for Slack channel trust.
