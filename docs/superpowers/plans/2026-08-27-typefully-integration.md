# Typefully Integration, Draft Canvas, and Governed Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a curated, per-user Typefully connection that supports local-first X and LinkedIn drafts, direct text/media editing and autosave in an OpenBot canvas, and immediate publishing only through an immutable, single-use human approval.

**Architecture:** Extend the existing plugin catalogue with a `user-api-key` auth mode and a Typefully REST adapter that conforms to `VendorTransport`, but keep immediate publication outside the Bot-visible tool manifest. Add a Typefully domain store and authenticated routes for owned drafts and publication proposals; compiled React surfaces render bounded inline summaries and load full authoritative data into the channel `DetailPanel`. All remote operations resolve the initiating user's encrypted key, recheck the originating Bot's grants and policy, and audit metadata without draft bodies or secrets.

**Tech Stack:** Bun 1.3.14, TypeScript, Hono, Drizzle/PostgreSQL, React 19, TanStack Query/Router, CopilotKit v2, Zod, Testing Library, Biome.

---

## Ground rules for every task

- Preserve the unrelated Slack/auth work already present in the worktree; stage only files named by the current task.
- Follow red-green-refactor: write the listed focused test, run it and observe the expected failure, implement the smallest production change, then rerun it.
- Never put a Typefully API key, complete unpublished draft, or proposal snapshot into component arguments, transcript messages, URLs, audit payloads, or thrown errors.
- Treat `typefully/publish_now` as a reserved server operation, never as an `mcp_tools` row or Bot-visible tool.
- X and LinkedIn are the only supported destinations. Reject every other destination before proposal creation.
- Use the existing plugin grant ref format (`typefully/tool_name`) and component grant machinery; no grant is implicit.

## Task 1: Add API-key credential and connection schema

**Files:**

- Modify: `server/src/db/schema/core.ts`
- Modify: `server/src/db/schema/plugins.ts`
- Create: `server/src/db/schema/typefully.ts`
- Modify: `server/src/db/schema/index.ts`
- Create via Drizzle: `server/drizzle/0021_*.sql`
- Create via Drizzle: `server/drizzle/meta/0021_snapshot.json`
- Modify via Drizzle: `server/drizzle/meta/_journal.json`
- Test: `server/tests/typefully-schema.integration.test.ts`
- Test: `server/tests/migration-journal.test.ts`

- [ ] **Step 1: Write the schema integration test**

Create `server/tests/typefully-schema.integration.test.ts` to insert one API-key connection, one draft, and one proposal, and to prove the ownership and uniqueness constraints:

```ts
const [connection] = await database
  .insert(mcpUserCredentials)
  .values({
    serverId: "typefully",
    userId,
    credentialId,
    authMethod: "api_key",
    scope: null,
  })
  .returning();
expect(connection?.authMethod).toBe("api_key");

const [draft] = await database
  .insert(typefullyDrafts)
  .values({
    ownerUserId: userId,
    channelId,
    botId,
    document: canonicalDocument,
    version: 1,
    contentHash,
    syncStatus: "local",
  })
  .returning();
expect(draft?.remoteDraftId).toBeNull();

await expect(
  database.insert(typefullyPublicationProposals).values({
    draftId: draft!.id,
    ownerUserId: otherUserId,
    botId,
    channelId,
    draftVersion: 1,
    contentHash,
    snapshot: canonicalDocument,
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
  }),
).rejects.toThrow();
```

The final assertion must be backed by a composite foreign key or equivalent database constraint tying `(draft_id, owner_user_id)` to the owning draft, not merely by application code.

- [ ] **Step 2: Run the schema test and observe the missing exports**

Run: `bun test server/tests/typefully-schema.integration.test.ts`

Expected: FAIL because `typefullyDrafts`, `typefullyPublicationProposals`, `mcp_user_api_key`, and `authMethod` do not exist.

- [ ] **Step 3: Add the credential and association types**

In `server/src/db/schema/core.ts`, add `"mcp_user_api_key"` to `credentialKind`.

In `server/src/db/schema/plugins.ts`, add a closed connection-auth enum and make OAuth scope nullable:

```ts
export const mcpUserAuthMethod = pgEnum("mcp_user_auth_method", [
  "oauth",
  "api_key",
]);

authMethod: mcpUserAuthMethod("auth_method").notNull().default("oauth"),
scope: text("scope"),
```

The migration must backfill existing rows as `oauth` before enforcing `NOT NULL`. OAuth code must continue requiring a non-null scope at its own boundary; API-key code must require `scope === null`.

- [ ] **Step 4: Define the Typefully tables**

Create `server/src/db/schema/typefully.ts` with:

```ts
export const typefullyDrafts = pgTable(
  "typefully_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    remoteDraftId: text("remote_draft_id"),
    document: jsonb("document").notNull(),
    version: integer("version").notNull().default(1),
    contentHash: text("content_hash").notNull(),
    remoteVersion: integer("remote_version"),
    remoteHash: text("remote_hash"),
    syncStatus: text("sync_status").notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("typefully_drafts_id_owner_key").on(table.id, table.ownerUserId),
    index("typefully_drafts_owner_channel_idx").on(table.ownerUserId, table.channelId),
  ],
);
```

Define `typefullyPublicationProposals` with UUID id, draft/owner/bot/channel identities, draft version/hash, JSON snapshot, status, expiry/decision/completion timestamps, remote result identifiers/URLs, bounded failure detail, and timestamps. Add:

- a composite FK `(draft_id, owner_user_id) -> typefully_drafts(id, owner_user_id)`;
- a pending lookup index on `(draft_id, status)`;
- a `CHECK` limiting status to `pending|declined|expired|published|failed|unknown`;
- positive draft versions.

Export the schema from `server/src/db/schema/index.ts`.

- [ ] **Step 5: Generate and inspect migration 0021**

Run: `bun --env-file=.env --cwd server run db:generate`

Expected: a new `0021_*.sql`, snapshot, and journal entry. Inspect the SQL and verify the OAuth backfill precedes `NOT NULL`, the composite ownership FK exists, and no default API key or draft body is present.

- [ ] **Step 6: Run schema and migration tests**

Run: `bun test server/tests/typefully-schema.integration.test.ts server/tests/migration-journal.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the schema slice**

```bash
git add server/src/db/schema/core.ts server/src/db/schema/plugins.ts server/src/db/schema/typefully.ts server/src/db/schema/index.ts server/drizzle server/tests/typefully-schema.integration.test.ts server/tests/migration-journal.test.ts
git commit -m "feat: add Typefully persistence schema"
```

## Task 2: Define and test the canonical draft document

**Files:**

- Create: `server/src/typefully/document.ts`
- Test: `server/tests/typefully-document.test.ts`

- [ ] **Step 1: Write canonicalization tests**

Cover deterministic hashing, X/LinkedIn normalization, media order and alt text, unsupported platforms, and bounded summaries:

```ts
const first = canonicalizeDraft({
  destinations: ["linkedin", "x"],
  posts: [{ id: "post-1", x: " Hello  ", linkedin: "Hello" }],
  media: [{ id: "m-2", order: 2, alt: "second" }, { id: "m-1", order: 1, alt: "first" }],
  socialSetId: "set-1",
  scheduleAt: null,
});
const second = canonicalizeDraft({ ...sameMeaningDifferentKeyOrder });
expect(first.hash).toBe(second.hash);
expect(first.document.destinations).toEqual(["x", "linkedin"]);
expect(first.document.media.map((item) => item.id)).toEqual(["m-1", "m-2"]);
expect(() => canonicalizeDraft({ ...input, destinations: ["threads"] })).toThrow(
  "Threads is not supported in OpenBot yet.",
);
expect(draftSummary(first.document)).not.toHaveProperty("posts");
```

- [ ] **Step 2: Run the test and observe the missing module**

Run: `bun test server/tests/typefully-document.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the closed document model**

Use Zod schemas and exported types:

```ts
export const destinationSchema = z.enum(["x", "linkedin"]);

export const draftDocumentSchema = z.object({
  title: z.string().trim().max(160).default(""),
  destinations: z.array(destinationSchema).min(1).max(2),
  socialSetId: z.string().trim().max(120).nullable(),
  accountLabel: z.string().trim().max(160).nullable(),
  posts: z.array(postBlockSchema).min(1).max(50),
  media: z.array(mediaDescriptorSchema).max(20),
  scheduleAt: z.string().datetime().nullable(),
});

export type CanonicalDraftDocument = z.infer<typeof draftDocumentSchema>;
export function canonicalizeDraft(input: unknown): {
  document: CanonicalDraftDocument;
  serialized: string;
  hash: string;
};
```

Serialize recursively with stable key ordering and hash with SHA-256. Normalize line endings only; do not silently alter meaningful whitespace within post bodies. `draftSummary` returns only draft id/title-or-leading-text, destinations, social-set label, media count, version, sync/proposal status.

- [ ] **Step 4: Run the document tests**

Run: `bun test server/tests/typefully-document.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/typefully/document.ts server/tests/typefully-document.test.ts
git commit -m "feat: define canonical Typefully drafts"
```

## Task 3: Add the curated Typefully REST transport without publish

**Files:**

- Modify: `server/src/plugins/catalogue.ts`
- Modify: `server/src/plugins/transport.ts`
- Create: `server/src/plugins/typefully-rest.ts`
- Modify: `app/src/lib/plugins/queries.ts`
- Test: `server/tests/typefully-rest.test.ts`
- Modify: `server/tests/plugin-catalogue.test.ts`

- [ ] **Step 1: Pin the safe tool manifest in tests**

Write a test that asserts the exact names and proves immediate publish is absent:

```ts
const tools = await typefully.listTools({ url: TYPEFULLY_API_URL });
expect(tools.map((tool) => tool.name)).toEqual([
  "list_social_sets",
  "list_drafts",
  "get_draft",
  "create_draft",
  "update_draft",
  "upload_media",
  "remove_media",
  "schedule_draft",
  "delete_draft",
]);
expect(tools.some((tool) => /publish/i.test(tool.name))).toBeFalse();
```

Also test bearer authentication, timeout, 401 redaction, 429 `Retry-After`, response-size limiting, and canonical result/error shapes against an injected `fetch`.

- [ ] **Step 2: Run the focused tests**

Run: `bun test server/tests/typefully-rest.test.ts server/tests/plugin-catalogue.test.ts`

Expected: FAIL because the transport and auth kind are missing.

- [ ] **Step 3: Extend catalogue auth and transport unions**

Add `{ kind: "user-api-key" }` to `CatalogueAuth`, add `"typefully-rest"` to `TransportKind`, register the adapter, and add the frozen catalogue entry:

```ts
{
  key: "typefully",
  title: "Typefully",
  vendor: "Typefully",
  summary: "Draft and schedule posts in the account of whoever is asking.",
  host: "https://api.typefully.com",
  path: "/v1",
  transport: "typefully-rest",
  auth: { kind: "user-api-key" },
  writeTools: Object.freeze([
    "create_draft", "update_draft", "upload_media", "remove_media",
    "schedule_draft", "delete_draft",
  ]),
  docsUrl: "https://support.typefully.com/en/articles/8718287-typefully-api",
}
```

Update every exhaustive auth-kind assertion and browser-facing `CatalogueItem` union.

- [ ] **Step 4: Implement the adapter**

`server/src/plugins/typefully-rest.ts` must export `listNeedsCredential = false`, the static tool list, and `callTool`. Keep URL construction pinned beneath the catalogue base URL. Accept a `fetch` implementation through a test-only factory while exporting the real adapter functions for `transport.ts`.

Do not implement final publication here. If a caller passes an unlisted tool, fail before network access.

- [ ] **Step 5: Run transport and catalogue tests**

Run: `bun test server/tests/typefully-rest.test.ts server/tests/plugin-catalogue.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/plugins/catalogue.ts server/src/plugins/transport.ts server/src/plugins/typefully-rest.ts server/tests/typefully-rest.test.ts server/tests/plugin-catalogue.test.ts app/src/lib/plugins/queries.ts
git commit -m "feat: add safe Typefully transport"
```

## Task 4: Store, rotate, resolve, and disconnect each user's API key

**Files:**

- Modify: `server/src/plugins/store.ts`
- Modify: `server/src/plugins/routes.ts`
- Modify: `server/src/credentials.ts`
- Create: `server/tests/plugin-user-api-key.integration.test.ts`
- Modify: `server/tests/plugin-routes.integration.test.ts`
- Modify: `server/tests/credentials.test.ts`

- [ ] **Step 1: Write credential-boundary tests**

Test two users with different Typefully keys, missing-key refusal, validation-before-storage, atomic rotation, disconnect, and cross-kind refusal. Capture outbound tokens through the existing injected `callVendor` seam:

```ts
await store.connectUserApiKey({ serverId: "typefully", userId: alice, apiKey: "alice-key", by: alice });
await store.connectUserApiKey({ serverId: "typefully", userId: bob, apiKey: "bob-key", by: bob });
await store.callTool({ ref: "typefully/list_social_sets", args: {}, botId, actorId: alice });
expect(seenTokens).toEqual(["alice-key"]);

await expect(
  store.callTool({ ref: "typefully/list_social_sets", args: {}, botId, actorId: unconnected }),
).rejects.toMatchObject({ code: "connection_required", serverId: "typefully" });
```

Assert OAuth exchange never accepts `mcp_user_api_key`, API-key resolution never accepts `mcp_user_token`, and audit payload JSON does not contain submitted keys.

- [ ] **Step 2: Run the integration test and observe missing methods**

Run: `bun test server/tests/plugin-user-api-key.integration.test.ts server/tests/credentials.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement typed API-key ownership in the plugin store**

Add:

```ts
type ConnectionRequired = {
  code: "connection_required";
  serverId: "typefully";
  connectPath: "/settings/connected-accounts/typefully";
};

connectUserApiKey(input: {
  serverId: string;
  userId: string;
  apiKey: string;
  by: string;
}): Promise<{ serverId: string; authMethod: "api_key"; connectedAt: string }>;

disconnectUserConnection(input: {
  serverId: string;
  userId: string;
  by: string;
}): Promise<void>;
```

Validate the key by calling a harmless Typefully read before opening the rotation transaction. Inside one transaction, revoke the old live `mcp_user_api_key`, create the encrypted replacement keyed by the user id, and upsert `mcp_user_credentials` with `authMethod: "api_key"` and `scope: null`. Bound vendor validation errors and never echo the submitted value.

Update `connectionTokenFor` to switch on the catalogue auth kind and association auth method. A mismatch is a hard refusal; no fallback to server credential, environment, Bot owner, or another user.

- [ ] **Step 4: Add authenticated connect/disconnect routes**

Add:

```text
PUT    /api/plugins/connections/typefully/api-key
DELETE /api/plugins/connections/typefully
```

The PUT accepts only `{ apiKey: string }`, derives `userId` from `context.var.actor`, and returns non-secret connection metadata. The DELETE derives the same user and revokes locally. Extend `GET /api/plugins/connections` with `authMethod` and non-secret `accountLabel` when available.

- [ ] **Step 5: Run credential and route tests**

Run: `bun test server/tests/plugin-user-api-key.integration.test.ts server/tests/plugin-routes.integration.test.ts server/tests/credentials.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/plugins/store.ts server/src/plugins/routes.ts server/src/credentials.ts server/tests/plugin-user-api-key.integration.test.ts server/tests/plugin-routes.integration.test.ts server/tests/credentials.test.ts
git commit -m "feat: connect personal Typefully accounts"
```

## Task 5: Build the owned local draft store with optimistic concurrency

**Files:**

- Create: `server/src/typefully/store.ts`
- Test: `server/tests/typefully-store.integration.test.ts`

- [ ] **Step 1: Write ownership, membership, and version tests**

Cover create/read/update, cross-user refusal, non-member refusal, originating Bot identity, version increments, hash updates, proposal invalidation, and local preservation after grant revocation:

```ts
const created = await store.createDraft({ ownerUserId, channelId, botId, document });
expect(created.version).toBe(1);

const saved = await store.saveDraft({
  draftId: created.id,
  actorId: ownerUserId,
  expectedVersion: 1,
  document: edited,
});
expect(saved.version).toBe(2);

await expect(store.saveDraft({ ...input, expectedVersion: 1 })).rejects.toMatchObject({
  code: "version_conflict",
  currentVersion: 2,
});
await expect(store.readDraft(created.id, otherUserId)).rejects.toThrow("Draft not found");
```

Return the same not-found response for absent, cross-user, and cross-channel requests to avoid disclosing unpublished drafts.

- [ ] **Step 2: Run and observe module-not-found**

Run: `bun test server/tests/typefully-store.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the Typefully store**

Export `createTypefullyStore({ database, plugin, auditStore, vendor })`, where `plugin` is a runtime getter returning the narrow `decide` surface from `PluginStore` (extended with server-operation authorization in Task 7). The getter avoids a construction cycle once local Typefully tools are dispatched through the plugin store in Task 6. The store must:

- verify `(channelId, actorId)` in `channel_memberships` on every owner-facing read/write;
- verify the draft's stored `botId` is still attached to the channel before remote actions;
- compare `expectedVersion` in the update predicate and return a typed 409 conflict;
- canonicalize, hash, increment version, set `syncStatus`, and invalidate pending proposals in one transaction;
- cap `lastError` and audit only ids/version/hash/status/destinations;
- allow local saves after Typefully grants are revoked, while marking remote sync blocked.

Expose narrow methods rather than raw table access:

```ts
createDraft(input): Promise<TypefullyDraft>;
readDraft(draftId, actorId): Promise<TypefullyDraft>;
saveDraft(input): Promise<TypefullyDraft>;
recordRemoteConfirmation(input): Promise<TypefullyDraft>;
recordRemoteFailure(input): Promise<TypefullyDraft>;
```

- [ ] **Step 4: Run the store tests**

Run: `bun test server/tests/typefully-store.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/typefully/store.ts server/tests/typefully-store.integration.test.ts
git commit -m "feat: add local-first Typefully draft store"
```

## Task 6: Add draft routes and remote synchronization

**Files:**

- Create: `server/src/typefully/routes.ts`
- Modify: `server/src/plugins/store.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Create: `server/tests/typefully-routes.integration.test.ts`
- Create: `server/tests/typefully-sync.integration.test.ts`

- [ ] **Step 1: Write the route contract tests**

Cover:

```text
POST  /api/typefully/drafts
GET   /api/typefully/drafts/:id
PUT   /api/typefully/drafts/:id
POST  /api/typefully/drafts/:id/sync
POST  /api/typefully/drafts/:id/media
DELETE /api/typefully/drafts/:id/media/:mediaId
```

Assert bounded summary responses for create, authoritative full document only for the authenticated owner/member GET, `409` with current version on stale saves, `connection_required` on sync without a key, and `403`/`409` for current grant or channel/Bot mismatches.

Also exercise the existing `/api/agent-tools/call` path for `typefully/create_draft` and
`typefully/update_draft`. These two calls must create/update OpenBot's local record before a key
exists, return only the bounded draft summary to the Bot, and retain the actor/Bot identity proven by
the signed run assertion.

- [ ] **Step 2: Write sync failure/recovery tests**

Use an injected fake Typefully vendor to prove:

- first sync creates a remote draft and records remote id/version/hash;
- later sync updates that remote id;
- vendor failure keeps the local document/version and sets `remote_error`;
- retry reconciles and confirms the same local version;
- revoked grant permits local save but blocks sync;
- 429 exposes bounded retry timing without starting an automatic loop;
- media upload failure leaves a failed descriptor that can be retried or removed.

- [ ] **Step 3: Run focused tests**

Run: `bun test server/tests/typefully-routes.integration.test.ts server/tests/typefully-sync.integration.test.ts`

Expected: FAIL because routes and sync orchestration do not exist.

- [ ] **Step 4: Implement routes and sync orchestration**

Create `createTypefullyRoutes(store, requireUser)` and map typed failures to stable JSON:

```ts
{ code: "connection_required", serverId: "typefully", draftId }
{ code: "version_conflict", currentVersion, currentHash }
{ code: "grant_required", ref: "typefully/update_draft" }
{ code: "remote_error", retryAt?: string, message: string }
```

The update route always commits locally first. If connected and the originating Bot still holds the needed grant, sync that exact saved version; otherwise return the saved local draft with an explicit remote state. Media bytes must use a bounded multipart route and never be embedded in JSON or component arguments.

Add a `firstPartyTool` dispatch seam to `PluginStoreOptions`:

```ts
firstPartyTool?: (input: {
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  botId: string;
  actorId: string;
}) => Promise<{ text: string; isError: boolean } | null>;
```

After grant and policy checks, but before credential resolution or vendor access,
`pluginStore.callTool` delegates Typefully's local `create_draft` and `update_draft` operations to
`TypefullyStore.callBotTool`. A `null` result means the normal credential/vendor path continues.
This is the seam that makes local-first drafting possible without weakening grants or inventing a
second callback API. The local result contains the draft id and bounded summary, never the full
document. Sync/list/schedule/media operations continue through actor-scoped credential resolution.

Add an optional `TypefullyStore` parameter at the end of `createApp`, mount `/api/typefully`, construct it beside `pluginStore` in `server/src/index.ts`, and pass the same database/audit/policy-backed plugin store.

Wire the two stores without a construction cycle by giving `TypefullyStore` a runtime getter for the
plugin authorization surface, then passing `typefullyStore.callBotTool` into `createPluginStore`:

```ts
let pluginStore: PluginStore;
const typefullyStore = createTypefullyStore({
  database,
  auditStore: bootAuditStore,
  plugin: () => pluginStore,
});
pluginStore = createPluginStore({
  ...pluginOptions,
  firstPartyTool: typefullyStore.callBotTool,
});
```

- [ ] **Step 5: Run route and sync tests**

Run: `bun test server/tests/typefully-routes.integration.test.ts server/tests/typefully-sync.integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/typefully/routes.ts server/src/plugins/store.ts server/src/app.ts server/src/index.ts server/tests/typefully-routes.integration.test.ts server/tests/typefully-sync.integration.test.ts
git commit -m "feat: add Typefully draft sync routes"
```

## Task 7: Implement immutable publication proposals and the server-only publish gate

**Files:**

- Create: `server/src/typefully/publication.ts`
- Modify: `server/src/typefully/store.ts`
- Modify: `server/src/typefully/routes.ts`
- Modify: `server/src/plugins/store.ts`
- Modify: `server/src/plugins/catalogue.ts`
- Modify: `server/src/plugins/typefully-rest.ts`
- Test: `server/tests/typefully-publication.integration.test.ts`
- Test: `server/tests/typefully-publish-manifest.test.ts`

- [ ] **Step 1: Write the proposal state-machine tests**

Test prepare, decline, expire, changed-local refusal, changed-remote refusal, cross-user refusal, disconnected/refused-grant refusal, two concurrent approvals, vendor rejection, timeout reconciliation, known success, and unknown outcome.

The concurrency assertion must execute two approval requests together and observe one vendor publish:

```ts
const [left, right] = await Promise.allSettled([
  store.approveAndPublish({ proposalId, actorId: ownerUserId }),
  store.approveAndPublish({ proposalId, actorId: ownerUserId }),
]);
expect([left, right].filter((result) => result.status === "fulfilled")).toHaveLength(1);
expect(vendor.publishCalls).toBe(1);
```

Assert a post-approval edit changes the pending proposal to `expired` or an explicit invalidated terminal representation and returns `Changed — review again`.

- [ ] **Step 2: Prove publish is absent from every Bot surface**

Create `server/tests/typefully-publish-manifest.test.ts` and assert:

- `typefully-rest.listTools()` has no publish tool;
- refreshed `mcp_tools` for Typefully has no publish row;
- `plugins/for/:botId` cannot return a publish ref even if a stale grant row is inserted manually;
- `/api/agent-tools/call` with a publish-like Typefully name is refused before network access.

The manifest may expose `prepare_publication`, which only snapshots an already-saved draft into a
proposal. The test must distinguish that reversible preparation step from final publication.

- [ ] **Step 3: Run publication tests**

Run: `bun test server/tests/typefully-publication.integration.test.ts server/tests/typefully-publish-manifest.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement proposal preparation**

`prepareProposal` must require a fully locally saved and remotely confirmed version, supported destinations, live actor credential, current Bot grants, and passing policy. In one transaction it invalidates older pending proposals and inserts an immutable canonical snapshot with a short explicit expiry (default 15 minutes).

Return only:

```ts
type ProposalSummary = {
  id: string;
  draftId: string;
  version: number;
  destinations: ("x" | "linkedin")[];
  expiresAt: string;
  status: ProposalStatus;
};
```

Add `prepare_publication` to the Typefully tool manifest and write classifications, and handle it in
`TypefullyStore.callBotTool` through the first-party dispatch from Task 6. It requires the same tool
grant and policy checks as every Typefully write, returns the bounded `ProposalSummary`, and never
publishes. Keep `publish`, `publish_now`, and every equivalent final operation absent.

- [ ] **Step 5: Implement approve/decline and final publication**

Add authenticated routes:

```text
POST /api/typefully/drafts/:id/proposals
GET  /api/typefully/proposals/:id
POST /api/typefully/proposals/:id/decline
POST /api/typefully/proposals/:id/publish
POST /api/typefully/proposals/:id/reconcile
```

The publish transaction must lock the proposal row with `SELECT ... FOR UPDATE`, verify owner/pending/expiry/single-use, re-read local version/hash, resolve the actor's live API key, recheck Bot grants and policy, fetch the remote draft, and compare its canonical snapshot before calling the dedicated vendor publish function.

Add a server-only `pluginStore.authorizeOperation` method that performs the existing grant and action-policy evaluation without advertising or calling a vendor tool. The final route requires the Bot still hold `typefully/prepare_publication`, then calls the method with an explicit policy context `{ mcp: { server: "typefully", tool: "publish_now", effect: "write" }, intent: "write_tool" }`. Keep this method off every HTTP response and model manifest; it exists solely so the proposal endpoint reuses the same live grant/policy boundary instead of duplicating or bypassing it.

Do not automatically retry a timed-out publish. Reconcile first using vendor draft/publication state. Set `unknown` when the result cannot be proven; `unknown` is terminal for automatic execution.

Audit lifecycle metadata only: proposal/draft ids, actor/Bot/channel, version/hash, destinations, decision, policy, and outcome. Never audit the snapshot.

- [ ] **Step 6: Run publication tests**

Run: `bun test server/tests/typefully-publication.integration.test.ts server/tests/typefully-publish-manifest.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/typefully/publication.ts server/src/typefully/store.ts server/src/typefully/routes.ts server/src/plugins/store.ts server/src/plugins/catalogue.ts server/src/plugins/typefully-rest.ts server/tests/typefully-publication.integration.test.ts server/tests/typefully-publish-manifest.test.ts
git commit -m "feat: enforce approved Typefully publishing"
```

## Task 8: Add frontend Typefully data contracts and autosave state

**Files:**

- Create: `app/src/lib/typefully/queries.ts`
- Create: `app/src/lib/typefully/mutations.ts`
- Create: `app/src/lib/typefully/autosave.ts`
- Test: `app/tests/typefully-client.test.ts`
- Test: `app/tests/typefully-autosave.test.ts`

- [ ] **Step 1: Write client contract tests**

Capture fetch calls and assert exact routes/bodies for load, save with `expectedVersion`, sync, media, proposal, publish, decline, connect, and disconnect. Verify `apiKey` appears only in the connect request body and never in query keys or thrown messages.

- [ ] **Step 2: Write autosave reducer tests**

Model states explicitly:

```ts
type AutosaveState =
  | { kind: "idle"; version: number; remote: "local" | "confirmed" }
  | { kind: "dirty"; baseVersion: number }
  | { kind: "saving"; baseVersion: number }
  | { kind: "saved"; version: number; remote: "local" | "confirmed" }
  | { kind: "conflict"; local: CanonicalDraftDocument; currentVersion: number }
  | { kind: "error"; local: CanonicalDraftDocument; message: string };
```

Test one debounced request for a burst of text edits, immediate save after settled media mutation, no publish while dirty/saving/error/conflict, stale response suppression, and cleanup on unmount.

- [ ] **Step 3: Run tests and observe missing modules**

Run: `bun test app/tests/typefully-client.test.ts app/tests/typefully-autosave.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement query/mutation options and autosave controller**

Use stable keys under `typefullyKeys`, central response types, and a 600 ms text debounce. Keep unsaved local text in React state when a 409 occurs and expose `reload` and `saveAsNewDraft` actions; never overwrite it automatically.

- [ ] **Step 5: Run tests**

Run: `bun test app/tests/typefully-client.test.ts app/tests/typefully-autosave.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/typefully/queries.ts app/src/lib/typefully/mutations.ts app/src/lib/typefully/autosave.ts app/tests/typefully-client.test.ts app/tests/typefully-autosave.test.ts
git commit -m "feat: add Typefully client state"
```

## Task 9: Add the inline draft render component

**Files:**

- Create: `app/src/components/gallery/typefully-draft.tsx`
- Modify: `app/src/lib/copilot/gallery-registry.ts`
- Test: `app/tests/typefully-draft-component.test.tsx`

- [ ] **Step 1: Write render and navigation tests**

Render every durable status and assert the card shows only bounded summary data, destinations, social set, media count, and `Review draft`. Clicking review must navigate to the same channel with `{ draft: draftId }` search state. Include grant-revoked and unavailable-draft refusals.

- [ ] **Step 2: Run the component test**

Run: `bun test app/tests/typefully-draft-component.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement and register the compiled component**

Register a normal gallery tool named `showTypefullyDraft` with parameters limited to:

```ts
{
  draftId: string;
  title: string;
  destinations: ("x" | "linkedin")[];
  socialSetLabel?: string;
  mediaCount: number;
  version: number;
  status: DraftDisplayStatus;
}
```

The component must not accept post bodies, media URLs, proposal snapshots, credential state, or user ids. Use existing `GalleryFrame` and button primitives, and load no full draft until the owner opens the panel.

- [ ] **Step 4: Run the test**

Run: `bun test app/tests/typefully-draft-component.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/gallery/typefully-draft.tsx app/src/lib/copilot/gallery-registry.ts app/tests/typefully-draft-component.test.tsx
git commit -m "feat: render Typefully draft summaries"
```

## Task 10: Open the Typefully canvas in the channel detail panel

**Files:**

- Modify: `app/src/routes/_authed/_app/channel/$channelId.tsx`
- Create: `app/src/components/typefully/draft-canvas.tsx`
- Create: `app/src/components/typefully/canvas-shell.tsx`
- Test: `app/tests/typefully-channel-panel.test.tsx`
- Test: `app/tests/typefully-canvas-shell.test.tsx`

- [ ] **Step 1: Write routing tests**

Extend channel search validation with `draft: z.string().uuid().optional()`. Assert a URL-opened draft panel loads after refresh, Back/close removes only `draft`, and opening settings/watch/draft makes the other panel flags undefined. Assert detail width is wider on desktop (use 720 px) and the canvas collapses into the main surface under the app's narrow breakpoint.

- [ ] **Step 2: Run route tests**

Run: `bun test app/tests/typefully-channel-panel.test.tsx app/tests/typefully-canvas-shell.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement exclusive panel routing**

Change the channel helper to:

```ts
const show = (next: { kind: "settings" } | { kind: "watch" } | { kind: "draft"; id: string } | null) =>
  navigate({
    search: (previous) => ({
      ...previous,
      settings: next?.kind === "settings" ? true : undefined,
      watch: next?.kind === "watch" ? true : undefined,
      draft: next?.kind === "draft" ? next.id : undefined,
    }),
  });
```

Render `DraftCanvas` in `DetailPanel` with title and 720 px width. Keep current watch/settings behavior and dismissal semantics intact.

- [ ] **Step 4: Implement the accessible canvas shell**

Provide labelled editing/preview regions, keyboard-reachable platform and viewport controls, sticky save/publish status, reduced-motion behavior, and responsive collapse. At this task the canvas may render read-only authoritative draft data; editing arrives next.

- [ ] **Step 5: Run route and shell tests**

Run: `bun test app/tests/typefully-channel-panel.test.tsx app/tests/typefully-canvas-shell.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add 'app/src/routes/_authed/_app/channel/$channelId.tsx' app/src/components/typefully/draft-canvas.tsx app/src/components/typefully/canvas-shell.tsx app/tests/typefully-channel-panel.test.tsx app/tests/typefully-canvas-shell.test.tsx
git commit -m "feat: open Typefully drafts in channel canvas"
```

## Task 11: Add direct text/media editing, realistic previews, and autosave

**Files:**

- Create: `app/src/components/typefully/draft-editor.tsx`
- Create: `app/src/components/typefully/media-editor.tsx`
- Create: `app/src/components/typefully/platform-preview.tsx`
- Create: `app/src/lib/typefully/preview.ts`
- Modify: `app/src/components/typefully/draft-canvas.tsx`
- Test: `app/tests/typefully-editor.test.tsx`
- Test: `app/tests/typefully-preview.test.tsx`
- Test: `app/tests/typefully-media.test.tsx`

- [ ] **Step 1: Write preview contract tests**

Pin X thread separators/counts, LinkedIn formatting, media/alt-text ordering, account label, and desktop/mobile layouts against canonical document fixtures. Verify unsupported destinations render a clear Typefully handoff and never a fake preview.

- [ ] **Step 2: Write editing and media tests**

Using fake timers and mocked mutation options, cover:

- direct X and LinkedIn variant edits;
- adding/removing/reordering post blocks;
- destination toggles;
- 600 ms debounced text autosave and visible `Saving…`/`Saved in OpenBot`/`Saved to Typefully`;
- upload progress, failed attachment Retry/Remove, ordering, and alt text;
- conflict preserving unsaved text with Reload/Save as new;
- remote outage preserving local save and disabling publish;
- publishing disabled for dirty/saving/error/conflict/media-failure states.

- [ ] **Step 3: Run focused UI tests**

Run: `bun test app/tests/typefully-editor.test.tsx app/tests/typefully-preview.test.tsx app/tests/typefully-media.test.tsx`

Expected: FAIL.

- [ ] **Step 4: Implement editing and previews**

Keep one optimistic canonical document in `DraftCanvas`, pass focused slices to editor/media/preview, and send the whole canonical document with `expectedVersion` on save. Treat the server response as the new authority only if it corresponds to the latest save sequence.

Provide explicit desktop/mobile preview toggles and X/LinkedIn tabs. Use OpenBot theme/accessibility primitives while matching native post hierarchy and Typefully's focused editor/preview relationship; do not reproduce Typefully navigation chrome.

- [ ] **Step 5: Run focused UI tests**

Run: `bun test app/tests/typefully-editor.test.tsx app/tests/typefully-preview.test.tsx app/tests/typefully-media.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/typefully app/src/lib/typefully/preview.ts app/tests/typefully-editor.test.tsx app/tests/typefully-preview.test.tsx app/tests/typefully-media.test.tsx
git commit -m "feat: edit and preview Typefully drafts"
```

## Task 12: Add progressive Typefully connection and resume

**Files:**

- Modify: `app/src/routes/_authed/settings/connected-accounts/index.tsx`
- Modify: `app/src/routes/_authed/settings/connected-accounts/$key.tsx`
- Modify: `app/src/lib/plugins/queries.ts`
- Modify: `app/src/lib/plugins/mutations.ts`
- Create: `app/src/components/typefully/connect-typefully.tsx`
- Create: `app/src/components/gallery/typefully-connection.tsx`
- Modify: `app/src/lib/copilot/gallery-registry.ts`
- Modify: `app/src/lib/copilot/gallery-tools.tsx`
- Modify: `app/src/components/typefully/draft-canvas.tsx`
- Test: `app/tests/typefully-connection.test.tsx`
- Test: `app/tests/typefully-resume.test.tsx`

- [ ] **Step 1: Write settings and inline connection tests**

Assert Typefully appears for `user-api-key`, its page uses a password/write-only field and official key-settings link, successful connect clears the field and invalidates connections, invalid key remains only in current form state, timeout permits explicit retry, cancel preserves the local draft, and disconnect restores local-only state.

Assert the key never appears in DOM after success, URL/search state, query cache, error text, or serialized draft/component data.

- [ ] **Step 2: Write pending-operation resume tests**

Model pending operations as non-secret local state:

```ts
type PendingTypefullyOperation =
  | { kind: "sync"; draftId: string }
  | { kind: "schedule"; draftId: string; expectedVersion: number }
  | { kind: "prepare_publication"; draftId: string; expectedVersion: number };
```

Test missing-key response -> connection panel -> successful connection -> exactly one resumed operation. Cancel and component unmount must not execute it. A changed draft version must revalidate rather than resume stale input.

Add a Bot-initiated case using a specialized suspended decision component. Its arguments are bounded and non-secret:

```ts
{
  draftId: string;
  operation: "sync" | "schedule" | "prepare_publication";
  expectedVersion: number;
}
```

After connection it must re-fetch the authoritative draft, execute the named operation once, and call `respond` once with the structured outcome so the suspended Bot run resumes. Cancel responds with a declined connection outcome while preserving the draft; it never performs the operation.

- [ ] **Step 3: Run connection tests**

Run: `bun test app/tests/typefully-connection.test.tsx app/tests/typefully-resume.test.tsx`

Expected: FAIL.

- [ ] **Step 4: Extend connected-account UI for API keys**

Include both `user-oauth` and `user-api-key` entries in the connected-account list. Branch the detail page by auth type: OAuth keeps redirect behavior; Typefully renders `ConnectTypefully`, rotates with PUT, and disconnects with DELETE. Add `authMethod` to `PluginConnection` and the catalogue union.

- [ ] **Step 5: Resume from the draft canvas**

On structured `connection_required`, retain the pending operation in component state and show the connection form inside the same detail-panel canvas. After connect, refetch the connection and authoritative draft, revalidate version/grants, then invoke the operation once. Do not put the pending operation or key into the transcript or URL.

Register `connectTypefullyAccount` as a dedicated `useHumanInTheLoop` component in `typefully-connection.tsx`. The tenant skill can call it after a Typefully tool returns `connection_required`; its renderer reuses `ConnectTypefully`, opens the draft canvas, and resumes only the bounded operation above. Keep it separately grantable like every compiled component—adding the connector or skill must not publish the component automatically.

- [ ] **Step 6: Run tests**

Run: `bun test app/tests/typefully-connection.test.tsx app/tests/typefully-resume.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add 'app/src/routes/_authed/settings/connected-accounts/index.tsx' 'app/src/routes/_authed/settings/connected-accounts/$key.tsx' app/src/lib/plugins/queries.ts app/src/lib/plugins/mutations.ts app/src/components/typefully/connect-typefully.tsx app/src/components/gallery/typefully-connection.tsx app/src/lib/copilot/gallery-registry.ts app/src/lib/copilot/gallery-tools.tsx app/src/components/typefully/draft-canvas.tsx app/tests/typefully-connection.test.tsx app/tests/typefully-resume.test.tsx
git commit -m "feat: connect Typefully when drafts need it"
```

## Task 13: Render and complete specialized HITL publication

**Files:**

- Create: `app/src/components/gallery/typefully-publication.tsx`
- Modify: `app/src/lib/copilot/gallery-tools.tsx`
- Modify: `app/src/lib/copilot/gallery-registry.ts`
- Modify: `app/src/components/typefully/draft-canvas.tsx`
- Test: `app/tests/typefully-publication-component.test.tsx`
- Test: `app/tests/typefully-publication-flow.test.tsx`

- [ ] **Step 1: Write HITL render tests**

Test pending, decline, expired, changed-review-again, publish success, vendor failure, and unknown status. The HITL args must contain only proposal id and bounded summary. The side panel must fetch the authoritative proposal snapshot and show exactly what the server will compare/publish.

Test that `respond` is called once with a structured outcome after decline/publish/refusal, and that closing the canvas leaves the suspended decision pending rather than approving it.

- [ ] **Step 2: Write user-initiated publication tests**

From a clean remotely confirmed draft, clicking `Publish now` must first create a proposal and then require a second explicit `Publish now` on the proposal review. An edit between those actions must invalidate the proposal. Publishing must stay disabled during unsaved/failed sync.

- [ ] **Step 3: Run publication component tests**

Run: `bun test app/tests/typefully-publication-component.test.tsx app/tests/typefully-publication-flow.test.tsx`

Expected: FAIL.

- [ ] **Step 4: Register a specialized decision component**

Add `approveTypefullyPublication` as a `useHumanInTheLoop` component, but do not use generic `askApproval`. Its model-facing parameters are:

```ts
{
  proposalId: string;
  draftId: string;
  destinations: ("x" | "linkedin")[];
  version: number;
  expiresAt: string;
}
```

Its renderer opens/links the proposal in the canvas. The approval button calls only `/api/typefully/proposals/:id/publish`; there is no frontend call to a raw Typefully publish tool.

- [ ] **Step 5: Implement proposal review in the canvas**

Show immutable content/media/destinations, expiry, and current status. Keep `Decline` and `Publish now` distinct and accessible. For `unknown`, display **Publishing status unknown**, disable repeat, and offer only reconciliation/manual Typefully handoff. For changed/expired, offer preparation of a new proposal rather than reuse.

- [ ] **Step 6: Run tests**

Run: `bun test app/tests/typefully-publication-component.test.tsx app/tests/typefully-publication-flow.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/components/gallery/typefully-publication.tsx app/src/lib/copilot/gallery-tools.tsx app/src/lib/copilot/gallery-registry.ts app/src/components/typefully/draft-canvas.tsx app/tests/typefully-publication-component.test.tsx app/tests/typefully-publication-flow.test.tsx
git commit -m "feat: add governed Typefully publication review"
```

## Task 14: Add tenant skills and the end-to-end journey

**Files:**

- Modify: `examples/fintech/skills.yaml`
- Modify: `examples/fintech/agents.yaml`
- Create: `server/tests/typefully-tenant-package.test.ts`
- Create: `tests/smoke/typefully-journey.test.ts`
- Modify: `.env.example` only if the smoke fake-vendor URL needs a documented test variable

- [ ] **Step 1: Write the tenant package test**

Add a Typefully drafting skill whose declared tool refs may exist before the connector is enabled. Assert package sync creates the skill association but no `mcp_servers`, `mcp_tools`, `plugin_grants`, component grants, or credentials implicitly.

- [ ] **Step 2: Add a preset Bot skill association**

In the fintech example, attach the drafting skill to the intended preset Bot. The instruction should tell the Bot to create a local X/LinkedIn draft, render `showTypefullyDraft`, invoke `connectTypefullyAccount` only after a remote operation returns `connection_required`, and prepare `approveTypefullyPublication` for immediate publishing. It must never ask the user to paste a key into chat.

- [ ] **Step 3: Write the smoke journey**

Use a fake Typefully vendor and execute the approved journey:

1. unconnected user creates local X/LinkedIn draft;
2. inline card opens reloadable canvas;
3. text/media edits save locally;
4. sync returns connection-required;
5. API key connects and the one pending sync resumes;
6. first proposal becomes invalid after an edit;
7. second proposal is approved;
8. exactly one publish reaches the fake vendor;
9. terminal transcript status and audit metadata are present;
10. key and full draft body are absent from transcript/component args/audit rows.

- [ ] **Step 4: Run package and smoke tests**

Run: `bun test server/tests/typefully-tenant-package.test.ts`

Expected: PASS.

Run: `OPENBOT_SMOKE=1 bun test tests/smoke/typefully-journey.test.ts`

Expected: PASS with the smoke database and fake vendor configured.

- [ ] **Step 5: Commit**

```bash
git add examples/fintech/skills.yaml examples/fintech/agents.yaml server/tests/typefully-tenant-package.test.ts tests/smoke/typefully-journey.test.ts .env.example
git commit -m "feat: add Typefully preset workflow"
```

## Task 15: Run security regressions and full verification

**Files:**

- Modify only files required to fix failures introduced by this feature

- [ ] **Step 1: Run focused backend security suites**

Run:

```bash
bun test server/tests/typefully-document.test.ts server/tests/typefully-rest.test.ts server/tests/plugin-user-api-key.integration.test.ts server/tests/typefully-store.integration.test.ts server/tests/typefully-routes.integration.test.ts server/tests/typefully-sync.integration.test.ts server/tests/typefully-publication.integration.test.ts server/tests/typefully-publish-manifest.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run existing connector regressions**

Run:

```bash
bun test server/tests/plugin-catalogue.test.ts server/tests/plugin-user-credential.integration.test.ts server/tests/plugin-credential-rotation.integration.test.ts server/tests/plugin-connect-route.test.ts server/tests/plugin-routes.integration.test.ts server/tests/plugin-store.integration.test.ts server/tests/credentials.test.ts
```

Expected: PASS; Notion and Google Drive OAuth behavior is unchanged.

- [ ] **Step 3: Run focused frontend suites**

Run:

```bash
bun test app/tests/typefully-client.test.ts app/tests/typefully-autosave.test.ts app/tests/typefully-draft-component.test.tsx app/tests/typefully-channel-panel.test.tsx app/tests/typefully-canvas-shell.test.tsx app/tests/typefully-editor.test.tsx app/tests/typefully-preview.test.tsx app/tests/typefully-media.test.tsx app/tests/typefully-connection.test.tsx app/tests/typefully-resume.test.tsx app/tests/typefully-publication-component.test.tsx app/tests/typefully-publication-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run repository quality gates**

Run in order:

```bash
bun run format
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
```

Expected: every command exits 0. Review formatter changes before staging and exclude unrelated pre-existing worktree files.

- [ ] **Step 5: Perform explicit leak and reachability checks**

Run:

```bash
rg -n "publish_now|publishNow|immediate_publish" server/src app/src
rg -n "apiKey|api_key" app/src/components/gallery app/src/lib/copilot server/src/typefully
```

Expected:

- publish references exist only in the dedicated authenticated proposal path and UI client, never the Typefully tool manifest or agent callback path;
- API-key references are limited to the write-only connection form/route, typed credential handling, and tests;
- no component schema includes a secret, complete draft document, or proposal snapshot.

- [ ] **Step 6: Inspect the final diff and commit verification fixes**

Run:

```bash
git status --short
git diff --stat HEAD~14..HEAD
git diff --check
```

Expected: no whitespace errors; unrelated Slack/auth files remain unstaged and unchanged by this work.

If verification required changes, inspect `git diff --name-only`, stage only the Typefully-related paths from that output, and commit them. Do not stage by directory if the output includes an unrelated pre-existing file.

```bash
git commit -m "test: verify Typefully publishing boundary"
```

## Completion checklist

- [ ] A user can create and edit a local draft with no Typefully key.
- [ ] A remote action asks for that user's key and resumes only the still-valid pending operation.
- [ ] Two people using one Bot resolve different encrypted keys with no fallback.
- [ ] The inline card is bounded; the full draft loads only for the owner/member in the canvas.
- [ ] Text and media edits autosave with visible local/remote/error/conflict states.
- [ ] X and LinkedIn desktop/mobile previews reflect the canonical saved document.
- [ ] Revoked grants permit local preservation but block remote sync, scheduling, and publication.
- [ ] Immediate publish is absent from every Bot-visible tool manifest and callback route.
- [ ] Approval is immutable, expiring, owner-bound, version/hash-bound, remote-reconciled, and single-use.
- [ ] Ambiguous vendor outcomes never trigger an automatic repeat.
- [ ] Audit rows contain lifecycle metadata but no key, full unpublished body, or proposal snapshot.
- [ ] Notion, Google Drive, custom MCP, and existing gallery components pass regressions.
