import { describe, expect, spyOn, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  activateManagedChannels,
  projectSlackStatus,
  startManagedChannelHost,
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
  test("reports activation failure with the caught error as a separate argument", async () => {
    const failure = new Error("gateway offline");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await activateManagedChannels({
        ready: async () => {
          throw failure;
        },
      });

      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(
        "OpenBot Slack Channel activation failed",
        failure,
      );
    } finally {
      logged.mockRestore();
    }
  });

  test("SIGTERM and SIGINT share one shutdown and unregister their callbacks", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const signals = {
      on(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        const registered = listeners.get(signal) ?? new Set();
        registered.add(listener);
        listeners.set(signal, registered);
      },
      off(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.get(signal)?.delete(listener);
      },
      emit(signal: "SIGINT" | "SIGTERM") {
        for (const listener of listeners.get(signal) ?? []) listener();
      },
      count(signal: "SIGINT" | "SIGTERM") {
        return listeners.get(signal)?.size ?? 0;
      },
    };
    let channelStops = 0;
    let httpStops = 0;
    const httpStopForces: Array<boolean | undefined> = [];
    let listenerStops = 0;
    let exits = 0;
    let markExited: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    await startManagedChannelHost({
      startWeb: () => ({
        stop(force?: boolean): Promise<void> {
          httpStops += 1;
          httpStopForces.push(force);
          if (force) return Promise.resolve();
          return new Promise(() => {});
        },
      }),
      stopWeb: (web) => web.stop(true),
      channels: {
        ready: async () => {},
        stop: async () => {
          channelStops += 1;
        },
      },
      signals,
      stopOthers: [
        async () => {
          listenerStops += 1;
        },
      ],
      exit: () => {
        exits += 1;
        markExited?.();
      },
    });

    expect(signals.count("SIGINT")).toBe(1);
    expect(signals.count("SIGTERM")).toBe(1);
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await exited;
    await Promise.resolve();

    expect(channelStops).toBe(1);
    expect(httpStops).toBe(1);
    expect(httpStopForces).toEqual([true]);
    expect(listenerStops).toBe(1);
    expect(exits).toBe(1);
    expect(signals.count("SIGINT")).toBe(0);
    expect(signals.count("SIGTERM")).toBe(0);
  });

  test("the production Bun host force-stops active WebSockets", async () => {
    const source = await Bun.file(
      new URL("../src/index.ts", import.meta.url),
    ).text();

    expect(source).toContain("stopWeb: (server) => server.stop(true)");
  });

  test("starts a live web host before managed activation and keeps it live on rejection", async () => {
    const events: string[] = [];
    let rejectActivation: ((error: Error) => void) | undefined;
    const activation = new Promise<void>((_resolve, reject) => {
      rejectActivation = reject;
    });
    const snapshot = {
      overall: "error" as const,
      channels: { openbot: "error" as const },
      detail: {
        openbot: {
          status: "error" as const,
          transport: "error" as const,
          provider: "unknown" as const,
        },
      },
    };
    const app = createApp(
      loadConfig(testEnvironment()),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => projectSlackStatus(snapshot),
    );
    let live: { app: typeof app; stop(): Promise<void> } | undefined;
    const start = startManagedChannelHost({
      startWeb: () => {
        events.push("serve");
        live = { app, stop: async () => {} };
        return live;
      },
      stopWeb: (web) => web.stop(),
      channels: {
        ready: async () => {
          events.push("activate");
          return activation;
        },
        stop: async () => {},
      },
      signals: { on: () => {}, off: () => {} },
      stopOthers: [],
      exit: () => {},
      reportActivationFailure: () => {},
    });

    await Promise.resolve();
    expect(events).toEqual(["serve", "activate"]);
    expect(live).toBeDefined();
    expect(
      (await live?.app.request("http://openbot.local/health"))?.status,
    ).toBe(200);

    rejectActivation?.(new Error("gateway unavailable"));
    await expect(start).resolves.toBe(live);
    const capabilities = await live?.app.request(
      "http://openbot.local/api/capabilities",
    );
    expect(capabilities?.status).toBe(200);
    expect((await capabilities?.json())?.channels.slack).toEqual({
      status: "error",
      transport: "error",
      provider: "unknown",
    });
  });
});
