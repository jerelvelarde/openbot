import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  parseRepositoryId,
  type RepositoryAccess,
  type RepositoryStore,
} from "./store";

/**
 * The repositories screen, and the grants on it.
 *
 * CONNECTING IS AN ADMINISTRATOR'S DECISION; LISTING IS NOT. Anybody handing work to a coworker has
 * to be able to see which repositories exist and which Bots may reach them, or the compose dialog
 * cannot narrow its coworker list and a person picks a Bot whose run then refuses. What the list
 * does not carry is the credential — `hasAuth` is a boolean, because secrets are write-only here.
 */
export function createRepositoryRoutes(
  store: RepositoryStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) =>
    context.json({ repositories: await store.list() }),
  );

  routes.post("/", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      repo?: unknown;
      defaultBranch?: unknown;
      credentialId?: unknown;
    } | null;

    const named = parseRepositoryId(
      typeof body?.repo === "string" ? body.repo : "",
    );
    if (!named) {
      return context.json({ error: "Name the repository as owner/name." }, 400);
    }

    await store.connect({
      ...named,
      /*
       * The caller's answer, or `main`.
       *
       * Asked for rather than discovered, because discovering it means a call to the forge and this
       * route is reached before any credential has necessarily been chosen. A repository still on
       * `master` is a real case and the default would fail at the first checkout, so the field
       * exists; it is not required, because most of the time the default is right.
       */
      defaultBranch:
        typeof body?.defaultBranch === "string" && body.defaultBranch.trim()
          ? body.defaultBranch.trim()
          : "main",
      ...(typeof body?.credentialId === "string"
        ? { credentialId: body.credentialId }
        : {}),
    });

    const record = await store.find(named.id);
    return context.json({ repository: record });
  });

  /**
   * Replace the grant set for one repository.
   *
   * The repository id has a slash in it, so it arrives as a wildcard rather than a `:param`. Hono
   * would otherwise match only the owner and leave the name in a second segment this route never
   * declared, which reads as a 404 on a repository that plainly exists.
   */
  routes.put("/:owner/:name/grants", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const named = parseRepositoryId(
      `${context.req.param("owner")}/${context.req.param("name")}`,
    );
    if (!named) return context.json({ error: "No such repository." }, 404);
    if (!(await store.find(named.id))) {
      return context.json({ error: "No such repository." }, 404);
    }

    const body = (await context.req.json().catch(() => null)) as {
      grants?: unknown;
    } | null;
    if (!Array.isArray(body?.grants)) {
      return context.json({ error: "A grant set is required." }, 400);
    }

    const grants: { agentId: string; access: RepositoryAccess }[] = [];
    for (const raw of body.grants) {
      const entry = raw as { agentId?: unknown; access?: unknown };
      if (typeof entry.agentId !== "string" || !entry.agentId) {
        return context.json({ error: "Every grant needs a coworker." }, 400);
      }
      if (entry.access !== "read" && entry.access !== "contribute") {
        return context.json({ error: "Access is read or contribute." }, 400);
      }
      grants.push({ agentId: entry.agentId, access: entry.access });
    }

    await store.setGrants({
      repo: named.id,
      grants,
      by: context.var.actor.email,
    });
    return context.json({ repository: await store.find(named.id) });
  });

  routes.delete("/:owner/:name", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const named = parseRepositoryId(
      `${context.req.param("owner")}/${context.req.param("name")}`,
    );
    if (!named) return context.json({ error: "No such repository." }, 404);

    await store.forget(named.id);
    return context.json({});
  });

  return routes;
}
