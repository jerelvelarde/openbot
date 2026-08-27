import { describe, expect, test } from "bun:test";
import { seal } from "../src/auth/signed-value";
import {
  EXTERNAL_LINK_TTL_MS,
  mintExternalLinkToken,
  readExternalLinkToken,
} from "../src/external/link-token";

const KEY = "external-link-token-test-key";
const NOW = 1_700_000_000_000;
const INVALID = "This Slack link has expired or is invalid.";
const identity = {
  provider: "slack" as const,
  providerTenantId: "T1",
  providerUserId: "U1",
  providerEmail: "person@example.com",
};

async function expectInvalid(token: string, key = KEY, now = NOW) {
  await expect(readExternalLinkToken(token, key, now)).rejects.toThrow(INVALID);
  await expect(readExternalLinkToken(token, key, now)).rejects.toThrowError(
    new Error(INVALID),
  );
}

describe("external Slack link tokens", () => {
  test("opens a live claim to only its provider identity", async () => {
    const token = await mintExternalLinkToken(identity, KEY, NOW);

    expect(await readExternalLinkToken(token, KEY, NOW)).toEqual(identity);
  });

  test("expires after its ten minute TTL", async () => {
    const token = await mintExternalLinkToken(identity, KEY, NOW);

    await expectInvalid(token, KEY, NOW + EXTERNAL_LINK_TTL_MS + 1);
  });

  test("remains valid exactly at its expiry boundary", async () => {
    const token = await mintExternalLinkToken(identity, KEY, NOW);

    expect(
      await readExternalLinkToken(token, KEY, NOW + EXTERNAL_LINK_TTL_MS),
    ).toEqual(identity);
  });

  test("refuses an altered claim", async () => {
    const token = await mintExternalLinkToken(identity, KEY, NOW);
    const altered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    await expectInvalid(altered);
  });

  test("refuses a claim sealed with another key", async () => {
    const token = await mintExternalLinkToken(identity, KEY, NOW);

    await expectInvalid(token, "another-external-link-token-test-key");
  });

  test.each([
    ["unsealed", "not a sealed value"],
    ["malformed JSON", "{not-json"],
    ["{}", "a sealed value with no claim fields"],
    ["[]", "a sealed array"],
  ])("refuses %s", async (value) => {
    const token =
      value === "unsealed"
        ? "not-a-sealed-value"
        : await seal(value, KEY, "external-link:v1");

    await expectInvalid(token);
  });

  test("requires the Slack provider binding", async () => {
    const token = await seal(
      JSON.stringify({
        ...identity,
        provider: "github",
        issuedAt: NOW,
        expiresAt: NOW + EXTERNAL_LINK_TTL_MS,
        nonce: "nonce",
      }),
      KEY,
      "external-link:v1",
    );

    await expectInvalid(token);
  });

  test.each([
    ["providerTenantId", ""],
    ["providerTenantId", "  "],
    ["providerUserId", ""],
    ["providerUserId", "  "],
  ])("refuses an empty %s", async (field, value) => {
    const token = await seal(
      JSON.stringify({
        ...identity,
        [field]: value,
        issuedAt: NOW,
        expiresAt: NOW + EXTERNAL_LINK_TTL_MS,
        nonce: "nonce",
      }),
      KEY,
      "external-link:v1",
    );

    await expectInvalid(token);
  });

  test.each([
    ["issuedAt", "now"],
    ["expiresAt", "later"],
    ["nonce", ""],
    ["nonce", 42],
    ["providerEmail", 42],
  ])("refuses a malformed %s", async (field, value) => {
    const token = await seal(
      JSON.stringify({
        ...identity,
        [field]: value,
        issuedAt: field === "issuedAt" ? value : NOW,
        expiresAt: field === "expiresAt" ? value : NOW + EXTERNAL_LINK_TTL_MS,
        nonce: field === "nonce" ? value : "nonce",
      }),
      KEY,
      "external-link:v1",
    );

    await expectInvalid(token);
  });

  test("refuses a claim that expires before it was issued", async () => {
    const token = await seal(
      JSON.stringify({
        ...identity,
        issuedAt: NOW,
        expiresAt: NOW - 1,
        nonce: "nonce",
      }),
      KEY,
      "external-link:v1",
    );

    await expectInvalid(token);
  });
});
