import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";
import {
  inputSchemaFor,
  parseTypefullyCall,
  TYPEFULLY_TOOL_NAMES,
  type TypefullyCall,
  type TypefullyToolName,
} from "./typefully-contracts";

const TYPEFULLY_API_URL = "https://api.typefully.com/v2";
const REQUEST_TIMEOUT_MS = 30_000;
const SAFE_MESSAGE_CHARS = 400;
const SAFE_ERROR_BODY_BYTES = 8_192;
const RETRY_AFTER_CHARS = 120;
const AUTHORITATIVE_DRAFT_BYTES = 1_000_000;

type Connection = { url: string; token?: string };
type FetchImplementation = typeof globalThis.fetch;

const TOOL_DESCRIPTIONS: Record<TypefullyToolName, string> = {
  list_social_sets:
    "List the Typefully social sets your personal account can access.",
  list_drafts: "List drafts in one Typefully social set.",
  get_draft: "Get one Typefully draft.",
  create_draft:
    "Create an unscheduled or inertly planned Typefully draft. This tool cannot publish immediately.",
  update_draft:
    "Update reviewed fields on a Typefully draft. This tool cannot publish immediately.",
  upload_media:
    "Request a presigned Typefully media-upload URL. This only initiates the upload and never accepts file bytes.",
  remove_media:
    "Remove one named media reference from an authoritative Typefully draft while preserving its other platform content.",
  schedule_draft:
    'Schedule a draft for a future ISO 8601 datetime or the next free slot. "now" is always refused.',
  delete_draft: "Delete one Typefully draft.",
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const TOOLS = deepFreeze(
  TYPEFULLY_TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: inputSchemaFor(name),
  })) satisfies McpTool[],
);

export const listNeedsCredential = false;

export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return structuredClone(TOOLS) as McpTool[];
}

function failure(text: string, truncated = false): McpCallResult {
  return { text, isError: true, truncated };
}

function safeFailure(message: string): McpCallResult {
  const oneLine = message
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length <= SAFE_MESSAGE_CHARS) return failure(oneLine);
  const suffix = " [truncated]";
  return failure(
    `${oneLine.slice(0, SAFE_MESSAGE_CHARS - suffix.length)}${suffix}`,
    true,
  );
}

type SanitizedText = { text: string; truncated: boolean };

function sanitizeVendorText(
  value: string,
  token: string,
  maxChars: number,
  oneLine = false,
): SanitizedText {
  let text = value.replaceAll(token, "[redacted]");
  if (oneLine) {
    text = text
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function truncationNotice(oneLine = false): string {
  return oneLine
    ? " [truncated: vendor response exceeded the safe limit]"
    : "\n\n[truncated: vendor response exceeded the safe limit]";
}

type BoundedBody = { text: string; truncated: boolean };

function successfulBody(body: BoundedBody, token: string): McpCallResult {
  let rendered = body.text;
  if (!body.truncated && body.text.trim() !== "") {
    try {
      rendered = JSON.stringify(JSON.parse(body.text));
    } catch {
      // Successful plain text is useful too; it is sanitized and bounded below.
    }
  }
  const safe = sanitizeVendorText(rendered, token, MAX_RESULT_CHARS);
  const truncated = body.truncated || safe.truncated;
  const text =
    safe.text.trim() === ""
      ? "The tool returned no content. Nothing was found, so there is nothing here to answer from."
      : `${safe.text}${truncated ? truncationNotice() : ""}`;
  return { text, isError: false, truncated };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RequestSpec = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
};

type ModelPlatform = {
  enabled: boolean;
  posts?: { text: string; mediaIds?: string[] }[];
};

function vendorPlatforms(
  value: Record<string, ModelPlatform | undefined>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [name, platform] of Object.entries(value)) {
    if (!platform) continue;
    const vendorPlatform: Record<string, unknown> = {
      enabled: platform.enabled,
    };
    if (platform.posts !== undefined) {
      vendorPlatform.posts = platform.posts.map((post) => ({
        text: post.text,
        ...(post.mediaIds === undefined
          ? {}
          : { media_ids: [...post.mediaIds] }),
      }));
    }
    mapped[name] = vendorPlatform;
  }
  return mapped;
}

function paginationQuery(args: {
  limit?: number;
  offset?: number;
}): Record<string, string> {
  return {
    ...(args.limit === undefined ? {} : { limit: String(args.limit) }),
    ...(args.offset === undefined ? {} : { offset: String(args.offset) }),
  };
}

function draftBody(args: {
  platforms?: Record<string, ModelPlatform | undefined>;
  draftTitle?: string | null;
  share?: boolean | null;
  planAt?: string | null;
}): Record<string, unknown> {
  return {
    ...(args.platforms === undefined
      ? {}
      : { platforms: vendorPlatforms(args.platforms) }),
    ...(args.draftTitle === undefined ? {} : { draft_title: args.draftTitle }),
    ...(args.share === undefined ? {} : { share: args.share }),
    ...(args.planAt === undefined ? {} : { plan_at: args.planAt }),
  };
}

function buildRequest(
  call: Exclude<TypefullyCall, { toolName: "remove_media" }>,
): RequestSpec {
  switch (call.toolName) {
    case "list_social_sets":
      return {
        method: "GET",
        path: "/social-sets",
        query: paginationQuery(call.args),
      };
    case "list_drafts":
      return {
        method: "GET",
        path: `/social-sets/${call.args.socialSetId}/drafts`,
        query: paginationQuery(call.args),
      };
    case "get_draft":
      return {
        method: "GET",
        path: `/social-sets/${call.args.socialSetId}/drafts/${call.args.draftId}`,
      };
    case "create_draft":
      return {
        method: "POST",
        path: `/social-sets/${call.args.socialSetId}/drafts`,
        body: draftBody(call.args),
      };
    case "update_draft":
      return {
        method: "PATCH",
        path: `/social-sets/${call.args.socialSetId}/drafts/${call.args.draftId}`,
        body: draftBody(call.args),
      };
    case "upload_media":
      return {
        method: "POST",
        path: `/social-sets/${call.args.socialSetId}/media/upload`,
        body: { file_name: call.args.fileName },
      };
    case "schedule_draft":
      return {
        method: "PATCH",
        path: `/social-sets/${call.args.socialSetId}/drafts/${call.args.draftId}`,
        body: { publish_at: call.args.publishAt },
      };
    case "delete_draft":
      return {
        method: "DELETE",
        path: `/social-sets/${call.args.socialSetId}/drafts/${call.args.draftId}`,
      };
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<BoundedBody> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      await reader.cancel();
      total += Math.max(remaining, 0);
      return decodeBody(chunks, total, true);
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return decodeBody(chunks, total, false);
}

function decodeBody(
  chunks: Uint8Array[],
  total: number,
  truncated: boolean,
): BoundedBody {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), truncated };
}

type RawResponse = { response: Response; body: BoundedBody };

async function requestTypefully(
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
  token: string,
  request: RequestSpec,
  successBodyBytes = MAX_RESULT_CHARS,
): Promise<RawResponse | McpCallResult> {
  const url = new URL(`${TYPEFULLY_API_URL}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers = new Headers({ authorization: `Bearer ${token}` });
  const body =
    request.body === undefined ? undefined : JSON.stringify(request.body);
  if (body !== undefined) headers.set("content-type", "application/json");

  let receivedHeaders = false;
  try {
    const response = await fetchImplementation(url, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    receivedHeaders = true;
    const bodyLimit = response.ok
      ? successBodyBytes + token.length
      : SAFE_ERROR_BODY_BYTES + token.length;
    return {
      response,
      body: await readBoundedBody(response, bodyLimit),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return failure("Typefully did not answer in time.");
    }
    return failure(
      receivedHeaders
        ? "Typefully response could not be read."
        : "Typefully could not be reached.",
    );
  }
}

function vendorMessage(body: BoundedBody, token: string): SanitizedText | null {
  if (body.truncated) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const nested = isRecord(parsed.error) ? parsed.error.message : null;
  const candidate = [parsed.detail, parsed.message, parsed.error, nested].find(
    (value): value is string => typeof value === "string",
  );
  return candidate === undefined
    ? null
    : sanitizeVendorText(candidate, token, SAFE_MESSAGE_CHARS, true);
}

function responseResult(raw: RawResponse, token: string): McpCallResult {
  const { response, body } = raw;
  if (response.status === 401) {
    return failure(
      "Typefully authentication failed (401). Reconnect your personal Typefully account and try again.",
    );
  }
  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader
      ? sanitizeVendorText(retryAfterHeader, token, RETRY_AFTER_CHARS, true)
      : null;
    const truncated = body.truncated || retryAfter?.truncated === true;
    const base = retryAfter?.text
      ? `Typefully rate limited this request (429). Retry-After: ${retryAfter.text}.`
      : "Typefully rate limited this request (429).";
    return failure(
      `${base}${truncated ? truncationNotice(true) : ""}`,
      truncated,
    );
  }
  if (!response.ok) {
    const detail = vendorMessage(body, token);
    const truncated = body.truncated || detail?.truncated === true;
    const base = detail?.text
      ? `Typefully refused this request (${response.status}): ${detail.text}`
      : `Typefully refused this request (${response.status}).`;
    return failure(
      `${base}${truncated ? truncationNotice(true) : ""}`,
      truncated,
    );
  }
  return successfulBody(body, token);
}

async function removeMedia(
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
  token: string,
  call: Extract<TypefullyCall, { toolName: "remove_media" }>,
): Promise<McpCallResult> {
  const path = `/social-sets/${call.args.socialSetId}/drafts/${call.args.draftId}`;
  const fetched = await requestTypefully(
    fetchImplementation,
    timeoutMs,
    token,
    { method: "GET", path },
    AUTHORITATIVE_DRAFT_BYTES,
  );
  if (!("response" in fetched)) return fetched;
  if (!fetched.response.ok) return responseResult(fetched, token);
  if (fetched.body.truncated) {
    return failure(
      `Typefully's draft response was too large to update safely.${truncationNotice(true)}`,
      true,
    );
  }

  let draft: unknown;
  try {
    draft = JSON.parse(fetched.body.text);
  } catch {
    return failure("Typefully returned a draft that could not be read safely.");
  }
  if (!isRecord(draft) || !isRecord(draft.platforms)) {
    return failure("Typefully returned a draft without a platforms object.");
  }
  const platform = draft.platforms[call.args.platform];
  if (!isRecord(platform) || !Array.isArray(platform.posts)) {
    return failure("The selected platform has no posts in this draft.");
  }
  const post = platform.posts[call.args.postIndex];
  if (!isRecord(post) || !Array.isArray(post.media_ids)) {
    return failure("The selected post has no attached media.");
  }
  const targetIndex = post.media_ids.indexOf(call.args.mediaId);
  if (targetIndex < 0) {
    return failure("The named media is not attached to the selected post.");
  }

  const preservedPlatforms = structuredClone(draft.platforms);
  const preservedPlatform = preservedPlatforms[call.args.platform];
  if (!isRecord(preservedPlatform) || !Array.isArray(preservedPlatform.posts)) {
    return failure(
      "Typefully returned a draft that could not be updated safely.",
    );
  }
  const preservedPost = preservedPlatform.posts[call.args.postIndex];
  if (!isRecord(preservedPost) || !Array.isArray(preservedPost.media_ids)) {
    return failure(
      "Typefully returned a draft that could not be updated safely.",
    );
  }
  preservedPost.media_ids.splice(targetIndex, 1);

  const patched = await requestTypefully(
    fetchImplementation,
    timeoutMs,
    token,
    {
      method: "PATCH",
      path,
      body: { platforms: preservedPlatforms },
    },
  );
  return "response" in patched ? responseResult(patched, token) : patched;
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
      const parsed = parseTypefullyCall(toolName, args);
      if (!parsed.ok) return safeFailure(parsed.message);
      if (!connection.token) {
        return failure(
          "No personal Typefully credential was available for this call. Connect your Typefully account and try again.",
        );
      }
      if (parsed.call.toolName === "remove_media") {
        return removeMedia(
          fetchImplementation,
          timeoutMs,
          connection.token,
          parsed.call,
        );
      }
      const raw = await requestTypefully(
        fetchImplementation,
        timeoutMs,
        connection.token,
        buildRequest(parsed.call),
      );
      return "response" in raw ? responseResult(raw, connection.token) : raw;
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
