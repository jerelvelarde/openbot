import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconGitBranch,
  IconGitCommit,
  IconGitPullRequest,
  IconNote,
  IconPencil,
  IconPlayerPlay,
  IconShieldX,
  IconTerminal2,
  IconEye,
  IconDownload,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { cancelRepoTaskMutationOptions } from "@/lib/repo-tasks/mutations";
import {
  type RepoTask,
  type RepoTaskStep,
  repoTaskQueryOptions,
} from "@/lib/repo-tasks/queries";
import { queryClient } from "@/query-client";

/**
 * One task, and everything it did.
 *
 * TWO READERS, ONE PAGE. Somebody checking on a running task wants the top section — where it is,
 * which branch, whether the tests pass. Somebody asking what a Bot actually did to their repository
 * wants the trail underneath, and wants it to include the things that were refused. A page that
 * showed only the outcome would be a report written next to the work rather than the record of it.
 *
 * The trail is the audit rows for this task, not a narration the model wrote. What the model says it
 * did and what the gateway recorded are different claims, and only one of them is evidence.
 */
export const Route = createFileRoute("/_authed/_app/tasks/$taskId")({
  component: RouteComponent,
});

const STEP_ICONS: Record<
  RepoTaskStep["kind"],
  React.ComponentType<{ className?: string }>
> = {
  checkout: IconDownload,
  branch: IconGitBranch,
  read: IconEye,
  edit: IconPencil,
  run: IconTerminal2,
  commit: IconGitCommit,
  push: IconArrowUpRight,
  pull_request: IconGitPullRequest,
  note: IconNote,
};

const STATE_WORDS: Record<RepoTask["state"], string> = {
  queued: "Queued",
  running: "Running",
  opened: "Pull request opened",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A read-only row: the value on the right, and no chevron promising a destination. */
function FactRow({
  icon: Icon,
  title,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: React.ReactNode;
}) {
  return (
    <Item size="sm" variant="default">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
      </ItemContent>
      <ItemActions className="text-muted-foreground text-sm">
        {value}
      </ItemActions>
    </Item>
  );
}

function Trail({ steps }: { steps: RepoTaskStep[] }) {
  return (
    <PageRows>
      {steps.map((step, index) => {
        const Icon =
          step.decision === "refused" ? IconShieldX : STEP_ICONS[step.kind];
        return (
          <div key={step.id}>
            {index > 0 ? <Separator /> : null}
            <Item size="sm" variant="default">
              <ItemMedia variant="icon">
                <Icon
                  className={
                    step.decision === "refused" ? "text-destructive" : undefined
                  }
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{step.summary}</ItemTitle>
                {step.detail ? (
                  /* The command is the point of the row, not a hint about it, so it is not clamped. */
                  <ItemDescription className="line-clamp-none font-mono text-xs">
                    {step.detail}
                  </ItemDescription>
                ) : null}
              </ItemContent>
              <ItemActions className="text-muted-foreground text-xs tabular-nums">
                {step.decision === "refused" ? (
                  <span className="text-destructive">Refused</span>
                ) : (
                  new Date(step.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                )}
              </ItemActions>
            </Item>
          </div>
        );
      })}
    </PageRows>
  );
}

function RouteComponent() {
  const { taskId } = Route.useParams();
  const task = useQuery(repoTaskQueryOptions(taskId));
  const cancel = useMutation(cancelRepoTaskMutationOptions(queryClient));

  if (task.isPending) return null;
  if (task.error || !task.data) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell title="Task">
          <p className="mt-4 text-destructive text-sm" role="alert">
            This task could not be loaded.
          </p>
        </PageShell>
      </div>
    );
  }

  const data = task.data;
  const running = data.state === "queued" || data.state === "running";

  return (
    /* The pane owns its scroll; see the note on the list screen. */
    <div className="min-h-0 flex-1 overflow-y-auto">
      <PageShell
        action={
          running ? (
            <Button
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(data.id)}
              size="sm"
              variant="ghost"
            >
              {cancel.isPending ? "Stopping…" : "Stop"}
            </Button>
          ) : data.pullRequestUrl ? (
            <Button
              render={(props) => (
                <a
                  href={data.pullRequestUrl}
                  rel="noreferrer"
                  target="_blank"
                  {...props}
                />
              )}
              size="sm"
            >
              <IconGitPullRequest />
              Open pull request
            </Button>
          ) : undefined
        }
        backButton={{ label: "Tasks", linkProps: { to: "/tasks" } }}
        description={data.repo}
        title={data.title}
      >
        {data.failure ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {data.failure}
          </p>
        ) : null}

        <PageSection title="Where it stands">
          <PageRows>
            <FactRow
              icon={
                data.state === "failed" ? IconAlertTriangle : IconPlayerPlay
              }
              title="State"
              value={STATE_WORDS[data.state]}
            />
            <Separator />
            <FactRow
              icon={IconGitBranch}
              title="Branch"
              value={<span className="font-mono text-xs">{data.branch}</span>}
            />
            <Separator />
            <FactRow
              icon={IconDownload}
              title="Base"
              value={<span className="font-mono text-xs">{data.base}</span>}
            />
            <Separator />
            <FactRow
              icon={IconGitCommit}
              title="Commits"
              value={data.commits}
            />
            {data.checks ? (
              <>
                <Separator />
                <FactRow
                  icon={IconTerminal2}
                  title="Tests"
                  value={
                    data.checks.failed > 0 ? (
                      <span className="text-destructive">
                        {data.checks.failed} failing
                      </span>
                    ) : (
                      `${data.checks.passed} passing`
                    )
                  }
                />
              </>
            ) : null}
          </PageRows>
        </PageSection>

        <PageSection
          description="Every command, file and network call this task made, as the gateway recorded it before acting. Refusals are here too."
          title="What it did"
        >
          {/* An empty bordered card reads as something that failed to load; absence reads as nothing
              yet, which is the true answer for a task that has only just been claimed. */}
          {data.steps.length === 0 ? (
            <PageEmpty>
              Nothing yet. The first row appears when the gateway records it.
            </PageEmpty>
          ) : (
            <Trail steps={data.steps} />
          )}
        </PageSection>
      </PageShell>
    </div>
  );
}
