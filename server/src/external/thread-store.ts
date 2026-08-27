import { and, eq, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents, externalThreadBindings } from "../db/schema";

export type ExternalThreadBindingInput = {
  channelsThreadId: string;
  provider: "slack";
  providerTenantId: string;
  providerConversationId: string;
  providerThreadId: string;
  agentId: string;
  /** Required by the public contract, but never trusted or persisted. Reads join the current name. */
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

/** An established Slack thread cannot be switched to another coworker. */
export class ExternalThreadConflictError extends Error {
  readonly agentName: string;

  constructor(agentName: string) {
    super(`This Slack thread is already assigned to ${agentName}.`);
    this.name = "ExternalThreadConflictError";
    this.agentName = agentName;
  }
}

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

type BindingReader = Pick<Database, "select">;
type BindingWriter = BindingReader & Pick<Database, "insert">;

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
  if (row.provider !== "slack") {
    throw new Error("External thread binding has an unsupported provider.");
  }
  return { ...row, provider: "slack" };
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

function hasSameIdentityAndCreator(
  binding: ExternalThreadBinding,
  input: ExternalThreadBindingInput,
): boolean {
  return (
    binding.channelsThreadId === input.channelsThreadId &&
    binding.provider === input.provider &&
    binding.providerTenantId === input.providerTenantId &&
    binding.providerConversationId === input.providerConversationId &&
    binding.providerThreadId === input.providerThreadId &&
    binding.createdByUserId === input.createdByUserId
  );
}

function assignedError(
  binding: ExternalThreadBinding,
): ExternalThreadConflictError {
  return new ExternalThreadConflictError(binding.agentName);
}

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      errno?: unknown;
    };
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      return candidate.code;
    }
    if (
      typeof candidate.errno === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.errno)
    ) {
      return candidate.errno;
    }
    current = candidate.cause;
  }
  return undefined;
}

function integrityError(): Error {
  return new Error("External thread bindings have conflicting identities.");
}

export function createExternalThreadStore(
  database: Database,
): ExternalThreadStore {
  async function lookup(
    reader: BindingReader,
    input: Pick<
      ExternalThreadBindingInput,
      | "channelsThreadId"
      | "provider"
      | "providerTenantId"
      | "providerConversationId"
      | "providerThreadId"
    >,
  ): Promise<ExternalThreadBinding[]> {
    const rows = await reader
      .select(bindingColumns)
      .from(externalThreadBindings)
      .innerJoin(agents, eq(externalThreadBindings.agentId, agents.id))
      .where(
        or(
          eq(externalThreadBindings.channelsThreadId, input.channelsThreadId),
          and(
            eq(externalThreadBindings.provider, input.provider),
            eq(externalThreadBindings.providerTenantId, input.providerTenantId),
            eq(
              externalThreadBindings.providerConversationId,
              input.providerConversationId,
            ),
            eq(externalThreadBindings.providerThreadId, input.providerThreadId),
          ),
        ),
      )
      .limit(2);
    return rows.map(asBinding);
  }

  function oneOrIntegrity(
    bindings: ExternalThreadBinding[],
  ): ExternalThreadBinding | null {
    if (bindings.length > 1) throw integrityError();
    return bindings[0] ?? null;
  }

  async function getByChannelsThreadId(
    id: string,
  ): Promise<ExternalThreadBinding | null> {
    const rows = await database
      .select(bindingColumns)
      .from(externalThreadBindings)
      .innerJoin(agents, eq(externalThreadBindings.agentId, agents.id))
      .where(eq(externalThreadBindings.channelsThreadId, id))
      .limit(1);
    return rows[0] ? asBinding(rows[0]) : null;
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
    const rows = await database
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
    return rows[0] ? asBinding(rows[0]) : null;
  }

  async function bindInSerializableTransaction(
    input: ExternalThreadBindingInput,
  ): Promise<ExternalThreadBinding> {
    return database.transaction(
      async (transaction) => {
        const existing = oneOrIntegrity(await lookup(transaction, input));
        if (existing) {
          if (isSameBinding(existing, input)) return existing;
          throw assignedError(existing);
        }

        const [inserted] = await (transaction as BindingWriter)
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
        if (!inserted) {
          throw new Error("External thread binding was not inserted.");
        }

        const binding = oneOrIntegrity(await lookup(transaction, input));
        if (!binding) {
          throw new Error(
            "External thread binding was not found after insertion.",
          );
        }
        return binding;
      },
      { isolationLevel: "serializable" },
    );
  }

  async function bind(
    input: ExternalThreadBindingInput,
  ): Promise<ExternalThreadBinding> {
    try {
      return await bindInSerializableTransaction(input);
    } catch (error) {
      if (sqlState(error) !== "40001") throw error;

      /*
       * An overlapping, still-uncommitted first delivery is concurrency: both serializable snapshots
       * may see no binding, and one may lose validation. After rollback, one combined read sees the
       * committed winner. Only the exact canonical/provider identity and creator may converge; a
       * call that starts after the winner commits sees an established row and takes the conflict path.
       */
      const winner = oneOrIntegrity(await lookup(database, input));
      if (winner && hasSameIdentityAndCreator(winner, input)) return winner;
      if (winner) throw assignedError(winner);
      throw error;
    }
  }

  return { getByChannelsThreadId, getByProviderThread, bind };
}
