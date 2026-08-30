import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createRepoTaskMutationOptions } from "@/lib/repo-tasks/mutations";
import { repositoryListQueryOptions } from "@/lib/repositories/queries";
import { queryClient } from "@/query-client";

/**
 * Handing a repository task to a coworker.
 *
 * TYPED FIELDS, NOT A SENTENCE. The repository, the coworker and the base branch are facts the
 * deployment resolves, and the same research that shaped the handoff envelope applies here: free
 * text is the commonest way a delegated task arrives subtly wrong, and the failure is silent — the
 * work completes confidently against the wrong base.
 *
 * The coworker list is derived from the repository's grants rather than from the roster. A person
 * choosing a Bot that cannot reach the repository, and finding out when the run refuses, is a
 * question this dialog already knows the answer to.
 */
export function NewRepoTask({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const repositories = useQuery(repositoryListQueryOptions());
  const create = useMutation(createRepoTaskMutationOptions(queryClient));
  const navigate = useNavigate();

  const [repo, setRepo] = useState("");
  const [agentId, setAgentId] = useState("");
  const [reference, setReference] = useState("");
  const [instructions, setInstructions] = useState("");

  const rows = repositories.data ?? [];
  const selected = rows.find((row) => row.id === repo);
  /* Only the Bots this repository was granted to, and only those that may write to it. */
  const eligible = (selected?.grants ?? []).filter(
    (grant) => grant.access === "contribute",
  );

  /* Choosing a repository whose grants do not include the chosen Bot clears the Bot rather than
   * carrying an impossible pair into the submit. */
  useEffect(() => {
    if (agentId && !eligible.some((grant) => grant.agentId === agentId)) {
      setAgentId("");
    }
  }, [agentId, eligible]);

  const submit = () => {
    create.mutate(
      {
        repo,
        agentId,
        base: selected?.defaultBranch ?? "main",
        reference: reference.trim(),
        instructions: instructions.trim(),
      },
      {
        onSuccess: (task) => {
          onClose();
          setRepo("");
          setAgentId("");
          setReference("");
          setInstructions("");
          navigate({ params: { taskId: task.id }, to: "/tasks/$taskId" });
        },
      },
    );
  };

  const ready = repo !== "" && agentId !== "" && instructions.trim().length > 0;

  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-4 overflow-y-auto">
          <Field>
            <FieldLabel htmlFor="task-repo">Repository</FieldLabel>
            {/* Base UI clears a select with `null`; the empty string is this form's "nothing chosen". */}
            <Select
              onValueChange={(value) => setRepo(value ?? "")}
              value={repo}
            >
              <SelectTrigger id="task-repo">
                <SelectValue placeholder="Choose a repository" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {rows.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.id}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="task-agent">Coworker</FieldLabel>
            <Select
              disabled={!selected}
              onValueChange={(value) => setAgentId(value ?? "")}
              value={agentId}
            >
              <SelectTrigger id="task-agent">
                {/* The coworker's name, not its id: the trigger has to state the current answer, and
                    `eng` is the spelling of the record rather than the answer. */}
                <SelectValue placeholder="Choose a coworker">
                  {(value: string) =>
                    eligible.find((grant) => grant.agentId === value)
                      ?.agentName ?? "Choose a coworker"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {eligible.map((grant) => (
                    <SelectItem key={grant.agentId} value={grant.agentId}>
                      {grant.agentName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              {selected && eligible.length === 0
                ? "No coworker may contribute to this repository yet. An administrator grants that on Repositories."
                : `Branches from ${selected?.defaultBranch ?? "the default branch"}. The Bot cannot push to it, and cannot merge.`}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="task-reference">
              Issue or pull request
            </FieldLabel>
            <Input
              id="task-reference"
              onChange={(event) => setReference(event.target.value)}
              placeholder="https://github.com/owner/name/issues/123"
              value={reference}
            />
            <FieldDescription>
              Optional. Given one, the coworker reads the thread before it
              starts.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="task-instructions">What to do</FieldLabel>
            <Textarea
              id="task-instructions"
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Fix the culler so a computer with a claimed task is not suspended. Add a test."
              rows={4}
              value={instructions}
            />
          </Field>

          {create.error ? (
            <p className="text-destructive text-sm" role="alert">
              {create.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!ready || create.isPending}
            onClick={submit}
            size="sm"
          >
            {create.isPending ? "Handing over…" : "Hand it over"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
