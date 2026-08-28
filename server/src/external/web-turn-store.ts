import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { externalThreadConversationRefs, externalWebTurns } from "../db/schema";

/** Terminal and in-flight states of one web-authored turn. */
export type ExternalWebTurnStatus = "accepted" | "delivered" | "failed";

export type ExternalWebTurnClaim =
  /** This request created the operation; it is the one that may deliver. */
  | { kind: "claimed"; operationId: string }
  /**
   * The same key already claimed this thread. The caller returns the original
   * operation and delivers nothing, which is what stops a browser retry from
   * producing a second Slack message and a second agent run.
   */
  | {
      kind: "duplicate";
      operationId: string;
      status: ExternalWebTurnStatus;
      failureCategory: string | null;
    };

export type ExternalWebTurnStore = {
  /**
   * The managed conversation reference for a thread, or null when Intelligence
   * has not issued one. Null is the ordinary state, not an error: it means this
   * thread cannot accept a web-authored turn yet.
   */
  conversationRef: (channelsThreadId: string) => Promise<string | null>;
  /**
   * Which of these threads currently hold a reference, as one query rather than
   * one per row, so listing a page of conversations does not fan out.
   */
  threadsWithConversationRef: (
    channelsThreadIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  claim: (input: {
    channelsThreadId: string;
    idempotencyKey: string;
    authorUserId: string;
  }) => Promise<ExternalWebTurnClaim>;
};

function asStatus(value: string): ExternalWebTurnStatus {
  if (value === "accepted" || value === "delivered" || value === "failed") {
    return value;
  }
  throw new Error("A web turn has an unsupported status.");
}

export function createExternalWebTurnStore(
  database: Database,
): ExternalWebTurnStore {
  async function conversationRef(
    channelsThreadId: string,
  ): Promise<string | null> {
    const rows = await database
      .select({
        conversationRef: externalThreadConversationRefs.conversationRef,
      })
      .from(externalThreadConversationRefs)
      .where(
        eq(externalThreadConversationRefs.channelsThreadId, channelsThreadId),
      )
      .limit(1);
    return rows[0]?.conversationRef ?? null;
  }

  async function threadsWithConversationRef(
    channelsThreadIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    // An empty `inArray` builds `in ()`, which is a syntax error, so the empty
    // page is answered without a query rather than by a special-cased SQL shape.
    if (channelsThreadIds.length === 0) return new Set();
    const rows = await database
      .select({
        channelsThreadId: externalThreadConversationRefs.channelsThreadId,
      })
      .from(externalThreadConversationRefs)
      .where(
        inArray(externalThreadConversationRefs.channelsThreadId, [
          ...channelsThreadIds,
        ]),
      );
    return new Set(rows.map((row) => row.channelsThreadId));
  }

  async function existing(
    channelsThreadId: string,
    idempotencyKey: string,
  ): Promise<ExternalWebTurnClaim | null> {
    const rows = await database
      .select({
        operationId: externalWebTurns.operationId,
        status: externalWebTurns.status,
        failureCategory: externalWebTurns.failureCategory,
      })
      .from(externalWebTurns)
      .where(
        and(
          eq(externalWebTurns.channelsThreadId, channelsThreadId),
          eq(externalWebTurns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row
      ? {
          kind: "duplicate",
          operationId: row.operationId,
          status: asStatus(row.status),
          failureCategory: row.failureCategory,
        }
      : null;
  }

  /**
   * Claim the turn before anything is delivered.
   *
   * The insert is the claim, so the unique index — not a prior read — decides
   * the winner. Two concurrent submissions of one key therefore cannot both
   * believe they won: `onConflictDoNothing` returns no row to the loser, which
   * then reads back the winner's operation.
   */
  async function claim(input: {
    channelsThreadId: string;
    idempotencyKey: string;
    authorUserId: string;
  }): Promise<ExternalWebTurnClaim> {
    const [inserted] = await database
      .insert(externalWebTurns)
      .values({
        channelsThreadId: input.channelsThreadId,
        idempotencyKey: input.idempotencyKey,
        authorUserId: input.authorUserId,
      })
      .onConflictDoNothing()
      .returning({ operationId: externalWebTurns.operationId });

    if (inserted) return { kind: "claimed", operationId: inserted.operationId };

    const winner = await existing(input.channelsThreadId, input.idempotencyKey);
    if (!winner) {
      // The insert conflicted, so a row for this key existed at write time. Not
      // finding it now means the conflict came from a different constraint, and
      // treating that as a duplicate would silently drop a turn.
      throw new Error("A web turn could not be claimed.");
    }
    return winner;
  }

  return { conversationRef, threadsWithConversationRef, claim };
}
