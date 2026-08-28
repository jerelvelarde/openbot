import { expect, test } from "bun:test";

test("the CI suite bounds success output without weakening failures or count enforcement", async () => {
  const source = await Bun.file(
    new URL("../scripts/test-ci.ts", import.meta.url),
  ).text();

  expect(source).toContain(
    'Bun.spawn(["bun", "run", "test", "--only-failures"], {',
  );
  expect(source).toContain('stdout: "inherit"');
  expect(source).toContain('stderr: "pipe"');
  expect(source).toContain("if (status !== 0) process.exit(status)");
  expect(source).toContain("stderr.match(/Ran (\\d+) tests? across/)");
  expect(source).toContain("if (count < MINIMUM_TESTS)");
});
