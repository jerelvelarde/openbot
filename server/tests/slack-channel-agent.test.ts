import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  EMPTY,
  lastValueFrom,
  NEVER,
  type Observable,
  of,
  throwError,
} from "rxjs";
import { toArray } from "rxjs/operators";
import type { ActorAgentResolver } from "../src/agents/agent-resolver";
import type {
  ExternalThreadBinding,
  ExternalThreadStore,
} from "../src/external/thread-store";
import type { CoworkerRoutingService } from "../src/routing/service";
import {
  OpenBotChannelAgent,
  type OpenBotChannelAgentDependencies,
} from "../src/slack/channel-agent";
import {
  currentSlackExecution,
  runWithSlackExecution,
  type SlackExecution,
} from "../src/slack/execution-context";

const CANONICAL_THREAD_ID = "channels-thread-1";
const ACTOR = { id: "alice", role: "user" } as const;

function execution(overrides: Partial<SlackExecution> = {}): SlackExecution {
  return {
    actor: ACTOR,
    applicationUser: { id: "alice", name: "Alice" },
    provider: "slack",
    providerTenantId: "tenant-1",
    providerConversationId: "conversation-1",
    providerThreadId: "slack-thread-1",
    messageText: "Please review this risk.",
    ...overrides,
  };
}

function input(): RunAgentInput {
  return {
    threadId: "runtime-thread",
    runId: "run-1",
    state: { existing: true },
    messages: [{ id: "message-1", role: "user", content: "original input" }],
    tools: [],
    context: [{ description: "ordinary context", value: "kept" }],
    forwardedProps: { ordinary: "kept" },
  };
}

function binding(
  overrides: Partial<ExternalThreadBinding> = {},
): ExternalThreadBinding {
  return {
    channelsThreadId: CANONICAL_THREAD_ID,
    provider: "slack",
    providerTenantId: "tenant-1",
    providerConversationId: "conversation-1",
    providerThreadId: "slack-thread-1",
    agentId: "risk",
    agentName: "Risk Analyst",
    createdByUserId: "alice",
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
    ...overrides,
  };
}

class ScriptedAgent extends AbstractAgent {
  readonly received: RunAgentInput[] = [];
  aborts = 0;

  constructor(
    readonly script: (input: RunAgentInput) => Observable<BaseEvent> = () =>
      EMPTY,
  ) {
    super({ agentId: "scripted", description: "scripted target" });
  }

  run(runInput: RunAgentInput): Observable<BaseEvent> {
    this.received.push(runInput);
    return this.script(runInput);
  }

  abortRun(): void {
    this.aborts += 1;
    super.abortRun();
  }
}

function harness(
  options: {
    existing?: ExternalThreadBinding | null;
    route?: Awaited<ReturnType<CoworkerRoutingService["route"]>>;
    resolve?: ActorAgentResolver["resolveAgentForActor"];
  } = {},
) {
  const getCalls: string[] = [];
  const bindCalls: Parameters<ExternalThreadStore["bind"]>[0][] = [];
  const routeCalls: Parameters<CoworkerRoutingService["route"]>[0][] = [];
  const resolveCalls: Parameters<ActorAgentResolver["resolveAgentForActor"]>[] =
    [];
  const target = new ScriptedAgent(() =>
    of(
      { type: "CUSTOM", name: "first", value: 1 } as BaseEvent,
      { type: "CUSTOM", name: "second", value: 2 } as BaseEvent,
    ),
  );
  const store: ExternalThreadStore = {
    async getByChannelsThreadId(id) {
      getCalls.push(id);
      return options.existing ?? null;
    },
    async getByProviderThread() {
      return null;
    },
    async bind(value) {
      bindCalls.push(value);
      return binding({
        ...value,
        createdAt: new Date("2026-08-27T00:00:00.000Z"),
      });
    },
  };
  const routing: CoworkerRoutingService = {
    async route(value) {
      routeCalls.push(value);
      return (
        options.route ?? {
          kind: "selected",
          agentId: "risk",
          name: "Risk Analyst",
          reason: "requested",
          fallback: false,
          viaMention: false,
        }
      );
    },
  };
  const resolver: ActorAgentResolver = {
    async resolveAgentsForActor() {
      return {};
    },
    async resolveAgentForActor(actor, agentId) {
      resolveCalls.push([actor, agentId]);
      return options.resolve
        ? options.resolve(actor, agentId)
        : Promise.resolve(target);
    },
  };
  const deps: OpenBotChannelAgentDependencies = { routing, store, resolver };

  return {
    agent: new OpenBotChannelAgent(CANONICAL_THREAD_ID, deps),
    target,
    getCalls,
    bindCalls,
    routeCalls,
    resolveCalls,
    deps,
  };
}

async function collect(agent: OpenBotChannelAgent, runInput = input()) {
  return runWithSlackExecution(execution(), () =>
    lastValueFrom(agent.run(runInput).pipe(toArray())),
  );
}

describe("OpenBotChannelAgent", () => {
  test("routes a first Slack turn, binds its trusted identity, and forwards events", async () => {
    const { agent, target, getCalls, bindCalls, routeCalls, resolveCalls } =
      harness();
    const events = await collect(agent);

    expect(getCalls).toEqual([CANONICAL_THREAD_ID]);
    expect(routeCalls).toEqual([
      { actor: ACTOR, text: "Please review this risk." },
    ]);
    expect(bindCalls).toEqual([
      {
        channelsThreadId: CANONICAL_THREAD_ID,
        provider: "slack",
        providerTenantId: "tenant-1",
        providerConversationId: "conversation-1",
        providerThreadId: "slack-thread-1",
        agentId: "risk",
        agentName: "Risk Analyst",
        createdByUserId: "alice",
      },
    ]);
    expect(resolveCalls).toEqual([[ACTOR, "risk"]]);
    expect(target.received).toHaveLength(1);
    expect(events).toEqual([
      { type: "CUSTOM", name: "first", value: 1 },
      { type: "CUSTOM", name: "second", value: 2 },
    ]);
  });

  test("uses an established binding and resolves it freshly for the current speaker", async () => {
    const { agent, bindCalls, routeCalls, resolveCalls } = harness({
      existing: binding({ agentId: "knowledge", agentName: "Knowledge" }),
    });
    await runWithSlackExecution(
      execution({ actor: { id: "bob", role: "user" } }),
      () => lastValueFrom(agent.run(input()).pipe(toArray())),
    );

    expect(routeCalls).toEqual([]);
    expect(bindCalls).toEqual([]);
    expect(resolveCalls).toEqual([[{ id: "bob", role: "user" }, "knowledge"]]);
  });

  test("keeps a linked coworker pinned when the current participant loses access", async () => {
    const { agent, bindCalls, routeCalls } = harness({
      existing: binding({ agentId: "private-risk", agentName: "Private Risk" }),
      resolve: async () => {
        throw new Error("Coworker private-risk is unavailable to this user.");
      },
    });

    await expect(collect(agent)).rejects.toThrow(
      "Coworker private-risk is unavailable to this user.",
    );
    expect(bindCalls).toEqual([]);
    expect(routeCalls).toEqual([]);
  });

  test("rejects a first turn with the stable no-coworker error", async () => {
    const { agent, bindCalls } = harness({ route: { kind: "none" } });

    await expect(collect(agent)).rejects.toThrow(
      "No coworker is available to you.",
    );
    expect(bindCalls).toEqual([]);
  });

  test("lists every ambiguous coworker name without assuming a service shape", async () => {
    const { agent } = harness({
      route: { kind: "ambiguous", names: ["A", "B"] },
    });

    await expect(collect(agent)).rejects.toThrow("Name one coworker: A, B.");
  });

  test("delegates the exact original input without leaking private Slack execution", async () => {
    const { agent, target } = harness();
    const original = input();
    await runWithSlackExecution(execution(), () =>
      lastValueFrom(agent.run(original).pipe(toArray())),
    );

    expect(target.received[0]).toBe(original);
    for (const property of [
      "provider",
      "providerTenantId",
      "providerConversationId",
      "providerThreadId",
      "applicationUser",
      "actor",
      "messageText",
      "channelsThreadId",
      "agentId",
    ]) {
      expect(target.received[0]).not.toHaveProperty(property);
    }
    expect(target.received[0].context).toBe(original.context);
    expect(target.received[0].forwardedProps).toBe(original.forwardedProps);
    expect(target.received[0].messages).toBe(original.messages);
  });

  test("only updates current mutable routing fields in the private execution", async () => {
    const { agent } = harness();
    await runWithSlackExecution(execution(), async () => {
      const current = currentSlackExecution();
      await lastValueFrom(agent.run(input()).pipe(toArray()));
      expect(current.channelsThreadId).toBe(CANONICAL_THREAD_ID);
      expect(current.agentId).toBe("risk");
      expect(current).toMatchObject({
        actor: ACTOR,
        applicationUser: { id: "alice", name: "Alice" },
        provider: "slack",
        providerTenantId: "tenant-1",
        providerConversationId: "conversation-1",
        providerThreadId: "slack-thread-1",
        messageText: "Please review this risk.",
      });
    });
  });

  test("clones are distinct fully configured agents with independent delegate abort state", async () => {
    const first = new ScriptedAgent(() => NEVER);
    const second = new ScriptedAgent(() => NEVER);
    const { agent, deps } = harness({
      existing: binding(),
      resolve: async (actor) => (actor.id === "alice" ? first : second),
    });
    const clone = agent.clone();
    expect(clone).toBeInstanceOf(OpenBotChannelAgent);
    expect(clone).not.toBe(agent);
    expect(clone.agentId).toBe("openbot-slack");
    expect(clone.description).toBe("OpenBot Slack router");

    const originalSubscription = runWithSlackExecution(execution(), () =>
      agent.run(input()).subscribe(),
    );
    const cloneSubscription = runWithSlackExecution(
      execution({ actor: { id: "bob", role: "user" } }),
      () => clone.run(input()).subscribe(),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(1);
    agent.abortRun();
    expect(first.aborts).toBe(1);
    expect(second.aborts).toBe(0);
    originalSubscription.unsubscribe();
    cloneSubscription.unsubscribe();
    expect(deps).toBeDefined();
  });

  test("an abort before resolution cannot abort a later run's target", async () => {
    let resolveFirst!: (agent: AbstractAgent) => void;
    const firstResolution = new Promise<AbstractAgent>((resolve) => {
      resolveFirst = resolve;
    });
    const oldTarget = new ScriptedAgent(() => NEVER);
    const futureTarget = new ScriptedAgent(() => NEVER);
    let calls = 0;
    const { agent } = harness({
      existing: binding(),
      resolve: async () => {
        calls += 1;
        return calls === 1 ? firstResolution : futureTarget;
      },
    });

    const oldSubscription = runWithSlackExecution(execution(), () =>
      agent.run(input()).subscribe(),
    );
    await Promise.resolve();
    agent.abortRun();
    const futureSubscription = runWithSlackExecution(execution(), () =>
      agent.run(input()).subscribe(),
    );
    await Promise.resolve();
    await Promise.resolve();
    resolveFirst(oldTarget);
    await Promise.resolve();

    expect(futureTarget.aborts).toBe(0);
    expect(oldTarget.aborts).toBe(0);
    oldSubscription.unsubscribe();
    futureSubscription.unsubscribe();
  });

  test("propagates resolver and delegated run failures through its observable", async () => {
    const resolverFailure = harness({
      existing: binding(),
      resolve: async () => {
        throw new Error("resolver failed");
      },
    });
    await expect(collect(resolverFailure.agent)).rejects.toThrow(
      "resolver failed",
    );

    const targetFailure = new ScriptedAgent(() =>
      throwError(() => new Error("target failed")),
    );
    const delegatedFailure = harness({
      existing: binding(),
      resolve: async () => targetFailure,
    });
    await expect(collect(delegatedFailure.agent)).rejects.toThrow(
      "target failed",
    );
  });
});
