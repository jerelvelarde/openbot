import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { PlatformPreview } from "@/components/typefully/platform-preview";
import {
  defineGalleryComponent,
  type GalleryComponent,
} from "@/lib/copilot/gallery-registry";
import {
  declineProposalMutationOptions,
  publishProposalMutationOptions,
  reconcileProposalMutationOptions,
} from "@/lib/typefully/mutations";
import {
  type ProposalSummary,
  type PublicationProposal,
  proposalMatchesSummary,
  proposalQueryOptions,
  TypefullyClientError,
  typefullyKeys,
} from "@/lib/typefully/queries";
import { Badge, GalleryFrame } from "./frame";

const destinationSchema = z.enum(["x", "linkedin"]);
const boundedDateSchema = z.string().max(64).datetime();
export const TypefullyPublicationArgs = z.strictObject({
  proposalId: z.string().uuid(),
  draftId: z.string().uuid(),
  destinations: z
    .array(destinationSchema)
    .min(1)
    .max(2)
    .refine((items) => new Set(items).size === items.length),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: boundedDateSchema,
});

type PublicationArgs = z.infer<typeof TypefullyPublicationArgs>;

function statusFor(proposal: PublicationProposal) {
  if (
    proposal.status === "pending" &&
    Date.parse(proposal.expiresAt) <= Date.now()
  ) {
    return "expired" as const;
  }
  return proposal.status;
}

function safeDetail(value: string | null) {
  if (!value) return null;
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
      ),
  )
    .slice(0, 240)
    .join("");
}

export function TypefullyProposalReview({
  proposal,
  busy = false,
  error = null,
  onDecline,
  onManualHandoff,
  onPublish,
  onReconcile,
  onReviewAgain,
}: {
  proposal: PublicationProposal;
  busy?: boolean;
  error?: string | null;
  onDecline?: () => void;
  onManualHandoff?: () => void;
  onPublish?: () => void;
  onReconcile?: () => void;
  onReviewAgain?: () => void;
}) {
  const status = statusFor(proposal);
  const terminal = {
    declined: "Publication declined",
    expired: "Review expired",
    published: "Published",
    failed: "Typefully could not publish",
    unknown: "Publishing status unknown",
  } as const;
  return (
    <section
      aria-label="Typefully publication review"
      className="space-y-4 rounded-[8px] border-2 border-border bg-card/50 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Immutable publication review</h3>
          <p className="text-xs text-muted-foreground">
            Version {proposal.version} · Expires{" "}
            {new Date(proposal.expiresAt).toLocaleString()}
          </p>
        </div>
        <Badge
          tone={
            status === "published"
              ? "positive"
              : status === "pending"
                ? "caution"
                : "neutral"
          }
        >
          {status === "pending"
            ? "Approval required"
            : status === "in_flight"
              ? "Publishing…"
              : terminal[status]}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Destinations:{" "}
        {proposal.destinations
          .map((item) => (item === "x" ? "X" : "LinkedIn"))
          .join(", ")}
      </p>
      <div className="space-y-3">
        {proposal.destinations.map((destination) => (
          <PlatformPreview
            document={proposal.snapshot}
            draftId={proposal.draftId}
            key={destination}
            platform={destination}
            viewport="desktop"
          />
        ))}
      </div>
      {status === "unknown" ? (
        <div className="space-y-2 text-sm" role="alert">
          <strong>Publishing status unknown</strong>
          <p className="text-muted-foreground">
            Do not try publishing again. Reconcile the result or check Typefully
            manually.
          </p>
          <a
            className="text-primary underline underline-offset-4"
            href="https://typefully.com/drafts"
            onClick={onManualHandoff}
            rel="noreferrer"
            target="_blank"
          >
            Continue in Typefully
          </a>
          <button
            className="rounded-[8px] border border-border bg-card px-3 py-2 disabled:opacity-50"
            disabled={busy || !onReconcile}
            onClick={onReconcile}
            type="button"
          >
            Check publication status
          </button>
        </div>
      ) : status === "failed" ? (
        <p className="text-sm text-destructive" role="alert">
          {safeDetail(proposal.failureDetail) ??
            "Typefully could not publish this reviewed snapshot."}
        </p>
      ) : status !== "pending" && status !== "in_flight" ? (
        <p className="text-sm" role="status">
          {terminal[status]}
        </p>
      ) : null}
      {status === "published" && proposal.publishedUrl ? (
        <a
          className="text-sm text-primary underline underline-offset-4"
          href={proposal.publishedUrl}
          rel="noreferrer"
          target="_blank"
        >
          View published post
        </a>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {safeDetail(error)}
        </p>
      ) : null}
      {status === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm disabled:opacity-50"
            disabled={busy || !onDecline}
            onClick={onDecline}
            type="button"
          >
            Decline
          </button>
          <button
            className="rounded-[8px] bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            disabled={busy || !onPublish}
            onClick={onPublish}
            type="button"
          >
            {busy ? "Publishing…" : "Publish now"}
          </button>
        </div>
      ) : status === "expired" || status === "failed" ? (
        onReviewAgain ? (
          <button
            className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm disabled:opacity-50"
            onClick={onReviewAgain}
            type="button"
          >
            Review again
          </button>
        ) : (
          <p className="text-sm text-muted-foreground">
            Return to the draft to prepare a new review.
          </p>
        )
      ) : null}
    </section>
  );
}

type ReviewLoaderProps = {
  summary: ProposalSummary;
  respond?: (result: unknown) => Promise<void>;
  onReviewAgain?: () => void;
};

type ProposalRefusalReason =
  | "unavailable"
  | "access_revoked"
  | "bot_not_attached"
  | "channel_forbidden"
  | "grant_required"
  | "remote_refused";

function proposalRefusalReason(error: unknown): ProposalRefusalReason | null {
  if (!(error instanceof TypefullyClientError)) return null;
  if (error.code === "draft_not_found") return "unavailable";
  if (
    error.code === "access_revoked" ||
    error.code === "bot_not_attached" ||
    error.code === "channel_forbidden" ||
    error.code === "grant_required" ||
    error.code === "remote_refused"
  ) {
    return error.code;
  }
  return null;
}

export function TypefullyProposalReviewLoader({
  summary,
  respond,
  onReviewAgain,
}: ReviewLoaderProps) {
  const queryClient = useQueryClient();
  const [actionAuthorityUnknown, setActionAuthorityUnknown] = useState(false);
  const [statusCheckBusy, setStatusCheckBusy] = useState(false);
  const proposalOptions = proposalQueryOptions(summary.id);
  const query = useQuery({
    ...proposalOptions,
    enabled: proposalOptions.enabled && !actionAuthorityUnknown,
  });
  const publish = useMutation(publishProposalMutationOptions(queryClient));
  const decline = useMutation(declineProposalMutationOptions(queryClient));
  const reconcile = useMutation(reconcileProposalMutationOptions(queryClient));
  const answered = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const answer = useCallback(
    async (result: unknown) => {
      if (!respond || answered.current) return;
      answered.current = true;
      await respond(result);
    },
    [respond],
  );
  const authoritative = query.data?.proposal;
  const bound = authoritative && proposalMatchesSummary(authoritative, summary);
  const effectiveStatus = bound ? statusFor(authoritative) : null;
  const refusalReason = proposalRefusalReason(query.error);

  const recoverActionAuthority = async () => {
    setActionAuthorityUnknown(true);
    setStatusCheckBusy(true);
    setActionError(null);
    queryClient.removeQueries({
      queryKey: typefullyKeys.proposal(summary.id),
      exact: true,
    });
    const refreshed = await query.refetch();
    setStatusCheckBusy(false);
    const latest = refreshed.data?.proposal;
    if (!latest) {
      if (proposalRefusalReason(refreshed.error)) {
        setActionAuthorityUnknown(false);
        return;
      }
      queryClient.removeQueries({
        queryKey: typefullyKeys.proposal(summary.id),
        exact: true,
      });
      setActionError(
        "Publication status could not be confirmed. Check the status again before taking any other action.",
      );
      return;
    }
    if (!proposalMatchesSummary(latest, summary)) {
      setActionAuthorityUnknown(false);
      try {
        await answer({
          outcome: "changed",
          proposalId: summary.id,
          draftId: summary.draftId,
          version: summary.version,
        });
      } catch {
        setActionError("The publication decision could not be sent.");
      }
      return;
    }
    const latestStatus = statusFor(latest);
    if (latestStatus === "pending" || latestStatus === "in_flight") {
      queryClient.removeQueries({
        queryKey: typefullyKeys.proposal(summary.id),
        exact: true,
      });
      setActionError(
        "Publication status is not yet conclusive. Check again before taking any other action.",
      );
      return;
    }
    setActionAuthorityUnknown(false);
    if (latestStatus === "unknown") return;
    try {
      await answer({
        outcome: latestStatus,
        proposalId: latest.id,
        draftId: latest.draftId,
        version: latest.version,
      });
    } catch {
      setActionError("The publication decision could not be sent.");
    }
  };

  useEffect(() => {
    if (!respond) return;
    if (refusalReason) {
      void answer({
        outcome: "refused",
        proposalId: summary.id,
        draftId: summary.draftId,
        version: summary.version,
        reason: refusalReason,
      }).catch(() =>
        setActionError(
          "The publication decision could not be sent. Try again.",
        ),
      );
      return;
    }
    if (!authoritative) return;
    if (!bound) {
      void answer({
        outcome: "changed",
        proposalId: summary.id,
        draftId: summary.draftId,
        version: summary.version,
      }).catch(() =>
        setActionError(
          "The publication decision could not be sent. Try again.",
        ),
      );
      return;
    }
    if (
      effectiveStatus === "pending" ||
      effectiveStatus === "in_flight" ||
      effectiveStatus === "unknown"
    )
      return;
    void answer({
      outcome: effectiveStatus,
      proposalId: authoritative.id,
      draftId: authoritative.draftId,
      version: authoritative.version,
    }).catch(() =>
      setActionError("The publication decision could not be sent. Try again."),
    );
  }, [
    answer,
    authoritative,
    bound,
    effectiveStatus,
    refusalReason,
    respond,
    summary,
  ]);

  if (actionAuthorityUnknown) {
    return (
      <section
        aria-label="Typefully publication status"
        className="space-y-3 rounded-[8px] border-2 border-border bg-card/50 p-4"
      >
        <Badge tone="neutral">Publishing status unknown</Badge>
        <div className="space-y-2 text-sm" role="alert">
          <strong>Publishing status unknown</strong>
          <p className="text-muted-foreground">
            The last action may have completed. Do not publish or decline again.
            Check the authoritative status first.
          </p>
          {actionError ? (
            <p className="text-destructive">{actionError}</p>
          ) : null}
        </div>
        <button
          className="rounded-[8px] border border-border bg-card px-3 py-2 text-sm disabled:opacity-50"
          disabled={statusCheckBusy}
          onClick={() => void recoverActionAuthority()}
          type="button"
        >
          {statusCheckBusy ? "Checking status…" : "Check publication status"}
        </button>
      </section>
    );
  }
  if (query.isPending) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading immutable publication review…
      </p>
    );
  }
  if (refusalReason) {
    return (
      <div className="space-y-2 text-sm text-destructive" role="alert">
        <p>This publication review is unavailable.</p>
        <p>No proposal content was disclosed.</p>
        {actionError ? <p>{actionError}</p> : null}
      </div>
    );
  }
  if (query.error || !authoritative) {
    return (
      <div className="space-y-2 text-sm" role="alert">
        <p className="text-destructive">
          This publication review could not be loaded. Try again.
        </p>
        <button
          className="rounded-[8px] border border-border bg-card px-3 py-2 disabled:opacity-50"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
          type="button"
        >
          {query.isFetching ? "Retrying…" : "Retry"}
        </button>
      </div>
    );
  }
  if (!bound) {
    return (
      <div className="space-y-2" role="alert">
        <p>The draft changed. This approval cannot be reused.</p>
        {onReviewAgain ? (
          <button onClick={onReviewAgain} type="button">
            Review again
          </button>
        ) : (
          <p>Return to the draft and prepare a new review.</p>
        )}
      </div>
    );
  }

  const finish = async (kind: "publish" | "decline") => {
    setActionError(null);
    let completed: PublicationProposal | null = null;
    try {
      const result = await (kind === "publish" ? publish : decline).mutateAsync(
        {
          proposalId: summary.id,
          draftId: summary.draftId,
          version: summary.version,
          destinations: summary.destinations,
          expiresAt: summary.expiresAt,
          status: "pending",
        },
      );
      completed = result.proposal;
    } catch (error) {
      if (
        error instanceof TypefullyClientError &&
        error.code === "remote_invalid_response"
      ) {
        await recoverActionAuthority();
        return;
      }
      const refreshed = await query.refetch();
      const latest = refreshed.data?.proposal;
      if (
        latest &&
        proposalMatchesSummary(latest, summary) &&
        statusFor(latest) !== "pending" &&
        statusFor(latest) !== "in_flight" &&
        statusFor(latest) !== "unknown"
      ) {
        try {
          await answer({
            outcome: statusFor(latest),
            proposalId: latest.id,
            draftId: latest.draftId,
            version: latest.version,
          });
        } catch {
          setActionError("The publication decision could not be sent.");
        }
      } else {
        setActionError(
          error instanceof TypefullyClientError
            ? error.message
            : "The publication decision could not be completed. Try again.",
        );
      }
    }
    if (!completed) return;
    if (completed.status === "unknown") return;
    try {
      await answer({
        outcome: completed.status,
        proposalId: completed.id,
        draftId: completed.draftId,
        version: completed.version,
      });
    } catch {
      setActionError("The publication decision could not be sent.");
    }
  };
  const reconcileUnknown = async () => {
    setActionError(null);
    try {
      const result = await reconcile.mutateAsync({
        proposalId: summary.id,
        draftId: summary.draftId,
        version: summary.version,
        destinations: summary.destinations,
        expiresAt: summary.expiresAt,
        status: "unknown",
      });
      if (result.proposal.status === "unknown") return;
      await answer({
        outcome: result.proposal.status,
        proposalId: result.proposal.id,
        draftId: result.proposal.draftId,
        version: result.proposal.version,
      });
    } catch (error) {
      setActionError(
        error instanceof TypefullyClientError
          ? error.message
          : "The publication status could not be checked. Try again.",
      );
    }
  };
  return (
    <TypefullyProposalReview
      busy={publish.isPending || decline.isPending || reconcile.isPending}
      error={actionError}
      onDecline={() => void finish("decline")}
      onManualHandoff={() => {
        void answer({
          outcome: "unknown",
          proposalId: authoritative.id,
          draftId: authoritative.draftId,
          version: authoritative.version,
        }).catch(() =>
          setActionError("The publication decision could not be sent."),
        );
      }}
      onPublish={() => void finish("publish")}
      onReconcile={() => void reconcileUnknown()}
      onReviewAgain={onReviewAgain}
      proposal={authoritative}
    />
  );
}

type DecisionProps = {
  status: "inProgress" | "executing" | "complete";
  args: Partial<PublicationArgs>;
  respond?: (result: unknown) => Promise<void>;
  onOpenDraft?: (draftId: string) => void;
};

export function TypefullyPublicationDecision({
  status,
  args,
  respond,
  onOpenDraft,
}: DecisionProps) {
  const parsed = TypefullyPublicationArgs.safeParse(args);
  const draftId = parsed.success ? parsed.data.draftId : undefined;
  useEffect(() => {
    if (draftId) onOpenDraft?.(draftId);
  }, [draftId, onOpenDraft]);
  if (status === "complete") {
    return (
      <GalleryFrame title="Typefully publication">
        <Badge tone="positive">Answered</Badge>
      </GalleryFrame>
    );
  }
  if (status === "inProgress" || !parsed.success) {
    return (
      <GalleryFrame title="Typefully publication">
        <p role="status">Preparing publication review…</p>
      </GalleryFrame>
    );
  }
  const request = parsed.data;
  return (
    <GalleryFrame title="Typefully publication">
      <TypefullyProposalReviewLoader
        respond={respond}
        summary={{
          id: request.proposalId,
          draftId: request.draftId,
          destinations: request.destinations,
          version: request.version,
          expiresAt: request.expiresAt,
          status: "pending",
        }}
      />
    </GalleryFrame>
  );
}

function RoutedTypefullyPublicationDecision(props: DecisionProps) {
  const navigate = useNavigate();
  const openDraft = useCallback(
    (draftId: string) => {
      void navigate({
        to: ".",
        search: (previous) => ({
          ...previous,
          settings: undefined,
          watch: undefined,
          draft: draftId,
        }),
      });
    },
    [navigate],
  );
  return <TypefullyPublicationDecision {...props} onOpenDraft={openDraft} />;
}

export const GALLERY: GalleryComponent[] = [
  defineGalleryComponent({
    name: "approveTypefullyPublication",
    title: "Approve Typefully publication",
    kind: "decision",
    defaultPublished: false,
    grantMode: "explicit",
    description:
      "Ask the person to review and decide one immutable Typefully publication proposal. Pass only the proposal id, local draft id, destinations, version, and expiry. Never pass draft content or credentials.",
    parameters: TypefullyPublicationArgs,
    Component:
      RoutedTypefullyPublicationDecision as GalleryComponent["Component"],
  }),
];
