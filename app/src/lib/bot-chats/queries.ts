import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/** One direct conversation with one Bot. `threadId` is what the chat component talks in. */
export type BotChat = {
  id: string;
  agentId: string;
  threadId: string;
  /** Null until the person has said something. The roster falls back to the Bot's name. */
  title: string | null;
  active: boolean;
  /**
   * Whether the conversation is put away. Hidden, not frozen — saying something in it brings it back.
   *
   * Declared here because the wire sends it: the server reports `archived` on a single-row read
   * rather than filtering the row out. Nothing in the browser reads it off this payload today — the
   * sidebar row and its menu read it off `RosterItem` — and it is declared anyway for the reason
   * `AgentChannel.archived` gives at greater length: nothing validates a response against this type,
   * so an undeclared field is dropped in silence and the next person to need it concludes it is not
   * sent.
   */
  archived: boolean;
};

export const botChatKeys = {
  all: ["bot-chats"] as const,
  detail: (id: string) => ["bot-chats", "detail", id] as const,
};

/**
 * Thrown when the server answers `GET /api/bot-chats/:id` with a 404: this conversation is not there.
 *
 * A dedicated type for the same reason `AdoptConflictError` is one. The Bot chat screen has two
 * sentences to choose between — "not here any more", which is a stale link or somebody else's chat
 * (the server answers 404 rather than 403 for both), and "could not load", which is offline, a 500,
 * or an aborted request — and `client` throws a plain `Error` built only from the body's message,
 * with no status attached. Told apart by message, the day the server rewords a sentence is the day a
 * failed load starts telling people their conversation was deleted.
 */
export class BotChatMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotChatMissingError";
  }
}

/**
 * One conversation, by id.
 *
 * Goes through `tryClient` rather than `client`, unlike most reads in this app, because the caller
 * needs the status and not just the message — see `BotChatMissingError`.
 */
export function botChatQueryOptions(id: string) {
  return queryOptions({
    queryKey: botChatKeys.detail(id),
    queryFn: async (): Promise<BotChat> => {
      const response = await tryClient(`/api/bot-chats/${id}`);

      if (response.ok) {
        return ((await response.json()) as { botChat: BotChat }).botChat;
      }

      // Same extraction `client` does: the server's own message names the reason when it sent one.
      const message = await response
        .json()
        .then((body: { error?: string }) => body.error)
        .catch(() => undefined);

      if (response.status === 404) {
        throw new BotChatMissingError(
          message ?? "That conversation is no longer available.",
        );
      }
      // The screen says "Could not load this conversation" itself, so this fallback is the detail
      // line under it rather than a second copy of the same sentence.
      throw new Error(message ?? "The server did not say why.");
    },
  });
}
