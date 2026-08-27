# OpenBot Login Page Redesign

## Goal

Replace the existing compact centered login column with a clean OpenBot-branded editorial split layout. The redesign should feel calm and intentional while preserving every existing authentication path and state.

## Approved Direction

The approved direction is **Editorial split**:

- A focused sign-in pane occupies the left side of the desktop viewport.
- A quiet ambient visual pane occupies the right side.
- The visual language is OpenBot minimal rather than the more expressive CopilotKit glass-and-blur theme.
- On narrow screens, the ambient pane disappears and the sign-in pane uses the full viewport.

The page should not read like a marketing landing page. It has one job: orient the user and help them sign in.

## Content Hierarchy

The sign-in pane presents, in order:

1. The existing animated `AgentOrb` at a modest size.
2. A small uppercase product-name kicker sourced from `appConfig.brand.productName` (shown as `OpenBot` in the approved mockup).
3. The headline: “Your AI workspace, ready when you are.”
4. The supporting line: “Sign in to continue to your workspace.”
5. The configured social-provider buttons.
6. The existing optional company-email SSO form, separated from social providers when both are present.
7. A small reassurance line: “Secure sign-in managed by your organization.”
8. Any authentication error immediately below the relevant controls.

The configured `appConfig.brand.productName` remains the source of every rendered product name. The approved OpenBot presentation must therefore continue to work for deployments that override that name.

## Layout and Visual Treatment

### Desktop

- Fill the viewport without the existing negative top offset.
- At the `lg` breakpoint and above, use a 52% sign-in pane and 48% ambient pane.
- Center a form column with a maximum width of 24rem inside the left pane.
- Use the application’s existing neutral type and color tokens rather than changing global fonts or theme variables.
- Keep the page background warm-neutral and low contrast.
- Give the right pane a softly layered neutral gradient, fine rings, and a restrained abstract orb treatment. It must use CSS only; no remote image or new bitmap asset is required.
- Keep decoration behind content, non-interactive, hidden from assistive technology, and unable to affect page overflow.

### Mobile and Narrow Screens

- Below the `lg` breakpoint, remove the ambient visual pane entirely.
- Show only the sign-in pane with generous horizontal padding.
- Keep the form vertically centered where viewport height permits, while allowing normal scrolling on short screens.
- Preserve a minimum supported width of 20rem.

## Authentication Behavior

The redesign is presentation-only. It must preserve:

- Google, Microsoft, and Okta provider buttons from `options.providers`.
- Provider-specific opening labels and the rule that all controls disable while one provider is opening.
- Runtime-registered SAML/OIDC routing through the email form when `options.sso` is enabled.
- The no-provider message when neither social providers nor SSO is configured.
- Existing error messages from `signInWith` and `signInWithEmailDomain`.
- Redirecting an already authenticated user away from `/sign`.

No new API calls, authentication rules, analytics, or domain restrictions are part of this change.

## Motion and Accessibility

- Retain the existing gentle entrance animation and stagger, adapted to the new content groups.
- Continue honoring `prefers-reduced-motion`; reduced-motion users receive opacity-only entrance behavior.
- Keep provider marks and button labels balanced and centered.
- Preserve visible keyboard focus styles supplied by the shared button and input primitives.
- Keep the error container exposed with `role="alert"`.
- Mark the ambient pane and its decoration `aria-hidden="true"`.
- Maintain readable contrast for muted text and controls in both light and dark application themes.

## Component Boundaries

Keep authentication state and handlers in `SignScreen`. Extract the ambient visual pane into a small local component only if doing so makes the route easier to read; it receives no data and owns no behavior. Continue using the shared `Button`, `Input`, `Separator`, `ProviderLogo`, and `AgentOrb` components.

Avoid global styling changes. Page-specific styling should use utility classes and, only where the layered ambient artwork requires it, a small colocated component structure. Do not change shared UI primitives for this page.

## Error and Edge States

- Long branded product names must wrap without overlapping the ambient pane.
- One, two, or three provider buttons must fit without changing the hierarchy.
- When social providers and SSO are both enabled, the separator and email form remain visually subordinate but clearly available.
- When only SSO is enabled, omit the separator.
- When no provider is configured, the explanatory message occupies the control area without leaving a misleading empty button frame.
- Authentication errors must remain in the sign-in pane and must not cause horizontal layout movement.

## Verification

Implementation verification should include:

- A focused component test for the approved headline, supporting copy, configured-provider rendering, and optional SSO states.
- A failing-first test before production changes, following the repository’s TDD workflow.
- Existing app type checking and linting.
- A production build.
- Visual inspection at desktop and mobile widths, including a short viewport and reduced-motion mode.
- A check that the social-provider click and company-email submission still call their existing authentication helpers and expose failures as alerts.

## Out of Scope

- Changing the OAuth audience or allowed email domains.
- Adding passwords, passkeys, magic links, account creation, or recovery flows.
- Changing global application typography or the authenticated application shell.
- Adding marketing copy, customer logos, product screenshots, or remote decorative assets.
