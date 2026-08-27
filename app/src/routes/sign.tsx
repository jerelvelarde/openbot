import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  providerName,
  signInWith,
  signInWithEmailDomain,
} from "@/lib/auth/client";
import { appConfig } from "@/lib/generated/application-config";
import {
  consumePendingSlackReturn,
  signedInSlackRedirect,
} from "../lib/auth/pending-return";
import {
  type AuthProviderId,
  authProvidersQueryOptions,
  currentUserQueryOptions,
} from "../lib/auth/queries";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user) {
      if (typeof window !== "undefined") {
        const pendingReturn = consumePendingSlackReturn(window.sessionStorage);
        const returnTo = signedInSlackRedirect(location.href, pendingReturn);
        if (returnTo) throw redirect({ href: returnTo });
      }
      throw redirect({ to: "/" });
    }
    // Loaded here so the screen paints with its buttons rather than painting empty and then
    // growing them, which reads as "no providers" for exactly as long as the request takes.
    await context.queryClient.ensureQueryData(authProvidersQueryOptions());
  },
  component: SignScreen,
});

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

function SignScreen() {
  // Which provider is being opened, rather than whether one is: with three buttons, a single
  // boolean would put "Opening…" on all of them.
  const [opening, setOpening] = useState<AuthProviderId | "sso" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: options } = useQuery(authProvidersQueryOptions());
  const providers = options?.providers ?? [];
  const [email, setEmail] = useState("");

  /**
   * Sign in through whichever identity provider covers this address.
   *
   * No password is asked for and none is checked here: only the part after the @ is used, to decide
   * which registered provider to hand somebody to.
   */
  async function handleDomainSignIn(submission: React.FormEvent) {
    submission.preventDefault();
    setError(null);
    setOpening("sso");

    try {
      await signInWithEmailDomain(email);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "No identity provider is registered for that address.",
      );
      setOpening(null);
    }
  }

  async function handleSignIn(provider: AuthProviderId) {
    setError(null);
    setOpening(provider);

    try {
      await signInWith(provider);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `Could not start ${providerName(provider)} sign-in.`,
      );
      setOpening(null);
    }
  }

  const prefersReducedMotion = useReducedMotion();
  const hidden = {
    opacity: 0,
    ...(prefersReducedMotion ? {} : { transform: ENTRANCE_OFFSET }),
  };
  const shown = {
    opacity: 1,
    ...(prefersReducedMotion ? {} : { transform: "translateY(0px)" }),
  };

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
}
