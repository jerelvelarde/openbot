import { IconArrowRight } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  defineGalleryComponent,
  type GalleryComponent,
} from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame, type Tone } from "./frame";

const destinationSchema = z.enum(["x", "linkedin"]);

/** The durable sync/proposal states emitted by the server, plus its safe not-found refusal. */
export const TYPEFULLY_DRAFT_STATUSES = [
  "local",
  "syncing",
  "synced",
  "connection_required",
  "remote_error",
  "grant_blocked",
  "pending",
  "in_flight",
  "declined",
  "expired",
  "published",
  "failed",
  "unknown",
  "draft_not_found",
] as const;

const draftDisplayStatusSchema = z.enum(TYPEFULLY_DRAFT_STATUSES);
export type DraftDisplayStatus = z.infer<typeof draftDisplayStatusSchema>;

export const TypefullyDraftProps = z.strictObject({
  draftId: z.string().uuid(),
  title: z.string().max(160),
  destinations: z
    .array(destinationSchema)
    .min(1)
    .max(2)
    .refine(
      (destinations) => new Set(destinations).size === destinations.length,
      "Destinations must be unique.",
    ),
  socialSetLabel: z.string().max(160).optional(),
  mediaCount: z.number().int().min(0).max(20),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: draftDisplayStatusSchema,
});

type TypefullyDraftArgs = z.infer<typeof TypefullyDraftProps>;

const STATUS: Record<
  DraftDisplayStatus,
  { label: string; tone: Tone; detail?: string }
> = {
  local: { label: "Saved in OpenBot", tone: "neutral" },
  syncing: { label: "Saving…", tone: "neutral" },
  synced: { label: "Saved to Typefully", tone: "positive" },
  connection_required: {
    label: "Connect Typefully",
    tone: "caution",
    detail: "Connect your Typefully account from the draft panel to sync it.",
  },
  remote_error: {
    label: "Not saved to Typefully",
    tone: "negative",
    detail:
      "Your OpenBot draft is safe. Review it and retry the Typefully sync.",
  },
  grant_blocked: {
    label: "Typefully access unavailable",
    tone: "caution",
    detail:
      "Typefully access is unavailable for this Bot. You can still review the draft saved in OpenBot.",
  },
  pending: { label: "Waiting for approval", tone: "caution" },
  in_flight: { label: "Publishing…", tone: "neutral" },
  declined: { label: "Declined", tone: "neutral" },
  expired: { label: "Changed — review again", tone: "caution" },
  published: { label: "Published", tone: "positive" },
  failed: {
    label: "Publishing failed",
    tone: "negative",
    detail: "Review the draft before trying another publication action.",
  },
  unknown: {
    label: "Publishing status unknown",
    tone: "caution",
    detail:
      "Review and reconcile the Typefully result before publishing again.",
  },
  draft_not_found: {
    label: "Draft unavailable",
    tone: "negative",
    detail:
      "This draft is no longer available. Ask the Bot to create a new draft.",
  },
};

const destinationLabel: Record<
  TypefullyDraftArgs["destinations"][number],
  string
> = {
  x: "X",
  linkedin: "LinkedIn",
};

/** A summary-only view: it does not fetch the authoritative draft or render remote media. */
export function TypefullyDraftSummary({
  title,
  destinations,
  socialSetLabel,
  mediaCount,
  version,
  status,
  onReview,
}: TypefullyDraftArgs & { onReview: () => void }) {
  const state = STATUS[status];
  const unavailable = status === "draft_not_found";

  return (
    <GalleryFrame
      action={
        unavailable ? undefined : (
          <Button onClick={onReview} size="sm" variant="outline">
            Review draft
            <IconArrowRight aria-hidden="true" />
          </Button>
        )
      }
      caption="Typefully draft"
      title={title || "Untitled draft"}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={state.tone}>{state.label}</Badge>
        {destinations.map((destination) => (
          <Badge key={destination}>{destinationLabel[destination]}</Badge>
        ))}
      </div>
      <dl className="mt-3 grid grid-cols-[minmax(0,8rem)_1fr] gap-x-4 gap-y-2 text-sm">
        <div className="contents">
          <dt className="text-muted-foreground">Social set</dt>
          <dd className="min-w-0 break-words">
            {socialSetLabel || "Not selected"}
          </dd>
        </div>
        <div className="contents">
          <dt className="text-muted-foreground">Attachments</dt>
          <dd>{mediaCount === 1 ? "1 media item" : `${mediaCount} media`}</dd>
        </div>
        <div className="contents">
          <dt className="text-muted-foreground">Revision</dt>
          <dd>Version {version}</dd>
        </div>
      </dl>
      {state.detail ? (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          {state.detail}
        </p>
      ) : null}
    </GalleryFrame>
  );
}

export function TypefullyDraft(props: Partial<TypefullyDraftArgs>) {
  const navigate = useNavigate();
  const parsed = TypefullyDraftProps.safeParse(props);
  if (!parsed.success) {
    return (
      <GalleryFrame title="Typefully draft">
        <p className="text-sm text-muted-foreground" role="status">
          This draft summary is unavailable. Ask the Bot to show it again.
        </p>
      </GalleryFrame>
    );
  }

  const draft = parsed.data;
  return (
    <TypefullyDraftSummary
      {...draft}
      onReview={() => {
        void navigate({
          to: ".",
          search: (previous) => ({
            ...previous,
            settings: undefined,
            watch: undefined,
            draft: draft.draftId,
          }),
        });
      }}
    />
  );
}

export const GALLERY: GalleryComponent[] = [
  defineGalleryComponent({
    name: "showTypefullyDraft",
    title: "Typefully draft",
    kind: "card",
    description:
      "Show a bounded summary of an OpenBot Typefully draft with a review action. Pass only the local draft id and summary fields; never pass post bodies, media URLs, credentials, snapshots, or user identifiers.",
    parameters: TypefullyDraftProps,
    Component: TypefullyDraft as GalleryComponent["Component"],
    preview: {
      draftId: "8b1c61f1-2154-4a5d-8c9a-7c8df8f9ae53",
      title: "Launch notes",
      destinations: ["x", "linkedin"],
      socialSetLabel: "Product team",
      mediaCount: 2,
      version: 3,
      status: "synced",
    },
    confirmation:
      "The Typefully draft summary is now on screen for the person.",
  }),
];
