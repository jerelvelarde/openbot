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
 * recoverable and is empty when opened. So only a provable "yes" adopts — and a provable "no" is the
 * one thing that retires the key, because nothing else ever would: this runs on every visit, so a key
 * that can never be adopted would otherwise ask the same question forever.
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
 * argument rather than reading storage itself, so that the key is read through this one function
 * wherever it is read at all.
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
 * Whether Intelligence still has a remembered thread: `true`, `false`, or `undefined` for "no clean
 * answer".
 *
 * THE THIRD ANSWER IS THE POINT, and it deliberately covers two situations this file then treats
 * identically. A 404 on this route means no thread reader is configured on this deployment at all,
 * which says nothing about the thread; a 400, a 502, a 200 carrying the wrong shape, or the request
 * simply throwing means the question was asked and came back without an answer. Neither is news
 * about the thread, and `attemptAdoption` — the only caller — does the same thing for both: keep the
 * remembered key, adopt nothing, ask again on the next visit.
 *
 * A second field naming WHICH of the two it was used to be returned alongside this, and was read by
 * nobody once `useBotThread` went away. That is worse than not having it: a reader takes a
 * distinction the code makes nothing of for one it acts on. So the two collapse here, where the
 * collapsing is visible, rather than downstream where it was invisible.
 */
async function checkKnown(threadId: string): Promise<boolean | undefined> {
  try {
    const response = await tryClient(
      `/api/threads/${encodeURIComponent(threadId)}`,
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { known?: unknown };
    return typeof body.known === "boolean" ? body.known : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a remembered thread is worth adopting.
 *
 * ONLY A PROVABLE YES ADOPTS, and the three answers `checkKnown` can give are why this cannot be
 * written as one rule shared with the decision to drop the key (`attemptAdoption`'s `known === false`
 * branch). Those two cut the answers in different places: a remembered id is dropped only when it is
 * provably gone, while it is adopted only when it is provably there, so `undefined` — the check
 * having failed — falls on the do-nothing side of both, and `known === true` is the single answer
 * they agree about.
 *
 * This function used to end with `&& threadToUse(input) === "remembered"` and describe itself as
 * built on that rule rather than beside it. It was not: with `known === true` already established,
 * that call could only ever return `"remembered"`, so the conjunct was dead and the rule was spelled
 * twice anyway. `threadToUse` itself went with the last reader of a remembered id — nothing picks a
 * thread out of storage any more, it is adopted or forgotten — so what is left is this one question.
 */
export function shouldAdopt(input: {
  remembered: string | null;
  known: boolean | undefined;
}): boolean {
  return input.remembered !== null && input.known === true;
}

/**
 * The full rescue sequence, once: check, decide, then adopt or forget. Shared by
 * `useLegacyThreadAdoption` below (the belt, on the chat screen) and `BotResolver`
 * (app/src/routes/_authed/_app/bot.tsx, the primary path — see this file's module comment for why
 * the resolver has to run this itself rather than waiting for the hook). One function rather than
 * the sequence hand-copied into both places: the
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
 *
 * WHAT A CALLER CANNOT LEARN FROM THE RETURN VALUE, because it cost a duplicate row once. Every
 * stale exit below reports `{ adopted: null }`, which is also what "nothing was remembered", "the
 * check came back inconclusive" and "the adopt failed" say — so a successful-but-stale adopt is
 * indistinguishable from an adoption that never happened, and a caller that reads
 * `{ adopted: null }` as licence to write something durable writes it alongside the row this
 * function just adopted. Widening the return type to name that case would move the decision in
 * here; leaving it as it is keeps the decision with whoever is about to write, which is where the
 * thing being protected lives. `BotResolver` therefore checks its own mount ref again immediately
 * before it creates — see the comment on that check in app/src/routes/_authed/_app/bot.tsx.
 */
export async function attemptAdoption(
  agentId: string,
  adopt: (variables: { agentId: string; threadId: string }) => Promise<BotChat>,
  isCurrent: () => boolean,
): Promise<{ adopted: string } | { adopted: null }> {
  const threadId = remembered(agentId);
  // Nothing remembered means nothing the check could protect.
  if (threadId === null) return { adopted: null };

  const known = await checkKnown(threadId);
  if (!isCurrent()) return { adopted: null };

  if (known === false) {
    /*
     * PROVEN GONE, so the key goes too. Intelligence saying plainly that it has never heard of this
     * id is the one answer that makes the key worthless: there is no transcript behind it for a
     * later visit to rescue. Left in place it would never be cleared by anything — the belt hook
     * runs on every Bot chat mount, so every visit would ask the same question and get the same
     * answer for the life of the browser profile, and the request would outlive the release it was
     * written for.
     *
     * ONLY `known === false`, deliberately, and this is the distinction the whole check exists to
     * make. `known === undefined` is the check failing to get an answer (see `checkKnown`) rather
     * than the thread being gone, and throwing away somebody's conversation on the strength of a
     * network blip is the worse of the two mistakes — so an inconclusive answer keeps the key and
     * falls through to the retry. Guarded by `isCurrent` like the other two `forget` call sites, for
     * the reason this function's own comment gives: committing to forget on behalf of a screen
     * nobody is looking at any more is the one thing that cannot be undone.
     */
    forget(agentId);
    return { adopted: null };
  }

  if (!shouldAdopt({ remembered: threadId, known })) {
    return { adopted: null };
  }

  try {
    const botChat = await adopt({ agentId, threadId });
    if (!isCurrent()) return { adopted: null };
    forget(agentId);
    return { adopted: botChat.id };
  } catch (error) {
    /*
     * An `instanceof`, and it has to stay one. This was a comparison against the server's exact
     * sentence — "That conversation is no longer available." — back when
     * `adoptBotChatMutationOptions` went through `client`, which throws a plain `Error` built from
     * the body's message and never surfaces the status. A match like that is exact only for as long
     * as nobody rewords the sentence; the day somebody does, a 409 silently stops being recognised
     * and the every-visit retry loop this whole path exists to prevent comes back, with nothing
     * failing loudly to say so. See `AdoptConflictError`, which exists to make the status askable.
     */
    if (!(error instanceof AdoptConflictError)) {
      // Any other failure — offline, a 500, the tab closing mid-request — keeps the key: it is
      // the only remaining pointer to this transcript, so the next visit has to be able to try
      // again.
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
