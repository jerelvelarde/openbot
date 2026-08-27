import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type {
  IntentRouter,
  RoutingCandidate,
  RoutingUndecided,
} from "./classify";

const DEV_ACTOR_EMAIL = "dev@openbot.local";
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;

export type CoworkerRouteResult =
  | {
      kind: "selected";
      agentId: string;
      name: string;
      reason: string;
      fallback: boolean;
      viaMention: boolean;
    }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "none" };

type RoutingActor = AgentActor & { email?: string };

export type CoworkerRoutingInput = {
  actor: RoutingActor;
  text: string;
  /** An explicit picker selection from a surface such as the web composer. */
  agentId?: string | null;
};

type CoworkerRouteDetail = {
  result: CoworkerRouteResult;
  /** Kept for surfaces that have historically returned the model's fallback cause. */
  undecided: RoutingUndecided | null;
};

export type CoworkerRoutingService = {
  route(input: CoworkerRoutingInput): Promise<CoworkerRouteResult>;
  routeDetailed(input: CoworkerRoutingInput): Promise<CoworkerRouteDetail>;
};

export type CreateCoworkerRoutingServiceOptions = {
  store: AgentProfileStore;
  router: IntentRouter;
  auditStore?: AuditStore;
  reachableSystems?: (agentId: string) => Promise<readonly string[]>;
};

/** Normalize people-facing names before matching, without making matching fuzzy. */
export function normalizeCoworkerName(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

function hasTokenBoundaries(text: string, start: number, end: number): boolean {
  const before = [...text.slice(0, start)].at(-1);
  const after = [...text.slice(end)][0];
  return !before || !WORD_CHARACTER.test(before)
    ? !after || !WORD_CHARACTER.test(after)
    : false;
}

function containsName(text: string, name: string): boolean {
  let start = text.indexOf(name);
  while (start >= 0) {
    if (hasTokenBoundaries(text, start, start + name.length)) return true;
    start = text.indexOf(name, start + name.length);
  }
  return false;
}

function visibleTo(actor: AgentActor, profile: AgentProfile): boolean {
  return (
    profile.deletedAt === null &&
    (profile.visibility === "public" ||
      profile.ownerUserId === actor.id ||
      actor.role === "admin")
  );
}

function actorId(actor: RoutingActor): string | undefined {
  return actor.id && actor.email !== DEV_ACTOR_EMAIL ? actor.id : undefined;
}

function suffixes(name: string): string[] {
  const tokens = name.split(" ");
  return tokens.slice(1).map((_, index) => tokens.slice(index + 1).join(" "));
}

function explicitNameRoute(
  text: string,
  roster: readonly AgentProfile[],
): CoworkerRouteResult | null {
  const normalizedText = normalizeCoworkerName(text);
  const fullMatches = roster.filter((profile) =>
    containsName(normalizedText, normalizeCoworkerName(profile.name)),
  );
  if (fullMatches.length === 1) {
    const [chosen] = fullMatches;
    if (!chosen) return null;
    return {
      kind: "selected",
      agentId: chosen.id,
      name: chosen.name,
      reason: "named by the person asking",
      fallback: false,
      viaMention: true,
    };
  }
  if (fullMatches.length > 1) {
    return {
      kind: "ambiguous",
      names: fullMatches
        .map(({ name }) => name)
        .sort((a, b) => a.localeCompare(b)),
    };
  }

  const candidatesBySuffix = new Map<string, AgentProfile[]>();
  for (const profile of roster) {
    for (const suffix of suffixes(normalizeCoworkerName(profile.name))) {
      if (!containsName(normalizedText, suffix)) continue;
      candidatesBySuffix.set(suffix, [
        ...(candidatesBySuffix.get(suffix) ?? []),
        profile,
      ]);
    }
  }
  const ambiguous = [...candidatesBySuffix.entries()]
    .filter(([, profiles]) => profiles.length > 1)
    .sort(([left], [right]) => right.length - left.length)[0]?.[1];
  if (!ambiguous) return null;
  return {
    kind: "ambiguous",
    names: ambiguous.map(({ name }) => name).sort((a, b) => a.localeCompare(b)),
  };
}

export function createCoworkerRoutingService(
  options: CreateCoworkerRoutingServiceOptions,
): CoworkerRoutingService {
  async function record(
    actor: RoutingActor,
    selected: Extract<CoworkerRouteResult, { kind: "selected" }>,
    candidates: readonly string[],
    undecided: RoutingUndecided | null,
  ): Promise<void> {
    if (!options.auditStore) return;
    await recordAuditEvent(options.auditStore, {
      eventType: "channel.routed",
      targetType: "agent",
      targetId: selected.agentId,
      ...(actorId(actor) ? { actorUserId: actorId(actor) } : {}),
      payload: {
        chosen: selected.agentId,
        reason: selected.reason,
        fallback: selected.fallback,
        viaMention: selected.viaMention,
        candidates,
        undecided,
      },
    });
  }

  async function routeDetailed(
    input: CoworkerRoutingInput,
  ): Promise<CoworkerRouteDetail> {
    // The store applies this same policy in SQL. Retaining this check makes the service's boundary
    // explicit to future store implementations and protects callers that provide a broader roster.
    const roster = (await options.store.list(input.actor, false)).filter(
      (profile) => visibleTo(input.actor, profile),
    );
    const namedId = input.agentId?.trim() || null;
    if (namedId) {
      const chosen = roster.find(({ id }) => id === namedId);
      if (!chosen) return { result: { kind: "none" }, undecided: null };
      const result: Extract<CoworkerRouteResult, { kind: "selected" }> = {
        kind: "selected",
        agentId: chosen.id,
        name: chosen.name,
        reason: "named by the person asking",
        fallback: false,
        viaMention: true,
      };
      await record(input.actor, result, [chosen.id], null);
      return { result, undecided: null };
    }

    if (roster.length === 0)
      return { result: { kind: "none" }, undecided: null };

    const explicit = explicitNameRoute(input.text, roster);
    if (explicit) {
      if (explicit.kind === "selected") {
        await record(input.actor, explicit, [explicit.agentId], null);
      }
      return { result: explicit, undecided: null };
    }

    const preferred =
      roster.find(({ visibility }) => visibility === "public") ?? roster[0];
    if (!preferred) return { result: { kind: "none" }, undecided: null };
    const candidates: RoutingCandidate[] = await Promise.all(
      roster.map(async (profile) => ({
        id: profile.id,
        name: profile.name,
        roleDescription: profile.roleDescription,
        ...(options.reachableSystems
          ? {
              reaches: await options
                .reachableSystems(profile.id)
                .catch(() => [] as readonly string[]),
            }
          : {}),
      })),
    );
    const decision = await options.router.route(
      input.text,
      candidates,
      preferred.id,
    );
    const result: Extract<CoworkerRouteResult, { kind: "selected" }> = {
      kind: "selected",
      agentId: decision.agentId,
      name: decision.name,
      reason: decision.reason,
      fallback: decision.fallback,
      viaMention: false,
    };
    await record(
      input.actor,
      result,
      candidates.map(({ id }) => id),
      decision.undecided,
    );
    return { result, undecided: decision.undecided };
  }

  return {
    async route(input) {
      return (await routeDetailed(input)).result;
    },
    routeDetailed,
  };
}
