/**
 * The one place the browser talks to the API server.
 *
 * WHAT THIS REPLACES. Every read opened with the same four lines — fetch with `credentials`, check
 * `ok`, throw a sentence, unwrap the envelope — and every entity that wrote more than once grew its
 * own private copy of the same request helper: `agentRequest`, `componentRequest`, and two others,
 * identical apart from the fallback sentence. Four copies of one function is four places for the
 * `body.error` extraction to be forgotten, and it had been, in more than one of them.
 *
 * WHAT IT DOES NOT DO. It owns the transport and nothing about meaning. The envelope key and the
 * sentence a person reads are per-endpoint facts, so they stay at the call site — a client that
 * guessed the envelope would be a client that had to be argued with.
 */

export type ClientOptions = {
  /** Absent means GET. */
  method?: string;
  /** Serialised as JSON, which is also what sets the content type. */
  body?: unknown;
  /**
   * What a person reads when the server sent no message of its own — or sent nothing at all.
   *
   * Name the entity in it — "Could not load coworkers" rather than "Request failed" — because this
   * is the sentence that reaches the screen when the server is the one that broke, and the one that
   * reaches it when the request never got as far as a server. `client` covers both; see it for how
   * the second one used to arrive on screen as the browser's own "Failed to fetch".
   */
  fallback?: string;
  /** For the calls a Bot makes on a person's behalf, which are abandoned when the turn is. */
  signal?: AbortSignal;
};

/**
 * What a person reads when neither the server nor the call site named anything.
 *
 * Written once because four paths in this file end in it — a rejected `fetch`, a refusal with no
 * message, a body that would not parse, and an envelope missing its key — and four copies of one
 * sentence is four things that drift. A call site that names its endpoint never sees it.
 */
const UNNAMED_FAILURE = "That request failed.";

/** Every request in this app is authenticated, and every one of them is JSON or nothing. */
async function send(path: string, options: ClientOptions): Promise<Response> {
  return fetch(path, {
    method: options.method,
    credentials: "include",
    headers:
      options.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * A request whose REFUSAL is a value rather than a throw.
 *
 * For the endpoints where a refusal is the answer: the gateway declining a component call, or the
 * catalogue announcement that is allowed to come back empty. Those callers read the status
 * themselves, and turning a refusal into an exception would make the boundary working look like the
 * boundary breaking.
 *
 * A REFUSAL, AND NOTHING WIDER THAN THAT. This is a bare `fetch`, and `fetch` resolves only when it
 * got a response: offline, a DNS failure, a CORS refusal and an abort all reject, so a status exists
 * here only once the server has actually spoken. Every caller therefore has two failures to think
 * about, not one, and the ones that care already do — `callComputer`
 * (lib/copilot/computer-tools.tsx) catches the rejection to tell an aborted run from a computer that
 * could not be reached, and `checkKnown` (lib/copilot/bot-thread.ts) catches it so an offline check
 * does not retire a remembered thread. A caller with nothing of its own to say about a rejection
 * wants `client` below instead, which turns one into the endpoint's own `fallback` sentence.
 *
 * This used to be documented as a request that "does not throw", and two fire-and-forget callers
 * were written against that: they reported activity through it, read nothing back, and were
 * therefore silent on the most likely failure there is. Both now go through `client`.
 */
export function tryClient(
  path: string,
  options: ClientOptions = {},
): Promise<Response> {
  return send(path, options);
}

/**
 * The server's own sentence for a response it refused, or `undefined` when it sent none.
 *
 * The useful one, because it names the field or the permission that failed where a `fallback` can
 * only name the thing being attempted. Every failing path in this file asks for it first.
 *
 * EXPORTED for the two callers that read a status themselves and so cannot use `client`:
 * `adoptBotChatMutationOptions` (lib/bot-chats/mutations.ts) and `botChatQueryOptions`
 * (lib/bot-chats/queries.ts). Both carried hand-copied duplicates of these four lines, each under a
 * comment saying it was a copy — which is the same "four copies of one request helper" this module
 * exists to end, one level down.
 *
 * NEVER THROWS, and never answers with something that is not a sentence. A body that is not JSON, a
 * JSON `null`, a JSON array, and an `error` that is an object rather than a string all come back
 * `undefined` — which is what lets every caller write `message ?? fallback` and mean it. The last of
 * those used to reach a screen as "[object Object]", a string that names nothing and reads as a bug
 * in this app rather than as a refusal by the server.
 */
export async function serverMessage(
  response: Response,
): Promise<string | undefined> {
  return response
    .json()
    .then((body: { error?: unknown }) =>
      typeof body.error === "string" ? body.error : undefined,
    )
    .catch(() => undefined);
}

/**
 * The payload out of a response that has already been decided a success.
 *
 * `key` names the field the payload arrived wrapped in — `"channel"`, `"botChat"` — or is `null` for
 * the endpoints whose body IS the payload, which is how a paged list arrives and why `null` is a key
 * here rather than an absent one.
 *
 * BOTH FAILURES END IN `fallback`, for the same reason a refusal and an unanswered request do in
 * `client` below, and this is where that promise was being broken.
 *
 * A 200 IS NOT A PROMISE OF JSON. A proxy's error page, a captive portal, a dev server answering the
 * wrong route: all of them answer 200 with HTML. Every caller with no envelope key used to be handed
 * the `Response` and parse it outside every guard, so `SyntaxError: Unexpected token '<', "<html>"…
 * is not valid JSON` was what reached the screen — rendered by the sidebar as its empty-state title,
 * under `role="alert"`, above the words "Nothing has been lost." The parse belongs inside the guard
 * that owns the sentence, which is here.
 *
 * AND AN ENVELOPE MISSING ITS KEY is the quieter half. Unwrapped unchecked it yields `undefined`
 * typed as `T`, and the type system then carries that lie onward: the Bot resolver
 * (routes/_authed/_app/bot.tsx) reads `created.id` off it, the `TypeError` lands in a catch with
 * nothing to say, and because the mutation itself SUCCEEDED there is no error state for the screen to
 * render at all — a permanently blank screen, no console line, after a row was written. Drift between
 * this app and its server is worth a sentence a person can report.
 *
 * EXPORTED for the same two `tryClient` callers as `serverMessage`: their success paths parse their
 * own envelopes, and had both holes.
 */
export async function unwrap<T>(
  response: Response,
  key: string | null,
  fallback?: string,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // The parser's own complaint is kept as `cause` rather than thrown, exactly as the rejected
    // `fetch` below keeps "Failed to fetch": a console still has it, and the screen does not.
    throw new Error(fallback ?? UNNAMED_FAILURE, { cause: error });
  }

  if (key === null) return body as T;

  const payload = (body as Record<string, T> | null | undefined)?.[key];
  if (payload === undefined) {
    /*
     * A `cause` and not a message, because "the response carried no botChat" is a sentence about
     * this app's wiring and not one a person can act on. The endpoint's own sentence is what they
     * read; this is what whoever they report it to reads.
     *
     * `undefined` rather than `key in body`, so a key present with no value fails the same way a
     * missing one does — JSON cannot express `undefined`, so nothing legitimate is refused here.
     */
    throw new Error(fallback ?? UNNAMED_FAILURE, {
      cause: new Error(`The response carried no "${key}".`),
    });
  }
  return payload;
}

/**
 * A request that throws when it does not work, carrying the server's own message when there is one.
 *
 * With a `key`, the JSON body is parsed and that key unwrapped, so a caller receives the payload
 * rather than the envelope it arrived in. With `null` for the key, the parsed body itself is the
 * payload, for the endpoints that send no envelope. Without either, the `Response` is returned for a
 * caller that only needed to know it worked — which is most of this app's writes, because a 204 has
 * no body to parse and asking for one would make every successful DELETE throw.
 *
 * THE KEY IS WHAT MAKES THIS RETURN DATA, and that is deliberate in the type signature: a caller
 * that wants the payload has to say so, and in saying so it hands the parse to the guard that holds
 * its `fallback`. The shape it replaces — hand back the `Response`, let the caller call `.json()` —
 * is still available and still correct for a caller with no body to read, but it is no longer the way
 * to read one. See `unwrap` for what was arriving on screen while it was.
 *
 * EVERY WAY OF FAILING ENDS IN `fallback`, which is what makes that option mean what its docblock
 * says. A server that says no is one; a request that never got an answer at all is the second, and
 * the most common of them; a body that is not JSON is the third; an envelope missing its key is the
 * fourth.
 */
export async function client<T>(
  path: string,
  key: string | null,
  options?: ClientOptions,
): Promise<T>;
export async function client(
  path: string,
  options?: ClientOptions,
): Promise<Response>;
export async function client<T>(
  path: string,
  keyOrOptions?: string | null | ClientOptions,
  maybeOptions?: ClientOptions,
): Promise<T | Response> {
  /*
   * `null` is a key, not the absence of one, so this cannot be the bare `typeof … === "string"`
   * check it used to be: `typeof null === "object"`, so a caller asking for the whole body would
   * have had its key read as its options and been handed the `Response` it was trying not to parse.
   */
  const key =
    keyOrOptions === null || typeof keyOrOptions === "string"
      ? keyOrOptions
      : undefined;
  const options =
    (typeof keyOrOptions === "object" && keyOrOptions !== null
      ? keyOrOptions
      : maybeOptions) ?? {};

  let response: Response;
  try {
    response = await send(path, options);
  } catch (error) {
    /*
     * A REQUEST THAT NEVER GOT AN ANSWER — offline, a DNS failure, a CORS refusal — which is what
     * `fetch` reports by rejecting rather than by a status.
     *
     * Only `!response.ok` below used to reach `fallback`, so this path skipped it entirely and the
     * browser's own console wording went to the screen instead: Chrome's "Failed to fetch" and
     * Safari's "Load failed" were rendered as the sidebar's empty-state title, under `role="alert"`
     * and above a Try again button — the empty-state work exists to stop a void being read as "my
     * conversations are gone", and a browser-internal string is not better. That one is the loudest
     * of them and not the only one: every screen that renders an `error.message` off a `client` call
     * had the same hole under it.
     *
     * The endpoint's own sentence is what a person can act on, so it is thrown here too. The
     * original is kept as `cause`, which is where a console still finds "Failed to fetch" and where
     * the two failures can still be told apart by anything that cares.
     */
    // An abort is this app abandoning its own request. It is passed through untouched, because the
    // caller that supplied the signal is the only one that knows what its abort meant, and none of
    // them wants a sentence about it on a screen.
    if (options.signal?.aborted) throw error;
    throw new Error(options.fallback ?? UNNAMED_FAILURE, {
      cause: error,
    });
  }

  if (!response.ok) {
    /*
     * The server's message is the useful one: it names the field or the permission that failed. The
     * fallback is only for the cases where it sent none, or sent something that is not JSON — see
     * `serverMessage`, which is the extraction, and which never throws.
     */
    throw new Error(
      (await serverMessage(response)) ?? options.fallback ?? UNNAMED_FAILURE,
    );
  }

  if (key === undefined) return response;

  return unwrap<T>(response, key, options.fallback);
}
