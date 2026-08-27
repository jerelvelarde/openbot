import { describe, expect, test } from "bun:test";
import { createPageStack } from "../src/active-page";

/**
 * Which of a Bot's open pages is the one being shown and acted on.
 *
 * A Bot's browser was bound to the page it launched with. Anything a site opened in a second window
 * was invisible to the live screen and unreachable by input, including while a person held the wheel,
 * which is precisely when it mattered: popup OAuth is how most "Sign in with Google" buttons work, so
 * the sign-ins a Bot hands to a human were the ones the human could not see. Clicking Google changed
 * nothing on the screen and every keystroke afterwards went to the page behind the window.
 *
 * These test the ordering and the numbering rather than the following. Subscribing to Chromium's
 * `page` event is Playwright's job and is not where a wrong answer was available; where to go when a
 * popup closes, and whether a caller is told its refs have died, both are.
 *
 * The numbering is the half that is easy to get wrong quietly. Elements are addressed by ref, and a
 * ref is minted per snapshot, so `e3` exists on the popup as well and names something else there —
 * "Delete everything" on one page and "Deny" on the other, measured. So the activation number moves
 * whenever the live page does, `currentPage` in index.ts throws the snapshot generation away when it
 * sees a different one, and a pending secret request refuses to be answered against a page it was not
 * made for. Without that last one, a request for an API key field went into the popup's public search
 * box and reported success.
 *
 * Pages are plain objects here. What the stack does with them is hold them in order and compare them
 * by identity, and a real `Page` would only make that need a browser.
 */

/**
 * A stack that has just opened its first page, which is how `profiles.ts` builds one.
 *
 * A browser announces the page it came up on through `opened` like every other, so that it is
 * followed by the same code and gets the same close handler.
 */
function stackOn<T>(first: T) {
  const pages = createPageStack<T>();
  pages.opened(first);
  return pages;
}

/** Stand-ins for pages, distinguishable in a failure message. */
const opener = { name: "opener" };
const popup = { name: "popup" };
const second = { name: "second popup" };

describe("following a page a site opens", () => {
  test("a browser starts on the page it launched with", () => {
    expect(stackOn(opener).active()).toBe(opener);
  });

  test("a page that opens becomes the one being shown", () => {
    // The whole defect, in one line. Chromium creates a page for `window.open` and gives it focus;
    // until this, nothing here noticed.
    const pages = stackOn(opener);
    pages.opened(popup);

    expect(pages.active()).toBe(popup);
  });

  test("closing it comes back to the page underneath", () => {
    // Why a stack and not "the newest page". A popup is a detour: the page beneath it is still the
    // work, and finishing a sign-in has to put the person back where they were.
    const pages = stackOn(opener);
    pages.opened(popup);
    pages.closed(popup);

    expect(pages.active()).toBe(opener);
  });

  test("three deep comes back one at a time", () => {
    const pages = stackOn(opener);
    pages.opened(popup);
    pages.opened(second);

    expect(pages.active()).toBe(second);
    pages.closed(second);
    expect(pages.active()).toBe(popup);
    pages.closed(popup);
    expect(pages.active()).toBe(opener);
  });

  test("a page closing from underneath does not move the screen", () => {
    // A popup can outlive the tab that opened it, and a person can close a background tab while
    // looking at another. Neither is a reason to change what is on screen.
    const pages = stackOn(opener);
    pages.opened(popup);
    pages.closed(opener);

    expect(pages.active()).toBe(popup);
    expect(pages.all()).toEqual([popup]);
  });

  test("closing a page that was never open changes nothing", () => {
    const pages = stackOn(opener);
    pages.closed(popup);

    expect(pages.active()).toBe(opener);
  });

  test("opening the same page twice does not stack it twice", () => {
    // Chromium announces a page through the context event, and we announce one we opened ourselves.
    // Counting both would leave a page that never goes away when its single close arrives.
    const pages = stackOn(opener);
    pages.opened(popup);
    pages.opened(popup);
    pages.closed(popup);

    expect(pages.active()).toBe(opener);
  });

  test("closing everything leaves no page rather than a dead one", () => {
    // A person can close the last tab at the end of a sign-in. Saying so is what lets the caller open
    // a fresh one instead of handing out a page Chromium has already destroyed.
    const pages = stackOn(opener);
    pages.closed(opener);

    expect(pages.active()).toBeUndefined();
    expect(pages.all()).toEqual([]);
  });

  test("pages are held by identity, not by what they look like", () => {
    // Two tabs on the same site are different pages however alike they are, and an equality that
    // compared anything but identity would miss the switch that a sign-in popup actually is.
    const pages = stackOn({ url: "https://example.test/" });
    pages.opened({ url: "https://example.test/" });

    expect(pages.all()).toHaveLength(2);
  });
});

describe("telling a caller that its refs have died", () => {
  test("a page opening is a new activation", () => {
    const pages = stackOn(opener);
    const before = pages.activation();
    pages.opened(popup);

    expect(pages.activation()).not.toBe(before);
  });

  test("so is coming back when it closes", () => {
    // Both directions. The opener's refs were minted before the popup existed, and the popup's
    // snapshot is the most recent one Playwright holds, so arriving back without a new number is the
    // same silent mis-resolution as leaving without one.
    const pages = stackOn(opener);
    pages.opened(popup);
    const onPopup = pages.activation();
    pages.closed(popup);

    expect(pages.activation()).not.toBe(onPopup);
  });

  test("a background tab closing is not", () => {
    // The live page did not move, so nothing about the refs against it changed. Numbering this would
    // throw away a good snapshot and cost the Bot a turn for something it never saw.
    const pages = stackOn(opener);
    pages.opened(popup);
    const onPopup = pages.activation();
    pages.closed(opener);

    expect(pages.activation()).toBe(onPopup);
  });

  test("re-announcing the page already showing is not", () => {
    const pages = stackOn(opener);
    const before = pages.activation();
    pages.opened(opener);

    expect(pages.activation()).toBe(before);
  });

  test("no two browsers ever report the same activation", () => {
    /*
     * The reason the number is process-wide rather than per browser.
     *
     * A browser that is evicted for the cap and relaunched builds a fresh stack, and the caller's
     * session can outlive it. Counting from one per stack meant a caller still holding "3" from the
     * browser before matched the new browser's third switch exactly, kept its refs, and resolved them
     * against a document that had not existed for minutes. A counter that only goes up cannot collide
     * with its own past.
     */
    const first = stackOn(opener);
    const relaunched = stackOn(opener);
    const seen = new Set([first.activation(), relaunched.activation()]);

    first.opened(popup);
    seen.add(first.activation());
    relaunched.opened(popup);
    seen.add(relaunched.activation());

    expect(seen.size).toBe(4);
  });

  test("an activation is never zero, because zero means nobody has looked yet", () => {
    // A caller starts at zero and compares. If a real activation could be zero, the first page it
    // ever saw would read as one it had already seen, and a pending secret request would compare
    // "not yet" against a real page and refuse.
    expect(createPageStack<typeof opener>().activation()).toBe(0);
    expect(stackOn(opener).activation()).toBeGreaterThan(0);
  });
});
