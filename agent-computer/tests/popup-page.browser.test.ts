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
        const opener = await profiles.activePage("popup-test");
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
        const first = await profiles.activePage("last-tab-test");
        await first.page.close();

        const next = await profiles.activePage("last-tab-test");
        expect(next.page.isClosed()).toBe(false);
        expect(profiles.liveCount()).toBe(1);
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
  profiles: { activePage: (botId: string) => Promise<ActivePageLike> },
  url: string,
): Promise<ActivePageLike> {
  const until = Date.now() + OPEN_TIMEOUT_MS;
  let last = await profiles.activePage("popup-test");
  while (last.page.url() !== url && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await profiles.activePage("popup-test");
  }
  return last;
}

/** Enough of what `activePage` returns for this file, without importing Playwright's types. */
type ActivePageLike = {
  page: {
    url: () => string;
    title: () => Promise<string>;
    close: () => Promise<void>;
    isClosed: () => boolean;
    goto: (url: string, options?: unknown) => Promise<unknown>;
    click: (selector: string) => Promise<void>;
  };
  activation: number;
};
