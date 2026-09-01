import { IconDeviceDesktop, IconSettings } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ActivityLog } from "@/components/computer/activity-log";
import { ComputerView } from "@/components/computer/computer-view";
import { useNeedsYou } from "@/components/computer/needs-you";
import { DetailPanel } from "@/components/layout/detail-panel";
import { Button } from "@/components/ui/button";
import { markChannelReadMutationOptions } from "@/lib/channels/mutations";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { onComputerActivity } from "@/lib/copilot/computer-activity";
import { rosterListQueryOptions } from "@/lib/roster/queries";

const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the shared detail pane. */
  watch: z.boolean().optional(),
});

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const HEADING_ENTRANCE_SECONDS = 0.18;
const HEADING_ENTRANCE_OFFSET = "translateY(4px)";

/** Shared detail pane width for the live screen view. */
const SCREEN_PANEL_WIDTH = 400;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

/**
 * What the Bot is looking at, and what it is doing.
 *
 * Two surfaces, stacked rather than tabbed. The screen was the only window into a Bot's computer,
 * so a Bot that spent two minutes in a terminal showed a blank browser and nothing else: the honest
 * answer to "what is it doing" was "something, on a machine holding your logins". The activity —
 * the shell and the workspace — sits below the screen, so watching one never costs the other and
 * nothing about what the Bot is doing hides behind a tab nobody clicked.
 */
function ComputerViewPanel({
  agentId,
  name,
}: {
  agentId: string;
  name?: string;
}) {
  return (
    <div className="mt-4 px-4">
      <div className="p-4">
        <ComputerView active computerId={agentId} name={name} />

        <div className="mt-10">
          <h3 className="mb-2 font-medium text-sm">Activity</h3>
          <ActivityLog computerId={agentId} />
        </div>
      </div>
    </div>
  );
}

/**
 * The prompt the server is holding, as this screen has observed it.
 *
 * A prompt needs an identity of its own, because the only thing a dismissal may hide is the prompt
 * that was dismissed. `useNeedsYou` reads `GET /api/computers/:id/control` and hands back a boolean,
 * so the identity has to be built here out of the one thing that boolean does say: when a prompt
 * arrives. `epoch` counts arrivals; `live` is what the last poll said, which is what tells an
 * arrival from the same prompt reported again by the next poll.
 *
 * `epoch` starts at 0 and 0 is never a prompt — the first arrival is 1. That is what lets a
 * dismissal recorded with nothing waiting, a settings panel closed on a channel where no prompt has
 * ever existed, hold a value no prompt that later arrives can match.
 */
export type SeenPrompt = {
  /** Which prompt. A count of arrivals, so 0 means none has been seen on this screen. */
  epoch: number;
  /** What the last poll said, so the next `true` reads as an arrival or as the same prompt. */
  live: boolean;
};

/**
 * Fold one `needsYou` reading into what this screen has seen.
 *
 * Only the edges say anything, and only one of them moves the identity: false → true is a new
 * prompt, and true → false is the prompt going away — answered in the pane, or the Bot stopped
 * waiting — which leaves `epoch` where it is, so a dismissal naming that prompt goes on naming it
 * rather than sliding onto the next one. A reading equal to the last one is returned unchanged, and
 * that is what makes it safe to call this on every run of the effect below: that effect also re-runs
 * when the pane opens and closes, and those runs must not invent prompts.
 *
 * A poll that FAILED is a false reading here, because `readControl` fails closed to `null` and
 * `useNeedsYou` maps that to false. A dropped round-trip mid-prompt therefore reads as the prompt
 * going away and coming back, which retires a dismissal and lets the pane open again. Left as it is:
 * the alternative is to read "the Bot's computer could not be reached" as "the prompt is still
 * standing", which suppresses the pane over a prompt nobody has confirmed exists, and reopening a
 * pane once on a lost poll is the cheaper wrong answer.
 */
export function observePrompt(seen: SeenPrompt, needsYou: boolean): SeenPrompt {
  if (needsYou === seen.live) return seen;
  return { epoch: needsYou ? seen.epoch + 1 : seen.epoch, live: needsYou };
}

/**
 * What a person closing the pane has dismissed, named in both identities the pane opens for.
 *
 * One close, two auto-open paths, and they do not share an identity — which is the whole reason this
 * is a record rather than a number. The browser-activity path is tab-local end to end: it opens for
 * a run this tab reported, so a dismissal of it belongs to that run. The needs-you path is server
 * state, true from any tab and across a reload, so a dismissal of it belongs to the prompt. One
 * number for both meant a close of the settings panel — which has no run and no prompt behind it —
 * stamped the run epoch's `null`, and `null !== null` is false, so every prompt for the rest of the
 * mount was read as already dismissed.
 *
 * The ref holding this is `undefined` until something is dismissed, and that is not the same as
 * either field being empty. `undefined` is "nothing has been dismissed on this screen"; `{ runEpoch:
 * null, promptEpoch: 0 }` is "a close happened, with no run reported and no prompt on screen".
 * Collapsing those two into one sentinel is the exact confusion that produced this bug, so they stay
 * apart even though neither can match anything real — `reportComputerActivity` counts epochs from 1
 * and so does `observePrompt`, which is what makes a close with nothing to dismiss suppress nothing.
 */
export type Dismissal = {
  /** The browser run in progress at the close; `null` when this tab has reported none. */
  runEpoch: number | null;
  /** The prompt on screen at the close; 0 when there was none. */
  promptEpoch: number;
};

/**
 * Whether a live needs-you prompt should open the screen pane on its own.
 *
 * Exported for the tests that pin the answers a person notices, because none of them read as a
 * decision from the effect that calls this.
 *
 * A pane already open is left alone — the same rule the `onComputerActivity` subscription in
 * `RouteComponent` follows for the other auto-open path. Taking the pane away from a settings panel
 * somebody deliberately opened is not a way to explain that a Bot is stuck, and the amber dot on the
 * Watch button says the same thing without seizing anything.
 *
 * Past that, the only question is whether THIS prompt has been dismissed, and that is a question
 * about the prompt rather than about anything this tab did. It used to compare the browser-run epoch
 * a dismissal was stamped with against the current one, and those two inputs come from different
 * places: `needsYou` is server state (`GET /api/computers/:id/control` via `useNeedsYou`), so it
 * outlives a reload and is true from any tab, while `runEpoch` is only ever written by this tab's
 * `onComputerActivity` subscription, whose only producer is a computer tool this tab ran. Reloading
 * while a Bot is blocked, walking into the channel after it got stuck, a prompt raised by a tool that
 * never touches the browser, a run driven from another tab — each of those is a live prompt with no
 * run epoch at all, and the pane is the only place the prompt and its masked field are drawn. Keyed
 * on the run, one dismissal covered every one of them and expired on none.
 *
 * The wrong key cut the other way too: a Bot that went on browsing while it waited moved the run
 * epoch, so the dismissal a person had just made was retired by activity that had nothing to do with
 * the prompt they closed, and the pane came back over them. Keyed on the prompt, a dismissal covers
 * the prompt it was made about and expires when that prompt does, which is both halves at once.
 *
 * Some dismissal is needed, though, or closing the pane is inert while the prompt is live:
 * `show(null)` clears `watch`, the poll goes on reporting the prompt, and the pane reopens.
 * `dismissalForClose` decides when one is written and what it says, and `Dismissal` carries both
 * identities, so one close still covers both auto-open paths.
 */
export function shouldOpenForNeedsYou(input: {
  needsYou: boolean;
  /** Either pane: settings and watch are one pane with two contents. */
  isPaneOpen: boolean;
  /** `undefined` when nothing has been dismissed on this screen; see `Dismissal`. */
  dismissed: Dismissal | undefined;
  /** `SeenPrompt.epoch` for the prompt the poll is reporting now. */
  promptEpoch: number;
}): boolean {
  if (!input.needsYou || input.isPaneOpen) return false;
  return input.dismissed?.promptEpoch !== input.promptEpoch;
}

/**
 * What moving the pane to `next` dismisses, or `undefined` when it is not a close at all.
 *
 * The predicate and the record are ONE function on purpose. They were two — `shouldRecordDismissal`
 * answering whether to record, and the caller deciding what to write — and the bug lived precisely in
 * the seam: the predicate was right about every close counting, the caller stamped the wrong
 * identity, and no test of either half could see it, because neither half was wrong on its own.
 * Anything that asks whether a close is a dismissal now gets the dismissal, so the two answers cannot
 * drift apart again.
 *
 * WHEN. Settings and watch are one pane with two contents, and a close has to count from either of
 * them. This used to read `next !== "watch" && isWatching`, which recognised a close only from the
 * screen: a settings pane closed while a prompt was live recorded nothing, `shouldOpenForNeedsYou`
 * read the newly closed pane as a fresh chance to open, and the pane came straight back as watch. The
 * person's close was defeated and a second one was needed to make it stick.
 *
 * WHAT. Every close is therefore recorded, including a close of a pane with nothing waiting behind it,
 * and that is safe only because of what the record says: the prompt on screen, which is 0 when there
 * is none, and no prompt is ever 0. Counting every close while stamping the browser-run epoch — which
 * is `null` until this tab runs a computer tool, and `null !== null` is false — is what suppressed the
 * pane for the life of the mount. The repair belongs in the identity and not in narrowing the WHEN
 * back to the screen, which would restore the defeated close above.
 *
 * Switching contents is not a close. The pane stays open, and `shouldOpenForNeedsYou` leaves an open
 * pane alone, so there is nothing for a dismissal to suppress.
 *
 * A close made with the browser Back button does not come through here at all — see the effect that
 * calls `shouldOpenForNeedsYou` for what that costs and why it is left as it is.
 */
export function dismissalForClose(input: {
  next: "settings" | "watch" | null;
  /** Either pane: settings and watch are one pane with two contents. */
  isPaneOpen: boolean;
  runEpoch: number | null;
  seenPrompt: SeenPrompt;
}): Dismissal | undefined {
  if (input.next !== null || !input.isPaneOpen) return undefined;
  return { runEpoch: input.runEpoch, promptEpoch: input.seenPrompt.epoch };
}

/**
 * The one coworker this screen acts on, or `undefined` when the channel does not hold exactly one.
 *
 * Both the header and `channelBodyState` derive their agent from this, so the buttons and the body
 * cannot disagree about whether there is a coworker to act on. They did: the header took
 * `agentIds[0]` unconditionally, so a channel with several coworkers polled needs-you for the first
 * one, offered to watch its screen and opened its profile, next to a body saying the channel was not
 * supported.
 */
export function soleAgentId(
  agentIds: string[] | undefined,
): string | undefined {
  return agentIds?.length === 1 ? agentIds[0] : undefined;
}

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { settings, watch } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const prefersReducedMotion = useReducedMotion();
  const isWatching = watch === true;
  /** Settings and watch are one pane with two contents, so "open" is either of them. */
  const isPaneOpen = isSettingsOpen || isWatching;
  /**
   * The coworker the header acts on: the same one the body renders, by the same rule.
   *
   * `undefined` for THREE reasons and not two, which is worth saying because everything downstream
   * collapses them: a channel with no coworker, a channel with several, and a channel whose detail
   * query has not answered yet. All three disable the Watch and coworker buttons and stop needs-you
   * polling, which is the right answer to each — there is no Bot to act on in any of them — and
   * `channelBodyState` is where they are told apart, because the body is the one place that has to
   * say something different about each. The header stays silent rather than guessing which it is;
   * `ChannelBody`'s docblock argues that out.
   */
  const agentId = soleAgentId(channel.data?.agentIds);
  /*
   * Polled while the pane is open as well, which it was not: this read `useNeedsYou(agentId,
   * !isWatching)`, on the grounds that the screen panel polls control itself.
   *
   * It does, but not for this. A dismissal has to know which prompt it is about, and this boolean is
   * the only place this screen hears about one — so switching the poll off exactly while the pane is
   * open blinded the screen for the whole window in which a person answers the prompt. Every prompt
   * then looked like it arrived twice: the gate forced `needsYou` false on open, and the first poll
   * after the close reported the standing prompt as a fresh arrival, retiring the dismissal that
   * close had just made. It hid the ordinary ending too — the prompt answered in the pane — so a
   * dismissal outlived the prompt it named and swallowed the next one.
   *
   * The cost is a second reader of `/control` while the screen pane is open, every 3s beside the
   * screen card's own 1s poll of the same route: a third more reads of a route already being read,
   * against an identity that cannot be built at all from a poller switched off when it matters.
   */
  const needsYou = useNeedsYou(agentId, true);
  /*
   * What the header says about the prompt, which is not the same as whether there is one: the amber
   * dot and the "waiting for you" label exist to reach somebody whose pane is shut, and the pane
   * itself draws the prompt and its masked field. Now that the poll runs while the pane is open, this
   * is what keeps the Watch button from offering to "open its screen" over an open screen.
   */
  const promptOutsidePane = needsYou && !isWatching;

  const queryClient = useQueryClient();
  const markRead = useMutation(markChannelReadMutationOptions(queryClient));
  /*
   * This channel's roster summary, read out of the same infinite query the sidebar renders.
   * The detail query deliberately knows nothing about activity; the roster is where the socket
   * keeps lastMessageAt live, so it is the one honest source for "has something new been said".
   *
   * Read from "all", not "active": the conversation this screen has open may itself be the one
   * somebody just archived. A screen that read "active" would lose its summary — and with it,
   * unseen tracking and mark-read — the moment that happened, even while still open. "all" is the
   * only status guaranteed to still hold the row this screen is looking at.
   *
   * Only what is cached, though. Nothing in this app calls `fetchNextPage` on the roster, so a
   * conversation sitting past the first page of "all" has no `summary` here at all: `unseen` is
   * false, the effect below never fires, and opening the conversation never writes a read marker.
   * Nothing looks wrong while it is open, because the sidebar suppresses the dot on the conversation
   * you are in by id whatever its row says (`isUnread` in app-sidebar.tsx) — but the marker was never
   * written, so the dot is back the moment you navigate away, and on a second device, where this is
   * not the conversation on screen, it never went at all. The sidebar pages each status separately,
   * so it can be showing a row from "active" that this screen's one page of "all" does not reach.
   * The gap is app-wide and predates this screen; `bot.tsx` documents what its own resolver does
   * with its version of it. Not fixed here: paging belongs to the query, which this screen does not
   * own.
   */
  const roster = useInfiniteQuery(rosterListQueryOptions("all"));
  const summary = roster.data?.find((row) => row.id === channelId);

  /*
   * Opening the channel marks it read; the Bot replying while it is open marks it read again.
   * One effect covers both: the dep changes on navigation and on every activity patch, and the
   * unseen check keeps it from writing a row per render. No dependency on the mutation object —
   * its identity changes per render and the effect must not re-fire for that.
   *
   * Keyed on primitives, deliberately. The optimistic mark-read patch changes the summary OBJECT's
   * identity without changing these values, so an object dep would re-fire the effect on its own
   * write — and when lastMessageAt sits ahead of this browser's clock (another device wrote it),
   * that re-fire loops into a PUT per render. Primitives hold still under the patch: one PUT.
   */
  const unseen = summary !== undefined && hasUnseenActivity(summary);
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (unseen) {
      markReadMutate(channelId);
    }
  }, [channelId, unseen, markReadMutate]);

  /*
   * Either auto-open path may open the pane once, unless the thing it would open for was dismissed.
   *
   * Three refs, because the two paths do not share an identity and the bug was pretending they did.
   * `runEpoch` is this tab's browser-run counter, written only by the subscription below; `seenPrompt`
   * is what the poll has said about the server's prompt, folded by `observePrompt`. `dismissed` is
   * `undefined` until a close happens, which is not the same as a close that had nothing to name —
   * `Dismissal` spells out why those two must stay apart, and why neither empty field can match a run
   * or a prompt that arrives later.
   */
  const seenPrompt = useRef<SeenPrompt>({ epoch: 0, live: false });
  const runEpoch = useRef<number | null>(null);
  const dismissed = useRef<Dismissal | undefined>(undefined);

  /*
   * Settings and watch share one pane; opening either clears the other URL flag.
   *
   * Declared above the effect that calls it rather than below it, which is where this used to sit:
   * that effect reached a `const` declared further down the function, and only got away with it
   * because an effect body runs after the render that queued it.
   *
   * Memoised so that effect can name it as a dependency — a function rebuilt every render is a
   * dependency array that fires every render, written a longer way. `isPaneOpen` is the only
   * reactive value the body reads besides `navigate`, so `show` changes identity when the pane opens
   * or closes but not when it swaps contents. Neither of those re-runs opens anything: the open one
   * finds a pane open, and a close made through here has just recorded a dismissal naming the run in
   * progress and the prompt on screen. A close made with the browser Back button does not come
   * through here, and that re-run does reopen the pane — the effect below says why that is left
   * alone.
   *
   * `replace` is for the callers that nobody asked for — the two auto-opens. A person's click on the
   * header buttons is a navigation they made and keeps its history entry.
   */
  const show = useCallback(
    (next: "settings" | "watch" | null, options?: { replace?: boolean }) => {
      // A close dismisses the run in progress and the prompt on screen, and nothing after either.
      const closing = dismissalForClose({
        next,
        isPaneOpen,
        runEpoch: runEpoch.current,
        seenPrompt: seenPrompt.current,
      });
      if (closing) dismissed.current = closing;
      return navigate({
        replace: options?.replace,
        search: (previous) => ({
          ...previous,
          settings: next === "settings" ? true : undefined,
          watch: next === "watch" ? true : undefined,
        }),
      });
    },
    [isPaneOpen, navigate],
  );

  useEffect(() => {
    if (!agentId) return;
    return onComputerActivity((activity) => {
      if (activity.botId !== agentId) return;
      runEpoch.current = activity.epoch;
      if (dismissed.current?.runEpoch === activity.epoch) return;
      navigate({
        // Nobody asked for this pane, so it is not a history step. Same rule as the effect below.
        replace: true,
        search: (previous) =>
          previous.watch === true || previous.settings === true
            ? previous
            : { ...previous, settings: undefined, watch: true },
      });
    });
  }, [agentId, navigate]);

  /*
   * Needs-you prompts auto-open the screen panel, because the prompt with the reason on it — the
   * amber "the assistant needs you" row, and the masked field for a credential — is drawn on the
   * screen card in that panel. Nothing about a stuck Bot is actionable until this pane is open, and
   * a fresh mount with a live prompt is the common way to arrive at one: the prompt is server state,
   * so a reload or a walk into the channel finds it already waiting. `shouldOpenForNeedsYou` is
   * where that reasoning lives, and it is what keeps this from being a decision buried in an effect.
   *
   * A dependency array, which this effect used to be missing: it ran after every render — every
   * roster socket patch, every mark-read, every refetch — and navigated on each one while `needsYou`
   * was true. It self-limited only because opening the pane flips `useNeedsYou`'s `when` to false,
   * which resets that hook's own state: a navigate-per-render held back by another file's behaviour
   * rather than by anything this effect said.
   *
   * The prompt's identity is folded in here rather than kept in state, because it is a function of
   * `needsYou` and of nothing else: `observePrompt` runs on every run of this effect, `needsYou` is a
   * dependency, and a reading equal to the last one changes nothing — so the epoch cannot move
   * without this effect running, and this effect running twice on one reading cannot invent a prompt.
   * The refs it and the dismissal live in do not re-render when they change, and that is enough:
   * `onComputerActivity` above is what hears about a new browser run, and it opens the pane itself
   * for a run nobody dismissed; this effect never has to notice that number moving.
   *
   * `replace: true` because nobody asked for this pane: an auto-open that pushed a history entry made
   * Back a trap, since Back landed on the closed state this effect immediately reopened, pushing
   * another entry every time. Back still does not count as a dismissal — it does not go through
   * `show` — so pressing it on a pane opened by hand, while the prompt is live, reopens the pane in
   * place rather than closing it, and a second Back leaves the channel. That is left as it is: it is
   * bounded, and inferring intent from a history entry the person did not push is guesswork. The
   * close button and the Watch toggle are what record a dismissal.
   */
  useEffect(() => {
    seenPrompt.current = observePrompt(seenPrompt.current, needsYou);
    if (
      !shouldOpenForNeedsYou({
        needsYou,
        isPaneOpen,
        dismissed: dismissed.current,
        promptEpoch: seenPrompt.current.epoch,
      })
    )
      return;
    void show("watch", { replace: true });
  }, [needsYou, isPaneOpen, show]);

  return (
    <DetailPanel
      onClose={() => show(null)}
      open={isPaneOpen && agentId !== undefined}
      detailWidth={isWatching ? SCREEN_PANEL_WIDTH : undefined}
      detail={
        agentId === undefined ? null : isWatching ? (
          // Manual watch remains active even when there is no current browser action.
          <ComputerViewPanel agentId={agentId} name={channel.data?.name} />
        ) : (
          <AgentProfile agentId={agentId} />
        )
      }
    >
      <div className="flex flex-col">
        <div className="h-12 border-b border-border sticky top-0 flex flex-row items-center justify-between px-3 gap-2">
          {/* Keyed on the displayed name so cold channel loads animate the resolved name, not the id. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <motion.div
              animate={{ opacity: 1 }}
              className="shrink-0"
              initial={{ opacity: 0 }}
              key={`avatar:${channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              <ChannelAvatar
                participantIds={channel.data?.agentIds ?? []}
                size={22}
              />
            </motion.div>
            <motion.span
              animate={
                prefersReducedMotion
                  ? { opacity: 1 }
                  : { opacity: 1, transform: "translateY(0px)" }
              }
              className="min-w-0 text-sm tracking-tight truncate"
              initial={
                prefersReducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, transform: HEADING_ENTRANCE_OFFSET }
              }
              key={`name:${channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              {channel.data?.name ?? "Channel"}
            </motion.span>
          </div>
          <div className="flex flex-row gap-1.5">
            <Button
              aria-label={
                promptOutsidePane
                  ? "This Bot is waiting for you. Open its screen"
                  : "Watch this Bot's screen"
              }
              aria-pressed={isWatching}
              className={`relative ${isWatching ? "bg-foreground/5" : ""}`}
              disabled={agentId === undefined}
              onClick={() => show(isWatching ? null : "watch")}
              variant="ghost"
              size="icon"
            >
              <IconDeviceDesktop className="size-4.5" />
              {/* Mirrors needs-you state outside the hidden screen pane. */}
              {promptOutsidePane ? (
                <span className="absolute right-1 top-1 size-2 rounded-full bg-amber-500" />
              ) : null}
            </Button>
            <Button
              aria-label="Channel coworker"
              aria-pressed={isSettingsOpen}
              className={isSettingsOpen ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => show(isSettingsOpen ? null : "settings")}
              variant="ghost"
              size="icon"
            >
              <IconSettings className="size-4.5" />
            </Button>
          </div>
        </div>
      </div>
      <ChannelBody
        channel={channel.data}
        error={channel.error}
        isPending={channel.isPending}
      />
    </DetailPanel>
  );
}

/** What the body of this screen has to say, once the detail query has been read. */
export type ChannelBodyState =
  | { kind: "loading" }
  /** Nothing readable, and the reason, in place of the transcript. */
  | { kind: "unavailable"; message: string }
  /** No coworker in the channel at all: nothing to route a message to. */
  | { kind: "no-coworker" }
  /** More than one coworker, which the runtime cannot route between yet. */
  | { kind: "unsupported" }
  | {
      kind: "chat";
      channel: AgentChannel;
      runtimeAgentId: string;
      /** A failed refresh, said beside the transcript rather than instead of it. */
      refreshProblem: string | undefined;
    };

/**
 * THE BLOCKING STATE TURNS ON `channel`, NOT ON `error`.
 *
 * In React Query v5 a failed *refetch* keeps the previous `data` alongside the new `error`, and this
 * screen refetches a lot: the client's defaults leave `staleTime` at 0 with `refetchOnMount` on, so
 * returning to a channel refetches its detail, and `createChannelMutationOptions` invalidates
 * `channelKeys.all`, which the open channel's detail query sits under. Consulting `error` for the
 * blocking state swapped a live, readable transcript — and the composer's unsent draft with it, since
 * `ChannelChat` unmounts — for one generic sentence, on nothing worse than a transient 500.
 * `bot_.$botChatId.tsx` reasons the identical hazard through for its own conversation and reaches the
 * same answer; the two screens are meant to agree, so change them together or not at all.
 *
 * A refetch that failed is still worth saying out loud, so it comes back as `refreshProblem` for the
 * caller to draw next to the transcript. Nothing is unmounted for it.
 *
 * Both sentences carry `error.message` rather than a sentence of this screen's own. For an API
 * refusal that is the server's own words: `client` throws the `error` field out of the response body,
 * falling back to this query's `Could not load this channel` only when the server sent none. The
 * literal below is reached only when there is no error to quote and no data either.
 *
 * Exported with `ChannelBodyState` for the test that pins the refetch case, which cannot be told
 * from a first-load failure by looking at the rendered output alone.
 */
export function channelBodyState(input: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  error: Error | null;
}): ChannelBodyState {
  if (input.isPending) return { kind: "loading" };
  if (!input.channel) {
    return {
      kind: "unavailable",
      message: input.error?.message ?? "Could not load this channel.",
    };
  }
  /*
   * One rule for "is there a coworker to act on", shared with the header, and two reasons there
   * might not be. Both used to collapse into `unsupported`, so a channel with no coworker was told
   * it had more than one.
   */
  const runtimeAgentId = soleAgentId(input.channel.agentIds);
  if (!runtimeAgentId) {
    return input.channel.agentIds.length === 0
      ? { kind: "no-coworker" }
      : { kind: "unsupported" };
  }
  return {
    kind: "chat",
    channel: input.channel,
    runtimeAgentId,
    refreshProblem: input.error?.message,
  };
}

/**
 * How many coworkers a channel holds decides what this body can draw, and there are three answers.
 *
 * EXACTLY ONE is the conversation, and the only shape a channel is normally created in.
 *
 * MORE THAN ONE is not supported yet: rendering a shared transcript for several agents before the
 * runtime can route between them would look like it works.
 *
 * NONE AT ALL is a shape the server deliberately produces, not a corrupt row. `GET /api/channels/:id`
 * joins `channel_agents` loosely and says so — those rows are deleted and reinserted on every
 * tenant-package sync, so an inner join answered "does this channel exist" with the absence of a Bot
 * — and the roster hydrates channels the same way. It gets its own sentence because it is the one
 * state nothing else on the screen covers: `active` is vacuously true for a channel with no coworker
 * (there is none to report as gone), so the banner `ChannelChat` draws for a deleted one would not
 * fire even if a transcript were drawn here, and the header's buttons are disabled with no
 * explanation of their own. Told "more than one coworker", a person looking at a channel with none
 * would have exactly one sentence on screen and it would be false.
 */
function ChannelBody({
  channel,
  isPending,
  error,
}: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  error: Error | null;
}) {
  const state = channelBodyState({ channel, isPending, error });

  // Nothing while the channel loads: a placeholder inside a local round-trip is a flicker.
  if (state.kind === "loading") return null;
  if (state.kind === "unavailable") {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {state.message}
      </p>
    );
  }
  if (state.kind === "no-coworker") {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This channel has no coworker in it, so there is nothing here to answer.
        Start a new channel to pick one.
      </p>
    );
  }
  if (state.kind === "unsupported") {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This channel has more than one coworker, which is not supported yet.
      </p>
    );
  }

  return (
    <>
      {/*
       * A plain sibling above the transcript, in the shape `bot_.$botChatId.tsx` uses for its own
       * banners: the transcript below it is `flex-1`, so this takes the height of its sentence and
       * the conversation keeps the rest. Nothing about the chat is torn down to show it.
       */}
      {state.refreshProblem ? (
        <p
          className="border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
          data-testid="channel-refresh-problem"
          role="alert"
        >
          {state.refreshProblem}
        </p>
      ) : null}
      {/* Remount on channel changes so CopilotKit agent/thread state cannot leak between channels. */}
      <ChannelChat
        channel={state.channel}
        key={state.channel.id}
        runtimeAgentId={state.runtimeAgentId}
      />
    </>
  );
}
