type JsonObject = { [key: string]: unknown };

function objectBody(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The fake Typefully vendor received a non-object body.");
  }
  return value as JsonObject;
}

function authoritativeDraft(
  id: string,
  body: JsonObject,
  previous?: JsonObject,
): JsonObject {
  const merged = { ...previous, ...body };
  const scheduled = typeof merged.plan_at === "string" ? merged.plan_at : null;
  return {
    ...merged,
    id: Number(id),
    status: scheduled === null ? "draft" : "planned",
    scheduled_date: scheduled,
  };
}

/** A loopback implementation of the official Typefully v2 draft contract used only by smoke tests. */
export function startFakeTypefullyVendor(apiUrl: string) {
  const parsed = new URL(apiUrl);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port
  ) {
    throw new Error(
      "OPENBOT_TYPEFULLY_SMOKE_API_URL must be http://127.0.0.1:<port>/v2.",
    );
  }
  let createDraftCalls = 0;
  let updateDraftCalls = 0;
  let publishCalls = 0;
  let sequence = 7000;
  const drafts = new Map<string, JsonObject>();
  const authorizations: Array<string | null> = [];
  const server = Bun.serve({
    hostname: parsed.hostname,
    port: Number(parsed.port),
    fetch: async (incoming) => {
      authorizations.push(incoming.headers.get("authorization"));
      const url = new URL(incoming.url);
      if (
        url.pathname === `${parsed.pathname}/me` &&
        incoming.method === "GET"
      ) {
        return Response.json({
          id: "smoke-account",
          name: "Fake Typefully smoke account",
          api_key_label: "Smoke only",
        });
      }
      const collection = new RegExp(
        `^${parsed.pathname}/social-sets/12/drafts/?$`,
      );
      const member = new RegExp(
        `^${parsed.pathname}/social-sets/12/drafts/(\\d+)$`,
      ).exec(url.pathname);
      if (collection.test(url.pathname) && incoming.method === "POST") {
        createDraftCalls += 1;
        sequence += 1;
        const id = String(sequence);
        const detail = authoritativeDraft(
          id,
          objectBody(await incoming.json()),
        );
        drafts.set(id, detail);
        return Response.json(detail);
      }
      if (member && incoming.method === "GET") {
        const stored = drafts.get(member[1] ?? "");
        return stored
          ? Response.json(stored)
          : Response.json({ detail: "missing" }, { status: 404 });
      }
      if (member && incoming.method === "PATCH") {
        const body = objectBody(await incoming.json());
        const id = member[1] ?? "";
        const previous = drafts.get(id);
        if (!previous) {
          return Response.json({ detail: "missing" }, { status: 404 });
        }
        if (body.publish_at === "now") {
          publishCalls += 1;
          const published = {
            ...previous,
            id: Number(id),
            publish_state: "finished",
            status: "published",
            x_published_url: `https://x.com/openbot/status/${id}`,
          };
          drafts.set(id, published);
          return Response.json(published);
        }
        updateDraftCalls += 1;
        const detail = authoritativeDraft(id, body, previous);
        drafts.set(id, detail);
        return Response.json(detail);
      }
      return Response.json(
        { detail: "unsupported smoke request" },
        { status: 404 },
      );
    },
  });

  return {
    apiUrl: `http://${parsed.hostname}:${server.port}${parsed.pathname}`,
    authorizations,
    get createDraftCalls() {
      return createDraftCalls;
    },
    get updateDraftCalls() {
      return updateDraftCalls;
    },
    get publishCalls() {
      return publishCalls;
    },
    close: () => server.stop(true),
  };
}
