import twitterText from "twitter-text";
import type { CanonicalDraftDocument, TypefullyDestination } from "./queries";

export const POST_BODY_LIMIT = 100_000;
export const X_POST_LIMIT = 280;
export const LINKEDIN_POST_LIMIT = 3_000;
export const ALT_TEXT_LIMIT = 10_000;
export const MAX_POSTS = 50;
export const MAX_MEDIA = 20;
export const MAX_MEDIA_ORDER = MAX_MEDIA - 1;
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
  limit: number;
  valid: boolean;
  position: number;
  total: number;
};

export type PlatformTextMetrics = {
  count: number;
  limit: number;
  valid: boolean;
};

export function platformTextMetrics(
  platform: TypefullyDestination,
  body: string,
): PlatformTextMetrics {
  const normalized = body.normalize("NFC");
  if (platform === "x") {
    const parsed = twitterText.parseTweet(normalized);
    return {
      count: parsed.weightedLength,
      limit: X_POST_LIMIT,
      valid: parsed.valid && parsed.weightedLength <= X_POST_LIMIT,
    };
  }

  // LinkedIn publishes a 3,000-character limit. Count Unicode code points so
  // supplementary characters are one character rather than two UTF-16 units.
  const characters = Array.from(normalized).length;
  return {
    count: characters,
    limit: LINKEDIN_POST_LIMIT,
    valid: characters <= LINKEDIN_POST_LIMIT,
  };
}

export function previewPosts(
  document: CanonicalDraftDocument,
  platform: TypefullyDestination,
): PreviewPost[] {
  return document.posts.map((post, index) => {
    const metrics = platformTextMetrics(platform, post[platform]);
    return {
      id: post.id,
      body: post[platform],
      characters: metrics.count,
      limit: metrics.limit,
      valid: metrics.valid,
      position: index + 1,
      total: document.posts.length,
    };
  });
}

export function orderedMedia(document: CanonicalDraftDocument) {
  return [...document.media].sort(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  );
}

export function nextMediaOrder(
  media: readonly Pick<CanonicalDraftDocument["media"][number], "order">[],
): number | undefined {
  if (media.length >= MAX_MEDIA) return;
  const order =
    media.reduce(
      (highest, descriptor) => Math.max(highest, descriptor.order),
      -1,
    ) + 1;
  return order <= MAX_MEDIA_ORDER ? order : undefined;
}

export function canAppendMedia(
  media: readonly Pick<CanonicalDraftDocument["media"][number], "order">[],
): boolean {
  return nextMediaOrder(media) !== undefined;
}

export function validateMediaFile(file: File): string | null {
  if (file.size > MAX_MEDIA_BYTES)
    return "Typefully media must be no larger than 25 MB.";
  if (!ALLOWED_MEDIA_TYPES.has(file.type))
    return "Use a supported image or video format.";
  return null;
}
