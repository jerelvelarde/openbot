import { describe, expect, test } from "bun:test";
import { catalogueEntry } from "../src/plugins/catalogue";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";
import { transportFor } from "../src/plugins/transport";
import {
  callTool,
  createTypefullyRestTransport,
  listTools,
  TYPEFULLY_REMOVE_MEDIA_MAX_DRAFT_BYTES,
  TypefullyApiKeyValidationError,
  validateTypefullyApiKey,
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
    const removeMedia = tools.find((tool) => tool.name === "remove_media");
    expect(removeMedia?.description).toContain(
      `${TYPEFULLY_REMOVE_MEDIA_MAX_DRAFT_BYTES / 1_000_000} MB`,
    );
    expect(removeMedia?.description).toMatch(/refus/i);
    expect(TYPEFULLY_REMOVE_MEDIA_MAX_DRAFT_BYTES).toBe(1_000_000);
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
    const update = tools.find((tool) => tool.name === "update_draft");
    const schema = create?.inputSchema as {
      allOf?: {
        anyOf?: {
          properties?: {
            platforms?: {
              required?: string[];
              properties?: Record<
                string,
                { properties?: { enabled?: { const?: unknown } } }
              >;
            };
          };
        }[];
      }[];
      properties?: {
        share?: { type?: unknown };
        platforms?: {
          minProperties?: unknown;
          properties?: {
            x?: {
              oneOf?: {
                required?: string[];
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
              }[];
            };
          };
        };
        planAt?: {
          anyOf?: { anyOf?: { maxLength?: unknown }[] }[];
        };
      };
    };

    const post =
      schema.properties?.platforms?.properties?.x?.oneOf?.[0]?.properties
        ?.posts;
    expect(post?.items?.properties?.text?.maxLength).toBe(50_000);
    expect(post?.items?.properties?.mediaIds?.maxItems).toBe(10);
    expect(
      schema.properties?.platforms?.properties?.x?.oneOf?.[0]?.required,
    ).toContain("posts");
    expect(
      schema.properties?.platforms?.properties?.x?.oneOf?.[1]?.required,
    ).not.toContain("posts");
    expect(schema.properties?.share?.type).toBe("boolean");
    expect(schema.properties?.platforms?.minProperties).toBe(1);
    expect(schema.properties?.planAt?.anyOf?.[0]?.anyOf?.[1]?.maxLength).toBe(
      64,
    );
    expect(
      (update?.inputSchema.anyOf as { required?: string[] }[] | undefined)?.map(
        (branch) => branch.required,
      ),
    ).toEqual([["platforms"], ["draftTitle"], ["share"], ["planAt"]]);
    expect(
      schema.allOf?.[0]?.anyOf?.map((branch) => ({
        platform: branch.properties?.platforms?.required?.[0],
        enabled:
          branch.properties?.platforms?.properties?.[
            branch.properties.platforms.required?.[0] ?? ""
          ]?.properties?.enabled?.const,
      })),
    ).toEqual([
      { platform: "x", enabled: true },
      { platform: "linkedin", enabled: true },
      { platform: "threads", enabled: true },
      { platform: "bluesky", enabled: true },
      { platform: "mastodon", enabled: true },
    ]);
  });

  test("is registered for the frozen Typefully catalogue entry", () => {
    const entry = catalogueEntry("typefully");
    expect(entry?.transport).toBe("typefully-rest");
    expect(transportFor(entry).callTool).toBe(callTool);
  });

  test("returns a deep clone so one listing cannot mutate the static manifest", async () => {
    const first = await listTools({ url: connection.url });
    first[0]!.name = "mutated";
    const root = first[1]!.inputSchema as {
      properties?: Record<string, { description?: string }>;
    };
    if (root.properties?.socialSetId) {
      root.properties.socialSetId.description = "mutated nested schema";
    }

    const second = await listTools({ url: connection.url });
    expect(second[0]?.name).toBe("list_social_sets");
    const secondSchema = second[1]?.inputSchema as
      | {
          properties?: Record<string, { description?: string }>;
        }
      | undefined;
    expect(secondSchema?.properties?.socialSetId?.description).not.toBe(
      "mutated nested schema",
    );
  });
});

describe("Typefully API-key validation", () => {
  test("calls the pinned /v2/me endpoint and returns bounded safe metadata", async () => {
    const { fetch, calls } = recordingFetch({
      body: {
        id: 123,
        name: "Typefully Account",
        email: "unnecessary@example.com",
        profile_image_url: "https://example.com/private.png",
        signup_date: "2026-01-01",
        api_key_label: "OpenBot",
      },
    });

    const metadata = await validateTypefullyApiKey("tf-valid-secret", fetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.typefully.com/v2/me",
      method: "GET",
      authorization: "Bearer tf-valid-secret",
    });
    expect(metadata).toEqual({
      accountId: "123",
      accountLabel: "Typefully Account",
      keyLabel: "OpenBot",
    });
    expect(JSON.stringify(metadata)).not.toContain("unnecessary@example.com");
  });

  test("rejects malformed keys before fetch", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response();
    }) as typeof globalThis.fetch;

    await expect(
      validateTypefullyApiKey("bad\nkey", fetch),
    ).rejects.toMatchObject({
      code: "invalid_api_key",
    });
    expect(calls).toBe(0);
  });

  test("never keeps a key reflected in identity metadata", async () => {
    const secret = "tf-reflected-secret";
    const { fetch } = recordingFetch({
      body: {
        id: secret,
        name: `Account ${secret}`,
        api_key_label: secret,
      },
    });

    const metadata = await validateTypefullyApiKey(secret, fetch);
    expect(JSON.stringify(metadata)).not.toContain(secret);
  });

  test("distinguishes invalid keys and rate limits without reflecting the key", async () => {
    for (const [status, code] of [
      [401, "invalid_api_key"],
      [429, "rate_limited"],
    ] as const) {
      const secret = `secret-${status}`;
      const { fetch } = recordingFetch({ status, text: secret });
      const error = await validateTypefullyApiKey(secret, fetch).catch(
        (caught) => caught,
      );
      expect(error).toBeInstanceOf(TypefullyApiKeyValidationError);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain(secret);
    }
  });

  test("distinguishes validation timeouts", async () => {
    const fetch = (async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("timed out", "AbortError"));
        });
      })) as typeof globalThis.fetch;

    await expect(
      validateTypefullyApiKey("tf-valid", fetch, 1),
    ).rejects.toMatchObject({ code: "validation_timeout" });
  });

  test("keeps the timeout active while reading the bounded identity stream", async () => {
    const fetch = (async (_input, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("timed out", "AbortError"));
            });
          },
        }),
      )) as typeof globalThis.fetch;

    await expect(
      validateTypefullyApiKey("tf-valid", fetch, 1),
    ).rejects.toMatchObject({ code: "validation_timeout" });
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

  test("remove_media reads the marker-preserving draft and removes only the named reference", async () => {
    const authoritative = {
      id: 34,
      publish_at: "2099-08-27T12:00:00Z",
      platforms: {
        x: {
          enabled: true,
          vendor_setting: { response_only: true },
          settings: {
            reply_to_url: "https://x.com/example/status/1",
            community_id: "community-1",
            share_with_followers: true,
            response_only: "omit",
          },
          posts: [
            {
              text: '<typ:comment-thread id="c1">Keep marker</typ:comment-thread>',
              media_ids: ["target-media", "keep-media"],
              quote_post_url: "https://example.test/post",
              subscribers_only: false,
              paid_partnership: true,
              made_with_ai: false,
              hide_link_preview: true,
              response_only: "omit",
            },
            { text: "Untouched post", media_ids: ["other-media"] },
          ],
        },
        linkedin: { enabled: false, vendor_disabled_field: "preserve" },
        future_platform: {
          enabled: true,
          posts: [{ text: "Unknown platform stays", media_ids: ["future"] }],
          future_field: 42,
        },
      },
    };
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
      return calls.length === 1
        ? new Response(JSON.stringify(authoritative), {
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          });
    }) as typeof globalThis.fetch;
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "remove_media", {
      socialSetId: 12,
      draftId: 34,
      platform: "x",
      postIndex: 0,
      mediaId: "target-media",
    });

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://api.typefully.com/v2/social-sets/12/drafts/34",
    );
    expect(new URL(calls[0]!.url).search).toBe("");
    expect(calls[1]?.method).toBe("PATCH");
    const patched = JSON.parse(calls[1]?.body ?? "null");
    expect(Object.keys(patched)).toEqual(["platforms"]);
    expect(patched.platforms).toEqual({
      x: {
        enabled: true,
        posts: [
          {
            text: '<typ:comment-thread id="c1">Keep marker</typ:comment-thread>',
            media_ids: ["keep-media"],
            quote_post_url: "https://example.test/post",
            subscribers_only: false,
            paid_partnership: true,
            made_with_ai: false,
            hide_link_preview: true,
          },
          { text: "Untouched post", media_ids: ["other-media"] },
        ],
        settings: {
          reply_to_url: "https://x.com/example/status/1",
          community_id: "community-1",
          share_with_followers: true,
        },
      },
    });
    expect(Object.keys(patched.platforms)).toEqual(["x"]);
    expect(JSON.stringify(patched)).not.toContain("response_only");
    expect(JSON.stringify(patched)).not.toContain("future_platform");
    expect(JSON.stringify(patched)).not.toContain("publish_at");
  });

  test("remove_media renames the documented LinkedIn response reshare field", async () => {
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
      return calls.length === 1
        ? new Response(
            JSON.stringify({
              platforms: {
                linkedin: {
                  enabled: true,
                  response_only: "omit",
                  settings: { response_only: "omit" },
                  posts: [
                    {
                      text: "Keep LinkedIn text",
                      media_ids: ["target-media", "keep-media"],
                      linkedin_reshare_urn: "urn:li:share:123",
                      hide_link_preview: false,
                      response_only: "omit",
                    },
                  ],
                },
                x: { enabled: false },
              },
            }),
          )
        : new Response(JSON.stringify({ ok: true }));
    }) as typeof globalThis.fetch;
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "remove_media", {
      socialSetId: 12,
      draftId: 34,
      platform: "linkedin",
      postIndex: 0,
      mediaId: "target-media",
    });

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]?.body ?? "null")).toEqual({
      platforms: {
        linkedin: {
          enabled: true,
          posts: [
            {
              text: "Keep LinkedIn text",
              media_ids: ["keep-media"],
              linkedin_reshare_target: "urn:li:share:123",
              hide_link_preview: false,
            },
          ],
        },
      },
    });
  });

  test("remove_media omits nullable optional X and LinkedIn response fields", async () => {
    const cases = [
      {
        platform: "x",
        responsePlatform: {
          enabled: true,
          settings: null,
          posts: [
            {
              text: "Keep X text",
              media_ids: ["target-media", "keep-media"],
              quote_post_url: null,
              subscribers_only: null,
              paid_partnership: null,
              made_with_ai: null,
              hide_link_preview: null,
            },
            { text: "No media response", media_ids: null },
          ],
        },
        expectedPlatform: {
          enabled: true,
          posts: [
            { text: "Keep X text", media_ids: ["keep-media"] },
            { text: "No media response" },
          ],
        },
      },
      {
        platform: "linkedin",
        responsePlatform: {
          enabled: true,
          settings: null,
          posts: [
            {
              text: "Keep LinkedIn text",
              media_ids: ["target-media", "keep-media"],
              linkedin_reshare_urn: null,
              hide_link_preview: null,
            },
          ],
        },
        expectedPlatform: {
          enabled: true,
          posts: [{ text: "Keep LinkedIn text", media_ids: ["keep-media"] }],
        },
      },
    ] as const;

    for (const item of cases) {
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
        return calls.length === 1
          ? new Response(
              JSON.stringify({
                platforms: { [item.platform]: item.responsePlatform },
              }),
            )
          : new Response(JSON.stringify({ ok: true }));
      }) as typeof globalThis.fetch;
      const transport = createTypefullyRestTransport(fetch);

      const result = await transport.callTool(connection, "remove_media", {
        socialSetId: 12,
        draftId: 34,
        platform: item.platform,
        postIndex: 0,
        mediaId: "target-media",
      });

      expect(result.isError).toBe(false);
      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[1]?.body ?? "null")).toEqual({
        platforms: { [item.platform]: item.expectedPlatform },
      });
    }
  });

  test("remove_media refuses malformed selected-platform responses without PATCHing", async () => {
    const { fetch, calls } = recordingFetch({
      body: {
        platforms: {
          x: {
            enabled: true,
            posts: [
              {
                text: "Valid text",
                media_ids: ["target-media", "keep-media"],
                quote_post_url: 42,
              },
            ],
          },
        },
      },
    });
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "remove_media", {
      socialSetId: 12,
      draftId: 34,
      platform: "x",
      postIndex: 0,
      mediaId: "target-media",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/could not be updated safely/i);
    expect(result.text.length).toBeLessThan(500);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  test("remove_media refuses a missing target after the authoritative GET", async () => {
    const { fetch, calls } = recordingFetch({
      body: {
        platforms: {
          x: {
            enabled: true,
            posts: [{ text: "Keep", media_ids: ["different-media"] }],
          },
        },
      },
    });
    const transport = createTypefullyRestTransport(fetch);
    const result = await transport.callTool(connection, "remove_media", {
      socialSetId: 12,
      draftId: 34,
      platform: "x",
      postIndex: 0,
      mediaId: "missing-media",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not attached");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
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
      transport.callTool(connection, "remove_media", {
        socialSetId: 1,
        draftId: 2,
        platforms,
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

  test("requires an enabled platform on create while allowing all-disabled updates", async () => {
    const disabled = recordingFetch();
    const disabledTransport = createTypefullyRestTransport(disabled.fetch);
    const refusedCreate = await disabledTransport.callTool(
      connection,
      "create_draft",
      {
        socialSetId: 1,
        platforms: { linkedin: { enabled: false } },
      },
    );
    expect(refusedCreate.isError).toBe(true);
    expect(disabled.calls).toHaveLength(0);

    const update = recordingFetch();
    const updateTransport = createTypefullyRestTransport(update.fetch);
    const acceptedUpdate = await updateTransport.callTool(
      connection,
      "update_draft",
      {
        socialSetId: 1,
        draftId: 2,
        platforms: { linkedin: { enabled: false } },
      },
    );
    expect(acceptedUpdate.isError).toBe(false);
    expect(JSON.parse(update.calls[0]?.body ?? "null")).toEqual({
      platforms: { linkedin: { enabled: false } },
    });

    const enabled = recordingFetch();
    const enabledTransport = createTypefullyRestTransport(enabled.fetch);
    const refused = await enabledTransport.callTool(
      connection,
      "create_draft",
      {
        socialSetId: 1,
        platforms: { linkedin: { enabled: true } },
      },
    );
    expect(refused.isError).toBe(true);
    expect(enabled.calls).toHaveLength(0);
  });

  test("bounds and flattens hostile validation values", async () => {
    const { fetch, calls } = recordingFetch();
    const transport = createTypefullyRestTransport(fetch);
    const hostileKey = `bad\n\u0000${"x".repeat(2_000)}`;
    const failures = [
      await transport.callTool(connection, "list_social_sets", {
        [hostileKey]: true,
      }),
      await transport.callTool(connection, "create_draft", {
        socialSetId: 1,
        platforms: { [hostileKey]: { enabled: false } },
      }),
      await transport.callTool(connection, "schedule_draft", {
        socialSetId: 1,
        draftId: 2,
        publishAt: `2099-01-01T00:00:00Z\n${"x".repeat(2_000)}`,
      }),
      await transport.callTool(connection, "create_draft", {
        socialSetId: 1,
        platforms,
        planAt: `2099-01-01T00:00:00Z\n${"x".repeat(2_000)}`,
      }),
    ];

    for (const result of failures) {
      expect(result.isError).toBe(true);
      expect(result.text.length).toBeLessThan(500);
      expect(result.text).not.toMatch(/[\r\n]/);
      expect(result.text).not.toContain("\u0000");
    }
    expect(failures.some((result) => result.truncated)).toBe(true);
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
  test("bounds and cancels oversized chunked success and error streams", async () => {
    async function run(status: number) {
      let cancelled = false;
      const encoder = new TextEncoder();
      const fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(encoder.encode("x".repeat(8_000)));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status },
        )) as typeof globalThis.fetch;
      const transport = createTypefullyRestTransport(fetch);
      const result = await transport.callTool(
        connection,
        "list_social_sets",
        {},
      );
      return { cancelled, result };
    }

    const success = await run(200);
    expect(success.cancelled).toBe(true);
    expect(success.result.isError).toBe(false);
    expect(success.result.truncated).toBe(true);
    expect(success.result.text).toContain("[truncated:");
    expect(success.result.text.length).toBeLessThan(MAX_RESULT_CHARS + 500);

    const error = await run(422);
    expect(error.cancelled).toBe(true);
    expect(error.result.isError).toBe(true);
    expect(error.result.truncated).toBe(true);
    expect(error.result.text).toContain("[truncated:");
    expect(error.result.text.length).toBeLessThan(MAX_RESULT_CHARS + 500);
  });

  test("turns post-header success and error stream failures into canonical results", async () => {
    for (const status of [200, 422]) {
      const encoder = new TextEncoder();
      const fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('{"partial":'));
            },
            pull(controller) {
              controller.error(new Error("stream failed with tf-secret-key"));
            },
          }),
          { status },
        )) as typeof globalThis.fetch;
      const transport = createTypefullyRestTransport(fetch);

      const result = await transport.callTool(
        connection,
        "list_social_sets",
        {},
      );
      expect(result).toEqual({
        text: expect.stringContaining("could not be read"),
        isError: true,
        truncated: false,
      });
      expect(result.text).not.toContain(connection.token);
    }
  });

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
    const retryAfter = `120-${connection.token}-${"x".repeat(1_000)}`;
    const { fetch, calls } = recordingFetch({
      status: 429,
      text: `do not retain this body ${connection.token}`,
      headers: { "retry-after": retryAfter },
    });
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "list_social_sets", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Retry-After");
    expect(result.text).toContain("120-");
    expect(result.text.length).toBeLessThan(500);
    expect(result.text).not.toContain("do not retain this body");
    expect(result.text).not.toContain(connection.token);
    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("keeps only a bounded safe vendor message for other failures", async () => {
    const { fetch } = recordingFetch({
      status: 422,
      body: {
        detail: `bad request ${connection.token} ${"x".repeat(5_000)}`,
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
    expect(result.truncated).toBe(true);
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

  test("redacts the bearer token from successful vendor text", async () => {
    const { fetch } = recordingFetch({
      body: { echoed: connection.token, safe: "keep this" },
    });
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "list_social_sets", {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain("keep this");
    expect(result.text).toContain("[redacted]");
    expect(result.text).not.toContain(connection.token);
  });

  test("redacts a chunk-split token beyond the character cap in UTF-8 bytes", async () => {
    const token = connection.token;
    const reflected = `${"😀".repeat(19_970)}${token} safe-tail`;
    const json = JSON.stringify({ reflected });
    const encoder = new TextEncoder();
    const bytes = encoder.encode(json);
    const tokenStart = encoder.encode(
      json.slice(0, json.indexOf(token)),
    ).length;
    const split = tokenStart + Math.floor(encoder.encode(token).length / 2);
    const fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
          },
        }),
      )) as typeof globalThis.fetch;
    const transport = createTypefullyRestTransport(fetch);

    const result = await transport.callTool(connection, "list_social_sets", {});

    expect(tokenStart).toBeGreaterThan(MAX_RESULT_CHARS);
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[redacted]");
    expect(result.text).not.toContain(token);
    expect(result.text).not.toContain(token.slice(0, 6));
    expect(result.text).not.toContain(token.slice(6));
  });
});
