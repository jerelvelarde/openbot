import type { AbstractAgent } from "@ag-ui/client";
import type { AgentFetch, StallGuard } from "../channels/stall-guard";
import {
  type LoadAgentsForActor,
  type LoadToolsForBot,
  type RuntimeModel,
  resolveRuntimeAgents,
  type SignRun,
  type ToolSelection,
} from "../copilot";
import type { AgentActor } from "./profile-types";

export type ActorAgentResolver = {
  resolveAgentsForActor(
    actor: AgentActor,
  ): Promise<Record<string, AbstractAgent>>;
  resolveAgentForActor(
    actor: AgentActor,
    agentId: string,
  ): Promise<AbstractAgent>;
};

export type ActorAgentResolverDependencies = {
  loadAgents: LoadAgentsForActor;
  model: RuntimeModel;
  resolveModelApiKey: () => Promise<string | null>;
  stallGuard?: StallGuard;
  loadToolsForActor?: (actorId: string) => LoadToolsForBot;
  signRunForActor?: (actorId: string) => SignRun;
  computerGuidance?: string;
  loadVendors?: () => Promise<readonly string[]>;
  selectionForActor?: (actorId: string) => ToolSelection;
  agentFetch?: AgentFetch;
};

/**
 * Resolves the coworkers available to one OpenBot actor.
 *
 * Every surface enters through this boundary so it shares the same visibility, grants, assertions,
 * skill selection, and endpoint dial policy for a person.
 */
export function createActorAgentResolver(
  deps: ActorAgentResolverDependencies,
): ActorAgentResolver {
  const resolveRegisteredAgents = (
    actor: AgentActor,
    registered: Awaited<ReturnType<LoadAgentsForActor>>,
  ) =>
    resolveRuntimeAgents(
      () => Promise.resolve(registered),
      deps.model,
      deps.resolveModelApiKey,
      deps.stallGuard,
      deps.loadToolsForActor?.(actor.id),
      deps.signRunForActor?.(actor.id),
      deps.computerGuidance,
      deps.loadVendors,
      deps.selectionForActor?.(actor.id),
      deps.agentFetch,
    );

  const resolveAgentsForActor = async (actor: AgentActor) =>
    resolveRegisteredAgents(actor, await deps.loadAgents(actor));

  return {
    resolveAgentsForActor,
    async resolveAgentForActor(actor, agentId) {
      const registered = await deps.loadAgents(actor);
      if (!registered.some((agent) => agent.id === agentId)) {
        throw new Error(`Coworker ${agentId} is unavailable to this user.`);
      }

      const agents = await resolveRegisteredAgents(actor, registered);
      const agent = Object.hasOwn(agents, agentId)
        ? agents[agentId]
        : undefined;
      if (!agent) {
        throw new Error(`Coworker ${agentId} is unavailable to this user.`);
      }
      return agent;
    },
  };
}
