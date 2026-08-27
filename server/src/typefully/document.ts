import { createHash } from "node:crypto";
import { z } from "zod";

const STABLE_ID_MAX_LENGTH = 120;
const POST_BODY_MAX_LENGTH = 100_000;
const ALT_TEXT_MAX_LENGTH = 10_000;
const REMOTE_ID_MAX_LENGTH = 240;
const SUMMARY_TITLE_MAX_LENGTH = 160;
const destinationRank = { x: 0, linkedin: 1 } as const;

const normalizeLineEndings = (value: string): string =>
  value.replace(/\r\n?/g, "\n");

const stableIdSchema = z.string().trim().min(1).max(STABLE_ID_MAX_LENGTH);
const postBodySchema = z
  .string()
  .max(POST_BODY_MAX_LENGTH)
  .transform(normalizeLineEndings);

export const destinationSchema = z.enum(["x", "linkedin"]);

export const postBlockSchema = z.strictObject({
  id: stableIdSchema,
  x: postBodySchema,
  linkedin: postBodySchema,
});

export const mediaDescriptorSchema = z.strictObject({
  id: stableIdSchema,
  kind: z.enum(["image", "video"]),
  order: z.number().int(),
  altText: z.string().max(ALT_TEXT_MAX_LENGTH).transform(normalizeLineEndings),
  remoteId: z.string().trim().min(1).max(REMOTE_ID_MAX_LENGTH).nullable(),
});

const destinationsSchema = z
  .array(destinationSchema)
  .min(1)
  .max(2)
  .superRefine((destinations, context) => {
    const seen = new Set<string>();
    for (const destination of destinations) {
      if (seen.has(destination)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate destination: ${destination}.`,
        });
      }
      seen.add(destination);
    }
  })
  .transform((destinations) =>
    [...destinations].sort(
      (left, right) => destinationRank[left] - destinationRank[right],
    ),
  );

const postsSchema = z
  .array(postBlockSchema)
  .min(1)
  .max(50)
  .superRefine((posts, context) => {
    const seen = new Set<string>();
    for (const post of posts) {
      if (seen.has(post.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate post id: ${post.id}.`,
        });
      }
      seen.add(post.id);
    }
  });

const mediaSchema = z
  .array(mediaDescriptorSchema)
  .max(20)
  .superRefine((media, context) => {
    const ids = new Set<string>();
    const orders = new Set<number>();
    for (const descriptor of media) {
      if (ids.has(descriptor.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate media id: ${descriptor.id}.`,
        });
      }
      if (orders.has(descriptor.order)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate media order: ${descriptor.order}.`,
        });
      }
      ids.add(descriptor.id);
      orders.add(descriptor.order);
    }
  });

export const draftDocumentSchema = z.strictObject({
  title: z.string().trim().max(160).default(""),
  destinations: destinationsSchema,
  socialSetId: z.string().trim().max(120).nullable(),
  accountLabel: z.string().trim().max(160).nullable(),
  posts: postsSchema,
  media: mediaSchema,
  scheduleAt: z.string().datetime().nullable(),
});

export type CanonicalDraftDocument = z.infer<typeof draftDocumentSchema>;

function unsupportedDestination(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const destinations = Reflect.get(input, "destinations");
  if (!Array.isArray(destinations)) {
    return null;
  }
  for (const destination of destinations) {
    if (
      typeof destination === "string" &&
      destination !== "x" &&
      destination !== "linkedin"
    ) {
      return destination;
    }
  }
  return null;
}

function platformLabel(platform: string): string {
  const sanitized = platform.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "�");
  const [first, ...rest] = Array.from(sanitized);
  if (first === undefined) {
    return "This platform";
  }
  return Array.from(`${first.toUpperCase()}${rest.join("")}`)
    .slice(0, 80)
    .join("");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeDraft(input: unknown): {
  document: CanonicalDraftDocument;
  serialized: string;
  hash: string;
} {
  const unsupported = unsupportedDestination(input);
  if (unsupported !== null) {
    throw new Error(
      `${platformLabel(unsupported)} is not supported in OpenBot yet.`,
    );
  }

  const parsed = draftDocumentSchema.parse(input);
  const document: CanonicalDraftDocument = {
    ...parsed,
    media: [...parsed.media].sort(
      (left, right) =>
        left.order - right.order ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    ),
  };
  const serialized = stableSerialize(document);
  const hash = createHash("sha256").update(serialized, "utf8").digest("hex");

  return { document, serialized, hash };
}

export const syncStatusSchema = z.enum([
  "local",
  "syncing",
  "synced",
  "connection_required",
  "remote_error",
  "grant_blocked",
]);
export type DraftSyncStatus = z.infer<typeof syncStatusSchema>;

export const proposalStatusSchema = z.enum([
  "pending",
  "declined",
  "expired",
  "published",
  "failed",
  "unknown",
]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const draftSummaryInputSchema = z.strictObject({
  id: z.string().uuid(),
  document: draftDocumentSchema,
  version: z.number().int().positive(),
  syncStatus: syncStatusSchema,
  proposalStatus: proposalStatusSchema.nullable().optional(),
  socialSetLabel: z.string().trim().max(160).nullable().optional(),
});

export type DraftSummaryInput = z.input<typeof draftSummaryInputSchema>;

export type DraftSummary = {
  id: string;
  title: string;
  destinations: ("x" | "linkedin")[];
  socialSetLabel: string | null;
  mediaCount: number;
  version: number;
  syncStatus: DraftSyncStatus;
  proposalStatus: ProposalStatus | null;
};

export function draftSummary(input: DraftSummaryInput): DraftSummary {
  const parsed = draftSummaryInputSchema.parse(input);
  let title = parsed.document.title.trim();
  if (title.length === 0) {
    for (const post of parsed.document.posts) {
      const body = parsed.document.destinations
        .map((destination) => post[destination].trim())
        .find((candidate) => candidate.length > 0);
      if (body !== undefined) {
        title = Array.from(body.replace(/\s+/g, " "))
          .slice(0, SUMMARY_TITLE_MAX_LENGTH)
          .join("");
        break;
      }
    }
  }

  return {
    id: parsed.id,
    title,
    destinations: [...parsed.document.destinations],
    socialSetLabel: parsed.socialSetLabel ?? null,
    mediaCount: parsed.document.media.length,
    version: parsed.version,
    syncStatus: parsed.syncStatus,
    proposalStatus: parsed.proposalStatus ?? null,
  };
}
