import { useEffect, useState } from "react";

type PreviewState =
  | { kind: "loading" }
  | { kind: "processing" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; url: string; mime: string };

function boundedMessage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "This media preview is unavailable.";
  const record = value as Record<string, unknown>;
  const candidate = record.reason;
  return typeof candidate === "string"
    ? Array.from(candidate).slice(0, 240).join("")
    : "This media preview is unavailable.";
}

export function RemoteMediaPreview({
  draftId,
  mediaId,
  kind,
  altText,
}: {
  draftId: string;
  mediaId: string;
  kind: "image" | "video";
  altText: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | null = null;
    setState({ kind: "loading" });
    void fetch(
      `/api/typefully/drafts/${encodeURIComponent(draftId)}/media/${encodeURIComponent(mediaId)}/preview?attempt=${attempt}`,
      { signal: abort.signal },
    )
      .then(async (response) => {
        if (response.status === 202) {
          setState({ kind: "processing" });
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
        const mime = response.headers.get("content-type")?.split(";", 1)[0];
        if (
          !mime ||
          (kind === "image" && !mime.startsWith("image/")) ||
          (kind === "video" && !mime.startsWith("video/"))
        ) {
          setState({
            kind: "failed",
            message: "This media preview has an unexpected format.",
          });
          return;
        }
        const blob = await response.blob();
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ kind: "ready", url: objectUrl, mime });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setState({
          kind: "failed",
          message:
            error instanceof Error && error.name === "AbortError"
              ? "This media preview was cancelled."
              : "This media preview could not load.",
        });
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, draftId, kind, mediaId]);

  const label = `${kind === "image" ? "Image" : "Video"}: ${altText || "No alt text"}`;
  if (state.kind === "ready") {
    return kind === "image" ? (
      <img
        alt={altText}
        aria-label={label}
        className="aspect-video w-full rounded-[4px] bg-muted/65 object-cover"
        data-testid="preview-media"
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
