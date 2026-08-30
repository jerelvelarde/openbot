import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type RepoTask, repoTaskKeys } from "./queries";

const FALLBACK = "Task operation failed";

/**
 * What starting a task needs, and nothing more.
 *
 * `instructions` is free text and everything else is not, which is the same split the handoff
 * envelope makes: the repository, the base and the coworker are facts the deployment resolves, and
 * asking a person to write them into a sentence is how they arrive wrong.
 */
export type RepoTaskInput = {
  repo: string;
  agentId: string;
  base: string;
  /** An issue or pull request URL, or empty for a task a person described themselves. */
  reference: string;
  instructions: string;
};

function invalidateRepoTasks(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: repoTaskKeys.all });
}

export function createRepoTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: RepoTaskInput): Promise<RepoTask> =>
      client("/api/repo-tasks", "task", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRepoTasks(queryClient),
  });
}

export function cancelRepoTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (taskId: string): Promise<void> => {
      await client(`/api/repo-tasks/${taskId}/cancel`, {
        method: "POST",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateRepoTasks(queryClient),
  });
}
