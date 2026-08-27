import { canAccessAgent } from "../agents/profile-policy";
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

export type CoworkerRouteDetail = {
  result: CoworkerRouteResult;
  /** Kept for surfaces that have historically returned the model's fallback cause. */
  undecided: RoutingUndecided | null;
};

export type CoworkerRoutingService = {
  route(input: CoworkerRoutingInput): Promise<CoworkerRouteResult>;
};

export type HttpCoworkerRoutingService = CoworkerRoutingService & {
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

type AliasOccurrence = {
  alias: string;
  start: number;
  end: number;
  profiles: ReadonlyMap<string, AgentProfile>;
};

function occurrencesOf(
  text: string,
  alias: string,
  profiles: ReadonlyMap<string, AgentProfile>,
): AliasOccurrence[] {
  const occurrences: AliasOccurrence[] = [];
  let start = text.indexOf(alias);
  while (start >= 0) {
    const end = start + alias.length;
    if (hasTokenBoundaries(text, start, end)) {
      occurrences.push({ alias, start, end, profiles });
    }
    start = text.indexOf(alias, start + alias.length);
  }
  return occurrences;
}

function actorId(actor: RoutingActor): string | undefined {
  return actor.id && actor.email !== DEV_ACTOR_EMAIL ? actor.id : undefined;
}

function suffixes(name: string): string[] {
  const tokens = name.split(" ");
  return tokens.slice(1).map((_, index) => tokens.slice(index + 1).join(" "));
}

function displayName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < leftPoints.length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0);
    const rightPoint = rightPoints[index]?.codePointAt(0);
    if (leftPoint === undefined) return -1;
    if (rightPoint === undefined) return 1;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

type AliasIndex = {
  aliases: Map<string, Map<string, AgentProfile>>;
  labels: Map<string, string>;
};

function addAlias(
  aliases: AliasIndex["aliases"],
  alias: string,
  profile: AgentProfile,
): void {
  if (!alias) return;
  const profiles = aliases.get(alias) ?? new Map<string, AgentProfile>();
  profiles.set(profile.id, profile);
  aliases.set(alias, profiles);
}

function buildAliasIndex(roster: readonly AgentProfile[]): AliasIndex {
  const byNormalizedName = new Map<string, AgentProfile[]>();
  for (const profile of roster) {
    const normalized = normalizeCoworkerName(profile.name);
    const profiles = byNormalizedName.get(normalized);
    if (profiles) profiles.push(profile);
    else byNormalizedName.set(normalized, [profile]);
  }

  const duplicateOptions = new Map<string, number>();
  for (const profiles of byNormalizedName.values()) {
    if (profiles.length < 2) continue;
    profiles
      .toSorted((left, right) => codePointCompare(left.id, right.id))
      .forEach((profile, index) => {
        duplicateOptions.set(profile.id, index + 1);
      });
  }
  const aliases = new Map<string, Map<string, AgentProfile>>();
  const labels = new Map<string, string>();
  for (const profile of roster) {
    const normalized = normalizeCoworkerName(profile.name);
    const option = duplicateOptions.get(profile.id);
    const label = option
      ? `${displayName(profile.name)} (option ${option})`
      : profile.name;
    labels.set(profile.id, label);
    addAlias(aliases, normalized, profile);
    for (const suffix of suffixes(normalized))
      addAlias(aliases, suffix, profile);
    if (option) {
      addAlias(aliases, normalizeCoworkerName(label), profile);
    }
  }
  return { aliases, labels };
}

function labelsFor(
  profiles: Iterable<AgentProfile>,
  labels: ReadonlyMap<string, string>,
): string[] {
  return [...profiles]
    .map((profile) => labels.get(profile.id) ?? profile.name)
    .sort(codePointCompare);
}

function explicitNameRoute(
  text: string,
  roster: readonly AgentProfile[],
): CoworkerRouteResult | null {
  const normalizedText = normalizeCoworkerName(text);
  const { aliases, labels } = buildAliasIndex(roster);
  const occurrences = [...aliases.entries()].flatMap(([alias, profiles]) =>
    occurrencesOf(normalizedText, alias, profiles),
  );
  const explicitOccurrences = occurrences.filter(
    (occurrence) =>
      !occurrences.some(
        (other) =>
          other.alias.length > occurrence.alias.length &&
          other.start < occurrence.end &&
          occurrence.start < other.end,
      ),
  );
  const profiles = new Map<string, AgentProfile>();
  for (const occurrence of explicitOccurrences) {
    for (const profile of occurrence.profiles.values()) {
      profiles.set(profile.id, profile);
    }
  }
  if (profiles.size === 1) {
    const chosen = profiles.values().next().value as AgentProfile;
    return {
      kind: "selected",
      agentId: chosen.id,
      name: chosen.name,
      reason: "named by the person asking",
      fallback: false,
      viaMention: true,
    };
  }
  if (profiles.size > 1) {
    return { kind: "ambiguous", names: labelsFor(profiles.values(), labels) };
  }
  return null;
}

function auditReason(
  selected: Extract<CoworkerRouteResult, { kind: "selected" }>,
  undecided: RoutingUndecided | null,
): string {
  if (selected.viaMention) return "named by the person asking";
  if (selected.fallback)
    return undecided ? `fallback: ${undecided}` : "fallback";
  return "intent match";
}

export function createCoworkerRoutingService(
  options: CreateCoworkerRoutingServiceOptions,
): HttpCoworkerRoutingService {
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
        reason: auditReason(selected, undecided),
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
    // The store applies this same policy in SQL; keep this canonical policy check at the service
    // boundary so a broader store implementation cannot leak a coworker into routing.
    const roster = (await options.store.list(input.actor, false)).filter(
      (profile) => canAccessAgent(input.actor, profile),
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
