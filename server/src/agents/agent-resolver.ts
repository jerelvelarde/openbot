import type { AbstractAgent } from "@ag-ui/client";
import type { AgentFetch, StallGuard } from "../channels/stall-guard";
import {
  type HandoffForRun,
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
  /**
   * The one coworker, or null when it is not this actor's to see.
   *
   * NULL IS RESERVED FOR ABSENCE FROM THE ROSTER. Anything else — a model key that cannot be read, a
   * database that blinked — is raised. A caller that turned those into "no such coworker" would tell
   * somebody their Bot had been deleted every time the deployment had a bad minute, and a hop or a
   * routine would stop retrying something that was coming back.
   */
  findAgentForActor(
    actor: AgentActor,
    agentId: string,
  ): Promise<AbstractAgent | null>;
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
  /**
   * How a run gets its tools for reaching past itself: handing work to another Bot, and asking a
   * person.
   *
   * Per actor for the same reason the tools are: which Bots may be reached is decided against the
   * roster that person can see, so a Bot must never be able to address one they cannot.
   */
  handoffForActor?: (actorId: string) => HandoffForRun;
};

/**
 * Resolves the coworkers available to one OpenBot actor.
 *
 * Every surface enters through this boundary so it shares the same visibility, grants, assertions,
 * skill selection, endpoint dial policy, and reach past itself for a person. A chat request, a Slack
 * message, a delivered hop and a routine's headless turn all build a Bot here, which is what makes
 * "the same Bot however it was asked" structural rather than a thing four call sites have to agree on.
 */
export function createActorAgentResolver(
  deps: ActorAgentResolverDependencies,
): ActorAgentResolver {
  const resolveRegisteredAgents = (
    actor: AgentActor,
    registered: Awaited<ReturnType<LoadAgentsForActor>>,
    /**
     * Build only this one, when the caller wants only this one.
     *
     * A hop delivery and a routine's turn each want a single Bot, and both were resolving the whole
     * roster to reach it: every registered Bot constructed, and a granted-tools query for each, with
     * all but one thrown away. The roster above is still read in full, because which Bots exist for
     * this person is what decides whether the one asked for is theirs to see at all; what narrows is
     * what gets built.
     */
    onlyBotId?: string,
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
      deps.handoffForActor?.(actor.id),
      onlyBotId,
    );

  const resolveAgentsForActor = async (actor: AgentActor) =>
    resolveRegisteredAgents(actor, await deps.loadAgents(actor));

  const findAgentForActor = async (actor: AgentActor, agentId: string) => {
    const registered = await deps.loadAgents(actor);
    if (!registered.some((agent) => agent.id === agentId)) return null;
    const agents = await resolveRegisteredAgents(actor, registered, agentId);
    return Object.hasOwn(agents, agentId) ? (agents[agentId] ?? null) : null;
  };

  return {
    resolveAgentsForActor,
    findAgentForActor,
    async resolveAgentForActor(actor, agentId) {
      const agent = await findAgentForActor(actor, agentId);
      if (!agent) {
        throw new Error(`Coworker ${agentId} is unavailable to this user.`);
      }
      return agent;
    },
  };
}
