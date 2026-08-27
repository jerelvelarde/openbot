import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createRunningComponentProtocol,
  openTypefullySmokeUi,
} from "../../app/tests/support/typefully-smoke-ui";
import {
  and,
  eq,
  inArray,
  notInArray,
} from "../../server/node_modules/drizzle-orm/index.js";
import { createDatabase } from "../../server/src/db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  componentExclusions,
  components,
  credentials,
  mcpServers,
  mcpTools,
  pluginGrants,
  typefullyDrafts,
  typefullyPublicationProposals,
} from "../../server/src/db/schema";
import { TEST_POOL } from "../../server/tests/support/database";

/**
 * The Typefully journey through a deployment that is really running.
 *
 * Start a dedicated smoke deployment with the ordinary server entry point:
 *
 *   OPENBOT_SMOKE=1 \
 *   OPENBOT_SINGLE_USER=true \
 *   OPENBOT_TYPEFULLY_SMOKE_API_URL=http://127.0.0.1:43199/v2 \
 *   OPENBOT_SMOKE_BOT=typefully-smoke-bot \
 *   OPENBOT_SMOKE_AGENT_URL=http://127.0.0.1:43198/ag-ui \
 *   AGENT_ENDPOINT_ALLOWED_HOSTS=127.0.0.1 \
 *   bun --env-file=.env server/src/index.ts
 *
 * Then run `OPENBOT_SMOKE=1 bun test tests/smoke/typefully-journey.test.ts`.
 * The journey uses authenticated HTTP, the running CopilotKit/AG-UI runtime, and production React
 * decision components. Direct database access below is isolation bookkeeping only: it snapshots
 * canonical shared state and removes exact UUID-scoped rows after every run. No store method
 * performs a journey step, and no real Typefully key or host is contacted.
 */

const asked = process.env.OPENBOT_SMOKE === "1";
const API = (process.env.OPENBOT_API_URL ?? "http://127.0.0.1:3001").replace(
  /\/$/,
  "",
);
const fakeApi = process.env.OPENBOT_TYPEFULLY_SMOKE_API_URL;
const smokeBot = process.env.OPENBOT_SMOKE_BOT;
const smokeAgentUrl = process.env.OPENBOT_SMOKE_AGENT_URL;
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

type JsonObject = { [key: string]: unknown };

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} answered ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  return JSON.parse(body) as T;
}

function events(input: {
  threadId: string;
  runId: string;
  tool?: { id: string; name: string; args: JsonObject };
  text?: string;
}) {
  const stream: JsonObject[] = [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
  ];
  if (input.tool) {
    stream.push(
      {
        type: "TOOL_CALL_START",
        toolCallId: input.tool.id,
        toolCallName: input.tool.name,
        parentMessageId: "",
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: input.tool.id,
        delta: JSON.stringify(input.tool.args),
      },
      { type: "TOOL_CALL_END", toolCallId: input.tool.id },
    );
  } else if (input.text) {
    const messageId = randomUUID();
    stream.push(
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: input.text },
      { type: "TEXT_MESSAGE_END", messageId },
    );
  }
  stream.push({
    type: "RUN_FINISHED",
    threadId: input.threadId,
    runId: input.runId,
  });
  return new Response(
    stream.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function fakeAgent(endpoint: string) {
  const parsed = new URL(endpoint);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    parsed.pathname !== "/ag-ui"
  ) {
    throw new Error(
      "OPENBOT_SMOKE_AGENT_URL must be http://127.0.0.1:<port>/ag-ui.",
    );
  }
  let next: { name: string; args: JsonObject; terminal: string } | undefined;
  let terminal: string | undefined;
  const runs: JsonObject[] = [];
  const server = Bun.serve({
    hostname: parsed.hostname,
    port: Number(parsed.port),
    fetch: async (incoming) => {
      const body = (await incoming.json()) as JsonObject & {
        threadId: string;
        runId: string;
      };
      const lastMessage = Array.isArray(body.messages)
        ? body.messages.at(-1)
        : undefined;
      const lastContent =
        typeof lastMessage === "object" &&
        lastMessage !== null &&
        "content" in lastMessage &&
        typeof lastMessage.content === "string"
          ? lastMessage.content
          : "";
      runs.push(body);
      if (
        lastContent.includes("Generate a short title for this conversation")
      ) {
        return events({
          threadId: body.threadId,
          runId: body.runId,
          text: "Typefully smoke journey",
        });
      }
      if (next) {
        const current = next;
        next = undefined;
        terminal = current.terminal;
        return events({
          threadId: body.threadId,
          runId: body.runId,
          tool: { id: randomUUID(), name: current.name, args: current.args },
        });
      }
      const text = terminal ?? "Typefully smoke turn completed.";
      terminal = undefined;
      return events({ threadId: body.threadId, runId: body.runId, text });
    },
  });
  return {
    runs,
    call(name: string, args: JsonObject, terminalText: string) {
      if (next || terminal)
        throw new Error("The prior fake AG-UI turn is open.");
      next = { name, args, terminal: terminalText };
    },
    close: () => server.stop(true),
  };
}

function fakeTypefully(apiUrl: string) {
  const parsed = new URL(apiUrl);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port
  ) {
    throw new Error(
      "OPENBOT_TYPEFULLY_SMOKE_API_URL must be http://127.0.0.1:<port>/v2.",
    );
  }
  let publishCalls = 0;
  let sequence = 7000;
  const drafts = new Map<string, JsonObject>();
  const authorizations: Array<string | null> = [];
  const server = Bun.serve({
    hostname: parsed.hostname,
    port: Number(parsed.port),
    fetch: async (incoming) => {
      authorizations.push(incoming.headers.get("authorization"));
      const url = new URL(incoming.url);
      if (
        url.pathname === `${parsed.pathname}/me` &&
        incoming.method === "GET"
      ) {
        return Response.json({
          id: "smoke-account",
          name: "Fake Typefully smoke account",
          api_key_label: "Smoke only",
        });
      }
      const collection = new RegExp(
        `^${parsed.pathname}/social-sets/12/drafts/?$`,
      );
      const member = new RegExp(
        `^${parsed.pathname}/social-sets/12/drafts/(\\d+)$`,
      ).exec(url.pathname);
      if (collection.test(url.pathname) && incoming.method === "POST") {
        sequence += 1;
        const id = String(sequence);
        drafts.set(id, (await incoming.json()) as JsonObject);
        return Response.json({ id: Number(id) });
      }
      if (member && incoming.method === "GET") {
        const stored = drafts.get(member[1] ?? "");
        return stored
          ? Response.json(stored)
          : Response.json({ detail: "missing" }, { status: 404 });
      }
      if (member && incoming.method === "PATCH") {
        const body = (await incoming.json()) as JsonObject;
        const id = member[1] ?? "";
        if (body.publish_at === "now") {
          publishCalls += 1;
          return Response.json({
            id: Number(id),
            publish_state: "finished",
            status: "published",
            x_published_url: `https://x.com/openbot/status/${id}`,
          });
        }
        drafts.set(id, body);
        return Response.json({ id: Number(id), ...body });
      }
      return Response.json(
        { detail: "unsupported smoke request" },
        { status: 404 },
      );
    },
  });
  return {
    authorizations,
    get publishCalls() {
      return publishCalls;
    },
    close: () => server.stop(true),
  };
}

beforeAll(async () => {
  if (!asked) return;
  if (!fakeApi) {
    throw new Error(
      "OPENBOT_TYPEFULLY_SMOKE_API_URL must match the loopback URL configured on the running deployment.",
    );
  }
  if (!smokeBot || !smokeAgentUrl) {
    throw new Error(
      "OPENBOT_SMOKE_BOT and OPENBOT_SMOKE_AGENT_URL must name the dedicated remote smoke Bot configured on the running deployment.",
    );
  }
  const response = await request("/api/capabilities").catch(() => null);
  if (!response?.ok) {
    throw new Error(
      `No running OpenBot deployment answered at ${API}. Start the documented smoke deployment first.`,
    );
  }
  const runtime = await json<{ licenseStatus: string }>("/api/copilotkit/info");
  if (runtime.licenseStatus !== "valid") {
    throw new Error(
      "The running deployment must have a valid CopilotKit licence before the AG-UI journey can run.",
    );
  }
});

afterAll(async () => database.$client.close());

describe.skipIf(!asked)("the running Typefully deployment journey", () => {
  test("stays local-first, resumes through UI decisions, and publishes exactly once", async () => {
    if (!fakeApi) throw new Error("Missing fake Typefully URL.");
    const suffix = randomUUID().slice(0, 8);
    const apiKey = `tf_smoke_${suffix}_secret`;
    const firstBody = `SMOKE_FULL_DRAFT_BODY_${suffix}`;
    const changedBody = `SMOKE_CHANGED_DRAFT_BODY_${suffix}`;
    const altText = `Smoke media alt ${suffix}`;
    const startedAt = Date.now() - 1_000;
    if (!smokeBot || !smokeAgentUrl) throw new Error("Missing smoke Bot.");
    const vendor = fakeTypefully(fakeApi);
    const agentEndpoint = fakeAgent(smokeAgentUrl);
    const createdComponents: string[] = [];
    const botId = smokeBot;
    let channelId: string | undefined;
    let draftId: string | undefined;
    let connectionCreated = false;
    let serverCreated = false;
    let ui: ReturnType<typeof openTypefullySmokeUi> | undefined;

    const beforeServers = await database
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "typefully"));
    serverCreated = beforeServers.length === 0;
    const beforeTools = await database
      .select()
      .from(mcpTools)
      .where(eq(mcpTools.serverId, "typefully"));
    const beforeCredentials = await database
      .select()
      .from(credentials)
      .where(eq(credentials.provider, "typefully"));
    const componentNames = [
      "connectTypefullyAccount",
      "approveTypefullyPublication",
    ];
    const beforeComponents = await database
      .select()
      .from(components)
      .where(inArray(components.name, componentNames));
    const beforeBotGrants = await database
      .select()
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, botId));
    const beforeBotComponents = await database
      .select()
      .from(componentExclusions)
      .where(eq(componentExclusions.agentId, botId));

    try {
      const connections = await json<{
        connections: { serverId: string }[];
      }>("/api/plugins/connections");
      if (
        connections.connections.some(({ serverId }) => serverId === "typefully")
      ) {
        throw new Error(
          "The smoke actor already has a Typefully connection. Use a dedicated smoke database; the test will not replace it.",
        );
      }

      const pluginState = await json<{ servers: { id: string }[] }>(
        "/api/plugins",
      );
      if (!pluginState.servers.some(({ id }) => id === "typefully")) {
        await json("/api/plugins/servers", {
          method: "POST",
          body: JSON.stringify({ key: "typefully" }),
        });
      }

      const announced = beforeComponents.map(({ name }) => name);
      const missing = componentNames.filter(
        (name) => !announced.includes(name),
      );
      if (missing.length) {
        createdComponents.push(...missing);
        await json("/api/components/catalogue", {
          method: "PUT",
          body: JSON.stringify({
            components: missing.map((name) => ({
              name,
              title:
                name === "connectTypefullyAccount"
                  ? "Connect Typefully"
                  : "Approve Typefully publication",
              kind: "decision",
              description: `${name} smoke UI contract`,
              defaultPublished: false,
              grantMode: "explicit",
            })),
          }),
        });
        for (const name of missing) {
          await json(`/api/components/${name}/publication`, {
            method: "POST",
            body: JSON.stringify({ published: true }),
          });
        }
      }
      const existingUnpublished = beforeComponents.filter(
        (component) => !component.published,
      );
      if (existingUnpublished.length) {
        throw new Error(
          `Smoke will not alter preexisting component publication: ${existingUnpublished.map(({ name }) => name).join(", ")}.`,
        );
      }

      await json(`/api/agents/${encodeURIComponent(botId)}`);
      const createdChannel = await json<{ channel: { id: string } }>(
        "/api/channels",
        {
          method: "POST",
          body: JSON.stringify({ agentIds: [botId] }),
        },
      );
      channelId = createdChannel.channel.id;

      for (const ref of [
        "typefully/get_draft",
        "typefully/create_draft",
        "typefully/update_draft",
        "typefully/prepare_publication",
      ]) {
        if (
          beforeBotGrants.some(
            (grant) => grant.kind === "mcp" && grant.ref === ref,
          )
        ) {
          continue;
        }
        await json("/api/plugins/grants", {
          method: "POST",
          body: JSON.stringify({ kind: "mcp", ref, agentId: botId }),
        });
      }
      for (const name of componentNames) {
        if (beforeBotComponents.some((grant) => grant.componentName === name)) {
          continue;
        }
        await json(`/api/components/${name}/grants`, {
          method: "POST",
          body: JSON.stringify({ agentId: botId }),
        });
      }

      const initialDocument = {
        title: "Launch post",
        destinations: ["x", "linkedin"],
        socialSetId: "12",
        accountLabel: "Fake Typefully smoke account",
        posts: [{ id: "post-1", x: "Initial X", linkedin: "Initial LinkedIn" }],
        media: [
          {
            id: `smoke-image-${suffix}`,
            kind: "image",
            order: 0,
            altText: "Initial alt",
            remoteId: null,
          },
        ],
        scheduleAt: null,
      };
      const createdTool = await json<{ text: string; isError: boolean }>(
        "/api/plugins/call",
        {
          method: "POST",
          body: JSON.stringify({
            ref: "typefully/create_draft",
            agentId: botId,
            args: { channelId, document: initialDocument },
          }),
        },
      );
      expect(createdTool.isError).toBe(false);
      const summary = JSON.parse(createdTool.text) as {
        id: string;
        title: string;
        destinations: ("x" | "linkedin")[];
        mediaCount: number;
        version: number;
        syncStatus: string;
      };
      draftId = summary.id;

      let pendingConnection:
        | { args: JsonObject; resolve: (value: unknown) => void }
        | undefined;
      let pendingPublication:
        | { args: JsonObject; resolve: (value: unknown) => void }
        | undefined;
      const componentArgs: Array<{ name: string; args: JsonObject }> = [];
      const protocol = await createRunningComponentProtocol({
        apiUrl: API,
        botId,
        handlers: {
          showTypefullyDraft: async (args) => {
            componentArgs.push({ name: "showTypefullyDraft", args });
            const result = await json<{
              draft: {
                id: string;
                title: string;
                destinations: string[];
                mediaCount: number;
                version: number;
                syncStatus: string;
              };
            }>(`/api/typefully/drafts/${String(args.draftId)}`);
            return {
              draftId: result.draft.id,
              title: result.draft.title,
              destinations: result.draft.destinations,
              mediaCount: result.draft.mediaCount,
              version: result.draft.version,
              status: result.draft.syncStatus,
            };
          },
          connectTypefullyAccount: async (args) => {
            componentArgs.push({ name: "connectTypefullyAccount", args });
            return await new Promise((resolve) => {
              pendingConnection = { args, resolve };
            });
          },
          approveTypefullyPublication: async (args) => {
            componentArgs.push({ name: "approveTypefullyPublication", args });
            return await new Promise((resolve) => {
              pendingPublication = { args, resolve };
            });
          },
        },
      });

      agentEndpoint.call(
        "showTypefullyDraft",
        {
          draftId,
          title: summary.title,
          destinations: summary.destinations,
          socialSetLabel: "Fake Typefully smoke account",
          mediaCount: summary.mediaCount,
          version: summary.version,
          status: summary.syncStatus,
        },
        "The local X and LinkedIn draft is open for review.",
      );
      await protocol.run("Create a local X and LinkedIn launch draft.");

      ui = openTypefullySmokeUi(API);
      await ui.editDraft({ draftId, xText: firstBody, altText });
      const local = await json<{
        draft: { version: number; contentHash: string; document: JsonObject };
      }>(`/api/typefully/drafts/${draftId}`);
      expect(local.draft.document).toMatchObject({
        media: [{ altText }],
        posts: [{ x: firstBody }],
      });

      const unconnected = await request(
        `/api/typefully/drafts/${draftId}/sync`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: local.draft.version,
            expectedHash: local.draft.contentHash,
          }),
        },
      );
      expect(unconnected.status).toBe(409);
      expect(await unconnected.json()).toMatchObject({
        code: "connection_required",
      });

      agentEndpoint.call(
        "connectTypefullyAccount",
        {
          draftId,
          operation: "sync",
          expectedVersion: local.draft.version,
        },
        "Typefully connected and the pending sync resumed once.",
      );
      const connectionRun = protocol.run("Sync the reviewed local draft.");
      await waitForValue(() => pendingConnection, "connection decision");
      if (!pendingConnection) throw new Error("Connection decision missing.");
      await ui.connectAndResume({
        args: pendingConnection.args,
        apiKey,
        respond: async (result) => pendingConnection?.resolve(result),
      });
      connectionCreated = true;
      await connectionRun;

      const synced = await json<{
        draft: { version: number; contentHash: string; document: JsonObject };
      }>(`/api/typefully/drafts/${draftId}`);
      const firstProposalCall = await json<{ text: string; isError: boolean }>(
        "/api/plugins/call",
        {
          method: "POST",
          body: JSON.stringify({
            ref: "typefully/prepare_publication",
            agentId: botId,
            args: { draftId, expectedVersion: synced.draft.version },
          }),
        },
      );
      expect(firstProposalCall.isError).toBe(false);
      const firstProposal = JSON.parse(firstProposalCall.text) as {
        id: string;
      };

      const changedDocument = structuredClone(synced.draft.document);
      const changedPosts = changedDocument.posts;
      if (!Array.isArray(changedPosts) || !changedPosts[0]) {
        throw new Error("The authoritative smoke draft has no first post.");
      }
      if (
        typeof changedPosts[0] !== "object" ||
        changedPosts[0] === null ||
        Array.isArray(changedPosts[0])
      ) {
        throw new Error("The authoritative first post is malformed.");
      }
      changedPosts[0] = {
        ...changedPosts[0],
        x: changedBody,
        linkedin: changedBody,
      };
      await json(`/api/typefully/drafts/${draftId}`, {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: synced.draft.version,
          document: changedDocument,
        }),
      });
      expect(
        await json<{ proposal: { status: string } }>(
          `/api/typefully/proposals/${firstProposal.id}`,
        ),
      ).toMatchObject({ proposal: { status: "expired" } });

      const changed = await json<{ draft: { version: number } }>(
        `/api/typefully/drafts/${draftId}`,
      );
      const secondProposalCall = await json<{ text: string; isError: boolean }>(
        "/api/plugins/call",
        {
          method: "POST",
          body: JSON.stringify({
            ref: "typefully/prepare_publication",
            agentId: botId,
            args: { draftId, expectedVersion: changed.draft.version },
          }),
        },
      );
      expect(secondProposalCall.isError).toBe(false);
      const secondProposal = JSON.parse(secondProposalCall.text) as {
        id: string;
        draftId: string;
        destinations: ("x" | "linkedin")[];
        version: number;
        expiresAt: string;
      };
      const approvalArgs = {
        proposalId: secondProposal.id,
        draftId: secondProposal.draftId,
        destinations: secondProposal.destinations,
        version: secondProposal.version,
        expiresAt: secondProposal.expiresAt,
      };
      agentEndpoint.call(
        "approveTypefullyPublication",
        approvalArgs,
        "Published to X and LinkedIn after explicit approval.",
      );
      const publicationRun = protocol.run(
        "Prepare the current immutable revision for immediate publication.",
      );
      await waitForValue(() => pendingPublication, "publication decision");
      if (!pendingPublication) throw new Error("Publication decision missing.");
      await ui.publish({
        args: pendingPublication.args,
        respond: async (result) => pendingPublication?.resolve(result),
      });
      await publicationRun;
      expect(vendor.publishCalls).toBe(1);
      expect(vendor.authorizations.length).toBeGreaterThan(0);
      expect(new Set(vendor.authorizations)).toEqual(
        new Set([`Bearer ${apiKey}`]),
      );

      const trail = await json<{
        events: Array<{
          eventType: string;
          targetId: string | null;
          payload: unknown;
          createdAt: string;
        }>;
      }>("/api/admin/audit-events?limit=200");
      const journeyAudits = trail.events.filter(
        (event) => Date.parse(event.createdAt) >= startedAt,
      );
      expect(
        journeyAudits.some(
          ({ payload }) =>
            payload !== null &&
            typeof payload === "object" &&
            "outcome" in payload &&
            payload.outcome === "published",
        ),
      ).toBe(true);
      const transcript = JSON.stringify(protocol.agent.messages);
      expect(transcript).toContain(
        "Published to X and LinkedIn after explicit approval.",
      );
      const boundedSurfaces = JSON.stringify({
        transcript: protocol.agent.messages,
        componentArgs,
        audits: journeyAudits,
      });
      for (const forbidden of [apiKey, firstBody, changedBody]) {
        expect(boundedSurfaces).not.toContain(forbidden);
      }
      expect(componentArgs.map(({ name }) => name)).toEqual([
        "showTypefullyDraft",
        "connectTypefullyAccount",
        "approveTypefullyPublication",
      ]);
      expect(agentEndpoint.runs.length).toBeGreaterThanOrEqual(6);
    } finally {
      ui?.close();
      const currentConnections = await json<{
        connections: { serverId: string }[];
      }>("/api/plugins/connections").catch(() => ({ connections: [] }));
      if (
        connectionCreated ||
        currentConnections.connections.some(
          ({ serverId }) => serverId === "typefully",
        )
      ) {
        await request("/api/plugins/connections/typefully", {
          method: "DELETE",
        });
      }
      if (draftId) {
        await database
          .delete(typefullyPublicationProposals)
          .where(eq(typefullyPublicationProposals.draftId, draftId));
        await database
          .delete(typefullyDrafts)
          .where(eq(typefullyDrafts.id, draftId));
      }
      await database.delete(componentExclusions).where(
        beforeBotComponents.length
          ? and(
              eq(componentExclusions.agentId, botId),
              notInArray(
                componentExclusions.componentName,
                beforeBotComponents.map(({ componentName }) => componentName),
              ),
            )
          : eq(componentExclusions.agentId, botId),
      );
      const priorGrantKeys = beforeBotGrants.map(
        ({ kind, ref }) => `${kind}:${ref}`,
      );
      const currentBotGrants = await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, botId));
      for (const grant of currentBotGrants) {
        if (!priorGrantKeys.includes(`${grant.kind}:${grant.ref}`)) {
          await database
            .delete(pluginGrants)
            .where(
              and(
                eq(pluginGrants.agentId, botId),
                eq(pluginGrants.kind, grant.kind),
                eq(pluginGrants.ref, grant.ref),
              ),
            );
        }
      }
      if (channelId) {
        await database
          .delete(channelAgents)
          .where(eq(channelAgents.channelId, channelId));
        await database
          .delete(channelMemberships)
          .where(eq(channelMemberships.channelId, channelId));
        await database.delete(channels).where(eq(channels.id, channelId));
      }
      if (createdComponents.length) {
        await database
          .delete(components)
          .where(inArray(components.name, createdComponents));
      }
      const beforeCredentialIds = beforeCredentials.map(({ id }) => id);
      await database
        .delete(credentials)
        .where(
          beforeCredentialIds.length
            ? and(
                eq(credentials.provider, "typefully"),
                notInArray(credentials.id, beforeCredentialIds),
              )
            : eq(credentials.provider, "typefully"),
        );
      if (serverCreated) {
        await database
          .delete(mcpTools)
          .where(eq(mcpTools.serverId, "typefully"));
        await database.delete(mcpServers).where(eq(mcpServers.id, "typefully"));
      }
      vendor.close();
      agentEndpoint.close();

      expect(
        await database
          .select()
          .from(mcpServers)
          .where(eq(mcpServers.id, "typefully")),
      ).toEqual(beforeServers);
      expect(
        await database
          .select()
          .from(mcpTools)
          .where(eq(mcpTools.serverId, "typefully")),
      ).toEqual(beforeTools);
      expect(
        await database
          .select()
          .from(credentials)
          .where(eq(credentials.provider, "typefully")),
      ).toEqual(beforeCredentials);
      expect(
        await database
          .select()
          .from(components)
          .where(inArray(components.name, componentNames)),
      ).toEqual(beforeComponents);
      expect(
        await database
          .select()
          .from(pluginGrants)
          .where(eq(pluginGrants.agentId, botId)),
      ).toEqual(beforeBotGrants);
      expect(
        await database
          .select()
          .from(componentExclusions)
          .where(eq(componentExclusions.agentId, botId)),
      ).toEqual(beforeBotComponents);
    }
  }, 120_000);
});

async function waitForValue<T>(
  read: () => T | undefined,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
