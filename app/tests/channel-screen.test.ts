import { expect, test } from "bun:test";
import type { AgentChannel } from "@/lib/channels/queries";
import {
  channelBodyState,
  shouldOpenForNeedsYou,
} from "@/routes/_authed/_app/channel/$channelId";

/** A fully-typed channel, so these tests build real objects rather than casts. */
function channel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: "channel-1",
    name: "Assistant channel",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
    archived: false,
    ...overrides,
  };
}

/*
 * THE ONE THAT MATTERS: a failed refetch must not take the conversation down with it.
 *
 * React Query v5 keeps the previous `data` beside a refetch's `error`, and this screen refetches on
 * every mount and on every channel create (see `channelBodyState`'s docblock for the chain). A
 * blocking state that consulted `error` unmounted a readable transcript, and the composer's unsent
 * draft with it, for a transient 500. This is the case that cannot be told apart from a first-load
 * failure by looking at the rendered screen, which is why it is pinned here rather than left to a
 * reader of the component.
 */
test("a failed refetch keeps the transcript and reports the failure beside it", () => {
  expect(
    channelBodyState({
      channel: channel(),
      isPending: false,
      error: new Error("The channel service is unavailable"),
    }),
  ).toEqual({
    kind: "chat",
    channel: channel(),
    runtimeAgentId: "agent-1",
    refreshProblem: "The channel service is unavailable",
  });
});

test("a channel that loaded cleanly has nothing to report beside it", () => {
  expect(
    channelBodyState({ channel: channel(), isPending: false, error: null }),
  ).toEqual({
    kind: "chat",
    channel: channel(),
    runtimeAgentId: "agent-1",
    refreshProblem: undefined,
  });
});

/*
 * A first load with nothing to show is the case that does block — and it says what the server said.
 * `client` throws the API's own `error` field, so discarding `error.message` for a sentence of this
 * screen's own threw away the only part a person could act on.
 */
test("a first load that failed says what the server said", () => {
  expect(
    channelBodyState({
      channel: undefined,
      isPending: false,
      error: new Error("You are not a member of this channel"),
    }),
  ).toEqual({
    kind: "unavailable",
    message: "You are not a member of this channel",
  });
});

test("no data and no error still says something", () => {
  expect(
    channelBodyState({ channel: undefined, isPending: false, error: null }),
  ).toEqual({ kind: "unavailable", message: "Could not load this channel." });
});

test("a loading channel draws nothing at all", () => {
  expect(
    channelBodyState({ channel: undefined, isPending: true, error: null }),
  ).toEqual({ kind: "loading" });
});

/*
 * Checked after the channel, so a channel that cannot be rendered is reported as that rather than as
 * a load failure: the transcript is missing because the runtime cannot route between two coworkers,
 * which is not something a person can retry.
 */
test("more than one coworker is unsupported rather than broken", () => {
  expect(
    channelBodyState({
      channel: channel({ agentIds: ["agent-1", "agent-2"] }),
      isPending: false,
      error: null,
    }),
  ).toEqual({ kind: "unsupported" });
});

test("no prompt, no pane", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: false,
      isPaneOpen: false,
      dismissedEpoch: null,
      runEpoch: 4,
    }),
  ).toBe(false);
});

test("a live prompt opens the screen pane", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissedEpoch: null,
      runEpoch: 4,
    }),
  ).toBe(true);
});

/*
 * An open pane is left alone. Settings and watch are one pane with two contents, so auto-opening the
 * screen over settings somebody deliberately opened takes their panel away to tell them something the
 * amber dot on the Watch button is already telling them.
 */
test("a live prompt does not take the pane away from settings", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: true,
      dismissedEpoch: null,
      runEpoch: 4,
    }),
  ).toBe(false);
});

/*
 * The defect this guard exists for: closing the pane while the Bot is still waiting used to be inert.
 * Clearing `watch` resumes `useNeedsYou`'s polling, the prompt is still live, and the pane reopened —
 * so the person could not keep it closed for as long as the Bot was stuck.
 */
test("a dismissal for this run keeps the pane closed while the prompt is still live", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissedEpoch: 4,
      runEpoch: 4,
    }),
  ).toBe(false);
});

test("a dismissal expires with its run", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissedEpoch: 4,
      runEpoch: 5,
    }),
  ).toBe(true);
});

/*
 * Both null is a dismissal recorded before any browser action was reported — `reportComputerActivity`
 * counts from 1, so a real epoch is never null. The dismissal holds until an action is reported,
 * which is the same "until the next run" rule with no run yet to compare against, and is the case a
 * guard written as `dismissedEpoch !== null && ...` would silently get wrong.
 */
test("a dismissal before any run has been reported still holds", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissedEpoch: null,
      runEpoch: null,
    }),
  ).toBe(false);
});
