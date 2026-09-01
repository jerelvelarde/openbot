import {
  IconBolt,
  IconBox,
  IconLogout,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  type LinkOptions,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useRosterEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import {
  type RosterItem,
  type RosterStatus,
  rosterListQueryOptions,
} from "@/lib/roster/queries";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../ui/empty";
import { openConversationId, RosterRow } from "./roster-row";
import { StatusFilter } from "./status-filter";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;
const settingsLinkOptions = { to: "/settings" } satisfies LinkOptions;

const userMenuItemClassName = "gap-2 px-2 py-1.5";

function UserAvatar() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  // `||`, not `??`: a name of "" (or of nothing but whitespace) reduces to "" through this chain,
  // and "" is not nullish, so `??` never reached the email and the circle rendered empty.
  const initials =
    currentUser?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || currentUser?.email.slice(0, 2).toUpperCase();

  return (
    <div className="size-[28px] bg-muted-foreground/10 text-foreground/70 rounded-full flex items-center justify-center text-xs overflow-hidden">
      {initials}
    </div>
  );
}

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 *
 * NOTHING REACHES IT TODAY. The server's roster page is 50 rows and nothing here calls
 * `fetchNextPage`, so `channels.data` cannot hold more than 50 and the comparison in
 * `rosterAnimation` is always true. It stays because it is the cheap half of wiring pagination: the
 * day a second page can arrive, the cap is already in place rather than being the thing somebody
 * notices after the animation starts measuring hundreds of rows.
 */
const MAX_ANIMATED_ROWS = 60;

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name and the last thing said in it, because those are the two things the
 * row actually shows — searching against something invisible returns results a person cannot
 * account for. Message history beyond the last line is not here to search: it lives in the thread
 * store, and reaching for it is a server endpoint rather than a filter.
 *
 * Unchanged in body for the roster's two kinds: a channel and a bot chat both project `name` and
 * `lastMessage`, so the filter below searches both without knowing which kind a given row is.
 */
function matchingItems(
  items: RosterItem[] | undefined,
  query: string,
): RosterItem[] {
  if (!items) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return items;
  }
  return items.filter((item) =>
    [item.name, item.lastMessage].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Pinned channels first, everything else after, each group left in the order it arrived in.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 *
 * ONE TERM OF THE THREE, DELIBERATELY. The server's key is `[pinned desc, recency desc, id desc]`
 * (server/src/roster/order.ts) and this mirrors the first of them alone. It does not need the other
 * two: `Array.prototype.sort` has been stable since ES2019, so partitioning on the pin leaves each
 * group in the order it arrived in, and the order it arrives in is already the remaining two terms —
 * the server sends a page that way, and `byRecency` re-sorts a patched page that way, its id
 * tie-break included. Restating them here would be a second copy of a rule that has one home, and
 * the second copy is the one that goes stale.
 *
 * WHAT IT DOES RELY ON is that the arriving order is TOTAL. A recency mirror that answered `0` on a
 * tie would hand tied rows over in whatever order the last thing to touch them left, and a stable
 * partition preserves that faithfully — the disagreement would surface as rows swapping places on
 * the next refetch, which is the symptom this function is part of preventing.
 *
 * The array is copied because `sort` mutates, and the array handed in is not this function's: with
 * an empty search box `matchingItems` returns its input untouched, so the caller's array is the one
 * React Query's `select` memoized for the sidebar's observer. app/tests/channel-order.test.ts asserts
 * the argument survives, and app/tests/roster-sidebar.test.ts asserts through a rendered sidebar that
 * the array really is the query's.
 */
export function pinnedFirst(channels: RosterItem[]): RosterItem[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's, because `lastMessageAgentId` is null for a *person* — see
 * `Null for a person` on `messages` in server/src/db/schema/core.ts. Any person: no user id is
 * stored on the message, so this predicate cannot tell your own words from a teammate's, and skipping
 * a null agent id is skipping every human message in the channel.
 *
 * THAT IS ONLY SAFE WHILE A CHANNEL HAS ONE MEMBER. It does today: the server inserts exactly one
 * `channel_memberships` row per channel, for its creator (server/src/channels/routes.ts). But the
 * table is keyed on (channel_id, user_id) and is multi-member by design, and this feature's own
 * wording on delete and archive is "for everyone in it" — so the first time a second member exists,
 * a teammate's message will raise no dot here. Written down rather than fixed because the fix is a
 * user id on the message, which is a schema change and not this function's to make; see the test
 * named for it in app/tests/channel-unread.test.ts.
 *
 * Compared with `>`, not `>=`: `patchRosterRead` stamps `lastReadAt` to exactly `lastMessageAt` when
 * the writer's clock is ahead of the reader's, so equal means read, and `>=` would leave the dot lit
 * forever on precisely the rows that guard exists to fix. ISO-8601 strings compare correctly as
 * strings, which is the same bet the server's recency sort already makes.
 */
export function hasUnseenActivity(channel: RosterItem): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/**
 * Unseen activity somewhere you are not looking. The open conversation never shows the dot.
 *
 * The open conversation may be either kind — a channel or a bot chat — and the two live under
 * different route params (`channelId`, `botChatId`). This function does not know or care which:
 * it takes whichever id the caller resolved from the matching param and compares it plainly, so
 * the "somewhere you are not looking" rule is enforced identically for both kinds.
 */
export function isUnread(
  channel: RosterItem,
  openId: string | undefined,
): boolean {
  return channel.id !== openId && hasUnseenActivity(channel);
}

/**
 * Which kind of nothing to say — and the two cases that are not a nothing at all.
 *
 * THE NOTHINGS ARE DIFFERENT FROM EACH OTHER, AND SAYING THE WRONG ONE IS ALARMING. *First use*, a
 * roster nobody has used yet, needs telling how to start. *No match* has to say so and quote the
 * search back — told "you don't have conversations yet" while holding a typo, a person reads their
 * conversations as gone. *Empty archive* is not an empty account. And *nothing anywhere*, which is
 * `All` coming back empty, is the only one of them that really does mean what the others get
 * mistaken for.
 *
 * The search wording wins over the status wording, because a search that matched nothing is a fact
 * about the search whichever list it ran against.
 *
 * *NOT KNOWN YET* IS NOT A NOTHING, and conflating the two is the near miss this docblock is really
 * for. While the query is pending `matchingItems` returns `[]`, so `total` is 0, and a first paint
 * would tell somebody they have no conversations. The two inline blocks this function replaced were
 * accidentally safe — they tested `channels.data?.length === 0`, and `undefined === 0` is false — so
 * collapsing them lost a guard nobody had written down.
 *
 * *FAILED* IS NOT A NOTHING EITHER, and it used to arrive disguised as one. It splits off *not known
 * yet*: pending says nothing because it is about to know, failed has to say something because it
 * never will, and both reach the guard below as `loaded: false, total: 0`. So a failed roster
 * returned `null` and the sidebar rendered a search box, three status buttons, and a void — no rows,
 * no sentence, no retry. With `retry: 1` and `refetchOnWindowFocus: false`
 * (app/src/query-client.ts) nothing tried again on its own, so the void was permanent — and a
 * permanent void is read as "my conversations are gone". Meanwhile the roster query was constructing
 * the sentence for exactly this ("Could not load your conversations") and handing it to nobody.
 * Nothing here could tell the two apart until `failure` was passed in; now it is said, and `failed`
 * tells the caller to offer the retry the query itself will not attempt.
 *
 * Only while nothing has loaded. A refetch that fails with rows already in hand leaves the rows
 * alone: they are the true thing on screen, and covering them with an alarm would be this docblock's
 * own mistake made in the other direction.
 *
 * The cases are named rather than counted on purpose. A running tally is the part that rots when a
 * branch is added — this docblock once carried three disagreeing counts of its own cases — and a
 * name is what a reader can check the body against.
 */
export function emptyStateFor(input: {
  status: RosterStatus;
  searching: boolean;
  total: number;
  search: string;
  /**
   * Whether the roster has ever come back with data — an empty list included, since a genuinely
   * empty roster is `[]` and not nothing. The caller passes `channels.data !== undefined`, so a first
   * load that is still pending and a first load that failed are both `false`, and every state after
   * the first answer is `true` — a later refetch that fails included, which is deliberate: it is what
   * keeps rows in hand from being covered by an alarm. See the last paragraph above.
   */
  loaded: boolean;
  /** The sentence the roster query failed with, or null if it has not failed. */
  failure: string | null;
}): { failed: boolean; title: string; description: string } | null {
  /*
   * *Not known yet* and *failed*, both of which arrive as `loaded: false, total: 0` and neither of
   * which is a nothing — see the two paragraphs shouting about them above.
   *
   * Answered here, above the search and status branches, because `searching` and `status` describe a
   * list that never arrived: quoting somebody's search back at them is no way to say the server is
   * down.
   */
  if (!input.loaded) {
    return input.failure === null
      ? null
      : {
          failed: true,
          title: input.failure,
          description:
            "Nothing has been lost — the list itself could not be fetched. Try again, or reload the page.",
        };
  }
  if (input.total > 0) return null;

  if (input.searching) {
    return {
      failed: false,
      title: "No conversations match your search",
      description: `Nothing here is named “${input.search.trim()}”, and nobody has said it recently either.`,
    };
  }

  if (input.status === "archived") {
    return {
      failed: false,
      title: "Nothing archived",
      description:
        "Archiving a conversation takes it out of this list without deleting anything. You can bring it back at any time.",
    };
  }

  if (input.status === "active") {
    return {
      failed: false,
      title: "No conversations yet",
      description:
        "Start one with a coworker, or open a Bot chat. Anything you archive will still be here under Archived.",
    };
  }

  return {
    failed: false,
    title: "No conversations at all",
    description: "Nothing here, archived or otherwise. Start one to get going.",
  };
}

/**
 * Whether the roster may animate at all, and whether it may animate reordering on top of that.
 *
 * FILTERING DOES NOT ANIMATE, AND NEITHER DOES SWITCHING STATUS. Every keystroke changes the match
 * set, so rows the search no longer matches would fade out and rows it matches again would slide
 * back in, under somebody who is still typing — and the moving target is the very thing they are
 * trying to read. `entrance` is what says so: it gates the mount and unmount animations, not just
 * the reorder, which is the half that was missed when this rule was first written down. Status is
 * the same case for a different reason: Active and Archived are disjoint, but All holds both, so a
 * row can keep its key across the click while its position in the array shifts — and a list that
 * was swapped out wholesale should not be animated as though its rows moved.
 *
 * `order` is `entrance` plus the row cap, because layout animation is the expensive one: `layout`
 * measures every animated row on each reorder, while a fade is cheap on a row that is mounting
 * anyway. Reordering is for a channel that was just spoken in, which is occasional.
 *
 * Pure and exported so both halves of the rule are checkable without a browser, the way `menuFor`
 * and `rowMarkers` are in roster-row.tsx. A comment claiming rows do not animate while a list is
 * being filtered is worth nothing if nothing tests it — that is exactly how it came to be untrue.
 */
export function rosterAnimation(input: {
  searching: boolean;
  status: RosterStatus;
  rows: number;
}): { entrance: boolean; order: boolean } {
  const entrance = !input.searching && input.status === "active";
  return { entrance, order: entrance && input.rows <= MAX_ANIMATED_ROWS };
}

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
 *
 * `animateEntrance` refuses the fade in and out, `animateOrder` refuses the reorder. Two props and
 * not one, because the row cap only has to stop the expensive movement — but `initial` and `exit`
 * are gated at all, rather than left unconditional beside a gated `layout`, because a row fading out
 * on a keystroke is thrashing whether or not the rows around it relayout too.
 *
 * A LIST ITEM AROUND THE ANIMATED ELEMENT, not instead of it. The roster is this application's
 * primary navigation and it has to be a list — a row that is only a `motion.div` has no position and
 * no count to announce, whatever the element above it claims to be. `SidebarMenuItem` is the `<li>`
 * (see components/ui/sidebar.tsx), and the animation is unaffected by sitting inside it: motion
 * measures this `div`'s own box against the viewport, and the box moves when the item holding it
 * moves, so a reorder animates exactly as it did when the `div` was the whole row. The `<li>` takes no
 * `exit` of its own and needs none — `AnimatePresence` holds a leaving child mounted until the motion
 * components inside it report their exits complete, which is this `div`.
 */
function Row({
  channel,
  animateEntrance,
  animateOrder,
}: {
  channel: RosterItem;
  animateEntrance: boolean;
  animateOrder: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();
  // Whether this row is unread, as a boolean, for the same reason `RosterRow` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  //
  // The open id comes from `openConversationId`, resolved from whichever route param matched — the
  // one function this and `RosterRow`'s `isOpen` (in roster-row.tsx) both call, so the two cannot
  // resolve "which conversation is open" two different ways and drift apart. They used to: `Row`
  // once read only `params.channelId`, so an open bot chat compared its own id against `undefined`,
  // always true, so the row you were looking at lit its own unread dot the moment its Bot replied —
  // the exact case `isUnread`'s docblock says never happens. See `openConversationId`'s docblock.
  const unread = useParams({
    strict: false,
    select: (params) => {
      const held = params as { channelId?: string; botChatId?: string };
      return isUnread(channel, openConversationId(held));
    },
  });
  return (
    <SidebarMenuItem>
      <motion.div
        animate={{ opacity: 1, transform: "translateY(0px)" }}
        // `false` disables the mount animation outright; a row then paints at its `animate` values.
        initial={
          animateEntrance
            ? {
                opacity: 0,
                transform: shouldReduceMotion ? "none" : "translateY(-8px)",
              }
            : false
        }
        // No `exit` definition means AnimatePresence has nothing to wait for and drops the row without
        // animating it: `setActive("exit", …)` resolves with nothing to animate, so `onExitComplete`
        // fires straight away (framer-motion 13.1.1, motion/features/animation/exit.mjs).
        exit={animateEntrance ? { opacity: 0 } : undefined}
        layout={animateOrder && !shouldReduceMotion ? "position" : false}
        transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
      >
        <RosterRow
          kind={channel.kind}
          id={channel.id}
          participantIds={channel.agentIds}
          name={channel.name}
          lastMessage={channel.lastMessage ?? undefined}
          lastMessageAt={
            channel.lastMessageAt
              ? relativeTime(channel.lastMessageAt)
              : undefined
          }
          pinned={channel.pinned}
          unread={unread}
          archived={channel.archived}
        />
      </motion.div>
    </SidebarMenuItem>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [status, setStatus] = useState<RosterStatus>("active");
  const channels = useInfiniteQuery(rosterListQueryOptions(status));
  // One socket for the app, opened where the roster is kept live. No status argument: the channel
  // screen reads the roster too, so the status this sidebar happens to have on screen is not
  // knowable from inside the hook. It patches all three cached lists instead — see its own docblock.
  useRosterEvents();
  const [search, setSearch] = useState("");
  const searching = search.trim().length > 0;
  const visibleItems = pinnedFirst(matchingItems(channels.data, search));
  // Both halves of "when may the roster move" — see `rosterAnimation` for which case each refuses.
  const animate = rosterAnimation({
    searching,
    status,
    rows: channels.data?.length ?? 0,
  });
  // `channels.data` is undefined for both "pending" and "errored" (the infinite query's `select`
  // flattens pages, so a genuinely empty roster is `[]`, not undefined) — see `emptyStateFor`'s
  // `loaded` param for why that distinction has to reach it, and its `failure` param for why
  // "errored" then has to be separated back out of it.
  const empty = emptyStateFor({
    status,
    searching,
    total: visibleItems.length,
    search,
    loaded: channels.data !== undefined,
    failure: channels.error?.message ?? null,
  });

  /**
   * Why the sign-out did not happen, said in the footer rather than in the menu.
   *
   * The click that asks for it closes the menu, so a sentence rendered inside the menu would be a
   * sentence nobody ever reads. It goes directly above the button the menu hangs off, which is where
   * the person just clicked and where they are still looking.
   */
  const [signOutProblem, setSignOutProblem] = useState<string | null>(null);

  /**
   * Sign out, and say so when the server refuses.
   *
   * `mutate` with callbacks rather than `await mutateAsync`, because this is wired straight to an
   * `onClick`: a refused sign-out rejected into nothing at all — the menu closed, `signOut.error` was
   * rendered nowhere, and the only record was an `unhandledrejection` in the console. Believing you
   * are logged out while you are not is the worst thing on this surface to be quietly wrong about, so
   * it gets the same treatment a refused pin gets on its row.
   *
   * The navigation goes inside `onSuccess` rather than after the call, because leaving for the
   * sign-in screen is what "you are signed out" looks like and it must not be shown to somebody who
   * is not. The `await` chain had that right for the wrong reason — the throw it swallowed also
   * skipped the line below it — and a callback is where it survives being read.
   */
  const handleSignOut = () => {
    setSignOutProblem(null);
    signOut.mutate(undefined, {
      onSuccess: () => {
        void navigate({ to: "/sign" });
      },
      onError: (thrown) => setSignOutProblem(thrown.message),
    });
  };

  return (
    <Sidebar {...props}>
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row gap-1.5">
            <SidebarMenuButton
              className="font-semibold text-[14px] tracking-tighter h-full leading-tight"
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  {appConfig.brand.productName}
                </Link>
              )}
            />
            <Button
              size="icon"
              variant="ghost"
              render={(props) => (
                <Link
                  {...props}
                  to="/channel/new"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
            >
              <IconPlus />
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="scroll-fade-b">
        {/*
         * THE GROUP IS THE COLUMN AND THE LIST IS INSIDE IT, which is the other way round from how
         * this surface was built. `SidebarMenu` is a `<ul>` and `SidebarMenuItem` an `<li>` (see
         * components/ui/sidebar.tsx), and `SidebarGroup` is the `<div>` that lays the column out —
         * so a group nested inside a menu put a `<div>` between the list and its items, and an `<li>`
         * is only a list item while it is a direct child of the list. The application's primary
         * navigation therefore announced no list, no count and no position, while looking in the
         * source as though it announced all three.
         *
         * The search box and the status filter are no longer list items, because they are not items
         * of anything: they were wrapped for the column layout, which the group provides directly.
         * Making the roster a real list and leaving those two inside a list of their own would be the
         * same mistake in a smaller place — markup chosen for its layout and read out as meaning.
         */}
        <SidebarGroup className="gap-px">
          <InputGroup className="bg-background text-sm rounded-lg h-9">
            <InputGroupInput
              aria-label="Search conversations"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search..."
              value={search}
            />
            <InputGroupAddon>
              <IconSearch />
            </InputGroupAddon>
          </InputGroup>
          <StatusFilter onChange={setStatus} value={status} />
          <div className="w-full h-2" />
          {empty ? (
            <div className="py-4">
              <Empty className="border border-dashed min-h-[40dvh]">
                <EmptyHeader>
                  {/*
                    Announced when it is a failure and not when it is an emptiness: an empty roster
                    is the answer to something the person just did, while a failed one interrupts
                    them with news they did not ask for and cannot see coming.
                  */}
                  <EmptyTitle role={empty.failed ? "alert" : undefined}>
                    {empty.title}
                  </EmptyTitle>
                  <EmptyDescription className="text-pretty">
                    {empty.description}
                  </EmptyDescription>
                </EmptyHeader>
                {empty.failed ? (
                  <EmptyContent>
                    {/*
                      The one thing that tries again. `retry: 1` is spent by the time this renders
                      and `refetchOnWindowFocus` is off, so without this button the only way out of
                      a failed roster is reloading the page.
                    */}
                    <Button
                      disabled={channels.isFetching}
                      onClick={() => {
                        void channels.refetch();
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      {channels.isFetching ? "Trying…" : "Try again"}
                    </Button>
                  </EmptyContent>
                ) : null}
              </Empty>
            </div>
          ) : null}
          {/*
           * Named, because this sidebar renders three lists — the brand and its New button, the
           * roster, the footer — and only one of them is a list of anything a person chose. Without a
           * name it is announced as "list, 12 items" among two others, and there is no visible
           * heading to hang it off: the group has no `SidebarGroupLabel`, deliberately, because the
           * roster fills the sidebar and a label over it would be labelling the whole surface.
           *
           * `gap-px` moves here with the rows, from the group it used to be the direct children of.
           */}
          <SidebarMenu aria-label="Conversations" className="gap-px">
            {/*
             * `initial={false}` covers only the children this element has on its very first render,
             * which here is none — the roster is still loading — so the rows still fade in when they
             * first arrive. Every later suppression is the row's own `initial`, above.
             *
             * It renders no element of its own, so the rows' `<li>`s are still direct children of the
             * list above: `AnimatePresence` returns its children and nothing around them, and holds a
             * leaving one mounted rather than wrapping it.
             */}
            <AnimatePresence initial={false}>
              {visibleItems.map((channel) => (
                <Row
                  key={channel.id}
                  animateEntrance={animate.entrance}
                  animateOrder={animate.order}
                  channel={channel}
                />
              ))}
            </AnimatePresence>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="gap-px">
          <SidebarMenuItem>
            {/* Beside Agents rather than inside Admin: writing a skill is something anybody does. */}
            <SidebarMenuButton
              className="hover:bg-foreground/5 h-10"
              render={(props) => (
                <Link
                  {...props}
                  to="/skills"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
            >
              <div className="size-[28px] flex items-center justify-center">
                <IconBox />
              </div>
              <span className="text-sm tracking-tight">Skills</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="hover:bg-foreground/5 h-10"
              render={(props) => (
                <Link
                  {...props}
                  to="/agents"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
            >
              <div className="size-[28px] flex items-center justify-center">
                <IconBolt />
              </div>
              <span className="text-sm tracking-tight">Agents</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {signOutProblem ? (
            <SidebarMenuItem>
              <p className="px-2 pb-1 text-destructive text-xs" role="alert">
                {signOutProblem}
              </p>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="hover:bg-foreground/5 h-10" />
                }
              >
                <UserAvatar />
                <span className="text-sm tracking-tight">
                  {currentUser?.name || currentUser?.email}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="p-1.5"
                side="top"
                sideOffset={8}
              >
                {/* Admin routes are server-guarded; hide the entry for users who cannot open them. */}
                {currentUser?.role === "admin" ? (
                  <DropdownMenuItem
                    className={userMenuItemClassName}
                    render={<Link {...adminLinkOptions} />}
                  >
                    <IconShieldLock />
                    Admin
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  render={<Link {...settingsLinkOptions} />}
                >
                  <IconSettings />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  disabled={signOut.isPending}
                  onClick={handleSignOut}
                  variant="destructive"
                >
                  <IconLogout />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/**
 * The Gregorian mean year and month, in milliseconds.
 *
 * Mean lengths, because a real month is 28 to 31 days and a real year is 365 or 366, and the caption
 * these feed rounds to a whole unit anyway. It is a caption, not a date: "3 months ago" being a few
 * days out is invisible, and anybody who needs the actual day opens the conversation.
 */
const MEAN_YEAR_MS = 31_556_952_000;
const MEAN_MONTH_MS = MEAN_YEAR_MS / 12;

/**
 * The units a gap between two instants can be said in, smallest first, each with the gap it stops
 * being the right one at.
 *
 * IT USED TO END AT WEEKS, so a conversation nobody had touched in a year read "52 weeks ago" and one
 * from three years ago read "157 weeks ago" — numbers nobody converts in their head, on the caption
 * that exists to be read at a glance. Months and years carry those now.
 *
 * Every limit is the length of the next unit up, except months, which stop half a month short of a
 * year. `relativeScale` rounds, so a limit of a full year would let 360 days — 11.8 months — round to
 * "12 months ago", which is "52 weeks ago" again one unit further along. Stopping early hands that
 * gap to years, where it reads "last year". The smaller boundaries have the same shape in a milder
 * form (23.9 hours says "24 hours ago" rather than "yesterday") and are left alone: nobody misreads
 * 24 hours, and moving them would reword every caption on the surface.
 */
const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: MEAN_MONTH_MS, divisor: 604_800_000, unit: "week" },
  {
    limit: MEAN_YEAR_MS - MEAN_MONTH_MS / 2,
    divisor: MEAN_MONTH_MS,
    unit: "month",
  },
  { limit: Number.POSITIVE_INFINITY, divisor: MEAN_YEAR_MS, unit: "year" },
] as const;

const relativeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

/**
 * How to say a gap in milliseconds: how many of a unit, signed as `Intl.RelativeTimeFormat` wants it
 * (negative for the past), or null for a gap that is not a number.
 *
 * Split out from `relativeTime` and exported because this is the part with a rule in it — which unit
 * a given gap belongs to — while the formatting is `Intl`'s. A test can pin "a year-old conversation
 * is said in years" without pinning the wording of any particular locale.
 */
export function relativeScale(
  elapsed: number,
): { value: number; unit: (typeof RELATIVE_UNITS)[number]["unit"] } | null {
  if (!Number.isFinite(elapsed)) {
    return null;
  }
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    // Unreachable: the last unit's limit is `POSITIVE_INFINITY` and `elapsed` is finite by the guard
    // above. It is here so `scale` is a unit rather than possibly `undefined`, and so an entry
    // appended after that one — with a real limit, as every other entry has — cannot crash a row.
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return { value: -Math.round(elapsed / scale.divisor), unit: scale.unit };
}

/**
 * Locale-aware relative timestamp, e.g. "2 minutes ago", or nothing for a value that is not a date.
 *
 * `Intl.RelativeTimeFormat.format` throws `RangeError` on a non-finite number, and an unparseable
 * date gives `NaN`. This value arrives over a socket, and there is no error boundary anywhere in this
 * app, so one bad `lastMessageAt` would take the whole sidebar down rather than one row's caption.
 * The server validates and serialises with `toISOString()`, which is why that is unlikely rather than
 * why it is impossible. `relativeScale` returns null for exactly that case, and this returns nothing.
 *
 * Read at render and never on a timer: a caption can therefore read "2 minutes ago" for longer than
 * two minutes, until something re-renders the row. That is the trade. The roster re-renders on every
 * socket patch and on every navigation, which is most of what happens on this surface, and a ticker
 * that woke every row once a minute to move one word is the more expensive half of it.
 */
function relativeTime(iso: string): string | undefined {
  const scale = relativeScale(Date.now() - new Date(iso).getTime());
  if (scale === null) {
    return undefined;
  }
  return relativeFormat.format(scale.value, scale.unit);
}
