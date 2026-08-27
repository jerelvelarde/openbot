import type { ChannelIdentityContext } from "@copilotkit/channels";
import type { AgentActor } from "../agents/profile-types";
import type {
  ExternalLinkStore,
  SlackActiveUserLinkStore,
} from "../external/link-store";
import { mintExternalLinkToken } from "../external/link-token";
import type {
  ExternalProviderIdentity,
  ExternalUserLink,
} from "../external/schema-types";

export type SlackIdentityResult =
  | {
      kind: "linked";
      user: { id: string; name: string };
      actor: AgentActor;
      identity: ExternalProviderIdentity;
    }
  | {
      kind: "unlinked";
      linkUrl: string;
      identity: ExternalProviderIdentity;
    };

export type SlackIdentityLinkerOptions = {
  store: ExternalLinkStore & SlackActiveUserLinkStore;
  encryptionKey: string;
  appUrl: string | undefined;
};

const APP_URL_ERROR = "Slack link setup requires an absolute OPENBOT_APP_URL.";
const LINK_CONFLICT_ERROR = "That Slack identity is already linked.";

function adapterEmail(context: ChannelIdentityContext): Promise<string | null> {
  return Promise.resolve(context.lookupProfile?.()).then((profile) => {
    const email = profile?.email?.trim().toLowerCase();
    return email || null;
  });
}

function identityFor(
  context: ChannelIdentityContext,
  providerEmail: string | null,
): ExternalProviderIdentity {
  if (context.provider !== "slack") {
    throw new Error("Slack identity requires a Slack provider.");
  }
  if (context.actor.kind !== "human") {
    throw new Error("Slack identity requires a human actor.");
  }
  return {
    provider: "slack",
    providerTenantId: context.tenant.id,
    providerUserId: context.actor.id,
    providerEmail,
  };
}

function linkedResult(
  identity: ExternalProviderIdentity,
  user: { id: string; name: string; role: AgentActor["role"] },
): SlackIdentityResult {
  return {
    kind: "linked",
    user: { id: user.id, name: user.name },
    actor: { id: user.id, role: user.role },
    identity,
  };
}

function configuredAppUrl(appUrl: string | undefined): URL {
  try {
    const url = new URL(appUrl ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error();
    return url;
  } catch {
    throw new Error(APP_URL_ERROR);
  }
}

function isLinkConflict(error: unknown): boolean {
  return error instanceof Error && error.message === LINK_CONFLICT_ERROR;
}

export class SlackIdentityLinker {
  constructor(private readonly options: SlackIdentityLinkerOptions) {}

  async resolve(context: ChannelIdentityContext): Promise<SlackIdentityResult> {
    const baseIdentity = identityFor(context, null);
    const existing = await this.options.store.find(
      baseIdentity.provider,
      baseIdentity.providerTenantId,
      baseIdentity.providerUserId,
    );
    if (existing) {
      const active = await this.options.store.resolveActiveUser(
        existing.openbotUserId,
      );
      if (active) return linkedResult(existing, active);
      return this.unlinked(existing);
    }

    const profileEmail = await adapterEmail(context);
    const identity = { ...baseIdentity, providerEmail: profileEmail };
    if (!profileEmail) return this.unlinked(identity);

    const matched =
      await this.options.store.findVerifiedUserByEmail(profileEmail);
    if (!matched) return this.unlinked(identity);
    const matchedActive = await this.options.store.resolveActiveUser(
      matched.id,
    );
    if (!matchedActive) return this.unlinked(identity);

    let linked: ExternalUserLink | null = null;
    try {
      linked = await this.options.store.link({
        ...identity,
        openbotUserId: matched.id,
      });
    } catch (error) {
      if (!isLinkConflict(error)) throw error;
    }

    const winner = await this.options.store.find(
      identity.provider,
      identity.providerTenantId,
      identity.providerUserId,
    );
    const current = winner ?? linked;
    if (!current) return this.unlinked(identity);

    const active = await this.options.store.resolveActiveUser(
      current.openbotUserId,
    );
    if (!active) return this.unlinked(identity);
    return linkedResult(current, active);
  }

  private async unlinked(
    identity: ExternalProviderIdentity,
  ): Promise<SlackIdentityResult> {
    const url = new URL("/link/slack", configuredAppUrl(this.options.appUrl));
    url.searchParams.set(
      "token",
      await mintExternalLinkToken(identity, this.options.encryptionKey),
    );
    return { kind: "unlinked", linkUrl: url.toString(), identity };
  }
}
