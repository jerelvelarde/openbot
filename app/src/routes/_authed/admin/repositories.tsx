import {
  IconBrandGithub,
  IconChevronRight,
  IconPlus,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RepositoryGrantsDialog } from "@/components/admin/repository-grants-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { queryClient } from "@/query-client";
import { connectRepositoryMutationOptions } from "@/lib/repositories/mutations";
import {
  type Repository,
  repositoryListQueryOptions,
} from "@/lib/repositories/queries";

/**
 * Which repositories this deployment can reach, and which coworkers may reach them.
 *
 * Beside Plugins rather than inside it, and the shape is deliberately the same: connecting is
 * account-wide, and who may use the connection is decided per Bot. A repository is a connector whose
 * tools happen to be `git`, so an administrator arriving from Plugins already knows how to read this.
 *
 * The row's summary states where a repository stands rather than naming the field, which is what the
 * layout skill asks: "2 Bots · contribute" answers the question an administrator came with, and
 * "Grants" does not.
 */
export const Route = createFileRoute("/_authed/admin/repositories")({
  component: RouteComponent,
});

/**
 * What a row says on the right.
 *
 * The strongest access any Bot holds, not a list of them, because the risk an administrator is
 * scanning for is whether anything here can write. The count and the level together are the whole
 * answer at a glance; the dialog has the detail.
 */
function summaryFor(repository: Repository): string {
  if (!repository.hasAuth) return "No credential";
  if (repository.grants.length === 0) return "No Bots";

  const bots = `${repository.grants.length} ${
    repository.grants.length === 1 ? "Bot" : "Bots"
  }`;
  const writes = repository.grants.some(
    (grant) => grant.access === "contribute",
  );
  return `${bots} · ${writes ? "contribute" : "read"}`;
}

function ConnectRepository() {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const connect = useMutation(connectRepositoryMutationOptions(queryClient));

  const submit = () => {
    connect.mutate(
      { repo: repo.trim(), credentialId: "github-app" },
      {
        onSuccess: () => {
          setRepo("");
          setOpen(false);
        },
      },
    );
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="ghost">
        <IconPlus />
        Connect
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect a repository</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4 overflow-y-auto">
            <Field>
              <FieldLabel htmlFor="repo">Repository</FieldLabel>
              <Input
                id="repo"
                onChange={(event) => setRepo(event.target.value)}
                placeholder="owner/name"
                value={repo}
              />
              <FieldDescription>
                Reached with this deployment's GitHub App installation. The
                token is minted per operation and never reaches a Bot's shell.
              </FieldDescription>
            </Field>
            {connect.error ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {connect.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={repo.trim().length === 0 || connect.isPending}
              onClick={submit}
              size="sm"
            >
              {connect.isPending ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RouteComponent() {
  const repositories = useQuery(repositoryListQueryOptions());
  const [editing, setEditing] = useState<Repository | null>(null);

  return (
    <PageShell
      description="Repositories a coworker may check out onto its own computer. Connecting one is account-wide; which Bots may reach it, and whether they may push, is decided here."
      title="Repositories"
    >
      <PageSection action={<ConnectRepository />} title="Connected">
        {/* Pending, error, empty, rows — pending first and silent, so nothing asserts mid-fetch. */}
        {repositories.isPending ? null : repositories.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Repositories could not be loaded.
          </p>
        ) : repositories.data?.length === 0 ? (
          <PageEmpty>
            No repositories are connected. A coworker with no repository cannot
            reach one.
          </PageEmpty>
        ) : (
          <PageRows>
            {(repositories.data ?? []).map((repository, index) => (
              <div key={repository.id}>
                {index > 0 ? <Separator /> : null}
                <Item
                  render={
                    <button
                      onClick={() => setEditing(repository)}
                      type="button"
                    />
                  }
                  size="sm"
                  variant="default"
                >
                  <ItemMedia variant="icon">
                    <IconBrandGithub />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{repository.id}</ItemTitle>
                    <ItemDescription>
                      Default branch {repository.defaultBranch}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="gap-2 text-muted-foreground text-sm">
                    {summaryFor(repository)}
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      <RepositoryGrantsDialog
        onClose={() => setEditing(null)}
        repository={editing}
      />
    </PageShell>
  );
}
