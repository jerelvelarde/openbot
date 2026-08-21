/**
 * What the companion knows about, named the way the server names it.
 *
 * Deliberately the server's vocabulary and not a phone-shaped simplification: a Bot, a channel, a
 * parked approval, an audit row. The moment these types start meaning something different from
 * `server/src/db/schema` and `server/src/computer/policy.ts`, the two surfaces begin telling people
 * different stories about the same deployment.
 */

/**
 * What a Bot wants to do, as the SERVER resolved it.
 *
 * Never as the model described it. The gateway looks the element up in the snapshot it took itself,
 * and that resolved value is what the audit row carries; a phone showing the model's own label for
 * what it is about to click would be showing the one thing the policy exists not to trust.
 */
export type ApprovalSubject = {
  /** How to phrase it: an element on a page, a file, a page itself, or a tool on an MCP server. */
  kind: "element" | "file" | "page" | "mcp";
  /** The element label, file path or tool name, exactly as the server resolved it. */
  label: string;
  /** Where it lands, when there is a where. */
  host?: string;
};

export type ApprovalState = "pending" | "allowed" | "denied" | "expired";

export type Approval = {
  id: string;
  botId: string;
  botName: string;
  channelId: string;
  /** The tool the Bot called, e.g. `computer_click`. Mechanism. */
  toolName: string;
  /** What the call does, e.g. `activate`. Effect, which is how an operator thinks. */
  intent: string;
  subject: ApprovalSubject;
  /** The CEL expression that asked. An operator can search for this in /admin/boundaries. */
  rule: string;
  /** Why, in words that go in front of a person. */
  reason: string;
  askedAt: string;
  /**
   * When the window closes.
   *
   * The server parks an action for ten minutes and then answers the Bot itself — "long enough that
   * somebody can walk back to their desk", as it puts it. A screen that shows three live buttons and
   * no deadline invites exactly that walk, and then a 409. Optional because the local fixtures and
   * older rows may not carry one.
   */
  expiresAt?: string;
  state: ApprovalState;
  /**
   * When it was answered, if it was. Never BY WHOM: the server deliberately does not carry the
   * answerer's identity, and a surface that filled that gap in would be inventing an attribution on
   * a security decision.
   */
  answeredAt?: string | null;
  /** Set when the answer wrote a scoped allow rule rather than a one-off permission. */
  scopedRule?: string;
};

export type ToolLineOutcome = "allowed" | "refused" | "failed" | "running";

/** One acting call, as the transcript draws it. Never the arguments: a trail is not a transcript. */
export type ToolLine = {
  /**
   * The call this line is about, where the stream said so.
   *
   * Present on a line being drawn live, so a running line and the resolved line that replaces it are
   * the same element to React rather than the same array position — which is what lets a list of
   * calls resolve out of order without the rows swapping under somebody reading them.
   */
  id?: string;
  label: string;
  detail?: string;
  outcome: ToolLineOutcome;
  /** Present only on a refusal, and it is the rule that caused it. */
  rule?: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text?: string;
  toolLines?: ToolLine[];
  at: string;
  /**
   * Sent to a Bot that was mid-turn.
   *
   * Held and drained into one follow-up turn when the Bot settles, rather than interrupting. The
   * words are already in the thread either way; what is queued is only the intent to run.
   */
  queued?: boolean;
};

/**
 * A Bot somebody could start a conversation with.
 *
 * The roster as `/api/agents` gives it, minus the fields only an administrator's screens need. It
 * carries `title` because "Risk Analyst" and "reads the payment runs" answer different questions,
 * and a person picking from a list of five Bots needs the second one.
 */
export type Bot = {
  id: string;
  name: string;
  title: string | null;
};

/**
 * A granted skill, as a `/` command.
 *
 * `instructions` travels with it because that is what actually goes to the Bot — as a system turn in
 * front of the message, never pasted into the person's own words. See `send`.
 */
export type Skill = {
  slug: string;
  title: string;
  summary: string | null;
  instructions: string;
};

/**
 * A turn as it arrives, before the deployment's own thread has it.
 *
 * The durable thread is authoritative and is what the transcript draws from a moment later; this is
 * the same turn while it is still being written. Held by the screen that started the run rather than
 * by the source, because it is ephemeral state about one in-flight request — and because announcing
 * a re-read of the whole thread on every token would put a network call behind every character.
 */
export type LiveTurn = {
  /** What the Bot has said so far. Grows by deltas. */
  text: string;
  /** What it has done so far, in order, resolving from running to an outcome. */
  toolLines: ToolLine[];
  /** Set when the run ended badly, in the words the deployment used. */
  failure?: string;
  done: boolean;
};

export type Channel = {
  id: string;
  name: string;
  botId: string;
  botName: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  /** A Bot mid-turn. A message sent now is queued and steered rather than dropped. */
  busy: boolean;
  pendingApprovals: number;
};

export type AuditOutcome =
  | "allowed"
  | "refused"
  | "failed"
  | "asked"
  | "answered"
  /** The window closed with nobody answering. Not a refusal, and not a failure. */
  | "expired";

export type AuditRow = {
  id: string;
  at: string;
  eventType: string;
  botId: string;
  botName: string;
  summary: string;
  outcome: AuditOutcome;
  rule?: string;
  actor?: string;
  /**
   * Whether the boundary was being enforced when this was decided.
   *
   * A dry-run deployment records a refusal and then lets the action through, so a row that says
   * "Refused" about something that happened is the trail contradicting itself. `carriedOut` is the
   * server's own word for "it went ahead anyway".
   */
  mode?: "enforce" | "dry-run";
  carriedOut?: boolean;
};

export type Notification = {
  id: string;
  /** The tight rule: approval, question, done-if-asked, routine-failed. Nothing else buzzes. */
  kind:
    | "approval"
    | "question"
    | "done"
    | "refused"
    /** Nobody answered in time. Not "failed": nothing was permitted and nothing was attempted. */
    | "expired"
    | "routine-failed";
  /** The Bot's id, which is also its avatar seed. Its face is how a list is scanned. */
  botId: string;
  botName: string;
  /**
   * The line a person reads on a lock screen.
   *
   * Resolved subject only. Never argument values, never file contents, never a message body: a push
   * payload is a less trusted surface than the audit trail, not a more trusted one.
   */
  body: string;
  at: string;
  read: boolean;
  approvalId?: string;
  channelId?: string;
};
