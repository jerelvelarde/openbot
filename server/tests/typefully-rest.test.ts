import { describe, expect, test } from "bun:test";
import { catalogueEntry } from "../src/plugins/catalogue";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";
import { transportFor } from "../src/plugins/transport";
import {
  callTool,
  createTypefullyRestTransport,
  listTools,
} from "../src/plugins/typefully-rest";

const connection = {
  url: "https://api.typefully.com/v2",
  token: "tf-secret-key",
};

type FetchCall = {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string | null;
  signal: AbortSignal | null;
};

function recordingFetch(input?: {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}) {
  const calls: FetchCall[] = [];
  const fetch = (async (
    requestInput: string | URL | Request,
    init?: RequestInit,
  ) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(requestInput),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body: typeof init?.body === "string" ? init.body : null,
      signal: init?.signal ?? null,
    });
    return new Response(
      input?.text ?? JSON.stringify(input?.body ?? { ok: true }),
      {
        status: input?.status ?? 200,
        headers: {
          "content-type": "application/json",
          ...input?.headers,
        },
      },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const platforms = {
  x: {
    enabled: true,
    posts: [{ text: "Hello X", mediaIds: ["media-1"] }],
  },
  linkedin: {
    enabled: true,
    posts: [{ text: "Hello LinkedIn" }],
  },
};

const plannedAt = "2099-08-27T12:00:00Z";

describe("the reviewed Typefully tool surface", () => {
  test("pins the exact safe manifest and advertises no publish operation", async () => {
    const tools = await listTools({ url: connection.url });
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_social_sets",
      "list_drafts",
      "get_draft",
      "create_draft",
      "update_draft",
      "upload_media",
      "remove_media",
      "schedule_draft",
      "delete_draft",
    ]);
    expect(tools.some((tool) => /publish/i.test(tool.name))).toBe(false);
  });

  test("closes every model-controlled object schema", async () => {
    const tools = await listTools({ url: connection.url });

    const visit = (schema: unknown) => {
      if (!schema || typeof schema !== "object") return;
      const record = schema as Record<string, unknown>;
      if (record.type === "object") {
        expect(record.additionalProperties).toBe(false);
      }
      for (const value of Object.values(record)) visit(value);
    };

    for (const tool of tools) visit(tool.inputSchema);
  });

  test("pins the live v2 post, media, and create-share bounds in the schema", async () => {
    const tools = await listTools({ url: connection.url });
    const create = tools.find((tool) => tool.name === "create_draft");
    const schema = create?.inputSchema as {
      properties?: {
        share?: { type?: unknown };
        platforms?: {
          properties?: {
            x?: {
              properties?: {
                posts?: {
                  maxItems?: unknown;
                  items?: {
                    properties?: {
                      text?: { maxLength?: unknown };
                      mediaIds?: { maxItems?: unknown };
                    };
                  };
                };
              };
            };
          };
        };
      };
    };

    const post = schema.properties?.platforms?.properties?.x?.properties?.posts;
    expect(post?.items?.properties?.text?.maxLength).toBe(50_000);
    expect(post?.items?.properties?.mediaIds?.maxItems).toBe(10);
    expect(schema.properties?.share?.type).toBe("boolean");
  });

  test("is registered for the frozen Typefully catalogue entry", () => {
    const entry = catalogueEntry("typefully");
    expect(entry?.transport).toBe("typefully-rest");
    expect(transportFor(entry).callTool).toBe(callTool);
  });
});

describe("v2 request mapping", () => {
  test("maps every tool to its exact method, path, query, and reviewed body", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    const cases: {
      name: string;
      args: Record<string, unknown>;
      method: string;
      path: string;
      query?: Record<string, string>;
      body?: unknown;
    }[] = [
      {
        name: "list_social_sets",
        args: { limit: 25, offset: 5 },
        method: "GET",
        path: "/v2/social-sets",
        query: { limit: "25", offset: "5" },
      },
      {
        name: "list_drafts",
        args: { socialSetId: 12, limit: 10, offset: 2 },
        method: "GET",
        path: "/v2/social-sets/12/drafts",
        query: { limit: "10", offset: "2" },
      },
      {
        name: "get_draft",
        args: { socialSetId: 12, draftId: 34 },
        method: "GET",
        path: "/v2/social-sets/12/drafts/34",
      },
      {
        name: "create_draft",
        args: {
          socialSetId: 12,
          platforms,
          draftTitle: "Launch",
          share: true,
          planAt: plannedAt,
        },
        method: "POST",
        path: "/v2/social-sets/12/drafts",
        body: {
          platforms: {
            x: {
              enabled: true,
              posts: [{ text: "Hello X", media_ids: ["media-1"] }],
            },
            linkedin: {
              enabled: true,
              posts: [{ text: "Hello LinkedIn" }],
            },
          },
          draft_title: "Launch",
          share: true,
          plan_at: plannedAt,
        },
      },
      {
        name: "update_draft",
        args: {
          socialSetId: 12,
          draftId: 34,
          draftTitle: "Renamed",
          planAt: "next-free-slot",
        },
        method: "PATCH",
        path: "/v2/social-sets/12/drafts/34",
        body: { draft_title: "Renamed", plan_at: "next-free-slot" },
      },
      {
        name: "upload_media",
        args: { socialSetId: 12, fileName: "launch.png" },
        method: "POST",
        path: "/v2/social-sets/12/media/upload",
        body: { file_name: "launch.png" },
      },
      {
        name: "remove_media",
        args: {
          socialSetId: 12,
          draftId: 34,
          platforms: {
            x: { enabled: true, posts: [{ text: "Hello X", mediaIds: [] }] },
          },
        },
        method: "PATCH",
        path: "/v2/social-sets/12/drafts/34",
        body: {
          platforms: {
            x: { enabled: true, posts: [{ text: "Hello X", media_ids: [] }] },
          },
        },
      },
      {
        name: "schedule_draft",
        args: { socialSetId: 12, draftId: 34, publishAt: plannedAt },
        method: "PATCH",
        path: "/v2/social-sets/12/drafts/34",
        body: { publish_at: plannedAt },
      },
      {
        name: "delete_draft",
        args: { socialSetId: 12, draftId: 34 },
        method: "DELETE",
        path: "/v2/social-sets/12/drafts/34",
      },
    ];

    for (const item of cases) {
      const result = await transport.callTool(connection, item.name, item.args);
      expect(result).toEqual({
        text: '{"ok":true}',
        isError: false,
        truncated: false,
      });
      const call = calls.at(-1);
      expect(call).toBeDefined();
      const url = new URL(call!.url);
      expect(url.origin).toBe("https://api.typefully.com");
      expect(url.pathname).toBe(item.path);
      expect(Object.fromEntries(url.searchParams)).toEqual(item.query ?? {});
      expect(call!.method).toBe(item.method);
      expect(call!.authorization).toBe("Bearer tf-secret-key");
      expect(call!.contentType).toBe(item.body ? "application/json" : null);
      expect(call!.body ? JSON.parse(call!.body) : undefined).toEqual(
        item.body,
      );
    }
    expect(calls).toHaveLength(cases.length);
  });

  test("pins requests beneath the reviewed v2 base instead of trusting the connection URL", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    await transport.callTool(
      { url: "https://evil.test/not-v2", token: connection.token },
      "get_draft",
      { socialSetId: 1, draftId: 2 },
    );

    expect(calls[0]?.url).toBe(
      "https://api.typefully.com/v2/social-sets/1/drafts/2",
    );
  });
});

describe("fail-closed validation", () => {
  test("refuses an unknown tool before fetch", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    const result = await transport.callTool(connection, "publish_draft", {
      socialSetId: 1,
      draftId: 2,
    });

    expect(result).toEqual({
      text: expect.stringContaining("not a tool"),
      isError: true,
      truncated: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("refuses a missing credential before fetch", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    const result = await transport.callTool(
      { url: connection.url },
      "list_social_sets",
      {},
    );

    expect(result).toEqual({
      text: expect.stringContaining("credential"),
      isError: true,
      truncated: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("validates positive integer ids before interpolation", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    for (const socialSetId of [0, -1, 1.5, "1", "../me"]) {
      const result = await transport.callTool(connection, "get_draft", {
        socialSetId,
        draftId: 2,
      });
      expect(result.isError).toBe(true);
    }
    for (const draftId of [0, -1, 1.5, "2", "../media"]) {
      const result = await transport.callTool(connection, "get_draft", {
        socialSetId: 1,
        draftId,
      });
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test("rejects unknown fields, including publish aliases and upload contentType", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    const attempts = [
      transport.callTool(connection, "create_draft", {
        socialSetId: 1,
        platforms,
        arbitrary: "do not forward",
      }),
      transport.callTool(connection, "create_draft", {
        socialSetId: 1,
        platforms,
        publishAt: plannedAt,
      }),
      transport.callTool(connection, "update_draft", {
        socialSetId: 1,
        draftId: 2,
        publish_at: "now",
      }),
      transport.callTool(connection, "upload_media", {
        socialSetId: 1,
        fileName: "launch.png",
        contentType: "image/png",
      }),
    ];

    for (const attempt of attempts) {
      expect((await attempt).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test("rejects post text and media ids beyond the live v2 bounds before fetch", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    const tooLong = await transport.callTool(connection, "create_draft", {
      socialSetId: 1,
      platforms: {
        x: { enabled: true, posts: [{ text: "x".repeat(50_001) }] },
      },
    });
    const tooManyMedia = await transport.callTool(connection, "create_draft", {
      socialSetId: 1,
      platforms: {
        x: {
          enabled: true,
          posts: [
            {
              text: "bounded",
              mediaIds: Array.from({ length: 11 }, (_, index) => String(index)),
            },
          ],
        },
      },
    });

    expect(tooLong.isError).toBe(true);
    expect(tooManyMedia.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("requires create_draft share to be boolean before fetch", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    for (const share of [null, "true", 1]) {
      const result = await transport.callTool(connection, "create_draft", {
        socialSetId: 1,
        platforms,
        share,
      });
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test("rejects now, past, impossible, and timezone-less schedules before fetch", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    for (const publishAt of [
      "now",
      "NOW",
      "2020-01-01T00:00:00Z",
      "2099-02-30T12:00:00Z",
      "2099-13-01T12:00:00Z",
      "2099-01-01T12:00:00",
      "tomorrow",
      "2099-01-01",
    ]) {
      const result = await transport.callTool(connection, "schedule_draft", {
        socialSetId: 1,
        draftId: 2,
        publishAt,
      });
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test("accepts future Z and offset schedules", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    for (const publishAt of [
      "2099-08-27T12:00:00Z",
      "2099-08-27T12:00:00-07:00",
      "2099-08-27T12:00:00.123456Z",
      "2099-08-27T12:00:00.123456-07:00",
      "next-free-slot",
    ]) {
      const result = await transport.callTool(connection, "schedule_draft", {
        socialSetId: 1,
        draftId: 2,
        publishAt,
      });
      expect(result.isError).toBe(false);
      expect(JSON.parse(calls.at(-1)?.body ?? "null")).toEqual({
        publish_at: publishAt,
      });
    }
    expect(calls).toHaveLength(5);
  });

  test("bounds pagination before fetch", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    for (const args of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: 1.5 },
    ]) {
      expect(
        (await transport.callTool(connection, "list_social_sets", args))
          .isError,
      ).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("bounded and redacted failures", () => {
  test("uses an abort timeout and reports it canonically", async () => {
    const calls: FetchCall[] = [];
    const fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: null,
        contentType: null,
        body: null,
        signal: init?.signal ?? null,
      });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });
    }) as typeof globalThis.fetch;
    const transport = createTypefullyRestTransport(fetch, {
      timeoutMs: 5,
    });

    const result = await transport.callTool(connection, "list_social_sets", {});
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      text: expect.stringContaining("in time"),
      isError: true,
      truncated: false,
    });
  });

  test("reports network failure without leaking implementation details", async () => {
    const fetch = (async () => {
      throw new Error("socket failed at 10.0.0.7 with tf-secret-key");
    }) as typeof globalThis.fetch;
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "list_social_sets", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("could not be reached");
    expect(result.text).not.toContain("10.0.0.7");
    expect(result.text).not.toContain(connection.token);
  });

  test("never includes the token or an untrusted 401 body", async () => {
    const hostile = `invalid ${connection.token} from internal-auth-host`;
    const { fetch } = recordingFetch({ status: 401, text: hostile });
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "list_social_sets", {});
    expect(result).toEqual({
      text: expect.stringContaining("authentication"),
      isError: true,
      truncated: false,
    });
    expect(result.text).not.toContain(connection.token);
    expect(result.text).not.toContain("internal-auth-host");
  });

  test("reports a bounded Retry-After on 429 and does not retry", async () => {
    const retryAfter = `120-${"x".repeat(1_000)}`;
    const { fetch, calls } = recordingFetch({
      status: 429,
      text: "do not retain this body",
      headers: { "retry-after": retryAfter },
    });
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "list_social_sets", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Retry-After");
    expect(result.text).toContain("120-");
    expect(result.text.length).toBeLessThan(500);
    expect(result.text).not.toContain("do not retain this body");
    expect(calls).toHaveLength(1);
  });

  test("keeps only a bounded safe vendor message for other failures", async () => {
    const { fetch } = recordingFetch({
      status: 422,
      body: {
        detail: `bad request ${"x".repeat(5_000)}`,
        secret_debug: connection.token,
      },
    });
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "list_social_sets", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("422");
    expect(result.text).toContain("bad request");
    expect(result.text.length).toBeLessThan(1_000);
    expect(result.text).not.toContain(connection.token);
    expect(result.truncated).toBe(false);
  });

  test("visibly truncates oversized successful responses", async () => {
    const { fetch } = recordingFetch({
      body: { result: "x".repeat(MAX_RESULT_CHARS + 1_000) },
    });
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "list_social_sets", {});
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated:");
    expect(result.text.length).toBeLessThan(MAX_RESULT_CHARS + 200);
  });
});
