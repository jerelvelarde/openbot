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
import type { DataSource } from "./source";

export type Connection =
  | { kind: "local" }
  | { kind: "live"; label: string; authenticated: boolean };

export function resolveConnection(): Connection {
  const api = process.env.EXPO_PUBLIC_OPENBOT_API?.trim();
  if (!api) return { kind: "local" };
  const token = process.env.EXPO_PUBLIC_OPENBOT_TOKEN?.trim();
  return {
    kind: "live",
    label: api === "same-origin" ? "this deployment" : api,
    authenticated: Boolean(token),
  };
}

export function createSource(connection: Connection): DataSource {
  if (connection.kind === "local") return createLocalSource();
  const api = process.env.EXPO_PUBLIC_OPENBOT_API?.trim() ?? "";
  const token = process.env.EXPO_PUBLIC_OPENBOT_TOKEN?.trim();
  return createHttpSource({
    baseUrl: api === "same-origin" ? "" : api,
    ...(token ? { token } : {}),
  });
}
