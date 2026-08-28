# Managed Slack Tenant Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the production single-workspace OpenBot deployment safely accept managed Slack deliveries whose canonical tenant is missing, without weakening workspace-scoped identity or authorization.

**Architecture:** Parse one operator-owned workspace ID at startup, then normalize each immutable Slack `ChannelIdentityContext` exactly once inside the existing `identity.resolve` phase. The normalized context is the only context passed to identity linking and ingress persistence. Known managed tenants remain authoritative and must match configuration; missing, blank, or `unknown` tenants fail closed unless the operator configured the single-workspace fallback.

**Tech Stack:** Bun, TypeScript, `@copilotkit/channels` 0.9, Bun test, Biome, Railway, managed CopilotKit Intelligence Channels.

---

## Task 1: Add and validate the deployment setting

**Files:**

- Modify: `server/tests/config.test.ts`
- Modify: `server/src/config.ts`

- [ ] **Step 1: Write failing configuration tests**

Add focused cases inside `describe("deployment configuration", ...)`:

```ts
test("loads a canonical managed Slack tenant fallback", () => {
  expect(
    loadConfig({
      ...baseEnvironment,
      OPENBOT_SLACK_TENANT_ID: " T05QFA4BW9X ",
    }).slackTenantId,
  ).toBe("T05QFA4BW9X");
});

test.each(["unknown", " UNKNOWN "])(
  "rejects the non-canonical managed Slack tenant %j",
  (tenantId) => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        OPENBOT_SLACK_TENANT_ID: tenantId,
      }),
    ).toThrow(
      "OPENBOT_SLACK_TENANT_ID must be a canonical Slack workspace ID, not unknown",
    );
  },
);

test("leaves managed Slack tenant fallback disabled when unset or blank", () => {
  expect(loadConfig(baseEnvironment).slackTenantId).toBeUndefined();
  expect(
    loadConfig({
      ...baseEnvironment,
      OPENBOT_SLACK_TENANT_ID: "   ",
    }).slackTenantId,
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and confirm the new expectation fails**

Run:

```sh
bun test server/tests/config.test.ts
```

Expected: failure because `DeploymentConfig` and `loadConfig` do not expose `slackTenantId`.

- [ ] **Step 3: Add boot-boundary parsing**

In `server/src/config.ts`, add the optional field beside the deployment/public URL settings:

```ts
/**
 * Operator-owned Slack workspace ID used only when managed Channels omits its canonical tenant.
 * A known managed tenant must still match this value; see slack/tenant-context.ts.
 */
slackTenantId: string | undefined;
```

Add a small parser near the other configuration parsers:

```ts
function slackTenantId(environment: Environment): string | undefined {
  const tenantId = optional(environment, "OPENBOT_SLACK_TENANT_ID");
  if (!tenantId) return undefined;
  if (tenantId.toLowerCase() === "unknown") {
    throw new Error(
      "OPENBOT_SLACK_TENANT_ID must be a canonical Slack workspace ID, not unknown",
    );
  }
  return tenantId;
}
```

Populate it once in `loadConfig`:

```ts
slackTenantId: slackTenantId(environment),
```

Do not enforce a `T...` regex: the security property is operator ownership plus exact comparison, and accepting future canonical Slack workspace ID shapes avoids an artificial compatibility boundary.

- [ ] **Step 4: Run the focused configuration tests**

Run:

```sh
bun test server/tests/config.test.ts
```

Expected: all configuration tests pass.

- [ ] **Step 5: Commit the configuration boundary**

```sh
git add server/src/config.ts server/tests/config.test.ts
git commit -m "feat: configure managed Slack tenant fallback"
```

## Task 2: Implement the pure immutable tenant resolver

**Files:**

- Create: `server/src/slack/tenant-context.ts`
- Create: `server/tests/slack-tenant-context.test.ts`

- [ ] **Step 1: Write the resolver contract as failing unit tests**

Create a local `identity(tenantId)` fixture with all canonical fields and add cases for:

```ts
expect(normalizeSlackTenantContext(context, undefined)).toBe(context);
expect(normalizeSlackTenantContext(context, "T1")).toBe(context);

expect(
  normalizeSlackTenantContext(identity("unknown"), "T1").tenant.id,
).toBe("T1");

expect(() => normalizeSlackTenantContext(identity("T2"), "T1")).toThrow(
  MANAGED_SLACK_TENANT_ERROR,
);

expect(() =>
  normalizeSlackTenantContext(identity("unknown"), undefined),
).toThrow(MANAGED_SLACK_TENANT_ERROR);
```

Also cover `""` and whitespace tenants by constructing the test fixture through a narrow test-only cast, because the runtime contract is TypeScript-shaped but provider input is external. Assert the replacement preserves references for `actor`, `installation`, `conversation`, `event`, `profile`, and `raw`, and assert both the returned context and replacement `tenant` object are frozen.

- [ ] **Step 2: Run the resolver tests and confirm the module is missing**

Run:

```sh
bun test server/tests/slack-tenant-context.test.ts
```

Expected: failure because `../src/slack/tenant-context` does not exist.

- [ ] **Step 3: Implement a single fail-closed resolver**

Create `server/src/slack/tenant-context.ts`:

```ts
import type { ChannelIdentityContext } from "@copilotkit/channels";

export const MANAGED_SLACK_TENANT_ERROR =
  "Managed Slack delivery did not provide the configured canonical tenant.";

function canonicalTenantId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tenantId = value.trim();
  return tenantId && tenantId.toLowerCase() !== "unknown"
    ? tenantId
    : undefined;
}

export function normalizeSlackTenantContext(
  context: ChannelIdentityContext,
  configuredTenantId?: string,
): ChannelIdentityContext {
  const managedTenantId = canonicalTenantId(context.tenant?.id);
  const fallbackTenantId = canonicalTenantId(configuredTenantId);

  if (managedTenantId) {
    if (fallbackTenantId && managedTenantId !== fallbackTenantId) {
      throw new Error(MANAGED_SLACK_TENANT_ERROR);
    }
    return context;
  }
  if (!fallbackTenantId) {
    throw new Error(MANAGED_SLACK_TENANT_ERROR);
  }

  return Object.freeze({
    ...context,
    tenant: Object.freeze({ ...context.tenant, id: fallbackTenantId }),
  });
}
```

Do not inspect `raw`, installation, channel, actor, email, or profile fields. Do not mutate the incoming object.

- [ ] **Step 4: Run the focused resolver tests**

Run:

```sh
bun test server/tests/slack-tenant-context.test.ts
```

Expected: all resolver cases pass.

- [ ] **Step 5: Commit the resolver**

```sh
git add server/src/slack/tenant-context.ts server/tests/slack-tenant-context.test.ts
git commit -m "feat: normalize managed Slack tenant context"
```

## Task 3: Normalize once before linking and ingress persistence

**Files:**

- Modify: `server/tests/slack-channel.integration.test.tsx`
- Modify: `server/src/slack/channel.tsx`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Extend the integration harness and write failing managed-delivery tests**

Add `configuredTenantId?: string` to the harness options and pass it through `OpenBotSlackChannelDependencies`.

Write an unknown-tenant regression that captures the exact context received by a custom identity linker and uses a real `SlackIngressRegistry`. Send a mention with `tenantId: "unknown"` and `configuredTenantId: "T05QFA4BW9X"`. Assert:

```ts
expect(seenContext?.tenant.id).toBe("T05QFA4BW9X");
expect(bindCalls).toEqual([
  expect.objectContaining({
    providerTenantId: "T05QFA4BW9X",
    providerConversationId: "C1",
  }),
]);
expect(shared.inputs).toHaveLength(1);
expect(events).toEqual([]);
```

Write a mismatch regression using canonical managed tenant `T2` and configured tenant `T1`. Assert `onTurn` rejects through the Channels `identifyUser` boundary, the custom linker was never called, ingress has no remembered principal for the event, no binding or run occurred, and the only bounded event is:

```ts
[{ type: "slack-turn-failed", phase: "identity.resolve" }]
```

Write a missing-config regression for managed tenant `unknown` with the same fail-closed expectations.

- [ ] **Step 2: Run the integration file and confirm the regressions fail**

Run:

```sh
bun test server/tests/slack-channel.integration.test.tsx
```

Expected: the fallback test still passes `unknown` to the linker, and mismatch/missing-config do not fail at the new boundary.

- [ ] **Step 3: Add normalization to the dependency contract and identity phase**

In `server/src/slack/channel.tsx`, import the resolver and extend the dependency type:

```ts
configuredTenantId?: string;
```

Keep normalization and identity resolution inside one existing diagnostic phase so a rejection remains privacy-safe and observable:

```ts
const { identityContext, identityResult } = await runSlackPhase(
  "identity.resolve",
  async () => {
    const identityContext = normalizeSlackTenantContext(
      context,
      deps.configuredTenantId,
    );
    const identityResult = await deps.identityLinker.resolve(identityContext);
    return { identityContext, identityResult };
  },
  logTurnFailure,
);
await runSlackPhase(
  "ingress.remember",
  () =>
    ingress.remember(eventId(identityContext), {
      identityContext,
      identityResult,
    }),
  logTurnFailure,
);
```

All later authorization and execution continue reading the remembered normalized context. Do not add fallback logic anywhere else.

- [ ] **Step 4: Wire startup configuration into the managed Slack channel**

In `server/src/index.ts`, add:

```ts
configuredTenantId: config.slackTenantId,
```

to the `createOpenBotSlackChannel` dependency object.

- [ ] **Step 5: Run focused Slack tests**

Run:

```sh
bun test \
  server/tests/slack-tenant-context.test.ts \
  server/tests/slack-channel.integration.test.tsx \
  server/tests/slack-identity-linker.test.ts \
  server/tests/slack-ingress-registry.test.ts
```

Expected: all tests pass; existing direct identity-linker tests still reject blank/unknown tenants.

- [ ] **Step 6: Commit the single normalization point**

```sh
git add server/src/slack/channel.tsx server/src/index.ts server/tests/slack-channel.integration.test.tsx
git commit -m "fix: apply Slack tenant fallback before identity linking"
```

## Task 4: Document the deliberately narrow bridge

**Files:**

- Modify: `.env.example`
- Modify: `docs/configuration.md`
- Modify: `docs/slack.md`

- [ ] **Step 1: Add the setting to the example without a production-specific value**

Under the managed Slack setup comments in `.env.example`, add:

```dotenv
# Single-workspace bridge for managed deliveries that omit canonical Slack tenant metadata. Set this
# to the workspace/team ID attached to this Channel. A conflicting known tenant is always rejected.
# Leave unset when Channels supplies canonical tenant metadata for every delivery.
# OPENBOT_SLACK_TENANT_ID=T0123456789
```

- [ ] **Step 2: Document setup, invariants, and removal path**

In `docs/configuration.md`, add `OPENBOT_SLACK_TENANT_ID` to Managed Slack and the general variable table. State that it:

- is a non-secret operator-owned workspace ID;
- is used only for missing/blank/`unknown` canonical managed tenant metadata;
- never overrides a conflicting known tenant;
- supports one Slack workspace per deployment;
- must be removed once Channels reliably supplies canonical tenant metadata.

In `docs/slack.md`, add the same rule to the security/troubleshooting section and explicitly prohibit deriving the workspace from raw payload, actor, email, channel, or installation data.

- [ ] **Step 3: Run formatting and documentation checks**

Run:

```sh
bunx biome format --write .env.example docs/configuration.md docs/slack.md
bun run format:check
```

Expected: formatter check passes and no placeholder like `TODO`, `TBD`, or `FIXME` was introduced.

- [ ] **Step 4: Commit documentation**

```sh
git add .env.example docs/configuration.md docs/slack.md
git commit -m "docs: explain managed Slack tenant bridge"
```

## Task 5: Verify the implementation before review

**Files:**

- Verify only; repair the task files above if any gate fails.

- [ ] **Step 1: Run the cheap-to-expensive local gates**

```sh
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
```

Expected: every command exits zero.

- [ ] **Step 2: Run the repository CI entry point**

```sh
bun run test:ci
```

Expected: the same checks used by CI pass locally.

- [ ] **Step 3: Audit the diff against the approved design**

```sh
git diff origin/main...HEAD --check
git diff origin/main...HEAD -- \
  server/src/config.ts \
  server/src/slack/tenant-context.ts \
  server/src/slack/channel.tsx \
  server/src/index.ts \
  server/tests/config.test.ts \
  server/tests/slack-tenant-context.test.ts \
  server/tests/slack-channel.integration.test.tsx \
  .env.example docs/configuration.md docs/slack.md
rg -n "TODO|TBD|FIXME|raw.*tenant|tenant.*raw" \
  server/src/slack server/tests/slack-* .env.example docs/configuration.md docs/slack.md
```

Confirm the diff has one fallback implementation, no raw-payload inference, no logged tenant ID, no swallowed failure, and no unrelated changes.

- [ ] **Step 4: Run the mandatory completion checklist and commit any verification repairs**

Use the repository's completion and verification skills. If a repair was necessary:

```sh
git add \
  server/src/config.ts \
  server/src/slack/tenant-context.ts \
  server/src/slack/channel.tsx \
  server/src/index.ts \
  server/tests/config.test.ts \
  server/tests/slack-tenant-context.test.ts \
  server/tests/slack-channel.integration.test.tsx \
  .env.example docs/configuration.md docs/slack.md
git commit -m "test: harden Slack tenant fallback"
```

## Task 6: Open, review, merge, and deploy the production fix

**Files:**

- No repository file changes expected unless review finds a defect.
- Railway OpenBot service variable: `OPENBOT_SLACK_TENANT_ID=T05QFA4BW9X`

- [ ] **Step 1: Push the branch and create the PR**

```sh
git push -u origin jerel/slack-tenant-fallback-design
gh pr create \
  --base main \
  --head jerel/slack-tenant-fallback-design \
  --title "fix: safely recover missing managed Slack tenant" \
  --body "## Summary
- recover managed Slack deliveries only when canonical tenant metadata is missing
- reject any conflict between a known managed tenant and the operator-owned workspace ID
- normalize once before identity linking and ingress persistence

## Production evidence
- Railway reported the bounded identity reason slack_identity_tenant_invalid
- Channels 0.9 managed delivery permits omitted tenant metadata and substitutes unknown
- production uses one attached Slack workspace, T05QFA4BW9X

## Security model
- configuration is a single-workspace bridge, not a raw-payload fallback
- no tenant is inferred from actor, email, channel, installation, or raw provider data
- existing account linking and actor/coworker authorization remain required

## Verification
- focused tenant/configuration/channel tests
- formatter, lint, typecheck, full tests, build, and test:ci

## Rollout and rollback
- set OPENBOT_SLACK_TENANT_ID on the OpenBot Railway service
- verify the migration pre-deploy gate and merged SHA
- complete account linking, Slack response, and OpenBot-domain conversation smoke test
- rollback the application deployment or remove the optional setting; never bypass tenant validation"
```

The PR body must include the production evidence (`slack_identity_tenant_invalid`), the upstream Channels omission, the single-workspace security model, tests, and the rollout/rollback steps. Never include credentials or raw provider payloads.

- [ ] **Step 2: Review and converge findings to zero**

Inspect the final PR diff independently, address every actionable finding with tests, rerun affected gates, and wait for required GitHub checks to pass.

- [ ] **Step 3: Configure the non-secret Railway workspace ID**

Follow the Railway operating skill and set exactly:

```text
OPENBOT_SLACK_TENANT_ID=T05QFA4BW9X
```

on the production OpenBot service, not PostgreSQL. Verify the variable name and service target without printing the full environment or any secret values. This configuration change may create a deployment; observe its terminal state before continuing.

- [ ] **Step 4: Merge and observe the application deployment**

Merge only after review and checks pass. Confirm Railway deploys the merged SHA, the pre-deploy migration command succeeds, the deployment reaches terminal `SUCCESS`, `/health` is healthy, and `/api/capabilities` still reports the managed Slack Channel attached/online.

- [ ] **Step 5: Confirm rollback remains safe**

If startup or the deployment fails, Railway must keep the prior healthy deployment serving. Keep the migration gate enabled. Revert the application patch or remove the optional variable only after identifying the failure; do not create a manual identity row and do not bypass tenant validation.

## Task 7: Complete the real Slack acceptance path

**Files:**

- No repository changes expected; use the user's main Chrome session for authenticated UI actions.

- [ ] **Step 1: Send a fresh mention in the approved Slack channel**

In workspace `T05QFA4BW9X`, channel `C0BT2D608QM`, send one uniquely timestamped mention such as:

```text
@openbot tenant fallback acceptance 2026-08-28
```

Expected for the currently unlinked user: one OpenBot account-link card, not `Something went wrong`, and no coworker run yet.

- [ ] **Step 2: Complete secure account linking**

Open the signed link in the user's main Chrome browser, authenticate on the production OpenBot domain if needed, and confirm the Slack identity link. Do not copy the signed token into logs, source, issue text, or chat output.

- [ ] **Step 3: Retry after linking and verify the full response**

Send a new uniquely timestamped `@openbot` mention. Confirm:

- the bot replies in the Slack thread with a non-fallback answer;
- no `slack-turn-failed` or Channels `runtime_handler_failed` event appears for that delivery;
- OpenBot records `channel.routed` for the linked application user and selected coworker;
- the external thread binding uses workspace `T05QFA4BW9X` and the correct Slack conversation/thread identifiers;
- the corresponding conversation is visible on the production OpenBot domain.

- [ ] **Step 4: Preserve acceptance evidence for the later video**

Record the merged SHA, Railway deployment ID, Slack message/thread link, OpenBot conversation URL, and acceptance timestamps in a credential-free handoff. This evidence becomes the shot list for the separately recorded end-to-end acceptance video.

- [ ] **Step 5: Report only the demonstrated outcome**

Declare the Slack integration complete only after the linked Slack reply and OpenBot-domain conversation are both visible. If a later boundary fails, report its exact bounded phase and continue diagnosis without weakening identity, linking, or authorization.
