import { expect, test } from "bun:test";
import { ownedSmokeTypefullyAssociation } from "./support/typefully-smoke-isolation";

test("a refused smoke run never claims or disconnects a preexisting Typefully association", () => {
  const preexisting = {
    serverId: "typefully",
    userId: "existing-user",
    credentialId: "existing-credential",
  };

  expect(
    ownedSmokeTypefullyAssociation({
      before: [preexisting],
      current: [preexisting],
      connectionAttempted: false,
    }),
  ).toBeUndefined();
  expect(
    ownedSmokeTypefullyAssociation({
      before: [preexisting],
      current: [
        preexisting,
        {
          serverId: "typefully",
          userId: "someone-else",
          credentialId: "unrelated-concurrent-credential",
        },
      ],
      connectionAttempted: false,
    }),
  ).toBeUndefined();
});

test("an attempted run claims only its exact new credential association", () => {
  const created = {
    serverId: "typefully",
    userId: "smoke-user",
    credentialId: "smoke-credential",
  };
  expect(
    ownedSmokeTypefullyAssociation({
      before: [],
      current: [created],
      connectionAttempted: true,
      credentialId: created.credentialId,
    }),
  ).toEqual(created);
});
