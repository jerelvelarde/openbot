/**
 * Where the companion's data comes from.
 *
 * One interface, two implementations. The seam exists because the endpoints this app wants —
 * `GET/POST /api/approvals`, notification delivery — are Phase 1 and Phase 2 of the plan and do not
 * exist on the server yet. Rather than wait, or fake them inside the screens where the fakery would
 * have to be unpicked later, the screens are written against this interface once and the transport
 * is swapped underneath.
 *
 * `createLocalSource` is also what makes the app runnable and recordable with no deployment, no
 * Docker and no model key.
 */
import type {
  Approval,
  AuditRow,
  Channel,
  Message,
  Notification,
} from "./types";

export type AnswerScope = "once" | "always";

export type DataSource = {
  channels(): Promise<Channel[]>;
  channel(id: string): Promise<Channel | undefined>;
  messages(channelId: string): Promise<Message[]>;
  /**
   * Say something to a Bot.
   *
   * Returns whether it was queued. A Bot mid-turn does not get interrupted: the message lands in the
   * thread immediately and drains into one follow-up turn when it settles.
   */
  send(channelId: string, text: string): Promise<{ queued: boolean }>;
  approvals(): Promise<Approval[]>;
  approval(id: string): Promise<Approval | undefined>;
  /**
   * Answer a parked action.
   *
   * `always` writes a scoped allow rule rather than a hidden per-bot flag, so the permission a person
   * granted from a phone is visible in `/admin/boundaries` like any other rule.
   */
  answer(
    id: string,
    decision: "allow" | "deny",
    scope: AnswerScope,
  ): Promise<Approval>;
  audit(channelId?: string): Promise<AuditRow[]>;
  notifications(): Promise<Notification[]>;
  markRead(id: string): Promise<void>;
  /** Fires when anything changes, so screens re-read rather than hold their own copy. */
  subscribe(listener: () => void): () => void;
};
