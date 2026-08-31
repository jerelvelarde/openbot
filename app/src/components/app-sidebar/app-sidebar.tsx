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
 * `fetchNextPage`, so `channels.data` cannot hold more than 50 and this comparison is always true.
 * It stays because it is the cheap half of wiring pagination: the day a second page can arrive, the
 * cap is already in place rather than being the thing somebody notices after the animation starts
 * measuring hundreds of rows.
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
 * Which nothing to say, of five — and the sixth case, which is not a nothing at all.
 *
 * FOUR DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has used yet needs
 * telling how to start. A roster that simply does not match what is in the box has to say so and
 * quote it back — told "you don't have conversations yet" while holding a typo, a person reads their
 * conversations as gone. An empty archive is not an empty account. And `All` being empty is the only
 * one of the four that really does mean there is nothing anywhere.
 *
 * The search wording wins over the status wording, because a search that matched nothing is a fact
 * about the search whichever list it ran against.
 *
 * A FAILED LOAD IS THE SIXTH CASE, AND IT IS NOT A NOTHING. It used to arrive here disguised as one:
 * a failed roster has no data, so `loaded` is false, so the fifth case returned `null` and the
 * sidebar rendered a search box, three status buttons, and a void — no rows, no sentence, no retry.
 * With `retry: 1` and `refetchOnWindowFocus: false` (app/src/query-client.ts) nothing tried again on
 * its own, so the void was permanent — and a permanent void is read as "my conversations are gone".
 * Meanwhile the roster query was constructing the sentence for exactly this ("Could not load your
 * conversations") and handing it to nobody. So it is handed in and said, and `failed` tells the
 * caller to offer the retry the query itself will not attempt.
 *
 * Only while nothing has loaded. A refetch that fails with rows already in hand leaves the rows
 * alone: they are the true thing on screen, and covering them with an alarm would be this docblock's
 * own mistake made in the other direction.
 */
export function emptyStateFor(input: {
  status: RosterStatus;
  searching: boolean;
  total: number;
  search: string;
  /** Whether the roster has answered at all. `false` while pending, and while errored. */
  loaded: boolean;
  /** The sentence the roster query failed with, or null if it has not failed. */
  failure: string | null;
}): { failed: boolean; title: string; description: string } | null {
  /*
   * FIVE nothings, not four. "Not known yet" is not "nothing", and conflating them is the exact
   * failure this docblock warns about below: while the query is pending `matchingItems` returns `[]`,
   * so `total` is 0, and without this line a person's first paint tells them they have no
   * conversations. The two inline blocks this replaced were accidentally safe — they tested
   * `channels.data?.length === 0`, and `undefined === 0` is false — so collapsing them lost a guard
   * nobody had written down.
   *
   * SIX, and the sixth lives inside the fifth. "Not known yet" splits in two: pending, which says
   * nothing because it is about to know, and failed, which has to say something because it never
   * will. Both reach this line as `loaded: false, total: 0`, which is exactly why the failure stayed
   * silent — nothing here could tell them apart until `failure` was passed in.
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
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
 */
function Row({
  channel,
  animateOrder,
}: {
  channel: RosterItem;
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
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(-8px)",
      }}
      exit={{ opacity: 0 }}
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
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing — and the moving target is the very thing
   * they are trying to read. Order animation is for a channel that was just spoken in, which is
   * occasional; this is not.
   *
   * SWITCHING STATUS DOES NOT ANIMATE EITHER, for the same reason. Active and Archived are disjoint,
   * but All holds both, so a row moving into or out of All can keep the same key across the click
   * while its position in the array shifts — layout animation reads that as the row leaping, when
   * really the list underneath it was just swapped out for a different one. Restricting animation to
   * the Active view is the same call `!searching` makes: skip the case where the list itself just
   * changed shape, rather than chase every way that can happen.
   */
  const animateOrder =
    !searching &&
    status === "active" &&
    (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;
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
        <SidebarMenu>
          <SidebarGroup className="gap-px">
            <SidebarMenuItem>
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
            </SidebarMenuItem>
            <SidebarMenuItem>
              <StatusFilter onChange={setStatus} value={status} />
            </SidebarMenuItem>
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
            <AnimatePresence initial={false}>
              {visibleItems.map((channel) => (
                <Row
                  key={channel.id}
                  animateOrder={animateOrder}
                  channel={channel}
                />
              ))}
            </AnimatePresence>
          </SidebarGroup>
        </SidebarMenu>
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

const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

const relativeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

/**
 * Locale-aware relative timestamp, e.g. "2 minutes ago", or nothing for a value that is not a date.
 *
 * `Intl.RelativeTimeFormat.format` throws `RangeError` on a non-finite number, and an unparseable
 * date gives `NaN`. This value arrives over a socket, and there is no error boundary anywhere in this
 * app, so one bad `lastMessageAt` would take the whole sidebar down rather than one row's caption.
 * The server validates and serialises with `toISOString()`, which is why that is unlikely rather than
 * why it is impossible.
 *
 * Read at render and never on a timer: a caption can therefore read "2 minutes ago" for longer than
 * two minutes, until something re-renders the row. That is the trade. The roster re-renders on every
 * socket patch and on every navigation, which is most of what happens on this surface, and a ticker
 * that woke every row once a minute to move one word is the more expensive half of it.
 */
function relativeTime(iso: string): string | undefined {
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed)) {
    return undefined;
  }
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return relativeFormat.format(
    -Math.round(elapsed / scale.divisor),
    scale.unit,
  );
}
