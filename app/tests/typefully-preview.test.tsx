import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { render } from "@testing-library/react";
import type { CanonicalDraftDocument } from "../src/lib/typefully/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => document.body.replaceChildren());
afterAll(() => GlobalRegistrator.unregister());

const documentFixture: CanonicalDraftDocument = {
  title: "Launch",
  destinations: ["x", "linkedin"],
  socialSetId: "social-1",
  accountLabel: "Acme Social",
  posts: [
    {
      id: "one",
      x: "First X post",
      linkedin: "LinkedIn opener\n\nWith detail.",
    },
    { id: "two", x: "Second X post", linkedin: "LinkedIn follow-up" },
  ],
  media: [
    {
      id: "second",
      kind: "video",
      order: 2,
      altText: "Demo video",
      remoteId: "r2",
    },
    {
      id: "first",
      kind: "image",
      order: 1,
      altText: "Product screenshot",
      remoteId: "r1",
    },
  ],
  scheduleAt: null,
};

test("X preview renders a numbered thread, separators, counts, and ordered media alt text", async () => {
  const { PlatformPreview } = await import(
    "../src/components/typefully/platform-preview"
  );
  const view = render(
    <PlatformPreview
      document={documentFixture}
      platform="x"
      viewport="desktop"
    />,
  );

  expect(view.getByText("Acme Social")).toBeTruthy();
  expect(view.getByText("1 / 2")).toBeTruthy();
  expect(view.getByText("2 / 2")).toBeTruthy();
  expect(view.getAllByTestId("thread-separator")).toHaveLength(1);
  expect(view.getByText("12 / 100,000")).toBeTruthy();
  const media = view.getAllByTestId("preview-media");
  expect(media.map((node) => node.getAttribute("aria-label"))).toEqual([
    "Image: Product screenshot",
    "Video: Demo video",
  ]);
  expect(
    view.getByRole("region", { name: "X desktop preview" }).className,
  ).toContain("max-w");
});

test("LinkedIn preview preserves paragraph formatting and mobile layout", async () => {
  const { PlatformPreview } = await import(
    "../src/components/typefully/platform-preview"
  );
  const view = render(
    <PlatformPreview
      document={documentFixture}
      platform="linkedin"
      viewport="mobile"
    />,
  );

  expect(view.getByText(/LinkedIn opener/).className).toContain(
    "whitespace-pre-wrap",
  );
  expect(
    view.getByRole("region", { name: "LinkedIn mobile preview" }).className,
  ).toContain("max-w-[360px]");
});

test("unsupported destinations hand off to Typefully without fabricating a preview", async () => {
  const { PlatformPreview } = await import(
    "../src/components/typefully/platform-preview"
  );
  const view = render(
    <PlatformPreview
      document={documentFixture}
      platform={"threads" as "x"}
      viewport="desktop"
    />,
  );

  expect(view.getByText(/finish this destination in Typefully/i)).toBeTruthy();
  expect(view.queryByText("First X post")).toBeNull();
});
