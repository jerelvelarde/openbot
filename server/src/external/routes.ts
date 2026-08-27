import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { ExternalLinkStore } from "./link-store";
import { readExternalLinkToken } from "./link-token";
import type { ExternalProviderIdentity } from "./schema-types";

const INVALID_LINK_MESSAGE = "This Slack link has expired or is invalid.";
const LINK_CONFLICT_MESSAGE = "That Slack identity is already linked.";

type ExternalLinkRoutesOptions = {
  store: ExternalLinkStore;
  encryptionKey: string;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  auditStore: AuditStore;
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
      await store.link({ ...claim, openbotUserId: actor.id });
    } catch (error) {
      if (error instanceof Error && error.message === LINK_CONFLICT_MESSAGE) {
        return context.json({ error: LINK_CONFLICT_MESSAGE }, 409);
      }
      throw error;
    }

    await recordAuditEvent(auditStore, {
      eventType: "external_identity.linked" as Parameters<
        typeof recordAuditEvent
      >[1]["eventType"],
      targetType: "user",
      targetId: actor.id,
      actorUserId: actor.id,
      payload: {
        provider: claim.provider,
        providerTenantId: claim.providerTenantId,
        providerUserId: claim.providerUserId,
      },
    });
    return context.json({ linked: true });
  });

  return routes;
}
