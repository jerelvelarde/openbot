import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  type Repository,
  type RepositoryAccess,
  repositoryKeys,
} from "./queries";

const FALLBACK = "Could not save the repository";

export type ConnectRepositoryInput = {
  /** `owner/name`, as a person types it or pastes it. */
  repo: string;
  credentialId: string;
};

export type RepositoryGrantsInput = {
  repo: string;
  grants: { agentId: string; access: RepositoryAccess }[];
};

const invalidateRepositories = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: repositoryKeys.all });

export function connectRepositoryMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: ConnectRepositoryInput): Promise<Repository> =>
      client("/api/repositories", "repository", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateRepositories(queryClient),
  });
}

/**
 * Replace the whole grant set for one repository.
 *
 * A whole set rather than one add and one remove, because the dialog it backs edits the set: sending
 * a diff would mean the browser deciding what changed, and two people editing the same repository
 * would each apply their own half of it.
 */
export function setRepositoryGrantsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: RepositoryGrantsInput): Promise<void> => {
      await client(`/api/repositories/${input.repo}/grants`, {
        method: "PUT",
        body: { grants: input.grants },
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateRepositories(queryClient),
  });
}

export function disconnectRepositoryMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (repo: string): Promise<void> => {
      await client(`/api/repositories/${repo}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateRepositories(queryClient),
  });
}
