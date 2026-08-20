import { useRenderTool } from "@copilotkit/react-core/v2";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { Streamdown } from "streamdown";
import * as z from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { useActiveBotId } from "@/lib/copilot/active-bot";
import { markdownComponents } from "@/lib/markdown";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
} from "@/lib/plugins/queries";

/**
 * How the transcript draws a Bot using somebody else's MCP server.
 *
 * Rendering only. These used to be registered with `useFrontendTool`, and each handler posted to
 * `/api/plugins/call` — a round trip from the browser back to the server that was going to make the
 * call anyway. That made an open tab load-bearing for MCP as well as for the browser: a Bot working
 * unattended had no tools at all.
 *
 * Execution now lives in `server/src/plugins/tools.ts`, beside the store that decides the grant,
 * evaluates the policy and writes the audit row. What is left here is what genuinely needs a browser:
 * drawing a vendor's markdown as markdown.
 *
 * The list is still fetched, and still keeps previously seen tools mounted, because a renderer has to
 * exist for a tool call that is already in the transcript — including one whose grant has since been
 * taken away. A revoked tool's past calls must still be readable.
 */
export function PluginTools() {
  const botId = useActiveBotId();
  const { data } = useQuery(agentPluginsQueryOptions(botId));
  const granted: GrantedPlugins = data ?? { tools: [], skills: [] };

  /** Keep previously seen tools mounted so an older call in the transcript still has a renderer. */
  const seen = useRef(new Map<string, GrantedPlugins["tools"][number]>());
  for (const tool of granted.tools) seen.current.set(tool.ref, tool);
  const drawable = [...seen.current.values()];

  return (
    <>
      {drawable.map((tool) => (
        <PluginToolLine
          key={tool.ref}
          name={tool.toolName}
          toolRef={tool.ref}
        />
      ))}
    </>
  );
}

/** What the server returns for an MCP call. See `plugins/tools.ts` for where each field comes from. */
type PluginOutcome = {
  ok?: boolean;
  /** The vendor's own text, on success or on a vendor error. */
  text?: string;
  /** A policy or a missing grant said no. Final: trying again changes nothing. */
  refused?: boolean;
  reason?: string;
  /** The call was permitted and the vendor complained. A later attempt might work. */
  vendorError?: boolean;
};

function outcomeOf(result: string | undefined): PluginOutcome {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PluginOutcome)
      : {};
  } catch {
    return result.startsWith("Error:")
      ? { ok: false, reason: result.slice("Error:".length).trim() }
      : {};
  }
}

/**
 * A tool result, as something worth looking at.
 *
 * MCP says a text part, and vendors fill it with anything from plain markdown to a JSON envelope
 * with the markdown inside one field. Markdown is drawn as markdown, a JSON wrapper is unwrapped to
 * the markdown it was hiding, and anything else is fenced as JSON. Nothing is discarded.
 */
function forDisplay(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON after all. Draw what the server sent.
    return text;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    // The field carrying the answer, told apart from the ones carrying bookkeeping: Slack sends
    // `{ results, pagination_info }`. The rest is kept below rather than dropped.
    const markdown = entries
      .filter(
        ([, value]) =>
          typeof value === "string" &&
          (value.includes("\n#") || value.startsWith("#")),
      )
      .sort((a, b) => String(b[1]).length - String(a[1]).length)[0];

    if (markdown) {
      const rest = entries.filter(([key]) => key !== markdown[0]);
      const body = String(markdown[1]);
      if (rest.length === 0) return body;
      return `${body}\n\n\`\`\`json\n${JSON.stringify(
        Object.fromEntries(rest),
        null,
        2,
      )}\n\`\`\``;
    }
  }

  return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
}

/**
 * Arguments are not drawn, so the schema is empty.
 *
 * A vendor's arguments can carry anything a person typed into a Bot — a search over somebody's
 * mailbox, a customer's name — and the line names the tool and the server instead. The real schema
 * lives on the server, where it is what the model is offered.
 */
const NO_DRAWN_ARGUMENTS = z.object({});

function PluginToolLine({ name, toolRef }: { name: string; toolRef: string }) {
  const [serverId, ...rest] = toolRef.split("/");
  const bareName = rest.join("/");

  useRenderTool(
    {
      name,
      parameters: NO_DRAWN_ARGUMENTS,
      render: ({ result, status }) => {
        const outcome = outcomeOf(result);

        // A refusal is drawn differently from a vendor or transport failure: one is a boundary, the
        // other is a bad day.
        if (
          outcome.refused === true ||
          (outcome.ok === false && !outcome.text)
        ) {
          return (
            <ToolLine
              detail={outcome.reason ?? serverId}
              failed={outcome.refused !== true}
              label={bareName}
              refused={outcome.refused === true}
            />
          );
        }

        return (
          <ToolLine
            detail={serverId}
            failed={outcome.vendorError === true}
            label={bareName}
            running={status !== "complete"}
          >
            {outcome.text ? (
              /* The server's own words, drawn the way a Bot's prose is drawn. */
              <Streamdown components={markdownComponents}>
                {forDisplay(outcome.text)}
              </Streamdown>
            ) : null}
          </ToolLine>
        );
      },
    },
    [name, serverId, bareName],
  );

  return null;
}
