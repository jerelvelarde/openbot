import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { signOutMutationOptions } from "../src/lib/auth/mutations";
import { authKeys, currentUserQueryOptions } from "../src/lib/auth/queries";
import { draftQueryOptions, typefullyKeys } from "../src/lib/typefully/queries";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("uses a stable key for the current authenticated user", () => {
  expect(authKeys.currentUser()).toEqual(["auth", "current-user"]);
  expect(currentUserQueryOptions().queryKey).toEqual(["auth", "current-user"]);
});

test("sign-out removes all user-scoped Typefully data", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(typefullyKeys.draft("shared-id"), {
    draft: { document: { posts: [{ x: "prior user's private body" }] } },
  });
  globalThis.fetch = (async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await queryClient
    .getMutationCache()
    .build(queryClient, signOutMutationOptions(queryClient))
    .execute(undefined);

  expect(queryClient.getQueryData(typefullyKeys.draft("shared-id"))).toBe(
    undefined,
  );
});

test("a session user transition drops prior Typefully bodies before an offline second login", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user-one",
    email: "one@example.com",
    role: "user",
  });
  queryClient.setQueryData(typefullyKeys.draft("same-uuid"), {
    draft: { document: { posts: [{ x: "user one's private body" }] } },
  });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        user: { id: "user-two", email: "two@example.com", role: "user" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  await currentUserQueryOptions().queryFn?.({ client: queryClient } as never);

  expect(queryClient.getQueryData(typefullyKeys.draft("same-uuid"))).toBe(
    undefined,
  );
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  await expect(
    queryClient.fetchQuery(draftQueryOptions("same-uuid")),
  ).rejects.toThrow("offline");
  expect(queryClient.getQueryData(typefullyKeys.draft("same-uuid"))).toBe(
    undefined,
  );
});
