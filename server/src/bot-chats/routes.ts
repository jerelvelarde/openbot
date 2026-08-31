/**
 * HTTP surface for a person's own conversations with one Bot.
 *
 * SHAPED AFTER `createChannelRoutes`, deliberately, for the same reason `bot-chats/store.ts` is
 * shaped after `createChannelStore`: a bot chat and a channel are read by one roster, and any
 * behaviour that differs between the two route files shows up as a roster whose rows behave
 * differently depending on which kind they are.
 *
 * Every route is scoped to the caller by `requireUser` and by the store underneath it. A row
 * belonging to somebody else is reported exactly as a row that does not exist — 404, never 403 —
 * because the store already answers that way and this file has no business telling the two apart.
 */
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AgentNotFoundError } from "../agents/profile-store";
import { type AuditStore, createAuditRecorder } from "../audit";
import type { AppVariables } from "../auth/guards";
import {
  MAX_ACTIVITY_BODY_BYTES,
  parseActivityInput,
} from "../channels/routes";
import {
  type BotChat,
  BotChatNotFoundError,
  type BotChatStore,
  BotChatThreadTakenError,
} from "./store";

type BotChatInputObject = Record<string, unknown>;

function isBotChatInputObject(input: unknown): input is BotChatInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

type CreateInputParseResult =
  | { ok: true; value: { agentId: string } }
  | { ok: false; error: string };

/** Parses `POST /`'s body. Not exported: nothing outside this file needs to test it in isolation. */
function parseCreateInput(input: unknown): CreateInputParseResult {
  if (!isBotChatInputObject(input)) {
    return { ok: false, error: "Bot chat input must be a JSON object." };
  }
  const { agentId } = input as { agentId?: unknown };
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    return { ok: false, error: "Agent ID must be a non-empty string." };
  }
  return { ok: true, value: { agentId: agentId.trim() } };
}

/**
 * A UUID-shaped string, nothing more.
 *
 * Not the format `thread-identity.ts` mints: adoption also has to accept a thread minted by a
 * different deployment, or minted before this one had a name, and `identity.owns` is false for both
 * without either meaning the thread is not real. The shape check exists only to keep a string that
 * could not possibly be a thread id from reaching the database at all.
 */
const PLAUSIBLE_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AdoptInputParseResult =
  | { ok: true; value: { agentId: string; threadId: string } }
  | { ok: false; error: string };

export function parseAdoptInput(input: unknown): AdoptInputParseResult {
  if (!isBotChatInputObject(input)) {
    return { ok: false, error: "Adopt input must be a JSON object." };
  }
  const { agentId, threadId } = input as {
    agentId?: unknown;
    threadId?: unknown;
  };
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    return { ok: false, error: "Agent ID must be a non-empty string." };
  }
  if (typeof threadId !== "string") {
    return { ok: false, error: "Thread ID must be a thread id." };
  }
  const trimmedThreadId = threadId.trim();
  if (!PLAUSIBLE_THREAD_ID.test(trimmedThreadId)) {
    return { ok: false, error: "Thread ID must be a thread id." };
  }

  return {
    ok: true,
    value: { agentId: agentId.trim(), threadId: trimmedThreadId },
  };
}

export function createBotChatRoutes(
  store: BotChatStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Where an archive, a restore and a delete are written. Absent in tests that do not care about the
   * trail, and the routes still work without it — `createChannelRoutes` takes it the same way, last
   * and optional, for the same reason.
   */
  auditStore?: AuditStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Write one row to the trail, tolerantly. See `createAuditRecorder` for every reason it behaves
   * this way, including why a refused act and a repeat click both write nothing.
   */
  const record = createAuditRecorder(auditStore, {
    type: "bot_chat",
    logType: "bot-chat-audit-write-failed",
    logIdKey: "botChatId",
  });

  routes.post("/", requireUser, async (context) => {
    const parsed = parseCreateInput(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      const botChat = await store.create(
        context.var.actor,
        parsed.value.agentId,
      );
      return context.json({ botChat: botChatDto(botChat) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  // Before `/:id`, or "adopt" is read as an id. `channels/routes.ts` carries the same hazard above
  // its `/events` route.
  routes.post("/adopt", requireUser, async (context) => {
    const parsed = parseAdoptInput(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      const botChat = await store.adopt(
        context.var.actor,
        parsed.value.agentId,
        parsed.value.threadId,
      );
      return context.json({ botChat: botChatDto(botChat) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:id", requireUser, async (context) => {
    try {
      const botChat = await store.get(
        context.var.actor,
        context.req.param("id"),
      );
      if (!botChat) {
        return context.json({ error: "Bot chat not found." }, 404);
      }
      return context.json({ botChat: botChatDto(botChat) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post(
    "/:id/activity",
    requireUser,
    /*
     * The same body limit the channel twin's activity route carries, taken from the same constant, and
     * not a second spelling of it.
     *
     * Two caps, and they are not interchangeable. `parseActivityInput` bounds the message, which is
     * the semantic limit and the one that answers 400; it cannot bound the work in front of it,
     * because `context.req.json()` below has already read and parsed the whole body by the time the
     * parser sees an object. Without this middleware a multi-megabyte body was read and `JSON.parse`d
     * in full and only then answered "Text is too long." — the parser's cap bounded the message and
     * nothing about the body carrying it.
     */
    bodyLimit({
      maxSize: MAX_ACTIVITY_BODY_BYTES,
      // JSON, and named, because every other refusal on these routes is; the default is a plain-text
      // "Payload Too Large" thrown as an exception, which a client parsing our error shape cannot
      // read. The same status and the same message the channel twin answers with, so a roster's two
      // kinds of row do not answer one oversized report differently.
      onError: (context) =>
        context.json({ error: "Activity body is too large." }, 413),
    }),
    async (context) => {
      const parsed = parseActivityInput(
        await context.req.json().catch(() => null),
      );
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);

      const id = context.req.param("id");
      try {
        const { restored } = await store.recordActivity(
          context.var.actor,
          id,
          parsed.value,
        );
        /*
         * This route restores conversations without anybody asking it to: saying something in an
         * archived one is how it comes back, so an ordinary message clears `archived_at`. Recorded
         * when it actually happened, and named `activity` rather than `explicit`, so the trail can
         * tell a restore somebody pressed from one that fell out of a message — the second is the one
         * whose absence reads as the archive having undone itself. The same two words the channel
         * twin's activity route uses, because they are the same two facts.
         */
        if (restored) {
          await record(context.var.actor.id, "bot_chat.unarchived", id, {
            mechanism: "activity",
          });
        }
        return context.body(null, 204);
      } catch (error) {
        return mapStoreError(context, error);
      }
    },
  );

  routes.put("/:id/pin", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isBotChatInputObject(body)) {
      return context.json({ error: "Pin input must be a JSON object." }, 400);
    }
    const { pinned } = body as { pinned?: unknown };
    if (typeof pinned !== "boolean") {
      return context.json({ error: "Pinned must be true or false." }, 400);
    }

    try {
      await store.setPinned(context.var.actor, context.req.param("id"), pinned);
      return context.json({ pinned });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/:id/read", requireUser, async (context) => {
    try {
      await store.markRead(context.var.actor, context.req.param("id"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/:id/archive", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isBotChatInputObject(body)) {
      return context.json(
        { error: "Archive input must be a JSON object." },
        400,
      );
    }
    const { archived } = body as { archived?: unknown };
    if (typeof archived !== "boolean") {
      return context.json({ error: "Archived must be true or false." }, 400);
    }

    const id = context.req.param("id");
    try {
      const changed = await store.setArchived(context.var.actor, id, archived);
      /*
       * Only when the store moved the flag. `setArchived` answers `false` for a repeat call on a chat
       * already in the requested state, and pressing Archive twice must not lay down two rows for one
       * archiving.
       *
       * The response below is unconditional either way — the caller asked for a state and that state
       * now holds — so a 200 here can coincide with no trail write at all. Deliberate: the HTTP
       * contract answers "is it archived now", not "did this call do the archiving".
       */
      if (changed) {
        await record(
          context.var.actor.id,
          archived ? "bot_chat.archived" : "bot_chat.unarchived",
          id,
          // Named the way `bot_chat.deleted` names its mechanism, and for a sharper reason: the
          // activity route writes `bot_chat.unarchived` too, when somebody speaking in an archived
          // conversation brings it back. Without this a reader cannot tell a decision from a side
          // effect.
          { mechanism: "explicit" },
        );
      }
      return context.json({ archived });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    try {
      await store.softDelete(context.var.actor, id);
      // Named rather than implied: the row and its thread are still there, and a later hard delete
      // would be a different fact about the same conversation. `softDelete` throws for a repeat, so
      // reaching this line is itself the "it happened this time" gate the archive route needs a
      // boolean for.
      await record(context.var.actor.id, "bot_chat.deleted", id, {
        mechanism: "soft",
      });
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

function botChatDto(botChat: BotChat) {
  return {
    id: botChat.id,
    agentId: botChat.agentId,
    threadId: botChat.threadId,
    title: botChat.title,
    active: botChat.active,
    archived: botChat.archived,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Agent not found." }, 404);
  }
  if (error instanceof BotChatNotFoundError) {
    return context.json({ error: "Bot chat not found." }, 404);
  }
  if (error instanceof BotChatThreadTakenError) {
    /*
     * `adopt` throws this for four different situations, not one: a thread that belongs to somebody
     * else, a thread that is the caller's own row but one *they* soft-deleted, a thread that is the
     * caller's own live row with a different Bot (the second, third and fourth bullets of the comment
     * inside `adopt` in bot-chats/store.ts), and a thread that is not a bot chat's at all but a
     * channel's, which the check above those bullets refuses. All four answer with this one message
     * and this one status, deliberately, and not because they have anything in common besides the
     * code:
     *
     *   - the client already treats 409 as success here — it is what clears the remembered thread
     *     id in storage, whichever of the reasons produced it — so one status code correctly serves
     *     all four;
     *   - naming which one happened would tell an outsider adopting a stranger's remembered thread
     *     id whether that thread exists, who deleted it, which Bot it belongs to, and whether it is
     *     a channel they cannot see, which is exactly the kind of probe every other method in this
     *     file (and in the store beneath it) is written to refuse.
     */
    return context.json(
      { error: "That conversation is no longer available." },
      409,
    );
  }
  throw error;
}
