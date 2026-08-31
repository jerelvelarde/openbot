import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * A channel as the browser sees it.
 *
 * `threadId` is what makes two channels with the same coworker independent conversations, and
 * `active` is false once a linked coworker has been deleted: the transcript stays readable, but
 * nothing more can be said in it.
 */
export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  /**
   * Whether the channel is put away. Hidden, not frozen — the conversation stays live, and saying
   * something in it brings it back.
   *
   * Declared here because the wire sends it. Nothing validates a response against this type, so an
   * undeclared field is ignored in silence rather than caught, which is the whole reason a mirror
   * that has quietly stopped matching its server is worth avoiding: the next person to need the
   * field reads this file, concludes it is not sent, and goes and adds it a second time.
   */
  archived: boolean;
};

/**
 * One channel, read one at a time. There is no list key here on purpose.
 *
 * A `list()` key lived here, with a `ChannelSummary`/`ChannelPage` pair to go with it, from when the
 * sidebar paged through channels alone. It reads the roster now — channels and Bot chats in one
 * ordering, which a channels-only list cannot express — and the summary types went unread with it.
 * They are gone rather than kept for later: an exported page type with no fetch behind it reads as a
 * live cache somebody should be patching, and `mutations.ts` had grown two comments explaining that
 * a mutation reaches the roster "not channelKeys.list()" — discussing a key nothing could read.
 */
export const channelKeys = {
  all: ["channels"] as const,
  detail: (channelId: string) => ["channels", "detail", channelId] as const,
};

export function channelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.detail(channelId),
    queryFn: async (): Promise<AgentChannel> => {
      return client(`/api/channels/${channelId}`, "channel", {
        fallback: "Could not load this channel",
      });
    },
  });
}
