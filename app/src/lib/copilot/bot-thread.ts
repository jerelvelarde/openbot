import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { adoptBotChatMutationOptions } from "@/lib/bot-chats/mutations";
import { tryClient } from "@/lib/client";

/**
 * The conversation a browser remembers from before Bot chats had rows.
 *
 * WHAT THIS USED TO BE. The one place a direct Bot chat's thread id lived: `localStorage`, one per
 * Bot, re-verified on every mount because Intelligence is free to forget the thread behind an id —
 * expiry, environment reset, a wiped development database — and a remembered id nobody upstream
 * recognises does not fail loudly. Every send just opens a new, empty thread under the old id and
 * the chat answers as if nothing had ever been said.
 *
 * WHAT IT IS NOW. Threads come from `bot_chats` rows, so none of that applies going forward. What
 * remains is one release-crossing job: a browser upgrading into this feature is holding an id for a
 * real conversation that has no row, and without adopting it that transcript is orphaned in
 * Intelligence for good.
 *
 * The check is what makes adoption safe rather than merely enthusiastic. Adopting an id Intelligence
 * has forgotten would manufacture a roster row with nothing behind it: a conversation that looks
 * recoverable and is empty when opened. So only a provable "yes" adopts.
 */

const KEY = "openbot.bot-thread";

/** The one place the storage key is built, so the getter and the setter can never drift apart. */
export function botThreadKey(agentId: string): string {
  return `${KEY}.${agentId}`;
}

function remembered(agentId: string): string | null {
  try {
    return window.localStorage.getItem(botThreadKey(agentId));
  } catch {
    // Storage can be unavailable or full. A thread for this visit is better than no chat at all.
    return null;
  }
}

/**
 * Clears the remembered thread once it no longer needs protecting — adopted, or proven gone.
 * Mirrors `remembered`'s own try/catch: storage can be unavailable or full, and failing to forget is
 * no worse than failing to remember in the first place — the conversation still works either way,
 * it is only the next visit's shortcut that is lost.
 */
function forget(agentId: string): void {
  try {
    window.localStorage.removeItem(botThreadKey(agentId));
  } catch {
    // As above: nothing here is worth crashing over.
  }
}

/**
 * Whether Intelligence still has a remembered thread, and whether the question could even be put
 * to it. Those are separate facts: a 404 on this route means no reader is configured on this
 * deployment at all, which says nothing about the thread and must not be read as bad news, while a
 * 400 or a 502 (or the request simply throwing) means the question was asked and failed to get a
 * clean answer.
 */
async function checkKnown(
  threadId: string,
): Promise<{ known: boolean | undefined; unavailable: boolean }> {
  try {
    const response = await tryClient(
      `/api/threads/${encodeURIComponent(threadId)}`,
    );
    if (response.status === 404) {
      // The route itself is absent, which is what an unconfigured reader looks like server-side.
      // Behave exactly as this hook did before the check existed: nothing was learned, nothing
      // changes.
      return { known: undefined, unavailable: false };
    }
    if (!response.ok) {
      // A 400 means the remembered id was not even a plausible thread id; a 502 means the check
      // itself failed to reach Intelligence. Either way there is no clean answer, and the safer
      // read is "unknown" rather than "gone" — see threadToUse for why.
      return { known: undefined, unavailable: true };
    }
    const body = (await response.json()) as { known?: unknown };
    if (typeof body.known !== "boolean") {
      // A 200 that does not carry the shape this hook asked for is not an answer either.
      return { known: undefined, unavailable: true };
    }
    return { known: body.known, unavailable: false };
  } catch {
    return { known: undefined, unavailable: true };
  }
}

/**
 * Whether to keep the remembered thread id or start over, given what the check above learned.
 *
 * The two ways of not keeping it are not the same mistake. `known: false` is Intelligence saying,
 * plainly, that it has never heard of this id — replacing it loses nothing, because there was
 * never anything there to lose, and keeping it would only mean sending every message into a thread
 * that quietly reopens empty. `known: undefined` is the opposite kind of ignorance: the check
 * failed to get an answer at all, and discarding somebody's conversation on the strength of a
 * network blip is the worse mistake of the two. So only a provable "no" moves this to `"fresh"`;
 * an inconclusive check keeps what was remembered. No remembered id to keep is its own case: with
 * nothing to protect, there is nothing the check could have told us that would change the outcome.
 */
export function threadToUse(input: {
  remembered: string | null;
  known: boolean | undefined;
}): "remembered" | "fresh" {
  if (input.remembered === null) return "fresh";
  return input.known === false ? "fresh" : "remembered";
}

/**
 * Whether a remembered thread is worth adopting.
 *
 * The inverse of `threadToUse`'s question, and deliberately built on it rather than beside it: there
 * is one rule about when a remembered id can be trusted, and two spellings of it would drift.
 */
export function shouldAdopt(input: {
  remembered: string | null;
  known: boolean | undefined;
}): boolean {
  return (
    input.remembered !== null &&
    input.known === true &&
    threadToUse(input) === "remembered"
  );
}

/**
 * The exact sentence `POST /api/bot-chats/adopt` answers with on a 409 — see `mapStoreError` in
 * server/src/bot-chats/routes.ts, which answers `BotChatThreadTakenError` with this one sentence for
 * two different reasons at once (a thread somebody else already owns, and a thread this same person
 * already owns but soft-deleted), deliberately, so a caller here cannot and need not tell them apart.
 *
 * It is also the only thing left here to check against. `client` (app/src/lib/client.ts) — which
 * `adoptBotChatMutationOptions` calls — throws a plain `Error` built from the response body's `error`
 * field, or a fallback sentence when there is none; the HTTP status itself never reaches the caller.
 * So this cannot be `error.status === 409` — there is no such property to read. Matching the sentence
 * is what is left, and it is exact only because this route has no other way to produce it: a 400
 * fails validation before `adopt` runs, a 404 says "Agent not found.", and an uncaught failure falls
 * back to the fallback sentence `adoptBotChatMutationOptions` passes to `client`, not to this one. If
 * the server ever rewords that sentence, this constant has to move with it, or a 409 stops being
 * recognised and the every-visit retry loop `useLegacyThreadAdoption` exists to prevent comes back.
 */
const ADOPT_CONFLICT_MESSAGE = "That conversation is no longer available.";

function isAdoptConflict(error: unknown): boolean {
  return error instanceof Error && error.message === ADOPT_CONFLICT_MESSAGE;
}

/**
 * Rescue a remembered conversation, once per Bot.
 *
 * Runs on the Bot screen. `forget` only after the adoption has landed, so an adoption that failed —
 * offline, a 500, the tab closing — is retried next time rather than losing the id that is the only
 * remaining pointer to that transcript.
 *
 * A 409 is a success for this purpose: somebody already has the thread, which is the outcome adoption
 * wanted. Only an error that leaves the thread unclaimed is worth keeping the key for.
 */
export function useLegacyThreadAdoption(agentId: string): void {
  const queryClient = useQueryClient();
  const adopt = useMutation(adoptBotChatMutationOptions(queryClient));
  // Extracted for the effect's dependency array: `adopt` itself is a fresh object every render, but
  // `mutateAsync` is stable, and depending on the object would re-run this effect (and re-ask
  // Intelligence, harmlessly but pointlessly) far more often than "once per Bot".
  const adoptThread = adopt.mutateAsync;

  useEffect(() => {
    let current = true;

    const threadId = remembered(agentId);
    // Nothing remembered means nothing the check could protect.
    if (threadId === null) return;

    void checkKnown(threadId).then(async (outcome) => {
      // The agent may have changed, or this screen may have unmounted, while the check was in
      // flight; an answer about a Bot nobody is looking at any more must not adopt anything.
      if (!current) return;
      if (!shouldAdopt({ remembered: threadId, known: outcome.known })) return;

      try {
        await adoptThread({ agentId, threadId });
      } catch (error) {
        if (!isAdoptConflict(error)) {
          // Any other failure — offline, a 500, the tab closing mid-request — keeps the key: it is
          // the only remaining pointer to this transcript, so the next visit has to be able to try
          // again. See `ADOPT_CONFLICT_MESSAGE` for why a 409 does not take this branch.
          return;
        }
        // A 409: somebody already has this thread — this same adoption racing from another tab, or
        // this same person having soft-deleted the row adoption would have created (see
        // `ADOPT_CONFLICT_MESSAGE`). Either way the outcome adoption wanted has already happened, so
        // this falls through to `forget` exactly as a successful `await` above would have.
      }

      if (!current) return;
      forget(agentId);
    });

    return () => {
      current = false;
    };
  }, [agentId, adoptThread]);
}
