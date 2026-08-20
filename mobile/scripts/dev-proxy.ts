/**
 * One origin for the web build of the companion, so it can talk to a real deployment.
 *
 * Development tooling, not product code, and it exists to avoid changing the product. The web app at
 * `:3010` reaches the API through a Vite proxy, so the server has no CORS configuration at all — and
 * it should not gain any just so a recording can be made. This does the same job Vite does: serves
 * the Expo bundle and forwards `/api` to the server, from a single origin, so the browser never makes
 * a cross-origin request.
 *
 * On a device none of this applies: a native client calls the API directly with a bearer token, which
 * is Phase 3 of the plan.
 *
 *   bun scripts/dev-proxy.ts            # :8090 -> expo :8081 + api :3001
 *   PORT=9000 API=http://host:3001 bun scripts/dev-proxy.ts
 */
const PORT = Number.parseInt(process.env.PORT ?? "8090", 10);
const API = process.env.API ?? "http://localhost:3001";
/**
 * The exported web build, rather than the Metro dev server.
 *
 * Metro assumes it is being served from its own origin and does not come up behind a proxy, so the
 * app is served from `expo export --platform web` output instead. That is also closer to what a real
 * build is, which is the right thing to be looking at in a recording.
 *
 *   EXPO_PUBLIC_OPENBOT_API=same-origin bunx expo export --platform web --output-dir dist
 */
const DIST = process.env.DIST ?? new URL("../dist", import.meta.url).pathname;

/** Forward a request unchanged, keeping the method, headers and body. */
async function forward(request: Request, base: string): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, base);

  const headers = new Headers(request.headers);
  // The upstream must see its own host, or the server's own URL construction and any cookie domain
  // are built from this proxy's address instead.
  headers.set("host", new URL(base).host);

  try {
    return await fetch(target.toString(), {
      method: request.method,
      headers,
      // GET and HEAD carry no body, and passing one is a TypeError rather than an empty request.
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: request.body }),
      redirect: "manual",
    });
  } catch (error) {
    return new Response(
      `dev-proxy could not reach ${target.origin}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      { status: 502 },
    );
  }
}

/**
 * A page for a Bot to act on.
 *
 * Served from here rather than pointed at somebody else's website, because a demonstration that
 * depends on a third party being up is one that stops working. It is a plain form with a button
 * called "Submit payment run", which is what the `ask` rule in the recording matches on.
 *
 * Reached from a Bot's container as `http://host.docker.internal:8090/demo/order`.
 */
const DEMO_ORDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Northwind Supplier Portal</title>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #f4f4f5; color: #18181b; }
  header { background: #18181b; color: #fafafa; padding: 14px 28px; font-weight: 600; }
  main { max-width: 620px; margin: 32px auto; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color: #71717a; margin: 0 0 24px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 16px 0 6px; }
  input, select { width: 100%; padding: 10px 12px; border: 1px solid #d4d4d8; border-radius: 8px; font: inherit; box-sizing: border-box; }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 14px; }
  th, td { text-align: left; padding: 8px 0; border-bottom: 1px solid #f4f4f5; }
  td.n, th.n { text-align: right; }
  .total { font-weight: 700; }
  .actions { display: flex; gap: 12px; margin-top: 28px; }
  button { padding: 11px 18px; border-radius: 8px; border: 1px solid #18181b; background: #18181b; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button.secondary { background: #fff; color: #18181b; border-color: #d4d4d8; }
</style></head>
<body>
  <header>Northwind Supplier Portal</header>
  <main>
    <h1>August payment run</h1>
    <p class="sub">Batch NW-2026-08 · prepared 19 August 2026</p>
    <form method="post" action="/demo/order">
      <label for="customer">Customer name</label>
      <input id="customer" name="customer" placeholder="Who this run is for">
      <label for="approver">Approver reference</label>
      <input id="approver" name="approver" placeholder="Optional">
      <table>
        <tr><th>Line</th><th class="n">Invoices</th><th class="n">Amount</th></tr>
        <tr><td>Logistics</td><td class="n">14</td><td class="n">£18,400.00</td></tr>
        <tr><td>Packaging</td><td class="n">9</td><td class="n">£11,650.00</td></tr>
        <tr><td>Cold storage</td><td class="n">14</td><td class="n">£18,160.00</td></tr>
        <tr class="total"><td>Total</td><td class="n">37</td><td class="n">£48,210.00</td></tr>
      </table>
      <div class="actions">
        <button type="submit" name="submit">Submit payment run</button>
        <button type="button" class="secondary">Save draft</button>
      </div>
    </form>
  </main>
</body></html>`;

const server = Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    // Everything the server owns, including the CopilotKit runtime under /api/copilotkit.
    if (pathname.startsWith("/api/")) return forward(request, API);

    if (pathname === "/demo/order") {
      // A POST lands here too, so the form has somewhere to go and the Bot sees a confirmation
      // rather than an error after it submits.
      if (request.method === "POST") {
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Submitted</title>
           <body style="font:15px/1.5 system-ui;margin:48px auto;max-width:560px">
           <h1 style="font-size:20px">Payment run submitted</h1>
           <p>Batch NW-2026-08 · 37 invoices · £48,210.00</p>
           <p style="color:#71717a">Reference NW-PR-4471.</p></body>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response(DEMO_ORDER, {
        headers: { "content-type": "text/html" },
      });
    }

    const file = Bun.file(
      `${DIST}${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (await file.exists()) return new Response(file);
    // Anything else is a client route: hand back the shell and let the app decide.
    return new Response(Bun.file(`${DIST}/index.html`), {
      headers: { "content-type": "text/html" },
    });
  },
});

console.info(
  `dev-proxy on http://localhost:${server.port} — app from ${DIST}, /api from ${API}`,
);
