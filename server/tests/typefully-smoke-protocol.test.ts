import { expect, test } from "bun:test";
import { correlatedRuntimeToolResult } from "./support/typefully-smoke-protocol";

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
