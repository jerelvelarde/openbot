import { afterEach, describe, expect, test } from "bun:test";
import { callComputer } from "../src/lib/copilot/computer-tools";

/**
 * What a Bot is told when its action did not happen.
 *
 * Every refusal reaches the model as this object, and the fields decide what it does next: `staleRefs`
 * is the one its own tool description turns into "the page changed, call this again with the new
 * refs", so labelling a takeover with it sends the Bot back round the same action against the person
 * who just took the browser. The server carries `humanHasControl` for exactly that reason; this is
 * the end of that wire, and the only place the two conditions are told apart for the model.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function serverAnswering(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** A server answering with a status and a body the client cannot read, as a real one does. */
function serverAnsweringUnreadably(status: number, body: string) {
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;
}

describe("a computer call the server refused", () => {
  test("a person holding the wheel is reported as that, not as stale refs", async () => {
    serverAnswering(409, {
      error: "A person has taken control of this computer.",
      humanHasControl: true,
    });

    const outcome = await callComputer("bot-1", "/click", { method: "POST" });

    expect(outcome.ok).toBe(false);
    expect(outcome.humanHasControl).toBe(true);
    // The instruction that must not be attached: it would send the Bot round again.
    expect(outcome.staleRefs).toBeUndefined();
    expect(outcome.reason).toBe("A person has taken control of this computer.");
  });

  test("a stale snapshot is still reported as stale refs", async () => {
    // The half that must not move. Losing this would park a Bot with genuinely stale refs waiting for
    // a person who is not coming.
    serverAnswering(409, { error: "Snapshot 3 is not the current one." });

    const outcome = await callComputer("bot-1", "/click", { method: "POST" });

    expect(outcome.ok).toBe(false);
    expect(outcome.staleRefs).toBe(true);
    expect(outcome.humanHasControl).toBeUndefined();
  });

  test("a policy refusal is neither", async () => {
    serverAnswering(403, {
      error: "That is not allowed here.",
      rule: 'url.host == "example.com"',
    });

    const outcome = await callComputer("bot-1", "/click", { method: "POST" });

    expect(outcome.refused).toBe(true);
    expect(outcome.staleRefs).toBeUndefined();
    expect(outcome.humanHasControl).toBeUndefined();
  });
});

describe("a computer call with no readable reason", () => {
  /*
   * The case that put a fabricated sentence in front of a person.
   *
   * While this deployment was crash-looping, every computer call came back with a status and a body
   * that was not JSON. `body.error` was absent, the model was handed "That did not work.", and
   * having no way to say the computer was unreachable it invented one: that no browser was
   * available to it. These pin the three sentences that replace that.
   */

  test("no computer on the deployment says so, and tells the Bot not to guess", async () => {
    // The routes are not mounted, so Hono answers 404 with plain text.
    serverAnsweringUnreadably(404, "404 Not Found");

    const outcome = await callComputer("bot-1", "/navigate", {
      method: "POST",
    });

    expect(outcome.ok).toBe(false);
    // What the client observed, not a claim about configuration it cannot check: a renamed route
    // or an edge 404 reaches here too.
    expect(String(outcome.reason)).toContain(
      "no computer endpoint on this deployment",
    );
    expect(String(outcome.reason)).toContain("rather than guessing");
    // Not a refusal and not stale: nothing was decided and no snapshot moved.
    expect(outcome.refused).toBeUndefined();
    expect(outcome.staleRefs).toBeUndefined();
  });

  test("an unreachable computer is named as this deployment's fault", async () => {
    for (const status of [502, 503, 504]) {
      serverAnsweringUnreadably(
        status,
        "<html>Application failed to respond</html>",
      );

      const outcome = await callComputer("bot-1", "/navigate", {
        method: "POST",
      });

      expect(outcome.ok).toBe(false);
      expect(String(outcome.reason)).toContain("cannot be reached");
      // The instruction that stops the invented explanation.
      expect(String(outcome.reason)).toContain(
        "do not offer a reason of your own",
      );
    }
  });

  test("anything else admits there is no reason available", async () => {
    serverAnsweringUnreadably(500, "Internal Server Error");

    const outcome = await callComputer("bot-1", "/navigate", {
      method: "POST",
    });

    expect(outcome.ok).toBe(false);
    expect(String(outcome.reason)).toContain("gave no reason");
    // No digits at all, rather than merely not this status: a check for "500" would pass just as
    // happily if the code started embedding some other number.
    expect(String(outcome.reason)).not.toMatch(/\d/);
  });

  test("a JSON body whose error is not a sentence is still nothing readable", async () => {
    // `??` alone only catches null and undefined. These all parse, so the old guard handed the
    // model an empty string or "[object Object]" — in the exact case the fallback existed for.
    for (const error of ["", "   ", { code: 502 }, 502, null]) {
      serverAnswering(503, { error });

      const outcome = await callComputer("bot-1", "/navigate", {
        method: "POST",
      });

      expect(outcome.ok).toBe(false);
      expect(String(outcome.reason)).toContain("cannot be reached");
    }
  });

  test("fetch failing outright also tells the Bot not to invent a reason", async () => {
    // No status to reason from at all, which is the case likeliest to produce an invention.
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const outcome = await callComputer("bot-1", "/navigate", {
      method: "POST",
    });

    expect(outcome.ok).toBe(false);
    expect(String(outcome.reason)).toContain(
      "do not offer a reason of your own",
    );
  });

  test("a reason the server did give is still preferred over any of these", async () => {
    // The status-based sentences are a fallback, never an override.
    serverAnswering(404, { error: "That Bot has no computer." });

    const outcome = await callComputer("bot-1", "/navigate", {
      method: "POST",
    });

    expect(outcome.reason).toBe("That Bot has no computer.");
  });
});
