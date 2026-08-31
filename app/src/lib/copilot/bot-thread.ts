import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  adoptBotChatMutationOptions,
  AdoptConflictError,
} from "@/lib/bot-chats/mutations";
import type { BotChat } from "@/lib/bot-chats/queries";
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
 *
 * WHO CALLS THIS NOW. `useLegacyThreadAdoption` below is the belt: it runs on the chat screen, on
 * every visit, and covers somebody who deep-links straight into a Bot chat. `attemptAdoption`, the
 * sequence it is built from, is also called directly by `BotResolver`
 * (app/src/routes/_authed/_app/bot.tsx) — the resolver has to run this to completion *before* it will
 * ever create, because a browser upgrading into this feature always reaches the resolver first, with
 * no `bot_chats` rows yet, and the resolver used to lose that race by definition: "nothing to open"
 * read as true before this hook — which only exists on the screen the resolver navigates to — ever
 * got a turn.
 */

const KEY = "openbot.bot-thread";

/** The one place the storage key is built, so the getter and the setter can never drift apart. */
export function botThreadKey(agentId: string): string {
  return `${KEY}.${agentId}`;
}

/**
 * Exported so `BotResolver` can ask, synchronously, whether there is anything worth adopting before
 * it commits to creating — see `shouldAttemptAdoption` in bot.tsx, which takes this value as a plain
 * argument rather than reading storage itself, for the same "one function, not two spellings" reason
 * `shouldAdopt` is built on `threadToUse` instead of re-deriving it.
 */
export function remembered(agentId: string): string | null {
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
 * This used to be a string match: `adoptBotChatMutationOptions` called `client`, which throws a plain
 * `Error` built from the response body's message and never surfaces the HTTP status, so the only thing
 * left to check here was the server's exact sentence — "That conversation is no longer available." A
 * comparison like that is exact only for as long as nobody rewords the sentence; the day someone does,
 * a 409 silently stops being recognised and the every-visit retry loop this hook exists to prevent
 * comes back, with nothing failing loudly to say so.
 *
 * `adoptBotChatMutationOptions` (app/src/lib/bot-chats/mutations.ts) now goes through `tryClient`
 * instead, reads `response.status` itself, and throws `AdoptConflictError` specifically when it is 409
 * — see that type's own comment for why the status, not the message, is what a 409 hinges on. So the
 * check below is an `instanceof`, not a string comparison, and it must stay that way: reinstating a
 * match against `error.message` would bring back exactly the fragility this replaced.
 */

/**
 * The full rescue sequence, once: check, decide, adopt, forget. Shared by `useLegacyThreadAdoption`
 * below (the belt, on the chat screen) and `BotResolver` (app/src/routes/_authed/_app/bot.tsx, the
 * primary path — see this file's module comment for why the resolver has to run this itself rather
 * than waiting for the hook). One function rather than the sequence hand-copied into both places: the
 * two would drift the first time either changed a step, and this is exactly the kind of drift that
 * turns "adopt safely" into "adopt safely, except from the one call site nobody updated."
 *
 * `adopt` is the caller's own `adoptBotChatMutationOptions().mutateAsync`, not created here, so each
 * caller keeps its own mutation state (`adopt.error`, `adopt.isPending`, …) if it ever needs it.
 *
 * `isCurrent` is checked at the same two points the hook's effect used to check its own local
 * `current` flag before this was extracted: after `checkKnown` resolves, and again after `adopt`
 * settles, before `forget`. A stale answer — the Bot changed, or the caller unmounted, while a
 * request was in flight — must not adopt or forget anything. Note what that means on the second
 * check: an adopt that *succeeded* but arrives stale still does not `forget` — the row now exists,
 * but the only side effect skipped is clearing the local pointer to it, and a future, unstale run
 * finishes that cleanly (finding the thread already adopted looks identical to a fresh adopt racing
 * a duplicate, which is exactly the 409 case below, already handled). Committing to `forget` on
 * behalf of a screen nobody is looking at any more is the one thing that cannot be undone, so it is
 * the one thing withheld until the answer is not stale.
 */
export async function attemptAdoption(
  agentId: string,
  adopt: (variables: { agentId: string; threadId: string }) => Promise<BotChat>,
  isCurrent: () => boolean,
): Promise<{ adopted: string } | { adopted: null }> {
  const threadId = remembered(agentId);
  // Nothing remembered means nothing the check could protect.
  if (threadId === null) return { adopted: null };

  const outcome = await checkKnown(threadId);
  if (!isCurrent()) return { adopted: null };
  if (!shouldAdopt({ remembered: threadId, known: outcome.known })) {
    return { adopted: null };
  }

  try {
    const botChat = await adopt({ agentId, threadId });
    if (!isCurrent()) return { adopted: null };
    forget(agentId);
    return { adopted: botChat.id };
  } catch (error) {
    if (!(error instanceof AdoptConflictError)) {
      // Any other failure — offline, a 500, the tab closing mid-request — keeps the key: it is
      // the only remaining pointer to this transcript, so the next visit has to be able to try
      // again. See `AdoptConflictError` for why a 409 does not take this branch.
      return { adopted: null };
    }
    // A 409: somebody already has this thread — this same adoption racing from another tab, or
    // this same person having soft-deleted the row adoption would have created (see
    // `AdoptConflictError`). Either way the outcome adoption wanted has already happened, so
    // this falls through to `forget` exactly as a successful `await` above would have. There is
    // no id to hand back here — whoever holds the thread now is not necessarily this call — so a
    // caller that needed an id (the resolver) falls back to its own `mostRecent`/create decision,
    // which is the right answer in both 409 cases: a stranger's row is invisible to this actor's
    // roster either way, and this same actor's soft-deleted row was deliberately put away, so
    // starting fresh is not a mistake to correct.
    if (!isCurrent()) return { adopted: null };
    forget(agentId);
    return { adopted: null };
  }
}

/**
 * Rescue a remembered conversation, once per Bot.
 *
 * Runs on the Bot screen. The outcome is not read here — `attemptAdoption` already does everything
 * this hook exists for (adopt, and forget once it lands) — this is a belt for whoever deep-links
 * straight into a Bot chat without going through `BotResolver` first: the resolver already ran this
 * exact sequence before it ever navigated here, so on the ordinary path this hook finds nothing
 * remembered and does nothing. It only has work left to do when the resolver's own attempt kept the
 * key — a failed adopt, or a check that could not get an answer — and this mount is the retry.
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
    void attemptAdoption(agentId, adoptThread, () => current);
    return () => {
      current = false;
    };
  }, [agentId, adoptThread]);
}
