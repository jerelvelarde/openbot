/** @jsxImportSource @copilotkit/channels */
import { defineChannelComponent } from "@copilotkit/channels";
import { Actions, Button, Message, Section } from "@copilotkit/channels/ui";
import { z } from "zod";

export const ApprovalCard = defineChannelComponent({
  name: "approval_card",
  description:
    "Ask the person to approve or reject a consequential action before continuing.",
  parameters: z.object({
    question: z.string().min(1).describe("The decision the person must make"),
  }),
  render({ question }) {
    return (
      <Message fallbackText={question}>
        <Section>{question}</Section>
        <Actions>
          <Button
            key="approval-approve"
            onClick={async ({ thread }) => {
              await thread.resume({ approved: true });
            }}
            style="primary"
          >
            Approve
          </Button>
          <Button
            key="approval-reject"
            onClick={async ({ thread }) => {
              await thread.resume({ approved: false });
            }}
          >
            Reject
          </Button>
        </Actions>
      </Message>
    );
  },
});
