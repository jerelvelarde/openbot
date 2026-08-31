import { CopilotChat } from "@copilotkit/react-core/v2";
import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { createBotChatMutationOptions } from "@/lib/bot-chats/mutations";
import { type BotChat, botChatQueryOptions } from "@/lib/bot-chats/queries";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useStoppedTurn } from "@/lib/copilot/stopped-turn";

/**
 * One direct conversation with one Bot.
 *
 * The thread comes from the row now, not from `localStorage`. What that buys: this URL is
 * shareable, survives a different browser, and `New chat` no longer destroys what it replaces —
 * the previous conversation is a roster row somebody can click.
 */
export const Route = createFileRoute("/_authed/_app/bot/$botChatId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { botChatId } = Route.useParams();
  const {
    data: botChat,
    isPending,
    error,
  } = useQuery(botChatQueryOptions(botChatId));

  if (isPending) return null;
  if (error || !botChat) {
    /*
     * A sentence rather than a throw, for the reason `bot.tsx` already gives about a named Bot
     * this deployment does not have: a stale link is not a crash. Reached for somebody else's
     * chat too, which the server answers 404 for rather than 403.
     */
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">
          This conversation is not here any more.
        </p>
      </div>
    );
  }

  /*
   * Keyed on the chat, so the hooks below never see it change under them. They cannot be called
   * conditionally, and the guards above return before any of them run.
   */
  return <BotChatScreen botChat={botChat} key={botChat.id} />;
}

function BotChatScreen({ botChat }: { botChat: BotChat }) {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const createBotChat = useMutation(createBotChatMutationOptions(queryClient));

  // Tool calls here act on this Bot's own computer.
  useActiveBot(botChat.agentId);
  /*
   * A turn that ends without an answer has to be said out loud here, because the packaged chat says
   * nothing. It reports a failed run to an `onError` prop and otherwise carries on as though the
   * turn simply finished: the composer unlocks, the spinner goes, and the transcript keeps the
   * person's own message with nothing under it. The banner that would have explained it belongs to
   * a provider this app does not mount.
   */
  const stopped = useStoppedTurn(botChat.agentId);

  const startNew = async () => {
    const created = await createBotChat.mutateAsync(botChat.agentId);
    await navigate({
      to: "/bot/$botChatId",
      params: { botChatId: created.id },
    });
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b px-6 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">
            {botChat.title ?? "Browser Bot"}
          </h1>
          {/*
           * Still labelled "New chat", even though pressing it no longer destroys anything: it is
           * still the control that starts a conversation, and the roster is where the previous one
           * now lives.
           */}
          <Button onClick={() => void startNew()} size="sm" variant="ghost">
            <IconPlus />
            New chat
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Ask it to open a page and watch it work.
        </p>
      </header>
      {/*
       * Both banners render as plain siblings in this fixed order, never one nested inside the
       * other, so either can appear alone or both together without the layout jumping around
       * depending on which conditions are true.
       */}
      {/*
       * No "history could not be loaded" banner here, unlike the `BotChat` this screen replaced.
       * That one existed because a thread id remembered in `localStorage` could name a thread
       * Intelligence had since forgotten, and there was no way to know that until the chat tried.
       * The thread here is `botChat.threadId`, read straight off a row this deployment wrote and is
       * reading right back — there is nothing between one visit and the next that could have gone
       * stale, so the case that banner described cannot happen through this route.
       */}
      {botChat.active ? null : (
        <p
          className="border-b bg-muted/40 px-6 py-2 text-muted-foreground text-sm"
          data-testid="bot-chat-retired"
          role="status"
        >
          This Bot has been retired. The conversation stays readable, but it can
          no longer reply.
        </p>
      )}
      {/*
       * Under the header rather than at the end of the transcript, which is where the missing answer
       * was going to be and where the channel draws its own version of this. The packaged chat owns
       * that list and virtualises it, so reaching into it means replacing the whole message view and
       * taking on its scrolling. The cost of putting the sentence here instead is that it is not
       * beside the gap it explains; what it buys is that it is always on screen, whatever the
       * transcript has been scrolled to, and that it survives the next release of the chat.
       */}
      {stopped ? (
        <p
          className="border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
          data-testid="bot-chat-stopped"
          role="alert"
        >
          {stopped}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {/*
         * Keyed on the thread as well as the agent. Switching agents was already handled by
         * `agentId`, but `threadId` changes too, whenever `botChat` is a different row — and the
         * packaged chat's own `startNewThread`/`setActiveThreadId` are proven no-ops once
         * `threadId` is a controlled prop (node_modules/@copilotkit/react-core/dist/copilotkit-
         * C4RqjAba.mjs:226-254): asking it to start over does nothing while it still holds the
         * old id. A key that omits the thread would leave the previous conversation on screen
         * under a composer that silently posts to the new one.
         */}
        <CopilotChat
          agentId={botChat.agentId}
          input={
            botChat.active
              ? undefined
              : {
                  sendButton: { disabled: true },
                  textArea: { disabled: true },
                }
          }
          key={`${botChat.agentId}:${botChat.threadId}`}
          threadId={botChat.threadId}
        />
      </div>
    </div>
  );
}
