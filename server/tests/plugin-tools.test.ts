import { describe, expect, test } from "bun:test";
import type { PluginStore } from "../src/plugins/store";
import { PluginRefusedError } from "../src/plugins/store";
import {
  createPluginToolSpecs,
  describeTool,
  parametersOf,
} from "../src/plugins/tools";

/**
 * What the server-side MCP tools must guarantee.
 *
 * These replace handlers that ran in the browser, so the properties worth pinning are the ones that
 * would change silently now that execution moved:
 *  - a refusal is an OUTCOME the model reads, never a thrown error that ends the run
 *  - a vendor's own error is told apart from a refusal, because one is worth retrying and one is not
 *  - the grant decides the list, and it is asked per run rather than captured
 *  - a vendor schema that is not an object schema does not become a guess
 */

type Call = {
  ref: string;
  args: Record<string, unknown>;
  botId: string;
  actorId: string;
};

function fakeStore(options: {
  tools?: {
    ref: string;
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  result?: { text: string; isError: boolean } | Error;
}) {
  const calls: Call[] = [];
  const store = {
    listForAgent: async () => ({ tools: options.tools ?? [], skills: [] }),
    callTool: async (input: Call) => {
      calls.push(input);
      if (options.result instanceof Error) throw options.result;
      return options.result ?? { text: "ok", isError: false };
    },
  } as unknown as PluginStore;
  return { store, calls };
}

const SEARCH = {
  ref: "linear/search_issues",
  toolName: "mcp__linear__search_issues",
  description: "Search issues.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "What to look for" } },
    required: ["query"],
  },
};

describe("the MCP tools a Bot holds", () => {
  test("offers exactly what the Bot was granted, under the name the model sees", async () => {
    const { store } = fakeStore({ tools: [SEARCH] });

    const specs = await createPluginToolSpecs({
      store,
      botId: "risk-analyst",
      actorId: "user_1",
    });

    expect(specs.map((spec) => spec.name)).toEqual([
      "mcp__linear__search_issues",
    ]);
    // The vendor's schema passes straight through: it is already the shape both consumers want, and
    // rewriting it would describe a different tool to the model than the server actually has.
    expect(specs[0]?.parameters).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
      },
      required: ["query"],
    });
  });

  test("a Bot granted nothing is offered nothing", async () => {
    const { store } = fakeStore({});
    expect(
      await createPluginToolSpecs({ store, botId: "b", actorId: "u" }),
    ).toEqual([]);
  });

  test("carries the Bot and the person, so the audit row is attributable", async () => {
    const { store, calls } = fakeStore({ tools: [SEARCH] });
    const [spec] = await createPluginToolSpecs({
      store,
      botId: "risk-analyst",
      actorId: "user_1",
    });

    const outcome = await spec?.execute({ query: "overdue" });

    expect(calls).toEqual([
      {
        ref: "linear/search_issues",
        args: { query: "overdue" },
        botId: "risk-analyst",
        actorId: "user_1",
      },
    ]);
    expect(outcome).toEqual({ ok: true, text: "ok" });
  });

  test("a refusal is an outcome, not a thrown error", async () => {
    const { store } = fakeStore({
      tools: [SEARCH],
      result: new PluginRefusedError(
        "A boundary in this deployment refused that.",
        'mcp.tool == "search_issues"',
      ),
    });
    const [spec] = await createPluginToolSpecs({
      store,
      botId: "b",
      actorId: "u",
    });

    // Thrown, the run would end with a stack trace. As an outcome the Bot can read the rule, say what
    // happened, and do something else.
    expect(await spec?.execute({ query: "x" })).toEqual({
      ok: false,
      reason: "A boundary in this deployment refused that.",
      refused: true,
      rule: 'mcp.tool == "search_issues"',
    });
  });

  test("a vendor's own error is not a refusal", async () => {
    const { store } = fakeStore({
      tools: [SEARCH],
      result: { text: "rate limited", isError: true },
    });
    const [spec] = await createPluginToolSpecs({
      store,
      botId: "b",
      actorId: "u",
    });

    // The call was permitted and did run. A Bot that reads "refused" stops trying; a Bot that reads a
    // vendor error can wait and try again.
    expect(await spec?.execute({})).toEqual({
      ok: false,
      text: "rate limited",
      vendorError: true,
    });
  });

  test("an unreachable server is reported, not thrown", async () => {
    const { store } = fakeStore({
      tools: [SEARCH],
      result: new Error("fetch failed"),
    });
    const [spec] = await createPluginToolSpecs({
      store,
      botId: "b",
      actorId: "u",
    });

    expect(await spec?.execute({})).toEqual({
      ok: false,
      reason: "fetch failed",
    });
  });

  test("a schema that is not an object schema becomes no parameters, not a guess", () => {
    // A model told the wrong shape calls the tool wrongly, and the vendor's resulting error explains
    // less than "this tool takes nothing" would.
    expect(parametersOf({ type: "string" })).toEqual({
      type: "object",
      properties: {},
    });
    expect(parametersOf(null)).toEqual({ type: "object", properties: {} });
    expect(parametersOf([1, 2])).toEqual({ type: "object", properties: {} });
  });

  test("names the server in the description, so two searches are tellable apart", () => {
    expect(describeTool(SEARCH)).toBe("Search issues. (linear)");
    // A vendor that advertises no description still gets one, rather than an empty string the model
    // has to guess from.
    expect(describeTool({ ...SEARCH, description: "" })).toBe(
      "search_issues on linear.",
    );
  });
});
