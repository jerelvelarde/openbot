import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { externalUserLinks, revokedAccess, users } from "../db/schema";
import type {
  ExternalProvider,
  ExternalProviderIdentity,
  ExternalUserLink,
} from "./schema-types";

export type ExternalLinkResult = {
  link: ExternalUserLink;
  created: boolean;
};

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
  linkWithStatus: (
    input: ExternalProviderIdentity & { openbotUserId: string },
  ) => Promise<ExternalLinkResult>;
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

  async function findVerifiedUserByEmail(email: string) {
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
  }

  async function linkWithStatus(
    input: ExternalProviderIdentity & { openbotUserId: string },
  ): Promise<ExternalLinkResult> {
    const [inserted] = await database
      .insert(externalUserLinks)
      .values(input)
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      return { link: asLink(inserted), created: true };
    }

    const existing = await find(
      input.provider,
      input.providerTenantId,
      input.providerUserId,
    );
    if (existing && existing.openbotUserId === input.openbotUserId) {
      return { link: existing, created: false };
    }
    if (existing) {
      throw new Error("That Slack identity is already linked.");
    }

    /*
     * `onConflictDoNothing` also covers the one-OpenBot-user-per-workspace key. When that key
     * won, the lookup above has no row because it is deliberately by provider identity; read the
     * other key before reporting the public conflict. Each statement observes committed work, so
     * this is also the answer after a concurrent insert has completed.
     */
    const [existingForUser] = await database
      .select({ openbotUserId: externalUserLinks.openbotUserId })
      .from(externalUserLinks)
      .where(
        and(
          eq(externalUserLinks.provider, input.provider),
          eq(externalUserLinks.providerTenantId, input.providerTenantId),
          eq(externalUserLinks.openbotUserId, input.openbotUserId),
        ),
      )
      .limit(1);
    if (existingForUser) {
      throw new Error("That Slack identity is already linked.");
    }

    throw new Error("External user link was not found after insertion.");
  }

  async function link(
    input: ExternalProviderIdentity & { openbotUserId: string },
  ): Promise<ExternalUserLink> {
    return (await linkWithStatus(input)).link;
  }

  return { find, findVerifiedUserByEmail, link, linkWithStatus };
}
