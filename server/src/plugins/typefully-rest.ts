import { checkNavigationTarget } from "../computer/target";
import type {
  PublicationOutcome,
  PublicationVendor,
} from "../typefully/publication";
import { PublicationVerificationError } from "../typefully/publication";
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
const SAFE_ERROR_BODY_CHARS = 2_048;
const RETRY_AFTER_CHARS = 120;
const MAX_REDACTABLE_TOKEN_BYTES = 4_096;
const TYPEFULLY_ACCOUNT_FIELD_CHARS = 200;
const TYPEFULLY_ME_MAX_BYTES = 16_384;
export const TYPEFULLY_REMOVE_MEDIA_MAX_DRAFT_BYTES = 1_000_000;
const TYPEFULLY_MEDIA_STATUS_MAX_BYTES = 32_768;
const TYPEFULLY_MEDIA_PREVIEW_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
]);

export type TypefullyMediaPreviewStatus =
  | { state: "processing"; fileName: string; mime: string }
  | { state: "failed"; fileName: string; mime: string; reason: string }
  | {
      state: "ready";
      fileName: string;
      mime: string;
      url: string;
    };

function boundedMediaField(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const characters = Array.from(value);
  return characters.length <= limit ? value : null;
}

function mediaPreviewStatus(
  value: unknown,
  token: string,
): TypefullyMediaPreviewStatus {
  if (!isRecord(value))
    throw new Error("Typefully returned an invalid media preview response.");
  const fileName = boundedMediaField(value.file_name, 300);
  const mime = boundedMediaField(value.mime, 120);
  const status = boundedMediaField(value.status, 80)?.toLowerCase();
  if (!fileName || !mime || !status || !TYPEFULLY_MEDIA_PREVIEW_MIMES.has(mime))
    throw new Error("Typefully returned an invalid media preview response.");
  if (status === "failed" || status === "error") {
    return {
      state: "failed",
      fileName,
      mime,
      reason:
        boundedMediaField(value.error_reason, 300)?.replaceAll(
          token,
          "[redacted]",
        ) ?? "Typefully could not process this media.",
    };
  }
  const mediaUrls = isRecord(value.media_urls) ? value.media_urls : null;
  const rawUrl = mediaUrls
    ? [
        mediaUrls.original,
        mediaUrls.large,
        mediaUrls.medium,
        mediaUrls.small,
      ].find((candidate): candidate is string => typeof candidate === "string")
    : undefined;
  if (!rawUrl) return { state: "processing", fileName, mime };
  const target = checkNavigationTarget(rawUrl);
  const parsed = target.allowed ? new URL(target.url) : null;
  if (
    !target.allowed ||
    parsed?.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    target.url.includes(token)
  )
    throw new Error("Typefully returned an unsafe media preview response.");
  return { state: "ready", fileName, mime, url: target.url };
}

export function createTypefullyMediaPreviewTransport(
  fetchImplementation: FetchImplementation = globalThis.fetch,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    async getStatus(input: {
      token: string;
      socialSetId: number;
      mediaId: string;
    }): Promise<TypefullyMediaPreviewStatus> {
      const raw = await requestTypefully(
        fetchImplementation,
        timeoutMs,
        input.token,
        {
          method: "GET",
          path: `/social-sets/${input.socialSetId}/media/${encodeURIComponent(input.mediaId)}`,
        },
        { maxBytes: TYPEFULLY_MEDIA_STATUS_MAX_BYTES },
      );
      if (!("response" in raw) || !raw.response.ok || raw.body.truncated)
        throw new Error("Typefully media preview is unavailable.");
      let value: unknown;
      try {
        value = JSON.parse(raw.body.text);
      } catch {
        throw new Error(
          "Typefully returned an invalid media preview response.",
        );
      }
      return mediaPreviewStatus(value, input.token);
    },
  };
}

type Connection = { url: string; token?: string };
type FetchImplementation = typeof globalThis.fetch;

export type TypefullyApiKeyMetadata = {
  accountId: string | null;
  accountLabel: string | null;
  keyLabel: string | null;
};

export type TypefullyApiKeyValidationCode =
  | "invalid_api_key"
  | "validation_timeout"
  | "rate_limited"
  | "validation_unavailable";

/** A bounded, non-secret failure suitable for returning from the connection route. */
export class TypefullyApiKeyValidationError extends Error {
  constructor(
    readonly code: TypefullyApiKeyValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "TypefullyApiKeyValidationError";
  }
}

const TOOL_DESCRIPTIONS: Record<TypefullyToolName, string> = {
  list_social_sets:
    "List the Typefully social sets your personal account can access.",
  list_drafts: "List drafts in one Typefully social set.",
  get_draft: "Get one Typefully draft.",
  create_draft:
    "Create a local OpenBot draft for this channel. It can be edited before Typefully is connected and never publishes immediately.",
  update_draft:
    "Update an existing local OpenBot draft with optimistic versioning. It never publishes immediately.",
  upload_media:
    "Request a presigned Typefully media-upload URL. This only initiates the upload and never accepts file bytes.",
  remove_media: `Remove one named media reference from an authoritative Typefully draft. For safety, this refuses draft responses larger than the ${TYPEFULLY_REMOVE_MEDIA_MAX_DRAFT_BYTES / 1_000_000} MB limit.`,
  delete_draft: "Delete one Typefully draft.",
  prepare_publication:
    "Prepare an immutable, expiring review proposal for one fully synchronized local draft. This never publishes.",
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

function failure(
  text: string,
  truncated = false,
  sideEffectOutcome?: McpCallResult["sideEffectOutcome"],
): McpCallResult {
  return {
    text,
    isError: true,
    truncated,
    ...(sideEffectOutcome ? { sideEffectOutcome } : {}),
  };
}

function safeFailure(message: string): McpCallResult {
  const oneLine = message
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = boundedCharacters(oneLine, SAFE_MESSAGE_CHARS);
  if (!bounded.truncated) return failure(bounded.text);
  const suffix = " [truncated]";
  return failure(
    `${boundedCharacters(oneLine, SAFE_MESSAGE_CHARS - suffix.length).text}${suffix}`,
    true,
  );
}

type SanitizedText = { text: string; truncated: boolean };

function boundedCharacters(
  value: string,
  maxCharacters: number,
): SanitizedText {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) {
    return { text: value, truncated: false };
  }
  return {
    text: characters.slice(0, maxCharacters).join(""),
    truncated: true,
  };
}

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
  return boundedCharacters(text, maxChars);
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
    case "delete_draft":
      return {
        method: "DELETE",
        path: `/social-sets/${call.args.socialSetId}/drafts/${call.args.draftId}`,
      };
    case "prepare_publication":
      throw new Error(
        "prepare_publication is a local review operation and cannot be sent to Typefully.",
      );
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

function boundedAccountField(value: unknown, apiKey: string): string | null {
  if (typeof value !== "string") return null;
  if (value.includes(apiKey)) return null;
  const sanitized = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) return null;
  return boundedCharacters(sanitized, TYPEFULLY_ACCOUNT_FIELD_CHARS).text;
}

/** Validate a personal key against Typefully's pinned identity endpoint before it is persisted. */
export function assertValidTypefullyApiKeyInput(apiKey: string): void {
  const keyBytes = new TextEncoder().encode(apiKey).byteLength;
  if (
    !apiKey.trim() ||
    keyBytes > MAX_REDACTABLE_TOKEN_BYTES ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(apiKey)
  ) {
    throw new TypefullyApiKeyValidationError(
      "invalid_api_key",
      "Enter a valid Typefully API key.",
    );
  }
}

/** Validate a personal key against Typefully's pinned identity endpoint before it is persisted. */
export async function validateTypefullyApiKey(
  apiKey: string,
  fetchImplementation: FetchImplementation = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<TypefullyApiKeyMetadata> {
  assertValidTypefullyApiKeyInput(apiKey);

  let response: Response;
  try {
    response = await fetchImplementation(`${TYPEFULLY_API_URL}/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new TypefullyApiKeyValidationError(
        "validation_timeout",
        "Typefully did not answer in time. Try again.",
      );
    }
    throw new TypefullyApiKeyValidationError(
      "validation_unavailable",
      "Typefully could not be reached to validate this key. Try again.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new TypefullyApiKeyValidationError(
      "invalid_api_key",
      "Typefully did not accept this API key.",
    );
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    throw new TypefullyApiKeyValidationError(
      "rate_limited",
      "Typefully is rate limiting key validation. Try again later.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new TypefullyApiKeyValidationError(
      "validation_unavailable",
      `Typefully could not validate this key (${response.status}). Try again.`,
    );
  }

  let body: BoundedBody;
  try {
    body = await readBoundedBody(response, TYPEFULLY_ME_MAX_BYTES);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new TypefullyApiKeyValidationError(
        "validation_timeout",
        "Typefully did not finish answering in time. Try again.",
      );
    }
    throw new TypefullyApiKeyValidationError(
      "validation_unavailable",
      "Typefully's validation response could not be read. Try again.",
    );
  }
  if (body.truncated) {
    throw new TypefullyApiKeyValidationError(
      "validation_unavailable",
      "Typefully's validation response was too large to read safely.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    throw new TypefullyApiKeyValidationError(
      "validation_unavailable",
      "Typefully returned an unreadable validation response.",
    );
  }
  if (!isRecord(parsed)) {
    throw new TypefullyApiKeyValidationError(
      "validation_unavailable",
      "Typefully returned an invalid validation response.",
    );
  }

  const rawId = parsed.id;
  const accountId =
    typeof rawId === "string" || typeof rawId === "number"
      ? boundedAccountField(String(rawId), apiKey)
      : null;
  return {
    accountId,
    accountLabel: boundedAccountField(parsed.name, apiKey),
    keyLabel: boundedAccountField(parsed.api_key_label, apiKey),
  };
}

type RawResponse = {
  response: Response;
  body: BoundedBody;
  method: RequestSpec["method"];
};
type SuccessBodyLimit = { maxCharacters: number } | { maxBytes: number };

const DEFINITE_REFUSAL_STATUSES = new Set([
  400, 401, 402, 403, 404, 409, 422, 429,
]);

function sideEffectOutcome(
  method: RequestSpec["method"],
  status?: number,
): NonNullable<McpCallResult["sideEffectOutcome"]> {
  return method === "GET" ||
    (status !== undefined && DEFINITE_REFUSAL_STATUSES.has(status))
    ? "definitely_not_applied"
    : "uncertain";
}

async function requestTypefully(
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
  token: string,
  request: RequestSpec,
  successBodyLimit: SuccessBodyLimit = { maxCharacters: MAX_RESULT_CHARS },
): Promise<RawResponse | McpCallResult> {
  const tokenBytes = new TextEncoder().encode(token).byteLength;
  if (tokenBytes > MAX_REDACTABLE_TOKEN_BYTES) {
    return failure(
      "The personal Typefully credential is too large to handle safely. Reconnect the account with a valid API key.",
    );
  }
  const url = new URL(`${TYPEFULLY_API_URL}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers = new Headers({ authorization: `Bearer ${token}` });
  const body =
    request.body === undefined ? undefined : JSON.stringify(request.body);
  if (body !== undefined) headers.set("content-type", "application/json");

  let response: Response | null = null;
  try {
    response = await fetchImplementation(url, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bodyLimit = response.ok
      ? "maxBytes" in successBodyLimit
        ? successBodyLimit.maxBytes
        : successBodyLimit.maxCharacters * 4 + tokenBytes
      : SAFE_ERROR_BODY_CHARS * 4 + tokenBytes;
    return {
      response,
      body: await readBoundedBody(response, bodyLimit),
      method: request.method,
    };
  } catch (error) {
    const outcome = sideEffectOutcome(request.method, response?.status);
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return failure("Typefully did not answer in time.", false, outcome);
    }
    return failure(
      response
        ? "Typefully response could not be read."
        : "Typefully could not be reached.",
      false,
      outcome,
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
  const { response, body, method } = raw;
  if (response.status === 401) {
    return failure(
      "Typefully authentication failed (401). Reconnect your personal Typefully account and try again.",
      false,
      sideEffectOutcome(method, response.status),
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
      sideEffectOutcome(method, response.status),
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
      sideEffectOutcome(method, response.status),
    );
  }
  return successfulBody(body, token);
}

type NormalizedPlatform = {
  enabled: boolean;
  posts?: Record<string, unknown>[];
  settings?: Record<string, unknown>;
};

type NormalizedPlatformResult =
  | { ok: true; platform: NormalizedPlatform }
  | { ok: false };

function copyOptionalString(
  source: Record<string, unknown>,
  sourceKey: string,
  target: Record<string, unknown>,
  targetKey = sourceKey,
  maxCharacters = 2_048,
): boolean {
  if (!Object.hasOwn(source, sourceKey)) return true;
  const value = source[sourceKey];
  if (value === null) return true;
  if (typeof value !== "string" || Array.from(value).length > maxCharacters) {
    return false;
  }
  target[targetKey] = value;
  return true;
}

function copyOptionalBoolean(
  source: Record<string, unknown>,
  key: string,
  target: Record<string, unknown>,
): boolean {
  if (!Object.hasOwn(source, key)) return true;
  const value = source[key];
  if (value === null) return true;
  if (typeof value !== "boolean") return false;
  target[key] = value;
  return true;
}

function normalizeResponsePost(
  platformName: Extract<
    TypefullyCall,
    { toolName: "remove_media" }
  >["args"]["platform"],
  rawPost: unknown,
): { ok: true; post: Record<string, unknown> } | { ok: false } {
  if (!isRecord(rawPost)) return { ok: false };
  if (
    typeof rawPost.text !== "string" ||
    Array.from(rawPost.text).length > 50_000
  ) {
    return { ok: false };
  }
  const post: Record<string, unknown> = { text: rawPost.text };
  if (Object.hasOwn(rawPost, "media_ids") && rawPost.media_ids !== null) {
    if (
      !Array.isArray(rawPost.media_ids) ||
      rawPost.media_ids.length > 10 ||
      rawPost.media_ids.some(
        (mediaId) =>
          typeof mediaId !== "string" ||
          mediaId.length < 1 ||
          Array.from(mediaId).length > 240,
      )
    ) {
      return { ok: false };
    }
    post.media_ids = [...rawPost.media_ids];
  }
  if (!copyOptionalBoolean(rawPost, "hide_link_preview", post)) {
    return { ok: false };
  }

  if (platformName === "x") {
    if (
      !copyOptionalString(rawPost, "quote_post_url", post) ||
      !copyOptionalBoolean(rawPost, "subscribers_only", post) ||
      !copyOptionalBoolean(rawPost, "paid_partnership", post) ||
      !copyOptionalBoolean(rawPost, "made_with_ai", post)
    ) {
      return { ok: false };
    }
  }
  if (
    platformName === "linkedin" &&
    !copyOptionalString(
      rawPost,
      "linkedin_reshare_urn",
      post,
      "linkedin_reshare_target",
      1_024,
    )
  ) {
    return { ok: false };
  }
  return { ok: true, post };
}

function normalizeResponseSettings(
  platformName: Extract<
    TypefullyCall,
    { toolName: "remove_media" }
  >["args"]["platform"],
  rawSettings: unknown,
): { ok: true; settings: Record<string, unknown> } | { ok: false } {
  if (!isRecord(rawSettings)) return { ok: false };
  const settings: Record<string, unknown> = {};
  if (
    platformName === "x" &&
    (!copyOptionalString(rawSettings, "reply_to_url", settings) ||
      !copyOptionalString(
        rawSettings,
        "community_id",
        settings,
        "community_id",
        512,
      ) ||
      !copyOptionalBoolean(rawSettings, "share_with_followers", settings))
  ) {
    return { ok: false };
  }
  return { ok: true, settings };
}

function normalizeSelectedPlatform(
  platformName: Extract<
    TypefullyCall,
    { toolName: "remove_media" }
  >["args"]["platform"],
  rawPlatform: unknown,
): NormalizedPlatformResult {
  if (!isRecord(rawPlatform) || typeof rawPlatform.enabled !== "boolean") {
    return { ok: false };
  }
  const platform: NormalizedPlatform = { enabled: rawPlatform.enabled };
  if (Object.hasOwn(rawPlatform, "posts")) {
    if (
      !Array.isArray(rawPlatform.posts) ||
      rawPlatform.posts.length < 1 ||
      rawPlatform.posts.length > 50
    ) {
      return { ok: false };
    }
    const posts: Record<string, unknown>[] = [];
    for (const rawPost of rawPlatform.posts) {
      const normalized = normalizeResponsePost(platformName, rawPost);
      if (!normalized.ok) return normalized;
      posts.push(normalized.post);
    }
    platform.posts = posts;
  } else if (rawPlatform.enabled) {
    return { ok: false };
  }
  if (Object.hasOwn(rawPlatform, "settings") && rawPlatform.settings !== null) {
    const normalized = normalizeResponseSettings(
      platformName,
      rawPlatform.settings,
    );
    if (!normalized.ok) return normalized;
    if (Object.keys(normalized.settings).length > 0) {
      platform.settings = normalized.settings;
    }
  }
  return { ok: true, platform };
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
    { maxBytes: TYPEFULLY_REMOVE_MEDIA_MAX_DRAFT_BYTES },
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
  const normalized = normalizeSelectedPlatform(
    call.args.platform,
    draft.platforms[call.args.platform],
  );
  if (!normalized.ok) {
    return failure(
      "Typefully returned a selected platform that could not be updated safely.",
    );
  }
  const posts = normalized.platform.posts;
  if (!posts)
    return failure("The selected platform has no posts in this draft.");
  const post = posts[call.args.postIndex];
  if (!isRecord(post) || !Array.isArray(post.media_ids)) {
    return failure("The selected post has no attached media.");
  }
  const targetIndex = post.media_ids.indexOf(call.args.mediaId);
  if (targetIndex < 0) {
    return failure("The named media is not attached to the selected post.");
  }

  post.media_ids.splice(targetIndex, 1);

  const patched = await requestTypefully(
    fetchImplementation,
    timeoutMs,
    token,
    {
      method: "PATCH",
      path,
      body: {
        platforms: { [call.args.platform]: normalized.platform },
      },
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
      if (parsed.call.toolName === "prepare_publication") {
        return failure(
          "prepare_publication is a local review operation and cannot be sent to Typefully.",
          false,
          "definitely_not_applied",
        );
      }
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

function publicationOutcomeFromBody(
  body: string,
  fallbackId: number,
  destinations: ("x" | "linkedin")[],
  includePublishedUrl = false,
): Pick<PublicationOutcome, "vendorResultId" | "publishedUrl"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { vendorResultId: String(fallbackId) };
  }
  if (!isRecord(parsed)) return { vendorResultId: String(fallbackId) };
  const rawId = parsed.id ?? parsed.draft_id;
  const platformFields = {
    x: "x_published_url",
    linkedin: "linkedin_published_url",
  } as const;
  const rawUrl = includePublishedUrl
    ? (["x", "linkedin"] as const)
        .filter((destination) => destinations.includes(destination))
        .map((destination) => parsed[platformFields[destination]])
        .find((value): value is string => {
          if (typeof value !== "string" || Array.from(value).length > 500) {
            return false;
          }
          try {
            return new URL(value).protocol === "https:";
          } catch {
            return false;
          }
        })
    : undefined;
  return {
    vendorResultId:
      typeof rawId === "string" || typeof rawId === "number"
        ? String(rawId)
        : String(fallbackId),
    ...(typeof rawUrl === "string" ? { publishedUrl: rawUrl } : {}),
  };
}

function publicationFailureDetail(
  document: Record<string, unknown>,
  token: string,
): string {
  const nested = isRecord(document.error) ? document.error.message : undefined;
  const raw = [document.error, nested, document.detail, document.message].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return raw
    ? sanitizeVendorText(raw, token, SAFE_MESSAGE_CHARS, true).text
    : "Typefully reports that publication failed.";
}

function officialPublicationOutcome(
  document: unknown,
  token: string,
  fallbackId: number,
  destinations: ("x" | "linkedin")[],
): PublicationOutcome {
  if (!isRecord(document)) return { outcome: "unknown" };
  const publishState = document.publish_state;
  const status = document.status;
  if (status === "error" || publishState === "error") {
    return {
      outcome: "failed",
      ...publicationOutcomeFromBody(
        JSON.stringify(document),
        fallbackId,
        destinations,
      ),
      detail: publicationFailureDetail(document, token),
    };
  }
  if (publishState === "finished" && status === "published") {
    return {
      outcome: "published",
      ...publicationOutcomeFromBody(
        JSON.stringify(document),
        fallbackId,
        destinations,
        true,
      ),
    };
  }
  return {
    outcome: "unknown",
    ...publicationOutcomeFromBody(
      JSON.stringify(document),
      fallbackId,
      destinations,
    ),
    detail:
      "Typefully is still publishing. Reconcile before taking any further action.",
  };
}

/** Dedicated server-only publication transport. It is deliberately absent from `listTools`. */
export function createTypefullyPublicationVendor(
  fetchImplementation: FetchImplementation = globalThis.fetch,
  options: { timeoutMs?: number } = {},
): PublicationVendor {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function get(input: {
    token: string;
    socialSetId: number;
    remoteDraftId: number;
    destinations: ("x" | "linkedin")[];
  }) {
    const raw = await requestTypefully(
      fetchImplementation,
      timeoutMs,
      input.token,
      {
        method: "GET",
        path: `/social-sets/${input.socialSetId}/drafts/${input.remoteDraftId}`,
      },
      { maxBytes: TYPEFULLY_REMOVE_MEDIA_MAX_DRAFT_BYTES },
    );
    const result = "response" in raw ? responseResult(raw, input.token) : raw;
    if (result.isError) {
      const failureClass = result.text.includes("did not answer in time")
        ? "remote_timeout"
        : "response" in raw &&
            DEFINITE_REFUSAL_STATUSES.has(raw.response.status)
          ? "remote_refused"
          : "remote_unavailable";
      throw new PublicationVerificationError(failureClass);
    }
    try {
      return JSON.parse(result.text) as unknown;
    } catch {
      throw new PublicationVerificationError("remote_invalid_response");
    }
  }

  return {
    fetchDraft: async (input) => ({ document: await get(input) }),
    publishDraft: async (input) => {
      const raw = await requestTypefully(
        fetchImplementation,
        timeoutMs,
        input.token,
        {
          method: "PATCH",
          path: `/social-sets/${input.socialSetId}/drafts/${input.remoteDraftId}`,
          body: { publish_at: "now" },
        },
      );
      const result = "response" in raw ? responseResult(raw, input.token) : raw;
      if (result.isError) {
        return {
          outcome:
            result.sideEffectOutcome === "definitely_not_applied"
              ? "failed"
              : "unknown",
          detail: result.text,
        };
      }
      let document: unknown;
      try {
        document = JSON.parse(result.text);
      } catch {
        return {
          outcome: "unknown",
          detail:
            "Typefully accepted the publish request but returned an unreadable status. Reconcile before taking any further action.",
        };
      }
      return officialPublicationOutcome(
        document,
        input.token,
        input.remoteDraftId,
        input.destinations,
      );
    },
    reconcileDraft: async (input) => {
      const document = await get(input);
      return officialPublicationOutcome(
        document,
        input.token,
        input.remoteDraftId,
        input.destinations,
      );
    },
  };
}
