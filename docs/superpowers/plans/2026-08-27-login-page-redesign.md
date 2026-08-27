# OpenBot Login Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing centered sign-in column with the approved responsive editorial-split OpenBot login page without changing authentication behavior.

**Architecture:** Keep routing, queries, state, and authentication handlers in `app/src/routes/sign.tsx`. Restructure only the rendered page: an animated sign-in pane remains the behavioral surface, while a local behavior-free `AmbientPanel` component provides CSS-only desktop decoration and disappears below the `lg` breakpoint. A focused Happy DOM component test renders the real route component with seeded React Query data, locking the new content, dynamic provider states, and responsive-panel contract before production JSX changes.

**Tech Stack:** React 19, TypeScript, TanStack Router and Query, Tailwind CSS v4, Motion, Bun test, Happy DOM, Testing Library.

---

## File Map

- **Create:** `app/tests/sign-page.test.tsx` — renders the real `/sign` route component against seeded provider options and verifies the approved page contract.
- **Modify:** `app/src/routes/sign.tsx` — preserves all existing authentication behavior while replacing the page structure and adding the CSS-only ambient panel.
- **Do not modify:** `app/src/styles.css` and shared UI primitives — the approved design is page-scoped and must not change the authenticated application.

### Task 1: Lock the approved sign-page contract with a failing component test

**Files:**
- Create: `app/tests/sign-page.test.tsx`
- Test: `app/tests/sign-page.test.tsx`

- [ ] **Step 1: Create the component test**

Create `app/tests/sign-page.test.tsx` with this complete content:

```tsx
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
  expect(
    view.getByText("Sign in to continue to your workspace."),
  ).toBeTruthy();
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
  expect(
    socialAndSso.getByPlaceholderText("you@company.com"),
  ).toBeTruthy();
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test app/tests/sign-page.test.tsx
```

Expected: FAIL in `presents the approved OpenBot editorial sign-in hierarchy` because the current page does not render the heading “Your AI workspace, ready when you are.” or the `[data-slot="sign-ambient"]` panel. The second test may pass because it captures behavior that already exists; the focused suite must remain red for the missing approved design.

### Task 2: Implement the editorial split without changing authentication behavior

**Files:**
- Modify: `app/src/routes/sign.tsx:93-190`
- Test: `app/tests/sign-page.test.tsx`

- [ ] **Step 1: Add the behavior-free ambient panel**

Insert this local component immediately above `SignScreen` in `app/src/routes/sign.tsx`:

```tsx
function AmbientPanel() {
  return (
    <aside
      aria-hidden="true"
      className="relative m-4 hidden min-h-0 overflow-hidden rounded-3xl bg-[linear-gradient(145deg,oklch(0.89_0.025_285),oklch(0.94_0.006_240)_44%,oklch(0.88_0.018_155))] lg:block dark:bg-[linear-gradient(145deg,oklch(0.24_0.025_285),oklch(0.19_0.008_240)_48%,oklch(0.23_0.018_155))]"
      data-slot="sign-ambient"
    >
      <div className="absolute -right-40 -top-28 size-[30rem] rounded-full border border-white/70 shadow-[0_0_0_4rem_rgba(255,255,255,0.13),0_0_0_8rem_rgba(255,255,255,0.09)] dark:border-white/15 dark:shadow-[0_0_0_4rem_rgba(255,255,255,0.035),0_0_0_8rem_rgba(255,255,255,0.02)]" />
      <div className="absolute -bottom-28 -left-20 size-72 rounded-full bg-[radial-gradient(circle_at_40%_35%,rgba(255,255,255,0.82),rgba(154,159,183,0.36)_48%,rgba(69,74,91,0.58))] shadow-2xl dark:opacity-55" />
      <p className="absolute left-7 top-7 max-w-[calc(100%-3.5rem)] break-words text-[0.65rem] font-medium uppercase tracking-[0.18em] text-foreground/40">
        {appConfig.brand.productName}
      </p>
      <p className="absolute bottom-7 right-7 text-xs text-foreground/40">
        Think · browse · act
      </p>
    </aside>
  );
}
```

This component must remain data-free except for the configured product name, non-interactive, and `aria-hidden`.

- [ ] **Step 2: Replace only the current return block**

In `SignScreen`, keep `opening`, `error`, `options`, `providers`, `email`, both submit handlers, reduced-motion handling, and the `hidden`/`shown` variants unchanged. Replace the current `return (...)` block with:

```tsx
  return (
    <div className="grid min-h-dvh w-full overflow-hidden bg-[#f7f7f4] lg:grid-cols-[52fr_48fr] dark:bg-background">
      <motion.main
        animate="shown"
        className="flex min-h-dvh items-center justify-center overflow-y-auto px-6 py-12 sm:px-10"
        initial="hidden"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS } },
        }}
      >
        <div className="w-full max-w-96">
          <motion.div
            className="flex items-center"
            transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
            variants={{ hidden, shown }}
          >
            <AgentOrb size="56px" />
          </motion.div>

          <motion.div
            className="mt-9"
            transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
            variants={{ hidden, shown }}
          >
            <p className="break-words text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {appConfig.brand.productName}
            </p>
            <h1 className="mt-3 max-w-sm text-[2rem] font-medium leading-[1.08] tracking-[-0.045em] text-balance sm:text-[2.2rem]">
              Your AI workspace, ready when you are.
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Sign in to continue to your workspace.
            </p>
          </motion.div>

          <motion.div
            className="mt-8 w-full"
            transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
            variants={{ hidden, shown }}
          >
            {providers.length > 0 ? (
              <div className="flex flex-col gap-2">
                {providers.map((provider) => (
                  <Button
                    className="h-11 w-full justify-start gap-3 bg-white px-3 tracking-tight shadow-xs dark:bg-input/30"
                    disabled={opening !== null}
                    key={provider}
                    onClick={() => handleSignIn(provider)}
                    size="lg"
                    variant="outline"
                  >
                    <ProviderLogo provider={provider} />
                    <span className="flex-1 text-center">
                      {opening === provider
                        ? `Opening ${providerName(provider)}…`
                        : `Continue with ${providerName(provider)}`}
                    </span>
                    <span aria-hidden="true" className="size-[18px]" />
                  </Button>
                ))}
              </div>
            ) : options?.sso ? null : (
              <p className="text-sm leading-6 text-muted-foreground">
                No sign-in provider is configured for this deployment.
              </p>
            )}

            {options?.sso ? (
              <form className="mt-3" onSubmit={handleDomainSignIn}>
                {providers.length > 0 ? (
                  <div className="mb-3 flex items-center gap-3">
                    <Separator className="flex-1" />
                    <span className="text-xs text-muted-foreground">or</span>
                    <Separator className="flex-1" />
                  </div>
                ) : null}
                <Input
                  autoComplete="email"
                  className="h-11 bg-white dark:bg-input/30"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  required
                  type="email"
                  value={email}
                />
                <Button
                  className="mt-2 h-11 w-full bg-white tracking-tight shadow-xs dark:bg-input/30"
                  disabled={opening !== null || email.trim().length === 0}
                  size="lg"
                  type="submit"
                  variant="outline"
                >
                  {opening === "sso"
                    ? "Opening…"
                    : "Continue with your company account"}
                </Button>
              </form>
            ) : null}

            {error ? (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <p className="mt-5 text-xs leading-5 text-muted-foreground/75">
              Secure sign-in managed by your organization
            </p>
          </motion.div>
        </div>
      </motion.main>

      <AmbientPanel />
    </div>
  );
```

Do not edit the authentication handlers while replacing this JSX. In particular, keep provider-specific opening state, the single shared disable gate, existing error messages, SSO email routing, and reduced-motion variant construction intact.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```bash
bun test app/tests/sign-page.test.tsx
```

Expected: PASS with 2 tests and no warnings or unhandled errors.

- [ ] **Step 4: Run the existing authentication tests**

Run:

```bash
bun test app/tests/auth-client.test.ts app/tests/auth-queries.test.ts
```

Expected: PASS. These tests confirm the unchanged provider naming, redirect initiation, error propagation, and server-driven provider query behavior.

- [ ] **Step 5: Format and re-run the focused tests**

Run:

```bash
bunx biome format --write app/src/routes/sign.tsx app/tests/sign-page.test.tsx
bun test app/tests/sign-page.test.tsx app/tests/auth-client.test.ts app/tests/auth-queries.test.ts
```

Expected: formatter exits 0; all focused tests PASS.

- [ ] **Step 6: Commit the tested redesign**

Run:

```bash
git add app/src/routes/sign.tsx app/tests/sign-page.test.tsx
git commit -m "feat: refresh the OpenBot sign-in page"
```

Expected: one commit containing only the sign page and its component test. Do not stage `server/tests/routing-service.test.ts` or any other pre-existing worktree change.

### Task 3: Verify responsive behavior and repository quality gates

**Files:**
- Verify: `app/src/routes/sign.tsx`
- Verify: `app/tests/sign-page.test.tsx`

- [ ] **Step 1: Run app type checking**

Run:

```bash
bun run --filter app typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 2: Run repository lint and formatting checks**

Run:

```bash
bun run format:check
bun run lint
```

Expected: both commands exit 0 with no warnings. If either reports an issue in a file outside this plan, record it as a pre-existing blocker and do not rewrite unrelated files.

- [ ] **Step 3: Run the full app test suite**

Run:

```bash
bun test app/tests app/src
```

Expected: all app tests PASS with no unhandled errors or warnings.

- [ ] **Step 4: Build the app production bundle**

Run:

```bash
bun run --filter app build
```

Expected: Vite production build exits 0 and writes the app bundle without missing-class, TypeScript, or asset errors.

- [ ] **Step 5: Inspect the page at required viewport states**

Start the existing development stack:

```bash
bun run dev
```

Open `http://localhost:3010/sign` and verify:

1. At 1440×900, the sign-in pane occupies 52% of the page and the ambient pane occupies 48% with an outer margin.
2. At 768×900, the ambient pane is absent and the form remains centered with comfortable horizontal padding.
3. At 320×568, the page has no horizontal overflow and can scroll vertically if required.
4. With reduced motion enabled, content fades without translating vertically.
5. In dark mode, the ambient gradient, muted text, buttons, and focus rings remain readable.
6. With the deployment’s configured providers, every expected button is visible and equally prominent.
7. If SSO is configured, the email field and company-account button remain below the separator; if it is the only configured route, no separator is rendered.

Expected: all seven checks pass. Stop the development stack after inspection.

- [ ] **Step 6: Confirm the final diff is scoped**

Run:

```bash
git status --short
git diff --check HEAD~1..HEAD
git show --stat --oneline HEAD
```

Expected: the redesign commit contains only `app/src/routes/sign.tsx` and `app/tests/sign-page.test.tsx`; the unrelated `server/tests/routing-service.test.ts` change remains unstaged and untouched.
