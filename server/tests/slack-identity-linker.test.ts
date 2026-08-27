import { describe, expect, test } from "bun:test";
import type { ChannelIdentityContext } from "@copilotkit/channels";
import type { AgentActor } from "../src/agents/profile-types";
import type {
  ExternalLinkStore,
  SlackActiveUserLinkStore,
} from "../src/external/link-store";
import type {
  ExternalProviderIdentity,
  ExternalUserLink,
} from "../src/external/schema-types";
import { SlackIdentityLinker } from "../src/slack/identity-linker";

const KEY = "slack-identity-linker-test-key";
const IDENTITY: ExternalProviderIdentity = {
  provider: "slack",
  providerTenantId: "T1",
  providerUserId: "U1",
  providerEmail: "adapter@example.test",
};

type ActiveUser = { id: string; name: string; role: AgentActor["role"] };

function linked(
  openbotUserId: string,
  providerEmail = IDENTITY.providerEmail,
): ExternalUserLink {
  return {
    ...IDENTITY,
    providerEmail,
    openbotUserId,
    linkedAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function context(
  overrides: Partial<ChannelIdentityContext> = {},
): ChannelIdentityContext {
  return {
    provider: "slack",
    tenant: { id: "T1" },
    installation: { id: "I1" },
    actor: { id: "U1", kind: "human", email: "untrusted@example.test" },
    conversation: { id: "C1" },
    trigger: "message",
    event: { id: "Ev1" },
    raw: null,
    ...overrides,
  };
}

function storeFor(
  input: {
    link?: ExternalUserLink | null;
    found?: { id: string; name: string } | null;
    active?: Map<string, ActiveUser>;
    onLink?: () => { link: ExternalUserLink; error?: Error };
  } = {},
): ExternalLinkStore &
  SlackActiveUserLinkStore & { linkedWith: ExternalProviderIdentity[] } {
  let currentLink = input.link ?? null;
  const linkedWith: ExternalProviderIdentity[] = [];
  const active = input.active ?? new Map<string, ActiveUser>();
  return {
    linkedWith,
    async find() {
      return currentLink;
    },
    async findVerifiedUserByEmail() {
      return input.found ?? null;
    },
    async resolveActiveUser(id) {
      return active.get(id) ?? null;
    },
    async link(value) {
      linkedWith.push(value);
      const outcome = input.onLink?.();
      if (outcome) {
        currentLink = outcome.link;
        if (outcome.error) throw outcome.error;
      } else {
        currentLink = linked(value.openbotUserId, value.providerEmail);
      }
      return currentLink;
    },
  };
}

function linker(
  store: ExternalLinkStore & SlackActiveUserLinkStore,
  appUrl = "https://openbot.test",
) {
  return new SlackIdentityLinker({ store, encryptionKey: KEY, appUrl });
}

describe("SlackIdentityLinker", () => {
  test("reloads the current OpenBot user and role for every existing link", async () => {
    const store = storeFor({
      link: linked("alice"),
      active: new Map([
        ["alice", { id: "alice", name: "Alice Now", role: "admin" }],
      ]),
    });

    await expect(linker(store).resolve(context())).resolves.toMatchObject({
      kind: "linked",
      user: { id: "alice", name: "Alice Now" },
      actor: { id: "alice", role: "admin" },
    });
  });

  test("refuses a linked user that has been revoked or lost every supported role", async () => {
    const store = storeFor({ link: linked("alice") });

    const result = await linker(store).resolve(context());

    expect(result.kind).toBe("unlinked");
    expect(store.linkedWith).toEqual([]);
  });

  test("accepts only human provider actors", async () => {
    const store = storeFor({
      found: { id: "alice", name: "Alice" },
      active: new Map([
        ["alice", { id: "alice", name: "Alice", role: "user" }],
      ]),
    });

    await expect(
      linker(store).resolve(context({ actor: { id: "B1", kind: "bot" } })),
    ).rejects.toThrow("Slack identity requires a human actor.");
    expect(store.linkedWith).toEqual([]);
  });

  test("uses only the adapter profile email for automatic linking", async () => {
    const store = storeFor({
      found: { id: "alice", name: "Alice" },
      active: new Map([
        ["alice", { id: "alice", name: "Alice", role: "user" }],
      ]),
    });
    const result = await linker(store).resolve(
      context({
        actor: { id: "U1", kind: "human", email: "attacker@example.test" },
        lookupProfile: async () => ({
          id: "U1",
          kind: "human",
          email: "  ADAPTER@EXAMPLE.TEST  ",
        }),
      }),
    );

    expect(result).toMatchObject({
      kind: "linked",
      actor: { id: "alice", role: "user" },
    });
    expect(store.linkedWith).toEqual([{ ...IDENTITY, openbotUserId: "alice" }]);
  });

  test("returns a secure linking flow for absent, ambiguous, unverified, or revoked adapter email", async () => {
    for (const profile of [
      undefined,
      { id: "U1", kind: "human" as const },
      { id: "U1", kind: "human" as const, email: "" },
    ]) {
      const store = storeFor();
      const result = await linker(store).resolve(
        context({ lookupProfile: async () => profile }),
      );
      expect(result.kind).toBe("unlinked");
      expect(store.linkedWith).toEqual([]);
      if (result.kind === "unlinked")
        expect(result.linkUrl).toStartWith(
          "https://openbot.test/link/slack?token=",
        );
    }
  });

  test("does not auto-link a matching email without an active OpenBot role", async () => {
    const store = storeFor({ found: { id: "alice", name: "Alice" } });
    const result = await linker(store).resolve(
      context({
        lookupProfile: async () => ({
          id: "U1",
          kind: "human",
          email: IDENTITY.providerEmail ?? undefined,
        }),
      }),
    );
    expect(result.kind).toBe("unlinked");
    expect(store.linkedWith).toEqual([]);
  });

  test("does not reassign a conflicting identity and only accepts the safe existing winner", async () => {
    const store = storeFor({
      found: { id: "alice", name: "Alice" },
      active: new Map([
        ["alice", { id: "alice", name: "Alice", role: "user" }],
        ["bob", { id: "bob", name: "Bob", role: "admin" }],
      ]),
      onLink: () => ({
        link: linked("bob"),
        error: new Error("That Slack identity is already linked."),
      }),
    });
    const result = await linker(store).resolve(
      context({
        lookupProfile: async () => ({
          id: "U1",
          kind: "human",
          email: IDENTITY.providerEmail ?? undefined,
        }),
      }),
    );

    expect(result).toMatchObject({
      kind: "linked",
      actor: { id: "bob", role: "admin" },
    });
    expect(store.linkedWith).toHaveLength(1);
  });

  test("requires a configured absolute app URL for an unlinked result", async () => {
    await expect(linker(storeFor(), "").resolve(context())).rejects.toThrow(
      "Slack link setup requires an absolute OPENBOT_APP_URL.",
    );
    await expect(
      linker(storeFor(), "/relative").resolve(context()),
    ).rejects.toThrow("Slack link setup requires an absolute OPENBOT_APP_URL.");
  });

  test("derives tenant and provider user only from ChannelIdentityContext", async () => {
    const store = storeFor();
    const result = await linker(store).resolve(
      context({
        tenant: { id: "T-trusted" },
        actor: {
          id: "U-trusted",
          kind: "human",
          email: "ignored@example.test",
        },
        raw: { tenant: "attacker", user: "attacker" },
      }),
    );
    expect(result).toMatchObject({
      identity: {
        provider: "slack",
        providerTenantId: "T-trusted",
        providerUserId: "U-trusted",
      },
    });
  });
});
