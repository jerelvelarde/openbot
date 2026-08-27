import { type McpCallResult, type McpTool, resultText } from "./mcp";

const TYPEFULLY_API_URL = "https://api.typefully.com/v2";
const REQUEST_TIMEOUT_MS = 30_000;
const SAFE_ERROR_CHARS = 400;
const RETRY_AFTER_CHARS = 120;

type Connection = { url: string; token?: string };
type FetchImplementation = typeof globalThis.fetch;

const postSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", maxLength: 100_000 },
    mediaIds: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 240 },
    },
  },
  required: ["text"],
} as const;

const platformSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    posts: { type: "array", minItems: 1, maxItems: 50, items: postSchema },
  },
  required: ["enabled", "posts"],
} as const;

const platformsSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    x: platformSchema,
    linkedin: platformSchema,
    threads: platformSchema,
    bluesky: platformSchema,
    mastodon: platformSchema,
  },
} as const;

const socialSetIdSchema = {
  type: "integer",
  minimum: 1,
  description: "The positive integer id of the Typefully social set.",
} as const;

const draftIdSchema = {
  type: "integer",
  minimum: 1,
  description: "The positive integer id of the Typefully draft.",
} as const;

const paginationProperties = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 50,
    description: "At most 50 records to return.",
  },
  offset: {
    type: "integer",
    minimum: 0,
    description: "How many records to skip.",
  },
} as const;

const draftFields = {
  platforms: platformsSchema,
  draftTitle: {
    type: ["string", "null"],
    maxLength: 512,
    description: "An internal title; it is not posted.",
  },
  share: { type: ["boolean", "null"] },
  planAt: {
    type: ["string", "null"],
    description:
      'A future ISO 8601 datetime or "next-free-slot". Planning is inert and never publishes.',
  },
} as const;

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_social_sets",
    description:
      "List the Typefully social sets your personal account can access.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: paginationProperties,
    },
  },
  {
    name: "list_drafts",
    description: "List drafts in one Typefully social set.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { socialSetId: socialSetIdSchema, ...paginationProperties },
      required: ["socialSetId"],
    },
  },
  {
    name: "get_draft",
    description: "Get one Typefully draft.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { socialSetId: socialSetIdSchema, draftId: draftIdSchema },
      required: ["socialSetId", "draftId"],
    },
  },
  {
    name: "create_draft",
    description:
      "Create an unscheduled or inertly planned Typefully draft. This tool cannot publish immediately.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { socialSetId: socialSetIdSchema, ...draftFields },
      required: ["socialSetId", "platforms"],
    },
  },
  {
    name: "update_draft",
    description:
      "Update reviewed fields on a Typefully draft. This tool cannot publish immediately.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        socialSetId: socialSetIdSchema,
        draftId: draftIdSchema,
        ...draftFields,
      },
      required: ["socialSetId", "draftId"],
    },
  },
  {
    name: "upload_media",
    description:
      "Request a presigned Typefully media-upload URL. This only initiates the upload and never accepts file bytes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        socialSetId: socialSetIdSchema,
        fileName: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          pattern:
            "^[a-zA-Z0-9_.()\\-]+\\.(?:[jJ][pP][gG]|[jJ][pP][eE][gG]|[pP][nN][gG]|[wW][eE][bB][pP]|[gG][iI][fF]|[mM][pP]4|[mM][oO][vV]|[pP][dD][fF])$",
        },
      },
      required: ["socialSetId", "fileName"],
    },
  },
  {
    name: "remove_media",
    description:
      "Update a draft with a fully reviewed platforms value from which the media reference has already been removed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        socialSetId: socialSetIdSchema,
        draftId: draftIdSchema,
        platforms: platformsSchema,
      },
      required: ["socialSetId", "draftId", "platforms"],
    },
  },
  {
    name: "schedule_draft",
    description:
      'Schedule a draft for a future ISO 8601 datetime or the next free slot. "now" is always refused.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        socialSetId: socialSetIdSchema,
        draftId: draftIdSchema,
        publishAt: {
          type: "string",
          description:
            'A future ISO 8601 datetime with timezone or "next-free-slot"; never "now".',
        },
      },
      required: ["socialSetId", "draftId", "publishAt"],
    },
  },
  {
    name: "delete_draft",
    description: "Delete one Typefully draft.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { socialSetId: socialSetIdSchema, draftId: draftIdSchema },
      required: ["socialSetId", "draftId"],
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

const failure = (text: string): McpCallResult => ({
  text,
  isError: true,
  truncated: false,
});

function successful(text: string): McpCallResult {
  const rendered = resultText([{ type: "text", text }]);
  return { ...rendered, isError: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownField(
  args: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  const unexpected = Object.keys(args).find((key) => !allowed.includes(key));
  return unexpected ?? null;
}

function positiveInteger(
  args: Record<string, unknown>,
  key: "socialSetId" | "draftId",
): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function pagination(
  args: Record<string, unknown>,
):
  | { ok: true; query: Record<string, string> }
  | { ok: false; message: string } {
  const query: Record<string, string> = {};
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 50
    ) {
      return { ok: false, message: "limit must be an integer from 1 to 50." };
    }
    query.limit = String(args.limit);
  }
  if (args.offset !== undefined) {
    if (
      typeof args.offset !== "number" ||
      !Number.isSafeInteger(args.offset) ||
      args.offset < 0
    ) {
      return { ok: false, message: "offset must be a non-negative integer." };
    }
    query.offset = String(args.offset);
  }
  return { ok: true, query };
}

const PLATFORM_NAMES = new Set([
  "x",
  "linkedin",
  "threads",
  "bluesky",
  "mastodon",
]);

function reviewedPlatforms(
  value: unknown,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return { ok: false, message: "platforms must name at least one platform." };
  }

  const mapped: Record<string, unknown> = {};
  for (const [platformName, rawPlatform] of Object.entries(value)) {
    if (!PLATFORM_NAMES.has(platformName) || !isRecord(rawPlatform)) {
      return {
        ok: false,
        message: `platforms.${platformName} is not supported.`,
      };
    }
    const extraPlatformField = unknownField(rawPlatform, ["enabled", "posts"]);
    if (extraPlatformField) {
      return {
        ok: false,
        message: `platforms.${platformName}.${extraPlatformField} is not allowed.`,
      };
    }
    if (typeof rawPlatform.enabled !== "boolean") {
      return {
        ok: false,
        message: `platforms.${platformName}.enabled must be a boolean.`,
      };
    }
    if (
      !Array.isArray(rawPlatform.posts) ||
      rawPlatform.posts.length < 1 ||
      rawPlatform.posts.length > 50
    ) {
      return {
        ok: false,
        message: `platforms.${platformName}.posts must contain 1 to 50 posts.`,
      };
    }
    const posts: Record<string, unknown>[] = [];
    for (const [index, rawPost] of rawPlatform.posts.entries()) {
      if (!isRecord(rawPost)) {
        return {
          ok: false,
          message: `platforms.${platformName}.posts[${index}] must be an object.`,
        };
      }
      const extraPostField = unknownField(rawPost, ["text", "mediaIds"]);
      if (extraPostField) {
        return {
          ok: false,
          message: `platforms.${platformName}.posts[${index}].${extraPostField} is not allowed.`,
        };
      }
      if (typeof rawPost.text !== "string" || rawPost.text.length > 100_000) {
        return {
          ok: false,
          message: `platforms.${platformName}.posts[${index}].text must be a string of at most 100000 characters.`,
        };
      }
      const post: Record<string, unknown> = { text: rawPost.text };
      if (rawPost.mediaIds !== undefined) {
        if (
          !Array.isArray(rawPost.mediaIds) ||
          rawPost.mediaIds.length > 20 ||
          rawPost.mediaIds.some(
            (id) => typeof id !== "string" || id.length < 1 || id.length > 240,
          )
        ) {
          return {
            ok: false,
            message: `platforms.${platformName}.posts[${index}].mediaIds is invalid.`,
          };
        }
        post.media_ids = [...rawPost.mediaIds];
      }
      posts.push(post);
    }
    mapped[platformName] = { enabled: rawPlatform.enabled, posts };
  }
  return { ok: true, value: mapped };
}

function futureDateOrSlot(value: unknown): value is string {
  if (value === "next-free-slot") return true;
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

type RequestSpec = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
};

type BuiltRequest =
  | { ok: true; request: RequestSpec }
  | { ok: false; message: string };

function idError(key: "socialSetId" | "draftId"): BuiltRequest {
  return {
    ok: false,
    message: `${key} must be a positive integer.`,
  };
}

function buildDraftBody(
  args: Record<string, unknown>,
  requirePlatforms: boolean,
):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string } {
  const body: Record<string, unknown> = {};
  if (args.platforms !== undefined) {
    const platforms = reviewedPlatforms(args.platforms);
    if (!platforms.ok) return platforms;
    body.platforms = platforms.value;
  } else if (requirePlatforms) {
    return { ok: false, message: "platforms is required." };
  }
  if (args.draftTitle !== undefined) {
    if (
      args.draftTitle !== null &&
      (typeof args.draftTitle !== "string" || args.draftTitle.length > 512)
    ) {
      return {
        ok: false,
        message:
          "draftTitle must be null or a string of at most 512 characters.",
      };
    }
    body.draft_title = args.draftTitle;
  }
  if (args.share !== undefined) {
    if (args.share !== null && typeof args.share !== "boolean") {
      return { ok: false, message: "share must be null or a boolean." };
    }
    body.share = args.share;
  }
  if (args.planAt !== undefined) {
    if (args.planAt !== null && !futureDateOrSlot(args.planAt)) {
      return {
        ok: false,
        message:
          'planAt must be null, "next-free-slot", or a future ISO 8601 datetime with timezone.',
      };
    }
    body.plan_at = args.planAt;
  }
  if (Object.keys(body).length === 0) {
    return {
      ok: false,
      message: "At least one reviewed draft field is required.",
    };
  }
  return { ok: true, body };
}

function buildRequest(
  toolName: string,
  args: Record<string, unknown>,
): BuiltRequest {
  if (toolName === "list_social_sets") {
    const extra = unknownField(args, ["limit", "offset"]);
    if (extra) return { ok: false, message: `${extra} is not allowed.` };
    const page = pagination(args);
    if (!page.ok) return page;
    return {
      ok: true,
      request: { method: "GET", path: "/social-sets", query: page.query },
    };
  }

  if (toolName === "list_drafts") {
    const extra = unknownField(args, ["socialSetId", "limit", "offset"]);
    if (extra) return { ok: false, message: `${extra} is not allowed.` };
    const socialSetId = positiveInteger(args, "socialSetId");
    if (!socialSetId) return idError("socialSetId");
    const page = pagination(args);
    if (!page.ok) return page;
    return {
      ok: true,
      request: {
        method: "GET",
        path: `/social-sets/${socialSetId}/drafts`,
        query: page.query,
      },
    };
  }

  if (toolName === "get_draft" || toolName === "delete_draft") {
    const extra = unknownField(args, ["socialSetId", "draftId"]);
    if (extra) return { ok: false, message: `${extra} is not allowed.` };
    const socialSetId = positiveInteger(args, "socialSetId");
    if (!socialSetId) return idError("socialSetId");
    const draftId = positiveInteger(args, "draftId");
    if (!draftId) return idError("draftId");
    return {
      ok: true,
      request: {
        method: toolName === "get_draft" ? "GET" : "DELETE",
        path: `/social-sets/${socialSetId}/drafts/${draftId}`,
      },
    };
  }

  if (toolName === "create_draft" || toolName === "update_draft") {
    const allowed = [
      "socialSetId",
      ...(toolName === "update_draft" ? ["draftId"] : []),
      "platforms",
      "draftTitle",
      "share",
      "planAt",
    ];
    const extra = unknownField(args, allowed);
    if (extra) return { ok: false, message: `${extra} is not allowed.` };
    const socialSetId = positiveInteger(args, "socialSetId");
    if (!socialSetId) return idError("socialSetId");
    const draftId =
      toolName === "update_draft" ? positiveInteger(args, "draftId") : null;
    if (toolName === "update_draft" && !draftId) return idError("draftId");
    const body = buildDraftBody(args, toolName === "create_draft");
    if (!body.ok) return body;
    return {
      ok: true,
      request: {
        method: toolName === "create_draft" ? "POST" : "PATCH",
        path:
          toolName === "create_draft"
            ? `/social-sets/${socialSetId}/drafts`
            : `/social-sets/${socialSetId}/drafts/${draftId}`,
        body: body.body,
      },
    };
  }

  if (toolName === "upload_media") {
    const extra = unknownField(args, ["socialSetId", "fileName"]);
    if (extra) return { ok: false, message: `${extra} is not allowed.` };
    const socialSetId = positiveInteger(args, "socialSetId");
    if (!socialSetId) return idError("socialSetId");
    const fileName = args.fileName;
    if (
      typeof fileName !== "string" ||
      fileName.length > 255 ||
      !/^[a-zA-Z0-9_.()-]+\.(?:jpg|jpeg|png|webp|gif|mp4|mov|pdf)$/i.test(
        fileName,
      )
    ) {
      return {
        ok: false,
        message: "fileName is not a supported media filename.",
      };
    }
    return {
      ok: true,
      request: {
        method: "POST",
        path: `/social-sets/${socialSetId}/media/upload`,
        body: { file_name: fileName },
      },
    };
  }

  if (toolName === "remove_media") {
    const extra = unknownField(args, ["socialSetId", "draftId", "platforms"]);
    if (extra) return { ok: false, message: `${extra} is not allowed.` };
    const socialSetId = positiveInteger(args, "socialSetId");
    if (!socialSetId) return idError("socialSetId");
    const draftId = positiveInteger(args, "draftId");
    if (!draftId) return idError("draftId");
    const platforms = reviewedPlatforms(args.platforms);
    if (!platforms.ok) return platforms;
    return {
      ok: true,
      request: {
        method: "PATCH",
        path: `/social-sets/${socialSetId}/drafts/${draftId}`,
        body: { platforms: platforms.value },
      },
    };
  }

  if (toolName === "schedule_draft") {
    const extra = unknownField(args, ["socialSetId", "draftId", "publishAt"]);
    if (extra) return { ok: false, message: `${extra} is not allowed.` };
    const socialSetId = positiveInteger(args, "socialSetId");
    if (!socialSetId) return idError("socialSetId");
    const draftId = positiveInteger(args, "draftId");
    if (!draftId) return idError("draftId");
    if (
      typeof args.publishAt === "string" &&
      args.publishAt.toLowerCase() === "now"
    ) {
      return {
        ok: false,
        message: 'Immediate publication (publishAt "now") is not available.',
      };
    }
    if (!futureDateOrSlot(args.publishAt)) {
      return {
        ok: false,
        message:
          'publishAt must be "next-free-slot" or a future ISO 8601 datetime with timezone.',
      };
    }
    return {
      ok: true,
      request: {
        method: "PATCH",
        path: `/social-sets/${socialSetId}/drafts/${draftId}`,
        body: { publish_at: args.publishAt },
      },
    };
  }

  return {
    ok: false,
    message: `${toolName} is not a tool this connector implements. Refresh the stored tool list.`,
  };
}

function safeRetryAfter(value: string | null): string | null {
  if (!value) return null;
  const bounded = value
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, RETRY_AFTER_CHARS)
    .trim();
  return bounded || null;
}

function safeVendorMessage(body: string, token: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const nested = isRecord(parsed.error) ? parsed.error.message : null;
  const candidates = [parsed.detail, parsed.message, parsed.error, nested];
  const message = candidates.find((value) => typeof value === "string");
  if (typeof message !== "string") return null;
  return message
    .replaceAll(token, "[redacted]")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .slice(0, SAFE_ERROR_CHARS)
    .trim();
}

async function execute(
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
  connection: Connection,
  request: RequestSpec,
): Promise<McpCallResult> {
  if (!connection.token) {
    return failure(
      "No personal Typefully credential was available for this call. Connect your Typefully account and try again.",
    );
  }

  const url = new URL(`${TYPEFULLY_API_URL}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers = new Headers({
    authorization: `Bearer ${connection.token}`,
  });
  const body =
    request.body === undefined ? undefined : JSON.stringify(request.body);
  if (body !== undefined) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return failure("Typefully did not answer in time.");
    }
    return failure("Typefully could not be reached.");
  }

  if (response.status === 401) {
    return failure(
      "Typefully authentication failed (401). Reconnect your personal Typefully account and try again.",
    );
  }
  if (response.status === 429) {
    const retryAfter = safeRetryAfter(response.headers.get("retry-after"));
    return failure(
      retryAfter
        ? `Typefully rate limited this request (429). Retry-After: ${retryAfter}.`
        : "Typefully rate limited this request (429).",
    );
  }

  const responseBody = await response.text();
  if (!response.ok) {
    const detail = safeVendorMessage(responseBody, connection.token);
    return failure(
      detail
        ? `Typefully refused this request (${response.status}): ${detail}`
        : `Typefully refused this request (${response.status}).`,
    );
  }

  let rendered = responseBody;
  if (responseBody.trim() !== "") {
    try {
      rendered = JSON.stringify(JSON.parse(responseBody));
    } catch {
      // A successful non-JSON response is still useful result text and remains bounded below.
    }
  }
  return successful(rendered);
}

export function createTypefullyRestTransport(
  fetchImplementation: FetchImplementation,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    listNeedsCredential,
    listTools,
    async callTool(
      connection: Connection,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<McpCallResult> {
      const built = buildRequest(toolName, args);
      if (!built.ok) return failure(built.message);
      return execute(fetchImplementation, timeoutMs, connection, built.request);
    },
  };
}

export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  return createTypefullyRestTransport(globalThis.fetch).callTool(
    connection,
    toolName,
    args,
  );
}
