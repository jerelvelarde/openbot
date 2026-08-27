import { useState } from "react";
import {
  ALT_TEXT_LIMIT,
  canAppendMedia,
  MAX_MEDIA,
  orderedMedia,
  validateMediaFile,
} from "@/lib/typefully/preview";
import type { CanonicalDraftDocument } from "@/lib/typefully/queries";

export type MediaItemState =
  | { kind: "uploading"; previewUrl?: string }
  | { kind: "failed" | "uncertain"; message: string; previewUrl?: string }
  | { kind: "ready"; previewUrl?: string };

export function MediaEditor({
  document,
  states,
  onTextChange,
  onReorder,
  onSelect,
  onRetry,
  onRemove,
  editingDisabled = false,
  remoteOperationsDisabled = false,
}: {
  document: CanonicalDraftDocument;
  states: Readonly<Record<string, MediaItemState>>;
  onTextChange(next: CanonicalDraftDocument): void;
  onReorder(next: CanonicalDraftDocument): void;
  onSelect(files: File[]): void;
  onRetry(mediaId: string): void;
  onRemove(mediaId: string): void;
  editingDisabled?: boolean;
  remoteOperationsDisabled?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const media = orderedMedia(document);
  const updateAlt = (id: string, altText: string) =>
    onTextChange({
      ...document,
      media: document.media.map((item) =>
        item.id === id ? { ...item, altText } : item,
      ),
    });
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= media.length) return;
    const next = [...media];
    const currentItem = next[index];
    const targetItem = next[target];
    if (!currentItem || !targetItem) return;
    next[index] = targetItem;
    next[target] = currentItem;
    onReorder({
      ...document,
      media: next.map((item, order) => ({ ...item, order })),
    });
  };
  const select = (files: FileList | null) => {
    const selected = Array.from(files ?? []);
    const validation = selected.map(validateMediaFile).find(Boolean) ?? null;
    if (validation) {
      setError(validation);
      return;
    }
    if (!canAppendMedia(media) || media.length + selected.length > MAX_MEDIA) {
      setError(`A draft can contain at most ${MAX_MEDIA} media attachments.`);
      return;
    }
    setError(null);
    if (selected.length > 0) onSelect(selected);
  };

  return (
    <div className="space-y-3">
      <label className="inline-flex cursor-pointer rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted/65">
        Add media
        <input
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime"
          aria-label="Add media"
          className="sr-only"
          disabled={remoteOperationsDisabled || !canAppendMedia(media)}
          multiple
          onChange={(event) => select(event.currentTarget.files)}
          type="file"
        />
      </label>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="space-y-2">
        {media.map((item, index) => {
          const state = states[item.id];
          const name = item.altText || `${item.kind} ${index + 1}`;
          const failed =
            state?.kind !== "uploading" &&
            (state?.kind === "failed" ||
              state?.kind === "uncertain" ||
              item.remoteId === null);
          return (
            <article
              className="rounded-[8px] border border-border bg-card p-3"
              key={item.id}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium capitalize">{item.kind}</p>
                  {state?.kind === "uploading" ? (
                    <p className="text-xs text-muted-foreground" role="status">
                      Uploading…
                    </p>
                  ) : null}
                  {failed ? (
                    <p className="text-xs text-destructive" role="alert">
                      {state?.kind === "failed" || state?.kind === "uncertain"
                        ? state.message
                        : "Typefully has not confirmed this upload."}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  <button
                    aria-label={`Move ${name} up`}
                    className="rounded-[4px] px-2 py-1 text-xs hover:bg-muted/65"
                    disabled={editingDisabled || index === 0}
                    onClick={() => move(index, -1)}
                    type="button"
                  >
                    Up
                  </button>
                  <button
                    aria-label={`Move ${name} down`}
                    className="rounded-[4px] px-2 py-1 text-xs hover:bg-muted/65"
                    disabled={editingDisabled || index === media.length - 1}
                    onClick={() => move(index, 1)}
                    type="button"
                  >
                    Down
                  </button>
                  {failed ? (
                    <button
                      aria-label={`Retry ${name}`}
                      className="rounded-[4px] px-2 py-1 text-xs hover:bg-muted/65"
                      disabled={remoteOperationsDisabled}
                      onClick={() => onRetry(item.id)}
                      type="button"
                    >
                      Retry
                    </button>
                  ) : null}
                  <button
                    aria-label={`Remove ${name}`}
                    className="rounded-[4px] px-2 py-1 text-xs hover:bg-destructive/10"
                    disabled={
                      remoteOperationsDisabled || state?.kind === "uploading"
                    }
                    onClick={() => onRemove(item.id)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <label className="mt-2 block text-xs text-muted-foreground">
                Alt text
                <input
                  aria-label={`Alt text for ${name}`}
                  className="mt-1 w-full rounded-[4px] border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  disabled={editingDisabled}
                  maxLength={ALT_TEXT_LIMIT}
                  onChange={(event) =>
                    updateAlt(item.id, event.currentTarget.value)
                  }
                  value={item.altText}
                />
              </label>
            </article>
          );
        })}
      </div>
    </div>
  );
}
