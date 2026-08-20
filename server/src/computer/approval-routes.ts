/**
 * The approvals surface: what is waiting on you, and answering it.
 *
 * A REST resource rather than a prompt inside one client, because the person who answers may not be
 * on the device that started the turn. That is the whole reason this exists: the same question is
 * answerable from the web app, from a phone, or from somebody else's laptop, and it survives the tab
 * that caused it being closed.
 *
 * Scoped by agent visibility, not merely by being signed in. A private Bot's approvals are its
 * owner's business, and a deployment with several people in it must not let one of them approve
 * another's Bot spending money.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import type { ApprovalRecord, ApprovalStore } from "./approvals";
import { scopedAllowRule } from "./approvals";
import type { PolicyStore } from "./policy-store";

/** What a surface renders. The rule travels with it; the actor's id does not. */
function present(approval: ApprovalRecord, botName: string) {
  return {
    id: approval.id,
    botId: approval.agentId,
    botName,
    channelId: approval.threadId,
    toolName: approval.toolName,
    intent: approval.intent,
    subject: approval.subject,
    rule: approval.rule,
    reason: approval.reason,
    state: approval.state,
    askedAt: approval.createdAt,
    answeredAt: approval.answeredAt,
    scopedRule: approval.scopedRule,
    expiresAt: approval.expiresAt,
  };
}

export function createApprovalRoutes(
  approvals: ApprovalStore,
  profileStore: AgentProfileStore,
  policyStore: PolicyStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /** The Bots this person may see, and what they are called. */
  async function visibleBots(context: {
    var: { actor: AppVariables["actor"] };
  }) {
    const actor = context.var.actor;
    const profiles = await profileStore.list({
      id: actor.id,
      role: actor.role,
    });
    return new Map(profiles.map((profile) => [profile.id, profile.name]));
  }

  routes.get("/", requireUser, async (context) => {
    const bots = await visibleBots(context);
    const all = await approvals.recent(60);
    return context.json(
      all
        .filter((approval) => bots.has(approval.agentId))
        .map((approval) =>
          present(approval, bots.get(approval.agentId) ?? approval.agentId),
        ),
    );
  });

  routes.get("/:approvalId", requireUser, async (context) => {
    const approval = await approvals.get(context.req.param("approvalId"));
    if (!approval) {
      return context.json({ error: "That approval is not waiting." }, 404);
    }
    const bots = await visibleBots(context);
    // 404 rather than 403 for a Bot this person cannot see: whether somebody else's private Bot
    // exists is not a fact this endpoint should confirm.
    if (!bots.has(approval.agentId)) {
      return context.json({ error: "That approval is not waiting." }, 404);
    }
    return context.json(
      present(approval, bots.get(approval.agentId) ?? approval.agentId),
    );
  });

  routes.post("/:approvalId", requireUser, async (context) => {
    const approvalId = context.req.param("approvalId");
    const body = (await context.req.json().catch(() => null)) as {
      decision?: unknown;
      scope?: unknown;
    } | null;

    const decision = body?.decision;
    if (decision !== "allow" && decision !== "deny") {
      return context.json(
        { error: 'decision must be "allow" or "deny".' },
        400,
      );
    }
    const scope = body?.scope === "always" ? "always" : "once";

    const existing = await approvals.get(approvalId);
    if (!existing) {
      return context.json({ error: "That approval is not waiting." }, 404);
    }
    const bots = await visibleBots(context);
    if (!bots.has(existing.agentId)) {
      return context.json({ error: "That approval is not waiting." }, 404);
    }
    if (existing.state !== "pending") {
      // Already settled, by somebody else or by the window closing. Reported as a conflict rather
      // than quietly overwritten: two people answering the same question must not both believe
      // theirs was the answer.
      return context.json(
        {
          error: `That was already ${existing.state}.`,
          state: existing.state,
        },
        409,
      );
    }

    const actor = context.var.actor;

    /**
     * "Always allow" writes a rule, and writes it BEFORE answering.
     *
     * In that order because the gateway carries the action out the moment the answer lands. Granting
     * afterwards would leave a window where the same call asks again, which to the person who just
     * pressed "always" looks exactly like the button not working.
     */
    let scopedRule: string | undefined;
    if (decision === "allow" && scope === "always") {
      scopedRule = scopedAllowRule(existing.agentId, existing.subject);
      if (!scopedRule) {
        // A label that cannot be expressed as a rule safely is not escaped into one. The one-off
        // answer is still available, and saying so is better than writing a rule that means
        // something slightly different from what was on screen.
        return context.json(
          {
            error:
              "That cannot be turned into a standing rule automatically. Allow it once, and add the rule in Boundaries.",
          },
          422,
        );
      }
      /**
       * Written to `exempt`, not `allow`.
       *
       * `allow` is evaluated after `ask`, so a permission written there could never stop the asking:
       * the person who pressed "always allow" would be asked again on the very next action. `exempt`
       * outranks `ask` and is still outranked by `deny`.
       */
      const current = policyStore.get();
      if (!(current.exempt ?? []).includes(scopedRule)) {
        await policyStore.set(
          { ...current, exempt: [...(current.exempt ?? []), scopedRule] },
          actor.email,
        );
      }
    }

    const answered = await approvals.answer(approvalId, {
      decision,
      scope,
      // Only a real users row may go in the foreign key. The local development actor is not one.
      ...(actor.email === DEV_ACTOR_EMAIL
        ? {}
        : { answeredByUserId: actor.id }),
      ...(scopedRule ? { scopedRule } : {}),
    });

    if (!answered) {
      return context.json(
        { error: "Somebody answered that a moment before you did." },
        409,
      );
    }

    // The audit row for the answer is written by the gateway, which is the thing that was waiting and
    // therefore the only place that knows the question actually resumed. Writing one here as well
    // would put two rows in the trail for one answer.
    return context.json(
      present(answered, bots.get(answered.agentId) ?? answered.agentId),
    );
  });

  return routes;
}

/**
 * The local actor's address.
 *
 * Compared against rather than imported from `auth/dev-actor`, for the same reason `computer/routes.ts`
 * does it: the computer must not depend on the authentication module's internals, and this is the one
 * fact about it that matters here.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";
