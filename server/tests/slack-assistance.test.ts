import { describe, expect, test } from "bun:test";
import { createChannel, FakeAdapter, FakeAgent } from "@copilotkit/channels";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentProfile } from "../src/agents/profile-types";
import type { TransactionalAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ControlState } from "../src/computer/schema";
import type { ExternalLinkCreationStore } from "../src/external/link-store";
import { createExternalLinkRoutes } from "../src/external/routes";
import { computerControlUrl, waitForAssistance } from "../src/slack/assistance";
import {
  ASSISTANCE_TTL_MS,
  mintAssistanceToken,
  readAssistanceToken,
} from "../src/slack/assistance-token";
import { ApprovalCard } from "../src/slack/components";

const KEY = "slack-assistance-test-key";
const NOW = 1_700_000_000_000;
const INVALID = "This assistance link has expired or is invalid.";

function profile(id = "coworker-1"): AgentProfile {
  return {
    id,
    name: "Coworker",
    title: "Coworker",
    roleDescription: "Helps with work.",
    avatarSeed: "coworker",
    visibility: "private",
    ownerUserId: "openbot-user-1",
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
  };
}

describe("Slack assistance claims", () => {
  test("seals a ten-minute claim without exposing its identities", async () => {
    const token = await mintAssistanceToken(
      {
        openbotUserId: "openbot-user-private",
        agentId: "coworker-private",
        channelsThreadId: "thread-private",
      },
      KEY,
      NOW,
    );

    expect(token).not.toContain("openbot-user-private");
    expect(token).not.toContain("coworker-private");
    expect(token).not.toContain("thread-private");
    expect(
      await readAssistanceToken(token, KEY, NOW + ASSISTANCE_TTL_MS),
    ).toMatchObject({
      openbotUserId: "openbot-user-private",
      agentId: "coworker-private",
      channelsThreadId: "thread-private",
      issuedAt: NOW,
      expiresAt: NOW + ASSISTANCE_TTL_MS,
    });
  });

  test("maps malformed, future-issued, expired, and cross-purpose claims uniformly", async () => {
    const token = await mintAssistanceToken(
      { openbotUserId: "u1", agentId: "a1", channelsThreadId: "t1" },
      KEY,
      NOW,
    );

    for (const [candidate, now] of [
      [undefined, NOW],
      ["not-a-token", NOW],
      [token, NOW - 1],
      [token, NOW + ASSISTANCE_TTL_MS + 1],
    ] as const) {
      await expect(readAssistanceToken(candidate, KEY, now)).rejects.toThrow(
        INVALID,
      );
    }
  });
});

describe("Slack assistance waiting", () => {
  const waiting: ControlState = {
    holder: "human",
    since: "2026-08-27T00:00:00.000Z",
    requested: true,
    reason: "Sign in",
  };

  test("returns answered once control is back with the bot and the request is clear", async () => {
    let now = 0;
    const states: ControlState[] = [
      waiting,
      {
        holder: "bot",
        since: "2026-08-27T00:00:01.000Z",
        requested: false,
      },
    ];
    const outcome = await waitForAssistance({
      control: async () =>
        states.shift() ?? {
          holder: "bot",
          since: "2026-08-27T00:00:01.000Z",
          requested: false,
        },
      done: (state) => state.holder === "bot" && !state.requested,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
        return "elapsed";
      },
    });

    expect(outcome).toBe("answered");
  });

  test("returns cancelled without polling after an aborted timer", async () => {
    const controller = new AbortController();
    let polls = 0;
    const outcome = await waitForAssistance({
      control: async () => {
        polls += 1;
        return waiting;
      },
      done: () => false,
      signal: controller.signal,
      now: () => 0,
      sleep: async () => {
        controller.abort();
        return "aborted";
      },
    });

    expect(outcome).toBe("cancelled");
    expect(polls).toBe(1);
  });

  test("expires at the bound without an extra poll", async () => {
    let now = 0;
    let polls = 0;
    const outcome = await waitForAssistance({
      control: async () => {
        polls += 1;
        return waiting;
      },
      done: () => false,
      timeoutMs: 2_000,
      pollMs: 1_000,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
        return "elapsed";
      },
    });

    expect(outcome).toBe("expired");
    expect(polls).toBe(2);
  });

  test("cancels while a control poll is hung and consumes its later rejection", async () => {
    const controller = new AbortController();
    let rejectControl: (error: Error) => void = () => undefined;
    const waiting = waitForAssistance({
      control: () =>
        new Promise<ControlState>((_resolve, reject) => {
          rejectControl = reject;
        }),
      done: () => false,
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort();

    const outcome = await Promise.race([
      waiting,
      new Promise<"test-timeout">((resolve) =>
        setTimeout(() => resolve("test-timeout"), 100),
      ),
    ]);
    expect(outcome).toBe("cancelled");
    rejectControl(new Error("late transport failure"));
    await Promise.resolve();
  });

  test("expires while a control poll never settles", async () => {
    const started = Date.now();
    const outcome = await Promise.race([
      waitForAssistance({
        control: () => new Promise<ControlState>(() => undefined),
        done: () => false,
        timeoutMs: 20,
      }),
      new Promise<"test-timeout">((resolve) =>
        setTimeout(() => resolve("test-timeout"), 100),
      ),
    ]);

    expect(outcome).toBe("expired");
    expect(Date.now() - started).toBeLessThan(100);
  });
});

test("computer control URL keeps the sealed claim in the query", () => {
  const url = computerControlUrl(
    "https://openbot.example/base",
    "sealed-token",
  );
  expect(url).toBe("https://openbot.example/assist?token=sealed-token");
});

test("computer control URL allows HTTPS and loopback only", () => {
  expect(computerControlUrl("http://localhost:3010", "sealed-token")).toBe(
    "http://localhost:3010/assist?token=sealed-token",
  );
  for (const appUrl of [
    "http://openbot.example",
    "https://user:password@openbot.example",
    "file:///tmp/openbot",
  ]) {
    expect(() => computerControlUrl(appUrl, "sealed-token")).toThrow(
      "OpenBot app URL",
    );
  }
});

test("approval buttons resume the originating thread with a boolean decision", async () => {
  const rendered = await ApprovalCard.render(
    { question: "Deploy this release?" },
    { platform: "slack", signal: new AbortController().signal },
  );
  const message = rendered as {
    props: { children: Array<{ props: { children: unknown } }> };
  };
  const actions = message.props.children[1] as {
    props: {
      children: Array<{
        props: { onClick: (context: unknown) => Promise<void> };
      }>;
    };
  };
  const actionNodes = actions.props.children as Array<{
    key?: string | number;
    props: { onClick: (context: unknown) => Promise<void> };
  }>;
  const decisions: unknown[] = [];
  const context = {
    thread: {
      resume: async (decision: unknown) => void decisions.push(decision),
    },
  };

  await actions.props.children[0]?.props.onClick(context);
  await actions.props.children[1]?.props.onClick(context);

  expect(message.props.children[0]?.props.children).toBe(
    "Deploy this release?",
  );
  expect(actionNodes.map((node) => node.key)).toEqual([
    "approval-approve",
    "approval-reject",
  ]);
  expect(decisions).toEqual([{ approved: true }, { approved: false }]);
});

function interactiveActionIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const node = value as { props?: Record<string, unknown> };
  const onClick = node.props?.onClick;
  const own =
    onClick &&
    typeof onClick === "object" &&
    typeof (onClick as { id?: unknown }).id === "string"
      ? [(onClick as { id: string }).id]
      : [];
  const children = node.props?.children;
  return [
    ...own,
    ...(Array.isArray(children)
      ? children.flatMap(interactiveActionIds)
      : interactiveActionIds(children)),
  ];
}

test("registered ApprovalCard binds durable one-use actions that resume its thread", async () => {
  const adapter = new FakeAdapter({ platform: "slack" });
  const lifecycle: Array<{ isResume?: boolean }> = [];
  adapter.runAgentLifecycle = async (args) => {
    lifecycle.push({ isResume: args.isResume });
    return args.execute(args.renderer.subscriber, undefined);
  };
  const agent = new FakeAgent([
    (subscriber) => {
      subscriber.onToolCallEndEvent?.({
        event: { toolCallId: "approval-call-1" },
        toolCallName: ApprovalCard.name,
        toolCallArgs: { question: "Deploy this release?" },
      });
    },
    () => undefined,
    () => undefined,
  ]);
  const channel = createChannel({
    name: "approval-probe",
    identifyUser: "platform",
    adapters: [adapter],
    agent: () => agent,
    components: [ApprovalCard],
    store: { actionRetentionMs: 60_000 },
  });
  channel.onMessage(async ({ thread }) => {
    await thread.runAgent();
  });
  await channel.ɵruntime.start();
  try {
    await adapter.getSink().onTurn({
      conversationKey: "approval-thread",
      replyTarget: {},
      userText: "ask first",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
    });
    const actionIds = (adapter.posted[0] ?? []).flatMap(interactiveActionIds);
    expect(actionIds).toHaveLength(2);
    expect(new Set(actionIds).size).toBe(2);
    const beforeResume = lifecycle.length;

    await adapter.getSink().onInteraction({
      id: actionIds[0]!,
      conversationKey: "approval-thread",
      replyTarget: {},
      eventId: "approve-once",
      actor: { id: "U1", kind: "human" },
    });
    expect(lifecycle).toHaveLength(beforeResume + 1);
    expect(lifecycle.at(-1)?.isResume).toBe(true);

    await adapter.getSink().onInteraction({
      id: actionIds[0]!,
      conversationKey: "approval-thread",
      replyTarget: {},
      eventId: "approve-twice",
      actor: { id: "U1", kind: "human" },
    });
    expect(lifecycle).toHaveLength(beforeResume + 1);
  } finally {
    await channel.ɵruntime.stop();
  }
});

function assistanceRoutes(
  actorId = "openbot-user-1",
  getProfile: AgentProfileStore["get"] = async () => profile(),
  requireUserOverride?: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> =
    requireUserOverride ??
    (async (context, next) => {
      context.set("actor", {
        id: actorId,
        email: "member@openbot.test",
        role: "user",
      });
      await next();
    });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/external-links",
    createExternalLinkRoutes({
      store: {} as ExternalLinkCreationStore,
      encryptionKey: KEY,
      requireUser,
      auditStore: {
        insert: async () => undefined,
        inTransaction: () => ({ insert: async () => undefined }),
      } satisfies TransactionalAuditStore,
      agentProfileStore: { get: getProfile },
    }),
  );
  return app;
}

describe("authenticated Slack assistance handoff", () => {
  test("prevents caching even when authentication refuses the request", async () => {
    const app = assistanceRoutes(
      "openbot-user-1",
      async () => profile(),
      async (context) => context.json({ error: "Unauthorized" }, 401),
    );

    const response = await app.request(
      "http://openbot.test/api/external-links/assistance?token=sealed-control",
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("rechecks the linked actor's coworker access and returns only the agent id", async () => {
    const calls: unknown[] = [];
    const token = await mintAssistanceToken(
      {
        openbotUserId: "openbot-user-1",
        agentId: "coworker-1",
        channelsThreadId: "private-thread-id",
      },
      KEY,
    );
    const app = assistanceRoutes("openbot-user-1", async (...args) => {
      calls.push(args);
      return profile();
    });

    const response = await app.request(
      `http://openbot.test/api/external-links/assistance?token=${encodeURIComponent(token)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ agentId: "coworker-1" });
    expect(calls).toEqual([
      [{ id: "openbot-user-1", role: "user" }, "coworker-1"],
    ]);
  });

  test("refuses the wrong signed-in user and inaccessible coworker without disclosing ids", async () => {
    const token = await mintAssistanceToken(
      {
        openbotUserId: "openbot-user-1",
        agentId: "coworker-1",
        channelsThreadId: "private-thread-id",
      },
      KEY,
    );
    for (const app of [
      assistanceRoutes("openbot-user-2"),
      assistanceRoutes("openbot-user-1", async () => null),
    ]) {
      const response = await app.request(
        `http://openbot.test/api/external-links/assistance?token=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await response.json())).not.toMatch(
        /openbot-user|coworker|private-thread/,
      );
    }
  });

  test("keeps profile-store outages as operational 5xx failures", async () => {
    const token = await mintAssistanceToken(
      {
        openbotUserId: "openbot-user-1",
        agentId: "coworker-1",
        channelsThreadId: "private-thread-id",
      },
      KEY,
    );
    const app = assistanceRoutes("openbot-user-1", async () => {
      throw new Error("database unavailable");
    });

    const response = await app.request(
      `http://openbot.test/api/external-links/assistance?token=${encodeURIComponent(token)}`,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toMatch(
      /database|openbot-user|coworker|private-thread/,
    );
  });

  test("maps missing, malformed, and expired claims to one 410 response", async () => {
    const expired = await mintAssistanceToken(
      {
        openbotUserId: "openbot-user-1",
        agentId: "coworker-1",
        channelsThreadId: "private-thread-id",
      },
      KEY,
      NOW,
    );
    const app = assistanceRoutes();
    for (const suffix of [
      "",
      "?token=invalid",
      `?token=${encodeURIComponent(expired)}`,
    ]) {
      const response = await app.request(
        `http://openbot.test/api/external-links/assistance${suffix}`,
      );
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: INVALID });
    }
  });
});
