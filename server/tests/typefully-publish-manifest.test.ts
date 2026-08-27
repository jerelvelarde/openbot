import { describe, expect, test } from "bun:test";
import { CATALOGUE } from "../src/plugins/catalogue";
import {
  createTypefullyPublicationVendor,
  createTypefullyRestTransport,
  listTools,
} from "../src/plugins/typefully-rest";

describe("Typefully publication manifest boundary", () => {
  test("offers reversible preparation but never a final publish operation", async () => {
    const tools = await listTools({ url: "https://api.typefully.com/v2" });
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("prepare_publication");
    expect(names).not.toContain("publish");
    expect(names).not.toContain("publish_now");
    expect(names.filter((name) => /publish|publication/i.test(name))).toEqual([
      "prepare_publication",
    ]);

    const typefully = CATALOGUE.find((entry) => entry.key === "typefully");
    expect(typefully?.writeTools).toContain("prepare_publication");
    expect(typefully?.writeTools).not.toContain("publish");
    expect(typefully?.writeTools).not.toContain("publish_now");
  });

  test("refuses local preparation and publish aliases before vendor network access", async () => {
    let fetches = 0;
    const transport = createTypefullyRestTransport(async () => {
      fetches += 1;
      return Response.json({});
    });
    const prepared = await transport.callTool(
      { url: "https://api.typefully.com/v2", token: "key" },
      "prepare_publication",
      { draftId: "00000000-0000-4000-8000-000000000001", expectedVersion: 1 },
    );
    const published = await transport.callTool(
      { url: "https://api.typefully.com/v2", token: "key" },
      "publish_now",
      {},
    );
    expect(prepared.isError).toBe(true);
    expect(published.isError).toBe(true);
    expect(fetches).toBe(0);
  });
});

describe("server-only Typefully publication transport", () => {
  test("uses the pinned v2 draft route and the reserved publish-at-now body", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const vendor = createTypefullyPublicationVendor(async (input, init) => {
      requests.push({ url: String(input), init });
      if (init?.method === "GET") {
        return Response.json({ status: "draft", platforms: {} });
      }
      return Response.json({
        id: 42,
        published_url: "https://typefully.com/t/42",
      });
    });

    expect(
      await vendor.fetchDraft({
        token: "secret-key",
        socialSetId: 7,
        remoteDraftId: 42,
      }),
    ).toEqual({ document: { status: "draft", platforms: {} } });
    expect(
      await vendor.publishDraft({
        token: "secret-key",
        socialSetId: 7,
        remoteDraftId: 42,
      }),
    ).toEqual({
      outcome: "published",
      vendorResultId: "42",
      publishedUrl: "https://typefully.com/t/42",
    });
    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      ["https://api.typefully.com/v2/social-sets/7/drafts/42", "GET"],
      ["https://api.typefully.com/v2/social-sets/7/drafts/42", "PATCH"],
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      publish_at: "now",
    });
  });

  test("distinguishes definite refusal from ambiguous timeout and only reconciles by GET", async () => {
    const refused = createTypefullyPublicationVendor(async () =>
      Response.json({ detail: "No" }, { status: 400 }),
    );
    expect(
      await refused.publishDraft({
        token: "key",
        socialSetId: 1,
        remoteDraftId: 2,
      }),
    ).toMatchObject({ outcome: "failed" });

    const timedOut = createTypefullyPublicationVendor(async () => {
      throw new DOMException("Timed out", "TimeoutError");
    });
    expect(
      await timedOut.publishDraft({
        token: "key",
        socialSetId: 1,
        remoteDraftId: 2,
      }),
    ).toMatchObject({ outcome: "unknown" });

    const methods: string[] = [];
    const reconciler = createTypefullyPublicationVendor(
      async (_input, init) => {
        methods.push(String(init?.method));
        return Response.json({
          id: 2,
          status: "published",
          published_url: "https://typefully.com/t/2",
        });
      },
    );
    expect(
      await reconciler.reconcileDraft({
        token: "key",
        socialSetId: 1,
        remoteDraftId: 2,
      }),
    ).toMatchObject({ outcome: "published", vendorResultId: "2" });
    expect(methods).toEqual(["GET"]);
  });
});
