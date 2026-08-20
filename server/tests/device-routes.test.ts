import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDeviceRoutes, NO_AUTH_REFUSAL } from "../src/device-routes";
import type { DeviceStore } from "../src/devices";
import type { Device } from "../src/notify";

/**
 * What the device endpoints must guarantee.
 *
 * One property matters more than the rest: **a deployment running without sign-in must not register
 * a device.** `OPENBOT_DEV_NO_AUTH` makes every caller the same administrator, so under it
 * "register this token to me" means "register it to whoever the deployment pretends everybody is" —
 * and the next person to call would start receiving that person's approvals. Reading approvals over
 * loopback is a development convenience; putting them on a handset is not.
 */

const ACTOR = {
  id: "user_1",
  email: "someone@example.test",
  role: "user",
} as AppVariables["actor"];

const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", ACTOR);
  await next();
};

function fakeStore() {
  const registered: { userId: string; platform: string; token: string }[] = [];
  const revoked: { userId: string; id: string }[] = [];
  const store = {
    register: async (input: {
      userId: string;
      platform: string;
      token: string;
    }) => {
      registered.push(input);
      return { id: "device_1", ...input } as Device;
    },
    list: async () => [
      {
        id: "device_1",
        userId: ACTOR.id,
        platform: "expo",
        token: "ExponentPushToken[secret]",
        lastSeenAt: "2026-08-20T10:00:00.000Z",
      },
    ],
    forUsers: async () => [],
    revoke: async (userId: string, id: string) => {
      revoked.push({ userId, id });
      return id === "device_1";
    },
  } as unknown as DeviceStore;
  return { store, registered, revoked };
}

function routes(authDisabled: boolean) {
  const { store, registered, revoked } = fakeStore();
  return {
    app: createDeviceRoutes({
      devices: store,
      authDisabled,
      requireUser: signedIn,
    }),
    registered,
    revoked,
  };
}

const registration = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    platform: "expo",
    token: "ExponentPushToken[abc123]",
  }),
};

describe("registering a device", () => {
  test("is refused while the deployment cannot tell one person from another", async () => {
    const { app, registered } = routes(true);

    const response = await app.request("/", registration);

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(NO_AUTH_REFUSAL);
    // Nothing written, so a deployment left in development mode does not accumulate tokens attributed
    // to a person who does not exist.
    expect(registered).toEqual([]);
  });

  test("is allowed once there are real accounts", async () => {
    const { app, registered } = routes(false);

    const response = await app.request("/", registration);

    expect(response.status).toBe(201);
    expect(registered).toEqual([
      {
        userId: "user_1",
        platform: "expo",
        token: "ExponentPushToken[abc123]",
      },
    ]);
  });

  test("refuses a body it cannot deliver to", async () => {
    const { app } = routes(false);
    const response = await app.request("/", {
      ...registration,
      body: JSON.stringify({ platform: "expo", token: "no" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("listing and revoking", () => {
  test("the token never leaves the server", async () => {
    const { app } = routes(false);

    const listed = await (await app.request("/")).json();

    // A person needs to know a device is registered and when it was last seen. The capability itself
    // is not something a surface needs to hold, and a surface that holds it can leak it.
    expect(listed).toEqual([
      {
        id: "device_1",
        platform: "expo",
        lastSeenAt: "2026-08-20T10:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("ExponentPushToken");
  });

  test("listing works even without sign-in, because it reveals nothing new", async () => {
    // Under OPENBOT_DEV_NO_AUTH there is one person, so their own list is their own. Refusing here
    // would make the screen unusable locally for no gain.
    expect(await (await routes(true).app.request("/")).status).toBe(200);
  });

  test("revoking somebody else's device is a 404, not a 403", async () => {
    const { app, revoked } = routes(false);

    const response = await app.request("/device_404", { method: "DELETE" });

    expect(response.status).toBe(404);
    // Whether a given id exists is not a fact this endpoint should confirm.
    expect(revoked).toEqual([{ userId: "user_1", id: "device_404" }]);
  });

  test("revoking my own device says so with no body", async () => {
    const { app } = routes(false);
    expect((await app.request("/device_1", { method: "DELETE" })).status).toBe(
      204,
    );
  });
});
