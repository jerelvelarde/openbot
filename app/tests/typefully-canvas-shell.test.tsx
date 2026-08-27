import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AutosaveSnapshot } from "../src/lib/typefully/autosave";
import type { AuthoritativeDraft } from "../src/lib/typefully/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const draft: AuthoritativeDraft = {
  id: "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53",
  document: {
    title: "Launch notes",
    destinations: ["x", "linkedin"],
    socialSetId: "social-set-1",
    accountLabel: "Acme social",
    posts: [
      {
        id: "post-1",
        x: "A concise X launch post.",
        linkedin: "A more detailed LinkedIn launch post.",
      },
    ],
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
  createdAt: "2026-08-27T08:00:00.000Z",
  updatedAt: "2026-08-27T08:01:00.000Z",
};

test("canvas provides labelled read-only editing and preview regions", async () => {
  const { CanvasShell } = await import(
    "../src/components/typefully/canvas-shell"
  );
  const view = render(<CanvasShell draft={draft} />);

  expect(view.getByRole("region", { name: "Editing" })).toBeTruthy();
  expect(view.getByRole("region", { name: "Preview" })).toBeTruthy();
  expect(view.queryByRole("textbox")).toBeNull();
  expect(view.container.querySelector("[contenteditable='true']")).toBeNull();
  expect(view.getByRole("status").textContent).toContain("Saved to Typefully");
  expect(view.getByText(/approval is required/i)).toBeTruthy();
  expect(view.getByTestId("canvas-status").className).toContain("sticky");
});

test("platform and viewport tabs are keyboard reachable and switch content", async () => {
  const { CanvasShell } = await import(
    "../src/components/typefully/canvas-shell"
  );
  const view = render(<CanvasShell draft={draft} />);
  const user = userEvent.setup({ document });

  const x = view.getByRole("tab", { name: "X" });
  const linkedin = view.getByRole("tab", { name: "LinkedIn" });
  expect(x.tabIndex).toBe(0);
  expect(linkedin.tabIndex).toBe(-1);
  x.focus();
  await user.keyboard("{ArrowRight}");
  expect(linkedin.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(linkedin);
  expect(linkedin.tabIndex).toBe(0);
  expect(x.tabIndex).toBe(-1);
  const controlled = linkedin.getAttribute("aria-controls");
  expect(controlled).toBeTruthy();
  const platformPanel = controlled
    ? document.getElementById(controlled)
    : undefined;
  expect(platformPanel?.getAttribute("role")).toBe("tabpanel");
  expect(platformPanel?.getAttribute("aria-labelledby")).toBe(linkedin.id);
  expect(platformPanel?.textContent).toContain(
    "A more detailed LinkedIn launch post.",
  );

  await user.keyboard("{Home}");
  expect(document.activeElement).toBe(x);
  expect(x.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(linkedin);

  const mobile = view.getByRole("tab", { name: "Mobile" });
  const desktop = view.getByRole("tab", { name: "Desktop" });
  desktop.focus();
  await user.keyboard("{ArrowLeft}");
  expect(mobile.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(mobile);
  expect(mobile.getAttribute("aria-controls")).toBeTruthy();
  expect(
    document
      .getElementById(mobile.getAttribute("aria-controls") ?? "")
      ?.getAttribute("role"),
  ).toBe("tabpanel");
  expect(
    document.getElementById(desktop.getAttribute("aria-controls") ?? "")
      ?.hidden,
  ).toBe(true);
  expect(
    document.getElementById(mobile.getAttribute("aria-controls") ?? "")
      ?.textContent,
  ).toContain("A more detailed LinkedIn launch post.");
  expect(view.getByRole("region", { name: "Preview" }).className).toContain(
    "max-w-[360px]",
  );
});

test("canvas exposes local CopilotKit glass patterns and reduced-motion-safe transitions", async () => {
  const { CanvasShell } = await import(
    "../src/components/typefully/canvas-shell"
  );
  const view = render(<CanvasShell draft={draft} />);

  expect(view.getByTestId("typefully-canvas").className).toContain("font-sans");
  expect(view.getAllByTestId("canvas-card")[0]?.className).toContain(
    "bg-card/50",
  );
  expect(view.getAllByTestId("canvas-card")[0]?.className).toContain(
    "border-2",
  );
  expect(view.getByTestId("typefully-canvas").className).toContain(
    "motion-reduce:scroll-auto",
  );
  expect(view.container.innerHTML).not.toContain("text-[#");
  expect(view.container.innerHTML).not.toContain("bg-white");
  expect(view.container.innerHTML).not.toContain("border-white");

  document.documentElement.classList.add("dark");
  expect(view.getByTestId("typefully-canvas").className).toContain(
    "text-foreground",
  );
  expect(view.getAllByTestId("canvas-card")[0]?.className).toContain(
    "border-border",
  );
  document.documentElement.classList.remove("dark");
});

test("canvas explains an empty destination instead of inventing a preview", async () => {
  const { CanvasShell } = await import(
    "../src/components/typefully/canvas-shell"
  );
  const view = render(
    <CanvasShell
      draft={{
        ...draft,
        document: { ...draft.document, destinations: [], posts: [] },
      }}
    />,
  );

  expect(view.getAllByText(/select a destination/i).length).toBeGreaterThan(0);
  expect(view.queryByRole("tab", { name: "X" })).toBeNull();
  expect(view.queryByRole("tab", { name: "LinkedIn" })).toBeNull();
});

test("publish readiness follows authoritative sync state and never offers direct publish", async () => {
  const { CanvasShell } = await import(
    "../src/components/typefully/canvas-shell"
  );
  const readiness = {
    synced: "Ready for approval",
    local: "Sync to Typefully before requesting approval",
    syncing: "Wait for saving to finish",
    connection_required: "Connect Typefully before requesting approval",
    remote_error: "Resolve the Typefully sync error before requesting approval",
    grant_blocked: "Typefully access is required before requesting approval",
  } as const;

  for (const [syncStatus, expected] of Object.entries(readiness)) {
    const view = render(
      <CanvasShell
        draft={{ ...draft, syncStatus: syncStatus as typeof draft.syncStatus }}
      />,
    );
    expect(view.getByTestId("publish-readiness").textContent).toContain(
      expected,
    );
    expect(view.queryByRole("button", { name: /publish now/i })).toBeNull();
    cleanup();
  }

  const unconfirmed = render(
    <CanvasShell draft={{ ...draft, remoteHash: "older-hash" }} />,
  );
  expect(unconfirmed.getByTestId("publish-readiness").textContent).toContain(
    "Wait for Typefully confirmation",
  );
});

test("remote errors surface a bounded redacted authoritative detail", async () => {
  const { CanvasShell } = await import(
    "../src/components/typefully/canvas-shell"
  );
  const secret = `Bearer ${"s".repeat(80)}`;
  const view = render(
    <CanvasShell
      draft={{
        ...draft,
        syncStatus: "remote_error",
        lastError: `${secret} ${"problem ".repeat(80)}`,
      }}
    />,
  );
  const alert = view.getByRole("alert");
  expect(alert.textContent).toContain("[redacted]");
  expect(alert.textContent).not.toContain("s".repeat(80));
  expect(Array.from(alert.textContent ?? "").length).toBeLessThanOrEqual(240);
});

test("interactive canvas renders optimistic autosave and conflict recovery without enabling approval", async () => {
  const { CanvasShell } = await import(
    "../src/components/typefully/canvas-shell"
  );
  const originalPost = draft.document.posts[0];
  if (!originalPost) throw new Error("Expected the canonical post fixture.");
  const optimistic = {
    ...draft.document,
    posts: [{ ...originalPost, x: "Unsaved local text" }],
  };
  const snapshot: AutosaveSnapshot = {
    document: optimistic,
    state: { kind: "dirty", baseVersion: draft.version },
    target: { draftId: draft.id, version: draft.version },
    createdDraft: null,
    actions: [],
  };
  const callbacks = {
    onTextChange: () => {},
    onMediaChange: () => {},
    onSelectMedia: () => {},
    onRetryMedia: () => {},
    onRemoveMedia: () => {},
  };
  const view = render(
    <CanvasShell
      autosave={snapshot}
      document={optimistic}
      draft={draft}
      {...callbacks}
    />,
  );

  expect(
    (view.getByRole("textbox", { name: "X post 1" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Unsaved local text");
  expect(view.getByRole("status").textContent).toContain("Saving…");
  expect(view.getByTestId("publish-readiness").textContent).toContain(
    "Wait for saving",
  );

  view.rerender(
    <CanvasShell
      autosave={{
        ...snapshot,
        state: {
          kind: "conflict",
          local: optimistic,
          currentVersion: draft.version + 1,
        },
        actions: ["reload", "saveAsNewDraft"],
      }}
      document={optimistic}
      draft={draft}
      onReload={() => {}}
      onSaveAsNew={() => {}}
      {...callbacks}
    />,
  );
  expect(
    (view.getByRole("textbox", { name: "X post 1" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Unsaved local text");
  expect(
    (view.getByRole("button", { name: "Reload" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(
    (view.getByRole("button", { name: "Save as new" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(view.getByTestId("publish-readiness").textContent).toContain(
    "Resolve the save conflict",
  );
});
