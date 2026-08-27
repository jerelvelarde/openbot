import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { checkNavigationTarget } from "../computer/target";
import { readBoundedJson } from "../http/bounded-json";
import { ConnectionRequiredError, PluginRefusedError } from "../plugins/store";
import { createTypefullyMediaPreviewTransport } from "../plugins/typefully-rest";
import { draftSummary } from "./document";
import {
  type MediaUploadDependencies,
  uploadPresignedMedia,
} from "./media-upload";
import {
  ProposalStateError,
  type PublicationProposal,
  PublicationVerificationError,
} from "./publication";
import {
  BotNotAttachedError,
  DraftNotFoundError,
  GrantRequiredError,
  ReconciliationRequiredError,
  SyncInProgressError,
  type TypefullyDraft,
  type TypefullyStore,
  VersionConflictError,
} from "./store";

const MAX_JSON_BYTES = 1_000_000;
const MAX_MEDIA_BYTES = 25_000_000;
const MAX_ERROR_CHARS = 500;
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

function proposalView(proposal: PublicationProposal) {
  return {
    id: proposal.id,
    draftId: proposal.draftId,
    version: proposal.version,
    destinations: proposal.destinations,
    expiresAt: proposal.expiresAt,
    status: proposal.status,
    snapshot: proposal.snapshot,
    contentHash: proposal.contentHash,
    decidedAt: proposal.decidedAt,
    completedAt: proposal.completedAt,
    vendorResultId: proposal.vendorResultId,
    publishedUrl: proposal.publishedUrl,
    failureDetail: proposal.failureDetail,
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
  draftId?: string,
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
  if (error instanceof ReconciliationRequiredError) {
    return context.json(
      {
        code: error.code,
        draftId: error.draftId,
        message: safeError(error),
      },
      409,
    );
  }
  if (error instanceof ProposalStateError) {
    return context.json(
      { code: error.code, message: safeError(error) },
      error.status,
    );
  }
  if (error instanceof PublicationVerificationError) {
    const status =
      error.failureClass === "remote_timeout"
        ? 504
        : error.failureClass === "remote_unavailable"
          ? 503
          : 502;
    return context.json(
      { code: error.failureClass, message: safeError(error) },
      status,
    );
  }
  if (error instanceof ConnectionRequiredError) {
    return context.json(
      {
        code: error.code,
        serverId: error.serverId,
        ...(draftId ? { draftId } : {}),
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

function persistedMediaFailureResponse(
  context: Context<{ Variables: AppVariables }>,
  error: unknown,
  draft: TypefullyDraft,
  media: MediaDescriptor,
) {
  const authority = { draft: summary(draft), media };
  if (error instanceof ConnectionRequiredError) {
    return context.json(
      {
        code: error.code,
        serverId: error.serverId,
        draftId: draft.id,
        connectPath: error.connectPath,
        ...authority,
      },
      409,
    );
  }
  if (error instanceof GrantRequiredError) {
    return context.json(
      { code: error.code, ref: error.ref, ...authority },
      403,
    );
  }
  if (error instanceof BotNotAttachedError) {
    return context.json({ code: error.code, ...authority }, 409);
  }
  if (error instanceof PluginRefusedError) {
    return context.json(
      {
        code: "remote_refused",
        message: safeError(error),
        ...authority,
      },
      403,
    );
  }
  if (error instanceof SyncInProgressError) {
    return context.json({ code: error.code, ...authority }, 409);
  }
  if (error instanceof ReconciliationRequiredError) {
    return context.json(
      {
        code: error.code,
        draftId: error.draftId,
        message: safeError(error),
        ...authority,
      },
      409,
    );
  }
  return context.json(
    {
      code: "remote_error",
      message: safeError(error),
      ...authority,
    },
    502,
  );
}

async function jsonBody(context: {
  req: { raw: Request; json(): Promise<unknown> };
}) {
  const body = await readBoundedJson(context.req.raw, MAX_JSON_BYTES);
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
  attemptId?: string,
) {
  const outcome = await store.syncDraft({
    draftId,
    actorId,
    expectedVersion: expected?.version,
    expectedHash: expected?.hash,
    attemptId,
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

async function uploadMediaBytes(
  file: File,
  uploadUrl: string,
  dependencies?: MediaUploadDependencies,
): Promise<void> {
  await uploadPresignedMedia(file, uploadUrl, dependencies);
}

async function withMediaHeartbeat<T>(
  store: TypefullyStore,
  input: { draftId: string; actorId: string; attemptId: string },
  operation: () => Promise<T>,
): Promise<T> {
  const first = await store.renewMediaAttempt(input);
  let heartbeatError: unknown;
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight || heartbeatError) return;
    inFlight = store
      .renewMediaAttempt(input)
      .then(() => {})
      .catch((error) => {
        heartbeatError = error;
      })
      .finally(() => {
        inFlight = null;
      });
  }, first.renewAfterMs);
  timer.unref?.();
  try {
    const result = await operation();
    if (inFlight) await inFlight;
    if (heartbeatError) throw heartbeatError;
    await store.renewMediaAttempt(input);
    return result;
  } finally {
    clearInterval(timer);
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
  options: {
    mediaUpload?: MediaUploadDependencies;
    mediaPreview?: ReturnType<typeof createTypefullyMediaPreviewTransport>;
  } = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const mediaPreview =
    options.mediaPreview ?? createTypefullyMediaPreviewTransport();
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

  routes.post("/drafts/:id/copy", async (context) => {
    const sourceDraftId = context.req.param("id");
    try {
      const body = await jsonBody(context);
      const source = await store.readDraft(sourceDraftId, context.var.actor.id);
      const copied = await store.createDraft({
        ownerUserId: context.var.actor.id,
        channelId: source.channelId,
        botId: source.botId,
        document: body.document,
        requireGrant: true,
      });
      return context.json({ draft: summary(copied) }, 201);
    } catch (error) {
      return errorResponse(context, error, sourceDraftId);
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
      return errorResponse(context, error, context.req.param("id"));
    }
  });

  routes.get("/drafts/:id/media/:mediaId/preview", async (context) => {
    const draftId = context.req.param("id");
    context.header("cache-control", "private, no-store");
    context.header("referrer-policy", "no-referrer");
    try {
      const authorized = await store.authorizeMediaPreview({
        draftId,
        actorId: context.var.actor.id,
      });
      const descriptor = authorized.draft.document.media.find(
        (item) => item.id === context.req.param("mediaId"),
      );
      if (!descriptor?.remoteId) throw new DraftNotFoundError();
      const socialSetId = authorized.draft.document.socialSetId;
      if (
        typeof socialSetId !== "string" ||
        !/^\d+$/.test(socialSetId) ||
        !Number.isSafeInteger(Number(socialSetId)) ||
        Number(socialSetId) < 1
      )
        throw new Error("This draft has no valid Typefully social set.");
      const status = await mediaPreview.getStatus({
        token: authorized.token,
        socialSetId: Number(socialSetId),
        mediaId: descriptor.remoteId,
      });
      if (status.state === "processing")
        return context.json(
          { state: "processing", fileName: status.fileName, mime: status.mime },
          202,
        );
      if (status.state === "failed")
        return context.json(
          {
            state: "failed",
            fileName: status.fileName,
            mime: status.mime,
            reason: safeError(status.reason),
          },
          422,
        );
      if (
        (descriptor.kind === "image" && !status.mime.startsWith("image/")) ||
        (descriptor.kind === "video" && !status.mime.startsWith("video/"))
      )
        throw new Error("Typefully returned a mismatched media preview.");
      if (context.req.query("status") === "1")
        return context.json({ state: "ready", mime: status.mime });
      return new Response(null, {
        status: 302,
        headers: {
          "cache-control": "private, no-store",
          location: status.url,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return errorResponse(context, error, draftId);
    }
  });

  routes.put("/drafts/:id", async (context) => {
    const draftId = context.req.param("id");
    try {
      const body = await jsonBody(context);
      if (!Number.isSafeInteger(body.expectedVersion)) {
        throw new Error("expectedVersion must be an integer.");
      }
      const saved = await store.saveDraft({
        draftId,
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
      return errorResponse(context, error, draftId);
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
      return errorResponse(context, error, draftId);
    }
  });

  routes.post("/drafts/:id/reconcile", async (context) => {
    const draftId = context.req.param("id");
    try {
      const body = await jsonBody(context);
      if (
        !Number.isSafeInteger(body.expectedVersion) ||
        typeof body.remoteDraftId !== "string"
      ) {
        throw new Error("expectedVersion and remoteDraftId are required.");
      }
      const draft = await store.reconcileUncertainCreate({
        draftId,
        actorId: context.var.actor.id,
        expectedVersion: body.expectedVersion as number,
        remoteDraftId: body.remoteDraftId,
      });
      return context.json({
        draft: summary(draft),
        remote: remoteState(draft),
      });
    } catch (error) {
      return errorResponse(context, error, draftId);
    }
  });

  routes.post("/drafts/:id/proposals", async (context) => {
    const draftId = context.req.param("id");
    try {
      const body = await jsonBody(context);
      if (!Number.isSafeInteger(body.expectedVersion)) {
        throw new Error("expectedVersion must be an integer.");
      }
      const proposal = await store.prepareProposal({
        draftId,
        actorId: context.var.actor.id,
        expectedVersion: body.expectedVersion as number,
      });
      return context.json({ proposal }, 201);
    } catch (error) {
      return errorResponse(context, error, draftId);
    }
  });

  routes.get("/proposals/:id", async (context) => {
    try {
      const proposal = await store.readProposal(
        context.req.param("id"),
        context.var.actor.id,
      );
      return context.json({ proposal: proposalView(proposal) });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  routes.post("/proposals/:id/decline", async (context) => {
    try {
      const proposal = await store.declineProposal(
        context.req.param("id"),
        context.var.actor.id,
      );
      return context.json({ proposal: proposalView(proposal) });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  routes.post("/proposals/:id/publish", async (context) => {
    try {
      const proposal = await store.approveAndPublish({
        proposalId: context.req.param("id"),
        actorId: context.var.actor.id,
      });
      return context.json({ proposal: proposalView(proposal) });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  routes.post("/proposals/:id/reconcile", async (context) => {
    try {
      const proposal = await store.reconcileProposal({
        proposalId: context.req.param("id"),
        actorId: context.var.actor.id,
      });
      return context.json({ proposal: proposalView(proposal) });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  routes.post("/drafts/:id/media", async (context) => {
    let persistedDraft: TypefullyDraft | null = null;
    let authoritativeMedia: MediaDescriptor | null = null;
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
      await store.authorizeTool({
        draftId: current.id,
        actorId: context.var.actor.id,
        toolName: "upload_media",
      });
      const media: MediaDescriptor = existing ?? {
        id: randomUUID(),
        kind,
        order: current.document.media.length,
        altText,
        remoteId: null,
      };
      authoritativeMedia = media;
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
      persistedDraft = saved;
      const attempt = await store.beginMediaAttempt({
        draftId: saved.id,
        actorId: context.var.actor.id,
        toolName: "upload_media",
        expectedVersion: saved.version,
        expectedHash: saved.contentHash,
      });
      let remoteInitiated = false;
      let initiatedMedia: MediaDescriptor | null = null;
      try {
        const heartbeat = {
          draftId: current.id,
          actorId: context.var.actor.id,
          attemptId: attempt.attemptId,
        };
        const remote = await withMediaHeartbeat(store, heartbeat, () =>
          store.callRemoteTool({
            draftId: current.id,
            actorId: context.var.actor.id,
            toolName: "upload_media",
            attemptId: attempt.attemptId,
            args: {
              socialSetId: Number(saved.document.socialSetId),
              fileName: file.name,
            },
          }),
        );
        if (remote.isError) {
          if (remote.sideEffectOutcome === "uncertain") {
            remoteInitiated = true;
            throw new Error(remote.text);
          }
          const failed = await store.recordRemoteFailure({
            draftId: saved.id,
            actorId: context.var.actor.id,
            expectedVersion: saved.version,
            attemptId: attempt.attemptId,
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
        remoteInitiated = true;
        const target = remoteMediaTarget(remote.text);
        await store.recordMediaInitiation({
          ...heartbeat,
          remoteMediaId: target.id,
        });
        const confirmedMedia = { ...media, remoteId: target.id };
        initiatedMedia = confirmedMedia;
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
        await withMediaHeartbeat(store, heartbeat, () =>
          uploadMediaBytes(file, target.uploadUrl, options.mediaUpload),
        );
        const synced = await synchronize(
          store,
          confirmed.id,
          context.var.actor.id,
          { version: confirmed.version, hash: confirmed.contentHash },
          attempt.attemptId,
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
        if (remoteInitiated) {
          const uncertain = await store.markMediaOutcomeUncertain({
            draftId: saved.id,
            actorId: context.var.actor.id,
            attemptId: attempt.attemptId,
            error,
          });
          return context.json(
            {
              code: "reconciliation_required",
              draftId: saved.id,
              message:
                "The media upload outcome is uncertain. Confirm it in Typefully or remove the media before retrying.",
              draft: summary(uncertain),
              media: initiatedMedia ?? media,
            },
            409,
          );
        }
        if (error instanceof ConnectionRequiredError) {
          const failed = await store.recordRemoteFailure({
            draftId: saved.id,
            actorId: context.var.actor.id,
            expectedVersion: saved.version,
            attemptId: attempt.attemptId,
            error,
          });
          return persistedMediaFailureResponse(context, error, failed, media);
        }
        if (
          error instanceof GrantRequiredError ||
          error instanceof BotNotAttachedError ||
          error instanceof PluginRefusedError
        ) {
          const failed = await store.recordRemoteFailure({
            draftId: saved.id,
            actorId: context.var.actor.id,
            expectedVersion: saved.version,
            attemptId: attempt.attemptId,
            error,
          });
          return persistedMediaFailureResponse(context, error, failed, media);
        }
        const failed = await store.recordRemoteFailure({
          draftId: saved.id,
          actorId: context.var.actor.id,
          expectedVersion: saved.version,
          attemptId: attempt.attemptId,
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
      if (persistedDraft && authoritativeMedia) {
        return persistedMediaFailureResponse(
          context,
          error,
          persistedDraft,
          authoritativeMedia,
        );
      }
      return errorResponse(context, error, context.req.param("id"));
    }
  });

  routes.delete("/drafts/:id/media/:mediaId", async (context) => {
    const draftId = context.req.param("id");
    let saved: TypefullyDraft | null = null;
    let mediaAttemptId: string | null = null;
    let remoteRemovalsSucceeded = 0;
    try {
      const body = await jsonBody(context);
      if (!Number.isSafeInteger(body.expectedVersion)) {
        throw new Error("expectedVersion must be an integer.");
      }
      const current = await store.readDraft(draftId, context.var.actor.id);
      const descriptor = current.document.media.find(
        (item) => item.id === context.req.param("mediaId"),
      );
      if (!descriptor) throw new DraftNotFoundError();
      await store.authorizeTool({
        draftId: current.id,
        actorId: context.var.actor.id,
        toolName: "remove_media",
      });
      const media = current.document.media.filter(
        (item) => item.id !== context.req.param("mediaId"),
      );
      saved = await store.saveDraft({
        draftId: current.id,
        actorId: context.var.actor.id,
        expectedVersion: body.expectedVersion as number,
        document: { ...current.document, media },
      });
      const attempt = await store.beginMediaAttempt({
        draftId: saved.id,
        actorId: context.var.actor.id,
        toolName: "remove_media",
        expectedVersion: saved.version,
        expectedHash: saved.contentHash,
      });
      mediaAttemptId = attempt.attemptId;
      if (descriptor.remoteId !== null && current.remoteDraftId !== null) {
        for (const platform of current.document.destinations) {
          for (const [postIndex] of current.document.posts.entries()) {
            const removed = await withMediaHeartbeat(
              store,
              {
                draftId: current.id,
                actorId: context.var.actor.id,
                attemptId: attempt.attemptId,
              },
              () =>
                store.callRemoteTool({
                  draftId: current.id,
                  actorId: context.var.actor.id,
                  toolName: "remove_media",
                  attemptId: attempt.attemptId,
                  args: {
                    socialSetId: Number(current.document.socialSetId),
                    draftId: Number(current.remoteDraftId),
                    platform,
                    postIndex,
                    mediaId: descriptor.remoteId,
                  },
                }),
            );
            if (removed.isError) {
              const failed = await store.recordRemoteFailure({
                draftId: saved.id,
                actorId: context.var.actor.id,
                expectedVersion: saved.version,
                expectedHash: saved.contentHash,
                attemptId: attempt.attemptId,
                error:
                  remoteRemovalsSucceeded > 0
                    ? `A partial remote media removal completed before the remaining operation failed: ${safeError(removed.text)}`
                    : removed.text,
              });
              return context.json(
                {
                  code: "remote_error",
                  message: safeError(removed.text),
                  draft: summary(failed),
                  remote: remoteState(failed),
                },
                502,
              );
            }
            remoteRemovalsSucceeded += 1;
          }
        }
      }
      await store.renewMediaAttempt({
        draftId: saved.id,
        actorId: context.var.actor.id,
        attemptId: attempt.attemptId,
      });
      const synced = await synchronize(
        store,
        saved.id,
        context.var.actor.id,
        {
          version: saved.version,
          hash: saved.contentHash,
        },
        attempt.attemptId,
      );
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
      if (saved && mediaAttemptId && !(error instanceof SyncInProgressError)) {
        const failed = await store.recordRemoteFailure({
          draftId: saved.id,
          actorId: context.var.actor.id,
          expectedVersion: saved.version,
          expectedHash: saved.contentHash,
          ...(mediaAttemptId ? { attemptId: mediaAttemptId } : {}),
          error:
            remoteRemovalsSucceeded > 0
              ? `A partial remote media removal completed before the remaining operation failed: ${safeError(error)}`
              : error,
        });
        if (
          error instanceof ConnectionRequiredError ||
          error instanceof GrantRequiredError ||
          error instanceof BotNotAttachedError ||
          error instanceof PluginRefusedError
        ) {
          return errorResponse(context, error, draftId);
        }
        return context.json(
          {
            code: "remote_error",
            message: safeError(error),
            draft: summary(failed),
            remote: remoteState(failed),
          },
          502,
        );
      }
      return errorResponse(context, error, draftId);
    }
  });

  return routes;
}
