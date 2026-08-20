/**
 * Actions waiting on a person, and the waiting itself.
 *
 * The gateway parks a call here and blocks on it. Everything else about the design follows from one
 * fact: **the person who answers may not be on the device that started the turn.** They may be on a
 * phone, on another laptop, or not at their desk yet. So the question is a row, answerable by anybody
 * with the right to answer it, rather than a prompt held in whichever process happened to be running
 * the run.
 *
 * The wait polls rather than subscribes. An in-process event would be silently wrong the moment a
 * second server instance exists — the answer arrives on one and the waiter is on the other — and the
 * same reasoning `channels/events.ts` gives for going through Postgres applies here. A poll is the
 * smaller version of that: correct across instances, no new infrastructure, and a second of latency
 * on something a human took thirty seconds to decide.
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Database } from "../db/client";
import { pendingApprovals } from "../db/schema";

export type ApprovalSubject = {
  kind: "element" | "file" | "page" | "mcp";
  label: string;
  host?: string;
};

export type ApprovalRequest = {
  agentId: string;
  threadId?: string;
  /** Null for the local development actor, which is not a row in `users`. */
  actorUserId?: string;
  toolName: string;
  intent?: string;
  subject: ApprovalSubject;
  rule: string;
  reason: string;
};

export type ApprovalRecord = {
  id: string;
  agentId: string;
  threadId: string | null;
  toolName: string;
  intent: string | null;
  subject: ApprovalSubject;
  rule: string;
  reason: string;
  state: "pending" | "allowed" | "denied" | "expired";
  answeredByUserId: string | null;
  answeredAt: string | null;
  scopedRule: string | null;
  expiresAt: string;
  createdAt: string;
};

export type ApprovalAnswer = {
  decision: "allow" | "deny";
  /** `always` writes a scoped allow rule as well as answering this one call. */
  scope: "once" | "always";
  answeredByUserId?: string;
  /** The rule an `always` answer wrote, recorded on the approval so the change is traceable. */
  scopedRule?: string;
};

/** What the gateway learns when its wait ends. */
export type ApprovalOutcome =
  | { answered: true; allowed: boolean; answeredByUserId: string | null }
  | { answered: false; reason: "expired" | "cancelled" };

/**
 * How long a question stays answerable.
 *
 * Long enough that somebody can walk back to their desk, finite because a turn cannot be held open
 * forever and because an answer given tomorrow would be about a page that is long gone.
 */
const DEFAULT_TTL_MS = 10 * 60_000;
const POLL_MS = 1_000;

export type ApprovalStoreOptions = {
  ttlMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type ApprovalStore = {
  create(request: ApprovalRequest): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | undefined>;
  /** Everything still waiting, newest first. */
  pending(): Promise<ApprovalRecord[]>;
  /** Recently answered as well as waiting, for a surface that shows what just happened. */
  recent(limit?: number): Promise<ApprovalRecord[]>;
  answer(
    id: string,
    answer: ApprovalAnswer,
  ): Promise<ApprovalRecord | undefined>;
  /** Block until answered or the window closes. */
  wait(id: string, signal?: AbortSignal): Promise<ApprovalOutcome>;
  /** Mark anything past its window, so a stale question stops appearing as a live one. */
  expireOverdue(): Promise<number>;
};

type Row = typeof pendingApprovals.$inferSelect;

function toRecord(row: Row): ApprovalRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    threadId: row.threadId,
    toolName: row.toolName,
    intent: row.intent,
    subject: {
      kind: row.subjectKind as ApprovalSubject["kind"],
      label: row.subjectLabel,
      ...(row.subjectHost ? { host: row.subjectHost } : {}),
    },
    rule: row.rule,
    reason: row.reason,
    state: row.state,
    answeredByUserId: row.answeredByUserId,
    answeredAt: row.answeredAt ? row.answeredAt.toISOString() : null,
    scopedRule: row.scopedRule,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function createApprovalStore(
  database: Database,
  options: ApprovalStoreOptions = {},
): ApprovalStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const store: ApprovalStore = {
    async create(request) {
      const [row] = await database
        .insert(pendingApprovals)
        .values({
          id: `approval_${crypto.randomUUID()}`,
          agentId: request.agentId,
          threadId: request.threadId ?? null,
          actorUserId: request.actorUserId ?? null,
          toolName: request.toolName,
          intent: request.intent ?? null,
          subjectKind: request.subject.kind,
          subjectLabel: request.subject.label,
          subjectHost: request.subject.host ?? null,
          rule: request.rule,
          reason: request.reason,
          state: "pending",
          expiresAt: new Date(Date.now() + ttlMs),
        })
        .returning();
      if (!row) throw new Error("The approval could not be recorded.");
      return toRecord(row);
    },

    async get(id) {
      const [row] = await database
        .select()
        .from(pendingApprovals)
        .where(eq(pendingApprovals.id, id))
        .limit(1);
      return row ? toRecord(row) : undefined;
    },

    async pending() {
      await store.expireOverdue();
      const rows = await database
        .select()
        .from(pendingApprovals)
        .where(eq(pendingApprovals.state, "pending"))
        .orderBy(desc(pendingApprovals.createdAt));
      return rows.map(toRecord);
    },

    async recent(limit = 30) {
      await store.expireOverdue();
      const rows = await database
        .select()
        .from(pendingApprovals)
        .orderBy(desc(pendingApprovals.createdAt))
        .limit(limit);
      return rows.map(toRecord);
    },

    async answer(id, answer) {
      /**
       * Only a pending approval may be answered.
       *
       * The state is part of the WHERE rather than checked first, so two people answering at the same
       * moment cannot both succeed: one update matches the pending row and the other matches nothing.
       * Without that, the second answer would silently overwrite the first and the trail would name
       * the wrong person as having allowed it.
       */
      const [row] = await database
        .update(pendingApprovals)
        .set({
          state: answer.decision === "allow" ? "allowed" : "denied",
          answeredByUserId: answer.answeredByUserId ?? null,
          answeredAt: new Date(),
          scopedRule: answer.scopedRule ?? null,
        })
        .where(
          and(
            eq(pendingApprovals.id, id),
            eq(pendingApprovals.state, "pending"),
          ),
        )
        .returning();
      return row ? toRecord(row) : undefined;
    },

    async wait(id, signal) {
      const deadline = Date.now() + ttlMs;
      while (Date.now() < deadline) {
        // Stop must actually stop, including out of a wait.
        if (signal?.aborted) return { answered: false, reason: "cancelled" };
        const record = await store.get(id);
        if (!record) return { answered: false, reason: "expired" };
        if (record.state === "allowed" || record.state === "denied") {
          return {
            answered: true,
            allowed: record.state === "allowed",
            answeredByUserId: record.answeredByUserId,
          };
        }
        if (record.state === "expired") {
          return { answered: false, reason: "expired" };
        }
        await sleep(pollMs);
      }
      // The window closed with nobody answering. Recorded as expired rather than left pending, so it
      // stops showing up as something a person could still act on.
      await database
        .update(pendingApprovals)
        .set({ state: "expired" })
        .where(
          and(
            eq(pendingApprovals.id, id),
            eq(pendingApprovals.state, "pending"),
          ),
        );
      return { answered: false, reason: "expired" };
    },

    async expireOverdue() {
      const rows = await database
        .update(pendingApprovals)
        .set({ state: "expired" })
        .where(
          and(
            eq(pendingApprovals.state, "pending"),
            lt(pendingApprovals.expiresAt, new Date()),
          ),
        )
        .returning({ id: pendingApprovals.id });
      return rows.length;
    },
  };

  return store;
}

/**
 * The rule an "always allow" writes.
 *
 * A rule, and not a hidden per-bot flag, so a permission somebody granted from a phone at 3am is
 * readable in `/admin/boundaries` next to every other boundary and can be taken away the same way.
 *
 * Scoped to this Bot and this subject rather than to the tool: "always allow this" means the thing in
 * front of the person, not every click this Bot will ever make. The label is quoted rather than
 * interpolated bare, and a label containing a quote is refused rather than escaped, because a rule
 * that has to be escaped correctly to be safe is a rule that will eventually be escaped incorrectly.
 */
export function scopedAllowRule(
  agentId: string,
  subject: ApprovalSubject,
): string | undefined {
  const unsafe = /["\\\n\r]/;
  if (unsafe.test(agentId) || unsafe.test(subject.label)) return undefined;

  if (subject.kind === "file") {
    return `bot.id == "${agentId}" && file.path == "${subject.label}"`;
  }
  if (subject.kind === "mcp") {
    return `bot.id == "${agentId}" && mcp.tool == "${subject.label}"`;
  }
  if (subject.kind === "page" && subject.host && !unsafe.test(subject.host)) {
    return `bot.id == "${agentId}" && page.host == "${subject.host}"`;
  }
  return `bot.id == "${agentId}" && contains(element.name, "${subject.label}")`;
}

/** Approvals that belong to Bots this person may not see are not theirs to answer. */
export async function approvalsForAgents(
  store: ApprovalStore,
  agentIds: string[],
): Promise<ApprovalRecord[]> {
  if (agentIds.length === 0) return [];
  const visible = new Set(agentIds);
  const all = await store.recent(60);
  return all.filter((approval) => visible.has(approval.agentId));
}

/** Exported for the routes, which need the same list query with an id filter. */
export async function approvalsByState(
  database: Database,
  states: ("pending" | "allowed" | "denied" | "expired")[],
): Promise<ApprovalRecord[]> {
  const rows = await database
    .select()
    .from(pendingApprovals)
    .where(inArray(pendingApprovals.state, states))
    .orderBy(desc(pendingApprovals.createdAt));
  return rows.map(toRecord);
}
