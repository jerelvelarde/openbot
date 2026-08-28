import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  connectionsQueryOptions,
  pluginKeys,
} from "../src/lib/plugins/queries";

const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});
afterAll(() => GlobalRegistrator.unregister());

test("personal API-key connections are strictly normalized before caching", async () => {
  const apiKey = "tf_secret_must_not_reach_cache";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        connections: [
          {
            serverId: "typefully",
            authMethod: "api_key",
            scope: null,
            accountLabel: "Product team",
            connectedAt: "2026-08-27T08:00:00.000Z",
            apiKey,
          },
        ],
        redirectUri: null,
        apiKey,
      }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const queryClient = new QueryClient();

  const result = await queryClient.fetchQuery(connectionsQueryOptions());

  expect(result).toEqual({
    connections: [
      {
        serverId: "typefully",
        authMethod: "api_key",
        scope: null,
        accountLabel: "Product team",
        connectedAt: "2026-08-27T08:00:00.000Z",
      },
    ],
    redirectUri: null,
  });
  expect(
    JSON.stringify(queryClient.getQueryData(pluginKeys.connections())),
  ).not.toContain(apiKey);
});

test("connects through a write-only field and never retains a successful key", async () => {
  const loaded = await import(
    "../src/components/typefully/connect-typefully"
  ).catch(() => undefined);
  expect(typeof loaded?.ConnectTypefully).toBe("function");
  if (!loaded) return;
  const apiKey = "tf_success_secret_must_disappear";
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        connection: {
          serverId: "typefully",
          authMethod: "api_key",
          accountLabel: "Product team",
          connectedAt: "2026-08-27T08:00:00.000Z",
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const queryClient = new QueryClient();
  let connected = 0;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <loaded.ConnectTypefully
        connection={null}
        onConnected={() => {
          connected += 1;
        }}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  const field = view.getByLabelText("Typefully API key") as HTMLInputElement;
  expect(field.type).toBe("password");
  expect(field.autocomplete).toBe("new-password");
  expect(
    view
      .getByRole("link", { name: "Open Typefully API settings" })
      .getAttribute("href"),
  ).toBe("https://typefully.com/settings/api");

  await user.type(field, apiKey);
  fireEvent.click(view.getByRole("button", { name: "Connect Typefully" }));

  await waitFor(() => expect(connected).toBe(1));
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("/api/plugins/connections/typefully/api-key");
  expect(requests[0]?.init?.method).toBe("PUT");
  expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({ apiKey });
  expect(field.value).toBe("");
  expect(view.container.textContent).not.toContain(apiKey);
  expect(view.container.innerHTML).not.toContain(apiKey);
  expect(window.location.href).not.toContain(apiKey);
  expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(
    apiKey,
  );
  expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain(
    apiKey,
  );
});

test("an invalid key stays only in the current field and supports retry", async () => {
  const { ConnectTypefully } = await import(
    "../src/components/typefully/connect-typefully"
  );
  const apiKey = "tf_invalid_current_form_only";
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(
        JSON.stringify({
          code: "invalid_api_key",
          error: `rejected ${apiKey}`,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        connection: {
          serverId: "typefully",
          authMethod: "api_key",
          accountLabel: null,
          connectedAt: "2026-08-27T08:00:00.000Z",
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConnectTypefully connection={null} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  const field = view.getByLabelText("Typefully API key") as HTMLInputElement;
  await user.type(field, apiKey);
  fireEvent.click(view.getByRole("button", { name: "Connect Typefully" }));

  expect((await view.findByRole("alert")).textContent).toContain(
    "Typefully did not accept that API key",
  );
  expect(field.value).toBe(apiKey);
  expect(view.container.textContent).not.toContain(apiKey);
  expect(JSON.stringify(queryClient)).not.toContain(apiKey);

  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(attempts).toBe(2));
  expect(field.value).toBe("");
});

test("cancelling key replacement clears the controlled secret before reopening", async () => {
  const { ConnectTypefully } = await import(
    "../src/components/typefully/connect-typefully"
  );
  const connection = {
    serverId: "typefully",
    authMethod: "api_key" as const,
    scope: null,
    accountLabel: "Product team",
    connectedAt: "2026-08-27T08:00:00.000Z",
  };
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectTypefully connection={connection} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Replace API key" }));
  const secret = "tf_replacement_must_be_erased";
  await user.type(view.getByLabelText("Typefully API key"), secret);
  await user.click(view.getByRole("button", { name: "Cancel" }));

  expect(view.container.innerHTML).not.toContain(secret);
  await user.click(view.getByRole("button", { name: "Replace API key" }));
  expect(
    (view.getByLabelText("Typefully API key") as HTMLInputElement).value,
  ).toBe("");
});

test("a Typefully timeout leaves an explicit retry without exposing the key", async () => {
  const { ConnectTypefully } = await import(
    "../src/components/typefully/connect-typefully"
  );
  const apiKey = "tf_timeout_form_only";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        code: "remote_timeout",
        error: `timed out for ${apiKey}`,
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectTypefully connection={null} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  await user.type(view.getByLabelText("Typefully API key"), apiKey);
  await user.click(view.getByRole("button", { name: "Connect Typefully" }));

  expect(await view.findByRole("button", { name: "Try again" })).toBeTruthy();
  expect(view.getByRole("alert").textContent).not.toContain(apiKey);
  expect(view.container.textContent).not.toContain(apiKey);
});

test("disconnect removes personal remote caches and returns to local state", async () => {
  const { ConnectTypefully } = await import(
    "../src/components/typefully/connect-typefully"
  );
  const methods: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    methods.push(init?.method ?? "GET");
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  let disconnected = 0;
  const queryClient = new QueryClient();
  const draft = { draft: { id: "local-draft", body: "Preserved" } };
  queryClient.setQueryData(["typefully", "draft", "local-draft"], draft);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConnectTypefully
        connection={{
          serverId: "typefully",
          authMethod: "api_key",
          scope: null,
          accountLabel: "Product team",
          connectedAt: "2026-08-27T08:00:00.000Z",
        }}
        onDisconnected={() => {
          disconnected += 1;
        }}
      />
    </QueryClientProvider>,
  );

  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: "Disconnect Typefully" }));

  await waitFor(() => expect(disconnected).toBe(1));
  expect(methods).toEqual(["DELETE"]);
  expect(view.getByLabelText("Typefully API key")).toBeTruthy();
  expect(
    view.getByText("Your OpenBot drafts stay available locally."),
  ).toBeTruthy();
  expect(
    queryClient.getQueryData(["typefully", "draft", "local-draft"]),
  ).toBeUndefined();
});

test("connected-account settings list both OAuth and personal API-key vendors", async () => {
  const settings = await import(
    "../src/routes/_authed/settings/connected-accounts/index"
  );
  const catalogue = [
    { key: "drive", auth: "user-oauth" as const },
    { key: "typefully", auth: "user-api-key" as const },
    { key: "shared", auth: "deployment-bearer" as const },
  ];

  expect(
    settings
      .personalConnectedAccountEntries(
        catalogue as Parameters<
          typeof settings.personalConnectedAccountEntries
        >[0],
        new Set(["drive", "typefully", "shared"]),
      )
      .map((entry) => entry.key),
  ).toEqual(["drive", "typefully"]);
});
