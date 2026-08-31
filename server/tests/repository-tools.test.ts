import { describe, expect, test } from "bun:test";
import type { ComputerGateway } from "../src/computer/gateway";
import type {
  RepositoryStore,
  RepoTaskRecord,
} from "../src/repositories/store";
import { createRepoTools } from "../src/repositories/tools";

/**
 * What the repository tools must guarantee.
 *
 * The one that matters most is negative: the credential must never appear in a command string.
 * `runCommand` records the command verbatim in its audit payload, and a command line is also the
 * one thing a model can influence, so a token interpolated into one is a token in the trail and
 * potentially in a reply. Every test here that asserts on `commands` is really asserting that.
 *
 * The rest are the properties that make "a Bot pushes only to its own branch, and cannot merge"
 * true by construction rather than by a check somebody can argue with.
 */

const TOKEN = "ghs_thisisthesecrettokenvalue";
const ACTOR = { id: "user-1", userId: "user-1" };

const TASK: RepoTaskRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  repo: "CopilotKit/openbot",
  agentId: "eng",
  actorId: "user-1",
  title: "Keep a computer with a claimed task awake",
  instructions: "Keep a computer with a claimed task awake.",
  source: { kind: "issue", number: 271 },
  base: "main",
  branch: "bot/eng/keep-a-computer-11111111",
  state: "running",
  createdAt: new Date().toISOString(),
};

function harness(options?: {
  access?: "read" | "contribute" | null;
  credential?: string | null;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}) {
  const commands: string[] = [];
  const writes: { path: string; contents: string }[] = [];

  const gateway = {
    async runCommand(
      _bot: string,
      _actor: unknown,
      input: { command: string },
    ) {
      commands.push(input.command);
      return {
        command: input.command,
        exitCode: options?.exitCode ?? 0,
        stdout: options?.stdout ?? "",
        stderr: options?.stderr ?? "",
        truncated: false,
        timedOut: false,
        elapsedMs: 1,
      };
    },
    async writeFile(
      _bot: string,
      _actor: unknown,
      input: { path: string; contents: string },
    ) {
      writes.push(input);
      return {
        path: input.path,
        bytes: input.contents.length,
        appended: false,
      };
    },
  } as unknown as ComputerGateway;

  const repositories = {
    async accessFor() {
      return options?.access === undefined ? "contribute" : options.access;
    },
  } as unknown as RepositoryStore;

  const tools = new Map(
    createRepoTools({
      gateway,
      botId: "eng",
      actor: ACTOR,
      repositories,
      task: TASK,
      credential: async () =>
        options?.credential === undefined ? TOKEN : options.credential,
    }).map((tool) => [tool.name, tool]),
  );

  return { tools, commands, writes };
}

const parse = (raw: string) => JSON.parse(raw) as Record<string, unknown>;

describe("what a repository task may do", () => {
  test("the credential never appears in a command", async () => {
    const { tools, commands, writes } = harness();

    await tools.get("repo_checkout")?.execute({});
    await tools.get("repo_push")?.execute({});

    expect(commands.length).toBeGreaterThan(0);
    // The property. `runCommand` writes the command into the audit payload verbatim.
    for (const command of commands) {
      expect(command).not.toContain(TOKEN);
    }
    // It reaches the container through a write, whose payload records the path and not the contents.
    expect(writes.some((write) => write.contents.includes(TOKEN))).toBe(true);
  });

  test("a push goes to the task's branch, and there is no argument to change that", async () => {
    const { tools, commands } = harness();
    const push = tools.get("repo_push");

    // No parameter to get wrong: the branch is read off the task row.
    const outcome = parse((await push?.execute({ branch: "main" })) ?? "{}");
    expect(outcome.ok).toBe(true);
    expect(outcome.branch).toBe(TASK.branch);

    const pushCommand = commands.find((command) => command.includes("push"));
    expect(pushCommand).toContain(`push origin ${TASK.branch}`);
    expect(pushCommand).not.toContain("main");
    expect(pushCommand).not.toContain("--force");
  });

  test("a coworker that may only read cannot commit, push or open a pull request", async () => {
    const { tools, commands } = harness({ access: "read" });

    for (const name of ["repo_commit", "repo_push", "repo_open_pull_request"]) {
      const outcome = parse(
        (await tools.get(name)?.execute({
          message: "x",
          title: "x",
          body: "x",
        })) ?? "{}",
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.refused).toBe(true);
    }
    // Refused before anything reached the computer, not after.
    expect(commands).toHaveLength(0);
  });

  test("the grant is re-read at the tool, not trusted from when the task was made", async () => {
    // Revoked between task creation and the push: the run must notice.
    const { tools } = harness({ access: null });
    const outcome = parse((await tools.get("repo_push")?.execute({})) ?? "{}");
    expect(outcome.refused).toBe(true);
  });

  test("no credential means a refusal with a reason, not a confusing git error", async () => {
    const { tools } = harness({ credential: null });
    const outcome = parse((await tools.get("repo_push")?.execute({})) ?? "{}");
    expect(outcome.ok).toBe(false);
    expect(String(outcome.reason)).toContain("No credential");
  });

  test("a rejected push says the branch moved, and is not retried as a force", async () => {
    const { tools } = harness({
      exitCode: 1,
      stderr: "! [rejected] main -> main (non-fast-forward)",
    });
    const outcome = parse((await tools.get("repo_push")?.execute({})) ?? "{}");
    expect(String(outcome.reason)).toContain("moved");
    expect(String(outcome.reason)).toContain("not be forced");
  });

  test("a long command logs to a file and answers with the tail", async () => {
    const { tools, commands } = harness({ stdout: "exit:0" });
    const outcome = parse(
      (await tools.get("repo_run")?.execute({ command: "bun test" })) ?? "{}",
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.passed).toBe(true);
    // The whole point: the output is somewhere greppable rather than in the context window.
    expect(String(outcome.logPath)).toContain(TASK.id);
    expect(commands.some((command) => command.includes("tail -c"))).toBe(true);
  });

  test("a failing command is a result, not an error", async () => {
    const { tools } = harness({ stdout: "exit:1" });
    const outcome = parse(
      (await tools.get("repo_run")?.execute({ command: "bun test" })) ?? "{}",
    );
    // Tests failing is something the model must be able to read and act on.
    expect(outcome.ok).toBe(true);
    expect(outcome.passed).toBe(false);
    expect(outcome.exitCode).toBe(1);
  });

  test("nothing merges, approves or force-pushes, because no such tool exists", () => {
    const { tools } = harness();
    const names = [...tools.keys()];
    expect(names).not.toContain("repo_merge");
    expect(names).not.toContain("repo_approve");
    expect(names).not.toContain("repo_force_push");
    expect(names).toContain("repo_open_pull_request");
  });

  test("a pull request opens as a draft", async () => {
    const { tools, commands } = harness({
      stdout: '{"html_url": "https://github.com/CopilotKit/openbot/pull/300"}',
    });
    const outcome = parse(
      (await tools
        .get("repo_open_pull_request")
        ?.execute({ title: "Fix the culler", body: "What changed." })) ?? "{}",
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.draft).toBe(true);
    expect(outcome.pullRequestUrl).toBe(
      "https://github.com/CopilotKit/openbot/pull/300",
    );
    /*
     * Asserted on what is actually sent, not on the answer.
     *
     * The payload is shell-quoted into the command, so a substring match would be matching escape
     * sequences. Parsing it back is the only way to say "the request really was a draft".
     */
    const sent = commands.find((command) => command.includes("pr-body.json"));
    const payload = sent?.match(/printf '%s' (".*?}") >/)?.[1];
    expect(payload).toBeDefined();
    expect(JSON.parse(JSON.parse(payload as string))).toMatchObject({
      draft: true,
      base: TASK.base,
      head: TASK.branch,
    });
  });
});
