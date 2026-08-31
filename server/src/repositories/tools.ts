import { z } from "zod";
import type { ActionActor, ComputerGateway } from "../computer/gateway";
import type { RunCommandResult } from "../computer/schema";
import type { GrantedTool } from "../plugins/tools";
import type { RepoTaskRecord, RepositoryStore } from "./store";

/**
 * Working on a repository, as tools the deployment runs rather than commands a model writes.
 *
 * WHY THESE ARE TYPED AND NOT JUST A SHELL. A Bot already has `computer_run_command`, so on the face
 * of it `git push` needs nothing new. What it needs is a credential, and that is the whole reason
 * this file exists: `runCommand` records the command verbatim in its audit payload, so a token
 * interpolated into a command line is a token in the trail. Worse, a command line is model output —
 * `git push && env` is a string a model writes, and the token would be in the reply.
 *
 * So the deployment composes every command that touches the credential, and the credential never
 * appears in one. It is written to a git credential file through `writeFile`, whose audit payload
 * records the path and not the contents, and removed when the task is done. The cost is real and
 * worth naming: for the length of a task the token is at rest inside that Bot's workspace, readable
 * by anything else running in that container. What makes that acceptable is that the container is
 * one Bot's, which is the same boundary the browser's logins already sit behind.
 *
 * WHAT IS NOT HERE IS AS DELIBERATE AS WHAT IS. There is no merge, no approve, and no force-push.
 * They are not denied by policy; they do not exist, because a coworker that can approve its own work
 * has removed the review it was supposed to be feeding, and a force-push is how a branch's history
 * stops being evidence.
 */

export type RepoToolsContext = {
  gateway: ComputerGateway;
  botId: string;
  actor: ActionActor;
  repositories: RepositoryStore;
  /** The task these tools belong to. The branch on it is what a push is checked against. */
  task: RepoTaskRecord;
  /**
   * The credential for this repository, fetched per task.
   *
   * A function rather than a value, so a token that expires mid-task can be minted again without the
   * tools being rebuilt. Returning null means no credential is stored, which makes the read-only
   * half still work against a public repository and the push half refuse with a reason.
   */
  credential: () => Promise<string | null>;
};

/** Where a repository is checked out, relative to the Bot's workspace. */
export const checkoutPath = (repo: string) => `repos/${repo}`;

/** Where the credential lives while a task is running. */
const CREDENTIAL_FILE = ".git-credentials-task";

type Outcome = Record<string, unknown> & { ok: boolean };
const answer = (outcome: Outcome) => JSON.stringify(outcome);

/**
 * How long a repository command may take.
 *
 * A clone and a test suite are not a click. The computer caps this at ten minutes of its own, which
 * is the ceiling rather than this number; what this changes is that a checkout is not stopped at the
 * two-minute default meant for an interactive command.
 */
const REPO_COMMAND_MS = 600_000;

/** Everything a command needs to reach the repository, with the credential kept out of the words. */
function gitPrefix(repo: string): string {
  return [
    `cd ${checkoutPath(repo)}`,
    // The helper reads the file written through `writeFile`; the token is never on this line.
    `git -c credential.helper='store --file=$HOME/${CREDENTIAL_FILE}'`,
  ].join(" && ");
}

export function createRepoTools(context: RepoToolsContext): GrantedTool[] {
  const { gateway, botId, actor, repositories, task } = context;

  /** Run one command the deployment composed, with a task-length deadline. */
  async function run(command: string): Promise<RunCommandResult> {
    return (await gateway.runCommand(botId, actor, {
      command,
      timeoutMs: REPO_COMMAND_MS,
    })) as RunCommandResult;
  }

  /**
   * Make the credential available, and answer whether it is there at all.
   *
   * Rewritten before every operation that needs it rather than once at the start, because a token
   * minted for a fifteen-minute task can expire inside one, and a push that fails on an expired
   * credential is indistinguishable to a model from a push it was not allowed to make.
   */
  async function withCredential(): Promise<boolean> {
    const token = await context.credential();
    if (!token) return false;
    await gateway.writeFile(botId, actor, {
      path: CREDENTIAL_FILE,
      // The contents are not echoed by `writeFile`, and are not in its audit payload.
      contents: `https://x-access-token:${token}@github.com\n`,
    });
    return true;
  }

  /** Whether this Bot may still leave a mark, asked now rather than trusted from task creation. */
  async function mayPush(): Promise<boolean> {
    return (
      (await repositories.accessFor(task.agentId, task.repo)) === "contribute"
    );
  }

  const failed = (result: RunCommandResult, what: string): Outcome => ({
    ok: false,
    reason: `${what} failed.`,
    exitCode: result.exitCode,
    // stderr is where git says what actually went wrong, and it is what the model needs.
    output: (result.stderr || result.stdout).slice(-4000),
    ...(result.timedOut ? { timedOut: true } : {}),
  });

  const tool = <S extends z.ZodType>(
    name: string,
    description: string,
    parameters: S,
    body: (args: z.infer<S>) => Promise<Outcome>,
  ): GrantedTool => ({
    name,
    ref: `repo/${name}`,
    description,
    parameters,
    execute: async (raw: unknown) => {
      const parsed = parameters.safeParse(raw ?? {});
      if (!parsed.success) {
        return answer({
          ok: false,
          reason: `Those arguments are not right for ${name}.`,
        });
      }
      try {
        return answer(await body(parsed.data));
      } catch (error) {
        return answer({
          ok: false,
          reason: error instanceof Error ? error.message : `${name} failed.`,
        });
      }
    },
  });

  return [
    tool(
      "repo_checkout",
      `Check out ${task.repo} onto your computer and put it on this task's branch. Call this ` +
        "first, before reading or changing anything. It is safe to call again: it fetches rather " +
        "than starting over, so a repository you have worked on before comes back quickly.",
      z.object({}),
      async () => {
        const hasCredential = await withCredential();
        const path = checkoutPath(task.repo);
        const clone = await run(
          [
            `mkdir -p $(dirname ${path})`,
            `if [ -d ${path}/.git ]; then ${gitPrefix(task.repo)} fetch --depth 50 origin ${task.base};`,
            `else git -c credential.helper='store --file=$HOME/${CREDENTIAL_FILE}' clone --depth 50 https://github.com/${task.repo}.git ${path}; fi`,
          ].join(" ; "),
        );
        if (clone.exitCode !== 0) {
          return {
            ...failed(clone, "The checkout"),
            ...(hasCredential
              ? {}
              : {
                  reason:
                    "The checkout failed and no credential is stored for this repository.",
                }),
          };
        }

        const branch = await run(
          `${gitPrefix(task.repo)} checkout -B ${task.branch} origin/${task.base}`,
        );
        if (branch.exitCode !== 0) return failed(branch, "Making the branch");

        return {
          ok: true,
          path,
          branch: task.branch,
          base: task.base,
          note: "Paths you read and write are relative to your workspace, so prefix them with this path.",
        };
      },
    ),

    tool(
      "repo_status",
      "What you have changed so far on this task's branch: the files, and whether anything is " +
        "staged. Call this before committing rather than assuming.",
      z.object({}),
      async () => {
        const result = await run(
          `${gitPrefix(task.repo)} status --porcelain=v1`,
        );
        if (result.exitCode !== 0) return failed(result, "Reading the status");
        const changes = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => ({
            state: line.slice(0, 2).trim(),
            path: line.slice(3),
          }));
        return { ok: true, changes, clean: changes.length === 0 };
      },
    ),

    tool(
      "repo_diff",
      "The change you have made, as a diff. Use it to check your own work before committing, and " +
        "to write a pull request body that describes what actually changed.",
      z.object({
        path: z
          .string()
          .optional()
          .describe("Limit the diff to one path. Omit for everything."),
      }),
      async (args) => {
        const result = await run(
          `${gitPrefix(task.repo)} diff -- ${args.path ? args.path : "."}`,
        );
        if (result.exitCode !== 0) return failed(result, "Reading the diff");
        return {
          ok: true,
          // A whole diff can be enormous, and the model has a context window.
          diff: result.stdout.slice(0, 20_000),
          truncated: result.stdout.length > 20_000,
        };
      },
    ),

    tool(
      "repo_run",
      "Run a build or a test command in the repository, with a long deadline. The full output goes " +
        "to a log file and you get the tail of it, so grep the log for the failure rather than " +
        "asking for it all again.",
      z.object({
        command: z
          .string()
          .describe(
            "The command, such as: bun test server/tests/culler.test.ts",
          ),
      }),
      async (args) => {
        /*
         * Logged to a file rather than returned whole.
         *
         * A passing suite is thousands of lines the model does not need and cannot afford; a failing
         * one has the answer in the last few. The log stays in the workspace so it can be grepped,
         * which is the thing a person would do.
         */
        const log = `logs/${task.id}.log`;
        const result = await run(
          `mkdir -p logs && cd ${checkoutPath(task.repo)} && ${args.command} > $HOME/${log} 2>&1; echo "exit:$?"`,
        );
        const tail = await run(`tail -c 4000 ${log}`);
        const marker = result.stdout.match(/exit:(\d+)/);
        const exitCode = marker ? Number(marker[1]) : result.exitCode;
        return {
          ok: true,
          exitCode,
          passed: exitCode === 0,
          logPath: log,
          tail: tail.stdout,
          ...(result.timedOut ? { timedOut: true } : {}),
        };
      },
    ),

    tool(
      "repo_commit",
      "Commit what you have changed, on this task's branch. Say what the change does, not what " +
        "files it touches.",
      z.object({
        message: z
          .string()
          .describe("The commit message: one line saying what the change does"),
      }),
      async (args) => {
        if (!(await mayPush())) {
          return {
            ok: false,
            refused: true,
            reason: "This coworker may read this repository but not change it.",
          };
        }
        const result = await run(
          [
            gitPrefix(task.repo),
            "add -A",
            /*
             * Authorship is the deployment's to stamp.
             *
             * A Bot must not be able to commit as a person: the trail would then show a human author
             * for work nobody wrote, which is the sort of small lie that survives into a blame view
             * years later.
             */
            `git -c user.name='${task.agentId} (OpenBot)' -c user.email='openbot@localhost' commit -m ${JSON.stringify(args.message)}`,
          ].join(" && "),
        );
        if (result.exitCode !== 0) {
          // Nothing staged is not a failure worth a stack; it is a fact the model should act on.
          if (/nothing to commit/i.test(result.stdout + result.stderr)) {
            return { ok: false, reason: "There is nothing to commit yet." };
          }
          return failed(result, "The commit");
        }
        return { ok: true, message: args.message };
      },
    ),

    tool(
      "repo_push",
      "Push this task's branch. You cannot push anywhere else, and you cannot merge.",
      z.object({}),
      async () => {
        if (!(await mayPush())) {
          return {
            ok: false,
            refused: true,
            reason:
              "This coworker may read this repository but not push to it.",
          };
        }
        if (!(await withCredential())) {
          return {
            ok: false,
            reason:
              "No credential is stored for this repository, so nothing was pushed.",
          };
        }
        /*
         * The branch comes from the task row, never from an argument.
         *
         * There is no parameter to get wrong and nothing for a model to name, which is what makes
         * "a Bot pushes only to its own branch" a property rather than a check that can be argued
         * with. `--force` is not offered for the same reason.
         */
        const result = await run(
          `${gitPrefix(task.repo)} push origin ${task.branch}`,
        );
        if (result.exitCode !== 0) {
          if (/non-fast-forward|rejected/i.test(result.stderr)) {
            return {
              ok: false,
              reason:
                "The branch moved since you last pushed. Fetch and reconcile; it will not be forced.",
            };
          }
          return failed(result, "The push");
        }
        return { ok: true, branch: task.branch };
      },
    ),

    tool(
      "repo_open_pull_request",
      "Open a draft pull request from this task's branch. Say what changed and what you checked. " +
        "It opens as a draft, and a person decides whether it is ready.",
      z.object({
        title: z.string().describe("One line saying what the change does"),
        body: z
          .string()
          .describe(
            "What changed, why, and what you ran to check it. Say what you did not do as well.",
          ),
      }),
      async (args) => {
        if (!(await mayPush())) {
          return {
            ok: false,
            refused: true,
            reason:
              "This coworker may not open a pull request on this repository.",
          };
        }
        if (!(await withCredential())) {
          return {
            ok: false,
            reason:
              "No credential is stored for this repository, so no pull request was opened.",
          };
        }
        /*
         * Through the API rather than `gh`, because the image has git and does not have `gh`, and
         * installing a CLI mid-task to make one HTTP call is a slower and less predictable way to
         * make the same call. `--netrc-file` keeps the token off the command line.
         */
        const payload = JSON.stringify({
          title: args.title,
          body: `${args.body}\n\nOpened by ${task.agentId} for a task in OpenBot. Task ${task.id}.`,
          head: task.branch,
          base: task.base,
          draft: true,
        });
        const result = await run(
          [
            `printf '%s' ${JSON.stringify(payload)} > $HOME/.pr-body.json`,
            `printf 'machine api.github.com login x-access-token password %s\\n' "$(sed -n 's|https://x-access-token:\\(.*\\)@github.com|\\1|p' $HOME/${CREDENTIAL_FILE})" > $HOME/.netrc-task`,
            "chmod 600 $HOME/.netrc-task",
            `curl -sS --netrc-file $HOME/.netrc-task -H 'Accept: application/vnd.github+json' -X POST https://api.github.com/repos/${task.repo}/pulls -d @$HOME/.pr-body.json`,
            "rm -f $HOME/.netrc-task $HOME/.pr-body.json",
          ].join(" && "),
        );
        if (result.exitCode !== 0) {
          return failed(result, "Opening the pull request");
        }
        const url = result.stdout.match(/"html_url":\s*"([^"]+\/pull\/\d+)"/);
        if (!url) {
          return {
            ok: false,
            reason: "The forge did not return a pull request.",
            output: result.stdout.slice(-2000),
          };
        }
        return { ok: true, pullRequestUrl: url[1], draft: true };
      },
    ),
  ];
}

/** Remove the credential a task left in the workspace. Called whether the task succeeded or not. */
export async function clearRepoCredential(context: {
  gateway: ComputerGateway;
  botId: string;
  actor: ActionActor;
}): Promise<void> {
  await context.gateway
    .runCommand(context.botId, context.actor, {
      command: `rm -f $HOME/${CREDENTIAL_FILE} $HOME/.netrc-task`,
    })
    .catch(() => {
      /*
       * Swallowed on purpose. This runs on the way out of a task that may already have failed, and a
       * computer that has gone away cannot be tidied. The token expires on its own; a thrown error
       * here would replace the real reason the task ended.
       */
    });
}
