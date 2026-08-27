import { describe, expect, test } from "bun:test";
import { CATALOGUE } from "../src/plugins/catalogue";
import {
  createTypefullyPublicationVendor,
  createTypefullyRestTransport,
  listTools,
} from "../src/plugins/typefully-rest";
import { remoteMatchesSnapshot } from "../src/typefully/publication";

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
        publish_state: "in_progress",
        status: "draft",
        published_url: null,
        share_url: "https://typefully.com/draft/review-only",
      });
    });

    expect(
      await vendor.fetchDraft({
        token: "secret-key",
        socialSetId: 7,
        remoteDraftId: 42,
        destinations: ["x", "linkedin"],
      }),
    ).toEqual({ document: { status: "draft", platforms: {} } });
    const outcome = await vendor.publishDraft({
      token: "secret-key",
      socialSetId: 7,
      remoteDraftId: 42,
      destinations: ["x", "linkedin"],
    });
    expect(outcome).toEqual({
      outcome: "unknown",
      vendorResultId: "42",
      detail:
        "Typefully is still publishing. Reconcile before taking any further action.",
    });
    expect(outcome).not.toHaveProperty("publishedUrl");
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
        destinations: ["x"],
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
        destinations: ["x"],
      }),
    ).toMatchObject({ outcome: "unknown" });

    const methods: string[] = [];
    let reconcileStatus: "published" | "error" = "published";
    const reconciler = createTypefullyPublicationVendor(
      async (_input, init) => {
        methods.push(String(init?.method));
        return Response.json({
          id: 2,
          publish_state: "finished",
          status: reconcileStatus,
          x_published_url:
            reconcileStatus === "published"
              ? "https://x.com/openbot/status/2"
              : "https://x.com/openbot/status/failed-not-proof",
          share_url: "https://typefully.com/draft/not-a-publication-url",
          error:
            reconcileStatus === "error" ? "Vendor publication failed" : null,
        });
      },
    );
    expect(
      await reconciler.reconcileDraft({
        token: "key",
        socialSetId: 1,
        remoteDraftId: 2,
        destinations: ["x"],
      }),
    ).toMatchObject({
      outcome: "published",
      vendorResultId: "2",
      publishedUrl: "https://x.com/openbot/status/2",
    });
    reconcileStatus = "error";
    const failed = await reconciler.reconcileDraft({
      token: "key",
      socialSetId: 1,
      remoteDraftId: 2,
      destinations: ["x"],
    });
    expect(failed).toMatchObject({
      outcome: "failed",
      detail: "Vendor publication failed",
    });
    expect(failed).not.toHaveProperty("publishedUrl");
    expect(methods).toEqual(["GET", "GET"]);
  });

  test("keeps in-progress reconciliation unknown and never issues a second publish PATCH", async () => {
    const methods: string[] = [];
    const vendor = createTypefullyPublicationVendor(async (_input, init) => {
      methods.push(String(init?.method));
      return Response.json({
        id: 2,
        publish_state: "in_progress",
        status: "draft",
        published_url: null,
        x_published_url: "https://x.com/openbot/status/in-progress-not-proof",
        share_url: "https://typefully.com/draft/review-only",
      });
    });
    expect(
      await vendor.reconcileDraft({
        token: "key",
        socialSetId: 1,
        remoteDraftId: 2,
        destinations: ["x"],
      }),
    ).toEqual({
      outcome: "unknown",
      vendorResultId: "2",
      detail:
        "Typefully is still publishing. Reconcile before taking any further action.",
    });
    expect(methods).toEqual(["GET"]);
  });

  test("uses only a selected destination's official published URL", async () => {
    const vendor = createTypefullyPublicationVendor(async () =>
      Response.json({
        id: 2,
        publish_state: "finished",
        status: "published",
        x_published_url: "https://x.com/openbot/status/2",
        linkedin_published_url:
          "https://www.linkedin.com/feed/update/urn:li:activity:2",
        share_url: "https://typefully.com/draft/review-only",
        url: "https://example.test/not-proof",
      }),
    );
    expect(
      await vendor.reconcileDraft({
        token: "key",
        socialSetId: 1,
        remoteDraftId: 2,
        destinations: ["linkedin"],
      }),
    ).toEqual({
      outcome: "published",
      vendorResultId: "2",
      publishedUrl: "https://www.linkedin.com/feed/update/urn:li:activity:2",
    });
    expect(
      await vendor.reconcileDraft({
        token: "key",
        socialSetId: 1,
        remoteDraftId: 2,
        destinations: ["linkedin", "x"],
      }),
    ).toMatchObject({ publishedUrl: "https://x.com/openbot/status/2" });
  });

  test("does not treat a draft share URL as published proof", async () => {
    const vendor = createTypefullyPublicationVendor(async () =>
      Response.json({
        id: 2,
        publish_state: "finished",
        status: "published",
        share_url: "https://typefully.com/draft/review-only",
      }),
    );
    expect(
      await vendor.reconcileDraft({
        token: "key",
        socialSetId: 1,
        remoteDraftId: 2,
        destinations: ["x"],
      }),
    ).toEqual({ outcome: "published", vendorResultId: "2" });
  });

  test("bounds and redacts the official terminal error detail", async () => {
    const token = "secret-publication-key";
    const vendor = createTypefullyPublicationVendor(async () =>
      Response.json({
        id: 2,
        publish_state: "finished",
        status: "error",
        error: `${token}-${"x".repeat(1_000)}`,
      }),
    );
    const outcome = await vendor.reconcileDraft({
      token,
      socialSetId: 1,
      remoteDraftId: 2,
      destinations: ["x"],
    });
    expect(outcome.outcome).toBe("failed");
    expect(outcome.detail).not.toContain(token);
    expect(Array.from(outcome.detail ?? "")).toHaveLength(400);
  });
});

describe("official Typefully scheduling comparison", () => {
  const scheduleAt = "2099-08-27T12:00:00Z";
  const snapshot = (scheduled: string | null) => ({
    title: "Launch",
    destinations: ["x", "linkedin"] as const,
    socialSetId: "7",
    accountLabel: "OpenBot",
    posts: [{ id: "post-1", x: "Exact X", linkedin: "Exact LinkedIn" }],
    media: [],
    scheduleAt: scheduled,
  });
  const remote = (status: string, scheduledDate: string | null) => ({
    status,
    scheduled_date: scheduledDate,
    draft_title: "Launch",
    platforms: {
      x: { enabled: true, posts: [{ text: "Exact X", media_ids: [] }] },
      linkedin: {
        enabled: true,
        posts: [{ text: "Exact LinkedIn", media_ids: [] }],
      },
    },
  });

  test("accepts only matching inert planned state and detects a date or live scheduling change", () => {
    expect(
      remoteMatchesSnapshot(
        remote("planned", scheduleAt),
        snapshot(scheduleAt),
        "unused",
      ),
    ).toBe(true);
    expect(
      remoteMatchesSnapshot(
        remote("scheduled", scheduleAt),
        snapshot(scheduleAt),
        "unused",
      ),
    ).toBe(false);
    expect(
      remoteMatchesSnapshot(
        remote("planned", "2099-08-28T12:00:00Z"),
        snapshot(scheduleAt),
        "unused",
      ),
    ).toBe(false);
    expect(
      remoteMatchesSnapshot(
        remote("draft", scheduleAt),
        snapshot(scheduleAt),
        "unused",
      ),
    ).toBe(false);
  });

  test("accepts the null draft control and rejects an unreviewed scheduled state", () => {
    expect(
      remoteMatchesSnapshot(remote("draft", null), snapshot(null), "unused"),
    ).toBe(true);
    expect(
      remoteMatchesSnapshot(remote("planned", null), snapshot(null), "unused"),
    ).toBe(false);
    expect(
      remoteMatchesSnapshot(
        remote("planned", scheduleAt),
        snapshot(null),
        "unused",
      ),
    ).toBe(false);
  });
});
