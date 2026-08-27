import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  activateManagedChannels,
  createGracefulShutdown,
  projectSlackStatus,
} from "../src/slack/status";
import { testEnvironment } from "./support/environment";

describe("Slack lifecycle status", () => {
  test("projects a joined transport with no Slack provider as setup required", () => {
    expect(
      projectSlackStatus({
        overall: "online",
        channels: { openbot: "setup_required" },
        detail: {
          openbot: {
            status: "setup_required",
            transport: "online",
            provider: "not_attached",
          },
        },
      }),
    ).toEqual({
      transport: "online",
      provider: "not_attached",
      status: "setup_required",
    });
  });

  test("projects a reconnecting Slack provider without certifying it online", () => {
    expect(
      projectSlackStatus({
        overall: "reconnecting",
        channels: { openbot: "reconnecting" },
        detail: {
          openbot: {
            status: "reconnecting",
            transport: "reconnecting",
            provider: "attached",
          },
        },
      }),
    ).toEqual({
      transport: "reconnecting",
      provider: "attached",
      status: "reconnecting",
    });
  });

  test("reports stopped with unknown provider before Channels exists", () => {
    expect(projectSlackStatus()).toEqual({
      status: "stopped",
      transport: "stopped",
      provider: "unknown",
    });
  });
});

describe("managed Channels lifecycle", () => {
  test("keeps the web app available when activation fails", async () => {
    const errors: unknown[] = [];
    await expect(
      activateManagedChannels(
        {
          ready: async () => {
            throw new Error("gateway offline");
          },
        },
        (error) => errors.push(error),
      ),
    ).resolves.toBeUndefined();

    const app = createApp(loadConfig(testEnvironment()));
    expect((await app.request("http://openbot.local/health")).status).toBe(200);
    expect(errors).toHaveLength(1);
  });

  test("stops Channels exactly once when shutdown is requested more than once", async () => {
    let channelStops = 0;
    let listenerStops = 0;
    let exits = 0;
    const shutdown = createGracefulShutdown({
      channels: {
        stop: async () => {
          channelStops += 1;
        },
      },
      stopOthers: [
        async () => {
          listenerStops += 1;
        },
      ],
      exit: () => {
        exits += 1;
      },
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(channelStops).toBe(1);
    expect(listenerStops).toBe(1);
    expect(exits).toBe(1);
  });
});
