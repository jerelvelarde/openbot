import { describe, expect, test } from "bun:test";
import { createIntelligenceConversationClient } from "../src/external/intelligence-conversations";

type FetchCall = { url: string; body: unknown; auth: string | undefined };

function clientWith(
  responder: (call: FetchCall) => { status: number; json: unknown } | "throw",
  settings: { apiKey?: string | undefined } = {},
) {
  const calls: FetchCall[] = [];
  const client = createIntelligenceConversationClient({
    apiUrl: "http://intelligence.test/",
    apiKey: "apiKey" in settings ? settings.apiKey : "cpk-1_short_long",
    surface: "openbot",
    fetchFn: (async (url: string, init: RequestInit) => {
      const call = {
        url: String(url),
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get("authorization") ?? undefined,
      };
      calls.push(call);
      const outcome = responder(call);
      if (outcome === "throw") throw new Error("network down");
      return {
        status: outcome.status,
        json: async () => outcome.json,
      } as Response;
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

describe("minting a conversation reference", () => {
  test("returns the reference and calls the managed route with the runtime key", async () => {
    const { client, calls } = clientWith(() => ({
      status: 200,
      json: { reference: "cref_v1_abc", adapter: "slack" },
    }));

    const reference = await client.mintReference({
      threadId: "thread-1",
      appUserId: "user-1",
    });

    expect(reference).toBe("cref_v1_abc");
    // The trailing slash on apiUrl must not produce a double slash, or the
    // route 404s and the thread silently stays read-only.
    expect(calls[0]?.url).toBe(
      "http://intelligence.test/api/channels/conversations/reference",
    );
    expect(calls[0]?.auth).toBe("Bearer cpk-1_short_long");
  });

  test("a refusal is null, not an error, so the surface degrades to read-only", async () => {
    const { client } = clientWith(() => ({ status: 404, json: {} }));
    expect(
      await client.mintReference({ threadId: "t", appUserId: "u" }),
    ).toBeNull();
  });

  test("an outage is null too, rather than breaking the page", async () => {
    const { client } = clientWith(() => "throw");
    expect(
      await client.mintReference({ threadId: "t", appUserId: "u" }),
    ).toBeNull();
  });

  test("no runtime key means no capability and no request at all", async () => {
    const { client, calls } = clientWith(() => ({ status: 200, json: {} }), {
      apiKey: undefined,
    });
    expect(
      await client.mintReference({ threadId: "t", appUserId: "u" }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("submitting an authored turn", () => {
  const turn = {
    reference: "cref_v1_abc",
    appUserId: "user-1",
    displayName: "Jerel John Velarde",
    idempotencyKey: "key-000001",
    text: "Answer in the thread, please.",
  };

  test("202 is accepted, and the surface travels with the turn", async () => {
    const { client, calls } = clientWith(() => ({
      status: 202,
      json: { outcome: "accepted", deliveryId: "dlv_1", wake: "published" },
    }));

    const result = await client.submitTurn(turn);

    expect(result).toEqual({
      kind: "accepted",
      deliveryId: "dlv_1",
      duplicate: false,
      wake: "published",
    });
    expect((calls[0]?.body as { surface?: string }).surface).toBe("openbot");
  });

  test("a duplicate is still accepted, and says so", async () => {
    const { client } = clientWith(() => ({
      status: 202,
      json: { outcome: "duplicate", deliveryId: "dlv_1", wake: "deferred" },
    }));
    const result = await client.submitTurn(turn);
    expect(result).toMatchObject({ kind: "accepted", duplicate: true });
  });

  test("4xx is a decision and 5xx is an outage, and they are not the same", async () => {
    // The distinction is load-bearing: only the first is safe to record as a
    // permanent failure against a claimed turn. Treating a 503 as a refusal
    // would drop the thread to read-only over a transient blip.
    const refused = await clientWith(() => ({
      status: 404,
      json: {},
    })).client.submitTurn(turn);
    expect(refused.kind).toBe("rejected");

    const outage = await clientWith(() => ({
      status: 503,
      json: {},
    })).client.submitTurn(turn);
    expect(outage.kind).toBe("unavailable");

    const dead = await clientWith(() => "throw").client.submitTurn(turn);
    expect(dead.kind).toBe("unavailable");
  });

  test("no runtime key reports unavailable rather than pretending to deliver", async () => {
    const { client, calls } = clientWith(() => ({ status: 202, json: {} }), {
      apiKey: undefined,
    });
    expect((await client.submitTurn(turn)).kind).toBe("unavailable");
    expect(calls).toHaveLength(0);
  });
});
