import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { createBotChatMutationOptions } from "@/lib/bot-chats/mutations";
import { type RosterItem, rosterListQueryOptions } from "@/lib/roster/queries";

export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
});

/**
 * Which Bot this screen is for.
 *
 * WHATEVER THIS DEPLOYMENT ACTUALLY HAS. The default used to be a hardcoded `risk-analyst`, a name
 * from a tenant package this one is not: on a clone that ships anything else, opening this screen
 * without naming a Bot took the whole page down to an unstyled error boundary, because the chat
 * throws when asked for an agent the runtime never synced. OpenBot exists to be forked, so a Bot
 * name written into a route is a defect on every fork but the one it came from.
 *
 * A named Bot that this deployment does not have is answered in a sentence rather than thrown,
 * for the same reason: a mistyped link is not a crash.
 */
function RouteComponent() {
  const { agent } = Route.useSearch();
  const { data: agents, isPending } = useQuery(agentListQueryOptions());
  const agentId = agent ?? agents?.[0]?.id;
  const known = agents?.some((candidate) => candidate.id === agentId) ?? false;

  if (isPending) return null;
  if (!agentId || !known) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">
          {agent
            ? `This deployment has no Bot called "${agent}".`
            : "This deployment has no Bots yet."}
        </p>
      </div>
    );
  }

  /*
   * Keyed on the Bot, so the hooks below never see it change under them. They cannot be called
   * conditionally, and the guards above return before any of them run.
   */
  return <BotResolver agentId={agentId} key={agentId} />;
}

/**
 * Where `?agent=` lands, now that a Bot has more than one conversation.
 *
 * Kept rather than removed, because links to this route exist and the default-Bot behaviour is
 * still wanted: somebody who has never opened a Bot chat should get one, not a chooser. It resolves
 * and redirects, so every conversation is reached by its own URL either way.
 */
export function resolveBotChat(input: { mostRecent: string | null }) {
  return input.mostRecent === null
    ? ({ create: true } as const)
    : ({ open: input.mostRecent } as const);
}

/**
 * Whether the resolver effect below is clear to act, given what the roster query currently holds
 * and whether an earlier run already claimed this resolution.
 *
 * Pulled out and exported for the same reason `resolveBotChat` is: the defect this replaces —
 * `roster.isPending` reading `false` the moment a roster load exhausts its retries and moves to
 * `error`, with `data` still `undefined` — is a fact about a boolean expression, not about a
 * mounted component, and there is no render harness in this suite to drive that component through
 * a failed query. `data === undefined` is true for both "still loading" and "gave up and failed
 * after retrying"; only a roster that actually resolved — even to an empty array, which is the
 * ordinary shape of a first visit — is allowed through. `started` is `started.current` from the
 * effect's own ref, passed in rather than read, so this stays a plain function of its inputs.
 */
export function shouldResolveBotChat(input: {
  data: RosterItem[] | undefined;
  started: boolean;
}): boolean {
  return input.data !== undefined && !input.started;
}

function BotResolver({ agentId }: { agentId: string }) {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const createBotChat = useMutation(createBotChatMutationOptions(queryClient));
  /*
   * The same infinite query the sidebar already loaded, so this needs no endpoint of its own: the
   * roster is already in recency order, and "first bot_chat row for this Bot" is exactly
   * `mostRecent`.
   *
   * Read from "active", deliberately not "all": `?agent=` must never reopen a conversation somebody
   * archived. `BotChatStore.mostRecent` applies the identical active-only filter, but it is not a
   * second enforcement of this rule yet — no route calls it. It exists as the belt for a
   * server-side resolver that has not been written; this comment used to claim that resolver
   * existed, which was not true.
   */
  const roster = useInfiniteQuery(rosterListQueryOptions("active"));
  /*
   * Sees only whichever roster pages happen to be cached: nothing in this app calls `fetchNextPage`
   * on the roster query, so a Bot chat sitting past the first page is invisible here, exactly as if
   * it did not exist. That gap predates this screen and is app-wide — the sidebar has the same
   * limit and nobody pages it either. What is new is that acting on it here writes a durable row:
   * reading `null` for a chat that is merely un-cached creates a duplicate, the same failure a
   * failed roster load causes by a different route (see `shouldResolveBotChat` above). Not fixed
   * here — paging the roster from this resolver is a bigger change than this one.
   */
  const mostRecent =
    roster.data?.find(
      (row) => row.kind === "bot_chat" && row.agentIds.includes(agentId),
    )?.id ?? null;

  /*
   * Runs once per resolution, guarded by a ref rather than left to the dependency array: this
   * component is keyed on `agentId` in the parent, so the ref starts fresh whenever the Bot
   * changes, but StrictMode still mounts, cleans up, and mounts this effect again on the very
   * first render — and a re-run that was not guarded would create a second Bot chat nobody asked
   * for. `shouldResolveBotChat` gates the first run on `roster.data`, not `roster.isPending`: see
   * that function's own comment for why `isPending` alone would misread a failed roster load as
   * "nothing to open" and fork a duplicate `bot_chats` row.
   */
  const started = useRef(false);
  const createBotChatMutate = createBotChat.mutateAsync;
  useEffect(() => {
    if (!shouldResolveBotChat({ data: roster.data, started: started.current }))
      return;
    started.current = true;
    /*
     * Set once this run commits to acting, and read only in the `.then` below: if the person
     * navigates away — or this Bot changes, which remounts the whole resolver under a new `key` —
     * before the create or lookup settles, `navigate` must not fire into a screen nobody is looking
     * at any more. Same `let current = true` / cleanup pair `useBotThread` in `bot-thread.ts` uses,
     * for the same reason.
     */
    let current = true;
    /*
     * Annotated, rather than left to inference: TypeScript fills each branch of the ternary inside
     * `resolveBotChat` with the other branch's key typed `undefined`, so an inferred type here still
     * carries `open?: undefined` on the `create` branch. `"open" in resolution` then stops
     * discriminating anything — both branches "have" `open` — and `resolution.open` comes back
     * `string | undefined` even inside this guard. The explicit annotation is the clean type
     * `resolveBotChat` actually promises; it is not on the export itself because the plan's
     * signature for it is exact.
     */
    const resolution: { open: string } | { create: true } = resolveBotChat({
      mostRecent,
    });
    const botChatId =
      "open" in resolution
        ? Promise.resolve(resolution.open)
        : createBotChatMutate(agentId).then((created) => created.id);
    botChatId
      .then((id) => {
        if (!current) return;
        void navigate({ to: "/bot/$botChatId", params: { botChatId: id } });
      })
      .catch(() => {
        // Handled, not ignored: `mutateAsync` rejects on a refused create, and `started.current` is
        // already `true`, so nothing here retries. Left uncaught, this would be an unhandled
        // rejection on top of a resolver that then renders `null` forever with no explanation. There
        // is nothing further to do in the catch itself — `createBotChat.error` is the same state a
        // caught error would otherwise have to be threaded into by hand, and the render below reads
        // it directly, the same way `startNew` in `bot_.$botChatId.tsx` leaves its own throw for
        // `createBotChat.error` to say out loud.
      });
    return () => {
      current = false;
    };
  }, [agentId, createBotChatMutate, mostRecent, navigate, roster.data]);

  /*
   * A sentence instead of nothing when the roster failed to load or a create was refused, for the
   * same reason the unknown-Bot guard in `RouteComponent` above answers a bad `?agent=` in a
   * sentence rather than a crash: this app has no toast, so silence here would read as the app
   * ignoring what happened rather than as the app having tried. Checked ahead of the resolving
   * state below, not folded into `shouldResolveBotChat`: the effect asks "is it safe to act", this
   * asks "is there something to say instead of nothing", and a roster that is still failing
   * answers "no" to the first and "yes" to the second at the same time.
   */
  const failure = roster.error ?? createBotChat.error;
  if (failure) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">{failure.message}</p>
      </div>
    );
  }

  /*
   * Nothing to render while this resolves, for the same reason the screen this replaced rendered
   * nothing before it had a thread: putting the packaged chat on screen before a thread id exists
   * lets it mint one of its own, and that is the id this deployment would then be stuck with.
   */
  return null;
}
