import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One direct conversation with one Bot. `threadId` is what the chat component talks in. */
export type BotChat = {
  id: string;
  agentId: string;
  threadId: string;
  /** Null until the person has said something. The roster falls back to the Bot's name. */
  title: string | null;
  active: boolean;
  archived: boolean;
};

export const botChatKeys = {
  all: ["bot-chats"] as const,
  detail: (id: string) => ["bot-chats", "detail", id] as const,
};

export function botChatQueryOptions(id: string) {
  return queryOptions({
    queryKey: botChatKeys.detail(id),
    queryFn: (): Promise<BotChat> =>
      client(`/api/bot-chats/${id}`, "botChat", {
        fallback: "Could not load this conversation",
      }),
  });
}
