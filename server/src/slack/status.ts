export type ChannelStatus =
  | "connecting"
  | "online"
  | "setup_required"
  | "reconnecting"
  | "stopped"
  | "error";

export type ChannelProviderStatus =
  | "attached"
  | "unhealthy"
  | "not_attached"
  | "disabled"
  | "channel_not_declared"
  | "unknown";

export type ChannelsStatusSnapshot = {
  overall: ChannelStatus;
  channels: Record<string, ChannelStatus>;
  detail: Record<
    string,
    {
      status: ChannelStatus;
      transport: ChannelStatus;
      provider: ChannelProviderStatus;
    }
  >;
};

/** The credential-free Slack state exposed to unauthenticated deployment checks. */
export type SlackStatus = {
  status: ChannelStatus;
  transport: ChannelStatus;
  provider: ChannelProviderStatus;
};

export function projectSlackStatus(
  snapshot?: ChannelsStatusSnapshot,
): SlackStatus {
  const leg = snapshot?.detail.openbot;
  if (!leg) {
    return { status: "stopped", transport: "stopped", provider: "unknown" };
  }
  return {
    status: leg.status,
    transport: leg.transport,
    provider: leg.provider,
  };
}

type ChannelsActivation = {
  ready(options?: { timeoutMs?: number }): Promise<void>;
};

function reportActivationFailure(error: unknown): void {
  console.error("OpenBot Slack Channel activation failed", error);
}

/** Activation is observable but non-fatal: the HTTP application remains available for setup. */
export async function activateManagedChannels(
  channels: ChannelsActivation | undefined,
  reportFailure: (error: unknown) => void = reportActivationFailure,
): Promise<void> {
  if (!channels) return;
  try {
    await channels.ready({ timeoutMs: 30_000 });
  } catch (error) {
    reportFailure(error);
  }
}

type StoppableChannels = { stop(): Promise<void> };

export type GracefulShutdownOptions = {
  channels?: StoppableChannels;
  stopOthers: ReadonlyArray<() => void | Promise<void>>;
  exit: () => void;
};

/** Build one idempotent signal handler so SIGINT and SIGTERM cannot tear down twice. */
export function createGracefulShutdown({
  channels,
  stopOthers,
  exit,
}: GracefulShutdownOptions): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return () => {
    shutdown ??= Promise.allSettled([
      ...(channels ? [Promise.resolve().then(() => channels.stop())] : []),
      ...stopOthers.map((stop) => Promise.resolve().then(stop)),
    ]).then(() => exit());
    return shutdown;
  };
}

type ShutdownSignal = "SIGINT" | "SIGTERM";

export type ShutdownSignalSource = {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
};

/** Register exactly one shared callback for each supported process signal. */
export function registerShutdownSignals(
  signals: ShutdownSignalSource,
  shutdown: () => Promise<void>,
): () => void {
  let registered = true;
  const unregister = () => {
    if (!registered) return;
    registered = false;
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  };
  const onSignal = () => {
    void shutdown().finally(unregister);
  };
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  return unregister;
}

type ManagedChannelsControl = ChannelsActivation & StoppableChannels;

export type ManagedChannelHostOptions<WebHost> = {
  startWeb(): WebHost;
  stopWeb(host: WebHost): void | Promise<void>;
  channels?: ManagedChannelsControl;
  signals: ShutdownSignalSource;
  stopOthers: ReadonlyArray<() => void | Promise<void>>;
  exit(): void;
  reportActivationFailure?: (error: unknown) => void;
};

/** Start HTTP first, install shutdown handling, then wait for non-fatal Channel activation. */
export async function startManagedChannelHost<WebHost>({
  startWeb,
  stopWeb,
  channels,
  signals,
  stopOthers,
  exit,
  reportActivationFailure,
}: ManagedChannelHostOptions<WebHost>): Promise<WebHost> {
  const web = startWeb();
  const shutdown = createGracefulShutdown({
    channels,
    stopOthers: [() => stopWeb(web), ...stopOthers],
    exit,
  });
  registerShutdownSignals(signals, shutdown);
  await activateManagedChannels(channels, reportActivationFailure);
  return web;
}
