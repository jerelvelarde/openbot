import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  adoptBotChatMutationOptions,
  createBotChatMutationOptions,
} from "@/lib/bot-chats/mutations";
import { attemptAdoption, remembered } from "@/lib/copilot/bot-thread";
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
  const agents = useQuery(agentListQueryOptions());

  /*
   * Gated on `data === undefined` rather than on `isPending`, which is the same conflation
   * `shouldResolveBotChat` below was written to avoid, in the one place on this screen that had kept
   * it. `isPending` reads `false` the moment a load exhausts its retries and moves to `error`, with
   * `data` still `undefined`, so a guard written on it alone answered a 500 or an offline browser
   * with "This deployment has no Bots yet." — a request that failed, reported as a settled fact
   * about the deployment, which is the one reading that leaves nothing to try. Nothing is said about
   * what the list holds until the list has resolved; a list that resolved and is genuinely empty is
   * the sentence below, and it means what it says.
   *
   * An error alongside data that did resolve — a background refetch that failed — deliberately does
   * not land here: there is a Bot to open, and this screen's job is to open it.
   */
  if (agents.data === undefined) {
    return agents.error ? <Notice>{agents.error.message}</Notice> : null;
  }

  const agentId = agent ?? agents.data[0]?.id;
  const known = agents.data.some((candidate) => candidate.id === agentId);

  if (!agentId || !known) {
    return (
      <Notice>
        {agent
          ? `This deployment has no Bot called "${agent}".`
          : "This deployment has no Bots yet."}
      </Notice>
    );
  }

  /*
   * Keyed on the Bot, so the hooks below never see it change under them. They cannot be called
   * conditionally, and the guards above return before any of them run. The key is also what makes
   * unmount the right thing for the resolver to cancel on: a different Bot is a different instance.
   */
  return <BotResolver agentId={agentId} key={agentId} />;
}

/**
 * The one shape for a sentence this screen says instead of a conversation.
 *
 * A Bot list that would not load, a deployment with no Bots, a named Bot that does not exist, a
 * create that was refused, a redirect that has not moved: different news, one way of delivering it,
 * written once rather than copied per branch. This app has no toast, so a sentence in the middle of
 * an otherwise empty screen is the entire vocabulary it has for "tried, and here is what happened" —
 * which is why the branches that reach for it matter more than its markup does.
 */
function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center p-6">
      <p className="text-muted-foreground text-sm">{children}</p>
    </div>
  );
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
 * The caller's most recently active Bot chat among the matching roster rows — by the same rule
 * `BotChatStore.mostRecent` (server/src/bot-chats/store.ts) uses server-side, not by roster order.
 *
 * Those are different things. The roster arrives pinned-first, then by recency
 * (`server/src/roster/order.ts`'s `RECENCY` expression) — a pinned bot chat from a month ago sorts
 * ahead of an unpinned one this person used five minutes ago. Taking the first matching row used to
 * be asserted, in a comment on the caller below, as "exactly `mostRecent`" — it was not:
 * `BotChatStore.mostRecent` orders on `coalesce(last_message_at, created_at)` alone, with no
 * pinned-first term at all, so the two silently disagreed on a pinned-but-stale bot chat. This picks
 * the maximum by `lastMessageAt ?? createdAt` among the matches instead of the first one, so the two
 * mean the same thing.
 *
 * Ties go to the greater `id`, because that is the tie-break the server applies — `mostRecent`
 * orders by recency and then by `id` descending — and not because first-seen or last-seen would be
 * defensible on its own. A tie is not exotic: `lastMessageAt` is null until somebody speaks in a
 * conversation, so `createdAt` decides, and two rows sharing a `createdAt` is ordinary for anything
 * seeded, imported, or created inside one transaction. Ids are `botchat_` followed by a v4 UUID —
 * one fixed length, lowercase hex, dashes in fixed positions — so comparing them as strings here
 * picks the row the server's `desc` picks.
 */
export function mostRecentBotChat(
  rows: RosterItem[],
  agentId: string,
): RosterItem | null {
  let best: RosterItem | null = null;
  for (const row of rows) {
    if (row.kind !== "bot_chat" || !row.agentIds.includes(agentId)) continue;
    if (best === null) {
      best = row;
      continue;
    }
    const recency = row.lastMessageAt ?? row.createdAt;
    const incumbent = best.lastMessageAt ?? best.createdAt;
    if (recency > incumbent || (recency === incumbent && row.id > best.id)) {
      best = row;
    }
  }
  return best;
}

/**
 * Whether the resolver must run the adoption sequence before it decides whether to create.
 *
 * Deliberately not "before it is allowed to create", which this used to say and which reads as a
 * promise this predicate cannot make: `attemptAdoption` answers an inconclusive check the same way it
 * answers "nothing to adopt", so a `true` here means the sequence runs, not that a create is off the
 * table. See `resolve` below, which is where that answer is acted on and where the residual case is
 * written down.
 *
 * This is the fix for the duplicate-conversation defect at the release boundary: a browser upgrading
 * into this feature has no `bot_chats` rows yet (`mostRecent` reads `null`), and — unfixed — the
 * resolver read that as "nothing to open," minted a fresh chat, and navigated, before the chat
 * screen's own adoption hook ever got a turn to claim the remembered thread. That is deterministic on
 * upgrade, not a race: nobody can deep-link `/bot/$botChatId` before a row exists, so the resolver
 * always won, and the person landed on the empty one while their real conversation sat unclaimed.
 *
 * `mostRecent !== null` means there is already something to open — the browser has been through this
 * before, or already adopted — so there is nothing for the resolver to gain by re-running the check
 * here; `useLegacyThreadAdoption` on the chat screen is the belt for a stray key left over from that.
 * Only "about to create, and something is remembered" is the case this function exists to catch.
 */
export function shouldAttemptAdoption(input: {
  mostRecent: string | null;
  remembered: string | null;
}): boolean {
  return input.mostRecent === null && input.remembered !== null;
}

/**
 * Whether the resolver effect below is clear to act, given what the roster query currently holds
 * and whether an earlier run already claimed this resolution.
 *
 * Pulled out and exported for the same reason `resolveBotChat` is: the defect this replaces —
 * `roster.isPending` reading `false` the moment a roster load exhausts its retries and moves to
 * `error`, with `data` still `undefined` — is a fact about a boolean expression, and stating it as
 * one says more, and keeps saying it, than the rendered case that also covers it now.
 * `data === undefined` is true for both "still loading" and "gave up and failed after retrying";
 * only a roster that actually resolved — even to an empty array, which is the ordinary shape of a
 * first visit — is allowed through. `started` is `started.current` from the effect's own ref, passed
 * in rather than read, so this stays a plain function of its inputs.
 */
export function shouldResolveBotChat(input: {
  data: RosterItem[] | undefined;
  started: boolean;
}): boolean {
  return input.data !== undefined && !input.started;
}

/**
 * What this screen shows while it resolves, and which of those answers wins when two are true.
 *
 * Three answers and a precedence, pulled out for the same reason the decisions above are: an
 * ordering that lives only in the order of two `if`s in a render body is a rule nothing can assert.
 * `opening` outranks `failed` deliberately. Once an id has been resolved the create worked, and a
 * roster refetch failing afterwards is not this screen's news — reporting it would replace the way
 * out of a redirect that has not moved with a sentence about something else, and would say the
 * conversation failed when it exists. `resolving` is last because it is the absence of the other
 * two rather than a state of its own.
 */
export function resolverView(input: {
  resolved: string | null;
  failure: Error | null;
}):
  | { kind: "opening"; botChatId: string }
  | { kind: "failed"; message: string }
  | { kind: "resolving" } {
  if (input.resolved !== null) {
    return { kind: "opening", botChatId: input.resolved };
  }
  if (input.failure) return { kind: "failed", message: input.failure.message };
  return { kind: "resolving" };
}

function BotResolver({ agentId }: { agentId: string }) {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const createBotChat = useMutation(createBotChatMutationOptions(queryClient));
  const adoptBotChat = useMutation(adoptBotChatMutationOptions(queryClient));
  /*
   * The same infinite query the sidebar already loaded, so this needs no endpoint of its own — but
   * unlike the sidebar, "which row is most recent" cannot be read off list order. The roster arrives
   * pinned-first, then by recency (`server/src/roster/order.ts`'s `RECENCY` expression): a pinned
   * older bot chat sorts ahead of an unpinned one used five minutes ago. Taking the first matching
   * row used to be asserted here as "exactly `mostRecent`" — it is not; `BotChatStore.mostRecent`
   * (server/src/bot-chats/store.ts) orders on recency alone, with no pinned-first term at all. See
   * `mostRecentBotChat` above for the fix and why the two now agree.
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
  const mostRecent = mostRecentBotChat(roster.data ?? [], agentId)?.id ?? null;
  /*
   * Read synchronously, alongside `mostRecent`, so `shouldAttemptAdoption` below can be a plain
   * function of two values rather than something that reaches into storage on its own. See
   * `remembered`'s own comment in `bot-thread.ts` for why it is exported for exactly this.
   */
  const legacyThreadId = remembered(agentId);

  /*
   * Whether this component is still on screen — and the only thing an in-flight resolution is
   * allowed to cancel on.
   *
   * A ref cleared by its own mount-only effect rather than a `let` declared inside the resolver
   * effect below, and that difference is the whole of the fix for the defect this replaces. A `let`
   * per effect run is cleared by that run's cleanup, and an effect's cleanup fires on any dependency
   * change, not only on unmount. Three of those changes are routine here: `roster.data` moving from
   * `undefined` to defined is the one the resolver exists to wake up for and so cannot leave the
   * dependency array; the resolver's own successful create invalidates `rosterKeys.all`, which React
   * Query awaits inside `onSuccess` and which lands back on `roster.data`; and StrictMode cleans up
   * and re-runs every effect once on first mount in development. Any of the three, arriving while
   * `resolve()` was still in flight, cleared the old flag — while the `started` latch below stopped
   * the re-run from arming a new one — so the `.then` skipped the redirect and nothing ever retried.
   * A `bot_chats` row was written and the person was left looking at a blank screen with no error to
   * explain it, precisely because the create had succeeded.
   *
   * `[]` deps mean this cleanup runs on unmount — and, in development, once more on the first mount,
   * where StrictMode's cleanup and re-setup are a single synchronous pass that nothing awaited can
   * observe a gap in.
   *
   * Unmount is also the honest boundary for `attemptAdoption`'s `isCurrent`, which is handed this
   * same ref below: the thing that must not happen there is `forget()` clearing the remembered
   * thread on behalf of a screen nobody is looking at any more. A dependency change is not that, and
   * a different Bot is a different component instance — `RouteComponent` keys this on `agentId` —
   * which unmounts this one and cancels it correctly.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /*
   * One create per mounted Bot, and that is now this latch's only job. It used to hold two — "do not
   * create twice" and "do not navigate twice" — and the second is what made the cancellation above
   * unrecoverable, because a re-run that returned early on this flag left nothing behind to navigate
   * with. `shouldResolveBotChat` gates the first run on `roster.data` rather than `roster.isPending`:
   * see that function's own comment for why `isPending` alone would misread a failed roster load as
   * "nothing to open" and fork a duplicate `bot_chats` row.
   */
  const started = useRef(false);
  /*
   * Where a finished resolution is put, rather than being navigated on directly from inside the
   * `.then`.
   *
   * State, for two reasons that are really one. It makes the redirect an effect over a value rather
   * than a callback inside a settled promise: React re-runs an effect or leaves it alone according to
   * its dependencies, and neither of those drops it, which is exactly what the `.then` could be made
   * to do. And it lets the render below say, in a sentence with a link in it, that a conversation was
   * resolved and this screen is still here — the state that used to render as nothing at all.
   */
  const [resolved, setResolved] = useState<string | null>(null);
  const createBotChatMutate = createBotChat.mutateAsync;
  const adoptBotChatMutate = adoptBotChat.mutateAsync;
  useEffect(() => {
    if (!shouldResolveBotChat({ data: roster.data, started: started.current }))
      return;
    started.current = true;
    async function resolve(): Promise<string | null> {
      /*
       * Adoption first, and fully awaited before any create decision is made — this is the fix for
       * the duplicate-conversation defect `shouldAttemptAdoption` documents: a browser upgrading
       * into this feature has no `bot_chats` rows yet, so without this, `mostRecent` reading `null`
       * would go straight to create below, and the remembered thread would only ever be rescued
       * *after* landing on the wrong, empty conversation — by which point there are two rows and no
       * way to tell the person had one already. Skipped whenever `mostRecent` is not `null`: a row
       * already exists, so there is nothing to gain from checking, and `useLegacyThreadAdoption` on
       * the chat screen is the belt for a stray key an earlier, incomplete adoption left behind.
       *
       * ONLY A PROVEN ADOPTION DIVERTS THIS, so the two-rows outcome is narrowed here rather than
       * closed, and the difference is worth being exact about. `attemptAdoption` reports
       * `{ adopted: null }` for an inconclusive check as well — a 500 from the thread reader, an
       * offline blink — and deliberately keeps the remembered key, so this falls through and
       * creates, and the belt hook rescues the thread into a second row from the chat screen on this
       * visit or a later one. Chosen rather than overlooked, and the two orderings are not equally
       * bad — both rows are minted with `created_at` defaulting to now and neither has a
       * `last_message_at` yet, so whichever is written second is the one `mostRecentBotChat` picks.
       * Adoption first and create second leaves the *empty* row newer, which is the defect below;
       * create first and adoption second leaves the *rescued* row newer, so the next visit resolves
       * to the transcript and what is left over is one empty conversation the person can see and
       * archive. Refusing to open anything because an existence check for a thread that may not even
       * exist any more came back inconclusive is the larger harm.
       */
      if (shouldAttemptAdoption({ mostRecent, remembered: legacyThreadId })) {
        /*
         * `isCurrent` is the mount ref, not a per-run flag: `attemptAdoption` checks it before it
         * adopts and again before it forgets, and what those checks are protecting against is
         * committing either on behalf of a screen that is gone. See the ref's own comment above for
         * why a dependency change is not that, and why treating it as one is what stranded the
         * redirect.
         */
        const attempt = await attemptAdoption(
          agentId,
          adoptBotChatMutate,
          () => mounted.current,
        );
        if (attempt.adopted !== null) return attempt.adopted;
      }
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
      if ("open" in resolution) return resolution.open;
      /*
       * The last look at `mounted` before this function writes anything durable, and the fix for the
       * second way this resolver forked a duplicate row.
       *
       * `attemptAdoption` reports an unmount as `{ adopted: null }`, which is the same thing it says
       * for "nothing to adopt" — so an adopt that succeeded and came back after this screen was gone
       * fell through to here, `mostRecent` still `null` (it is the value this effect run closed
       * over, and the adopted row cannot have reached it), and a second, empty conversation was
       * written for nobody. Two durable rows for one conversation, the empty one newer, so
       * `mostRecentBotChat` resolves to the empty one — and nothing here revisits that, because
       * `mostRecent` is no longer `null` and adoption is never attempted again. The rescued
       * transcript sits below it in the roster for the person to find by hand: the same
       * duplicate-conversation defect `shouldAttemptAdoption` exists to prevent, re-entered through
       * the stale path.
       *
       * Here rather than inside `attemptAdoption`, because this is the one statement in this function
       * that writes a row: guarding it covers every await ahead of it — a check that answered late,
       * an adopt that succeeded late, a 409 that arrived late — instead of only the one of the three
       * that was reproduced. See the mount ref's own comment above for why `mounted.current` is false
       * only after a real unmount, and so cannot fire on a dependency change and strand a resolution
       * the way a per-run flag did.
       *
       * `null` rather than a throw: nothing failed, and the `.catch` below is the create's error
       * path. An unmounted component renders nothing and runs no effects, so there is no frame in
       * which this answer is on screen — `resolved` simply stays as it was.
       */
      if (!mounted.current) return null;
      const created = await createBotChatMutate(agentId);
      return created.id;
    }
    resolve()
      .then((id) => {
        if (id === null || !mounted.current) return;
        setResolved(id);
      })
      .catch(() => {
        // Handled, not ignored: `mutateAsync` rejects on a refused create, and `started.current` is
        // already `true`, so nothing here retries. Left uncaught it would be an unhandled rejection,
        // and empty it stays, because there is nothing for the body to do that is not already done —
        // `createBotChat.error` is the same state a caught error would otherwise have to be threaded
        // into by hand, and the render below reads it directly, the same way `startNew` in
        // `bot_.$botChatId.tsx` leaves its own throw for
        // `createBotChat.error` to say out loud. `attemptAdoption` never rejects — every failure
        // inside it is caught and folded into `{ adopted: null }`, so a caught rejection here still
        // only ever comes from the create branch, exactly as before this function had adoption in
        // front of it.
      });
    /*
     * No cleanup, deliberately, and this effect has nothing left that a cleanup could safely do: the
     * only cancellation this resolution honours is unmount, which the mount-only effect above owns.
     * A cleanup here would fire on every dependency change and put the defect back.
     */
  }, [
    agentId,
    adoptBotChatMutate,
    createBotChatMutate,
    legacyThreadId,
    mostRecent,
    roster.data,
  ]);

  /*
   * The redirect, as an effect on the resolved id rather than a call from inside the `.then` above.
   *
   * Nothing about the resolution can take it away: `resolved` is state, `navigate` from
   * `useNavigate` is stable across renders, and an unmounted component runs no effects at all — so
   * this fires once per resolution, and only for a screen that is still on screen.
   *
   * `replace`, not a push, and that is a Back-button fix rather than a preference. `/bot` renders no
   * conversation of its own; it resolves and redirects. A pushed entry therefore made Back a trap:
   * back to `/bot`, which resolves and redirects forwards again, leaving no way past it to wherever
   * the person actually came from.
   */
  useEffect(() => {
    if (resolved === null) return;
    void navigate({
      to: "/bot/$botChatId",
      params: { botChatId: resolved },
      replace: true,
    });
  }, [navigate, resolved]);

  /*
   * A sentence instead of nothing when the roster failed to load or a create was refused, for the
   * same reason the unknown-Bot guard in `RouteComponent` above answers a bad `?agent=` in a
   * sentence rather than a crash: this app has no toast, so silence here would read as the app
   * ignoring what happened rather than as the app having tried. Not folded into
   * `shouldResolveBotChat`: the effect asks "is it safe to act", this asks "is there something to
   * say instead of nothing", and a roster that is still failing answers "no" to the first and "yes"
   * to the second at the same time.
   *
   * `adoptBotChat.error` is deliberately not in this list. A failed adoption is not this screen's
   * failure to report: `resolve` above already falls through to opening or creating when
   * `attemptAdoption` comes back empty, so the person still lands somewhere usable, and the
   * remembered key survives for `useLegacyThreadAdoption` to retry from the chat screen. Reporting
   * it here would turn a quiet, retryable fallback into a blocking error sentence for a problem that
   * already has a recovery path.
   */
  const view = resolverView({
    resolved,
    failure: roster.error ?? createBotChat.error,
  });

  /*
   * Resolved, and still here. On the ordinary path this is one frame between the redirect being
   * asked for and the router arriving, which is why it reads as an opening rather than as an alarm.
   * It exists for the path that is not ordinary: a conversation that was resolved — or created — and
   * a redirect that did not happen used to render as `null`, indistinguishable from still loading and
   * from a screen that had given up, with no error to read because nothing had failed. The link is
   * the way out of that by hand, and it carries the same `replace` for the same reason the effect
   * above does.
   */
  if (view.kind === "opening") {
    return (
      <Notice>
        Opening this conversation.{" "}
        <Link
          className="underline"
          params={{ botChatId: view.botChatId }}
          replace
          to="/bot/$botChatId"
        >
          Open it now
        </Link>{" "}
        if this screen stays where it is.
      </Notice>
    );
  }

  if (view.kind === "failed") return <Notice>{view.message}</Notice>;

  /*
   * Nothing to render while this resolves, for the same reason the screen this replaced rendered
   * nothing before it had a thread: putting the packaged chat on screen before a thread id exists
   * lets it mint one of its own, and that is the id this deployment would then be stuck with.
   */
  return null;
}
