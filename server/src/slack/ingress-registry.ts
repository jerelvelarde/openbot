import type { ChannelIdentityContext } from "@copilotkit/channels";
import type { SlackIdentityResult } from "./identity-linker";

export type Timer = { cancel(): void };

export type SlackIngress = {
  identityContext: ChannelIdentityContext;
  identityResult: SlackIdentityResult;
};

export type SlackIngressSelector = {
  provider: "slack";
  providerTenantId: string;
  providerConversationId: string;
  providerActorId: string;
  applicationUserId: string | null;
  conversationKey: string;
};

export type SlackIngressTimer = {
  after(milliseconds: number, callback: () => void): Timer;
};

const INGRESS_TTL_MS = 30_000;
const EVENT_ID_ERROR = "Managed Slack ingress requires an event id.";

type RememberedIngress = {
  ingress: SlackIngress;
  timer: Timer;
};

const systemTimer: SlackIngressTimer = {
  after(milliseconds, callback) {
    const timeout = setTimeout(callback, milliseconds);
    return { cancel: () => clearTimeout(timeout) };
  },
};

function requiredEventId(eventId: string | undefined): string {
  if (!eventId?.trim()) throw new Error(EVENT_ID_ERROR);
  return eventId.trim();
}

/** One-use, short-lived identity facts bridging managed Channels ingress to agent execution. */
export class SlackIngressRegistry {
  private readonly entries = new Map<string, RememberedIngress[]>();

  constructor(private readonly timer: SlackIngressTimer = systemTimer) {}

  remember(eventId: string | undefined, ingress: SlackIngress): void {
    const id = requiredEventId(eventId);
    const rememberedForEvent = this.entries.get(id) ?? [];
    const priorIndex = rememberedForEvent.findIndex(({ ingress: prior }) =>
      samePrincipal(prior, ingress),
    );
    const prior = rememberedForEvent[priorIndex];
    prior?.timer.cancel();

    let remembered: RememberedIngress;
    const timer = this.timer.after(INGRESS_TTL_MS, () => {
      this.remove(id, remembered);
    });
    remembered = { ingress, timer };
    if (priorIndex >= 0) rememberedForEvent[priorIndex] = remembered;
    else rememberedForEvent.push(remembered);
    this.entries.set(id, rememberedForEvent);
  }

  take(
    eventId: string | undefined,
    selector: SlackIngressSelector,
  ): SlackIngress | null {
    const id = requiredEventId(eventId);
    const matches = (this.entries.get(id) ?? []).filter(({ ingress }) =>
      matchesSelector(ingress, selector),
    );
    if (matches.length !== 1) return null;
    const [remembered] = matches;
    if (!remembered) return null;
    this.remove(id, remembered);
    remembered.timer.cancel();
    return remembered.ingress;
  }

  private remove(id: string, remembered: RememberedIngress): void {
    const remaining = (this.entries.get(id) ?? []).filter(
      (entry) => entry !== remembered,
    );
    if (remaining.length > 0) this.entries.set(id, remaining);
    else this.entries.delete(id);
  }
}

function applicationUserId(ingress: SlackIngress): string | null {
  return ingress.identityResult.kind === "linked"
    ? ingress.identityResult.user.id
    : null;
}

function samePrincipal(left: SlackIngress, right: SlackIngress): boolean {
  return (
    left.identityContext.provider === right.identityContext.provider &&
    left.identityContext.tenant.id === right.identityContext.tenant.id &&
    left.identityContext.conversation.id ===
      right.identityContext.conversation.id &&
    left.identityContext.actor.id === right.identityContext.actor.id &&
    applicationUserId(left) === applicationUserId(right)
  );
}

function matchesSelector(
  ingress: SlackIngress,
  selector: SlackIngressSelector,
): boolean {
  const context = ingress.identityContext;
  const expectedPrefix = `${selector.provider}:${selector.providerTenantId}:${selector.providerConversationId}:`;
  return (
    context.provider === selector.provider &&
    context.tenant.id === selector.providerTenantId &&
    context.conversation.id === selector.providerConversationId &&
    context.actor.id === selector.providerActorId &&
    applicationUserId(ingress) === selector.applicationUserId &&
    selector.conversationKey.startsWith(expectedPrefix) &&
    selector.conversationKey.length > expectedPrefix.length
  );
}
