import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createChannel,
  FakeAdapter,
  FakeAgent,
  MemoryStore,
} from "@copilotkit/channels";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  approvalDecisions,
  externalThreadBindings,
  users,
} from "../src/db/schema";
import { createApprovalDecisionStore } from "../src/slack/approval-store";
import {
  ApprovalCard,
  configureApprovalDecisionStore,
} from "../src/slack/components";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const presentationIds = new Set<string>();
const channelsThreadId = `approval-thread-${crypto.randomUUID()}`;
const agentId = `approval-agent-${crypto.randomUUID()}`;

beforeAll(async () => {
  await database
    .insert(users)
    .values([
      { id: "U1", email: `u1-${crypto.randomUUID()}@example.test` },
      { id: "U2", email: `u2-${crypto.randomUUID()}@example.test` },
    ])
    .onConflictDoNothing();
  await database.insert(agents).values({
    id: agentId,
    name: "Approval Agent",
    type: "remote_ag_ui",
    configuration: {},
  });
  await database.insert(externalThreadBindings).values({
    channelsThreadId,
    provider: "slack",
    providerTenantId: `tenant-${crypto.randomUUID()}`,
    providerConversationId: `conversation-${crypto.randomUUID()}`,
    providerThreadId: `thread-${crypto.randomUUID()}`,
    agentId,
    createdByUserId: "U1",
  });
});

type BoundAction = {
  id: string;
  value: { presentationId: string; approved: boolean };
};

function boundActions(value: unknown): BoundAction[] {
  if (!value || typeof value !== "object") return [];
  const node = value as { props?: Record<string, unknown> };
  const click = node.props?.onClick;
  const action =
    click &&
    typeof click === "object" &&
    typeof (click as { id?: unknown }).id === "string" &&
    node.props?.value &&
    typeof node.props.value === "object"
      ? [
          {
            id: (click as { id: string }).id,
            value: node.props.value as BoundAction["value"],
          },
        ]
      : [];
  const children = node.props?.children;
  return [
    ...action,
    ...(Array.isArray(children)
      ? children.flatMap(boundActions)
      : boundActions(children)),
  ];
}

function runtime(
  state: MemoryStore,
  lifecycle: Array<{ isResume?: boolean }>,
  script: ConstructorParameters<typeof FakeAgent>[0],
) {
  configureApprovalDecisionStore(createApprovalDecisionStore(database), {
    authorize: async ({ userId }) => userId === "U1" || userId === "U2",
    subject: () => ({
      channelsThreadId,
      conversationKey: "approval-thread",
      agentId,
      createdByUserId: "U1",
    }),
  });
  const adapter = new FakeAdapter({ platform: "slack" });
  adapter.runAgentLifecycle = async (args) => {
    lifecycle.push({ isResume: args.isResume });
    return args.execute(args.renderer.subscriber, undefined);
  };
  const channel = createChannel({
    name: "approval-durability-probe",
    identifyUser: ({ actor }) => ({ id: actor.id, name: actor.id }),
    adapters: [adapter],
    agent: () => new FakeAgent(script),
    components: [ApprovalCard],
    store: { adapter: state, actionRetentionMs: 60_000 },
  });
  channel.onMessage(async ({ thread }) => {
    await thread.runAgent();
  });
  return { adapter, channel };
}

const presentApproval: ConstructorParameters<typeof FakeAgent>[0][number] = (
  subscriber,
) => {
  subscriber.onToolCallEndEvent?.({
    event: { toolCallId: crypto.randomUUID() },
    toolCallName: ApprovalCard.name,
    toolCallArgs: { question: "Deploy this release?" },
  });
};

async function present() {
  const lifecycle: Array<{ isResume?: boolean }> = [];
  const state = new MemoryStore();
  const running = runtime(state, lifecycle, [presentApproval, () => undefined]);
  await running.channel.ɵruntime.start();
  await running.adapter.getSink().onTurn({
    conversationKey: "approval-thread",
    replyTarget: {},
    userText: "ask first",
    platform: "slack",
    actor: { id: "U1", kind: "human" },
  });
  const actions = (running.adapter.posted[0] ?? []).flatMap(boundActions);
  expect(actions).toHaveLength(2);
  presentationIds.add(actions[0]!.value.presentationId);
  return { ...running, actions, lifecycle, state };
}

async function click(
  adapter: FakeAdapter,
  action: BoundAction,
  eventId: string,
  actorId: string,
) {
  await adapter.getSink().onInteraction({
    id: action.id,
    value: action.value,
    conversationKey: "approval-thread",
    replyTarget: {},
    eventId,
    actor: { id: actorId, kind: "human" },
  });
}

afterAll(async () => {
  await database
    .delete(approvalDecisions)
    .where(eq(approvalDecisions.channelsThreadId, channelsThreadId));
  await database.$client.end({ timeout: 5 });
});

describe("durable Slack approval decisions", () => {
  test("an unlinked or inaccessible participant cannot claim the presentation", async () => {
    const fixture = await present();
    try {
      const before = fixture.lifecycle.length;
      await expect(
        click(fixture.adapter, fixture.actions[0]!, "unauthorized", "U3"),
      ).rejects.toThrow("authorized");
      expect(fixture.lifecycle).toHaveLength(before);
      await click(fixture.adapter, fixture.actions[0]!, "authorized", "U1");
      expect(fixture.lifecycle).toHaveLength(before + 1);
    } finally {
      await fixture.channel.ɵruntime.stop();
    }
  });

  for (const firstApproved of [true, false]) {
    test(`${firstApproved ? "approve" : "reject"} prevents the sibling decision`, async () => {
      const fixture = await present();
      try {
        const first = fixture.actions.find(
          ({ value }) => value.approved === firstApproved,
        )!;
        const sibling = fixture.actions.find(
          ({ value }) => value.approved !== firstApproved,
        )!;
        const before = fixture.lifecycle.length;

        await click(fixture.adapter, first, "first-decision", "U1");
        await click(fixture.adapter, sibling, "sibling-decision", "U2");

        expect(fixture.lifecycle).toHaveLength(before + 1);
        expect(fixture.lifecycle.at(-1)?.isResume).toBe(true);
      } finally {
        await fixture.channel.ɵruntime.stop();
      }
    });
  }

  test("concurrent actors can resume only one sibling action", async () => {
    const fixture = await present();
    try {
      const before = fixture.lifecycle.length;
      await Promise.all([
        click(fixture.adapter, fixture.actions[0]!, "concurrent-approve", "U1"),
        click(fixture.adapter, fixture.actions[1]!, "concurrent-reject", "U2"),
      ]);
      expect(fixture.lifecycle).toHaveLength(before + 1);
    } finally {
      await fixture.channel.ɵruntime.stop();
    }
  });

  test("only the original winning actor can retry the same action", async () => {
    const store = createApprovalDecisionStore(database);
    const presentationId = crypto.randomUUID();
    presentationIds.add(presentationId);
    await store.present({
      presentationId,
      channelsThreadId,
      conversationKey: "approval-thread",
      agentId,
      createdByUserId: "U1",
    });

    expect(
      await store.begin({
        presentationId,
        actionId: "approve-action",
        approved: true,
        decidedByUserId: "U1",
      }),
    ).toBe("first");
    expect(
      await store.begin({
        presentationId,
        actionId: "approve-action",
        approved: true,
        decidedByUserId: "U2",
      }),
    ).toBe("rejected");
    expect(
      await store.begin({
        presentationId,
        actionId: "approve-action",
        approved: true,
        decidedByUserId: "U1",
      }),
    ).toBe("retry");
  });

  test("a persisted decision rejects its sibling after a runtime restart", async () => {
    const first = await present();
    const before = first.lifecycle.length;
    await click(first.adapter, first.actions[0]!, "before-restart", "U1");
    expect(first.lifecycle).toHaveLength(before + 1);
    await first.channel.ɵruntime.stop();

    const restarted = runtime(first.state, first.lifecycle, [() => undefined]);
    await restarted.channel.ɵruntime.start();
    try {
      await click(restarted.adapter, first.actions[1]!, "after-restart", "U2");
      expect(first.lifecycle).toHaveLength(before + 1);
    } finally {
      await restarted.channel.ɵruntime.stop();
    }
  });

  test("retention cleanup preserves live action-window rows", async () => {
    const store = createApprovalDecisionStore(database);
    const presentationId = crypto.randomUUID();
    presentationIds.add(presentationId);
    await store.present({
      presentationId,
      channelsThreadId,
      conversationKey: "approval-thread",
      agentId,
      createdByUserId: "U1",
    });
    expect(await store.cleanup(new Date(Date.now() - 60_000))).toBe(0);
    expect(await store.get(presentationId)).not.toBeNull();
  });
});
