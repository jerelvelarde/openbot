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
 */
export function patchRosterRead(queryClient: QueryClient, id: string) {
  const now = new Date().toISOString();
  for (const status of ROSTER_STATUSES) {
    queryClient.setQueryData(
      rosterKeys.list(status),
      (data: InfiniteData<RosterPage> | undefined) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((row) =>
              row.id === id
                ? {
                    ...row,
                    /*
                     * The later of now and the row's own lastMessageAt: lastMessageAt comes from
                     * another clock, and a marker stamped "now" by a clock running behind it
                     * would leave the row still reading as unseen — and the dot still lit.
                     */
                    lastReadAt:
                      row.lastMessageAt && row.lastMessageAt > now
                        ? row.lastMessageAt
                        : now,
                  }
                : row,
            ),
          })),
        },
    );
  }
}
