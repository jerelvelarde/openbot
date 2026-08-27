import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ConnectTypefully,
  type PendingTypefullyOperation,
  resumePendingTypefullyOperation,
} from "../src/components/typefully/connect-typefully";
import { pluginKeys } from "../src/lib/plugins/queries";
import { typefullyKeys } from "../src/lib/typefully/queries";

const draftId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";
const originalFetch = globalThis.fetch;

function authoritativeDraft(version = 5) {
  return {
    id: draftId,
    document: {
      title: "Resume draft",
      destinations: ["x"] as const,
      socialSetId: null,
      accountLabel: "Product team",
      posts: [{ id: "post-1", x: "Hello", linkedin: "" }],
      media: [],
      scheduleAt: null,
    },
    version,
    contentHash: `hash-${version}`,
    remoteDraftId: null,
    remoteVersion: null,
    remoteHash: null,
    syncStatus: "connection_required" as const,
    lastError: null,
    createdAt: "2026-08-27T08:00:00.000Z",
    updatedAt: "2026-08-27T08:00:00.000Z",
  };
}

function syncedDraft(version = 5) {
  return {
    ...authoritativeDraft(version),
    remoteDraftId: "remote-draft",
    remoteVersion: version,
    remoteHash: `hash-${version}`,
    syncStatus: "synced" as const,
  };
}

const typefullyConnection = {
  serverId: "typefully",
  authMethod: "api_key" as const,
  scope: null,
  accountLabel: "Product team",
  connectedAt: "2026-08-27T08:00:00.000Z",
};

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  mock.restore();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

test("refetches connection and authoritative draft before resuming exactly once", async () => {
  const calls: string[] = [];
  const pending: PendingTypefullyOperation = {
    kind: "prepare_publication",
    draftId,
    expectedVersion: 5,
  };
  const result = await resumePendingTypefullyOperation(pending, {
    loadConnection: async () => {
      calls.push("connection");
    },
    loadDraft: async () => {
      calls.push("draft");
      return authoritativeDraft();
    },
    sync: async () => {
      calls.push("sync");
      return { version: 5 };
    },
    preparePublication: async () => {
      calls.push("prepare");
      return { proposalId: "proposal-1", version: 5 };
    },
  });

  expect(calls).toEqual(["connection", "draft", "prepare"]);
  expect(result).toEqual({
    outcome: "resumed",
    draftId,
    operation: "prepare_publication",
    version: 5,
    proposalId: "proposal-1",
  });
});

test("a changed authoritative version refuses stale schedule input", async () => {
  let operations = 0;
  const result = await resumePendingTypefullyOperation(
    { kind: "schedule", draftId, expectedVersion: 5 },
    {
      loadConnection: async () => {},
      loadDraft: async () => authoritativeDraft(6),
      sync: async () => {
        operations += 1;
        return { version: 6 };
      },
      preparePublication: async () => {
        operations += 1;
        return { proposalId: "proposal-1", version: 6 };
      },
    },
  );

  expect(operations).toBe(0);
  expect(result).toEqual({
    outcome: "stale",
    draftId,
    operation: "schedule",
    expectedVersion: 5,
    currentVersion: 6,
  });
});

test("the specialized connection decision has bounded non-secret arguments", async () => {
  const { TypefullyConnectionArgs } = await import(
    "../src/components/gallery/typefully-connection"
  );
  expect(
    TypefullyConnectionArgs.safeParse({
      draftId,
      operation: "sync",
      expectedVersion: 5,
    }).success,
  ).toBe(true);
  expect(
    TypefullyConnectionArgs.safeParse({
      draftId,
      operation: "sync",
      expectedVersion: 5,
      apiKey: "tf_must_not_be_an_argument",
    }).success,
  ).toBe(false);
});

test("cancel answers a suspended Bot once without executing or changing the draft", async () => {
  const { TypefullyConnectionDecision } = await import(
    "../src/components/gallery/typefully-connection"
  );
  const respond = mock(async () => {});
  const resume = mock(async () => ({
    outcome: "resumed" as const,
    draftId,
    operation: "sync" as const,
    version: 5,
  }));
  const cachedDraft = { draft: authoritativeDraft() };
  const queryClient = new QueryClient();
  queryClient.setQueryData(["typefully", "draft", draftId], cachedDraft);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TypefullyConnectionDecision
        args={{ draftId, operation: "sync", expectedVersion: 5 }}
        respond={respond}
        resumeOperation={resume}
        status="executing"
      />
    </QueryClientProvider>,
  );

  await userEvent
    .setup({ document })
    .dblClick(view.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(resume).not.toHaveBeenCalled();
  expect(respond.mock.calls[0]?.[0]).toEqual({
    outcome: "declined",
    code: "connection_declined",
    draftId,
    operation: "sync",
  });
  expect(queryClient.getQueryData(["typefully", "draft", draftId])).toBe(
    cachedDraft,
  );
});

test("a failed suspended response stays visible and retryable", async () => {
  const { TypefullyConnectionDecision } = await import(
    "../src/components/gallery/typefully-connection"
  );
  let attempts = 0;
  const respond = mock(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("run unavailable");
  });
  const resume = mock(async () => ({
    outcome: "resumed" as const,
    draftId,
    operation: "sync" as const,
    version: 5,
  }));
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TypefullyConnectionDecision
        args={{ draftId, operation: "sync", expectedVersion: 5 }}
        respond={respond}
        resumeOperation={resume}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const cancel = view.getByRole("button", { name: "Cancel" });

  await userEvent.setup({ document }).click(cancel);
  expect((await view.findByRole("alert")).textContent).toContain(
    "The connection decision could not be sent",
  );
  await userEvent.setup({ document }).click(cancel);

  await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
  expect(resume).not.toHaveBeenCalled();
});

test("a Bot-initiated connection resumes the bounded operation and responds once", async () => {
  const { TypefullyConnectionDecision } = await import(
    "../src/components/gallery/typefully-connection"
  );
  const respond = mock(async () => {});
  const outcome = {
    outcome: "resumed" as const,
    draftId,
    operation: "prepare_publication" as const,
    version: 5,
    proposalId: "proposal-1",
  };
  const resume = mock(async () => outcome);
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        connection: {
          serverId: "typefully",
          authMethod: "api_key",
          accountLabel: "Product team",
          connectedAt: "2026-08-27T08:00:00.000Z",
        },
      }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TypefullyConnectionDecision
        args={{
          draftId,
          operation: "prepare_publication",
          expectedVersion: 5,
        }}
        respond={respond}
        resumeOperation={resume}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.type(
    view.getByLabelText("Typefully API key"),
    "tf_component_local_secret",
  );
  await user.click(view.getByRole("button", { name: "Connect Typefully" }));

  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[0]?.[0]).toEqual({
    kind: "prepare_publication",
    draftId,
    expectedVersion: 5,
  });
  expect(resume.mock.calls[0]?.[1]).toBe(5);
  expect(respond.mock.calls[0]?.[0]).toEqual(outcome);
  expect(view.container.textContent).not.toContain("tf_component_local_secret");
});

test("unmounting during connection never executes the pending operation", async () => {
  const { TypefullyConnectionDecision } = await import(
    "../src/components/gallery/typefully-connection"
  );
  let finishConnection!: (response: Response) => void;
  globalThis.fetch = (async () =>
    await new Promise<Response>((resolve) => {
      finishConnection = resolve;
    })) as typeof fetch;
  const respond = mock(async () => {});
  const resume = mock(async () => ({
    outcome: "resumed" as const,
    draftId,
    operation: "sync" as const,
    version: 5,
  }));
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TypefullyConnectionDecision
        args={{ draftId, operation: "sync", expectedVersion: 5 }}
        respond={respond}
        resumeOperation={resume}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.type(view.getByLabelText("Typefully API key"), "tf_unmounted");
  await user.click(view.getByRole("button", { name: "Connect Typefully" }));
  view.unmount();
  finishConnection(
    new Response(
      JSON.stringify({
        connection: {
          serverId: "typefully",
          authMethod: "api_key",
          accountLabel: null,
          connectedAt: "2026-08-27T08:00:00.000Z",
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(resume).not.toHaveBeenCalled();
  expect(respond).not.toHaveBeenCalled();
});

test("the draft canvas keeps the local draft visible when connection is cancelled", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const cached = { draft: authoritativeDraft() };
  queryClient.setQueryData(typefullyKeys.draft(draftId), cached);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );

  expect(view.getByLabelText("Typefully API key")).toBeTruthy();
  expect(
    (view.getByRole("textbox", { name: "X post 1" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Hello");
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: "Cancel" }));

  expect(view.queryByLabelText("Typefully API key")).toBeNull();
  expect(
    (view.getByRole("textbox", { name: "X post 1" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Hello");
  expect(queryClient.getQueryData(typefullyKeys.draft(draftId))).toBe(cached);
  expect(view.getByRole("button", { name: "Connect Typefully" })).toBeTruthy();
});

test("disconnecting an active canvas clears remote authority but preserves the local draft", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: syncedDraft(),
  });
  queryClient.setQueryData(pluginKeys.connections(), {
    connections: [typefullyConnection],
    redirectUri: null,
  });
  globalThis.fetch = (async (input, init) => {
    if (
      String(input) === "/api/plugins/connections/typefully" &&
      init?.method === "DELETE"
    ) {
      return new Response(JSON.stringify({ disconnected: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (String(input) === "/api/plugins/connections") {
      return new Response(
        JSON.stringify({ connections: [], redirectUri: null }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
      <ConnectTypefully connection={typefullyConnection} />
    </QueryClientProvider>,
  );
  expect(view.getByTestId("publish-readiness").textContent).toContain(
    "Ready for approval",
  );

  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: "Disconnect Typefully" }));

  await waitFor(() =>
    expect(view.getByTestId("canvas-status").textContent).toContain(
      "Saved in OpenBot",
    ),
  );
  expect(view.getByTestId("publish-readiness").textContent).toContain(
    "Connect Typefully",
  );
  expect(
    view
      .getByRole("button", { name: "Review & publish" })
      .hasAttribute("disabled"),
  ).toBeTrue();
  expect(
    (view.getByRole("textbox", { name: "X post 1" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Hello");
  expect(queryClient.getQueryData(typefullyKeys.draft(draftId))).toMatchObject({
    draft: {
      document: { posts: [{ x: "Hello" }] },
      remoteDraftId: null,
      remoteVersion: null,
      remoteHash: null,
      syncStatus: "local",
    },
  });
});

test("a direct synced canvas confirms connections over the network and localizes when disconnected", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: syncedDraft(),
  });
  const requests: string[] = [];
  let finishConnectionCheck!: (response: Response) => void;
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    if (String(input) === "/api/plugins/connections") {
      return await new Promise<Response>((resolve) => {
        finishConnectionCheck = resolve;
      });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  }) as typeof fetch;

  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );

  await waitFor(() => expect(requests).toContain("/api/plugins/connections"));
  await act(async () => {
    finishConnectionCheck(
      new Response(JSON.stringify({ connections: [], redirectUri: null }), {
        headers: { "content-type": "application/json" },
      }),
    );
  });
  await waitFor(() =>
    expect(view.getByTestId("canvas-status").textContent).toContain(
      "Saved in OpenBot",
    ),
  );
  expect(view.getByTestId("publish-readiness").textContent).toContain(
    "Connect Typefully",
  );
  expect(
    view
      .getByRole("button", { name: "Review & publish" })
      .hasAttribute("disabled"),
  ).toBeTrue();
  expect(
    (view.getByRole("textbox", { name: "X post 1" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Hello");
  expect(queryClient.getQueryData(typefullyKeys.draft(draftId))).toMatchObject({
    draft: {
      remoteDraftId: null,
      remoteVersion: null,
      remoteHash: null,
      syncStatus: "local",
    },
  });
  expect(requests).toEqual(["/api/plugins/connections"]);
});

test("a pending or failed connection check never exposes stale remote readiness", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: syncedDraft(),
  });
  let finishConnectionCheck!: (response: Response) => void;
  globalThis.fetch = (async (input) => {
    if (String(input) === "/api/plugins/connections") {
      return await new Promise<Response>((resolve) => {
        finishConnectionCheck = resolve;
      });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );

  expect(view.getByTestId("canvas-status").textContent).toContain(
    "Saved in OpenBot",
  );
  expect(
    view
      .getByRole("button", { name: "Review & publish" })
      .hasAttribute("disabled"),
  ).toBeTrue();

  await act(async () => {
    finishConnectionCheck(
      new Response(JSON.stringify({ error: "offline" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  await waitFor(() =>
    expect(queryClient.getQueryState(pluginKeys.connections())?.status).toBe(
      "error",
    ),
  );
  expect(view.getByTestId("canvas-status").textContent).toContain(
    "Saved in OpenBot",
  );
  expect(
    view
      .getByRole("button", { name: "Review & publish" })
      .hasAttribute("disabled"),
  ).toBeTrue();
});

test("an authoritative connected result restores confirmed remote readiness", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: syncedDraft(),
  });
  globalThis.fetch = (async (input) => {
    if (String(input) === "/api/plugins/connections") {
      return new Response(
        JSON.stringify({
          connections: [typefullyConnection],
          redirectUri: null,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );

  await waitFor(() =>
    expect(view.getByTestId("publish-readiness").textContent).toContain(
      "Ready for approval",
    ),
  );
  expect(view.getByTestId("canvas-status").textContent).toContain(
    "Saved to Typefully",
  );
  expect(
    view
      .getByRole("button", { name: "Review & publish" })
      .hasAttribute("disabled"),
  ).toBeFalse();
});

test("unmounting the inline canvas aborts authority revalidation before sync", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  let finishConnectionCheck!: (response: Response) => void;
  let connectionCheckStarted!: () => void;
  const connectionCheck = new Promise<void>((resolve) => {
    connectionCheckStarted = resolve;
  });
  const requests: string[] = [];
  let connectionRequestSignal: AbortSignal | null = null;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (url.endsWith("/api-key")) {
      return new Response(JSON.stringify({ connection: typefullyConnection }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/plugins/connections") {
      connectionRequestSignal = init?.signal ?? null;
      connectionCheckStarted();
      return await new Promise<Response>((resolve) => {
        finishConnectionCheck = resolve;
      });
    }
    if (url === `/api/typefully/drafts/${draftId}`) {
      return new Response(JSON.stringify({ draft: authoritativeDraft() }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/sync")) {
      return new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.type(view.getByLabelText("Typefully API key"), "tf_inline_abort");
  await user.click(view.getByRole("button", { name: "Connect Typefully" }));
  await connectionCheck;

  view.unmount();
  expect(connectionRequestSignal?.aborted).toBeTrue();
  await act(async () => {
    finishConnectionCheck(
      new Response(
        JSON.stringify({
          connections: [typefullyConnection],
          redirectUri: null,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(requests.some((request) => request.endsWith("/sync"))).toBeFalse();
});

test("cancelling inline authority revalidation aborts before sync", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  let finishConnectionCheck!: (response: Response) => void;
  let connectionCheckStarted!: () => void;
  const connectionCheck = new Promise<void>((resolve) => {
    connectionCheckStarted = resolve;
  });
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (url.endsWith("/api-key")) {
      return new Response(JSON.stringify({ connection: typefullyConnection }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/plugins/connections") {
      connectionCheckStarted();
      return await new Promise<Response>((resolve) => {
        finishConnectionCheck = resolve;
      });
    }
    if (url === `/api/typefully/drafts/${draftId}`) {
      return new Response(JSON.stringify({ draft: authoritativeDraft() }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/sync")) {
      return new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DraftCanvas draftId={draftId} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.type(view.getByLabelText("Typefully API key"), "tf_inline_cancel");
  await user.click(view.getByRole("button", { name: "Connect Typefully" }));
  await connectionCheck;

  await user.click(view.getByRole("button", { name: "Cancel" }));
  await act(async () => {
    finishConnectionCheck(
      new Response(
        JSON.stringify({
          connections: [typefullyConnection],
          redirectUri: null,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(requests.some((request) => request.endsWith("/sync"))).toBeFalse();
  expect(view.getByRole("textbox", { name: "X post 1" })).toBeTruthy();
});

test("the draft canvas refetches authority and resumes a pending sync once", async () => {
  const { DraftCanvas } = await import(
    "../src/components/typefully/draft-canvas"
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(typefullyKeys.draft(draftId), {
    draft: authoritativeDraft(),
  });
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (url.endsWith("/api-key")) {
      return new Response(
        JSON.stringify({
          connection: {
            serverId: "typefully",
            authMethod: "api_key",
            accountLabel: "Product team",
            connectedAt: "2026-08-27T08:00:00.000Z",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === "/api/plugins/connections") {
      return new Response(
        JSON.stringify({
          connections: [
            {
              serverId: "typefully",
              authMethod: "api_key",
              scope: null,
              accountLabel: "Product team",
              connectedAt: "2026-08-27T08:00:00.000Z",
            },
          ],
          redirectUri: null,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (method === "POST" && url.endsWith("/sync")) {
      return new Response(
        JSON.stringify({
          draft: {
            id: draftId,
            title: "Resume draft",
            destinations: ["x"],
            socialSetLabel: "Product team",
            mediaCount: 0,
            version: 5,
            syncStatus: "synced",
            proposalStatus: null,
          },
          remote: {
            state: "synced",
            remoteDraftId: "remote-draft",
            confirmedVersion: 5,
            confirmedHash: "hash-5",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        draft: {
          ...authoritativeDraft(),
          remoteDraftId: "remote-draft",
          remoteVersion: 5,
          remoteHash: "hash-5",
          syncStatus: "synced",
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
  await user.type(view.getByLabelText("Typefully API key"), "tf_resume_once");
  await user.click(view.getByRole("button", { name: "Connect Typefully" }));

  await waitFor(() =>
    expect(
      requests.filter((request) => request.endsWith("/sync")),
    ).toHaveLength(1),
  );
  expect(requests).toContain("PUT /api/plugins/connections/typefully/api-key");
  expect(requests).toContain("GET /api/plugins/connections");
  expect(
    requests.filter(
      (request) => request === `GET /api/typefully/drafts/${draftId}`,
    ).length,
  ).toBeGreaterThanOrEqual(1);
  expect(view.queryByLabelText("Typefully API key")).toBeNull();
  expect(view.container.textContent).not.toContain("tf_resume_once");
});
