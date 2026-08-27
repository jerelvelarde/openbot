import { useEffect, useState } from "react";

type PreviewState =
  | { kind: "loading" }
  | { kind: "processing" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; url: string; mime: string };

type PollScheduler = {
  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clear(handle: ReturnType<typeof setTimeout>): void;
};

const scheduler: PollScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle),
};

export const MEDIA_PREVIEW_POLL_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000,
] as const;

function boundedMessage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "This media preview is unavailable.";
  const candidate = (value as Record<string, unknown>).reason;
  return typeof candidate === "string"
    ? Array.from(candidate).slice(0, 240).join("")
    : "This media preview is unavailable.";
}

function previewPath(draftId: string, mediaId: string) {
  return `/api/typefully/drafts/${encodeURIComponent(draftId)}/media/${encodeURIComponent(mediaId)}/preview`;
}

export function RemoteMediaPreview({
  draftId,
  mediaId,
  kind,
  altText,
  pollScheduler = scheduler,
  pollDelaysMs = MEDIA_PREVIEW_POLL_DELAYS_MS,
}: {
  draftId: string;
  mediaId: string;
  kind: "image" | "video";
  altText: string;
  /** Deterministic scheduler seam for bounded polling tests. */
  pollScheduler?: PollScheduler;
  pollDelaysMs?: readonly number[];
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const path = previewPath(draftId, mediaId);
    setState({ kind: "loading" });

    const poll = async (pollIndex: number): Promise<void> => {
      try {
        const response = await fetch(
          `${path}?status=1&attempt=${attempt}&poll=${pollIndex}`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        if (response.status === 202) {
          setState({ kind: "processing" });
          const delay = pollDelaysMs[pollIndex];
          if (delay === undefined) {
            setState({
              kind: "failed",
              message:
                "Typefully is still processing this media. Retry the preview shortly.",
            });
            return;
          }
          timer = pollScheduler.set(() => void poll(pollIndex + 1), delay);
          return;
        }
        if (!response.ok) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          setState({ kind: "failed", message: boundedMessage(payload) });
          return;
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        const ready =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : null;
        const mime = ready?.mime;
        if (
          ready?.state !== "ready" ||
          typeof mime !== "string" ||
          (kind === "image" && !mime.startsWith("image/")) ||
          (kind === "video" && !mime.startsWith("video/"))
        ) {
          setState({
            kind: "failed",
            message: "This media preview has an unexpected format.",
          });
          return;
        }
        setState({
          kind: "ready",
          url: `${path}?asset=${attempt}`,
          mime,
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        setState({
          kind: "failed",
          message:
            error instanceof Error && error.name === "AbortError"
              ? "This media preview was cancelled."
              : "This media preview could not load.",
        });
      }
    };

    void poll(0);
    return () => {
      abort.abort();
      if (timer !== undefined) pollScheduler.clear(timer);
    };
  }, [attempt, draftId, kind, mediaId, pollDelaysMs, pollScheduler]);

  const label = `${kind === "image" ? "Image" : "Video"}: ${altText || "No alt text"}`;
  if (state.kind === "ready") {
    return kind === "image" ? (
      <img
        alt={altText}
        aria-label={label}
        className="aspect-video w-full rounded-[4px] bg-muted/65 object-cover"
        data-testid="preview-media"
        referrerPolicy="no-referrer"
        src={state.url}
      />
    ) : (
      <video
        aria-label={label}
        className="aspect-video w-full rounded-[4px] bg-muted/65 object-cover"
        controls
        data-testid="preview-media"
        muted
        playsInline
        src={state.url}
      />
    );
  }
  return (
    <div
      className="flex aspect-video flex-col items-center justify-center gap-2 rounded-[4px] bg-muted/65 px-3 text-center text-xs text-muted-foreground"
      data-testid="preview-media"
      role={state.kind === "failed" ? "alert" : "status"}
    >
      <span className="sr-only">{label}</span>
      {state.kind === "loading"
        ? "Loading media preview…"
        : state.kind === "processing"
          ? "Typefully is processing this media…"
          : state.message}
      {state.kind === "failed" ? (
        <button
          className="rounded-[4px] border border-border bg-card px-2 py-1 text-foreground"
          onClick={() => setAttempt((value) => value + 1)}
          type="button"
        >
          Retry preview
        </button>
      ) : null}
    </div>
  );
}
