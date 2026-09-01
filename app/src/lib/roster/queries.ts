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

/**
 * Every status there is, written down once.
 *
 * `RosterStatus` is derived from this tuple rather than declared beside it, so the array is the only
 * place the list exists: a status added here widens the type, and every loop that walks all the lists
 * — the socket patcher in `channels/use-channel-events.ts`, the read marker in `roster/read-marker.ts`
 * — covers it without being edited. Those two used to spell the list out for themselves, which meant a
 * fourth status would have type-checked cleanly while both loops silently skipped it.
 */
export const ROSTER_STATUSES = ["active", "archived", "all"] as const;

/** Which conversations a list holds. `all` is active plus archived, and never deleted. */
export type RosterStatus = (typeof ROSTER_STATUSES)[number];

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
      /*
       * `null` for the envelope key, because this endpoint's body IS the page — `items` and
       * `nextCursor` together, with nothing wrapped around them to unwrap.
       *
       * What passing a key at all buys is the parse happening inside `client`, where the `fallback`
       * lives. Read back out here, a 200 carrying a proxy's HTML error page arrived on screen as
       * `SyntaxError: Unexpected token '<', "<html>"… is not valid JSON`, rendered by the sidebar as
       * its empty-state title under `role="alert"` and above the words "Nothing has been lost" —
       * which is the one place in this app a void is most likely to be read as
       * "my conversations are gone".
       */
      return client<RosterPage>(`/api/roster?${parameters.toString()}`, null, {
        fallback: "Could not load your conversations",
      });
    },
    getNextPageParam: (page: RosterPage) => page.nextCursor ?? undefined,
    select: (data): RosterItem[] => data.pages.flatMap((page) => page.items),
  });
}
