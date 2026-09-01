import { expect, test } from "bun:test";
import type { AgentChannel } from "@/lib/channels/queries";
import {
  channelBodyState,
  shouldOpenForNeedsYou,
  shouldRecordDismissal,
  soleAgentId,
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

/*
 * The other end of the same check, and a shape the server deliberately produces: `GET
 * /api/channels/:id` joins `channel_agents` loosely, so a channel whose rows a tenant-package sync
 * has deleted still loads with `agentIds: []`. Both counts used to collapse into `unsupported`, whose
 * one sentence — "more than one coworker" — was then the only thing on the screen and was false.
 * Nothing else covers it: `active` is vacuously true for a channel with no coworker to report gone.
 */
test("no coworker at all is its own state, not more than one", () => {
  expect(
    channelBodyState({
      channel: channel({ agentIds: [] }),
      isPending: false,
      error: null,
    }),
  ).toEqual({ kind: "no-coworker" });
});

/*
 * The header derives its agent from the same rule the body does, so the buttons cannot offer to watch
 * and to open a profile for a coworker the body is refusing to render a transcript for.
 */
test("the header acts on a coworker only when the channel holds exactly one", () => {
  expect(soleAgentId(["agent-1"])).toBe("agent-1");
  expect(soleAgentId([])).toBeUndefined();
  expect(soleAgentId(["agent-1", "agent-2"])).toBeUndefined();
  expect(soleAgentId(undefined)).toBeUndefined();
});

/*
 * `dismissedEpoch: undefined` is "nothing has been dismissed on this screen" — the state a fresh
 * mount holds. The cases below that mean that used to pass `null`, which now means something
 * narrower: a dismissal recorded before any run was reported. "a prompt raised outside this tab's own
 * runs opens the pane" and "a dismissal made before any run was reported still holds" are the two
 * answers that forced the two apart.
 */
test("no prompt, no pane", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: false,
      isPaneOpen: false,
      dismissedEpoch: undefined,
      runEpoch: 4,
    }),
  ).toBe(false);
});

test("a live prompt opens the screen pane", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissedEpoch: undefined,
      runEpoch: 4,
    }),
  ).toBe(true);
});

/*
 * THE REGRESSION THE SENTINEL EXISTS FOR: a prompt this tab never ran anything for.
 *
 * `runEpoch` is written only by the live `onComputerActivity` subscription, whose only producer is a
 * computer tool executed by this tab. `needsYou` is server state read from
 * `GET /api/computers/:id/control`, so it survives a reload and is true from any tab. Reloading while
 * the Bot is blocked, opening the channel after it got stuck, a prompt raised by a tool that never
 * touches the browser, a run driven from another device — all of them are this case, and the pane is
 * the only place the prompt and its masked credential field are drawn.
 *
 * With one sentinel for both "never dismissed" and "no run reported", this was `null !== null` and
 * the pane stayed shut for every one of them, leaving only the amber dot.
 */
test("a prompt raised outside this tab's own runs opens the pane", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissedEpoch: undefined,
      runEpoch: null,
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
      dismissedEpoch: undefined,
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
 * A dismissal recorded before any browser action was reported. The value copied is `runEpoch`, which
 * is null until this tab reports one (`reportComputerActivity` counts from 1, so a real epoch is
 * never null), and the dismissal holds until one arrives: the same "until the next run" rule with no
 * run yet to compare against. A guard written as `dismissedEpoch !== null && ...` would get it wrong.
 *
 * The answer is unchanged; the PREMISE was wrong and is corrected here. This case used to be written
 * as `dismissedEpoch: null`, when `null` was also what a ref nobody had written held — so the file
 * claimed these two nulls were a dismissal, while the identical pair was overwhelmingly a screen on
 * which nothing had ever been dismissed, and that reading is what kept the pane shut on every fresh
 * mount (see "a prompt raised outside this tab's own runs opens the pane"). "Never dismissed" is
 * `undefined` now, so this case can hold on its own.
 */
test("a dismissal made before any run was reported still holds", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissedEpoch: null,
      runEpoch: null,
    }),
  ).toBe(false);
});

/*
 * Closing the pane is what records that dismissal, and settings and watch are one pane with two
 * contents: the rule turns on the pane being open, so it cannot tell the contents apart and cannot
 * get one of them wrong. It used to read `next !== "watch" && isWatching`, which recognised a close
 * only from the screen — a settings pane closed while a prompt was live recorded nothing, the
 * needs-you rule above read the newly closed pane as a fresh chance to open, and the pane came back
 * as watch on the next render. The close was defeated and a second one was needed to make it stick.
 */
test("closing the pane is a dismissal whichever content it was showing", () => {
  expect(shouldRecordDismissal({ next: null, isPaneOpen: true })).toBe(true);
});

/*
 * Swapping contents is not a close: the pane stays open, and an open pane is left alone anyway, so
 * there would be nothing for the dismissal to suppress.
 */
test("opening or swapping the pane records nothing", () => {
  expect(shouldRecordDismissal({ next: "settings", isPaneOpen: true })).toBe(
    false,
  );
  expect(shouldRecordDismissal({ next: "watch", isPaneOpen: true })).toBe(
    false,
  );
  expect(shouldRecordDismissal({ next: "watch", isPaneOpen: false })).toBe(
    false,
  );
  expect(shouldRecordDismissal({ next: null, isPaneOpen: false })).toBe(false);
});
