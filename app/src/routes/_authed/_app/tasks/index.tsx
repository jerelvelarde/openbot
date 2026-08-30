import {
  IconChevronRight,
  IconCircleDashed,
  IconGitPullRequest,
  IconPlayerPlay,
  IconPlus,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { NewRepoTask } from "@/components/tasks/new-repo-task";
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
import {
  type RepoTask,
  type RepoTaskState,
  repoTaskListQueryOptions,
} from "@/lib/repo-tasks/queries";

/**
 * What the coworkers are working on, and what came of it.
 *
 * THIS SCREEN EXISTS BECAUSE NOBODY IS WATCHING. Every other surface in this app is a conversation
 * somebody is present for; a repository task runs for tens of minutes on a computer with no browser
 * attached. Without a list, the only evidence a task is running is the pull request that eventually
 * appears, and the only evidence one failed is the pull request that never does.
 *
 * Two sections rather than one sorted list. "In progress" is the thing a person came to check and it
 * is usually short; "Finished" is a record they scan. One list ordered by time buries the running
 * task under this morning's successes by the middle of the afternoon.
 */
export const Route = createFileRoute("/_authed/_app/tasks/")({
  component: RouteComponent,
});

const STATE_ICONS: Record<
  RepoTaskState,
  React.ComponentType<{ className?: string }>
> = {
  queued: IconCircleDashed,
  running: IconPlayerPlay,
  opened: IconGitPullRequest,
  failed: IconAlertTriangle,
  cancelled: IconCircleDashed,
};

/**
 * What a row says on the right: where this task actually is.
 *
 * A running task says what it is doing rather than "Running", because the difference between a Bot
 * three minutes into a test suite and a Bot stuck is the only thing worth reading at a glance.
 */
function summaryFor(task: RepoTask): string {
  switch (task.state) {
    case "queued":
      return "Queued";
    case "running":
      return task.steps.at(-1)?.summary ?? "Starting";
    case "opened":
      return task.checks && task.checks.failed > 0
        ? `Pull request · ${task.checks.failed} failing`
        : "Pull request opened";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function TaskRows({ tasks }: { tasks: RepoTask[] }) {
  return (
    <PageRows>
      {tasks.map((task, index) => {
        const Icon = STATE_ICONS[task.state];
        return (
          <div key={task.id}>
            {index > 0 ? <Separator /> : null}
            {/* Childless, because children given to `render` replace the row's own and it draws empty. */}
            <Item
              render={<Link params={{ taskId: task.id }} to="/tasks/$taskId" />}
              size="sm"
              variant="default"
            >
              <ItemMedia variant="icon">
                <Icon
                  className={
                    task.state === "failed" ? "text-destructive" : undefined
                  }
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{task.title}</ItemTitle>
                <ItemDescription>
                  {task.repo} · {task.agentName} · {task.branch}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="gap-2 text-muted-foreground text-sm">
                <span className="hidden sm:inline">{summaryFor(task)}</span>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </div>
        );
      })}
    </PageRows>
  );
}

function RouteComponent() {
  const tasks = useQuery(repoTaskListQueryOptions());
  const [composing, setComposing] = useState(false);

  const all = tasks.data ?? [];
  const active = all.filter(
    (task) => task.state === "queued" || task.state === "running",
  );
  const finished = all.filter(
    (task) => task.state !== "queued" && task.state !== "running",
  );

  return (
    /*
     * A DELIBERATE DEVIATION, stated as the layout skill asks. `_app` is one viewport that never
     * scrolls — panes scroll inside it — so a `PageShell` dropped straight in is clipped by the
     * shell's `overflow-hidden` rather than scrolled. This is the pane, and it owns its scroll.
     */
    <div className="min-h-0 flex-1 overflow-y-auto">
      <PageShell
        action={
          <Button onClick={() => setComposing(true)} size="sm" variant="ghost">
            <IconPlus />
            New task
          </Button>
        }
        description="Work handed to a coworker on a repository. It runs on that Bot's own computer, whether or not anybody is watching, and every command it runs is on the trail."
        title="Tasks"
      >
        <PageSection title="In progress">
          {tasks.isPending ? null : tasks.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              Tasks could not be loaded.
            </p>
          ) : active.length === 0 ? (
            <PageEmpty>Nothing is running.</PageEmpty>
          ) : (
            <TaskRows tasks={active} />
          )}
        </PageSection>

        <PageSection title="Finished">
          {tasks.isPending ? null : tasks.error ? null : finished.length ===
            0 ? (
            <PageEmpty>No task has finished yet.</PageEmpty>
          ) : (
            <TaskRows tasks={finished} />
          )}
        </PageSection>

        <NewRepoTask onClose={() => setComposing(false)} open={composing} />
      </PageShell>
    </div>
  );
}
