import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { boundedActivityText } from "@/lib/channels/mutations";
import { client, tryClient } from "@/lib/client";
import { patchRosterRead } from "@/lib/roster/read-marker";
import { rosterKeys } from "@/lib/roster/queries";
import { botChatKeys, type BotChat } from "./queries";

/**
 * Start a new direct conversation with a Bot.
 *
 * Deliberately not idempotent: every call starts a conversation.
 */
export function createBotChatMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<BotChat> =>
      client<BotChat>("/api/bot-chats", "botChat", {
        method: "POST",
        body: { agentId },
        fallback: "Could not start this conversation",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: rosterKeys.all }),
  });
}

/**
 * Thrown by `adoptBotChatMutationOptions` when the server answers `POST /api/bot-chats/adopt` with a
 * 409 — see `mapStoreError` in server/src/bot-chats/routes.ts, which answers `BotChatThreadTakenError`
 * with this one status for two different reasons at once (a thread somebody else already owns, and a
 * thread this same person already owns but soft-deleted), deliberately, so a caller here cannot and
 * need not tell them apart.
 *
 * A dedicated type rather than a plain `Error` because `useLegacyThreadAdoption`
 * (app/src/lib/copilot/bot-thread.ts) has to treat exactly this one status as a success — somebody
 * already has the thread, which is the outcome adoption wanted — while every other failure has to keep
 * the remembered thread id for a retry. `client` (app/src/lib/client.ts) throws a plain `Error` built
 * only from the response body's message, with no status attached, so telling the two apart used to mean
 * comparing the server's exact sentence — a check that breaks silently the moment that sentence is
 * reworded. Going through `tryClient` and constructing this only when `response.status === 409` means
 * the caller can ask `instanceof AdoptConflictError` and get a real answer instead of a guess.
 */
export class AdoptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdoptConflictError";
  }
}

/**
 * Adopt a thread the browser still remembers from before the roster existed, giving it a chat row.
 *
 * Idempotent on purpose: two tabs holding the same remembered thread both try to adopt it, and the
 * server's unique constraint gives them back the same row rather than minting two.
 *
 * Goes through `tryClient` rather than `client`, unlike every other mutation in this file: the caller
 * needs to know whether a failure was specifically a 409, and `client` never surfaces the status, only
 * a message built from it. See `AdoptConflictError`.
 */
export function adoptBotChatMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      agentId: string;
      threadId: string;
    }): Promise<BotChat> => {
      const response = await tryClient("/api/bot-chats/adopt", {
        method: "POST",
        body: variables,
      });

      if (response.ok) {
        return ((await response.json()) as { botChat: BotChat }).botChat;
      }

      // Same extraction `client` does: the server's own message names the reason, which is worth
      // surfacing over a generic fallback when it sent one.
      const message = await response
        .json()
        .then((body: { error?: string }) => body.error)
        .catch(() => undefined);

      if (response.status === 409) {
        throw new AdoptConflictError(
          message ?? "That conversation is no longer available.",
        );
      }
      throw new Error(message ?? "Could not open this conversation");
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: rosterKeys.all }),
  });
}

/**
 * Report the last thing said in a bot chat.
 *
 * The client that ran the agent already has the message before platform replay can return it; the
 * runtime exposes no run-completion hook and its run endpoint returns before the reply exists.
 *
 * NOTHING WAITS ON IT AND NOTHING RETRIES — a failed preview update is a stale roster line, not a
 * lost message — BUT A REFUSAL IS NOT ALLOWED TO BE INVISIBLE, and it used to be. This went through
 * `tryClient` with the response dropped unread, so `400 "Text is too long."`, a 413 on an oversized
 * body, a 400 on a bad timestamp, a 404 for a row deleted in another tab, a 401 on an expired
 * session and any 500 were all byte-for-byte indistinguishable from the 204 that means it worked.
 * What that costs is not cosmetic: this route is the only thing that clears `archived_at`, so the
 * promise that saying something in an archived conversation brings it back was being broken in
 * silence — the person spoke, the Bot answered, the conversation stayed archived, and there was no
 * dot, no banner, no console line and no retry to tell them their model of the app was now wrong.
 * `client` turns every one of those into a throw carrying whatever the server said, `onError` writes
 * the line, and a caller that wants to put a sentence on the screen now has an error to hang it on.
 *
 * WHY THE TITLE REFETCH LIVES HERE, in the mutation's own `onSuccess`, driven by a flag in the
 * variables rather than by per-call callbacks at the call site. `useBotChatActivity` reports both
 * directions of one conversation through a single `useMutation`, which is a single
 * `MutationObserver`, and query-core's `MutationObserver.mutate` keeps per-call callbacks in one
 * field and detaches the observer from whatever mutation is still in flight (@tanstack/query-core
 * 5.102.2, `mutationObserver.js`: `this.#mutateOptions = options` then
 * `this.#currentMutation?.removeObserver(this)`). So the Bot's reply — reported moments after the
 * person's turn, and reported with no callbacks of its own — used to cancel the person's: the
 * refetch was silently dropped on exactly the slow connection that makes two reports overlap, and
 * the roster went on showing the Bot's name for every conversation with that Bot. A mutation's own
 * `onSuccess` is invoked by the mutation (`mutation.js`: `await this.options.onSuccess?.(…)`), not
 * by the observer, so there is nothing for a later call to overwrite or detach.
 */
export function recordBotChatActivityMutationOptions(
  queryClient: QueryClient,
  /**
   * Told, with the conversation's id, that this report did not leave the conversation with a title.
   *
   * Either because the report never landed, or because it landed and the refetch behind it still
   * found `title === null`. `useBotChatActivity` answers it by re-arming the watcher's
   * `firstFromPerson` flag, so the next thing the person says asks again — see the flag's docblock
   * in activity.ts for why one report was not enough. Optional because a caller that reports without
   * ever setting `derivesTitle` has nothing to re-arm.
   */
  onTitleStillMissing?: (botChatId: string) => void,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      botChatId: string;
      text: string;
      agentId: string | null;
      at: string;
      /**
       * Whether this is the report the server may derive the conversation's title from — a person's
       * first words in a conversation that has none yet. Client-side intent only: the server decides
       * the title for itself from the message, and the body below is unchanged by it. "May" and not
       * "does": `onSuccess` checks what actually came back rather than assuming.
       */
      derivesTitle: boolean;
    }) => {
      await client(`/api/bot-chats/${variables.botChatId}/activity`, {
        method: "POST",
        body: {
          agentId: variables.agentId,
          at: variables.at,
          /*
           * Cut to the length the route accepts rather than sent whole and refused: this is a
           * preview, and a report refused for its length loses the timestamp and the un-archiving
           * with it. See `boundedActivityText`, which the channel's reporter shares.
           */
          text: boundedActivityText(variables.text),
        },
        fallback: "Could not update this conversation's roster line.",
      });
    },
    onSuccess: async (_data, variables) => {
      if (!variables.derivesTitle) return;
      /*
       * `title` is derived server-side from the message this report just delivered, and nothing else
       * in this app would ever hear about it: the socket's activity event carries the preview and the
       * timestamp but not the name, and this deployment turns `refetchOnWindowFocus` off. The detail
       * query is what the open screen's header reads; the roster is what the sidebar row reads.
       *
       * After the write rather than beside it, so the refetch reads the title instead of racing it.
       */
      await queryClient.invalidateQueries({
        queryKey: botChatKeys.detail(variables.botChatId),
      });
      // Not awaited, unlike the detail query above: nothing here reads the roster back, the row it
      // refreshes is drawn by the sidebar, and awaiting three infinite lists would hold this
      // mutation pending for no reader.
      void queryClient.invalidateQueries({ queryKey: rosterKeys.all });

      /*
       * AND THEN LOOK, because a 204 means the server was TOLD about a message, not that it named
       * the conversation from it. The two decisions are made by different code on different rules:
       * this browser calls a message "words" with `.trim()`, and the server calls it words with
       * `flatten`, which strips `\p{Cc}\p{Cf}\p{Cs}` first. A first message of nothing but
       * zero-width characters passes the trim, is reported, spends the one refetch, and leaves
       * `title` null — and the person's NEXT message does get titled server-side, since that write
       * is guarded on `WHERE title IS NULL`, so a real title then sat in the database while the
       * header and the sidebar row showed the Bot's name for the rest of the session.
       *
       * The invalidation above is awaited, so by here the cache holds what the refetch found and the
       * signal costs nothing extra. Anything other than a string — including no cached row at all,
       * which is what an inactive detail query leaves — re-arms rather than latches: an extra refetch
       * on the next message is cheap, and a roster line stuck on the Bot's name is not.
       */
      const titled = queryClient.getQueryData<BotChat>(
        botChatKeys.detail(variables.botChatId),
      )?.title;
      if (typeof titled !== "string") {
        onTitleStillMissing?.(variables.botChatId);
      }
    },
    onError: (error, variables) => {
      /*
       * The structured shape `use-channel-events.ts` uses for the same kind of failure: one nothing
       * can recover from, which is exactly why it has to be said. The note is written for whoever
       * reads it in a report from a person who says their conversation would not come back.
       */
      console.error(
        JSON.stringify({
          type: "bot-chat-activity-not-recorded",
          botChatId: variables.botChatId,
          error: error.message,
          note: "This tab could not tell the server what was just said in this conversation. The message itself is unaffected, but the roster line keeps its previous preview and timestamp, and an archived conversation stays archived until something is said in it that does reach the server.",
        }),
      );
      // The server never heard the message, so it cannot have titled the conversation from it.
      if (variables.derivesTitle) onTitleStillMissing?.(variables.botChatId);
    },
  });
}

/** Pin or unpin a bot chat for this member. A marker, not a reorder, so no optimistic sort. */
export function setBotChatPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { botChatId: string; pinned: boolean }) => {
      await client(`/api/bot-chats/${variables.botChatId}/pin`, {
        method: "PUT",
        body: { pinned: variables.pinned },
        fallback: "Could not pin this conversation",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: rosterKeys.all }),
  });
}

/**
 * Stamp a bot chat read for this member, patching the cache before the wire answers.
 *
 * Patched in onMutate rather than refetched on success: the dot must clear the instant the chat
 * opens, not a round-trip later. No rollback on failure and no invalidation — a mark-read that did
 * not land is a dot that returns on the next refetch, which is the truth reasserting itself, and a
 * refetch here would race the socket's own patches for nothing.
 *
 * Patches all three status lists: unlike a channel, which has one cache to patch, a bot chat's row can
 * be sitting in Active, Archived, or All, and the read has to clear wherever it is.
 */
export function markBotChatReadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (botChatId: string) => {
      await client(`/api/bot-chats/${botChatId}/read`, {
        method: "PUT",
        fallback: "Could not mark this conversation read",
      });
    },
    onMutate: (botChatId) => {
      patchRosterRead(queryClient, botChatId);
    },
  });
}

/**
 * Archive or restore a bot chat for this member. Hidden, not frozen: the conversation stays live.
 *
 * Invalidates rather than patches, because the row moves between the Active, Archived, and All lists
 * and a patch would leave it in two of them at once — that is a page-membership change, which a patch
 * to one row's fields cannot express.
 *
 * `rosterKeys.all` ONLY, and the same as the channel's archive for the same reason. This used to
 * invalidate `botChatKeys.detail` as well, justified by "the Bot chat screen renders `archived`
 * straight off it" — it does not, and never did: the only readers of `archived` anywhere in the
 * browser are the sidebar row and its menu, both off `RosterItem`. So the extra refetch bought
 * nothing a person could see, while making the open screen re-read a row on every archive from
 * anywhere, which is what forced its "not here any more" guard to reason carefully about a failed
 * refetch. If an archived indicator ever does belong on the screen, this is the invalidation to
 * bring back — with the reader that justifies it, in the same change.
 */
export function setBotChatArchivedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { botChatId: string; archived: boolean }) => {
      await client(`/api/bot-chats/${variables.botChatId}/archive`, {
        method: "PUT",
        body: { archived: variables.archived },
        fallback: variables.archived
          ? "Could not archive this conversation"
          : "Could not restore this conversation",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: rosterKeys.all }),
  });
}

/** Soft-delete a bot chat. The server keeps the transcript; the roster forgets. */
export function deleteBotChatMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (botChatId: string) => {
      await client(`/api/bot-chats/${botChatId}`, {
        method: "DELETE",
        fallback: "Could not delete this conversation",
      });
    },
    // The roster only, and deliberately not the detail query — which archive above does not
    // invalidate either, but for a different reason worth keeping straight. Archive leaves the row
    // exactly where it was and simply has no reader for the refetch to serve; this one has no row
    // left at all. The open chat's detail query would refetch into the fresh 404 and flash an error
    // before the navigate-home lands, so even gaining a reader would not make this one safe.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: rosterKeys.all }),
  });
}
