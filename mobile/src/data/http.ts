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

import { createTurnFold, streamRun, toolLineOf } from "./run";
import type { AnswerScope, DataSource, SendOptions } from "./source";
import type {
  Approval,
  ApprovalSubject,
  AuditOutcome,
  AuditRow,
  Bot,
  Channel,
  Message,
  Notification,
  Skill,
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
  /**
   * Called when the deployment says this session is no longer valid.
   *
   * Without it an expired token is terminal: every read throws 401, every screen shows "that did not
   * work (401)", and nothing ever decides to stop being signed in — so there is no route back to the
   * sign-in screen short of reinstalling the app.
   */
  onUnauthorized?: () => void;
};

/**
 * React Native's WebSocket, which takes an options bag the browser's does not.
 *
 * The types resolve to the DOM constructor — `lib` is `["DOM", "ESNext"]` — so the third argument
 * has to be asserted in one place rather than cast at the point of use. It matters because that bag
 * is the only way to send a bearer token on a handshake: the alternative is the token in the query
 * string, which is a credential in a URL, and URLs are logged.
 */
type WebSocketWithHeaders = new (
  url: string,
  protocols?: string[],
  options?: { headers: Record<string, string> },
) => WebSocket;

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

type ServerAgent = { id: string; name: string; title: string | null };

type ServerChannelCreated = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
};

type ServerSkill = {
  slug: string;
  title: string;
  summary: string | null;
  instructions: string;
};

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
  expiresAt: string | null;
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
 * What a tool did, as a verb.
 *
 * The trail's payload carries `action` — the tool name — and the thing acted on separately. Rendering
 * only the second makes "typed into the password field" and "clicked the password field" the same
 * row, which is the distinction the trail exists for.
 */
const VERBS: Record<string, string> = {
  computer_click: "Clicked",
  computer_type: "Typed into",
  computer_key: "Pressed a key on",
  computer_navigate: "Opened",
  computer_read: "Read",
  computer_snapshot: "Read the page",
  computer_read_file: "Read the file",
  computer_write_file: "Wrote to the file",
  computer_list_files: "Listed the files in",
  computer_request_secret: "Asked for a secret for",
};

function verbOf(action: unknown): string {
  if (typeof action !== "string" || !action) return "Acted on";
  const known = VERBS[action];
  if (known) return known;
  // An unmapped tool still names itself, which beats a bare noun. MCP tools land here.
  return `Called ${action.replace(/^computer_/, "").replace(/_/g, " ")} on`;
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
  let timer: ReturnType<typeof setInterval> | undefined;
  const announce = () => {
    for (const listener of listeners) listener();
  };

  /**
   * Live channel activity, pushed rather than polled.
   *
   * The deployment tells every member of a channel when something was said in it, and the web app has
   * consumed that since it existed. This app polled every four seconds instead, so anything said by
   * another person — or by the same person at a desk — took up to four seconds to appear.
   *
   * It is an optimisation and never a source of truth. The server's own comment says so, and this
   * follows it: an event does not carry state into the app, it only says "read again". So a dropped
   * socket costs nothing but latency, the poll stays as the floor, and a reconnect re-reads
   * everything rather than trying to work out what it missed.
   */
  let socket: WebSocket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let backoff = 500;

  function socketUrl(): string | undefined {
    const origin =
      base || (typeof window === "undefined" ? "" : window.location.origin);
    if (!origin) return undefined;
    return `${origin.replace(/^http/, "ws")}/api/channels/events`;
  }

  async function connect() {
    if (socket || listeners.size === 0) return;
    const url = socketUrl();
    if (!url) return;
    const token = await config.token?.();
    // Another subscriber may have connected, or the last one left, while the token was being read.
    if (socket || listeners.size === 0) return;

    try {
      socket = token
        ? new (WebSocket as unknown as WebSocketWithHeaders)(url, undefined, {
            headers: { authorization: `Bearer ${token}` },
          })
        : new WebSocket(url);
    } catch {
      // A URL the platform will not open. The poll is still running, so this is latency, not failure.
      return;
    }

    const dropped = () => {
      socket = undefined;
      // Nothing is listening any more, so there is nothing to keep a socket open for.
      if (listeners.size === 0) return;
      reconnect = setTimeout(() => {
        backoff = Math.min(backoff * 2, 30_000);
        void connect();
      }, backoff);
    };

    socket.onopen = () => {
      backoff = 500;
      // Whatever happened while there was no socket is recovered by reading, not by replay.
      announce();
    };
    // The payload says which channel changed and what was said. Nothing is taken from it: the roster
    // read is authoritative, and trusting a socket frame over it would be two sources of one truth.
    socket.onmessage = () => announce();
    socket.onclose = dropped;
    socket.onerror = () => {};
  }

  function disconnect() {
    if (reconnect !== undefined) {
      clearTimeout(reconnect);
      reconnect = undefined;
    }
    const open = socket;
    socket = undefined;
    open?.close();
  }

  /**
   * GETs in flight right now, so one announce is one request per path.
   *
   * Several screens read overlapping things — the channel screen alone wants channels, messages and
   * approvals, and `messages` asks for channels again to find the Bot — and every one of them fires
   * on the same announce. Sharing the promise collapses that fan-out.
   *
   * Deliberately in-flight only, with no time-based cache: `answer` announces and then immediately
   * re-reads, and a cached answer there would leave the screen saying an approval is still waiting
   * after somebody answered it.
   */
  const inFlight = new Map<string, Promise<unknown>>();

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    if (!init) {
      const shared = inFlight.get(path);
      if (shared) return shared as Promise<T>;
      const started = request<T>(path).finally(() => inFlight.delete(path));
      inFlight.set(path, started);
      return started;
    }
    return request<T>(path, init);
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await send_(path, init);
    return (await response.json()) as T;
  }

  /**
   * A request whose body nobody reads.
   *
   * Starting a run answers `text/event-stream`, so parsing it as JSON waits for the whole turn and
   * then rejects — which the composer showed as "that could not be sent" for a run that had in fact
   * started, and restored the draft over whatever had been typed since.
   */
  async function post(path: string, body: unknown): Promise<void> {
    await send_(path, { method: "POST", body: JSON.stringify(body) });
  }

  async function send_(path: string, init?: RequestInit): Promise<Response> {
    const token = await config.token?.();
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init?.headers ?? {}),
        },
        // Same-origin behind the dev proxy, where the session cookie is how the browser is known.
        credentials: "include",
      });
    } catch {
      /**
       * A request that never arrived.
       *
       * The platform's own words for this are "Failed to fetch" in a browser and "Network request
       * failed" on a device, and both of those end up on a card headed "Offline" in front of
       * somebody who wanted to know whether their Bot is blocked. Status 0 because there was no
       * response to have one.
       */
      throw new ApiError(0, "This deployment could not be reached.");
    }
    if (!response.ok) {
      // A dead session is not a failed read, and treating it as one strands the app on an error it
      // can never clear. Told once, before the message is thrown for whoever asked.
      if (response.status === 401) config.onUnauthorized?.();
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new ApiError(
        response.status,
        body?.error ?? `That did not work (${response.status}).`,
      );
    }
    return response;
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
    const agents = await roster();
    names = new Map(agents.map((agent) => [agent.id, agent.name]));
    return names;
  }

  async function roster(): Promise<ServerAgent[]> {
    // Without `?hidden=true`, which is the deployment's own scoping: a hidden Bot is not one to
    // start a conversation with, and that decision is not this app's to make.
    const { agents } = await call<{ agents: ServerAgent[] }>("/api/agents");
    return agents;
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
      // The server deliberately does not say WHO answered, so nothing here may imply it did. This
      // previously invented the string "a person" and rendered it as a fact.
      ...(row.answeredAt ? { answeredAt: row.answeredAt } : {}),
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
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

    async send(channelId, text, options: SendOptions = {}) {
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
      const fold = createTurnFold();
      const token = await config.token?.();

      await streamRun({
        url: `${base}/api/copilotkit/agent/${encodeURIComponent(channel.botId)}/run`,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
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
            /**
             * A skill goes in FRONT of the message, as a system turn.
             *
             * Not pasted into what the person typed. The two are not the same kind of thing: the
             * transcript shows what somebody said, and putting the skill's paragraph in their words
             * puts sentences in their mouth and makes the reply quote instructions back at them.
             * The web app does exactly this, and the thread reader skips system turns, so it never
             * appears on screen on either surface.
             */
            ...(options.skills ?? []).map((skill, index) => ({
              id: `sys_${runId}_${index}`,
              role: "system" as const,
              content: skill.instructions,
            })),
            { id: `msg_${runId}`, role: "user", content: text },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
        ...(options.signal ? { signal: options.signal } : {}),
        onData: (data) => {
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            // A frame this app cannot parse is not a reason to fail a run that is going fine.
            return;
          }
          options.onTurn?.(fold(event));
        },
      });

      /**
       * Tell the channel something was said.
       *
       * This is what keeps the roster's preview current and what wakes the other members' sockets —
       * the server's own comment is explicit that the person who ran it reports over HTTP and the
       * socket is the other direction. Without it a message sent from a phone left the channel list
       * showing whatever was said before it, on every surface.
       *
       * After the turn, and never allowed to fail the send: the message went, and saying it did not
       * because a preview could not be updated would be the worst kind of lie a composer can tell.
       */
      try {
        await post(`/api/channels/${encodeURIComponent(channelId)}/activity`, {
          text,
          agentId: null,
          at: new Date().toISOString(),
        });
      } catch {
        // Nothing to do about it here, and nothing worth interrupting anybody over.
      }

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

    async bots() {
      const agents = await roster();
      return agents.map<Bot>((agent) => ({
        id: agent.id,
        name: agent.name,
        title: agent.title ?? null,
      }));
    },

    async createChannel(botId) {
      const { channel } = await call<{ channel: ServerChannelCreated }>(
        "/api/channels",
        { method: "POST", body: JSON.stringify({ agentIds: [botId] }) },
      );
      // The roster gained a channel, so anything showing the roster is now out of date.
      names = undefined;
      announce();
      const named = await botNames();
      return {
        // The THREAD is the channel everywhere in this app: it is what the transcript is read by and
        // what an approval names. Using the channel row's own id here would give the new channel an
        // id nothing else can look anything up with.
        id: channel.threadId,
        name: channel.name,
        botId,
        botName: named.get(botId) ?? botId,
        lastMessage: null,
        lastMessageAt: null,
        busy: false,
        pendingApprovals: 0,
      };
    },

    async skills(channelId) {
      const channel = await source.channel(channelId);
      if (!channel?.botId) return [];
      const { skills } = await call<{ skills: ServerSkill[] }>(
        `/api/plugins/for/${encodeURIComponent(channel.botId)}`,
      );
      return skills.map<Skill>((skill) => ({
        slug: skill.slug,
        title: skill.title,
        summary: skill.summary,
        instructions: skill.instructions,
      }));
    },

    approvals,

    async approval(id) {
      return (await approvals()).find((one) => one.id === id);
    },

    async answer(id, decision, scope: AnswerScope) {
      await post(`/api/approvals/${encodeURIComponent(id)}`, {
        decision,
        scope,
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
         * "Answered" is not an outcome on its own.
         *
         * The row says an answer was given; what it was is in the payload — and one of the possible
         * answers is that nobody gave one. A timeout recorded as "answered" tells a reader a person
         * decided this, when the truth is the window closed and the server answered for them.
         */
        if (outcome === "answered") {
          if (payload.answer === "denied") outcome = "refused";
          else if (
            payload.answer === "expired" ||
            payload.answer === "cancelled"
          ) {
            outcome = "expired";
          }
        }

        /**
         * The decision, where the server puts it.
         *
         * `writeAsk` (the asked/answered rows) carries `rule` at the top level; `writeAction` (every
         * allowed, refused and failed row) carries it under `decision`. Reading only the first meant
         * no refusal in this list ever showed the rule that caused it — on the screen whose subtitle
         * promises exactly that.
         */
        const decision = (
          typeof payload.decision === "object" && payload.decision
            ? payload.decision
            : {}
        ) as { rule?: unknown; mode?: unknown; carriedOut?: unknown };
        const rule =
          typeof payload.rule === "string"
            ? payload.rule
            : typeof decision.rule === "string"
              ? decision.rule
              : undefined;

        const botId = typeof payload.bot === "string" ? payload.bot : "";
        const element =
          typeof payload.element === "object" &&
          payload.element &&
          "name" in payload.element
            ? String((payload.element as { name?: unknown }).name ?? "")
            : "";
        // `subject` is the asked/answered rows' own phrasing and already reads as a sentence
        // fragment; the acting rows are assembled from a verb and what it acted on.
        const summary =
          typeof payload.subject === "string"
            ? payload.subject
            : `${verbOf(payload.action)} ${
                element ||
                (typeof payload.file === "string" ? payload.file : "") ||
                (typeof payload.page === "string" ? payload.page : "") ||
                "something it could not name"
              }`;

        rows.push({
          id: event.id,
          at: event.createdAt,
          eventType: event.eventType,
          botId,
          botName: named.get(botId) ?? botId,
          summary,
          outcome,
          ...(rule ? { rule } : {}),
          ...(typeof payload.actor === "string"
            ? { actor: payload.actor }
            : {}),
          ...(decision.mode === "dry-run" || decision.mode === "enforce"
            ? { mode: decision.mode }
            : {}),
          ...(typeof decision.carriedOut === "boolean"
            ? { carriedOut: decision.carriedOut }
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
                ? // Not "routine-failed": that colour means permitted, attempted, did not work.
                  // Nothing was permitted here and nothing was attempted.
                  "expired"
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
      connect();
      /**
       * One timer, not one per subscriber.
       *
       * Every `useLive` call used to start its own interval, and each tick announced to ALL of them:
       * the channel screen's four hooks meant sixteen reads every four seconds, each several composed
       * requests, which queues the response that matters behind seven that do not.
       */
      if (listeners.size === 1) {
        timer = setInterval(announce, config.pollMs ?? 4_000);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
        disconnect();
      };
    },

    refresh: announce,
  };

  return source;
}
