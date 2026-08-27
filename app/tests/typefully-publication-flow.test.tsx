import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CanvasShell } from "../src/components/typefully/canvas-shell";
import type {
  AuthoritativeDraft,
  PublicationProposal,
} from "../src/lib/typefully/queries";

const proposalId = "f36e8a5e-a3c0-4ea8-93e1-10be25ff37f1";
const draftId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";
const draft: AuthoritativeDraft = {
  id: draftId,
  document: {
    title: "Launch",
    destinations: ["x"],
    socialSetId: "set-1",
    accountLabel: "Product",
    posts: [{ id: "post-1", x: "Publish me", linkedin: "" }],
    media: [],
    scheduleAt: null,
  },
  version: 7,
  contentHash: "hash-7",
  remoteDraftId: "remote-7",
  remoteVersion: 7,
  remoteHash: "hash-7",
  syncStatus: "synced",
  lastError: null,
  createdAt: "2026-08-27T18:00:00.000Z",
  updatedAt: "2026-08-27T18:01:00.000Z",
};
const summary = {
  id: proposalId,
  draftId,
  version: 7,
  destinations: ["x"] as const,
  expiresAt: "2099-08-27T20:00:00.000Z",
  status: "pending" as const,
};
const authoritative: PublicationProposal = {
  ...summary,
  destinations: [...summary.destinations],
  snapshot: draft.document,
  contentHash: draft.contentHash,
  decidedAt: null,
  completedAt: null,
  vendorResultId: null,
  publishedUrl: null,
  failureDetail: null,
};
const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  mock.restore();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

test("publishing requires prepare and then a second explicit action on immutable review", async () => {
  const prepare = mock(() => {});
  const calls: string[] = [];
  globalThis.fetch = mock(async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({ proposal: authoritative });
  }) as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const first = render(
    <QueryClientProvider client={client}>
      <CanvasShell
        draft={draft}
        onPreparePublication={prepare}
        remoteConnected
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });

  expect(first.queryByRole("button", { name: "Publish now" })).toBeNull();
  await user.click(first.getByRole("button", { name: "Review & publish" }));
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([]);
  first.unmount();

  const review = render(
    <QueryClientProvider client={client}>
      <CanvasShell draft={draft} proposal={summary} remoteConnected />
    </QueryClientProvider>,
  );
  expect((await review.findAllByText("Publish me")).length).toBeGreaterThan(0);
  await user.click(review.getByRole("button", { name: "Publish now" }));
  await waitFor(() =>
    expect(calls).toContain(
      `POST /api/typefully/proposals/${proposalId}/publish`,
    ),
  );
});

test("a changed or unsaved draft cannot reuse publication review", () => {
  const changed = render(
    <QueryClientProvider client={new QueryClient()}>
      <CanvasShell
        draft={{
          ...draft,
          version: 8,
          contentHash: "hash-8",
          remoteVersion: 8,
          remoteHash: "hash-8",
        }}
        proposal={summary}
        remoteConnected
      />
    </QueryClientProvider>,
  );
  expect(changed.getByText(/draft changed/i)).toBeTruthy();
  expect(changed.queryByRole("button", { name: "Publish now" })).toBeNull();
  changed.unmount();

  const dirty = render(
    <CanvasShell
      autosave={{
        document: draft.document,
        target: { draftId, version: 7 },
        state: { kind: "dirty", remote: "confirmed" },
      }}
      draft={draft}
      remoteConnected
    />,
  );
  expect(
    (
      dirty.getByRole("button", {
        name: "Review & publish",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
