/**
 * The same data, from a real deployment.
 *
 * Written against the endpoints that exist: `/api/approvals` (the `ask` outcome), `/api/channels`,
 * `/api/agents`, `/api/audit`, and the runtime's own thread history under `/api/copilotkit`. Nothing
 * here invents a route.
 *
 * Two things this deliberately does NOT do:
 *  - it does not fall back to local data when a request fails. A companion that quietly shows a made
 *    up approval queue when it cannot reach the server is worse than one that says it is offline.
 *  - it does not invent a notification feed. What is waiting on a person IS the approval queue, and a
 *    second list derived from it would be a second source of truth for the same fact.
 */

import type { AnswerScope, DataSource } from "./source";
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

export type HttpSourceConfig = {
  /**
   * Where the API is. Empty means same-origin, which is what the web build behind the dev proxy uses.
   *
   * A native client passes an absolute URL and a token. Only the API server is ever reachable; the
   * Bot computers stay on loopback.
   */
  baseUrl?: string;
  /**
   * The session token, read at call time.
   *
   * A function rather than a value, because this source is built once for the life of the app and a
   * captured token would be the one that existed before somebody signed in. It also keeps the token
   * out of any object a screen can reach.
   *
   * Absent is only correct same-origin, where the browser's own cookie is how it is known, or against
   * a deployment running `OPENBOT_DEV_NO_AUTH` on loopback. Anything reachable from a phone needs a
   * real one, and the server refuses to register a device while that flag is set.
   */
  token?: () => Promise<string | undefined>;
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

/**
 * A run id, and a message id.
 *
 * `crypto.randomUUID` is not on every React Native runtime, so this does not depend on it. The value
 * only has to be unique within a thread, and the platform's own ids are what identify anything that
 * matters.
 */
function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  createdAt?: string;
};

/**
 * Turn a tool call and its result into the one line a transcript shows.
 *
 * The outcome keys are the ones the gateway produces, so a refusal keeps its rule and a failure stays
 * distinguishable from a refusal. Arguments are never rendered: the label and the resolved element
 * are enough, and a transcript is not a place for whatever was typed into a password field.
 */
function toolLineOf(result: string): ToolLine | undefined {
  let parsed: {
    tool?: string;
    action?: string;
    ok?: boolean;
    refused?: boolean;
    reason?: string;
    rule?: string;
    element?: { name?: string };
    text?: string;
  };
  try {
    parsed = JSON.parse(result) as typeof parsed;
  } catch {
    // Not JSON: the runtime stringifies a thrown handler this way. Shown as a failure rather than
    // guessed at, because the alternative is a line that claims something worked.
    return {
      label: "tool",
      outcome: "failed",
      detail: result.slice(0, 120),
    };
  }

  const name = parsed.tool ?? parsed.action;
  // Without a name there is nothing to say. Drawing an anonymous outcome would be a line a person
  // cannot audit, which is worse than no line.
  if (!name) return undefined;

  const label = name.replace(/^computer_/, "").replace(/_/g, " ");

  if (parsed.refused) {
    return {
      label,
      outcome: "refused",
      ...(parsed.element?.name || parsed.reason
        ? { detail: parsed.element?.name ?? parsed.reason }
        : {}),
      ...(typeof parsed.rule === "string" ? { rule: parsed.rule } : {}),
    };
  }
  if (parsed.ok === false) {
    return {
      label,
      outcome: "failed",
      ...(parsed.reason ? { detail: parsed.reason } : {}),
    };
  }
  return {
    label,
    outcome: "allowed",
    // The element as the SERVER resolved it, never the ref the model sent.
    ...(parsed.element?.name ? { detail: parsed.element.name } : {}),
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
    const token = await config.token?.();
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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

  /**
   * Whether the runtime has ever seen this thread.
   *
   * Asked because a thread the runtime does not know about cannot be read: `…/messages` answers 500,
   * not an empty list. That is indistinguishable from a real failure unless something checks, and the
   * difference matters — an unread history sent as empty would silently drop a conversation's context
   * on the next message.
   */
  async function threadExists(threadId: string, botId: string) {
    const { threads } = await call<{ threads: { id: string }[] }>(
      `/api/copilotkit/api/threads?agentId=${encodeURIComponent(botId)}`,
    );
    return threads.some((thread) => thread.id === threadId);
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
      const [{ channels }, waiting, named] = await Promise.all([
        call<{ channels: ServerChannel[] }>("/api/channels"),
        approvals(),
        botNames(),
      ]);
      return channels.map((row) => {
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
      /**
       * The thread, from the runtime.
       *
       * The agent is a required query parameter: a thread belongs to one Bot, and the runtime will not
       * hand over somebody's conversation without being told whose it is.
       */
      const channel = await source.channel(channelId);
      const botId = channel?.botId ?? "";

      // A channel nobody has spoken in yet has no thread to read. Empty, rather than an error a
      // person would read as "this is broken".
      if (!(await threadExists(channelId, botId))) return [];

      const rows = await call<{ messages: ServerMessage[] }>(
        `/api/copilotkit/api/threads/${encodeURIComponent(channelId)}/messages` +
          `?agentId=${encodeURIComponent(botId)}`,
      ).then((body) => body.messages ?? []);

      const messages: Message[] = [];
      for (const row of rows) {
        /**
         * A tool result is its own line.
         *
         * Not attached to the assistant message that made the call, because that message is not in the
         * thread: Intelligence keeps the results and not the calls. So the name comes from the result
         * itself, which is why the server stamps it there — see `tools/spec.ts`.
         */
        if (row.role === "tool") {
          const line = toolLineOf(String(row.content ?? ""));
          if (line) {
            messages.push({
              id: row.id,
              role: "assistant",
              toolLines: [line],
              at: row.createdAt ?? "",
            });
          }
          continue;
        }
        if (row.role === "system" || row.role === "developer") continue;

        const text = typeof row.content === "string" ? row.content : "";
        if (!text) continue;
        messages.push({
          id: row.id,
          role: row.role === "user" ? "user" : "assistant",
          text,
          at: row.createdAt ?? "",
        });
      }
      return messages;
    },

    async send(channelId, text) {
      const channel = await source.channel(channelId);
      if (!channel?.botId) {
        throw new ApiError(404, "That channel has no Bot to talk to.");
      }

      /**
       * Starting a turn is an AG-UI run, and a run carries the conversation.
       *
       * The runtime does not merge the stored thread into what a caller sends — proven by asking a
       * follow-up question with only the new message and watching the Bot go looking for the answer in
       * its own workspace. So the history goes back up with it, which is what every AG-UI client does.
       */
      const history = await source.messages(channelId);

      const runId = randomId();
      await call(
        `/api/copilotkit/agent/${encodeURIComponent(channel.botId)}/run`,
        {
          method: "POST",
          body: JSON.stringify({
            threadId: channelId,
            runId,
            messages: [
              ...history
                /**
                 * Text only, on purpose.
                 *
                 * The thread keeps tool RESULTS without the assistant message that made the calls, so
                 * sending them back would hand a provider a tool result answering a call it has never
                 * seen — which every provider rejects, and which would break every follow-up message.
                 * What those tools found is already in the Bot's own answer.
                 */
                .filter((message) => Boolean(message.text))
                .map((message) => ({
                  id: message.id,
                  role: message.role,
                  content: message.text,
                })),
              { id: `msg_${runId}`, role: "user", content: text },
            ],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          }),
        },
      );

      announce();
      /**
       * Never "queued".
       *
       * The local source models a Bot mid-turn holding a message until it settles. Against a real
       * deployment this app cannot know that a turn is in flight — a run belongs to whichever client
       * started it — so claiming a message was queued would be inventing a state.
       */
      return { queued: false };
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
          botId: one.botId,
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
