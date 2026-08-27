import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { CanonicalDraftDocument } from "../src/lib/typefully/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const documentFixture: CanonicalDraftDocument = {
  title: "Launch",
  destinations: ["x"],
  socialSetId: "social-1",
  accountLabel: "Acme",
  posts: [{ id: "one", x: "Hello", linkedin: "" }],
  media: [
    {
      id: "a",
      kind: "image",
      order: 0,
      altText: "First",
      remoteId: "remote-a",
    },
    { id: "b", kind: "video", order: 1, altText: "Second", remoteId: null },
  ],
  scheduleAt: null,
};

test("validates MIME and 25 MB before selecting uploads", async () => {
  const { MediaEditor } = await import(
    "../src/components/typefully/media-editor"
  );
  const onSelect = mock(() => {});
  const view = render(
    <MediaEditor
      document={documentFixture}
      onReorder={() => {}}
      onRemove={() => {}}
      onRetry={() => {}}
      onSelect={onSelect}
      onTextChange={() => {}}
      states={{}}
    />,
  );
  const input = view.getByLabelText("Add media");

  fireEvent.change(input, {
    target: { files: [new File(["x"], "bad.txt", { type: "text/plain" })] },
  });
  expect(view.getByText(/supported image or video/i)).toBeTruthy();
  expect(onSelect).not.toHaveBeenCalled();

  const large = new File(["x"], "large.png", { type: "image/png" });
  Object.defineProperty(large, "size", { value: 25_000_001 });
  fireEvent.change(input, { target: { files: [large] } });
  expect(view.getByText(/25 MB/i)).toBeTruthy();
});

test("shows honest upload state and failed or uncertain Retry/Remove actions", async () => {
  const { MediaEditor } = await import(
    "../src/components/typefully/media-editor"
  );
  const retry = mock(() => {});
  const remove = mock(() => {});
  const view = render(
    <MediaEditor
      document={documentFixture}
      onReorder={() => {}}
      onRemove={remove}
      onRetry={retry}
      onSelect={() => {}}
      onTextChange={() => {}}
      states={{
        b: { kind: "failed", message: "Upload could not be confirmed" },
        a: { kind: "uploading" },
      }}
    />,
  );
  const user = userEvent.setup({ document });

  expect(view.getByText("Uploading…")).toBeTruthy();
  expect(view.queryByText(/%/)).toBeNull();
  expect(view.getByText("Upload could not be confirmed")).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Retry Second" }));
  await user.click(view.getByRole("button", { name: "Remove Second" }));
  expect(retry).toHaveBeenCalledWith("b");
  expect(remove).toHaveBeenCalledWith("b");
});

test("edits alt text and reorders canonical media", async () => {
  const { MediaEditor } = await import(
    "../src/components/typefully/media-editor"
  );
  const onTextChange = mock(() => {});
  const onReorder = mock(() => {});
  let latest = documentFixture;
  function Harness() {
    const [current, setCurrent] = useState(documentFixture);
    return (
      <MediaEditor
        document={current}
        onReorder={(next) => {
          onReorder(next);
          latest = next;
          setCurrent(next);
        }}
        onRemove={() => {}}
        onRetry={() => {}}
        onSelect={() => {}}
        onTextChange={(next) => {
          onTextChange(next);
          latest = next;
          setCurrent(next);
        }}
        states={{}}
      />
    );
  }
  const view = render(<Harness />);
  const user = userEvent.setup({ document });

  const alt = view.getByLabelText("Alt text for First");
  await user.clear(alt);
  await user.type(alt, "Updated alt");
  expect(latest.media[0]?.altText).toBe("Updated alt");
  expect(onTextChange).toHaveBeenCalled();
  expect(onReorder).not.toHaveBeenCalled();
  await user.click(view.getByRole("button", { name: "Move Second up" }));
  expect(onReorder).toHaveBeenCalledTimes(1);
  expect(latest.media.map((item) => [item.id, item.order])).toEqual([
    ["b", 0],
    ["a", 1],
  ]);
});
