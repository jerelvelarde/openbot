import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentActor } from "../agents/profile-types";

export type SlackExecution = {
  actor: AgentActor;
  applicationUser: { id: string; name: string };
  provider: "slack";
  providerTenantId: string;
  providerConversationId: string;
  providerThreadId: string;
  channelsThreadId?: string;
  messageText: string;
  agentId?: string;
};

const executionStorage = new AsyncLocalStorage<SlackExecution>();

/** Runs server-side Slack work without placing its private facts in agent inputs. */
export function runWithSlackExecution<T>(
  execution: SlackExecution,
  run: () => T,
): T {
  return executionStorage.run(execution, run);
}

/** Reads the server-private execution facts for the current Slack turn. */
export function currentSlackExecution(): SlackExecution {
  const execution = executionStorage.getStore();
  if (!execution) {
    throw new Error("A Slack agent run requires a private execution context.");
  }
  return execution;
}
