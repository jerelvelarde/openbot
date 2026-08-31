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
import { rosterListQueryOptions } from "@/lib/roster/queries";

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
   * archived. The store's own `mostRecent` — consulted server-side wherever a fresh visit to a Bot
   * has to pick a thread — applies the identical active-only filter. Both are stated because either
   * alone is a rule somebody could quietly remove without the other one catching it.
   */
  const roster = useInfiniteQuery(rosterListQueryOptions("active"));
  const mostRecent =
    roster.data?.find(
      (row) => row.kind === "bot_chat" && row.agentIds.includes(agentId),
    )?.id ?? null;

  /*
   * Runs once per resolution, guarded by a ref rather than left to the dependency array: this
   * component is keyed on `agentId` in the parent, so the ref starts fresh whenever the Bot
   * changes, but StrictMode still mounts, cleans up, and mounts this effect again on the very
   * first render — and a re-run that was not guarded would create a second Bot chat nobody asked
   * for. `roster.isPending` gates the first run so a still-loading roster is never misread as
   * "nothing to open".
   */
  const started = useRef(false);
  const createBotChatMutate = createBotChat.mutateAsync;
  useEffect(() => {
    if (roster.isPending || started.current) return;
    started.current = true;
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
    void botChatId.then((id) =>
      navigate({ to: "/bot/$botChatId", params: { botChatId: id } }),
    );
  }, [agentId, createBotChatMutate, mostRecent, navigate, roster.isPending]);

  /*
   * Nothing to render while this resolves, for the same reason the screen this replaced rendered
   * nothing before it had a thread: putting the packaged chat on screen before a thread id exists
   * lets it mint one of its own, and that is the id this deployment would then be stuck with.
   */
  return null;
}
