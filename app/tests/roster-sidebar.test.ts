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
import { cleanup, configure, render, within } from "@testing-library/react";
import { createElement } from "react";
import { AppSidebar } from "../src/components/app-sidebar/app-sidebar";
import { SidebarProvider } from "../src/components/ui/sidebar";
import {
  type RosterItem,
  type RosterPage,
  rosterKeys,
} from "../src/lib/roster/queries";

/**
 * The roster as it is actually rendered: what assistive technology is told the sidebar is, and what
 * the render does to the array React Query lent it.
 *
 * BOTH OF THESE ARE ONLY TRUE OF A RENDER, which is why they cost a DOM. The list semantics are the
 * markup itself — a claim about which element ends up inside which — and no pure function has an
 * opinion about it. The other is aliasing: `pinnedFirst` is unit-tested against arrays a test built
 * (app/tests/channel-order.test.ts), and the fact that matters about it in production is whose array
 * it is handed, which only the real component and a real query observer can say.
 *
 * The harness is the one app/tests/bot-chat-resolver.test.ts established, and its docblock on the
 * registrator — register only if nothing else has, unregister in `afterAll`, query through `render`'s
 * return value rather than `screen` — is the longer telling of why it is shaped this way.
 *
 * WHAT THIS HARNESS CANNOT ASSERT, written down because it looks assertable and costs an hour to find
 * out otherwise: nothing here can wait for a motion animation to finish. `motion-dom` captures
 * `requestAnimationFrame` once, at module load (frameloop/frame.mjs:
 * `createRenderBatcher(typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : noop)`),
 * and under `bun test` the DOM is registered in `beforeAll` — after every static import has been
 * evaluated — so the batcher it keeps is `noop` and the frame loop never runs. A row removed from the
 * roster therefore stays on screen for the whole of `waitFor`'s budget: `AnimatePresence` is holding
 * it for an exit animation that cannot advance. Confirmed to be the environment and not the markup by
 * reverting the list item and watching the row stay put just the same. So the row's exit wiring is
 * argued from framer-motion's own PresenceChild — see the `Row` docblock in app-sidebar.tsx — rather
 * than asserted here. Making it assertable needs the registration to happen before module evaluation,
 * which is a `preload` in bunfig.toml and a change to how the whole suite starts.
 */
let registeredHere = false;

/**
 * A socket that connects to nothing.
 *
 * `useRosterEvents` opens one on mount, and it is not what these tests are about: happy-dom would
 * either have no `WebSocket` at all for the effect to construct, or a real one dialling
 * `ws://localhost:3000` out of a test process. Neither handler is ever called here, so nothing below
 * depends on this class doing anything — it exists so the mount survives, and so the teardown's
 * `close()` has something to call.
 */
class SilentSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close() {}
}

const realFetch = globalThis.fetch;
let restoreSocket: (() => void) | null = null;

/** The signed-in person the footer names. `user`, so the admin entry stays out of the tree. */
const ME = {
  id: "user_1",
  email: "someone@example.com",
  name: "Someone",
  role: "user" as const,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  configure({ asyncUtilTimeout: 5000 });
  if (GlobalRegistrator.isRegistered) return;
  GlobalRegistrator.register({ url: "http://localhost:3000/" });
  registeredHere = true;
});

afterAll(async () => {
  configure({ asyncUtilTimeout: 1000 });
  if (!registeredHere) return;
  /*
   * Let React's scheduler finish before the DOM is taken away.
   *
   * `cleanup` unmounts, but the commit it schedules is a macrotask: `performWorkUntilDeadline` runs
   * later and reads `window.event`, so unregistering first turns the last test's own teardown into a
   * bare `ReferenceError: window is not defined`, thrown out of the scheduler where no test can catch
   * it and reported by `bun test` as an error beside a suite that passed. One turn of the macrotask
   * queue is enough — the work is already queued by the time this runs.
   */
  await new Promise((resolve) => setTimeout(resolve, 0));
  await GlobalRegistrator.unregister();
  registeredHere = false;
});

beforeEach(() => {
  /*
   * Installed through the descriptor rather than by assignment, and put back afterwards, for the
   * reason the registrator itself is: `bun test` runs every file in one process, and a `WebSocket`
   * left on `globalThis` by this file would be the thing a later file's real socket resolves to.
   */
  const previous = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: SilentSocket,
    writable: true,
  });
  restoreSocket = () => {
    if (previous) {
      Object.defineProperty(globalThis, "WebSocket", previous);
      return;
    }
    Reflect.deleteProperty(globalThis, "WebSocket");
  };

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/me")) {
      return Promise.resolve(jsonResponse({ user: ME }));
    }
    /*
     * Every roster read these tests need is seeded into the cache below with `staleTime: Infinity`,
     * so reaching the wire for one means the seed missed — answered loudly rather than with an empty
     * page, which would arrive on screen as an empty roster and read like a rendering bug.
     */
    return Promise.resolve(jsonResponse({ error: `No stub for ${path}` }, 500));
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  restoreSocket?.();
  restoreSocket = null;
});

function conversation(overrides: Partial<RosterItem> & { id: string }) {
  return {
    kind: "channel",
    name: overrides.id,
    agentIds: ["agent_1"],
    threadId: `thread_${overrides.id}`,
    active: true,
    archived: false,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  } satisfies RosterItem;
}

/**
 * The sidebar on a real router, inside the provider `Sidebar` requires, with the roster seeded.
 *
 * Every path the sidebar and its rows can link to is declared, because `Link` builds an href through
 * the router and a `to` no route answers is a render-time throw rather than a dead link. `/admin` and
 * `/settings` are absent deliberately: the first is hidden for a non-admin, and the second lives
 * inside a dropdown that mounts nothing until it is opened — so a route added for either would be a
 * route this file claims is needed while nothing reaches it.
 */
function mount(options: {
  roster: RosterItem[];
  /**
   * Called with every array React Query hands the sidebar as its roster data.
   *
   * This is `structuralSharing`, which is public API, switched off — it returns `next` untouched —
   * and recording what it was given on the way through. Off matters as much as the recording: with
   * structural sharing on, `replaceEqualDeep` sits between `select` and the component, and because
   * `rosterListQueryOptions` builds a fresh `select` closure on every render, the flattening re-runs
   * every render and its result is compared against the previous one. A previous array that a render
   * reordered in place is then not deeply equal to the freshly flattened one, so `replaceEqualDeep`
   * replaces it — the mutation is undone before any later render or assertion can see it. That is an
   * accident of two unrelated mechanisms, not a guarantee, and a test resting on it would prove
   * nothing about the copy it exists to defend.
   */
  handedOut?: (data: RosterItem[]) => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        ...(options.handedOut
          ? {
              structuralSharing: (_previous: unknown, next: unknown) => {
                // The raw `InfiniteData` goes through here too; the flattened roster is the array.
                if (Array.isArray(next)) {
                  options.handedOut?.(next as RosterItem[]);
                }
                return next;
              },
            }
          : {}),
      },
    },
  });
  const seeded: InfiniteData<RosterPage, string> = {
    pages: [{ items: options.roster, nextCursor: null }],
    pageParams: [""],
  };
  queryClient.setQueryData(rosterKeys.list("active"), seeded);

  /*
   * The sidebar is the root route's component, so it is inside the router rather than beside it: it
   * reads `useParams` for which conversation is open and its rows render `Link`s, both of which need
   * the router above them. No `Outlet`, so the declared routes below contribute their paths and
   * nothing else — this file is not looking at any screen.
   */
  const root = createRootRoute({
    component: () =>
      createElement(SidebarProvider, null, createElement(AppSidebar, null)),
  });
  const paths = [
    "/",
    "/channel/new",
    "/channel/$channelId",
    "/bot/$botChatId",
    "/skills",
    "/agents",
  ];
  const router = createRouter({
    routeTree: root.addChildren(
      paths.map((path) =>
        createRoute({
          getParentRoute: () => root,
          path,
          component: () => createElement("p", null, path),
        }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, {
        router,
      } as React.ComponentProps<typeof RouterProvider>),
    ),
  );
}

/**
 * The roster list, once the router has resolved its first match.
 *
 * `find*` rather than `get*` because `RouterProvider` renders nothing at all until the initial load
 * settles, so a synchronous query runs against an empty body — which fails with "no accessible roles"
 * and looks exactly like the semantics defect these tests are about.
 */
function rosterList(view: ReturnType<typeof mount>): Promise<HTMLElement> {
  return view.findByRole("list", { name: "Conversations" });
}

/** The ids of the conversations on screen, in the order they are rendered. */
function renderedOrder(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

describe("the roster's list semantics", () => {
  /*
   * The app's primary navigation, told to assistive technology as a list.
   *
   * IT WAS NOT ONE. `SidebarMenu` renders the `<ul>` and `SidebarMenuItem` the `<li>`, and this
   * surface had them the wrong way round — `<ul>` → `SidebarGroup`'s `<div>` → `<li>` — with the rows
   * themselves bare `motion.div`s that were never list items at all. A browser does not make a list
   * out of that: no count, no position, no "3 of 12" on the one control a person navigates this whole
   * application with.
   *
   * Asserted on the roles rather than on tag names, because roles are what is actually exposed, and
   * on `parentElement` as well, because HTML only makes an `<li>` a list item when it is a direct
   * child of the list — which is precisely the part the old markup got wrong while still containing
   * both elements.
   */
  test("the roster is a named list, and every row is an item directly inside it", async () => {
    const view = mount({
      roster: [
        conversation({ id: "channel_a" }),
        conversation({ id: "channel_b" }),
        conversation({ id: "channel_c" }),
      ],
    });

    const list = await rosterList(view);
    const items = within(list).getAllByRole("listitem");

    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.parentElement).toBe(list);
    }
  });

  test("an empty roster is a list with nothing in it, not a missing list", async () => {
    // The empty state renders a sentence beside the roster, and the list stays: a list that vanishes
    // when it empties is a control that disappears from under a keyboard between two refetches.
    const view = mount({ roster: [] });

    const list = await rosterList(view);
    expect(within(list).queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("what a row says about itself", () => {
  /*
   * The same defect as the list, one level down: state drawn and never said.
   *
   * `rowMarkers` decides which of the three a row shows and app/tests/roster-row-menu.test.ts pins
   * that decision, but two of the three markers were a coloured circle and an `<svg>` with no text in
   * them — so the answer was rendered for the eye alone. Archived was the only one a screen reader
   * ever got, which is what made the gap easy to miss: the row appeared to announce its state.
   *
   * The quiet row is half the test. Labels asserted only on the row that has them could be labels
   * every row carries, which would be worse than none — a roster that says "unread, pinned" about all
   * twelve conversations.
   */
  test("the unread dot and the pin are named, not only coloured", async () => {
    const view = mount({
      roster: [
        conversation({
          id: "channel_shouting",
          lastMessageAgentId: "agent_1",
          lastMessageAt: "2026-08-30T12:00:00.000Z",
          pinned: true,
        }),
        conversation({ id: "channel_quiet" }),
      ],
    });

    const list = await rosterList(view);
    const [shouting, quiet] = within(list).getAllByRole("listitem");

    expect(within(shouting).getByRole("img", { name: "Unread" })).toBeDefined();
    expect(within(shouting).getByRole("img", { name: "Pinned" })).toBeDefined();
    expect(within(quiet).queryByRole("img", { name: "Unread" })).toBeNull();
    expect(within(quiet).queryByRole("img", { name: "Pinned" })).toBeNull();
  });
});

describe("the roster the sidebar sorts", () => {
  /*
   * `pinnedFirst`'s copy, proved where the aliasing actually happens.
   *
   * The seed is the state the socket patcher leaves behind, which is the ordinary case rather than a
   * contrived one: `use-channel-events` patches a pin onto a row already on screen without moving it,
   * so the cache holds an unpinned row above a pinned one until the next refetch. `pinnedFirst` is
   * the render-level mirror that fixes the display — and with the search box empty, `matchingItems`
   * hands it React Query's own array to fix it in.
   *
   * So there are two assertions and they are about different things: the rows come out pinned-first,
   * and the array the query lent the sidebar comes back in the order the query put it in.
   */
  test("draws pinned first without reordering the query's own data", async () => {
    const handedOut: RosterItem[][] = [];
    const view = mount({
      roster: [
        conversation({ id: "channel_unpinned" }),
        conversation({ id: "channel_pinned", pinned: true }),
      ],
      handedOut: (data) => handedOut.push(data),
    });

    const list = await rosterList(view);
    expect(renderedOrder(list)).toEqual(["channel_pinned", "channel_unpinned"]);

    // Every array the observer produced, not just the last: the flattening re-runs on each render,
    // and each of its results is handed to `pinnedFirst` by the render that produced it.
    expect(handedOut.length).toBeGreaterThan(0);
    for (const data of handedOut) {
      expect(data.map((item) => item.id)).toEqual([
        "channel_unpinned",
        "channel_pinned",
      ]);
    }
  });
});
