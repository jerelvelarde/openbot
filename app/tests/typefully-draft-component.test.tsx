import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { buildGalleryComponents } from "@/lib/copilot/gallery-registry";
import {
  channelPaneSearch,
  chatSearchSchema,
  computerActivitySearch,
  validateChannelSearch,
} from "@/routes/_authed/_app/channel/$channelId";

const { GALLERY, TYPEFULLY_DRAFT_STATUSES } = await import(
  "@/components/gallery/typefully-draft"
);

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

const draftId = "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53";
const definition = GALLERY.find(
  (component) => component.name === "showTypefullyDraft",
);

function validArgs(status: string, overrides: Record<string, unknown> = {}) {
  return {
    draftId,
    title: "Launch notes",
    destinations: ["x", "linkedin"],
    socialSetLabel: "Acme social",
    mediaCount: 2,
    version: 7,
    status,
    ...overrides,
  };
}

async function renderDefinition(
  status: string,
  overrides: Record<string, unknown> = {},
) {
  if (!definition) throw new Error("showTypefullyDraft was not registered");
  const Component = definition.Component as ComponentType<
    Record<string, unknown>
  >;
  const root = createRootRoute({ component: Outlet });
  const channel = createRoute({
    getParentRoute: () => root,
    path: "/channel/$channelId",
    component: () => <Component {...validArgs(status, overrides)} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([channel]),
    history: createMemoryHistory({
      initialEntries: ["/channel/channel-1"],
    }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

test("registers the strict bounded summary contract and rejects forbidden data", () => {
  expect(definition?.kind).toBe("card");
  expect(definition?.parameters.safeParse(validArgs("local")).success).toBe(
    true,
  );

  for (const forbidden of [
    "posts",
    "postBody",
    "mediaUrls",
    "snapshot",
    "credentialId",
    "userId",
  ]) {
    expect(
      definition?.parameters.safeParse({
        ...validArgs("local"),
        [forbidden]:
          forbidden === "mediaUrls" ? ["https://secret.test/a"] : "secret",
      }).success,
    ).toBe(false);
  }

  expect(
    definition?.parameters.safeParse({
      ...validArgs("local"),
      title: "x".repeat(161),
    }).success,
  ).toBe(false);
  expect(
    definition?.parameters.safeParse({
      ...validArgs("local"),
      title: "🪶".repeat(160),
    }).success,
  ).toBe(true);
  expect(
    definition?.parameters.safeParse({
      ...validArgs("local"),
      title: "🪶".repeat(161),
    }).success,
  ).toBe(false);
  expect(
    definition?.parameters.safeParse({
      ...validArgs("local"),
      socialSetLabel: "x".repeat(161),
    }).success,
  ).toBe(false);
  expect(
    definition?.parameters.safeParse({
      ...validArgs("local"),
      destinations: ["x", "x"],
    }).success,
  ).toBe(false);
  expect(
    definition?.parameters.safeParse({
      ...validArgs("local"),
      mediaCount: 21,
    }).success,
  ).toBe(false);
});

test("the production channel search schema canonicalizes every pane conflict", () => {
  for (const [input, expected] of [
    [{}, { draft: undefined, settings: undefined, watch: undefined }],
    [
      { settings: true },
      { draft: undefined, settings: true, watch: undefined },
    ],
    [{ watch: true }, { draft: undefined, settings: undefined, watch: true }],
    [
      { draft: draftId },
      { draft: draftId, settings: undefined, watch: undefined },
    ],
    [
      { settings: true, watch: true },
      { draft: undefined, settings: undefined, watch: true },
    ],
    [
      { settings: true, draft: draftId },
      { draft: draftId, settings: undefined, watch: undefined },
    ],
    [
      { watch: true, draft: draftId },
      { draft: draftId, settings: undefined, watch: undefined },
    ],
    [
      { settings: true, watch: true, draft: draftId },
      { draft: draftId, settings: undefined, watch: undefined },
    ],
    [
      { settings: false, watch: false },
      { draft: undefined, settings: undefined, watch: undefined },
    ],
  ] as const) {
    expect(chatSearchSchema.parse(input)).toEqual(expected);
  }
  expect(chatSearchSchema.safeParse({ draft: "not-a-uuid" }).success).toBe(
    false,
  );
});

test("reconstructed channel URLs serialize only the canonical pane", async () => {
  for (const [query, expected] of [
    ["", { draft: undefined, settings: undefined, watch: undefined }],
    ["?settings=true", { draft: undefined, settings: true, watch: undefined }],
    ["?watch=true", { draft: undefined, settings: undefined, watch: true }],
    [
      `?draft=${draftId}`,
      { draft: draftId, settings: undefined, watch: undefined },
    ],
    [
      "?settings=true&watch=true",
      { draft: undefined, settings: undefined, watch: true },
    ],
    [
      `?settings=true&draft=${draftId}`,
      { draft: draftId, settings: undefined, watch: undefined },
    ],
    [
      `?watch=true&draft=${draftId}`,
      { draft: draftId, settings: undefined, watch: undefined },
    ],
    [
      `?settings=true&watch=true&draft=${draftId}`,
      { draft: draftId, settings: undefined, watch: undefined },
    ],
  ] as const) {
    const root = createRootRoute({ component: Outlet });
    const channel = createRoute({
      getParentRoute: () => root,
      path: "/channel/$channelId",
      validateSearch: validateChannelSearch,
      component: () => null,
    });
    const router = createRouter({
      routeTree: root.addChildren([channel]),
      history: createMemoryHistory({
        initialEntries: [`/channel/channel-1${query}`],
      }),
    });
    await router.load();
    const validated = router.state.matches.at(-1)?.search;
    expect(validated).toEqual(expected);
    await router.navigate({
      replace: true,
      search: validated,
    });
    const serialized = new URL(
      router.state.location.href,
      "https://openbot.test",
    );
    expect(
      ["draft", "settings", "watch"].filter((key) =>
        serialized.searchParams.has(key),
      ),
    ).toHaveLength(
      Object.values(expected).filter((value) => value !== undefined).length,
    );
    expect(router.state.location.pathname).toBe("/channel/channel-1");
  }
});

test("normalizes canonical social-set labels without refusing the card", async () => {
  for (const [label, expected] of [
    [null, null],
    [undefined, undefined],
    ["  Product team  ", "Product team"],
    ["   ", undefined],
  ] as const) {
    const args = validArgs("local");
    if (label === undefined) delete args.socialSetLabel;
    else args.socialSetLabel = label;
    const parsed = definition?.parameters.safeParse(args);
    expect(parsed?.success).toBe(true);
    if (parsed?.success) expect(parsed.data.socialSetLabel).toBe(expected);
  }

  const canonicalNull = await renderDefinition("local", {
    socialSetLabel: null,
  });
  expect(canonicalNull.getByText("Not selected")).toBeTruthy();
  expect(canonicalNull.queryByText(/summary is unavailable/i)).toBeNull();
});

test("the shared pane transitions exclude draft, settings, and watch", () => {
  const draft = { draft: draftId };
  expect(channelPaneSearch(draft, "settings")).toEqual({
    draft: undefined,
    settings: true,
    watch: undefined,
  });
  expect(channelPaneSearch(draft, "watch")).toEqual({
    draft: undefined,
    settings: undefined,
    watch: true,
  });
  expect(channelPaneSearch({ settings: true }, { draft: draftId })).toEqual({
    draft: draftId,
    settings: undefined,
    watch: undefined,
  });

  const protectedDraft = { draft: draftId };
  expect(computerActivitySearch(protectedDraft)).toBe(protectedDraft);
  expect(computerActivitySearch({})).toEqual({
    draft: undefined,
    settings: undefined,
    watch: true,
  });
});

test("the production Vite registry discovers Typefully exactly once and rejects duplicates", async () => {
  const { createServer } = await import("vite");
  const vite = await createServer({
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
    root: new URL("../", import.meta.url).pathname,
    server: { middlewareMode: true },
  });
  try {
    const production = (await vite.ssrLoadModule(
      "/src/lib/copilot/gallery-registry.ts",
    )) as { GALLERY_COMPONENTS: Array<{ name: string }> };
    expect(
      production.GALLERY_COMPONENTS.filter(
        (component) => component.name === "showTypefullyDraft",
      ),
    ).toHaveLength(1);
  } finally {
    await vite.close();
  }

  if (!definition) throw new Error("showTypefullyDraft was not registered");
  expect(() =>
    buildGalleryComponents({
      first: { GALLERY: [definition] },
      second: { GALLERY: [definition] },
    }),
  ).toThrow(/duplicate gallery component name.*showTypefullyDraft/i);
});

test("renders every current server status through the registered component", async () => {
  const statuses = {
    local: "Saved in OpenBot",
    syncing: "Saving…",
    synced: "Saved to Typefully",
    connection_required: "Connect Typefully",
    remote_error: "Not saved to Typefully",
    grant_blocked: "Typefully access unavailable",
    pending: "Waiting for approval",
    in_flight: "Publishing…",
    declined: "Declined",
    expired: "Changed — review again",
    published: "Published",
    failed: "Publishing failed",
    unknown: "Publishing status unknown",
    draft_not_found: "Draft unavailable",
  } as const;
  expect(TYPEFULLY_DRAFT_STATUSES).toEqual(Object.keys(statuses));

  for (const status of TYPEFULLY_DRAFT_STATUSES) {
    const view = await renderDefinition(status);
    expect(view.getByRole("figure")).toBeTruthy();
    expect(view.getByText("Launch notes")).toBeTruthy();
    expect(view.getByText("X")).toBeTruthy();
    expect(view.getByText("LinkedIn")).toBeTruthy();
    expect(view.getByText("Acme social")).toBeTruthy();
    expect(view.getByText("2 media")).toBeTruthy();
    expect(view.getByText("Version 7")).toBeTruthy();
    expect(view.getByText(statuses[status])).toBeTruthy();
    cleanup();
  }
});

test("keeps unpublished bodies and media URLs out of the renderer", async () => {
  const view = await renderDefinition("synced");
  expect(view.container.textContent).toContain("Launch notes");
  expect(view.container.textContent).not.toContain("post body secret");
  expect(view.container.textContent).not.toContain("https://secret.test/media");
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.querySelector("video")).toBeNull();
});

test("review is keyboard accessible and preserves safe search state for the same route", async () => {
  if (!definition) throw new Error("showTypefullyDraft was not registered");
  const Component = definition.Component as ComponentType<
    Record<string, unknown>
  >;
  const root = createRootRoute({ component: Outlet });
  const channel = createRoute({
    getParentRoute: () => root,
    path: "/channel/$channelId",
    validateSearch: validateChannelSearch,
    component: () => <Component {...validArgs("synced")} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([channel]),
    history: createMemoryHistory({
      initialEntries: ["/channel/channel-1?settings=true"],
    }),
  });
  await router.load();
  const view = render(<RouterProvider router={router} />);
  const user = userEvent.setup({ document });
  const review = view.getByRole("button", { name: "Review draft" });
  review.focus();
  expect(document.activeElement).toBe(review);
  await user.keyboard("{Enter}");

  await waitFor(() => expect(router.state.location.search.draft).toBe(draftId));
  expect(router.state.location.pathname).toBe("/channel/channel-1");
  expect(router.state.location.search).toEqual({
    draft: draftId,
  });
  expect(router.state.location.href).not.toContain("Launch notes");
  expect(router.state.location.href).not.toContain("Acme social");

  const reloadedRoot = createRootRoute({ component: Outlet });
  const reloadedChannel = createRoute({
    getParentRoute: () => reloadedRoot,
    path: "/channel/$channelId",
    validateSearch: validateChannelSearch,
    component: () => null,
  });
  const reloaded = createRouter({
    routeTree: reloadedRoot.addChildren([reloadedChannel]),
    history: createMemoryHistory({
      initialEntries: [router.state.location.href],
    }),
  });
  await reloaded.load();
  expect(reloaded.state.location.pathname).toBe("/channel/channel-1");
  expect(reloaded.state.location.search).toEqual({ draft: draftId });

  await router.history.back();
  await waitFor(() =>
    expect(router.state.location.search).toEqual({
      settings: true,
    }),
  );
  expect(router.state.location.pathname).toBe("/channel/channel-1");
});

test("shows safe actionable grant and unavailable refusals", async () => {
  const revoked = await renderDefinition("grant_blocked");
  expect(revoked.getByRole("status").textContent).toContain("access");
  expect(revoked.getByRole("button", { name: "Review draft" })).toBeTruthy();
  cleanup();

  const unavailable = await renderDefinition("draft_not_found");
  expect(unavailable.getByRole("status").textContent).toContain(
    "no longer available",
  );
  expect(
    unavailable.queryByRole("button", { name: "Review draft" }),
  ).toBeNull();
});
