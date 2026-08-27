import type { CanonicalDraftDocument, TypefullyDestination } from "./queries";

export const POST_BODY_LIMIT = 100_000;
export const ALT_TEXT_LIMIT = 10_000;
export const MAX_POSTS = 50;
export const MAX_MEDIA = 20;
export const MAX_MEDIA_BYTES = 25_000_000;

export const ALLOWED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
]);

export type PreviewPost = {
  id: string;
  body: string;
  characters: number;
  position: number;
  total: number;
};

export function previewPosts(
  document: CanonicalDraftDocument,
  platform: TypefullyDestination,
): PreviewPost[] {
  return document.posts.map((post, index) => ({
    id: post.id,
    body: post[platform],
    characters: post[platform].length,
    position: index + 1,
    total: document.posts.length,
  }));
}

export function orderedMedia(document: CanonicalDraftDocument) {
  return [...document.media].sort(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  );
}

export function validateMediaFile(file: File): string | null {
  if (file.size > MAX_MEDIA_BYTES)
    return "Typefully media must be no larger than 25 MB.";
  if (!ALLOWED_MEDIA_TYPES.has(file.type))
    return "Use a supported image or video format.";
  return null;
}
