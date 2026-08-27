import { afterEach, describe, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import {
  connectTypefully,
  createDraftMutationOptions,
  declineProposalMutationOptions,
  deleteMediaMutationOptions,
  disconnectTypefullyMutationOptions,
  prepareProposalMutationOptions,
  publishProposalMutationOptions,
  reconcileDraftMutationOptions,
  reconcileProposalMutationOptions,
  saveDraftMutationOptions,
  syncDraftMutationOptions,
  TypefullyClientError,
  uploadMediaMutationOptions,
} from "../src/lib/typefully/mutations";
import {
  type AuthoritativeDraft,
  type CanonicalDraftDocument,
  draftQueryOptions,
  proposalQueryOptions,
  typefullyKeys,
} from "../src/lib/typefully/queries";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const document: CanonicalDraftDocument = {
  title: "Launch",
  destinations: ["x", "linkedin"],
  socialSetId: "12",
  accountLabel: "OpenBot",
  posts: [{ id: "post-1", x: "Hello X", linkedin: "Hello LinkedIn" }],
  media: [],
  scheduleAt: null,
};

const draftSummary = (version: number, syncStatus = "synced" as const) => ({
  id: "draft-1",
  title: "Launch",
  destinations: ["x"] as const,
  socialSetLabel: "OpenBot",
  mediaCount: 0,
  version,
  syncStatus,
  proposalStatus: null,
});

const authoritativeDraft = (
  version: number,
  overrides: Partial<AuthoritativeDraft> = {},
): AuthoritativeDraft => ({
  id: "draft-1",
  document,
  version,
  contentHash: `hash-${version}`,
  remoteDraftId: `remote-${version}`,
  remoteVersion: version,
  remoteHash: `remote-hash-${version}`,
  syncStatus: "synced",
  lastError: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
  ...overrides,
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capture(responseBody: unknown = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init });
    return json(responseBody);
  }) as typeof fetch;
  return calls;
}

async function mutate<TVariables>(
  options: { mutationFn?: (variables: TVariables, context: never) => unknown },
  variables: TVariables,
) {
  if (!options.mutationFn) throw new Error("Missing mutationFn in test.");
  return await options.mutationFn(variables, {} as never);
}

describe("Typefully query contracts", () => {
  test("uses stable, secret-free keys and exact load routes", async () => {
    const draftId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";
    const calls = capture({
      draft: authoritativeDraft(1, {
        id: draftId,
      }),
    });
    expect(typefullyKeys.all).toEqual(["typefully"]);
    expect(typefullyKeys.draft("draft/one")).toEqual([
      "typefully",
      "draft",
      "draft/one",
    ]);
    expect(typefullyKeys.proposal("proposal/one")).toEqual([
      "typefully",
      "proposal",
      "proposal/one",
    ]);
    expect(typefullyKeys.lists()).toEqual(["typefully", "list"]);

    const abort = new AbortController();
    await draftQueryOptions(draftId).queryFn?.({
      signal: abort.signal,
    } as never);
    await proposalQueryOptions("proposal/one").queryFn?.({} as never);

    expect(calls.map(({ url, init }) => [url, init?.method ?? "GET"])).toEqual([
      [`/api/typefully/drafts/${draftId}`, "GET"],
      ["/api/typefully/proposals/proposal%2Fone", "GET"],
    ]);
    expect(calls[0]?.init?.signal).toBe(abort.signal);
    expect(draftQueryOptions("draft/one").gcTime).toBe(0);
  });

  test("strictly validates bounded authoritative draft responses", async () => {
    const valid = authoritativeDraft(1, {
      id: "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53",
    });
    for (const malformed of [
      null,
      [],
      {},
      { draft: null },
      { draft: { ...valid, syncStatus: "regressed" } },
      {
        draft: {
          ...valid,
          document: { ...valid.document, destinations: ["threads"] },
        },
      },
      {
        draft: {
          ...valid,
          document: { ...valid.document, posts: [{ id: "missing-bodies" }] },
        },
      },
      { draft: { ...valid, lastError: "e".repeat(501) } },
      {
        draft: {
          ...valid,
          document: {
            ...valid.document,
            posts: [{ id: "post-1", x: "x".repeat(100_001), linkedin: "ok" }],
          },
        },
      },
    ]) {
      capture(malformed);
      const error = await draftQueryOptions(valid.id)
        .queryFn?.({} as never)
        .then(() => null)
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(TypefullyClientError);
      expect((error as TypefullyClientError).code).toBe(
        "remote_invalid_response",
      );
      expect((error as Error).message).not.toContain("regressed");
      expect((error as Error).message).not.toContain("threads");
    }

    capture({ draft: valid });
    expect(await draftQueryOptions(valid.id).queryFn?.({} as never)).toEqual({
      draft: valid,
    });
  });

  test("rejects a valid-shaped draft returned for a different requested id without caching or leaking ids", async () => {
    const requestedId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";
    const returnedId = "a2847b7f-1371-4fa7-88c8-aa80c610e50e";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    capture({
      draft: authoritativeDraft(1, {
        id: returnedId,
        document: {
          ...document,
          posts: [{ id: "p1", x: "private", linkedin: "" }],
        },
      }),
    });

    const error = await queryClient
      .fetchQuery(draftQueryOptions(requestedId))
      .then(() => null)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(TypefullyClientError);
    expect((error as TypefullyClientError).code).toBe(
      "remote_invalid_response",
    );
    expect((error as Error).message).not.toContain(requestedId);
    expect((error as Error).message).not.toContain(returnedId);
    expect((error as Error).message).not.toContain("private");
    expect(queryClient.getQueryData(typefullyKeys.draft(requestedId))).toBe(
      undefined,
    );
  });
});

describe("Typefully mutation contracts", () => {
  test("sends exact JSON routes and bodies", async () => {
    const calls = capture({
      proposal: {
        id: "proposal-1",
        draftId: "draft/1",
        version: 5,
        destinations: ["x"],
        expiresAt: "2026-08-28T00:00:00.000Z",
        status: "pending",
      },
    });
    await mutate(createDraftMutationOptions(), {
      channelId: "channel-1",
      botId: "bot-1",
      document,
    });
    await mutate(saveDraftMutationOptions(), {
      draftId: "draft/1",
      expectedVersion: 4,
      document,
    });
    await mutate(syncDraftMutationOptions(), { draftId: "draft/1" });
    await mutate(reconcileDraftMutationOptions(), {
      draftId: "draft/1",
      expectedVersion: 5,
      remoteDraftId: "77",
    });
    await mutate(prepareProposalMutationOptions(), {
      draftId: "draft/1",
      expectedVersion: 5,
    });
    await mutate(publishProposalMutationOptions(), {
      proposalId: "proposal/1",
    });
    await mutate(reconcileProposalMutationOptions(), {
      proposalId: "proposal/1",
    });
    await mutate(declineProposalMutationOptions(), {
      proposalId: "proposal/1",
    });
    await mutate(disconnectTypefullyMutationOptions(), undefined);

    expect(
      calls.map(({ url, init }) => [
        url,
        init?.method,
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      ]),
    ).toEqual([
      [
        "/api/typefully/drafts",
        "POST",
        { channelId: "channel-1", botId: "bot-1", document },
      ],
      [
        "/api/typefully/drafts/draft%2F1",
        "PUT",
        { expectedVersion: 4, document },
      ],
      ["/api/typefully/drafts/draft%2F1/sync", "POST", undefined],
      [
        "/api/typefully/drafts/draft%2F1/reconcile",
        "POST",
        { expectedVersion: 5, remoteDraftId: "77" },
      ],
      [
        "/api/typefully/drafts/draft%2F1/proposals",
        "POST",
        { expectedVersion: 5 },
      ],
      ["/api/typefully/proposals/proposal%2F1/publish", "POST", undefined],
      ["/api/typefully/proposals/proposal%2F1/reconcile", "POST", undefined],
      ["/api/typefully/proposals/proposal%2F1/decline", "POST", undefined],
      ["/api/plugins/connections/typefully", "DELETE", undefined],
    ]);
  });

  test("builds bounded multipart uploads and exact media deletes", async () => {
    const calls = capture({});
    const file = new File(["image"], "launch.png", { type: "image/png" });
    await mutate(uploadMediaMutationOptions(), {
      draftId: "draft/1",
      expectedVersion: 2,
      kind: "image",
      altText: "Product screenshot",
      file,
      mediaId: "retry-1",
    });
    await mutate(deleteMediaMutationOptions(), {
      draftId: "draft/1",
      mediaId: "media/1",
      expectedVersion: 3,
    });

    const form = calls[0]?.init?.body;
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("file")).toMatchObject({
      name: "launch.png",
      type: "image/png",
      size: 5,
    });
    expect((form as FormData).get("expectedVersion")).toBe("2");
    expect((form as FormData).get("kind")).toBe("image");
    expect((form as FormData).get("altText")).toBe("Product screenshot");
    expect((form as FormData).get("mediaId")).toBe("retry-1");
    expect(calls[0]?.url).toBe("/api/typefully/drafts/draft%2F1/media");
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(calls[1]?.url).toBe(
      "/api/typefully/drafts/draft%2F1/media/media%2F1",
    );
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
      expectedVersion: 3,
    });

    const oversized = new File([new Uint8Array(25_000_001)], "large.mp4", {
      type: "video/mp4",
    });
    expect(
      mutate(uploadMediaMutationOptions(), {
        draftId: "d",
        expectedVersion: 1,
        kind: "video",
        altText: "",
        file: oversized,
      }),
    ).rejects.toThrow("25 MB");
    expect(calls).toHaveLength(2);
  });

  test("keeps an API key only in the connect body, even under adversarial errors", async () => {
    const apiKey = "tf_secret_that_must_not_escape";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      return json(
        {
          code: "invalid_api_key",
          error: `Vendor rejected ${apiKey}`,
          message: `debug=${apiKey}`,
        },
        400,
      );
    }) as typeof fetch;

    expect(JSON.stringify(typefullyKeys)).not.toContain(apiKey);

    let caught: unknown;
    try {
      await connectTypefully(apiKey);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypefullyClientError);
    expect(String(caught)).not.toContain(apiKey);
    expect(JSON.stringify(caught)).not.toContain(apiKey);
    expect((caught as TypefullyClientError).code).toBe("invalid_api_key");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/plugins/connections/typefully/api-key");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ apiKey });
    expect(calls[0]?.url).not.toContain(apiKey);
  });

  test("normalizes a successful connection before it can enter mutation cache", async () => {
    const apiKey = "tf_success_secret";
    globalThis.fetch = (async () =>
      json({
        connection: {
          serverId: "typefully",
          authMethod: "api_key",
          accountLabel: "Personal Typefully",
          connectedAt: "2026-08-27T00:00:00.000Z",
          debug: apiKey,
        },
        apiKey,
      })) as typeof fetch;

    const result = await connectTypefully(apiKey);
    expect(result).toEqual({
      connection: {
        serverId: "typefully",
        authMethod: "api_key",
        accountLabel: "Personal Typefully",
        connectedAt: "2026-08-27T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  test("strips typed detail fields and metadata that try to echo the connect key", async () => {
    const apiKey = "tf_structured_secret";
    globalThis.fetch = (async () =>
      json(
        {
          code: "invalid_api_key",
          currentHash: apiKey,
          draftId: apiKey,
          connectPath: `/settings/${apiKey}`,
        },
        400,
      )) as typeof fetch;
    let failure: unknown;
    try {
      await connectTypefully(apiKey);
    } catch (error) {
      failure = error;
    }
    expect(JSON.stringify(failure)).not.toContain(apiKey);

    globalThis.fetch = (async () =>
      json({
        connection: {
          serverId: "typefully",
          authMethod: "api_key",
          accountLabel: apiKey,
          connectedAt: "2026-08-27T00:00:00.000Z",
        },
      })) as typeof fetch;
    expect(connectTypefully(apiKey)).rejects.toThrow("could not be completed");
  });

  test("never creates a secret-bearing TanStack mutation cache entry", async () => {
    const apiKey = "tf_cache_secret";
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    globalThis.fetch = (async (url: string | URL | Request) =>
      String(url).endsWith("/connections/typefully")
        ? json({ ok: true })
        : json({
            connection: {
              serverId: "typefully",
              authMethod: "api_key",
              accountLabel: null,
              connectedAt: "2026-08-27T00:00:00.000Z",
            },
          })) as typeof fetch;

    const observer = new MutationObserver(
      queryClient,
      disconnectTypefullyMutationOptions(),
    );
    await observer.mutate(undefined);
    const before = queryClient.getMutationCache().getAll().length;
    const connected = await connectTypefully(apiKey);
    expect(connected.connection.accountLabel).toBeNull();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(before);
    expect(
      JSON.stringify(queryClient.getMutationCache().getAll()),
    ).not.toContain(apiKey);

    globalThis.fetch = (async () =>
      json(
        { code: "invalid_api_key", currentHash: apiKey },
        400,
      )) as typeof fetch;
    await expect(connectTypefully(apiKey)).rejects.toThrow("did not accept");
    expect(queryClient.getMutationCache().getAll()).toHaveLength(before);
    expect(
      JSON.stringify(queryClient.getMutationCache().getAll()),
    ).not.toContain(apiKey);
  });

  test("normalizes proposal preparation to its bounded summary", async () => {
    globalThis.fetch = (async () =>
      json(
        {
          proposal: {
            id: "proposal-1",
            draftId: "draft-1",
            version: 3,
            destinations: ["x"],
            expiresAt: "2026-08-28T00:00:00.000Z",
            status: "pending",
            snapshot: document,
            contentHash: "must-not-enter-cache",
          },
        },
        201,
      )) as typeof fetch;
    const result = await mutate(prepareProposalMutationOptions(), {
      draftId: "draft-1",
      expectedVersion: 3,
    });
    expect(result).toEqual({
      proposal: {
        id: "proposal-1",
        draftId: "draft-1",
        version: 3,
        destinations: ["x"],
        expiresAt: "2026-08-28T00:00:00.000Z",
        status: "pending",
      },
    });
    expect(JSON.stringify(result)).not.toContain("snapshot");
    expect(JSON.stringify(result)).not.toContain("contentHash");
  });

  test("preparing a proposal invalidates draft, proposal, and list caches without replacing the full proposal", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const summary = {
      id: "proposal-1",
      draftId: "draft-1",
      version: 3,
      destinations: ["x"] as const,
      expiresAt: "2026-08-28T00:00:00.000Z",
      status: "pending" as const,
    };
    const fullProposal = {
      ...summary,
      snapshot: document,
      contentHash: "full-content-hash",
      decidedAt: null,
      completedAt: null,
      vendorResultId: null,
      publishedUrl: null,
      failureDetail: null,
    };
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(3),
    });
    queryClient.setQueryData(typefullyKeys.proposal("proposal-1"), {
      proposal: fullProposal,
    });
    queryClient.setQueryData(
      [...typefullyKeys.lists(), "drafts"],
      [draftSummary(3)],
    );
    globalThis.fetch = (async () =>
      json({ proposal: summary }, 201)) as typeof fetch;

    const observer = new MutationObserver(
      queryClient,
      prepareProposalMutationOptions(queryClient),
    );
    await observer.mutate({ draftId: "draft-1", expectedVersion: 3 });

    expect(
      queryClient.getQueryState(typefullyKeys.draft("draft-1"))?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(typefullyKeys.proposal("proposal-1"))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState([...typefullyKeys.lists(), "drafts"])
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryData(typefullyKeys.proposal("proposal-1")),
    ).toEqual({ proposal: fullProposal });
  });

  test("proposal actions immediately converge their exact proposal cache", async () => {
    const actions = [
      ["publish", publishProposalMutationOptions, "published"],
      ["reconcile", reconcileProposalMutationOptions, "published"],
      ["decline", declineProposalMutationOptions, "declined"],
    ] as const;
    for (const [action, options, status] of actions) {
      const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
      });
      const proposal = {
        id: `proposal-${action}`,
        draftId: "draft-1",
        version: 3,
        destinations: ["x"] as const,
        expiresAt: "2026-08-28T00:00:00.000Z",
        status,
        snapshot: document,
        contentHash: "content-hash",
        decidedAt: "2026-08-27T01:00:00.000Z",
        completedAt: status === "published" ? "2026-08-27T01:00:01.000Z" : null,
        vendorResultId: status === "published" ? "vendor-1" : null,
        publishedUrl:
          status === "published" ? "https://example.com/post" : null,
        failureDetail: null,
      };
      queryClient.setQueryData(typefullyKeys.proposal(proposal.id), {
        proposal: { ...proposal, status: "pending" },
      });
      globalThis.fetch = (async () => json({ proposal })) as typeof fetch;
      const observer = new MutationObserver(queryClient, options(queryClient));

      await observer.mutate({ proposalId: proposal.id });

      expect(
        queryClient.getQueryData(typefullyKeys.proposal(proposal.id)),
      ).toEqual({
        proposal,
      });
    }
  });

  test("rejects an invalid or unbounded proposal summary", async () => {
    const valid = {
      id: "proposal-1",
      draftId: "draft-1",
      version: 1,
      destinations: ["x"],
      expiresAt: "2026-08-28T00:00:00.000Z",
      status: "pending",
    };
    for (const proposal of [
      { ...valid, id: "p".repeat(121) },
      { ...valid, version: 0 },
      { ...valid, destinations: ["x", "x"] },
      { ...valid, expiresAt: "not-a-date" },
    ]) {
      globalThis.fetch = (async () => json({ proposal })) as typeof fetch;
      await expect(
        mutate(prepareProposalMutationOptions(), {
          draftId: "draft-1",
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  test("retains bounded media failure details and patches authoritative cache", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: {
        id: "draft-1",
        document,
        version: 1,
        contentHash: "old",
        remoteDraftId: "22",
        remoteVersion: 1,
        remoteHash: "old",
        syncStatus: "synced",
        lastError: null,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    });
    const media = {
      id: "media-1",
      kind: "image" as const,
      order: 0,
      altText: "Launch",
      remoteId: "remote-1",
    };
    globalThis.fetch = (async () =>
      json(
        {
          code: "reconciliation_required",
          draftId: "draft-1",
          draft: { ...draftSummary(2, "remote_error"), mediaCount: 1 },
          media,
          message: "untrusted",
        },
        409,
      )) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      uploadMediaMutationOptions(queryClient),
    );
    let failure: unknown;
    try {
      await observer.mutate({
        draftId: "draft-1",
        expectedVersion: 1,
        kind: "image",
        altText: "Launch",
        file: new File(["x"], "x.png", { type: "image/png" }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "reconciliation_required",
      draftId: "draft-1",
      draft: { version: 2, syncStatus: "remote_error" },
      media,
    });
    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: {
        version: 2,
        syncStatus: "remote_error",
        document: { media: [media] },
      },
    });
    expect(
      queryClient.getQueryState(typefullyKeys.draft("draft-1"))?.isInvalidated,
    ).toBe(true);
  });

  test("persists a completed upload descriptor returned at version plus two even when refetch fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    let failRefetch = false;
    await queryClient.fetchQuery({
      queryKey: typefullyKeys.draft("draft-1"),
      queryFn: async () => {
        if (failRefetch) throw new Error("refetch unavailable");
        return { draft: authoritativeDraft(1) };
      },
    });
    failRefetch = true;
    const media = {
      id: "media-complete",
      kind: "image" as const,
      order: 0,
      altText: "Completed upload",
      remoteId: "typefully-media-22",
    };
    globalThis.fetch = (async () =>
      json({
        draft: { ...draftSummary(3), mediaCount: 1 },
        remote: {
          state: "synced",
          remoteDraftId: "remote-3",
          confirmedVersion: 3,
          confirmedHash: "remote-hash-3",
        },
        media,
      })) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      uploadMediaMutationOptions(queryClient),
    );

    await observer.mutate({
      draftId: "draft-1",
      expectedVersion: 1,
      kind: "image",
      altText: media.altText,
      file: new File(["x"], "x.png", { type: "image/png" }),
    });

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: {
        version: 3,
        document: { media: [media] },
        remoteVersion: 3,
      },
    });
  });

  test("replaces an in-cache upload placeholder when its version plus two descriptor arrives", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(1),
    });
    let finishRequest: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        finishRequest = resolve;
      })) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      uploadMediaMutationOptions(queryClient),
    );
    const pending = observer.mutate({
      draftId: "draft-1",
      expectedVersion: 1,
      kind: "image",
      altText: "Completed upload",
      file: new File(["x"], "x.png", { type: "image/png" }),
      mediaId: "media-complete",
    });
    while (!finishRequest) await Promise.resolve();
    const placeholder = {
      id: "media-complete",
      kind: "image" as const,
      order: 0,
      altText: "Completed upload",
      remoteId: null,
    };
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(2, {
        document: { ...document, media: [placeholder] },
      }),
    });
    const completed = {
      ...placeholder,
      remoteId: "typefully-media-22",
    };
    finishRequest?.(
      json({
        draft: { ...draftSummary(3), mediaCount: 1 },
        media: completed,
      }),
    );
    await pending;

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: { version: 3, document: { media: [completed] } },
    });
  });

  test("persists an uncertain completed upload descriptor returned at version plus two", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(1),
    });
    const media = {
      id: "media-uncertain",
      kind: "image" as const,
      order: 0,
      altText: "Uncertain upload",
      remoteId: "typefully-media-uncertain",
    };
    globalThis.fetch = (async () =>
      json(
        {
          code: "remote_error",
          draft: { ...draftSummary(3, "remote_error"), mediaCount: 1 },
          remote: {
            state: "remote_error",
            remoteDraftId: "remote-3",
            confirmedVersion: 2,
            confirmedHash: "remote-hash-2",
          },
          media,
        },
        502,
      )) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      uploadMediaMutationOptions(queryClient),
    );

    await expect(
      observer.mutate({
        draftId: "draft-1",
        expectedVersion: 1,
        kind: "image",
        altText: media.altText,
        file: new File(["x"], "x.png", { type: "image/png" }),
      }),
    ).rejects.toBeInstanceOf(TypefullyClientError);

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: {
        version: 3,
        document: { media: [media] },
        syncStatus: "remote_error",
        remoteVersion: 2,
      },
    });
  });

  test("persists an initiated upload placeholder returned at version plus one", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(1),
    });
    const placeholder = {
      id: "media-placeholder",
      kind: "image" as const,
      order: 0,
      altText: "Initiated upload",
      remoteId: null,
    };
    globalThis.fetch = (async () =>
      json(
        {
          code: "remote_error",
          draft: { ...draftSummary(2, "remote_error"), mediaCount: 1 },
          media: placeholder,
        },
        502,
      )) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      uploadMediaMutationOptions(queryClient),
    );

    await expect(
      observer.mutate({
        draftId: "draft-1",
        expectedVersion: 1,
        kind: "image",
        altText: placeholder.altText,
        file: new File(["x"], "x.png", { type: "image/png" }),
      }),
    ).rejects.toBeInstanceOf(TypefullyClientError);

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: { version: 2, document: { media: [placeholder] } },
    });
  });

  test("late completed upload cannot roll back a newer cache generation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(1),
    });
    let finishRequest: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        finishRequest = resolve;
      })) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      uploadMediaMutationOptions(queryClient),
    );
    const late = observer.mutate({
      draftId: "draft-1",
      expectedVersion: 1,
      kind: "image",
      altText: "Late upload",
      file: new File(["x"], "x.png", { type: "image/png" }),
    });
    while (!finishRequest) await Promise.resolve();
    const newerMedia = {
      id: "newer-media",
      kind: "image" as const,
      order: 0,
      altText: "Newer media",
      remoteId: "newer-remote",
    };
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(4, {
        document: { ...document, media: [newerMedia] },
      }),
    });
    finishRequest?.(
      json({
        draft: { ...draftSummary(3), mediaCount: 1 },
        media: {
          id: "late-media",
          kind: "image",
          order: 0,
          altText: "Late upload",
          remoteId: "late-remote",
        },
      }),
    );
    await late;

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: { version: 4, document: { media: [newerMedia] } },
    });
  });

  test("late draft success cannot replace a newer authoritative cache generation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(1),
    });
    let finishRequest: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        finishRequest = resolve;
      })) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      saveDraftMutationOptions(queryClient),
    );
    const late = observer.mutate({
      draftId: "draft-1",
      expectedVersion: 1,
      document: { ...document, title: "Late response" },
    });
    while (!finishRequest) await Promise.resolve();
    const newerDocument = { ...document, title: "Newer authoritative" };
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(3, { document: newerDocument }),
    });
    finishRequest?.(json({ draft: draftSummary(2) }));
    await late;

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: {
        version: 3,
        document: newerDocument,
        syncStatus: "synced",
        remoteVersion: 3,
      },
    });
    expect(
      queryClient.getQueryState(typefullyKeys.draft("draft-1"))?.isInvalidated,
    ).toBe(true);
  });

  test("late draft failure cannot replace a newer authoritative cache generation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(1),
    });
    let finishRequest: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        finishRequest = resolve;
      })) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      saveDraftMutationOptions(queryClient),
    );
    const late = observer.mutate({
      draftId: "draft-1",
      expectedVersion: 1,
      document: { ...document, title: "Failed response" },
    });
    while (!finishRequest) await Promise.resolve();
    const newerDocument = { ...document, title: "Newer authoritative" };
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(4, { document: newerDocument }),
    });
    finishRequest?.(
      json(
        {
          code: "remote_error",
          draft: draftSummary(2, "remote_error"),
          remote: {
            state: "remote_error",
            remoteDraftId: "stale-remote",
            confirmedVersion: 1,
            confirmedHash: "stale-hash",
          },
        },
        502,
      ),
    );
    await expect(late).rejects.toBeInstanceOf(TypefullyClientError);

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: {
        version: 4,
        document: newerDocument,
        syncStatus: "synced",
        remoteVersion: 4,
      },
    });
  });

  test("late equal-version failure cannot downgrade confirmed cache state or remote metadata", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(1),
    });
    let finishRequest: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        finishRequest = resolve;
      })) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      saveDraftMutationOptions(queryClient),
    );
    const late = observer.mutate({
      draftId: "draft-1",
      expectedVersion: 1,
      document: { ...document, title: "Failed response" },
    });
    while (!finishRequest) await Promise.resolve();
    const confirmedDocument = { ...document, title: "Confirmed elsewhere" };
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(2, { document: confirmedDocument }),
    });
    finishRequest?.(
      json(
        {
          code: "remote_error",
          draft: draftSummary(2, "remote_error"),
          remote: {
            state: "remote_error",
            remoteDraftId: "stale-remote",
            confirmedVersion: 1,
            confirmedHash: "stale-hash",
          },
        },
        502,
      ),
    );
    await expect(late).rejects.toBeInstanceOf(TypefullyClientError);

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: {
        version: 2,
        document: confirmedDocument,
        syncStatus: "synced",
        remoteDraftId: "remote-2",
        remoteVersion: 2,
        remoteHash: "remote-hash-2",
      },
    });
  });

  test("late same-version success cannot downgrade a newer confirmed cache", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(2, {
        syncStatus: "syncing",
        remoteVersion: 1,
      }),
    });
    let finishRequest: ((response: Response) => void) | undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        finishRequest = resolve;
      })) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      syncDraftMutationOptions(queryClient),
    );
    const late = observer.mutate({ draftId: "draft-1" });
    while (!finishRequest) await Promise.resolve();
    const confirmedDocument = { ...document, title: "Confirmed document" };
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(2, { document: confirmedDocument }),
    });
    finishRequest?.(
      json({
        draft: draftSummary(2, "remote_error"),
        remote: {
          state: "remote_error",
          remoteDraftId: "stale-remote",
          confirmedVersion: 1,
          confirmedHash: "stale-hash",
        },
      }),
    );
    await late;

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: {
        version: 2,
        document: confirmedDocument,
        syncStatus: "synced",
        remoteDraftId: "remote-2",
        remoteVersion: 2,
        remoteHash: "remote-hash-2",
      },
    });
  });

  test("same-version confirmed success can upgrade uncertain cached remote state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(2, {
        syncStatus: "remote_error",
        remoteDraftId: "remote-1",
        remoteVersion: 1,
        remoteHash: "remote-hash-1",
      }),
    });
    globalThis.fetch = (async () =>
      json({
        draft: draftSummary(2, "synced"),
        remote: {
          state: "synced",
          remoteDraftId: "remote-2",
          confirmedVersion: 2,
          confirmedHash: "remote-hash-2",
        },
      })) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      syncDraftMutationOptions(queryClient),
    );

    await observer.mutate({ draftId: "draft-1" });

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: {
        version: 2,
        syncStatus: "synced",
        remoteDraftId: "remote-2",
        remoteVersion: 2,
        remoteHash: "remote-hash-2",
      },
    });
  });

  test("same-version remote progress cannot downgrade an already synced status", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(2, {
        remoteDraftId: "remote-1",
        remoteVersion: 1,
        remoteHash: "remote-hash-1",
      }),
    });
    globalThis.fetch = (async () =>
      json({
        draft: draftSummary(2, "remote_error"),
        remote: {
          state: "remote_error",
          remoteDraftId: "remote-2",
          confirmedVersion: 2,
          confirmedHash: "remote-hash-2",
        },
      })) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      syncDraftMutationOptions(queryClient),
    );

    await observer.mutate({ draftId: "draft-1" });

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: {
        version: 2,
        syncStatus: "synced",
        remoteDraftId: "remote-2",
        remoteVersion: 2,
        remoteHash: "remote-hash-2",
      },
    });
  });

  test("does not replace the document when a result skips the expected generation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    queryClient.setQueryData(typefullyKeys.draft("draft-1"), {
      draft: authoritativeDraft(1),
    });
    globalThis.fetch = (async () =>
      json({ draft: draftSummary(4) })) as typeof fetch;
    const observer = new MutationObserver(
      queryClient,
      saveDraftMutationOptions(queryClient),
    );

    await observer.mutate({
      draftId: "draft-1",
      expectedVersion: 1,
      document: { ...document, title: "Uncorrelated result" },
    });

    expect(
      queryClient.getQueryData(typefullyKeys.draft("draft-1")),
    ).toMatchObject({
      draft: { version: 4, document },
    });
  });

  test("invalidates and refetches media errors without a draft summary", async () => {
    for (const operation of ["upload", "delete"] as const) {
      const draftId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";
      const queryClient = new QueryClient({
        defaultOptions: {
          mutations: { retry: false },
          queries: { retry: false },
        },
      });
      queryClient.setQueryData(typefullyKeys.draft(draftId), {
        draft: {
          id: draftId,
          document,
          version: 1,
          contentHash: "old",
          remoteDraftId: "22",
          remoteVersion: 1,
          remoteHash: "old",
          syncStatus: "synced",
          lastError: null,
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:00.000Z",
        },
      });
      globalThis.fetch = (async () =>
        json(
          operation === "upload"
            ? { code: "grant_required", ref: "typefully/upload_media" }
            : {
                code: "connection_required",
                serverId: "typefully",
                draftId: "draft-1",
                connectPath: "/settings/connected-accounts/typefully",
              },
          operation === "upload" ? 403 : 409,
        )) as typeof fetch;
      if (operation === "upload") {
        const observer = new MutationObserver(
          queryClient,
          uploadMediaMutationOptions(queryClient),
        );
        await expect(
          observer.mutate({
            draftId,
            expectedVersion: 1,
            kind: "image",
            altText: "Launch",
            file: new File(["x"], "x.png", { type: "image/png" }),
          }),
        ).rejects.toBeInstanceOf(TypefullyClientError);
      } else {
        const observer = new MutationObserver(
          queryClient,
          deleteMediaMutationOptions(queryClient),
        );
        await expect(
          observer.mutate({
            draftId,
            mediaId: "media-1",
            expectedVersion: 1,
          }),
        ).rejects.toBeInstanceOf(TypefullyClientError);
      }
      expect(
        queryClient.getQueryState(typefullyKeys.draft(draftId))?.isInvalidated,
      ).toBe(true);

      globalThis.fetch = (async () =>
        json({
          draft: {
            ...(
              queryClient.getQueryData(typefullyKeys.draft(draftId)) as {
                draft: Record<string, unknown>;
              }
            ).draft,
            id: draftId,
            version: 7,
            syncStatus: "connection_required",
          },
        })) as typeof fetch;
      await queryClient.fetchQuery(draftQueryOptions(draftId));
      expect(
        queryClient.getQueryData(typefullyKeys.draft(draftId)),
      ).toMatchObject({ draft: { version: 7 } });
    }
  });

  test("carries remote-error media identity into explicit retry and remove calls", async () => {
    const media = {
      id: "retry-media",
      kind: "image" as const,
      order: 0,
      altText: "Retry me",
      remoteId: null,
    };
    globalThis.fetch = (async () =>
      json(
        {
          code: "remote_error",
          retryAt: "2026-08-27T01:00:00.000Z",
          draft: { ...draftSummary(2, "remote_error"), mediaCount: 1 },
          remote: {
            state: "remote_error",
            remoteDraftId: "22",
            confirmedVersion: 1,
            confirmedHash: "old",
          },
          media,
        },
        502,
      )) as typeof fetch;
    let failure: TypefullyClientError | undefined;
    try {
      await mutate(uploadMediaMutationOptions(), {
        draftId: "draft-1",
        expectedVersion: 1,
        kind: "image",
        altText: "Retry me",
        file: new File(["x"], "x.png", { type: "image/png" }),
      });
    } catch (error) {
      failure = error as TypefullyClientError;
    }
    expect(failure).toMatchObject({
      code: "remote_error",
      retryAt: "2026-08-27T01:00:00.000Z",
      draft: { version: 2 },
      media,
    });

    const calls = capture({});
    await mutate(uploadMediaMutationOptions(), {
      draftId: "draft-1",
      expectedVersion: failure?.draft?.version ?? 0,
      kind: "image",
      altText: "Retry me",
      file: new File(["x"], "x.png", { type: "image/png" }),
      mediaId: failure?.media?.id,
    });
    await mutate(deleteMediaMutationOptions(), {
      draftId: "draft-1",
      expectedVersion: failure?.draft?.version ?? 0,
      mediaId: failure?.media?.id ?? "",
    });
    const retryForm = calls[0]?.init?.body;
    expect(retryForm).toBeInstanceOf(FormData);
    expect((retryForm as FormData).get("mediaId")).toBe("retry-media");
    expect(calls[1]?.url).toBe(
      "/api/typefully/drafts/draft-1/media/retry-media",
    );
  });

  test("preserves typed, bounded recovery details without trusting server messages", async () => {
    globalThis.fetch = (async () =>
      json(
        {
          code: "version_conflict",
          currentVersion: 9,
          currentHash: "abc",
          message: "untrusted detail",
        },
        409,
      )) as typeof fetch;

    try {
      await mutate(saveDraftMutationOptions(), {
        draftId: "draft-1",
        expectedVersion: 8,
        document,
      });
      throw new Error("Expected request failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(TypefullyClientError);
      expect(error).toMatchObject({
        code: "version_conflict",
        currentVersion: 9,
        currentHash: "abc",
      });
      expect((error as Error).message).toBe(
        "This draft changed elsewhere. Review the latest version before saving again.",
      );
    }
  });

  test("rejects inherited and prototype-shaped error codes", async () => {
    for (const code of ["constructor", "toString", "__proto__"]) {
      globalThis.fetch = (async () => json({ code }, 400)) as typeof fetch;
      await expect(
        mutate(syncDraftMutationOptions(), { draftId: "draft-1" }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        message: "That Typefully request could not be completed.",
      });
    }
  });
});
