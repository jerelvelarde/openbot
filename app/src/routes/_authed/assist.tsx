import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { tryClient } from "@/lib/client";

type AssistanceOutcome =
  | { kind: "loading" }
  | { kind: "ready"; href: string }
  | { kind: "invalid" }
  | { kind: "wrong-user" }
  | { kind: "error" };

export const Route = createFileRoute("/_authed/assist")({
  validateSearch: (search: Record<string, unknown>): { token?: string } => {
    const token = assistanceToken(search);
    return token ? { token } : {};
  },
  component: AssistancePage,
});

/** The sealed claim remains opaque and is never rendered or cached. */
export function assistanceToken(
  search: Record<string, unknown>,
): string | null {
  if (typeof search.token !== "string") return null;
  return search.token.trim() || null;
}

export function assistanceResponseOutcome(
  status: number,
  body: unknown,
): Exclude<AssistanceOutcome, { kind: "loading" }> {
  if (status === 403) return { kind: "wrong-user" };
  if (status === 410) return { kind: "invalid" };
  if (
    status !== 200 ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return { kind: "error" };
  }
  const agentId = (body as { agentId?: unknown }).agentId;
  if (typeof agentId !== "string" || agentId.trim() === "") {
    return { kind: "error" };
  }
  return { kind: "ready", href: `/bot?agent=${encodeURIComponent(agentId)}` };
}

async function loadAssistance(
  token: string,
  signal: AbortSignal,
): Promise<Exclude<AssistanceOutcome, { kind: "loading" }>> {
  try {
    const response = await tryClient(
      `/api/external-links/assistance?token=${encodeURIComponent(token)}`,
      { signal },
    );
    const body = await response.json().catch(() => null);
    return assistanceResponseOutcome(response.status, body);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    return { kind: "error" };
  }
}

function AssistancePage() {
  const { token } = Route.useSearch();
  if (!token) return <AssistanceStatus outcome={{ kind: "invalid" }} />;
  return <AssistanceLoader key={token} token={token} />;
}

function AssistanceLoader({ token }: { token: string }) {
  const [outcome, setOutcome] = useState<AssistanceOutcome>({
    kind: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();
    setOutcome({ kind: "loading" });
    loadAssistance(token, controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) setOutcome(loaded);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [token]);

  return <AssistanceStatus outcome={outcome} />;
}

function AssistanceStatus({ outcome }: { outcome: AssistanceOutcome }) {
  const description =
    outcome.kind === "loading"
      ? "Checking this secure assistance link…"
      : outcome.kind === "wrong-user"
        ? "This assistance request belongs to a different OpenBot account."
        : outcome.kind === "invalid"
          ? "This assistance link has expired or is invalid. Return to Slack and ask the coworker to try again."
          : outcome.kind === "error"
            ? "This assistance request could not be checked right now. Try again."
            : "Continue in OpenBot to control the coworker’s computer securely.";

  return (
    <PageShell title="Coworker assistance">
      <PageSection description={description} title="Secure handoff">
        {outcome.kind === "ready" ? (
          <Button render={<a href={outcome.href} />}>
            Open coworker control
          </Button>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
