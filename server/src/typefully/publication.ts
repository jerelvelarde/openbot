import { z } from "zod";
import {
  type CanonicalDraftDocument,
  canonicalizeDraft,
  type ProposalStatus,
} from "./document";

const SAFE_VENDOR_FIELD_CHARS = 500;

export type ProposalSummary = {
  id: string;
  draftId: string;
  version: number;
  destinations: ("x" | "linkedin")[];
  expiresAt: string;
  status: ProposalStatus;
};

export type PublicationProposal = ProposalSummary & {
  ownerUserId: string;
  botId: string;
  channelId: string;
  contentHash: string;
  snapshot: CanonicalDraftDocument;
  decidedAt: string | null;
  completedAt: string | null;
  vendorResultId: string | null;
  publishedUrl: string | null;
  failureDetail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicationOutcome = {
  outcome: "published" | "failed" | "unknown";
  vendorResultId?: string;
  publishedUrl?: string;
  detail?: string;
};

export type PublicationVendor = {
  fetchDraft(input: {
    token: string;
    socialSetId: number;
    remoteDraftId: number;
    destinations: ("x" | "linkedin")[];
  }): Promise<{ document: unknown; outcome?: PublicationOutcome }>;
  publishDraft(input: {
    token: string;
    socialSetId: number;
    remoteDraftId: number;
    destinations: ("x" | "linkedin")[];
  }): Promise<PublicationOutcome>;
  reconcileDraft(input: {
    token: string;
    socialSetId: number;
    remoteDraftId: number;
    destinations: ("x" | "linkedin")[];
  }): Promise<PublicationOutcome>;
};

export type PublicationVerificationFailureClass =
  | "remote_timeout"
  | "remote_refused"
  | "remote_unavailable"
  | "remote_invalid_response";

export class PublicationVerificationError extends Error {
  constructor(readonly failureClass: PublicationVerificationFailureClass) {
    super("Typefully could not verify the reviewed draft. Try again.");
    this.name = "PublicationVerificationError";
  }
}

export class ProposalStateError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly code:
      | "proposal_not_pending"
      | "proposal_expired"
      | "proposal_changed"
      | "proposal_not_reconcilable",
    message: string,
  ) {
    super(message);
    this.name = "ProposalStateError";
  }
}

export function changedProposalError(): ProposalStateError {
  return new ProposalStateError("proposal_changed", "Changed — review again");
}

export function proposalSummary(input: {
  id: string;
  draftId: string;
  draftVersion: number;
  snapshot: CanonicalDraftDocument;
  expiresAt: Date;
  status: ProposalStatus;
}): ProposalSummary {
  return {
    id: input.id,
    draftId: input.draftId,
    version: input.draftVersion,
    destinations: [...input.snapshot.destinations],
    expiresAt: input.expiresAt.toISOString(),
    status: input.status,
  };
}

export function remoteMatchesSnapshot(
  remote: unknown,
  snapshot: CanonicalDraftDocument,
  contentHash: string,
): boolean {
  try {
    const canonical = canonicalizeDraft(remote);
    return (
      canonical.hash === contentHash &&
      canonical.serialized === canonicalizeDraft(snapshot).serialized
    );
  } catch {
    if (!remote || typeof remote !== "object" || Array.isArray(remote)) {
      return false;
    }
    const record = remote as Record<string, unknown>;
    const platforms = record.platforms;
    if (
      !platforms ||
      typeof platforms !== "object" ||
      Array.isArray(platforms)
    ) {
      return false;
    }
    const selected = platforms as Record<string, unknown>;
    for (const [name, value] of Object.entries(selected)) {
      if (snapshot.destinations.includes(name as "x" | "linkedin")) continue;
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).enabled === true
      ) {
        return false;
      }
    }
    for (const destination of snapshot.destinations) {
      const platform = selected[destination];
      if (
        !platform ||
        typeof platform !== "object" ||
        Array.isArray(platform)
      ) {
        return false;
      }
      if ((platform as Record<string, unknown>).enabled === false) return false;
      const posts = (platform as Record<string, unknown>).posts;
      if (!Array.isArray(posts) || posts.length !== snapshot.posts.length) {
        return false;
      }
      for (let index = 0; index < posts.length; index += 1) {
        const post = posts[index];
        if (!post || typeof post !== "object" || Array.isArray(post))
          return false;
        const text = (post as Record<string, unknown>).text;
        if (text !== snapshot.posts[index]?.[destination]) return false;
        const actualMedia = (post as Record<string, unknown>).media_ids ?? [];
        const expectedMedia = snapshot.media
          .map((media) => media.remoteId)
          .filter((id): id is string => id !== null);
        if (
          !Array.isArray(actualMedia) ||
          JSON.stringify(actualMedia.map(String)) !==
            JSON.stringify(expectedMedia)
        ) {
          return false;
        }
      }
    }
    if (
      Object.hasOwn(record, "draft_title") &&
      record.draft_title !== snapshot.title
    ) {
      return false;
    }
    const status = record.status;
    const scheduledDate = record.scheduled_date ?? null;
    if (typeof status !== "string") return false;
    if (snapshot.scheduleAt === null) {
      if (status !== "draft" || scheduledDate !== null) return false;
    } else {
      if (status !== "planned" || typeof scheduledDate !== "string") {
        return false;
      }
      const approvedTime = Date.parse(snapshot.scheduleAt);
      const remoteTime = Date.parse(scheduledDate);
      if (
        !Number.isFinite(approvedTime) ||
        !Number.isFinite(remoteTime) ||
        approvedTime !== remoteTime
      ) {
        return false;
      }
    }
    return true;
  }
}

const safeField = z
  .string()
  .max(SAFE_VENDOR_FIELD_CHARS)
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
const safeUrl = safeField.refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
});

export function safePublicationOutcome(
  value: PublicationOutcome,
): PublicationOutcome {
  return {
    outcome: value.outcome,
    ...(value.vendorResultId === undefined
      ? {}
      : { vendorResultId: safeField.parse(value.vendorResultId) }),
    ...(value.publishedUrl === undefined
      ? {}
      : { publishedUrl: safeUrl.parse(value.publishedUrl) }),
    ...(value.detail === undefined
      ? {}
      : { detail: safeField.parse(value.detail) }),
  };
}
