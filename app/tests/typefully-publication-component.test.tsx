import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import {
  GALLERY,
  TypefullyProposalReview,
  TypefullyPublicationArgs,
  TypefullyPublicationDecision,
} from "../src/components/gallery/typefully-publication";
import type { PublicationProposal } from "../src/lib/typefully/queries";

const proposalId = "f36e8a5e-a3c0-4ea8-93e1-10be25ff37f1";
const draftId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";
const expiresAt = "2099-08-27T20:00:00.000Z";
const originalFetch = globalThis.fetch;

function proposal(status: PublicationProposal["status"]): PublicationProposal {
  return {
    id: proposalId,
    draftId,
    version: 7,
    destinations: ["x", "linkedin"],
    expiresAt,
    status,
    snapshot: {
      title: "Immutable launch",
      destinations: ["x", "linkedin"],
      socialSetId: "social-set-1",
      accountLabel: "Product team",
      posts: [
        {
          id: "post-1",
          x: "The exact X post",
          linkedin: "The exact LinkedIn post",
        },
      ],
      media: [],
      scheduleAt: null,
    },
    contentHash: "hash-7",
    decidedAt: status === "pending" ? null : "2026-08-27T19:00:00.000Z",
    completedAt: status === "published" ? "2026-08-27T19:01:00.000Z" : null,
    vendorResultId: status === "published" ? "vendor-result-1" : null,
    publishedUrl:
      status === "published" ? "https://typefully.com/t/published-1" : null,
    failureDetail: status === "failed" ? "Typefully refused this draft." : null,
  };
}

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  mock.restore();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

test("publication HITL arguments are bounded and the component starts unpublished explicit", () => {
  expect(
    TypefullyPublicationArgs.parse({
      proposalId,
      draftId,
      destinations: ["x", "linkedin"],
      version: 7,
      expiresAt,
    }),
  ).toEqual({
    proposalId,
    draftId,
    destinations: ["x", "linkedin"],
    version: 7,
    expiresAt,
  });
  expect(() =>
    TypefullyPublicationArgs.parse({
      proposalId,
      draftId,
      destinations: ["x"],
      version: 7,
      expiresAt,
      snapshot: { secret: "draft body" },
    }),
  ).toThrow();
  expect(() =>
    TypefullyPublicationArgs.parse({
      proposalId,
      draftId,
      destinations: ["x"],
      version: 7,
      expiresAt: `2099-08-27T20:00:00.${"0".repeat(80)}Z`,
    }),
  ).toThrow();
  expect(GALLERY[0]).toMatchObject({
    name: "approveTypefullyPublication",
    kind: "decision",
    defaultPublished: false,
    grantMode: "explicit",
  });
});

test("pending publication fetches immutable authority and publishes only through the proposal route", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = mock(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "GET") {
      return Response.json({ proposal: proposal("pending") });
    }
    return Response.json({ proposal: proposal("published") });
  }) as typeof fetch;
  const respond = mock(async () => {});
  const open = mock(() => {});
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        onOpenDraft={open}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });

  expect((await view.findByText("The exact X post")).textContent).toBeTruthy();
  expect(open).toHaveBeenCalledWith(draftId);
  await user.click(view.getByRole("button", { name: "Publish now" }));
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(respond.mock.calls[0]?.[0]).toMatchObject({
    outcome: "published",
    proposalId,
    draftId,
  });
  expect(calls).toEqual([
    { url: `/api/typefully/proposals/${proposalId}`, method: "GET" },
    { url: `/api/typefully/proposals/${proposalId}/publish`, method: "POST" },
    { url: `/api/typefully/proposals/${proposalId}`, method: "GET" },
  ]);
  expect(calls.some(({ url }) => url.includes("publish_now"))).toBe(false);
});

test("decline is distinct and terminal proposal states cannot repeat publication", async () => {
  for (const [status, text] of [
    ["declined", "Publication declined"],
    ["expired", "Review expired"],
    ["failed", "Typefully could not publish"],
    ["unknown", "Publishing status unknown"],
    ["published", "Published"],
  ] as const) {
    const view = render(
      <TypefullyProposalReview proposal={proposal(status)} />,
    );
    expect(view.getAllByText(text).length).toBeGreaterThan(0);
    expect(view.queryByRole("button", { name: "Publish now" })).toBeNull();
    if (status === "unknown") {
      expect(view.getByText(/do not try publishing again/i)).toBeTruthy();
    }
    if (status === "published") {
      expect(
        view
          .getByRole("link", { name: "View published post" })
          .getAttribute("href"),
      ).toBe("https://typefully.com/t/published-1");
    }
    view.unmount();
  }
});

test("decline calls only the decline route and answers once", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({
      proposal: proposal(init?.method === "POST" ? "declined" : "pending"),
    });
  }) as typeof fetch;
  const respond = mock(async () => {});
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Decline" }));
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(respond.mock.calls[0]?.[0]).toMatchObject({ outcome: "declined" });
  expect(calls.some((call) => call.includes("/decline"))).toBe(true);
  expect(calls.some((call) => call.includes("/publish"))).toBe(false);
});

test("closing a pending decision leaves it unanswered", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ proposal: proposal("pending") }),
  ) as typeof fetch;
  const respond = mock(async () => {});
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  await view.findByRole("button", { name: "Publish now" });
  view.unmount();
  await Promise.resolve();
  expect(respond).not.toHaveBeenCalled();
});

test("unmounting evicts the immutable proposal snapshot immediately", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ proposal: proposal("pending") }),
  ) as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        status="executing"
      />
    </QueryClientProvider>,
  );
  await view.findByRole("button", { name: "Publish now" });
  expect(
    client.getQueryData(["typefully", "proposal", proposalId]),
  ).toBeDefined();
  view.unmount();
  await waitFor(() =>
    expect(
      client.getQueryData(["typefully", "proposal", proposalId]),
    ).toBeUndefined(),
  );
});

test("mismatched publish authority cannot change cache or answer the HITL decision", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (init?.method === "POST") {
      return Response.json({
        proposal: {
          ...proposal("published"),
          draftId: "5bc7b8a2-3672-4c45-bcb1-5bce6ec39dd3",
        },
      });
    }
    return Response.json({ proposal: proposal("pending") });
  }) as typeof fetch;
  const respond = mock(async () => {});
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Publish now" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain("invalid response"),
  );
  expect(respond).not.toHaveBeenCalled();
  expect(calls).toEqual([
    `GET /api/typefully/proposals/${proposalId}`,
    `POST /api/typefully/proposals/${proposalId}/publish`,
  ]);
  expect(
    client.getQueryData<{ proposal: PublicationProposal }>([
      "typefully",
      "proposal",
      proposalId,
    ])?.proposal,
  ).toEqual(proposal("pending"));
});

test("direct failed publish answers once while unknown waits for reconciliation", async () => {
  for (const terminal of ["failed", "unknown"] as const) {
    let authoritativeStatus: PublicationProposal["status"] = "pending";
    globalThis.fetch = mock(async (_input, init) => {
      if (init?.method === "POST") {
        authoritativeStatus = terminal;
      }
      return Response.json({ proposal: proposal(authoritativeStatus) });
    }) as typeof fetch;
    const respond = mock(async () => {});
    const view = render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <TypefullyPublicationDecision
          args={{
            proposalId,
            draftId,
            destinations: ["x", "linkedin"],
            version: 7,
            expiresAt,
          }}
          respond={respond}
          status="executing"
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup({ document });
    await user.click(await view.findByRole("button", { name: "Publish now" }));
    if (terminal === "failed") {
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0]?.[0]).toMatchObject({ outcome: "failed" });
    } else {
      expect(
        (await view.findAllByText("Publishing status unknown")).length,
      ).toBeGreaterThan(0);
      expect(respond).not.toHaveBeenCalled();
    }
    expect(view.queryByRole("button", { name: "Publish now" })).toBeNull();
    view.unmount();
  }
});

test("authoritative non-disclosure and grant refusals answer once without exposing a retry", async () => {
  for (const refusal of [
    { status: 404, code: "draft_not_found", reason: "unavailable" },
    { status: 403, code: "grant_required", reason: "grant_required" },
    { status: 403, code: "remote_refused", reason: "remote_refused" },
  ] as const) {
    globalThis.fetch = mock(async () =>
      Response.json({ code: refusal.code }, { status: refusal.status }),
    ) as typeof fetch;
    const respond = mock(async () => {});
    const view = render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <TypefullyPublicationDecision
          args={{
            proposalId,
            draftId,
            destinations: ["x", "linkedin"],
            version: 7,
            expiresAt,
          }}
          respond={respond}
          status="executing"
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0]?.[0]).toEqual({
      outcome: "refused",
      proposalId,
      draftId,
      version: 7,
      reason: refusal.reason,
    });
    expect(view.getByRole("alert").textContent).toContain(
      "publication review is unavailable",
    );
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    view.unmount();
  }
});

test("a transient initial proposal load stays pending and can be retried", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("offline");
    return Response.json({ proposal: proposal("pending") });
  }) as typeof fetch;
  const respond = mock(async () => {});
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });

  expect(await view.findByRole("button", { name: "Retry" })).toBeTruthy();
  expect(respond).not.toHaveBeenCalled();
  await user.click(view.getByRole("button", { name: "Retry" }));
  expect(await view.findByRole("button", { name: "Publish now" })).toBeTruthy();
  expect(respond).not.toHaveBeenCalled();
});

test("StrictMode attempts a rejected terminal refusal response only once", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ code: "draft_not_found" }, { status: 404 }),
  ) as typeof fetch;
  const respond = mock(async () => {
    throw new Error("run gone");
  });
  const view = render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <TypefullyPublicationDecision
          args={{
            proposalId,
            draftId,
            destinations: ["x", "linkedin"],
            version: 7,
            expiresAt,
          }}
          respond={respond}
          status="executing"
        />
      </QueryClientProvider>
    </StrictMode>,
  );

  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(respond).toHaveBeenCalledTimes(1);
  expect(view.getByRole("alert").textContent).toContain(
    "decision could not be sent",
  );
});

test("unmounting before a terminal proposal refusal arrives leaves the decision pending", async () => {
  let release: (() => void) | undefined;
  globalThis.fetch = mock(
    async () =>
      new Promise<Response>((resolve) => {
        release = () =>
          resolve(Response.json({ code: "draft_not_found" }, { status: 404 }));
      }),
  ) as typeof fetch;
  const respond = mock(async () => {});
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(release).toBeDefined());
  view.unmount();
  release?.();
  await Promise.resolve();
  expect(respond).not.toHaveBeenCalled();
});

test("changed, expired, and failed authority answer terminally once", async () => {
  for (const status of ["expired", "failed"] as const) {
    globalThis.fetch = mock(async () =>
      Response.json({ proposal: proposal(status) }),
    ) as typeof fetch;
    const respond = mock(async () => {});
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <TypefullyPublicationDecision
          args={{
            proposalId,
            draftId,
            destinations: ["x", "linkedin"],
            version: 7,
            expiresAt,
          }}
          respond={respond}
          status="executing"
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0]?.[0]).toMatchObject({ outcome: status });
    view.unmount();
  }

  globalThis.fetch = mock(async () =>
    Response.json({ proposal: { ...proposal("pending"), version: 8 } }),
  ) as typeof fetch;
  const respond = mock(async () => {});
  const changed = render(
    <QueryClientProvider client={new QueryClient()}>
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(respond.mock.calls[0]?.[0]).toMatchObject({ outcome: "changed" });
  expect(changed.getByText(/prepare a new review/i)).toBeTruthy();
});

test("a vendor failure refetches durable failure and cannot repeat publish", async () => {
  let publishAttempted = false;
  const calls: string[] = [];
  globalThis.fetch = mock(async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${String(input)}`);
    if (method === "POST") {
      publishAttempted = true;
      return Response.json(
        { code: "remote_unavailable", message: "Typefully unavailable" },
        { status: 503 },
      );
    }
    return Response.json({
      proposal: proposal(publishAttempted ? "failed" : "pending"),
    });
  }) as typeof fetch;
  const respond = mock(async () => {});
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Publish now" }));
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(respond.mock.calls[0]?.[0]).toMatchObject({ outcome: "failed" });
  expect(view.queryByRole("button", { name: "Publish now" })).toBeNull();
  expect(calls.filter((call) => call.includes("/publish"))).toHaveLength(1);
});

test("a rejected HITL response is attempted once", async () => {
  globalThis.fetch = mock(async (_input, init) =>
    Response.json({
      proposal: proposal(init?.method === "POST" ? "published" : "pending"),
    }),
  ) as typeof fetch;
  const respond = mock(async () => {
    throw new Error("run gone");
  });
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Publish now" }));
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(respond).toHaveBeenCalledTimes(1);
  expect(view.getByRole("alert").textContent).toContain(
    "decision could not be sent",
  );
});

test("unknown publication offers reconciliation or an explicit manual handoff", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${String(input)}`);
    return Response.json({
      proposal: proposal(method === "POST" ? "published" : "unknown"),
    });
  }) as typeof fetch;
  const respond = mock(async () => {});
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  expect(
    (await view.findAllByText("Publishing status unknown")).length,
  ).toBeGreaterThan(0);
  expect(respond).not.toHaveBeenCalled();
  expect(view.queryByRole("button", { name: "Publish now" })).toBeNull();
  await user.click(
    view.getByRole("button", { name: "Check publication status" }),
  );
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(respond.mock.calls[0]?.[0]).toMatchObject({ outcome: "published" });
  expect(calls.some((call) => call.includes("/reconcile"))).toBe(true);
  expect(calls.some((call) => call.includes("/publish"))).toBe(false);
});

test("manual Typefully handoff answers unknown without retrying publication", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ proposal: proposal("unknown") }),
  ) as typeof fetch;
  const respond = mock(async () => {});
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TypefullyPublicationDecision
        args={{
          proposalId,
          draftId,
          destinations: ["x", "linkedin"],
          version: 7,
          expiresAt,
        }}
        respond={respond}
        status="executing"
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  const handoff = await view.findByRole("link", {
    name: "Continue in Typefully",
  });
  expect(handoff.getAttribute("href")).toBe("https://typefully.com/drafts");
  handoff.addEventListener("click", (event) => event.preventDefault());
  await user.click(handoff);
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(respond.mock.calls[0]?.[0]).toMatchObject({ outcome: "unknown" });
});
