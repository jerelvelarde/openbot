import type { ToolSpec } from "./spec";

/**
 * The tools as AG-UI puts them on the wire, for a remote Bot.
 *
 * Exactly the shape `RunAgentInput.tools` carries, which is what the browser used to send after
 * registering the same tools locally. A remote Bot therefore sees no change at all: it still
 * receives a list of callable tools and still ends its run when it calls one. What changed is who
 * carries the call out on the other side.
 */
export function toAgUiTools(specs: ToolSpec[]) {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  }));
}
