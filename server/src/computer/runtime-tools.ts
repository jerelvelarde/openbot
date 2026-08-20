/**
 * Hand the computer tools to the runtime.
 *
 * Split from `tools.ts` on purpose. This module imports `@copilotkit/runtime/v2`, which pulls in
 * `eventsource`, which Bun cannot `require()` from a test — the same hazard `copilot.ts` documents
 * for `createApp`. Keeping the tool definitions themselves runtime-free means they stay testable
 * without booting a runtime, and this file holds the one import that costs something.
 */
import {
  convertJsonSchemaToZodSchema,
  defineTool,
  type ToolDefinition,
} from "@copilotkit/runtime/v2";
import { runTool, type ToolSpec } from "../tools/spec";

/**
 * The tools as a `BuiltInAgent` takes them.
 *
 * The JSON Schema each spec carries is converted rather than re-declared, so the schema a remote
 * AG-UI Bot receives on the wire and the schema a built-in Bot is given cannot drift into describing
 * different tools under the same names.
 */
export function toRuntimeTools(specs: ToolSpec[]): ToolDefinition[] {
  return specs.map((spec) =>
    defineTool({
      name: spec.name,
      description: spec.description,
      // `true` says the parameter object itself is required; optionality of each property is read
      // from the schema's own `required` list by the converter.
      parameters: convertJsonSchemaToZodSchema(spec.parameters, true),
      execute: (args) => runTool(spec, (args ?? {}) as Record<string, unknown>),
    }),
  );
}
