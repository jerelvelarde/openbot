import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { InfiniteData } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, configure, render, waitFor } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { botThreadKey } from "../src/lib/copilot/bot-thread";
import {
  type RosterItem,
  type RosterPage,
  rosterKeys,
} from "../src/lib/roster/queries";
import {
  mostRecentBotChat,
  Route,
  resolveBotChat,
  resolverView,
  shouldAttemptAdoption,
  shouldResolveBotChat,
} from "../src/routes/_authed/_app/bot";

describe("resolveBotChat", () => {
  test("opens the conversation this person was last in", () => {
    expect(resolveBotChat({ mostRecent: "botchat_1" })).toEqual({
      open: "botchat_1",
    });
  });

  test("starts one when there is nothing to open", () => {
    // A first visit, or a person who archived everything: `?agent=` must still land somewhere usable.
    expect(resolveBotChat({ mostRecent: null })).toEqual({ create: true });
  });
});

const ROW: RosterItem = {
  kind: "bot_chat",
  id: "botchat_1",
  name: "Bot",
  agentIds: ["agent_1"],
  threadId: "thread_1",
  active: true,
  archived: false,
  lastMessage: null,
  lastMessageAt: null,
  lastMessageAgentId: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  pinned: false,
  lastReadAt: null,
};

describe("mostRecentBotChat", () => {
  // Defect 4: the roster arrives pinned-first, then by recency (see `RECENCY` in
  // server/src/roster/order.ts), so a naive "first matching row" reads as "the pinned one," not "the
  // one this person actually used most recently." `BotChatStore.mostRecent` orders on recency alone
  // (`coalesce(last_message_at, created_at)`), so this has to agree with that, not with roster order.
  const OLDER_PINNED: RosterItem = {
    ...ROW,
    id: "botchat_pinned_old",
    pinned: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const NEWER_UNPINNED: RosterItem = {
    ...ROW,
    id: "botchat_unpinned_new",
    pinned: false,
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  test("a newer unpinned chat beats an older pinned one, even sitting first in roster order", () => {
    // The array below is in the order the roster actually arrives: pinned first. Taking the first
    // entry would return the pinned-but-stale row; this must not.
    const roster = [OLDER_PINNED, NEWER_UNPINNED];
    expect(mostRecentBotChat(roster, "agent_1")?.id).toBe(
      "botchat_unpinned_new",
    );
  });

  test("order in the input does not matter — same answer either way", () => {
    const roster = [NEWER_UNPINNED, OLDER_PINNED];
    expect(mostRecentBotChat(roster, "agent_1")?.id).toBe(
      "botchat_unpinned_new",
    );
  });

  test("falls back to createdAt when lastMessageAt is null on both", () => {
    // `lastMessageAt` is null for any conversation nobody has spoken in — every conversation on the
    // visit that creates it — so this fallback carries the ordinary case, not an edge case.
    expect(OLDER_PINNED.lastMessageAt).toBeNull();
    expect(NEWER_UNPINNED.lastMessageAt).toBeNull();
    const roster = [OLDER_PINNED, NEWER_UNPINNED];
    expect(mostRecentBotChat(roster, "agent_1")?.id).toBe(
      "botchat_unpinned_new",
    );
  });

  test("lastMessageAt outranks createdAt when present", () => {
    const recentlyMessaged: RosterItem = {
      ...OLDER_PINNED,
      id: "botchat_old_but_just_messaged",
      lastMessageAt: "2026-08-31T00:00:00.000Z",
    };
    const roster = [recentlyMessaged, NEWER_UNPINNED];
    expect(mostRecentBotChat(roster, "agent_1")?.id).toBe(
      "botchat_old_but_just_messaged",
    );
  });

  /*
   * The tie-break, pinned from both sides.
   *
   * Not a formality: with `lastMessageAt` null until somebody speaks, `createdAt` decides, and two
   * rows sharing a `createdAt` is what seeding, importing, or creating two in one transaction
   * produces. `BotChatStore.mostRecent` breaks that tie on `desc(botChats.id)`, and this function
   * exists to give the same answer the server would. Both orders are asserted because a comparison
   * left unpinned answers "whichever I saw first", which is a different rule that happens to agree
   * half the time.
   */
  const SAME_TIME_LOWER: RosterItem = {
    ...ROW,
    id: "botchat_aaaa",
    createdAt: "2026-08-30T00:00:00.000Z",
  };
  const SAME_TIME_GREATER: RosterItem = {
    ...ROW,
    id: "botchat_bbbb",
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  test("a tie on recency goes to the greater id, as the server's second ordering term does", () => {
    expect(
      mostRecentBotChat([SAME_TIME_GREATER, SAME_TIME_LOWER], "agent_1")?.id,
    ).toBe("botchat_bbbb");
  });

  test("a tie answers the same whichever way round the rows arrive", () => {
    expect(
      mostRecentBotChat([SAME_TIME_LOWER, SAME_TIME_GREATER], "agent_1")?.id,
    ).toBe("botchat_bbbb");
  });

  test("ignores rows for a different Bot and rows that are channels, not bot chats", () => {
    const otherAgent: RosterItem = {
      ...NEWER_UNPINNED,
      id: "botchat_other_agent",
      agentIds: ["agent_2"],
    };
    const channel: RosterItem = {
      ...NEWER_UNPINNED,
      id: "channel_1",
      kind: "channel",
      createdAt: "2026-08-31T00:00:00.000Z",
    };
    expect(
      mostRecentBotChat([otherAgent, channel, OLDER_PINNED], "agent_1")?.id,
    ).toBe("botchat_pinned_old");
  });

  test("nothing matching returns null", () => {
    expect(mostRecentBotChat([], "agent_1")).toBeNull();
  });
});

describe("shouldAttemptAdoption", () => {
  // Defect 2: a browser upgrading into this feature has no `bot_chats` rows yet — `mostRecent` reads
  // `null` — and used to go straight to create, before the remembered thread ever got a chance to be
  // rescued. This is the pure decision behind the fix: "about to create, and something is
  // remembered" is the one case that must not create without trying to adopt first.
  test("a browser upgrading in — no rows yet, but a remembered thread — attempts adoption before create", () => {
    expect(
      shouldAttemptAdoption({ mostRecent: null, remembered: "thread_1" }),
    ).toBe(true);
  });

  test("a genuinely first visit — no rows, nothing remembered — has nothing to adopt", () => {
    expect(shouldAttemptAdoption({ mostRecent: null, remembered: null })).toBe(
      false,
    );
  });

  test("a row already exists — nothing to gain from checking; the chat screen's hook is the belt", () => {
    expect(
      shouldAttemptAdoption({
        mostRecent: "botchat_1",
        remembered: "thread_1",
      }),
    ).toBe(false);
  });

  test("a row already exists and nothing is remembered either — plainly nothing to do", () => {
    expect(
      shouldAttemptAdoption({ mostRecent: "botchat_1", remembered: null }),
    ).toBe(false);
  });
});

describe("shouldResolveBotChat", () => {
  /*
   * This is the regression test for the duplicate-conversation defect: `roster.isPending` reads
   * `false` in the *error* state too, where `data` is still `undefined`, so a guard written against
   * `isPending` misreads a failed load as "nothing to open" and forks a second `bot_chats` row. If
   * `shouldResolveBotChat` is ever rewritten to treat `data: undefined` as "safe to act" — which is
   * what a revert to `isPending`-shaped reasoning would do — this assertion fails.
   */
  test("a failed roster load (data undefined) does not act", () => {
    expect(shouldResolveBotChat({ data: undefined, started: false })).toBe(
      false,
    );
  });

  // The case the fix must not break: a first visit, or a person who archived everything, resolves
  // the roster to a genuinely empty array rather than to `undefined`, and that has to act — it is
  // the entire reason this resolver exists.
  test("a genuinely empty roster ([]) still acts", () => {
    expect(shouldResolveBotChat({ data: [], started: false })).toBe(true);
  });

  test("a resolved roster with rows acts", () => {
    expect(shouldResolveBotChat({ data: [ROW], started: false })).toBe(true);
  });

  test("does not act twice, once a run has already started", () => {
    expect(shouldResolveBotChat({ data: [ROW], started: true })).toBe(false);
  });
});

describe("resolverView", () => {
  test("a resolved id is an open conversation to hand over to", () => {
    expect(resolverView({ resolved: "botchat_1", failure: null })).toEqual({
      kind: "opening",
      botChatId: "botchat_1",
    });
  });

  test("a failure with nothing resolved is the sentence to say", () => {
    expect(
      resolverView({ resolved: null, failure: new Error("Roster is down") }),
    ).toEqual({ kind: "failed", message: "Roster is down" });
  });

  /*
   * The precedence, which is the only reason this is a function rather than two `if`s: a create that
   * worked, followed by a roster refetch that failed, must not replace the way out of a stuck
   * redirect with a sentence about the roster. The conversation exists; saying otherwise would be
   * false as well as unhelpful.
   */
  test("an id already resolved outranks a failure that arrived after it", () => {
    expect(
      resolverView({
        resolved: "botchat_1",
        failure: new Error("Roster is down"),
      }),
    ).toEqual({ kind: "opening", botChatId: "botchat_1" });
  });

  test("neither yet is still resolving", () => {
    expect(resolverView({ resolved: null, failure: null })).toEqual({
      kind: "resolving",
    });
  });
});

/*
 * THE RENDER HARNESS, and the state of it in this suite.
 *
 * `@testing-library/react`, `@testing-library/user-event`, `happy-dom` and
 * `@happy-dom/global-registrator` are all declared in app/package.json and installed. Nothing else
 * in this suite renders anything, so the tests below are the first DOM in it, and a comment on
 * `shouldResolveBotChat` used to assert the opposite — that no harness existed here — which is how
 * the defect the tests below cover went a whole review round without one.
 *
 * WHY THE DOM IS NEEDED AT ALL, when everything above is a pure function: the defect is effect
 * scheduling. A resolution cancelled by a dependency change rather than by an unmount is not a fact
 * about any expression — it is a fact about when React runs cleanups, and about StrictMode running
 * one on the first mount in development. A pure model of that would have to assume the very
 * distinction the old code got wrong.
 *
 * WHY THIS DOES NOT MAKE THE SUITE ORDER-DEPENDENT, AND WHAT WOULD. `bun test` runs every file in
 * one process, and `app/tests/auth-client.test.ts` assigns `globalThis.window` at module scope with
 * a plain `=`, giving a bare object with no DOM behind it. That is exactly the sort of thing a
 * global DOM collides with, and it does not collide here for one reason worth knowing before writing
 * the next one of these: `bun test` evaluates a file's module scope immediately before running that
 * same file's tests, never all of them up front, so a later file's assignment cannot reach these
 * tests and this file's registration cannot reach an earlier file's. What keeps that true is the two
 * rules below, both of which the registrator supports: register only if nothing else already has,
 * and unregister in `afterAll`. `GlobalRegistrator.register` saves the descriptor of every global it
 * replaces — a foreign `window` included — and `unregister` puts them all back, so the process is
 * left as it was found. Verified in both orders against `auth-client.test.ts`, and with
 * `router.test.ts`, which builds the real generated route tree, on either side.
 *
 * ONE TRAP, for whoever writes the second one of these: `@testing-library/react`'s `screen` binds to
 * `document.body` when the module is imported, which here is before `beforeAll` has registered
 * anything, so it throws when used. The tests below query through the value `render` returns, which
 * binds at call time.
 */
let registeredHere = false;

beforeAll(() => {
  /*
   * `@testing-library/react` waits one second by default, and every `waitFor` and `findBy*` below
   * inherits it. That budget is not a fact about anything under test — nothing here is timing
   * sensitive by design; a render either resolves and redirects or it does not — and it is small
   * enough to be spent on load rather than on work: these tests have failed at 1003–1005 ms, the
   * duration landing on the timeout itself rather than anywhere near it, which is what a starved
   * event loop looks like rather than a stuck resolution. `bun run test` puts app, server and worker
   * in one process, so CI is where that load actually lives. A longer budget costs nothing on the
   * happy path: `waitFor` returns as soon as its assertion passes, so this only lengthens genuine
   * failures.
   */
  configure({ asyncUtilTimeout: 5000 });
  if (GlobalRegistrator.isRegistered) return;
  GlobalRegistrator.register({ url: "http://localhost:3000/" });
  registeredHere = true;
});

afterAll(async () => {
  // Put back, for the same reason the registration below is undone: `configure` writes to a
  // module-level object shared by every file that imports the library, and this file is the only one
  // that does today — which is exactly the assumption worth not leaving a landmine under.
  configure({ asyncUtilTimeout: 1000 });
  if (!registeredHere) return;
  await GlobalRegistrator.unregister();
  registeredHere = false;
});

/** The Bot the stubbed deployment has. Only its id is read by the screen. */
const AGENT = { id: "agent_1", name: "Bot", title: "Bot" };

/** What the stubbed `POST /api/bot-chats` hands back. */
const CREATED = "botchat_created";

/**
 * The conversation a browser upgrading into this feature is still holding, and the row adopting it
 * produces. Distinct ids from `CREATED` on purpose: which of the two the resolver lands on is the
 * whole difference between rescuing somebody's transcript and burying it under an empty chat.
 */
const LEGACY_THREAD = "thread_legacy_1";
const ADOPTED = "botchat_adopted";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Script = {
  /** `GET /api/agents` */
  agents?: () => Response;
  /** `GET /api/roster?status=active` */
  roster?: () => Response;
  /** `POST /api/bot-chats`, deferrable so a test can hold a create in flight. */
  create?: () => Response | Promise<Response>;
  /** `GET /api/threads/:threadId` — whether Intelligence still has a remembered thread. */
  check?: () => Response;
  /** `POST /api/bot-chats/adopt`, deferrable so a test can hold an adoption in flight. */
  adopt?: () => Response | Promise<Response>;
};

let calls: Array<{ method: string; path: string }> = [];
const realFetch = globalThis.fetch;

/**
 * The server this screen talks to, as the requests it can make.
 *
 * `fetch` rather than a mocked module: `client` in app/src/lib/client.ts is the only thing between
 * this screen and the wire, and stubbing at the wire keeps the mutation options, the query options
 * and their invalidations — including the roster invalidation a successful create fires, which is
 * one of the dependency changes that used to strand the redirect — exactly as they are in the app.
 *
 * The two adoption routes are stubbed here even though most tests never reach them, because the
 * unstubbed fall-through below answers 500 and `attemptAdoption` folds every failure into "adopted
 * nothing": a missing stub on this path does not fail loudly, it quietly turns an adoption test into
 * a create test. Nothing seeds the remembered key unless a test asks for it, so the defaults only
 * decide what the tests that do seed it get.
 */
function serve(script: Script = {}): void {
  calls = [];
  const routes = {
    agents: script.agents ?? (() => jsonResponse({ agents: [AGENT] })),
    roster:
      script.roster ?? (() => jsonResponse({ items: [], nextCursor: null })),
    create: script.create ?? (() => jsonResponse({ botChat: { id: CREATED } })),
    check: script.check ?? (() => jsonResponse({ known: true })),
    adopt: script.adopt ?? (() => jsonResponse({ botChat: { id: ADOPTED } })),
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path });
    if (path.startsWith("/api/agents")) return Promise.resolve(routes.agents());
    if (path.startsWith("/api/roster")) return Promise.resolve(routes.roster());
    if (path.startsWith("/api/threads/")) {
      return Promise.resolve(routes.check());
    }
    // Before the exact-match create below rather than after it, so that a path that merely starts
    // the same way cannot be read as a create.
    if (path === "/api/bot-chats/adopt" && method === "POST") {
      return Promise.resolve(routes.adopt());
    }
    if (path === "/api/bot-chats" && method === "POST") {
      return Promise.resolve(routes.create());
    }
    return Promise.resolve(
      jsonResponse({ error: `No stub for ${method} ${path}` }, 500),
    );
  }) as typeof fetch;
}

function creates(): number {
  return calls.filter(
    (call) => call.method === "POST" && call.path === "/api/bot-chats",
  ).length;
}

function adopts(): number {
  return calls.filter(
    (call) => call.method === "POST" && call.path === "/api/bot-chats/adopt",
  ).length;
}

/**
 * Give a resolution that is already past its last `await` every chance to reach the request it must
 * not make.
 *
 * `waitFor` is the right tool for an assertion that becomes true; this one is an absence, and the
 * absence has no signal to poll. An unmounted resolver writes nothing by definition, and the roster
 * invalidation a successful adopt fires reaches no observer once the screen is gone, so there is no
 * later event to hang the assertion on. What separates the released adopt response from the create is
 * microtasks — `client` issues its `fetch` synchronously inside the mutation function — and each turn
 * of the macrotask queue below drains all of them. Two, so that a hop this comment did not anticipate
 * does not turn a real regression into a passing test; without the mount check in `resolve` the create
 * is in `calls` by the time the first one returns.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The `GET /api/threads/:threadId` paths this screen asked for, in order. */
function checked(): string[] {
  return calls
    .filter((call) => call.path.startsWith("/api/threads/"))
    .map((call) => call.path);
}

/**
 * The options `Route` was declared with, so `mount` below can put them back.
 *
 * `Route.update` is `Object.assign` onto the route's own options — the mechanism routeTree.gen.ts
 * uses — so re-parenting it onto a test tree mutates the object app/src/router.ts imports. Restored
 * after every render for that reason: this file must not be able to change what another test file
 * sees, whichever order they run in.
 */
const ROUTE_OPTIONS = { ...Route.options };

/**
 * The screen, on a real router, with `/bot` re-parented onto a tree of exactly three routes.
 *
 * A real router rather than a stubbed `navigate`, because two of the things under test are the
 * router's own: that `validateSearch` still answers `?agent=`, and that the redirect replaces the
 * `/bot` entry instead of pushing past it — which is a fact about history, assertable only if there
 * is history. `initialEntries` therefore starts somewhere else and walks to `/bot`, the way a person
 * arrives.
 */
function mount(
  options: { url?: string; roster?: RosterItem[]; stallChat?: boolean } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      // No retries, so a stubbed failure is the error state immediately; no staleness, so the only
      // refetches in these tests are the ones the app itself asks for.
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  if (options.roster) {
    const seeded: InfiniteData<RosterPage, string> = {
      pages: [{ items: options.roster, nextCursor: null }],
      pageParams: [""],
    };
    queryClient.setQueryData(rosterKeys.list("active"), seeded);
  }

  const root = createRootRoute();
  const elsewhere = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => createElement("p", null, "somewhere else"),
  });
  const bot = Route.update({
    id: "/bot",
    path: "/bot",
    getParentRoute: () => root,
  } as Parameters<typeof Route.update>[0]);
  const chat = createRoute({
    getParentRoute: () => root,
    path: "/bot/$botChatId",
    component: () => createElement("p", null, "the conversation"),
    // A conversation that never finishes loading, for the one test that needs to look at the
    // resolver while the redirect it asked for has not arrived. The router keeps the current match
    // on screen until the next one resolves, so `/bot` is what stays rendered.
    ...(options.stallChat
      ? { loader: () => new Promise<never>(() => {}) }
      : {}),
  });
  const router = createRouter({
    routeTree: root.addChildren([elsewhere, bot, chat]),
    history: createMemoryHistory({
      initialEntries: ["/", options.url ?? "/bot"],
    }),
  });

  const view = render(
    createElement(
      StrictMode,
      null,
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, {
          router,
        } as React.ComponentProps<typeof RouterProvider>),
      ),
    ),
  );
  return { queryClient, router, view };
}

describe("the resolver on screen", () => {
  beforeEach(() => {
    serve();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
    Route.options = { ...ROUTE_OPTIONS };
    window.localStorage.clear();
  });

  /*
   * The defect, reproduced by arriving the way everybody arrives.
   *
   * `roster.data` is already in the cache before this mounts — the sidebar holds the identical
   * `rosterListQueryOptions("active")` query, so anyone reaching `/bot` from inside the app has it —
   * which means the resolver acts on its first effect run, and StrictMode's cleanup-and-re-run lands
   * on top of an in-flight `resolve()`. That used to cancel the navigation and latch the retry shut:
   * a `bot_chats` row written, and a blank screen with no error, because the create had succeeded.
   */
  test("creates a conversation and opens it, once, under StrictMode", async () => {
    const { router, view } = mount({ roster: [] });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/bot/${CREATED}`),
    );
    expect(await view.findByText("the conversation")).toBeDefined();
    expect(creates()).toBe(1);
  });

  /*
   * The Back-button trap, asserted on history rather than on the argument that avoids it. `/bot`
   * renders no conversation of its own, so a pushed entry sends Back to a screen that immediately
   * redirects forwards again, with no way past it.
   */
  test("replaces the /bot entry, so Back reaches where the person came from", async () => {
    const { router, view } = mount({ roster: [] });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/bot/${CREATED}`),
    );
    router.history.back();

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(await view.findByText("somewhere else")).toBeDefined();
  });

  /*
   * The state this screen used to render as nothing at all: a conversation resolved, and a redirect
   * that has not arrived. Here the conversation is merely slow to load, which is the benign version;
   * the version worth guarding against is the one where the redirect never lands, because that used
   * to be a blank screen with no error to read — the create had succeeded, so there was nothing for
   * `roster.error` or `createBotChat.error` to say. A sentence and a link is what a person can act
   * on, and the link is the way through by hand.
   */
  test("says a conversation is opening, with a way in, while the redirect has not arrived", async () => {
    const { view } = mount({ roster: [], stallChat: true });

    const link = await view.findByRole("link", { name: "Open it now" });
    expect(link.getAttribute("href")).toBe(`/bot/${CREATED}`);
    expect(await view.findByText(/Opening this conversation/)).toBeDefined();
    // The resolver is still what is on screen — the conversation has not arrived — which is the
    // whole point: this is what a person is looking at meanwhile, in place of nothing.
    expect(view.queryByText("the conversation")).toBeNull();
  });

  test("opens the most recent conversation instead of creating another", async () => {
    const older: RosterItem = {
      ...ROW,
      id: "botchat_older",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const newer: RosterItem = {
      ...ROW,
      id: "botchat_newer",
      createdAt: "2026-08-30T00:00:00.000Z",
    };
    const { router } = mount({ roster: [older, newer] });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/bot/botchat_newer"),
    );
    expect(creates()).toBe(0);
  });

  /*
   * The roster changing under the effect while the create is in flight — the production shape of the
   * same defect StrictMode reproduces above, and the one the resolver triggers itself: a successful
   * create invalidates `rosterKeys.all`, React Query awaits that invalidation inside `onSuccess`,
   * and `roster.data` is in the effect's dependency array.
   */
  test("a roster change while the create is in flight does not lose the redirect", async () => {
    let release: (response: Response) => void = () => {};
    const inFlight = new Promise<Response>((resolve) => {
      release = resolve;
    });
    serve({ create: () => inFlight });
    const { queryClient, router } = mount({ roster: [] });

    await waitFor(() => expect(creates()).toBe(1));
    // What the invalidated roster comes back with once the create lands.
    const created: RosterItem = { ...ROW, id: CREATED };
    queryClient.setQueryData(rosterKeys.list("active"), {
      pages: [{ items: [created], nextCursor: null }],
      pageParams: [""],
    } satisfies InfiniteData<RosterPage, string>);
    release(jsonResponse({ botChat: { id: CREATED } }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/bot/${CREATED}`),
    );
    expect(creates()).toBe(1);
  });

  test("a failed roster load says what happened and creates nothing", async () => {
    serve({
      roster: () => jsonResponse({ error: "Could not reach the roster" }, 500),
    });
    const { router, view } = mount();

    expect(await view.findByText("Could not reach the roster")).toBeDefined();
    expect(creates()).toBe(0);
    expect(router.state.location.pathname).toBe("/bot");
  });

  test("a refused create says what happened rather than nothing", async () => {
    serve({
      create: () => jsonResponse({ error: "You cannot start one" }, 403),
    });
    const { router, view } = mount({ roster: [] });

    expect(await view.findByText("You cannot start one")).toBeDefined();
    expect(router.state.location.pathname).toBe("/bot");
  });

  /*
   * Defect 3: `isPending` reads `false` in the error state with `data` still `undefined`, so a Bot
   * list that failed to load was answered with a sentence about the deployment — "no Bots yet" — for
   * what was a 500 or an offline browser.
   */
  test("a failed Bot list says what happened, not that the deployment has none", async () => {
    serve({
      agents: () => jsonResponse({ error: "Could not load coworkers" }, 500),
    });
    const { view } = mount();

    expect(await view.findByText("Could not load coworkers")).toBeDefined();
    expect(view.queryByText(/no Bots yet/)).toBeNull();
  });

  test("a Bot list that resolved empty still says the deployment has none", async () => {
    serve({ agents: () => jsonResponse({ agents: [] }) });
    const { view } = mount();

    expect(
      await view.findByText("This deployment has no Bots yet."),
    ).toBeDefined();
    expect(creates()).toBe(0);
  });

  test("a named Bot this deployment does not have is answered in a sentence", async () => {
    const { view } = mount({ url: "/bot?agent=nope" });

    expect(
      await view.findByText('This deployment has no Bot called "nope".'),
    ).toBeDefined();
    expect(creates()).toBe(0);
  });

  /*
   * ADOPTION, ON SCREEN — the branch that had no test at all.
   *
   * Every assertion above passes with the entire `if (shouldAttemptAdoption(...)) { ... }` block
   * deleted from `resolve()`: nothing here seeded `botThreadKey`, and `serve` had no stub for
   * `POST /api/bot-chats/adopt` or `GET /api/threads/:id`, so the branch could not be entered. The
   * predicate was tested as a pure function, which says what the decision is and nothing about
   * whether the resolver makes it. That matters more than the usual coverage argument because the
   * defect the branch exists for is deterministic on upgrade rather than a race — every upgrading
   * browser, first visit, every time — so a regression would not be rare, it would be universal, and
   * its symptom is a durable row rather than a crash.
   */
  test("a remembered thread is adopted, and no second conversation is created", async () => {
    // The browser upgrading in: a real conversation behind a localStorage key, and no `bot_chats` row
    // anywhere yet, which is the only state this branch can be reached from.
    window.localStorage.setItem(botThreadKey(AGENT.id), LEGACY_THREAD);
    const { router } = mount({ roster: [] });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/bot/${ADOPTED}`),
    );
    expect(checked()).toEqual([`/api/threads/${LEGACY_THREAD}`]);
    expect(adopts()).toBe(1);
    // The one that matters: the person lands in their own transcript, and there is no empty
    // conversation sitting on top of it in the roster.
    expect(creates()).toBe(0);
    // Adopted, so the key has nothing left to protect — and `useLegacyThreadAdoption` runs on the
    // screen this just redirected to, so a key left behind is the same question asked again forever.
    expect(window.localStorage.getItem(botThreadKey(AGENT.id))).toBeNull();
  });

  /*
   * The stale path, which is how the duplicate row came back after `shouldAttemptAdoption` closed the
   * original one.
   *
   * `attemptAdoption` reports an unmount as `{ adopted: null }` — the same answer it gives for
   * "nothing was remembered" — so a resolution whose adopt succeeded after this screen was gone used
   * to read that as "nothing to adopt", fall through with `mostRecent` still `null`, and create. Two
   * durable rows for one conversation, the empty one newer, so `mostRecentBotChat` resolves to the
   * empty one — and adoption is never attempted again, because `mostRecent` is no longer `null`.
   *
   * The unmount window exists only on this path: on the ordinary path nothing is awaited between the
   * decision and the create, which is why no test above could have caught this.
   */
  test("an unmount while the adopt is in flight creates nothing behind it", async () => {
    window.localStorage.setItem(botThreadKey(AGENT.id), LEGACY_THREAD);
    let release: (response: Response) => void = () => {};
    const inFlight = new Promise<Response>((resolve) => {
      release = resolve;
    });
    serve({ adopt: () => inFlight });
    const { view } = mount({ roster: [] });

    await waitFor(() => expect(adopts()).toBe(1));
    // Navigating away, closing the tab, switching Bot — the resolver's own comment on `mounted` says
    // unmount is the only thing a resolution is allowed to cancel on, and this is that.
    view.unmount();
    // The adoption succeeds anyway: the request was already with the server, so the row is written
    // whatever this browser does next. That is the point — the answer is stale, not failed.
    release(jsonResponse({ botChat: { id: ADOPTED } }));
    await settle();

    expect(creates()).toBe(0);
    // Not forgotten, deliberately: `attemptAdoption` withholds `forget` from a stale answer, so the
    // pointer survives for `useLegacyThreadAdoption` to finish from the chat screen, where finding the
    // thread already adopted is the 409 it already handles.
    expect(window.localStorage.getItem(botThreadKey(AGENT.id))).toBe(
      LEGACY_THREAD,
    );
  });
});
