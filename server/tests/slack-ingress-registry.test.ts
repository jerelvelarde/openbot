import { describe, expect, test } from "bun:test";
import type { ChannelIdentityContext } from "@copilotkit/channels";
import {
  SlackIngressRegistry,
  type Timer,
} from "../src/slack/ingress-registry";

type Scheduled = { delay: number; callback: () => void; cancelled: boolean };

function clock() {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    after(delay: number, callback: () => void): Timer {
      const entry = { delay, callback, cancelled: false };
      scheduled.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
  };
}

function context(eventId = "Ev1"): ChannelIdentityContext {
  return {
    provider: "slack",
    tenant: { id: "T1" },
    installation: { id: "I1" },
    actor: { id: "U1", kind: "human" },
    conversation: { id: "C1" },
    trigger: "message",
    event: { id: eventId },
    raw: null,
  };
}

const identityResult = {
  kind: "unlinked" as const,
  linkUrl: "https://openbot.test/link/slack?token=token",
  identity: {
    provider: "slack" as const,
    providerTenantId: "T1",
    providerUserId: "U1",
    providerEmail: null,
  },
};

describe("managed Slack ingress registry", () => {
  test("takes a remembered ingress only once", () => {
    const registry = new SlackIngressRegistry(clock());
    const ingress = { identityContext: context(), identityResult };

    registry.remember("Ev1", ingress);

    expect(registry.take("Ev1")).toBe(ingress);
    expect(registry.take("Ev1")).toBeNull();
  });

  test("rejects a missing or blank managed event id", () => {
    const registry = new SlackIngressRegistry(clock());
    const ingress = { identityContext: context(), identityResult };

    for (const eventId of ["", "  ", undefined]) {
      expect(() => registry.remember(eventId, ingress)).toThrow(
        "Managed Slack ingress requires an event id.",
      );
      expect(() => registry.take(eventId)).toThrow(
        "Managed Slack ingress requires an event id.",
      );
    }
  });

  test("replaces an ingress by cancelling its prior expiry", () => {
    const timer = clock();
    const registry = new SlackIngressRegistry(timer);
    const first = { identityContext: context(), identityResult };
    const latest = { identityContext: context("Ev1"), identityResult };

    registry.remember("Ev1", first);
    registry.remember("Ev1", latest);

    expect(timer.scheduled[0]).toMatchObject({
      delay: 30_000,
      cancelled: true,
    });
    expect(registry.take("Ev1")).toBe(latest);
  });

  test("cancels expiry when an ingress is taken", () => {
    const timer = clock();
    const registry = new SlackIngressRegistry(timer);
    registry.remember("Ev1", { identityContext: context(), identityResult });

    registry.take("Ev1");

    expect(timer.scheduled[0]?.cancelled).toBe(true);
  });

  test("expires an untouched ingress after exactly thirty seconds", () => {
    const timer = clock();
    const registry = new SlackIngressRegistry(timer);
    registry.remember("Ev1", { identityContext: context(), identityResult });

    expect(timer.scheduled[0]?.delay).toBe(30_000);
    timer.scheduled[0]?.callback();

    expect(registry.take("Ev1")).toBeNull();
  });

  test("does not let a stale expiry delete a replacement", () => {
    const timer = clock();
    const registry = new SlackIngressRegistry(timer);
    const first = { identityContext: context(), identityResult };
    const latest = { identityContext: context(), identityResult };
    registry.remember("Ev1", first);
    registry.remember("Ev1", latest);

    timer.scheduled[0]?.callback();

    expect(registry.take("Ev1")).toBe(latest);
  });

  test("uses one trimmed event key for replacement, expiry, and take", () => {
    const timer = clock();
    const registry = new SlackIngressRegistry(timer);
    const first = { identityContext: context(), identityResult };
    const latest = { identityContext: context(), identityResult };
    registry.remember(" Ev1 ", first);
    registry.remember("Ev1", latest);

    timer.scheduled[0]?.callback();

    expect(registry.take(" Ev1 ")).toBe(latest);
  });
});
