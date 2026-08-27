import { type KeyboardEvent, useId, useRef, useState } from "react";
import { type AutosaveSnapshot, canPublish } from "@/lib/typefully/autosave";
import { platformTextMetrics } from "@/lib/typefully/preview";
import type {
  AuthoritativeDraft,
  CanonicalDraftDocument,
  DraftSyncStatus,
  ProposalSummary,
  TypefullyDestination,
} from "@/lib/typefully/queries";
import { TypefullyProposalReviewLoader } from "../gallery/typefully-publication";
import { DraftEditor } from "./draft-editor";
import { MediaEditor, type MediaItemState } from "./media-editor";
import { PlatformPreview, type PreviewViewport } from "./platform-preview";

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
            className={`h-8 flex-1 rounded-[8px] px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none ${active ? "bg-card text-card-foreground shadow-sm" : "bg-transparent"}`}
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

function ReadOnlyPosts({
  document,
  platform,
}: {
  document: CanonicalDraftDocument;
  platform: TypefullyDestination;
}) {
  return document.posts.map((post, index) => (
    <article
      className="whitespace-pre-wrap rounded-[4px] bg-muted/65 px-3 py-2 text-sm leading-[22px]"
      key={post.id}
    >
      <span className="sr-only">Post {index + 1}: </span>
      {post[platform] || "No content for this destination."}
    </article>
  ));
}

/** Last-error display is bounded again at the browser boundary and removes credential-shaped data. */
export function safeDraftError(value: string): string {
  const withoutControls = Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127 ? " " : character;
  }).join("");
  return Array.from(
    withoutControls
      .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
      .replace(
        /\b(api[ _-]?key|token|secret)\s*[:=]\s*\S+/giu,
        "$1: [redacted]",
      )
      .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted]"),
  )
    .slice(0, 240)
    .join("");
}

function autosaveLabel(
  snapshot: AutosaveSnapshot | undefined,
  draft: AuthoritativeDraft,
  mediaBusy: boolean,
  remoteConnected: boolean,
) {
  if (mediaBusy) return "Saving…";
  if (!snapshot) return SYNC_LABELS[draft.syncStatus];
  if (snapshot.state.kind === "dirty" || snapshot.state.kind === "saving")
    return "Saving…";
  if (snapshot.state.kind === "conflict") return "Save conflict";
  if (snapshot.state.kind === "error") return "Not saved to Typefully";
  if (remoteConnected !== true) return "Saved in OpenBot";
  return snapshot.state.remote === "confirmed"
    ? "Saved to Typefully"
    : "Saved in OpenBot";
}

function readiness(
  draft: AuthoritativeDraft,
  document: CanonicalDraftDocument,
  snapshot: AutosaveSnapshot | undefined,
  mediaStates: Readonly<Record<string, MediaItemState>>,
  mediaBusy: boolean,
  remoteConnected: boolean,
) {
  if (
    document.posts.some((post) =>
      document.destinations.some(
        (destination) =>
          !platformTextMetrics(destination, post[destination]).valid,
      ),
    )
  )
    return "Resolve destination character limits before requesting approval";
  if (
    mediaBusy ||
    document.media.some((item) => item.remoteId === null) ||
    Object.values(mediaStates).some((state) => state.kind !== "ready")
  )
    return "Resolve media uploads before requesting approval";
  if (remoteConnected !== true)
    return "Connect Typefully before requesting approval";
  if (snapshot) {
    if (snapshot.state.kind === "dirty" || snapshot.state.kind === "saving")
      return "Wait for saving to finish";
    if (snapshot.state.kind === "conflict")
      return "Resolve the save conflict before requesting approval";
    if (snapshot.state.kind === "error")
      return "Retry saving before requesting approval";
    return canPublish(snapshot.state)
      ? "Ready for approval"
      : "Sync to Typefully before requesting approval";
  }
  if (draft.syncStatus !== "synced") {
    const messages: Record<Exclude<DraftSyncStatus, "synced">, string> = {
      local: "Sync to Typefully before requesting approval",
      syncing: "Wait for saving to finish",
      connection_required: "Connect Typefully before requesting approval",
      remote_error:
        "Resolve the Typefully sync error before requesting approval",
      grant_blocked: "Typefully access is required before requesting approval",
    };
    return messages[draft.syncStatus];
  }
  return draft.remoteDraftId !== null &&
    draft.remoteVersion === draft.version &&
    draft.remoteHash === draft.contentHash
    ? "Ready for approval"
    : "Wait for Typefully confirmation before requesting approval";
}

export type CanvasShellProps = {
  draft: AuthoritativeDraft;
  document?: CanonicalDraftDocument;
  autosave?: AutosaveSnapshot;
  mediaStates?: Readonly<Record<string, MediaItemState>>;
  localMediaUrls?: Readonly<Record<string, string>>;
  mediaBusy?: boolean;
  mediaOperationError?: string | null;
  onTextChange?: (next: CanonicalDraftDocument) => void;
  onMediaTextChange?: (next: CanonicalDraftDocument) => void;
  onDismissMediaOperationError?: () => void;
  onMediaReorder?: (next: CanonicalDraftDocument) => void;
  onSelectMedia?: (files: File[]) => void;
  onRetryMedia?: (mediaId: string) => void;
  onRemoveMedia?: (mediaId: string) => void;
  onReload?: () => void;
  onSaveAsNew?: () => void;
  onRetrySave?: () => void;
  onPreparePublication?: () => void;
  proposal?: ProposalSummary | null;
  proposalPreparing?: boolean;
  proposalError?: string | null;
  remoteConnected: boolean;
};

export function CanvasShell({
  draft,
  document = draft.document,
  autosave,
  mediaStates = {},
  localMediaUrls = {},
  mediaBusy = false,
  mediaOperationError = null,
  onTextChange,
  onMediaTextChange,
  onDismissMediaOperationError,
  onMediaReorder,
  onSelectMedia,
  onRetryMedia,
  onRemoveMedia,
  onReload,
  onSaveAsNew,
  onRetrySave,
  onPreparePublication,
  proposal = null,
  proposalPreparing = false,
  proposalError = null,
  remoteConnected,
}: CanvasShellProps) {
  const destinations = document.destinations;
  const [requestedPlatform, setRequestedPlatform] =
    useState<TypefullyDestination>(destinations[0] ?? "x");
  const [viewport, setViewport] = useState<PreviewViewport>("desktop");
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
  const viewportPanelId = (value: PreviewViewport) =>
    `${viewportBase}-panel-${value}`;
  const interactive = Boolean(
    onTextChange &&
      onMediaTextChange &&
      onMediaReorder &&
      onSelectMedia &&
      onRetryMedia &&
      onRemoveMedia,
  );
  const saveMessage =
    autosave?.state.kind === "error"
      ? autosave.state.message
      : draft.syncStatus === "remote_error"
        ? draft.lastError
        : null;
  const mediaDisabled =
    mediaBusy ||
    Boolean(
      autosave &&
        autosave.state.kind !== "idle" &&
        autosave.state.kind !== "saved",
    );
  const readinessMessage = readiness(
    draft,
    document,
    autosave,
    mediaStates,
    mediaBusy,
    remoteConnected,
  );
  const publicationReady =
    readinessMessage === "Ready for approval" &&
    !proposalPreparing &&
    proposal === null;

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
              {document.title || "Untitled draft"}
            </p>
            <p
              aria-live="polite"
              className="text-xs text-muted-foreground"
              role="status"
            >
              {autosaveLabel(autosave, draft, mediaBusy, remoteConnected)} ·
              Version {autosave?.target.version ?? draft.version}
            </p>
          </div>
          <span
            className="rounded-full bg-muted/65 px-1.5 py-0.5 text-xs"
            data-testid="publish-readiness"
          >
            {readinessMessage} · Publishing approval is required
          </span>
          <button
            className="rounded-[8px] bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!publicationReady || !onPreparePublication}
            onClick={onPreparePublication}
            type="button"
          >
            {proposalPreparing ? "Preparing review…" : "Review & publish"}
          </button>
          {proposal ? (
            <p
              className="w-full rounded-[4px] bg-muted/65 px-3 py-2 text-xs"
              role="status"
            >
              An immutable publication review is shown below.
            </p>
          ) : null}
          {proposalError ? (
            <p className="w-full text-xs text-destructive" role="alert">
              {safeDraftError(proposalError)}
            </p>
          ) : null}
          {saveMessage ? (
            <p
              className="w-full rounded-[4px] bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {safeDraftError(saveMessage)}
            </p>
          ) : null}
          {autosave?.state.kind === "conflict" ? (
            <div className="flex w-full flex-wrap gap-2">
              <button
                className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm"
                onClick={onReload}
                type="button"
              >
                Reload
              </button>
              <button
                className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm"
                disabled={!onSaveAsNew}
                onClick={onSaveAsNew}
                type="button"
              >
                Save as new
              </button>
            </div>
          ) : null}
          {autosave?.state.kind === "error" ? (
            <button
              className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm"
              onClick={onRetrySave}
              type="button"
            >
              Retry save
            </button>
          ) : null}
        </header>
        {proposal ? (
          proposal.draftId !== (autosave?.target.draftId ?? draft.id) ||
          proposal.version !== (autosave?.target.version ?? draft.version) ? (
            <section
              aria-label="Typefully publication review"
              className="rounded-[8px] border-2 border-border bg-card/50 p-4 text-sm"
              role="alert"
            >
              <p>The draft changed. This approval cannot be reused.</p>
              <button
                className="mt-3 rounded-[8px] border border-border bg-card px-3 py-2"
                disabled={proposalPreparing || !onPreparePublication}
                onClick={onPreparePublication}
                type="button"
              >
                Review again
              </button>
            </section>
          ) : (
            <TypefullyProposalReviewLoader
              onReviewAgain={
                proposalPreparing ? undefined : onPreparePublication
              }
              summary={proposal}
            />
          )
        ) : null}
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
                  {document.accountLabel || "No social set selected"}
                </p>
              </div>
              {platform ? (
                platformOptions.map((option) => (
                  <div
                    aria-labelledby={`${platformBase}-tab-${option.id}`}
                    hidden={platform !== option.id}
                    id={platformPanelId(option.id)}
                    key={option.id}
                    role="tabpanel"
                  >
                    {interactive ? (
                      <DraftEditor
                        disabled={
                          mediaBusy || autosave?.state.kind === "conflict"
                        }
                        document={document}
                        onChange={onTextChange ?? (() => {})}
                        platform={option.id}
                      />
                    ) : (
                      <div className="space-y-2">
                        <ReadOnlyPosts
                          document={document}
                          platform={option.id}
                        />
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <EmptyDestination />
              )}
              {interactive ? (
                <div>
                  <SectionTitle>Media</SectionTitle>
                  {mediaOperationError ? (
                    <div
                      className="mb-3 flex items-start justify-between gap-3 rounded-[4px] bg-destructive/10 px-3 py-2 text-xs text-destructive"
                      role="alert"
                    >
                      <span>{safeDraftError(mediaOperationError)}</span>
                      <button
                        aria-label="Dismiss media upload error"
                        className="rounded-[4px] border border-current px-2 py-1"
                        onClick={onDismissMediaOperationError}
                        type="button"
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : null}
                  <MediaEditor
                    document={document}
                    editingDisabled={
                      mediaBusy || autosave?.state.kind === "conflict"
                    }
                    onReorder={onMediaReorder ?? (() => {})}
                    onRemove={onRemoveMedia ?? (() => {})}
                    onRetry={onRetryMedia ?? (() => {})}
                    onSelect={onSelectMedia ?? (() => {})}
                    onTextChange={onMediaTextChange ?? (() => {})}
                    remoteOperationsDisabled={mediaDisabled}
                    states={mediaStates}
                  />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {document.media.length} media attachment
                  {document.media.length === 1 ? "" : "s"}
                </p>
              )}
            </div>
          </section>
          <section
            aria-label="Preview"
            className={`w-full justify-self-center rounded-[8px] border-2 border-border bg-card/50 p-4 transition-[max-width] motion-reduce:transition-none ${viewport === "mobile" ? "max-w-[360px]" : "max-w-none"}`}
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
                {viewport === option.id && platform ? (
                  <PlatformPreview
                    document={document}
                    draftId={autosave?.target.draftId ?? draft.id}
                    localMediaUrls={localMediaUrls}
                    platform={platform}
                    viewport={option.id}
                  />
                ) : viewport === option.id ? (
                  <EmptyDestination />
                ) : null}
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
