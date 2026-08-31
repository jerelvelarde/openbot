import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { patchRosterRead } from "@/lib/roster/read-marker";
import { rosterKeys } from "@/lib/roster/queries";
import { type AgentChannel, channelKeys } from "./queries";

/**
 * Start a new channel with one or more coworkers.
 *
 * Deliberately not idempotent: every call creates a channel with its own thread.
 */
export function createChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentIds: string[]): Promise<AgentChannel> => {
      const response = await client("/api/channels", {
        method: "POST",
        body: { agentIds },
        fallback: "Could not start a channel",
      });
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
    // channelKeys.all no longer backs anything the sidebar reads — that reader is gone — but it
    // still reaches channelKeys.detail, which channelQueryOptions does read; rosterKeys.all is
    // what actually gets the new row into the sidebar.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: channelKeys.all });
      void queryClient.invalidateQueries({ queryKey: rosterKeys.all });
    },
  });
}

/**
 * Report the last thing said in a channel.
 *
 * The client that ran the agent already has the message before platform replay can return it; the
 * runtime exposes no run-completion hook and its run endpoint returns before the reply exists.
 *
 * Fire-and-forget on purpose: a failed preview update is a stale roster line, not a lost message.
 */
export function recordChannelActivityMutationOptions() {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      text: string;
      agentId: string | null;
      at: string;
    }) => {
      /* Still fire-and-forget: `tryClient` does not throw, and the result is not read. */
      await tryClient(`/api/channels/${variables.channelId}/activity`, {
        method: "POST",
        body: {
          agentId: variables.agentId,
          at: variables.at,
          text: variables.text,
        },
      });
    },
  });
}

/** Pin or unpin a channel for this member. A marker, not a reorder, so no optimistic sort. */
export function setChannelPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { channelId: string; pinned: boolean }) => {
      await client(`/api/channels/${variables.channelId}/pin`, {
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
 * of a channel's unread state now, and it reads the roster, not channelKeys.list().
 */
export function markChannelReadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string) => {
      await client(`/api/channels/${channelId}/read`, {
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
      await client(`/api/channels/${channelId}`, {
        method: "DELETE",
        fallback: "Could not delete this channel",
      });
    },
    // Not the detail query: the open channel's detail query would refetch into the fresh 404 and
    // flash an error before the navigate-home lands; left alone, it keeps its cache and the
    // navigation happens with nothing to complain about. Just rosterKeys.all — the sidebar is the
    // only reader of the channel list now, and it reads the roster, not channelKeys.list().
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: rosterKeys.all }),
  });
}

/**
 * Archive or restore a channel for everyone in it. Hidden, not frozen: the conversation stays live.
 *
 * Invalidates rather than patches, because the row moves between the Active, Archived, and All lists
 * and a patch would leave it in two of them at once. `rosterKeys.all` is the prefix all three share.
 */
export function setChannelArchivedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { channelId: string; archived: boolean }) => {
      await client(`/api/channels/${variables.channelId}/archive`, {
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
