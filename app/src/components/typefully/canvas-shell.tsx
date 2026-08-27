import { type KeyboardEvent, useId, useRef, useState } from "react";
import type {
  AuthoritativeDraft,
  DraftSyncStatus,
  TypefullyDestination,
} from "@/lib/typefully/queries";

type Viewport = "desktop" | "mobile";

const SYNC_LABELS: Record<DraftSyncStatus, string> = {
  local: "Saved in OpenBot",
  syncing: "Saving…",
  synced: "Saved to Typefully",
  connection_required: "Connect Typefully",
  remote_error: "Not saved to Typefully",
  grant_blocked: "Typefully access unavailable",
};

const READINESS_LABELS: Record<Exclude<DraftSyncStatus, "synced">, string> = {
  local: "Sync to Typefully before requesting approval",
  syncing: "Wait for saving to finish",
  connection_required: "Connect Typefully before requesting approval",
  remote_error: "Resolve the Typefully sync error before requesting approval",
  grant_blocked: "Typefully access is required before requesting approval",
};

const PLATFORM_LABELS: Record<TypefullyDestination, string> = {
  x: "X",
  linkedin: "LinkedIn",
};

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1">
      <span className="whitespace-nowrap text-[10px] font-normal uppercase tracking-[0.05em] text-muted-foreground">
        {children}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

function Tabs<T extends string>({
  idBase,
  label,
  options,
  panelId,
  selected,
  onSelect,
}: {
  idBase: string;
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  panelId: (id: T) => string;
  selected: T;
  onSelect: (value: T) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onSelect(option.id);
    refs.current[index]?.focus();
  };
  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % options.length;
    if (event.key === "ArrowLeft")
      next = (index - 1 + options.length) % options.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = options.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
  };

  return (
    <div
      aria-label={label}
      className="flex rounded-[8px] bg-muted/65 p-1"
      role="tablist"
    >
      {options.map((option, index) => {
        const active = selected === option.id;
        return (
          <button
            aria-controls={panelId(option.id)}
            aria-selected={active}
            className={`h-8 flex-1 rounded-[8px] px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none ${
              active
                ? "bg-card text-card-foreground shadow-sm"
                : "bg-transparent"
            }`}
            id={`${idBase}-tab-${option.id}`}
            key={option.id}
            onClick={() => onSelect(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            ref={(node) => {
              refs.current[index] = node;
            }}
            role="tab"
            tabIndex={active ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function EmptyDestination() {
  return (
    <p className="rounded-[4px] bg-muted/65 px-3 py-2 text-sm text-muted-foreground">
      Select a destination to see its content and preview.
    </p>
  );
}

function PostContent({
  draft,
  platform,
}: {
  draft: AuthoritativeDraft;
  platform: TypefullyDestination;
}) {
  return draft.document.posts.length === 0 ? (
    <p className="text-sm text-muted-foreground">No posts yet.</p>
  ) : (
    draft.document.posts.map((post, index) => (
      <article
        className="whitespace-pre-wrap rounded-[4px] bg-muted/65 px-3 py-2 text-sm leading-[22px]"
        key={post.id}
      >
        <span className="sr-only">Post {index + 1}: </span>
        {post[platform] || "No content for this destination."}
      </article>
    ))
  );
}

function PreviewContent({
  draft,
  platform,
}: {
  draft: AuthoritativeDraft;
  platform: TypefullyDestination | undefined;
}) {
  if (!platform) return <EmptyDestination />;
  return (
    <div className="rounded-[8px] border border-border bg-card p-4 text-card-foreground">
      <div className="mb-3 flex items-center justify-between gap-2">
        <strong className="text-sm font-medium">
          {draft.document.accountLabel || "Typefully account"}
        </strong>
        <span className="rounded-full bg-muted/65 px-1.5 py-0.5 text-xs">
          {PLATFORM_LABELS[platform]}
        </span>
      </div>
      <div className="space-y-3">
        {draft.document.posts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No posts to preview.</p>
        ) : (
          draft.document.posts.map((post) => (
            <p
              className="whitespace-pre-wrap text-sm leading-[22px]"
              key={post.id}
            >
              {post[platform] || "No content for this destination."}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

/** Last-error display is bounded again at the browser boundary and removes credential-shaped data. */
export function safeDraftError(value: string): string {
  const withoutControls = Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127 ? " " : character;
  }).join("");
  const redacted = withoutControls
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\b(api[ _-]?key|token|secret)\s*[:=]\s*\S+/giu, "$1: [redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted]");
  return Array.from(redacted).slice(0, 240).join("");
}

function publishReadiness(draft: AuthoritativeDraft): string {
  if (draft.syncStatus !== "synced") return READINESS_LABELS[draft.syncStatus];
  return draft.remoteDraftId !== null &&
    draft.remoteVersion === draft.version &&
    draft.remoteHash === draft.contentHash
    ? "Ready for approval"
    : "Wait for Typefully confirmation before requesting approval";
}

export function CanvasShell({ draft }: { draft: AuthoritativeDraft }) {
  const destinations = draft.document.destinations;
  const [requestedPlatform, setRequestedPlatform] =
    useState<TypefullyDestination>(destinations[0] ?? "x");
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const platform = destinations.includes(requestedPlatform)
    ? requestedPlatform
    : destinations[0];
  const platformOptions = destinations.map((destination) => ({
    id: destination,
    label: PLATFORM_LABELS[destination],
  }));
  const platformBase = `platform-${useId().replaceAll(":", "")}`;
  const viewportBase = `viewport-${useId().replaceAll(":", "")}`;
  const viewportOptions = [
    { id: "desktop", label: "Desktop" },
    { id: "mobile", label: "Mobile" },
  ] as const;
  const platformPanelId = (value: TypefullyDestination) =>
    `${platformBase}-panel-${value}`;
  const viewportPanelId = (value: Viewport) => `${viewportBase}-panel-${value}`;

  return (
    <div
      className="h-full overflow-y-auto scroll-smooth p-2 font-sans text-foreground motion-reduce:scroll-auto"
      data-testid="typefully-canvas"
    >
      <div className="mx-auto flex min-h-full max-w-[1100px] flex-col gap-2">
        <header
          className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-[8px] border-2 border-border bg-card/50 p-3 backdrop-blur-sm"
          data-testid="canvas-status"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {draft.document.title || "Untitled draft"}
            </p>
            <p className="text-xs text-muted-foreground" role="status">
              {SYNC_LABELS[draft.syncStatus]} · Version {draft.version}
            </p>
          </div>
          <span
            className="rounded-full bg-muted/65 px-1.5 py-0.5 text-xs"
            data-testid="publish-readiness"
          >
            {publishReadiness(draft)} · Publishing approval is required
          </span>
          {draft.syncStatus === "remote_error" && draft.lastError ? (
            <p
              className="w-full rounded-[4px] bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {safeDraftError(draft.lastError)}
            </p>
          ) : null}
        </header>

        <div className="grid flex-1 gap-2 md:grid-cols-2">
          <section
            aria-label="Editing"
            className="rounded-[8px] border-2 border-border bg-card/50 p-4"
            data-testid="canvas-card"
          >
            <SectionTitle>Editing</SectionTitle>
            {platform ? (
              <Tabs
                idBase={platformBase}
                label="Editing platform"
                onSelect={setRequestedPlatform}
                options={platformOptions}
                panelId={platformPanelId}
                selected={platform}
              />
            ) : null}

            <div className="mt-4 space-y-4">
              <div>
                <p className="text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
                  Account
                </p>
                <p className="mt-1 text-sm">
                  {draft.document.accountLabel || "No social set selected"}
                </p>
              </div>
              {platform ? (
                <div className="space-y-2">
                  {platformOptions.map((option) => (
                    <div
                      aria-labelledby={`${platformBase}-tab-${option.id}`}
                      hidden={platform !== option.id}
                      id={platformPanelId(option.id)}
                      key={option.id}
                      role="tabpanel"
                    >
                      <PostContent draft={draft} platform={option.id} />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyDestination />
              )}
              <p className="text-xs text-muted-foreground">
                {draft.document.media.length} media attachment
                {draft.document.media.length === 1 ? "" : "s"}
              </p>
            </div>
          </section>

          <section
            aria-label="Preview"
            className={`w-full justify-self-center rounded-[8px] border-2 border-border bg-card/50 p-4 transition-[max-width] motion-reduce:transition-none ${
              viewport === "mobile" ? "max-w-[360px]" : "max-w-none"
            }`}
            data-testid="canvas-card"
          >
            <SectionTitle>Preview</SectionTitle>
            <Tabs
              idBase={viewportBase}
              label="Preview viewport"
              onSelect={setViewport}
              options={viewportOptions}
              panelId={viewportPanelId}
              selected={viewport}
            />

            {viewportOptions.map((option) => (
              <div
                aria-labelledby={`${viewportBase}-tab-${option.id}`}
                className="mt-4"
                hidden={viewport !== option.id}
                id={viewportPanelId(option.id)}
                key={option.id}
                role="tabpanel"
              >
                <PreviewContent draft={draft} platform={platform} />
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
