import type { ChannelIdentityContext } from "@copilotkit/channels";
import type { SlackIdentityResult } from "./identity-linker";

export type Timer = { cancel(): void };

export type SlackIngress = {
  identityContext: ChannelIdentityContext;
  identityResult: SlackIdentityResult;
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
  private readonly entries = new Map<string, RememberedIngress>();

  constructor(private readonly timer: SlackIngressTimer = systemTimer) {}

  remember(eventId: string | undefined, ingress: SlackIngress): void {
    const id = requiredEventId(eventId);
    const prior = this.entries.get(id);
    prior?.timer.cancel();

    let remembered: RememberedIngress;
    const timer = this.timer.after(INGRESS_TTL_MS, () => {
      if (this.entries.get(id) === remembered) this.entries.delete(id);
    });
    remembered = { ingress, timer };
    this.entries.set(id, remembered);
  }

  take(eventId: string | undefined): SlackIngress | null {
    const id = requiredEventId(eventId);
    const remembered = this.entries.get(id);
    if (!remembered) return null;
    this.entries.delete(id);
    remembered.timer.cancel();
    return remembered.ingress;
  }
}
