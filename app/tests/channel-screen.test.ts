import { expect, test } from "bun:test";
import type { AgentChannel } from "@/lib/channels/queries";
import {
  channelBodyState,
  type Dismissal,
  dismissalForClose,
  observePrompt,
  type SeenPrompt,
  shouldOpenForNeedsYou,
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
 * THE PROMPT IS THE THING WITH AN IDENTITY, AND THE DISMISSAL IS KEYED ON IT.
 *
 * `shouldOpenForNeedsYou` used to compare the browser-run epoch a dismissal was stamped with against
 * the current one. `needsYou` is server state and `runEpoch` is written only by this tab's own
 * computer tools, so a dismissal made with no run — the ordinary case, since most prompts arrive
 * without this tab having driven anything — stamped `null`, `null !== null` is false, and every
 * later prompt on that mount was read as already dismissed. `observePrompt` gives the prompt an
 * identity of its own, and `Dismissal` names both, so a close of the settings panel cannot silence
 * a prompt and a Bot's own browsing cannot revive a close.
 */
test("no prompt, no pane", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: false,
      isPaneOpen: false,
      dismissed: undefined,
      promptEpoch: 0,
    }),
  ).toBe(false);
});

test("a live prompt opens the screen pane", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissed: undefined,
      promptEpoch: 1,
    }),
  ).toBe(true);
});

/*
 * A prompt this tab never ran anything for, which is most of them: reloading while the Bot is
 * blocked, opening the channel after it got stuck, a prompt raised by a tool that never touches the
 * browser, a run driven from another device. `needsYou` is read from `GET
 * /api/computers/:id/control`, so it survives a reload and is true from any tab, and the pane is the
 * only place the prompt and its masked credential field are drawn.
 *
 * The run epoch used to be half of this answer, and it is not an input any more — which is what
 * makes this case unbreakable in the way it was broken twice. `runEpoch: null` here would once have
 * decided it.
 */
test("a prompt raised outside this tab's own runs opens the pane", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissed: { runEpoch: null, promptEpoch: 0 },
      promptEpoch: 1,
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
      dismissed: undefined,
      promptEpoch: 1,
    }),
  ).toBe(false);
});

/*
 * The defect this guard exists for: closing the pane while the Bot is still waiting used to be inert.
 * Clearing `watch` leaves the prompt exactly where it was, the next poll reports it, and the pane
 * reopened — so the person could not keep it closed for as long as the Bot was stuck.
 */
test("a dismissal for this prompt keeps the pane closed while the prompt is still live", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissed: { runEpoch: 7, promptEpoch: 4 },
      promptEpoch: 4,
    }),
  ).toBe(false);
});

/*
 * A close with nothing waiting behind it — the settings panel on a channel where no prompt has ever
 * existed. `promptEpoch: 0` is what such a close records, and 0 is not a prompt: `observePrompt`
 * hands out 1 for the first arrival. This is the same pair of inputs that used to be `null` against
 * `null`, and answering it "already dismissed" is what suppressed the pane for the life of the mount.
 */
test("a close with no prompt behind it names no prompt", () => {
  expect(
    shouldOpenForNeedsYou({
      needsYou: true,
      isPaneOpen: false,
      dismissed: { runEpoch: null, promptEpoch: 0 },
      promptEpoch: 1,
    }),
  ).toBe(true);
});

/*
 * `observePrompt` on its own. The poll hands back a boolean, so the arrival is the only edge that can
 * mint an identity, and the prompt going away has to LEAVE the epoch alone: a dismissal naming prompt
 * 1 must go on naming prompt 1 rather than sliding onto the next arrival.
 */
test("a prompt arriving is a new identity; the same prompt reported again is not", () => {
  const none: SeenPrompt = { epoch: 0, live: false };
  const first = observePrompt(none, true);
  expect(first).toEqual({ epoch: 1, live: true });
  expect(observePrompt(first, true)).toBe(first);
  const gone = observePrompt(first, false);
  expect(gone).toEqual({ epoch: 1, live: false });
  expect(observePrompt(gone, false)).toBe(gone);
  expect(observePrompt(gone, true)).toEqual({ epoch: 2, live: true });
});

/*
 * Closing the pane is what records a dismissal, and settings and watch are one pane with two
 * contents: the rule turns on the pane being open, so it cannot tell the contents apart and cannot
 * get one of them wrong. It used to read `next !== "watch" && isWatching`, which recognised a close
 * only from the screen — a settings pane closed while a prompt was live recorded nothing, the
 * needs-you rule above read the newly closed pane as a fresh chance to open, and the pane came back
 * as watch on the next render. The close was defeated and a second one was needed to make it stick.
 *
 * The identity is asserted in the same breath as the close, because "record every close" and "stamp
 * the browser-run epoch" were each defensible alone and were the bug together. A close of the screen
 * mid-run names both: the run it interrupted, for the browser-activity path, and the prompt it was
 * showing, for this one.
 */
test("closing the pane dismisses the run and the prompt it was showing", () => {
  expect(
    dismissalForClose({
      next: null,
      isPaneOpen: true,
      runEpoch: 7,
      seenPrompt: { epoch: 4, live: true },
    }),
  ).toEqual({ runEpoch: 7, promptEpoch: 4 });
});

/*
 * And a close with neither behind it — the settings panel on a channel where nothing has ever waited
 * — names neither, in values that cannot collide with a real one: `reportComputerActivity` counts
 * runs from 1 and `observePrompt` counts prompts from 1. This is the record that used to be a bare
 * `null` doing the work of both, which is what silenced every later prompt.
 */
test("a close with no run and no prompt names values nothing can match", () => {
  expect(
    dismissalForClose({
      next: null,
      isPaneOpen: true,
      runEpoch: null,
      seenPrompt: { epoch: 0, live: false },
    }),
  ).toEqual({ runEpoch: null, promptEpoch: 0 });
});

/*
 * Swapping contents is not a close: the pane stays open, and an open pane is left alone anyway, so
 * there would be nothing for the dismissal to suppress.
 */
test("opening or swapping the pane records nothing", () => {
  const at = { runEpoch: 7, seenPrompt: { epoch: 4, live: true } };
  expect(
    dismissalForClose({ next: "settings", isPaneOpen: true, ...at }),
  ).toBeUndefined();
  expect(
    dismissalForClose({ next: "watch", isPaneOpen: true, ...at }),
  ).toBeUndefined();
  expect(
    dismissalForClose({ next: "watch", isPaneOpen: false, ...at }),
  ).toBeUndefined();
  expect(
    dismissalForClose({ next: null, isPaneOpen: false, ...at }),
  ).toBeUndefined();
});

/**
 * The screen's needs-you state machine, held exactly as `RouteComponent` holds it.
 *
 * The three answers below are about SEQUENCES — a pane closed and then a prompt arriving; a prompt
 * dismissed and then the Bot carrying on working — and none of them can be asked of a single call,
 * which is how the wrong key survived two rounds of single-call tests. So the refs live here and the
 * events are methods, and each test reads as what a person and a Bot did, followed by whether the
 * pane opened on them.
 *
 * `poll` is one reading of `GET /api/computers/:id/control` reaching the effect that auto-opens:
 * `observePrompt` first, then `shouldOpenForNeedsYou`, in that order, because the epoch has to exist
 * before it can be compared. `closes` is the close button or a pressed header button, which is where
 * `dismissalForClose` runs against the pane as it stood before the navigation — the model asks it
 * what was dismissed rather than deciding for itself, so the stamped identity is under test here too
 * and not just re-implemented.
 */
function channelScreen() {
  let seenPrompt: SeenPrompt = { epoch: 0, live: false };
  let runEpoch: number | null = null;
  let dismissed: Dismissal | undefined;
  let isPaneOpen = false;

  return {
    /** One poll, and whether it opened the pane. */
    poll(needsYou: boolean): boolean {
      seenPrompt = observePrompt(seenPrompt, needsYou);
      const opens = shouldOpenForNeedsYou({
        needsYou,
        isPaneOpen,
        dismissed,
        promptEpoch: seenPrompt.epoch,
      });
      if (opens) isPaneOpen = true;
      return opens;
    },
    /** A click on Watch or on the coworker button. */
    opens() {
      isPaneOpen = true;
    },
    closes() {
      dismissed =
        dismissalForClose({ next: null, isPaneOpen, runEpoch, seenPrompt }) ??
        dismissed;
      isPaneOpen = false;
    },
    /** The Bot reaches its computer, the only thing that moves the browser-run epoch. */
    browses(epoch: number) {
      runEpoch = epoch;
    },
  };
}

/*
 * THE DEFECT: a settings panel, closed once, silenced every prompt for the life of the mount.
 *
 * Nothing has ever been waiting on this channel, so the close has no prompt to dismiss — but it
 * recorded one anyway, stamped with the browser-run epoch, which is `null` until this tab runs a
 * computer tool. `null !== null` is false, and `runEpoch` never moves on its own, so the needs-you
 * pane was shut for good: a Bot could block on a credential and the only thing left saying so was
 * the amber dot on a button.
 */
test("a settings pane closed with no prompt ever shown does not suppress a later prompt", () => {
  const screen = channelScreen();
  expect(screen.poll(false)).toBe(false);
  screen.opens();
  screen.closes();
  expect(screen.poll(true)).toBe(true);
});

/*
 * The other half of the same wrong key, and the reason narrowing the close rule back to the screen
 * would not have fixed this file. A dismissal keyed on the run in progress was retired by the
 * Bot's next browser action — which, while it waits for a credential, it may well take: the prompt
 * the person closed the pane on is still the prompt, and the pane came back over them anyway.
 */
test("a dismissed prompt stays dismissed while the Bot goes on working", () => {
  const screen = channelScreen();
  screen.browses(7);
  expect(screen.poll(true)).toBe(true);
  screen.closes();
  expect(screen.poll(true)).toBe(false);
  screen.browses(8);
  expect(screen.poll(true)).toBe(false);
});

/*
 * And the dismissal has to expire, or the fix is the bug again with a longer comment. The prompt goes
 * away — answered in the pane, or the Bot stopped waiting — and the next one is not the one that was
 * dismissed. No browser run happens anywhere in this sequence, which is exactly the case the old key
 * could not tell from the one above.
 */
test("a new server prompt after a dismissal opens the pane", () => {
  const screen = channelScreen();
  expect(screen.poll(true)).toBe(true);
  screen.closes();
  expect(screen.poll(true)).toBe(false);
  expect(screen.poll(false)).toBe(false);
  expect(screen.poll(true)).toBe(true);
});
