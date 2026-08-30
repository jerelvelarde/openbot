import { IconRobot } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  ItemActions,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem as SelectOption,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { setRepositoryGrantsMutationOptions } from "@/lib/repositories/mutations";
import type { Repository, RepositoryAccess } from "@/lib/repositories/queries";
import { queryClient } from "@/query-client";

/**
 * Who may reach one repository, and how far.
 *
 * A dialog rather than in-place controls, because this is a set: the layout skill's second row kind.
 * Editing several coworkers' access on the row itself would turn a settings screen back into a form,
 * and the summary on the row would be describing a state half of which had not been saved.
 *
 * `none` is a value in the same control as `read` and `contribute` rather than a separate remove
 * button. Revoking is the same decision as granting, made in the other direction, and splitting it
 * across two controls is how an administrator ends up sure they revoked something they did not.
 */

type Level = RepositoryAccess | "none";

const LEVEL_LABELS: Record<Level, string> = {
  none: "No access",
  read: "Read",
  contribute: "Contribute",
};

export function RepositoryGrantsDialog({
  repository,
  onClose,
}: {
  /** The repository being edited, or null when the dialog is closed. */
  repository: Repository | null;
  onClose: () => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const save = useMutation(setRepositoryGrantsMutationOptions(queryClient));
  const [levels, setLevels] = useState<Record<string, Level>>({});
  /*
   * The repository is cleared the moment Save succeeds, but the dialog is still on screen animating
   * out — so reading the title straight off the prop puts a placeholder in the heading for the
   * length of the exit. Held here instead, and the prop stays the thing that decides `open`.
   */
  const [shown, setShown] = useState<Repository | null>(null);

  /*
   * Seeded from the repository each time one is opened, rather than held from the last. A dialog
   * that opens showing the previous repository's grants for a moment is a dialog that has told the
   * administrator something false about this one.
   */
  useEffect(() => {
    if (!repository) return;
    setShown(repository);
    setLevels(
      Object.fromEntries(
        repository.grants.map((grant) => [grant.agentId, grant.access]),
      ),
    );
  }, [repository]);

  const submit = () => {
    if (!repository) return;
    save.mutate(
      {
        repo: repository.id,
        grants: Object.entries(levels)
          .filter(
            (entry): entry is [string, RepositoryAccess] => entry[1] !== "none",
          )
          .map(([agentId, access]) => ({ agentId, access })),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={!!repository}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{shown?.id ?? "Repository"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <p className="mb-4 text-muted-foreground text-sm leading-relaxed">
            Read checks out, greps and runs the tests inside the Bot's own
            container. Contribute also branches, commits, pushes and opens a
            pull request. Merging is in neither.
          </p>
          {/* `muted` rather than a card: --card and --popover are the same colour, so a card-coloured row inside a dialog is no row at all. */}
          <div className="overflow-hidden rounded-lg border border-border [&_[data-slot=item]]:rounded-none">
            {(agents.data ?? []).map((agent, index) => (
              <div key={agent.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm" variant="muted">
                  <ItemMedia variant="icon">
                    <IconRobot />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{agent.name}</ItemTitle>
                    <ItemDescription>{agent.title}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Select
                      onValueChange={(value) =>
                        setLevels((current) => ({
                          ...current,
                          [agent.id]: value as Level,
                        }))
                      }
                      value={levels[agent.id] ?? "none"}
                    >
                      <SelectTrigger className="w-36" size="sm">
                        {/* The label, not the value: the trigger showing `none` states the field's
                            spelling rather than the current answer. */}
                        <SelectValue>
                          {(value: Level) =>
                            LEVEL_LABELS[value] ?? LEVEL_LABELS.none
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {(["none", "read", "contribute"] as Level[]).map(
                            (level) => (
                              <SelectOption key={level} value={level}>
                                {LEVEL_LABELS[level]}
                              </SelectOption>
                            ),
                          )}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </div>
          {save.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={submit} size="sm">
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
