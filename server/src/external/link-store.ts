import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { externalUserLinks, revokedAccess, users } from "../db/schema";
import type {
  ExternalProvider,
  ExternalProviderIdentity,
  ExternalUserLink,
} from "./schema-types";

export type ExternalLinkStore = {
  find: (
    provider: ExternalProvider,
    tenantId: string,
    providerUserId: string,
  ) => Promise<ExternalUserLink | null>;
  findVerifiedUserByEmail: (
    email: string,
  ) => Promise<{ id: string; name: string } | null>;
  link: (
    input: ExternalProviderIdentity & { openbotUserId: string },
  ) => Promise<ExternalUserLink>;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function asLink(row: typeof externalUserLinks.$inferSelect): ExternalUserLink {
  return {
    provider: row.provider as ExternalProvider,
    providerTenantId: row.providerTenantId,
    providerUserId: row.providerUserId,
    providerEmail: row.providerEmail,
    openbotUserId: row.openbotUserId,
    linkedAt: row.linkedAt,
    updatedAt: row.updatedAt,
  };
}

export function createExternalLinkStore(database: Database): ExternalLinkStore {
  async function find(
    provider: ExternalProvider,
    tenantId: string,
    providerUserId: string,
  ): Promise<ExternalUserLink | null> {
    const [row] = await database
      .select()
      .from(externalUserLinks)
      .where(
        and(
          eq(externalUserLinks.provider, provider),
          eq(externalUserLinks.providerTenantId, tenantId),
          eq(externalUserLinks.providerUserId, providerUserId),
        ),
      )
      .limit(1);
    return row ? asLink(row) : null;
  }

  return {
    find,

    async findVerifiedUserByEmail(email) {
      const rows = await database
        .select({
          id: users.id,
          // User names predate the not-null requirement but callers need a stable display value.
          name: sql<string>`coalesce(${users.name}, '')`,
        })
        .from(users)
        .leftJoin(
          revokedAccess,
          eq(revokedAccess.email, sql`lower(${users.email})`),
        )
        .where(
          and(
            eq(sql`lower(${users.email})`, normalizeEmail(email)),
            eq(users.emailVerified, true),
            isNull(revokedAccess.email),
          ),
        )
        .limit(2);

      return rows.length === 1 ? rows[0] : null;
    },

    async link(input) {
      await database
        .insert(externalUserLinks)
        .values(input)
        .onConflictDoNothing();

      const existing = await find(
        input.provider,
        input.providerTenantId,
        input.providerUserId,
      );
      if (!existing) {
        throw new Error("External user link was not found after insertion.");
      }
      if (existing.openbotUserId !== input.openbotUserId) {
        throw new Error("That Slack identity is already linked.");
      }
      return existing;
    },
  };
}
