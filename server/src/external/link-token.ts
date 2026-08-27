import { seal, unseal } from "../auth/signed-value";
import type { ExternalProviderIdentity } from "./schema-types";

export const EXTERNAL_LINK_TTL_MS = 10 * 60_000;

const EXTERNAL_LINK_LABEL = "external-link:v1";
const INVALID_LINK_MESSAGE = "This Slack link has expired or is invalid.";

type ExternalLinkClaim = ExternalProviderIdentity & {
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

function invalidLink(): never {
  throw new Error(INVALID_LINK_MESSAGE);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asClaim(value: unknown): ExternalLinkClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const claim = value as Partial<ExternalLinkClaim>;
  const { issuedAt, expiresAt } = claim;
  if (
    claim.provider !== "slack" ||
    !isNonEmptyString(claim.providerTenantId) ||
    !isNonEmptyString(claim.providerUserId) ||
    (claim.providerEmail !== null && typeof claim.providerEmail !== "string") ||
    typeof issuedAt !== "number" ||
    !Number.isFinite(issuedAt) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt < issuedAt ||
    !isNonEmptyString(claim.nonce)
  ) {
    return null;
  }

  return claim as ExternalLinkClaim;
}

export async function mintExternalLinkToken(
  identity: ExternalProviderIdentity,
  key: string,
  now = Date.now(),
): Promise<string> {
  return seal(
    JSON.stringify({
      ...identity,
      issuedAt: now,
      expiresAt: now + EXTERNAL_LINK_TTL_MS,
      nonce: crypto.randomUUID(),
    } satisfies ExternalLinkClaim),
    key,
    EXTERNAL_LINK_LABEL,
  );
}

export async function readExternalLinkToken(
  token: string | undefined,
  key: string,
  now = Date.now(),
): Promise<ExternalProviderIdentity> {
  try {
    const unsealed = await unseal(token, key, EXTERNAL_LINK_LABEL);
    if (!unsealed) return invalidLink();

    const claim = asClaim(JSON.parse(unsealed));
    if (!claim || now > claim.expiresAt) return invalidLink();

    return {
      provider: claim.provider,
      providerTenantId: claim.providerTenantId,
      providerUserId: claim.providerUserId,
      providerEmail: claim.providerEmail,
    };
  } catch {
    return invalidLink();
  }
}
