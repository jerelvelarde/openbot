/**
 * The managed Channels capability behind a web-authored turn.
 *
 * Two calls, both server-to-server with the project runtime key. OpenBot owns
 * its own user identities, so it asserts who is speaking; Intelligence binds
 * that assertion into the reference it issues, and refuses the reference for
 * anybody else. Nothing here ever sees a Slack credential, a channel id, or a
 * thread timestamp — the reply target stays sealed inside the reference.
 */

/** How long either managed call may take before the surface gives up on it. */
const REQUEST_TIMEOUT_MS = 8_000;

export type IntelligenceConversationClient = {
  /**
   * Issues the capability that makes one thread writable for one person.
   *
   * Returns null rather than throwing for every refusal, because "this thread
   * cannot accept web turns" is the ordinary state, not an error: the surface
   * degrades to read-only, which is exactly what it does when the managed
   * support is absent entirely.
   */
  mintReference(input: {
    threadId: string;
    appUserId: string;
  }): Promise<string | null>;
  /** Submits one authored turn against a previously issued reference. */
  submitTurn(input: {
    reference: string;
    appUserId: string;
    displayName: string;
    idempotencyKey: string;
    text: string;
  }): Promise<IntelligenceTurnOutcome>;
};

export type IntelligenceTurnOutcome =
  /** Durably accepted; the Slack post and agent run follow on the managed path. */
  | { kind: "accepted"; deliveryId: string; duplicate: boolean; wake: string }
  /**
   * Refused for good: the reference is not valid for this person, this
   * conversation, or this moment. Retrying the same turn cannot help.
   */
  | { kind: "rejected"; reason: string }
  /**
   * Could not be established. The turn may or may not have been accepted, so
   * the caller must not resubmit under a fresh key.
   */
  | { kind: "unavailable"; reason: string };

export type IntelligenceConversationSettings = {
  apiUrl: string;
  apiKey: string | undefined;
  /** Application surface recorded as the author's origin, e.g. `openbot`. */
  surface: string;
  fetchFn?: typeof fetch;
};

/**
 * A client that is always safe to call.
 *
 * With no runtime key configured every call reports "no capability" rather
 * than throwing, so a deployment without managed Channels renders a read-only
 * surface instead of an error page.
 */
export function createIntelligenceConversationClient(
  settings: IntelligenceConversationSettings,
): IntelligenceConversationClient {
  const fetchFn = settings.fetchFn ?? fetch;
  const base = settings.apiUrl.replace(/\/+$/, "");
  const apiKey = settings.apiKey;

  async function call(
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: unknown } | null> {
    if (!apiKey) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      return { status: response.status, json };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async mintReference({ threadId, appUserId }) {
      const result = await call("/api/channels/conversations/reference", {
        threadId,
        appUserId,
      });
      if (result?.status !== 200) return null;
      const reference = (result.json as { reference?: unknown } | null)
        ?.reference;
      return typeof reference === "string" && reference.length > 0
        ? reference
        : null;
    },

    async submitTurn(input) {
      const result = await call("/api/channels/conversations/turns", {
        reference: input.reference,
        appUserId: input.appUserId,
        displayName: input.displayName,
        surface: settings.surface,
        idempotencyKey: input.idempotencyKey,
        text: input.text,
      });
      if (!result) {
        return { kind: "unavailable", reason: "transport" };
      }
      if (result.status === 202) {
        const body = result.json as {
          deliveryId?: unknown;
          outcome?: unknown;
          wake?: unknown;
        } | null;
        return {
          kind: "accepted",
          deliveryId:
            typeof body?.deliveryId === "string" ? body.deliveryId : "",
          duplicate: body?.outcome === "duplicate",
          wake: typeof body?.wake === "string" ? body.wake : "unknown",
        };
      }
      // 4xx is a decision, 5xx is an outage. Only the first is safe to record
      // as a permanent failure against the claimed turn.
      if (result.status >= 400 && result.status < 500) {
        return { kind: "rejected", reason: `status_${result.status}` };
      }
      return { kind: "unavailable", reason: `status_${result.status}` };
    },
  };
}
