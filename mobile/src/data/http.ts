/**
 * The same data, from a real deployment.
 *
 * Written against the endpoints the plan's Phase 1 and Phase 2 add — `GET/POST /api/approvals`,
 * notifications — plus the channel routes that already exist in `server/src/channels/routes.ts`. It
 * is not reachable yet, and that is the point of the seam: the screens are finished against
 * `DataSource`, and this becomes the live implementation the day those routes land.
 *
 * Two things this deliberately does NOT do:
 *  - it does not fall back to local data when a request fails. A companion that quietly shows a made
 *    up approval queue when it cannot reach the server is worse than one that says it is offline.
 *  - it does not send a session cookie. A native client authenticates with a bearer token, and the
 *    server must refuse to issue one while OPENBOT_DEV_NO_AUTH is set: that flag admits every caller
 *    as one administrator, which is defensible on loopback and is a hole from a phone.
 */
import type {
  Approval,
  AuditRow,
  Channel,
  Message,
  Notification,
} from "./types";
import type { AnswerScope, DataSource } from "./source";

export type HttpSourceConfig = {
  /** Where the API server is. Only `server` is ever reachable; the computers stay on loopback. */
  baseUrl: string;
  /** The device token, from the sign-in exchange. Never a cookie. */
  token: string;
  /** Poll interval for the approval queue until push delivery is wired up. */
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

export function createHttpSource(config: HttpSourceConfig): DataSource {
  const listeners = new Set<() => void>();
  const announce = () => {
    for (const listener of listeners) listener();
  };

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new ApiError(
        response.status,
        body?.error ?? "That did not work. Try again in a moment.",
      );
    }
    return (await response.json()) as T;
  }

  let poll: ReturnType<typeof setInterval> | undefined;

  return {
    channels: () => call<Channel[]>("/api/channels"),
    channel: (id) => call<Channel | undefined>(`/api/channels/${id}`),
    messages: (channelId) =>
      call<Message[]>(`/api/channels/${channelId}/messages`),

    async send(channelId, text) {
      return call<{ queued: boolean }>(`/api/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    },

    approvals: () => call<Approval[]>("/api/approvals"),
    approval: (id) => call<Approval>(`/api/approvals/${id}`),

    async answer(id, decision, scope: AnswerScope) {
      const answered = await call<Approval>(`/api/approvals/${id}`, {
        method: "POST",
        body: JSON.stringify({ decision, scope }),
      });
      announce();
      return answered;
    },

    audit: (channelId) =>
      call<AuditRow[]>(
        channelId
          ? `/api/audit?threadId=${encodeURIComponent(channelId)}`
          : "/api/audit",
      ),

    notifications: () => call<Notification[]>("/api/notifications"),

    async markRead(id) {
      await call(`/api/notifications/${id}/read`, { method: "POST" });
      announce();
    },

    subscribe(listener) {
      listeners.add(listener);
      // Polled rather than pushed, until Phase 2 gives the server something to push with. The
      // interval is generous because the phone is not the surface somebody watches.
      poll ??= setInterval(announce, config.pollMs ?? 15_000);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && poll) {
          clearInterval(poll);
          poll = undefined;
        }
      };
    },
  };
}
