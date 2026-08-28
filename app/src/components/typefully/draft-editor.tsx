import { useEffect, useRef, useState } from "react";
import {
  MAX_POSTS,
  POST_BODY_LIMIT,
  platformTextMetrics,
} from "@/lib/typefully/preview";
import type {
  CanonicalDraftDocument,
  TypefullyDestination,
} from "@/lib/typefully/queries";

const LABELS: Record<TypefullyDestination, string> = {
  x: "X",
  linkedin: "LinkedIn",
};

function nextPostId(): string {
  return `post-${crypto.randomUUID()}`;
}

export function DraftEditor({
  document,
  platform,
  onChange,
  disabled = false,
}: {
  document: CanonicalDraftDocument;
  platform: TypefullyDestination;
  onChange(next: CanonicalDraftDocument): void;
  disabled?: boolean;
}) {
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const textareas = useRef<Array<HTMLTextAreaElement | null>>([]);
  useEffect(() => {
    if (focusIndex === null) return;
    textareas.current[focusIndex]?.focus();
    setFocusIndex(null);
  }, [focusIndex]);

  const updatePost = (index: number, value: string) => {
    const posts = document.posts.map((post, postIndex) =>
      postIndex === index ? { ...post, [platform]: value } : post,
    );
    onChange({ ...document, posts });
  };
  const move = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (destination < 0 || destination >= document.posts.length) return;
    const posts = [...document.posts];
    const currentPost = posts[index];
    const destinationPost = posts[destination];
    if (!currentPost || !destinationPost) return;
    posts[index] = destinationPost;
    posts[destination] = currentPost;
    onChange({ ...document, posts });
    setFocusIndex(destination);
  };
  const remove = (index: number) => {
    if (document.posts.length <= 1) return;
    onChange({
      ...document,
      posts: document.posts.filter((_, postIndex) => postIndex !== index),
    });
    setFocusIndex(Math.max(0, index - 1));
  };
  const add = () => {
    if (document.posts.length >= MAX_POSTS) return;
    onChange({
      ...document,
      posts: [...document.posts, { id: nextPostId(), x: "", linkedin: "" }],
    });
    setFocusIndex(document.posts.length);
  };
  const toggleDestination = (destination: TypefullyDestination) => {
    const enabled = document.destinations.includes(destination);
    if (enabled && document.destinations.length === 1) return;
    const destinations = enabled
      ? document.destinations.filter((item) => item !== destination)
      : ([...document.destinations, destination] as TypefullyDestination[]);
    onChange({ ...document, destinations });
  };

  return (
    <div className="space-y-4">
      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-2 text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
          Destinations
        </legend>
        {(["x", "linkedin"] as const).map((destination) => {
          const checked = document.destinations.includes(destination);
          return (
            <label
              className="flex items-center gap-2 text-sm"
              key={destination}
            >
              <input
                aria-label={`Publish to ${LABELS[destination]}`}
                checked={checked}
                disabled={
                  disabled || (checked && document.destinations.length === 1)
                }
                onChange={() => toggleDestination(destination)}
                type="checkbox"
              />
              {LABELS[destination]}
            </label>
          );
        })}
      </fieldset>

      <div className="space-y-3">
        {document.posts.map((post, index) => {
          const body = post[platform];
          const metrics = platformTextMetrics(platform, body);
          const label = `${LABELS[platform]} post ${index + 1}`;
          const errorId = `${platform}-${post.id}-error`;
          return (
            <article
              className="rounded-[8px] border border-border bg-card p-3"
              key={post.id}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Post {index + 1}</span>
                <div className="flex gap-1">
                  <button
                    aria-label={`Move post ${index + 1} up`}
                    className="rounded-[4px] px-2 py-1 text-xs hover:bg-muted/65"
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                    type="button"
                  >
                    Up
                  </button>
                  <button
                    aria-label={`Move post ${index + 1} down`}
                    className="rounded-[4px] px-2 py-1 text-xs hover:bg-muted/65"
                    disabled={disabled || index === document.posts.length - 1}
                    onClick={() => move(index, 1)}
                    type="button"
                  >
                    Down
                  </button>
                  <button
                    aria-label={`Remove post ${index + 1}`}
                    className="rounded-[4px] px-2 py-1 text-xs hover:bg-destructive/10"
                    disabled={disabled || document.posts.length === 1}
                    onClick={() => remove(index)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <textarea
                aria-describedby={errorId}
                aria-invalid={!metrics.valid}
                aria-label={label}
                className="min-h-28 w-full resize-y rounded-[4px] border border-input bg-background px-3 py-2 text-sm leading-[22px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={disabled}
                maxLength={POST_BODY_LIMIT}
                onChange={(event) =>
                  updatePost(index, event.currentTarget.value)
                }
                ref={(node) => {
                  textareas.current[index] = node;
                }}
                value={body}
              />
              <p
                className={`mt-1 text-right text-xs ${metrics.valid ? "text-muted-foreground" : "text-destructive"}`}
                id={errorId}
              >
                {metrics.count.toLocaleString()} /{" "}
                {metrics.limit.toLocaleString()}
                {!metrics.valid
                  ? ` — ${LABELS[platform]} limit exceeded`
                  : null}
              </p>
            </article>
          );
        })}
      </div>
      <button
        className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted/65"
        disabled={disabled || document.posts.length >= MAX_POSTS}
        onClick={add}
        type="button"
      >
        Add post
      </button>
    </div>
  );
}
