import type { Hono as HonoApp, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "./agents/profile-store";
import { createAgentRoutes } from "./agents/routes";
import { type AuditReader, type AuditStore, auditQueryFromUrl } from "./audit";
import { createDevRequireUser } from "./auth/dev-actor";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
  type RoleRepository,
  requireAdmin,
} from "./auth/guards";
import type { ChannelEventHub } from "./channels/events";
import { type ChannelStore, createChannelRoutes } from "./channels/routes";
import type { ThreadIdentity } from "./channels/thread-identity";
import { createThreadRoutes } from "./channels/thread-routes";
import { createComponentRoutes } from "./components/routes";
import type { SandboxedStore } from "./components/sandboxed";
import { createSandboxedRoutes } from "./components/sandboxed-routes";
import type { ComponentStore } from "./components/store";
import { createApprovalRoutes } from "./computer/approval-routes";
import type { ApprovalStore } from "./computer/approvals";
import type { ComputerClient } from "./computer/client";
import type { ComputerGateway } from "./computer/gateway";
import type { PolicyStore } from "./computer/policy-store";
import { createComputerRoutes } from "./computer/routes";
import type { DeploymentConfig } from "./config";
import type { ConnectorAdminService } from "./connectors";
import type { CredentialAdminService, CredentialInput } from "./credentials";
import { createDeviceRoutes } from "./device-routes";
import type { DeviceStore } from "./devices";
import { createMobileAuthRoutes } from "./mobile-auth-routes";
import { createPluginRoutes } from "./plugins/routes";
import type { PluginStore } from "./plugins/store";
import type { PackageStatusReader } from "./tenant-package";

export function createApp(
  config: DeploymentConfig,
  auth?: AuthService,
  roleRepository?: RoleRepository,
  auditReader?: AuditReader,
  credentialService?: CredentialAdminService,
  packageStatusReader?: PackageStatusReader,
  connectorService?: ConnectorAdminService,
  /**
   * The CopilotKit endpoint, already built by the caller.
   *
   * Passed in rather than constructed here so this module never imports the runtime. The runtime
   * pulls in `eventsource`, which Bun cannot `require()` from a test, so importing it at module
   * scope broke every server test that touches createApp even though none of them use CopilotKit.
   */
  copilotHandler?: HonoApp,
  /** Absent when no computer is configured, and the routes are then not mounted at all. */
  computerClient?: ComputerClient,
  /** The only path to an acting call: policy decision, then audit row, then the action. */
  computerGateway?: ComputerGateway,
  /** What the gateway enforces, and what an administrator can change while running. */
  computerPolicy?: PolicyStore,
  /** Bots as durable objects: profile, roster, visibility. */
  agentProfileStore?: AgentProfileStore,
  /** The durable channels a Bot runs in. */
  channelStore?: ChannelStore,
  /** Live channel activity. Absent leaves the routes working, just without the socket. */
  channelEvents?: ChannelEventHub,
  /**
   * Where a Bot's own refusal is written.
   *
   * Separate from `auditReader`, which only reads: this writes, and it is the one thing in the trail
   * that is not decided by the gateway, a model declining before it calls anything.
   */
  auditStore?: AuditStore,
  /**
   * Which components each Bot may answer with.
   *
   * Absent leaves the app working and every Bot answering in prose, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must not fall back to granting
   * everything.
   */
  componentStore?: ComponentStore,
  /**
   * The MCP servers and packaged skills this deployment has, and which Bots hold them.
   *
   * Absent leaves every Bot with the tools it was born with, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must offer nothing extra rather than
   * fall back to offering everything.
   */
  pluginStore?: PluginStore,
  /**
   * Components authored in the browser rather than compiled into the build.
   *
   * Absent leaves the compiled gallery working exactly as before, which is the correct degraded
   * behaviour: the React path is the primary one and does not depend on this.
   */
  sandboxedStore?: SandboxedStore,
  /**
   * How this deployment names the threads it mints.
   *
   * Absent leaves the direct Bot chat generating its own id in the browser, which works and simply
   * says nothing about which deployment the conversation belongs to.
   */
  threadIdentity?: ThreadIdentity,
  /**
   * Actions parked for a person to answer.
   *
   * Absent leaves `/api/approvals` unmounted, and an `ask` rule then refuses rather than parking:
   * a deployment that cannot record approvals must not carry an action out on the grounds that
   * nobody could be asked.
   */
  approvalStore?: ApprovalStore,
  /**
   * The devices that have asked to be told.
   *
   * Absent leaves `/api/devices` unmounted, which is what a deployment with no notifications is.
   * Present but with sign-in disabled leaves the routes mounted and registration refused, which is
   * different and worth saying out loud: see `device-routes.ts`.
   */
  deviceStore?: DeviceStore,
) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/health", (context) => context.json({ status: "ok" }));
  // Projected, never the raw runtime. config.runtime carries the Intelligence contract, including
  // INTELLIGENCE_API_KEY and the licence token, and this endpoint is reachable by anyone. Returning
  // the object wholesale would serve deployment secrets to the browser. Add fields here explicitly.
  app.get("/api/capabilities", (context) =>
    context.json({
      mode: config.runtime.mode,
      durableHistory: config.runtime.durableHistory,
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", (context) => {
    if (!auth) {
      return context.json(
        { error: "Google authentication is not configured." },
        503,
      );
    }

    return auth.handler(context.req.raw);
  });

  /**
   * Sign-in for the companion app, when both an auth provider and a companion are configured.
   *
   * Mounted only when there is a real auth service, because the whole point of these routes is to
   * turn a real cookie session into something a phone may hold. Under `OPENBOT_DEV_NO_AUTH` there is
   * no session to convert and nothing here would be honest.
   */
  if (auth && config.auth) {
    app.route(
      "/api/mobile",
      createMobileAuthRoutes({
        auth: auth as never,
        baseUrl: config.auth.baseUrl,
        ...(config.auth.appScheme ? { appScheme: config.auth.appScheme } : {}),
      }),
    );
  }

  const authenticationUnavailable: MiddlewareHandler<{
    Variables: AppVariables;
  }> = async (context) =>
    context.json({ error: "Google authentication is not configured." }, 503);
  // Local development can stand in a fixed administrator so the product is reachable before the
  // authentication slice is built. It is checked first so a machine with the flag set does not also
  // need Google credentials configured just to boot.
  const requireUser = config.devNoAuth
    ? createDevRequireUser()
    : auth && roleRepository
      ? createRequireUser(auth, roleRepository)
      : authenticationUnavailable;

  app.get("/api/me", requireUser, (context) =>
    context.json({ user: context.var.actor }),
  );
  app.get("/api/admin/status", requireUser, (context) => {
    const denied = requireAdmin(context);
    return denied ?? context.json({ status: "ok" });
  });
  app.get("/api/admin/audit-events", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!auditReader) {
      return context.json({ error: "Audit logging is not configured." }, 503);
    }

    return context.json(
      await auditReader.list(auditQueryFromUrl(new URL(context.req.url))),
    );
  });
  /**
   * The trail, for the person whose Bots it is about.
   *
   * Separate from `/api/admin/audit-events`, which is an administrator reading the whole deployment.
   * This answers "what did my Bots just do", which is a thing an ordinary user needs and a phone shows,
   * and it is scoped to the Bots that person can see rather than to their role.
   *
   * Read-only, and it adds no new facts: the same rows, filtered. A refusal still carries the rule
   * that caused it, because that is the one detail that turns "blocked" into something actionable.
   */
  app.get("/api/audit", requireUser, async (context) => {
    if (!auditReader || !agentProfileStore) {
      return context.json({ error: "Audit logging is not configured." }, 503);
    }
    const actor = context.var.actor;
    const visible = new Set(
      (await agentProfileStore.list({ id: actor.id, role: actor.role })).map(
        (profile) => profile.id,
      ),
    );

    const { events, nextCursor } = await auditReader.list(
      auditQueryFromUrl(new URL(context.req.url)),
    );

    /**
     * Filtered on the Bot named in the payload.
     *
     * An event with no Bot in it is deployment-level - a policy load, a credential rotation - and is
     * not this person's business here; the admin trail is where those are read. So an unattributable
     * row is dropped rather than shown to everybody, which is the fail-closed direction.
     */
    const mine = events.filter((event) => {
      const bot = (event.payload as { bot?: unknown } | null)?.bot;
      return typeof bot === "string" && visible.has(bot);
    });

    return context.json({
      events: mine,
      ...(nextCursor ? { nextCursor } : {}),
    });
  });
  app.get("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    return context.json({ credentials: await credentialService.list() });
  });
  app.post("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: "Credential storage is not configured." },
        503,
      );
    }

    const body = await context.req.json().catch(() => null);
    const input = credentialInput(body, context.var.actor.id);
    if (!input) {
      return context.json({ error: "Credential input is invalid." }, 400);
    }

    return context.json(
      { credential: await credentialService.create(input) },
      201,
    );
  });
  app.post(
    "/api/admin/credentials/:credentialId/rotate",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      const body = await context.req.json().catch(() => null);
      const input = credentialInput(body, context.var.actor.id);
      if (!input) {
        return context.json({ error: "Credential input is invalid." }, 400);
      }

      return context.json({
        credential: await credentialService.rotate({
          ...input,
          previousCredentialId: context.req.param("credentialId"),
        }),
      });
    },
  );
  app.post(
    "/api/admin/credentials/:credentialId/revoke",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: "Credential storage is not configured." },
          503,
        );
      }

      return context.json({
        credential: await credentialService.revoke(
          context.req.param("credentialId"),
          context.var.actor.id,
        ),
      });
    },
  );
  app.get("/api/admin/package", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!packageStatusReader) {
      return context.json({ error: "Tenant package is not configured." }, 503);
    }
    return context.json({ package: await packageStatusReader.active() });
  });
  app.get("/api/admin/connectors", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!connectorService) {
      return context.json(
        { error: "Connector management is not configured." },
        503,
      );
    }

    return context.json({ connectors: await connectorService.list() });
  });
  app.post(
    "/api/admin/connectors/google-drive/setup",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      if (!connectorService?.configureGoogleDrive) {
        return context.json(
          { error: "Google Drive setup is not configured." },
          503,
        );
      }
      const body = await context.req.json().catch(() => null);
      const input = googleDriveSetupInput(body, context.var.actor.id);
      if (!input)
        return context.json({ error: "Google Drive setup is invalid." }, 400);
      return context.json(
        { connector: await connectorService.configureGoogleDrive(input) },
        201,
      );
    },
  );

  // The CopilotKit runtime, behind the same session guard as every other API route. Mounted last so
  // its own routing under /api/copilotkit cannot shadow an OpenBot route declared above.
  if (copilotHandler) {
    // Mounted at the ROOT with the handler carrying its own basePath. Mounting it at
    // "/api/copilotkit" as well double-prefixes it: Hono strips the prefix before the handler sees
    // the path, so every route lands at /api/copilotkit/api/copilotkit/* and /info 404s. The client
    // reports that as "Runtime info request failed with status 404" and every run fails before it
    // starts, with nothing at all in the server log.
    app.route("/", copilotHandler);
  }

  // The Bot computer. Acting on a page needs the gateway and the policy it enforces, so all
  // three arrive together or the routes are not mounted: a computer whose actions were ungoverned is
  // not a reduced feature, it is the one shape of this feature that must not exist.
  if (computerClient && computerGateway && computerPolicy) {
    app.route(
      "/api/computers",
      createComputerRoutes(
        computerClient,
        computerGateway,
        computerPolicy,
        requireUser,
      ),
    );
  }

  // Scoped by agent visibility rather than merely by being signed in, so one person cannot answer
  // another's private Bot. See createApprovalRoutes.
  if (approvalStore && agentProfileStore && computerPolicy) {
    app.route(
      "/api/approvals",
      createApprovalRoutes(
        approvalStore,
        agentProfileStore,
        computerPolicy,
        requireUser,
      ),
    );
  }

  if (deviceStore) {
    app.route(
      "/api/devices",
      createDeviceRoutes({
        devices: deviceStore,
        // The same fact `index.ts` prints at boot, passed in rather than read here, so the refusal is
        // a property of how the app was assembled and a test can drive both halves of it.
        authDisabled: config.devNoAuth,
        requireUser,
      }),
    );
  }

  if (agentProfileStore) {
    app.route(
      "/api/agents",
      createAgentRoutes(
        agentProfileStore,
        requireUser,
        // The same stance the computer uses: a laptop legitimately talks to its own services, a hosted
        // deployment must not. Passed from configuration rather than defaulted here, so "hosted and
        // permissive" cannot happen by forgetting something.
        config.computer?.allowPrivateHosts ?? false,
        // A Bot's own refusal goes in the same trail as everything else it does.
        auditStore,
      ),
    );
  }

  if (channelStore) {
    app.route(
      "/api/channels",
      createChannelRoutes(channelStore, requireUser, channelEvents),
    );
  }

  if (componentStore) {
    app.route(
      "/api/components",
      createComponentRoutes(componentStore, requireUser, auditStore),
    );
  }

  if (pluginStore) {
    app.route("/api/plugins", createPluginRoutes(pluginStore, requireUser));
  }

  if (sandboxedStore) {
    app.route(
      "/api/sandboxed",
      createSandboxedRoutes(sandboxedStore, requireUser),
    );
  }

  if (threadIdentity) {
    app.route("/api/threads", createThreadRoutes(threadIdentity, requireUser));
  }

  return app;
}

function googleDriveSetupInput(value: unknown, actorUserId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.serviceAccountJson !== "string" ||
    typeof body.impersonationSubject !== "string" ||
    !body.impersonationSubject.trim()
  )
    return null;
  try {
    const json = JSON.parse(body.serviceAccountJson) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  } catch {
    return null;
  }
  return {
    serviceAccountJson: body.serviceAccountJson,
    impersonationSubject: body.impersonationSubject.trim(),
    actorUserId,
  };
}

function credentialInput(
  value: unknown,
  actorUserId: string,
): CredentialInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    (body.kind !== "model" &&
      body.kind !== "connector" &&
      body.kind !== "mcp") ||
    typeof body.provider !== "string" ||
    typeof body.keyId !== "string" ||
    typeof body.plaintext !== "string" ||
    !body.plaintext ||
    !body.metadata ||
    typeof body.metadata !== "object" ||
    Array.isArray(body.metadata)
  ) {
    return null;
  }

  return {
    kind: body.kind,
    provider: body.provider,
    keyId: body.keyId,
    metadata: body.metadata as Record<string, unknown>,
    plaintext: body.plaintext,
    actorUserId,
  };
}
