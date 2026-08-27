import { and, eq, isNull, lt } from "drizzle-orm";
import type { Database } from "../db/client";
import { approvalDecisions } from "../db/schema";

export type ApprovalPresentation = {
  presentationId: string;
  channelsThreadId: string;
  conversationKey: string;
  agentId: string;
  createdByUserId: string;
  createdAt: Date;
};

export type ApprovalDecisionClaim = {
  presentationId: string;
  actionId: string;
  approved: boolean;
  decidedByUserId: string;
};

export type ApprovalClaimResult = "first" | "retry" | "rejected";

export interface ApprovalDecisionStore {
  present(input: Omit<ApprovalPresentation, "createdAt">): Promise<void>;
  get(presentationId: string): Promise<ApprovalPresentation | null>;
  begin(input: ApprovalDecisionClaim): Promise<ApprovalClaimResult>;
  complete(presentationId: string, actionId: string): Promise<void>;
  cleanup(before: Date): Promise<number>;
}

export function createApprovalDecisionStore(
  database: Database,
): ApprovalDecisionStore {
  return {
    async present(input) {
      await database
        .insert(approvalDecisions)
        .values(input)
        .onConflictDoNothing({ target: approvalDecisions.presentationId });
    },

    async get(presentationId) {
      const [row] = await database
        .select({
          presentationId: approvalDecisions.presentationId,
          channelsThreadId: approvalDecisions.channelsThreadId,
          conversationKey: approvalDecisions.conversationKey,
          agentId: approvalDecisions.agentId,
          createdByUserId: approvalDecisions.createdByUserId,
          createdAt: approvalDecisions.createdAt,
        })
        .from(approvalDecisions)
        .where(eq(approvalDecisions.presentationId, presentationId))
        .limit(1);
      return row ?? null;
    },

    async begin(input) {
      return database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({
            actionId: approvalDecisions.actionId,
            approved: approvalDecisions.approved,
            decidedByUserId: approvalDecisions.decidedByUserId,
            completedAt: approvalDecisions.completedAt,
          })
          .from(approvalDecisions)
          .where(eq(approvalDecisions.presentationId, input.presentationId))
          .for("update");
        if (!row) return "rejected";
        if (row.actionId === null) {
          await transaction
            .update(approvalDecisions)
            .set({
              actionId: input.actionId,
              approved: input.approved,
              decidedByUserId: input.decidedByUserId,
            })
            .where(eq(approvalDecisions.presentationId, input.presentationId));
          return "first";
        }
        if (
          row.actionId === input.actionId &&
          row.approved === input.approved &&
          row.decidedByUserId === input.decidedByUserId &&
          row.completedAt === null
        ) {
          return "retry";
        }
        return "rejected";
      });
    },

    async complete(presentationId, actionId) {
      await database
        .update(approvalDecisions)
        .set({ completedAt: new Date() })
        .where(
          and(
            eq(approvalDecisions.presentationId, presentationId),
            eq(approvalDecisions.actionId, actionId),
            isNull(approvalDecisions.completedAt),
          ),
        );
    },

    async cleanup(before) {
      const removed = await database
        .delete(approvalDecisions)
        .where(lt(approvalDecisions.createdAt, before))
        .returning({ presentationId: approvalDecisions.presentationId });
      return removed.length;
    },
  };
}
