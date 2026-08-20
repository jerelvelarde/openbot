import { describe, expect, test } from "bun:test";
import { createMobileAuthRoutes, NO_SCHEME } from "../src/mobile-auth-routes";

/**
 * What signing in from a phone must guarantee.
 *
 * The app must never be the thing collecting credentials, and the thing it ends up holding must not
 * be a long-lived session token that travelled through a deep link the operating system can log. So:
 *
 *  - sign-in leaves for the provider, and comes back to THIS server, not to the app
 *  - the app receives a one-time token, and only after a session exists
 *  - arriving without a session is a sentence the app can show, not a silent dead end
 *  - a deployment with no companion configured says so instead of redirecting nowhere
 */

function fakeAuth(options: {
  url?: string | null;
  token?: string | null;
  throws?: boolean;
}) {
  const asked: unknown[] = [];
  return {
    asked,
    auth: {
      api: {
        signInSocial: async (input: unknown) => {
          asked.push(input);
          return { url: options.url ?? null, redirect: true };
        },
        generateOneTimeToken: async () => {
          if (options.throws) throw new Error("no session");
          return options.token ? { token: options.token } : null;
        },
      },
    },
  };
}

const BASE = "https://openbot.example/";

describe("signing in from the companion", () => {
  test("leaves for the provider, and comes back here rather than to the app", async () => {
    const { auth, asked } = fakeAuth({
      url: "https://accounts.google.example/o/oauth2/v2/auth?x=1",
    });
    const routes = createMobileAuthRoutes({
      auth,
      baseUrl: BASE,
      appScheme: "openbot",
    });

    const response = await routes.request("/sign-in");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://accounts.google.example/o/oauth2/v2/auth?x=1",
    );
    // Back to this server, because a cookie session is the only thing that can be exchanged for
    // something an app may hold — and the trailing slash on the base URL must not double up.
    expect(asked).toEqual([
      {
        body: {
          provider: "google",
          callbackURL: "https://openbot.example/api/mobile/handoff",
        },
      },
    ]);
  });

  test("hands the app a one-time token, never a session token", async () => {
    const routes = createMobileAuthRoutes({
      auth: fakeAuth({ token: "ott_abc" }).auth,
      baseUrl: BASE,
      appScheme: "openbot",
    });

    const response = await routes.request("/handoff");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "openbot://auth?token=ott_abc",
    );
  });

  test("arriving without a session says so, so the app can explain it", async () => {
    for (const auth of [
      fakeAuth({ token: null }).auth,
      fakeAuth({ throws: true }).auth,
    ]) {
      const routes = createMobileAuthRoutes({
        auth,
        baseUrl: BASE,
        appScheme: "openbot",
      });
      const response = await routes.request("/handoff");

      // A dead end in a browser tab, with the app still sitting on a spinner, is the worst outcome
      // here. The app is sent back to with a reason instead.
      expect(response.headers.get("location")).toBe(
        "openbot://auth?error=not-signed-in",
      );
    }
  });

  test("no companion configured is a settings problem, said plainly", async () => {
    const routes = createMobileAuthRoutes({
      auth: fakeAuth({ url: "https://x", token: "t" }).auth,
      baseUrl: BASE,
    });

    for (const path of ["/sign-in", "/handoff"]) {
      const response = await routes.request(path);
      expect(response.status).toBe(501);
      expect((await response.json()).error).toBe(NO_SCHEME);
    }
  });

  test("a provider that is not configured is reported, not redirected to null", async () => {
    const routes = createMobileAuthRoutes({
      auth: fakeAuth({ url: null }).auth,
      baseUrl: BASE,
      appScheme: "openbot",
    });

    expect((await routes.request("/sign-in")).status).toBe(503);
  });
});
