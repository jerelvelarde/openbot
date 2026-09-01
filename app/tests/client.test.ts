import { afterEach, describe, expect, test } from "bun:test";
import { client, serverMessage, unwrap } from "../src/lib/client";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A response with a body and a content type, which is what a real server sends. */
function answering(status: number, body: string, contentType: string) {
  globalThis.fetch = (async () =>
    new Response(status === 204 ? null : body, {
      status,
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
}

function answeringJSON(status: number, body: unknown) {
  answering(status, JSON.stringify(body), "application/json");
}

/**
 * A 200 CARRYING SOMETHING THAT IS NOT JSON, which is the failure every caller used to own itself.
 *
 * `client` handed the `Response` back for a caller with no envelope key, and each of them then did
 * `await response.json()` outside every guard — so a proxy's error page, a captive portal, or a dev
 * server answering the wrong route produced `SyntaxError: Unexpected token '<', "<html>"... is not
 * valid JSON`, which the sidebar renders as its empty-state title under `role="alert"` and above the
 * words "Nothing has been lost." The parse belongs inside the guard that owns the `fallback`
 * sentence, and these pin it there for both shapes of key.
 */
describe("a success whose body is not JSON", () => {
  test("says the endpoint's own sentence, not the parser's", async () => {
    answering(200, "<html><body>502 Bad Gateway</body></html>", "text/html");

    await expect(
      client("/api/channels/channel-1", "channel", {
        fallback: "Could not load this channel",
      }),
    ).rejects.toThrow("Could not load this channel");
  });

  test("keeps the parser's own complaint as the cause", async () => {
    answering(200, "<html>nope</html>", "text/html");

    // The same bargain the unanswered-request path strikes: the sentence is the endpoint's, and the
    // original is still there for a console, or for anything that needs to tell the two apart.
    const caught = await client("/api/roster", null, {
      fallback: "Could not load your conversations",
    }).catch((error: unknown) => error);

    expect((caught as Error).message).toBe("Could not load your conversations");
    expect((caught as Error).cause).toBeInstanceOf(SyntaxError);
  });

  test("still names something when the caller named nothing", async () => {
    answering(200, "not json", "text/plain");

    await expect(client("/api/roster", null)).rejects.toThrow(
      "That request failed.",
    );
  });
});

/**
 * AN ENVELOPE THAT DOES NOT CARRY THE KEY IT WAS ASKED FOR, which is the quieter half.
 *
 * Unwrapped unchecked, a missing key is `undefined` typed as `T` — and the type system then carries
 * the lie onward: `BotResolver` (routes/_authed/_app/bot_.$botChatId.tsx and bot.tsx) reads
 * `created.id` off it, the `TypeError` lands in a catch with nothing to say, and because the mutation
 * itself SUCCEEDED there is no error state for the screen to render. A blank screen, no console line,
 * after a row was written.
 */
describe("an envelope missing its key", () => {
  test("throws the endpoint's sentence rather than resolving undefined", async () => {
    answeringJSON(200, { botChat: undefined });

    await expect(
      client("/api/bot-chats", "botChat", {
        method: "POST",
        fallback: "Could not start this conversation",
      }),
    ).rejects.toThrow("Could not start this conversation");
  });

  test("names the missing key in the cause, where a console will find it", async () => {
    answeringJSON(200, { channel: undefined });

    const caught = await client("/api/channels", "channel", {
      fallback: "Could not start a channel",
    }).catch((error: unknown) => error);

    expect(String((caught as Error).cause)).toContain("channel");
  });

  test("a body that is not an object at all is the same failure", async () => {
    // A JSON `null` and a JSON array both index to `undefined` rather than throwing, so neither is
    // caught by the parse guard above; both are caught here.
    answeringJSON(200, null);

    await expect(
      client("/api/channels/channel-1", "channel", {
        fallback: "Could not load this channel",
      }),
    ).rejects.toThrow("Could not load this channel");
  });
});

/**
 * The three call shapes, which have to keep meaning what they mean: most of this app is on one of
 * them, and the `null` one exists because a paged list has no envelope to name.
 */
describe("client's call shapes", () => {
  test("a key unwraps the envelope", async () => {
    answeringJSON(200, { channel: { id: "channel-1" }, unrelated: 1 });

    expect(
      await client("/api/channels/channel-1", "channel", {
        fallback: "Could not load this channel",
      }),
    ).toEqual({ id: "channel-1" });
  });

  test("a null key means the body is the payload", async () => {
    answeringJSON(200, { items: [], nextCursor: "more" });

    expect(
      await client("/api/roster?status=active", null, {
        fallback: "Could not load your conversations",
      }),
    ).toEqual({ items: [], nextCursor: "more" });
  });

  test("no key still hands back the Response, for a caller that only needed it to work", async () => {
    answeringJSON(204, undefined);

    // Most of this app's writes are here: a 204 has no body to parse, and asking for one would make
    // every successful DELETE throw.
    const response = await client("/api/channels/channel-1", {
      method: "DELETE",
      fallback: "Could not delete this channel",
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(204);
  });

  test("options given alongside a key still reach the request", async () => {
    const seen: RequestInit[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ botChat: { id: "botchat-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await client("/api/bot-chats", "botChat", {
      method: "POST",
      body: { agentId: "agent-1" },
    });

    expect(seen[0]?.method).toBe("POST");
    expect(JSON.parse(String(seen[0]?.body))).toEqual({ agentId: "agent-1" });
  });
});

/**
 * The server's own message, which two callers on `tryClient` used to extract with hand-copied
 * duplicates of this — each carrying a comment saying it was a copy.
 */
describe("serverMessage", () => {
  test("gives the sentence the server sent", async () => {
    expect(
      await serverMessage(
        new Response(JSON.stringify({ error: "That name is taken." }), {
          status: 409,
        }),
      ),
    ).toBe("That name is taken.");
  });

  test("gives nothing for a body that is not JSON, rather than throwing", async () => {
    expect(
      await serverMessage(new Response("<html>502</html>", { status: 502 })),
    ).toBeUndefined();
  });

  test("gives nothing for an error that is not a sentence", async () => {
    // A shape drift here used to reach the screen as "[object Object]", which is worse than the
    // endpoint's own fallback: it names nothing and looks like a bug in the app rather than a refusal.
    expect(
      await serverMessage(
        new Response(JSON.stringify({ error: { message: "nested" } }), {
          status: 500,
        }),
      ),
    ).toBeUndefined();
    expect(
      await serverMessage(new Response(JSON.stringify(null), { status: 500 })),
    ).toBeUndefined();
  });
});

/**
 * `unwrap` on its own, because the two callers that read a status themselves — `tryClient` callers,
 * which `client` cannot serve — reach it directly and would otherwise be the only place its
 * behaviour is pinned.
 */
describe("unwrap", () => {
  test("unwraps, and refuses a missing key, given a response somebody else fetched", async () => {
    const envelope = () =>
      new Response(JSON.stringify({ botChat: { id: "botchat-1" } }), {
        status: 200,
      });

    expect(await unwrap(envelope(), "botChat", "Could not open this")).toEqual({
      id: "botchat-1",
    });
    await expect(
      unwrap(
        new Response(JSON.stringify({}), { status: 200 }),
        "botChat",
        "Could not open this",
      ),
    ).rejects.toThrow("Could not open this");
  });
});
