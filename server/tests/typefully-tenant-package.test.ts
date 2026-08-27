import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
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
    "typefully/prepare_publication",
  ]);
  expect(socialSkill?.instructions).toContain("showTypefullyDraft");
  expect(socialSkill?.instructions).toContain("connection_required");
  expect(socialSkill?.instructions).toContain("connectTypefullyAccount");
  expect(socialSkill?.instructions).toContain("approveTypefullyPublication");
  expect(socialSkill?.instructions).toContain(
    "never ask the person to paste or send a Typefully API key in chat",
  );

  const packageSuffix = randomUUID().slice(0, 8);
  const skillIds = new Map(
    loaded.skills.map((skill) => [
      skill.slug,
      `${skill.slug}-${packageSuffix}`,
    ]),
  );
  const isolatedSkillId = skillIds.get("draft-social-posts");
  if (!isolatedSkillId) throw new Error("The Typefully skill is missing.");
  const agentIds = new Map(
    loaded.agents.map((agent) => [agent.id, `${agent.id}-${packageSuffix}`]),
  );
  const isolated = {
    ...loaded,
    tenantId: `fintech-typefully-${packageSuffix}`,
    agents: loaded.agents.map((agent) => {
      const isolatedId = agentIds.get(agent.id);
      if (!isolatedId) throw new Error(`Missing isolated id for ${agent.id}.`);
      return {
        ...agent,
        id: isolatedId,
        skills: agent.skills.map((skill) => {
          const isolatedSkill = skillIds.get(skill);
          if (!isolatedSkill) {
            throw new Error(`Missing isolated skill id for ${skill}.`);
          }
          return isolatedSkill;
        }),
      };
    }),
    skills: loaded.skills.map((skill) => {
      const isolatedSlug = skillIds.get(skill.slug);
      if (!isolatedSlug) {
        throw new Error(`Missing isolated skill id for ${skill.slug}.`);
      }
      return { ...skill, slug: isolatedSlug };
    }),
    channels: [],
    sourcePath: `${loaded.sourcePath}#${packageSuffix}`,
    checksum: randomUUID(),
  };
  const intendedBot = isolated.agents.find((agent) =>
    agent.skills.includes(isolatedSkillId),
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
        ref: isolatedSkillId,
        grantedBy: "tenant-package",
      },
    ]);
    expect(
      await database
        .select()
        .from(skillTools)
        .where(eq(skillTools.skillId, isolatedSkillId)),
    ).toHaveLength(4);

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
            inArray(
              pluginGrants.agentId,
              isolated.agents.map((agent) => agent.id),
            ),
            eq(pluginGrants.kind, "mcp"),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(componentExclusions)
        .where(
          inArray(
            componentExclusions.agentId,
            isolated.agents.map((agent) => agent.id),
          ),
        ),
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
    const createdSkillIds = [...skillIds.values()];
    await database
      .delete(skillTools)
      .where(inArray(skillTools.skillId, createdSkillIds));
    await database.delete(skills).where(inArray(skills.id, createdSkillIds));
    if (deploymentId) {
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.id, deploymentId));
    }
  }

  expect(
    await database
      .select()
      .from(agents)
      .where(
        inArray(
          agents.id,
          isolated.agents.map((agent) => agent.id),
        ),
      ),
  ).toHaveLength(0);
  expect(
    await database
      .select()
      .from(skills)
      .where(inArray(skills.id, [...skillIds.values()])),
  ).toHaveLength(0);
});
