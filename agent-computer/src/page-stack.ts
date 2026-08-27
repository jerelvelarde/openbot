/**
 * Which of a Bot's open pages is in front, and what document that is.
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
 * be open. A stack says both of those in one structure — push on open, drop on close, the top is in
 * front — and it says the right thing for three pages deep, where "the newest" says nothing about
 * where to go next.
 *
 * "IN FRONT" MEANS "MOST RECENTLY OPENED", AND THAT IS NOT THE SAME THING. Chromium focuses a
 * `window.open` popup, so for the case this exists for the two coincide, but a page opened into a
 * background tab does not take focus and this will still put it on top. Real focus was considered and
 * rejected: nothing in Playwright reports it, `document.hasFocus()` needs a round-trip into a page
 * that may not have a document yet at the moment it is announced, and a screen that followed a poll
 * of that would flicker between two pages. So the promise here is the honest one — this is the page
 * the browser most recently opened — and `top()` rather than `active()` says so at every call site.
 *
 * WHY THIS IS NOT A BOOLEAN. Switching pages does not only change what is on screen. Elements are
 * addressed by ref, and a ref is only meaningful against the document it was taken from: it is minted
 * per snapshot, so `e3` exists on the window that just opened as well and names something else there.
 * Measured on a two-button page, `e3` was "Delete everything" on the opener and "Deny" on the popup.
 * A switch that changed only the viewing path would leave the acting path pointing at the first and
 * reaching the second, so every activation is numbered here and callers throw away what they knew
 * when the number moves.
 *
 * The number is not an identity, though, and that difference had teeth. `originOf` and the per-page
 * identity `profiles.ts` keeps beside it are what answer "is this the same document the Bot described,
 * and is it the one the person was told about" — see `/human/secret` in index.ts, and the note there
 * on what a number alone let through.
 *
 * It lives in its own file with no Playwright import, for the reason `browser-eviction.ts` and
 * `viewer.ts` do: `profiles.ts` imports Playwright at module scope, so a decision left there needs a
 * browser merely to be imported by a test. The ordering is the part with a wrong answer available;
 * opening and closing pages is Playwright's job and stays in `profiles.ts`.
 */

/**
 * How many times any Bot's front page has changed, across this process.
 *
 * Process-wide and never reset, so no two activations anywhere carry the same number. Per-stack
 * counting looked equivalent and was not: a browser that is evicted and relaunched builds a fresh
 * stack, and a caller still holding "generation 3" from the browser before it would have matched the
 * new browser's third switch and gone on using refs taken against a document that no longer exists.
 * A counter that only ever goes up cannot collide with its own past.
 */
let activations = 0;

/**
 * How many pages one browser is tracked as having open.
 *
 * A bound rather than a policy. Nothing closes a page here, so a site that opens windows in a loop
 * would otherwise grow this array for as long as the browser lives, and every prune would walk all of
 * it. Past the cap the oldest is forgotten rather than closed: it is the page furthest from what
 * anybody is looking at, forgetting it costs only the ability to fall back to it, and its own close
 * event is already a no-op for a page the stack does not hold.
 */
const MAX_TRACKED_PAGES = 32;

/** The pages a Bot has open, oldest first, and which one is in front. */
export type PageStack<T> = {
  /**
   * A page has opened. It goes to the front.
   *
   * Idempotent: a page already on the stack does not move and does not count as an activation.
   * Chromium announces a page through more than one route — the context's `page` event, and our own
   * call when we opened one deliberately — and a stack that took both would report a switch that
   * never happened and throw away perfectly good refs.
   */
  opened: (page: T) => void;
  /**
   * A page has closed. Whatever is under it comes to the front.
   *
   * Takes a page from anywhere in the stack, not only the top: a popup can outlive the tab that
   * opened it, and a person can close a background tab while looking at another.
   */
  closed: (page: T) => void;
  /**
   * Drop every page the caller can see has gone, in one pass.
   *
   * Here rather than as a loop over `all()` at the call site because this runs on every route call
   * and on every tick of the viewer's follow loop, and the call-site version allocated a copy of the
   * array each time in order to iterate it. It also settles the activation once for the whole sweep
   * rather than once per page removed.
   */
  prune: (isGone: (page: T) => boolean) => void;
  /** Whether this page is one of the ones being tracked. */
  holds: (page: T) => boolean;
  /** The page to show and to act on, or undefined once every page has closed. */
  top: () => T | undefined;
  /** Every page still open, oldest first. */
  all: () => T[];
  /**
   * Which activation the front page is. Changes only when the front page changes.
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
  /**
   * The same pages, for asking whether one is held.
   *
   * A set beside the array rather than `array.includes`. `profiles.ts` asks this once per page it is
   * handed, so the array version was quadratic in the number of tabs a site had opened, on a path
   * that runs inside Chromium's own event handler.
   */
  const present = new Set<T>();
  /** Zero is "no page has ever been in front here", which is what an empty stack is. */
  let activation = 0;

  /**
   * Re-read which page is in front and number the change if it moved.
   *
   * By identity, never by value. Two pages are distinct objects however alike their URLs look, and an
   * equality that compared anything else would miss a switch between two tabs on the same site, which
   * is the ordinary shape of a sign-in popup.
   */
  const settle = (wasInFront: T | undefined): void => {
    if (pages[pages.length - 1] === wasInFront) return;
    activation = ++activations;
  };

  return {
    opened(page) {
      if (present.has(page)) return;
      const wasInFront = pages[pages.length - 1];
      pages.push(page);
      present.add(page);
      // The oldest goes, never the newest: the front page is the one somebody is looking at.
      while (pages.length > MAX_TRACKED_PAGES) {
        const forgotten = pages.shift();
        if (forgotten !== undefined) present.delete(forgotten);
      }
      settle(wasInFront);
    },

    closed(page) {
      if (!present.has(page)) return;
      const wasInFront = pages[pages.length - 1];
      pages.splice(pages.indexOf(page), 1);
      present.delete(page);
      settle(wasInFront);
    },

    prune(isGone) {
      const wasInFront = pages[pages.length - 1];
      let kept = 0;
      for (const page of pages) {
        if (isGone(page)) {
          present.delete(page);
          continue;
        }
        pages[kept] = page;
        kept += 1;
      }
      if (kept === pages.length) return;
      pages.length = kept;
      settle(wasInFront);
    },

    holds(page) {
      return present.has(page);
    },

    top() {
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

/**
 * The part of a URL that says whose document this is.
 *
 * The one fact a person driving somebody else's browser has to be told, and the one this process
 * never said. A page the Bot follows is chosen by the site, not by us: a compromised script on the
 * page can call `window.open` on any address it likes, and the window it opens takes the live screen
 * within a second — arriving, in a sign-in the Bot has just asked for help with, exactly when the
 * person is expecting a sign-in window to arrive. Origin is what tells `accounts.google.com` from a
 * convincing copy of it, and nothing else on that screen does.
 *
 * The origin rather than the whole URL. It is the part that decides who receives what is typed, it is
 * short enough to read at a glance without a horizontal scroll, and the rest of a URL is where a
 * lookalike hides its real host behind a long and reassuring path.
 *
 * A scheme with no origin — `about:blank`, `data:`, `blob:` — answers with the scheme and what
 * follows it rather than with the word "null", because "null" where a site's name belongs reads as a
 * bug rather than as "this is not a website".
 */
export function originOf(url: string): string {
  if (!url.trim()) return "about:blank";
  try {
    const parsed = new URL(url);
    if (parsed.origin && parsed.origin !== "null") return parsed.origin;
    return `${parsed.protocol}${parsed.pathname}`.slice(0, 60);
  } catch {
    // Not a URL at all. Whatever it is, it is what the browser says it is on, and hiding it would
    // leave the person with nothing rather than with something odd-looking they can question.
    return url.slice(0, 60);
  }
}

/**
 * What to tell a person whose screen has just been taken by a window they did not open.
 *
 * A function rather than a constant because the address is the whole message. "A new window opened,
 * please confirm" is a dialog people dismiss; naming the site, and saying in the same breath what
 * typing would do, is the difference between a confirmation and a check.
 *
 * Exported from here, beside `originOf`, so that the refusal and the surface that explains it cannot
 * drift apart, and so a test can assert the address is in it without starting a browser.
 */
export function unacceptedPageMessage(origin: string): string {
  return `The screen has moved to a window that opened by itself, at ${origin}. Nothing you type reaches it until you confirm that is where you meant to be — check the address is the one you expect, because anything typed now would go to that site.`;
}
