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
afterEach(() => {
  cleanup();
  mock.restore();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

const draftId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";

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
  globalThis.fetch = fetchImplementation;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { queryClient };
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
  expect(view.getByTestId("detail-panel-main").className).toContain(
    "max-md:hidden",
  );
  expect(view.getByTestId("detail-panel-pane").className).toContain(
    "max-md:!w-full",
  );
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
  expect(view.getByTestId("detail-panel-main").className).toContain(
    "max-md:hidden",
  );

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
  const { queryClient } = queryView((async (input) => {
    calls.push(String(input));
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
