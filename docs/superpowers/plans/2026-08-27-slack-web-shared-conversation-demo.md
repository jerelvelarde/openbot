# Slack-to-Web Shared Conversation Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a linked Slack conversation appear and continue on the authenticated OpenBot domain, then mirror a completed web turn back to the original Slack thread with the existing OpenBot bot and prove the production journey in one uncut video.

**Architecture:** Managed CopilotKit Channels remains the only Slack ingress and CopilotKit Intelligence remains the only transcript. OpenBot materializes an authorized web channel around the managed thread ID, verifies completed web messages against Intelligence, and queues provider delivery through an interface whose temporary implementation calls Slack Web API. PostgreSQL and the existing leased work queue provide idempotency, ordering, and multi-replica safety; ambiguous external outcomes are never automatically reposted.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle ORM/PostgreSQL, CopilotKit Channels 0.9, CopilotKit Runtime/Intelligence 1.69, React, TanStack Query, Slack Web API, Railway.

---

## Prerequisite gate

Do not begin Task 1 until the production Slack repair plan in
`docs/superpowers/plans/2026-08-27-slack-production-diagnostic-and-migration-gate.md` has completed,
Railway's pre-deploy migration command is active, and a linked `@openbot` mention receives a real
threaded reply. Record the successful deployment URL and Slack test timestamp in the PR description;
do not put workspace, channel, user, or thread IDs in the repository.

## File map

**Canonical conversation foundation**

- Create `server/src/external/canonical-thread-reader.ts`: read and validate canonical Intelligence messages for a user.
- Create `server/src/external/channel-materializer.ts`: idempotently project an external binding into the existing web-channel tables.
- Modify `server/src/slack/channel-agent.ts`: materialize after binding and before coworker execution.
- Modify `server/src/channels/routes.ts`: expose only the safe external-provider marker on authorized channel DTOs.
- Test in `server/tests/canonical-thread-reader.test.ts`, `server/tests/external-channel-materializer.integration.test.ts`, `server/tests/slack-channel-agent.test.ts`, and `server/tests/channel-routes.test.ts`.

**Verified external delivery**

- Modify `server/src/db/schema/core.ts`: define delivery rows and their constraints.
- Generate `server/drizzle/0022_*.sql`, snapshot, and journal entry.
- Create `server/src/external/delivery-store.ts`: atomically enqueue ordered delivery records and work items, then transition delivery state.
- Create `server/src/external/turn-service.ts`: authorize a channel and resolve canonical message content.
- Create `server/src/external/turn-routes.ts`: validate the authenticated HTTP contract.
- Test in `server/tests/external-delivery-store.integration.test.ts`, `server/tests/external-turn-service.integration.test.ts`, and `server/tests/external-turn-routes.test.ts`.

**Slack bridge and worker**

- Create `server/src/slack/thread-publisher.ts`: narrow `chat.postMessage` client and safe error classes.
- Create `server/src/external/delivery-worker.ts`: leased queue consumer with strict ambiguity handling.
- Modify `server/src/config.ts`: optional server-only bot token.
- Modify `server/src/index.ts` and `server/src/app.ts`: wire the reader, materializer, routes, worker, and shutdown.
- Test in `server/tests/slack-thread-publisher.test.ts`, `server/tests/external-delivery-worker.test.ts`, `server/tests/config.test.ts`, and `server/tests/health.test.ts`.

**Web UX and acceptance**

- Modify `app/src/lib/channels/queries.ts`: safe provider marker.
- Modify `app/src/lib/channels/mutations.ts`: idempotent completed-turn request.
- Create `app/src/components/channels/external-delivery-status.tsx`: Slack connection/delivery status.
- Modify `app/src/components/channels/channel-chat.tsx`: retain canonical IDs and request mirroring only after successful completion.
- Test in `app/tests/channel-external-delivery.test.tsx` and `app/tests/channel-queries.test.ts`.
- Create `docs/slack-shared-conversation-demo.md`: production setup, rollback, and the thirteen-shot recording checklist.

### Task 1: Establish the canonical transcript contract

**Files:**
- Create: `server/src/external/canonical-thread-reader.ts`
- Test: `server/tests/canonical-thread-reader.test.ts`

- [ ] **Step 1: Write a failing contract test for the managed history shape**

Use a fake matching the only Intelligence call this feature needs and include messages in the exact
stored dialect already handled by the web reader:

```ts
const client = {
  getThreadMessages: mock(async (input: { threadId: string; userId: string }) => ({
    messages: [
      { id: "slack-user-1", role: "user", content: "Review this risk" },
      { id: "slack-agent-1", role: "assistant", content: "The main risk is drift." },
    ],
  })),
};

const reader = createCanonicalThreadReader(client);
expect(await reader.completedTurn({
  threadId: "channels-thread-1",
  userId: "user-1",
  userMessageId: "slack-user-1",
  assistantMessageId: "slack-agent-1",
})).toEqual({
  user: { id: "slack-user-1", role: "user", text: "Review this risk" },
  assistant: { id: "slack-agent-1", role: "assistant", text: "The main risk is drift." },
});
expect(client.getThreadMessages).toHaveBeenCalledWith({
  threadId: "channels-thread-1",
  userId: "user-1",
});
```

Also test missing IDs, reversed roles, blank content, non-string content, and duplicate IDs. Each must
throw `CanonicalTurnError` with a closed `code` (`message_missing`, `role_mismatch`, or
`content_unavailable`), never include message text in the error.

- [ ] **Step 2: Run the test and verify the reader does not exist**

Run: `bun test server/tests/canonical-thread-reader.test.ts`

Expected: FAIL because `../src/external/canonical-thread-reader` cannot be resolved.

- [ ] **Step 3: Implement the minimal typed reader**

Create these public types and implementation:

```ts
export type CanonicalTextMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type CanonicalThreadClient = {
  getThreadMessages(input: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: unknown[] }>;
};

export type CanonicalThreadReader = {
  completedTurn(input: {
    threadId: string;
    userId: string;
    userMessageId: string;
    assistantMessageId: string;
  }): Promise<{ user: CanonicalTextMessage; assistant: CanonicalTextMessage }>;
};

export class CanonicalTurnError extends Error {
  constructor(readonly code: "message_missing" | "role_mismatch" | "content_unavailable") {
    super(`Canonical turn could not be delivered: ${code}.`);
    this.name = "CanonicalTurnError";
  }
}
```

`completedTurn` must call `getThreadMessages` once, find exactly one row per requested ID, verify the
user/assistant roles, trim only to test emptiness, and return the original nonblank text unchanged.
Do not accept browser-provided text and do not log the response.

- [ ] **Step 4: Run the focused contract tests**

Run: `bun test server/tests/canonical-thread-reader.test.ts app/tests/thread-messages.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit the transcript contract**

```bash
git add server/src/external/canonical-thread-reader.ts server/tests/canonical-thread-reader.test.ts
git commit -m "test: define canonical external turn history"
```

### Task 2: Materialize one authorized web channel per external thread

**Files:**
- Create: `server/src/external/channel-materializer.ts`
- Test: `server/tests/external-channel-materializer.integration.test.ts`
- Modify: `server/src/slack/channel-agent.ts`
- Modify: `server/tests/slack-channel-agent.test.ts`

- [ ] **Step 1: Write failing integration tests for creation and convergence**

Seed a user, coworker, and `external_thread_bindings` row using the existing database test support.
Assert this call:

```ts
const result = await materializer.materialize(binding);
expect(result).toMatchObject({
  agentIds: [binding.agentId],
  threadId: binding.channelsThreadId,
});
```

creates exactly one matching row in each of `channels`, `channel_memberships`, `channel_agents`, and
`intelligence_channel_mappings`. Call it twice and concurrently with `Promise.all`; assert all calls
return the same channel ID. Seed a pre-existing mapping with a different owner or agent and assert
`ExternalChannelIntegrityError`.

- [ ] **Step 2: Run the materializer tests and verify failure**

Run: `bun test server/tests/external-channel-materializer.integration.test.ts`

Expected: FAIL because `createExternalChannelMaterializer` is missing.

- [ ] **Step 3: Implement serializable materialization**

Expose this boundary:

```ts
export type ExternalChannelMaterializer = {
  materialize(binding: ExternalThreadBinding): Promise<AgentChannel>;
};

export function createExternalChannelMaterializer(database: Database): ExternalChannelMaterializer;
```

Inside a serializable transaction, lookup `intelligence_channel_mappings.threadId` first. Validate
its membership user and sole channel agent against the binding. If absent, insert:

```ts
const channelId = `channel_${crypto.randomUUID()}`;
await transaction.insert(channels).values({
  id: channelId,
  name: binding.agentName,
  description: "A private OpenBot conversation connected to Slack.",
});
await transaction.insert(channelMemberships).values({
  channelId,
  userId: binding.createdByUserId,
});
await transaction.insert(channelAgents).values({
  channelId,
  agentId: binding.agentId,
});
await transaction.insert(intelligenceChannelMappings).values({
  channelId,
  userId: binding.createdByUserId,
  threadId: binding.channelsThreadId,
});
```

On SQLSTATE `40001` or unique conflict, re-read and converge only if thread, owner, and agent match.
Never mint a replacement thread ID.

- [ ] **Step 4: Make Slack execution materialize before resolving the coworker**

Extend `OpenBotChannelAgentDependencies`:

```ts
materializer: ExternalChannelMaterializer;
```

In `resolve`, after a binding exists and before `resolver.resolveAgentForActor`, call:

```ts
await this.materializer.materialize(binding);
```

Update the test harness with a fake materializer. Assert the first-turn order is bind → materialize →
resolve and an existing binding still materializes. Assert materialization failure prevents coworker
resolution and execution.

- [ ] **Step 5: Run focused tests**

Run: `bun test server/tests/external-channel-materializer.integration.test.ts server/tests/slack-channel-agent.test.ts server/tests/external-thread-store.integration.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Commit channel materialization**

```bash
git add server/src/external/channel-materializer.ts server/src/slack/channel-agent.ts server/tests/external-channel-materializer.integration.test.ts server/tests/slack-channel-agent.test.ts
git commit -m "feat: surface Slack threads as web channels"
```

### Task 3: Add durable external delivery records

**Files:**
- Modify: `server/src/db/schema/core.ts`
- Generate: `server/drizzle/0022_*.sql`
- Generate: `server/drizzle/meta/0022_snapshot.json`
- Modify: `server/drizzle/meta/_journal.json`
- Create: `server/src/external/delivery-store.ts`
- Test: `server/tests/schema.test.ts`
- Test: `server/tests/external-delivery-store.integration.test.ts`

- [ ] **Step 1: Write failing schema assertions**

Assert `external_message_deliveries` has a primary UUID ID, foreign key to
`external_thread_bindings.channels_thread_id`, a unique index on `(channels_thread_id,
canonical_message_id)`, and checks restricting role/status/sequence. Add an integration test proving
two calls to `enqueueTurn` create two delivery rows and two `work_items` rows, while repeating the
same call creates nothing new.

- [ ] **Step 2: Run the failing schema/store tests**

Run: `bun test server/tests/schema.test.ts server/tests/external-delivery-store.integration.test.ts`

Expected: FAIL because the table and store do not exist.

- [ ] **Step 3: Define the delivery table**

Add `externalMessageDeliveries` after `externalThreadBindings` with these columns:

```ts
id: uuid("id").primaryKey().defaultRandom(),
channelsThreadId: text("channels_thread_id").notNull().references(
  () => externalThreadBindings.channelsThreadId,
  { onDelete: "cascade" },
),
turnId: text("turn_id").notNull(),
canonicalMessageId: text("canonical_message_id").notNull(),
role: text("role").notNull(),
sequence: integer("sequence").notNull(),
status: text("status").notNull().default("pending"),
payload: jsonb("payload"),
providerMessageId: text("provider_message_id"),
completedAt: timestamp("completed_at", { withTimezone: true }),
createdAt: createdAt(),
updatedAt: updatedAt(),
```

Add check constraints for roles `user|assistant`, sequence `0|1`, statuses
`pending|delivering|sent|unknown|failed`, a unique index on thread/message, and an index on
`(turn_id, sequence)`. Import `integer` if needed.

- [ ] **Step 4: Generate and inspect migration 0022**

Run: `cd server && bun run db:generate`

Expected: one `0022_*.sql`, one snapshot, and one later journal entry. Inspect the SQL and confirm it
only creates this table, constraints, indexes, and foreign key. Do not hand-edit its timestamp.

- [ ] **Step 5: Implement atomic enqueueing and state transitions**

Expose:

```ts
export const EXTERNAL_DELIVERY_WORK = "slack.thread.message";
export type DeliveryStatus = "pending" | "delivering" | "sent" | "unknown" | "failed";
export type ExternalDelivery = {
  id: string;
  channelsThreadId: string;
  turnId: string;
  canonicalMessageId: string;
  role: "user" | "assistant";
  sequence: 0 | 1;
  status: DeliveryStatus;
  payload: { text: string; attributionName?: string } | null;
  providerMessageId: string | null;
};
export type ExternalDeliveryStore = {
  enqueueTurn(input: { binding: ExternalThreadBinding; userAttributionName: string; user: CanonicalTextMessage; assistant: CanonicalTextMessage }): Promise<ExternalDelivery[]>;
  get(id: string): Promise<ExternalDelivery | null>;
  getTurn(channelsThreadId: string, canonicalMessageId: string): Promise<ExternalDelivery[]>;
  predecessorSent(delivery: ExternalDelivery): Promise<boolean>;
  markDelivering(id: string): Promise<void>;
  markSent(id: string, providerMessageId: string): Promise<void>;
  markPending(id: string): Promise<void>;
  markUnknown(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
};
export function createExternalDeliveryStore(database: Database): ExternalDeliveryStore;
```

`enqueueTurn` derives `turnId` deterministically as
`${channelsThreadId}:${user.id}:${assistant.id}`. In one database transaction, insert each delivery
with `onConflictDoNothing`, then insert a `work_items` row for each inserted delivery using kind
`slack.thread.message`, key equal to delivery ID, and payload `{ deliveryId }`. Store only a bounded
object `{text, attributionName}` for the user and `{text}` for the assistant. The attribution name
comes from `users.name` (falling back to `OpenBot user`), never from the browser. `markSent` clears
`payload`; terminal failures never log it.
`getTurn` first resolves the matching delivery's `turnId`, then returns both rows ordered by
`sequence`; an assistant message ID therefore yields the complete user/assistant status pair.

- [ ] **Step 6: Run schema, migration, and store tests**

Run: `bun test server/tests/schema.test.ts server/tests/migration-journal.test.ts server/tests/external-delivery-store.integration.test.ts server/tests/work-queue.integration.test.ts`

Expected: all tests PASS.

- [ ] **Step 7: Commit the durable delivery model**

```bash
git add server/src/db/schema/core.ts server/src/external/delivery-store.ts server/drizzle server/tests/schema.test.ts server/tests/external-delivery-store.integration.test.ts
git commit -m "feat: persist idempotent external deliveries"
```

### Task 4: Authorize and verify completed web turns

**Files:**
- Create: `server/src/external/turn-service.ts`
- Test: `server/tests/external-turn-service.integration.test.ts`

- [ ] **Step 1: Write failing authorization and canonical-content tests**

Seed a materialized external channel. Call:

```ts
await service.request({
  actor,
  channelId,
  userMessageId: "web-user-1",
  assistantMessageId: "web-assistant-1",
});
```

Assert the reader receives only the stored thread ID and authenticated actor ID, then the store
receives the database binding, server-read `users.name`, and reader-returned text. Test a non-member, deleted channel, missing
external binding, wrong channel agent, wrong binding owner, missing canonical message, and repeated
request. All unauthorized/missing channel shapes must produce the same `ExternalTurnNotFoundError`
so membership cannot be probed. Test disabled delivery produces `ExternalDeliveryUnavailableError`
before any rows are queued. Test `status` applies the same authorization and returns only message ID
plus status.

- [ ] **Step 2: Run the service test and verify failure**

Run: `bun test server/tests/external-turn-service.integration.test.ts`

Expected: FAIL because `createExternalTurnService` is missing.

- [ ] **Step 3: Implement the service boundary**

Expose:

```ts
export type ExternalTurnRequest = {
  actor: AgentActor;
  channelId: string;
  userMessageId: string;
  assistantMessageId: string;
};

export type ExternalTurnService = {
  request(input: ExternalTurnRequest): Promise<{ deliveries: ExternalDelivery[] }>;
  status(input: { actor: AgentActor; channelId: string; assistantMessageId: string }): Promise<{ deliveries: ExternalDelivery[] }>;
};
export function createExternalTurnService(options: {
  database: Database;
  reader: CanonicalThreadReader;
  deliveries: ExternalDeliveryStore;
  enabled: () => boolean;
}): ExternalTurnService;
```

Construct the service with `enabled: () => boolean`; `request` throws
`ExternalDeliveryUnavailableError` when false, while `status` may still report already queued work.
Use one database query joining active `channels`, caller `channel_memberships`, `users`,
`intelligence_channel_mappings`, `external_thread_bindings`, and `channel_agents`. Require mapping
user, binding creator, and actor IDs to match, and the channel agent to match the binding agent. Then
call `reader.completedTurn` with `{threadId, userId, userMessageId, assistantMessageId}` and pass the
canonical result plus `users.name ?? "OpenBot user"` to `deliveryStore.enqueueTurn`. `status` uses
the same authorized lookup followed by `deliveryStore.getTurn`.

- [ ] **Step 4: Run the service tests**

Run: `bun test server/tests/external-turn-service.integration.test.ts server/tests/canonical-thread-reader.test.ts server/tests/external-delivery-store.integration.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit verified external turns**

```bash
git add server/src/external/turn-service.ts server/tests/external-turn-service.integration.test.ts
git commit -m "feat: verify completed web turns for delivery"
```

### Task 5: Add the authenticated external-turn HTTP endpoint

**Files:**
- Create: `server/src/external/turn-routes.ts`
- Test: `server/tests/external-turn-routes.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/tests/health.test.ts`

- [ ] **Step 1: Write failing route tests**

Mount `createExternalTurnRoutes(service, requireUser)` at `/api/channels`. Prove
`POST /channel-1/external-turns` rejects unauthenticated callers, non-object bodies, blank IDs,
unknown keys, and identical IDs. A valid body must call the service with the context actor and return:

```json
{
  "deliveries": [
    { "messageId": "web-user-1", "status": "pending" },
    { "messageId": "web-assistant-1", "status": "pending" }
  ]
}
```

The DTO must omit payload, provider destination, provider message ID, and binding identifiers.
Also test `GET /channel-1/external-turns/web-assistant-1` returns the same safe DTO after applying the
same membership check, and that disabled delivery maps to HTTP 503 with `{status:"unavailable"}`.

- [ ] **Step 2: Run the route test and verify failure**

Run: `bun test server/tests/external-turn-routes.test.ts`

Expected: FAIL because the route factory is missing.

- [ ] **Step 3: Implement strict parsing and safe DTO projection**

Accept only this exact body:

```ts
type ExternalTurnBody = {
  userMessageId: string;
  assistantMessageId: string;
};
```

Trim IDs, cap each at 256 code points, reject extra keys, and map service errors to 404/409/502/503
without returning internal error messages. Return 202 for pending/existing deliveries. The GET route
accepts one encoded assistant message ID and delegates authorization to `service.status`.

- [ ] **Step 4: Mount an optional route app before the Copilot catch-all**

Append `externalTurnRoutes?: HonoApp<{ Variables: AppVariables }>` to `createApp` after the current
`slackStatus` argument. Mount it only when supplied:

```ts
if (externalTurnRoutes) app.route("/api/channels", externalTurnRoutes);
```

Keep this before `app.route("/", copilotHandler)`. Add a health test proving the route is mounted and
still passes through authentication.

- [ ] **Step 5: Run route and app tests**

Run: `bun test server/tests/external-turn-routes.test.ts server/tests/health.test.ts server/tests/channel-routes.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Commit the HTTP boundary**

```bash
git add server/src/external/turn-routes.ts server/src/app.ts server/tests/external-turn-routes.test.ts server/tests/health.test.ts
git commit -m "feat: accept verified external channel turns"
```

### Task 6: Implement the narrow Slack thread publisher

**Files:**
- Create: `server/src/slack/thread-publisher.ts`
- Test: `server/tests/slack-thread-publisher.test.ts`

- [ ] **Step 1: Write failing request and classification tests**

Inject `fetch`. Assert one call to `https://slack.com/api/chat.postMessage` with bearer token and JSON
`{channel, thread_ts, text}`. Test user formatting:

```text
Alice via OpenBot
Review this risk
```

Test assistant formatting without pretending it came from the Slack human. Assert 429 becomes
`SlackPublishError("rate_limited", retryAfterMs)`, `ok:false`/ordinary 4xx becomes `rejected`, and
network errors, timeout, invalid JSON, and 5xx become `ambiguous`. Error messages must not contain
token, destination, response body, or message text.

- [ ] **Step 2: Run the publisher test and verify failure**

Run: `bun test server/tests/slack-thread-publisher.test.ts`

Expected: FAIL because `createSlackThreadPublisher` is missing.

- [ ] **Step 3: Implement the publisher interface**

```ts
export type SlackThreadPublisher = {
  post(input: {
    channelId: string;
    threadTs: string;
    role: "user" | "assistant";
    text: string;
    attributionName?: string;
  }): Promise<{ messageTs: string }>;
};
export function createSlackThreadPublisher(options: {
  botToken: string;
  fetch?: typeof globalThis.fetch;
}): SlackThreadPublisher;

export class SlackPublishError extends Error {
  constructor(
    readonly kind: "rate_limited" | "rejected" | "ambiguous",
    readonly retryAfterMs?: number,
  ) {
    super(`Slack publish ${kind}.`);
    this.name = "SlackPublishError";
  }
}
```

Use `AbortSignal.timeout(10_000)`, a bearer authorization header derived from `options.botToken`, and
`content-type: application/json`.
For role `user`, require a nonblank server-derived `attributionName` and format
`${attributionName} via OpenBot\n${text}`; for `assistant`, preserve the canonical text. Require
response `{ok:true, ts:string}`. Do not instantiate a Channels Slack adapter, Socket Mode client, or
event listener.

- [ ] **Step 4: Run publisher tests**

Run: `bun test server/tests/slack-thread-publisher.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit the Slack egress adapter**

```bash
git add server/src/slack/thread-publisher.ts server/tests/slack-thread-publisher.test.ts
git commit -m "feat: publish web turns to Slack threads"
```

### Task 7: Dispatch deliveries without duplicate reposts

**Files:**
- Create: `server/src/external/delivery-worker.ts`
- Test: `server/tests/external-delivery-worker.test.ts`

- [ ] **Step 1: Write failing worker state-machine tests**

With fake store, queue, publisher, and binding reader, test:

- attempt 1 + predecessor sent posts once, marks sent, and finishes work;
- assistant with unsent predecessor releases without publishing;
- rate limit marks pending and releases for the exact bounded retry delay;
- deterministic rejection marks failed and finishes;
- ambiguous result marks unknown and finishes;
- any claimed item with `attempts > 1` marks unknown and finishes without calling Slack;
- missing/terminal delivery finishes harmlessly;
- logs contain only `{type, deliveryId, status}`.

- [ ] **Step 2: Run worker tests and verify failure**

Run: `bun test server/tests/external-delivery-worker.test.ts`

Expected: FAIL because the worker does not exist.

- [ ] **Step 3: Implement one bounded dispatch pass**

Expose:

```ts
export async function dispatchExternalDeliveries(options: {
  owner: string;
  queue: WorkQueue;
  store: ExternalDeliveryStore;
  bindings: ExternalThreadStore;
  publisher: SlackThreadPublisher;
  limit?: number;
}): Promise<number>;
```

Claim kind `slack.thread.message` with a 30-second lease and limit 10. Before any external call,
refuse `attempts > 1` as ambiguous. Resolve channel/thread only from the stored immutable binding.
Parse the stored payload, pass its canonical text, delivery role, and optional server-derived
attribution name to the publisher. Mark delivering, call Slack once, then transition and
finish/release exactly as the tests specify.

- [ ] **Step 4: Add a stoppable polling owner**

Expose `startExternalDeliveryWorker` returning `{stop(): void}`. Use a replica-unique owner
`external-delivery:${crypto.randomUUID()}`, an unref'd interval, and an immediate first pass. The
interval only claims leased PostgreSQL work; it never posts directly from a timer callback without a
claim. Catch pass failures and emit a bounded `external-delivery-worker-failed` event.

- [ ] **Step 5: Run worker and queue tests**

Run: `bun test server/tests/external-delivery-worker.test.ts server/tests/work-queue.integration.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Commit the dispatcher**

```bash
git add server/src/external/delivery-worker.ts server/tests/external-delivery-worker.test.ts
git commit -m "feat: dispatch Slack deliveries safely"
```

### Task 8: Wire configuration, runtime services, and shutdown

**Files:**
- Modify: `server/src/config.ts`
- Modify: `server/tests/config.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write failing configuration tests**

Assert absent token produces no `slackWebEgress`; a nonblank token produces
`{botToken: "xoxb-test"}`; blank values remain absent. Verify no capability endpoint or serialized
config response contains the token.

- [ ] **Step 2: Run configuration tests and verify failure**

Run: `bun test server/tests/config.test.ts server/tests/health.test.ts`

Expected: FAIL because `slackWebEgress` is not defined.

- [ ] **Step 3: Add server-only optional configuration**

```ts
export type SlackWebEgressConfig = { botToken: string };
// in DeploymentConfig
slackWebEgress?: SlackWebEgressConfig;
// in loadConfig result
...(optional(environment, "OPENBOT_SLACK_BOT_TOKEN")
  ? { slackWebEgress: { botToken: optional(environment, "OPENBOT_SLACK_BOT_TOKEN") as string } }
  : {}),
```

Do not add the value to runtime capabilities, app config generation, logs, or audit payloads.

- [ ] **Step 4: Wire the foundation before constructing the Slack channel**

In `server/src/index.ts`, construct:

```ts
const externalChannelMaterializer = createExternalChannelMaterializer(database);
```

Pass it into `agentDeps.materializer`. Build `createCanonicalThreadReader(createIntelligenceClient(
config.runtime.intelligence))`, `createExternalDeliveryStore(database)`, and
`createExternalTurnService({ database, reader: canonicalThreadReader, deliveries: externalDeliveryStore, enabled: () => Boolean(config.slackWebEgress) })`, then mount
`createExternalTurnRoutes(externalTurnService, requireExternalUser)` through the new final `createApp`
argument.

- [ ] **Step 5: Enable only egress when the bot token exists**

Create the publisher and `startExternalDeliveryWorker` only when `config.slackWebEgress` exists.
Always mount the turn route so an externally connected channel can report `unavailable` explicitly
when direct egress is disabled. Add `deliveryWorker.stop()` to the existing orderly shutdown list.
Do not create an app token or second inbound listener.

- [ ] **Step 6: Run server wiring checks**

Run: `bun test server/tests/config.test.ts server/tests/slack-channel-agent.test.ts server/tests/external-turn-routes.test.ts server/tests/slack-lifecycle.test.ts && bun run --cwd server typecheck`

Expected: tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit runtime wiring**

```bash
git add server/src/config.ts server/src/index.ts server/tests/config.test.ts
git commit -m "feat: wire optional Slack web egress"
```

### Task 9: Expose a safe Slack marker and mirror completed web turns

**Files:**
- Modify: `server/src/channels/routes.ts`
- Modify: `server/tests/channel-routes.test.ts`
- Modify: `app/src/lib/channels/queries.ts`
- Modify: `app/src/lib/channels/mutations.ts`
- Create: `app/src/components/channels/external-delivery-status.tsx`
- Modify: `app/src/components/channels/channel-chat.tsx`
- Test: `app/tests/channel-external-delivery.test.tsx`
- Test: `app/tests/channel-queries.test.ts`

- [ ] **Step 1: Write failing safe-projection tests**

Left join `external_thread_bindings` by the authorized channel mapping's thread ID and assert channel
detail/list DTOs expose only:

```ts
externalProvider: "slack" | null;
```

Assert they never include tenant, conversation, thread, or Slack message IDs. Update fake channel
builders in tests with `externalProvider: null`.

- [ ] **Step 2: Run server channel tests and verify failure**

Run: `bun test server/tests/channel-routes.test.ts server/tests/channel-activity.integration.test.ts`

Expected: FAIL until the type, joins, and DTO are updated.

- [ ] **Step 3: Implement the safe marker**

Add `externalProvider` to `AgentChannel`/`ChannelSummary`, select only `externalThreadBindings.provider`,
normalize it to `"slack" | null`, and return it from `channelDto`/`channelSummaryDto`. All membership
filters remain unchanged.

- [ ] **Step 4: Write failing client mutation and chat tests**

Test `requestExternalTurnDeliveryMutationOptions` posts only the two IDs to
`/api/channels/:id/external-turns`. In a `ChannelChat` test, assert an external Slack channel requests
delivery once after a successful run, an ordinary channel never requests it, a failed run never
requests it, and rerender/reload does not resubmit a completed turn. Test
`externalTurnDeliveryQueryOptions` polls the GET status route only while any delivery is pending or
delivering, then stops on sent, failed, unknown, or unavailable.

- [ ] **Step 5: Add the client mutation and status component**

The mutation input is:

```ts
type ExternalTurnMutation = {
  channelId: string;
  userMessageId: string;
  assistantMessageId: string;
};
```

Use the throwing `client`, not `tryClient`, because Slack delivery status is user-visible. Render a
small `ExternalDeliveryStatus` line for Slack channels with `connected`, `sending`, `sent`,
`unavailable`, or `needs review`; do not render provider identifiers. After POST returns, poll
`GET /api/channels/:channelId/external-turns/:assistantMessageId` at one second only while work is
pending/delivering. Map `unknown|failed` to `needs review` and HTTP 503 to `unavailable`.

- [ ] **Step 6: Retain canonical IDs through one completed run**

In `deliver`, assign the user ID before `addMessage`:

```ts
const userMessageId = newId();
target.addMessage({ content: trimmed, id: userMessageId, role: "user" });
await copilotkit.runAgent({ agent: target });
const reply = [...target.messages].reverse().find(
  (message) => message.role === "assistant" && typeof message.content === "string" && message.content.trim(),
);
```

After the complete `runAgent` promise resolves, preserve existing roster activity reporting and, only
for `channel.externalProvider === "slack"`, call the mutation with `userMessageId` and `reply.id`.
Guard each pair in a mount-local `Set<string>` keyed by both IDs so React effects and event callbacks
cannot submit twice. The database uniqueness constraint remains the durable idempotency boundary.
Do not send text or provider IDs from the browser.

- [ ] **Step 7: Run web and server channel tests**

Run: `bun test app/tests/channel-external-delivery.test.tsx app/tests/channel-queries.test.ts app/tests/thread-messages.test.ts server/tests/channel-routes.test.ts`

Expected: all tests PASS.

- [ ] **Step 8: Commit the web continuation UX**

```bash
git add server/src/channels/routes.ts server/tests/channel-routes.test.ts app/src/lib/channels/queries.ts app/src/lib/channels/mutations.ts app/src/components/channels/external-delivery-status.tsx app/src/components/channels/channel-chat.tsx app/tests/channel-external-delivery.test.tsx app/tests/channel-queries.test.ts
git commit -m "feat: mirror completed web turns to Slack"
```

### Task 10: Prove the integrated journey locally

**Files:**
- Test: `server/tests/slack-web-conversation.integration.test.ts`
- Modify as required by failures: only files introduced in Tasks 1-9

- [ ] **Step 1: Write the end-to-end application integration test**

Use the real database stores plus fakes for Intelligence and Slack. Drive this sequence:

1. bind a linked managed Slack thread to a coworker;
2. materialize it twice and assert one web channel;
3. list/open it as owner and reject a second user;
4. restore the fake canonical Slack history;
5. add canonical web user/assistant messages;
6. request the completed external turn twice;
7. dispatch work until empty; and
8. assert exactly two Slack posts, original channel/thread destination, user before assistant, and
   terminal sent rows with cleared payloads.

- [ ] **Step 2: Run the integration test and make only evidence-backed fixes**

Run: `bun test server/tests/slack-web-conversation.integration.test.ts`

Expected: PASS. If canonical managed history cannot be read under the linked OpenBot user, stop and
update the design; do not add a copied transcript fallback.

- [ ] **Step 3: Run focused Slack/web regression tests**

Run:

```bash
bun test \
  server/tests/slack-channel.integration.test.tsx \
  server/tests/slack-channel-agent.test.ts \
  server/tests/slack-identity-linker.test.ts \
  server/tests/external-thread-store.integration.test.ts \
  server/tests/external-channel-materializer.integration.test.ts \
  server/tests/external-delivery-store.integration.test.ts \
  server/tests/external-turn-service.integration.test.ts \
  server/tests/external-delivery-worker.test.ts \
  server/tests/slack-web-conversation.integration.test.ts \
  app/tests/channel-external-delivery.test.tsx \
  app/tests/thread-messages.test.ts
```

Expected: all tests PASS.

- [ ] **Step 4: Commit the integrated regression**

```bash
git add server/tests/slack-web-conversation.integration.test.ts
git commit -m "test: cover the Slack web conversation journey"
```

### Task 11: Document Railway setup, rollback, and video acceptance

**Files:**
- Create: `docs/slack-shared-conversation-demo.md`
- Modify: `.env.example`
- Modify if present: Railway deployment documentation that already owns environment variables

- [ ] **Step 1: Write the production runbook**

Document these exact requirements without values:

```text
Railway pre-deploy command:
cd /app/server && /usr/local/bin/bun scripts/migrate.ts

OpenBot service variable:
OPENBOT_SLACK_BOT_TOKEN=<existing installed OpenBot bot token>

Slack app requirement:
chat:write; existing bot is a member of the demo channel
```

State that no app-level token or Socket Mode connection is added. Rollback removes
`OPENBOT_SLACK_BOT_TOKEN`, redeploys, and leaves managed ingress, web history, and additive schema
intact. Add the thirteen-step recording list verbatim from the approved spec and a redaction
checklist for secrets, email, signed links, unrelated Slack content, and provider IDs. Include an
"Option 1 migration" section linking CopilotKit/CopilotKit#6751 and explaining that the managed
conversation reference/turn API replaces the worker and `SlackThreadPublisher`, while canonical
thread IDs, materialized channels, verified message IDs, and the web UI remain unchanged.

- [ ] **Step 2: Add the variable name to `.env.example`**

Add a commented optional variable with no fake production-looking secret:

```dotenv
# Optional temporary bridge for mirroring completed web turns to Slack.
# OPENBOT_SLACK_BOT_TOKEN=
```

- [ ] **Step 3: Check documentation and secret hygiene**

Run:

```bash
rg -n 'xox[baprs]-[A-Za-z0-9-]{10,}|T05QFA4BW9X|C0BT2D608QM' docs .env.example server app
```

Expected: no token values or hard-coded workspace/channel IDs. The only token matches are variable
names or deliberately synthetic unit-test strings.

- [ ] **Step 4: Commit the runbook**

```bash
git add docs/slack-shared-conversation-demo.md .env.example
git commit -m "docs: add Slack shared conversation runbook"
```

### Task 12: Final verification, deploy, and record acceptance

**Files:**
- Modify only for verified failures: files already in this plan
- Produce outside git: one uncut `.mp4`
- Attach externally: PR or release evidence

- [ ] **Step 1: Run repository quality gates**

Run:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:ci
bun run build
git diff --check
git status --short
```

Expected: every command exits 0; the worktree contains only intended changes and generated migration
artifacts.

- [ ] **Step 2: Review security and failure invariants**

Inspect the final diff and prove: one Slack ingress listener; no token/browser leakage; no provider
destination accepted from HTTP; canonical content read server-side; owner/agent/binding agreement;
unique message idempotency; user-before-assistant ordering; ambiguous outcomes not retried; payload
cleared after success; safe DTOs/logs; direct egress optional.

- [ ] **Step 3: Push and open the PR**

Push the `jerel/` branch, open the PR against the repository's default branch, link
CopilotKit/CopilotKit#6751 as the option-1 follow-up, and include the Notion integration page. Do not
merge until CI and production acceptance are green.

- [ ] **Step 4: Configure and deploy Railway**

Set `OPENBOT_SLACK_BOT_TOKEN` on the OpenBot service through Railway's secret UI/API, confirm the
pre-deploy migration command, deploy the reviewed commit, and wait for terminal success. Never read
the token back into terminal output or logs.

- [ ] **Step 5: Run the live transcript compatibility gate**

Send a fresh linked Slack mention, open the newly materialized channel on the authenticated OpenBot
domain, and verify the exact request/reply restore from Intelligence. If they do not, stop the
rollout and disable direct egress; do not record or copy history.

- [ ] **Step 6: Record the uncut acceptance MP4**

Record all thirteen observations from `docs/slack-shared-conversation-demo.md` in one continuous
file: Railway migration/health, Slack mention/reply, web channel and restored history, web follow-up,
attributed user post and agent reply in the original Slack thread, matching web reply, reload, and no
duplicates. Keep the MP4 outside git and attach it to the PR or release evidence.

- [ ] **Step 7: Merge only after evidence is attached**

Confirm CI, Railway, the live gate, and video are all green. Merge the PR, confirm the merged commit
deploys successfully, and add the final deployment and video links to the PR. If any gate fails,
leave the PR open and preserve the failure state for diagnosis.
