import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { authKeys, type SignInOptions } from "@/lib/auth/queries";
import { Route } from "@/routes/sign";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const SignComponent = Route.options.component as ComponentType;

function renderSign(options: SignInOptions) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(authKeys.providers(), options);

  return render(
    <QueryClientProvider client={queryClient}>
      <SignComponent />
    </QueryClientProvider>,
  );
}

test("presents the approved OpenBot editorial sign-in hierarchy", () => {
  const view = renderSign({ providers: ["google"], sso: false });

  expect(
    view.getByRole("heading", {
      name: "Your AI workspace, ready when you are.",
    }),
  ).toBeTruthy();
  expect(view.getByText("Sign in to continue to your workspace.")).toBeTruthy();
  expect(
    view.getByText("Secure sign-in managed by your organization"),
  ).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Continue with Google" }),
  ).toBeTruthy();

  const ambient = view.container.querySelector(
    '[data-slot="sign-ambient"][aria-hidden="true"]',
  );
  expect(ambient).not.toBeNull();
  expect(ambient?.className).toContain("hidden");
  expect(ambient?.className).toContain("lg:block");
});

test("keeps social, company SSO, and no-provider states available", () => {
  const socialAndSso = renderSign({
    providers: ["google", "microsoft", "okta"],
    sso: true,
  });
  expect(
    socialAndSso.getByRole("button", { name: "Continue with Google" }),
  ).toBeTruthy();
  expect(
    socialAndSso.getByRole("button", { name: "Continue with Microsoft" }),
  ).toBeTruthy();
  expect(
    socialAndSso.getByRole("button", { name: "Continue with Okta" }),
  ).toBeTruthy();
  expect(socialAndSso.getByPlaceholderText("you@company.com")).toBeTruthy();
  expect(
    socialAndSso.getByRole("button", {
      name: "Continue with your company account",
    }),
  ).toBeTruthy();
  socialAndSso.unmount();

  const noProviders = renderSign({ providers: [], sso: false });
  expect(
    noProviders.getByText(
      "No sign-in provider is configured for this deployment.",
    ),
  ).toBeTruthy();
});
