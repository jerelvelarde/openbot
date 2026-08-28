export type SmokeCleanupStep = {
  name: string;
  run: () => void | Promise<void>;
};

/** Run every independent teardown even when an earlier resource refuses cleanup. */
export async function settleSmokeCleanup(
  steps: SmokeCleanupStep[],
): Promise<Error[]> {
  const settled = await Promise.allSettled(
    steps.map(async ({ run }) => await run()),
  );
  return settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    const reason =
      result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason));
    return [new Error(`${steps[index]?.name ?? "cleanup"}: ${reason.message}`)];
  });
}
