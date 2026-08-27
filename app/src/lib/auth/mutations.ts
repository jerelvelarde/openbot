import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { authKeys, clearTypefullyUserCache } from "./queries";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    fallback: "Could not sign out",
  });
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => {
      clearTypefullyUserCache(queryClient);
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
  });
}
