import { describe, expect, test } from "bun:test";
import {
  ComputerUnavailableError,
  StaleSnapshotError,
  WorkspaceRequestError,
} from "../src/computer/client";
import {
  ActionRefusedError,
  type ComputerGateway,
} from "../src/computer/gateway";
import {
  type ComputerToolSpec,
  createComputerToolSpecs,
} from "../src/computer/tools";

/**
 * What the server-side tools must guarantee.
 *
 * These tools replace handlers that used to run in the browser, so the properties worth pinning are
 * the ones that would silently change when execution moved:
 *  - a refusal is an OUTCOME the model can read, never a thrown error that ends the run
 *  - the outcome keys stay the ones the transcript renderers already parse
 *  - the gateway is addressed as the Bot, and carries the person, so the audit row is attributable
 *  - a wait for a person is finite, and gives up with an instruction rather than hanging
 *  - a secret's value is never in anything this module returns
 */

const ACTOR = { id: "user_1", userId: "user_1" };

type GatewayCall = { method: string; args: unknown[] };

/** A gateway that records what reached it and can be told to fail a given way. */
function fakeGateway(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: GatewayCall[] = [];
  const record =
    (method: string, result: unknown = { action: method }) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    };

  const gateway = {
    navigate: record("navigate", {
      title: "Order",
      url: "https://example.com",
    }),
    read: record("read", { text: "hello" }),
    snapshot: record("snapshot", { snapshotId: 7, elements: [] }),
    click: record("click"),
    type: record("type"),
    key: record("key"),
    scroll: record("scroll"),
    listFiles: record("listFiles", { entries: [] }),
    readFile: record("readFile", { contents: "note" }),
    writeFile: record("writeFile", { written: true }),
    requestSecret: record("requestSecret", { secretWanted: { label: "code" } }),
    requestHelp: record("requestHelp", { requested: true }),
    control: record("control", { holder: "bot", requested: false }),
    ...overrides,
  } as unknown as ComputerGateway;

  return { gateway, calls };
}

function specsFor(
  gateway: ComputerGateway,
  extra: { recordRefusal?: (input: { reason: string }) => Promise<void> } = {},
) {
  return createComputerToolSpecs({
    gateway,
    botId: "risk-analyst",
    actor: ACTOR,
    // A wait that resolves immediately, so the give-up path is provable in a test rather than in
    // ten minutes.
    waitFor: { timeoutMs: 5, pollMs: 1, sleep: () => Promise.resolve() },
    ...extra,
  });
}

function toolNamed(specs: ComputerToolSpec[], name: string): ComputerToolSpec {
  const spec = specs.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`No tool called ${name}`);
  return spec;
}

describe("computer tools", () => {
  test("every tool the browser registered still exists, under the same name", () => {
    const { gateway } = fakeGateway();
    const names = specsFor(gateway).map((spec) => spec.name);

    // The list the surface used to register. A name that disappears here is a capability a Bot
    // silently loses, and nothing else in the suite would notice.
    expect(names.sort()).toEqual(
      [
        "computer_click",
        "computer_key",
        "computer_list_files",
        "computer_navigate",
        "computer_read",
        "computer_read_file",
        "computer_request_help",
        "computer_request_secret",
        "computer_scroll",
        "computer_snapshot",
        "computer_type",
        "computer_write_file",
        "report_refusal",
      ].sort(),
    );
  });

  test("a successful call passes the gateway's result through", async () => {
    const { gateway } = fakeGateway();
    const result = await toolNamed(
      specsFor(gateway),
      "computer_navigate",
    ).execute({
      url: "https://example.com",
    });

    expect(result).toEqual({
      ok: true,
      title: "Order",
      url: "https://example.com",
    });
  });

  test("the gateway is addressed as the Bot, and told who is asking", async () => {
    const { gateway, calls } = fakeGateway();
    await toolNamed(specsFor(gateway), "computer_click").execute({
      ref: "e9",
      snapshotId: 7,
    });

    const click = calls.find((call) => call.method === "click");
    // computerId and botId are the same value, matching how the HTTP routes call it, and the actor
    // travels with every acting call because the audit row is attributed to a person.
    expect(click?.args.slice(0, 3)).toEqual([
      "risk-analyst",
      "risk-analyst",
      ACTOR,
    ]);
    expect(click?.args[3]).toEqual({ ref: "e9", snapshotId: 7 });
  });

  test("a policy refusal is returned, not thrown, and names the rule", async () => {
    const { gateway } = fakeGateway({
      click: () =>
        Promise.reject(
          new ActionRefusedError(
            "This deployment's policy does not allow that.",
            'contains(element.name, "Submit")',
          ),
        ),
    });

    const result = await toolNamed(specsFor(gateway), "computer_click").execute(
      {
        ref: "e9",
        snapshotId: 7,
      },
    );

    // Thrown, this would end the run and the person would see a malfunction instead of a boundary.
    expect(result).toEqual({
      ok: false,
      reason: "This deployment's policy does not allow that.",
      refused: true,
      rule: 'contains(element.name, "Submit")',
    });
  });

  test("a stale snapshot and a person at the wheel are told apart", async () => {
    const stale = fakeGateway({
      click: () => Promise.reject(new StaleSnapshotError("Refs are stale.")),
    });
    const driving = fakeGateway({
      click: () =>
        Promise.reject(
          new ComputerUnavailableError(
            "A person has control of this computer.",
          ),
        ),
    });

    const staleResult = await toolNamed(
      specsFor(stale.gateway),
      "computer_click",
    ).execute({ ref: "e9", snapshotId: 7 });
    const drivingResult = await toolNamed(
      specsFor(driving.gateway),
      "computer_click",
    ).execute({ ref: "e9", snapshotId: 7 });

    // Both arrived as HTTP 409 before, and the browser called both "stale", which sent a Bot to take
    // another snapshot while somebody was still driving. The typed error is available here, so they
    // are classified apart.
    expect(staleResult.staleRefs).toBe(true);
    expect(staleResult.humanHasControl).toBeUndefined();
    expect(drivingResult.humanHasControl).toBe(true);
    expect(drivingResult.staleRefs).toBeUndefined();
  });

  test("a missing file is not reported as a refusal", async () => {
    const { gateway } = fakeGateway({
      readFile: () =>
        Promise.reject(
          new WorkspaceRequestError("There is no file at notes.md."),
        ),
    });

    const result = await toolNamed(
      specsFor(gateway),
      "computer_read_file",
    ).execute({ path: "notes.md" });

    // A Bot that reads "blocked" stops trying. A Bot that reads "no such file" lists the workspace.
    expect(result.ok).toBe(false);
    expect(result.refused).toBeUndefined();
    expect(result.reason).toBe("There is no file at notes.md.");
  });

  test("waiting for help resolves when the wheel comes back", async () => {
    let looks = 0;
    const { gateway } = fakeGateway({
      control: () => {
        looks += 1;
        // Still driving on the first look, handed back on the second.
        return Promise.resolve(
          looks < 2
            ? { holder: "human", requested: true }
            : { holder: "bot", requested: false },
        );
      },
    });

    const result = await toolNamed(
      specsFor(gateway),
      "computer_request_help",
    ).execute({ reason: "This page wants a code from your phone." });

    expect(result.ok).toBe(true);
    expect(String(result.result)).toContain("handed control back");
  });

  test("waiting for help gives up rather than hanging", async () => {
    const { gateway } = fakeGateway({
      // Nobody ever takes the wheel.
      control: () => Promise.resolve({ holder: "human", requested: true }),
    });

    const result = await toolNamed(
      specsFor(gateway),
      "computer_request_help",
    ).execute({ reason: "Please sign in." });

    // A run that cannot end is worse than one that ends badly: the channel is locked until restart.
    expect(result.ok).toBe(true);
    expect(String(result.result)).toContain("Nobody took control");
  });

  test("a supplied secret is acknowledged without its value", async () => {
    let looks = 0;
    const { gateway } = fakeGateway({
      control: () => {
        looks += 1;
        return Promise.resolve(
          looks < 2 ? { secretWanted: { label: "the code" } } : {},
        );
      },
    });

    const result = await toolNamed(
      specsFor(gateway),
      "computer_request_secret",
    ).execute({ label: "the code", ref: "e4", snapshotId: 7 });

    const said = JSON.stringify(result);
    expect(result.ok).toBe(true);
    expect(said).toContain("the code");
    // The label is the only thing that may travel. Anything resembling a value must not.
    expect(said).not.toContain("secretWanted");
  });

  test("a self-reported refusal is recorded, and answering survives the recording failing", async () => {
    const recorded: { reason: string }[] = [];
    const { gateway } = fakeGateway();

    const ok = await toolNamed(
      specsFor(gateway, {
        recordRefusal: async (input) => {
          recorded.push(input);
        },
      }),
      "report_refusal",
    ).execute({ reason: "That would move money." });
    expect(recorded).toEqual([{ reason: "That would move money." }]);
    expect(ok.ok).toBe(true);

    const broken = await toolNamed(
      specsFor(gateway, {
        recordRefusal: () => Promise.reject(new Error("database is down")),
      }),
      "report_refusal",
    ).execute({ reason: "That would move money." });

    // Bookkeeping must not stop the Bot answering the person in front of it.
    expect(broken.ok).toBe(true);
    expect(String(broken.result)).toContain("Tell the person");
  });
});
