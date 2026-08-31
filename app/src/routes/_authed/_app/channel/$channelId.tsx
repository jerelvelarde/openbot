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
 * Whether a live needs-you prompt should open the screen pane on its own.
 *
 * Exported for the test that pins the two answers a person notices, because both of them used to be
 * "yes" and neither reads as a decision from the effect that calls this.
 *
 * A pane already open is left alone — the same rule the `onComputerActivity` subscription in
 * `RouteComponent` follows for the other auto-open path. Taking the pane away from a settings panel
 * somebody deliberately opened is not a way to explain that a Bot is stuck, and the amber dot on the
 * Watch button says the same thing without seizing anything.
 *
 * A dismissal recorded for the current browser-activity run keeps the pane closed. Without that,
 * closing the pane was inert while the prompt was live: `show(null)` clears `watch`, `useNeedsYou`
 * resumes polling, the prompt is still there, and the pane reopens. This is the same `dismissedEpoch`
 * the browser-activity path already writes, so one close covers both paths — and it covers one run,
 * not the life of the screen, because the next run arrives with an epoch nobody dismissed and that
 * path opens the pane again.
 *
 * Two nulls is the state before any browser action has been reported (`reportComputerActivity`
 * counts from 1, so a real epoch is never null). A dismissal there holds until an action is
 * reported, which is the same "until the next run" rule with no run yet to compare against.
 */
export function shouldOpenForNeedsYou(input: {
  needsYou: boolean;
  /** Either pane: settings and watch are one pane with two contents. */
  isPaneOpen: boolean;
  dismissedEpoch: number | null;
  runEpoch: number | null;
}): boolean {
  if (!input.needsYou || input.isPaneOpen) return false;
  return input.dismissedEpoch !== input.runEpoch;
}

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { settings, watch } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const prefersReducedMotion = useReducedMotion();
  const isWatching = watch === true;
  /** Channel routing currently supports one coworker. */
  const agentId = channel.data?.agentIds[0];
  /** Only polled while the screen is closed; the screen panel polls control itself. */
  const needsYou = useNeedsYou(agentId, !isWatching);

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

  // Browser activity may auto-open the screen once per run unless this run was dismissed.
  const dismissedEpoch = useRef<number | null>(null);
  const runEpoch = useRef<number | null>(null);

  /*
   * Settings and watch share one pane; opening either clears the other URL flag.
   *
   * Declared above the effect that calls it rather than below it, which is where this used to sit:
   * that effect reached a `const` declared further down the function, and only got away with it
   * because an effect body runs after the render that queued it.
   *
   * Memoised so that effect can name it as a dependency — a function rebuilt every render is a
   * dependency array that fires every render, written a longer way. `isWatching` is a dependency
   * because the dismissal reads it, so `show` changes identity whenever the pane opens or closes;
   * neither of those re-runs can open anything, because one of them has a pane open and the other
   * has just recorded a dismissal.
   */
  const show = useCallback(
    (next: "settings" | "watch" | null) => {
      // Dismissal applies only to the current browser-activity run.
      if (next !== "watch" && isWatching)
        dismissedEpoch.current = runEpoch.current;
      return navigate({
        search: (previous) => ({
          ...previous,
          settings: next === "settings" ? true : undefined,
          watch: next === "watch" ? true : undefined,
        }),
      });
    },
    [isWatching, navigate],
  );

  useEffect(() => {
    if (!agentId) return;
    return onComputerActivity((activity) => {
      if (activity.botId !== agentId) return;
      runEpoch.current = activity.epoch;
      if (dismissedEpoch.current === activity.epoch) return;
      navigate({
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
   * screen card in that panel. Nothing about a stuck Bot is actionable until this pane is open.
   *
   * A dependency array, which this effect used to be missing: it ran after every render — every
   * roster socket patch, every mark-read, every refetch — and navigated on each one while `needsYou`
   * was true. It self-limited only because opening the pane flips `useNeedsYou`'s `when` to false,
   * which resets that hook's own state: a navigate-per-render held back by another file's behaviour
   * rather than by anything this effect said.
   *
   * The two epochs are read out of refs, which do not re-render when they change, and that is
   * enough. `onComputerActivity` above is what hears about a new run, and it opens the pane itself
   * for an epoch nobody dismissed; this effect never has to notice the number moving.
   */
  useEffect(() => {
    if (
      !shouldOpenForNeedsYou({
        needsYou,
        isPaneOpen: isSettingsOpen || isWatching,
        dismissedEpoch: dismissedEpoch.current,
        runEpoch: runEpoch.current,
      })
    )
      return;
    void show("watch");
  }, [needsYou, isSettingsOpen, isWatching, show]);

  return (
    <DetailPanel
      onClose={() => show(null)}
      open={(isSettingsOpen || isWatching) && agentId !== undefined}
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
                needsYou
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
              {needsYou ? (
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
  const runtimeAgentId =
    input.channel.agentIds.length === 1 ? input.channel.agentIds[0] : undefined;
  if (!runtimeAgentId) return { kind: "unsupported" };
  return {
    kind: "chat",
    channel: input.channel,
    runtimeAgentId,
    refreshProblem: input.error?.message,
  };
}

/**
 * A channel holds exactly one coworker. More than one is not supported yet, and rendering a shared
 * transcript for several agents before the runtime can route between them would look like it works.
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
