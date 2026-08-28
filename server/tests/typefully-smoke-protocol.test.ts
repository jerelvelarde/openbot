import { expect, test } from "bun:test";
import {
  correlatedRuntimeToolResult,
  sentinelsInExternalAgentRuns,
} from "./support/typefully-smoke-protocol";

test("publication evidence comes from the runtime result correlated to its exact tool call", () => {
  const messages = [
    {
      role: "assistant",
      content: "Published because I said so",
      toolCalls: [
        {
          id: "call-approval",
          type: "function",
          function: { name: "approveTypefullyPublication", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call-other",
      content: JSON.stringify({ outcome: "published" }),
    },
    {
      role: "tool",
      toolCallId: "call-approval",
      content: JSON.stringify({ outcome: "published", proposalId: "p-2" }),
    },
  ];

  expect(
    correlatedRuntimeToolResult(messages, "approveTypefullyPublication"),
  ).toEqual({
    toolCallId: "call-approval",
    result: { outcome: "published", proposalId: "p-2" },
  });
  expect(correlatedRuntimeToolResult(messages, "missing")).toBeUndefined();
});

test.each(["state", "context", "tool arguments"])(
  "the raw external-agent boundary catches a sentinel present only in %s",
  (location) => {
    const sentinel = `PRIVATE_${location.replaceAll(" ", "_").toUpperCase()}`;
    const run = {
      messages: [{ role: "user", content: "Safe request" }],
      state: location === "state" ? { draft: sentinel } : { draft: "safe" },
      context: location === "context" ? [{ description: sentinel }] : [],
      tools: [
        {
          name: "safeTool",
          description: "Safe tool",
          parameters:
            location === "tool arguments"
              ? { exampleArguments: { value: sentinel } }
              : { type: "object" },
        },
      ],
      forwardedProperties: { trace: "bounded" },
    };

    expect(sentinelsInExternalAgentRuns([run], [sentinel])).toEqual([sentinel]);
  },
);

test("a bounded raw external-agent run has no private sentinels", () => {
  expect(
    sentinelsInExternalAgentRuns(
      [
        {
          messages: [{ role: "user", content: "Prepare publication" }],
          state: { draftId: "draft-1", version: 2 },
          context: [{ description: "Typefully publication" }],
          tools: [{ name: "approveTypefullyPublication" }],
          forwardedProperties: { channelId: "channel-1" },
        },
      ],
      ["PRIVATE_BODY", "PRIVATE_ALT", "tf_private_key"],
    ),
  ).toEqual([]);
});
