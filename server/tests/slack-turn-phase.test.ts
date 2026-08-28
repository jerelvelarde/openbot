import { describe, expect, test } from "bun:test";
import {
  runSlackPhase,
  SLACK_TURN_PHASES,
  type SlackTurnFailureEvent,
} from "../src/slack/turn-phase";

describe("Slack turn phase diagnostics", () => {
  test("logs only the fixed event type and phase for every allowed phase", async () => {
    for (const phase of SLACK_TURN_PHASES) {
      const events: SlackTurnFailureEvent[] = [];
      const original = new Error("sensitive failure");

      await expect(
        runSlackPhase(
          phase,
          async () => {
            throw original;
          },
          (event) => events.push(event),
        ),
      ).rejects.toBe(original);

      expect(events).toEqual([{ type: "slack-turn-failed", phase }]);
      expect(Object.keys(events[0] ?? {}).sort()).toEqual(["phase", "type"]);
      expect(JSON.stringify(events)).not.toContain("sensitive");
    }
  });

  test("successful operations are silent", async () => {
    const events: SlackTurnFailureEvent[] = [];
    await expect(
      runSlackPhase(
        "identity.resolve",
        () => "linked",
        (event) => events.push(event),
      ),
    ).resolves.toBe("linked");
    expect(events).toEqual([]);
  });

  test("logger failure cannot replace the application error", async () => {
    const original = new Error("application failure");
    await expect(
      runSlackPhase(
        "agent.run",
        async () => {
          throw original;
        },
        () => {
          throw new Error("logger failure");
        },
      ),
    ).rejects.toBe(original);
  });
});
