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

/**
 * The one place a channel id becomes a request path, id encoded.
 *
 * ENCODED, WHICH IT WAS NOT. Every site here and in `mutations.ts` interpolated the id into a
 * template of its own, and the failure that produces is not the usual "unsafe input" one — it is
 * quieter and worse. An id carrying `%3F` reaches the server as `/api/channels/x?y`, which reads the
 * id as `x` and answers about a DIFFERENT conversation: a pin, an archive, a read stamp or a DELETE
 * aimed at one channel landing on another. `%2F` splits the path instead, so the route stops matching
 * and the answer is a 404 the screen reports as "not here any more".
 *
 * A FUNCTION AND NOT SIX `encodeURIComponent` CALLS, because six of those is six chances to write the
 * seventh without one — which is exactly how this happened: `checkKnown` (lib/copilot/bot-thread.ts)
 * encoded, inline, where none of its siblings could see it. The base path does not appear at a call
 * site any more, so the unencoded form is no longer something a sibling can be written in. Same shape
 * and same reason as `componentPath` in lib/components/mutations.ts, which this follows.
 *
 * Lives here rather than in `mutations.ts` only because both files need it and mutations already
 * imports from queries.
 */
export function channelPath(channelId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}`;
}

export function channelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.detail(channelId),
    queryFn: async (): Promise<AgentChannel> => {
      return client(channelPath(channelId), "channel", {
        fallback: "Could not load this channel",
      });
    },
  });
}
