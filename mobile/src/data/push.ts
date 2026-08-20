/**
 * Asking to be told.
 *
 * This is the only part of the notification story that lives on the device, and it is deliberately
 * small: get the platform's push token, hand it to the deployment, and remember nothing. Everything
 * about what is worth a notification, and what a notification may say, is decided on the server —
 * see `server/src/notify.ts` — because a phone is not where that judgement belongs.
 *
 * Registration is a request, not a side effect of opening the app. The permission prompt is the
 * person's decision and it is asked once, when they say they want it.
 */

import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export type PushOutcome =
  | { ok: true }
  /** Said in words a person can act on, because every one of these has a different fix. */
  | { ok: false; reason: string };

/**
 * Register this device with a deployment.
 *
 * `token` is the session, read at call time. Registration needs a real account: a deployment running
 * without sign-in refuses this, on purpose, because it cannot tell one person from another and would
 * be attaching a handset to whoever it pretends everybody is.
 */
export async function registerForPush(options: {
  baseUrl: string;
  token: () => Promise<string | undefined>;
}): Promise<PushOutcome> {
  if (Platform.OS === "web") {
    return {
      ok: false,
      reason: "This build runs in a browser, which has no push token to give.",
    };
  }
  if (!Device.isDevice) {
    // A simulator has no push service behind it. Said plainly, because "nothing arrives" on a
    // simulator otherwise looks like a bug in the server.
    return {
      ok: false,
      reason:
        "A simulator cannot receive push notifications. Use a real device.",
    };
  }

  const existing = await Notifications.getPermissionsAsync();
  const granted =
    existing.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) {
    return {
      ok: false,
      reason: "Notifications are turned off for OpenBot in Settings.",
    };
  }

  let pushToken: string;
  try {
    pushToken = (await Notifications.getExpoPushTokenAsync()).data;
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? error.message
          : "This device could not produce a push token.",
    };
  }

  const session = await options.token();
  const response = await fetch(`${options.baseUrl}/api/devices`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session ? { authorization: `Bearer ${session}` } : {}),
    },
    body: JSON.stringify({ platform: "expo", token: pushToken }),
  }).catch(() => null);

  if (!response) {
    return { ok: false, reason: "Could not reach that deployment." };
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    // The server's own words. The 403 here is the one that matters: it explains that the deployment
    // is running without sign-in, which is a settings problem and not a phone problem.
    return {
      ok: false,
      reason: body?.error ?? `That was refused (${response.status}).`,
    };
  }
  return { ok: true };
}

/**
 * Where a notification points.
 *
 * The payload the server sends is small and structured on purpose, so this reads keys rather than
 * parsing a URL. Anything unrecognised opens the inbox, which is never wrong.
 */
export type PushTarget =
  | { screen: "approval"; approvalId: string }
  | { screen: "channel"; channelId: string }
  | { screen: "inbox" };

export function targetOf(data: unknown): PushTarget {
  if (typeof data !== "object" || data === null) return { screen: "inbox" };
  const payload = data as Record<string, unknown>;
  if (payload.screen === "approval" && typeof payload.approvalId === "string") {
    return { screen: "approval", approvalId: payload.approvalId };
  }
  if (payload.screen === "channel" && typeof payload.channelId === "string") {
    return { screen: "channel", channelId: payload.channelId };
  }
  return { screen: "inbox" };
}
