/**
 * The session this app holds, and how it got one.
 *
 * A phone cannot be handed a cookie, so sign-in happens in the system browser — where the person can
 * see the address bar and where this app never touches their password — and comes back through a deep
 * link carrying a single-use token. That is traded for a session token, which is kept in the
 * platform's secure store and sent as a bearer token afterwards.
 *
 * Two things are deliberate:
 *
 *  - **The token is never in app state, in a log, or in a prop.** It is read out of the secure store
 *    when a request needs it and put nowhere else. A token in a React tree ends up in a crash report.
 *  - **The web build does not use any of this.** Behind the dev proxy the API is same-origin and the
 *    browser's own session cookie is how it is known, which is why the recording works with no token.
 *    A build pointed at an absolute URL needs a real one, and says so if it has none.
 */

import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { Platform } from "react-native";

/** Where the token lives. One key, so signing out is one delete. */
const KEY = "openbot.session";

export type SessionState =
  /** Reading the store. Rendering a sign-in screen before knowing would flash it at somebody who is signed in. */
  | { status: "unknown" }
  /** Signed in, or not needing to be: see `cookies` below. */
  | { status: "signed-in"; cookies: boolean }
  | { status: "signed-out" }
  | { status: "failed"; reason: string };

export type Session = {
  state: SessionState;
  /** Open the system browser and complete sign-in. Resolves when the app has a token, or not. */
  signIn(): Promise<void>;
  signOut(): Promise<void>;
};

/**
 * The token, for the data layer.
 *
 * A function rather than a value, and outside React, because the data source is built once for the
 * life of the app and must see the token that exists NOW rather than the one that existed when it was
 * constructed.
 */
export async function readToken(): Promise<string | undefined> {
  if (!supportsSecureStore()) return undefined;
  return (await SecureStore.getItemAsync(KEY)) ?? undefined;
}

/**
 * Whether there is a secure store to use.
 *
 * There is not, on web. Falling back to `localStorage` would put a session token somewhere any script
 * on the page can read, so the web build simply has no token and relies on its cookie instead.
 */
function supportsSecureStore(): boolean {
  return Platform.OS !== "web";
}

const SessionContext = createContext<Session>({
  state: { status: "signed-out" },
  signIn: async () => {},
  signOut: async () => {},
});

export const useSession = () => useContext(SessionContext);

export function SessionProvider({
  baseUrl,
  children,
}: {
  /** The deployment to sign in to. Empty means same-origin, where the cookie already works. */
  baseUrl: string;
  children: ReactNode;
}) {
  const sameOrigin = baseUrl === "";
  const [state, setState] = useState<SessionState>(
    // Same-origin: the browser is already carrying whatever session it has, and there is nothing for
    // this app to hold or to ask for.
    sameOrigin || !supportsSecureStore()
      ? { status: "signed-in", cookies: true }
      : { status: "unknown" },
  );

  useEffect(() => {
    if (sameOrigin || !supportsSecureStore()) return;
    let cancelled = false;
    void readToken().then((token) => {
      if (cancelled) return;
      setState(
        token
          ? { status: "signed-in", cookies: false }
          : { status: "signed-out" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [sameOrigin]);

  const signIn = useCallback(async () => {
    if (sameOrigin) return;

    const returnTo = Linking.createURL("auth");
    const result = await WebBrowser.openAuthSessionAsync(
      `${baseUrl}/api/mobile/sign-in`,
      returnTo,
    );

    if (result.type !== "success") {
      // Dismissed, or the browser was closed. Not an error: somebody changed their mind.
      setState({ status: "signed-out" });
      return;
    }

    const handoff = Linking.parse(result.url);
    const error = single(handoff.queryParams?.error);
    if (error) {
      setState({
        status: "failed",
        reason:
          error === "not-signed-in"
            ? "Sign-in did not complete. Try again."
            : error,
      });
      return;
    }

    const oneTime = single(handoff.queryParams?.token);
    if (!oneTime) {
      setState({
        status: "failed",
        reason: "That deployment did not send a token back.",
      });
      return;
    }

    /**
     * Trade the one-time token for a session.
     *
     * The one-time token travelled through the operating system to get here and may be in a log; it is
     * spent on first use, so what is left in that log is worthless. The session it returns is what
     * goes in the secure store.
     */
    try {
      const response = await fetch(
        `${baseUrl}/api/auth/one-time-token/verify`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: oneTime }),
        },
      );
      if (!response.ok) {
        setState({
          status: "failed",
          reason: "That sign-in had expired. Try again.",
        });
        return;
      }
      const body = (await response.json()) as {
        session?: { token?: string };
        token?: string;
      };
      const session = body.session?.token ?? body.token;
      if (!session) {
        setState({
          status: "failed",
          reason: "That deployment did not return a session.",
        });
        return;
      }
      await SecureStore.setItemAsync(KEY, session);
      setState({ status: "signed-in", cookies: false });
    } catch {
      setState({
        status: "failed",
        reason: "Could not reach that deployment.",
      });
    }
  }, [baseUrl, sameOrigin]);

  const signOut = useCallback(async () => {
    if (supportsSecureStore()) await SecureStore.deleteItemAsync(KEY);
    setState({ status: "signed-out" });
  }, []);

  return (
    <SessionContext.Provider value={{ state, signIn, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

/** A query parameter, which the platform types as possibly a list. */
function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}
