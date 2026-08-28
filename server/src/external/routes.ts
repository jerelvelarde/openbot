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
import type { ExternalWebTurnStore } from "./web-turn-store";

const INVALID_LINK_MESSAGE = "This Slack link has expired or is invalid.";
const LINK_CONFLICT_MESSAGE = "That Slack identity is already linked.";
const INVALID_ASSISTANCE_MESSAGE =
  "This assistance link has expired or is invalid.";
const ASSISTANCE_FORBIDDEN_MESSAGE =
  "This assistance request is not available to this account.";
const INVALID_CONVERSATION_PAGE_MESSAGE = "Invalid conversation page.";
const CONVERSATION_NOT_FOUND_MESSAGE = "Conversation not found.";
const READ_ONLY_MESSAGE =
  "This Slack conversation cannot accept messages from OpenBot yet.";
const INVALID_TURN_MESSAGE = "Enter a message to send.";

/**
 * Bounds a web-authored turn before anything is claimed or delivered.
 *
 * Deliberately a standalone pure function returning a discriminated result: the
 * bounds are the interesting part and testing them should not need a request.
 */
const MAX_TURN_CODE_POINTS = 4_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export type ExternalTurnInput = { idempotencyKey: string; text: string };

export function parseExternalTurnInput(
  value: unknown,
): { ok: true; value: ExternalTurnInput } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: INVALID_TURN_MESSAGE };
  }
  const body = value as { id?: unknown; text?: unknown };
  if (
    typeof body.id !== "string" ||
    // The same charset the managed boundary bounds ids by, so a key that is
    // accepted here cannot be rejected further down the chain.
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(body.id) ||
    body.id.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    return { ok: false, error: INVALID_TURN_MESSAGE };
  }
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return { ok: false, error: INVALID_TURN_MESSAGE };
  }
  // Counted in code points, not UTF-16 units, so an emoji costs one character
  // to the person typing it rather than two.
  if (Array.from(body.text).length > MAX_TURN_CODE_POINTS) {
    return { ok: false, error: INVALID_TURN_MESSAGE };
  }
  return { ok: true, value: { idempotencyKey: body.id, text: body.text } };
}

type ExternalLinkRoutesOptions = {
  store: ExternalLinkCreationStore;
  encryptionKey: string;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  auditStore: TransactionalAuditStore;
  agentProfileStore: Pick<AgentProfileStore, "get" | "listAccessibleIds">;
  threadStore: ExternalThreadStore;
  webTurnStore: ExternalWebTurnStore;
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

function externalThreadLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(INVALID_CONVERSATION_PAGE_MESSAGE);
  }
  const limit = Number(value);
  if (limit < 1 || limit > 200) {
    throw new Error(INVALID_CONVERSATION_PAGE_MESSAGE);
  }
  return limit;
}

type ExternalThreadSummary = Awaited<
  ReturnType<ExternalThreadStore["listForCreator"]>
>["threads"][number];

function externalThreadSummary(
  thread: ExternalThreadSummary,
  writable: boolean,
) {
  return {
    threadId: thread.threadId,
    provider: thread.provider,
    agentId: thread.agentId,
    agentName: thread.agentName,
    lastMessage: thread.lastMessage,
    lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
    createdAt: thread.createdAt.toISOString(),
    readOnly: !writable,
  };
}

export function createExternalLinkRoutes({
  store,
  encryptionKey,
  requireUser,
  auditStore,
  agentProfileStore,
  threadStore,
  webTurnStore,
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

  routes.use("/threads", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.get("/threads", requireUser, async (context) => {
    let limit: number | undefined;
    try {
      limit = externalThreadLimit(context.req.query("limit"));
    } catch {
      return context.json({ error: INVALID_CONVERSATION_PAGE_MESSAGE }, 400);
    }

    const actor = context.var.actor;
    const requestedLimit = limit ?? 50;
    const agentIds = await agentProfileStore.listAccessibleIds({
      id: actor.id,
      role: actor.role,
    });
    const page = await threadStore.listForCreator(actor.id, {
      agentIds,
      cursor: context.req.query("cursor"),
      limit: requestedLimit,
    });

    const writable = await webTurnStore.threadsWithConversationRef(
      page.threads.map((thread) => thread.threadId),
    );

    return context.json({
      threads: page.threads.map((thread) =>
        externalThreadSummary(thread, writable.has(thread.threadId)),
      ),
      nextCursor: page.nextCursor,
    });
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
      // Capability, not configuration. A thread is writable exactly when
      // Intelligence has issued a conversation reference for it, so a
      // deployment without managed support degrades to the read-only surface on
      // its own rather than through a flag someone has to remember to unset.
      readOnly:
        (await webTurnStore.conversationRef(binding.channelsThreadId)) === null,
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

  routes.post("/threads/:threadId/messages", requireUser, async (context) => {
    const actor = context.var.actor;
    const threadId = context.req.param("threadId");
    const parsed = parseExternalTurnInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 422);

    // Ownership first, and not-found and not-yours collapse to one response, so
    // posting cannot become a probe for which threads exist. Same shape as the
    // two GET handlers above.
    const binding = await threadStore.getByChannelsThreadId(threadId);
    if (!binding || binding.createdByUserId !== actor.id) {
      return context.json({ error: CONVERSATION_NOT_FOUND_MESSAGE }, 404);
    }
    // Re-checked on every turn rather than trusted from the binding: a user who
    // has since lost access to the pinned coworker must stop being able to
    // speak into the thread they started.
    const profile = await agentProfileStore.get(
      { id: actor.id, role: actor.role },
      binding.agentId,
    );
    if (!profile) {
      return context.json({ error: CONVERSATION_NOT_FOUND_MESSAGE }, 404);
    }

    const conversationRef = await webTurnStore.conversationRef(threadId);
    if (conversationRef === null) {
      // The managed capability is absent, so nothing here can reach Slack.
      // Refusing before the claim keeps the ledger free of turns that were
      // never deliverable, and 409 says "not now" rather than "never".
      return context.json({ error: READ_ONLY_MESSAGE }, 409);
    }

    // Claimed before delivery, so a retried submission returns the original
    // operation instead of producing a second Slack message and agent run.
    const claim = await webTurnStore.claim({
      channelsThreadId: threadId,
      idempotencyKey: parsed.value.idempotencyKey,
      authorUserId: actor.id,
    });
    if (claim.kind === "duplicate") {
      return context.json(
        {
          operationId: claim.operationId,
          status: claim.status,
          duplicate: true,
        },
        200,
      );
    }

    await recordAuditEvent(auditStore, {
      eventType: "external_thread.turn_authored",
      targetType: "external_thread",
      targetId: threadId,
      actorUserId: actor.id,
      // Deliberately no message text and no conversation reference: this record
      // says a turn was authored, not what it said or how to reach it.
      payload: { agentId: binding.agentId, operationId: claim.operationId },
    });

    /*
     * Accepted, not completed. Delivery into the Slack thread is the managed
     * path's job and is not wired yet (CopilotKit/CopilotKit#6751), so this
     * returns the durable operation id rather than pretending the message has
     * landed. Nothing acknowledges success before Slack has the message.
     */
    return context.json(
      { operationId: claim.operationId, status: "accepted" },
      202,
    );
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
