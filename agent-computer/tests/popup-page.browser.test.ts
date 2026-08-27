import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real Chromium, a real `window.open`, and the page the Bot ends up on.
 *
 * The unit tests next door prove where the stack goes. This proves the thing that was actually
 * broken: that Chromium's second page reaches the stack at all. Nothing about the ordering was ever
 * wrong — there was simply no listener, so a popup existed and nothing in this process knew.
 *
 * NOT PART OF `bun run test`, and deliberately so. Every other test here runs on a clone that has
 * only run `bun install` at the root, where `agent-computer` has no node_modules and Playwright is
 * not installed; that is a property `tests/clean-checkout.test.ts` asserts on purpose. So this file
 * imports `profiles.ts` dynamically, inside the tests, and asks for itself by name:
 *
 *   cd agent-computer && bun install && bunx playwright install chromium
 *   COMPUTER_BROWSER_TEST=1 bun test tests/popup-page.browser.test.ts
 *
 * Without `COMPUTER_BROWSER_TEST` it skips, so `bun run test` stays honest on a machine with no
 * browser.
 */

const asked = process.env.COMPUTER_BROWSER_TEST === "1";
const describeBrowser = asked ? describe : describe.skip;

/**
 * Two pages that cannot be mistaken for one another.
 *
 * Served over HTTP rather than as `data:` URLs, because Chromium refuses to open a `data:` URL as a
 * top-level document and the popup would never appear — which looks exactly like the defect under
 * test and would have this pass for the wrong reason.
 */
const PAGES: Record<string, string> = {
  "/opener": `<!doctype html><title>Opener</title><h1>Opener</h1>
    <button id="go" onclick="window.open('/popup', '_blank')">Sign in with Example</button>`,
  "/popup": `<!doctype html><title>Popup</title><h1>Popup</h1>
    <input id="password" type="password" />`,
};

let site: ReturnType<typeof Bun.serve> | undefined;
let profilesDir = "";

beforeAll(async () => {
  if (!asked) return;
  site = Bun.serve({
    port: 0,
    fetch(request) {
      const body = PAGES[new URL(request.url).pathname];
      if (!body) return new Response("Not found.", { status: 404 });
      return new Response(body, { headers: { "content-type": "text/html" } });
    },
  });
  profilesDir = await mkdtemp(join(tmpdir(), "openbot-popup-"));
});

afterAll(async () => {
  site?.stop(true);
  if (profilesDir) await rm(profilesDir, { recursive: true, force: true });
});

/** How long to let Chromium finish opening a window before calling it a failure. */
const OPEN_TIMEOUT_MS = 10_000;

describeBrowser("a page a site opens in a second window", () => {
  test(
    "becomes the page the Bot is shown and acts on, and closing it comes back",
    async () => {
      const { createProfiles } = await import("../src/profiles");
      const profiles = createProfiles(profilesDir);
      const origin = `http://127.0.0.1:${site?.port}`;

      try {
        const opener = await profiles.frontPage("popup-test");
        await opener.page.goto(`${origin}/opener`, {
          waitUntil: "domcontentloaded",
        });

        // A real click, because a `window.open` without a user gesture is refused by the popup
        // blocker and this would be testing the blocker instead.
        await opener.page.click("#go");

        const onPopup = await settleOn(profiles, `${origin}/popup`);
        // The defect: this used to be the opener for ever, so the live screen showed the page behind
        // the sign-in window and every keystroke went to it.
        expect(onPopup.page.url()).toBe(`${origin}/popup`);
        expect(await onPopup.page.title()).toBe("Popup");

        // And the caller is told, so refs taken against the opener are thrown away rather than
        // resolved against a document that never had them.
        expect(onPopup.activation).not.toBe(opener.activation);

        await onPopup.page.close();
        const back = await settleOn(profiles, `${origin}/opener`);
        expect(back.page.url()).toBe(`${origin}/opener`);
        expect(back.activation).not.toBe(onPopup.activation);
      } finally {
        await profiles.closeAll();
      }
    },
    OPEN_TIMEOUT_MS * 6,
  );

  test(
    "closing the last page leaves the browser usable rather than restarting it",
    async () => {
      // Ordinary at the end of a sign-in: the person closes the window they were given. The browser
      // and its cookies are the thing that just succeeded, so losing them here would discard it.
      const { createProfiles } = await import("../src/profiles");
      const profiles = createProfiles(profilesDir);

      try {
        const first = await profiles.frontPage("last-tab-test");
        await first.page.close();

        const next = await profiles.frontPage("last-tab-test");
        expect(next.page.isClosed()).toBe(false);
        expect(profiles.liveCount()).toBe(1);
      } finally {
        await profiles.closeAll();
      }
    },
    OPEN_TIMEOUT_MS * 6,
  );
});

describeBrowser("a browser that cannot produce a page", () => {
  test(
    "is replaced rather than wedging every request after it",
    async () => {
      /*
       * The failure this guards is an outage, not a wrong answer.
       *
       * "Connected" is not the same question as "can this still do anything": a renderer killed for
       * memory takes every target with it while the browser process stays up. Without the recovery,
       * the throw left the dead entry in the map, the next caller found it and threw identically, and
       * the computer answered the same error for every request until the container restarted — the
       * precise outage the relaunch exists to prevent.
       *
       * The state is built by taking `newPage` away from the live context, which is the call that
       * fails in the real thing, and then emptying the stack so it has to be reached.
       */
      const { createProfiles } = await import("../src/profiles");
      const profiles = createProfiles(profilesDir);

      try {
        const first = await profiles.frontPage("wedge-test");
        const context = first.page.context();
        context.newPage = () =>
          Promise.reject(
            new Error("Target page, context or browser has been closed"),
          );
        await first.page.close();

        const recovered = await profiles.frontPage("wedge-test");

        expect(recovered.page.isClosed()).toBe(false);
        // One browser, not two: the unusable one is closed on the way past rather than left running.
        expect(profiles.liveCount()).toBe(1);
        // And it stays repaired, rather than working once and wedging on the next call.
        const again = await profiles.frontPage("wedge-test");
        expect(again.page.isClosed()).toBe(false);
      } finally {
        await profiles.closeAll();
      }
    },
    OPEN_TIMEOUT_MS * 6,
  );
});

describeBrowser("the page handed back and the number describing it", () => {
  test(
    "never disagree, even when a window opens while a replacement is being made",
    async () => {
      /*
       * The race the `FrontPage` type exists to close, driven rather than reasoned about.
       *
       * Opening a page is awaited, so a window the site opens during that await is announced after
       * the replacement and is the one in front by the time the call returns. Handing back the
       * replacement with the stack's number is a page and a number that disagree — and because the
       * caller records that number as the one it has seen, the next call returns the genuinely front
       * page carrying a number it already knows, so nothing is invalidated and refs minted against
       * the replacement resolve against the other document.
       *
       * Made deterministic by opening the second window inside `newPage`, which is exactly where the
       * window would land: after the replacement exists and before the caller is answered. Waiting on
       * a real site to win a race would pass on a fast machine and mean nothing.
       */
      const { createProfiles } = await import("../src/profiles");
      const profiles = createProfiles(profilesDir);

      try {
        const start = await profiles.frontPage("race-test");
        const context = start.page.context();
        const openPage = context.newPage.bind(context);
        await start.page.close();

        let intruder: unknown;
        context.newPage = async () => {
          const replacement = await openPage();
          intruder = await openPage();
          return replacement;
        };

        const during = await profiles.frontPage("race-test");
        context.newPage = openPage;

        // The page that was in front when the answer was given, not the one that was made for it.
        expect(during.page).toBe(intruder);

        // And the pair still agrees on the next call, which is the property that actually protects
        // the refs: a different page always arrives with a different number.
        const after = await profiles.frontPage("race-test");
        expect(after.page).toBe(during.page);
        expect(after.activation).toBe(during.activation);
      } finally {
        await profiles.closeAll();
      }
    },
    OPEN_TIMEOUT_MS * 6,
  );
});

describeBrowser("what the front page says about itself", () => {
  test(
    "names the site, and gives a following window a different name from the opener",
    async () => {
      // The origin is what a person driving is shown before they type. It has to be the document
      // actually in front, and a window a site opens has to be distinguishable from the page under
      // it — that pair is what the secret guard compares.
      const { createProfiles } = await import("../src/profiles");
      const profiles = createProfiles(profilesDir);
      const origin = `http://127.0.0.1:${site?.port}`;

      try {
        const opener = await profiles.frontPage("origin-test");
        await opener.page.goto(`${origin}/opener`, {
          waitUntil: "domcontentloaded",
        });
        const onOpener = await profiles.frontPage("origin-test");
        expect(onOpener.origin).toBe(origin);

        await onOpener.page.click("#go");
        const onPopup = await settleOn(
          profiles,
          `${origin}/popup`,
          "origin-test",
        );
        expect(onPopup.origin).toBe(origin);
        expect(onPopup.pageId).not.toBe(onOpener.pageId);
      } finally {
        await profiles.closeAll();
      }
    },
    OPEN_TIMEOUT_MS * 6,
  );
});

/**
 * Wait for the Bot's page to be the one expected.
 *
 * Polled rather than awaited on an event, because the caller under test is an accessor: the question
 * is what a route asking right now would be handed, and a popup arrives on its own schedule.
 */
async function settleOn(
  profiles: { frontPage: (botId: string) => Promise<FrontPageLike> },
  url: string,
  botId = "popup-test",
): Promise<FrontPageLike> {
  const until = Date.now() + OPEN_TIMEOUT_MS;
  let last = await profiles.frontPage(botId);
  while (last.page.url() !== url && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await profiles.frontPage(botId);
  }
  return last;
}

/** Enough of what `frontPage` returns for this file, without importing Playwright's types. */
type FrontPageLike = {
  pageId: string;
  origin: string;
  page: {
    url: () => string;
    title: () => Promise<string>;
    close: () => Promise<void>;
    isClosed: () => boolean;
    goto: (url: string, options?: unknown) => Promise<unknown>;
    click: (selector: string) => Promise<void>;
    context: () => {
      newPage: (() => Promise<unknown>) & {
        bind: (thisArg: unknown) => () => Promise<unknown>;
      };
    };
  };
  activation: number;
};
