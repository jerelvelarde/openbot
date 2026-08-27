/** @jsxImportSource @copilotkit/channels */
import { defineChannelComponent } from "@copilotkit/channels";
import { Actions, Button, Message, Section } from "@copilotkit/channels/ui";
import { z } from "zod";
import type {
  ApprovalDecisionStore,
  ApprovalPresentation,
} from "./approval-store";
import { maybeCurrentSlackExecution } from "./execution-context";

type ApprovalDependencies = {
  store: ApprovalDecisionStore;
  authorize(input: {
    userId: string;
    presentation: ApprovalPresentation;
  }): Promise<boolean>;
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
    now: options.now ?? Date.now,
    // Channels keeps actions for seven days by default. Keep the authorization row one day longer
    // so cleanup can never outpace the continuation it protects.
    retentionMs: options.retentionMs ?? 8 * 24 * 60 * 60_000,
  };
}

const approvalAction = z
  .object({
    presentationId: z.string().uuid(),
    channelsThreadId: z.string().min(1),
    conversationKey: z.string().min(1),
    agentId: z.string().min(1),
    createdByUserId: z.string().min(1),
    approved: z.boolean(),
  })
  .strict();

/*
 * Channels 0.9 persists each non-undefined button actionValue in its ActionRegistry and replaces
 * the provider callback value with that stored value on hot and cold dispatch. These buttons use
 * either a complete object or null, never undefined, so provider input is never the fallback.
 */

function sameSubject(
  presentation: ApprovalPresentation,
  decision: z.infer<typeof approvalAction>,
): boolean {
  return (
    presentation.channelsThreadId === decision.channelsThreadId &&
    presentation.conversationKey === decision.conversationKey &&
    presentation.agentId === decision.agentId &&
    presentation.createdByUserId === decision.createdByUserId
  );
}

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
  if (decision.conversationKey !== conversationKey) {
    throw new Error("This approval interaction could not be authorized.");
  }
  const now = dependencies.now();
  await dependencies.store.cleanup(new Date(now - dependencies.retentionMs));
  await dependencies.store.present({
    presentationId: decision.presentationId,
    channelsThreadId: decision.channelsThreadId,
    conversationKey: decision.conversationKey,
    agentId: decision.agentId,
    createdByUserId: decision.createdByUserId,
  });
  const presentation = await dependencies.store.get(decision.presentationId);
  if (
    !presentation ||
    !sameSubject(presentation, decision) ||
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
    const execution = maybeCurrentSlackExecution();
    const subject =
      execution?.channelsThreadId &&
      execution.channelsConversationKey &&
      execution.agentId
        ? {
            channelsThreadId: execution.channelsThreadId,
            conversationKey: execution.channelsConversationKey,
            agentId: execution.agentId,
            createdByUserId: execution.actor.id,
          }
        : null;
    const presentation = subject
      ? { presentationId: crypto.randomUUID(), ...subject }
      : null;
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
            value={presentation ? { ...presentation, approved: true } : null}
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
            value={presentation ? { ...presentation, approved: false } : null}
          >
            Reject
          </Button>
        </Actions>
      </Message>
    );
  },
});
