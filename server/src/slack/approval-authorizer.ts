import type { AgentProfileStore } from "../agents/profile-store";
import type { ExternalLinkAuthorizationStore } from "../external/link-store";
import type { ExternalThreadStore } from "../external/thread-store";
import type { ApprovalPresentation } from "./approval-store";

export type SlackApprovalAuthorization = {
  actor: { id: string; role: "admin" | "user" };
  applicationUser: { id: string; name: string };
  provider: "slack";
  providerTenantId: string;
  providerConversationId: string;
  providerThreadId: string;
};

export type ApprovalAuthorizerDependencies = {
  links: ExternalLinkAuthorizationStore;
  threads: ExternalThreadStore;
  profiles: Pick<AgentProfileStore, "get">;
};

/** Recheck canonical user, immutable Slack thread binding, and coworker visibility per click. */
export function createApprovalAuthorizer(
  dependencies: ApprovalAuthorizerDependencies,
) {
  return async (input: {
    userId: string;
    presentation: ApprovalPresentation;
  }): Promise<false | SlackApprovalAuthorization> => {
    const active = await dependencies.links.resolveActiveUser(input.userId);
    if (!active || active.id !== input.userId) return false;
    const binding = await dependencies.threads.getByChannelsThreadId(
      input.presentation.channelsThreadId,
    );
    if (!binding || binding.agentId !== input.presentation.agentId)
      return false;
    const actor = { id: active.id, role: active.role };
    if (
      (await dependencies.profiles.get(actor, input.presentation.agentId)) ===
      null
    ) {
      return false;
    }
    return {
      actor,
      applicationUser: { id: active.id, name: active.name },
      provider: "slack",
      providerTenantId: binding.providerTenantId,
      providerConversationId: binding.providerConversationId,
      providerThreadId: binding.providerThreadId,
    };
  };
}
