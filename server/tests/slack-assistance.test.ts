import { describe, expect, test } from "bun:test";
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
  expect(decisions).toEqual([{ approved: true }, { approved: false }]);
});

function assistanceRoutes(
  actorId = "openbot-user-1",
  getProfile: AgentProfileStore["get"] = async () => profile(),
) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: "member@openbot.test",
      role: "user",
    });
    await next();
  };
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
      expect(JSON.stringify(await response.json())).not.toMatch(
        /openbot-user|coworker|private-thread/,
      );
    }
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
      expect(await response.json()).toEqual({ error: INVALID });
    }
  });
});
