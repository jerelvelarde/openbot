/**
 * What a tool is, on this side of the wire.
 *
 * One shape for every tool the server hands a Bot, whether it drives a browser or calls somebody
 * else's MCP server. It exists because the two consumers do not care which kind a tool is: a
 * `BuiltInAgent` needs Zod parameters and an executor, a remote AG-UI Bot needs JSON Schema on the
 * wire and somebody to carry the call out, and both conversions are written once against this.
 *
 * Parameters are JSON Schema rather than Zod deliberately. That is the shape AG-UI puts in
 * `RunAgentInput.tools`, and it is also what an MCP server advertises, so the tools that come from
 * outside need no translation at all and the tools declared here need exactly one.
 */

/**
 * The JSON Schema subset both consumers accept.
 *
 * Mirrored here rather than imported, because the runtime declares its equivalent without exporting
 * it, and importing anything else from `@copilotkit/runtime/v2` in this module would drag
 * `eventsource` in with it — the require hazard `runtime-tools.ts` exists to contain.
 *
 * Recursive on purpose. A tool declared in this repo has flat parameters, but a tool advertised by
 * somebody else's MCP server can nest objects and arrays, and flattening those would describe a
 * different tool to the model than the one the server actually has.
 */
export type ToolParameterSchema = {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
  items?: ToolParameterSchema;
  enum?: string[];
  anyOf?: ToolParameterSchema[];
  oneOf?: ToolParameterSchema[];
};

export type ToolParameters = ToolParameterSchema & {
  type: "object";
  properties: Record<string, ToolParameterSchema>;
};

/**
 * What a governed tool returns: the result, or a reason it did not happen.
 *
 * `ok` is always present so a model never has to infer failure from a missing field. A refusal is an
 * outcome, not an exception: the Bot has to be able to read it and decide what to do instead, and an
 * error would end the run before it could.
 */
export type ToolOutcome = Record<string, unknown> & { ok: boolean };

/**
 * One tool, independent of how it is eventually handed to a model.
 *
 * `execute` must not throw. Everything that can go wrong — a refusal, a stale reference, an
 * unreachable computer, a vendor error — is a value the model reads.
 */
export type ToolSpec = {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (args: Record<string, unknown>) => Promise<ToolOutcome>;
};
