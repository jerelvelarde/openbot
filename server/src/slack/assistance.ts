import type { ChannelToolContext } from "@copilotkit/channels";
import { Actions, Button, Message, Section } from "@copilotkit/channels/ui";
import type { ComputerGateway } from "../computer/gateway";
import type { ControlState, SecretRequest } from "../computer/schema";
import { ASSISTANCE_TTL_MS, mintAssistanceToken } from "./assistance-token";
import { currentSlackExecution } from "./execution-context";

export const ASSISTANCE_POLL_MS = 1_000;

type WaitOutcome = "answered" | "cancelled" | "expired";
type SleepOutcome = "elapsed" | "aborted";

export type WaitForAssistanceOptions = {
  control: () => Promise<ControlState>;
  done: (state: ControlState) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<SleepOutcome>;
};

function abortAwareSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<SleepOutcome> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: SleepOutcome) => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish("aborted");
    timer = setTimeout(() => finish("elapsed"), milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Poll one already-created assistance request for a finite, abortable window. */
export async function waitForAssistance({
  control,
  done,
  signal,
  timeoutMs = ASSISTANCE_TTL_MS,
  pollMs = ASSISTANCE_POLL_MS,
  now = Date.now,
  sleep = abortAwareSleep,
}: WaitForAssistanceOptions): Promise<WaitOutcome> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (signal?.aborted) return "cancelled";
    const state = await control();
    if (signal?.aborted) return "cancelled";
    if (done(state)) return "answered";
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const slept = await sleep(Math.min(pollMs, remaining), signal);
    if (slept === "aborted" || signal?.aborted) return "cancelled";
  }
  return "expired";
}

export function computerControlUrl(appUrl: string, token: string): string {
  let configured: URL;
  try {
    configured = new URL(appUrl);
    const hostname = configured.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
    if (
      configured.username ||
      configured.password ||
      (configured.protocol !== "https:" &&
        !(configured.protocol === "http:" && loopback))
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "OpenBot app URL must be HTTPS (or loopback HTTP for local development).",
    );
  }
  const url = new URL("/assist", configured);
  url.searchParams.set("token", token);
  return url.toString();
}

export type SlackAssistanceOptions = {
  appUrl: string;
  encryptionKey: string;
};

async function assistanceUrl(options: SlackAssistanceOptions): Promise<string> {
  const execution = currentSlackExecution();
  if (!execution.agentId || !execution.channelsThreadId) {
    throw new Error("Slack assistance requires a pinned coworker thread.");
  }
  const token = await mintAssistanceToken(
    {
      openbotUserId: execution.actor.id,
      agentId: execution.agentId,
      channelsThreadId: execution.channelsThreadId,
    },
    options.encryptionKey,
  );
  return computerControlUrl(options.appUrl, token);
}

function assistanceMessage(reason: string, url: string) {
  return Message({
    fallbackText: `${reason} Open coworker control: ${url}`,
    children: [
      Section({ children: reason }),
      Actions({
        children: Button({ url, children: "Open coworker control" }),
      }),
    ],
  });
}

function actorAndAgent() {
  const execution = currentSlackExecution();
  if (!execution.agentId) {
    throw new Error("Slack assistance requires a pinned coworker.");
  }
  return {
    agentId: execution.agentId,
    actor: { id: execution.actor.id, userId: execution.actor.id },
  };
}

export async function requestSlackHelp(
  gateway: ComputerGateway,
  reason: string,
  context: ChannelToolContext,
  options: SlackAssistanceOptions,
) {
  const { agentId, actor } = actorAndAgent();
  await gateway.requestHelp(agentId, actor, reason);
  const url = await assistanceUrl(options);
  await context.thread.post(assistanceMessage(reason, url));
  const outcome = await waitForAssistance({
    control: () => gateway.control(agentId),
    done: (state) => state.holder === "bot" && !state.requested,
    signal: context.signal,
  });
  return {
    ok: true,
    result:
      outcome === "answered"
        ? "The person has finished and handed control back. Take a fresh snapshot: the page may have changed while they were driving."
        : outcome === "cancelled"
          ? "The request was cancelled."
          : "Nobody took control. Say what you still need rather than trying to do it yourself.",
  };
}

export async function requestSlackSecret(
  gateway: ComputerGateway,
  input: SecretRequest,
  context: ChannelToolContext,
  options: SlackAssistanceOptions,
) {
  const { agentId, actor } = actorAndAgent();
  await gateway.requestSecret(agentId, actor, input);
  const url = await assistanceUrl(options);
  await context.thread.post(
    assistanceMessage(`Open OpenBot to enter ${input.label}.`, url),
  );
  const outcome = await waitForAssistance({
    control: () => gateway.control(agentId),
    done: (state) =>
      !("secretWanted" in state) || state.secretWanted === undefined,
    signal: context.signal,
  });
  return {
    ok: true,
    result:
      outcome === "answered"
        ? `The person has entered ${input.label} into the field. It was typed straight into the page and you were not told what it is.`
        : outcome === "cancelled"
          ? "The request was cancelled."
          : `Nobody entered ${input.label}. Do not ask for it another way.`,
  };
}
