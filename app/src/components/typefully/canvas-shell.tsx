import { useState } from "react";
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

const PLATFORM_LABELS: Record<TypefullyDestination, string> = {
  x: "X",
  linkedin: "LinkedIn",
};

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1">
      <span className="whitespace-nowrap text-[10px] font-normal uppercase tracking-[0.05em] text-[#57575b]">
        {children}
      </span>
      <span aria-hidden className="h-px flex-1 bg-[#dbdbe5]" />
    </div>
  );
}

function Tabs<T extends string>({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  selected: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div
      aria-label={label}
      className="flex rounded-[8px] bg-white/50 p-1"
      role="tablist"
    >
      {options.map((option) => (
        <button
          aria-selected={selected === option.id}
          className={`h-8 flex-1 rounded-[8px] px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#010507] focus-visible:ring-offset-2 motion-reduce:transition-none ${
            selected === option.id ? "bg-white" : "bg-transparent"
          }`}
          key={option.id}
          onClick={() => onSelect(option.id)}
          role="tab"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function EmptyDestination() {
  return (
    <p className="rounded-[4px] bg-white/65 px-3 py-2 text-sm text-[#57575b]">
      Select a destination to see its content and preview.
    </p>
  );
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

  return (
    <div
      className="h-full overflow-y-auto scroll-smooth p-2 font-sans text-[#010507] motion-reduce:scroll-auto"
      data-testid="typefully-canvas"
    >
      <div className="mx-auto flex min-h-full max-w-[1100px] flex-col gap-2">
        <header
          className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-[8px] border-2 border-white bg-white/50 p-3 backdrop-blur-sm"
          data-testid="canvas-status"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {draft.document.title || "Untitled draft"}
            </p>
            <p className="text-xs text-[#57575b]" role="status">
              {SYNC_LABELS[draft.syncStatus]} · Version {draft.version}
            </p>
          </div>
          <span className="rounded-full bg-white/65 px-1.5 py-0.5 text-xs">
            Publishing approval is required
          </span>
        </header>

        <div className="grid flex-1 gap-2 md:grid-cols-2">
          <section
            aria-label="Editing"
            className="rounded-[8px] border-2 border-white bg-white/50 p-4"
            data-testid="canvas-card"
          >
            <SectionTitle>Editing</SectionTitle>
            {platform ? (
              <Tabs
                label="Editing platform"
                onSelect={setRequestedPlatform}
                options={platformOptions}
                selected={platform}
              />
            ) : null}

            <div className="mt-4 space-y-4">
              <div>
                <p className="text-[10px] uppercase tracking-[0.05em] text-[#57575b]">
                  Account
                </p>
                <p className="mt-1 text-sm">
                  {draft.document.accountLabel || "No social set selected"}
                </p>
              </div>
              {platform ? (
                <div className="space-y-2">
                  {draft.document.posts.length === 0 ? (
                    <p className="text-sm text-[#838389]">No posts yet.</p>
                  ) : (
                    draft.document.posts.map((post, index) => (
                      <article
                        className="whitespace-pre-wrap rounded-[4px] bg-white/65 px-3 py-2 text-sm leading-[22px]"
                        key={post.id}
                      >
                        <span className="sr-only">Post {index + 1}: </span>
                        {post[platform] || "No content for this destination."}
                      </article>
                    ))
                  )}
                </div>
              ) : (
                <EmptyDestination />
              )}
              <p className="text-xs text-[#838389]">
                {draft.document.media.length} media attachment
                {draft.document.media.length === 1 ? "" : "s"}
              </p>
            </div>
          </section>

          <section
            aria-label="Preview"
            className={`w-full justify-self-center rounded-[8px] border-2 border-white bg-white/50 p-4 transition-[max-width] motion-reduce:transition-none ${
              viewport === "mobile" ? "max-w-[360px]" : "max-w-none"
            }`}
            data-testid="canvas-card"
          >
            <SectionTitle>Preview</SectionTitle>
            <Tabs
              label="Preview viewport"
              onSelect={setViewport}
              options={[
                { id: "desktop", label: "Desktop" },
                { id: "mobile", label: "Mobile" },
              ]}
              selected={viewport}
            />

            <div className="mt-4 rounded-[8px] border border-[#dbdbe5] bg-white p-4">
              {platform ? (
                <>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <strong className="text-sm font-medium">
                      {draft.document.accountLabel || "Typefully account"}
                    </strong>
                    <span className="rounded-full bg-white/65 px-1.5 py-0.5 text-xs">
                      {PLATFORM_LABELS[platform]}
                    </span>
                  </div>
                  <div className="space-y-3">
                    {draft.document.posts.length === 0 ? (
                      <p className="text-sm text-[#838389]">
                        No posts to preview.
                      </p>
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
                </>
              ) : (
                <EmptyDestination />
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
