import { describe, expect, test } from "bun:test";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { createActorAgentResolver } from "../src/agents/agent-resolver";

describe("actor-scoped agent resolver", () => {
  test("uses the same actor for web maps and individual agent resolution", async () => {
    const seenActorIds: string[] = [];
    const resolver = createActorAgentResolver({
      loadAgents: async (actor) => {
        seenActorIds.push(actor.id);
        return [
          {
            id: "risk",
            name: "Risk Analyst",
            type: "built_in" as const,
            systemPrompt: "Assess operational risk.",
          },
        ];
      },
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey: async () => "openai-secret",
    });
    const actor = { id: "u1", role: "user" as const };

    const visibleAgents = await resolver.resolveAgentsForActor(actor);
    const risk = await resolver.resolveAgentForActor(actor, "risk");

    expect(seenActorIds).toEqual(["u1", "u1"]);
    expect(visibleAgents.risk).toBeInstanceOf(BuiltInAgent);
    expect(risk).toBeInstanceOf(BuiltInAgent);
  });

  test("rejects an agent absent from the actor's visible map", async () => {
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        {
          id: "risk",
          name: "Risk Analyst",
          type: "built_in" as const,
          systemPrompt: "Assess operational risk.",
        },
      ],
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey: async () => "openai-secret",
    });

    await expect(
      resolver.resolveAgentForActor({ id: "u1", role: "user" }, "private-risk"),
    ).rejects.toThrow("Coworker private-risk is unavailable to this user.");
  });
});
