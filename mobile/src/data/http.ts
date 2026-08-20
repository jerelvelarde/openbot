/**
 * The same data, from a real deployment.
 *
 * Written against the endpoints that exist: `/api/approvals` (the `ask` outcome), `/api/channels`,
 * `/api/agents`, `/api/audit`, and the runtime's own thread history under `/api/copilotkit`. Nothing
 * here invents a route.
 *
 * Three things this deliberately does NOT do:
 *  - it does not fall back to local data when a request fails. A companion that quietly shows a made
 *    up approval queue when it cannot reach the server is worse than one that says it is offline.
 *  - it does not pretend it can start a turn. Running a Bot is an AG-UI run over the CopilotKit
 *    runtime, not a REST call, so `send` refuses in plain words rather than dropping the message.
 *  - it does not invent a notification feed. What is waiting on a person IS the approval queue, and a
 *    second list derived from it would be a second source of truth for the same fact.
 */
import type {
  Approval,
  ApprovalSubject,
  AuditOutcome,
  AuditRow,
  Channel,
  Message,
  Notification,
  ToolLine,
} from "./types";
import type { AnswerScope, DataSource } from "./source";

export type HttpSourceConfig = {
  /**
   * Where the API is. Empty means same-origin, which is what the web build behind the dev proxy uses.
   *
   * A native client passes an absolute URL and a token. Only the API server is ever reachable; the
   * Bot computers stay on loopback.
   */
  baseUrl?: string;
  /**
   * The device token.
   *
   * Absent is only correct against a deployment running `OPENBOT_DEV_NO_AUTH` on loopback, which
   * admits every caller as one administrator. Anything reachable from a phone needs a real token, and
   * the server must refuse to issue one while that flag is set.
   */
  token?: string;
  /** How often to re-read while nothing is pushing. */
  pollMs?: number;
};

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** A message this app cannot deliver, said plainly rather than swallowed. */
export class NotOverRestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotOverRestError";
  }
}

type ServerChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
};

type ServerAgent = { id: string; name: string };

type ServerAuditEvent = {
  id: string;
  eventType: string;
  createdAt: string;
  actorUserId: string | null;
  payload: Record<string, unknown> | null;
};

type ServerApproval = {
  id: string;
  botId: string;
  botName: string;
  channelId: string | null;
  toolName: string;
  intent: string | null;
  subject: ApprovalSubject;
  rule: string;
  reason: string;
  state: Approval["state"];
  askedAt: string;
  answeredAt: string | null;
  scopedRule: string | null;
};

/** An AG-UI message, as the runtime's thread history returns it. */
type ServerMessage = {
  id: string;
  role: string;
  content?: string | null;
  toolCallId?: string;
  toolCalls?: { id: string; function: { name: string; arguments: string } }[];
};

/**
 * Turn a tool call and its result into the one line a transcript shows.
 *
 * The outcome keys are the ones the gateway produces, so a refusal keeps its rule and a failure stays
 * distinguishable from a refusal. Arguments are never rendered: the label and the resolved element
 * are enough, and a transcript is not a place for whatever was typed into a password field.
 */
function toolLineOf(name: string, result: string | undefined): ToolLine {
  const label = name.replace(/^computer_/, "").replace(/_/g, " ");
  let outcome: ToolLine["outcome"] = "running";
  let detail: string | undefined;
  let rule: string | undefined;

  if (result !== undefined) {
    try {
      const parsed = JSON.parse(result) as {
        ok?: boolean;
        refused?: boolean;
        reason?: string;
        rule?: string;
        element?: { name?: string };
      };
      if (parsed.refused) {
        outcome = "refused";
        rule = typeof parsed.rule === "string" ? parsed.rule : undefined;
        detail = parsed.element?.name ?? parsed.reason;
      } else if (parsed.ok === false) {
        outcome = "failed";
        detail = parsed.reason;
      } else {
        outcome = "allowed";
        detail = parsed.element?.name;
      }
    } catch {
      // Not JSON: the runtime stringifies a thrown handler. Treat it as a plain failure rather than
      // guessing, and show what it said.
      outcome = result.startsWith("Error:") ? "failed" : "allowed";
      detail = result.startsWith("Error:")
        ? result.slice("Error:".length).trim()
        : undefined;
    }
  }

  return {
    label,
    outcome,
    ...(detail ? { detail } : {}),
    ...(rule ? { rule } : {}),
  };
}

/** Which audit rows a person reads as an outcome, and what to call it. */
function auditOutcomeOf(eventType: string): AuditOutcome | undefined {
  if (eventType === "computer.action_allowed") return "allowed";
  if (eventType === "computer.action_refused") return "refused";
  if (eventType === "computer.action_failed") return "failed";
  if (eventType === "computer.action_asked") return "asked";
  if (eventType === "computer.action_answered") return "answered";
  return undefined;
}

export function createHttpSource(config: HttpSourceConfig = {}): DataSource {
  const base = config.baseUrl ?? "";
  const listeners = new Set<() => void>();
  const announce = () => {
    for (const listener of listeners) listener();
  };

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        ...(init?.headers ?? {}),
      },
      // Same-origin behind the dev proxy, where the session cookie is how the browser is known.
      credentials: "include",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new ApiError(
        response.status,
        body?.error ?? `That did not work (${response.status}).`,
      );
    }
    return (await response.json()) as T;
  }

  /** Bot names, for putting a name rather than an id in front of a person. */
  let names: Map<string, string> | undefined;
  async function botNames(): Promise<Map<string, string>> {
    if (names) return names;
    const { agents } = await call<{ agents: ServerAgent[] }>("/api/agents");
    names = new Map(agents.map((agent) => [agent.id, agent.name]));
    return names;
  }

  async function approvals(): Promise<Approval[]> {
    const rows = await call<ServerApproval[]>("/api/approvals");
    return rows.map((row) => ({
      id: row.id,
      botId: row.botId,
      botName: row.botName,
      channelId: row.channelId ?? "",
      toolName: row.toolName,
      intent: row.intent ?? "act on",
      subject: row.subject,
      rule: row.rule,
      reason: row.reason,
      askedAt: row.askedAt,
      state: row.state,
      ...(row.answeredAt ? { answeredBy: "a person" } : {}),
      ...(row.scopedRule ? { scopedRule: row.scopedRule } : {}),
    }));
  }

  const source: DataSource = {
    async channels() {
      const [rows, waiting, named] = await Promise.all([
        call<ServerChannel[]>("/api/channels"),
        approvals(),
        botNames(),
      ]);
      return rows.map((row) => {
        const botId = row.agentIds[0] ?? "";
        const pending = waiting.filter(
          (one) => one.state === "pending" && one.channelId === row.threadId,
        ).length;
        return {
          id: row.threadId,
          name: row.name,
          botId,
          botName: named.get(botId) ?? botId,
          lastMessage: row.lastMessage,
          lastMessageAt: row.lastMessageAt,
          /**
           * Derived, not asked for.
           *
           * The server does not track whether a turn is in flight — a run belongs to whichever client
           * started it. A Bot parked on an approval is the one "busy" state this app can know about
           * truthfully, so that is the only one it claims.
           */
          busy: pending > 0,
          pendingApprovals: pending,
        } satisfies Channel;
      });
    },

    async channel(id) {
      return (await source.channels()).find((one) => one.id === id);
    },

    async messages(channelId) {
      const rows = await call<{ messages: ServerMessage[] }>(
        `/api/copilotkit/threads/${encodeURIComponent(channelId)}/messages`,
      ).then((body) => body.messages ?? []);

      // Tool results arrive as their own messages, keyed by call id. Collected first so each call can
      // be rendered with its outcome rather than as a permanently running line.
      const results = new Map<string, string>();
      for (const row of rows) {
        if (row.role === "tool" && row.toolCallId) {
          results.set(row.toolCallId, String(row.content ?? ""));
        }
      }

      const messages: Message[] = [];
      for (const row of rows) {
        if (row.role === "tool" || row.role === "system") continue;
        const toolLines = (row.toolCalls ?? []).map((call_) =>
          toolLineOf(call_.function.name, results.get(call_.id)),
        );
        const text = typeof row.content === "string" ? row.content : "";
        if (!text && toolLines.length === 0) continue;
        messages.push({
          id: row.id,
          role: row.role === "user" ? "user" : "assistant",
          ...(text ? { text } : {}),
          ...(toolLines.length ? { toolLines } : {}),
          at: new Date().toISOString(),
        });
      }
      return messages;
    },

    async send() {
      /**
       * Starting a turn is an AG-UI run, not a REST call.
       *
       * Said out loud rather than accepted and dropped. The honest version of this needs the
       * CopilotKit client in the app, which is its own piece of work; until then a person is told
       * their message did not go, which is far better than believing it did.
       */
      throw new NotOverRestError(
        "Sending needs the CopilotKit runtime, which this build does not carry yet. Approvals, activity and reading a thread all work against the live deployment.",
      );
    },

    approvals,

    async approval(id) {
      return (await approvals()).find((one) => one.id === id);
    },

    async answer(id, decision, scope: AnswerScope) {
      await call(`/api/approvals/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ decision, scope }),
      });
      announce();
      const answered = await source.approval(id);
      if (!answered) throw new ApiError(404, "That approval is gone.");
      return answered;
    },

    async audit() {
      const [{ events }, named] = await Promise.all([
        call<{ events: ServerAuditEvent[] }>("/api/audit?limit=60"),
        botNames(),
      ]);
      const rows: AuditRow[] = [];
      for (const event of events) {
        let outcome = auditOutcomeOf(event.eventType);
        if (!outcome) continue;
        const payload = event.payload ?? {};
        /**
         * "You answered" is not an outcome on its own.
         *
         * The row says a person answered; what they said is in the payload. Rendering a refusal in the
         * same colour as an approval would make the one row somebody scrolling the trail most needs to
         * spot look exactly like the rows either side of it.
         */
        if (outcome === "answered" && payload.answer === "denied") {
          outcome = "refused";
        }
        const botId = typeof payload.bot === "string" ? payload.bot : "";
        const subject =
          typeof payload.subject === "string"
            ? payload.subject
            : typeof payload.element === "object" &&
                payload.element &&
                "name" in payload.element
              ? String((payload.element as { name?: unknown }).name ?? "")
              : typeof payload.file === "string"
                ? payload.file
                : typeof payload.page === "string"
                  ? payload.page
                  : ((payload.action as string) ?? event.eventType);
        rows.push({
          id: event.id,
          at: event.createdAt,
          eventType: event.eventType,
          botId,
          botName: named.get(botId) ?? botId,
          summary: subject,
          outcome,
          ...(typeof payload.rule === "string" ? { rule: payload.rule } : {}),
          ...(typeof payload.actor === "string"
            ? { actor: payload.actor }
            : {}),
        });
      }
      return rows;
    },

    /**
     * Derived from the approval queue rather than fetched.
     *
     * What is waiting on a person IS the approval queue; a separate feed would be a second source of
     * truth for one fact, and the two would eventually disagree. Real push delivery is Phase 2 and is
     * not built: nothing here arrives while the app is closed.
     */
    async notifications() {
      const waiting = await approvals();
      return waiting
        .filter((one) => one.state !== "pending")
        .slice(0, 20)
        .map<Notification>((one) => ({
          id: `note_${one.id}`,
          // What happened, not merely that something did: a refusal must not be drawn like an
          // approval in a list somebody is scanning.
          kind:
            one.state === "denied"
              ? "refused"
              : one.state === "expired"
                ? "routine-failed"
                : "done",
          botName: one.botName,
          body:
            one.state === "allowed"
              ? `was allowed to ${one.intent} “${one.subject.label}”`
              : one.state === "denied"
                ? `was refused “${one.subject.label}”`
                : `never got an answer about “${one.subject.label}”`,
          at: one.answeredAt ?? one.askedAt,
          read: true,
          approvalId: one.id,
          ...(one.channelId ? { channelId: one.channelId } : {}),
        }));
    },

    async markRead() {
      // Nothing to mark: the queue is the state. Left as a no-op rather than a route that pretends.
    },

    subscribe(listener) {
      listeners.add(listener);
      const timer = setInterval(announce, config.pollMs ?? 4_000);
      return () => {
        listeners.delete(listener);
        clearInterval(timer);
      };
    },
  };

  return source;
}
