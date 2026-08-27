import { tryClient } from "@/lib/client";

/**
 * Handing control of a Bot's computer to a person, and back.
 *
 * Plain functions rather than factories, and every one of them fails closed. Nothing here is cached:
 * who holds the wheel is a fact about this second, and a stale copy of it would be worse than no
 * copy — it would show somebody a screen they cannot drive, or let them think they can.
 *
 * The reads answer `null` on failure rather than throwing. A panel that cannot say who is driving
 * should say nothing, not tear down the screen the person is looking at.
 */

export type ControlState = {
  holder: "bot" | "human";
  since: string;
  reason?: string;
  requested: boolean;
  /** What the Bot is waiting for, by name only. Present means show the masked prompt. */
  secretWanted?: string;
  /**
   * Whose site the field is on, as the computer saw it when the Bot asked.
   *
   * Shown beside the masked box, because "the assistant needs your password" with no address on it is
   * a prompt that cannot be checked — and the page it refers to was chosen by the site the Bot is on
   * rather than by anybody here. The computer refuses the value if the browser has moved off that
   * page since; this is so a person can refuse it first.
   */
  secretOrigin?: string;
};

async function callControl(
  computerId: string,
  path: string,
  method?: string,
): Promise<ControlState | null> {
  const response = await tryClient(
    `/api/computers/${computerId}${path}`,
    method ? { method } : {},
  );
  if (!response.ok) return null;
  return (await response.json()) as ControlState;
}

export function readControl(computerId: string) {
  return callControl(computerId, "/control");
}

export function takeControl(computerId: string) {
  return callControl(computerId, "/control/take", "POST");
}

export function releaseControl(computerId: string) {
  return callControl(computerId, "/control/release", "POST");
}

/**
 * Supply a secret synchronously and never echo the value back to the UI.
 *
 * The one call here that reports why it failed, because a person is waiting on the answer and a
 * silent failure would leave them typing into something that is not listening.
 */
export async function supplySecret(
  computerId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/human/secret`,
      { method: "POST", body: { text } },
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { ok: false, error: body?.error ?? "That could not be entered." };
  } catch {
    return {
      ok: false,
      error: "The assistant's computer could not be reached.",
    };
  }
}
