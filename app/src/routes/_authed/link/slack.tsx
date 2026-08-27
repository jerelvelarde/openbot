import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useReducer, useRef, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { tryClient } from "@/lib/client";

type SlackClaim = {
  workspace: string;
  user: string;
  email?: string;
};

type SlackLinkFailure = {
  kind: "error";
  message: string;
};

type SlackLinkCompletion = ReturnType<typeof slackLinkResult>;

type SlackClaimState =
  | { kind: "loading"; requestId: number }
  | { kind: "ready"; requestId: number; claim: SlackClaim }
  | { kind: "terminal"; requestId: number; outcome: SlackLinkCompletion }
  | { kind: "error"; requestId: number };

type SlackClaimAction =
  | { type: "start"; requestId: number }
  | { type: "ready"; requestId: number; claim: SlackClaim }
  | { type: "terminal"; requestId: number; outcome: SlackLinkCompletion }
  | { type: "error"; requestId: number };

class SlackLinkTerminalError extends Error {
  constructor(readonly outcome: SlackLinkCompletion) {
    super(outcome.message);
  }
}

export const Route = createFileRoute("/_authed/link/slack")({
  validateSearch: (search: Record<string, unknown>): { token?: string } => {
    const token = slackLinkToken(search);
    return token ? { token } : {};
  },
  component: SlackLinkPage,
});

/** A claim token is opaque: trim it for the request, but never render or store it as page data. */
export function slackLinkToken(search: Record<string, unknown>): string | null {
  if (typeof search.token !== "string") return null;

  const token = search.token.trim();
  return token === "" ? null : token;
}

export function slackLinkResult(status: number) {
  if (status === 200)
    return {
      kind: "linked",
      message: "Slack is linked to your OpenBot account.",
    } as const;
  if (status === 409)
    return {
      kind: "conflict",
      message:
        "That Slack identity is already linked to another OpenBot account.",
    } as const;
  return {
    kind: "invalid",
    message:
      "This Slack link has expired or is invalid. Return to Slack and try again.",
  } as const;
}

/** Non-token server failures are retryable, unlike the terminal completion results above. */
export function slackLinkFailure(_status?: number): SlackLinkFailure {
  return {
    kind: "error",
    message: "Slack could not be linked right now. Try again.",
  };
}

/**
 * A response can be retried only when the server failed to serve it. Every other HTTP refusal is a
 * terminal claim result, so an expired token is never presented as an invitation to retry forever.
 * Omitting a status represents a network error before an HTTP response existed.
 */
export function slackLinkResponseOutcome(status?: number) {
  if (status === undefined || (status >= 500 && status <= 599)) {
    return slackLinkFailure(status);
  }
  return slackLinkResult(status);
}

/** Mutation state needs only an epoch to reject a response for an older page token. */
export function slackLinkMutationVariables(version: number) {
  return { version };
}

/**
 * Deliberately selects the three fields this page may show. In particular, a response cannot add a
 * token-shaped field and have it accidentally find its way into the UI.
 */
export function slackLinkClaim(value: unknown): SlackClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const claim = value as {
    providerTenantId?: unknown;
    providerUserId?: unknown;
    providerEmail?: unknown;
  };
  const workspace = nonEmptyDisplayString(claim.providerTenantId);
  const user = nonEmptyDisplayString(claim.providerUserId);

  if (!workspace || !user) return null;
  if (claim.providerEmail === null) return { workspace, user };

  const email = nonEmptyDisplayString(claim.providerEmail);
  return email ? { workspace, user, email } : null;
}

function nonEmptyDisplayString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const display = value.trim();
  return display === "" ? null : display;
}

/** A newer claim request owns the screen; late results from an older one are ignored. */
export function slackLinkClaimState(
  state: SlackClaimState | null,
  action: SlackClaimAction,
): SlackClaimState | null {
  if (action.type === "start") {
    return { kind: "loading", requestId: action.requestId };
  }

  if (state?.requestId !== action.requestId) return state;

  switch (action.type) {
    case "ready":
      return {
        kind: "ready",
        requestId: action.requestId,
        claim: action.claim,
      };
    case "terminal":
      return {
        kind: "terminal",
        requestId: action.requestId,
        outcome: action.outcome,
      };
    case "error":
      return { kind: "error", requestId: action.requestId };
  }
}

async function loadSlackClaim(
  token: string,
  signal: AbortSignal,
): Promise<SlackClaim> {
  const response = await tryClient(
    `/api/external-links/slack?token=${encodeURIComponent(token)}`,
    { signal },
  );

  if (!response.ok) {
    const outcome = slackLinkResponseOutcome(response.status);
    if (outcome.kind !== "error") throw new SlackLinkTerminalError(outcome);
    throw new Error("Could not load Slack link.");
  }

  const claim = slackLinkClaim(await response.json().catch(() => null));
  if (!claim) throw new Error("Could not read Slack link.");
  return claim;
}

async function completeSlackLink(
  token: string,
): Promise<SlackLinkCompletion | SlackLinkFailure> {
  const response = await tryClient("/api/external-links/slack", {
    method: "POST",
    body: { token },
  });

  return slackLinkResponseOutcome(response.status);
}

function SlackLinkPage() {
  const { token } = Route.useSearch();
  const submitted = useRef(false);
  const tokenVersion = useRef(0);
  const visibleToken = useRef(token);
  const requestId = useRef(0);
  const tokenChanged = visibleToken.current !== token;
  if (tokenChanged) {
    visibleToken.current = token;
    tokenVersion.current += 1;
  }

  const [outcome, setOutcome] = useState<
    SlackLinkCompletion | SlackLinkFailure | null
  >(null);
  const [claim, dispatchClaim] = useReducer(slackLinkClaimState, null);
  const [retry, setRetry] = useState(0);
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);

  useEffect(() => {
    // The retry counter gives a retry its own generation even when the token did not change.
    requestId.current += retry + 1;
    const nextRequestId = requestId.current;
    setOutcome(null);
    submitted.current = false;
    setPendingVersion(null);
    dispatchClaim({ type: "start", requestId: nextRequestId });

    if (!token) {
      dispatchClaim({
        type: "terminal",
        requestId: nextRequestId,
        outcome: slackLinkResult(400),
      });
      return;
    }

    const controller = new AbortController();
    loadSlackClaim(token, controller.signal)
      .then((loaded) =>
        dispatchClaim({
          type: "ready",
          requestId: nextRequestId,
          claim: loaded,
        }),
      )
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof SlackLinkTerminalError) {
          dispatchClaim({
            type: "terminal",
            requestId: nextRequestId,
            outcome: error.outcome,
          });
          return;
        }
        dispatchClaim({ type: "error", requestId: nextRequestId });
      });

    return () => controller.abort();
  }, [retry, token]);

  const link = useMutation({
    mutationFn: (_variables: ReturnType<typeof slackLinkMutationVariables>) =>
      completeSlackLink(token ?? ""),
    onSuccess: (nextOutcome, variables) => {
      if (variables.version === tokenVersion.current) setOutcome(nextOutcome);
    },
    onError: (_error, variables) => {
      if (variables.version === tokenVersion.current) {
        setOutcome(slackLinkFailure());
      }
    },
    onSettled: (_data, _error, variables) => {
      if (variables.version === tokenVersion.current) {
        submitted.current = false;
        setPendingVersion(null);
      }
    },
  });

  if (!token) {
    return <TerminalOutcome outcome={slackLinkResult(400)} />;
  }

  if (tokenChanged || !claim || claim.kind === "loading") {
    return (
      <PageShell
        description="Checking the Slack identity that asked to be linked."
        title="Link Slack"
      >
        <p className="mt-12 text-muted-foreground text-sm" role="status">
          Loading Slack link…
        </p>
      </PageShell>
    );
  }

  if (claim.kind === "terminal") {
    return <TerminalOutcome outcome={claim.outcome} />;
  }

  if (claim.kind === "error") {
    return (
      <PageShell title="Link Slack">
        <PageSection>
          <p className="text-destructive text-sm" role="alert">
            Slack could not be checked right now. Try again.
          </p>
          <Button
            className="mt-4"
            onClick={() => setRetry((current) => current + 1)}
            type="button"
          >
            Try again
          </Button>
        </PageSection>
      </PageShell>
    );
  }

  const submit = () => {
    if (submitted.current) return;
    submitted.current = true;
    setOutcome(null);
    const version = tokenVersion.current;
    setPendingVersion(version);
    link.mutate(slackLinkMutationVariables(version));
  };

  if (outcome && outcome.kind !== "error") {
    return <TerminalOutcome outcome={outcome} />;
  }

  return (
    <PageShell
      description="Confirm that this is the Slack identity you want to link to your OpenBot account."
      title="Link Slack"
    >
      <PageSection title="Slack identity">
        <dl className="mt-4 rounded-lg border border-border bg-card text-sm">
          <ClaimField label="Slack workspace" value={claim.claim.workspace} />
          <ClaimField label="Slack user" value={claim.claim.user} />
          {claim.claim.email !== undefined ? (
            <ClaimField label="Slack email" value={claim.claim.email} />
          ) : null}
        </dl>
      </PageSection>

      <PageSection>
        {outcome ? (
          <p className="text-destructive text-sm" role="alert">
            {outcome.message}
          </p>
        ) : null}
        <Button
          disabled={pendingVersion === tokenVersion.current}
          onClick={submit}
          type="button"
        >
          {pendingVersion === tokenVersion.current
            ? "Linking Slack…"
            : "Link Slack"}
        </Button>
      </PageSection>
    </PageShell>
  );
}

function ClaimField({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border border-b px-4 py-3 last:border-b-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function TerminalOutcome({ outcome }: { outcome: SlackLinkCompletion }) {
  return (
    <PageShell title="Link Slack">
      <PageSection>
        <p
          className={
            outcome.kind === "linked" ? "text-sm" : "text-destructive text-sm"
          }
          role={outcome.kind === "linked" ? "status" : "alert"}
        >
          {outcome.message}
        </p>
      </PageSection>
    </PageShell>
  );
}
