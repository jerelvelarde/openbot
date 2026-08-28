# Slack Production Diagnostic and Migration Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Prevent Railway schema drift and identify the exact application-owned phase that makes a real Slack mention return “Something went wrong.”

**Architecture:** Add a small Slack-only phase boundary that emits a fixed two-field event and rethrows the original exception, then wrap each application-owned transition in createOpenBotSlackChannel. Configure the Railway OpenBot service to run the existing idempotent migration runner before deployment, deploy the diagnostic, and use one approved Slack mention to produce the evidence required for a separate cause-specific repair plan.

**Tech Stack:** TypeScript, Bun test, CopilotKit Channels 0.9, Biome, Railway CLI, Railway PostgreSQL.

---

## Scope boundary

This is the first of two sequential implementation plans. The approved design makes the final repair depend on one of eight observed phase codes. Implementing that repair before the evidence exists would be speculative, so this plan finishes with a production phase diagnosis. The next plan will contain the exact regression test and smallest code fix for that single observed branch.

## File map

- Create server/src/slack/turn-phase.ts: closed phase union, bounded event, logger, and rethrowing helper.
- Create server/tests/slack-turn-phase.test.ts: unit contract for all allowed phases and logger failure.
- Modify server/src/slack/channel.tsx: inject the logger and wrap the eight application-owned transitions.
- Modify server/tests/slack-channel.integration.test.tsx: inject failures at each channel seam and assert the exact phase.
- Modify Railway production service configuration only: set deploy.preDeployCommand on OpenBot service 0bc50155-f52c-4d2c-8bc1-e69d81e42685.

### Task 1: Add the bounded phase boundary

**Files:**
- Create: server/tests/slack-turn-phase.test.ts
- Create: server/src/slack/turn-phase.ts

- [ ] **Step 1: Write the failing unit tests**

Create server/tests/slack-turn-phase.test.ts:

~~~ts
import { describe, expect, test } from "bun:test";
import {
  SLACK_TURN_PHASES,
  runSlackPhase,
  type SlackTurnFailureEvent,
} from "../src/slack/turn-phase";

describe("Slack turn phase diagnostics", () => {
  test("logs only the fixed event type and phase for every allowed phase", async () => {
    for (const phase of SLACK_TURN_PHASES) {
      const events: SlackTurnFailureEvent[] = [];
      const original = new Error("sensitive failure");

      await expect(
        runSlackPhase(
          phase,
          async () => {
            throw original;
          },
          (event) => events.push(event),
        ),
      ).rejects.toBe(original);

      expect(events).toEqual([{ type: "slack-turn-failed", phase }]);
      expect(Object.keys(events[0] ?? {}).sort()).toEqual(["phase", "type"]);
      expect(JSON.stringify(events)).not.toContain("sensitive");
    }
  });

  test("successful operations are silent", async () => {
    const events: SlackTurnFailureEvent[] = [];
    await expect(
      runSlackPhase("identity.resolve", () => "linked", (event) =>
        events.push(event),
      ),
    ).resolves.toBe("linked");
    expect(events).toEqual([]);
  });

  test("logger failure cannot replace the application error", async () => {
    const original = new Error("application failure");
    await expect(
      runSlackPhase(
        "agent.run",
        async () => {
          throw original;
        },
        () => {
          throw new Error("logger failure");
        },
      ),
    ).rejects.toBe(original);
  });
});
~~~

- [ ] **Step 2: Run the unit test and verify red**

~~~bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bun test server/tests/slack-turn-phase.test.ts
~~~

Expected: FAIL because ../src/slack/turn-phase does not exist.

- [ ] **Step 3: Implement the minimal phase module**

Create server/src/slack/turn-phase.ts:

~~~ts
export const SLACK_TURN_PHASES = [
  "identity.resolve",
  "ingress.remember",
  "ingress.take",
  "identity.validate",
  "link_card.post",
  "thread.subscribe",
  "execution.prepare",
  "agent.run",
] as const;

export type SlackTurnPhase = (typeof SLACK_TURN_PHASES)[number];

export type SlackTurnFailureEvent = {
  type: "slack-turn-failed";
  phase: SlackTurnPhase;
};

export type SlackTurnFailureLogger = (event: SlackTurnFailureEvent) => void;

export const defaultSlackTurnFailureLogger: SlackTurnFailureLogger = (event) => {
  console.error(JSON.stringify(event));
};

export async function runSlackPhase<T>(
  phase: SlackTurnPhase,
  operation: () => T | Promise<T>,
  logger: SlackTurnFailureLogger,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    try {
      logger({ type: "slack-turn-failed", phase });
    } catch {
      // Observability must never replace the application failure.
    }
    throw error;
  }
}
~~~

- [ ] **Step 4: Run the Step 2 command and verify 3 pass, 0 fail.**

- [ ] **Step 5: Format and commit**

~~~bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bunx biome check --write server/src/slack/turn-phase.ts server/tests/slack-turn-phase.test.ts
git add server/src/slack/turn-phase.ts server/tests/slack-turn-phase.test.ts
git commit -m "feat: add bounded Slack turn diagnostics"
~~~

Expected: Biome exits 0 and the commit contains only the two new files.

### Task 2: Wire identity and ingress phases

**Files:**
- Modify: server/src/slack/channel.tsx:23-45,83-130
- Modify: server/tests/slack-channel.integration.test.tsx:355-510,513-690

- [ ] **Step 1: Extend the integration harness with a collector**

Import SlackTurnFailureEvent and SlackTurnFailureLogger from ../src/slack/turn-phase. Add logTurnFailure?: SlackTurnFailureLogger to the harness options. Add:

~~~ts
  const events: SlackTurnFailureEvent[] = [];
~~~

Pass this dependency:

~~~ts
    logTurnFailure:
      options.logTurnFailure ?? ((event) => events.push(event)),
~~~

Return events from harness.

- [ ] **Step 2: Write failing identity and ingress tests**

Add these cases near the existing principal-mismatch case:

~~~ts
  test("reports identity.resolve without leaking the error", async () => {
    const identityLinker: OpenBotSlackChannelDependencies["identityLinker"] = {
      async resolve() {
        throw new Error("secret identity detail");
      },
    };
    const { adapter, channel, events } = harness({ identityLinker });
    await channel.ɵruntime.start();

    await expect(
      adapter.getSink().onTurn(turn("E-resolve-fail", "hello")),
    ).rejects.toThrow("secret identity detail");
    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "identity.resolve" },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret identity detail");
  });

  test("reports ingress.remember", async () => {
    class FailingRememberRegistry extends SlackIngressRegistry {
      override remember(): void {
        throw new Error("remember failed");
      }
    }
    const { adapter, channel, events } = harness({
      ingressRegistry: new FailingRememberRegistry(),
    });
    await channel.ɵruntime.start();

    await expect(
      adapter.getSink().onTurn(turn("E-remember-fail", "hello")),
    ).rejects.toThrow("remember failed");
    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "ingress.remember" },
    ]);
  });

  test("reports ingress.take before binding or running", async () => {
    class FailingTakeRegistry extends SlackIngressRegistry {
      override take(): never {
        throw new Error("take failed");
      }
    }
    const { adapter, channel, bindCalls, shared, events } = harness({
      ingressRegistry: new FailingTakeRegistry(),
    });
    await channel.ɵruntime.start();

    await expect(
      adapter.getSink().onTurn(turn("E-take-fail", "hello")),
    ).rejects.toThrow("take failed");
    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "ingress.take" },
    ]);
    expect(bindCalls).toEqual([]);
    expect(shared.inputs).toEqual([]);
  });
~~~

In the existing provider/canonical principal mismatch test, return events and assert:

~~~ts
    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "identity.validate" },
    ]);
~~~

- [ ] **Step 3: Run the four cases and verify red**

~~~bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bun test server/tests/slack-channel.integration.test.tsx --test-name-pattern 'identity.resolve|ingress.remember|ingress.take|principal mismatch'
~~~

Expected: FAIL because the dependency and wrappers do not exist.

- [ ] **Step 4: Add the dependency and wrappers**

In server/src/slack/channel.tsx import defaultSlackTurnFailureLogger, runSlackPhase, and SlackTurnFailureLogger from ./turn-phase. Add this dependency:

~~~ts
  logTurnFailure?: SlackTurnFailureLogger;
~~~

At function entry select:

~~~ts
  const logTurnFailure =
    deps.logTurnFailure ?? defaultSlackTurnFailureLogger;
~~~

Replace identifyUser with:

~~~ts
    identifyUser: async (context) => {
      if (context.actor.kind !== "human") return null;
      const identityResult = await runSlackPhase(
        "identity.resolve",
        () => deps.identityLinker.resolve(context),
        logTurnFailure,
      );
      await runSlackPhase(
        "ingress.remember",
        () =>
          ingress.remember(eventId(context), {
            identityContext: context,
            identityResult,
          }),
        logTurnFailure,
      );
      return identityResult.kind === "linked" ? identityResult.user : null;
    },
~~~

Replace ingress take and validation with:

~~~ts
    const remembered = await runSlackPhase(
      "ingress.take",
      () =>
        ingress.take(message.eventId, {
          provider: "slack",
          providerActorId: message.actor.id,
          applicationUserId: message.user?.id ?? null,
        }),
      logTurnFailure,
    );
    await runSlackPhase(
      "identity.validate",
      () => {
        if (!remembered || !validRememberedPrincipal(remembered, message)) {
          throw new Error(
            "Managed Slack ingress identity is no longer available.",
          );
        }
      },
      logTurnFailure,
    );
    if (!remembered) {
      throw new Error("Managed Slack ingress identity is no longer available.");
    }
~~~

The last guard is unreachable after successful validation and exists only for TypeScript narrowing. Do not change the selector, validation predicate, or one-use registry.

- [ ] **Step 5: Run the Step 3 command and verify all selected tests pass.**

- [ ] **Step 6: Format, typecheck, and commit**

~~~bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bunx biome check --write server/src/slack/channel.tsx server/tests/slack-channel.integration.test.tsx
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bun run --filter server typecheck
git add server/src/slack/channel.tsx server/tests/slack-channel.integration.test.tsx
git commit -m "feat: diagnose Slack identity ingress failures"
~~~

Expected: both checks exit 0.

### Task 3: Wire delivery and execution phases

**Files:**
- Modify: server/src/slack/channel.tsx:126-159
- Modify: server/tests/slack-channel.integration.test.tsx:355-510,513-760

- [ ] **Step 1: Add deterministic failure seams**

Add failPost?: boolean, failSubscribe?: boolean, and failExecutionPrepare?: boolean to harness options. Override adapter.post for failPost:

~~~ts
  if (options.failPost) {
    adapter.post = async () => {
      throw new Error("post failed");
    };
  }
~~~

For failSubscribe, use a MemoryStore wrapper after adapter.stateStore assignment:

~~~ts
  if (options.failSubscribe) {
    const backing = new MemoryStore();
    adapter.stateStore = {
      kv: {
        ...backing.kv,
        set: async (key, value, ttlMs) => {
          if (key.startsWith("sub:")) {
            throw new Error("subscribe failed");
          }
          await backing.kv.set(key, value, ttlMs);
        },
      },
      list: backing.list,
      lock: backing.lock,
      dedup: backing.dedup,
      queue: backing.queue,
    };
  }
~~~

Pass this test-only preparation failure through channel dependencies:

~~~ts
    prepareExecution: options.failExecutionPrepare
      ? () => {
          throw new Error("prepare failed");
        }
      : undefined,
~~~

- [ ] **Step 2: Write failing delivery and execution tests**

~~~ts
  test("reports link_card.post for an unlinked post failure", async () => {
    const { adapter, channel, events, shared, bindCalls } = harness({
      failPost: true,
    });
    await channel.ɵruntime.start();
    await expect(
      adapter
        .getSink()
        .onTurn(turn("E-link-post", "hello", { actorId: "UNLINKED" })),
    ).rejects.toThrow("post failed");
    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "link_card.post" },
    ]);
    expect(shared.inputs).toEqual([]);
    expect(bindCalls).toEqual([]);
  });

  test("reports thread.subscribe before binding or running", async () => {
    const { adapter, channel, events, shared, bindCalls } = harness({
      failSubscribe: true,
    });
    await channel.ɵruntime.start();
    await expect(
      adapter.getSink().onTurn(turn("E-subscribe", "hello")),
    ).rejects.toThrow("subscribe failed");
    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "thread.subscribe" },
    ]);
    expect(shared.inputs).toEqual([]);
    expect(bindCalls).toEqual([]);
  });

  test("reports execution.prepare before agent execution", async () => {
    const { adapter, channel, events, shared } = harness({
      failExecutionPrepare: true,
    });
    await channel.ɵruntime.start();
    await expect(
      adapter.getSink().onTurn(turn("E-prepare", "hello")),
    ).rejects.toThrow("prepare failed");
    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "execution.prepare" },
    ]);
    expect(shared.inputs).toEqual([]);
  });

  test("reports agent.run without leaking coworker errors", async () => {
    const resolver: ActorAgentResolver = {
      async resolveAgentsForActor() {
        return {};
      },
      async resolveAgentForActor() {
        throw new Error("agent detail must not be logged");
      },
    };
    const { adapter, channel, events } = harness({ resolver });
    await channel.ɵruntime.start();
    await expect(
      adapter.getSink().onTurn(turn("E-agent", "hello")),
    ).rejects.toThrow("agent detail must not be logged");
    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "agent.run" },
    ]);
    expect(JSON.stringify(events)).not.toContain("agent detail");
  });
~~~

- [ ] **Step 3: Run the four cases and verify red**

~~~bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bun test server/tests/slack-channel.integration.test.tsx --test-name-pattern 'link_card.post|thread.subscribe|execution.prepare|agent.run'
~~~

Expected: FAIL because delivery/execution wrappers do not exist.

- [ ] **Step 4: Add the narrow execution preparation seam**

Immediately after executionFor, define:

~~~ts
type SlackExecutionPreparer = typeof executionFor;
~~~

Add prepareExecution?: SlackExecutionPreparer to dependencies, then select:

~~~ts
  const prepareExecution = deps.prepareExecution ?? executionFor;
~~~

- [ ] **Step 5: Wrap delivery and execution operations**

Replace the remainder of runLinked with:

~~~ts
    if (remembered.identityResult.kind === "unlinked") {
      await runSlackPhase(
        "link_card.post",
        () => thread.post(linkCard(remembered.identityResult.linkUrl)),
        logTurnFailure,
      );
      return;
    }
    if (!message.user) {
      await runSlackPhase(
        "identity.validate",
        () => {
          throw new Error(
            "Managed Slack ingress identity did not match its user.",
          );
        },
        logTurnFailure,
      );
      return;
    }
    if (subscribe) {
      await runSlackPhase(
        "thread.subscribe",
        () => thread.subscribe(),
        logTurnFailure,
      );
    }
    const execution = await runSlackPhase(
      "execution.prepare",
      () =>
        prepareExecution(
          remembered.identityContext,
          remembered.identityResult,
          thread.conversationKey,
          message.text,
        ),
      logTurnFailure,
    );
    await runSlackPhase(
      "agent.run",
      () =>
        runWithSlackExecution(execution, () =>
          thread.runAgent(
            message.contentParts?.length
              ? { prompt: message.contentParts }
              : undefined,
          ),
        ),
      logTurnFailure,
    );
~~~

Do not add a fallback post; Channels retains its single generic provider response.

- [ ] **Step 6: Run all focused Slack tests**

~~~bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bun test server/tests/slack-turn-phase.test.ts server/tests/slack-identity-linker.test.ts server/tests/slack-ingress-registry.test.ts server/tests/slack-channel.integration.test.tsx server/tests/migration-journal.test.ts
~~~

Expected: the prior 43 cases plus all new cases pass; 0 fail.

- [ ] **Step 7: Format, typecheck, and commit**

~~~bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bunx biome check --write server/src/slack/channel.tsx server/tests/slack-channel.integration.test.tsx
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bun run --filter server typecheck
git add server/src/slack/channel.tsx server/tests/slack-channel.integration.test.tsx
git commit -m "feat: diagnose Slack delivery phase failures"
~~~

Expected: checks exit 0.

### Task 4: Configure and verify Railway's migration gate

**Files:**
- Modify externally: Railway project 51dff52d-610a-4143-a317-8d0629e90fef, production environment 717f01b2-9466-4629-b357-3fc27bf3cf8a, OpenBot service 0bc50155-f52c-4d2c-8bc1-e69d81e42685

- [ ] **Step 1: Confirm the exact target**

Run the Railway workflow preflight once:

~~~bash
command -v railway
RAILWAY_CALLER=skill:use-railway@1.3.0 RAILWAY_AGENT_SESSION=railway-slack-durable-20260827 railway whoami --json
RAILWAY_CALLER=skill:use-railway@1.3.0 RAILWAY_AGENT_SESSION=railway-slack-durable-20260827 railway --version
RAILWAY_CALLER=skill:use-railway@1.3.0 RAILWAY_AGENT_SESSION=railway-slack-durable-20260827 railway --help 2>&1 | grep -A4 "Agent tooling:"
~~~

Expected: the CLI exists, authentication succeeds, and the tooling health block has no missing component. Then confirm service 0bc50155-f52c-4d2c-8bc1-e69d81e42685 is OpenBot in production. It must not be PostgreSQL service 2732f5be-68ce-4adc-93e7-c0d093c5e882.

- [ ] **Step 2: Set the pre-deploy command**

~~~bash
RAILWAY_CALLER=skill:use-railway@1.3.0 RAILWAY_AGENT_SESSION=railway-slack-durable-20260827 railway environment edit \
  --project 51dff52d-610a-4143-a317-8d0629e90fef \
  --environment 717f01b2-9466-4629-b357-3fc27bf3cf8a \
  --service-config 0bc50155-f52c-4d2c-8bc1-e69d81e42685 \
  deploy.preDeployCommand \
  'cd /app/server && /usr/local/bin/bun scripts/migrate.ts' \
  --message 'Run OpenBot migrations before production deploy' \
  --json
~~~

Expected: JSON success for the production environment configuration commit.

- [ ] **Step 3: Verify the exact read-back**

In the production OpenBot Deploy settings, confirm Pre-deploy Command is exactly:

~~~text
cd /app/server && /usr/local/bin/bun scripts/migrate.ts
~~~

Confirm git status shows no railway.toml, railway.json, or Railway link file.

- [ ] **Step 4: Verify idempotency in the deployed image**

Run twice from the Railway OpenBot console:

~~~bash
cd /app/server && /usr/local/bin/bun scripts/migrate.ts
~~~

Expected both times:

~~~json
{"type":"migrations-applied","status":"ok"}
~~~

Query the journal from the same image:

~~~bash
/usr/local/bin/bun -e 'import postgres from "postgres"; const sql=postgres(process.env.DATABASE_URL,{max:1}); const rows=await sql`select count(*)::int as count from drizzle.__drizzle_migrations`; console.log(JSON.stringify(rows[0])); await sql.end();'
~~~

Expected: {"count":22}. Do not insert or update identity rows.

### Task 5: Verify, review, merge, and deploy the diagnostic

**Files:**
- Verify only; no additional production source files

- [ ] **Step 1: Run the focused clean baseline**

Run the Task 3 Step 6 command. Expected: all selected tests pass, 0 fail.

- [ ] **Step 2: Run static checks**

~~~bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bun run format:check
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bun run lint
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app oven/bun:1.3.14 bun run --filter server typecheck
~~~

Expected: all exit 0. The known full-suite environment gaps—no local PostgreSQL and missing @ag-ui/encoder in the separate agent-bot package—do not excuse any focused Slack failure.

- [ ] **Step 3: Inspect the branch boundary**

~~~bash
git status --short --branch
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
~~~

Expected: clean tree, no whitespace errors, no Typefully files, and no secrets.

- [ ] **Step 4: Push and open the PR**

~~~bash
git push -u origin jerel/slack-durable-fix
gh pr create \
  --base main \
  --head jerel/slack-durable-fix \
  --title 'Diagnose Slack delivery failures and gate Railway migrations' \
  --body-file docs/superpowers/specs/2026-08-27-slack-production-durability-design.md
~~~

Expected: GitHub returns a PR URL.

- [ ] **Step 5: Review and merge**

Run the repository-required code review and CI. Merge only when required checks are green and actionable findings have converged to zero.

- [ ] **Step 6: Verify terminal Railway deployment**

Wait for terminal SUCCESS. Confirm deployment logs show the migration success event before application start and health success. A failed migration must block promotion.

### Task 6: Produce the exact production phase evidence

**Files:**
- Create after evidence: exactly one filename selected from the phase-to-file mapping in Step 5

- [ ] **Step 1: Obtain action-time approval**

Before sending an external message, ask the user to approve one fresh test mention in workspace T05QFA4BW9X, channel C0BT2D608QM. Earlier approval does not authorize a new post.

- [ ] **Step 2: Send one reproduction**

After approval, send exactly:

~~~text
@openbot whatsup
~~~

Do not retry until that delivery reaches a terminal result.

- [ ] **Step 3: Record the bounded phase**

Read Railway logs for the reproduction window and record exactly one of identity.resolve, ingress.remember, ingress.take, identity.validate, link_card.post, thread.subscribe, execution.prepare, or agent.run. The diagnostic event must contain only type and phase. If Channels fails with no OpenBot phase, record an upstream-boundary result and return to design without broadening logs.

- [ ] **Step 4: Confirm security invariants**

Verify no Slack IDs, email, content, signed URL/token, or serialized identity context was logged; no manual external_user_links row was created; unlinked ingress created no coworker binding or run; linked ingress retained reauthorization and immutable binding up to the failure.

- [ ] **Step 5: Write the exact second-stage plan**

Select the exact filename from this mapping:

| Observed phase | Plan file |
| --- | --- |
| identity.resolve | docs/superpowers/plans/2026-08-27-slack-identity-resolve-repair.md |
| ingress.remember | docs/superpowers/plans/2026-08-27-slack-ingress-remember-repair.md |
| ingress.take | docs/superpowers/plans/2026-08-27-slack-ingress-take-repair.md |
| identity.validate | docs/superpowers/plans/2026-08-27-slack-identity-validate-repair.md |
| link_card.post | docs/superpowers/plans/2026-08-27-slack-link-card-post-repair.md |
| thread.subscribe | docs/superpowers/plans/2026-08-27-slack-thread-subscribe-repair.md |
| execution.prepare | docs/superpowers/plans/2026-08-27-slack-execution-prepare-repair.md |
| agent.run | docs/superpowers/plans/2026-08-27-slack-agent-run-repair.md |

Include the production-contract regression test and only the matching cause branch from the approved design. Explicitly preserve canonical identity fields, fail-closed tenant/actor checks, one-use ingress, secure account linking, and Channels-owned fallback behavior.

- [ ] **Step 6: Commit the evidence-based plan**

~~~bash
git add -f docs/superpowers/plans/2026-08-27-slack-*-repair.md
git commit -m "docs: plan evidence-based Slack repair"
~~~

Expected: exactly one cause-specific plan, with no speculative alternate fix.
