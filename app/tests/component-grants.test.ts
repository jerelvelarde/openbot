import { expect, test } from "bun:test";
import {
  componentGrantDescription,
  componentGrantEnabled,
} from "../src/routes/_authed/admin/components/$name";

test("explicit component grants start off, grant on, and revoke off", () => {
  const component = {
    grantMode: "explicit" as const,
    grantedTo: [] as string[],
    withheldFrom: [] as string[],
  };

  expect(componentGrantEnabled(component, "bot-a")).toBe(false);
  expect(componentGrantEnabled(component, "bot-b")).toBe(false);

  const grant = !componentGrantEnabled(component, "bot-a");
  expect(grant).toBe(true);
  component.grantedTo = ["bot-a"];
  expect(componentGrantEnabled(component, "bot-a")).toBe(true);
  expect(componentGrantEnabled(component, "bot-b")).toBe(false);

  const revoke = !componentGrantEnabled(component, "bot-a");
  expect(revoke).toBe(false);
  component.grantedTo = [];
  expect(componentGrantEnabled(component, "bot-a")).toBe(false);
  expect(componentGrantDescription("explicit")).toContain("explicit Bot grant");
});

test("open components use withholding instead of explicit grants", () => {
  const component = {
    grantMode: "open" as const,
    grantedTo: [] as string[],
    withheldFrom: ["bot-b"],
  };

  expect(componentGrantEnabled(component, "bot-a")).toBe(true);
  expect(componentGrantEnabled(component, "bot-b")).toBe(false);
});
