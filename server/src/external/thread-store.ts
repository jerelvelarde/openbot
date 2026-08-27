import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents, externalThreadBindings } from "../db/schema";

export type ExternalThreadBindingInput = {
  channelsThreadId: string;
  provider: "slack";
  providerTenantId: string;
  providerConversationId: string;
  providerThreadId: string;
  agentId: string;
  agentName: string;
  createdByUserId: string;
};

export type ExternalThreadBinding = Omit<
  ExternalThreadBindingInput,
  "agentName"
> & {
  agentName: string;
  createdAt: Date;
};

export type ExternalThreadStore = {
  getByChannelsThreadId: (id: string) => Promise<ExternalThreadBinding | null>;
  getByProviderThread: (
    identity: Pick<
      ExternalThreadBindingInput,
      | "provider"
      | "providerTenantId"
      | "providerConversationId"
      | "providerThreadId"
    >,
  ) => Promise<ExternalThreadBinding | null>;
  bind: (input: ExternalThreadBindingInput) => Promise<ExternalThreadBinding>;
};

const bindingColumns = {
  channelsThreadId: externalThreadBindings.channelsThreadId,
  provider: externalThreadBindings.provider,
  providerTenantId: externalThreadBindings.providerTenantId,
  providerConversationId: externalThreadBindings.providerConversationId,
  providerThreadId: externalThreadBindings.providerThreadId,
  agentId: externalThreadBindings.agentId,
  agentName: agents.name,
  createdByUserId: externalThreadBindings.createdByUserId,
  createdAt: externalThreadBindings.createdAt,
};

function asBinding(
  row: Omit<ExternalThreadBinding, "provider"> & { provider: string },
): ExternalThreadBinding {
  return { ...row, provider: row.provider as "slack" };
}

function isSameBinding(
  binding: ExternalThreadBinding,
  input: ExternalThreadBindingInput,
): boolean {
  return (
    binding.channelsThreadId === input.channelsThreadId &&
    binding.provider === input.provider &&
    binding.providerTenantId === input.providerTenantId &&
    binding.providerConversationId === input.providerConversationId &&
    binding.providerThreadId === input.providerThreadId &&
    binding.agentId === input.agentId &&
    binding.createdByUserId === input.createdByUserId
  );
}

function isSameLogicalThread(
  binding: ExternalThreadBinding,
  input: ExternalThreadBindingInput,
): boolean {
  return (
    binding.channelsThreadId === input.channelsThreadId &&
    binding.provider === input.provider &&
    binding.providerTenantId === input.providerTenantId &&
    binding.providerConversationId === input.providerConversationId &&
    binding.providerThreadId === input.providerThreadId
  );
}

function assignedError(binding: ExternalThreadBinding): Error {
  return new Error(
    `This Slack thread is already assigned to ${binding.agentName}.`,
  );
}

export function createExternalThreadStore(
  database: Database,
): ExternalThreadStore {
  async function getByChannelsThreadId(
    id: string,
  ): Promise<ExternalThreadBinding | null> {
    const [binding] = await database
      .select(bindingColumns)
      .from(externalThreadBindings)
      .innerJoin(agents, eq(externalThreadBindings.agentId, agents.id))
      .where(eq(externalThreadBindings.channelsThreadId, id))
      .limit(1);
    return binding ? asBinding(binding) : null;
  }

  async function getByProviderThread(
    identity: Pick<
      ExternalThreadBindingInput,
      | "provider"
      | "providerTenantId"
      | "providerConversationId"
      | "providerThreadId"
    >,
  ): Promise<ExternalThreadBinding | null> {
    const [binding] = await database
      .select(bindingColumns)
      .from(externalThreadBindings)
      .innerJoin(agents, eq(externalThreadBindings.agentId, agents.id))
      .where(
        and(
          eq(externalThreadBindings.provider, identity.provider),
          eq(
            externalThreadBindings.providerTenantId,
            identity.providerTenantId,
          ),
          eq(
            externalThreadBindings.providerConversationId,
            identity.providerConversationId,
          ),
          eq(
            externalThreadBindings.providerThreadId,
            identity.providerThreadId,
          ),
        ),
      )
      .limit(1);
    return binding ? asBinding(binding) : null;
  }

  async function findEffectiveBinding(
    input: ExternalThreadBindingInput,
  ): Promise<ExternalThreadBinding | null> {
    const [byChannelsThreadId, byProviderThread] = await Promise.all([
      getByChannelsThreadId(input.channelsThreadId),
      getByProviderThread(input),
    ]);
    if (
      byChannelsThreadId &&
      byProviderThread &&
      byChannelsThreadId.channelsThreadId !== byProviderThread.channelsThreadId
    ) {
      throw new Error("External thread bindings have conflicting identities.");
    }
    return byChannelsThreadId ?? byProviderThread;
  }

  async function bind(
    input: ExternalThreadBindingInput,
  ): Promise<ExternalThreadBinding> {
    /*
     * This read is deliberately before the insert. A caller that arrives after a binding is durable
     * must not reinterpret its request as a first-delivery race and switch its agent. Two true first
     * deliveries can both observe no row, then converge on the conflict winner below.
     */
    const existing = await findEffectiveBinding(input);
    if (existing) {
      if (isSameBinding(existing, input)) return existing;
      throw assignedError(existing);
    }

    const [inserted] = await database
      .insert(externalThreadBindings)
      .values({
        channelsThreadId: input.channelsThreadId,
        provider: input.provider,
        providerTenantId: input.providerTenantId,
        providerConversationId: input.providerConversationId,
        providerThreadId: input.providerThreadId,
        agentId: input.agentId,
        createdByUserId: input.createdByUserId,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      const binding = await getByChannelsThreadId(inserted.channelsThreadId);
      if (binding) return binding;
      throw new Error("External thread binding was not found after insertion.");
    }

    const winner = await findEffectiveBinding(input);
    if (!winner) {
      throw new Error("External thread binding was not found after insertion.");
    }
    if (
      isSameBinding(winner, input) ||
      (isSameLogicalThread(winner, input) &&
        winner.createdByUserId === input.createdByUserId) ||
      (winner.agentId === input.agentId &&
        winner.createdByUserId === input.createdByUserId)
    ) {
      return winner;
    }
    throw assignedError(winner);
  }

  return { getByChannelsThreadId, getByProviderThread, bind };
}
