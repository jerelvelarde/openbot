import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { TypefullyDraftSummary } from "../src/components/gallery/typefully-draft";
import { DetailPanel } from "../src/components/layout/detail-panel";
import { agentKeys } from "../src/lib/agents/queries";
import { channelKeys } from "../src/lib/channels/queries";
import { reportComputerActivity } from "../src/lib/copilot/computer-activity";
import { pluginKeys } from "../src/lib/plugins/queries";
import {
  TypefullyClientError,
  typefullyKeys,
} from "../src/lib/typefully/queries";
import {
  channelDetailPresentation,
  channelPaneSearch,
  Route as ProductionChannelRoute,
} from "../src/routes/_authed/_app/channel/$channelId";

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  (
    window as unknown as { happyDOM: { setURL: (url: string) => void } }
  ).happyDOM.setURL("http://localhost/");
});
afterEach(async () => {
  await act(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  mock.restore();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  GlobalRegistrator.unregister();
});

const draftId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";

const confirmedTypefullyConnection = {
  serverId: "typefully",
  authMethod: "api_key" as const,
  scope: null,
  accountLabel: "Route account",
  connectedAt: "2026-08-27T08:00:00.000Z",
};

const channel = {
  id: "channel-1",
  name: "Launch channel",
  agentIds: ["bot-1", "bot-2"],
  threadId: "thread-1",
  active: true,
};

function ProductionTestRoot() {
  const navigate = useNavigate();
  return (
    <>
      <TypefullyDraftSummary
        destinations={["x"]}
        draftId={draftId}
        mediaCount={0}
        onReview={() => {
          void navigate({
            params: { channelId: channel.id },
            search: (previous) =>
              channelPaneSearch(previous as { watch?: true }, {
                draft: draftId,
              }),
            to: "/channel/$channelId",
          });
        }}
        socialSetLabel="Route account"
        status="synced"
        title="Draft summary"
        version={1}
      />
      <Outlet />
    </>
  );
}

function authoritativeDraft() {
  return {
    id: draftId,
    document: {
      title: "Production route draft",
      destinations: ["x"],
      socialSetId: null,
      accountLabel: "Route account",
      posts: [{ id: "p1", x: "Route body", linkedin: "" }],
      media: [],
      scheduleAt: null,
    },
    version: 1,
    contentHash: "hash",
    remoteDraftId: "remote-1",
    remoteVersion: 1,
    remoteHash: "hash",
    syncStatus: "synced" as const,
    lastError: null,
    createdAt: "2026-08-27T08:00:00.000Z",
    updatedAt: "2026-08-27T08:00:00.000Z",
  };
}

function queryView(fetchImplementation: typeof fetch) {
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/plugins/connections") {
      return confirmedConnectionsResponse();
    }
    return fetchImplementation(input, init);
  }) as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  confirmTypefully(queryClient);
  return { queryClient };
}

function confirmedConnectionsResponse() {
  return new Response(
    JSON.stringify({
      connections: [confirmedTypefullyConnection],
      redirectUri: null,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function confirmTypefully(queryClient: QueryClient) {
  queryClient.setQueryDefaults(pluginKeys.connections(), {
    staleTime: Number.POSITIVE_INFINITY,
  });
  queryClient.setQueryData(pluginKeys.connections(), {
    connections: [confirmedTypefullyConnection],
    redirectUri: null,
  });
}

test("wide detail panel becomes the main surface at the app narrow breakpoint", () => {
  expect(channelDetailPresentation({ draft: draftId }, "bot-1")).toEqual({
    kind: "draft",
    open: true,
    width: 720,
    collapseAtNarrow: true,
  });
  const view = render(
    <DetailPanel
      collapseAtNarrow
      detail={<div>Canvas</div>}
      detailWidth={720}
      onClose={() => {}}
      open
    >
      <div>Chat</div>
    </DetailPanel>,
  );

  const panel = view.getByTestId("detail-panel");
  expect(panel.getAttribute("data-detail-width")).toBe("720");
  expect(panel.dataset.layout).toBe("collapsed");
  expect(view.getByTestId("detail-panel-main").className).toContain("hidden");
  expect(view.getByTestId("detail-panel-content").style.width).toBe("100%");
});

test("a closed detail panel exposes no close control or hidden dialog content", () => {
  const view = render(
    <DetailPanel
      detail={<button type="button">Hidden detail action</button>}
      onClose={() => {}}
      open={false}
      title={<span>Hidden detail</span>}
    >
      <button type="button">Main action</button>
    </DetailPanel>,
  );

  expect(view.queryByRole("button", { name: "Close detail panel" })).toBeNull();
  expect(
    view.queryByRole("button", { name: "Hidden detail action" }),
  ).toBeNull();
  expect(view.getAllByRole("button")).toHaveLength(1);
});

test("draft layout uses available channel width and never leaves a clipped 720px sliver", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  let resize = (_width: number) => {};
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resize = (width) =>
        callback(
          [{ contentRect: { width } } as ResizeObserverEntry],
          this as ResizeObserver,
        );
    }
    disconnect() {}
    observe() {}
    unobserve() {}
  };
  try {
    const view = render(
      <DetailPanel
        collapseAtNarrow
        detail={<button type="button">Canvas content</button>}
        detailWidth={720}
        focusKey={draftId}
        onClose={() => {}}
        open
        title={<span>Typefully draft</span>}
      >
        <div>Chat</div>
      </DetailPanel>,
    );

    for (const [viewport, available] of [
      [768, 428],
      [900, 560],
      [1059, 719],
      [1200, 860],
    ]) {
      act(() => resize(available));
      expect(view.getByTestId("detail-panel").dataset.layout).toBe("collapsed");
      expect(view.getByTestId("detail-panel-content").style.width).toBe("100%");
      expect(
        view.getByRole("button", { name: "Close detail panel" }),
      ).toBeTruthy();
      expect(view.getByRole("button", { name: "Canvas content" })).toBeTruthy();
      expect(viewport).toBeGreaterThanOrEqual(768);
    }
    act(() => resize(1060));
    expect(view.getByTestId("detail-panel").dataset.layout).toBe("split");
    expect(view.getByTestId("detail-panel-content").style.width).toBe("720px");
  } finally {
    globalThis.ResizeObserver = originalResizeObserver;
  }
});

test("watch and settings detail panes keep their existing split layout", () => {
  const view = render(
    <DetailPanel
      detail={<div>Watch screen</div>}
      detailWidth={400}
      onClose={() => {}}
      open
    >
      <div>Chat</div>
    </DetailPanel>,
  );
  expect(view.getByTestId("detail-panel").dataset.layout).toBe("split");
  expect(view.getByTestId("detail-panel-main").className).not.toContain(
    "hidden",
  );
  expect(view.getByTestId("detail-panel-content").style.width).toBe("400px");
});

test("detail focus enters the canvas and returns to the originating review control", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <DetailPanel
        collapseAtNarrow
        detail={<div>Canvas</div>}
        detailWidth={720}
        focusKey={open ? draftId : undefined}
        onClose={() => setOpen(false)}
        open={open}
        title={<span>Typefully draft</span>}
      >
        <button onClick={() => setOpen(true)} type="button">
          Review draft
        </button>
      </DetailPanel>
    );
  }

  const view = render(<Harness />);
  const user = userEvent.setup({ document });
  const review = view.getByRole("button", { name: "Review draft" });
  await user.click(review);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      view.getByRole("heading", { name: "Typefully draft" }),
    ),
  );
  await user.click(view.getByRole("button", { name: "Close detail panel" }));
  await waitFor(() => expect(document.activeElement).toBe(review));
  expect(view.queryByRole("button", { name: "Close detail panel" })).toBeNull();
});

test("a directly linked canvas closes safely to the channel fallback", async () => {
  function DirectHarness() {
    const [open, setOpen] = useState(true);
    return (
      <DetailPanel
        collapseAtNarrow
        detail={<div>Canvas</div>}
        detailWidth={720}
        focusKey={open ? draftId : undefined}
        onClose={() => setOpen(false)}
        open={open}
        title={<span>Typefully draft</span>}
      >
        <button data-channel-focus-fallback type="button">
          Channel conversation
        </button>
      </DetailPanel>
    );
  }
  const view = render(<DirectHarness />);
  const user = userEvent.setup({ document });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      view.getByRole("heading", { name: "Typefully draft" }),
    ),
  );
  await user.click(view.getByRole("button", { name: "Close detail panel" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      view.getByRole("button", { name: "Channel conversation" }),
    ),
  );
});

test("closing the draft removes only its pane key and pane transitions stay exclusive", () => {
  const withUnrelated = { draft: draftId, campaign: "launch" } as Parameters<
    typeof channelPaneSearch
  >[0] & { campaign: string };
  expect(channelPaneSearch(withUnrelated, null)).toEqual({
    campaign: "launch",
    draft: undefined,
    settings: undefined,
    watch: undefined,
  });
  expect(channelPaneSearch({ draft: draftId }, "watch")).toEqual({
    draft: undefined,
    settings: undefined,
    watch: true,
  });
  expect(channelPaneSearch({ watch: true }, { draft: draftId })).toEqual({
    draft: draftId,
    settings: undefined,
    watch: undefined,
  });
});

test("the production route preserves focus on automatic watch and backs out of a real Review draft action", async () => {
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input.url;
    const body = url.includes("/api/copilotkit/info")
      ? { version: "test", agents: {} }
      : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  confirmTypefully(queryClient);
  queryClient.setQueryData(channelKeys.detail(channel.id), channel);
  queryClient.setQueryData(agentKeys.detail("bot-1"), {
    id: "bot-1",
    name: "Launch Bot",
    title: "Writer",
    roleDescription: "Writes launch posts",
    avatarSeed: "launch",
    visibility: "private",
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: true,
    canManage: false,
    mine: false,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            createdAt: "2026-08-27T08:00:00.000Z",
            pinned: false,
            lastReadAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  const history = createMemoryHistory({
    initialEntries: [`/channel/${channel.id}`],
  });
  const root = createRootRoute({ component: ProductionTestRoot });
  const productionChannel = ProductionChannelRoute.update({
    id: "/channel/$channelId",
    path: "/channel/$channelId",
    getParentRoute: () => root,
  });
  const productionTree = root.addChildren([productionChannel]);
  const productionRouter = createRouter({
    routeTree: productionTree,
    history,
    context: { queryClient },
  });
  await productionRouter.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={productionRouter} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });

  const currentControl = view.getByRole("button", { name: "Channel coworker" });
  currentControl.focus();
  act(() => reportComputerActivity("bot-1"));
  await waitFor(() =>
    expect(productionRouter.state.location.search).toEqual({ watch: true }),
  );
  expect(document.activeElement).toBe(currentControl);

  await user.click(view.getByRole("button", { name: "Review draft" }));
  expect(await view.findByText("Production route draft")).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      view.getByRole("heading", { name: "Typefully draft" }),
    ),
  );
  expect(
    view.getByTestId("detail-panel").getAttribute("data-detail-width"),
  ).toBe("720");
  expect(view.getByTestId("detail-panel").dataset.layout).toBe("collapsed");

  await act(async () => {
    await productionRouter.history.back();
  });
  await waitFor(() =>
    expect(productionRouter.state.location.search).toEqual({ watch: true }),
  );
  expect(view.queryByText("Production route draft")).toBeNull();
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: "Review draft" }),
  );

  await act(async () => {
    await productionRouter.navigate({
      search: (previous) =>
        channelPaneSearch(previous as { watch?: true }, { draft: draftId }),
    });
  });
  expect(productionRouter.state.location.search).toEqual({ draft: draftId });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      view.getByRole("heading", { name: "Typefully draft" }),
    ),
  );

  await user.click(view.getByRole("button", { name: "Close detail panel" }));
  await waitFor(() =>
    expect(productionRouter.state.location.search).toEqual({}),
  );
  expect(view.queryByText("Production route draft")).toBeNull();

  await act(async () => {
    await productionRouter.history.back();
  });
  await waitFor(() =>
    expect(productionRouter.state.location.search).toEqual({ draft: draftId }),
  );
  expect(await view.findByText("Production route draft")).toBeTruthy();

  cleanup();
  const refreshed = createRouter({
    routeTree: productionTree,
    history: createMemoryHistory({
      initialEntries: [productionRouter.state.location.href],
    }),
    context: { queryClient },
  });
  await refreshed.load();
  const refreshedView = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={refreshed} />
    </QueryClientProvider>,
  );
  expect(await refreshedView.findByText("Production route draft")).toBeTruthy();
  expect(refreshed.state.location.search).toEqual({ draft: draftId });
});

test("an authoritative draft is fetched only while its canvas is mounted", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const calls: string[] = [];
  let resolveSecond: ((response: Response) => void) | undefined;
  const { queryClient } = queryView((async (input) => {
    calls.push(String(input));
    if (calls.length === 2) {
      return await new Promise<Response>((resolve) => {
        resolveSecond = resolve;
      });
    }
    return new Response(
      JSON.stringify({
        draft: {
          id: draftId,
          document: {
            title: "Private body",
            destinations: ["x"],
            socialSetId: null,
            accountLabel: null,
            posts: [{ id: "p1", x: "Secret post", linkedin: "" }],
            media: [],
            scheduleAt: null,
          },
          version: 1,
          contentHash: "hash",
          remoteDraftId: null,
          remoteVersion: null,
          remoteHash: null,
          syncStatus: "local",
          lastError: null,
          createdAt: "2026-08-27T08:00:00.000Z",
          updatedAt: "2026-08-27T08:00:00.000Z",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch);

  const view = render(
    <QueryClientProvider client={queryClient}>
      <DetailPanel
        collapseAtNarrow
        detail={<DraftCanvas draftId={draftId} />}
        detailWidth={720}
        onClose={() => {}}
        open={false}
      >
        <div>Chat</div>
      </DetailPanel>
    </QueryClientProvider>,
  );
  expect(calls).toHaveLength(0);
  expect(view.queryByText("Private body")).toBeNull();

  view.rerender(
    <QueryClientProvider client={queryClient}>
      <DetailPanel
        collapseAtNarrow
        detail={<DraftCanvas draftId={draftId} />}
        detailWidth={720}
        onClose={() => {}}
        open
      >
        <div>Chat</div>
      </DetailPanel>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(await view.findByText("Private body")).toBeTruthy();

  view.rerender(
    <QueryClientProvider client={queryClient}>
      <DetailPanel
        collapseAtNarrow
        detail={<DraftCanvas draftId={draftId} />}
        detailWidth={720}
        onClose={() => {}}
        open={false}
      >
        <div>Chat</div>
      </DetailPanel>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(queryClient.getQueryData(typefullyKeys.draft(draftId))).toBe(
      undefined,
    ),
  );

  view.rerender(
    <QueryClientProvider client={queryClient}>
      <DetailPanel
        collapseAtNarrow
        detail={<DraftCanvas draftId={draftId} />}
        detailWidth={720}
        onClose={() => {}}
        open
      >
        <div>Chat</div>
      </DetailPanel>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(view.queryByText("Private body")).toBeNull();
  expect(view.getByRole("status").textContent).toContain("Loading draft");
  await act(async () => {
    resolveSecond?.(
      new Response(JSON.stringify({ draft: authoritativeDraft() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  expect(await view.findByText("Production route draft")).toBeTruthy();
});

test("closing a draft aborts its active authorized fetch and removes its query", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  let aborted = false;
  const { queryClient } = queryView((async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }) as typeof fetch);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DetailPanel
        detail={<DraftCanvas draftId={draftId} />}
        onClose={() => {}}
        open
      >
        <div>Chat</div>
      </DetailPanel>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      queryClient.getQueryState(typefullyKeys.draft(draftId)),
    ).toBeTruthy(),
  );

  view.rerender(
    <QueryClientProvider client={queryClient}>
      <DetailPanel
        detail={<DraftCanvas draftId={draftId} />}
        onClose={() => {}}
        open={false}
      >
        <div>Chat</div>
      </DetailPanel>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(aborted).toBe(true));
  await waitFor(() =>
    expect(queryClient.getQueryState(typefullyKeys.draft(draftId))).toBe(
      undefined,
    ),
  );
});

test("draft canvas handles owner-safe refusal states without content", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  for (const [code, message] of [
    ["draft_not_found", "Draft unavailable"],
    ["channel_forbidden", "Draft unavailable"],
    ["connection_required", "Connect Typefully"],
    ["grant_required", "Typefully access"],
    ["remote_error", "could not load"],
  ] as const) {
    const { queryClient } = queryView(
      (async () =>
        new Response(JSON.stringify({ code }), {
          status: code === "draft_not_found" ? 404 : 403,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DraftCanvas draftId={draftId} />
      </QueryClientProvider>,
    );
    expect((await view.findByRole("alert")).textContent).toContain(message);
    expect(view.container.textContent).not.toContain("Secret post");
    cleanup();
  }

  expect(new TypefullyClientError("draft_not_found").code).toBe(
    "draft_not_found",
  );
});

test("draft canvas refuses malformed successful payloads without rendering their body", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const { queryClient } = queryView(
    (async () =>
      new Response(
        JSON.stringify({
          draft: {
            ...authoritativeDraft(),
            syncStatus: "invented",
            document: {
              ...authoritativeDraft().document,
              posts: [{ id: "p1", x: "must never render", linkedin: "" }],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );

  expect((await view.findByRole("alert")).textContent).toContain(
    "could not load",
  );
  expect(view.container.textContent).not.toContain("must never render");
});

test("draft canvas refuses a different valid draft returned for the requested id", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const { queryClient } = queryView(
    (async () =>
      new Response(
        JSON.stringify({
          draft: {
            ...authoritativeDraft(),
            id: "a2847b7f-1371-4fa7-88c8-aa80c610e50e",
            document: {
              ...authoritativeDraft().document,
              posts: [{ id: "p1", x: "another owner's body", linkedin: "" }],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );

  expect((await view.findByRole("alert")).textContent).toContain(
    "could not load",
  );
  expect(view.container.textContent).not.toContain("another owner's body");
  expect(queryClient.getQueryData(typefullyKeys.draft(draftId))).toBe(
    undefined,
  );
});

test("production draft canvas keeps editing during a delayed save and coalesces the latest document", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const requests: Array<{ expectedVersion: number; body: string }> = [];
  let resolveFirst!: (response: Response) => void;
  let getVersion = 1;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  confirmTypefully(queryClient);
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/plugins/connections") {
      return confirmedConnectionsResponse();
    }
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const payload = JSON.parse(String(init?.body)) as {
        expectedVersion: number;
        document: { posts: Array<{ x: string }> };
      };
      requests.push({
        expectedVersion: payload.expectedVersion,
        body: payload.document.posts[0]?.x ?? "",
      });
      const version = payload.expectedVersion + 1;
      const response = new Response(
        JSON.stringify({
          draft: {
            id: draftId,
            title: "Production route draft",
            destinations: ["x"],
            socialSetLabel: "Route account",
            mediaCount: 0,
            version,
            syncStatus: "synced",
            proposalStatus: null,
          },
          remote: {
            state: "synced",
            remoteDraftId: "remote-1",
            confirmedVersion: version,
            confirmedHash: `hash-${version}`,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      if (requests.length === 1)
        return await new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      getVersion = version;
      return response;
    }
    const body = requests.at(-1)?.body ?? "Route body";
    return new Response(
      JSON.stringify({
        draft: {
          ...authoritativeDraft(),
          version: getVersion,
          contentHash: `hash-${getVersion}`,
          remoteVersion: getVersion,
          remoteHash: `hash-${getVersion}`,
          document: {
            ...authoritativeDraft().document,
            posts: [{ id: "p1", x: body, linkedin: "" }],
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  const editor = view.getByRole("textbox", { name: "X post 1" });
  await user.type(editor, "A");
  await waitFor(() => expect(requests).toHaveLength(1), { timeout: 1_500 });
  expect((editor as HTMLTextAreaElement).disabled).toBe(false);
  await user.type(editor, "BC");
  expect((editor as HTMLTextAreaElement).value).toBe("Route bodyABC");
  getVersion = 2;
  resolveFirst(
    new Response(
      JSON.stringify({
        draft: {
          id: draftId,
          title: "Production route draft",
          destinations: ["x"],
          socialSetLabel: "Route account",
          mediaCount: 0,
          version: 2,
          syncStatus: "synced",
          proposalStatus: null,
        },
        remote: {
          state: "synced",
          remoteDraftId: "remote-1",
          confirmedVersion: 2,
          confirmedHash: "hash-2",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests).toEqual([
    { expectedVersion: 1, body: "Route bodyA" },
    { expectedVersion: 2, body: "Route bodyABC" },
  ]);
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toContain(
      "Saved to Typefully",
    ),
  );
});

test("draft media add omits an id, then retry and remove use the server-authoritative id", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  confirmTypefully(queryClient);
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  const calls: Array<{
    url: string;
    method: string;
    mediaId: FormDataEntryValue | null;
  }> = [];
  const media = {
    id: "authoritative-media-id",
    kind: "image" as const,
    order: 0,
    altText: "",
    remoteId: null as string | null,
  };
  let uploadCount = 0;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (url === "/api/plugins/connections") {
      return confirmedConnectionsResponse();
    }
    const form = init?.body instanceof FormData ? init.body : null;
    calls.push({ url, method, mediaId: form?.get("mediaId") ?? null });
    if (method === "POST") {
      uploadCount += 1;
      const version = uploadCount + 1;
      const completed =
        uploadCount === 1
          ? media
          : { ...media, remoteId: "typefully-media-77" };
      return new Response(
        JSON.stringify({
          ...(uploadCount === 1
            ? {
                code: "remote_error",
                message: "Upload failed. Retry it.",
              }
            : {}),
          draft: {
            id: draftId,
            title: "Production route draft",
            destinations: ["x"],
            socialSetLabel: "Route account",
            mediaCount: 1,
            version,
            syncStatus: uploadCount === 1 ? "remote_error" : "synced",
            proposalStatus: null,
          },
          remote: {
            state: uploadCount === 1 ? "remote_error" : "synced",
            remoteDraftId: "remote-1",
            confirmedVersion: uploadCount === 1 ? 1 : version,
            confirmedHash: `hash-${version}`,
          },
          media: completed,
        }),
        {
          status: uploadCount === 1 ? 502 : 201,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (method === "DELETE")
      return new Response(
        JSON.stringify({
          draft: {
            id: draftId,
            title: "Production route draft",
            destinations: ["x"],
            socialSetLabel: "Route account",
            mediaCount: 0,
            version: 4,
            syncStatus: "synced",
            proposalStatus: null,
          },
          remote: {
            state: "synced",
            remoteDraftId: "remote-1",
            confirmedVersion: 4,
            confirmedHash: "hash-4",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    return new Response(JSON.stringify({ draft: authoritativeDraft() }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.upload(
    view.getByLabelText("Add media"),
    new File(["image"], "launch.png", { type: "image/png" }),
  );
  const retry = await view.findByRole("button", { name: "Retry image 1" });
  expect(calls[0]).toMatchObject({
    url: `/api/typefully/drafts/${draftId}/media`,
    method: "POST",
    mediaId: null,
  });
  await user.click(retry);
  await waitFor(() => expect(uploadCount).toBe(2));
  expect(calls.filter((call) => call.method === "POST")[1]).toMatchObject({
    method: "POST",
    mediaId: media.id,
  });
  await user.click(view.getByRole("button", { name: "Remove image 1" }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === "DELETE")).toBe(true),
  );
  expect(calls.find((call) => call.method === "DELETE")?.url).toBe(
    `/api/typefully/drafts/${draftId}/media/${media.id}`,
  );
});

test("a retry cannot adopt or rekey mismatched non-2xx recovery media", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  confirmTypefully(queryClient);
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  const authoritativeMedia = {
    id: "authoritative-retry-media",
    kind: "image" as const,
    order: 0,
    altText: "",
    remoteId: null,
  };
  let uploads = 0;
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? "GET") === "POST") {
      uploads += 1;
      const media =
        uploads === 1
          ? authoritativeMedia
          : { ...authoritativeMedia, id: "different-retry-media" };
      return new Response(
        JSON.stringify({
          code: "remote_error",
          draft: {
            id: draftId,
            title: "Production route draft",
            destinations: ["x"],
            socialSetLabel: "Route account",
            mediaCount: 1,
            version: uploads + 1,
            syncStatus: "remote_error",
            proposalStatus: null,
          },
          media,
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        draft: {
          ...authoritativeDraft(),
          document: {
            ...authoritativeDraft().document,
            media: [authoritativeMedia],
          },
          version: 2,
          contentHash: "hash-2",
          remoteVersion: 1,
          syncStatus: "remote_error",
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.upload(
    view.getByLabelText("Add media"),
    new File(["image"], "launch.png", { type: "image/png" }),
  );
  const retry = await view.findByRole("button", { name: "Retry image 1" });
  const priorItemAlert = view.getByText(
    "Typefully could not confirm this change. Your local draft is preserved.",
  ).textContent;
  const priorStatus = view.getByTestId("canvas-status").textContent;
  const priorPreviewSource = view
    .getByTestId("preview-media")
    .getAttribute("src");
  const priorAltText = (
    view.getByRole("textbox", {
      name: "Alt text for image 1",
    }) as HTMLInputElement
  ).value;
  await user.click(retry);
  await waitFor(() => expect(uploads).toBe(2));
  const alerts = view.getAllByRole("alert").map((alert) => alert.textContent);
  expect(alerts).toContain(priorItemAlert);
  expect(
    alerts.some((alert) => alert?.includes("invalid media response")),
  ).toBe(true);
  expect(view.getByTestId("canvas-status").textContent).toBe(priorStatus);
  expect(view.getByTestId("preview-media").getAttribute("src")).toBe(
    priorPreviewSource,
  );
  expect(
    (
      view.getByRole("textbox", {
        name: "Alt text for image 1",
      }) as HTMLInputElement
    ).value,
  ).toBe(priorAltText);
  expect(view.getByRole("button", { name: "Retry image 1" })).toBeTruthy();
  expect(
    view.queryByRole("button", { name: /different-retry-media/ }),
  ).toBeNull();
  expect(queryClient.getQueryData(typefullyKeys.draft(draftId))).toMatchObject({
    draft: {
      version: 2,
      document: { media: [authoritativeMedia] },
    },
  });

  await user.click(view.getByRole("button", { name: "Retry image 1" }));
  await waitFor(() => expect(uploads).toBe(3));
});

test("a retry cannot adopt malformed successful authority or mutate local media state", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  confirmTypefully(queryClient);
  const existingMedia = {
    id: "existing-first-media",
    kind: "image" as const,
    order: 0,
    altText: "Existing first attachment",
    remoteId: "remote-existing-first",
  };
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: {
      ...authoritativeDraft(),
      document: {
        ...authoritativeDraft().document,
        media: [existingMedia],
      },
    },
  });
  const authoritativeMedia = {
    id: "authoritative-success-retry-media",
    kind: "image" as const,
    order: 1,
    altText: "",
    remoteId: null,
  };
  const uploadedFiles: File[] = [];
  let uploads = 0;
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? "GET") === "POST") {
      uploads += 1;
      const file =
        init?.body instanceof FormData ? init.body.get("file") : undefined;
      if (file instanceof File) uploadedFiles.push(file);
      if (uploads === 1) {
        return new Response(
          JSON.stringify({
            code: "remote_error",
            draft: {
              id: draftId,
              title: "Production route draft",
              destinations: ["x"],
              socialSetLabel: "Route account",
              mediaCount: 2,
              version: 2,
              syncStatus: "remote_error",
              proposalStatus: null,
            },
            media: authoritativeMedia,
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          draft: {
            id: draftId,
            title: "Production route draft",
            destinations: ["x"],
            socialSetLabel: "Route account",
            mediaCount: 1,
            version: 3,
            syncStatus: "synced",
            proposalStatus: null,
          },
          media: {
            ...authoritativeMedia,
            order: 0,
            remoteId: "untrusted-completed-media",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        draft: {
          ...authoritativeDraft(),
          document: {
            ...authoritativeDraft().document,
            media: [existingMedia, authoritativeMedia],
          },
          version: 2,
          contentHash: "hash-2",
          remoteVersion: 1,
          syncStatus: "remote_error",
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  const selectedFile = new File(["image"], "launch.png", {
    type: "image/png",
  });
  await user.upload(view.getByLabelText("Add media"), selectedFile);
  const retry = await view.findByRole("button", { name: "Retry image 2" });
  const priorCache = queryClient.getQueryData(typefullyKeys.draft(draftId));
  const priorItemAlert = view.getByText(
    "Typefully could not confirm this change. Your local draft is preserved.",
  ).textContent;
  const priorStatus = view.getByTestId("canvas-status").textContent;
  const priorPreviewSource = view
    .getAllByTestId("preview-media")[1]
    ?.getAttribute("src");
  const priorAltText = (
    view.getByRole("textbox", {
      name: "Alt text for image 2",
    }) as HTMLInputElement
  ).value;

  await user.click(retry);
  await waitFor(() => expect(uploads).toBe(2));

  expect(queryClient.getQueryData(typefullyKeys.draft(draftId))).toBe(
    priorCache,
  );
  expect(view.getByTestId("canvas-status").textContent).toBe(priorStatus);
  expect(view.getAllByTestId("preview-media")[1]?.getAttribute("src")).toBe(
    priorPreviewSource,
  );
  expect(
    (
      view.getByRole("textbox", {
        name: "Alt text for image 2",
      }) as HTMLInputElement
    ).value,
  ).toBe(priorAltText);
  const alerts = view.getAllByRole("alert").map((alert) => alert.textContent);
  expect(alerts).toContain(priorItemAlert);
  expect(
    alerts.some((alert) => alert?.includes("invalid media response")),
  ).toBe(true);
  expect(view.getByRole("button", { name: "Retry image 2" })).toBeTruthy();
  expect(uploadedFiles[1]).toBe(selectedFile);

  await user.click(view.getByRole("button", { name: "Retry image 2" }));
  await waitFor(() => expect(uploads).toBe(3));
  expect(uploadedFiles[2]).toBe(selectedFile);
});

test("media busy locks edits and an autosave error blocks media operations", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  confirmTypefully(queryClient);
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  let finishUpload!: (response: Response) => void;
  let uploadStarted = false;
  globalThis.fetch = (async (_input, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST") {
      uploadStarted = true;
      return await new Promise<Response>((resolve) => {
        finishUpload = resolve;
      });
    }
    if (method === "PUT")
      return new Response(
        JSON.stringify({ code: "remote_error", message: "Save failed." }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    return new Response(JSON.stringify({ draft: authoritativeDraft() }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  const editor = view.getByRole("textbox", { name: "X post 1" });
  await user.upload(
    view.getByLabelText("Add media"),
    new File(["image"], "launch.png", { type: "image/png" }),
  );
  await waitFor(() => expect(uploadStarted).toBe(true));
  expect((editor as HTMLTextAreaElement).disabled).toBe(true);
  await user.type(editor, "must-not-apply");
  expect((editor as HTMLTextAreaElement).value).toBe("Route body");
  finishUpload(
    new Response(
      JSON.stringify({
        draft: {
          id: draftId,
          title: "Production route draft",
          destinations: ["x"],
          socialSetLabel: "Route account",
          mediaCount: 1,
          version: 3,
          syncStatus: "synced",
          proposalStatus: null,
        },
        remote: {
          state: "synced",
          remoteDraftId: "remote-1",
          confirmedVersion: 3,
          confirmedHash: "hash-3",
        },
        media: {
          id: "authoritative-media-id",
          kind: "image",
          order: 0,
          altText: "",
          remoteId: "typefully-media-77",
        },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    ),
  );
  await waitFor(() =>
    expect((editor as HTMLTextAreaElement).disabled).toBe(false),
  );
  expect((editor as HTMLTextAreaElement).value).toBe("Route body");

  await user.type(editor, "!");
  await waitFor(
    () =>
      expect(view.getByRole("status").textContent).toContain(
        "Not saved to Typefully",
      ),
    { timeout: 1_500 },
  );
  expect((view.getByLabelText("Add media") as HTMLInputElement).disabled).toBe(
    true,
  );
});

for (const [label, uploadResult] of [
  ["network failure", () => Promise.reject(new TypeError("offline"))],
  [
    "malformed success",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            draft: {
              id: draftId,
              title: "Production route draft",
              destinations: ["x"],
              socialSetLabel: "Route account",
              mediaCount: 1,
              version: 2,
              syncStatus: "local",
              proposalStatus: null,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      ),
  ],
  [
    "wrong-draft committed failure",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: "remote_error",
            draft: {
              id: "a2847b7f-1371-4fa7-88c8-aa80c610e50e",
              title: "Another draft",
              destinations: ["x"],
              socialSetLabel: "Route account",
              mediaCount: 1,
              version: 2,
              syncStatus: "remote_error",
              proposalStatus: null,
            },
            media: {
              id: "untrusted-media-id",
              kind: "image",
              order: 0,
              altText: "",
              remoteId: null,
            },
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        ),
      ),
  ],
] as const) {
  test(`uncommitted first-upload ${label} fully clears its optimistic readiness state`, async () => {
    const { DraftCanvas } = await import(
      "../src/components/typefully/draft-canvas"
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    confirmTypefully(queryClient);
    queryClient.setQueryData(typefullyKeys.draft(draftId), {
      draft: authoritativeDraft(),
    });
    globalThis.fetch = (async (input, init) => {
      if (String(input) === "/api/plugins/connections") {
        return confirmedConnectionsResponse();
      }
      if ((init?.method ?? "GET") === "POST") return uploadResult();
      return new Response(JSON.stringify({ draft: authoritativeDraft() }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DraftCanvas draftId={draftId} />
      </QueryClientProvider>,
    );
    await userEvent
      .setup({ document })
      .upload(
        view.getByLabelText("Add media"),
        new File(["image"], "launch.png", { type: "image/png" }),
      );
    await waitFor(() =>
      expect(
        (view.getByLabelText("Add media") as HTMLInputElement).disabled,
      ).toBe(false),
    );
    expect(view.queryByRole("button", { name: /Remove image/ })).toBeNull();
    expect(view.getByRole("alert").textContent).toContain(
      "Select the file again to retry",
    );
    expect(view.getByTestId("publish-readiness").textContent).toContain(
      "Ready for approval",
    );
    expect(
      (
        view.getByRole("button", {
          name: "Review & publish",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    await userEvent
      .setup({ document })
      .click(view.getByRole("button", { name: "Dismiss media upload error" }));
    expect(view.queryByRole("alert")).toBeNull();
  });
}

test("a later successful selection clears the rollback media alert", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  confirmTypefully(queryClient);
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  let uploadCount = 0;
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? "GET") === "POST" && ++uploadCount === 1) {
      throw new TypeError("offline");
    }
    if ((init?.method ?? "GET") === "POST") {
      return new Response(
        JSON.stringify({
          draft: {
            id: draftId,
            title: "Production route draft",
            destinations: ["x"],
            socialSetLabel: "Route account",
            mediaCount: 1,
            version: 3,
            syncStatus: "synced",
            proposalStatus: null,
          },
          media: {
            id: "successful-media-id",
            kind: "image",
            order: 0,
            altText: "",
            remoteId: "typefully-media-88",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ draft: authoritativeDraft() }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  const add = view.getByLabelText("Add media");
  await user.upload(
    add,
    new File(["first"], "first.png", { type: "image/png" }),
  );
  await view.findByRole("alert");
  await user.upload(
    add,
    new File(["second"], "second.png", { type: "image/png" }),
  );
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  expect(view.getByRole("button", { name: /Remove image/ })).toBeTruthy();
});

test("production review control prepares a proposal without publishing", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  confirmTypefully(queryClient);
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  let authorityVersion = 1;
  let authorityBody = "Route body";
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (url === "/api/plugins/connections") {
      return confirmedConnectionsResponse();
    }
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === "POST")
      return new Response(
        JSON.stringify({
          proposal: {
            id: `proposal-${authorityVersion}`,
            draftId,
            version: authorityVersion,
            destinations: ["x"],
            expiresAt: "2026-08-28T00:00:00.000Z",
            status: "pending",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    if (method === "PUT") {
      const payload = JSON.parse(String(init?.body)) as {
        document: { posts: Array<{ x: string }> };
      };
      authorityVersion += 1;
      authorityBody = payload.document.posts[0]?.x ?? authorityBody;
      return new Response(
        JSON.stringify({
          draft: {
            id: draftId,
            title: "Production route draft",
            destinations: ["x"],
            socialSetLabel: "Route account",
            mediaCount: 0,
            version: authorityVersion,
            syncStatus: "synced",
            proposalStatus: null,
          },
          remote: {
            state: "synced",
            remoteDraftId: "remote-1",
            confirmedVersion: authorityVersion,
            confirmedHash: `hash-${authorityVersion}`,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        draft: {
          ...authoritativeDraft(),
          version: authorityVersion,
          contentHash: `hash-${authorityVersion}`,
          remoteVersion: authorityVersion,
          remoteHash: `hash-${authorityVersion}`,
          document: {
            ...authoritativeDraft().document,
            posts: [{ id: "p1", x: authorityBody, linkedin: "" }],
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: "Review & publish" }));
  expect(
    await view.findByText(/An immutable publication review is shown below/),
  ).toBeTruthy();
  expect(calls).toContainEqual({
    url: `/api/typefully/drafts/${draftId}/proposals`,
    method: "POST",
    body: { expectedVersion: 1 },
  });
  expect(calls.some((call) => call.url.includes("/publish"))).toBe(false);
  const user = userEvent.setup({ document });
  await user.type(view.getByRole("textbox", { name: "X post 1" }), "!");
  await waitFor(() =>
    expect(
      view.queryByText(/An immutable publication review is shown below/),
    ).toBeNull(),
  );
  await waitFor(
    () =>
      expect(view.getByRole("status").textContent).toContain(
        "Saved to Typefully",
      ),
    { timeout: 1_500 },
  );
  await user.click(view.getByRole("button", { name: "Review & publish" }));
  expect(
    await view.findByText(/An immutable publication review is shown below/),
  ).toBeTruthy();
  expect(
    calls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/proposals"),
    ),
  ).toHaveLength(2);
});

test("save as new pushes the production route onto the authoritative copied draft", async () => {
  const copiedId = "17a7b81e-2360-43a4-872c-c13175832a5d";
  const copiedBody = "Keep this conflicted copy";
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  confirmTypefully(queryClient);
  queryClient.setQueryData(channelKeys.detail(channel.id), channel);
  queryClient.setQueryData(agentKeys.detail("bot-1"), {
    id: "bot-1",
    name: "Launch Bot",
    title: "Writer",
    roleDescription: "Writes launch posts",
    avatarSeed: "launch",
    visibility: "private",
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: true,
    canManage: false,
    mine: false,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (method === "PUT")
      return new Response(
        JSON.stringify({ code: "version_conflict", currentVersion: 2 }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    if (method === "POST" && url.endsWith(`/${draftId}/copy`))
      return new Response(
        JSON.stringify({
          draft: {
            id: copiedId,
            title: "Production route draft",
            destinations: ["x"],
            socialSetLabel: "Route account",
            mediaCount: 0,
            version: 1,
            syncStatus: "local",
            proposalStatus: null,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    if (method === "GET" && url.includes(`/drafts/${copiedId}`))
      return new Response(
        JSON.stringify({
          draft: {
            ...authoritativeDraft(),
            id: copiedId,
            version: 1,
            contentHash: "copy-hash",
            remoteDraftId: null,
            remoteVersion: null,
            remoteHash: null,
            syncStatus: "local",
            document: {
              ...authoritativeDraft().document,
              posts: [{ id: "p1", x: copiedBody, linkedin: "" }],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    if (method === "GET" && url.includes(`/drafts/${draftId}`))
      return new Response(
        JSON.stringify({
          draft: { ...authoritativeDraft(), version: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return new Response(JSON.stringify({ version: "test", agents: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const root = createRootRoute({ component: ProductionTestRoot });
  const route = ProductionChannelRoute.update({
    id: "/channel/$channelId",
    path: "/channel/$channelId",
    getParentRoute: () => root,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [`/channel/${channel.id}?draft=${draftId}`],
    }),
    context: { queryClient },
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  const editor = await view.findByRole("textbox", { name: "X post 1" });
  await user.clear(editor);
  await user.type(editor, copiedBody);
  expect((editor as HTMLTextAreaElement).disabled).toBe(false);
  expect(
    await view.findByRole(
      "button",
      { name: "Save as new" },
      { timeout: 1_500 },
    ),
  ).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Save as new" }));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ draft: copiedId }),
  );
  expect(
    (
      (await view.findByRole("textbox", {
        name: "X post 1",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe(copiedBody);
  await act(async () => {
    await router.history.back();
  });
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ draft: draftId }),
  );
});
