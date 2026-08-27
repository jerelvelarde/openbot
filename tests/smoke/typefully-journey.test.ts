import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createRunningComponentProtocol,
  openTypefullySmokeUi,
} from "../../app/tests/support/typefully-smoke-ui";
import {
  and,
  eq,
  gte,
  inArray,
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
  mcpUserCredentials,
  pluginGrants,
  typefullyDrafts,
  typefullyPublicationProposals,
} from "../../server/src/db/schema";
import { TEST_POOL } from "../../server/tests/support/database";
import { startFakeTypefullyVendor } from "../../server/tests/support/fake-typefully-vendor";
import { settleSmokeCleanup } from "../../server/tests/support/typefully-smoke-cleanup";
import { confirmedSmokeTypefullyAssociation } from "../../server/tests/support/typefully-smoke-isolation";
import { correlatedRuntimeToolResult } from "../../server/tests/support/typefully-smoke-protocol";

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
    const firstXBody = `SMOKE_FIRST_X_BODY_${suffix}`;
    const firstLinkedInBody = `SMOKE_FIRST_LINKEDIN_BODY_${suffix}`;
    const changedXBody = `SMOKE_CHANGED_X_BODY_${suffix}`;
    const changedLinkedInBody = `SMOKE_CHANGED_LINKEDIN_BODY_${suffix}`;
    const altText = `SMOKE_MEDIA_ALT_${suffix}`;
    const startedAt = Date.now() - 1_000;
    const runStartedAt = new Date(startedAt);
    if (!smokeBot || !smokeAgentUrl) throw new Error("Missing smoke Bot.");
    let vendor: ReturnType<typeof startFakeTypefullyVendor> | undefined;
    let agentEndpoint: ReturnType<typeof fakeAgent> | undefined;
    const createdComponents: string[] = [];
    const createdToolNames: string[] = [];
    const createdPluginGrants: Array<{ kind: "mcp"; ref: string }> = [];
    const createdComponentGrants: string[] = [];
    const botId = smokeBot;
    let channelId: string | undefined;
    let draftId: string | undefined;
    let connectionCreated = false;
    let createdCredentialId: string | undefined;
    let actorId: string | undefined;
    let actorEmail: string | undefined;
    let serverCreated = false;
    let ui: ReturnType<typeof openTypefullySmokeUi> | undefined;
    let beforeServers: (typeof mcpServers.$inferSelect)[] = [];
    let beforeTools: (typeof mcpTools.$inferSelect)[] = [];
    let beforeCredentials: (typeof credentials.$inferSelect)[] = [];
    let beforeAssociations: (typeof mcpUserCredentials.$inferSelect)[] = [];
    const componentNames = [
      "connectTypefullyAccount",
      "approveTypefullyPublication",
    ];
    let beforeComponents: (typeof components.$inferSelect)[] = [];
    let beforeBotGrants: (typeof pluginGrants.$inferSelect)[] = [];
    let beforeBotComponents: (typeof componentExclusions.$inferSelect)[] = [];
    let snapshotsCaptured = false;
    let journeyFailure: unknown;
    let finalFailures: Error[] = [];

    try {
      vendor = startFakeTypefullyVendor(fakeApi);
      agentEndpoint = fakeAgent(smokeAgentUrl);
      beforeServers = await database
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.id, "typefully"));
      beforeTools = await database
        .select()
        .from(mcpTools)
        .where(eq(mcpTools.serverId, "typefully"));
      beforeCredentials = await database
        .select()
        .from(credentials)
        .where(eq(credentials.provider, "typefully"));
      beforeAssociations = await database
        .select()
        .from(mcpUserCredentials)
        .where(eq(mcpUserCredentials.serverId, "typefully"));
      beforeComponents = await database
        .select()
        .from(components)
        .where(inArray(components.name, componentNames));
      beforeBotGrants = await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, botId));
      beforeBotComponents = await database
        .select()
        .from(componentExclusions)
        .where(eq(componentExclusions.agentId, botId));
      snapshotsCaptured = true;
      const actor = await json<{ user: { id: string; email: string } }>(
        "/api/me",
      );
      actorId = actor.user.id;
      actorEmail = actor.user.email;
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
        const installed = await json<{
          server: { id: string; tools: Array<{ name: string }> };
        }>("/api/plugins/servers", {
          method: "POST",
          body: JSON.stringify({ key: "typefully" }),
        });
        if (installed.server.id !== "typefully") {
          throw new Error("The connector response did not identify Typefully.");
        }
        createdToolNames.push(
          ...installed.server.tools.map(({ name }) => name),
        );
        serverCreated = true;
      }

      const announced = beforeComponents.map(({ name }) => name);
      const missing = componentNames.filter(
        (name) => !announced.includes(name),
      );
      if (missing.length) {
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
              description: `${name} smoke UI contract ${suffix}`,
              defaultPublished: false,
              grantMode: "explicit",
            })),
          }),
        });
        createdComponents.push(...missing);
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
        createdPluginGrants.push({ kind: "mcp", ref });
      }
      for (const name of componentNames) {
        if (beforeBotComponents.some((grant) => grant.componentName === name)) {
          continue;
        }
        await json(`/api/components/${name}/grants`, {
          method: "POST",
          body: JSON.stringify({ agentId: botId }),
        });
        createdComponentGrants.push(name);
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
      let connectionDecisionResult: unknown;
      let publicationDecisionResult: unknown;
      let draftRouteEvidence:
        | {
            reviewedDraftId: string;
            directHref: string;
            backClosed: boolean;
            closeCleared: boolean;
          }
        | undefined;
      const componentArgs: Array<{ name: string; args: JsonObject }> = [];
      ui = openTypefullySmokeUi(API);
      const protocol = await createRunningComponentProtocol({
        apiUrl: API,
        botId,
        handlers: {
          showTypefullyDraft: async (args) => {
            componentArgs.push({ name: "showTypefullyDraft", args });
            if (!ui) throw new Error("The smoke UI is unavailable.");
            draftRouteEvidence = await ui.reviewEditReloadAndClose({
              args,
              channelId,
              xText: firstXBody,
              linkedinText: firstLinkedInBody,
              altText,
            });
            return {
              reviewedDraftId: draftRouteEvidence.reviewedDraftId,
              backClosed: draftRouteEvidence.backClosed,
              closeCleared: draftRouteEvidence.closeCleared,
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

      expect(draftRouteEvidence).toMatchObject({
        reviewedDraftId: draftId,
        backClosed: true,
        closeCleared: true,
      });
      expect(draftRouteEvidence?.directHref).toContain(`draft=${draftId}`);
      const local = await json<{
        draft: { version: number; contentHash: string; document: JsonObject };
      }>(`/api/typefully/drafts/${draftId}`);
      expect(local.draft.document).toMatchObject({
        media: [{ altText }],
        posts: [{ x: firstXBody, linkedin: firstLinkedInBody }],
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
        respond: async (result) => {
          connectionDecisionResult = result;
          pendingConnection?.resolve(result);
        },
      });
      if (connectionDecisionResult === undefined) {
        throw new Error(
          "The connection mutation did not produce a confirmed resumed decision.",
        );
      }
      const afterConnectAssociations = await database
        .select()
        .from(mcpUserCredentials)
        .where(
          and(
            eq(mcpUserCredentials.serverId, "typefully"),
            eq(mcpUserCredentials.userId, actorId),
          ),
        );
      const afterConnectCredentials = await database
        .select({
          id: credentials.id,
          provider: credentials.provider,
          keyId: credentials.keyId,
          createdAt: credentials.createdAt,
        })
        .from(credentials)
        .where(eq(credentials.provider, "typefully"));
      const createdAssociation = confirmedSmokeTypefullyAssociation({
        connectionConfirmed: true,
        actorId,
        runStartedAt,
        associations: afterConnectAssociations,
        credentials: afterConnectCredentials,
      });
      if (!createdAssociation) {
        throw new Error(
          "The connection did not create a traceable Typefully credential association.",
        );
      }
      createdCredentialId = createdAssociation.credentialId;
      connectionCreated = true;
      await connectionRun;
      expect(vendor.createDraftCalls).toBe(1);
      expect(vendor.updateDraftCalls).toBe(0);

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
        x: changedXBody,
        linkedin: changedLinkedInBody,
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

      const changed = await json<{
        draft: { version: number; contentHash: string };
      }>(`/api/typefully/drafts/${draftId}`);
      const resynced = await json<{ draft: { version: number } }>(
        `/api/typefully/drafts/${draftId}/sync`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: changed.draft.version,
            expectedHash: changed.draft.contentHash,
          }),
        },
      );
      expect(vendor.createDraftCalls).toBe(1);
      expect(vendor.updateDraftCalls).toBe(1);
      const secondProposalCall = await json<{ text: string; isError: boolean }>(
        "/api/plugins/call",
        {
          method: "POST",
          body: JSON.stringify({
            ref: "typefully/prepare_publication",
            agentId: botId,
            args: { draftId, expectedVersion: resynced.draft.version },
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
        respond: async (result) => {
          publicationDecisionResult = result;
          pendingPublication?.resolve(result);
        },
      });
      await publicationRun;
      expect(vendor.publishCalls).toBe(1);
      expect(vendor.authorizations.length).toBeGreaterThan(0);
      expect(new Set(vendor.authorizations)).toEqual(
        new Set([`Bearer ${apiKey}`]),
      );

      const trail = await json<{
        events: Array<{
          actorUserId: string | null;
          eventType: string;
          targetType: string;
          targetId: string | null;
          payload: unknown;
          createdAt: string;
        }>;
      }>("/api/admin/audit-events?limit=200");
      const journeyAudits = trail.events.filter(
        (event) => Date.parse(event.createdAt) >= startedAt,
      );
      const publicationAudit = journeyAudits.find(
        (event) =>
          event.eventType === "configuration.changed" &&
          event.targetType === "typefully_publication_proposal" &&
          event.targetId === secondProposal.id &&
          event.actorUserId === actorId &&
          event.payload !== null &&
          typeof event.payload === "object" &&
          "decision" in event.payload &&
          event.payload.decision === "approved" &&
          "outcome" in event.payload &&
          event.payload.outcome === "published" &&
          "draftId" in event.payload &&
          event.payload.draftId === secondProposal.draftId &&
          "version" in event.payload &&
          event.payload.version === secondProposal.version &&
          "destinations" in event.payload &&
          JSON.stringify(event.payload.destinations) ===
            JSON.stringify(secondProposal.destinations),
      );
      expect(publicationAudit).toBeDefined();
      expect(publicationDecisionResult).toMatchObject({
        outcome: "published",
        proposalId: secondProposal.id,
        draftId: secondProposal.draftId,
        version: secondProposal.version,
      });
      expect(componentArgs.at(-1)).toEqual({
        name: "approveTypefullyPublication",
        args: approvalArgs,
      });
      const publicationToolResult = correlatedRuntimeToolResult(
        protocol.agent.messages,
        "approveTypefullyPublication",
      );
      expect(publicationToolResult?.result).toEqual(publicationDecisionResult);
      expect(
        correlatedRuntimeToolResult(
          protocol.agent.messages,
          "connectTypefullyAccount",
        )?.result,
      ).toEqual(connectionDecisionResult);
      const boundedSurfaces = JSON.stringify({
        transcript: protocol.agent.messages,
        componentArgs,
        audits: journeyAudits,
      });
      for (const forbidden of [
        apiKey,
        altText,
        firstXBody,
        firstLinkedInBody,
        changedXBody,
        changedLinkedInBody,
      ]) {
        expect(boundedSurfaces).not.toContain(forbidden);
      }
      expect(componentArgs.map(({ name }) => name)).toEqual([
        "showTypefullyDraft",
        "connectTypefullyAccount",
        "approveTypefullyPublication",
      ]);
      expect(agentEndpoint.runs.length).toBeGreaterThanOrEqual(6);
    } catch (error) {
      journeyFailure = error;
    } finally {
      const cleanupErrors: Error[] = [];
      cleanupErrors.push(
        ...(await settleSmokeCleanup([
          { name: "UI globals", run: () => ui?.close() },
          {
            name: "owned Typefully connection",
            run: async () => {
              if (!connectionCreated || !createdCredentialId) return;
              const response = await request(
                "/api/plugins/connections/typefully",
                { method: "DELETE" },
              );
              if (!response.ok) {
                throw new Error(`disconnect answered ${response.status}`);
              }
            },
          },
          {
            name: "owned draft and channel",
            run: async () => {
              if (draftId) {
                await database
                  .delete(typefullyPublicationProposals)
                  .where(eq(typefullyPublicationProposals.draftId, draftId));
                await database
                  .delete(typefullyDrafts)
                  .where(eq(typefullyDrafts.id, draftId));
              }
              if (channelId) {
                await database
                  .delete(channelAgents)
                  .where(eq(channelAgents.channelId, channelId));
                await database
                  .delete(channelMemberships)
                  .where(eq(channelMemberships.channelId, channelId));
                await database
                  .delete(channels)
                  .where(eq(channels.id, channelId));
              }
            },
          },
          ...createdComponentGrants.map((componentName) => ({
            name: `component grant ${componentName}`,
            run: async () => {
              await database
                .delete(componentExclusions)
                .where(
                  and(
                    eq(componentExclusions.agentId, botId),
                    eq(componentExclusions.componentName, componentName),
                    eq(componentExclusions.withheldBy, actorEmail),
                    gte(componentExclusions.withheldAt, runStartedAt),
                  ),
                );
            },
          })),
          ...createdPluginGrants.map((grant) => ({
            name: `plugin grant ${grant.kind}:${grant.ref}`,
            run: async () => {
              await database
                .delete(pluginGrants)
                .where(
                  and(
                    eq(pluginGrants.agentId, botId),
                    eq(pluginGrants.kind, grant.kind),
                    eq(pluginGrants.ref, grant.ref),
                    eq(pluginGrants.grantedBy, actorEmail),
                    gte(pluginGrants.grantedAt, runStartedAt),
                  ),
                );
            },
          })),
        ])),
      );
      cleanupErrors.push(
        ...(await settleSmokeCleanup([
          {
            name: "owned components",
            run: async () => {
              if (!createdComponents.length) return;
              for (const name of createdComponents) {
                await database
                  .delete(components)
                  .where(
                    and(
                      eq(components.name, name),
                      eq(
                        components.draftDescription,
                        `${name} smoke UI contract ${suffix}`,
                      ),
                      eq(components.updatedBy, actorEmail),
                      gte(components.createdAt, runStartedAt),
                    ),
                  );
              }
            },
          },
          {
            name: "owned credential",
            run: async () => {
              if (!createdCredentialId) return;
              await database
                .delete(credentials)
                .where(eq(credentials.id, createdCredentialId));
            },
          },
          {
            name: "owned connector",
            run: async () => {
              if (!serverCreated) return;
              for (const name of createdToolNames) {
                await database
                  .delete(mcpTools)
                  .where(
                    and(
                      eq(mcpTools.serverId, "typefully"),
                      eq(mcpTools.name, name),
                    ),
                  );
              }
              const remainingTools = await database
                .select({ name: mcpTools.name })
                .from(mcpTools)
                .where(eq(mcpTools.serverId, "typefully"));
              if (remainingTools.length) {
                throw new Error(
                  "Typefully gained tools outside this run; leaving the shared connector intact.",
                );
              }
              await database
                .delete(mcpServers)
                .where(
                  and(
                    eq(mcpServers.id, "typefully"),
                    eq(mcpServers.addedBy, actorEmail),
                    gte(mcpServers.createdAt, runStartedAt),
                  ),
                );
            },
          },
          { name: "fake vendor", run: () => vendor?.close() },
          { name: "fake AG-UI agent", run: () => agentEndpoint?.close() },
        ])),
      );

      if (snapshotsCaptured) {
        cleanupErrors.push(
          ...(await settleSmokeCleanup([
            {
              name: "server snapshot",
              run: async () =>
                expect(
                  await database
                    .select()
                    .from(mcpServers)
                    .where(eq(mcpServers.id, "typefully")),
                ).toEqual(beforeServers),
            },
            {
              name: "tool snapshot",
              run: async () =>
                expect(
                  await database
                    .select()
                    .from(mcpTools)
                    .where(eq(mcpTools.serverId, "typefully")),
                ).toEqual(beforeTools),
            },
            {
              name: "credential snapshot",
              run: async () =>
                expect(
                  await database
                    .select()
                    .from(credentials)
                    .where(eq(credentials.provider, "typefully")),
                ).toEqual(beforeCredentials),
            },
            {
              name: "connection snapshot",
              run: async () =>
                expect(
                  await database
                    .select()
                    .from(mcpUserCredentials)
                    .where(eq(mcpUserCredentials.serverId, "typefully")),
                ).toEqual(beforeAssociations),
            },
            {
              name: "component snapshot",
              run: async () =>
                expect(
                  await database
                    .select()
                    .from(components)
                    .where(inArray(components.name, componentNames)),
                ).toEqual(beforeComponents),
            },
            {
              name: "plugin grant snapshot",
              run: async () =>
                expect(
                  await database
                    .select()
                    .from(pluginGrants)
                    .where(eq(pluginGrants.agentId, botId)),
                ).toEqual(beforeBotGrants),
            },
            {
              name: "component grant snapshot",
              run: async () =>
                expect(
                  await database
                    .select()
                    .from(componentExclusions)
                    .where(eq(componentExclusions.agentId, botId)),
                ).toEqual(beforeBotComponents),
            },
          ])),
        );
      }
      finalFailures = [
        ...(journeyFailure === undefined
          ? []
          : [
              journeyFailure instanceof Error
                ? journeyFailure
                : new Error(String(journeyFailure)),
            ]),
        ...cleanupErrors,
      ];
    }
    if (finalFailures.length) {
      throw new AggregateError(finalFailures, "Typefully smoke journey failed");
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
