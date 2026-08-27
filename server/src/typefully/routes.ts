import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { checkNavigationTarget } from "../computer/target";
import { ConnectionRequiredError, PluginRefusedError } from "../plugins/store";
import { draftSummary } from "./document";
import {
  BotNotAttachedError,
  DraftNotFoundError,
  GrantRequiredError,
  SyncInProgressError,
  type TypefullyDraft,
  type TypefullyStore,
  VersionConflictError,
} from "./store";

const MAX_JSON_BYTES = 1_000_000;
const MAX_MEDIA_BYTES = 25_000_000;
const MAX_ERROR_CHARS = 500;
const MEDIA_UPLOAD_TIMEOUT_MS = 30_000;
const MAX_MULTIPART_BYTES = MAX_MEDIA_BYTES + 1_000_000;
const ALLOWED_MEDIA = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
]);

type MediaDescriptor = TypefullyDraft["document"]["media"][number];

class MediaTooLargeError extends Error {}

function summary(draft: TypefullyDraft) {
  return draftSummary({
    id: draft.id,
    document: draft.document,
    version: draft.version,
    syncStatus: draft.syncStatus,
    socialSetLabel: draft.document.accountLabel,
  });
}

function authoritative(draft: TypefullyDraft) {
  return {
    id: draft.id,
    document: draft.document,
    version: draft.version,
    contentHash: draft.contentHash,
    remoteDraftId: draft.remoteDraftId,
    remoteVersion: draft.remoteVersion,
    remoteHash: draft.remoteHash,
    syncStatus: draft.syncStatus,
    lastError: draft.lastError,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function remoteState(draft: TypefullyDraft) {
  return {
    state: draft.syncStatus,
    remoteDraftId: draft.remoteDraftId,
    confirmedVersion: draft.remoteVersion,
    confirmedHash: draft.remoteHash,
  };
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return (
    Array.from(
      value
        .normalize("NFKC")
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
      .slice(0, MAX_ERROR_CHARS)
      .join("") || "The remote operation failed."
  );
}

function retryAt(message: string): string | undefined {
  const match = message.match(/Retry-After:\s*(.+?)(?:\.\s*$|$)/i);
  if (!match) return undefined;
  const value = match[1]?.trim() ?? "";
  const now = Date.now();
  const seconds = /^\d{1,8}$/.test(value) ? Number(value) : null;
  const requested =
    seconds === null
      ? Date.parse(value)
      : now + Math.min(seconds, 86_400) * 1_000;
  if (!Number.isFinite(requested) || requested <= now) return undefined;
  return new Date(Math.min(requested, now + 86_400_000)).toISOString();
}

function errorResponse(
  context: Context<{ Variables: AppVariables }>,
  error: unknown,
) {
  if (error instanceof DraftNotFoundError) {
    return context.json({ code: error.code }, 404);
  }
  if (error instanceof VersionConflictError) {
    return context.json(
      {
        code: error.code,
        currentVersion: error.currentVersion,
        currentHash: error.currentHash,
      },
      409,
    );
  }
  if (error instanceof BotNotAttachedError) {
    return context.json({ code: error.code }, 409);
  }
  if (error instanceof GrantRequiredError) {
    return context.json({ code: error.code, ref: error.ref }, 403);
  }
  if (error instanceof SyncInProgressError) {
    return context.json({ code: error.code }, 409);
  }
  if (error instanceof ConnectionRequiredError) {
    return context.json(
      {
        code: error.code,
        serverId: error.serverId,
        connectPath: error.connectPath,
      },
      409,
    );
  }
  if (error instanceof PluginRefusedError) {
    return context.json(
      { code: "remote_refused", message: safeError(error) },
      403,
    );
  }
  return context.json(
    { code: "invalid_request", message: safeError(error) },
    400,
  );
}

async function jsonBody(context: {
  req: { raw: Request; json(): Promise<unknown> };
}) {
  const declared = Number(context.req.raw.headers.get("content-length") ?? 0);
  if (declared > MAX_JSON_BYTES) throw new Error("Request body is too large.");
  const body = await context.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("A JSON object is required.");
  }
  return body as Record<string, unknown>;
}

async function synchronize(
  store: TypefullyStore,
  draftId: string,
  actorId: string,
  expected?: { version: number; hash: string },
) {
  const outcome = await store.syncDraft({
    draftId,
    actorId,
    expectedVersion: expected?.version,
    expectedHash: expected?.hash,
  });
  if (outcome.result.isError) {
    const message = safeError(outcome.result.text);
    return {
      ok: false as const,
      draft: outcome.draft,
      error: {
        code: "remote_error" as const,
        ...(retryAt(message) ? { retryAt: retryAt(message) } : {}),
        message,
      },
    };
  }
  return { ok: true as const, draft: outcome.draft };
}

function remoteMediaTarget(text: string): { id: string; uploadUrl: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Typefully returned an invalid media upload response.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Typefully returned an invalid media upload response.");
  }
  const record = parsed as Record<string, unknown>;
  const id = record.id ?? record.media_id;
  const uploadUrl = record.upload_url ?? record.uploadUrl;
  if (
    (typeof id !== "string" && typeof id !== "number") ||
    typeof uploadUrl !== "string" ||
    Array.from(String(id)).length > 240 ||
    Array.from(uploadUrl).length > 4_096
  ) {
    throw new Error("Typefully returned an invalid media upload response.");
  }
  let url: URL;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw new Error("Typefully returned an invalid media upload URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Typefully returned an invalid media upload URL.");
  }
  const target = checkNavigationTarget(url.toString());
  if (!target.allowed) {
    throw new Error("Typefully returned an unsafe media upload URL.");
  }
  return { id: String(id), uploadUrl: target.url };
}

async function uploadMediaBytes(file: File, uploadUrl: string): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": file.type },
    body: file,
    redirect: "manual",
    signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => {});
  if (!response.ok) {
    throw new Error(`Typefully media upload failed (${response.status}).`);
  }
}

async function boundedFormData(request: Request): Promise<FormData> {
  const declared = request.headers.get("content-length");
  if (
    declared &&
    /^\d+$/.test(declared) &&
    Number(declared) > MAX_MULTIPART_BYTES
  ) {
    await request.body?.cancel().catch(() => {});
    throw new MediaTooLargeError();
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_MULTIPART_BYTES) {
        await reader.cancel().catch(() => {});
        throw new MediaTooLargeError();
      }
      chunks.push(value);
    }
  }
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw new Error("A multipart form is required.");
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return await new Response(joined.buffer as ArrayBuffer, {
    headers: { "content-type": contentType },
  }).formData();
}

export function createTypefullyRoutes(
  store: TypefullyStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);

  routes.post("/drafts", async (context) => {
    try {
      const body = await jsonBody(context);
      if (
        typeof body.channelId !== "string" ||
        typeof body.botId !== "string"
      ) {
        throw new Error("channelId and botId are required.");
      }
      const draft = await store.createDraft({
        ownerUserId: context.var.actor.id,
        channelId: body.channelId,
        botId: body.botId,
        document: body.document,
        requireGrant: true,
      });
      return context.json({ draft: summary(draft) }, 201);
    } catch (error) {
      if (error instanceof DraftNotFoundError) {
        return context.json({ code: "channel_forbidden" }, 403);
      }
      return errorResponse(context, error);
    }
  });

  routes.get("/drafts/:id", async (context) => {
    try {
      const draft = await store.readDraft(
        context.req.param("id"),
        context.var.actor.id,
      );
      return context.json({ draft: authoritative(draft) });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  routes.put("/drafts/:id", async (context) => {
    try {
      const body = await jsonBody(context);
      if (!Number.isSafeInteger(body.expectedVersion)) {
        throw new Error("expectedVersion must be an integer.");
      }
      const saved = await store.saveDraft({
        draftId: context.req.param("id"),
        actorId: context.var.actor.id,
        expectedVersion: body.expectedVersion as number,
        document: body.document,
      });
      if (saved.syncStatus === "grant_blocked") {
        return context.json({
          draft: summary(saved),
          remote: remoteState(saved),
        });
      }
      try {
        const synced = await synchronize(
          store,
          saved.id,
          context.var.actor.id,
          {
            version: saved.version,
            hash: saved.contentHash,
          },
        );
        if (!synced.ok) {
          return context.json(
            {
              draft: summary(synced.draft),
              remote: remoteState(synced.draft),
              ...synced.error,
            },
            502,
          );
        }
        return context.json({
          draft: summary(synced.draft),
          remote: remoteState(synced.draft),
        });
      } catch (error) {
        if (error instanceof ConnectionRequiredError) {
          return context.json({
            draft: summary(saved),
            remote: { ...remoteState(saved), state: "connection_required" },
          });
        }
        if (
          error instanceof GrantRequiredError ||
          error instanceof BotNotAttachedError ||
          error instanceof SyncInProgressError
        ) {
          return context.json({
            draft: summary(saved),
            remote: remoteState(saved),
          });
        }
        throw error;
      }
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  routes.post("/drafts/:id/sync", async (context) => {
    const draftId = context.req.param("id");
    try {
      const synced = await synchronize(store, draftId, context.var.actor.id);
      if (!synced.ok) {
        return context.json(
          {
            ...synced.error,
            draft: summary(synced.draft),
            remote: remoteState(synced.draft),
          },
          502,
        );
      }
      return context.json({
        draft: summary(synced.draft),
        remote: remoteState(synced.draft),
      });
    } catch (error) {
      if (error instanceof ConnectionRequiredError) {
        return context.json(
          {
            code: error.code,
            serverId: error.serverId,
            draftId,
            connectPath: error.connectPath,
          },
          409,
        );
      }
      return errorResponse(context, error);
    }
  });

  routes.post("/drafts/:id/media", async (context) => {
    try {
      const form = await boundedFormData(context.req.raw);
      const file = form.get("file");
      const expectedVersion = Number(form.get("expectedVersion"));
      const kind = form.get("kind");
      const altText = form.get("altText");
      const retryMediaId = form.get("mediaId");
      if (!(file instanceof File) || file.size > MAX_MEDIA_BYTES) {
        return context.json({ code: "media_too_large" }, 413);
      }
      if (!ALLOWED_MEDIA.has(file.type)) {
        return context.json({ code: "unsupported_media" }, 415);
      }
      if (
        !Number.isSafeInteger(expectedVersion) ||
        (kind !== "image" && kind !== "video") ||
        typeof altText !== "string"
      ) {
        throw new Error("Invalid media fields.");
      }
      const current = await store.readDraft(
        context.req.param("id"),
        context.var.actor.id,
      );
      const existing =
        typeof retryMediaId === "string" && retryMediaId
          ? current.document.media.find((item) => item.id === retryMediaId)
          : undefined;
      if (retryMediaId && !existing) throw new DraftNotFoundError();
      if (existing && expectedVersion !== current.version) {
        throw new VersionConflictError(current.version, current.contentHash);
      }
      const media: MediaDescriptor = existing ?? {
        id: randomUUID(),
        kind,
        order: current.document.media.length,
        altText,
        remoteId: null,
      };
      const saved = existing
        ? current
        : await store.saveDraft({
            draftId: current.id,
            actorId: context.var.actor.id,
            expectedVersion,
            document: {
              ...current.document,
              media: [...current.document.media, media],
            },
          });
      try {
        const remote = await store.callRemoteTool({
          draftId: current.id,
          actorId: context.var.actor.id,
          toolName: "upload_media",
          args: {
            socialSetId: Number(saved.document.socialSetId),
            fileName: file.name,
          },
        });
        if (remote.isError) {
          const failed = await store.recordRemoteFailure({
            draftId: saved.id,
            actorId: context.var.actor.id,
            expectedVersion: saved.version,
            error: remote.text,
          });
          return context.json(
            {
              code: "remote_error",
              message: safeError(remote.text),
              draft: summary(failed),
              media,
            },
            502,
          );
        }
        const target = remoteMediaTarget(remote.text);
        await uploadMediaBytes(file, target.uploadUrl);
        const confirmedMedia = { ...media, remoteId: target.id };
        const confirmed = await store.saveDraft({
          draftId: saved.id,
          actorId: context.var.actor.id,
          expectedVersion: saved.version,
          document: {
            ...saved.document,
            media: saved.document.media.map((item) =>
              item.id === media.id ? confirmedMedia : item,
            ),
          },
        });
        const synced = await synchronize(
          store,
          confirmed.id,
          context.var.actor.id,
          { version: confirmed.version, hash: confirmed.contentHash },
        );
        if (!synced.ok) {
          return context.json(
            {
              ...synced.error,
              draft: summary(synced.draft),
              media: confirmedMedia,
            },
            502,
          );
        }
        return context.json(
          { draft: summary(synced.draft), media: confirmedMedia },
          201,
        );
      } catch (error) {
        if (error instanceof ConnectionRequiredError) {
          return context.json(
            {
              draft: summary(saved),
              media,
              remote: { state: "connection_required" },
            },
            201,
          );
        }
        if (
          error instanceof GrantRequiredError ||
          error instanceof BotNotAttachedError ||
          error instanceof PluginRefusedError
        ) {
          return errorResponse(context, error);
        }
        const failed = await store.recordRemoteFailure({
          draftId: saved.id,
          actorId: context.var.actor.id,
          expectedVersion: saved.version,
          error,
        });
        return context.json(
          {
            code: "remote_error",
            message: safeError(error),
            draft: summary(failed),
            media,
          },
          502,
        );
      }
    } catch (error) {
      if (error instanceof MediaTooLargeError) {
        return context.json({ code: "media_too_large" }, 413);
      }
      return errorResponse(context, error);
    }
  });

  routes.delete("/drafts/:id/media/:mediaId", async (context) => {
    try {
      const body = await jsonBody(context);
      if (!Number.isSafeInteger(body.expectedVersion)) {
        throw new Error("expectedVersion must be an integer.");
      }
      const current = await store.readDraft(
        context.req.param("id"),
        context.var.actor.id,
      );
      const descriptor = current.document.media.find(
        (item) => item.id === context.req.param("mediaId"),
      );
      if (!descriptor) throw new DraftNotFoundError();
      await store.authorizeTool({
        draftId: current.id,
        actorId: context.var.actor.id,
        toolName: "remove_media",
      });
      if (descriptor.remoteId !== null && current.remoteDraftId !== null) {
        const removed = await store.callRemoteTool({
          draftId: current.id,
          actorId: context.var.actor.id,
          toolName: "remove_media",
          args: {
            socialSetId: Number(current.document.socialSetId),
            draftId: Number(current.remoteDraftId),
            platform: current.document.destinations[0],
            postIndex: 0,
            mediaId: descriptor.remoteId,
          },
        });
        if (removed.isError) {
          return context.json(
            { code: "remote_error", message: safeError(removed.text) },
            502,
          );
        }
      }
      const media = current.document.media.filter(
        (item) => item.id !== context.req.param("mediaId"),
      );
      const draft = await store.saveDraft({
        draftId: current.id,
        actorId: context.var.actor.id,
        expectedVersion: body.expectedVersion as number,
        document: { ...current.document, media },
      });
      return context.json({
        draft: summary(draft),
        remote: remoteState(draft),
      });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  return routes;
}
