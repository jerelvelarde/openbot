import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { CanvasShellProps } from "../src/components/typefully/canvas-shell";
import { typefullyKeys } from "../src/lib/typefully/queries";

let renderedShell: CanvasShellProps | undefined;

mock.module("../src/components/typefully/canvas-shell", () => ({
  CanvasShell: (props: CanvasShellProps) => {
    renderedShell = props;
    return (
      <div>
        <span data-testid="media-count">{props.document?.media.length}</span>
        {props.mediaOperationError ? (
          <p role="alert">{props.mediaOperationError}</p>
        ) : null}
      </div>
    );
  },
}));

const draftId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";
const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  renderedShell = undefined;
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test("a stale upload callback refuses exhausted order capacity without mutation", async () => {
  const authoritative = {
    id: draftId,
    document: {
      title: "Capacity draft",
      destinations: ["x"] as const,
      socialSetId: null,
      accountLabel: "Route account",
      posts: [{ id: "p1", x: "Body", linkedin: "" }],
      media: [
        {
          id: "existing-media",
          kind: "image" as const,
          order: 19,
          altText: "Existing",
          remoteId: "remote-existing",
        },
      ],
      scheduleAt: null,
    },
    version: 7,
    contentHash: "hash-7",
    remoteDraftId: "remote-draft",
    remoteVersion: 7,
    remoteHash: "hash-7",
    syncStatus: "synced" as const,
    lastError: null,
    createdAt: "2026-08-27T08:00:00.000Z",
    updatedAt: "2026-08-27T08:00:00.000Z",
  };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const cached = { draft: authoritative };
  queryClient.setQueryData(typefullyKeys.draft(draftId), cached);
  const fetchRequest = mock(() =>
    Promise.reject(new Error("capacity guard must not make a request")),
  );
  globalThis.fetch = fetchRequest as typeof fetch;
  const createObjectURL = mock(() => "blob:must-not-be-created");
  const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });

  try {
    const { DraftCanvas } = await import(
      "../src/components/typefully/draft-canvas"
    );
    const view = render(
      <QueryClientProvider client={queryClient}>
        <DraftCanvas draftId={draftId} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(renderedShell).toBeDefined());
    const beforeDocument = renderedShell?.document;

    await act(async () => {
      renderedShell?.onSelectMedia?.([
        new File(["image"], "blocked.png", { type: "image/png" }),
      ]);
    });

    expect(view.getByRole("alert").textContent).toContain(
      "Media capacity reached",
    );
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(renderedShell?.document).toBe(beforeDocument);
    expect(renderedShell?.document?.media).toEqual(
      authoritative.document.media,
    );
    expect(view.getByTestId("media-count").textContent).toBe("1");
    expect(queryClient.getQueryData(typefullyKeys.draft(draftId))).toBe(cached);
  } finally {
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
  }
});

test("a gapped layout uploads at the exact next order six", async () => {
  const authoritative = {
    id: draftId,
    document: {
      title: "Gapped draft",
      destinations: ["x"] as const,
      socialSetId: null,
      accountLabel: "Route account",
      posts: [{ id: "p1", x: "Body", linkedin: "" }],
      media: [0, 5].map((order) => ({
        id: `existing-${order}`,
        kind: "image" as const,
        order,
        altText: "Existing",
        remoteId: `remote-${order}`,
      })),
      scheduleAt: null,
    },
    version: 7,
    contentHash: "hash-7",
    remoteDraftId: "remote-draft",
    remoteVersion: 7,
    remoteHash: "hash-7",
    syncStatus: "synced" as const,
    lastError: null,
    createdAt: "2026-08-27T08:00:00.000Z",
    updatedAt: "2026-08-27T08:00:00.000Z",
  };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritative,
  });
  let submittedVersion: string | null = null;
  let uploadRequests = 0;
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? "GET") !== "POST") {
      return new Response(JSON.stringify({ draft: authoritative }), {
        headers: { "content-type": "application/json" },
      });
    }
    uploadRequests += 1;
    const form = init?.body as FormData;
    submittedVersion = form.get("expectedVersion") as string;
    return new Response(
      JSON.stringify({
        draft: {
          id: draftId,
          title: "Gapped draft",
          destinations: ["x"],
          socialSetLabel: "Route account",
          mediaCount: 3,
          version: 9,
          syncStatus: "synced",
          proposalStatus: null,
        },
        media: {
          id: "authoritative-new-media",
          kind: "image",
          order: 6,
          altText: "",
          remoteId: "remote-new-media",
        },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:gapped-upload",
  });

  try {
    const { DraftCanvas } = await import(
      "../src/components/typefully/draft-canvas"
    );
    render(
      <QueryClientProvider client={queryClient}>
        <DraftCanvas draftId={draftId} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(renderedShell).toBeDefined());

    await act(async () => {
      await (renderedShell?.onSelectMedia?.([
        new File(["image"], "allowed.png", { type: "image/png" }),
      ]) as unknown as Promise<void>);
    });

    expect(uploadRequests).toBe(1);
    expect(submittedVersion).toBe("7");
    await waitFor(() =>
      expect(renderedShell?.document?.media.map((item) => item.order)).toEqual([
        0, 5, 6,
      ]),
    );
    expect(renderedShell?.mediaOperationError).toBeNull();
  } finally {
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
  }
});
