import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { ROSTER_STATUSES, type RosterPage, rosterKeys } from "./queries";

/**
 * Stamp one row's `lastReadAt` in every cached roster status list, patching the cache before the
 * wire answers.
 *
 * Shared by channels and bot chats: both kinds of conversation live in the same three roster lists
 * (Active, Archived, All), and "mark this row read" is one idea for both of them, not two copies of
 * the same loop that have to be kept in step by hand. The row is looked up by id alone — ids are
 * globally unique — so this patches whichever list the row is actually sitting in and is a no-op on
 * the other two.
 *
 * A NO-OP MEANS THE IDENTICAL CACHE BACK, not a rebuilt one that happens to hold equal values, and
 * that is a guarantee rather than an optimisation. This used to rebuild `pages`, every page object
 * and every `items` array in all three lists on every call — the lists that cannot hold the row
 * included — while the paragraph above called itself a no-op on them. What made the rebuild look free
 * is React Query's structural sharing inside `setQueryData`, which compares what it is handed against
 * what it holds and puts the old references back where they are equal. `applyRosterEvent` in
 * `channels/use-channel-events.ts` refuses to lean on that, in as many words: real, but incidental,
 * and gone the moment anybody sets `structuralSharing: false`, while `RosterRow`'s memo wants a
 * guarantee. The read marker took the incidental version; now the two agree. A row sits in All and in
 * one of Active or Archived, so the third list is left exactly as it was found, and the two that do
 * hold the row rebuild only the page it is on.
 */
export function patchRosterRead(queryClient: QueryClient, id: string) {
  const now = new Date().toISOString();
  for (const status of ROSTER_STATUSES) {
    queryClient.setQueryData(
      rosterKeys.list(status),
      (data: InfiniteData<RosterPage> | undefined) => {
        if (!data) return data;

        // Found first, so "this list does not hold the row" and "this page does not hold the row"
        // are both answered before anything is rebuilt.
        const holding = data.pages.findIndex((page) =>
          page.items.some((row) => row.id === id),
        );
        if (holding === -1) return data;

        return {
          ...data,
          pages: data.pages.map((page, index) =>
            index === holding
              ? {
                  ...page,
                  items: page.items.map((row) =>
                    row.id === id
                      ? {
                          ...row,
                          /*
                           * The later of now and the row's own lastMessageAt: lastMessageAt comes
                           * from another clock, and a marker stamped "now" by a clock running behind
                           * it would leave the row still reading as unseen — and the dot still lit.
                           */
                          lastReadAt:
                            row.lastMessageAt && row.lastMessageAt > now
                              ? row.lastMessageAt
                              : now,
                        }
                      : row,
                  ),
                }
              : page,
          ),
        };
      },
    );
  }
}
