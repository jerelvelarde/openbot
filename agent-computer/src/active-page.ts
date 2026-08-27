/**
 * Which of a Bot's open pages is the one being shown and acted on.
 *
 * A Bot's browser was bound to one page, captured when Chromium launched, and nothing ever replaced
 * it. Anything a site opened in a second window or tab was invisible to the live screen and
 * unreachable by input, including while a person held the wheel. That lands hardest on take-the-wheel,
 * which exists so a person can finish the sign-ins a Bot cannot: popup OAuth is how most
 * "Sign in with Google" buttons work, so the flows most likely to need a human were the ones the
 * human could not see. The person clicked, nothing on their screen changed, and their keystrokes went
 * to the page behind the window they were meant to be typing into.
 *
 * A stack rather than "the newest page". A popup is a detour: the page underneath is still the work,
 * and when the popup closes the screen has to come back to it rather than to whatever else happens to
 * be open. A stack says both of those in one structure — push on open, drop on close, the top is
 * live — and it says the right thing for three pages deep, where "the newest" says nothing about
 * where to go next.
 *
 * WHY THIS IS NOT A BOOLEAN. Switching pages does not only change what is on screen. Elements are
 * addressed by ref, and a ref is only meaningful against the document it was taken from: it is minted
 * per snapshot, so `e3` exists on the window that just opened as well and names something else there.
 * Measured on a two-button page, `e3` was "Delete everything" on the opener and "Deny" on the popup.
 * A switch that changed only the viewing path would leave the acting path pointing at the first and
 * reaching the second, so every activation is numbered here and callers throw away what they knew
 * when the number moves.
 *
 * The path that would actually have got it wrong is a person supplying a secret, which by design does
 * not check the snapshot generation: with a popup open and snapshotted, a request made for an API key
 * field on the page underneath put the value into that popup's public search box and answered
 * `supplied: true`. Measured before the number existed. See `currentPage` and `/human/secret` in
 * index.ts.
 *
 * It lives in its own file with no Playwright import, for the reason `browser-eviction.ts` and
 * `viewer.ts` do: `profiles.ts` imports Playwright at module scope, so a decision left there needs a
 * browser merely to be imported by a test. The ordering is the part with a wrong answer available;
 * opening and closing pages is Playwright's job and stays in `profiles.ts`.
 */

/**
 * How many times any Bot's active page has changed, across this process.
 *
 * Process-wide and never reset, so no two activations anywhere carry the same number. Per-stack
 * counting looked equivalent and was not: a browser that is evicted and relaunched builds a fresh
 * stack, and a caller still holding "generation 3" from the browser before it would have matched the
 * new browser's third switch and gone on using refs taken against a document that no longer exists.
 * A counter that only ever goes up cannot collide with its own past.
 */
let activations = 0;

/** The pages a Bot has open, newest last, and which one is live. */
export type PageStack<T> = {
  /**
   * A page has opened. It becomes the live one.
   *
   * Idempotent: a page already on the stack does not move and does not count as an activation.
   * Chromium announces a page through more than one route — the context's `page` event, and our own
   * call when we opened one deliberately — and a stack that took both would report a switch that
   * never happened and throw away perfectly good refs.
   */
  opened: (page: T) => void;
  /**
   * A page has closed. Whatever is under it becomes live again.
   *
   * Takes a page from anywhere in the stack, not only the top: a popup can outlive the tab that
   * opened it, and a person can close a background tab while looking at another.
   */
  closed: (page: T) => void;
  /** The page to show and to act on, or undefined once every page has closed. */
  active: () => T | undefined;
  /** Every page still open, oldest first. For a caller that has to prune ones it knows are gone. */
  all: () => T[];
  /**
   * Which activation the live page is. Changes only when the live page changes.
   *
   * The number is opaque and only ever compared for equality. A caller keeps the last one it saw and
   * treats a different value as "everything I knew about the page is stale".
   */
  activation: () => number;
};

/**
 * An empty stack, which is what a browser is until its first page is announced.
 *
 * Empty rather than seeded with the page a browser launches with, so that page arrives through
 * `opened` like every other one and is followed by the same code. Seeding it meant the launch page
 * was the one page in the browser nobody had subscribed to the closing of, which is exactly the tab a
 * person is most likely to close.
 *
 * The gap that leaves is nominal: `profiles.ts` announces the launch page on the line after this one,
 * with nothing awaited in between, so no caller can observe an empty stack for a running browser.
 */
export function createPageStack<T>(): PageStack<T> {
  const pages: T[] = [];
  /** Zero is "no page has ever been live here", which is what an empty stack is. */
  let activation = 0;

  /**
   * Re-read which page is live and number the change if it moved.
   *
   * By identity, never by value. Two pages are distinct objects however alike their URLs look, and an
   * equality that compared anything else would miss a switch between two tabs on the same site, which
   * is the ordinary shape of a sign-in popup.
   */
  const settle = (wasLive: T | undefined): void => {
    if (pages[pages.length - 1] === wasLive) return;
    activation = ++activations;
  };

  return {
    opened(page) {
      if (pages.includes(page)) return;
      const wasLive = pages[pages.length - 1];
      pages.push(page);
      settle(wasLive);
    },

    closed(page) {
      const at = pages.indexOf(page);
      if (at === -1) return;
      const wasLive = pages[pages.length - 1];
      pages.splice(at, 1);
      settle(wasLive);
    },

    active() {
      return pages[pages.length - 1];
    },

    all() {
      return [...pages];
    },

    activation() {
      return activation;
    },
  };
}
