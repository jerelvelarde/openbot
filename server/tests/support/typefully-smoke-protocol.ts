type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function callIdentity(value: unknown) {
  const call = record(value);
  if (!call || typeof call.id !== "string") return undefined;
  const fn = record(call.function);
  const name =
    typeof call.name === "string"
      ? call.name
      : typeof fn?.name === "string"
        ? fn.name
        : undefined;
  return name ? { id: call.id, name } : undefined;
}

/** Scan the complete JSON request bodies recorded at the external AG-UI boundary. */
export function sentinelsInExternalAgentRuns(
  runs: unknown[],
  sentinels: string[],
): string[] {
  const surface = JSON.stringify(runs);
  return [...new Set(sentinels)].filter((sentinel) => {
    if (!sentinel) return false;
    const encoded = JSON.stringify(sentinel);
    return surface.includes(encoded.slice(1, -1));
  });
}

/** Return only an actual runtime tool-result correlated to the named AG-UI call. */
export function correlatedRuntimeToolResult(
  messages: unknown[],
  toolName: string,
): { toolCallId: string; result: unknown } | undefined {
  const callIds = new Set<string>();
  for (const value of messages) {
    const message = record(value);
    if (!message || !Array.isArray(message.toolCalls)) continue;
    for (const rawCall of message.toolCalls) {
      const call = callIdentity(rawCall);
      if (call?.name === toolName) callIds.add(call.id);
    }
  }
  for (const value of messages) {
    const message = record(value);
    if (
      message?.role !== "tool" ||
      typeof message.toolCallId !== "string" ||
      !callIds.has(message.toolCallId)
    ) {
      continue;
    }
    if (typeof message.content !== "string") {
      return { toolCallId: message.toolCallId, result: message.content };
    }
    try {
      return {
        toolCallId: message.toolCallId,
        result: JSON.parse(message.content),
      };
    } catch {
      return { toolCallId: message.toolCallId, result: message.content };
    }
  }
  return undefined;
}
