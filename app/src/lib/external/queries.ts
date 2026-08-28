import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { Message } from "@ag-ui/core";

export type ExternalThreadTarget = {
  threadId: string;
  agentId: string;
  agentName: string;
  provider: "slack";
  readOnly: true;
};

export function externalThreadTarget(value: unknown): ExternalThreadTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Could not load this Slack conversation.");
  }
  const target = value as Partial<ExternalThreadTarget>;
  if (
    typeof target.threadId !== "string" ||
    target.threadId.length === 0 ||
    typeof target.agentId !== "string" ||
    target.agentId.length === 0 ||
    typeof target.agentName !== "string" ||
    target.agentName.length === 0 ||
    target.provider !== "slack" ||
    target.readOnly !== true
  ) {
    throw new Error("Could not load this Slack conversation.");
  }
  return target as ExternalThreadTarget;
}

export async function readExternalThreadMessages(
  threadId: string,
): Promise<readonly Message[]> {
  const response = await client(
    `/api/external-links/threads/${encodeURIComponent(threadId)}/messages`,
    { fallback: "Could not load this Slack conversation" },
  );
  const value = (await response.json()) as { messages?: unknown };
  return Array.isArray(value.messages) ? (value.messages as Message[]) : [];
}

export function externalThreadQueryOptions(threadId: string) {
  return queryOptions({
    queryKey: ["external-threads", threadId],
    queryFn: async () => {
      const response = await client(
        `/api/external-links/threads/${encodeURIComponent(threadId)}`,
        { fallback: "Could not load this Slack conversation" },
      );
      return externalThreadTarget(await response.json());
    },
  });
}
