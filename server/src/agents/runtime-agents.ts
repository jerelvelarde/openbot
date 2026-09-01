import { and, eq, exists, isNotNull, isNull, or, sql } from "drizzle-orm";
import { type RegisteredAgent, registeredAgentFromRow } from "../copilot";
import type { CredentialSecretReader } from "../credentials";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  botChats,
  channelAgents,
  channelMemberships,
} from "../db/schema";
import { agentAuthHeaders, authFromConfiguration } from "./auth-header";
import type { AgentActor } from "./profile-types";

/**
 * Read the agents one person may run, on every request.
 *
 * The filtering is in the query, not in JavaScript afterwards: a private coworker must never be
 * read into the process for an actor who cannot see it, and "we fetched it but did not show it" is
 * the shape most accidental disclosures take.
 */
export function createRuntimeAgentLoader(
  database: Database,
  /** Resolves a customer agent's key at load time. Absent means no agent can carry one. */
  vault?: { reader: CredentialSecretReader; encryptionKey: string },
  /** Secret for the deployment-managed Bot. Never sent to customer-owned endpoints. */
  managedAgent?: { endpoint: URL; token: string },
) {
  return async (actor: AgentActor): Promise<RegisteredAgent[]> => {
    const [active, tombstones] = await Promise.all([
      selectActiveAgents(database, actor),
      selectTombstoneAgents(database, actor),
    ]);

    // A row whose configuration cannot be understood is skipped rather than mounted as a broken
    // agent. Tombstones are appended after, and never overwrite a live agent of the same id.
    const registered = new Map<string, RegisteredAgent>();
    for (const row of active) {
      const agent = registeredAgentFromRow(row);
      if (!agent) continue;
      // The key is resolved per load, rather than being cached on the row: revoking a
      // credential then takes effect on the next run rather than on the next restart.
      if (agent.type === "remote_ag_ui" && vault) {
        const headers = await agentAuthHeaders({
          reader: vault.reader,
          encryptionKey: vault.encryptionKey,
          auth: authFromConfiguration(row.configuration),
        });
        if (headers) agent.headers = headers;
      }
      if (
        agent.type === "remote_ag_ui" &&
        managedAgent &&
        agent.endpoint === managedAgent.endpoint.toString()
      ) {
        agent.headers = {
          ...agent.headers,
          "x-openbot-agent-token": managedAgent.token,
        };
      }
      registered.set(agent.id, agent);
    }
    for (const row of tombstones) {
      if (registered.has(row.id)) continue;
      registered.set(row.id, {
        id: row.id,
        name: row.name,
        type: "unavailable",
        reason: `${row.name} has been deleted and can no longer run. Its conversations remain readable.`,
      });
    }

    return [...registered.values()];
  };
}

function selectActiveAgents(database: Database, actor: AgentActor) {
  return database
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      configuration: agents.configuration,
      title: agentProfiles.title,
      roleDescription: agentProfiles.roleDescription,
    })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(
      and(
        isNull(agentProfiles.deletedAt),
        actor.role === "admin"
          ? undefined
          : or(
              eq(agentProfiles.visibility, "public"),
              eq(agentProfiles.ownerUserId, actor.id),
            ),
      ),
    );
}

/**
 * Deleted coworkers the caller still has history with.
 *
 * Registered so Intelligence can restore the thread the person is reading. History with the agent is
 * what authorizes this, not the profile's visibility, which is why deleting a coworker leaves its
 * conversations readable instead of erasing them.
 *
 * TWO KINDS OF HISTORY, BECAUSE THERE ARE TWO KINDS OF CONVERSATION. Membership of a channel the
 * agent worked in is one. A direct conversation on the Bot screen is the other, and this query used
 * to know only the first: it joined `channel_agents` to `channel_memberships` and never named
 * `bot_chats`, so a retired Bot somebody had only ever direct-messaged was registered nowhere at all.
 * That is not a missing convenience. `useAgent` throws for an id the runtime does not hold, and the
 * packaged `CopilotChat` resolves the same id the same way, so the whole Bot chat screen fell to the
 * error boundary — including the "this Bot has been retired, the conversation stays readable" banner
 * written for exactly this case. A guard in the browser could not have saved it for that reason, and
 * this is the only side the fix can live on.
 *
 * AN `exists` PER ARM RATHER THAN JOINS, and the reason is the same one `roster/query.ts` gives for
 * its own mapping term: neither arm reads a column of the tables it tests, both only ask whether a
 * row is there. It is also what lets this go back to a plain `select`. The `selectDistinct` it used
 * to carry was earning its keep — a join against `channel_agents` returns one row per shared channel
 * — and an `or` of two such joins would have been worse than that, multiplying a person's channels
 * with their conversations before collapsing the lot.
 */
function selectTombstoneAgents(database: Database, actor: AgentActor) {
  return database
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(
      and(
        isNotNull(agentProfiles.deletedAt),
        or(
          // A channel the agent worked in, that this person is a member of. `channel_memberships`'
          // primary key is `(channel_id, user_id)`, so the membership half of this is a key lookup.
          exists(
            database
              .select({ present: sql`1` })
              .from(channelAgents)
              .innerJoin(
                channelMemberships,
                and(
                  eq(channelMemberships.channelId, channelAgents.channelId),
                  eq(channelMemberships.userId, actor.id),
                ),
              )
              .where(eq(channelAgents.agentId, agents.id)),
          ),
          /*
           * A direct conversation with the agent, that this person owns.
           *
           * `bot_chats.user_id` is the whole of the ownership term here, where the channel arm above
           * needs a join to reach one. That asymmetry is the table's own: a bot chat has exactly one
           * interested party, so it carries the person on the row rather than in a membership table
           * able to hold only ever one member — `schema/coworker.ts` argues that at length, and the
           * roster's two branches divide the same way.
           *
           * `deleted_at` FILTERED AND `archived_at` DELIBERATELY NOT, which is the difference this arm
           * has to get right. A conversation the person deleted cannot be opened — `BotChatStore.get`
           * filters it and the screen says "not here any more" — so there is no screen left for it to
           * authorize an agent for. An archived one is hidden from the roster and its URL still opens
           * it, which is what makes archiving reversible rather than a deletion wearing a gentler
           * name; filtering on it here would crash exactly the screen archiving promises stays
           * readable.
           */
          exists(
            database
              .select({ present: sql`1` })
              .from(botChats)
              .where(
                and(
                  eq(botChats.agentId, agents.id),
                  eq(botChats.userId, actor.id),
                  isNull(botChats.deletedAt),
                ),
              ),
          ),
        ),
      ),
    );
}
