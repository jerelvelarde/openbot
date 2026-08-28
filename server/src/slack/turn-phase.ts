export const SLACK_TURN_PHASES = [
  "identity.resolve",
  "ingress.remember",
  "ingress.take",
  "identity.validate",
  "link_card.post",
  "thread.subscribe",
  "execution.prepare",
  "agent.run",
] as const;

export type SlackTurnPhase = (typeof SLACK_TURN_PHASES)[number];
export type SlackTurnFailureEvent = {
  type: "slack-turn-failed";
  phase: SlackTurnPhase;
};
export type SlackTurnFailureLogger = (event: SlackTurnFailureEvent) => void;

export const defaultSlackTurnFailureLogger: SlackTurnFailureLogger = (
  event,
) => {
  console.error(JSON.stringify(event));
};

export async function runSlackPhase<T>(
  phase: SlackTurnPhase,
  operation: () => T | Promise<T>,
  logger: SlackTurnFailureLogger,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    try {
      logger({ type: "slack-turn-failed", phase });
    } catch {
      // Observability must never replace the application failure.
    }
    throw error;
  }
}
