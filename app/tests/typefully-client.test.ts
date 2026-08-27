import { afterEach, describe, expect, test } from "bun:test";
import {
  connectTypefullyMutationOptions,
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
    const calls = capture({ draft: { id: "draft-1" } });
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

    await draftQueryOptions("draft/one").queryFn?.({} as never);
    await proposalQueryOptions("proposal/one").queryFn?.({} as never);

    expect(calls.map(({ url, init }) => [url, init?.method ?? "GET"])).toEqual([
      ["/api/typefully/drafts/draft%2Fone", "GET"],
      ["/api/typefully/proposals/proposal%2Fone", "GET"],
    ]);
  });
});

describe("Typefully mutation contracts", () => {
  test("sends exact JSON routes and bodies", async () => {
    const calls = capture({});
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

    const options = connectTypefullyMutationOptions();
    const serializedOptions = JSON.stringify(options);
    expect(serializedOptions).not.toContain(apiKey);
    expect(JSON.stringify(typefullyKeys)).not.toContain(apiKey);

    let caught: unknown;
    try {
      await mutate(options, { apiKey });
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

    const result = await mutate(connectTypefullyMutationOptions(), { apiKey });
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
      await mutate(connectTypefullyMutationOptions(), { apiKey });
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
    expect(
      mutate(connectTypefullyMutationOptions(), { apiKey }),
    ).rejects.toThrow("could not be completed");
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
});
