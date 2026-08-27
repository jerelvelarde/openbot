import { describe, expect, test } from "bun:test";
import {
  currentSlackExecution,
  runWithSlackExecution,
  type SlackExecution,
} from "../src/slack/execution-context";

function execution(id: string): SlackExecution {
  return {
    actor: { id, role: "user" },
    applicationUser: { id, name: id },
    provider: "slack",
    providerTenantId: "T1",
    providerConversationId: "C1",
    providerThreadId: "thread-1",
    messageText: "hello",
  };
}

describe("private Slack execution context", () => {
  test("survives await and microtask boundaries", async () => {
    const value = execution("alice");
    await runWithSlackExecution(value, async () => {
      await Promise.resolve();
      expect(currentSlackExecution()).toBe(value);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(currentSlackExecution()).toBe(value);
    });
  });

  test("isolates overlapping turns", async () => {
    let releaseAlice!: () => void;
    const aliceGate = new Promise<void>((resolve) => (releaseAlice = resolve));
    const alice = runWithSlackExecution(execution("alice"), async () => {
      await aliceGate;
      return currentSlackExecution().actor.id;
    });
    const bob = runWithSlackExecution(execution("bob"), async () => {
      await Promise.resolve();
      return currentSlackExecution().actor.id;
    });

    await expect(bob).resolves.toBe("bob");
    releaseAlice();
    await expect(alice).resolves.toBe("alice");
  });

  test("restores an outer run after a nested run", async () => {
    await runWithSlackExecution(execution("alice"), async () => {
      expect(currentSlackExecution().actor.id).toBe("alice");
      await runWithSlackExecution(execution("bob"), async () => {
        expect(currentSlackExecution().actor.id).toBe("bob");
      });
      expect(currentSlackExecution().actor.id).toBe("alice");
    });
  });

  test("requires a private context outside Slack execution", () => {
    expect(() => currentSlackExecution()).toThrow(
      "A Slack agent run requires a private execution context.",
    );
  });
});
