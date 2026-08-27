# Slack OpenBot Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one managed `@OpenBot` Slack assistant that links Slack people to OpenBot users, pins each Slack thread to one accessible coworker, and runs that coworker with the speaker's current tools and policy.

**Architecture:** `@copilotkit/channels` owns managed Slack delivery, thread subscriptions, streaming, files, deduplication, and continuation rendering. OpenBot adds durable external identity/thread stores, a reusable actor-scoped agent resolver, a server-private per-turn execution context, and a delegating `AbstractAgent`; Slack handlers never place OpenBot identity metadata in the model prompt. Existing plugin tools and `ComputerGateway` remain the enforcement paths.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle/PostgreSQL, AG-UI, CopilotKit Runtime 1.69, `@copilotkit/channels` 0.9, RxJS, Zod, TanStack Router, Bun test.

---

## File structure

### Existing files to modify

- `server/package.json` — add the Channels public package.
- `bun.lock` — record the exact Channels dependency graph.
- `server/tsconfig.json` — enable the Channels JSX runtime for Slack-native messages.
- `server/src/copilot.ts` — accept one reusable actor-scoped agent resolver and pass Channels into `CopilotRuntime`.
- `server/src/index.ts` — construct the Slack services/channel, activate Channels, expose status, and stop it during shutdown.
- `server/src/app.ts` — mount authenticated account-link completion and expose projected Channel readiness.
- `server/src/db/schema/core.ts` — declare external user links and thread bindings.
- `server/src/routing/routes.ts` — call the shared coworker routing service instead of maintaining a second routing implementation.
- `app/src/lib/copilot/computer-tools.tsx` — import shared computer tool schemas/descriptions while preserving web handlers/renderers.
- `app/src/routeTree.gen.ts` — generated TanStack route entry for the Slack link confirmation page.
- `.env.example`, `docs/configuration.md`, `docs/architecture.md` — document managed Slack setup and operating limits.

### New focused files

- `server/src/agents/agent-resolver.ts` — build all visible agents for an actor or exactly one named agent.
- `server/src/external/schema-types.ts` — provider identity and thread metadata types shared by stores and Slack code.
- `server/src/external/link-store.ts` — durable provider-user links and verified-email lookup.
- `server/src/external/thread-store.ts` — immutable external thread bindings with race-safe insert/reload.
- `server/src/external/link-token.ts` — sealed, expiring, provider-bound account-link claims.
- `server/src/external/routes.ts` — authenticated link inspection/completion endpoints.
- `server/src/routing/service.ts` — explicit-name and intent-based coworker selection plus the canonical audit write.
- `server/src/slack/ingress-registry.ts` — short-lived handoff from Channels identity resolution to the matching handler event.
- `server/src/slack/identity-linker.ts` — resolve an existing link or perform the one allowed exact-email bootstrap.
- `server/src/slack/execution-context.ts` — `AsyncLocalStorage` context for current OpenBot actor/provider turn.
- `server/src/slack/channel-agent.ts` — delegating `AbstractAgent` that pins/resolves one coworker and forwards AG-UI events.
- `server/src/slack/channel.tsx` — the managed `openbot` Channel declaration and Slack-native messages/interactions.
- `server/src/slack/status.ts` — projected lifecycle/readiness state without credentials.
- `shared/computer-tool-contracts.ts` — platform-neutral Zod schemas and descriptions.
- `server/src/slack/computer-tools.ts` — Channels tools that invoke `ComputerGateway` directly.
- `server/src/slack/assistance.ts` — bounded server-side wait and secure OpenBot control links.
- `server/src/slack/assistance-token.ts` — sealed ten-minute control claim bound to the linked OpenBot user.
- `server/src/slack/components.tsx` — portable approval and secure-link Slack UI.
- `app/src/routes/_authed/link/slack.tsx` — authenticated account-link confirmation page.
- `app/src/routes/_authed/assist.tsx` — validate an assistance claim before opening the coworker's control screen.
- `docs/slack.md` — provider setup, linking, security limits, and smoke-test instructions.

### Tests to add

- `server/tests/agent-resolver.test.ts`
- `server/tests/external-link-store.integration.test.ts`
- `server/tests/external-thread-store.integration.test.ts`
- `server/tests/external-link-token.test.ts`
- `server/tests/external-link-routes.test.ts`
- `server/tests/routing-service.test.ts`
- `server/tests/slack-ingress-registry.test.ts`
- `server/tests/slack-identity-linker.test.ts`
- `server/tests/slack-channel-agent.test.ts`
- `server/tests/slack-computer-tools.test.ts`
- `server/tests/slack-assistance.test.ts`
- `server/tests/slack-channel.integration.test.tsx`
- `server/tests/slack-lifecycle.test.ts`
- `app/tests/slack-link-route.test.ts`
- `app/tests/slack-assist-route.test.ts`

## Task 1: Install Channels and extract the reusable actor-scoped agent resolver

**Files:**
- Modify: `server/package.json`
- Modify: `bun.lock`
- Create: `server/src/agents/agent-resolver.ts`
- Modify: `server/src/copilot.ts`
- Modify: `server/src/index.ts`
- Create: `server/tests/agent-resolver.test.ts`
- Modify: `server/tests/copilot.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Create `server/tests/agent-resolver.test.ts` with a fake registered-agent loader and assert both the web map and single-agent paths use the same actor:

```ts
import { describe, expect, test } from "bun:test";
import { createActorAgentResolver } from "../src/agents/agent-resolver";

const actor = { id: "u1", role: "user" as const };

describe("actor-scoped agent resolver", () => {
  test("resolves the visible map and one requested coworker from the same actor", async () => {
    const seen: string[] = [];
    const resolver = createActorAgentResolver({
      loadAgents: async (value) => {
        seen.push(value.id);
        return [{
          id: "risk",
          name: "Risk Analyst",
          type: "built_in",
          systemPrompt: "Review risk.",
        }];
      },
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey: async () => "key",
    });

    expect(Object.keys(await resolver.resolveAgentsForActor(actor))).toEqual(["risk"]);
    expect((await resolver.resolveAgentForActor(actor, "risk")).agentId).toBe("risk");
    expect(seen).toEqual(["u1", "u1"]);
  });

  test("refuses an agent absent from the current actor's visible map", async () => {
    const resolver = createActorAgentResolver({
      loadAgents: async () => [],
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey: async () => null,
    });

    await expect(resolver.resolveAgentForActor(actor, "private-risk"))
      .rejects.toThrow("Coworker private-risk is unavailable to this user.");
  });
});
```

- [ ] **Step 2: Run the new tests and verify the module is missing**

Run: `bun test server/tests/agent-resolver.test.ts`

Expected: FAIL with `Cannot find module '../src/agents/agent-resolver'`.

- [ ] **Step 3: Implement the resolver service**

Create `server/src/agents/agent-resolver.ts` with the dependency object currently passed separately through `mountCopilotRuntime` and `createRequestAgents`:

```ts
import type { AbstractAgent } from "@ag-ui/client";
import type { AgentActor } from "./profile-types";
import type {
  LoadAgentsForActor,
  LoadToolsForBot,
  RuntimeModel,
  SignRun,
  ToolSelection,
} from "../copilot";
import { resolveRuntimeAgents } from "../copilot";
import type { AgentFetch, StallGuard } from "../channels/stall-guard";

export type ActorAgentResolver = {
  resolveAgentsForActor(actor: AgentActor): Promise<Record<string, AbstractAgent>>;
  resolveAgentForActor(actor: AgentActor, agentId: string): Promise<AbstractAgent>;
};

export function createActorAgentResolver(deps: {
  loadAgents: LoadAgentsForActor;
  model: RuntimeModel;
  resolveModelApiKey: () => Promise<string | null>;
  stallGuard?: StallGuard;
  loadToolsForActor?: (actorId: string) => LoadToolsForBot;
  signRunForActor?: (actorId: string) => SignRun;
  computerGuidance?: string;
  loadVendors?: () => Promise<readonly string[]>;
  selectionForActor?: (actorId: string) => ToolSelection;
  agentFetch?: AgentFetch;
}): ActorAgentResolver {
  const resolveAgentsForActor = (actor: AgentActor) =>
    resolveRuntimeAgents(
      () => deps.loadAgents(actor),
      deps.model,
      deps.resolveModelApiKey,
      deps.stallGuard,
      deps.loadToolsForActor?.(actor.id),
      deps.signRunForActor?.(actor.id),
      deps.computerGuidance,
      deps.loadVendors,
      deps.selectionForActor?.(actor.id),
      deps.agentFetch,
    );

  return {
    resolveAgentsForActor,
    async resolveAgentForActor(actor, agentId) {
      const agent = (await resolveAgentsForActor(actor))[agentId];
      if (!agent) {
        throw new Error(`Coworker ${agentId} is unavailable to this user.`);
      }
      return agent;
    },
  };
}
```

Export `ToolSelection` from `server/src/copilot.ts`. Change `createRequestAgents` to accept `ActorAgentResolver` and return `resolver.resolveAgentsForActor(await identifyActor(request))`. Change `mountCopilotRuntime` to receive the resolver instead of the duplicated construction arguments.

- [ ] **Step 4: Install Channels 0.9 and update the runtime construction call**

Run: `bun add --cwd server @copilotkit/channels@0.9.0`

Expected: `server/package.json` contains `"@copilotkit/channels": "0.9.0"` and `bun.lock` resolves the package once.

In `server/src/index.ts`, construct one `actorAgentResolver` from the existing closures and pass it to `mountCopilotRuntime`:

```ts
const actorAgentResolver = createActorAgentResolver({
  loadAgents: loadAgentsForActor,
  model: tenantPackage.model,
  resolveModelApiKey: () => resolveModelApiKey({
    encryptionKey: config.keyEncryptionKey,
    reader: credentialStore,
    provider: tenantPackage.model.provider,
    keyId: tenantPackage.model.credentialSecretRef,
    environment: process.env,
  }),
  stallGuard,
  loadToolsForActor: (actorId) => (botId) =>
    grantedTools({ store: pluginStore, botId, actorId }),
  signRunForActor: (actorId) => (botId, runId) =>
    mintRunAssertion({ botId, actorId, runId }, config.keyEncryptionKey),
  computerGuidance: config.computer ? COMPUTER_GUIDANCE : undefined,
  loadVendors: async () =>
    (await pluginStore.listServers()).map((server) => server.id),
  selectionForActor: (actorId) => ({
    loadSkills: (botId) => grantedSkills({ store: pluginStore, botId }),
    choose: chooseSkills,
    record: async (botId, selection) => {
      await recordAuditEvent(bootAuditStore, {
        eventType: "mcp.tools_discovered",
        targetType: "bot",
        targetId: botId,
        actorUserId: actorId,
        payload: {
          bot: botId,
          reason: selection.reason,
          granted: selection.granted,
          offered: selection.offered.length,
          skills: selection.skills,
        },
      });
    },
  }),
  agentFetch: createAgentFetch({
    allowPrivateHosts: config.computer?.allowPrivateHosts === true,
    allowedHosts: config.agentEndpointAllowedHosts,
    onRefusal: ({ address, reason }) => {
      void recordAuditEvent(bootAuditStore, {
        eventType: "agent.dial_refused",
        targetType: "endpoint",
        targetId: address,
        payload: { address, reason },
      });
    },
  }),
});
```

Move these existing closures without changing their audit payload or endpoint-refusal behavior. Import `COMPUTER_GUIDANCE` from `shared/bot-prompt` and reuse the current `createAgentFetch` construction rather than creating a second dial policy.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun test server/tests/agent-resolver.test.ts server/tests/copilot.test.ts && bun run --filter server typecheck`

Expected: PASS; typecheck exits 0.

- [ ] **Step 6: Commit the resolver refactor**

```bash
git add server/package.json bun.lock server/src/agents/agent-resolver.ts server/src/copilot.ts server/src/index.ts server/tests/agent-resolver.test.ts server/tests/copilot.test.ts
git commit -m "refactor: share actor-scoped agent resolution"
```

## Task 2: Add durable external user links

**Files:**
- Create: `server/src/external/schema-types.ts`
- Modify: `server/src/db/schema/core.ts`
- Create: `server/src/external/link-store.ts`
- Create: `server/tests/external-link-store.integration.test.ts`
- Create: `server/drizzle/0020_external_channels.sql`
- Create: `server/drizzle/meta/0020_snapshot.json`
- Modify: `server/drizzle/meta/_journal.json`

- [ ] **Step 1: Write failing integration tests for link uniqueness and verified email**

Create `server/tests/external-link-store.integration.test.ts`. Use `createDatabase(testDatabaseUrl())`, insert unique test users, and cover:

```ts
test("links one Slack identity to one OpenBot user and reads it back", async () => {
  await store.link({
    provider: "slack",
    providerTenantId: teamId,
    providerUserId: "U123",
    openbotUserId: userId,
    providerEmail: "person@example.com",
  });
  expect(await store.find("slack", teamId, "U123")).toMatchObject({
    openbotUserId: userId,
    providerEmail: "person@example.com",
  });
});

test("does not silently reassign an existing provider identity", async () => {
  await store.link(linkFor(userId));
  await expect(store.link(linkFor(otherUserId))).rejects.toThrow(
    "That Slack identity is already linked.",
  );
});

test("matches only one active verified OpenBot user by normalized email", async () => {
  expect(await store.findVerifiedUserByEmail(" PERSON@example.com "))
    .toEqual({ id: userId, name: "Person" });
});
```

Also assert unverified users and rows present in `revoked_access` do not match.

- [ ] **Step 2: Run the integration test and verify the table/store are missing**

Run: `bun test server/tests/external-link-store.integration.test.ts`

Expected: FAIL because `external/link-store` does not exist.

- [ ] **Step 3: Declare the schema and provider types**

Create `server/src/external/schema-types.ts`:

```ts
export type ExternalProvider = "slack";

export type ExternalProviderIdentity = {
  provider: ExternalProvider;
  providerTenantId: string;
  providerUserId: string;
  providerEmail: string | null;
};

export type ExternalUserLink = ExternalProviderIdentity & {
  openbotUserId: string;
  linkedAt: Date;
  updatedAt: Date;
};
```

Add `externalUserLinks` to `server/src/db/schema/core.ts` with a composite primary key on provider/tenant/user, a unique index on provider/tenant/OpenBot user, a cascading foreign key to `users.id`, and `linkedAt`/`updatedAt` timestamps.

```ts
export const externalUserLinks = pgTable(
  "external_user_links",
  {
    provider: text("provider").notNull(),
    providerTenantId: text("provider_tenant_id").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    openbotUserId: text("openbot_user_id").notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerEmail: text("provider_email"),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerTenantId, table.providerUserId] }),
    uniqueIndex("external_user_links_openbot_workspace_idx").on(
      table.provider,
      table.providerTenantId,
      table.openbotUserId,
    ),
  ],
);
```

- [ ] **Step 4: Implement the race-safe link store**

Create `server/src/external/link-store.ts` with this public contract:

```ts
export type ExternalLinkStore = {
  find(provider: ExternalProvider, tenantId: string, providerUserId: string):
    Promise<ExternalUserLink | null>;
  findVerifiedUserByEmail(email: string):
    Promise<{ id: string; name: string } | null>;
  link(input: ExternalProviderIdentity & { openbotUserId: string }):
    Promise<ExternalUserLink>;
};
```

`findVerifiedUserByEmail` must query `users` with `lower(email)`, `email_verified = true`, and no matching lower-cased `revoked_access.email`. It must return null unless exactly one row matches. `link` must use `onConflictDoNothing`, reload the provider identity, return it when it matches the requested user, and throw `That Slack identity is already linked.` on a conflicting user.

- [ ] **Step 5: Generate and inspect the migration**

Run: `bun run --filter server db:generate -- --name=external_channels`

Expected: Drizzle creates migration 0020, its snapshot, and a journal entry. Rename only if Drizzle's generated basename differs, keeping the journal tag identical. Confirm SQL includes both uniqueness constraints and the cascading user foreign key.

- [ ] **Step 6: Apply migration and run the focused test**

Run: `bun run --filter server db:migrate && bun test server/tests/external-link-store.integration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit external identity persistence**

```bash
git add server/src/external/schema-types.ts server/src/db/schema/core.ts server/src/external/link-store.ts server/tests/external-link-store.integration.test.ts server/drizzle/0020_external_channels.sql server/drizzle/meta/0020_snapshot.json server/drizzle/meta/_journal.json
git commit -m "feat: persist external user links"
```

## Task 3: Add expiring account-link claims and authenticated confirmation

**Files:**
- Create: `server/src/external/link-token.ts`
- Create: `server/src/external/routes.ts`
- Modify: `server/src/app.ts`
- Create: `server/tests/external-link-token.test.ts`
- Create: `server/tests/external-link-routes.test.ts`

- [ ] **Step 1: Write token tests for expiry, tampering, and provider binding**

Create `server/tests/external-link-token.test.ts` around an injected clock:

```ts
const identity = {
  provider: "slack" as const,
  providerTenantId: "T1",
  providerUserId: "U1",
  providerEmail: "person@example.com",
};

test("opens a live provider-bound link claim", async () => {
  const token = await mintExternalLinkToken(identity, KEY, now);
  expect(await readExternalLinkToken(token, KEY, now + 1)).toEqual(identity);
});

test("rejects expired and altered claims with one public error", async () => {
  const token = await mintExternalLinkToken(identity, KEY, now);
  await expect(readExternalLinkToken(token, KEY, now + EXTERNAL_LINK_TTL_MS + 1))
    .rejects.toThrow("This Slack link has expired or is invalid.");
  await expect(readExternalLinkToken(`${token}x`, KEY, now + 1))
    .rejects.toThrow("This Slack link has expired or is invalid.");
});
```

- [ ] **Step 2: Run token tests and verify failure**

Run: `bun test server/tests/external-link-token.test.ts`

Expected: FAIL because the token module does not exist.

- [ ] **Step 3: Implement sealed claims**

Create `server/src/external/link-token.ts` using `seal`/`unseal` from `auth/signed-value.ts`, label `external-link:v1`, and a ten-minute TTL:

```ts
export const EXTERNAL_LINK_TTL_MS = 10 * 60_000;

type ExternalLinkClaim = ExternalProviderIdentity & {
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export async function mintExternalLinkToken(
  identity: ExternalProviderIdentity,
  key: string,
  now = Date.now(),
): Promise<string> {
  return seal(JSON.stringify({
    ...identity,
    issuedAt: now,
    expiresAt: now + EXTERNAL_LINK_TTL_MS,
    nonce: crypto.randomUUID(),
  } satisfies ExternalLinkClaim), key, "external-link:v1");
}
```

`readExternalLinkToken` must validate the full JSON shape, provider `slack`, non-empty IDs, and `now <= expiresAt` before returning provider identity fields.

- [ ] **Step 4: Write failing route tests**

Create `server/tests/external-link-routes.test.ts` with an authenticated middleware that sets `context.var.actor`. Assert `GET /api/external-links/slack?token=...` returns only workspace/user/email display fields, and `POST` binds the claim to `context.var.actor.id`. Assert a replay by a different actor returns 409 and does not reassign.

- [ ] **Step 5: Implement and mount the authenticated routes**

Create `createExternalLinkRoutes({ store, encryptionKey, requireUser, auditStore })`. On successful completion, write:

```ts
await recordAuditEvent(auditStore, {
  eventType: "external_identity.linked",
  targetType: "user",
  targetId: actor.id,
  actorUserId: actor.id,
  payload: {
    provider: claim.provider,
    providerTenantId: claim.providerTenantId,
    providerUserId: claim.providerUserId,
  },
});
```

Do not include the token, email, or message content in the audit payload. Add an optional `externalLinkRoutes` argument at the end of `createApp`'s dependency list and mount it at `/api/external-links`.

- [ ] **Step 6: Run route/token tests and server typecheck**

Run: `bun test server/tests/external-link-token.test.ts server/tests/external-link-routes.test.ts && bun run --filter server typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the secure link backend**

```bash
git add server/src/external/link-token.ts server/src/external/routes.ts server/src/app.ts server/tests/external-link-token.test.ts server/tests/external-link-routes.test.ts
git commit -m "feat: add secure Slack account linking"
```

## Task 4: Add the Slack link confirmation page

**Files:**
- Create: `app/src/routes/_authed/link/slack.tsx`
- Modify: `app/src/routeTree.gen.ts`
- Create: `app/tests/slack-link-route.test.ts`

- [ ] **Step 1: Write failing tests for link-page state transitions**

Create `app/tests/slack-link-route.test.ts` for exported pure helpers:

```ts
test("requires a token and maps completion responses", () => {
  expect(slackLinkToken({})).toBeNull();
  expect(slackLinkToken({ token: " claim " })).toBe("claim");
  expect(slackLinkResult(200)).toEqual({ kind: "linked", message: "Slack is linked to your OpenBot account." });
  expect(slackLinkResult(409).kind).toBe("conflict");
});
```

- [ ] **Step 2: Run the test and verify the route is missing**

Run: `bun test app/tests/slack-link-route.test.ts`

Expected: FAIL because the route module does not exist.

- [ ] **Step 3: Implement the authenticated confirmation screen**

Create the TanStack route at `/_authed/link/slack` with `validateSearch` accepting only a non-empty `token`. Load claim metadata from `GET /api/external-links/slack`, show the Slack workspace/user identifiers and provider email when present, and submit the exact token to `POST /api/external-links/slack` only after the person clicks `Link Slack`.

Use these terminal messages:

```ts
export function slackLinkResult(status: number) {
  if (status === 200) return { kind: "linked", message: "Slack is linked to your OpenBot account." } as const;
  if (status === 409) return { kind: "conflict", message: "That Slack identity is already linked to another OpenBot account." } as const;
  return { kind: "invalid", message: "This Slack link has expired or is invalid. Return to Slack and try again." } as const;
}
```

- [ ] **Step 4: Regenerate the route tree and run tests**

Run: `bun run --filter app build && bun test app/tests/slack-link-route.test.ts`

Expected: the route tree includes `/_authed/link/slack`; PASS.

- [ ] **Step 5: Commit the link UI**

```bash
git add app/src/routes/_authed/link/slack.tsx app/src/routeTree.gen.ts app/tests/slack-link-route.test.ts
git commit -m "feat: add Slack account link confirmation"
```

## Task 5: Centralize coworker routing with explicit-name support

**Files:**
- Create: `server/src/routing/service.ts`
- Modify: `server/src/routing/routes.ts`
- Create: `server/tests/routing-service.test.ts`
- Modify: `server/tests/routing-routes.test.ts`

- [ ] **Step 1: Write failing routing-service tests**

Cover exact normalized names, ambiguity, absent roster, visibility, intent fallback, and audit:

```ts
test("routes a unique explicit coworker name without invoking the model", async () => {
  const result = await service.route({ actor, text: "ask risk analyst to review this" });
  expect(result).toMatchObject({ kind: "selected", agentId: "risk", viaMention: true });
  expect(modelCalls).toEqual([]);
});

test("returns visible choices for an ambiguous explicit name", async () => {
  const result = await service.route({ actor, text: "ask analyst to review this" });
  expect(result).toEqual({
    kind: "ambiguous",
    names: ["Risk Analyst", "Data Analyst"],
  });
});

test("passes only the actor's visible roster to intent routing", async () => {
  await service.route({ actor, text: "review this report", explicitAgentId: null });
  expect(modelCandidates).toEqual(["public", "owned-private"]);
});
```

- [ ] **Step 2: Run the tests and verify the service is missing**

Run: `bun test server/tests/routing-service.test.ts`

Expected: FAIL because `routing/service` does not exist.

- [ ] **Step 3: Implement the shared service**

Export `CoworkerRoutingService.route(input)` returning this closed union:

```ts
export type CoworkerRouteResult =
  | { kind: "selected"; agentId: string; name: string; reason: string; fallback: boolean; viaMention: boolean }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "none" };
```

Normalize names with Unicode NFKC, lowercase, trim, and collapsed whitespace. Prefer a full visible name occurring on word boundaries; when more than one visible name shares the matched normalized suffix, return alphabetized choices. If no explicit name is found, reuse `IntentRouter.route`. Move the one canonical `channel.routed` audit write into this service, retaining `chosen`, `reason`, `fallback`, `viaMention`, `candidates`, and `undecided` while never storing message text.

- [ ] **Step 4: Refactor the HTTP route onto the service**

Change `createRoutingRoutes` to receive `CoworkerRoutingService`. Preserve its response/status contract by translating `none` to 409 and an inaccessible explicit `agentId` to 404. Keep existing HTTP tests green and add one name-ambiguity assertion at the service level only; the web composer still sends IDs.

- [ ] **Step 5: Run focused routing tests**

Run: `bun test server/tests/routing-service.test.ts server/tests/routing-routes.test.ts`

Expected: PASS with all existing audit assertions unchanged.

- [ ] **Step 6: Commit shared routing**

```bash
git add server/src/routing/service.ts server/src/routing/routes.ts server/tests/routing-service.test.ts server/tests/routing-routes.test.ts
git commit -m "refactor: share coworker routing across surfaces"
```

## Task 6: Add immutable external thread bindings

**Files:**
- Modify: `server/src/db/schema/core.ts`
- Create: `server/src/external/thread-store.ts`
- Create: `server/tests/external-thread-store.integration.test.ts`
- Create: `server/drizzle/0021_external_thread_bindings.sql`
- Create: `server/drizzle/meta/0021_snapshot.json`
- Modify: `server/drizzle/meta/_journal.json`

- [ ] **Step 1: Write failing integration tests**

Test insert/reload, immutable agent IDs, provider uniqueness, and two concurrent first inserts:

```ts
test("keeps the winner when first deliveries race", async () => {
  const [left, right] = await Promise.all([
    store.bind(binding({ agentId: "risk" })),
    store.bind(binding({ agentId: "knowledge" })),
  ]);
  expect(left.agentId).toBe(right.agentId);
  expect(["risk", "knowledge"]).toContain(left.agentId);
});

test("never switches a bound thread", async () => {
  await store.bind(binding({ agentId: "risk" }));
  await expect(store.bind(binding({ agentId: "knowledge" })))
    .rejects.toThrow("This Slack thread is already assigned to Risk Analyst.");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test server/tests/external-thread-store.integration.test.ts`

Expected: FAIL because the thread store is missing.

- [ ] **Step 3: Declare and migrate the binding table**

Add `externalThreadBindings` with primary key `channelsThreadId`, unique provider/tenant/conversation/thread columns, `agentId` referencing `agents.id` with `onDelete: restrict`, `createdByUserId` referencing `users.id` with `onDelete: restrict`, and `createdAt`.

```ts
export const externalThreadBindings = pgTable(
  "external_thread_bindings",
  {
    channelsThreadId: text("channels_thread_id").primaryKey(),
    provider: text("provider").notNull(),
    providerTenantId: text("provider_tenant_id").notNull(),
    providerConversationId: text("provider_conversation_id").notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    agentId: text("agent_id").notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    createdByUserId: text("created_by_user_id").notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("external_thread_bindings_provider_thread_idx").on(
      table.provider,
      table.providerTenantId,
      table.providerConversationId,
      table.providerThreadId,
    ),
  ],
);
```

Run `bun run --filter server db:generate -- --name=external_thread_bindings` to create migration 0021, its snapshot, and its journal entry. Never rewrite migration 0020: Task 2 committed and applied it already.

- [ ] **Step 4: Implement bind-or-reload semantics**

Create `ExternalThreadStore` with `getByChannelsThreadId`, `getByProviderThread`, and `bind`. `bind` performs `insert(...).onConflictDoNothing().returning()`. If no row returns, reload by both keys; return the winner when every immutable field matches, otherwise throw the already-assigned error without updating.

```ts
export type ExternalThreadBindingInput = {
  channelsThreadId: string;
  provider: "slack";
  providerTenantId: string;
  providerConversationId: string;
  providerThreadId: string;
  agentId: string;
  agentName: string;
  createdByUserId: string;
};

export type ExternalThreadBinding = Omit<ExternalThreadBindingInput, "agentName"> & {
  agentName: string;
  createdAt: Date;
};

export type ExternalThreadStore = {
  getByChannelsThreadId(id: string): Promise<ExternalThreadBinding | null>;
  getByProviderThread(identity: Pick<ExternalThreadBindingInput,
    "provider" | "providerTenantId" | "providerConversationId" | "providerThreadId"
  >): Promise<ExternalThreadBinding | null>;
  bind(input: ExternalThreadBindingInput): Promise<ExternalThreadBinding>;
};
```

- [ ] **Step 5: Migrate and run the concurrency tests**

Run: `bun run --filter server db:migrate && bun test server/tests/external-thread-store.integration.test.ts`

Expected: PASS, including the concurrent insert case.

- [ ] **Step 6: Commit thread persistence**

```bash
git add server/src/db/schema/core.ts server/src/external/thread-store.ts server/tests/external-thread-store.integration.test.ts server/drizzle/0021_external_thread_bindings.sql server/drizzle/meta/0021_snapshot.json server/drizzle/meta/_journal.json
git commit -m "feat: pin external threads to coworkers"
```

## Task 7: Build the private Slack ingress and execution context

**Files:**
- Create: `server/src/slack/ingress-registry.ts`
- Create: `server/src/slack/identity-linker.ts`
- Create: `server/src/slack/execution-context.ts`
- Create: `server/tests/slack-ingress-registry.test.ts`
- Create: `server/tests/slack-identity-linker.test.ts`

- [ ] **Step 1: Write failing tests for event handoff and actor isolation**

```ts
test("takes identity metadata once by managed event id", () => {
  registry.remember("event-1", ingress);
  expect(registry.take("event-1")).toEqual(ingress);
  expect(registry.take("event-1")).toBeNull();
});

test("isolates overlapping turn actors", async () => {
  const seen = await Promise.all([
    runWithSlackExecution(alice, async () => {
      await Promise.resolve();
      return currentSlackExecution().actor.id;
    }),
    runWithSlackExecution(bob, async () => currentSlackExecution().actor.id),
  ]);
  expect(seen).toEqual(["alice", "bob"]);
});

test("auto-links only an exact adapter-profile email match", async () => {
  const result = await linker.resolve(identityContext({
    actor: { id: "U1", kind: "human", email: "untrusted@example.com" },
    profile: { id: "U1", kind: "human", email: "person@example.com" },
  }));
  expect(result).toMatchObject({ kind: "linked", actor: { id: "u1" } });
  expect(linkStore.link).toHaveBeenCalledWith(expect.objectContaining({
    providerUserId: "U1",
    openbotUserId: "u1",
    providerEmail: "person@example.com",
  }));
});
```

- [ ] **Step 2: Run and verify missing modules**

Run: `bun test server/tests/slack-ingress-registry.test.ts`

Expected: FAIL because the Slack modules are absent.

- [ ] **Step 3: Implement the bounded ingress registry**

`SlackIngressRegistry` stores `{ identityContext, linkedUser, linkUrl }` by non-empty `ChannelEvent.id`, deletes on `take`, rejects a missing event ID in managed Slack, and removes untouched entries after 30 seconds. Inject `setTimeout`/`clearTimeout` in tests so expiry is deterministic.

```ts
export type Timer = { cancel(): void };
export type SlackIngress = {
  identityContext: ChannelIdentityContext;
  identityResult: SlackIdentityResult;
};

export class SlackIngressRegistry {
  private readonly entries = new Map<string, { value: SlackIngress; timer: Timer }>();

  remember(eventId: string | undefined, value: SlackIngress): void {
    if (!eventId?.trim()) throw new Error("Managed Slack ingress requires an event id.");
    this.entries.get(eventId)?.timer.cancel();
    const timer = this.timer.after(30_000, () => this.entries.delete(eventId));
    this.entries.set(eventId, { value, timer });
  }

  take(eventId: string | undefined): SlackIngress | null {
    if (!eventId) return null;
    const entry = this.entries.get(eventId);
    if (!entry) return null;
    entry.timer.cancel();
    this.entries.delete(eventId);
    return entry.value;
  }
}
```

Inject `{ after(ms, callback): Timer }`; the production adapter wraps `setTimeout`/`clearTimeout` and tests use a deterministic fake. Import `SlackIdentityResult` from the linker module implemented in the next step.

- [ ] **Step 4: Implement the Slack identity linker**

`SlackIdentityLinker.resolve(context)` returns:

```ts
type SlackIdentityResult =
  | { kind: "linked"; user: { id: string; name: string }; actor: AgentActor; identity: ExternalProviderIdentity }
  | { kind: "unlinked"; linkUrl: string; identity: ExternalProviderIdentity };
```

For an existing link, reload the OpenBot user and roles on every event and refuse revoked or roleless users. For an unlinked human, call `context.lookupProfile()` and use only the email returned by that adapter profile lookup for automatic matching; never trust `context.actor.email` for bootstrap. When that exact normalized email maps to one active verified OpenBot user, persist the link and return it. Otherwise mint an expiring claim and return `${appUrl}/link/slack?token=${encodeURIComponent(token)}`. An absent `appUrl` returns a stable setup error instead of a relative or Host-header-derived URL.

Add `resolveActiveUser(openbotUserId)` to `ExternalLinkStore`; it returns the user's current name and effective `admin` or `user` role only when the email is not revoked. Add tests for existing links, profile-email bootstrap, ambiguous or absent email, revoked user, missing role, conflicting existing link, and missing app URL.

- [ ] **Step 5: Implement the AsyncLocalStorage execution context**

Create:

```ts
export type SlackExecution = {
  actor: AgentActor;
  applicationUser: { id: string; name: string };
  provider: "slack";
  providerTenantId: string;
  providerConversationId: string;
  providerThreadId: string;
  channelsThreadId?: string;
  messageText: string;
  agentId?: string;
};

const storage = new AsyncLocalStorage<SlackExecution>();

export function runWithSlackExecution<T>(value: SlackExecution, run: () => T): T {
  return storage.run(value, run);
}

export function currentSlackExecution(): SlackExecution {
  const value = storage.getStore();
  if (!value) throw new Error("A Slack agent run requires a private execution context.");
  return value;
}
```

`OpenBotChannelAgent` sets `channelsThreadId` from the factory-supplied canonical thread ID before it reads or writes a binding. The context object is never added to `thread.runAgent({ context })`, `forwardedProps`, model messages, or Channels thread state.

- [ ] **Step 6: Run identity/isolation tests and typecheck**

Run: `bun test server/tests/slack-ingress-registry.test.ts server/tests/slack-identity-linker.test.ts && bun run --filter server typecheck`

Expected: PASS.

- [ ] **Step 7: Commit private execution context and identity resolution**

```bash
git add server/src/slack/ingress-registry.ts server/src/slack/identity-linker.ts server/src/slack/execution-context.ts server/src/external/link-store.ts server/tests/slack-ingress-registry.test.ts server/tests/slack-identity-linker.test.ts
git commit -m "feat: isolate Slack turn identity"
```

## Task 8: Implement the delegating OpenBot Channel agent

**Files:**
- Create: `server/src/slack/channel-agent.ts`
- Create: `server/tests/slack-channel-agent.test.ts`

- [ ] **Step 1: Write failing delegation tests**

Use a scripted `AbstractAgent` and assert:

```ts
test("routes and binds the first turn before delegating", async () => {
  await collect(agent.run(inputFor("ask Risk Analyst to review this")));
  expect(routeCalls).toEqual([{ actor, text: "ask Risk Analyst to review this" }]);
  expect(bound.agentId).toBe("risk");
  expect(resolved).toEqual([{ actor, agentId: "risk" }]);
});

test("reloads access for every later participant and never changes the binding", async () => {
  binding.agentId = "private-risk";
  await expect(runAs(bob, agent)).rejects.toThrow(
    "Coworker private-risk is unavailable to this user.",
  );
  expect(routeCalls).toEqual([]);
  expect(binding.agentId).toBe("private-risk");
});

test("clone returns a distinct fully configured delegate", () => {
  const cloned = agent.clone();
  expect(cloned).not.toBe(agent);
  expect(cloned).toBeInstanceOf(OpenBotChannelAgent);
});
```

Also assert ambiguous/no-roster outcomes produce stable public errors and that the target input contains no serialized provider tenant/user metadata.

- [ ] **Step 2: Run and verify the class is missing**

Run: `bun test server/tests/slack-channel-agent.test.ts`

Expected: FAIL because `slack/channel-agent` does not exist.

- [ ] **Step 3: Implement lazy delegation**

Implement `OpenBotChannelAgent extends AbstractAgent` using RxJS `defer`, `from`, and `switchMap`, mirroring `RunSelectedAgent` in `copilot.ts`. In `run(input)`:

1. Read `currentSlackExecution()` and set `execution.channelsThreadId` to this agent instance's canonical factory thread ID.
2. Load by that `channelsThreadId`.
3. If absent, call `routing.route({ actor, text: execution.messageText })`, reject `none`/`ambiguous` with user-safe messages, then call `threadStore.bind`.
4. Set `execution.agentId` to the immutable binding.
5. Call `resolver.resolveAgentForActor(execution.actor, binding.agentId)`.
6. Store `inner` for abort propagation and return `inner.run(input)` unchanged.

Implement `clone()` by constructing a new `OpenBotChannelAgent` with the same immutable dependency object and copied base identity, not by relying on the base clone's fixed field list.

```ts
export class OpenBotChannelAgent extends AbstractAgent {
  private inner?: AbstractAgent;

  constructor(
    private readonly canonicalThreadId: string,
    private readonly deps: OpenBotChannelAgentDeps,
  ) {
    super({ agentId: "openbot-slack", description: "OpenBot Slack router" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return defer(() => from(this.resolve(input)).pipe(
      switchMap(({ target, forwarded }) => {
        this.inner = target;
        return target.run(forwarded);
      }),
    ));
  }

  private async resolve(input: RunAgentInput) {
    const execution = currentSlackExecution();
    execution.channelsThreadId = this.canonicalThreadId;
    let binding = await this.deps.threadStore.getByChannelsThreadId(this.canonicalThreadId);
    if (!binding) {
      const decision = await this.deps.routing.route({
        actor: execution.actor,
        text: execution.messageText,
      });
      if (decision.kind === "none") throw new Error("No coworker is available to you.");
      if (decision.kind === "ambiguous") {
        throw new Error(`Name one coworker: ${decision.names.join(", ")}.`);
      }
      binding = await this.deps.threadStore.bind({
        channelsThreadId: this.canonicalThreadId,
        provider: execution.provider,
        providerTenantId: execution.providerTenantId,
        providerConversationId: execution.providerConversationId,
        providerThreadId: execution.providerThreadId,
        agentId: decision.agentId,
        agentName: decision.name,
        createdByUserId: execution.actor.id,
      });
    }
    execution.agentId = binding.agentId;
    const target = await this.deps.resolver.resolveAgentForActor(
      execution.actor,
      binding.agentId,
    );
    return { target, forwarded: input };
  }

  override clone(): OpenBotChannelAgent {
    return new OpenBotChannelAgent(this.canonicalThreadId, this.deps);
  }

  override abortRun(): void {
    this.inner?.abortRun();
    super.abortRun();
  }
}
```

- [ ] **Step 4: Run delegation tests**

Run: `bun test server/tests/slack-channel-agent.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the delegating agent**

```bash
git add server/src/slack/channel-agent.ts server/tests/slack-channel-agent.test.ts
git commit -m "feat: delegate Slack threads to OpenBot coworkers"
```

## Task 9: Share computer tool contracts and add governed ChannelTools

**Files:**
- Create: `shared/computer-tool-contracts.ts`
- Modify: `app/src/lib/copilot/computer-tools.tsx`
- Create: `server/src/slack/computer-tools.ts`
- Create: `server/tests/slack-computer-tools.test.ts`

- [ ] **Step 1: Write failing ChannelTool tests against a fake gateway**

Cover navigate, snapshot, click, type, key, scroll, file list/read/write/share, command, policy refusal, stale reference, abort, human control, and missing computer. One representative assertion:

```ts
test("passes the current coworker, actor, input, and abort signal to the gateway", async () => {
  const signal = new AbortController().signal;
  await toolsByName.computer_click.handler(
    { ref: "e4", snapshotId: 9 },
    channelContext({ signal }),
  );
  expect(gateway.click).toHaveBeenCalledWith(
    "risk",
    { id: "u1", userId: "u1" },
    { ref: "e4", snapshotId: 9 },
    signal,
  );
});
```

Assert `ActionRefusedError` becomes `{ ok: false, refused: true, reason, rule }`, while other errors become `{ ok: false, reason: "The assistant's computer could not be reached." }` and are never retried.

- [ ] **Step 2: Run and verify missing tool module**

Run: `bun test server/tests/slack-computer-tools.test.ts`

Expected: FAIL because the contracts and ChannelTools are absent.

- [ ] **Step 3: Extract platform-neutral schemas and descriptions**

Move each Zod parameter schema and description string from `app/src/lib/copilot/computer-tools.tsx` into named exports in `shared/computer-tool-contracts.ts`, for example:

```ts
export const computerClickContract = {
  name: "computer_click",
  description: "Click an element by ref from the most recent snapshot.",
  parameters: z.object({
    ref: z.string().describe("Element ref from computer_snapshot"),
    snapshotId: z.number().describe("Snapshot id that produced the ref"),
  }),
} as const;
```

The web file imports the contract fields into `useFrontendTool` and retains its existing HTTP handlers and React renderers. Do not move React or browser code into `shared`.

- [ ] **Step 4: Implement gateway-backed ChannelTools**

Create `createSlackComputerTools(gateway)` using `defineChannelTool`. Each handler reads `currentSlackExecution()`, requires `execution.agentId`, constructs `{ id: actor.id, userId: actor.id }`, and calls the matching gateway method directly. This matches the authenticated web route's audit identity; Slack provider IDs remain external-link metadata and never replace OpenBot authorization. Return raw gateway result objects plus `ok: true`; catch only to normalize known refusal/stale/control/unavailable outcomes.

```ts
async function governed<T>(run: () => Promise<T>): Promise<Record<string, unknown>> {
  try {
    return { ok: true, ...(await run() as Record<string, unknown>) };
  } catch (error) {
    if (error instanceof ActionRefusedError) {
      return { ok: false, refused: true, reason: error.message, rule: error.rule };
    }
    if (error instanceof StaleSnapshotError) {
      return { ok: false, staleRefs: true, reason: error.message };
    }
    if (error instanceof HumanHasControlError) {
      return { ok: false, humanHasControl: true, reason: error.message };
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, stopped: true, reason: "Stopped." };
    }
    return { ok: false, reason: "The assistant's computer could not be reached." };
  }
}
```

Use the actual exported gateway error classes or add narrow public error guards beside `ComputerGateway`; do not infer policy refusal from error-message text.

Add `computer_share_file` with `{ path: string; filename?: string }`. It calls `gateway.readFile`, refuses truncated output rather than uploading an incomplete file, encodes the complete text as UTF-8, and calls `context.thread.postFile`. Return the adapter's explicit error when Slack rejects the size or file type; never report a file as shared when `postFile.ok` is false.

- [ ] **Step 5: Run server and web computer tests**

Run: `bun test server/tests/slack-computer-tools.test.ts app/tests/computer-tool-refusals.test.ts && bun run typecheck`

Expected: PASS; web behavior is unchanged.

- [ ] **Step 6: Commit governed Slack computer tools**

```bash
git add shared/computer-tool-contracts.ts app/src/lib/copilot/computer-tools.tsx server/src/slack/computer-tools.ts server/tests/slack-computer-tools.test.ts
git commit -m "feat: expose governed computer tools to Channels"
```

## Task 10: Add Slack-native assistance and approval continuations

**Files:**
- Create: `server/src/slack/assistance.ts`
- Create: `server/src/slack/assistance-token.ts`
- Create: `server/src/slack/components.tsx`
- Modify: `server/src/slack/computer-tools.ts`
- Modify: `server/src/external/routes.ts`
- Create: `app/src/routes/_authed/assist.tsx`
- Modify: `app/src/routeTree.gen.ts`
- Modify: `server/tsconfig.json`
- Create: `server/tests/slack-assistance.test.ts`
- Create: `app/tests/slack-assist-route.test.ts`

- [ ] **Step 1: Write failing bounded-wait and secret-redaction tests**

Use an injected clock/poller to assert answered, cancelled, and expired results. Assert rendered messages contain the assistance reason and `/assist?token=`, but never the supplied secret, `SecretRequest` field ref, session cookie, or a plain coworker/user ID outside the sealed claim.

- [ ] **Step 2: Run and verify missing assistance module**

Run: `bun test server/tests/slack-assistance.test.ts`

Expected: FAIL because `slack/assistance` is absent.

- [ ] **Step 3: Implement sealed assistance claims and the authenticated handoff**

Create `server/src/slack/assistance-token.ts` with a sealed `slack-assistance:v1` claim containing `openbotUserId`, `agentId`, `channelsThreadId`, `issuedAt`, `expiresAt`, and a nonce. Use a ten-minute TTL and the same uniform invalid/expired error discipline as account links.

```ts
const ASSISTANCE_LABEL = "slack-assistance:v1";
export const ASSISTANCE_TTL_MS = 10 * 60_000;
const assistanceClaim = z.object({
  openbotUserId: z.string().min(1),
  agentId: z.string().min(1),
  channelsThreadId: z.string().min(1),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  nonce: z.string().uuid(),
});

function parseAssistanceClaim(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed = assistanceClaim.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function mintAssistanceToken(
  input: { openbotUserId: string; agentId: string; channelsThreadId: string },
  key: string,
  now = Date.now(),
): Promise<string> {
  return seal(JSON.stringify({
    ...input,
    issuedAt: now,
    expiresAt: now + ASSISTANCE_TTL_MS,
    nonce: crypto.randomUUID(),
  }), key, ASSISTANCE_LABEL);
}

export async function readAssistanceToken(token: string, key: string, now = Date.now()) {
  const raw = await unseal(token, key, ASSISTANCE_LABEL);
  const claim = parseAssistanceClaim(raw);
  if (!claim || now > claim.expiresAt) {
    throw new Error("This assistance link has expired or is invalid.");
  }
  return claim;
}
```

Add `GET /api/external-links/assistance?token=...` behind `requireUser`. Open the claim, require `claim.openbotUserId === context.var.actor.id`, recheck coworker access with `AgentProfileStore.get`, and return only `{ agentId }`. Return 403 for the wrong signed-in user and 410 for invalid/expired claims.

Create `app/src/routes/_authed/assist.tsx`. It validates the token through that endpoint, then renders one `Open coworker control` button linking to `/bot?agent=<encoded agentId>`. Invalid/expired/wrong-user states never navigate. Regenerate `app/src/routeTree.gen.ts` and test the pure status mapper in `app/tests/slack-assist-route.test.ts`.

- [ ] **Step 4: Implement secure control links and bounded polling**

Build Slack links from configured `appUrl` and the sealed token:

```ts
export function computerControlUrl(appUrl: string, token: string): string {
  const url = new URL("/assist", appUrl);
  url.searchParams.set("token", token);
  return url.toString();
}
```

Implement `waitForAssistance` with the same ten-minute/one-second bounds as the web surface, `gateway.control(agentId)`, and abort-aware timers. `computer_request_help` calls `gateway.requestHelp`, posts a Slack-native message with the control URL, waits for holder `bot` and no outstanding request, then returns the same model guidance as web. `computer_request_secret` calls `gateway.requestSecret`, posts only the label and secure control URL, waits for `secretWanted` to clear, and returns no value.

- [ ] **Step 5: Add portable approval UI**

Enable Channels JSX in `server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@copilotkit/channels"
  }
}
```

Create `ApprovalCard` with `defineChannelComponent`, Zod parameters `{ question: string }`, and Approve/Reject buttons. Each button calls `context.thread.resume({ approved: true|false })`; Channels binds the persisted continuation to the originating thread.

- [ ] **Step 6: Run assistance tests and typecheck**

Run: `bun test server/tests/slack-assistance.test.ts app/tests/slack-assist-route.test.ts && bun run --filter server typecheck && bun run --filter app build`

Expected: PASS.

- [ ] **Step 7: Commit assistance and approval UI**

```bash
git add server/src/slack/assistance.ts server/src/slack/assistance-token.ts server/src/slack/components.tsx server/src/slack/computer-tools.ts server/src/external/routes.ts app/src/routes/_authed/assist.tsx app/src/routeTree.gen.ts server/tests/slack-assistance.test.ts app/tests/slack-assist-route.test.ts server/tsconfig.json
git commit -m "feat: add Slack assistance and approvals"
```

## Task 11: Declare and integration-test the managed OpenBot Channel

**Files:**
- Create: `server/src/slack/channel.tsx`
- Create: `server/tests/slack-channel.integration.test.tsx`
- Modify: `server/src/copilot.ts`

- [ ] **Step 1: Write a failing FakeAdapter integration test**

Use `FakeAdapter` from `@copilotkit/channels/testing` with `platform: "slack"` and `messageEvents: true`. Cover:

- unlinked mention posts a link and never runs an agent or creates a binding;
- linked mention subscribes, routes, binds, and streams a reply;
- an ordinary subscribed thread reply runs the pinned agent without a mention;
- a different linked participant rechecks access;
- built-in and remote AG-UI coworkers both receive the same standing role, actor grants, signed run assertion, and ChannelTools through the shared resolver;
- duplicate event IDs execute once;
- same-conversation overlaps are serial;
- content parts reach the delegated AG-UI input;
- a complete workspace text file uses `thread.postFile`, while truncated and adapter-refused files return explicit errors;
- approval interaction resumes the persisted continuation.

Core happy-path assertion:

```ts
await adapter.getSink().onTurn(turn({
  eventId: "E1",
  conversationKey: "slack:T1:C1:root-1",
  userText: "ask Risk Analyst to review this",
  mentioned: true,
}));

expect(await state.isSubscribed("slack:T1:C1:root-1")).toBe(true);
expect(binding.agentId).toBe("risk");
expect(adapter.postedText()).toContain("review complete");
```

- [ ] **Step 2: Run and verify the channel declaration is missing**

Run: `bun test server/tests/slack-channel.integration.test.tsx`

Expected: FAIL because `slack/channel` does not exist.

- [ ] **Step 3: Implement `createOpenBotSlackChannel`**

Create a named managed Channel with no direct adapter in production:

```tsx
const channel = createChannel({
  name: "openbot",
  identifyUser,
  agent: (threadId) => new OpenBotChannelAgent(threadId, deps.agentDeps),
  tools: deps.computerGateway ? createSlackComputerTools(deps.computerGateway) : [],
  components: [ApprovalCard],
  showToolStatus: true,
  store: { concurrency: "serial", actionRetentionMs: 10 * 60_000 },
});
```

The `identifyUser` callback must:

1. reject non-human actors;
2. call `SlackIdentityLinker.resolve(context)`;
3. remember identity metadata/result in `SlackIngressRegistry` by `context.event.id`;
4. return `{ id, name }` only for linked OpenBot users.

`onMention` takes the ingress entry, posts the link card when `message.user` is null, otherwise subscribes and runs the agent inside `runWithSlackExecution`. Derive provider tenant/conversation from the saved `ChannelIdentityContext` and provider thread from `thread.conversationKey`. The handler leaves `channelsThreadId` unset; the factory-created `OpenBotChannelAgent` writes its own canonical `threadId` into the private execution object before binding.

`onMessage` returns unless `thread.isSubscribed()` is true; then it follows the same linked execution path. Updated/deleted message revisions do not start fresh agent runs.

- [ ] **Step 4: Pass Channels into the runtime without changing the Hono endpoint**

Add an optional `channels: Channel[] = []` parameter to `mountCopilotRuntime` and include `channels` in `new CopilotRuntime`. Continue returning the `CopilotHonoApp`, whose `.channels` control surface is used in Task 12.

- [ ] **Step 5: Run integration tests and typecheck**

Run: `bun test server/tests/slack-channel.integration.test.tsx && bun run --filter server typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the managed Channel declaration**

```bash
git add server/src/slack/channel.tsx server/tests/slack-channel.integration.test.tsx server/src/copilot.ts
git commit -m "feat: add managed OpenBot Slack channel"
```

## Task 12: Wire lifecycle, provider readiness, and graceful shutdown

**Files:**
- Create: `server/src/slack/status.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/app.ts`
- Modify: `server/tests/health.test.ts`
- Create: `server/tests/slack-lifecycle.test.ts`

- [ ] **Step 1: Write failing readiness projection tests**

Test these exact public states:

```ts
expect(projectSlackStatus({
  overall: "online",
  channels: { openbot: "setup_required" },
  detail: { openbot: { status: "setup_required", transport: "online", provider: "not_attached" } },
})).toEqual({ transport: "online", provider: "not_attached", status: "setup_required" });

expect(projectSlackStatus({
  overall: "reconnecting",
  channels: { openbot: "reconnecting" },
  detail: { openbot: { status: "reconnecting", transport: "reconnecting", provider: "attached" } },
})).toEqual({ transport: "reconnecting", provider: "attached", status: "reconnecting" });
```

Also test `stop()` is called exactly once for SIGTERM and activation failure leaves web serving available.

Implement the projection as a pure function so health tests do not import the runtime transport:

```ts
export function projectSlackStatus(snapshot?: ChannelsStatusSnapshot): SlackStatus {
  const leg = snapshot?.detail.openbot;
  if (!leg) {
    return { status: "stopped", transport: "stopped", provider: "unknown" };
  }
  return {
    status: leg.status,
    transport: leg.transport,
    provider: leg.provider,
  };
}
```

Define `ChannelsStatusSnapshot` structurally from `ChannelsControl.status()` and keep `SlackStatus` limited to the three public strings shown above.

- [ ] **Step 2: Run and verify the lifecycle projection is missing**

Run: `bun test server/tests/slack-lifecycle.test.ts server/tests/health.test.ts`

Expected: FAIL because `slack/status` and the projected capability are absent.

- [ ] **Step 3: Construct and activate Channels in the long-running Bun host**

In `server/src/index.ts`, create the link/thread stores, linker, ingress registry, routing service, Channel, and runtime handler. Call:

```ts
const copilotHandler = mountCopilotRuntime(/* existing deps */, [openbotSlackChannel]);
await copilotHandler.channels?.ready({ timeoutMs: 30_000 }).catch((error) => {
  console.error("OpenBot Slack Channel activation failed", error);
});
```

Do not terminate the web server for `setup_required` or a recoverable Channel failure. Add `copilotHandler.channels?.stop()` to the existing `Promise.allSettled` shutdown array before `process.exit(0)`.

- [ ] **Step 4: Expose credential-free Slack readiness**

Pass `() => projectSlackStatus(copilotHandler.channels?.status())` into `createApp`. Add `channels.slack` to `/api/capabilities` with only `status`, `transport`, and `provider`. Do not expose Intelligence URLs, keys, license values, installation IDs, Slack tokens, workspace IDs, or actor IDs.

- [ ] **Step 5: Run lifecycle, health, and Copilot tests**

Run: `bun test server/tests/slack-lifecycle.test.ts server/tests/health.test.ts server/tests/copilot.test.ts && bun run --filter server typecheck`

Expected: PASS.

- [ ] **Step 6: Commit lifecycle wiring**

```bash
git add server/src/slack/status.ts server/src/index.ts server/src/app.ts server/tests/health.test.ts server/tests/slack-lifecycle.test.ts
git commit -m "feat: operate managed Slack channel lifecycle"
```

## Task 13: Document setup, scopes, security limits, and smoke test

**Files:**
- Modify: `.env.example`
- Modify: `docs/configuration.md`
- Modify: `docs/architecture.md`
- Create: `docs/slack.md`

- [ ] **Step 1: Add the managed setup procedure**

Document:

```bash
npx copilotkit@latest channels setup
```

Select the existing Intelligence project, Channel name `openbot`, and Slack provider. State that the managed path keeps Slack bot/app tokens in CopilotKit Intelligence; OpenBot stores no Slack token.

- [ ] **Step 2: Document minimum Slack access and account linking**

List only the scopes generated by the current setup command and explain why each is needed: app mentions, thread/message read/write, files, and user profile/email for linking. Tell operators to confirm the generated manifest rather than copying a stale hand-written scope list.

Document automatic linking requirements: human actor, verified Slack email, exactly one active verified OpenBot account. Document the ten-minute explicit link path for every other case.

- [ ] **Step 3: Document product limits and secure assistance**

State:

- one Slack identity, `@OpenBot`, in release one;
- one immutable coworker per Slack thread;
- every speaker uses their own grants;
- no Slack-to-web roster mirroring yet;
- arbitrary React/sandbox components fall back to text and an authenticated OpenBot link;
- passwords, OTPs, card values, model keys, and connector credentials must never be pasted in Slack;
- separate coworker Slack identities require separate app installations/credentials and are future work.

- [ ] **Step 4: Run documentation and repository checks**

Run: `bun run format:check && bun run lint && bun run typecheck && bun test && bun run build`

Expected: every command exits 0 with no warnings promoted by lint.

- [ ] **Step 5: Perform the real Slack smoke test**

In a test workspace:

1. Install and attach `@OpenBot`.
2. Link one Slack user.
3. Send `@OpenBot ask Risk Analyst to review the attached report`.
4. Confirm the streamed response is threaded.
5. Reply without mentioning `@OpenBot` and confirm the same coworker runs.
6. Add a second linked user and confirm their own grants/access apply.
7. Run one browser action and one policy-refused action.
8. Request control/secret assistance and complete it only in OpenBot.
9. Confirm `channel.routed`, tool, policy, and assistance audit rows identify the linked OpenBot user and pinned coworker without message bodies or secrets.

Record date, workspace, OpenBot commit, Channels version, and pass/fail for each item in the deployment change record; do not commit workspace IDs or credentials.

- [ ] **Step 6: Commit documentation**

```bash
git add .env.example docs/configuration.md docs/architecture.md docs/slack.md
git commit -m "docs: explain OpenBot Slack setup"
```

## Task 14: Final regression and clean handoff

**Files:**
- No new files expected.

- [ ] **Step 1: Run the complete cheap-to-expensive verification sequence**

Run:

```bash
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
git diff --check
```

Expected: all exit 0.

- [ ] **Step 2: Verify database migration state in a fresh database**

Create a disposable PostgreSQL database, set `DATABASE_URL` to that explicit database, run `bun run --filter server db:migrate`, and query `external_user_links` and `external_thread_bindings` with `\d`. Expected: both tables, both primary keys, both uniqueness constraints, and declared foreign keys exist.

- [ ] **Step 3: Verify no secrets or message bodies entered durable audit payloads**

Run:

```bash
rg -n "SLACK_(BOT|APP)_TOKEN|providerEmail.*payload|messageText.*payload|secret.*payload" server/src docs .env.example
```

Expected: no persisted Slack token, provider email, message text, or secret payload path. Documentation may name token environment variables only when explicitly saying OpenBot does not store them.

- [ ] **Step 4: Inspect repository state and recent commits**

Run: `git status --short --branch && git log --oneline --decorate -15`

Expected: clean feature branch containing the scoped commits above and no unrelated files.

- [ ] **Step 5: Hand off provider setup separately from code**

Report the exact commit, verification commands, test counts, migration number, current `/api/capabilities` Slack status, and whether the real workspace smoke test ran. If provider status is `setup_required`, give the operator the single `channels setup` command and stop; do not claim Slack is live until provider detail is `attached`.
