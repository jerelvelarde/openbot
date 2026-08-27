import {
  orderedMedia,
  POST_BODY_LIMIT,
  previewPosts,
} from "@/lib/typefully/preview";
import type {
  CanonicalDraftDocument,
  TypefullyDestination,
} from "@/lib/typefully/queries";

export type PreviewViewport = "desktop" | "mobile";

const LABELS: Record<TypefullyDestination, string> = {
  x: "X",
  linkedin: "LinkedIn",
};

export function PlatformPreview({
  document,
  platform,
  viewport,
  localMediaUrls = {},
}: {
  document: CanonicalDraftDocument;
  platform: string;
  viewport: PreviewViewport;
  localMediaUrls?: Readonly<Record<string, string>>;
}) {
  if (platform !== "x" && platform !== "linkedin") {
    return (
      <div
        className="rounded-[8px] border border-border bg-card p-4 text-sm text-muted-foreground"
        role="note"
      >
        Finish this destination in Typefully. OpenBot does not fabricate an
        unsupported preview.
      </div>
    );
  }
  const destination = platform as TypefullyDestination;
  const label = LABELS[destination];
  const posts = previewPosts(document, destination);
  const media = orderedMedia(document);

  return (
    <section
      aria-label={`${label} ${viewport} preview`}
      className={`mx-auto w-full overflow-hidden rounded-[8px] border border-border bg-card text-card-foreground shadow-sm ${
        viewport === "mobile" ? "max-w-[360px]" : "max-w-[640px]"
      }`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <strong className="block truncate text-sm font-medium">
            {document.accountLabel || "Typefully account"}
          </strong>
          <span className="text-xs text-muted-foreground">{label} preview</span>
        </div>
        <span className="rounded-full bg-muted/65 px-1.5 py-0.5 text-xs">
          {label}
        </span>
      </header>

      <div className="px-4 py-3">
        {posts.map((post, index) => (
          <div key={post.id}>
            {index > 0 && destination === "x" ? (
              <div
                aria-hidden
                className="ml-[7px] h-6 border-l border-border"
                data-testid="thread-separator"
              />
            ) : null}
            <article className="grid grid-cols-[16px_1fr] gap-3">
              <span
                aria-hidden
                className="mt-1 h-4 w-4 rounded-full bg-foreground/80"
              />
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {destination === "x"
                      ? `${post.position} / ${post.total}`
                      : "Post"}
                  </span>
                  <span>
                    {post.characters.toLocaleString()} /{" "}
                    {POST_BODY_LIMIT.toLocaleString()}
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-[22px]">
                  {post.body || `No ${label} content for this post.`}
                </p>
              </div>
            </article>
          </div>
        ))}

        {media.length > 0 ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {media.map((item) => {
              const localUrl = localMediaUrls[item.id];
              const mediaLabel = `${item.kind === "image" ? "Image" : "Video"}: ${item.altText || "No alt text"}`;
              return (
                <div
                  aria-label={mediaLabel}
                  className="flex min-h-20 items-center justify-center overflow-hidden rounded-[4px] bg-muted/65 text-center text-xs text-muted-foreground"
                  data-testid="preview-media"
                  key={item.id}
                  role="img"
                >
                  {localUrl && item.kind === "image" ? (
                    <img
                      alt={item.altText}
                      className="h-full w-full object-cover"
                      src={localUrl}
                    />
                  ) : (
                    <span className="px-2">{mediaLabel}</span>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
