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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { RosterRow } from "./roster-row";
import { StatusFilter } from "./status-filter";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;
const settingsLinkOptions = { to: "/settings" } satisfies LinkOptions;

const userMenuItemClassName = "gap-2 px-2 py-1.5";

function UserAvatar() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const initials =
    currentUser?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? currentUser?.email.slice(0, 2).toUpperCase();

  return (
    <div className="size-[28px] bg-muted-foreground/10 text-foreground/70 rounded-full flex items-center justify-center text-xs overflow-hidden">
      {initials}
    </div>
  );
}

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
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
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 *
 * Unchanged in body for the roster's two kinds: a channel and a bot chat both project `name` and
 * `lastMessage`, so the filter above already searches both without knowing which kind a given row is.
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
 * Pinned channels first, everything else after, newest activity first within each group.
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
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
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
 * Which nothing to say, of four.
 *
 * FOUR DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has used yet needs
 * telling how to start. A roster that simply does not match what is in the box has to say so and
 * quote it back — told "you don't have conversations yet" while holding a typo, a person reads their
 * conversations as gone. An empty archive is not an empty account. And `All` being empty is the only
 * one of the four that really does mean there is nothing anywhere.
 *
 * The search wording wins over the status wording, because a search that matched nothing is a fact
 * about the search whichever list it ran against.
 */
export function emptyStateFor(input: {
  status: RosterStatus;
  searching: boolean;
  total: number;
  search: string;
}): { title: string; description: string } | null {
  if (input.total > 0) return null;

  if (input.searching) {
    return {
      title: "No conversations match your search",
      description: `Nothing here is named “${input.search.trim()}”, and nobody has said it recently either.`,
    };
  }

  if (input.status === "archived") {
    return {
      title: "Nothing archived",
      description:
        "Archiving a conversation takes it out of this list without deleting anything. You can bring it back at any time.",
    };
  }

  if (input.status === "active") {
    return {
      title: "No conversations yet",
      description:
        "Start one with a coworker, or open a Bot chat. Anything you archive will still be here under Archived.",
    };
  }

  return {
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
  // The open id comes from whichever route param matched — `channelId` for a channel route,
  // `botChatId` for a bot chat route — mirroring `RosterRow`'s `isOpen` below. The two must stay
  // in step: reading only `channelId` here once meant an open bot chat compared its own id against
  // `undefined`, always true, so the row you were looking at lit its own unread dot the moment its
  // Bot replied — the exact case `isUnread`'s docblock says never happens.
  const unread = useParams({
    strict: false,
    select: (params) => {
      const held = params as { channelId?: string; botChatId?: string };
      return isUnread(channel, held.channelId ?? held.botChatId);
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

  const handleSignOut = async () => {
    await signOut.mutateAsync();
    await navigate({ to: "/sign" });
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
                  aria-label="Search channels"
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
            {(() => {
              const empty = emptyStateFor({
                status,
                searching,
                total: visibleItems.length,
                search,
              });
              return empty ? (
                <div className="py-4">
                  <Empty className="border border-dashed min-h-[40dvh]">
                    <EmptyHeader>
                      <EmptyTitle>{empty.title}</EmptyTitle>
                      <EmptyDescription className="text-pretty">
                        {empty.description}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </div>
              ) : null;
            })()}
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
              <span className="text-sm trackint-tight">Skills</span>
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
              <span className="text-sm trackint-tight">Agents</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="hover:bg-foreground/5 h-10" />
                }
              >
                <UserAvatar />
                <span className="text-sm trackint-tight">
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

/** Locale-aware relative timestamp, e.g. "2 minutes ago". */
function relativeTime(iso: string) {
  const elapsed = Date.now() - new Date(iso).getTime();
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return relativeFormat.format(
    -Math.round(elapsed / scale.divisor),
    scale.unit,
  );
}
