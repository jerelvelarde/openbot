import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { CanonicalDraftDocument } from "../src/lib/typefully/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const draft: CanonicalDraftDocument = {
  title: "Launch",
  destinations: ["x", "linkedin"],
  socialSetId: "social-1",
  accountLabel: "Acme",
  posts: [
    { id: "one", x: "X one", linkedin: "LinkedIn one" },
    { id: "two", x: "X two", linkedin: "LinkedIn two" },
  ],
  media: [],
  scheduleAt: null,
};

test("edits independent destination variants and reports strict character bounds", async () => {
  const { DraftEditor } = await import(
    "../src/components/typefully/draft-editor"
  );
  const onChange = mock(() => {});
  let latest = draft;
  function Harness() {
    const [current, setCurrent] = useState(draft);
    return (
      <DraftEditor
        document={current}
        onChange={(next) => {
          onChange(next);
          latest = next;
          setCurrent(next);
        }}
        platform="x"
      />
    );
  }
  const view = render(<Harness />);

  const user = userEvent.setup({ document });
  const editor = view.getByLabelText("X post 1");
  await user.clear(editor);
  await user.type(editor, "Edited X");
  expect(latest.posts[0]).toEqual({
    id: "one",
    x: "Edited X",
    linkedin: "LinkedIn one",
  });
  expect(view.getByText("5 / 100,000")).toBeTruthy();
  expect(view.getByLabelText("X post 1").getAttribute("maxlength")).toBe(
    "100000",
  );
});

test("character counters match the canonical UTF-16 string bound", async () => {
  const { DraftEditor } = await import(
    "../src/components/typefully/draft-editor"
  );
  const firstPost = draft.posts[0];
  const secondPost = draft.posts[1];
  if (!firstPost || !secondPost) throw new Error("Expected two post fixtures.");
  const unicode = {
    ...draft,
    posts: [{ ...firstPost, x: "😀" }, secondPost],
  };
  const view = render(
    <DraftEditor document={unicode} onChange={() => {}} platform="x" />,
  );

  expect(view.getByText("2 / 100,000")).toBeTruthy();
});

test("adds, reorders, and removes post blocks with keyboard-labelled controls", async () => {
  const { DraftEditor } = await import(
    "../src/components/typefully/draft-editor"
  );
  const onChange = mock(() => {});
  let latest = draft;
  function Harness() {
    const [current, setCurrent] = useState(draft);
    return (
      <DraftEditor
        document={current}
        onChange={(next) => {
          onChange(next);
          latest = next;
          setCurrent(next);
        }}
        platform="x"
      />
    );
  }
  const view = render(<Harness />);
  const user = userEvent.setup({ document });

  await user.click(view.getByRole("button", { name: "Add post" }));
  expect(latest.posts).toHaveLength(3);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("X post 3");

  await user.click(view.getByRole("button", { name: "Move post 2 up" }));
  expect(latest.posts.slice(0, 2).map((post) => post.id)).toEqual([
    "two",
    "one",
  ]);

  await user.click(view.getByRole("button", { name: "Remove post 1" }));
  expect(latest.posts).toHaveLength(2);
});

test("destination toggles keep at least one destination enabled", async () => {
  const { DraftEditor } = await import(
    "../src/components/typefully/draft-editor"
  );
  const onChange = mock(() => {});
  let latest = { ...draft, destinations: ["x"] as Array<"x" | "linkedin"> };
  const view = render(
    <DraftEditor
      document={latest}
      onChange={(next) => {
        latest = next;
        onChange(next);
      }}
      platform="x"
    />,
  );
  const user = userEvent.setup({ document });

  expect(
    view.getByLabelText("Publish to X").getAttribute("disabled"),
  ).not.toBeNull();
  await user.click(view.getByLabelText("Publish to LinkedIn"));
  expect(latest.destinations).toEqual(["x", "linkedin"]);
});
