import { CopilotChat } from "@copilotkit/react-core/v2";
import { IconPlus } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { Button } from "@/components/ui/button";
import { useBotNames } from "@/lib/agents/bot-names";
import { useBotChatActivity } from "@/lib/bot-chats/activity";
import {
  createBotChatMutationOptions,
  markBotChatReadMutationOptions,
} from "@/lib/bot-chats/mutations";
import {
  type BotChat,
  BotChatMissingError,
  botChatQueryOptions,
} from "@/lib/bot-chats/queries";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useLegacyThreadAdoption } from "@/lib/copilot/bot-thread";
import { useStoppedTurn } from "@/lib/copilot/stopped-turn";
import { rosterListQueryOptions } from "@/lib/roster/queries";

/**
 * One direct conversation with one Bot.
 *
 * The thread comes from the row now, not from `localStorage`. What that buys: this URL is
 * shareable, survives a different browser, and `New chat` no longer destroys what it replaces —
 * the previous conversation is a roster row somebody can click.
 *
 * Filename carries a trailing underscore (`bot_.$botChatId.tsx`) to opt out of nesting under
 * `/bot`: `bot.tsx` renders a full-screen component with no `<Outlet />`, so a plain child route
 * would never render — only its parent would. The underscore is stripped from the URL, so
 * `fullPath` is still `/bot/$botChatId` and this makes the route a child of `_app` (which does
 * render an `<Outlet />`) instead.
 */
export const Route = createFileRoute("/_authed/_app/bot_/$botChatId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { botChatId } = Route.useParams();
  const {
    data: botChat,
    error,
    isPending,
  } = useQuery(botChatQueryOptions(botChatId));

  if (isPending) return null;
  if (!botChat) {
    /*
     * A sentence rather than a throw, for the reason `bot.tsx` already gives about a named Bot
     * this deployment does not have: a stale link is not a crash.
     *
     * WHICH sentence is decided by the status, not by there being no data. "Not here any more" is
     * true of a 404 — a stale link, or somebody else's chat, which the server answers 404 for rather
     * than 403 — and it is a lie about every other way a first load fails: offline, a 500, a request
     * aborted by a navigation. Telling somebody their conversation is gone when the network dropped
     * is the worse of the two mistakes, and it is not one they can act on. `botChatQueryOptions`
     * reads `response.status` itself and throws `BotChatMissingError` only for the 404, the same way
     * `adoptBotChatMutationOptions` does for its 409.
     *
     * `error` is consulted only INSIDE `!botChat`, deliberately. In React Query v5 a failed
     * *refetch* keeps the previous `data` alongside the new `error` — and this screen does refetch,
     * once per conversation, when `useBotChatActivity` invalidates `botChatKeys.detail(...)` to pick
     * up the title. Consulting `error` before `data` would swap a live, still-open conversation for
     * one of these sentences on nothing worse than a transient 500.
     */
    const missing = error instanceof BotChatMissingError;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-1 p-6">
        <p className="text-muted-foreground text-sm">
          {missing
            ? "This conversation is not here any more."
            : "Could not load this conversation."}
        </p>
        {missing || !error ? null : (
          <p className="text-muted-foreground text-sm">{error.message}</p>
        )}
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
  const botName = useBotNames();
  const queryClient = useQueryClient();
  const createBotChat = useMutation(createBotChatMutationOptions(queryClient));
  const markRead = useMutation(markBotChatReadMutationOptions(queryClient));

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
  // No-op for every browser with no remembered key — which is every browser after the first visit.
  useLegacyThreadAdoption(botChat.agentId);
  /*
   * The roster hears what is said here from this screen, because nothing else can hear it.
   *
   * The packaged chat owns the composer and the transcript, so this watches the agent instance it
   * binds to and reports each new message in both directions — which is what derives `title` from the
   * person's first message, writes the preview line and its timestamp, restores an archived
   * conversation when somebody speaks in it again, and raises the unseen dot the effect below clears.
   * See `lib/bot-chats/activity.ts` for why the browser is the only thing that can report this and
   * how a replayed history is told apart from something just said.
   */
  useBotChatActivity(botChat);

  /*
   * This conversation's roster summary, read out of the same infinite query the sidebar renders. The
   * detail query deliberately knows nothing about activity; the roster is where the socket keeps
   * `lastMessageAt` live, so it is the one honest source for "has something new been said".
   *
   * Read from "all", not "active", for the reason `channel/$channelId.tsx` gives about its own copy of
   * this: the conversation this screen has open may be the one somebody just archived, and "all" is
   * the only status guaranteed to still hold the row this screen is looking at.
   */
  const roster = useInfiniteQuery(rosterListQueryOptions("all"));
  const summary = roster.data?.find((row) => row.id === botChat.id);

  /*
   * Opening the conversation marks it read; the Bot replying while it is open marks it read again.
   * One effect covers both: the dep changes on navigation and on every activity patch, and the unseen
   * check keeps it from writing a row per render.
   *
   * Keyed on primitives, deliberately — the same trap the channel route documents. The optimistic
   * mark-read patch changes the summary OBJECT's identity without changing these values, so an object
   * dep would re-fire the effect on its own write, and when `lastMessageAt` sits ahead of this
   * browser's clock (another device wrote it) that re-fire loops into a PUT per render.
   */
  const unseen = summary !== undefined && hasUnseenActivity(summary);
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (unseen) {
      markReadMutate(botChat.id);
    }
  }, [botChat.id, unseen, markReadMutate]);

  const startNew = async () => {
    const created = await createBotChat.mutateAsync(botChat.agentId);
    await navigate({
      to: "/bot/$botChatId",
      params: { botChatId: created.id },
    });
  };

  /*
   * Caught and dropped, not because there is nothing to say — `createBotChat.error` says it, in the
   * header below — but because an unhandled rejection is not how it gets said. `mutateAsync` rejects
   * on a refused create, and a rejection nobody handles reaches `window.onunhandledrejection`, where
   * any error reporter reads it as an uncaught application fault rather than a server saying no.
   * The mutation is still the record of what went wrong; this only declines to raise it twice, once
   * properly and once as a crash. `BotResolver` — the only other place that creates a conversation —
   * ends its own chain the same way, with an empty catch and its comment saying why.
   */
  const onNewChat = () => {
    void startNew().catch(() => {});
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b px-6 py-3">
        <div className="flex items-baseline justify-between">
          {/*
           * The Bot's own name when the conversation has no title yet, never a name written into
           * this route. That default used to be "Browser Bot", which `bot.tsx` argues against at
           * length for the default Bot id it used to hardcode: a Bot name in a route is a defect on
           * every fork but the one it came from. It was also a disagreement with the sidebar, which
           * falls back to the Bot's name for this same untitled row (server/src/roster/query.ts:
           * `name: row.title || row.agentName`), so the header and the row named one conversation
           * two different things.
           *
           * `useBotNames` falls back to the Bot's id while the coworker list is still loading, which
           * is the one value that is never somebody else's name.
           */}
          <h1 className="text-lg font-semibold">
            {botChat.title ?? botName(botChat.agentId)}
          </h1>
          {/*
           * Still labelled "New chat", even though pressing it no longer destroys anything: it is
           * still the control that starts a conversation, and the roster is where the previous one
           * now lives.
           *
           * Disabled once the Bot is retired, not just while the request is in flight: `create`
           * resolves the profile through `getWithin`, which filters a retired profile out, so the
           * server always refuses this for a retired Bot. Leaving the button enabled next to a
           * composer this same screen already disables for the same reason would invite a click
           * that is guaranteed to fail.
           */}
          <Button
            disabled={createBotChat.isPending || !botChat.active}
            onClick={onNewChat}
            size="sm"
            variant="ghost"
          >
            <IconPlus />
            New chat
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Ask it to open a page and watch it work.
        </p>
        {/*
         * Where a refused create gets said out loud. The mutation's own `error` is the record — see
         * `onNewChat` above for why the rejection is swallowed rather than left unhandled. There is
         * no toast in this app, and silence here would read as the app ignoring the click, the same
         * reasoning as the `problem` sentence in `roster-row.tsx`.
         */}
        {createBotChat.error ? (
          <p className="text-destructive text-sm" role="alert">
            {createBotChat.error.message}
          </p>
        ) : null}
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
