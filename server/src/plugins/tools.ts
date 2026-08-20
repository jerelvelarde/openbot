/**
 * The MCP tools a Bot has been granted, executed on the server.
 *
 * The same move the computer tools made, for the same reason. These were registered in the browser
 * with `useFrontendTool` and each handler posted to `/api/plugins/call` — a round trip back to this
 * process, which then did the work. A Bot whose person had closed the tab therefore had no MCP at
 * all, which makes "no tab, no computer" only half the story: an unattended Bot could not reach
 * anybody else's server either.
 *
 * Nothing about governance moves. `store.callTool` still decides the grant, evaluates the policy,
 * writes the audit row and only then calls out, in that order. This file is the offering, not the
 * deciding: it lists what a Bot holds and hands each one to a model in the shape a tool takes.
 *
 * What stays in the browser is the drawing. A vendor's markdown is still rendered as markdown in the
 * transcript, from the result this returns.
 */

import type { ToolParameters, ToolSpec } from "../tools/spec";
import type { GrantedPlugins, PluginStore } from "./store";
import { PluginRefusedError } from "./store";

export type PluginToolsContext = {
  store: PluginStore;
  /** The Bot the grants belong to. A grant is per-Bot, so this decides the whole list. */
  botId: string;
  /** Who is asking, for the audit row `store.callTool` writes. */
  actorId: string;
};

/**
 * A vendor's advertised input schema, as tool parameters.
 *
 * MCP servers advertise JSON Schema, which is what this side wants anyway, so the usual case is a
 * pass-through. A server that advertises something that is not an object schema gets an empty
 * parameter set rather than a guess: a model told the wrong shape will call the tool wrongly, and
 * the vendor's own error is a worse explanation than "this tool takes nothing".
 */
export function parametersOf(inputSchema: unknown): ToolParameters {
  if (
    typeof inputSchema === "object" &&
    inputSchema !== null &&
    !Array.isArray(inputSchema)
  ) {
    const schema = inputSchema as Record<string, unknown>;
    const properties = schema.properties;
    if (
      typeof properties === "object" &&
      properties !== null &&
      !Array.isArray(properties)
    ) {
      return {
        type: "object",
        properties: properties as ToolParameters["properties"],
        ...(Array.isArray(schema.required)
          ? {
              required: schema.required.filter(
                (n): n is string => typeof n === "string",
              ),
            }
          : {}),
      };
    }
  }
  return { type: "object", properties: {} };
}

/**
 * The description a model is shown.
 *
 * The vendor's own words with the server named after them. A Bot choosing between two servers that
 * both offer something called "search" needs to know which is which, and vendors do not write their
 * descriptions expecting to sit beside a competitor's.
 */
export function describeTool(tool: GrantedPlugins["tools"][number]): string {
  const [serverId, ...rest] = tool.ref.split("/");
  const bare = rest.join("/");
  return tool.description
    ? `${tool.description} (${serverId})`
    : `${bare} on ${serverId}.`;
}

/**
 * Build the MCP tools for one Bot and one person.
 *
 * Asynchronous because the list is a question about the database: which servers this Bot has been
 * granted, and what those servers said they can do. Resolved per run rather than per process so a
 * grant taken away a moment ago is gone from the very next run, without a restart.
 */
export async function createPluginToolSpecs(
  context: PluginToolsContext,
): Promise<ToolSpec[]> {
  const { store, botId, actorId } = context;
  const granted = await store.listForAgent(botId);

  return granted.tools.map((tool) => ({
    name: tool.toolName,
    description: describeTool(tool),
    parameters: parametersOf(tool.inputSchema),
    execute: async (args) => {
      try {
        const result = await store.callTool({
          ref: tool.ref,
          args,
          botId,
          actorId,
        });
        // A vendor error is a result, not a failure of the call: the tool was permitted and did run.
        // Told apart from a refusal so a Bot reading this knows whether trying differently could help.
        return result.isError
          ? { ok: false, text: result.text, vendorError: true }
          : { ok: true, text: result.text };
      } catch (error) {
        if (error instanceof PluginRefusedError) {
          return {
            ok: false,
            reason: error.message,
            refused: true,
            rule: error.rule,
          };
        }
        return {
          ok: false,
          reason:
            error instanceof Error
              ? error.message
              : `${tool.ref} could not be reached.`,
        };
      }
    },
  }));
}
