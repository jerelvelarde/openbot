import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * What a Bot may do with a repository it has been granted.
 *
 * Two levels rather than a matrix of six, because the question an administrator is actually asking
 * is whether this coworker may leave a mark on the repository. `read` checks out, greps and runs the
 * tests inside its own container; `contribute` also branches, commits, pushes and opens a pull
 * request. Merging is in neither, because it is not a tool.
 */
export type RepositoryAccess = "read" | "contribute";

/** One Bot's standing reach into one repository. */
export type RepositoryGrant = {
  agentId: string;
  agentName: string;
  access: RepositoryAccess;
};

/**
 * A repository as the browser sees it.
 *
 * `hasAuth` is a boolean and never the installation credential, for the same reason every other read
 * type in this app carries one: secrets are write-only here. `canManage` is the server's verdict,
 * rendered rather than recomputed.
 */
export type Repository = {
  /** `owner/name`, which is also the grant's `ref`. */
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  hasAuth: boolean;
  grants: RepositoryGrant[];
  canManage: boolean;
};

export const repositoryKeys = {
  all: ["repositories"] as const,
  list: () => ["repositories", "list"] as const,
};

export function repositoryListQueryOptions() {
  return queryOptions({
    queryKey: repositoryKeys.list(),
    queryFn: (): Promise<Repository[]> =>
      client("/api/repositories", "repositories", {
        fallback: "Could not load repositories",
      }),
  });
}
