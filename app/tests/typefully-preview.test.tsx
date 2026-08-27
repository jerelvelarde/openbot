import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { platformTextMetrics } from "../src/lib/typefully/preview";
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
  expect(view.getByText("12 / 280")).toBeTruthy();
  const media = view.getAllByTestId("preview-media");
  expect(media.map((node) => node.getAttribute("aria-label"))).toEqual([
    "Image: Product screenshot",
    "Video: Demo video",
  ]);
  expect(
    view.getByRole("region", { name: "X desktop preview" }).className,
  ).toContain("max-w");
});

test("platform counters follow X weighted text and LinkedIn code-point limits", () => {
  expect(
    platformTextMetrics("x", "https://example.com/a/very/long/path"),
  ).toEqual({
    count: 23,
    limit: 280,
    valid: true,
  });
  expect(platformTextMetrics("x", "😀").count).toBe(2);
  expect(platformTextMetrics("x", "界".repeat(140))).toMatchObject({
    count: 280,
    valid: true,
  });
  expect(platformTextMetrics("x", "界".repeat(141))).toMatchObject({
    count: 282,
    valid: false,
  });
  expect(platformTextMetrics("x", "👨‍👩‍👧‍👦").count).toBe(2);
  expect(platformTextMetrics("x", "e\u0301").count).toBe(1);
  expect(platformTextMetrics("linkedin", "😀".repeat(3_000))).toEqual({
    count: 3_000,
    limit: 3_000,
    valid: true,
  });
  expect(platformTextMetrics("linkedin", "😀".repeat(3_001))).toMatchObject({
    count: 3_001,
    valid: false,
  });
});

test("local videos and remote media use safe native-aspect semantic previews", async () => {
  const { PlatformPreview } = await import(
    "../src/components/typefully/platform-preview"
  );
  const view = render(
    <PlatformPreview
      document={documentFixture}
      localMediaUrls={{ second: "blob:local-video" }}
      platform="x"
      viewport="desktop"
    />,
  );

  const video = view.getByLabelText("Video: Demo video") as HTMLVideoElement;
  expect(video.tagName).toBe("VIDEO");
  expect(video.controls).toBe(true);
  expect(video.muted).toBe(true);
  expect(video.getAttribute("src")).toBe("blob:local-video");
  const remoteImage = view.getByLabelText("Image: Product screenshot");
  expect(remoteImage.getAttribute("role")).toBe("img");
  expect(remoteImage.className).toContain("aspect-video");
  expect(remoteImage.textContent).not.toContain("Image:");
});

test("reloaded remote media polls same-origin status and renders native redirect URLs", async () => {
  const { PlatformPreview } = await import(
    "../src/components/typefully/platform-preview"
  );
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    const video = url.includes("/second/");
    return new Response(
      JSON.stringify({
        state: "ready",
        mime: video ? "video/mp4" : "image/png",
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    const view = render(
      <PlatformPreview
        document={{
          ...documentFixture,
          media: documentFixture.media.filter((item) => item.kind === "video"),
        }}
        draftId="draft-private"
        platform="x"
        viewport="desktop"
      />,
    );
    await waitFor(() =>
      expect(view.getByLabelText("Video: Demo video").tagName).toBe("VIDEO"),
    );
    expect(calls).toEqual([
      "/api/typefully/drafts/draft-private/media/second/preview?status=1&attempt=0&poll=0",
    ]);
    expect(view.getByLabelText("Video: Demo video").getAttribute("src")).toBe(
      "/api/typefully/drafts/draft-private/media/second/preview?asset=0",
    );
    expect(view.container.innerHTML).not.toContain("cdn.typefully");
    expect(view.container.innerHTML).not.toContain("api_key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote media exposes processing and bounded failure states", async () => {
  const { PlatformPreview } = await import(
    "../src/components/typefully/platform-preview"
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const failed = String(input).includes("/second/");
    return new Response(
      JSON.stringify(
        failed
          ? { state: "failed", reason: "Transcode failed" }
          : { state: "processing" },
      ),
      {
        status: failed ? 422 : 202,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  try {
    const view = render(
      <PlatformPreview
        document={documentFixture}
        draftId="draft-private"
        platform="x"
        viewport="desktop"
      />,
    );
    expect(
      await view.findByText("Typefully is processing this media…"),
    ).toBeTruthy();
    expect(await view.findByText("Transcode failed")).toBeTruthy();
    expect(view.getByRole("button", { name: "Retry preview" })).toBeTruthy();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("processing previews poll with bounded exponential delays and eventually become ready", async () => {
  const { RemoteMediaPreview } = await import(
    "../src/components/typefully/remote-media-preview"
  );
  const originalFetch = globalThis.fetch;
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const pollDelays = [10, 20] as const;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls < 3
      ? new Response(JSON.stringify({ state: "processing" }), { status: 202 })
      : new Response(JSON.stringify({ state: "ready", mime: "video/mp4" }));
  }) as typeof fetch;
  try {
    const view = render(
      <RemoteMediaPreview
        altText="Launch"
        draftId="draft-private"
        kind="video"
        mediaId="media-1"
        pollDelaysMs={pollDelays}
        pollScheduler={{
          clear: () => {},
          set: (callback, delay) => {
            callbacks.push(callback);
            delays.push(delay);
            return callbacks.length as ReturnType<typeof setTimeout>;
          },
        }}
      />,
    );
    expect(
      await view.findByText("Typefully is processing this media…"),
    ).toBeTruthy();
    expect(delays).toEqual([10]);
    await act(async () => callbacks.shift()?.());
    await waitFor(() => expect(delays).toEqual([10, 20]));
    await act(async () => callbacks.shift()?.());
    await waitFor(() =>
      expect(view.getByLabelText("Video: Launch").tagName).toBe("VIDEO"),
    );
    expect(calls).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native image and video load failures become accessible retry states", async () => {
  const { RemoteMediaPreview } = await import(
    "../src/components/typefully/remote-media-preview"
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) =>
    new Response(
      JSON.stringify({
        state: "ready",
        mime: String(input).includes("video") ? "video/mp4" : "image/png",
      }),
    )) as typeof fetch;
  try {
    const video = render(
      <RemoteMediaPreview
        altText="Demo"
        draftId="draft-private"
        kind="video"
        mediaId="video"
      />,
    );
    const element = await video.findByLabelText("Video: Demo");
    fireEvent.error(element);
    expect(
      await video.findByText("This media preview could not load."),
    ).toBeTruthy();
    expect(video.getByRole("button", { name: "Retry preview" })).toBeTruthy();
    video.unmount();

    const image = render(
      <RemoteMediaPreview
        altText="Screenshot"
        draftId="draft-private"
        kind="image"
        mediaId="image"
      />,
    );
    expect(
      await image.findByText("This media preview could not load."),
    ).toBeTruthy();
    expect(image.getByRole("button", { name: "Retry preview" })).toBeTruthy();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("processing poll exhaustion exposes retry and unmount aborts an active request", async () => {
  const { RemoteMediaPreview } = await import(
    "../src/components/typefully/remote-media-preview"
  );
  const originalFetch = globalThis.fetch;
  const callbacks: Array<() => void> = [];
  const pollDelays = [10] as const;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ state: "processing" }), {
      status: 202,
    })) as typeof fetch;
  try {
    const exhausted = render(
      <RemoteMediaPreview
        altText="Launch"
        draftId="draft-private"
        kind="image"
        mediaId="media-1"
        pollDelaysMs={pollDelays}
        pollScheduler={{
          clear: () => {},
          set: (callback) => {
            callbacks.push(callback);
            return callbacks.length as ReturnType<typeof setTimeout>;
          },
        }}
      />,
    );
    await exhausted.findByText("Typefully is processing this media…");
    await act(async () => callbacks.shift()?.());
    expect(
      await exhausted.findByRole("button", { name: "Retry preview" }),
    ).toBeTruthy();
    exhausted.unmount();

    let aborted = false;
    globalThis.fetch = ((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      })) as typeof fetch;
    const pending = render(
      <RemoteMediaPreview
        altText="Launch"
        draftId="draft-private"
        kind="image"
        mediaId="media-2"
      />,
    );
    pending.unmount();
    expect(aborted).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
