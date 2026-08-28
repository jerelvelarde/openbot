# Slack Sidebar Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authorized Slack-origin conversations discoverable in OpenBot's existing sidebar with a title-line Slack chip and a link to the existing read-only transcript.

**Architecture:** Add a bounded creator-scoped list operation to the existing external-thread store and expose it through the authenticated external-links routes. Fetch that list independently in the app, convert native and Slack summaries into a discriminated roster model, and render one stable activity-sorted sidebar without changing Slack delivery or native channel behavior.

**Tech Stack:** TypeScript, Bun test, Hono, Drizzle ORM/PostgreSQL, React 19, TanStack Query, TanStack Router, Testing Library, Tailwind CSS.

---

## File structure

- Modify `server/src/external/thread-store.ts` — define and query paginated external-thread summaries.
- Modify `server/tests/external-thread-store.integration.test.ts` — prove ownership, preview, ordering, and cursor behavior against PostgreSQL.
- Modify `server/src/external/routes.ts` — expose the authenticated, fail-closed list endpoint.
- Modify `server/tests/external-link-routes.test.ts` — prove authentication, authorization filtering, safe output, and validation.
- Modify `app/src/lib/external/queries.ts` — validate and fetch external-thread pages.
- Create `app/src/components/app-sidebar/roster.ts` — own the discriminated roster type, merge order, search, keys, and destinations.
- Modify `app/tests/external-thread-route.test.ts` — reject malformed external-thread list responses.
- Create `app/tests/sidebar-roster.test.ts` — test roster behavior without router or network fixtures.
- Create `app/src/components/app-sidebar/slack-channel.tsx` — render a read-only Slack row and its chip.
- Create `app/tests/slack-sidebar-row.test.tsx` — test the row's visible contract and retry error component.
- Modify `app/src/components/app-sidebar/app-sidebar.tsx` — query, merge, animate, and render both sources.

### Task 1: External-thread summary store

**Files:**
- Modify: `server/src/external/thread-store.ts`
- Test: `server/tests/external-thread-store.integration.test.ts`

- [ ] **Step 1: Write failing ownership and activity tests**

Add integration tests that create two bindings for the main creator, one for the other creator, and timestamped transcript messages. Assert that the first creator sees only their rows, with the newest message selected and flattened to a bounded one-line preview:

```ts
test("lists only the creator's Slack threads with latest activity first", async () => {
  const older = binding("list_older");
  const newer = binding("list_newer");
  const foreign = binding("list_foreign", {
    createdByUserId: otherCreatorId,
  });
  await store.bind(older);
  await store.bind(newer);
  await store.bind(foreign);
  await database.insert(externalThreadMessages).values([
    {
      channelsThreadId: older.channelsThreadId,
      messageId: "older-user",
      role: "user",
      content: "old line",
      createdAt: new Date("2099-08-28T10:00:00.000Z"),
    },
    {
      channelsThreadId: newer.channelsThreadId,
      messageId: "newer-user",
      role: "user",
      content: "newest\nline",
      createdAt: new Date("2099-08-28T11:00:00.000Z"),
    },
    {
      channelsThreadId: foreign.channelsThreadId,
      messageId: "foreign-user",
      role: "user",
      content: "must stay private",
      createdAt: new Date("2099-08-28T12:00:00.000Z"),
    },
  ]);

  const page = await store.listForCreator(creatorId, { limit: 20 });

  const listed = page.threads.filter((thread) =>
    [older.channelsThreadId, newer.channelsThreadId].includes(thread.threadId),
  );
  expect(listed.map((thread) => thread.threadId)).toEqual([
    newer.channelsThreadId,
    older.channelsThreadId,
  ]);
  expect(listed[0]?.lastMessage).toBe("newest line");
  expect(page.threads.some((thread) => thread.threadId === foreign.channelsThreadId)).toBe(false);
});
```

Add a second test with three creator-owned rows, `limit: 2`, and explicit message times in 2099 so unrelated fixture bindings cannot outrank them. Assert page one has two rows, `nextCursor` is non-null, page two contains only the third row, and the two pages have no duplicate IDs. Call the first page once more with `cursor: "malformed"` and assert it returns the same IDs as the cursor-free first page.

- [ ] **Step 2: Run the store test and verify RED**

Run:

```bash
bun test server/tests/external-thread-store.integration.test.ts
```

Expected: TypeScript/runtime failure because `ExternalThreadStore.listForCreator` does not exist.

- [ ] **Step 3: Add the summary types, cursor, preview, and query**

In `server/src/external/thread-store.ts`, add `desc` and `sql` to the existing Drizzle imports and define the public safe model:

```ts
export type ExternalThreadSummary = {
  threadId: string;
  provider: "slack";
  agentId: string;
  agentName: string;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
};

export type ExternalThreadPage = {
  threads: ExternalThreadSummary[];
  nextCursor: string | null;
};

export type ExternalThreadListQuery = {
  cursor?: string;
  limit?: number;
};
```

Extend `ExternalThreadStore` with:

```ts
listForCreator: (
  creatorId: string,
  query?: ExternalThreadListQuery,
) => Promise<ExternalThreadPage>;
```

Use constants matching the native roster's bounded posture:

```ts
const DEFAULT_EXTERNAL_THREAD_PAGE = 50;
const MAX_EXTERNAL_THREAD_PAGE = 200;
const MAX_PREVIEW_CODE_POINTS = 200;

const latestMessageAt = sql<Date | null>`(
  select ${externalThreadMessages.createdAt}
  from ${externalThreadMessages}
  where ${externalThreadMessages.channelsThreadId} = ${externalThreadBindings.channelsThreadId}
  order by ${externalThreadMessages.sequence} desc
  limit 1
)`;
const latestMessageContent = sql<string | null>`(
  select ${externalThreadMessages.content}
  from ${externalThreadMessages}
  where ${externalThreadMessages.channelsThreadId} = ${externalThreadBindings.channelsThreadId}
  order by ${externalThreadMessages.sequence} desc
  limit 1
)`;
const externalRecency = sql<Date>`coalesce(${latestMessageAt}, ${externalThreadBindings.createdAt})`;
```

Implement base64url cursor encode/decode over `{ recency, threadId }`. Treat an absent or malformed cursor as the first page, matching native channels. Implement `previewOf` by replacing control characters with spaces, collapsing whitespace, and truncating by Unicode code point to 200 characters with a final ellipsis.

Implement `listForCreator` as one creator-filtered query ordered by `externalRecency desc, channelsThreadId desc`, fetching `limit + 1`. Select only `threadId`, constant provider, agent ID/current joined name, latest content/time, and binding creation time. Return `nextCursor` from the last included row and map content through `previewOf`.

Use this implementation shape inside `createExternalThreadStore`:

```ts
async function listForCreator(
  creatorId: string,
  query: ExternalThreadListQuery = {},
): Promise<ExternalThreadPage> {
  const limit = Math.min(
    Math.max(query.limit ?? DEFAULT_EXTERNAL_THREAD_PAGE, 1),
    MAX_EXTERNAL_THREAD_PAGE,
  );
  const cursor = decodeExternalThreadCursor(query.cursor);
  const rows = await database
    .select({
      threadId: externalThreadBindings.channelsThreadId,
      agentId: externalThreadBindings.agentId,
      agentName: agents.name,
      lastMessage: latestMessageContent,
      lastMessageAt: latestMessageAt,
      createdAt: externalThreadBindings.createdAt,
      recency: externalRecency,
    })
    .from(externalThreadBindings)
    .innerJoin(agents, eq(externalThreadBindings.agentId, agents.id))
    .where(
      and(
        eq(externalThreadBindings.createdByUserId, creatorId),
        cursor
          ? sql`(${externalRecency}, ${externalThreadBindings.channelsThreadId}) < (${cursor.recency}::timestamptz, ${cursor.threadId})`
          : undefined,
      ),
    )
    .orderBy(
      sql`${externalRecency} desc`,
      desc(externalThreadBindings.channelsThreadId),
    )
    .limit(limit + 1);
  const wanted = rows.slice(0, limit);
  const last = wanted.at(-1);
  return {
    threads: wanted.map((row) => ({
      threadId: row.threadId,
      provider: "slack" as const,
      agentId: row.agentId,
      agentName: row.agentName,
      lastMessage: row.lastMessage === null ? null : previewOf(row.lastMessage),
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeExternalThreadCursor({
            recency: new Date(last.recency).toISOString(),
            threadId: last.threadId,
          })
        : null,
  };
}
```

Return `listForCreator` from the store object beside the existing methods.

- [ ] **Step 4: Run the store test and verify GREEN**

Run:

```bash
bun test server/tests/external-thread-store.integration.test.ts
```

Expected: all external-thread integration tests pass, including ownership and cursor tests.

- [ ] **Step 5: Commit the store slice**

```bash
git add server/src/external/thread-store.ts server/tests/external-thread-store.integration.test.ts
git commit -m "feat: list Slack transcript summaries"
```

### Task 2: Authenticated external-thread list route

**Files:**
- Modify: `server/src/external/routes.ts`
- Test: `server/tests/external-link-routes.test.ts`

- [ ] **Step 1: Extend the fake store and write failing route tests**

Add `listForCreator` to `fakeThreadStore`:

```ts
listForCreator: async (creatorId) => ({
  threads:
    creatorId === actor.id && found
      ? [
          {
            threadId: found.channelsThreadId,
            provider: "slack" as const,
            agentId: found.agentId,
            agentName: found.agentName,
            lastMessage: "Latest reply",
            lastMessageAt: new Date(NOW + 1_000),
            createdAt: found.createdAt,
          },
        ]
      : [],
  nextCursor: null,
}),
```

Add tests for `GET /api/external-links/threads`:

```ts
test("GET lists only safe authorized Slack transcript summaries", async () => {
  const { app } = appFor();
  const response = await app.request(
    "http://openbot.test/api/external-links/threads?limit=25",
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    threads: [
      {
        threadId: "channels-thread-1",
        provider: "slack",
        agentId: "risk",
        agentName: "Risk Analyst",
        lastMessage: "Latest reply",
        lastMessageAt: new Date(NOW + 1_000).toISOString(),
        createdAt: new Date(NOW).toISOString(),
        readOnly: true,
      },
    ],
    nextCursor: null,
  });
});
```

Also assert:

- the unauthenticated middleware returns 401;
- a summary whose agent is rejected by `agentProfileStore.get` is omitted;
- `?limit=0`, `?limit=abc`, and `?limit=201` return 400;
- the store receives `actor.id`, the validated limit, and the opaque cursor; and
- response JSON contains none of `providerTenantId`, `providerConversationId`, `providerThreadId`, or `createdByUserId`.

- [ ] **Step 2: Run the route test and verify RED**

Run:

```bash
bun test server/tests/external-link-routes.test.ts
```

Expected: request to `/threads` returns 404 because the list handler does not exist.

- [ ] **Step 3: Implement strict list input parsing and authorization**

In `server/src/external/routes.ts`, add a parser that distinguishes absence from invalid input:

```ts
function externalThreadLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("invalid external thread limit");
  const parsed = Number(value);
  if (parsed < 1 || parsed > 200) {
    throw new Error("invalid external thread limit");
  }
  return parsed;
}
```

Register `routes.get("/threads", requireUser, handler)` before the parameterized thread route. The handler must:

1. set `Cache-Control: no-store`;
2. return `{ error: "Invalid conversation page." }` with 400 for an invalid limit;
3. call `threadStore.listForCreator(actor.id, { cursor, limit })`;
4. call `agentProfileStore.get({ id: actor.id, role: actor.role }, thread.agentId)` for every returned row;
5. omit rows that fail the current access check and replace the stored name with `profile.name`; and
6. serialize dates and add `readOnly: true`.

Use `Promise.all` for independent access checks, preserving store order after filtering. Do not return any provider identity fields.

The handler body is:

```ts
routes.get("/threads", requireUser, async (context) => {
  context.header("Cache-Control", "no-store");
  let limit: number | undefined;
  try {
    limit = externalThreadLimit(context.req.query("limit"));
  } catch {
    return context.json({ error: "Invalid conversation page." }, 400);
  }
  const actor = context.var.actor;
  const page = await threadStore.listForCreator(actor.id, {
    cursor: context.req.query("cursor"),
    limit,
  });
  const checked = await Promise.all(
    page.threads.map(async (thread) => {
      const profile = await agentProfileStore.get(
        { id: actor.id, role: actor.role },
        thread.agentId,
      );
      return profile
        ? {
            threadId: thread.threadId,
            provider: thread.provider,
            agentId: profile.id,
            agentName: profile.name,
            lastMessage: thread.lastMessage,
            lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
            createdAt: thread.createdAt.toISOString(),
            readOnly: true as const,
          }
        : null;
    }),
  );
  return context.json({
    threads: checked.filter((thread) => thread !== null),
    nextCursor: page.nextCursor,
  });
});
```

- [ ] **Step 4: Run route tests and verify GREEN**

Run:

```bash
bun test server/tests/external-link-routes.test.ts
```

Expected: all external-link route tests pass.

- [ ] **Step 5: Commit the route slice**

```bash
git add server/src/external/routes.ts server/tests/external-link-routes.test.ts
git commit -m "feat: expose authorized Slack conversations"
```

### Task 3: Client query and unified roster model

**Files:**
- Modify: `app/src/lib/external/queries.ts`
- Create: `app/src/components/app-sidebar/roster.ts`
- Modify: `app/tests/external-thread-route.test.ts`
- Create: `app/tests/sidebar-roster.test.ts`

- [ ] **Step 1: Write failing roster tests**

Create `app/tests/sidebar-roster.test.ts` with fully typed builders for one `ChannelSummary` and one `ExternalThreadSummary`. Assert the desired order and search contract:

```ts
test("keeps pinned native channels first and interleaves the rest by activity", () => {
  const rows = conversationRoster(
    [
      channel("native-new", "2026-08-28T12:00:00.000Z", false),
      channel("native-pinned", "2026-08-28T09:00:00.000Z", true),
    ],
    [slack("slack-middle", "2026-08-28T11:00:00.000Z")],
  );

  expect(rows.map(rosterKey)).toEqual([
    "openbot:native-pinned",
    "openbot:native-new",
    "slack:slack-middle",
  ]);
});

test("searches Slack agent names and previews", () => {
  const rows = conversationRoster([], [
    slack("thread-1", "2026-08-28T11:00:00.000Z", {
      agentName: "Risk Analyst",
      lastMessage: "Reviewed the vendor controls",
    }),
  ]);

  expect(matchingRoster(rows, "vendor").map(rosterKey)).toEqual([
    "slack:thread-1",
  ]);
  expect(matchingRoster(rows, "risk").map(rosterKey)).toEqual([
    "slack:thread-1",
  ]);
});

test("sends Slack rows to the canonical transcript route", () => {
  expect(rosterDestination({ source: "slack", thread: slack("thread/1", null) })).toEqual({
    to: "/slack/thread/$threadId",
    params: { threadId: "thread/1" },
  });
});

test("does not declare the roster empty until both sources loaded", () => {
  expect(shouldShowEmptyRoster([], [], true, false)).toBe(false);
  expect(shouldShowEmptyRoster([], [], true, true)).toBe(true);
  expect(shouldShowEmptyRoster([channel("native", null, false)], [], true, true)).toBe(false);
});
```

Add a deterministic tie test and an empty-query identity test so clearing search does not restage the animated list.

In `app/tests/external-thread-route.test.ts`, add one valid page assertion and table-driven invalid cases for a missing `threads` array, a non-Slack provider, `readOnly: false`, an invalid ISO timestamp, and a non-string cursor. Each invalid value must make `externalThreadPage(value)` throw `Could not load Slack conversations.`.

- [ ] **Step 2: Run the app test and verify RED**

Run:

```bash
bun test app/tests/sidebar-roster.test.ts
```

Expected: module-not-found failure for `app/src/components/app-sidebar/roster.ts`.

- [ ] **Step 3: Add validated query types and the pure roster module**

In `app/src/lib/external/queries.ts`, define:

```ts
export type ExternalThreadSummary = ExternalThreadTarget & {
  lastMessage: string | null;
  lastMessageAt: string | null;
  createdAt: string;
};

export type ExternalThreadPage = {
  threads: ExternalThreadSummary[];
  nextCursor: string | null;
};

export const externalThreadKeys = {
  all: ["external-threads"] as const,
  list: () => ["external-threads", "list"] as const,
  detail: (threadId: string) => ["external-threads", threadId] as const,
};
```

Add `externalThreadSummary` and `externalThreadPage` validators that reject missing IDs, invalid dates, non-Slack providers, non-boolean `readOnly`, and non-array pages. Change the detail query to use `externalThreadKeys.detail(threadId)`. Add `externalThreadListQueryOptions()` using `infiniteQueryOptions`, `/api/external-links/threads`, the opaque cursor, and a flattened `select` matching the native channel query.

Use explicit runtime validation rather than casting server JSON:

```ts
function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function externalThreadPage(value: unknown): ExternalThreadPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Could not load Slack conversations.");
  }
  const page = value as { threads?: unknown; nextCursor?: unknown };
  if (
    !Array.isArray(page.threads) ||
    (page.nextCursor !== null && typeof page.nextCursor !== "string")
  ) {
    throw new Error("Could not load Slack conversations.");
  }
  return {
    threads: page.threads.map((entry) => {
      let target: ExternalThreadTarget;
      try {
        target = externalThreadTarget(entry);
      } catch {
        throw new Error("Could not load Slack conversations.");
      }
      const summary = entry as {
        lastMessage?: unknown;
        lastMessageAt?: unknown;
        createdAt?: unknown;
      };
      if (
        (summary.lastMessage !== null && typeof summary.lastMessage !== "string") ||
        (summary.lastMessageAt !== null && !isoTimestamp(summary.lastMessageAt)) ||
        !isoTimestamp(summary.createdAt)
      ) {
        throw new Error("Could not load Slack conversations.");
      }
      return {
        ...target,
        lastMessage: summary.lastMessage,
        lastMessageAt: summary.lastMessageAt,
        createdAt: summary.createdAt,
      } as ExternalThreadSummary;
    }),
    nextCursor: page.nextCursor,
  };
}

export function externalThreadListQueryOptions() {
  return infiniteQueryOptions({
    queryKey: externalThreadKeys.list(),
    initialPageParam: "",
    queryFn: async ({ pageParam }): Promise<ExternalThreadPage> => {
      const suffix = pageParam
        ? `?cursor=${encodeURIComponent(pageParam as string)}`
        : "";
      const response = await client(`/api/external-links/threads${suffix}`, {
        fallback: "Could not load Slack conversations",
      });
      return externalThreadPage(await response.json());
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    select: (data): ExternalThreadSummary[] =>
      data.pages.flatMap((page) => page.threads),
  });
}
```

Create `app/src/components/app-sidebar/roster.ts`:

```ts
export type SidebarRosterRow =
  | { source: "openbot"; channel: ChannelSummary }
  | { source: "slack"; thread: ExternalThreadSummary };

export function rosterKey(row: SidebarRosterRow): string {
  return row.source === "openbot"
    ? `openbot:${row.channel.id}`
    : `slack:${row.thread.threadId}`;
}

export function conversationRoster(
  channels: ChannelSummary[],
  threads: ExternalThreadSummary[],
): SidebarRosterRow[] {
  const rows: SidebarRosterRow[] = [
    ...channels.map((channel) => ({ source: "openbot" as const, channel })),
    ...threads.map((thread) => ({ source: "slack" as const, thread })),
  ];
  return rows.sort((left, right) => {
    const leftPinned = left.source === "openbot" && left.channel.pinned;
    const rightPinned = right.source === "openbot" && right.channel.pinned;
    const pinOrder = Number(rightPinned) - Number(leftPinned);
    if (pinOrder !== 0) return pinOrder;
    const leftAt = activityAt(left);
    const rightAt = activityAt(right);
    return rightAt.localeCompare(leftAt) || rosterKey(right).localeCompare(rosterKey(left));
  });
}
```

Implement `activityAt`, `matchingRoster`, `rosterName`, `rosterLastMessage`, and `rosterDestination` as exhaustive source branches. An empty search query returns the input array unchanged. Add `shouldShowEmptyRoster(channels, threads, channelsLoaded, slackLoaded)`, which returns true only when both loaded flags are true and both arrays are empty.

The empty-state helper is deliberately independent of React Query:

```ts
export function shouldShowEmptyRoster(
  channels: ChannelSummary[],
  threads: ExternalThreadSummary[],
  channelsLoaded: boolean,
  slackLoaded: boolean,
): boolean {
  return channelsLoaded && slackLoaded && channels.length === 0 && threads.length === 0;
}
```

- [ ] **Step 4: Run roster tests and verify GREEN**

Run:

```bash
bun test app/tests/external-thread-route.test.ts app/tests/sidebar-roster.test.ts
```

Expected: all roster ordering, search, and destination tests pass.

- [ ] **Step 5: Commit the client-model slice**

```bash
git add app/src/lib/external/queries.ts app/src/components/app-sidebar/roster.ts app/tests/external-thread-route.test.ts app/tests/sidebar-roster.test.ts
git commit -m "feat: model mixed conversation roster"
```

### Task 4: Slack sidebar row and app-sidebar integration

**Files:**
- Create: `app/src/components/app-sidebar/slack-channel.tsx`
- Modify: `app/src/components/app-sidebar/app-sidebar.tsx`
- Create: `app/tests/slack-sidebar-row.test.tsx`

- [ ] **Step 1: Write failing component tests**

Export presentation-only children so the visual and failure contract can be tested without constructing a router:

```ts
test("Slack row content keeps the chip beside the agent name", () => {
  const view = render(
    <SlackChannelContent
      agentId="risk"
      agentName="Risk Analyst"
      lastMessage="Latest reply"
      lastMessageAt="now"
    />,
  );

  expect(view.getByText("Risk Analyst")).toBeTruthy();
  const chip = view.getByText("Slack");
  expect(chip.closest('[data-slot="conversation-title"]')?.textContent).toContain(
    "Risk AnalystSlack",
  );
  expect(view.getByText("Latest reply")).toBeTruthy();
  expect(view.queryByText("Pin channel")).toBeNull();
  expect(view.queryByText("Delete channel…")).toBeNull();
});

test("Slack list failure is explicit and retryable", () => {
  let retries = 0;
  const view = render(<SlackRosterProblem retry={() => retries++} />);
  expect(view.getByRole("alert").textContent).toContain(
    "Slack conversations could not be loaded.",
  );
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  expect(retries).toBe(1);
});
```

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
bun test app/tests/slack-sidebar-row.test.tsx
```

Expected: module-not-found failure for `slack-channel.tsx`.

- [ ] **Step 3: Implement the read-only row**

Create `slack-channel.tsx` with `SlackChannelContent`, a `SlackChannel` wrapper, and `SlackRosterProblem`.

`SlackChannelContent` must use `ChannelAvatar` with `[agentId]`, render the agent name and this title-line chip inside a flex container carrying `data-slot="conversation-title"`:

```tsx
<span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
  Slack
</span>
```

It renders the relative timestamp at the right and the full-width truncated preview on the second line. `SlackChannel` wraps that content in:

```tsx
<Link
  to="/slack/thread/$threadId"
  params={{ threadId }}
  className="flex w-full flex-row items-center gap-2 rounded-lg px-2 py-2 hover:bg-foreground/5"
  activeProps={{ className: "bg-foreground/5" }}
>
  <SlackChannelContent
    agentId={agentId}
    agentName={agentName}
    lastMessage={lastMessage}
    lastMessageAt={lastMessageAt}
  />
</Link>
```

`SlackRosterProblem` renders an accessible compact alert and a ghost `Retry` button. It contains no query logic.

- [ ] **Step 4: Integrate both queries and source-specific rows**

In `app-sidebar.tsx`:

1. call `useInfiniteQuery(externalThreadListQueryOptions())` beside the native query;
2. compute `conversationRoster(channels.data ?? [], externalThreads.data ?? [])` and then `matchingRoster`;
3. replace the channel-only map with an exhaustive source branch keyed by `rosterKey(row)`;
4. preserve `ChannelRow` and the native `Channel` component unchanged;
5. add an animated Slack row that passes relative activity time to `SlackChannel`;
6. base animation count and search-empty logic on the merged row count;
7. show `SlackRosterProblem` when `externalThreads.error` exists and call `void externalThreads.refetch()` from retry; and
8. call `shouldShowEmptyRoster` with both queries' success flags so the global empty state appears only after both sources succeed empty.

The rendering branch should be explicit:

```tsx
{visibleRows.map((row) =>
  row.source === "openbot" ? (
    <ChannelRow
      key={rosterKey(row)}
      animateOrder={animateOrder}
      channel={row.channel}
    />
  ) : (
    <SlackChannelRow
      key={rosterKey(row)}
      animateOrder={animateOrder}
      thread={row.thread}
    />
  ),
)}
```

Do not add native context-menu mutations, unread dots, or pin state to `SlackChannelRow`.

- [ ] **Step 5: Run focused app tests and verify GREEN**

Run:

```bash
bun test app/tests/sidebar-roster.test.ts app/tests/slack-sidebar-row.test.tsx app/tests/channel-order.test.ts app/tests/channel-unread.test.ts app/tests/channel-menu-mutations.test.ts
```

Expected: all focused sidebar tests pass with no warnings.

- [ ] **Step 6: Commit the UI slice**

```bash
git add app/src/components/app-sidebar/app-sidebar.tsx app/src/components/app-sidebar/slack-channel.tsx app/tests/slack-sidebar-row.test.tsx
git commit -m "feat: show Slack threads in sidebar"
```

### Task 5: Full verification and acceptance readiness

**Files:**
- Verify only; no migration or generated route-tree change is expected.

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
bun run format
bun run lint
bun run typecheck
```

Expected: each command exits 0 with no warnings. Review formatter changes and keep only changes in the listed feature files.

- [ ] **Step 2: Run all automated tests**

Run:

```bash
bun test
```

Expected: the full repository suite passes with no new skips or failures.

- [ ] **Step 3: Build the production bundles**

Run:

```bash
bun run build
```

Expected: app, server, and worker builds exit 0.

- [ ] **Step 4: Confirm no schema migration was introduced**

Run:

```bash
git diff origin/main -- server/drizzle server/src/db/schema
```

Expected: no output. The feature reads the existing external binding and message tables.

- [ ] **Step 5: Inspect the final branch state**

Run:

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: clean worktree and the design plus focused store, route, client-model, and UI commits on `jerel/slack-sidebar-threads`.

- [ ] **Step 6: Perform production acceptance after deploy**

In Slack, mention `@openbot` with a unique sentence and wait for the agent response. In OpenBot, verify the same conversation appears in the sidebar at the expected recency position with the title-line `Slack` chip. Open it and confirm the existing read-only transcript shows both the Slack user message and agent response. Record the Slack permalink and OpenBot transcript URL in the PR acceptance notes.
