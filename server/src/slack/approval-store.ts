import type { Database } from "../db/client";
import { approvalDecisions } from "../db/schema";

export type ApprovalDecisionClaim = {
  presentationId: string;
  actionId: string;
  approved: boolean;
};

export interface ApprovalDecisionStore {
  /** Atomically returns true only for the first action from one presentation. */
  claim(input: ApprovalDecisionClaim): Promise<boolean>;
}

export function createApprovalDecisionStore(
  database: Database,
): ApprovalDecisionStore {
  return {
    async claim(input) {
      const inserted = await database
        .insert(approvalDecisions)
        .values(input)
        .onConflictDoNothing({ target: approvalDecisions.presentationId })
        .returning({ presentationId: approvalDecisions.presentationId });
      return inserted.length === 1;
    },
  };
}
