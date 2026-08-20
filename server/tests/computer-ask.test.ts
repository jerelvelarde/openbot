import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { ApprovalStore } from "../src/computer/approvals";
import { scopedAllowRule } from "../src/computer/approvals";
import type { ComputerClient } from "../src/computer/client";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import {
  type ActionPolicy,
  evaluateActionPolicy,
} from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";

/**
 * The third policy answer, tested as properties.
 *
 * The ones that matter, and none of them are visible from a green typecheck:
 *  - an asked action does NOT reach the computer until somebody says yes
 *  - deny still beats ask, so a forbidden thing never becomes a question
 *  - a broken ask expression asks, rather than quietly permitting
 *  - dry-run changes no outcomes, including this one
 *  - the trail records the question and the answer separately, and names who answered
 *  - nobody answering ends the run instead of holding it open
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://portal.example/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e1", role: "input", name: "Customer name:", type: "text" },
    { ref: "e9", role: "button", name: "Submit payment run" },
  ],
};

const ASK_SUBMIT: ActionPolicy = {
  mode: "enforce",
  deny: [],
  ask: ['contains(element.name, "submit")'],
  allow: ["true"],
};

function fakeClient() {
  const reached: string[] = [];
  return {
    reached,
    client: {
      forBot: () => ({
        snapshot: async () => SNAPSHOT,
        click: async () => {
          reached.push("click");
          return { action: "click", url: SNAPSHOT.url, elapsedMs: 1 } as never;
        },
        // The actions with no element of their own, which is what the rules below are about.
        navigate: async () => {
          reached.push("navigate");
          return { url: SNAPSHOT.url, title: "Orders", text: "" } as never;
        },
        scroll: async () => {
          reached.push("scroll");
          return { action: "scroll", url: SNAPSHOT.url } as never;
        },
        readFile: async () => {
          reached.push("readFile");
          return { path: "notes.md", contents: "" } as never;
        },
      }),
    } as unknown as ComputerClient,
  };
}

function fakeAudit() {
  const rows: AuditEventInput[] = [];
  return {
    rows,
    store: {
      insert: async (event: AuditEventInput) => void rows.push(event),
    } as AuditStore,
  };
}

/**
 * An approval store that answers however the test says, without a database.
 *
 * `answerWith` is applied on the first wait, so the gateway's suspend-and-resume is exercised without
 * a timer or a real row.
 */
function fakeApprovals(
  answerWith:
    | { answered: true; allowed: boolean; answeredByUserId: string | null }
    | { answered: false; reason: "expired" | "cancelled" },
) {
  const created: unknown[] = [];
  return {
    created,
    store: {
      create: async (request: unknown) => {
        created.push(request);
        return {
          id: "approval_1",
          agentId: "risk-analyst",
          threadId: null,
          toolName: "computer_click",
          intent: "activate",
          subject: { kind: "element", label: "Submit payment run" },
          rule: 'contains(element.name, "submit")',
          reason: "asked",
          state: "pending",
          answeredByUserId: null,
          answeredAt: null,
          scopedRule: null,
          expiresAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
      },
      wait: async () => answerWith,
    } as unknown as ApprovalStore,
  };
}

type Announcement = {
  botId: string;
  approvalId: string;
  subject: string;
  threadId?: string;
};

function gatewayWith(
  policy: ActionPolicy,
  approvals?: ApprovalStore,
  announce?: (announcement: Announcement) => void,
): {
  gateway: ReturnType<typeof createComputerGateway>;
  reached: string[];
  rows: AuditEventInput[];
} {
  const { client, reached } = fakeClient();
  const { store, rows } = fakeAudit();
  const gateway = createComputerGateway({
    client,
    auditStore: store,
    policy: () => policy,
    ...(approvals ? { approvals } : {}),
    ...(announce ? { announce } : {}),
  });
  return { gateway, reached, rows };
}

const ACTOR = { id: "user_1", userId: "user_1" };

describe("the ask outcome", () => {
  test("deny beats ask, so a forbidden action never becomes a question", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: ['contains(element.name, "submit")'],
        ask: ['contains(element.name, "submit")'],
        allow: ["true"],
      },
      {
        tool: { name: "computer_click" },
        bot: { id: "risk-analyst" },
        actor: { id: "user_1" },
        page: { url: SNAPSHOT.url, host: "portal.example" },
        element: { ref: "e9", role: "button", name: "Submit payment run" },
      },
    );

    // Offering somebody a button that overrides a deny rule is how a boundary stops meaning anything.
    expect(decision.source).toBe("deny");
    expect(decision.parked).toBe(false);
    expect(decision.allowed).toBe(false);
  });

  test("a broken ask expression asks rather than permitting", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: [],
        ask: ["this is not valid CEL ((("],
        allow: ["true"],
      },
      {
        tool: { name: "computer_click" },
        bot: { id: "risk-analyst" },
        actor: { id: "user_1" },
        page: { url: SNAPSHOT.url, host: "portal.example" },
      },
    );

    // Fail-closed here means "involve a person". A typo must not quietly turn a supervised action
    // into an unsupervised one.
    expect(decision.source).toBe("ask");
    expect(decision.parked).toBe(true);
  });

  test("dry-run changes no outcomes, including an ask", () => {
    const decision = evaluateActionPolicy(
      { ...ASK_SUBMIT, mode: "dry-run" },
      {
        tool: { name: "computer_click" },
        bot: { id: "risk-analyst" },
        actor: { id: "user_1" },
        page: { url: SNAPSHOT.url, host: "portal.example" },
        element: { ref: "e9", role: "button", name: "Submit payment run" },
      },
    );

    // Dry-run's whole promise is that an operator can write a rule against live traffic and read the
    // trail without refusing anybody's work, or making them answer prompts for it.
    expect(decision.source).toBe("ask");
    expect(decision.parked).toBe(false);
    expect(decision.forward).toBe(true);
  });

  test("an asked action does not reach the computer until somebody allows it", async () => {
    const allowed = gatewayWith(
      ASK_SUBMIT,
      fakeApprovals({
        answered: true,
        allowed: true,
        answeredByUserId: "user_1",
      }).store,
    );
    await allowed.gateway.snapshot("risk-analyst");
    await allowed.gateway.click("risk-analyst", "risk-analyst", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });
    expect(allowed.reached).toEqual(["click"]);

    const refused = gatewayWith(
      ASK_SUBMIT,
      fakeApprovals({
        answered: true,
        allowed: false,
        answeredByUserId: "user_1",
      }).store,
    );
    await refused.gateway.snapshot("risk-analyst");
    await expect(
      refused.gateway.click("risk-analyst", "risk-analyst", ACTOR, {
        ref: "e9",
        snapshotId: 7,
      }),
    ).rejects.toThrow(ActionRefusedError);
    // The whole point: a person said no, and nothing happened.
    expect(refused.reached).toEqual([]);
    // And it is in the trail as a refusal, not only as an answer.
    expect(refused.rows.map((row) => row.eventType)).toEqual([
      "computer.action_asked",
      "computer.action_answered",
      "computer.action_refused",
    ]);
  });

  test("the question and the answer are separate rows, and the answer names who gave it", async () => {
    const { gateway, rows } = gatewayWith(
      ASK_SUBMIT,
      fakeApprovals({
        answered: true,
        allowed: true,
        answeredByUserId: "user_1",
      }).store,
    );
    await gateway.snapshot("risk-analyst");
    await gateway.click("risk-analyst", "risk-analyst", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    const types = rows.map((row) => row.eventType);
    // Three rows, in order, each saying something the others do not.
    expect(types).toEqual([
      "computer.action_asked",
      "computer.action_answered",
      "computer.action_allowed",
    ]);
    // Never "refused". Recorded that way, the trail would say a Bot was blocked from the very thing a
    // person approved, which is the opposite of what happened.
    expect(types).not.toContain("computer.action_refused");

    const answered = rows.find(
      (row) => row.eventType === "computer.action_answered",
    );
    const payload = answered?.payload as Record<string, unknown>;
    expect(payload.answer).toBe("allowed");
    expect(payload.answeredBy).toBe("user_1");
    // The rule travels with it, so an operator can go and find the boundary that asked.
    expect(payload.rule).toBe('contains(element.name, "submit")');
  });

  test("the subject recorded is the one the SERVER resolved", async () => {
    const approvals = fakeApprovals({
      answered: true,
      allowed: true,
      answeredByUserId: "user_1",
    });
    const { gateway } = gatewayWith(ASK_SUBMIT, approvals.store);
    await gateway.snapshot("risk-analyst");
    await gateway.click("risk-analyst", "risk-analyst", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    const request = approvals.created[0] as {
      subject: { kind: string; label: string; host?: string };
    };
    // From the snapshot this server took, never from what the caller said it was clicking. An
    // approval screen quoting the model's own label would hand back the trust the gateway exists to
    // withhold.
    expect(request.subject).toEqual({
      kind: "element",
      label: "Submit payment run",
      host: "portal.example",
    });
  });

  test("nobody answering ends the run instead of holding it open", async () => {
    const { gateway, reached, rows } = gatewayWith(
      ASK_SUBMIT,
      fakeApprovals({ answered: false, reason: "expired" }).store,
    );
    await gateway.snapshot("risk-analyst");
    await expect(
      gateway.click("risk-analyst", "risk-analyst", ACTOR, {
        ref: "e9",
        snapshotId: 7,
      }),
    ).rejects.toThrow(/did not happen/);

    expect(reached).toEqual([]);
    // An unanswered question is asked and then answered-as-expired. It is never an "allowed" row.
    expect(rows.map((row) => row.eventType)).not.toContain(
      "computer.action_allowed",
    );
    const answered = rows.find(
      (row) => row.eventType === "computer.action_answered",
    );
    // Recorded, not silent. A trail that shows the question and never the outcome cannot answer
    // whether an `ask` rule is workable.
    expect(
      answered?.payload as Record<string, unknown> | undefined,
    ).toMatchObject({ answer: "expired" });
  });

  test("an ask with nowhere to record it refuses rather than acting", async () => {
    // No approval store configured. The safe degradation is to refuse: a deployment that cannot ask
    // anybody must not carry the action out on the grounds that nobody could be asked.
    const { gateway, reached } = gatewayWith(ASK_SUBMIT);
    await gateway.snapshot("risk-analyst");
    await expect(
      gateway.click("risk-analyst", "risk-analyst", ACTOR, {
        ref: "e9",
        snapshotId: 7,
      }),
    ).rejects.toThrow(/cannot record approvals/);
    expect(reached).toEqual([]);
  });
});

describe("a standing permission", () => {
  test("outranks ask, or the always-allow button does nothing", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: [],
        ask: ['contains(element.name, "submit")'],
        exempt: [
          'bot.id == "risk-analyst" && contains(element.name, "Submit payment run")',
        ],
        allow: ["true"],
      },
      {
        tool: { name: "computer_click" },
        bot: { id: "risk-analyst" },
        actor: { id: "user_1" },
        page: { url: SNAPSHOT.url, host: "portal.example" },
        element: { ref: "e9", role: "button", name: "Submit payment run" },
      },
    );

    // Written into `allow` instead, this would still be asked about, because allow is evaluated after
    // ask. The person who pressed "always allow" would be asked again on the very next action.
    expect(decision.source).toBe("exempt");
    expect(decision.parked).toBe(false);
    expect(decision.allowed).toBe(true);
  });

  test("is still outranked by deny", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: ['contains(element.name, "submit")'],
        ask: [],
        exempt: ['contains(element.name, "submit")'],
        allow: ["true"],
      },
      {
        tool: { name: "computer_click" },
        bot: { id: "risk-analyst" },
        actor: { id: "user_1" },
        page: { url: SNAPSHOT.url, host: "portal.example" },
        element: { ref: "e9", role: "button", name: "Submit payment run" },
      },
    );

    // Exempting something from being asked about must never exempt it from being forbidden.
    expect(decision.source).toBe("deny");
    expect(decision.allowed).toBe(false);
  });

  test("a broken expression asks rather than permitting", () => {
    const decision = evaluateActionPolicy(
      {
        mode: "enforce",
        deny: [],
        ask: ['contains(element.name, "submit")'],
        exempt: ["not valid CEL ((("],
        allow: ["true"],
      },
      {
        tool: { name: "computer_click" },
        bot: { id: "risk-analyst" },
        actor: { id: "user_1" },
        page: { url: SNAPSHOT.url, host: "portal.example" },
        element: { ref: "e9", role: "button", name: "Submit payment run" },
      },
    );

    // An unreadable permission is no permission, and the action falls through to being asked about.
    expect(decision.source).toBe("ask");
  });
});

describe("the rule an always-allow writes", () => {
  test("is scoped to this Bot and this subject", () => {
    expect(
      scopedAllowRule("risk-analyst", {
        kind: "element",
        label: "Submit payment run",
      }),
    ).toBe(
      'bot.id == "risk-analyst" && contains(element.name, "Submit payment run")',
    );
    expect(
      scopedAllowRule("risk-analyst", { kind: "file", label: "notes.md" }),
    ).toBe('bot.id == "risk-analyst" && file.path == "notes.md"');
  });

  test("refuses a label it cannot express safely rather than escaping it", () => {
    // A rule that has to be escaped correctly to be safe is a rule that will eventually be escaped
    // incorrectly. The one-off answer is still available.
    expect(
      scopedAllowRule("risk-analyst", {
        kind: "element",
        label: 'Submit " || true || "',
      }),
    ).toBeUndefined();
  });
});

describe("telling somebody it is waiting", () => {
  const ASKS: ActionPolicy = {
    mode: "enforce",
    deny: [],
    ask: ['contains(element.name, "submit")'],
    allow: ["true"],
  };

  test("announces the parked action, with the subject the server resolved", async () => {
    const announced: Announcement[] = [];
    const approvals = fakeApprovals({
      answered: true,
      allowed: true,
      answeredByUserId: "user_2",
    });
    const { gateway } = gatewayWith(ASKS, approvals.store, (announcement) =>
      announced.push(announcement),
    );
    await gateway.snapshot("risk-analyst");

    await gateway.click("risk-analyst", "risk-analyst", ACTOR, {
      ref: "e9",
      snapshotId: 1,
    });

    // The point of the wait is that somebody finds out about it during the wait. Announced with the
    // label this server looked up, which is the same value the audit row carries.
    expect(announced).toEqual([
      {
        botId: "risk-analyst",
        approvalId: "approval_1",
        subject: "Submit payment run",
      },
    ]);
  });

  test("a push that cannot be sent does not turn a parked action into a refusal", async () => {
    const approvals = fakeApprovals({
      answered: true,
      allowed: true,
      answeredByUserId: "user_2",
    });
    const { gateway, reached } = gatewayWith(ASKS, approvals.store, () => {
      throw new Error("expo is down");
    });
    await gateway.snapshot("risk-analyst");

    // An approval that was recorded and could not be announced is still an approval. Failing here
    // would make a missing push service look like a policy decision.
    await gateway.click("risk-analyst", "risk-analyst", ACTOR, {
      ref: "e9",
      snapshotId: 1,
    });

    expect(reached).toContain("click");
  });

  test("says nothing when the action was not parked", async () => {
    const announced: Announcement[] = [];
    const { gateway } = gatewayWith(
      { mode: "enforce", deny: [], ask: [], allow: ["true"] },
      undefined,
      (announcement) => announced.push(announcement),
    );
    await gateway.snapshot("risk-analyst");

    await gateway.click("risk-analyst", "risk-analyst", ACTOR, {
      ref: "e9",
      snapshotId: 1,
    });

    // A product that notifies on everything is a product whose notifications are switched off.
    expect(announced).toEqual([]);
  });
});

describe("a rule about a button is not a rule about everything", () => {
  /**
   * The shape of rule every deployment writes, and the trap under it.
   *
   * The policy engine treats an expression it cannot evaluate as a MATCH, which is right for an
   * element the server could not resolve. Applied to an action with no element at all it is a
   * disaster: this rule is unevaluable for a navigation, so it would match, so asking about one
   * button would ask about every page the Bot opens.
   */
  const ASK_ABOUT_A_BUTTON: ActionPolicy = {
    mode: "enforce",
    deny: [],
    ask: ['contains(element.name, "Submit payment run")'],
    allow: ["true"],
  };

  test("opening a page is not parked by a rule about a button", async () => {
    const announced: Announcement[] = [];
    const approvals = fakeApprovals({
      answered: true,
      allowed: true,
      answeredByUserId: "user_1",
    });
    const { gateway, reached } = gatewayWith(
      ASK_ABOUT_A_BUTTON,
      approvals.store,
      (announcement) => announced.push(announcement),
    );

    await gateway.navigate(
      "risk-analyst",
      "risk-analyst",
      ACTOR,
      "https://portal.example/orders",
    );

    // A navigation did not click anything, so a rule about a click is false for it.
    expect(announced).toEqual([]);
    expect(approvals.created).toEqual([]);
    expect(reached).toContain("navigate");
  });

  test("scrolling and reading a file are not parked by it either", async () => {
    const approvals = fakeApprovals({
      answered: true,
      allowed: true,
      answeredByUserId: "user_1",
    });
    const { gateway } = gatewayWith(ASK_ABOUT_A_BUTTON, approvals.store);

    await gateway.scroll("risk-analyst", "risk-analyst", ACTOR, {
      deltaY: 600,
    });
    await gateway.readFile("risk-analyst", "risk-analyst", ACTOR, {
      path: "notes.md",
    });

    expect(approvals.created).toEqual([]);
  });

  test("but the button itself still asks", async () => {
    const approvals = fakeApprovals({
      answered: true,
      allowed: true,
      answeredByUserId: "user_1",
    });
    const { gateway } = gatewayWith(ASK_ABOUT_A_BUTTON, approvals.store);
    await gateway.snapshot("risk-analyst");

    await gateway.click("risk-analyst", "risk-analyst", ACTOR, {
      ref: "e9",
      snapshotId: 1,
    });

    expect(approvals.created).toHaveLength(1);
  });

  test("and an element the server could not resolve still fails closed", async () => {
    const approvals = fakeApprovals({
      answered: false,
      reason: "expired",
    });
    const { gateway, reached } = gatewayWith(
      ASK_ABOUT_A_BUTTON,
      approvals.store,
    );
    // No snapshot taken, so there is nothing to resolve the ref against.

    await expect(
      gateway.click("risk-analyst", "risk-analyst", ACTOR, {
        ref: "e9",
        snapshotId: 1,
      }),
    ).rejects.toThrow();

    // The neutral values are for actions that HAVE no element. A click whose element could not be
    // found must still be treated as possibly the one the rule is about.
    expect(reached).not.toContain("click");
  });
});
