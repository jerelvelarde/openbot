/** @jsxImportSource @copilotkit/channels */
import { defineChannelComponent } from "@copilotkit/channels";
import { Actions, Button, Message, Section } from "@copilotkit/channels/ui";
import { z } from "zod";
import type {
  ApprovalDecisionStore,
  ApprovalPresentation,
} from "./approval-store";
import { currentSlackExecution } from "./execution-context";

type ApprovalSubject = Omit<
  ApprovalPresentation,
  "presentationId" | "createdAt"
>;
type ApprovalDependencies = {
  store: ApprovalDecisionStore;
  authorize(input: {
    userId: string;
    presentation: ApprovalPresentation;
  }): Promise<boolean>;
  subject(): ApprovalSubject;
  now(): number;
  retentionMs: number;
};

let approvalDependencies: ApprovalDependencies | undefined;

/** Wire the durable decision store before registering ApprovalCard with a Channel runtime. */
export function configureApprovalDecisionStore(
  store: ApprovalDecisionStore,
  options: Partial<Omit<ApprovalDependencies, "store">> = {},
): void {
  approvalDependencies = {
    store,
    authorize: options.authorize ?? (async () => false),
    subject:
      options.subject ??
      (() => {
        const execution = currentSlackExecution();
        if (
          !execution.channelsThreadId ||
          !execution.channelsConversationKey ||
          !execution.agentId
        ) {
          throw new Error("ApprovalCard requires a pinned Slack thread.");
        }
        return {
          channelsThreadId: execution.channelsThreadId,
          conversationKey: execution.channelsConversationKey,
          agentId: execution.agentId,
          createdByUserId: execution.actor.id,
        };
      }),
    now: options.now ?? Date.now,
    // Channels keeps actions for seven days by default. Keep the authorization row one day longer
    // so cleanup can never outpace the continuation it protects.
    retentionMs: options.retentionMs ?? 8 * 24 * 60 * 60_000,
  };
}

const approvalAction = z.object({
  presentationId: z.string().uuid(),
  approved: z.boolean(),
});

async function claimAndResume(
  value: unknown,
  actionId: string,
  userId: string | null,
  conversationKey: string | null,
  resume: (decision: { approved: boolean }) => Promise<unknown>,
): Promise<void> {
  const dependencies = approvalDependencies;
  if (!dependencies) {
    throw new Error("ApprovalCard requires a durable approval decision store.");
  }
  if (!userId || !conversationKey) {
    throw new Error("This approval interaction could not be authorized.");
  }
  const decision = approvalAction.parse(value);
  const presentation = await dependencies.store.get(decision.presentationId);
  if (
    !presentation ||
    presentation.conversationKey !== conversationKey ||
    !(await dependencies.authorize({ userId, presentation }))
  ) {
    throw new Error("This approval interaction could not be authorized.");
  }
  const claimed = await dependencies.store.begin({
    ...decision,
    actionId,
    decidedByUserId: userId,
  });
  if (claimed === "rejected") return;
  await resume({ approved: decision.approved });
  await dependencies.store.complete(decision.presentationId, actionId);
}

function threadConversationKey(thread: unknown): string | null {
  if (!thread || typeof thread !== "object") return null;
  const value = (thread as { conversationKey?: unknown }).conversationKey;
  return typeof value === "string" && value ? value : null;
}

export const ApprovalCard = defineChannelComponent({
  name: "approval_card",
  description:
    "Ask the person to approve or reject a consequential action before continuing.",
  parameters: z.object({
    question: z.string().min(1).describe("The decision the person must make"),
  }),
  async render({ question }) {
    const dependencies = approvalDependencies;
    if (!dependencies) {
      throw new Error(
        "ApprovalCard requires a durable approval decision store.",
      );
    }
    const presentationId = crypto.randomUUID();
    const now = dependencies.now();
    await dependencies.store.cleanup(new Date(now - dependencies.retentionMs));
    await dependencies.store.present({
      presentationId,
      ...dependencies.subject(),
    });
    return (
      <Message fallbackText={question}>
        <Section>{question}</Section>
        <Actions>
          <Button
            key="approval-approve"
            onClick={async ({ action, thread, user }) => {
              await claimAndResume(
                action.value,
                action.id,
                user?.id ?? null,
                threadConversationKey(thread),
                (decision) => thread.resume(decision),
              );
            }}
            style="primary"
            value={{ presentationId, approved: true }}
          >
            Approve
          </Button>
          <Button
            key="approval-reject"
            onClick={async ({ action, thread, user }) => {
              await claimAndResume(
                action.value,
                action.id,
                user?.id ?? null,
                threadConversationKey(thread),
                (decision) => thread.resume(decision),
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
