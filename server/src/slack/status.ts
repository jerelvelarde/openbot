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

/** Activation is observable but non-fatal: the HTTP application remains available for setup. */
export async function activateManagedChannels(
  channels: ChannelsActivation | undefined,
  reportFailure: (error: unknown) => void = () =>
    console.error("OpenBot Slack Channel activation failed"),
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
