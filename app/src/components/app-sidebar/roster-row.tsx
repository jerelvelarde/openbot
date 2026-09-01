import {
  IconArchive,
  IconArchiveOff,
  IconDots,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconTrash,
} from "@tabler/icons-react";
import {
  type UseMutationOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  deleteBotChatMutationOptions,
  setBotChatArchivedMutationOptions,
  setBotChatPinnedMutationOptions,
} from "@/lib/bot-chats/mutations";
import {
  deleteChannelMutationOptions,
  setChannelArchivedMutationOptions,
  setChannelPinnedMutationOptions,
} from "@/lib/channels/mutations";
import type { RosterKind } from "@/lib/roster/queries";
import { ChannelAvatar } from "../channels/avatar";

/**
 * Where a row goes when it is clicked.
 *
 * Pure and exported so the branching is provable without a router: a roster row that does not open
 * what it names is the failure this guards against.
 */
export function linkFor(row: { kind: RosterKind; id: string }) {
  return row.kind === "channel"
    ? { to: "/channel/$channelId" as const, params: { channelId: row.id } }
    : { to: "/bot/$botChatId" as const, params: { botChatId: row.id } };
}

/**
 * Which conversation, if any, is the one on screen.
 *
 * The open conversation may be either kind — a channel or a bot chat — and each kind's id arrives
 * under a different route param: `channelId` for one, `botChatId` for the other. This is the one
 * place that knows that, so `Row`'s unread check (in `app-sidebar.tsx`) and `RosterRow`'s `isOpen`
 * check below both resolve it here instead of each rolling its own — which is how they drifted
 * apart before: `Row` once read only `params.channelId`, so on a bot chat route it always got
 * `undefined`, which never equals a real id, so the conversation on screen lit its own unread dot
 * the moment its Bot replied.
 *
 * When both params are somehow present, `channelId` wins — a precedence that is arbitrary, not
 * meaningful, since no route ever matches both at once.
 */
export function openConversationId(params: {
  channelId?: string;
  botChatId?: string;
}): string | undefined {
  return params.channelId ?? params.botChatId;
}

/**
 * What the context menu offers, as a list of acts.
 *
 * The same three on both kinds. A menu whose Delete worked on channel rows and not on bot chat rows
 * would be a menu that changed shape depending on which identical-looking row was right-clicked,
 * which is why `bot_chats` carries `deleted_at` at all.
 */
export function menuFor(row: { archived: boolean; pinned: boolean }) {
  return [
    row.pinned ? "unpin" : "pin",
    row.archived ? "restore" : "archive",
    "delete",
  ] as const;
}

/**
 * What deleting this row costs, in the words its kind has earned.
 *
 * ONE DIALOG, TWO KINDS, AND ONLY ONE OF THEM CAN HAVE ANYBODY ELSE IN IT. `channels` are
 * multi-member by design — `channel_memberships` is keyed on (channel_id, user_id) — so "for anyone
 * in it" is the rule a channel's delete follows, even while the server still inserts exactly one
 * membership per channel (see `hasUnseenActivity` in app-sidebar.tsx, which turns on the same fact).
 * A `bot_chats` row carries a single `user_id` and every server read and write filters on it
 * (server/src/bot-chats/store.ts), so there is no anyone-else for it to have. Told that the
 * conversation will stop appearing for everyone in it, a person reads a teammate into a conversation
 * that cannot hold one — and then hesitates over deleting something that is only theirs.
 *
 * Both sentences describe the roster and neither mentions the transcript, which the server soft-
 * deletes and keeps: a dialog that promised either way would be promising something this button does
 * not decide.
 */
export function deleteWarningFor(kind: RosterKind): string {
  return kind === "channel"
    ? "The conversation will no longer appear for anyone in it."
    : "The conversation is yours alone, and will no longer appear in your list.";
}

/**
 * Mutation options that report a refusal, with the handler attached to the MUTATION.
 *
 * NOT `mutate(variables, { onError })`. `useMutation` is one `MutationObserver` per call site, and
 * query-core keeps per-call callbacks in a single field on it: `MutationObserver.mutate` does
 * `this.#mutateOptions = options` and then `this.#currentMutation?.removeObserver(this)`
 * (@tanstack/query-core 5.102.2, `mutationObserver.js`). So a second click overwrote the stored
 * callbacks *and* detached the observer from the still-running first mutation, and the first click's
 * `onError` never fired at all. Because each handler below clears `problem` before it starts, a
 * refused pin followed a moment later by a second pin left the row saying nothing whatsoever — the
 * silence those handlers exist to end. Neither menu item was disabled while its act was in flight
 * and both menus close on the click, so re-opening and clicking again inside one round trip took no
 * effort at all.
 *
 * A mutation invokes its own options' `onError` itself, from the catch in `execute`
 * (`mutation.js`: `await this.options.onError?.(…)`), with no reference to its observers — so a
 * handler put here survives the detach that lost the per-call one. That is the fix
 * `recordBotChatActivityMutationOptions` made for the same query-core behaviour, and its docblock is
 * the longer telling of why. The items are disabled while pending as well, so the two clicks are
 * harder to make in the first place; this is what makes the first one report itself when they are.
 *
 * The wrapped options' own `onError` still runs, first: none of the four pin and archive options
 * define one today, and one added later must not be silently dropped by this wrapper.
 */
export function reportingRefusal<TVariables>(
  options: Omit<UseMutationOptions<void, Error, TVariables>, "mutationKey">,
  report: (message: string) => void,
): Omit<UseMutationOptions<void, Error, TVariables>, "mutationKey"> {
  return {
    ...options,
    onError: (thrown, variables, onMutateResult, context) => {
      options.onError?.(thrown, variables, onMutateResult, context);
      report(thrown.message);
    },
  };
}

/** What a row can say about itself, beside its name and its last line. */
export type RowMarker = "unread" | "archived" | "pinned";

/**
 * Which state markers this row shows, in the order they sit on the row.
 *
 * ARCHIVED HAS TO BE VISIBLE. `All` holds archived and live rows together, and an archived row that
 * looks identical to a live one leaves right-clicking it and reading whether the menu offers Archive
 * or Restore as the only way to tell the two apart — which guts the tab, and the tri-state filter
 * with it. The row already knew: `archived` arrives on it, and `menuFor` was its only reader.
 *
 * Shown in every list rather than only in `All`, because it is a fact about the row and not about
 * which list the row came in on — which is why `archived` is carried per row at all (see the note on
 * it in roster/queries.ts). Under `Archived` that repeats what the pressed button says,
 * the way the pin repeats itself on every pinned row in every list; repetition is not wrongness, and
 * the alternative is a row whose appearance depends on where it is being looked at.
 *
 * State about the message comes before state about the row, so the unread dot sits first.
 *
 * Returned as a list and iterated at the render site rather than written out as three conditionals
 * there, for the same reason `menuFor` is: the rule then has one home, and it is a home a test can
 * reach without a browser.
 */
export function rowMarkers(row: {
  unread: boolean;
  archived: boolean;
  pinned: boolean;
}): RowMarker[] {
  const markers: RowMarker[] = [];
  if (row.unread) markers.push("unread");
  if (row.archived) markers.push("archived");
  if (row.pinned) markers.push("pinned");
  return markers;
}

/**
 * What each marker looks like.
 *
 * Elements, keyed here, rather than a component per marker: the three have nothing in common — a
 * dot, a word, an icon — so a shared wrapper would exist only to hold the key, and would add a gap
 * to the row for every marker it wrapped.
 *
 * TWO OF THE THREE ARE SHAPES, AND A SHAPE SAYS NOTHING OUT LOUD. Archived is a word, so it reaches
 * anybody reading the row by any means. The unread dot and the pin were a coloured circle and an
 * `<svg>` with no text anywhere in them — so the two facts this row is most often scanned for were
 * visible only to somebody looking at it, and a screen reader was given three rows it could not tell
 * apart. `role="img"` with `aria-label` is what names a graphic that carries meaning; the alternative,
 * a visually hidden word inside each, would need a wrapper around the icon for the sole purpose of
 * holding it — which is the wrapper the paragraph above declines.
 *
 * The labels join the row link's accessible name, beside the conversation's name and its preview,
 * which is where they belong: they are facts about that conversation, and "Archived" has been read out
 * from exactly there since the day it was added.
 */
const MARKER_META: Record<RowMarker, ReactNode> = {
  unread: (
    <span
      aria-label="Unread"
      className="size-2 shrink-0 rounded-full bg-primary"
      key="unread"
      role="img"
    />
  ),
  archived: (
    <span
      className="shrink-0 rounded bg-muted-foreground/10 px-1 text-[10px] text-muted-foreground/80 leading-4"
      key="archived"
    >
      Archived
    </span>
  ),
  pinned: (
    <IconPinFilled
      aria-label="Pinned"
      className="size-3 shrink-0 text-muted-foreground/70"
      key="pinned"
      role="img"
    />
  ),
};

/**
 * Label and icon for the two toggle acts `menuFor` can name.
 *
 * Delete is deliberately absent: its label never toggles and its click opens a dialog instead of
 * mutating, so it is rendered directly rather than forced through a lookup built for the two acts
 * that do toggle.
 */
const ACT_META: Record<
  "pin" | "unpin" | "archive" | "restore",
  { icon: ReactNode; label: string }
> = {
  pin: { icon: <IconPin />, label: "Pin conversation" },
  unpin: { icon: <IconPinnedOff />, label: "Unpin conversation" },
  archive: { icon: <IconArchive />, label: "Archive" },
  restore: { icon: <IconArchiveOff />, label: "Restore" },
};

/**
 * All the row's act rendering needs of a menu item, and all its two menus have in common.
 *
 * `ContextMenuItem` and `DropdownMenuItem` are separate wrappers over the same Base UI `Menu.Item`,
 * so neither's props type is the other's; this is the slice both satisfy.
 */
type ActMenuItem = (props: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  variant?: "default" | "destructive";
}) => ReactNode;

/**
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 *
 * Pin, Archive and Delete hang off two triggers that offer exactly the same list: right-clicking the
 * row, and the ⋯ button at its end. THE BUTTON IS WHAT THE KEYBOARD CAN REACH. A context menu is
 * opened with a pointer — right click, or a long press on touch — and the only other control this
 * row had was the link, which navigates and nothing else. So archiving, the act this row exists to
 * offer, could not be asked for without a mouse; a person moving down the roster by Tab had no way
 * to it at all. The button hides until the row is hovered or the button itself is focused, so the
 * roster still reads as a list of conversations rather than a list of controls.
 *
 * Deleting is confirmed in a dialog that names the conversation, because the row it was invoked on
 * is one of several identical-looking rows. Archiving gets no such dialog: it is reversible and
 * hides nothing permanently.
 */
export const RosterRow = memo(function RosterRow({
  kind,
  id,
  participantIds,
  name,
  lastMessage,
  lastMessageAt,
  pinned,
  unread,
  archived,
}: {
  kind: RosterKind;
  id: string;
  participantIds: string[];
  name: string;
  lastMessage?: string;
  lastMessageAt?: string;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Whether this row's conversation is the one on screen, as a boolean, so navigating between
  // conversations re-renders the two rows whose answer changed rather than the whole roster.
  const isOpen = useParams({
    strict: false,
    select: (params) => {
      const held = params as { channelId?: string; botChatId?: string };
      return openConversationId(held) === id;
    },
  });

  const [confirming, setConfirming] = useState(false);
  /**
   * Why the last pin, archive or restore did not take, said on the row it was asked of.
   *
   * These used to fail in total silence: the menu closed, nothing moved, and nothing on screen
   * accounted for it — which reads as the app ignoring the click. There is no toast in this app, and
   * the row is where the person was looking, so the sentence goes here.
   *
   * ONE SENTENCE, NOT ONE PER ACT. Pin and archive held a state each, and each was cleared only by
   * the next attempt at its own act — so a refused pin sat under this row through a successful
   * archive, through every navigation (the row does not unmount), for the rest of the session, with
   * nothing a person could do about it. Holding one makes every act's clear the same clear, and
   * opening either menu clears it too, so a stale refusal goes away the moment somebody looks at the
   * acts again rather than only when they retry the one act that failed.
   *
   * Cleared on open and not on close: both menus close on the click that starts the mutation, and
   * the refusal arrives after that, so clearing on close would race the sentence it exists to show.
   *
   * Filled by the mutations themselves rather than by callbacks handed to `mutate` — see
   * `reportingRefusal` for the click this row used to drop on the floor.
   */
  const [problem, setProblem] = useState<string | null>(null);

  // One row, two kinds, and the endpoints differ. Both mutations of every pair are created
  // unconditionally — hooks cannot be called conditionally — so the picking happens after they
  // exist, not instead of creating one of them.
  //
  // Delete's two mutation functions both take a bare id, so picking one by kind is the whole
  // story: `deleteConversation` below stands in for either from here on. Pin and archive take
  // differently shaped variables (`{ channelId, ... }` vs `{ botChatId, ... }`), so a single
  // picked handle would still need a kind check at every call to know which shape to build —
  // that check happens once, in each handler below, against `channelPinned`/`botChatPinned` and
  // `channelArchived`/`botChatArchived` directly, rather than through an alias that could not
  // itself be called without the same check. The two pending flags further down do pick by kind,
  // because reading a flag needs no variables; it is only the call that cannot be shared.
  const channelPinned = useMutation(
    reportingRefusal(setChannelPinnedMutationOptions(queryClient), setProblem),
  );
  const botChatPinned = useMutation(
    reportingRefusal(setBotChatPinnedMutationOptions(queryClient), setProblem),
  );

  const channelArchived = useMutation(
    reportingRefusal(
      setChannelArchivedMutationOptions(queryClient),
      setProblem,
    ),
  );
  const botChatArchived = useMutation(
    reportingRefusal(
      setBotChatArchivedMutationOptions(queryClient),
      setProblem,
    ),
  );

  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));
  const deleteBotChat = useMutation(deleteBotChatMutationOptions(queryClient));
  const deleteConversation = kind === "channel" ? deleteChannel : deleteBotChat;

  // Whether this row's own pin or archive is already in flight. The items that start them are
  // disabled while it is, which is the near half of the fix `reportingRefusal` describes: one
  // observer cannot be asked twice if the second ask is not offered.
  const pinPending = (kind === "channel" ? channelPinned : botChatPinned)
    .isPending;
  const archivePending = (
    kind === "channel" ? channelArchived : botChatArchived
  ).isPending;

  const confirmDelete = async () => {
    /*
     * Away first when this row's conversation is the one on screen.
     *
     * The roster invalidates the moment the delete lands, so this row — and the dialog living inside
     * it — unmounts while the rest of this function is still owed. Navigating after the mutation
     * therefore ran in a component that was already gone, leaving somebody looking at a conversation
     * that no longer exists. Leaving before asking is safe in the other direction: a refused delete
     * puts them on the roster with the conversation still in it, and says why in the dialog.
     */
    if (isOpen) {
      await navigate({ to: "/" });
    }
    try {
      // Both delete mutations take a bare id, unlike pin and archive, so no branch is needed here.
      await deleteConversation.mutateAsync(id);
    } catch {
      // The error is on the mutation and rendered in the dialog; leaving it open says "not done".
      return;
    }
    setConfirming(false);
  };

  // What the menus offer, given this row's current state. Rendered below by iterating this array
  // rather than by hardcoding the three items, so a rule this file no longer states correctly —
  // like an archived row still saying "Archive" — is a rule this file no longer states at all, not
  // a rule that quietly diverges between the tested function and the rendered menu.
  const acts = menuFor({ archived, pinned });

  const handlePinClick = () => {
    setProblem(null);
    if (kind === "channel") {
      channelPinned.mutate({ channelId: id, pinned: !pinned });
    } else {
      botChatPinned.mutate({ botChatId: id, pinned: !pinned });
    }
  };

  const handleArchiveClick = () => {
    setProblem(null);
    if (kind === "channel") {
      channelArchived.mutate({ channelId: id, archived: !archived });
    } else {
      botChatArchived.mutate({ botChatId: id, archived: !archived });
    }
  };

  /*
   * The acts, rendered into whichever of the two menus is asking for them.
   *
   * Written once and handed the item component, because the row has two menus and two hand-written
   * copies of this list is how one of them ends up offering Archive on a row the other offers
   * Restore on — or, worse, how the keyboard's menu quietly loses the item the pointer's menu keeps.
   * `menuFor` already keeps the shape of the list in one place; this keeps the rendering of it there
   * too, disabled states included.
   */
  const renderActs = (Item: ActMenuItem) =>
    acts.map((act) =>
      act === "delete" ? (
        <Item
          key="delete"
          onClick={() => {
            // A refusal from a previous attempt is not news about this one.
            deleteConversation.reset();
            setConfirming(true);
          }}
          variant="destructive"
        >
          <IconTrash />
          Delete…
        </Item>
      ) : (
        <Item
          disabled={
            act === "pin" || act === "unpin" ? pinPending : archivePending
          }
          key={act}
          onClick={
            act === "pin" || act === "unpin"
              ? handlePinClick
              : handleArchiveClick
          }
        >
          {ACT_META[act].icon}
          {ACT_META[act].label}
        </Item>
      ),
    );

  const clearProblemOnOpen = (open: boolean) => {
    if (open) setProblem(null);
  };

  return (
    <>
      <div className="group/row relative">
        <ContextMenu onOpenChange={clearProblemOnOpen}>
          <ContextMenuTrigger>
            <Link
              {...linkFor({ kind, id })}
              className="flex flex-row py-2 px-2 gap-2 items-center w-full hover:bg-foreground/5 rounded-lg [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
              activeProps={{
                className: "bg-foreground/5",
              }}
            >
              <div className="">
                <ChannelAvatar participantIds={participantIds} size={32} />
              </div>
              <div className="flex-col min-w-0 flex-1">
                <div className="flex flex-row items-center justify-between gap-2">
                  <span
                    className={`text-[14px] tracking-[-1%] truncate ${
                      unread ? "font-medium" : ""
                    }`}
                  >
                    {name}
                  </span>
                  <div className="text-[12px] text-muted-foreground/70">
                    {lastMessageAt}
                  </div>
                </div>
                <div className="mt-px flex h-4 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
                    {lastMessage}
                  </span>
                  {rowMarkers({ unread, archived, pinned }).map(
                    (marker) => MARKER_META[marker],
                  )}
                </div>
              </div>
            </Link>
          </ContextMenuTrigger>
          <ContextMenuContent>{renderActs(ContextMenuItem)}</ContextMenuContent>
        </ContextMenu>
        {/*
         * A sibling of the link, not a child of it: this is a button, and a button inside an anchor
         * is neither valid HTML nor separately clickable. It sits over the right-hand end of the row
         * — the timestamp it covers is the least of what the row says, and only while somebody is
         * pointing at that row or has tabbed onto the button.
         *
         * `opacity-0` rather than `hidden`, because a hidden button is not in the tab order and this
         * one has to be: it is the whole keyboard path. `pointer-events-none` while invisible so it
         * does not swallow clicks meant for the row underneath.
         */}
        <DropdownMenu onOpenChange={clearProblemOnOpen}>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`Actions for ${name}`}
                className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 bg-sidebar opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 data-popup-open:pointer-events-auto data-popup-open:opacity-100"
                size="icon-sm"
                variant="ghost"
              >
                <IconDots />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {renderActs(DropdownMenuItem)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {problem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        open={confirming}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>{deleteWarningFor(kind)}</DialogDescription>
          </DialogHeader>
          {deleteConversation.error ? (
            <p className="text-destructive text-sm">
              {deleteConversation.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={deleteConversation.isPending}
              onClick={() => {
                /*
                 * Caught and dropped for the reason `bot_.$botChatId.tsx` gives on its own
                 * create-and-go chain: the `await navigate(…)` that opens `confirmDelete` sits
                 * outside its try, and a router navigation that rejects would otherwise reach
                 * `window.onunhandledrejection`, where a reporter reads it as an uncaught
                 * application fault. Nothing is lost by dropping it — the delete has not run when
                 * that happens, so the dialog stays open over a conversation that is still there,
                 * which is the honest state to leave somebody in.
                 */
                void confirmDelete().catch(() => {});
              }}
              size="sm"
              variant="destructive"
            >
              {deleteConversation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
