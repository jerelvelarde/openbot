import {
  IconArchive,
  IconArchiveOff,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
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
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 *
 * Right-click opens Pin, Archive, and Delete. Deleting is confirmed in a dialog that names the
 * conversation, because the row it was invoked on is one of several identical-looking rows. Archiving
 * gets no such dialog: it is reversible and hides nothing permanently.
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
  // A retired Bot's chat still lists here, unrendered by this row for now — carried in the props
  // because the roster already knows it and a later screen needs it, not because this row uses it.
  active: _active,
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
  active: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Whether this row's conversation is the one on screen, as a boolean, so navigating between
  // conversations re-renders the two rows whose answer changed rather than the whole roster.
  const isOpen = useParams({
    strict: false,
    select: (params) => {
      const held = params as { channelId?: string; botChatId?: string };
      return held.channelId === id || held.botChatId === id;
    },
  });

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
  // itself be called without the same check.
  const channelPinned = useMutation(
    setChannelPinnedMutationOptions(queryClient),
  );
  const botChatPinned = useMutation(
    setBotChatPinnedMutationOptions(queryClient),
  );

  const channelArchived = useMutation(
    setChannelArchivedMutationOptions(queryClient),
  );
  const botChatArchived = useMutation(
    setBotChatArchivedMutationOptions(queryClient),
  );

  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));
  const deleteBotChat = useMutation(deleteBotChatMutationOptions(queryClient));
  const deleteConversation = kind === "channel" ? deleteChannel : deleteBotChat;

  const [confirming, setConfirming] = useState(false);
  /**
   * Why a pin did not take, said on the row it was asked of.
   *
   * Pinning used to fail in total silence: the menu closed, the pin did not move, and nothing on
   * screen accounted for it — which reads as the app ignoring the click. There is no toast in this
   * app, and the row is where the person was looking, so the sentence goes here and is replaced by
   * the next attempt.
   */
  const [pinProblem, setPinProblem] = useState<string | null>(null);
  /** Same treatment, same reason, for a failed archive or restore. */
  const [archiveProblem, setArchiveProblem] = useState<string | null>(null);

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

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <Link
            {...linkFor({ kind, id })}
            type="button"
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
                {unread ? (
                  /* State about the message beats state about the row, so it sits first. */
                  <span className="size-2 shrink-0 rounded-full bg-primary" />
                ) : null}
                {pinned ? (
                  <IconPinFilled className="size-3 shrink-0 text-muted-foreground/70" />
                ) : null}
              </div>
            </div>
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              setPinProblem(null);
              if (kind === "channel") {
                channelPinned.mutate(
                  { channelId: id, pinned: !pinned },
                  { onError: (thrown) => setPinProblem(thrown.message) },
                );
              } else {
                botChatPinned.mutate(
                  { botChatId: id, pinned: !pinned },
                  { onError: (thrown) => setPinProblem(thrown.message) },
                );
              }
            }}
          >
            {pinned ? <IconPinnedOff /> : <IconPin />}
            {pinned ? "Unpin conversation" : "Pin conversation"}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              setArchiveProblem(null);
              if (kind === "channel") {
                channelArchived.mutate(
                  { channelId: id, archived: !archived },
                  { onError: (thrown) => setArchiveProblem(thrown.message) },
                );
              } else {
                botChatArchived.mutate(
                  { botChatId: id, archived: !archived },
                  { onError: (thrown) => setArchiveProblem(thrown.message) },
                );
              }
            }}
          >
            {archived ? <IconArchiveOff /> : <IconArchive />}
            {archived ? "Restore" : "Archive"}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => {
              // A refusal from a previous attempt is not news about this one.
              deleteConversation.reset();
              setConfirming(true);
            }}
          >
            <IconTrash />
            Delete…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {pinProblem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {pinProblem}
        </p>
      ) : null}
      {archiveProblem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {archiveProblem}
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
            <DialogDescription>
              The conversation will no longer appear for anyone in it.
            </DialogDescription>
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
                void confirmDelete();
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
