/**
 * Which deployment this build talks to.
 *
 * Chosen at build time from the environment rather than from a settings screen, because the answer is
 * a property of how the app was started, not a preference. Unset means the local source, which is
 * what makes the app runnable with nothing behind it.
 *
 *   EXPO_PUBLIC_OPENBOT_API=same-origin   # web build behind mobile/scripts/dev-proxy.ts
 *   EXPO_PUBLIC_OPENBOT_API=https://openbot.example
 *   EXPO_PUBLIC_OPENBOT_TOKEN=...         # required for anything not on loopback
 */
import { createHttpSource } from "./http";
import { createLocalSource } from "./local";
import { forgetSession, readToken } from "./session";
import type { DataSource } from "./source";

export type Connection =
  | { kind: "local" }
  | { kind: "live"; label: string; baseUrl: string };

export function resolveConnection(): Connection {
  const api = process.env.EXPO_PUBLIC_OPENBOT_API?.trim();
  if (!api) return { kind: "local" };
  return {
    kind: "live",
    /**
     * Which deployment, in the words a person can check.
     *
     * "this deployment" distinguishes a laptop from production not at all, and the whole point of the
     * bar it appears in is answering "is this real?" of a screenshot. Same-origin only ever happens
     * in a browser, hence the guard: this module is imported on native too.
     */
    label:
      api === "same-origin"
        ? typeof window === "undefined"
          ? "this deployment"
          : window.location.host
        : api,
    /**
     * Whether this build needs to sign in at all.
     *
     * Same-origin means the browser is already carrying a session cookie, which is the web build
     * behind the dev proxy. Anything else is a phone talking to a deployment over the network, and
     * that needs a real session before it can read anybody's approvals.
     */
    baseUrl: api === "same-origin" ? "" : api,
  };
}

export function createSource(connection: Connection): DataSource {
  if (connection.kind === "local") return createLocalSource();
  return createHttpSource({
    baseUrl: connection.baseUrl,
    // Read per call, so a token acquired after the app started is used without rebuilding anything.
    token: readToken,
    // A session the deployment no longer accepts ends, rather than becoming an error on every screen
    // with no way back to the sign-in button.
    onUnauthorized: forgetSession,
  });
}
