import type { McpServerDefinition } from '../../../../shared/config-types';
import { isRetiredBundledMcpServer } from '../../../../shared/mcpConfig';
import { resolveMcpTemplateValue } from '../../../session-core/mcp-template-resolution';
import { NpxMcpResolutionError, resolveNpxMcpInvocation } from '../../../utils/mcp-command';

const CODEX_MCP_NO_PROXY_VAL = 'localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1';
/** Native attempt bound, deliberately independent from MyAgents' 10s dispatch grace. */
export const MANAGED_CODEX_MCP_STARTUP_TIMEOUT_SEC = 60;
const CODEX_MCP_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;
const CODEX_MCP_TEMPLATE_RE = /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/;
const CODEX_MCP_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODEX_MCP_SECRET_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/i;
const CODEX_MCP_INLINE_SECRET_RE = /(?:api[-_]?key|token|secret|password|authorization|access[-_]?token|refresh[-_]?token)\s*[:=]\s*[^,\s]+/i;
const CODEX_MCP_SENSITIVE_FLAG_RE = /^-{1,2}(?:api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|pwd|authorization|auth-token)(?:$|[=:])/i;
const CODEX_MCP_PARENT_ENV_DENY = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PWD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'MYAGENTS_RUNTIME_SOURCE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
]);

export interface ManagedCodexMcpProjectionFailure {
  serverId: string;
  state: 'failed' | 'unsupported';
  code: 'mcp_projection_rejected' | 'mcp_transport_unsupported';
  message: string;
}

export interface ManagedCodexMcpLaunchProjection {
  args: string[];
  serverNames: string[];
  acceptedServerIds: string[];
  envPatch: Record<string, string | undefined>;
  failures: ManagedCodexMcpProjectionFailure[];
}

class ManagedCodexMcpProjectionError extends Error {
  constructor(
    readonly state: ManagedCodexMcpProjectionFailure['state'],
    readonly code: ManagedCodexMcpProjectionFailure['code'],
    message: string,
  ) {
    super(message);
  }
}

function reject(reason: string): never {
  throw new ManagedCodexMcpProjectionError('failed', 'mcp_projection_rejected', reason);
}

function unsupported(reason: string): never {
  throw new ManagedCodexMcpProjectionError('unsupported', 'mcp_transport_unsupported', reason);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlInlineStringMap(values: Record<string, string>): string {
  return `{${Object.entries(values).map(([key, value]) => `${tomlKey(key)}=${tomlString(value)}`).join(',')}}`;
}

function pushCodexConfigArg(target: string[], key: string, valueToml: string): void {
  target.push('-c', `${key}=${valueToml}`);
}

function codexMcpServerName(id: string): string | null {
  const normalized = id.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return normalized || null;
}

function codexMcpEnvVarName(serverName: string, key: string): string {
  const safeServer = serverName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const safeKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return `MYAGENTS_MCP_${safeServer}_${safeKey}`.slice(0, 180);
}

function uniqueCodexMcpEnvVarName(
  serverName: string,
  key: string,
  used: Set<string>,
): string {
  const base = codexMcpEnvVarName(serverName, key);
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) {
    const suffix = `_${i}`;
    candidate = `${base.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

function hasCodexMcpTemplate(value: string): boolean {
  return CODEX_MCP_TEMPLATE_RE.test(value);
}

function unsafeCodexMcpStdioValueReason(value: string): string | null {
  if (hasCodexMcpTemplate(value)) return 'contains MyAgents env placeholder';
  if (CODEX_MCP_SECRET_VALUE_RE.test(value)) return 'contains inline secret-looking value';
  if (/bearer\s+\S+/i.test(value)) return 'contains inline bearer token';
  if (CODEX_MCP_INLINE_SECRET_RE.test(value)) return 'contains inline credential assignment';
  return null;
}

function unsafeCodexMcpStdioArgsReason(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    const valueReason = unsafeCodexMcpStdioValueReason(arg);
    if (valueReason) return `arg[${i}] ${valueReason}`;
    if (CODEX_MCP_SENSITIVE_FLAG_RE.test(arg.trim())) {
      return `arg[${i}] uses a credential flag`;
    }
    const previous = args[i - 1]?.trim();
    if (previous && CODEX_MCP_SENSITIVE_FLAG_RE.test(previous)) {
      return `arg[${i}] follows a credential flag`;
    }
  }
  return null;
}

function unsafeCodexMcpUrlReason(rawUrl: string): string | null {
  if (hasCodexMcpTemplate(rawUrl)) return 'contains MyAgents env placeholder';
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'is not a valid URL';
  }
  if (parsed.username || parsed.password) return 'contains URL userinfo';
  if (parsed.search || parsed.hash) {
    return 'contains query string or fragment that would enter argv';
  }
  if (CODEX_MCP_SECRET_VALUE_RE.test(parsed.pathname)) {
    return 'contains secret-looking path segment';
  }
  return null;
}

function canExposeMcpEnvKeyToCodexParent(key: string): boolean {
  if (!CODEX_MCP_ENV_NAME_RE.test(key)) return false;
  const upper = key.toUpperCase();
  if (upper.startsWith('CODEX_') || upper.startsWith('OPENAI_')) return false;
  if (CODEX_MCP_PARENT_ENV_DENY.has(upper)) return false;
  if ((CODEX_MCP_PROXY_ENV_KEYS as readonly string[]).some(proxyKey => proxyKey.toUpperCase() === upper)) {
    return false;
  }
  return true;
}

/**
 * Compile each selected MCP independently. A rejected optional server never
 * contaminates another server's argv/env projection and never aborts the
 * Managed Codex process. Callers use `failures` as extension component state.
 */
export function projectManagedCodexMcpLaunchConfig(
  servers: readonly McpServerDefinition[] | undefined,
  parentEnv: Readonly<Record<string, string | undefined>>,
): ManagedCodexMcpLaunchProjection {
  if (!servers || servers.length === 0) {
    return { args: [], serverNames: [], acceptedServerIds: [], envPatch: {}, failures: [] };
  }

  const args: string[] = [];
  const serverNames: string[] = [];
  const acceptedServerIds: string[] = [];
  const envPatch: Record<string, string | undefined> = {};
  const failures: ManagedCodexMcpProjectionFailure[] = [];
  const usedNames = new Set<string>();
  const assignedParentEnv = new Map<string, {
    value: string;
    serverId: string;
    source: 'stdio' | 'http-header';
  }>();

  for (const server of servers) {
    if (isRetiredBundledMcpServer(server)) continue;
    const serverArgs: string[] = [];
    const serverEnvPatch: Record<string, string | undefined> = {};
    const nextAssignedParentEnv = new Map(assignedParentEnv);
    let serverName: string | null = null;
    try {
      serverName = codexMcpServerName(server.id);
      if (!serverName || usedNames.has(serverName)) {
        reject('invalid or duplicate Codex MCP server name');
      }

      if (server.type === 'stdio') {
        const command = server.command;
        if (command === '__builtin__') {
          acceptedServerIds.push(server.id);
          continue;
        }
        if (!command) reject('missing stdio command');
        let stdioArgs = Array.isArray(server.args) ? [...server.args] : [];
        let projectedCommand = command;
        if (projectedCommand === 'npx') {
          const invocation = resolveNpxMcpInvocation(stdioArgs, {
            pinPresetPackages: server.isBuiltin === true,
          });
          projectedCommand = invocation.command;
          stdioArgs = invocation.args;
        }
        const commandReason = unsafeCodexMcpStdioValueReason(projectedCommand);
        if (commandReason) reject(`stdio command ${commandReason}`);
        const argsReason = unsafeCodexMcpStdioArgsReason(stdioArgs);
        if (argsReason) reject(`stdio args unsafe for Codex argv (${argsReason})`);

        const serverEnv = Object.entries(server.env ?? {});
        const unsafeEnvKeys = serverEnv
          .map(([key]) => key)
          .filter(key => !canExposeMcpEnvKeyToCodexParent(key));
        if (unsafeEnvKeys.length > 0) {
          reject(`env keys cannot be exposed to Codex parent process (${unsafeEnvKeys.join(', ')})`);
        }
        for (const [key, value] of serverEnv) {
          const assigned = nextAssignedParentEnv.get(key);
          if (assigned && (assigned.source !== 'stdio' || assigned.value !== value)) {
            reject(`env key ${key} conflicts with server ${assigned.serverId}`);
          }
          nextAssignedParentEnv.set(key, { value, serverId: server.id, source: 'stdio' });
          serverEnvPatch[key] = value;
        }

        pushCodexConfigArg(serverArgs, `mcp_servers.${serverName}.command`, tomlString(projectedCommand));
        pushCodexConfigArg(serverArgs, `mcp_servers.${serverName}.args`, tomlArray(stdioArgs));
        const envVars = new Set<string>();
        for (const key of CODEX_MCP_PROXY_ENV_KEYS) {
          if (parentEnv[key]) envVars.add(key);
        }
        envVars.add('NO_PROXY');
        envVars.add('no_proxy');
        for (const [key, value] of serverEnv) {
          if (!key || value === undefined) continue;
          envVars.add(key);
        }
        pushCodexConfigArg(serverArgs, `mcp_servers.${serverName}.env_vars`, tomlArray([...envVars].sort()));
        pushCodexConfigArg(
          serverArgs,
          `mcp_servers.${serverName}.startup_timeout_sec`,
          String(MANAGED_CODEX_MCP_STARTUP_TIMEOUT_SEC),
        );
      } else if (server.type === 'http') {
        if (!server.url) reject('missing HTTP MCP URL');
        const url = server.url;
        const urlReason = unsafeCodexMcpUrlReason(url);
        if (urlReason) reject(`HTTP MCP URL unsafe for Codex argv (${urlReason})`);

        const envHeaderMap: Record<string, string> = {};
        for (const [header, value] of Object.entries(server.headers ?? {})) {
          if (!header || value === undefined) continue;
          const resolvedHeaderValue = resolveMcpTemplateValue(value, server.env);
          if (resolvedHeaderValue === null) {
            reject(`HTTP header ${header} references missing env placeholder`);
          }
          const envName = uniqueCodexMcpEnvVarName(
            serverName,
            header,
            new Set(nextAssignedParentEnv.keys()),
          );
          serverEnvPatch[envName] = resolvedHeaderValue;
          nextAssignedParentEnv.set(envName, {
            value: resolvedHeaderValue,
            serverId: server.id,
            source: 'http-header',
          });
          envHeaderMap[header] = envName;
        }

        pushCodexConfigArg(serverArgs, `mcp_servers.${serverName}.url`, tomlString(url));
        if (Object.keys(envHeaderMap).length > 0) {
          pushCodexConfigArg(
            serverArgs,
            `mcp_servers.${serverName}.env_http_headers`,
            tomlInlineStringMap(envHeaderMap),
          );
        }
        pushCodexConfigArg(
          serverArgs,
          `mcp_servers.${serverName}.startup_timeout_sec`,
          String(MANAGED_CODEX_MCP_STARTUP_TIMEOUT_SEC),
        );
      } else {
        unsupported(`Codex app-server does not support MyAgents MCP type ${server.type}`);
      }

      usedNames.add(serverName);
      assignedParentEnv.clear();
      for (const [key, value] of nextAssignedParentEnv) assignedParentEnv.set(key, value);
      args.push(...serverArgs);
      Object.assign(envPatch, serverEnvPatch);
      serverNames.push(serverName);
      acceptedServerIds.push(server.id);
    } catch (error) {
      const projectionError = error instanceof ManagedCodexMcpProjectionError
        ? error
        : error instanceof NpxMcpResolutionError
          ? new ManagedCodexMcpProjectionError(
              'failed',
              'mcp_projection_rejected',
              error.message,
            )
          : new ManagedCodexMcpProjectionError(
              'failed',
              'mcp_projection_rejected',
              'unexpected launch projection failure',
            );
      failures.push({
        serverId: server.id,
        state: projectionError.state,
        code: projectionError.code,
        message: `Managed Codex MCP ${server.id} cannot be applied: ${projectionError.message}`,
      });
    }
  }

  if (serverNames.length > 0) {
    envPatch.NO_PROXY = CODEX_MCP_NO_PROXY_VAL;
    envPatch.no_proxy = CODEX_MCP_NO_PROXY_VAL;
  }
  return { args, serverNames, acceptedServerIds, envPatch, failures };
}
