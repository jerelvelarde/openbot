import { expect, test } from "bun:test";
import {
  consumePendingSlackReturn,
  pendingSlackReturnPath,
  savePendingSlackReturn,
  signedInSlackRedirect,
} from "@/lib/auth/pending-return";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

test("accepts only a same-origin Slack link with one non-empty token", () => {
  expect(pendingSlackReturnPath("/link/slack?token=claim")).toBe(
    "/link/slack?token=claim",
  );
  expect(pendingSlackReturnPath("/link/slack?token= claim ")).toBe(
    "/link/slack?token=claim",
  );

  for (const rejected of [
    "https://evil.example/link/slack?token=claim",
    "//evil.example/link/slack?token=claim",
    "/admin?token=claim",
    "/link/slack",
    "/link/slack?token=",
    "/link/slack?token=one&token=two",
    "/link/slack?token=claim#fragment",
  ]) {
    expect(pendingSlackReturnPath(rejected)).toBeNull();
  }
});

test("saves an expiring one-time Slack return and consumes it after auth", () => {
  const session = storage();
  expect(savePendingSlackReturn("/link/slack?token=claim", session, 100)).toBe(
    true,
  );
  expect(consumePendingSlackReturn(session, 100 + 60_000)).toBe(
    "/link/slack?token=claim",
  );
  expect(consumePendingSlackReturn(session, 100 + 60_000)).toBeNull();
});

test("rejects and deletes expired or malformed saved returns", () => {
  const session = storage();
  savePendingSlackReturn("/link/slack?token=claim", session, 0);
  expect(consumePendingSlackReturn(session, 10 * 60_000 + 1)).toBeNull();
  expect(consumePendingSlackReturn(session, 10 * 60_000 + 1)).toBeNull();
});

test("redirects a signed-in person only to a consumed Slack return", () => {
  expect(signedInSlackRedirect("/", "/link/slack?token=claim")).toBe(
    "/link/slack?token=claim",
  );
  expect(
    signedInSlackRedirect("/link/slack?token=claim", "/link/slack?token=claim"),
  ).toBeNull();
  expect(signedInSlackRedirect("/", null)).toBeNull();
});
