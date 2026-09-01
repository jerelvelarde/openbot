import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { patchRosterRead } from "@/lib/roster/read-marker";
import { rosterKeys } from "@/lib/roster/queries";
import { type AgentChannel, channelKeys, channelPath } from "./queries";

/**
 * Start a new channel with one or more coworkers.
 *
 * Deliberately not idempotent: every call creates a channel with its own thread.
 */
export function createChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    /*
     * Through `client`'s envelope key rather than parsing the response here, which is what this used
     * to do — and what `useStartChannel` (lib/channels/start.ts) then reads `.id` and `.threadId` off
     * the moment it resolves. Parsed out here, outside the guard that holds the `fallback`, a 200
     * carrying a proxy's HTML error page threw a raw `SyntaxError` and an envelope that had drifted
     * resolved `undefined` typed as `AgentChannel` — a mutation that SUCCEEDED, so no screen had an
     * error to render, followed by a `TypeError` on the first field read. See `unwrap` in lib/client.ts.
     */
    mutationFn: (agentIds: string[]): Promise<AgentChannel> =>
      client<AgentChannel>("/api/channels", "channel", {
        method: "POST",
        body: { agentIds },
        fallback: "Could not start a channel",
      }),
    /*
     * channelKeys.all is a prefix of channelKeys.detail, which channelQueryOptions reads;
     * rosterKeys.all is what actually gets the new row into the sidebar.
     *
     * DROPPED RATHER THAN RETURNED, which every sibling below does the opposite of, and the
     * difference is deliberate rather than an oversight. query-core awaits whatever `onSuccess`
     * returns before the mutation settles, and `useStartChannel` (lib/channels/start.ts) awaits
     * `mutateAsync` and then seeds, stashes and navigates — so returning these would hold the
     * navigation, and the composer's `pending` with it, behind a roster refetch plus a refetch of
     * whichever channel detail query is open, which is the channel being navigated away from.
     * Neither result is read by anything in that sequence.
     *
     * A sibling has somewhere for the wait to show instead: `deleteConversation.isPending` is what
     * keeps the menu's button reading "Deleting…" (app-sidebar/roster-row.tsx), and staying pending
     * until the row has actually gone is the honest version of that.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: channelKeys.all });
      void queryClient.invalidateQueries({ queryKey: rosterKeys.all });
    },
  });
}

/**
 * How long a reported message may be, in UTF-16 units, before the route refuses it outright.
 *
 * This side's copy of `MAX_ACTIVITY_TEXT_UNITS` in server/src/channels/routes.ts — a copy because
 * nothing under `app` imports from `server`, and here for the same reason the server keeps it in its
 * own channels file: the bot chat activity route reads a body of this shape and turns away the same
 * sizes, so `bot-chats/mutations.ts` imports this one rather than restating it and the two reporters
 * cannot drift apart on this side either.
 *
 * If the two SIDES drift, the report comes back `400 "Text is too long."` — which the reporters now
 * say out loud instead of dropping, so the drift is a console line rather than a silence.
 */
export const MAX_ACTIVITY_TEXT_UNITS = 16_000;

/**
 * The reported text, cut down to what the route will accept.
 *
 * A report is a PREVIEW, not the message: the server keeps 200 code points of it for the roster row
 * and the first 80 for a bot chat's title, and the transcript is held by whoever owns it. So a
 * message over the cap is worth reporting shortened, where sending it whole is worth nothing at all
 * — the route refuses the whole request, and with it the timestamp, the preview, and the
 * `archived_at` clear that is how saying something in an archived conversation brings it back.
 *
 * Cut in UTF-16 units and never through the middle of an astral character, the same rule and the
 * same reason as `boundedInput` in server/src/roster/preview.ts: the server strips a lone surrogate
 * to a space, so a cut that split a pair would render a space where a character used to be.
 */
export function boundedActivityText(text: string): string {
  if (text.length <= MAX_ACTIVITY_TEXT_UNITS) return text;
  const last = text.charCodeAt(MAX_ACTIVITY_TEXT_UNITS - 1);
  const splitsAPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(
    0,
    splitsAPair ? MAX_ACTIVITY_TEXT_UNITS - 1 : MAX_ACTIVITY_TEXT_UNITS,
  );
}

/**
 * Report the last thing said in a channel.
 *
 * The client that ran the agent already has the message before platform replay can return it; the
 * runtime exposes no run-completion hook and its run endpoint returns before the reply exists.
 *
 * Still fire-and-forget in the sense that matters: nothing waits on it, nothing retries, and a
 * failed preview update is a stale roster line rather than a lost message. What it is no longer is
 * SILENT. This went through `tryClient` with the response dropped unread, which made a 400 on a bad
 * timestamp, a 413, a 401 on an expired session and any 500 byte-for-byte indistinguishable from the
 * 204 that means it worked — and a rejection, which is what being offline actually produces, equally
 * so. `client` turns all of those into one throw carrying whatever the server said, and `onError`
 * writes the line: the shape `use-channel-events.ts` established for a failure nothing can recover
 * from, which is exactly why it has to be said out loud.
 */
export function recordChannelActivityMutationOptions() {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      text: string;
      agentId: string | null;
      at: string;
    }) => {
      await client(`${channelPath(variables.channelId)}/activity`, {
        method: "POST",
        body: {
          agentId: variables.agentId,
          at: variables.at,
          text: boundedActivityText(variables.text),
        },
        fallback: "Could not update this channel's roster line.",
      });
    },
    onError: (error, variables) => {
      console.error(
        JSON.stringify({
          type: "channel-activity-not-recorded",
          channelId: variables.channelId,
          error: error.message,
          note: "This tab could not tell the server what was just said in this channel. The message itself is unaffected; the channel's roster line keeps its previous preview and timestamp until something else moves it.",
        }),
      );
    },
  });
}

/** Pin or unpin a channel for this member. A marker, not a reorder, so no optimistic sort. */
export function setChannelPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { channelId: string; pinned: boolean }) => {
      await client(`${channelPath(variables.channelId)}/pin`, {
        method: "PUT",
        body: { pinned: variables.pinned },
        fallback: "Could not pin this channel",
      });
    },
    // rosterKeys.all only: a pin changes the roster row's `pinned` flag and where it sorts, nothing
    // in the AgentChannel detail payload that channelQueryOptions reads, so there is nothing in
    // channelKeys worth refetching over this.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: rosterKeys.all }),
  });
}

/**
 * Stamp a channel read for this member, patching the cache before the wire answers.
 *
 * Patched in onMutate rather than refetched on success: the dot must clear the instant the channel
 * opens, not a round-trip later. No rollback on failure and no invalidation — a mark-read that did
 * not land is a dot that returns on the next refetch, which is the truth reasserting itself, and a
 * refetch here would race the socket's own patches for nothing.
 *
 * Patches only the three roster status lists, via `patchRosterRead`: the sidebar is the one reader
 * of a channel's unread state, and it reads the roster.
 */
export function markChannelReadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string) => {
      await client(`${channelPath(channelId)}/read`, {
        method: "PUT",
        fallback: "Could not mark this channel read",
      });
    },
    onMutate: (channelId) => {
      patchRosterRead(queryClient, channelId);
    },
  });
}

/** Soft-delete a channel for everyone in it. The server keeps the transcript; the roster forgets. */
export function deleteChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string) => {
      await client(channelPath(channelId), {
        method: "DELETE",
        fallback: "Could not delete this channel",
      });
    },
    /*
     * REMOVED rather than invalidated, which are opposites, and this wanted both of the properties
     * only removal has.
     *
     * Not invalidated, for the reason this comment has always given: the open channel's detail query
     * would refetch into the fresh 404 and flash an error before the navigate-home lands. But left
     * alone it kept its cache, and that is the half the argument stopped short of. `confirmDelete`
     * (app-sidebar/roster-row.tsx) navigates home BEFORE it deletes, deliberately and for a reason of
     * its own, so by the time this runs the cached row is sitting out the client's default
     * five-minute `gcTime` with nobody watching it — and pressing Back inside that window rendered
     * the deleted conversation from cache, complete with a working composer, until the refetch
     * behind it came back 404.
     *
     * `removeQueries` is what gets both: the entry stops existing, and because nothing observes it
     * any more there is no refetch for the 404 to answer. The one key and not the `channelKeys.all`
     * prefix — every other channel's cached detail is still true.
     *
     * rosterKeys.all is what removes the row from the sidebar, which is the only reader of the
     * channel list. Returned, and so awaited by query-core, because `deleteConversation.isPending`
     * is what keeps the menu's button reading "Deleting…" until the row has actually gone.
     */
    onSuccess: (_data, channelId) => {
      queryClient.removeQueries({ queryKey: channelKeys.detail(channelId) });
      return queryClient.invalidateQueries({ queryKey: rosterKeys.all });
    },
  });
}

/**
 * Archive or restore a channel for everyone in it. Hidden, not frozen: the conversation stays live.
 *
 * Invalidates rather than patches, because the row moves between the Active, Archived, and All lists
 * and a patch would leave it in two of them at once. `rosterKeys.all` is the prefix all three share.
 *
 * NOT `channelKeys.detail`, and a bot chat's archive does not invalidate its own detail query either.
 * The two disagreed for a while: the bot chat's archive refetched its detail query on the stated
 * grounds that the Bot chat screen renders `archived` off it, and this one did not, on no stated
 * grounds. Neither position was the true one — nothing in the browser reads `archived` off a
 * single-channel or single-bot-chat read at all. Both types declare the field because the wire sends
 * it (see `AgentChannel.archived` above for why an undeclared field is worse than an unread one),
 * and the only readers are the sidebar row and its menu, off `RosterItem`. An archived indicator on
 * the channel or Bot chat screen would be the reader that earns the refetch, and it would want
 * adding to both surfaces together.
 */
export function setChannelArchivedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { channelId: string; archived: boolean }) => {
      await client(`${channelPath(variables.channelId)}/archive`, {
        method: "PUT",
        body: { archived: variables.archived },
        fallback: variables.archived
          ? "Could not archive this channel"
          : "Could not restore this channel",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: rosterKeys.all }),
  });
}
