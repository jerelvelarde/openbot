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
export type ApprovalSubject =
  | { kind: "element"; label: string; host: string }
  | { kind: "page"; host: string; url: string }
  | { kind: "file"; path: string }
  | { kind: "mcp"; server: string; tool: string; effect: "read" | "write" };

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
  state: ApprovalState;
  answeredBy?: string;
  /** Set when the answer wrote a scoped allow rule rather than a one-off permission. */
  scopedRule?: string;
};

export type ToolLineOutcome = "allowed" | "refused" | "failed" | "running";

/** One acting call, as the transcript draws it. Never the arguments: a trail is not a transcript. */
export type ToolLine = {
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
  | "answered";

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
};

export type Notification = {
  id: string;
  /** The tight rule: approval, question, done-if-asked, routine-failed. Nothing else buzzes. */
  kind: "approval" | "question" | "done" | "routine-failed";
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
