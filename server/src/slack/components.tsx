/** @jsxImportSource @copilotkit/channels */
import { defineChannelComponent } from "@copilotkit/channels";
import { Actions, Button, Message, Section } from "@copilotkit/channels/ui";
import { z } from "zod";
import type { ApprovalDecisionStore } from "./approval-store";

let approvalDecisionStore: ApprovalDecisionStore | undefined;

/** Wire the durable decision store before registering ApprovalCard with a Channel runtime. */
export function configureApprovalDecisionStore(
  store: ApprovalDecisionStore,
): void {
  approvalDecisionStore = store;
}

const approvalAction = z.object({
  presentationId: z.string().uuid(),
  approved: z.boolean(),
});

async function claimAndResume(
  value: unknown,
  actionId: string,
  resume: (decision: { approved: boolean }) => Promise<unknown>,
): Promise<void> {
  if (!approvalDecisionStore) {
    throw new Error("ApprovalCard requires a durable approval decision store.");
  }
  const decision = approvalAction.parse(value);
  const claimed = await approvalDecisionStore.claim({
    ...decision,
    actionId,
  });
  if (claimed) await resume({ approved: decision.approved });
}

export const ApprovalCard = defineChannelComponent({
  name: "approval_card",
  description:
    "Ask the person to approve or reject a consequential action before continuing.",
  parameters: z.object({
    question: z.string().min(1).describe("The decision the person must make"),
  }),
  render({ question }) {
    const presentationId = crypto.randomUUID();
    return (
      <Message fallbackText={question}>
        <Section>{question}</Section>
        <Actions>
          <Button
            key="approval-approve"
            onClick={async ({ action, thread }) => {
              await claimAndResume(action.value, action.id, (decision) =>
                thread.resume(decision),
              );
            }}
            style="primary"
            value={{ presentationId, approved: true }}
          >
            Approve
          </Button>
          <Button
            key="approval-reject"
            onClick={async ({ action, thread }) => {
              await claimAndResume(action.value, action.id, (decision) =>
                thread.resume(decision),
              );
            }}
            value={{ presentationId, approved: false }}
          >
            Reject
          </Button>
        </Actions>
      </Message>
    );
  },
});
