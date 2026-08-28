import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../agents/profile-store";
import { recordAuditEvent, type TransactionalAuditStore } from "../audit";
import type { AppVariables } from "../auth/guards";
import {
  type AssistanceClaim,
  readAssistanceToken,
} from "../slack/assistance-token";
import type { ExternalLinkCreationStore } from "./link-store";
import { readExternalLinkToken } from "./link-token";
import type { ExternalProviderIdentity } from "./schema-types";
import type { ExternalThreadStore } from "./thread-store";

const INVALID_LINK_MESSAGE = "This Slack link has expired or is invalid.";
const LINK_CONFLICT_MESSAGE = "That Slack identity is already linked.";
const INVALID_ASSISTANCE_MESSAGE =
  "This assistance link has expired or is invalid.";
const ASSISTANCE_FORBIDDEN_MESSAGE =
  "This assistance request is not available to this account.";

type ExternalLinkRoutesOptions = {
  store: ExternalLinkCreationStore;
  encryptionKey: string;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  auditStore: TransactionalAuditStore;
  agentProfileStore: Pick<AgentProfileStore, "get">;
  threadStore: ExternalThreadStore;
};

function tokenFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const token = (value as { token?: unknown }).token;
  return typeof token === "string" ? token : undefined;
}

function invalidLinkResponse(context: Context<{ Variables: AppVariables }>) {
  return context.json({ error: INVALID_LINK_MESSAGE }, 400);
}

export function createExternalLinkRoutes({
  store,
  encryptionKey,
  requireUser,
  auditStore,
  agentProfileStore,
  threadStore,
}: ExternalLinkRoutesOptions) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/slack", requireUser, async (context) => {
    try {
      const claim = await readExternalLinkToken(
        context.req.query("token"),
        encryptionKey,
      );
      return context.json({
        providerTenantId: claim.providerTenantId,
        providerUserId: claim.providerUserId,
        providerEmail: claim.providerEmail,
      });
    } catch {
      return invalidLinkResponse(context);
    }
  });

  routes.post("/slack", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    let claim: ExternalProviderIdentity;
    try {
      claim = await readExternalLinkToken(tokenFrom(body), encryptionKey);
    } catch {
      return invalidLinkResponse(context);
    }

    const actor = context.var.actor;
    try {
      await store.linkWithStatusAndAudit(
        { ...claim, openbotUserId: actor.id },
        async (transaction) => {
          await recordAuditEvent(auditStore.inTransaction(transaction), {
            eventType: "external_identity.linked",
            targetType: "user",
            targetId: actor.id,
            actorUserId: actor.id,
            payload: {
              provider: claim.provider,
              providerTenantId: claim.providerTenantId,
              providerUserId: claim.providerUserId,
            },
          });
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message === LINK_CONFLICT_MESSAGE) {
        return context.json({ error: LINK_CONFLICT_MESSAGE }, 409);
      }
      throw error;
    }

    return context.json({ linked: true });
  });

  routes.use("/threads/*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.get("/threads/:threadId", requireUser, async (context) => {
    const actor = context.var.actor;
    const binding = await threadStore.getByChannelsThreadId(
      context.req.param("threadId"),
    );
    if (!binding || binding.createdByUserId !== actor.id) {
      return context.json({ error: "Conversation not found." }, 404);
    }

    const profile = await agentProfileStore.get(
      { id: actor.id, role: actor.role },
      binding.agentId,
    );
    if (!profile) {
      return context.json({ error: "Conversation not found." }, 404);
    }

    return context.json({
      threadId: binding.channelsThreadId,
      agentId: profile.id,
      agentName: profile.name,
      provider: binding.provider,
      readOnly: true,
    });
  });

  routes.get("/threads/:threadId/messages", requireUser, async (context) => {
    const actor = context.var.actor;
    const threadId = context.req.param("threadId");
    const binding = await threadStore.getByChannelsThreadId(threadId);
    if (!binding || binding.createdByUserId !== actor.id) {
      return context.json({ error: "Conversation not found." }, 404);
    }
    const profile = await agentProfileStore.get(
      { id: actor.id, role: actor.role },
      binding.agentId,
    );
    if (!profile) {
      return context.json({ error: "Conversation not found." }, 404);
    }
    return context.json({
      messages: await threadStore.getTranscript(threadId),
    });
  });

  routes.use("/assistance", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.get("/assistance", requireUser, async (context) => {
    let claim: AssistanceClaim;
    try {
      claim = await readAssistanceToken(
        context.req.query("token"),
        encryptionKey,
      );
    } catch {
      return context.json({ error: INVALID_ASSISTANCE_MESSAGE }, 410);
    }

    const actor = context.var.actor;
    if (claim.openbotUserId !== actor.id) {
      return context.json({ error: ASSISTANCE_FORBIDDEN_MESSAGE }, 403);
    }

    let profile: Awaited<ReturnType<AgentProfileStore["get"]>>;
    try {
      profile = await agentProfileStore.get(
        { id: actor.id, role: actor.role },
        claim.agentId,
      );
    } catch {
      return context.json(
        { error: "This assistance request could not be checked right now." },
        503,
      );
    }
    if (!profile) {
      return context.json({ error: ASSISTANCE_FORBIDDEN_MESSAGE }, 403);
    }
    return context.json({ agentId: profile.id });
  });

  return routes;
}
