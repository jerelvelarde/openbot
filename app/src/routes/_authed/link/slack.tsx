import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
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

class InvalidSlackLinkError extends Error {}

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

async function loadSlackClaim(token: string): Promise<SlackClaim> {
  const response = await tryClient(
    `/api/external-links/slack?token=${encodeURIComponent(token)}`,
  );

  if (!response.ok) {
    if (response.status === 400) throw new InvalidSlackLinkError();
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

  if (
    response.status === 200 ||
    response.status === 409 ||
    response.status === 400
  ) {
    return slackLinkResult(response.status);
  }

  return slackLinkFailure(response.status);
}

function SlackLinkPage() {
  const { token } = Route.useSearch();
  const submitted = useRef(false);
  const [outcome, setOutcome] = useState<
    SlackLinkCompletion | SlackLinkFailure | null
  >(null);
  const claim = useQuery({
    // Do not place the secret token in a React Query cache key.
    queryKey: ["slack-link-claim"],
    queryFn: () => loadSlackClaim(token ?? ""),
    enabled: token !== undefined,
    retry: false,
  });
  const link = useMutation({
    mutationFn: () => completeSlackLink(token ?? ""),
    onSuccess: setOutcome,
    onError: () => setOutcome(slackLinkFailure()),
    onSettled: () => {
      submitted.current = false;
    },
  });

  if (!token) {
    return <TerminalOutcome outcome={slackLinkResult(400)} />;
  }

  if (claim.isPending) {
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

  if (claim.isError) {
    if (claim.error instanceof InvalidSlackLinkError) {
      return <TerminalOutcome outcome={slackLinkResult(400)} />;
    }

    return (
      <PageShell title="Link Slack">
        <PageSection>
          <p className="text-destructive text-sm" role="alert">
            Slack could not be checked right now. Try again.
          </p>
          <Button
            className="mt-4"
            onClick={() => claim.refetch()}
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
    link.mutate();
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
          <ClaimField
            label="Slack workspace"
            value={claim.data?.workspace ?? ""}
          />
          <ClaimField label="Slack user" value={claim.data?.user ?? ""} />
          {claim.data?.email !== undefined ? (
            <ClaimField label="Slack email" value={claim.data.email} />
          ) : null}
        </dl>
      </PageSection>

      <PageSection>
        {outcome ? (
          <p className="text-destructive text-sm" role="alert">
            {outcome.message}
          </p>
        ) : null}
        <Button disabled={link.isPending} onClick={submit} type="button">
          {link.isPending ? "Linking Slack…" : "Link Slack"}
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
