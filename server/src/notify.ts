/**
 * Being told, instead of having to look.
 *
 * The approvals table made an action answerable from anywhere. It did not make anybody aware of it:
 * a parked action sits there until somebody happens to open the app, and a Bot that stops to ask a
 * question at 3pm is a Bot that has stopped until 5. So this is the other half — the part that
 * reaches a person who is not looking at anything.
 *
 * Four things are worth interrupting somebody for, and nothing else is:
 *
 *   approval  an action is parked and a person has to answer before it can happen
 *   question  a Bot needs a hand — a sign-in, a code, something it must not do itself
 *   finished  work the person asked to be told about is done
 *   failed    something running unattended stopped, and nobody was watching it
 *
 * Deliberately not: every action, every message, every tool call. A product that notifies on
 * everything is a product whose notifications are turned off, and then the approval nobody sees is
 * the one that mattered.
 *
 * **A notification is read on a locked screen.** That is the constraint the shape below exists to
 * enforce: the caller cannot pass a body, only a subject that the server already resolved, so page
 * text, file contents and typed values have no route into a push payload. What a Bot wrote about its
 * own request does get through, truncated, because that is the thing the person needs to read in
 * order to act.
 */

/** Where a notification points, in the companion. Deep links are paths, never URLs with data in them. */
export type NotificationTarget =
  | { screen: "approval"; approvalId: string }
  | { screen: "channel"; channelId: string }
  | { screen: "bot"; botId: string };

export type Notification = {
  kind: "approval" | "question" | "finished" | "failed";
  botId: string;
  /** The Bot's display name. Falls back to its id, which is at least recognisable. */
  botName?: string;
  /**
   * What this is about, in a few words, as the SERVER resolved it.
   *
   * "Submit payment run", not the ref the model sent. Same value that went in the audit row, so the
   * notification and the trail name the thing identically.
   */
  subject?: string;
  /**
   * The Bot's own words about what it needs, for a question.
   *
   * Model-written, and truncated. A person cannot decide whether to help without reading what was
   * asked, so this is the one field that carries text nobody on this side composed.
   */
  asked?: string;
  target?: NotificationTarget;
};

/** One registered device. The token is a capability to interrupt somebody, so it is never logged. */
export type Device = {
  id: string;
  userId: string;
  platform: string;
  token: string;
};

export type PushMessage = {
  title: string;
  body: string;
  /** Small, structured, and free of anything a lock screen should not show. */
  data: Record<string, string>;
};

/**
 * How a message actually leaves this process.
 *
 * An interface with one method, so a deployment with no push credentials has a truthful adapter
 * rather than a broken one, and so a test can assert what would have been sent without a network.
 */
export type Delivery = {
  name: string;
  send(message: PushMessage, devices: Device[]): Promise<void>;
};

export type NotifierOptions = {
  /** Who may see this Bot, and therefore who may be told about it. */
  recipients: (botId: string) => Promise<string[]>;
  /** The devices those people have registered. */
  devicesFor: (userIds: string[]) => Promise<Device[]>;
  delivery: Delivery;
};

export type Notifier = {
  notify(notification: Notification): Promise<void>;
};

/** As long as a notification is allowed to be. Past this it is truncated with an ellipsis. */
const MAX_ASKED = 140;

/**
 * The words a person sees.
 *
 * Composed here rather than by the caller, which is what keeps the lock-screen rule enforceable: a
 * caller that could pass a body could pass a page's contents into it.
 */
export function compose(notification: Notification): PushMessage {
  const who = notification.botName ?? notification.botId;
  const subject = notification.subject?.trim();
  const asked = notification.asked?.trim();

  const title =
    notification.kind === "approval"
      ? `${who} needs your approval`
      : notification.kind === "question"
        ? `${who} needs a hand`
        : notification.kind === "finished"
          ? `${who} has finished`
          : `${who} stopped`;

  const body =
    notification.kind === "question"
      ? (clip(asked, MAX_ASKED) ?? "It cannot get past something on its own.")
      : notification.kind === "approval"
        ? (subject ?? "Something is waiting on you.")
        : notification.kind === "finished"
          ? (subject ?? "The work you asked about is done.")
          : (subject ?? "It could not finish, and nobody was watching.");

  return {
    title,
    body,
    data: {
      kind: notification.kind,
      bot: notification.botId,
      ...targetData(notification.target),
    },
  };
}

function targetData(
  target: NotificationTarget | undefined,
): Record<string, string> {
  if (!target) return {};
  if (target.screen === "approval") {
    return { screen: "approval", approvalId: target.approvalId };
  }
  if (target.screen === "channel") {
    return { screen: "channel", channelId: target.channelId };
  }
  return { screen: "bot", botId: target.botId };
}

function clip(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function createNotifier(options: NotifierOptions): Notifier {
  return {
    async notify(notification) {
      /**
       * Delivery never breaks the thing that triggered it.
       *
       * A parked action must park whether or not a phone can be reached, and a Bot must finish its
       * work whether or not anybody was told. So this swallows nothing quietly but throws nothing
       * either: a failure is reported here and the caller carries on.
       */
      try {
        const userIds = await options.recipients(notification.botId);
        if (userIds.length === 0) return;
        const devices = await options.devicesFor(userIds);
        if (devices.length === 0) return;
        await options.delivery.send(compose(notification), devices);
      } catch (error) {
        console.error(
          `Could not tell anybody about ${notification.kind} for ${notification.botId}.`,
          error,
        );
      }
    },
  };
}

/**
 * The adapter for a deployment with nowhere to send.
 *
 * Named and logged rather than silent, because "notifications are not configured" and "notifications
 * are broken" look identical from the outside and only one of them is worth investigating.
 */
export function createLoggingDelivery(): Delivery {
  return {
    name: "log",
    async send(message, devices) {
      console.info(
        `[notify] ${message.title} — ${message.body} (${devices.length} device${
          devices.length === 1 ? "" : "s"
        }, no push service configured)`,
      );
    },
  };
}

/** Expo's push service. The endpoint is a constant so nothing observed can redirect a payload. */
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export type ExpoDeliveryOptions = {
  /** Only needed if the project enforces it. Sent as a bearer token, never logged. */
  accessToken?: string;
  fetch?: typeof fetch;
};

/**
 * Send through Expo.
 *
 * Chosen because the companion is an Expo app and this is the one path that works on both platforms
 * without either vendor's certificate living in this repo. A deployment that would rather talk to
 * APNs and FCM directly writes another `Delivery`; nothing above this knows the difference.
 */
export function createExpoDelivery(
  options: ExpoDeliveryOptions = {},
): Delivery {
  const send = options.fetch ?? fetch;
  return {
    name: "expo",
    async send(message, devices) {
      const expo = devices.filter((device) => device.platform === "expo");
      if (expo.length === 0) return;

      const response = await send(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(options.accessToken
            ? { authorization: `Bearer ${options.accessToken}` }
            : {}),
        },
        body: JSON.stringify(
          expo.map((device) => ({
            to: device.token,
            title: message.title,
            body: message.body,
            data: message.data,
            // The point of the whole exercise: it should wake a phone up.
            priority: "high",
            sound: "default",
          })),
        ),
      });

      if (!response.ok) {
        // The token is deliberately absent from this message. A rejected push is worth knowing about;
        // a rejected push with somebody's device token in the log is a token in the log forever.
        throw new Error(
          `Expo refused the push for ${expo.length} device(s): ${response.status}`,
        );
      }
    },
  };
}
