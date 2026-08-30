import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * Where a task is, as five words rather than a spinner.
 *
 * `opened` rather than `done`, because a coworker's work finishing is a pull request existing, not a
 * change being accepted. Nothing here says the work was any good; that is the review's answer, and
 * this screen must not imply it has been given.
 */
export type RepoTaskState =
  | "queued"
  | "running"
  | "opened"
  | "failed"
  | "cancelled";

/**
 * One thing the coworker did, as the audit trail recorded it.
 *
 * `decision` is on every step because a refusal is a step too. A trail that only lists what happened
 * reads as though nothing was ever stopped, which is the opposite of the claim this product makes.
 */
export type RepoTaskStep = {
  id: string;
  at: string;
  kind:
    | "checkout"
    | "branch"
    | "read"
    | "edit"
    | "run"
    | "commit"
    | "push"
    | "pull_request"
    | "note";
  summary: string;
  /** The command, the path, or the rule that refused. Absent where the summary is the whole of it. */
  detail?: string;
  decision: "allowed" | "refused";
};

/** What a build or test command answered. */
export type RepoTaskChecks = {
  command: string;
  passed: number;
  failed: number;
  /** Where the full log was written in the workspace, because it is not coming back through here. */
  logPath: string;
};

/**
 * A task as the browser sees it.
 *
 * `branch` is the task's own, and is what a push is checked against on the server. The browser shows
 * it; it does not enforce it.
 */
export type RepoTask = {
  id: string;
  repo: string;
  agentId: string;
  agentName: string;
  title: string;
  source: {
    kind: "issue" | "pull_request" | "manual";
    number?: number;
    url?: string;
  };
  base: string;
  branch: string;
  state: RepoTaskState;
  /** Who asked. The run carries their authorization, so the trail names them and not the Bot alone. */
  requestedBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  commits: number;
  checks?: RepoTaskChecks;
  pullRequestUrl?: string;
  /** Why it stopped, on `failed` and `cancelled`. Said in a sentence, not a stack. */
  failure?: string;
  steps: RepoTaskStep[];
};

export const repoTaskKeys = {
  all: ["repo-tasks"] as const,
  list: () => ["repo-tasks", "list"] as const,
  detail: (taskId: string) => ["repo-tasks", "detail", taskId] as const,
};

export function repoTaskListQueryOptions() {
  return queryOptions({
    queryKey: repoTaskKeys.list(),
    queryFn: (): Promise<RepoTask[]> =>
      client("/api/repo-tasks", "tasks", {
        fallback: "Could not load tasks",
      }),
    /*
     * A task runs for tens of minutes with nobody watching, so the list is the one screen in this app
     * that has something new to say without anybody touching it. Polled rather than pushed: the
     * channel socket carries a conversation, and a list of tasks is not one.
     */
    refetchInterval: 2_000,
  });
}

export function repoTaskQueryOptions(taskId: string) {
  return queryOptions({
    queryKey: repoTaskKeys.detail(taskId),
    queryFn: (): Promise<RepoTask> =>
      client(`/api/repo-tasks/${taskId}`, "task", {
        fallback: "Could not load the task",
      }),
    refetchInterval: 2_000,
  });
}
