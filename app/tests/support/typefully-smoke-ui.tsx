import { randomUUID } from "node:crypto";
import { ProxiedCopilotRuntimeAgent } from "@copilotkit/core";
import { CopilotKitCoreReact } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TypefullyConnectionArgs,
  TypefullyConnectionDecision,
} from "../../src/components/gallery/typefully-connection";
import {
  TypefullyPublicationArgs,
  TypefullyPublicationDecision,
} from "../../src/components/gallery/typefully-publication";
import { DraftCanvas } from "../../src/components/typefully/draft-canvas";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function absoluteApiFetch(
  apiUrl: string,
  original: typeof fetch,
): typeof fetch {
  return ((input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const target = /^https?:\/\//.test(raw) ? raw : new URL(raw, apiUrl).href;
    return original(target, init);
  }) as typeof fetch;
}

export async function createRunningComponentProtocol(input: {
  apiUrl: string;
  botId: string;
  handlers: Record<string, ToolHandler>;
}) {
  const tools = Object.entries(input.handlers).map(([name, handler]) => ({
    name,
    description: `Typefully smoke UI contract for ${name}`,
    handler,
    followUp: true,
    agentId: input.botId,
  }));
  const core = new CopilotKitCoreReact({
    credentials: "include",
    tools,
    deferInitialConnection: true,
  });
  const agent = new ProxiedCopilotRuntimeAgent({
    agentId: input.botId,
    runtimeAgentId: input.botId,
    runtimeUrl: `${input.apiUrl}/api/copilotkit`,
    credentials: "include",
    threadId: randomUUID(),
    transport: "sse",
    runtimeMode: "sse",
  });
  core.addAgent__unsafe_dev_only({ id: input.botId, agent });

  return {
    agent,
    async run(message: string) {
      agent.addMessage({ id: randomUUID(), role: "user", content: message });
      await core.runAgent({ agent });
    },
  };
}

export function openTypefullySmokeUi(apiUrl: string) {
  GlobalRegistrator.register();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = absoluteApiFetch(apiUrl, originalFetch);

  const client = () =>
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

  return {
    async editDraft(input: {
      draftId: string;
      xText: string;
      altText: string;
    }) {
      const queryClient = client();
      const view = render(
        <QueryClientProvider client={queryClient}>
          <DraftCanvas draftId={input.draftId} />
        </QueryClientProvider>,
      );
      const user = userEvent.setup({ document });
      const xEditor = await view.findByLabelText("X post 1");
      await user.clear(xEditor);
      await user.type(xEditor, input.xText);
      const alt = await view.findByLabelText("Alt text for image 1");
      await user.clear(alt);
      await user.type(alt, input.altText);
      await waitFor(
        () => {
          const statuses = view.getAllByText("Saved in OpenBot");
          if (statuses.length === 0) throw new Error("Draft is not saved yet.");
        },
        { timeout: 15_000 },
      );
      view.unmount();
      queryClient.clear();
    },

    async connectAndResume(input: {
      args: Record<string, unknown>;
      apiKey: string;
      respond: (result: unknown) => Promise<void>;
    }) {
      const args = TypefullyConnectionArgs.parse(input.args);
      const queryClient = client();
      const view = render(
        <QueryClientProvider client={queryClient}>
          <TypefullyConnectionDecision
            args={args}
            respond={input.respond}
            status="executing"
          />
        </QueryClientProvider>,
      );
      const user = userEvent.setup({ document });
      await user.type(
        await view.findByLabelText("Typefully API key"),
        input.apiKey,
      );
      await user.click(view.getByRole("button", { name: "Connect Typefully" }));
      await waitFor(
        () => {
          if (view.queryByText("Rechecking the draft and Typefully access…")) {
            throw new Error("The suspended sync is still resuming.");
          }
        },
        { timeout: 15_000 },
      );
      view.unmount();
      queryClient.clear();
    },

    async publish(input: {
      args: Record<string, unknown>;
      respond: (result: unknown) => Promise<void>;
    }) {
      const args = TypefullyPublicationArgs.parse(input.args);
      const queryClient = client();
      const view = render(
        <QueryClientProvider client={queryClient}>
          <TypefullyPublicationDecision
            args={args}
            respond={input.respond}
            status="executing"
          />
        </QueryClientProvider>,
      );
      const user = userEvent.setup({ document });
      await user.click(
        await view.findByRole("button", { name: "Publish now" }),
      );
      await waitFor(
        () => {
          if (!view.queryByText("Published")) {
            throw new Error("Publication has not reached a terminal state.");
          }
        },
        { timeout: 20_000 },
      );
      view.unmount();
      queryClient.clear();
    },

    close() {
      cleanup();
      globalThis.fetch = originalFetch;
      GlobalRegistrator.unregister();
    },
  };
}
