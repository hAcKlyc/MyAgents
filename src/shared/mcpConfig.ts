import type { McpServerDefinition } from './config-types';
import { DEFAULT_STANDARD_PLAYWRIGHT_ARGS, STANDARD_PLAYWRIGHT_MCP_ID } from './browserTools';

type AgentMcpConfig = {
  mcpEnabledServers?: unknown;
  mcpServersJson?: unknown;
};

export type McpConfigContainer = {
  mcpServers?: McpServerDefinition[];
  mcpEnabledServers?: string[];
  mcpServerEnv?: Record<string, Record<string, string>>;
  mcpServerArgs?: Record<string, string[]>;
  agents?: unknown[];
  imBotConfig?: unknown;
  imBotConfigs?: unknown[];
  launcherLastUsed?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Old app-owned definitions can survive in config and Session snapshots.
 * Match the retired launch marker, never the user-editable server id/name.
 */
export function isRetiredBundledMcpServer(server: Pick<McpServerDefinition, 'type' | 'command'>): boolean {
  return server.type === 'stdio' && server.command === '__bundled_cuse__';
}

/**
 * Apply user-editable MCP env and argument additions to a resolved catalogue.
 * `mcpServerArgs[id]` is an EXTRA-args store: replacing `server.args` would
 * discard preset executable/package arguments (for example Playwright's npm
 * package spec) and turn a valid MCP definition into a broken command.
 */
export function applyMcpServerConfigAdditions(
  servers: readonly McpServerDefinition[],
  config: Pick<McpConfigContainer, 'mcpServerArgs' | 'mcpServerEnv'>,
): McpServerDefinition[] {
  const argsByServer = asRecord(config.mcpServerArgs);
  const envByServer = asRecord(config.mcpServerEnv);

  return servers.filter(server => !isRetiredBundledMcpServer(server)).map((server) => {
    const configuredArgs = argsByServer[server.id];
    const extraArgs = configuredArgs === undefined && server.id === STANDARD_PLAYWRIGHT_MCP_ID
      ? [...DEFAULT_STANDARD_PLAYWRIGHT_ARGS]
      : configuredArgs;
    const extraEnv = envByServer[server.id];
    const hasArgs = Array.isArray(extraArgs);
    const hasEnv = !!extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv);
    if (!hasArgs && !hasEnv) return server;

    return {
      ...server,
      ...(hasArgs ? {
        args: [
          ...(Array.isArray(server.args) ? server.args : []),
          ...extraArgs.filter((arg): arg is string => typeof arg === 'string'),
        ],
      } : {}),
      ...(hasEnv ? {
        env: {
          ...(server.env ?? {}),
          ...(extraEnv as Record<string, string>),
        },
      } : {}),
    };
  });
}

type RemoteMcpDefinition = McpServerDefinition & {
  type: 'http' | 'sse';
  url: string;
};

function isPromotableRemoteMcpDefinition(server: unknown): server is RemoteMcpDefinition {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
  const candidate = server as { id?: unknown; name?: unknown; type?: unknown; url?: unknown };
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && (candidate.type === 'http' || candidate.type === 'sse')
    && typeof candidate.url === 'string'
    && candidate.url.length > 0;
}

function parseMcpServerEntries(raw: unknown): unknown[] {
  const parsed = typeof raw === 'string'
    ? (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })()
    : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

function normalizeMcpServersJson(servers: unknown[]): string | undefined {
  return servers.length > 0 ? JSON.stringify(servers) : undefined;
}

function hasMcpServerId(entry: unknown, serverId: string): boolean {
  return !!entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && (entry as { id?: unknown }).id === serverId;
}

function asAgentMcpConfig(agent: unknown): (Record<string, unknown> & AgentMcpConfig) | null {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null;
  return agent as Record<string, unknown> & AgentMcpConfig;
}

function asMcpRefConfig(value: unknown): (Record<string, unknown> & AgentMcpConfig) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown> & AgentMcpConfig;
}

/**
 * Heal a legacy Agent-only MCP catalogue split:
 * `agents[].mcpEnabledServers` references a custom HTTP/SSE server whose full
 * definition exists only in `agents[].mcpServersJson`, while the global
 * `config.mcpServers` registry is missing it.
 *
 * This is the shared TypeScript twin of the Rust reader's
 * `promote_agent_mcp_json_to_global_value`.
 */
export function promoteAgentMcpJsonToGlobal<T extends McpConfigContainer>(config: T): boolean {
  const agents = Array.isArray(config.agents) ? config.agents : [];
  if (agents.length === 0) return false;

  const globalServers = Array.isArray(config.mcpServers) ? [...config.mcpServers] : [];
  const globalEnabled = new Set(Array.isArray(config.mcpEnabledServers) ? config.mcpEnabledServers : []);
  const knownIds = new Set(globalServers.map(server => server.id));
  let changed = false;

  for (const agent of agents) {
    const a = asAgentMcpConfig(agent);
    if (!a) continue;
    const enabledIds = Array.isArray(a.mcpEnabledServers)
      ? new Set(a.mcpEnabledServers.filter((id): id is string => typeof id === 'string' && id.length > 0))
      : new Set<string>();
    if (enabledIds.size === 0) continue;

    for (const entry of parseMcpServerEntries(a.mcpServersJson)) {
      if (!isPromotableRemoteMcpDefinition(entry)) continue;
      const server = entry;
      if (!enabledIds.has(server.id) || server.isBuiltin || knownIds.has(server.id)) continue;
      const normalized: McpServerDefinition = { ...server, isBuiltin: false };
      globalServers.push(normalized);
      knownIds.add(normalized.id);
      globalEnabled.add(normalized.id);
      changed = true;
    }
  }

  if (changed) {
    config.mcpServers = globalServers;
    config.mcpEnabledServers = Array.from(globalEnabled);
  }
  return changed;
}

function pruneMcpReference(holder: AgentMcpConfig, serverId: string): boolean {
  let changed = false;

  if (Array.isArray(holder.mcpEnabledServers)) {
    const nextEnabled = holder.mcpEnabledServers.filter(id => id !== serverId);
    if (nextEnabled.length !== holder.mcpEnabledServers.length) {
      holder.mcpEnabledServers = nextEnabled;
      changed = true;
    }
  }

  const currentEntries = parseMcpServerEntries(holder.mcpServersJson);
  if (currentEntries.length > 0) {
    const nextEntries = currentEntries.filter(entry => !hasMcpServerId(entry, serverId));
    if (nextEntries.length !== currentEntries.length) {
      const serialized = normalizeMcpServersJson(nextEntries);
      if (serialized === undefined) {
        delete holder.mcpServersJson;
      } else {
        holder.mcpServersJson = serialized;
      }
      changed = true;
    }
  }

  return changed;
}

function withoutKey<T>(record: T | undefined, key: string): T | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !(key in record)) return record;
  const next = { ...(record as Record<string, unknown>) };
  delete next[key];
  return next as T;
}

export function pruneMcpServerReferencesFromAppConfig<T extends McpConfigContainer>(config: T, serverId: string): T {
  const next = { ...config } as McpConfigContainer;

  next.mcpEnabledServers = (Array.isArray(config.mcpEnabledServers) ? config.mcpEnabledServers : [])
    .filter(id => id !== serverId);

  if (Array.isArray(config.agents)) {
    next.agents = config.agents.map(agent => {
      const a = asAgentMcpConfig(agent);
      if (!a) return agent;
      const cloned = { ...a };
      return pruneMcpReference(cloned, serverId) ? cloned : agent;
    });
  }

  const legacyBot = asMcpRefConfig(config.imBotConfig);
  if (legacyBot) {
    const cloned = { ...legacyBot };
    if (pruneMcpReference(cloned, serverId)) {
      next.imBotConfig = cloned;
    }
  }

  if (Array.isArray(config.imBotConfigs)) {
    next.imBotConfigs = config.imBotConfigs.map(bot => {
      const b = asMcpRefConfig(bot);
      if (!b) return bot;
      const cloned = { ...b };
      return pruneMcpReference(cloned, serverId) ? cloned : bot;
    });
  }

  const launcherLastUsed = asMcpRefConfig(config.launcherLastUsed);
  if (launcherLastUsed && Array.isArray(launcherLastUsed.mcpEnabledServers)) {
    const nextEnabled = launcherLastUsed.mcpEnabledServers.filter(id => id !== serverId);
    if (nextEnabled.length !== launcherLastUsed.mcpEnabledServers.length) {
      next.launcherLastUsed = { ...launcherLastUsed, mcpEnabledServers: nextEnabled };
    }
  }

  return next as T;
}

export function removeMcpServerDefinitionFromAppConfig<T extends McpConfigContainer>(config: T, serverId: string): T {
  const next = { ...config } as McpConfigContainer;

  next.mcpServers = (Array.isArray(config.mcpServers) ? config.mcpServers : [])
    .filter(server => server.id !== serverId);
  next.mcpServerEnv = withoutKey(config.mcpServerEnv, serverId);
  next.mcpServerArgs = withoutKey(config.mcpServerArgs, serverId);

  return next as T;
}

/**
 * Remove a custom MCP server from the AppConfig-owned stores: custom
 * definition, global gate, env/args overrides, Agent/legacy Bot selection
 * refs, legacy runtime payloads, and UI caches. Project, Session, Task, and
 * Cron references belong to their own stores and are handled by the cascade
 * service, not this helper.
 */
export function removeMcpServerFromAppConfig<T extends McpConfigContainer>(config: T, serverId: string): T {
  const withoutRefs = pruneMcpServerReferencesFromAppConfig(config, serverId);
  const withoutDefinition = removeMcpServerDefinitionFromAppConfig(withoutRefs, serverId);
  return withoutDefinition as T;
}
