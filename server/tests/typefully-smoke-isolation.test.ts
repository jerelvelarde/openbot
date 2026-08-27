import { expect, test } from "bun:test";
import { confirmedSmokeTypefullyAssociation } from "./support/typefully-smoke-isolation";

const started = new Date("2026-08-27T12:00:00.000Z");

test("an attempted but unconfirmed connection never owns a sole snapshot difference", () => {
  expect(
    confirmedSmokeTypefullyAssociation({
      connectionConfirmed: false,
      actorId: "smoke-user",
      runStartedAt: started,
      associations: [
        {
          serverId: "typefully",
          userId: "smoke-user",
          credentialId: "ambiguous-after-failure",
        },
        {
          serverId: "typefully",
          userId: "concurrent-user",
          credentialId: "concurrent-after-failure",
        },
      ],
      credentials: [
        {
          id: "ambiguous-after-failure",
          provider: "typefully",
          keyId: "smoke-user",
          createdAt: new Date("2026-08-27T12:00:01.000Z"),
        },
        {
          id: "concurrent-after-failure",
          provider: "typefully",
          keyId: "concurrent-user",
          createdAt: new Date("2026-08-27T12:00:01.500Z"),
        },
      ],
    }),
  ).toBeUndefined();
});

test("a confirmed connection captures only its exact actor-bound new association", () => {
  const owned = {
    serverId: "typefully",
    userId: "smoke-user",
    credentialId: "smoke-credential",
  };
  expect(
    confirmedSmokeTypefullyAssociation({
      connectionConfirmed: true,
      actorId: "smoke-user",
      runStartedAt: started,
      associations: [
        {
          serverId: "typefully",
          userId: "concurrent-user",
          credentialId: "concurrent-credential",
        },
        owned,
      ],
      credentials: [
        {
          id: "concurrent-credential",
          provider: "typefully",
          keyId: "concurrent-user",
          createdAt: new Date("2026-08-27T12:00:01.000Z"),
        },
        {
          id: "smoke-credential",
          provider: "typefully",
          keyId: "smoke-user",
          createdAt: new Date("2026-08-27T12:00:02.000Z"),
        },
      ],
    }),
  ).toEqual(owned);
});

test("preexisting and concurrent credentials cannot be claimed by a confirmed actor", () => {
  expect(
    confirmedSmokeTypefullyAssociation({
      connectionConfirmed: true,
      actorId: "smoke-user",
      runStartedAt: started,
      associations: [
        {
          serverId: "typefully",
          userId: "smoke-user",
          credentialId: "preexisting",
        },
        {
          serverId: "typefully",
          userId: "concurrent-user",
          credentialId: "concurrent",
        },
      ],
      credentials: [
        {
          id: "preexisting",
          provider: "typefully",
          keyId: "smoke-user",
          createdAt: new Date("2026-08-27T11:59:59.000Z"),
        },
        {
          id: "concurrent",
          provider: "typefully",
          keyId: "concurrent-user",
          createdAt: new Date("2026-08-27T12:00:03.000Z"),
        },
      ],
    }),
  ).toBeUndefined();
});
