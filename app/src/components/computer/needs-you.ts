import { useEffect, useState } from "react";
import { readControl } from "@/lib/computers/control";

/**
 * Poll a Bot's computer for control/secret prompts, so a blocked Bot can surface outside its screen.
 *
 * NOT "closed screens", which is what this said and what its one caller used to ask for. Gating the
 * poll on the screen being closed forced the answer to false exactly while somebody was answering the
 * prompt, so the first poll after they closed the pane reported the standing prompt as a fresh
 * arrival — and the dismissal they had just made was retired by it. `channel/$channelId.tsx` passes
 * `when: true` unconditionally for that reason; a `false` here is how that defect comes back, so it
 * is worth reading the dismissal reasoning in that file before narrowing this again.
 *
 * `when` therefore has exactly one caller and one value today. It is kept rather than dropped because
 * `botId === undefined` and "this surface does not want to poll" are different questions, and the
 * second one belongs to the caller.
 */

const INTERVAL_MS = 3_000;

export function useNeedsYou(botId: string | undefined, when: boolean): boolean {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    if (!botId || !when) {
      setNeeded(false);
      return;
    }

    let live = true;
    const check = async () => {
      const state = await readControl(botId).catch(() => null);
      if (!live) return;
      setNeeded(
        Boolean(state && (state.requested || state.secretWanted !== undefined)),
      );
    };

    void check();
    const timer = setInterval(() => void check(), INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [botId, when]);

  return needed;
}
