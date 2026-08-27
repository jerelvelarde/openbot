import { describe, expect, test } from "bun:test";
import { createApprovalAuthorizer } from "../src/slack/approval-authorizer";
import type { ApprovalPresentation } from "../src/slack/approval-store";

const presentation: ApprovalPresentation = {
  presentationId: "11111111-1111-4111-8111-111111111111",
  channelsThreadId: "thread-1",
  conversationKey: "conversation-1",
  agentId: "risk",
  createdByUserId: "creator",
  createdAt: new Date(),
};

function authorizer(
  options: {
    active?: boolean;
    boundAgentId?: string | null;
    accessible?: boolean;
  } = {},
) {
  return createApprovalAuthorizer({
    links: {
      resolveActiveUser: async (id) =>
        options.active === false
          ? null
          : { id, name: id, role: "user" as const },
    } as never,
    threads: {
      getByChannelsThreadId: async () =>
        options.boundAgentId === null
          ? null
          : ({ agentId: options.boundAgentId ?? "risk" } as never),
    } as never,
    profiles: {
      get: async () => (options.accessible === false ? null : ({} as never)),
    },
  });
}

describe("Slack approval authorization", () => {
  test("fails closed for unlinked, rebound, and inaccessible participants", async () => {
    expect(
      await authorizer({ active: false })({ userId: "u1", presentation }),
    ).toBe(false);
    expect(
      await authorizer({ boundAgentId: "other" })({
        userId: "u1",
        presentation,
      }),
    ).toBe(false);
    expect(
      await authorizer({ accessible: false })({ userId: "u1", presentation }),
    ).toBe(false);
  });

  test("accepts only an active canonical user with current access to the pinned coworker", async () => {
    expect(await authorizer()({ userId: "u1", presentation })).toBe(true);
  });
});
