import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  remoteHash: "remote-hash-7",
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

  const linkedin = view.getByRole("tab", { name: "LinkedIn" });
  linkedin.focus();
  await user.keyboard("{Enter}");
  expect(linkedin.getAttribute("aria-selected")).toBe("true");
  expect(
    view.getAllByText("A more detailed LinkedIn launch post."),
  ).toHaveLength(2);

  const mobile = view.getByRole("tab", { name: "Mobile" });
  mobile.focus();
  await user.keyboard(" ");
  expect(mobile.getAttribute("aria-selected")).toBe("true");
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
    "bg-white/50",
  );
  expect(view.getAllByTestId("canvas-card")[0]?.className).toContain(
    "border-2",
  );
  expect(view.getByTestId("typefully-canvas").className).toContain(
    "motion-reduce:scroll-auto",
  );
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
