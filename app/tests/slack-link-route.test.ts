import { expect, test } from "bun:test";
import {
  slackLinkClaim,
  slackLinkClaimState,
  slackLinkFailure,
  slackLinkMutationVariables,
  slackLinkResponseOutcome,
  slackLinkResult,
  slackLinkToken,
} from "@/routes/_authed/link/slack";

test("requires a token and maps completion responses", () => {
  expect(slackLinkToken({})).toBeNull();
  expect(slackLinkToken({ token: " claim " })).toBe("claim");
  expect(slackLinkResult(200)).toEqual({
    kind: "linked",
    message: "Slack is linked to your OpenBot account.",
  });
  expect(slackLinkResult(409).kind).toBe("conflict");
});

test("rejects non-string, empty, and repeated token search inputs", () => {
  expect(slackLinkToken({ token: "" })).toBeNull();
  expect(slackLinkToken({ token: "   " })).toBeNull();
  expect(slackLinkToken({ token: ["first", "second"] })).toBeNull();
  expect(slackLinkToken({ token: { value: "claim" } })).toBeNull();
  expect(slackLinkToken({ token: 42 })).toBeNull();
});

test("maps invalid and expired completion statuses uniformly", () => {
  expect(slackLinkResult(400)).toEqual({
    kind: "invalid",
    message:
      "This Slack link has expired or is invalid. Return to Slack and try again.",
  });
  expect(slackLinkResult(410).kind).toBe("invalid");
});

test("keeps unexpected server failures retryable", () => {
  expect(slackLinkFailure(500)).toEqual({
    kind: "error",
    message: "Slack could not be linked right now. Try again.",
  });
});

test("treats only network and 5xx link failures as retryable", () => {
  for (const status of [400, 401, 403, 404, 410, 422]) {
    expect(slackLinkResponseOutcome(status).kind).toBe("invalid");
  }
  expect(slackLinkResponseOutcome(409).kind).toBe("conflict");

  for (const status of [500, 502, 503]) {
    expect(slackLinkResponseOutcome(status).kind).toBe("error");
  }
  expect(slackLinkResponseOutcome().kind).toBe("error");
});

test("drops an older claim response after the link token changes", () => {
  const first = slackLinkClaimState(null, { type: "start", requestId: 1 });
  const second = slackLinkClaimState(first, { type: "start", requestId: 2 });

  expect(second).toEqual({ kind: "loading", requestId: 2 });
  expect(
    slackLinkClaimState(second, {
      type: "ready",
      requestId: 1,
      claim: { workspace: "old-workspace", user: "old-user" },
    }),
  ).toEqual(second);
});

test("keeps the claim token out of mutation cache variables", () => {
  expect(slackLinkMutationVariables(3)).toEqual({ version: 3 });
  expect(slackLinkMutationVariables(3)).not.toHaveProperty("token");
});

test("maps only safe Slack identity fields for display", () => {
  expect(
    slackLinkClaim({
      providerTenantId: "T0123",
      providerUserId: "U0456",
      providerEmail: "person@example.com",
      token: "must not be displayed",
    }),
  ).toEqual({
    workspace: "T0123",
    user: "U0456",
    email: "person@example.com",
  });
  expect(
    slackLinkClaim({
      providerTenantId: "T0123",
      providerUserId: "U0456",
      providerEmail: null,
    }),
  ).toEqual({ workspace: "T0123", user: "U0456" });
  expect(slackLinkClaim({ providerTenantId: "T0123" })).toBeNull();
});
