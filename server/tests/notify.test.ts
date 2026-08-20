import { describe, expect, test } from "bun:test";
import {
  compose,
  createExpoDelivery,
  createNotifier,
  type Device,
  type Notification,
} from "../src/notify";

/**
 * What a notification must and must not carry.
 *
 * A notification is read on a locked screen, by somebody who has not agreed to see anything in
 * particular. So the properties worth pinning are mostly about restraint:
 *
 *  - the words are composed here, from a subject the SERVER resolved, so page text and typed values
 *    have no route into a push payload
 *  - a private Bot's approval reaches its owner and administrators, and nobody else
 *  - delivery failing never breaks the thing that triggered it
 *  - a device token never appears in a log or an error
 */

const DEVICE: Device = {
  id: "device_1",
  userId: "user_1",
  platform: "expo",
  token: "ExponentPushToken[abcdefghijklmnop]",
};

function notifier(options: {
  recipients?: string[];
  devices?: Device[];
  send?: (message: unknown, devices: Device[]) => Promise<void>;
}) {
  const sent: { message: unknown; devices: Device[] }[] = [];
  const store = createNotifier({
    recipients: async () => options.recipients ?? ["user_1"],
    devicesFor: async () => options.devices ?? [DEVICE],
    delivery: {
      name: "test",
      send: async (message, devices) => {
        sent.push({ message, devices });
        await options.send?.(message, devices);
      },
    },
  });
  return { store, sent };
}

describe("what a notification says", () => {
  test("an approval names the Bot and the thing the server resolved", () => {
    const message = compose({
      kind: "approval",
      botId: "risk-analyst",
      botName: "Risk Analyst",
      subject: "Submit payment run",
      target: { screen: "approval", approvalId: "approval_9" },
    });

    expect(message.title).toBe("Risk Analyst needs your approval");
    // The subject, which is the same value that went in the audit row — not the ref the model sent.
    expect(message.body).toBe("Submit payment run");
    expect(message.data).toEqual({
      kind: "approval",
      bot: "risk-analyst",
      screen: "approval",
      approvalId: "approval_9",
    });
  });

  test("there is no way to pass a body, only a subject", () => {
    // The type has no body field, and this is the shape that makes the lock-screen rule enforceable
    // rather than a convention. A caller that could pass text could pass a page's contents.
    const notification = {
      kind: "approval",
      botId: "b",
      subject: "Delete everything",
      body: "the page said: card 4242 4242 4242 4242",
    } as unknown as Notification;

    expect(compose(notification).body).toBe("Delete everything");
  });

  test("a question carries what the Bot asked, clipped", () => {
    const long = "x".repeat(400);
    const message = compose({ kind: "question", botId: "b", asked: long });

    // The one field carrying text nobody on this side composed: a person cannot decide whether to
    // help without reading the request. Bounded so a lock screen is not a data export.
    expect(message.body.length).toBeLessThanOrEqual(140);
    expect(message.body.endsWith("…")).toBe(true);
  });

  test("says something useful when there is nothing to name", () => {
    // Never an empty body: a notification with no words is a buzz nobody can act on.
    expect(compose({ kind: "approval", botId: "b" }).body).toBe(
      "Something is waiting on you.",
    );
    expect(compose({ kind: "question", botId: "b" }).body).toBe(
      "It cannot get past something on its own.",
    );
    expect(compose({ kind: "failed", botId: "b" }).body).toBe(
      "It could not finish, and nobody was watching.",
    );
  });

  test("falls back to the Bot's id, which is at least recognisable", () => {
    expect(compose({ kind: "finished", botId: "risk-analyst" }).title).toBe(
      "risk-analyst has finished",
    );
  });
});

describe("who gets told", () => {
  test("nobody registered means nothing sent, and no error", async () => {
    const { store, sent } = notifier({ devices: [] });
    await store.notify({ kind: "approval", botId: "b" });
    expect(sent).toEqual([]);
  });

  test("nobody may see the Bot means nothing sent", async () => {
    const { store, sent } = notifier({ recipients: [] });
    await store.notify({ kind: "approval", botId: "b" });
    // A deleted or invisible Bot is not an error here. Failing would break whatever produced the
    // notification, which is always something more important than the notification.
    expect(sent).toEqual([]);
  });

  test("delivery failing does not fail the caller", async () => {
    const { store } = notifier({
      send: async () => {
        throw new Error("expo is down");
      },
    });

    // A parked action must park whether or not a phone can be reached. If this threw, a missing push
    // service would look like a policy decision.
    await store.notify({ kind: "approval", botId: "b" });
  });
});

describe("sending through Expo", () => {
  test("sends one message per registered device, at a priority that wakes a phone", async () => {
    let body: unknown;
    const delivery = createExpoDelivery({
      fetch: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await delivery.send({ title: "T", body: "B", data: { kind: "approval" } }, [
      DEVICE,
      { ...DEVICE, id: "d2", token: "ExponentPushToken[zzzz]" },
    ]);

    expect(body).toEqual([
      {
        to: DEVICE.token,
        title: "T",
        body: "B",
        data: { kind: "approval" },
        priority: "high",
        sound: "default",
      },
      {
        to: "ExponentPushToken[zzzz]",
        title: "T",
        body: "B",
        data: { kind: "approval" },
        priority: "high",
        sound: "default",
      },
    ]);
  });

  test("ignores devices it cannot deliver to", async () => {
    let called = false;
    const delivery = createExpoDelivery({
      fetch: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await delivery.send({ title: "T", body: "B", data: {} }, [
      { ...DEVICE, platform: "ios" },
    ]);

    // A token registered for a platform this adapter does not speak is left for an adapter that does,
    // rather than posted to Expo and rejected.
    expect(called).toBe(false);
  });

  test("a rejected push is reported without the device token in it", async () => {
    const delivery = createExpoDelivery({
      fetch: (async () =>
        new Response("nope", { status: 400 })) as unknown as typeof fetch,
    });

    // A token in a log is a token in the log forever, and it is a standing capability to interrupt
    // somebody. The count is enough to investigate with.
    await expect(
      delivery.send({ title: "T", body: "B", data: {} }, [DEVICE]),
    ).rejects.toThrow(/1 device\(s\): 400/);
    await expect(
      delivery.send({ title: "T", body: "B", data: {} }, [DEVICE]),
    ).rejects.not.toThrow(/ExponentPushToken/);
  });
});
