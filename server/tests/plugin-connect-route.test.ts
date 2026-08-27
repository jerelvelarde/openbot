import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  CatalogueEntryUnknownError,
  type OAuthClient,
  UserConnectionError,
} from "../src/plugins/store";
import { TypefullyApiKeyValidationError } from "../src/plugins/typefully-rest";

/**
 * `POST /servers/:id/connect`, for a dynamically registered vendor.
 *
 * Notion has no administrator step: nobody pastes a client id, so the first person to connect is
 * the one who makes the deployment introduce itself (RFC 7591) to the vendor. Google Drive is the
 * regression pin for the OLD behaviour, which must survive unchanged for a manually registered
 * vendor: no stored client is still a 409 telling an administrator to add one, and registration is
 * never attempted for it.
 */

/** A real key shape: base64 over 32 bytes, which is what the deployment's own check demands. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function signedIn(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role: "user",
    } as never);
    await next();
  };
}

function app(store: {
  oauthClientFor: (serverId: string) => Promise<OAuthClient | null>;
  ensureOAuthClient: (
    serverId: string,
    by: string,
  ) => Promise<OAuthClient | null>;
  [key: string]: unknown;
}) {
  const routes = createPluginRoutes(
    store as never,
    signedIn(),
    async () => true,
    {
      publicUrl: "https://openbot.example",
      appUrl: "https://app.example",
      encryptionKey: ENCRYPTION_KEY,
      // Only the callback asks this. Every test here stops at the authorization URL.
      personHasAccess: async () => true,
    },
  );
  return new Hono().route("/api/plugins", routes);
}

function personalConnectionApp(store: Record<string, unknown>) {
  const routes = createPluginRoutes(
    store as never,
    signedIn(),
    async () => true,
  );
  return new Hono().route("/api/plugins", routes);
}

describe("connecting a dynamically registered vendor", () => {
  test("registers a client on first connect and mints an authorization URL with it", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return { clientId: "dyn-1", clientSecret: "" };
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(ensureCalls).toEqual([
      { serverId: "notion", by: "person@openbot.test" },
    ]);

    const body = (await response.json()) as { authorizationUrl: string };
    const url = new URL(body.authorizationUrl);
    expect(url.host).toBe("mcp.notion.com");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe("dyn-1");
  });

  test("a refused registration answers 502, naming the vendor", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return null;
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(502);
    expect(ensureCalls.length).toBe(1);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Notion refused this deployment's registration. Try again, and check the vendor's status if it persists.",
    );
  });
});

describe("connecting a manually registered vendor (regression pin)", () => {
  test("still 409s with no client registered, and never attempts self-registration", async () => {
    const ensureCalls: { serverId: string; by: string }[] = [];
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId, by) => {
        ensureCalls.push({ serverId, by });
        return { clientId: "should-not-happen", clientSecret: "x" };
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/google-drive/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    expect(ensureCalls).toEqual([]);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("no OAuth client registered");
  });
});

/**
 * Connecting a catalogue vendor that nobody has added to this deployment.
 *
 * The entry exists, so the handler gets past every check it makes about the vendor, and then asks the
 * store for a client — which cannot answer, because there is no server row to hold one. That is an
 * administrator's missing step and the person pressing Connect can do nothing about it, so it is the
 * same 409 as a vendor whose client an administrator has not pasted in yet. It used to be a 500: an
 * unhandled `CatalogueEntryUnknownError` out of `ensureOAuthClient`.
 */
describe("connecting a vendor this deployment has not added", () => {
  test("is the 409 an administrator can act on, not a 500", async () => {
    const hono = app({
      oauthClientFor: async () => null,
      ensureOAuthClient: async (serverId) => {
        throw new CatalogueEntryUnknownError(serverId);
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Notion has not been added to this deployment yet. An administrator has to add it first.",
    );
  });
});

describe("personal Typefully connection routes", () => {
  test("requires authentication before either connection method", async () => {
    let calls = 0;
    const reject: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
      context.json({ error: "Sign in required." }, 401);
    const routes = createPluginRoutes(
      {
        connectUserApiKey: async () => {
          calls += 1;
        },
        disconnectUserConnection: async () => {
          calls += 1;
        },
      } as never,
      reject,
      async () => true,
    );
    const hono = new Hono().route("/api/plugins", routes);

    const put = await hono.request(
      "http://t/api/plugins/connections/typefully/api-key",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "tf" }),
      },
    );
    const remove = await hono.request(
      "http://t/api/plugins/connections/typefully",
      { method: "DELETE" },
    );
    expect([put.status, remove.status]).toEqual([401, 401]);
    expect(calls).toBe(0);
  });

  test("derives ownership from the session and never echoes the key", async () => {
    const calls: unknown[] = [];
    const hono = personalConnectionApp({
      connectUserApiKey: async (input: unknown) => {
        calls.push(input);
        return {
          serverId: "typefully",
          authMethod: "api_key",
          accountLabel: "Personal Typefully",
          connectedAt: "2026-08-27T00:00:00.000Z",
        };
      },
    });

    const response = await hono.request(
      "http://t/api/plugins/connections/typefully/api-key",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "tf-route-secret" }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        serverId: "typefully",
        userId: "user-1",
        apiKey: "tf-route-secret",
        by: "user-1",
      },
    ]);
    expect(await response.text()).not.toContain("tf-route-secret");
  });

  test("rejects unknown fields and invalid field types before the store", async () => {
    let calls = 0;
    const hono = personalConnectionApp({
      connectUserApiKey: async () => {
        calls += 1;
      },
    });

    for (const body of [
      { apiKey: "tf", userId: "somebody-else" },
      { apiKey: 123 },
      {},
    ]) {
      const response = await hono.request(
        "http://t/api/plugins/connections/typefully/api-key",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(calls).toBe(0);
  });

  test("maps validation failures to stable status and code pairs", async () => {
    for (const [code, status] of [
      ["invalid_api_key", 400],
      ["validation_timeout", 503],
      ["validation_unavailable", 503],
      ["rate_limited", 429],
    ] as const) {
      const hono = personalConnectionApp({
        connectUserApiKey: async () => {
          throw new TypefullyApiKeyValidationError(code, "safe failure");
        },
      });
      const response = await hono.request(
        "http://t/api/plugins/connections/typefully/api-key",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: "tf-never-echo" }),
        },
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "safe failure", code });
    }
  });

  test("reports a connector that is not enabled with a stable conflict", async () => {
    const hono = personalConnectionApp({
      connectUserApiKey: async () => {
        throw new UserConnectionError(
          "connector_not_enabled",
          "Typefully is not enabled.",
        );
      },
    });
    const response = await hono.request(
      "http://t/api/plugins/connections/typefully/api-key",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "tf" }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Typefully is not enabled.",
      code: "connector_not_enabled",
    });
  });

  test("refuses a connection for an offboarded actor", async () => {
    const hono = personalConnectionApp({
      connectUserApiKey: async () => {
        throw new UserConnectionError(
          "access_revoked",
          "This user's access has been revoked.",
        );
      },
    });
    const response = await hono.request(
      "http://t/api/plugins/connections/typefully/api-key",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "tf-never-echo" }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This user's access has been revoked.",
      code: "access_revoked",
    });
  });

  test("disconnect derives the same owner and reports repeated disconnect stably", async () => {
    const calls: unknown[] = [];
    const connected = personalConnectionApp({
      disconnectUserConnection: async (input: unknown) => {
        calls.push(input);
      },
    });
    const first = await connected.request(
      "http://t/api/plugins/connections/typefully",
      { method: "DELETE" },
    );
    expect(first.status).toBe(200);
    expect(calls).toEqual([
      { serverId: "typefully", userId: "user-1", by: "user-1" },
    ]);

    const absent = personalConnectionApp({
      disconnectUserConnection: async () => {
        throw new UserConnectionError("not_connected", "Not connected.");
      },
    });
    const second = await absent.request(
      "http://t/api/plugins/connections/typefully",
      { method: "DELETE" },
    );
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({
      error: "Not connected.",
      code: "not_connected",
    });
  });
});
