const PENDING_SLACK_RETURN_KEY = "openbot.pending-slack-return";
const PENDING_SLACK_RETURN_MS = 10 * 60_000;

type SessionStorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type PendingSlackReturn = {
  path: string;
  expiresAt: number;
};

/**
 * The only return URL allowed through the sign-in handoff. It deliberately carries no origin,
 * arbitrary route, fragment, or duplicate query field, so this record can never become an open
 * redirect or be forwarded to an identity provider.
 */
export function pendingSlackReturnPath(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;

  const url = new URL(value, "https://openbot.invalid");
  if (
    url.pathname !== "/link/slack" ||
    url.hash !== "" ||
    [...url.searchParams.keys()].length !== 1 ||
    url.searchParams.getAll("token").length !== 1
  ) {
    return null;
  }

  const token = url.searchParams.get("token")?.trim();
  return token ? `/link/slack?token=${encodeURIComponent(token)}` : null;
}

export function savePendingSlackReturn(
  value: string,
  storage: SessionStorageLike,
  now = Date.now(),
): boolean {
  const path = pendingSlackReturnPath(value);
  if (!path) return false;

  try {
    storage.setItem(
      PENDING_SLACK_RETURN_KEY,
      JSON.stringify({ path, expiresAt: now + PENDING_SLACK_RETURN_MS }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Always removes the record before inspecting it, so a return is strictly one-time. */
export function consumePendingSlackReturn(
  storage: SessionStorageLike,
  now = Date.now(),
): string | null {
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_SLACK_RETURN_KEY);
    storage.removeItem(PENDING_SLACK_RETURN_KEY);
  } catch {
    return null;
  }

  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Partial<PendingSlackReturn>;
    if (
      typeof record.path !== "string" ||
      typeof record.expiresAt !== "number"
    ) {
      return null;
    }
    if (record.expiresAt <= now) return null;
    return pendingSlackReturnPath(record.path);
  } catch {
    return null;
  }
}

/** Prevents the authenticated boundary from redirecting to the route it is already loading. */
export function signedInSlackRedirect(
  currentHref: string,
  pendingReturn: string | null,
): string | null {
  const path = pendingReturn ? pendingSlackReturnPath(pendingReturn) : null;
  return path && path !== currentHref ? path : null;
}
