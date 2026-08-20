/**
 * Signing in from a phone.
 *
 * A browser keeps a cookie and needs nothing here. A native app cannot be handed one, so it needs a
 * way to end up holding a session token — and the way it must NOT get there is by collecting a
 * password itself. So sign-in happens in the system browser, where the person can see the address bar
 * and where the credentials never pass through this product, and the app's part is only to receive
 * the result.
 *
 * Two routes, in order:
 *
 *   GET /api/mobile/sign-in   redirects into Google, telling better-auth to come back to the next one
 *   GET /api/mobile/handoff   with a fresh cookie session, mints a ONE-TIME token and redirects into
 *                             the app
 *
 * One-time, because that final redirect goes through the operating system to reach the app and can
 * be logged on the way. A token spent on first use is worth almost nothing in a log; a session token
 * that lasts weeks is worth a great deal.
 */
import { Hono } from "hono";
import type { AppVariables } from "./auth/guards";

type SessionAuth = {
  api: {
    signInSocial(input: {
      body: { provider: string; callbackURL?: string };
    }): Promise<{ url?: string | null; redirect?: boolean } | null>;
    generateOneTimeToken(input: {
      headers: Headers;
    }): Promise<{ token: string } | null>;
  };
};

export type MobileAuthOptions = {
  auth: SessionAuth;
  /** Where this deployment answers, for building the callback better-auth returns to. */
  baseUrl: string;
  /**
   * The companion's URL scheme, such as `openbot`.
   *
   * Absent means no companion is configured for this deployment, and these routes say so rather than
   * redirecting somewhere that will not open.
   */
  appScheme?: string;
};

/** What the app is told when nobody configured it. Said plainly, because it is a settings problem. */
const NO_SCHEME =
  "This deployment has no companion app configured. Set OPENBOT_APP_SCHEME.";

export function createMobileAuthRoutes(options: MobileAuthOptions) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/sign-in", async (context) => {
    if (!options.appScheme) return context.json({ error: NO_SCHEME }, 501);

    const started = await options.auth.api.signInSocial({
      body: {
        provider: "google",
        // Back to this server, not into the app. The app cannot be handed a cookie, and this is the
        // only place a cookie session can be exchanged for something an app may hold.
        callbackURL: `${trimEnd(options.baseUrl)}/api/mobile/handoff`,
      },
    });

    if (!started?.url) {
      return context.json(
        { error: "Google sign-in is not configured on this deployment." },
        503,
      );
    }
    return context.redirect(started.url, 302);
  });

  routes.get("/handoff", async (context) => {
    if (!options.appScheme) return context.json({ error: NO_SCHEME }, 501);

    /**
     * Cookie-authenticated, by the session Google's redirect just created.
     *
     * Not behind `requireUser`: that returns JSON, and this is reached by a browser mid-redirect
     * where a person needs a sentence rather than a 401 body. Arriving here without a session means
     * sign-in did not complete.
     */
    const minted = await options.auth.api
      .generateOneTimeToken({ headers: context.req.raw.headers })
      .catch(() => null);

    if (!minted?.token) {
      return context.redirect(
        `${options.appScheme}://auth?error=not-signed-in`,
        302,
      );
    }

    // The token is in the fragment-free query because the app reads it from the deep link, and it is
    // single-use and three minutes old at most. See the plugin configuration in auth/index.ts.
    return context.redirect(
      `${options.appScheme}://auth?token=${encodeURIComponent(minted.token)}`,
      302,
    );
  });

  return routes;
}

function trimEnd(url: string) {
  return url.replace(/\/+$/, "");
}

export { NO_SCHEME };
