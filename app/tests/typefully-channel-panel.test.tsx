import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { DetailPanel } from "../src/components/layout/detail-panel";
import { TypefullyClientError } from "../src/lib/typefully/queries";
import {
  channelDetailPresentation,
  channelPaneSearch,
} from "../src/routes/_authed/_app/channel/$channelId";

const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  mock.restore();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

const draftId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";

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
