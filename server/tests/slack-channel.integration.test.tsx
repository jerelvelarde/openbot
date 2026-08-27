import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import type {
  ChannelIdentityContext,
  ChannelNode,
  IncomingTurn,
  InteractionEvent,
  PlatformAdapter,
} from "@copilotkit/channels";
import { Observable } from "rxjs";
import type { ActorAgentResolver } from "../src/agents/agent-resolver";
import type { ComputerGateway } from "../src/computer/gateway";
import type {
  ExternalThreadBinding,
  ExternalThreadStore,
} from "../src/external/thread-store";
import type { CoworkerRoutingService } from "../src/routing/service";
import type { ApprovalPresentation } from "../src/slack/approval-store";
import {
  createOpenBotSlackChannel,
  type OpenBotSlackChannelDependencies,
} from "../src/slack/channel";
import { configureApprovalDecisionStore } from "../src/slack/components";
import type { SlackIdentityResult } from "../src/slack/identity-linker";

type SharedRunState = {
  inputs: RunAgentInput[];
  active: number;
  maxActive: number;
  blockRuns: boolean;
  pendingFinishes: Array<() => void>;
  requestApproval: boolean;
  approvalPresented: boolean;
};

type FakeAdapterInstance = PlatformAdapter & {
  posted: ChannelNode[][];
  getSink(): {
    onTurn(turn: IncomingTurn): void | Promise<void>;
    onInteraction(event: InteractionEvent): void | Promise<void>;
  };
};

type FakeAdapterConstructor = new (options: {
  platform: string;
  messageEvents: boolean;
}) => FakeAdapterInstance;

// Channels 0.9's umbrella testing export accidentally points at the core conformance helper.
// Resolve the package's own core dependency so this still exercises the SDK's shipped FakeAdapter.
const channelsEntry = import.meta.resolve("@copilotkit/channels");
const fakeAdapterModule = new URL(
  "../../channels-core/dist/testing/fake-adapter.js",
  channelsEntry,
).href;
const { FakeAdapter } = (await import(fakeAdapterModule)) as {
  FakeAdapter: FakeAdapterConstructor;
};

class ReplyAgent extends AbstractAgent {
  constructor(private readonly shared: SharedRunState) {
    super({ agentId: "risk", description: "Risk Analyst" });
  }

  override clone(): ReplyAgent {
    return new ReplyAgent(this.shared);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.shared.inputs.push(input);
    this.shared.active += 1;
    this.shared.maxActive = Math.max(this.shared.maxActive, this.shared.active);
    return new Observable((subscriber) => {
      const finish = () => {
        const messageId = `reply-${this.shared.inputs.length}`;
        subscriber.next({
          type: "RUN_STARTED",
          threadId: input.threadId,
          runId: input.runId,
        });
        if (
          this.shared.requestApproval &&
          !this.shared.approvalPresented &&
          !input.forwardedProps?.command
        ) {
          this.shared.approvalPresented = true;
          subscriber.next({
            type: "TOOL_CALL_START",
            toolCallId: "approval-call-1",
            toolCallName: "approval_card",
            parentMessageId: "",
          });
          subscriber.next({
            type: "TOOL_CALL_ARGS",
            toolCallId: "approval-call-1",
            delta: JSON.stringify({ question: "Deploy this release?" }),
          });
          subscriber.next({
            type: "TOOL_CALL_END",
            toolCallId: "approval-call-1",
          });
        } else {
          subscriber.next({
            type: "TEXT_MESSAGE_START",
            messageId,
            role: "assistant",
          });
          subscriber.next({
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: "review complete",
          });
          subscriber.next({
            type: "TEXT_MESSAGE_END",
            messageId,
          });
        }
        subscriber.next({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        });
        this.shared.active -= 1;
        subscriber.complete();
      };
      if (this.shared.blockRuns) this.shared.pendingFinishes.push(finish);
      else finish();
    });
  }
}

function identity(eventId: string, actorId: string): ChannelIdentityContext {
  return {
    provider: "slack",
    tenant: { id: "T1" },
    installation: { id: "I1" },
    actor: { id: actorId, kind: "human", name: actorId },
    conversation: { id: "C1" },
    trigger: "message",
    event: { id: eventId },
    raw: null,
  };
}

function turn(
  eventId: string,
  text: string,
  options: {
    actorId?: string;
    mentioned?: boolean;
    kind?: "created" | "updated" | "deleted";
  } = {},
) {
  const actorId = options.actorId ?? "U1";
  const kind = options.kind ?? "created";
  return {
    eventId,
    conversationKey: "slack:T1:C1:root-1",
    replyTarget: {},
    userText: text,
    platform: "slack",
    actor: { id: actorId, kind: "human" as const, name: actorId },
    identityContext: identity(eventId, actorId),
    operation: {
      kind,
      logicalMessageId: eventId,
      revisionId: `${eventId}:${kind}`,
      mentioned: options.mentioned ?? true,
    },
  };
}

function postedText(adapter: FakeAdapter): string {
  return JSON.stringify(adapter.posted);
}

function actionIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const node = value as { props?: Record<string, unknown> };
  const onClick = node.props?.onClick;
  const own =
    onClick && typeof onClick === "object" && "id" in onClick
      ? [String(onClick.id)]
      : [];
  const children = node.props?.children;
  return [
    ...own,
    ...(Array.isArray(children)
      ? children.flatMap(actionIds)
      : actionIds(children)),
  ];
}

function harness(options: { computerGateway?: ComputerGateway } = {}) {
  const adapter = new FakeAdapter({ platform: "slack", messageEvents: true });
  const createRunRenderer = adapter.createRunRenderer.bind(adapter);
  adapter.createRunRenderer = (target) => {
    const renderer = createRunRenderer(target);
    const onText = renderer.subscriber.onTextMessageContentEvent?.bind(
      renderer.subscriber,
    );
    let streamed = "";
    renderer.subscriber.onTextMessageContentEvent = (event) => {
      streamed += event.event.delta;
      onText?.(event);
    };
    const finish = renderer.finish?.bind(renderer);
    renderer.finish = async () => {
      if (streamed) {
        adapter.posted.push([{ type: "text", props: { value: streamed } }]);
      }
      await finish?.();
    };
    return renderer;
  };
  const bindings = new Map<string, ExternalThreadBinding>();
  const bindCalls: Parameters<ExternalThreadStore["bind"]>[0][] = [];
  const shared: SharedRunState = {
    inputs: [],
    active: 0,
    maxActive: 0,
    blockRuns: false,
    pendingFinishes: [],
    requestApproval: false,
    approvalPresented: false,
  };
  const target = new ReplyAgent(shared);
  const actors: string[] = [];
  const linker = {
    async resolve(
      context: ChannelIdentityContext,
    ): Promise<SlackIdentityResult> {
      const providerUserId = context.actor.id;
      if (providerUserId === "UNLINKED") {
        return {
          kind: "unlinked",
          linkUrl: "https://openbot.test/link/slack?token=opaque",
          identity: {
            provider: "slack",
            providerTenantId: "T1",
            providerUserId,
            providerEmail: null,
          },
        };
      }
      return {
        kind: "linked",
        user: { id: providerUserId.toLowerCase(), name: providerUserId },
        actor: { id: providerUserId.toLowerCase(), role: "user" },
        identity: {
          provider: "slack",
          providerTenantId: "T1",
          providerUserId,
          providerEmail: null,
        },
      };
    },
  };
  const store: ExternalThreadStore = {
    async getByChannelsThreadId(id) {
      return bindings.get(id) ?? null;
    },
    async getByProviderThread() {
      return null;
    },
    async bind(input) {
      bindCalls.push(input);
      const value = {
        ...input,
        createdAt: new Date("2026-08-27T00:00:00.000Z"),
      };
      bindings.set(input.channelsThreadId, value);
      return value;
    },
  };
  const routing: CoworkerRoutingService = {
    async route() {
      return {
        kind: "selected",
        agentId: "risk",
        name: "Risk Analyst",
        reason: "requested",
        fallback: false,
        viaMention: true,
      };
    },
  };
  const resolver: ActorAgentResolver = {
    async resolveAgentsForActor() {
      return { risk: target };
    },
    async resolveAgentForActor(actor) {
      actors.push(actor.id);
      return target;
    },
  };
  const deps: OpenBotSlackChannelDependencies = {
    identityLinker: linker,
    agentDeps: { routing, store, resolver },
    computerGateway: options.computerGateway,
  };
  const channel = createOpenBotSlackChannel(deps);
  channel.ɵruntime.addAdapter(adapter);
  return { adapter, channel, bindings, bindCalls, shared, actors };
}

describe("managed OpenBot Slack channel", () => {
  test("an unlinked mention posts a link without running or binding", async () => {
    const { adapter, channel, bindCalls, shared } = harness();
    await channel.ɵruntime.start();

    await adapter
      .getSink()
      .onTurn(turn("E-unlinked", "hello", { actorId: "UNLINKED" }));

    expect(postedText(adapter)).toContain("Link OpenBot account");
    expect(postedText(adapter)).toContain("opaque");
    expect(bindCalls).toEqual([]);
    expect(shared.inputs).toEqual([]);
  });

  test("a linked mention subscribes, binds, and streams the pinned coworker", async () => {
    const { adapter, channel, bindCalls, shared } = harness();
    await channel.ɵruntime.start();

    await adapter
      .getSink()
      .onTurn(turn("E1", "ask Risk Analyst to review this"));

    expect(bindCalls[0]).toMatchObject({
      channelsThreadId: "slack:T1:C1:root-1",
      provider: "slack",
      providerTenantId: "T1",
      providerConversationId: "C1",
      providerThreadId: "slack:T1:C1:root-1",
      agentId: "risk",
      createdByUserId: "u1",
    });
    expect(shared.inputs).toHaveLength(1);
    expect(postedText(adapter)).toContain("review complete");
  });

  test("subscribed replies run without mentions and recheck each participant", async () => {
    const { adapter, channel, actors } = harness();
    await channel.ɵruntime.start();
    await adapter.getSink().onTurn(turn("E1", "start"));
    await adapter
      .getSink()
      .onTurn(turn("E2", "follow up", { actorId: "U2", mentioned: false }));

    expect(actors).toEqual(["u1", "u2"]);
  });

  test("ignores edits and deletions and deduplicates repeated creates", async () => {
    const { adapter, channel, shared } = harness();
    await channel.ɵruntime.start();
    const sink = adapter.getSink();
    await sink.onTurn(turn("E1", "start"));
    await sink.onTurn(turn("E1", "start"));
    await sink.onTurn(turn("E2", "edited", { kind: "updated" }));
    await sink.onTurn(turn("E3", "deleted", { kind: "deleted" }));

    expect(shared.inputs).toHaveLength(1);
  });

  test("passes multimodal content parts and serializes overlapping thread turns", async () => {
    const { adapter, channel, shared } = harness();
    await channel.ɵruntime.start();
    shared.blockRuns = true;
    const first = adapter.getSink().onTurn({
      ...turn("E1", "start"),
      contentParts: [{ type: "text" as const, text: "from a content part" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = adapter
      .getSink()
      .onTurn(turn("E2", "follow up", { mentioned: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shared.inputs).toHaveLength(1);
    expect(shared.inputs[0]?.messages.at(-1)?.content).toEqual([
      { type: "text", text: "from a content part" },
    ]);
    expect(shared.maxActive).toBe(1);
    shared.blockRuns = false;
    shared.pendingFinishes.shift()?.();
    await Promise.all([first, second]);
    expect(shared.inputs).toHaveLength(2);
    expect(shared.maxActive).toBe(1);
  });

  test("exposes governed computer tools, file sharing, and approvals to the delegated run", async () => {
    // No handler is invoked in this registration test; Task 9 exercises each operation against a
    // full fake gateway, including successful/truncated/refused file uploads.
    const computerGateway = {} as ComputerGateway;
    const { adapter, channel, shared } = harness({ computerGateway });
    await channel.ɵruntime.start();
    await adapter.getSink().onTurn(turn("E-tools", "start"));

    const names = shared.inputs[0]?.tools.map(({ name }) => name);
    expect(names).toContain("computer_navigate");
    expect(names).toContain("computer_share_file");
    expect(names).toContain("approval_card");
  });

  test("an authorized approval interaction resumes the pinned agent as the current participant", async () => {
    const presentations = new Map<string, ApprovalPresentation>();
    configureApprovalDecisionStore(
      {
        async present(value) {
          presentations.set(value.presentationId, {
            ...value,
            createdAt: new Date(),
          });
        },
        async get(id) {
          return presentations.get(id) ?? null;
        },
        async begin() {
          return "first";
        },
        async complete() {},
        async cleanup() {
          return 0;
        },
      },
      {
        authorize: async ({ userId }) => ({
          actor: { id: userId, role: "user" },
          applicationUser: { id: userId, name: userId },
          provider: "slack",
          providerTenantId: "T1",
          providerConversationId: "C1",
          providerThreadId: "slack:T1:C1:root-1",
        }),
      },
    );
    const { adapter, channel, shared, actors } = harness();
    shared.requestApproval = true;
    await channel.ɵruntime.start();
    await adapter.getSink().onTurn(turn("E-approval", "deploy"));
    expect(shared.inputs).toHaveLength(2);
    const approve = adapter.posted.flat().flatMap(actionIds)[0];
    expect(approve).toBeDefined();

    await adapter.getSink().onInteraction({
      id: approve!,
      conversationKey: "slack:T1:C1:root-1",
      replyTarget: {},
      eventId: "E-click",
      actor: { id: "U2", kind: "human", name: "U2" },
      identityContext: identity("E-click", "U2"),
    });

    expect(actors.at(-1)).toBe("u2");
    expect(shared.inputs.at(-1)?.forwardedProps?.command).toEqual({
      resume: { approved: true },
    });
  });
});
