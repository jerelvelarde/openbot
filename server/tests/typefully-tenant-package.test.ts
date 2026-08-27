import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  componentExclusions,
  credentials,
  deploymentPackages,
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
  skillTools,
} from "../src/db/schema";
import {
  loadTenantPackage,
  synchronizeTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

afterAll(async () => database.$client.close());

test("the fintech Typefully skill associates without creating connector authority", async () => {
  const source = join(import.meta.dir, "..", "..", "examples", "fintech");
  const loaded = await loadTenantPackage(source);
  const socialSkill = loaded.skills.find(
    (skill) => skill.slug === "draft-social-posts",
  );
  expect(socialSkill).toBeDefined();
  expect(socialSkill?.tools).toEqual([
    "typefully/get_draft",
    "typefully/create_draft",
    "typefully/update_draft",
  ]);
  expect(socialSkill?.instructions).toContain("showTypefullyDraft");
  expect(socialSkill?.instructions).toContain("connection_required");
  expect(socialSkill?.instructions).toContain("connectTypefullyAccount");
  expect(socialSkill?.instructions).toContain("approveTypefullyPublication");
  expect(socialSkill?.instructions).toContain(
    "never ask the person to paste or send a Typefully API key in chat",
  );

  const packageSuffix = randomUUID().slice(0, 8);
  const agentIds = new Map(
    loaded.agents.map((agent) => [agent.id, `${agent.id}-${packageSuffix}`]),
  );
  const isolated = {
    ...loaded,
    tenantId: `fintech-typefully-${packageSuffix}`,
    agents: loaded.agents.map((agent) => {
      const isolatedId = agentIds.get(agent.id);
      if (!isolatedId) throw new Error(`Missing isolated id for ${agent.id}.`);
      return { ...agent, id: isolatedId };
    }),
    channels: [],
    sourcePath: `${loaded.sourcePath}#${packageSuffix}`,
    checksum: randomUUID(),
  };
  const intendedBot = isolated.agents.find((agent) =>
    agent.skills.includes("draft-social-posts"),
  );
  if (!intendedBot) throw new Error("The package did not attach the skill.");
  expect(intendedBot?.id).toBe(`general-assistant-${packageSuffix}`);

  const typefullyServersBefore = await database
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, "typefully"));
  const typefullyToolsBefore = await database
    .select()
    .from(mcpTools)
    .where(eq(mcpTools.serverId, "typefully"));
  const typefullyCredentialsBefore = await database
    .select()
    .from(credentials)
    .where(eq(credentials.provider, "typefully"));

  let deploymentId: string | undefined;
  try {
    deploymentId = (await synchronizeTenantPackage(database, isolated)).id;

    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, intendedBot.id),
            eq(pluginGrants.kind, "skill"),
          ),
        ),
    ).toMatchObject([
      {
        ref: "draft-social-posts",
        grantedBy: "tenant-package",
      },
    ]);
    expect(
      await database
        .select()
        .from(skillTools)
        .where(eq(skillTools.skillId, "draft-social-posts")),
    ).toHaveLength(3);

    expect(
      await database
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.id, "typefully")),
    ).toEqual(typefullyServersBefore);
    expect(
      await database
        .select()
        .from(mcpTools)
        .where(eq(mcpTools.serverId, "typefully")),
    ).toEqual(typefullyToolsBefore);
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, intendedBot.id),
            eq(pluginGrants.kind, "mcp"),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(componentExclusions)
        .where(eq(componentExclusions.agentId, intendedBot.id)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(credentials)
        .where(eq(credentials.provider, "typefully")),
    ).toEqual(typefullyCredentialsBefore);
  } finally {
    for (const agent of isolated.agents) {
      await database.delete(agents).where(eq(agents.id, agent.id));
    }
    await database
      .delete(skillTools)
      .where(eq(skillTools.skillId, "draft-social-posts"));
    await database.delete(skills).where(eq(skills.id, "draft-social-posts"));
    if (deploymentId) {
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.id, deploymentId));
    }
  }
});
