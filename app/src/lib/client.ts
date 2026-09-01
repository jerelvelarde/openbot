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
 * A request that throws when it does not work, carrying the server's own message when there is one.
 *
 * With a `key`, the JSON body is parsed and that key unwrapped, so a caller receives the payload
 * rather than the envelope it arrived in. Without one, the `Response` is returned for a caller that
 * only needed to know it worked.
 *
 * BOTH WAYS OF FAILING END IN `fallback`, which is what makes that option mean what its docblock
 * says. A server that says no is one of them; a request that never got an answer at all is the
 * other, and it is the more common one.
 */
export async function client<T>(
  path: string,
  key: string,
  options?: ClientOptions,
): Promise<T>;
export async function client(
  path: string,
  options?: ClientOptions,
): Promise<Response>;
export async function client<T>(
  path: string,
  keyOrOptions?: string | ClientOptions,
  maybeOptions?: ClientOptions,
): Promise<T | Response> {
  const key = typeof keyOrOptions === "string" ? keyOrOptions : undefined;
  const options =
    (typeof keyOrOptions === "string" ? maybeOptions : keyOrOptions) ?? {};

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
    throw new Error(options.fallback ?? "That request failed.", {
      cause: error,
    });
  }

  if (!response.ok) {
    /*
     * The server's message is the useful one: it names the field or the permission that failed. The
     * fallback is only for the cases where it sent none, or sent something that is not JSON.
     */
    const message = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => undefined);
    throw new Error(message ?? options.fallback ?? "That request failed.");
  }

  if (key === undefined) return response;

  return ((await response.json()) as Record<string, T>)[key];
}
