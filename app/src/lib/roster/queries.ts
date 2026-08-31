import { infiniteQueryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * One roster over two kinds of conversation.
 *
 * `kind` is for rendering, not for finding a row: ids are prefixed on the server and therefore
 * globally unique, so everything that looks a row up does it by id alone.
 *
 * `archived` is carried on the row rather than inferred from which list it arrived in, because the
 * menu on the row has to offer Archive or Restore and a row can be sitting in the All list.
 */
export type RosterKind = "channel" | "bot_chat";

/** Which conversations a list holds. `all` is active plus archived, and never deleted. */
export type RosterStatus = "active" | "archived" | "all";

export type RosterItem = {
  kind: RosterKind;
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  /** False once the Bot has been retired: the transcript stays readable, nothing more can be said. */
  active: boolean;
  archived: boolean;
  lastMessage: string | null;
  /** ISO-8601, or null for a conversation nobody has used yet. */
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** ISO-8601. Ordering falls back to this, so a conversation just made sorts to the top. */
  createdAt: string;
  pinned: boolean;
  /** ISO-8601 when this person last had it open, or null for never. Theirs, only. */
  lastReadAt: string | null;
};

export type RosterPage = { items: RosterItem[]; nextCursor: string | null };

/**
 * The status is part of the key, so the three lists are three caches.
 *
 * Sharing one key would have Archived's pages overwrite Active's the moment either was fetched. All
 * three sit under one prefix so a single `invalidateQueries` on `rosterKeys.all` reaches every one of
 * them, which is what an archive has to do — see `use-channel-events.ts` for why an archive
 * invalidates rather than patches.
 */
export const rosterKeys = {
  all: ["roster"] as const,
  list: (status: RosterStatus) => ["roster", "list", status] as const,
};

export function rosterListQueryOptions(status: RosterStatus) {
  return infiniteQueryOptions({
    queryKey: rosterKeys.list(status),
    initialPageParam: "",
    queryFn: async ({ pageParam }): Promise<RosterPage> => {
      const parameters = new URLSearchParams({ status });
      if (pageParam) parameters.set("cursor", pageParam as string);
      const response = await client(`/api/roster?${parameters.toString()}`, {
        fallback: "Could not load your conversations",
      });
      return (await response.json()) as RosterPage;
    },
    getNextPageParam: (page: RosterPage) => page.nextCursor ?? undefined,
    select: (data): RosterItem[] => data.pages.flatMap((page) => page.items),
  });
}
