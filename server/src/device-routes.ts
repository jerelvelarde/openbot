/**
 * Registering a device, and taking it back.
 *
 * Small on purpose: register, list mine, revoke one. There is no endpoint that lists somebody else's
 * devices and none that sends a test push to an arbitrary token, because both of those are ways to
 * find out what somebody carries.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "./auth/guards";
import { type DeviceStore, readRegistration } from "./devices";

export type DeviceRoutesOptions = {
  devices: DeviceStore;
  /**
   * Whether this deployment is admitting everybody as one person.
   *
   * Passed in rather than read from the environment here, so the refusal is a property of how the
   * app was assembled and a test can assert both halves of it.
   */
  authDisabled: boolean;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
};

/**
 * Why registration is refused while authentication is off.
 *
 * `OPENBOT_DEV_NO_AUTH` makes every caller the same administrator. Under it, "register this token to
 * me" means "register this token to whoever the deployment pretends everybody is" — so the next
 * person to call it would be registered against a person they are not, and would start receiving
 * that person's approvals. Reading and answering approvals over loopback is a development
 * convenience; putting them on a handset is not.
 */
const NO_AUTH_REFUSAL =
  "This deployment is running without sign-in, so it cannot tell one person from another. " +
  "Notifications need real accounts: configure Google sign-in and turn OPENBOT_DEV_NO_AUTH off.";

export function createDeviceRoutes(options: DeviceRoutesOptions) {
  const { devices, authDisabled, requireUser } = options;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    const mine = await devices.list(context.var.actor.id);
    return context.json(
      // The token never leaves this process. A person needs to know a device is registered and when
      // it was last seen; the capability itself is not something a surface needs to hold.
      mine.map((device) => ({
        id: device.id,
        platform: device.platform,
        lastSeenAt: device.lastSeenAt,
      })),
    );
  });

  routes.post("/", requireUser, async (context) => {
    if (authDisabled) {
      return context.json({ error: NO_AUTH_REFUSAL }, 403);
    }

    const registration = readRegistration(
      await context.req.json().catch(() => null),
    );
    if (!registration.ok) {
      return context.json({ error: registration.reason }, 400);
    }

    const device = await devices.register({
      userId: context.var.actor.id,
      platform: registration.platform,
      token: registration.token,
    });
    return context.json({ id: device.id, platform: device.platform }, 201);
  });

  routes.delete("/:deviceId", requireUser, async (context) => {
    const revoked = await devices.revoke(
      context.var.actor.id,
      context.req.param("deviceId"),
    );
    // 404 rather than 403 for somebody else's device: whether a given id exists is not a fact this
    // endpoint should confirm.
    return revoked
      ? context.body(null, 204)
      : context.json({ error: "That device is not registered to you." }, 404);
  });

  return routes;
}

export { NO_AUTH_REFUSAL };
