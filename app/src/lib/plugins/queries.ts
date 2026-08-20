import { queryOptions } from "@tanstack/react-query";

/** A tool one server offers, as the Plugins page sees it. */
export type PluginTool = {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `<serverId>/<name>`. What a grant names. */
  ref: string;
  /** Whether it changes something. Anything not positively known to be a read is a write. */
  effect: "read" | "write";
  grantedTo: string[];
};

export type PluginServer = {
  id: string;
  title: string;
  vendor: string;
  url: string;
  summary: string;
  docsUrl: string;
  /** `first-party` for a reviewed entry, `custom` for one an administrator added by URL. */
  provenance: string;
  hasCredential: boolean;
  toolsRefreshedAt: string | null;
  lastError: string | null;
  addedBy: string | null;
  tools: PluginTool[];
};

export type PluginSkill = {
  id: string;
  slug: string;
  /** Whose it is. Null means the deployment's: an administrator looks after it. */
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  grantedTo: string[];
};

export type CatalogueItem = {
  key: string;
  title: string;
  vendor: string;
  summary: string;
  docsUrl: string;
  needsCredential: boolean;
  /** True for a vendor that gives every customer their own hostname. */
  perInstance: boolean;
};

export type PluginsPage = {
  catalogue: CatalogueItem[];
  servers: PluginServer[];
  skills: PluginSkill[];
};

/** What one Bot holds, which is all the runtime needs to offer it. */
export type GrantedPlugins = {
  tools: {
    ref: string;
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  skills: {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
  }[];
};

export const pluginKeys = {
  all: ["plugins"] as const,
  page: () => ["plugins", "page"] as const,
  forAgent: (agentId: string) => ["plugins", "for-agent", agentId] as const,
};

export function pluginsPageQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.page(),
    queryFn: async (): Promise<PluginsPage> => {
      const response = await fetch("/api/plugins", { credentials: "include" });
      if (!response.ok) throw new Error("Plugins could not be loaded.");
      return response.json();
    },
  });
}

/**
 * What the active Bot has been granted, for drawing its tool calls.
 *
 * The offering itself moved to the server, which builds a Bot's tools per run from the same grants.
 * This is read here only so the transcript has a renderer for each tool name, and it is polled
 * because a tool granted while a channel is open should be drawable without a reload.
 */
export function agentPluginsQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: pluginKeys.forAgent(agentId),
    enabled: agentId.length > 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<GrantedPlugins> => {
      const response = await fetch(
        `/api/plugins/for/${encodeURIComponent(agentId)}`,
        { credentials: "include" },
      );
      if (!response.ok)
        throw new Error("This Bot's plugins could not be read.");
      return response.json();
    },
  });
}
