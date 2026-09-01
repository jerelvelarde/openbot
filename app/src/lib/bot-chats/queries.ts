import { queryOptions } from "@tanstack/react-query";
import { serverMessage, tryClient, unwrap } from "@/lib/client";

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
 * The one place a bot chat id becomes a request path, id encoded.
 *
 * ENCODED, WHICH IT WAS NOT. Every site here and in `mutations.ts` built its own template, and what
 * that costs is not the ordinary "unsafe input" harm but a quieter and worse one: an id carrying
 * `%3F` reaches the server as `/api/bot-chats/x?y`, which reads the id as `x` and answers about a
 * DIFFERENT conversation — an archive, a read stamp or a DELETE aimed at one landing on another.
 * `%2F` splits the path instead, so the route stops matching and the 404 is reported to a person as
 * "not here any more".
 *
 * A FUNCTION AND NOT SIX `encodeURIComponent` CALLS, because six of those is six chances to write the
 * seventh without one — which is how this happened: `checkKnown` (lib/copilot/bot-thread.ts) encoded,
 * inline, where none of its siblings could see that it did. The base path no longer appears at a call
 * site, so the unencoded form is not a shape a sibling can be written in. Same as `channelPath` in
 * lib/channels/queries.ts, and as `componentPath` in lib/components/mutations.ts before either.
 *
 * `/api/bot-chats/adopt` is not built from this and does not want to be: it is a fixed route with no
 * id in it, and the thread id it acts on travels in the body.
 */
export function botChatPath(id: string): string {
  return `/api/bot-chats/${encodeURIComponent(id)}`;
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
      const response = await tryClient(botChatPath(id));

      if (response.ok) {
        /*
         * Through `unwrap` rather than parsed here, which is what reading a status yourself used to
         * cost. A 200 is not a promise of JSON — a proxy error page and a captive portal both answer
         * one with HTML — and the parse sat outside every guard, so `SyntaxError: Unexpected token
         * '<'` was what the screen put under "Could not load this conversation." An envelope without
         * its key was the quieter half: `undefined` typed as a `BotChat`, handed to a screen that
         * reads `botChat.id` to key itself on.
         *
         * The fallback is the detail line, not a second copy of the screen's own sentence, the same
         * choice the non-404 throw below makes and for the same reason.
         */
        return unwrap<BotChat>(
          response,
          "botChat",
          "The server's reply could not be read.",
        );
      }

      // `client`'s own extraction, shared rather than restated: the server's message names the
      // reason when it sent one, and `serverMessage` answers `undefined` when it did not.
      const message = await serverMessage(response);

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
