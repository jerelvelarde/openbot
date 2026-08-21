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
  Bot,
  Channel,
  LiveTurn,
  Message,
  Notification,
  Skill,
} from "./types";

export type AnswerScope = "once" | "always";

export type SendOptions = {
  /**
   * Skills to put in front of the message.
   *
   * Each one becomes a system turn ahead of the person's own, which is how the web app does it too:
   * pasting a skill's paragraph into somebody's message puts sentences in their mouth and makes the
   * reply quote instructions back at them.
   */
  skills?: Skill[];
  /** Called as the reply is written. See {@link DataSource.send}. */
  onTurn?: (turn: LiveTurn) => void;
  /**
   * Leaving the screen, or the app.
   *
   * Aborts reading the stream. It does NOT stop the run: a turn belongs to the deployment once it has
   * started, and pretending a phone can call it back would be the app claiming a power it has not
   * got. Whatever happens next is in the thread and in the trail.
   */
  signal?: AbortSignal;
};

export type DataSource = {
  channels(): Promise<Channel[]>;
  channel(id: string): Promise<Channel | undefined>;
  messages(channelId: string): Promise<Message[]>;
  /**
   * Say something to a Bot, and watch it answer.
   *
   * Returns whether it was queued. A Bot mid-turn does not get interrupted: the message lands in the
   * thread immediately and drains into one follow-up turn when it settles.
   *
   * `onTurn` is called as the reply arrives, which is the difference between a chat and a form. It is
   * optional: a caller that only wants the message sent can ignore it and read the thread afterwards.
   */
  send(
    channelId: string,
    text: string,
    options?: SendOptions,
  ): Promise<{ queued: boolean }>;
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
  /**
   * The Bots a conversation could be started with.
   *
   * Only the ones this person may see, and never the hidden ones: the deployment's own scoping, not
   * a filter invented here.
   */
  bots(): Promise<Bot[]>;
  /**
   * Start a conversation with a Bot.
   *
   * The server mints the thread, so the app never invents one. Returns the channel to open.
   */
  createChannel(botId: string): Promise<Channel>;
  /**
   * The skills granted to a channel's Bot, offered as `/` commands in its composer.
   *
   * Keyed on the channel rather than the Bot, like every other read here. A read keyed on something
   * that arrives from ANOTHER read runs once with nothing — `useLiveResult` re-subscribes on the
   * source, not on a changed closure — and then waits for an unrelated announce to notice.
   */
  skills(channelId: string): Promise<Skill[]>;
  /** Fires when anything changes, so screens re-read rather than hold their own copy. */
  subscribe(listener: () => void): () => void;
  /**
   * Read everything again, now, because a person asked.
   *
   * A poll every few seconds is the right default and the wrong answer to "this says it could not
   * reach the deployment". Relaunching the app was previously the only way to retry.
   */
  refresh(): void;
};
