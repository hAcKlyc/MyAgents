/**
 * Admin API — Self-Configuration endpoints for the CLI tool.
 *
 * All handlers follow the same pattern:
 *   1. Validate input
 *   2. If dry-run → return preview
 *   3. Write config (atomicModifyConfig)
 *   4. Update Sidecar in-memory state
 *   5. Broadcast SSE event for frontend sync
 *   6. Return result
 */

import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { cp as fsCp } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  isProjectArchived,
  isProjectVisibleToUser,
  splitProviderModelInput,
  type McpServerDefinition,
  type PermissionMode,
  type ProxySettings,
} from '../shared/config-types';
import {
  agentUsesManagedCodexProvider,
  isPermissionModeForRuntimeIdentity,
  managedCodexProviderPermissionToRuntimePermission,
} from '../shared/providerExecution';
import {
  deriveCliToolKind,
  type CliToolRegistryEntry,
} from '../shared/types/cliTools';
import { workspacePathsEqual } from '../shared/workspacePath';
import {
  IMAGE_UNDERSTANDING_TOOL_ID,
  SPEECH_RECOGNITION_TOOL_ID,
} from '../shared/official-tools';
import { removeProviderFromProxySettingsScope } from '../shared/proxyScope';
import {
  removeCustomMcpServerCascade,
  McpRemovalError,
} from './services/mcp-removal';
import { SDK_RESERVED_MCP_NAMES } from './agent-session';
import {
  findMissingEnvKeys,
  findPathCollision,
  getCliToolsBinDir,
  getCliToolsDir,
  assertCliToolTreeSelfContained,
  modifyCliToolsRegistry,
  readCliToolManifest,
  readCliToolsRegistry,
  removeCliToolDir,
  removeCliToolShim,
  writeCliToolShim,
} from './utils/cli-tools-registry';
import {
  loadConfig,
  atomicModifyConfig,
  withAgentConfigIntentLock,
  getAllMcpServers,
  getEnabledMcpServerIds,
  loadProjects,
  atomicModifyProjects,
  redactSecret,
  findProvider,
  findEffectiveProvider,
  getAllEffectiveProviders,
  getProviderSelectionError,
  isProviderDisabled,
  resolveProviderEnv,
  saveCustomProviderFile,
  deleteCustomProviderFile,
  withAvailableProvidersProjection,
  isCliToolRegistryEnabled,
  listImageUnderstandingModelOptions,
  getEffectiveOfficialToolIdsForSession,
  type AdminAppConfig,
  type AgentConfigSlim,
  type ChannelConfigSlim,
  type ProjectSlim,
} from './utils/admin-config';
import { cancellableFetch, fetchWithGeneralProxy } from './utils/cancellation';
import { ensureShellPath } from './utils/shell';
import { buildCronScope } from './utils/cron-scope';
import { readLoopbackJson } from './utils/loopback-response';
import {
  ADMIN_LOOPBACK_TIMEOUT_MS,
  managementApi,
} from './utils/management-api-client';
import { buildSessionExecutablePath } from './utils/session-executable-path';
import { getSessionEngine } from './session-engine';
import { getSessionsByAgentDir, isHistoryVisibleSession } from './SessionStore';
import {
  agentWorkspaceIdentityFailure,
  resolvePersistedAgentWorkspaceRegistry,
  type PersistedAgentWorkspaceProjection,
} from './utils/agent-workspace-identity';
import { buildProactiveAgentTogglePatch } from '../shared/proactiveAgentPolicy';
import {
  isReservedBuiltinBrowserMcpId,
  MANAGED_BROWSER_MCP_ID,
} from '../shared/browserTools';

// Long-running sidecar operations need their own budget. Anchored to the
// sidecar's internal `FETCH_TIMEOUT_MS` (300s for tarball download) plus a
// 30s buffer so the inner timeout always wins. Used by skill install routes.
const SKILL_INSTALL_LOOPBACK_TIMEOUT_MS = 330_000;
// A graceful Channel shutdown can spend up to ~20s draining one runtime, and
// Agent disable/archive may stop several sequentially. Do not let the generic
// 10s loopback budget turn a successful destructive lifecycle into an unknown
// transport outcome before Rust releases the Bridge/plugin-use registry.
const AGENT_LIFECYCLE_LOOPBACK_TIMEOUT_MS = 300_000;
import { resolve } from 'path';
import {
  setMcpServers,
  setAgents,
  getMcpServers,
  getAgentState,
  getSidecarPort,
  forceReloadActiveSession,
} from './agent-session';
import { loadEnabledAgents } from './agents/agent-loader';
import { getHomeDirOrNull } from './utils/platform';
import { join } from 'path';
import { broadcast } from './sse';
import {
  getCronTaskContext,
  markCronTaskExitRequested,
  CRON_TASK_EXIT_TEXT,
} from './tools/cron-tools';
import { getImCronContext, getSessionCronContext } from './tools/im-cron-tool';
import { getImMediaContext } from './tools/im-media-tool';
import { buildReadMeContent } from './tools/generative-ui-tool';
import { WIDGET_TRIGGER_GUIDANCE } from './system-prompt-cli-tools';
import { assertSafeFilePath } from './utils/safe-file-path';
import {
  VALID_RUNTIMES,
  RUNTIME_DISPLAY_NAMES,
  getRuntimePermissionModes,
  getDefaultRuntimePermissionMode,
  isRuntimePermissionMode,
  projectPermissionModeForRuntime,
  buildRuntimeChangePatch,
  type RuntimeType,
  type RecoveryHint,
  type RuntimePermissionMode,
  type RuntimeModelInfo,
  type RuntimeDetection,
  type RuntimeConfig,
  type RuntimeSource,
} from '../shared/types/runtime';
import { getExternalRuntime, isRuntimeSupported } from './runtimes/factory';
import { queryRuntimeModels } from './runtimes/external-session';
import { isManagedCodexRuntimeInstalled } from './runtimes/codex-command-context';
import { trackServer } from './analytics';

/**
 * Infer the analytics `source` for a CLI-originated request.
 *
 * - `MYAGENTS_PORT` is injected into AI subproc env by `buildClaudeSessionEnv()`
 *   (cli_architecture.md). When it's set, the caller is an AI agent invoking
 *   the CLI as a tool (`cli_agent`). Otherwise it's the user typing in their
 *   terminal (`cli`).
 *
 * Used by legacy handlers that do not yet carry explicit caller metadata.
 * Task lifecycle handlers instead use the actor stamped by the CLI process.
 */
function cliSource(): 'cli' | 'cli_agent' {
  return process.env.MYAGENTS_PORT ? 'cli_agent' : 'cli';
}

// ---------------------------------------------------------------------------
// Sidecar self-loopback (for thin wrappers over existing /api/skill/* routes)
// ---------------------------------------------------------------------------

async function sidecarSelf(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' = 'GET',
  body?: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const sidecarPort = getSidecarPort();
  if (!sidecarPort) {
    return {
      status: 500,
      json: { success: false, error: 'Sidecar port not initialized' },
    };
  }
  const url = `http://127.0.0.1:${sidecarPort}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }
  try {
    const resp = await cancellableFetch(url, options, {
      timeoutMs: opts?.timeoutMs ?? ADMIN_LOOPBACK_TIMEOUT_MS,
    });
    // Issue #114 — defensive read via shared helper. Map to this caller's
    // legacy {status, json} shape (sidecarSelf has callers that branch on
    // status code, so we preserve that envelope rather than collapsing to
    // a flat error object).
    const json = await readLoopbackJson(resp, 'Sidecar self-call');
    return { status: resp.status, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 500,
      json: { success: false, error: `Sidecar self-call failed: ${msg}` },
    };
  }
}

/**
 * Build an AdminResponse error from a Management API failure, preserving any
 * `recoveryHint` the helper attached (currently: unreachable-backend cases).
 *
 * Use this instead of `{ success: false, error: String(resp.error ?? 'X') }`
 * in handlers that transform the shape (e.g. list handlers that unwrap
 * `resp.tasks` / `resp.runs`) — those bypass `wrapMgmtResponse` but still
 * deserve the hint propagation. Sites that already go through
 * `wrapMgmtResponse` don't need to change.
 */
function mgmtError(
  resp: Record<string, unknown>,
  fallbackMsg: string,
): AdminResponse {
  const response: AdminResponse = {
    success: false,
    error: String(resp.error ?? fallbackMsg),
  };
  for (const field of ['code', 'suggestion', 'suggestedCommand'] as const) {
    if (typeof resp[field] === 'string' && resp[field])
      response[field] = resp[field];
  }
  const hint = resp.recoveryHint;
  if (hint && typeof hint === 'object' && !Array.isArray(hint)) {
    response.recoveryHint = hint as RecoveryHint;
  }
  return response;
}

/** Convert Management API response ({ ok, ... }) to Admin API response ({ success, data, error }) */
function wrapMgmtResponse(mgmt: Record<string, unknown>): AdminResponse {
  if (mgmt.ok) {
    const { ok: _ok, recoveryHint: _rh, ...rest } = mgmt;
    return { success: true, data: rest };
  }
  const response: AdminResponse = {
    success: false,
    error: String(mgmt.error ?? 'Unknown error'),
  };
  for (const field of ['code', 'suggestion', 'suggestedCommand'] as const) {
    if (typeof mgmt[field] === 'string' && mgmt[field])
      response[field] = mgmt[field];
  }
  // Propagate the `recoveryHint` if the Management API helper attached one
  // (currently only for unreachable-backend scenarios — see `managementApi`).
  const maybeHint = mgmt.recoveryHint;
  if (maybeHint && typeof maybeHint === 'object' && !Array.isArray(maybeHint)) {
    response.recoveryHint = maybeHint as RecoveryHint;
  }
  return response;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /**
   * Free-form success tip ("Server added.", "Restart required."). Purely
   * informational — distinct from `recoveryHint` which is a structured,
   * actionable recovery path for a failed request.
   */
  hint?: string;
  /**
   * Scope descriptor for workspace-scoped list/status reads (cron). The list
   * silently filters to the caller's workspace (a security boundary), so a
   * `{data: []}` / `Total: 0` result is easy for an Agent consumer to misread
   * as "nothing exists anywhere". Echo the scope so it can tell "empty within
   * this workspace" apart from "empty everywhere". Pair with `hint` (the
   * human/LLM-readable note). See `buildCronScope`.
   */
  scope?: {
    workspacePath: string;
    source: 'explicit' | 'default';
    visibility: string;
  };
  /**
   * Structured recovery path for recoverable errors. The CLI renders this
   * under the error line as `→ Run: <command>` so the caller (AI or human)
   * can copy-paste to correct course without digging through --help.
   *
   * Pair a `recoveryHint` with `success: false` + `error` — never emit one
   * on a success path; use `hint` there.
   */
  recoveryHint?: RecoveryHint;
  dryRun?: boolean;
  preview?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// MCP Handlers
// ---------------------------------------------------------------------------

export function handleMcpList(): AdminResponse {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const enabledIds = new Set(getEnabledMcpServerIds(config));

  const data = allServers.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: enabledIds.has(s.id),
    isBuiltin: s.isBuiltin,
    command: s.command,
    url: s.url,
    requiresConfig: s.requiresConfig,
    hasEnv: !!(s.env && Object.keys(s.env).length > 0),
  }));

  return { success: true, data };
}

/**
 * `myagents mcp show <id>` — details for a single MCP server.
 *
 * Mirrors handleAgentShow: parses user-facing config + workspace enable state
 * into one consolidated payload the AI / user can inspect without dumping the
 * whole list. Env values are redacted so an AI transcript never leaks API keys
 * (same redaction rule the model-list endpoint already uses).
 */
export async function handleMcpShow(payload: {
  id?: string;
}): Promise<AdminResponse> {
  const id = payload.id;
  if (!id) {
    return {
      success: false,
      error: 'Missing required argument: <mcp-id>',
      recoveryHint: {
        recoveryCommand: 'myagents mcp list',
        message: 'See valid MCP server ids.',
      },
    };
  }
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const server = allServers.find((s) => s.id === id);
  if (!server) {
    return {
      success: false,
      error: `MCP server '${id}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents mcp list',
        message: 'See valid MCP server ids.',
      },
    };
  }

  const globalEnabled = new Set(getEnabledMcpServerIds(config));
  const workspacePath = getCurrentWorkspacePath();
  let projectEnabled: boolean | null = null;
  if (workspacePath) {
    const projects = loadProjects();
    const project = projects.find((p) =>
      workspacePathsEqual(p.path, workspacePath),
    );
    projectEnabled = new Set(project?.mcpEnabledServers ?? []).has(id);
  }

  // Redact env values — mirrors what `model list` does for provider api keys.
  const env = server.env
    ? Object.fromEntries(
        Object.entries(server.env).map(([k, v]) => [k, redactSecret(v)]),
      )
    : undefined;

  return {
    success: true,
    data: {
      id: server.id,
      name: server.name,
      type: server.type,
      description: server.description,
      isBuiltin: !!server.isBuiltin,
      requiresConfig: !!server.requiresConfig,
      websiteUrl: server.websiteUrl,
      command: server.command,
      args: server.args,
      url: server.url,
      // Headers (for http/sse) and env (for stdio) — redacted values only.
      headers: server.headers
        ? Object.fromEntries(
            Object.entries(server.headers).map(([k, v]) => [
              k,
              redactSecret(v),
            ]),
          )
        : undefined,
      env,
      enabled: {
        global: globalEnabled.has(id),
        // null = no current workspace session → project scope n/a.
        project: projectEnabled,
      },
      workspacePath: workspacePath ?? null,
    },
  };
}

export async function handleMcpAdd(payload: {
  server: Partial<McpServerDefinition>;
  dryRun?: boolean;
}): Promise<AdminResponse> {
  const { dryRun } = payload;
  const s = payload.server;

  // Validate required fields
  if (!s.id) return { success: false, error: 'Missing required field: id' };
  if (!s.type) return { success: false, error: 'Missing required field: type' };
  if (isReservedBuiltinBrowserMcpId(s.id)) {
    return {
      success: false,
      error: `MCP ID "${s.id}" is reserved by a built-in Browser tool`,
    };
  }

  // Reject SDK reserved MCP names — these cause the Claude Agent SDK to crash (exit code 1)
  // with "Invalid MCP configuration: X is a reserved MCP name."
  const normalizedId = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (SDK_RESERVED_MCP_NAMES.includes(normalizedId)) {
    return {
      success: false,
      error: `MCP ID "${s.id}" 与 Claude SDK 内置保留名冲突，请使用其他名称（如 "my-${s.id}"）`,
    };
  }

  if (s.type === 'stdio' && !s.command) {
    return { success: false, error: 'stdio type requires "command" field' };
  }
  if ((s.type === 'sse' || s.type === 'http') && !s.url) {
    return { success: false, error: `${s.type} type requires "url" field` };
  }

  const server: McpServerDefinition = {
    id: s.id,
    name: s.name || s.id,
    type: s.type,
    description: s.description,
    command: s.command,
    // Defensive: CLI may send non-array args (boolean, string) due to parsing edge cases
    args: Array.isArray(s.args) ? s.args : undefined,
    env: s.env,
    url: s.url,
    headers: s.headers,
    isBuiltin: false,
    requiresConfig: s.requiresConfig,
    websiteUrl: s.websiteUrl,
    configHint: s.configHint,
  };

  if (dryRun) {
    if (
      (loadConfig().mcpServers ?? []).some(
        (existing) => existing.id === server.id,
      )
    ) {
      return mcpAlreadyExistsResponse(server.id);
    }
    return { success: true, dryRun: true, preview: server };
  }

  let alreadyExists = false;
  await atomicModifyConfig((c) => {
    if ((c.mcpServers ?? []).some((existing) => existing.id === server.id)) {
      alreadyExists = true;
      return c;
    }
    return {
      ...c,
      mcpServers: [...(c.mcpServers || []), server],
    };
  });
  if (alreadyExists) return mcpAlreadyExistsResponse(server.id);

  await notifyMcpChange('add', server.id);
  return {
    success: true,
    data: { id: server.id, name: server.name },
    hint: 'Server added. Use "myagents mcp enable" to activate.',
  };
}

export async function handleMcpRemove(payload: {
  id: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  try {
    const result = await removeCustomMcpServerCascade(id);
    await notifyMcpChange('remove', id);
    return { success: true, data: result, hint: 'Server removed.' };
  } catch (err) {
    const response: AdminResponse = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
    if (
      err instanceof McpRemovalError &&
      err.recoveryHint &&
      typeof err.recoveryHint === 'object'
    ) {
      response.recoveryHint = err.recoveryHint as RecoveryHint;
    }
    return response;
  }
}

export async function handleMcpEnable(payload: {
  id: string;
  scope?: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  const scope = parseMcpScope(payload.scope);
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!scope) {
    return {
      success: false,
      error: "Invalid scope. Use 'global', 'project', or 'both'.",
    };
  }

  // Verify server exists
  const allServers = getAllMcpServers();
  if (!allServers.find((s) => s.id === id)) {
    return { success: false, error: `MCP server '${id}' not found` };
  }

  if (scope === 'global' || scope === 'both') {
    await atomicModifyConfig((c) => {
      const enabled = new Set(c.mcpEnabledServers || []);
      enabled.add(id);
      return { ...c, mcpEnabledServers: Array.from(enabled) };
    });
  }

  let projectMutation: ProjectMcpMutationResult | null = null;
  if (scope === 'project' || scope === 'both') {
    projectMutation = await enableMcpForCurrentProject(id);
    if (scope === 'project' && projectMutation.status !== 'updated') {
      return projectMcpMutationFailure('enable', id, projectMutation);
    }
  }

  await notifyMcpChange('enable', id);
  const scopeLabel = scope === 'both' ? 'global + project' : scope;
  const skipHint =
    projectMutation && projectMutation.status !== 'updated'
      ? ` Project scope skipped: ${projectMcpMutationReason(projectMutation)}.`
      : '';
  return {
    success: true,
    data: { id, scope: scopeLabel, projectScope: projectMutation?.status },
    hint: `Enabled ${id} (${scopeLabel}).${skipHint}`,
  };
}

export async function handleMcpDisable(payload: {
  id: string;
  scope?: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  const scope = parseMcpScope(payload.scope);
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!scope) {
    return {
      success: false,
      error: "Invalid scope. Use 'global', 'project', or 'both'.",
    };
  }

  if (scope === 'global' || scope === 'both') {
    await atomicModifyConfig((c) => {
      const enabled = new Set(c.mcpEnabledServers || []);
      enabled.delete(id);
      return { ...c, mcpEnabledServers: Array.from(enabled) };
    });
  }

  let projectMutation: ProjectMcpMutationResult | null = null;
  if (scope === 'project' || scope === 'both') {
    projectMutation = await disableMcpForCurrentProject(id);
    if (scope === 'project' && projectMutation.status !== 'updated') {
      return projectMcpMutationFailure('disable', id, projectMutation);
    }
  }

  await notifyMcpChange('disable', id);
  const skipHint =
    projectMutation && projectMutation.status !== 'updated'
      ? ` Project scope skipped: ${projectMcpMutationReason(projectMutation)}.`
      : '';
  return {
    success: true,
    data: { id, projectScope: projectMutation?.status },
    hint: `Disabled ${id}.${skipHint}`,
  };
}

export async function handleMcpEnv(payload: {
  id: string;
  action: 'set' | 'get' | 'delete';
  env?: Record<string, string>;
}): Promise<AdminResponse> {
  const { id, action, env } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  if (action === 'get') {
    const config = loadConfig();
    const serverEnv = (config.mcpServerEnv ?? {})[id] ?? {};
    // Redact values for safety
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(serverEnv)) {
      redacted[k] = redactSecret(v);
    }
    return { success: true, data: { id, env: redacted } };
  }

  if (action === 'set') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No environment variables provided' };
    }
    await atomicModifyConfig((c) => {
      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };
      mcpServerEnv[id] = { ...(mcpServerEnv[id] || {}), ...env };
      return { ...c, mcpServerEnv };
    });
    await notifyMcpChange('env', id);
    return {
      success: true,
      data: { id, keys: Object.keys(env) },
      hint: 'Environment variables updated.',
    };
  }

  if (action === 'delete') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No keys specified for deletion' };
    }
    await atomicModifyConfig((c) => {
      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };
      if (mcpServerEnv[id]) {
        // Deep-copy per-server env to avoid mutating the original config object
        const serverEnv = { ...mcpServerEnv[id] };
        for (const key of Object.keys(env)) {
          delete serverEnv[key];
        }
        if (Object.keys(serverEnv).length === 0) {
          delete mcpServerEnv[id];
        } else {
          mcpServerEnv[id] = serverEnv;
        }
      }
      return { ...c, mcpServerEnv };
    });
    await notifyMcpChange('env', id);
    return { success: true, data: { id, deletedKeys: Object.keys(env) } };
  }

  return {
    success: false,
    error: `Unknown action: ${action}. Use 'set', 'get', or 'delete'.`,
  };
}

export async function handleMcpTest(payload: {
  id: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const allServers = getAllMcpServers();
  const server = allServers.find((s) => s.id === id);
  if (!server) return { success: false, error: `MCP server '${id}' not found` };

  const transportType = (server as { type?: unknown }).type;
  if (
    transportType !== 'stdio' &&
    transportType !== 'sse' &&
    transportType !== 'http'
  ) {
    return {
      success: false,
      error: `MCP server '${id}' has unsupported transport type '${String(transportType)}'`,
    };
  }

  // Validate config completeness
  if (server.type === 'stdio' && !server.command) {
    return {
      success: false,
      error: `MCP server '${id}' has no command configured`,
    };
  }
  if ((server.type === 'sse' || server.type === 'http') && !server.url) {
    return {
      success: false,
      error: `MCP server '${id}' has no URL configured`,
    };
  }

  // Application Browser Host: __browser_host__ is a product-owned projection
  // sentinel, never an executable. A generic stdio handshake would therefore
  // produce the misleading `spawn __browser_host__ ENOENT`. Acquiring the
  // current Session's capability is the non-disruptive readiness check: opening
  // a second MCP connection here would retire the live Session connection.
  if (
    server.id === MANAGED_BROWSER_MCP_ID &&
    server.command === '__browser_host__'
  ) {
    try {
      const { acquireBrowserCapability } = await import(
        './browser-host/capability-client'
      );
      const capability = await acquireBrowserCapability();
      return {
        success: true,
        data: {
          id,
          type: 'application-host',
          state: 'ready',
          sessionScoped: true,
          hostGeneration: capability.hostGeneration,
        },
        hint: 'MyAgents Browser Host is ready for the current Product Session. __browser_host__ is an internal projection marker, not a PATH executable.',
      };
    } catch (error) {
      return {
        success: false,
        error: `MyAgents Browser Host is unavailable for the current Product Session: ${error instanceof Error ? error.message : String(error)}`,
        data: {
          id,
          type: 'application-host',
          state: 'unavailable',
          sessionScoped: true,
        },
        recoveryHint: {
          recoveryCommand: 'myagents mcp test myagents-browser',
          message:
            'Run this check from an active MyAgents Agent Session after the application Browser Host is ready.',
        },
      };
    }
  }

  // Built-in MCP: delegate to registry.
  // getBuiltinMcpInstance() force-loads the tool module (SDK+zod+server
  // construction) on first hit; it returns undefined only when the id isn't
  // registered in META. META is registered via agent-session.ts's side-effect
  // import of './tools/builtin-mcp-meta', which already ran before any admin
  // handler can fire — no need to force-import META here.
  if (server.command === '__builtin__') {
    const { getBuiltinMcpInstance } = await import(
      './tools/builtin-mcp-registry'
    );
    const entryPromise = getBuiltinMcpInstance(server.id);
    if (!entryPromise) {
      return {
        success: false,
        error: `Built-in MCP '${server.id}' not registered`,
      };
    }
    // Don't swallow factory/import errors — a failing `myagents mcp test` must
    // surface as "failure" so users/agents diagnose the actual issue instead of
    // getting a false "validated" green light while the session keeps breaking.
    try {
      const entry = await entryPromise;
      if (entry.validate) {
        const validationError = await entry.validate(server.env || {});
        if (validationError) {
          const errMsg =
            typeof validationError === 'string'
              ? validationError
              : JSON.stringify(validationError);
          return { success: false, error: errMsg };
        }
      }
    } catch (err) {
      return {
        success: false,
        error: `Built-in MCP '${server.id}' load failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      success: true,
      data: { id, type: 'builtin' },
      hint: 'Built-in MCP validated.',
    };
  }

  // External MCPs are valid only after the exact configured transport completes
  // protocol initialization. PATH/HTTP reachability is merely a prerequisite and
  // cannot prove package resolution, args/env, framing, or MCP compatibility.
  let usedStoredOAuth = false;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const {
      MCP_CONNECTION_TEST_TIMEOUT_MS,
      McpConnectionTestError,
      testMcpServerConnection,
    } = await import('./utils/mcp-connection-test');
    const deadlineAt = Date.now() + MCP_CONNECTION_TEST_TIMEOUT_MS;
    const operation = async () => {
      let probeServer: McpServerDefinition = server;
      if (server.type === 'sse' || server.type === 'http') {
        const { resolveAuthHeaders } = await import('./mcp-oauth');
        const configHeaders = server.headers || {};
        // Match the Session path exactly: only the two canonical spellings with
        // a non-empty value suppress stored OAuth injection.
        const hasExplicitAuth = Boolean(
          configHeaders.Authorization || configHeaders.authorization,
        );
        const oauthHeaders = hasExplicitAuth
          ? {}
          : await resolveAuthHeaders(server.id);
        usedStoredOAuth = typeof oauthHeaders.Authorization === 'string';
        probeServer = {
          ...server,
          headers: { ...configHeaders, ...oauthHeaders },
        };
      }

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new McpConnectionTestError('Connection timed out (15s)');
      }
      const executablePath = buildSessionExecutablePath();
      return await testMcpServerConnection(probeServer, {
        fetch: (url, init) => fetchWithGeneralProxy(String(url), init),
        timeoutMs: remainingMs,
        executionEnv: { [executablePath.key]: executablePath.value },
        cwd: getCurrentWorkspacePath(),
      });
    };
    const overallDeadline = new Promise<never>((_, reject) => {
      operationTimer = setTimeout(() => {
        reject(new McpConnectionTestError('Connection timed out (15s)'));
      }, MCP_CONNECTION_TEST_TIMEOUT_MS);
      operationTimer.unref?.();
    });
    const result = await Promise.race([operation(), overallDeadline]);
    const identity = [result.serverName, result.serverVersion]
      .filter(Boolean)
      .join(' ');
    return {
      success: true,
      data: {
        id,
        type: result.transport,
        serverName: result.serverName,
        serverVersion: result.serverVersion,
        resolvedCommand: result.resolvedCommand,
      },
      hint: `MCP initialize succeeded${identity ? ` (${identity})` : ''}.`,
    };
  } catch (err) {
    const probeError = err as { message?: unknown; statusCode?: unknown };
    const statusCode =
      typeof probeError.statusCode === 'number'
        ? probeError.statusCode
        : undefined;
    if (statusCode === 401 || statusCode === 403) {
      const hint = usedStoredOAuth
        ? 'OAuth token may be expired or revoked. Try re-authorizing.'
        : 'This server may require OAuth authorization. Use Settings UI or `myagents mcp oauth start`.';
      return {
        success: false,
        error: `Authentication failed (HTTP ${statusCode}). ${hint}`,
      };
    }
    const message =
      typeof probeError.message === 'string' ? probeError.message : String(err);
    return { success: false, error: `MCP initialize failed: ${message}` };
  } finally {
    if (operationTimer) clearTimeout(operationTimer);
  }
}

// ---------------------------------------------------------------------------
// MCP OAuth Handlers (CLI-facing wrappers around mcp-oauth module)
// ---------------------------------------------------------------------------

/** Resolve MCP server URL from config by ID */
function getMcpServerUrl(id: string): { url: string } | { error: string } {
  const allServers = getAllMcpServers();
  const server = allServers.find((s) => s.id === id);
  if (!server) return { error: `MCP server '${id}' not found` };
  if (server.type !== 'sse' && server.type !== 'http') {
    return {
      error: `MCP server '${id}' is type '${server.type}' — OAuth only applies to sse/http servers.`,
    };
  }
  if (!server.url) return { error: `MCP server '${id}' has no URL configured` };
  return { url: server.url };
}

export async function handleMcpOAuthDiscover(payload: {
  id: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  const resolved = getMcpServerUrl(id);
  if ('error' in resolved) return { success: false, error: resolved.error };

  try {
    const { probeOAuthRequirement } = await import('./mcp-oauth');
    const result = await probeOAuthRequirement(id, resolved.url, true);
    return { success: true, data: { id, ...result } };
  } catch (err) {
    return {
      success: false,
      error: `OAuth discovery failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function handleMcpOAuthStart(payload: {
  id: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  callbackPort?: number;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  const resolved = getMcpServerUrl(id);
  if ('error' in resolved) return { success: false, error: resolved.error };

  try {
    const { authorizeServer } = await import('./mcp-oauth');
    const manualConfig = payload.clientId
      ? {
          clientId: payload.clientId,
          clientSecret: payload.clientSecret,
          scopes: payload.scopes
            ? payload.scopes.split(/[,\s]+/).filter(Boolean)
            : undefined,
          callbackPort: payload.callbackPort,
        }
      : undefined;

    const { authUrl, waitForCompletion } = await authorizeServer(
      id,
      resolved.url,
      manualConfig,
    );

    // Fire-and-forget: log completion but don't block the HTTP response.
    // CLI should poll `mcp oauth status <id>` to check completion.
    waitForCompletion.then((ok) => {
      console.log(
        `[admin] OAuth ${ok ? 'completed' : 'failed/cancelled'} for MCP ${id}`,
      );
    });

    return {
      success: true,
      data: { id, authUrl },
      hint: 'Authorization started. Complete in browser, then check with `mcp oauth status`.',
    };
  } catch (err) {
    return {
      success: false,
      error: `OAuth start failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function handleMcpOAuthStatus(payload: {
  id: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  try {
    const { getOAuthStatus } = await import('./mcp-oauth');
    const result = getOAuthStatus(id);
    return { success: true, data: { id, ...result } };
  } catch (err) {
    return {
      success: false,
      error: `OAuth status check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function handleMcpOAuthRevoke(payload: {
  id: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  try {
    const { revokeAuthorization } = await import('./mcp-oauth');
    await revokeAuthorization(id);
    return {
      success: true,
      data: { id },
      hint: 'OAuth authorization revoked.',
    };
  } catch (err) {
    return {
      success: false,
      error: `OAuth revoke failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Official Vision CLI Tool Handlers
// ---------------------------------------------------------------------------

export async function handleVisionReadme(): Promise<AdminResponse> {
  const { getVisionToolReadme } = await import('./official-tools/vision');
  return { success: true, data: { text: getVisionToolReadme() } };
}

export function handleVisionModels(): AdminResponse {
  return {
    success: true,
    data: { models: listImageUnderstandingModelOptions() },
  };
}

export async function handleVisionAnalyze(payload: {
  images?: unknown;
  image?: unknown;
  prompt?: unknown;
  promptFile?: unknown;
}): Promise<AdminResponse> {
  const rawImages = Array.isArray(payload.images)
    ? payload.images
    : payload.image !== undefined
      ? [payload.image]
      : [];
  const images = rawImages.filter(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
  const prompt =
    typeof payload.prompt === 'string' ? payload.prompt : undefined;
  const promptFile =
    typeof payload.promptFile === 'string' ? payload.promptFile : undefined;
  const { analyzeImages, visionErrorResponse } = await import(
    './official-tools/vision'
  );
  try {
    const sessionContext = getSessionEngine().getCurrentSessionContext();
    const result = await analyzeImages({
      workspacePath: sessionContext.workspacePath ?? getCurrentWorkspacePath(),
      sessionMeta: sessionContext.sessionMeta ?? null,
      images,
      prompt,
      promptFile,
    });
    trackServer('official_tool_vision_analyze', {
      tool_id: IMAGE_UNDERSTANDING_TOOL_ID,
      image_count: result.images.length,
      provider_id: result.providerId,
      model: result.model,
    });
    return { success: true, data: result };
  } catch (error) {
    const { status, error: message, recoveryHint } = visionErrorResponse(error);
    return { success: false, error: message, data: { status }, recoveryHint };
  }
}

// ---------------------------------------------------------------------------
// Model Provider Handlers
// ---------------------------------------------------------------------------

export function handleModelList(): AdminResponse {
  const config = loadConfig();
  const apiKeys = config.providerApiKeys ?? {};
  const verifyStatus = config.providerVerifyStatus ?? {};

  const allProviders = getAllEffectiveProviders(config);
  const data = allProviders.map((p) => {
    const id = String(p.id);
    const cfg = p.config as Record<string, unknown> | undefined;
    const models = (Array.isArray(p.models) ? p.models : []).flatMap(
      (model) => {
        if (!model || typeof model !== 'object') return [];
        const record = model as Record<string, unknown>;
        const modelId =
          typeof record.model === 'string' ? record.model.trim() : '';
        if (!modelId) return [];
        return [
          {
            model: modelId,
            modelName:
              typeof record.modelName === 'string' && record.modelName.trim()
                ? record.modelName
                : modelId,
          },
        ];
      },
    );
    const configuredPrimary = (
      config.providerPrimaryModels as Record<string, string> | undefined
    )?.[id];
    const primaryModel =
      configuredPrimary &&
      models.some((model) => model.model === configuredPrimary)
        ? configuredPrimary
        : typeof p.primaryModel === 'string'
          ? p.primaryModel
          : models[0]?.model;
    return {
      id,
      name: String(p.name),
      vendor: p.vendor ? String(p.vendor) : undefined,
      baseUrl: cfg?.baseUrl ? String(cfg.baseUrl) : undefined,
      isBuiltin: !!p.isBuiltin,
      protocol: p.apiProtocol ? String(p.apiProtocol) : 'anthropic',
      enabled: p.enabled !== false,
      hasApiKey: !!apiKeys[id],
      status:
        (verifyStatus[id] as unknown as Record<string, unknown>)?.status ??
        'not-set',
      primaryModel,
      models,
    };
  });

  return { success: true, data };
}

async function notifyAppConfigChanged(
  section: 'model' | 'mcp',
  action: string,
  id: string,
): Promise<void> {
  // Preserve the current Sidecar-local event for tabs connected to this
  // process, then fan out an app-scoped invalidation through Rust so every
  // renderer reloads the disk authorities regardless of Sidecar ownership.
  broadcast('config:changed', { section, action, id });
  const result = await managementApi(
    '/api/app/config-changed',
    'POST',
    {},
    { timeoutMs: 2_000 },
  );
  if (result.ok !== true) {
    const label = section === 'model' ? 'Model' : 'MCP';
    throw new Error(
      `${label} configuration was saved, but app-wide refresh failed after ${action} '${id}': ${String(result.error ?? 'unknown Management API error')}. Restart MyAgents or retry the command to refresh every open window.`,
    );
  }
}

async function notifyModelConfigChanged(
  action: string,
  id: string,
): Promise<void> {
  await notifyAppConfigChanged('model', action, id);
}

export async function handleModelSetKey(payload: {
  id: string;
  apiKey: string;
}): Promise<AdminResponse> {
  const { id, apiKey } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!apiKey)
    return { success: false, error: 'Missing required field: apiKey' };

  await atomicModifyConfig((c) =>
    withAvailableProvidersProjection({
      ...c,
      providerApiKeys: { ...(c.providerApiKeys || {}), [id]: apiKey },
    }),
  );

  await notifyModelConfigChanged('set-key', id);
  return { success: true, data: { id }, hint: `API key saved for ${id}.` };
}

export async function handleModelSetDefault(payload: {
  id: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (isProviderDisabled(id)) {
    return {
      success: false,
      error: `Provider '${id}' is disabled. Re-enable it before setting it as default.`,
    };
  }

  await atomicModifyConfig((c) => ({
    ...c,
    defaultProviderId: id,
  }));

  await notifyModelConfigChanged('set-default', id);
  return {
    success: true,
    data: { id },
    hint: `Default provider set to ${id}.`,
  };
}

export async function handleModelVerify(payload: {
  id: string;
  model?: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  // Resolve the provider before looking for an API key. Subscription providers
  // deliberately keep credentials at another owner (SDK, host UI, or runtime),
  // so treating every provider as API-key-backed routes valid subscriptions to
  // the wrong verification path.
  const config = loadConfig();
  const provider = findEffectiveProvider(id, config);
  if (!provider) {
    return {
      success: false,
      error: `Provider '${id}' not found in presets or custom providers.`,
    };
  }

  const providerConfig = (provider.config ?? {}) as Record<string, unknown>;
  const baseUrl = String(providerConfig.baseUrl ?? '');
  const authType = String(provider.authType ?? 'both');
  const apiProtocol = provider.apiProtocol as
    | 'anthropic'
    | 'openai'
    | undefined;
  const userPrimary = (
    config.providerPrimaryModels as Record<string, string> | undefined
  )?.[id];
  const verifyModel =
    payload.model ?? userPrimary ?? String(provider.primaryModel ?? '');

  const persistVerified = async (): Promise<AdminResponse> => {
    await atomicModifyConfig((c) =>
      withAvailableProvidersProjection({
        ...c,
        providerVerifyStatus: {
          ...(c.providerVerifyStatus ?? {}),
          [id]: { status: 'valid', verifiedAt: new Date().toISOString() },
        },
      }),
    );
    await notifyModelConfigChanged('verify', id);
    return {
      success: true,
      data: { id, model: verifyModel },
      hint: 'Verification successful.',
    };
  };

  try {
    const subscriptionAuth = provider.subscriptionAuth as
      | { kind?: string }
      | undefined;
    if (provider.type === 'subscription') {
      if (subscriptionAuth?.kind === 'sdk-native') {
        const { verifySubscription } = await import('./provider-verify');
        const result = await verifySubscription(verifyModel || undefined);
        if (result.success) return await persistVerified();
        return {
          success: false,
          error: result.error ?? 'Subscription verification failed',
          data: { id, detail: result.detail },
        };
      }
      if (subscriptionAuth?.kind === 'runtime-managed') {
        return {
          success: false,
          code: 'SUBSCRIPTION_AUTH_OWNER_REQUIRED',
          error: `Provider '${id}' is authenticated by its external runtime, not by a MyAgents API key.`,
          recoveryHint: {
            message:
              'Open Settings → Model Providers → Codex (订阅), then complete the MyAgents-managed login there.',
          },
        };
      }
      return {
        success: false,
        code: 'SUBSCRIPTION_AUTH_OWNER_REQUIRED',
        error: `Provider '${id}' uses a host-managed subscription login, not a MyAgents API key.`,
        recoveryHint: {
          recoveryCommand: 'myagents model list --json',
          message:
            'Open Settings → Model Providers, complete the subscription login there, and verify it from that screen.',
        },
      };
    }

    const apiKey = (config.providerApiKeys ?? {})[id];
    if (!apiKey) {
      return {
        success: false,
        error: `No API key set for provider '${id}'. Use 'myagents model set-key' first.`,
      };
    }

    const { verifyProviderViaSdk } = await import('./provider-verify');
    const result = await verifyProviderViaSdk(
      id,
      baseUrl,
      apiKey,
      authType,
      verifyModel,
      apiProtocol,
      provider.maxOutputTokens ? Number(provider.maxOutputTokens) : undefined,
      provider.maxOutputTokensParamName as
        | 'max_tokens'
        | 'max_completion_tokens'
        | 'max_output_tokens'
        | undefined,
      provider.upstreamFormat as 'chat_completions' | 'responses' | undefined,
    );

    if (result.success) {
      return await persistVerified();
    }

    return {
      success: false,
      error: result.error ?? 'Verification failed',
      data: { id, detail: result.detail },
    };
  } catch (err) {
    return {
      success: false,
      error: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function handleModelAdd(payload: {
  provider: Record<string, unknown>;
  dryRun?: boolean;
}): Promise<AdminResponse> {
  const { dryRun } = payload;
  const p = payload.provider;

  // Validate required fields
  if (!p.id) return { success: false, error: 'Missing required field: id' };
  if (!isValidId(String(p.id)))
    return {
      success: false,
      error: 'Invalid id: only alphanumeric, hyphens, and underscores allowed',
    };
  if (!p.name) return { success: false, error: 'Missing required field: name' };
  if (!p.baseUrl)
    return {
      success: false,
      error: 'Missing required field: baseUrl (API endpoint)',
    };
  if (!p.models || !Array.isArray(p.models) || p.models.length === 0) {
    return {
      success: false,
      error: 'Missing required field: models (at least one model ID required)',
    };
  }

  // Build model entities
  const modelSeries = (p.modelSeries as string) || String(p.id);
  const expandedModelIds = (p.models as unknown[]).flatMap((model) =>
    splitProviderModelInput(String(model)),
  );
  if (expandedModelIds.length === 0) {
    return {
      success: false,
      error: 'Missing required field: models (at least one model ID required)',
    };
  }
  const modelNameInputs = Array.isArray(p.modelNames)
    ? (p.modelNames as unknown[]).map((name) => String(name).trim())
    : [];
  const seenModelIds = new Set<string>();
  const uniqueModelRefs = expandedModelIds.flatMap((model, expandedIndex) => {
    if (seenModelIds.has(model)) return [];
    seenModelIds.add(model);
    return [{ model, expandedIndex }];
  });
  const modelNamesUseExpandedIndex =
    modelNameInputs.length === expandedModelIds.length;
  const models = uniqueModelRefs.map(
    ({ model, expandedIndex }, uniqueIndex) => {
      const modelName = modelNamesUseExpandedIndex
        ? modelNameInputs[expandedIndex]
        : modelNameInputs[uniqueIndex];
      return {
        model,
        modelName: modelName || model,
        modelSeries,
      };
    },
  );
  const modelIds = models.map((model) => model.model);

  // Build aliases
  let modelAliases: Record<string, string> | undefined;
  if (p.aliases && typeof p.aliases === 'object') {
    modelAliases = p.aliases as Record<string, string>;
  } else if (modelIds.length > 0) {
    // Default: map fable/sonnet/opus/haiku to first model
    modelAliases = {
      fable: modelIds[0],
      sonnet: modelIds[0],
      opus: modelIds[0],
      haiku: modelIds[0],
    };
  }

  const requestedPrimaryModel = p.primaryModel
    ? String(p.primaryModel).trim()
    : '';
  const providerObj = {
    id: String(p.id),
    name: String(p.name),
    vendor: String(p.vendor ?? p.name),
    cloudProvider: String(p.cloudProvider ?? ''),
    type: 'api' as const,
    primaryModel: modelIds.includes(requestedPrimaryModel)
      ? requestedPrimaryModel
      : modelIds[0],
    isBuiltin: false,
    config: {
      baseUrl: String(p.baseUrl),
      ...(p.timeout ? { timeout: Number(p.timeout) } : {}),
      ...(p.disableNonessential ? { disableNonessential: true } : {}),
    },
    authType: String(p.authType ?? 'auth_token'),
    ...(p.protocol === 'openai' || p.apiProtocol === 'openai'
      ? {
          apiProtocol: 'openai' as const,
          ...(p.maxOutputTokens
            ? { maxOutputTokens: Number(p.maxOutputTokens) }
            : {}),
          ...(p.maxOutputTokensParamName
            ? { maxOutputTokensParamName: String(p.maxOutputTokensParamName) }
            : {}),
          upstreamFormat: String(p.upstreamFormat ?? 'chat_completions') as
            | 'chat_completions'
            | 'responses',
        }
      : {}),
    websiteUrl: p.websiteUrl ? String(p.websiteUrl) : undefined,
    models,
    modelAliases,
  };

  if (dryRun) {
    return { success: true, dryRun: true, preview: providerObj };
  }

  // The provider file is the definition authority. Projection is derived and
  // this operation is idempotent, so retrying repairs a failed config commit.
  await saveCustomProviderFile(providerObj);
  await atomicModifyConfig((c) => withAvailableProvidersProjection(c));
  await notifyModelConfigChanged('add', providerObj.id);
  return {
    success: true,
    data: { id: providerObj.id, name: providerObj.name, models: modelIds },
    hint: `Provider added. Use 'myagents model set-key ${providerObj.id} <key>' to set API key.`,
  };
}

export async function handleModelRemove(payload: {
  id: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!isValidId(id))
    return {
      success: false,
      error: 'Invalid id: only alphanumeric, hyphens, and underscores allowed',
    };

  // Check if it's a preset
  const provider = findProvider(id);
  if (provider?.isBuiltin) {
    return {
      success: false,
      error: `Cannot remove built-in provider '${id}'. Only custom providers can be removed.`,
    };
  }

  // Commit config cleanup first. If it fails, the provider definition remains
  // untouched and the user can retry without compensating rollback machinery.
  await atomicModifyConfig((c) => {
    const apiKeys = { ...(c.providerApiKeys ?? {}) };
    delete apiKeys[id];
    const verifyStatus = { ...(c.providerVerifyStatus ?? {}) };
    delete verifyStatus[id];
    // If this was the default provider, clear it
    const defaultId =
      c.defaultProviderId === id ? undefined : c.defaultProviderId;
    // Strip the deleted id from providerOrder / disabledProviderIds so disk
    // state doesn't grow unbounded across delete-and-re-add cycles.
    const providerOrder = c.providerOrder?.filter((pid) => pid !== id);
    const disabledProviderIds = c.disabledProviderIds?.filter(
      (pid) => pid !== id,
    );
    const currentProxySettings =
      c.proxySettings &&
      typeof c.proxySettings === 'object' &&
      !Array.isArray(c.proxySettings)
        ? (c.proxySettings as ProxySettings)
        : undefined;
    const proxySettings = removeProviderFromProxySettingsScope(
      currentProxySettings,
      id,
    );
    return withAvailableProvidersProjection({
      ...c,
      providerApiKeys: apiKeys,
      providerVerifyStatus: verifyStatus,
      defaultProviderId: defaultId,
      providerOrder:
        providerOrder && providerOrder.length > 0 ? providerOrder : undefined,
      disabledProviderIds:
        disabledProviderIds && disabledProviderIds.length > 0
          ? disabledProviderIds
          : undefined,
      ...(proxySettings ? { proxySettings } : {}),
    });
  });
  if (!(await deleteCustomProviderFile(id))) {
    return { success: false, error: `Custom provider '${id}' not found.` };
  }

  await notifyModelConfigChanged('remove', id);
  return { success: true, data: { id }, hint: 'Provider removed.' };
}

// ---------------------------------------------------------------------------
// Agent Handlers
// ---------------------------------------------------------------------------

function findProjectForAgent(
  projects: ProjectSlim[],
  agent: AgentConfigSlim,
): { index: number; project: ProjectSlim } | null {
  const matches = projects
    .map((project, index) => ({ project, index }))
    .filter((entry) => entry.project.agentId === agent.id);
  if (matches.length !== 1) return null;
  const index = matches[0].index;
  return index >= 0 ? { index, project: projects[index] } : null;
}

function isProjectArchivedSlim(
  project: { archivedAt?: unknown } | null | undefined,
): boolean {
  return (
    typeof project?.archivedAt === 'string' && project.archivedAt.length > 0
  );
}

function normalizeAgentLifecycleFilter(
  value: unknown,
): 'all' | 'active' | 'archived' {
  if (value === 'active' || value === 'archived') return value;
  return value === 'all' ? 'all' : 'active';
}

function isCurrentAgentIdentity(
  identity: PersistedAgentWorkspaceProjection,
  currentWorkspacePath: string | undefined,
): boolean {
  return (
    identity.association === 'project-linked' &&
    !!currentWorkspacePath &&
    workspacePathsEqual(identity.workspacePath, currentWorkspacePath)
  );
}

export async function handleAgentList(
  payload: { lifecycle?: string } = {},
): Promise<AdminResponse> {
  try {
    const registry = await resolvePersistedAgentWorkspaceRegistry();
    const lifecycle = normalizeAgentLifecycleFilter(payload.lifecycle);
    const currentWorkspacePath = getCurrentWorkspacePath();
    const agents = registry.agentProjections
      .filter(
        (identity) =>
          !identity.project || isProjectVisibleToUser(identity.project),
      )
      .filter((identity) => {
        const archived = identity.project
          ? isProjectArchived(identity.project)
          : false;
        if (lifecycle === 'active') return !archived;
        if (lifecycle === 'archived') return archived;
        return true;
      })
      .map((identity) => {
        const { agent, project, workspacePath } = identity;
        return {
          agentId: agent.id,
          name: agent.name,
          projectId: project?.id ?? null,
          workspacePath,
          enabled: agent.enabled === true,
          archived: project ? isProjectArchived(project) : false,
          archivedAt:
            project && isProjectArchived(project)
              ? (project.archivedAt ?? null)
              : null,
          association: identity.association,
          isCurrent: isCurrentAgentIdentity(identity, currentWorkspacePath),
          channelCount: (agent.channels ?? []).length,
          channels: (agent.channels ?? []).map((channel) => ({
            id: channel.id,
            type: channel.type,
            name: channel.name,
            enabled: channel.enabled,
          })),
        };
      });
    return { success: true, data: agents };
  } catch (error) {
    return agentWorkspaceIdentityFailure(error);
  }
}

export async function handleAgentCurrent(): Promise<AdminResponse> {
  try {
    const registry = await resolvePersistedAgentWorkspaceRegistry();
    const workspacePath = getCurrentWorkspacePath() ?? defaultCronWorkspace();
    const identity = registry.agentProjections.find(
      (item) =>
        item.association === 'project-linked' &&
        !!item.project &&
        workspacePathsEqual(item.workspacePath, workspacePath),
    );
    if (!identity?.project) {
      return {
        success: false,
        error: `Current workspace is not linked to a visible Agent project: ${workspacePath}`,
        recoveryHint: {
          recoveryCommand: 'myagents agent list',
          message: 'Inspect addressable Agent workspaces.',
        },
      };
    }
    return {
      success: true,
      data: {
        agentId: identity.agent.id,
        name: identity.agent.name,
        workspaceId: identity.project.id,
        workspacePath: identity.workspacePath,
        sessionId:
          getSessionEngine().getCurrentSessionContext().sessionId ?? null,
      },
    };
  } catch (error) {
    return agentWorkspaceIdentityFailure(error);
  }
}

export async function handleAgentEnable(payload: {
  id: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  let registry: Awaited<
    ReturnType<typeof resolvePersistedAgentWorkspaceRegistry>
  >;
  try {
    registry = await resolvePersistedAgentWorkspaceRegistry();
  } catch (error) {
    return agentWorkspaceIdentityFailure(error);
  }
  const diagnostic = registry.diagnostics.find((item) =>
    item.agentIds.includes(id),
  );
  if (diagnostic)
    return { success: false, error: diagnostic.message, code: diagnostic.code };
  const projection = registry.agentProjections.find(
    (item) => item.agentId === id,
  );
  if (projection?.project && isProjectArchived(projection.project)) {
    const lifecycleAgentId = projection.project.agentId ?? id;
    return {
      success: false,
      error: `Agent '${id}' belongs to an archived workspace.`,
      recoveryHint: {
        recoveryCommand: `myagents agent unarchive ${lifecycleAgentId}`,
        message:
          'Unarchive the Agent workspace before enabling proactive capabilities.',
      },
    };
  }
  return modifyAgentConfigIntent(
    id,
    (agent) => {
      const patch = buildProactiveAgentTogglePatch(agent, true);
      return {
        ok: true,
        agent: { ...agent, ...patch },
        livePatch: {
          enabled: true,
          heartbeatConfigJson: JSON.stringify(patch.heartbeat),
          memoryAutoUpdateConfigJson: JSON.stringify(patch.memoryAutoUpdate),
          memoryEvolutionConfigJson: JSON.stringify(patch.memoryEvolution),
        },
      };
    },
    'enable',
  );
}

export async function handleAgentDisable(payload: {
  id: string;
}): Promise<AdminResponse> {
  const { id } = payload;
  return modifyAgentConfigIntent(
    id,
    (agent) => {
      const patch = buildProactiveAgentTogglePatch(agent, false);
      return {
        ok: true,
        agent: { ...agent, ...patch },
        livePatch: {
          enabled: false,
          heartbeatConfigJson: JSON.stringify(patch.heartbeat),
          memoryAutoUpdateConfigJson: JSON.stringify(patch.memoryAutoUpdate),
          memoryEvolutionConfigJson: JSON.stringify(patch.memoryEvolution),
        },
      };
    },
    'disable',
  );
}

export async function handleAgentArchive(payload: {
  id?: string;
}): Promise<AdminResponse> {
  const id = payload.id;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const config = loadConfig();
  const agent = (config.agents ?? []).find((a) => a.id === id);
  if (!agent) {
    return {
      success: false,
      error: `Agent '${id}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message: 'See valid agent ids.',
      },
    };
  }

  let archivedAt = '';
  let projectId = '';
  let agentEnabledBeforeArchive = false;
  let alreadyArchived = false;
  const wasEnabled = agent.enabled === true;
  await atomicModifyProjects((projects) => {
    const entry = findProjectForAgent(projects, agent);
    if (!entry) return projects;
    const next = [...projects];
    projectId = entry.project.id;
    alreadyArchived = isProjectArchivedSlim(entry.project);
    archivedAt = alreadyArchived
      ? String(entry.project.archivedAt)
      : new Date().toISOString();
    agentEnabledBeforeArchive = alreadyArchived
      ? entry.project.archivedAgentEnabledBeforeArchive === true
      : wasEnabled;
    next[entry.index] = {
      ...entry.project,
      archivedAt,
      archivedAgentEnabledBeforeArchive: agentEnabledBeforeArchive,
      pinnedAt: undefined,
    };
    return next;
  });

  if (!projectId) {
    return {
      success: false,
      error: `Agent '${id}' has no linked workspace project.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message:
          'Archive works on Agent workspaces registered in projects.json.',
      },
    };
  }

  if (wasEnabled) {
    await modifyAgent(
      id,
      (current) => ({ ...current, enabled: false }),
      'archive',
    );
  }

  const reloadResult = await managementApi(
    '/api/agent/reload-config',
    'POST',
    { agentId: id, patch: { enabled: false } },
    { timeoutMs: AGENT_LIFECYCLE_LOOPBACK_TIMEOUT_MS },
  );
  // Channels are lifecycle-independent from Proactive Agent, so archiving
  // explicitly stops them even when proactive/task convergence fails.
  const stopResult = await managementApi(
    '/api/agent/stop-channels',
    'POST',
    { agentId: id },
    { timeoutMs: AGENT_LIFECYCLE_LOOPBACK_TIMEOUT_MS },
  );
  if (!wasEnabled) {
    broadcast('config:changed', { section: 'project', action: 'archive', id });
  }

  if (reloadResult.ok !== true) {
    const failure = mgmtError(
      reloadResult,
      'Failed to reconcile Agent runtime',
    );
    failure.error = `Agent workspace '${id}' was archived, but proactive runtime or managed tasks did not converge: ${failure.error}`;
    return failure;
  }
  const stopOk = stopResult.ok === true;
  if (!stopOk) {
    const failure = mgmtError(stopResult, 'Failed to stop Agent channels');
    failure.error = `Agent workspace '${id}' was archived, but its running channels could not be stopped: ${failure.error}`;
    return failure;
  }
  return {
    success: true,
    data: {
      id,
      projectId,
      archivedAt,
      agentEnabledBeforeArchive,
      alreadyArchived,
      stoppedChannels: stopResult.stoppedChannels ?? 0,
    },
    hint: 'Agent workspace archived.',
  };
}

export async function handleAgentUnarchive(payload: {
  id?: string;
}): Promise<AdminResponse> {
  const id = payload.id;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const config = loadConfig();
  const agent = (config.agents ?? []).find((a) => a.id === id);
  if (!agent) {
    return {
      success: false,
      error: `Agent '${id}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list --archived',
        message: 'See archived agent ids.',
      },
    };
  }

  const projectEntry = findProjectForAgent(loadProjects(), agent);
  const projectId = projectEntry?.project.id ?? '';
  const alreadyActive =
    !!projectEntry && !isProjectArchivedSlim(projectEntry.project);
  const shouldRestoreAgent =
    projectEntry?.project.archivedAgentEnabledBeforeArchive === true;

  if (!projectId) {
    return {
      success: false,
      error: `Agent '${id}' has no linked workspace project.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list --archived',
        message:
          'Unarchive works on Agent workspaces registered in projects.json.',
      },
    };
  }

  if (alreadyActive) {
    return {
      success: true,
      data: {
        id,
        projectId,
        restoredAgentEnabled: false,
        alreadyActive: true,
      },
      hint: 'Agent workspace is already active.',
    };
  }

  let restoredAgentConfig = false;
  if (shouldRestoreAgent) {
    const restoreResult = await modifyAgent(
      id,
      (current) => ({ ...current, enabled: true }),
      'unarchive',
    );
    if (!restoreResult.success) return restoreResult;
    restoredAgentConfig = true;
  }

  try {
    await atomicModifyProjects((projects) => {
      const entry = findProjectForAgent(projects, agent);
      if (!entry || !isProjectArchivedSlim(entry.project)) return projects;
      const next = [...projects];
      const {
        archivedAt: _archivedAt,
        archivedAgentEnabledBeforeArchive: _archivedAgentEnabledBeforeArchive,
        ...rest
      } = entry.project;
      next[entry.index] = rest;
      return next;
    });
  } catch (err) {
    if (restoredAgentConfig) {
      await modifyAgent(
        id,
        (current) => ({ ...current, enabled: false }),
        'unarchive-rollback',
      );
    }
    throw err;
  }

  broadcast('config:changed', { section: 'project', action: 'unarchive', id });

  const reloadResult = await managementApi(
    '/api/agent/reload-config',
    'POST',
    { agentId: id, patch: { enabled: shouldRestoreAgent } },
    { timeoutMs: AGENT_LIFECYCLE_LOOPBACK_TIMEOUT_MS },
  );
  if (reloadResult.ok !== true) {
    const failure = mgmtError(
      reloadResult,
      'Failed to reconcile Agent runtime',
    );
    failure.error = `Agent workspace '${id}' was unarchived, but proactive runtime or managed tasks did not converge: ${failure.error}`;
    return failure;
  }

  return {
    success: true,
    data: {
      id,
      projectId,
      restoredAgentEnabled: shouldRestoreAgent,
    },
    hint: 'Agent workspace unarchived. Enabled channels will restart automatically shortly.',
  };
}

const AGENT_SET_FIELDS = [
  'enabled',
  'runtime',
  'runtimeConfig',
  'providerId',
  'model',
  'permissionMode',
] as const;

export async function handleAgentSet(payload: {
  id: string;
  key: string;
  value: unknown;
}): Promise<AdminResponse> {
  const { id, key, value } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!key) return { success: false, error: 'Missing required field: key' };

  // Protect sensitive/structural fields
  const protectedFields = ['id', 'channels'];
  if (protectedFields.includes(key)) {
    return {
      success: false,
      error: `Cannot directly set field '${key}'. Use specific commands instead.`,
    };
  }
  if (!AGENT_SET_FIELDS.includes(key as (typeof AGENT_SET_FIELDS)[number])) {
    const canonicalKey =
      key === 'provider'
        ? 'providerId'
        : key === 'permission'
          ? 'permissionMode'
          : undefined;
    return {
      success: false,
      error: canonicalKey
        ? `Unknown Agent field '${key}'; use '${canonicalKey}'. Supported fields: ${AGENT_SET_FIELDS.join(', ')}.`
        : `Unknown Agent field '${key}'. Supported fields: ${AGENT_SET_FIELDS.join(', ')}.`,
    };
  }

  if (key === 'enabled') {
    if (typeof value !== 'boolean') {
      return { success: false, error: 'enabled must be a boolean' };
    }
    return value ? handleAgentEnable({ id }) : handleAgentDisable({ id });
  }

  // `runtime` field has a cross-runtime scrub policy (see
  // buildRuntimeChangePatch doc in shared/types/runtime.ts). A blind spread
  // here would leak the previous runtime's model/permissionMode/additionalArgs
  // into the new runtime — Codex CLI then rejects e.g. a Gemini model with
  // "model is not supported when using ChatGPT account". Route through the
  // helper so the CLI `myagents agent set <id> runtime codex` path stays in
  // lockstep with the Chat / Settings / Launcher in-app paths.
  if (key === 'runtime') {
    if (typeof value !== 'string') {
      return { success: false, error: 'runtime must be a string' };
    }
    if (!VALID_RUNTIMES.includes(value as RuntimeType)) {
      return {
        success: false,
        error: `Unknown runtime: '${value}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
      };
    }
    return modifyAgentConfigIntent(
      id,
      (agent) => {
        const patch = buildRuntimeChangePatch(
          agent.runtimeConfig as RuntimeConfig | undefined,
          value as RuntimeType,
        );
        return {
          ok: true,
          agent: {
            ...agent,
            runtime: patch.runtime,
            runtimeConfig: patch.runtimeConfig,
          },
          livePatch: {
            runtime: patch.runtime,
            runtimeConfig: patch.runtimeConfig ?? null,
          },
        };
      },
      'set',
    );
  }

  if (key === 'permissionMode') {
    if (typeof value !== 'string') {
      return { success: false, error: 'permissionMode must be a string' };
    }
  }

  if (
    (key === 'providerId' || key === 'model') &&
    (typeof value !== 'string' || !value.trim())
  ) {
    return { success: false, error: `${key} must be a non-empty string` };
  }

  return modifyAgentConfigIntent(
    id,
    (agent, currentConfig) => {
      let normalizedValue = value;
      if (key === 'runtimeConfig') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return {
            ok: false,
            response: {
              success: false,
              error: 'runtimeConfig must be a JSON object.',
            },
          };
        }
        const runtimeConfig = value as RuntimeConfig;
        const targetManagedCodex = agentUsesManagedCodexProvider({
          providerId: agent.providerId,
          runtime:
            typeof agent.runtime === 'string' ? agent.runtime : undefined,
          runtimeConfig,
        });
        if (
          targetManagedCodex &&
          (runtimeConfig.source !== undefined ||
            runtimeConfig.model !== undefined ||
            runtimeConfig.permissionMode !== undefined ||
            runtimeConfig.additionalArgs !== undefined)
        ) {
          return {
            ok: false,
            response: {
              success: false,
              error:
                'Managed Codex Agent defaults keep provider/model/permission in product fields, not runtimeConfig.',
            },
          };
        }
        if (
          runtimeConfig.source === 'managed-provider' &&
          !targetManagedCodex
        ) {
          return {
            ok: false,
            response: {
              success: false,
              error:
                'runtimeConfig.source=managed-provider requires the complete managed Codex provider identity.',
            },
          };
        }
        if (runtimeConfig.permissionMode !== undefined) {
          if (typeof runtimeConfig.permissionMode !== 'string') {
            return {
              ok: false,
              response: {
                success: false,
                error: 'runtimeConfig.permissionMode must be a string.',
              },
            };
          }
          const runtime = (agent.runtime ?? 'builtin') as RuntimeType;
          if (
            runtime === 'builtin' ||
            !isRuntimePermissionMode(runtimeConfig.permissionMode, runtime)
          ) {
            return {
              ok: false,
              response: {
                success: false,
                error: `Invalid runtimeConfig.permissionMode for ${runtime}. Run 'myagents runtime describe ${runtime}' for valid values.`,
              },
            };
          }
        }
      }
      if (key === 'permissionMode') {
        const requestedMode = (value as string).trim();
        if (
          agentUsesManagedCodexProvider({
            providerId: agent.providerId,
            runtime:
              typeof agent.runtime === 'string' ? agent.runtime : undefined,
            runtimeConfig: agent.runtimeConfig as
              | { source?: string }
              | undefined,
          })
        ) {
          const validModes: PermissionMode[] = ['auto', 'plan', 'fullAgency'];
          if (!validModes.includes(requestedMode as PermissionMode)) {
            return {
              ok: false,
              response: {
                success: false,
                error: `Invalid managed Codex permissionMode. Valid: ${validModes.join(', ')}.`,
              },
            };
          }
          normalizedValue = requestedMode;
        } else {
          const validModes: PermissionMode[] = ['auto', 'plan', 'fullAgency'];
          if (!validModes.includes(requestedMode as PermissionMode)) {
            return {
              ok: false,
              response: {
                success: false,
                error: `Invalid permissionMode. Valid: ${validModes.join(', ')}.`,
              },
            };
          }
          normalizedValue = requestedMode;
        }
      }

      if (key === 'providerId' || key === 'model') {
        normalizedValue = (value as string).trim();
      }

      if (key === 'providerId') {
        const provider = getAllEffectiveProviders(currentConfig).find(
          (candidate) => candidate.id === normalizedValue,
        );
        if (!provider) {
          return {
            ok: false,
            response: {
              success: false,
              error: `Unknown providerId: '${normalizedValue}'. Run 'myagents model list' to inspect available providers.`,
            },
          };
        }
        const selectionError = getProviderSelectionError(
          provider,
          currentConfig,
        );
        if (selectionError) {
          return {
            ok: false,
            response: { success: false, error: selectionError },
          };
        }
      }

      if (key === 'model') {
        const providerId =
          typeof agent.providerId === 'string'
            ? agent.providerId
            : currentConfig.defaultProviderId;
        const provider = providerId
          ? getAllEffectiveProviders(currentConfig).find(
              (candidate) => candidate.id === providerId,
            )
          : undefined;
        if (!provider) {
          return {
            ok: false,
            response: {
              success: false,
              error:
                'Cannot validate model without an Agent providerId. Set providerId first.',
            },
          };
        }
        const selectionError = getProviderSelectionError(
          provider,
          currentConfig,
        );
        if (selectionError) {
          return {
            ok: false,
            response: { success: false, error: selectionError },
          };
        }
        const registeredModels = Array.isArray(provider.models)
          ? provider.models.flatMap((entry) => {
              if (!entry || typeof entry !== 'object') return [];
              const model = (entry as Record<string, unknown>).model;
              return typeof model === 'string' && model.trim()
                ? [model.trim()]
                : [];
            })
          : [];
        // Runtime-backed providers discover models dynamically. An empty static
        // catalogue means validation belongs to that runtime, not that no model
        // is legal. Providers with a concrete catalogue fail closed on typos.
        if (
          registeredModels.length > 0 &&
          !registeredModels.includes(String(normalizedValue))
        ) {
          return {
            ok: false,
            response: {
              success: false,
              error: `Model '${normalizedValue}' is not registered for provider '${provider.id}'.`,
            },
          };
        }
      }

      const syncExecutionDefault =
        key === 'providerId' || key === 'model' || key === 'permissionMode';
      const providerEnvJson =
        key === 'providerId'
          ? (() => {
              const resolved = resolveProviderEnv(
                String(normalizedValue),
                currentConfig,
              );
              return resolved ? JSON.stringify(resolved) : undefined;
            })()
          : undefined;
      return {
        ok: true,
        agent: {
          ...agent,
          [key]: normalizedValue,
          ...(key === 'providerId' ? { providerEnvJson } : {}),
        },
        projectPatch: syncExecutionDefault
          ? { [key]: normalizedValue }
          : undefined,
        livePatch: syncExecutionDefault
          ? {
              [key]: normalizedValue,
              ...(key === 'providerId'
                ? { providerEnvJson: providerEnvJson ?? null }
                : {}),
            }
          : undefined,
      };
    },
    'set',
  );
}

export function handleAgentChannelList(payload: {
  agentId: string;
}): AdminResponse {
  const config = loadConfig();
  const agent = (config.agents ?? []).find((a) => a.id === payload.agentId);
  if (!agent)
    return { success: false, error: `Agent '${payload.agentId}' not found` };

  return {
    success: true,
    data: (agent.channels ?? []).map((ch) => ({
      id: ch.id,
      type: ch.type,
      name: ch.name,
      enabled: ch.enabled,
    })),
  };
}

export async function handleAgentChannelAdd(payload: {
  agentId: string;
  channel: Record<string, unknown>;
}): Promise<AdminResponse> {
  const { agentId, channel } = payload;
  if (!agentId)
    return { success: false, error: 'Missing required field: agentId' };
  if (!channel.type)
    return { success: false, error: 'Missing required field: channel.type' };

  const channelId = (channel.id as string) || crypto.randomUUID();
  const newChannel: ChannelConfigSlim = {
    ...channel, // user-provided fields first
    id: channelId, // override with guaranteed values
    type: channel.type as string,
    name: (channel.name as string) || `${channel.type} channel`,
    enabled: channel.enabled !== undefined ? !!channel.enabled : true,
  };

  const result = await modifyAgent(
    agentId,
    (agent) => ({
      ...agent,
      channels: [...(agent.channels ?? []), newChannel],
    }),
    'channel-add',
  );
  if (result.success) {
    trackServer('agent_channel_create', {
      source: cliSource(),
      platform: newChannel.type,
    });
  }
  return result;
}

export async function handleAgentChannelRemove(payload: {
  agentId: string;
  channelId: string;
}): Promise<AdminResponse> {
  const { agentId, channelId } = payload;
  if (!agentId)
    return { success: false, error: 'Missing required field: agentId' };
  if (!channelId)
    return { success: false, error: 'Missing required field: channelId' };

  // Capture platform BEFORE the channel is removed — once `modifyAgent`
  // commits, the channel is gone and we can't read its type. Best-effort:
  // if the lookup fails (agent missing, channel missing) we still attempt
  // the remove and report `platform: 'unknown'` rather than skipping
  // analytics entirely.
  let platform = 'unknown';
  try {
    const config = loadConfig();
    const agent = (config.agents ?? []).find((a) => a.id === agentId);
    const ch = agent?.channels?.find((c) => c.id === channelId);
    if (ch?.type) platform = ch.type;
  } catch {
    // Silent — analytics must not affect the main flow.
  }

  const result = await modifyAgent(
    agentId,
    (agent) => ({
      ...agent,
      channels: (agent.channels ?? []).filter((ch) => ch.id !== channelId),
    }),
    'channel-remove',
  );
  if (!result.success) return result;

  trackServer('agent_channel_remove', { source: cliSource(), platform });
  const stopped = await managementApi(
    '/api/agent/stop-channel',
    'POST',
    { agentId, channelId },
    { timeoutMs: AGENT_LIFECYCLE_LOOPBACK_TIMEOUT_MS },
  );
  if (stopped.ok !== true) {
    const failure = mgmtError(stopped, 'Failed to stop Agent channel');
    failure.error = `Channel '${channelId}' was removed from Agent '${agentId}' config, but its running runtime could not be stopped: ${failure.error}`;
    return failure;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Config Handlers
// ---------------------------------------------------------------------------

export function handleConfigGet(payload: { key: string }): AdminResponse {
  const { key } = payload;
  if (!key) return { success: false, error: 'Missing required field: key' };

  const config = loadConfig();
  const value = getNestedValue(config, key);
  if (value === undefined) {
    return { success: false, error: `Config key '${key}' not found` };
  }

  // Redact sensitive fields recursively
  const redacted = redactSensitiveValues(key, value);
  return { success: true, data: { key, value: redacted } };
}

export async function handleConfigSet(payload: {
  key: string;
  value: unknown;
  dryRun?: boolean;
}): Promise<AdminResponse> {
  const { key, value, dryRun } = payload;
  if (!key) return { success: false, error: 'Missing required field: key' };

  // Reject dangerous key paths (prototype pollution)
  if (hasDangerousKeySegment(key)) {
    return { success: false, error: 'Invalid key path' };
  }

  if (key.split('.')[0] === 'cliToolRegistryEnabled') {
    return {
      success: false,
      error:
        "Cannot set 'cliToolRegistryEnabled' via config set. Enable it from Settings → About & Feedback → Lab.",
    };
  }

  // Protect structural/sensitive keys that have dedicated commands
  const protectedKeys = [
    'providerApiKeys',
    'providerVerifyStatus',
    'agents',
    'mcpServers',
    'mcpEnabledServers',
    'mcpServerEnv',
    'mcpServerArgs',
    'imBotConfigs',
    'cliToolEnv',
  ];
  const rootKey = key.split('.')[0];
  if (protectedKeys.includes(rootKey)) {
    return {
      success: false,
      error: `Cannot set '${key}' via config set. Use dedicated commands (e.g., 'myagents mcp', 'myagents agent', 'myagents model set-key').`,
    };
  }

  if (dryRun) {
    return { success: true, dryRun: true, preview: { key, value } };
  }

  await atomicModifyConfig((c) => setNestedValue(c, key, value));
  broadcast('config:changed', { section: 'config', action: 'set', key });
  return { success: true, data: { key }, hint: `Config '${key}' updated.` };
}

// ---------------------------------------------------------------------------
// Status & Reload
// ---------------------------------------------------------------------------

export function handleStatus(): AdminResponse {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const enabledIds = getEnabledMcpServerIds(config);
  const currentMcp = getMcpServers();

  return {
    success: true,
    data: {
      mcpServers: { total: allServers.length, enabled: enabledIds.length },
      activeMcpInSession: currentMcp ? currentMcp.length : 0,
      defaultProvider: config.defaultProviderId ?? 'not set',
      agents: (config.agents ?? []).length,
    },
  };
}

function resolveEffectiveMcpServersForWorkspace(
  config: AdminAppConfig,
  workspacePath: string | undefined,
  source: string,
): McpServerDefinition[] {
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));
  const globallyEnabledServers = () =>
    allServers.filter((s) => globalEnabled.has(s.id));

  if (!workspacePath) {
    return globallyEnabledServers();
  }

  const projects = loadProjects();
  const project = projects.find(
    (p) =>
      typeof p.path === 'string' && workspacePathsEqual(p.path, workspacePath),
  );
  if (!project) {
    // Treat an unregistered workspace like the no-workspace branch. The admin
    // API should not destructively clear the active session's MCP set just
    // because project metadata is temporarily missing or path identity drifted.
    console.warn(
      `[admin-api] ${source}: workspace ${workspacePath} not found in projects; falling back to global MCP set`,
    );
    return globallyEnabledServers();
  }

  const projectEnabled = new Set(project.mcpEnabledServers ?? []);
  return allServers.filter(
    (s) => globalEnabled.has(s.id) && projectEnabled.has(s.id),
  );
}

export function handleReload(workspacePath?: string): AdminResponse {
  // Re-read config from disk and push effective MCP + sub-agents to in-memory state.
  // Workspace resolution: prefer explicit arg → fall back to the session's agentDir.
  // Without this fallback, sub-agent reload would only see global agents.
  const effectiveWorkspace = workspacePath || getCurrentWorkspacePath();

  const config = loadConfig();
  const effectiveServers = resolveEffectiveMcpServersForWorkspace(
    config,
    effectiveWorkspace,
    'handleReload',
  );

  // Sub-agent reload: re-scan the .md files on disk so edits to frontmatter
  // (model, description, tools) take effect without restarting the app.
  // Mirror /api/agents/enabled's resolution — project dir (if any) + user dir.
  //
  // We read BOTH sources of truth (MCP from config.json + agents from .md files)
  // before mutating any in-memory state, so a scan failure doesn't leave the
  // caller with a half-applied reload (MCP pushed but agents stale).
  const home = getHomeDirOrNull();
  const userAgentsBaseDir = home ? join(home, '.myagents', 'agents') : '';
  const projAgentsDir = effectiveWorkspace
    ? join(effectiveWorkspace, '.claude', 'agents')
    : '';
  let agents: ReturnType<typeof loadEnabledAgents>;
  try {
    agents = loadEnabledAgents(projAgentsDir, userAgentsBaseDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[admin-api] handleReload: sub-agent re-scan failed:', err);
    return {
      success: false,
      error: `Failed to reload sub-agents from disk: ${msg}`,
    };
  }

  // Both sources loaded cleanly — now commit the in-memory state atomically
  // (well, as atomically as two module-level setters allow) and trigger the
  // forced restart that applies them.
  setMcpServers(effectiveServers);
  setAgents(agents);
  const agentCount = Object.keys(agents).length;

  // Force a session restart even for snapshotted (Tab / Cron / Background)
  // sessions — reload is an explicit request, not noise from React state
  // sync. Without this the in-memory config is refreshed but the running
  // SDK subprocess keeps delegating to the old sub-agent definitions (#98).
  forceReloadActiveSession('agents');

  broadcast('config:changed', { section: 'all', action: 'reload' });
  return {
    success: true,
    hint: `Configuration reloaded (MCP: ${effectiveServers.length}, sub-agents: ${agentCount}). The session will restart on the next turn to apply changes.`,
  };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

// Build the runtime enum line from the single source of truth (VALID_RUNTIMES).
// This prevents silent drift between docs and validator — if a runtime is
// added to the RuntimeType union, `--help` picks it up automatically.
const RUNTIMES_ENUM_LINE = VALID_RUNTIMES.join(' | ');

const CLI_TOOL_REGISTRY_DISABLED_HELP = `myagents tool — CLI tool registry

This experimental feature is currently disabled.

Enable it from Settings → About & Feedback → Lab → CLI tool registry before
using 'myagents tool ...'. The stable built-in myagents CLI commands
(cron, record, im, widget, task, runtime, etc.) remain available.`;

function taskLeafHelp(input: {
  usage: string;
  when: string;
  effect: string;
  options: string;
  mutation: string;
  output: string;
  example: string;
  recovery: string;
}): string {
  return `${input.usage}

WHEN TO CALL
  ${input.when}
EFFECT
  ${input.effect}
OPTIONS
${input.options}
MUTATION / AI
  ${input.mutation}
OUTPUT
  ${input.output}
EXAMPLE
  ${input.example}
RECOVERY
  ${input.recovery}`;
}

const HELP_TEXTS: Record<string, string> = {
  anydoc: `myagents anydoc — Convert one local document to Markdown with offline OCR

Commands:
  convert                  Submit one local document conversion job
  status <job-id>          Inspect one job
  wait <job-id>            Poll one job until it reaches a terminal state
  cancel <job-id>          Cancel a queued or running job
  list                     List recent jobs

Run myagents anydoc <command> --help for the exact contract.`,
  'anydoc/convert': `myagents anydoc convert — Submit one local document conversion

WHEN TO CALL
  Convert one Office, OpenDocument, RTF, EPUB, CSV, PDF, PNG, JPEG, or WebP file to Markdown.

EFFECT
  Creates an app-owned asynchronous job. Conversion and OCR are fully local; no GPT, cloud API, user Python, or network is required.

OPTIONS
  --file <input>           Required exactly once; local file path
  --output <directory>     Optional output root directory, never a document filename
  --password <password>    Optional transient document password
  --wait                   Poll this same job until terminal
  --json                   Emit one machine-readable JSON document

PATH / PASSWORD SAFETY
  Relative paths resolve from the CLI working directory. Links, directories, special files, and URL input are rejected. A literal --password value can be visible in shell history and local process inspection; it is never persisted, logged, echoed, or copied into recovery commands.

FIXED LIMITS
  Queue: 16 jobs. Source: 512 MiB. PDF: 500 pages. Decoded image: 100 megapixels. Published output: 128 MiB. Job deadline: 30 minutes. Control frame: 1 MiB.

ASYNC / EXIT
  Without --wait, acceptance exits 0 immediately. With --wait, success/warnings exit 0; failed/cancelled/interrupted exit 1. Ctrl-C exits 130 without cancelling the job.

OUTPUT
  <output-root>/<job-id>/document.md and referenced assets/. Omitting --output uses the current Workspace; if none is available, pass --output explicitly.

EXAMPLES
  myagents anydoc convert --file ./proposal.docx
  myagents anydoc convert --file ./scan.pdf --output ./converted --wait

ERROR RECOVERY
  Follow the returned code, suggestion, and recovery command. Use status or cancel with the accepted job ID.`,
  'anydoc/status': `myagents anydoc status <job-id> — Inspect one conversion job

WHEN TO CALL
  Check the current stage, terminal result, warnings, metrics, or artifact path.

EFFECT
  Performs one short read-only status request.

OPTIONS
  <job-id>                 Required YYYYMMDD_<12 lowercase hex>
  --json                   Machine-readable output

PATH / PASSWORD SAFETY
  Does not read source content or accept a password.

ASYNC / EXIT
  The query exits 0 when found even if the job itself failed.

OUTPUT
  Current job state, stage, output paths, warnings, error, metrics, and pipeline versions.

EXAMPLES
  myagents anydoc status 20260815_7f3a91c2b6d4

ERROR RECOVERY
  Copy the exact ID from myagents anydoc list.`,
  'anydoc/wait': `myagents anydoc wait <job-id> — Wait for one conversion job

WHEN TO CALL
  Continue only after a previously accepted job has finished.

EFFECT
  Polls short status requests with bounded backoff; it does not create another job.

OPTIONS
  <job-id>                 Required YYYYMMDD_<12 lowercase hex>
  --json                   Emit one JSON document only after completion

PATH / PASSWORD SAFETY
  Does not reopen the source or accept a password.

ASYNC / EXIT
  succeeded/succeeded_with_warnings exit 0; failed/cancelled/interrupted exit 1. Ctrl-C exits 130 and leaves the app-owned job running.

OUTPUT
  The terminal job and artifact path, or its structured terminal error.

EXAMPLES
  myagents anydoc wait 20260815_7f3a91c2b6d4

ERROR RECOVERY
  After Ctrl-C, run status or cancel with the printed job ID.`,
  'anydoc/cancel': `myagents anydoc cancel <job-id> — Cancel one conversion job

WHEN TO CALL
  Stop a queued or running conversion whose result is no longer needed.

EFFECT
  Queued jobs are cancelled immediately; running Workers receive graceful cancel and are force-stopped after the bounded grace period.

OPTIONS
  <job-id>                 Required YYYYMMDD_<12 lowercase hex>
  --json                   Machine-readable output

PATH / PASSWORD SAFETY
  Partial output is never published as a successful artifact.

ASYNC / EXIT
  A running job may first report cancelling. Repeating cancel is safe.

OUTPUT
  The updated job receipt.

EXAMPLES
  myagents anydoc cancel 20260815_7f3a91c2b6d4

ERROR RECOVERY
  Use list to recover an exact job ID; terminal jobs cannot be cancelled.`,
  'anydoc/list': `myagents anydoc list — List recent conversion jobs

WHEN TO CALL
  Discover a job ID or review recent local conversion history.

EFFECT
  Reads durable metadata only; it does not scan or delete artifact directories.

OPTIONS
  --limit <1..100>         Number of newest jobs; default 20
  --json                   Machine-readable output

PATH / PASSWORD SAFETY
  Passwords and document contents are never included.

ASYNC / EXIT
  Read-only; exits 0 when the query succeeds.

OUTPUT
  Jobs ordered by createdAt, newest first.

EXAMPLES
  myagents anydoc list --limit 20

ERROR RECOVERY
  Retry with a limit from 1 through 100.`,
  speech: `myagents speech — Transcribe one local audio/video attachment

Commands:
  transcribe --file <input>  Submit one Session-scoped ASR job
  status <job-id>            Inspect one job from this Session
  wait <job-id>              Poll one job until terminal
  cancel <job-id>            Cancel one queued or running job
  list                       List this Session's recent jobs

Session ID and Workspace are bound automatically by MyAgents. Never pass or infer caller scope.
Run myagents speech <command> --help for the exact contract.`,
  'speech/transcribe': `myagents speech transcribe --file <input> — Submit one attachment transcription

WHEN TO CALL
  Convert one supported local audio/video attachment into an ASR transcript. This command does not create a Record or perform diarization.

EFFECT
  Creates an app-owned asynchronous job bound to the exact calling Session and its authoritative Workspace.

OPTIONS
  --file <input>           Required exactly once; local Workspace file
  --output <directory>     Optional Workspace output root; default is myagents_files/speech-transcriptions
  --wait                   Poll this same job until terminal
  --json                   Emit one machine-readable JSON document

IDENTITY / PATH SAFETY
  Caller scope is injected by MyAgents and cannot be overridden. Links, special files, directories, and URLs are rejected. The source and output must remain inside the authoritative Workspace.

FIXED LIMITS
  One file, at most 4 GiB and 8 hours. Supported containers/codecs are probed from file content. Runtime deadline is max(30 minutes, twice the media duration).

ASYNC / EXIT
  Without --wait, acceptance exits 0 immediately. With --wait, success exits 0; failed/cancelled/interrupted exits 1. Ctrl-C exits 130 without cancelling.

OUTPUT
  <output-root>/<job-id>/transcript.md and transcript.json, published together only after the exact job generation succeeds.

ERROR RECOVERY
  Follow the returned code and suggestion. Missing local models return SPEECH_RESOURCE_REQUIRED; Global CLI returns SPEECH_SESSION_REQUIRED.`,
  'speech/status': `myagents speech status <job-id> — Inspect one transcription job

WHEN TO CALL
  Read the current stage or terminal result of one job submitted by this exact Session.
EFFECT
  Performs one read-only exact-Session lookup.
OPTIONS
  <job-id>                 Required exact ID from myagents speech list
  --json                   Machine-readable output
IDENTITY / PATH SAFETY
  Caller scope is injected automatically. Jobs from other Sessions are indistinguishable from missing jobs.
ASYNC / EXIT
  Exits after one status read; use wait to poll until terminal.
OUTPUT
  Job state, stage, safe artifact paths, metrics, and structured terminal error.
ERROR RECOVERY
  Copy the exact ID from myagents speech list.`,
  'speech/wait': `myagents speech wait <job-id> — Wait for one transcription job

WHEN TO CALL
  Continue only after a previously accepted job from this Session has finished.
EFFECT
  Polls status with bounded backoff and never creates another job.
OPTIONS
  <job-id>                 Required exact ID from myagents speech list
  --json                   Emit one JSON document only after completion
IDENTITY / PATH SAFETY
  Caller scope is injected automatically; no Session or Workspace option exists.
ASYNC / EXIT
  succeeded exits 0; failed/cancelled/interrupted exits 1. Ctrl-C exits 130 and leaves the app-owned job running.
OUTPUT
  The terminal job and published transcript paths, or its structured terminal error.
ERROR RECOVERY
  After Ctrl-C, run status or cancel with the printed job ID.`,
  'speech/cancel': `myagents speech cancel <job-id> — Cancel one transcription job

WHEN TO CALL
  Stop a queued or running job from this exact Session when its result is no longer needed.
EFFECT
  Requests cancellation from the app-owned speech scheduler; repeating cancel is safe.
OPTIONS
  <job-id>                 Required exact ID from myagents speech list
  --json                   Machine-readable output
IDENTITY / PATH SAFETY
  Caller scope is injected automatically. Partial output is never published as a successful artifact.
ASYNC / EXIT
  A running job may first report cancelling while the Worker stops.
OUTPUT
  The updated job receipt.
ERROR RECOVERY
  Use list to recover an exact job ID; terminal jobs cannot be cancelled.`,
  'speech/list': `myagents speech list — List recent transcription jobs from this Session

WHEN TO CALL
  Discover a job ID or review the calling Session's local transcription history.
EFFECT
  Reads durable job metadata filtered by the exact caller Session; other Sessions are never included.
OPTIONS
  --limit <1..100>         Number of newest jobs; default 20
  --json                   Machine-readable output
IDENTITY / PATH SAFETY
  Session and Workspace are injected automatically. File contents are not read by list.
ASYNC / EXIT
  Read-only; exits 0 when the query succeeds.
OUTPUT
  This Session's jobs ordered newest first.
ERROR RECOVERY
  Retry with a limit from 1 through 100.`,
  'mcp/add': taskLeafHelp({
    usage: 'myagents mcp add --id <id> [connection options] [--dry-run]',
    when: 'Use when registering a new custom MCP server.',
    effect:
      'Validates the proposed server and, unless --dry-run is set, persists it in config.json.',
    options:
      '  --dry-run              Validate and preview without writing config.json\n  See myagents mcp --help for transport options.',
    mutation:
      '--dry-run does not write or persist configuration. Without it, this mutates app configuration.',
    output: 'The normalized server preview or the created server ID.',
    example:
      '  myagents mcp add --id docs --type http --url https://example.test/mcp --dry-run',
    recovery:
      'If validation fails, correct the reported field and repeat the same dry-run.',
  }),
  'model/add': taskLeafHelp({
    usage:
      'myagents model add --id <id> --name <name> --base-url <url> --models <model> [--dry-run]',
    when: 'Use when registering a custom API-key-backed model provider.',
    effect:
      'Validates the provider and, unless --dry-run is set, persists its provider definition.',
    options:
      '  --dry-run              Validate and preview without persisting provider files or config\n  See myagents model --help for protocol and model options.',
    mutation:
      '--dry-run does not write or persist provider configuration. Without it, this mutates app configuration.',
    output: 'The normalized provider preview or the created provider ID.',
    example:
      '  myagents model add --id acme --name Acme --base-url https://api.example.test --models acme-chat --dry-run',
    recovery:
      'Resolve the validation error and repeat the dry-run before applying the mutation.',
  }),
  'model/verify': taskLeafHelp({
    usage: 'myagents model verify <provider-id> [--model <model>]',
    when: 'Use to verify an API-key provider or an SDK-native subscription.',
    effect:
      'API-key providers send a minimal provider probe. SDK-native subscriptions use their SDK login; host/runtime-managed subscriptions redirect to their credential owner.',
    options:
      '  --model <model>         Override the provider default for this verification',
    mutation:
      'A successful verification persists only verification status and time; it never copies subscription credentials.',
    output: 'Verification success, or an actionable credential-owner error.',
    example: '  myagents model verify anthropic-sub --model claude-sonnet-5',
    recovery:
      'For subscription authentication errors, follow the returned Settings or runtime recovery hint.',
  }),
  'config/set': taskLeafHelp({
    usage: 'myagents config set <key> <value> [--dry-run]',
    when: 'Use when changing one supported application configuration key.',
    effect:
      'Parses and validates the value, then persists it unless --dry-run is set.',
    options:
      '  --dry-run              Preview the parsed value without writing config.json',
    mutation:
      '--dry-run does not write or persist config.json. Without it, this mutates application configuration.',
    output: 'The parsed key/value preview or the persisted value.',
    example: '  myagents config set locale en-US --dry-run',
    recovery:
      'Run myagents config --help to inspect supported keys and value shapes.',
  }),
  mcp: `myagents mcp — Manage MCP tool servers

Commands:
  list                     List all MCP servers
  show <id>                Show one MCP server's config + enable state (env/headers redacted)
  add                      Add a new MCP server
  remove <id>              Remove a custom MCP server
  enable <id>              Enable an MCP server
  disable <id>             Disable an MCP server
  test <id>                Validate MCP server connectivity
  env <id> <action>        Manage environment variables
  oauth <action> <id>      Manage OAuth for HTTP/SSE servers

Options for 'add':
  --id          Server ID (required)
  --name        Display name (defaults to id)
  --type        stdio | sse | http (default: stdio)
  --command     Command to run (for stdio)
  --args        Arguments (repeatable)
  --url         Endpoint URL (for sse/http)
  --env         KEY=VALUE (repeatable)
  --headers     KEY=VALUE (repeatable, for sse/http)

Options for 'enable' / 'disable':
  --scope       global | project | both (default: both)

Options for 'env':
  set KEY=VALUE [KEY2=VALUE2 ...]
  get
  delete KEY [KEY2 ...]

OAuth subcommands:
  oauth discover <id>      Probe server for OAuth requirements
  oauth start <id>         Start OAuth authorization (opens browser)
  oauth status <id>        Check OAuth status
  oauth revoke <id>        Revoke stored OAuth token

Options for 'oauth start' (manual mode):
  --client-id      OAuth client ID (skip for auto mode)
  --client-secret  OAuth client secret
  --scopes         Scopes (comma or space separated)
  --callback-port  Local callback port`,

  vision: `myagents vision — Official image-understanding helper

Commands:
  readme                   Show the full image-understanding tool guide
  analyze                  Analyze one or more local workspace image paths

Options for 'analyze':
  --image <path>           Image path inside the current MyAgents workspace (repeatable)
  --prompt-file <path>     Workspace-relative text file with the inspection request
  --prompt '<text>'        Short literal request authored by the agent
  --json                   Output machine-readable JSON

Examples:
  myagents vision readme
  myagents vision analyze --image @myagents_files/screenshot.png --prompt-file inspect.txt

Use --prompt-file for user-provided, multiline, quoted, or shell-sensitive text.
The configured image-understanding model is selected in Settings -> Toolbox.`,

  model: `myagents model — Manage model providers

Commands:
  list                     List all providers (preset + custom)
  add                      Add a custom provider
  remove <id>              Remove a custom provider
  set-key <id> <api-key>   Set API key for a provider
  verify <id> [--model m]  Verify API key (sends a test message)
  set-default <id>         Set default provider

Options for 'add':
  --id            Provider ID (required)
  --name          Display name (required)
  --base-url      API endpoint URL (required)
  --models        Model IDs (repeatable, at least one)
  --model-names   Display names for models (repeatable)
  --primary-model Default model (default: first in --models)
  --auth-type     auth_token | api_key | both (default: auth_token)
  --protocol      anthropic | openai (default: anthropic)
  --upstream-format  chat_completions | responses (openai only)
  --max-output-tokens  Max output limit (openai only)
  --aliases       SDK alias mapping: sonnet=model,opus=model,haiku=model
  --vendor        Vendor name
  --website-url   Provider website`,

  config: `myagents config — Read/write application config

Commands:
  get <key>               Read a config value
  set <key> <value>       Set a config value`,

  cron: `myagents cron — Manage scheduled tasks

Commands:
  list                     List all cron tasks
                           Inspect one task with: myagents task get <taskId>
  add                      Create a new cron task
  start <id>               Start a stopped task
  stop <id>                Stop a running task
  remove <id>              Delete a task
  update <id>              Update task fields
  runs <id>                View execution history
  status                   Show cron task summary

Options for 'add':
  --name         Task name
  --prompt       AI prompt (required; alias: --message)
  --prompt-file  Read prompt body from a file (preferred for multi-line /
                 quoted / backtick content; max 1 MB)
  --schedule     Either a cron expression (e.g. "*/30 * * * *") OR a JSON
                 CronSchedule object:
                   '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}'
                   '{"kind":"every","minutes":30}'
                   '{"kind":"cron","expr":"0 9 * * *","tz":"Asia/Shanghai"}'
                 On create, non-JSON cron input is stored with the local IANA
                 timezone. JSON "tz" is optional; use it for a different
                 timezone or explicit UTC.
  --every        Interval in minutes (alternative to --schedule)
  --workspace    Workspace path. Defaults to the current session workspace.

Options for 'update' <id>:
  Same flags as add (plus --model, --permissionMode). --message is also
  accepted as an alias for --prompt here. --prompt-file is supported and
  cannot be combined with --prompt or --message.

See 'myagents task readme' for the canonical automation + exit flow.`,

  goal: `myagents goal — Manage the current session Goal Mode

Goal Mode turns the current MyAgents session into a long-running objective. MyAgents
keeps starting the next turn with the current session context until the Goal is
complete, blocked, or canceled by the user.

Use it when the User explicitly asks to start / enter / use Goal Mode, Goal
Loop, 目标模式, 设立目标, or to keep a goal running continuously until completion.
Do not infer Goal Mode from an ordinary complex request.

Commands:
  get | list                               Show the current session Goal
  create --objective-file <path>            Create a Goal from a local text file
         [--deadline <ISO-8601-with-offset>]
         [--max-executions <positive-integer>]
         [--ai-can-exit <true|false>]
  update --status complete                  Mark the active Goal complete
  update --status blocked                   Mark the active Goal blocked

Use --reason-file <path> when a terminal reason is needed. Goal objective and
reason text are file-only inputs so arbitrary user text never enters a shell
command line. Paths may point to local regular text files outside the current
workspace, including the system temp directory; files remain size/NUL/symlink
guarded.

Create options:
  --deadline       Latest time the Goal may keep running. Requires ISO-8601
                   with an explicit offset or Z; it is not a delayed start.
  --max-executions Maximum number of settled Goal turns (>= 1).
  --ai-can-exit    Whether the AI may mark complete/blocked before the other
                   end conditions are reached (default: true).

When to call:
  get
    Use when the user asks what Goal is active, or before making a state change.
    Effect: returns the current session Goal, or null if none is active.

  create
    Use only when the User explicitly asks to start Goal Mode / Goal Loop /
    目标模式 / 设立目标 / continuous goal execution. If this session already has an
    unfinished Goal, creation fails instead of replacing it.
    Effect: creates a current-session Goal and starts automatic continuation.

  update --status complete
    Use only when current evidence proves every requirement in the Goal has
    been satisfied and no required work remains.
    Effect: stops automatic continuation, marks the Goal complete, and notifies
    the user if notifications are enabled.

  update --status blocked
    Use only when the same blocker has repeated for at least three consecutive
    Goal turns and you cannot make meaningful progress without user input or an
    external-state change.
    Effect: stops automatic continuation, marks the Goal blocked, and surfaces
    the reason to the user.

Rules:
  - Do not create a Goal just because a task is long, hard, or multi-step.
  - Do not use update to pause, resume, cancel, or replace a Goal; those are
    controlled by the user/system.
  - Do not mark complete for partial progress, a stopped turn, or a plausible
    final answer without evidence.
  - With --ai-can-exit false, complete/blocked updates from the AI are rejected;
    the Goal runs until another end condition or user/system control stops it.

Examples:
  myagents goal get
  myagents goal create --objective-file goal-objective.txt --deadline 2026-07-22T09:00:00+08:00 --max-executions 12
  myagents goal update --status complete
  myagents goal update --status blocked`,

  plugin: `myagents plugin — Manage OpenClaw channel plugins (IM adapters from npm)

Commands:
  list                     List installed plugins
  install <npm-spec>       Install a plugin from npm
  remove <plugin-id>       Uninstall a plugin

Note: for Claude plugins (Anthropic plugin protocol — skills + agents + MCP
+ hooks bundled as a directory), use 'myagents cc-plugin' instead.`,

  'cc-plugin': `myagents cc-plugin — Manage Claude plugins (PRD 0.2.17)

Commands:
  list                                       List installed plugins + enabled state
  install <source>                           Install from owner/repo, github URL,
                                             .zip URL, or file:///abs/path
  uninstall <name|--id ID> [--purgeData]     Remove plugin; data dir kept unless --purgeData
  enable <name|--id ID>                      Enable an installed plugin
  disable <name|--id ID>                     Disable without uninstalling
  show <name|--id ID>                        Show manifest + component inventory

Examples:
  myagents cc-plugin install anthropics/example-plugin
  myagents cc-plugin install https://github.com/foo/bar/tree/v1.0/sub/plugin
  myagents cc-plugin install file:///Users/me/dev/my-plugin
  myagents cc-plugin enable my-plugin
  myagents cc-plugin show my-plugin
  myagents cc-plugin uninstall my-plugin --purgeData

Plugins land in ~/.myagents/plugins/<name>/ and are activated on next session
pre-warm (~1s). Different concept from OpenClaw channel plugins above —
unrelated storage, unrelated semantics.`,

  runtime: `myagents runtime — Inspect Agent Runtimes (v0.1.69+)

Commands:
  list                            List all known runtimes + install status
  describe <runtime>              Show models + permission modes for a runtime

Valid runtimes: ${RUNTIMES_ENUM_LINE}

Examples:
  myagents runtime list                       # which runtimes are installed?
  myagents runtime list --json
  myagents runtime describe codex             # models + permission modes for codex
  myagents runtime describe gemini --json

Why this exists:
  'runtime describe' is the command to consult BEFORE choosing values for
  'task create-direct --runtime / --model / --permissionMode'. The help text
  for those flags intentionally does NOT list models or modes — values depend
  on which CLI you have installed and are dynamic. Use this command instead.`,

  space: `myagents space — Discover Cloud Goals and work with Space Issues

IDENTITY AND SPACE SELECTION
  Start with \`myagents space list --json\`. Every Space business command
  requires an explicit canonical \`--space <slug>\`; there is no implicit
  default. If the current workspace is actively registered in that Space,
  commands act as that Registered Agent. Otherwise they act as the signed-in
  User with the same permissions as the UI. A delivery-bound Session refuses
  identity or workspace mismatches instead of silently falling back to User.
  Run \`myagents space whoami --space <slug> --json\` when identity is unclear.

COMMANDS
  list                                          List available Space slugs
  whoami --space <slug>                         Resolve the actor for this workspace
  goal list --space <slug>                      List Cloud Space Goals and stable IDs
  assignee list --space <slug>                  List valid typed assignee IDs
  issue create --space <slug> ...               Create an Issue, optionally with files
  issue list --space <slug> [filters]           List Issues
  issue view <id> --space <slug> --comments     Read current Issue + latest 5 comments
  issue update <id> --space <slug> ...          Edit title/body/Goal/human-only metadata
  issue comments <id> --space <slug>            Read older comments by cursor
  issue comment get <id> <commentId> ...        Read one complete comment
  issue comment <id> --space <slug> ...         Post text and/or files atomically
  issue attachment add <id> --space <slug> ... Add top-level Issue attachments now
  issue claim|complete|close|status ...          Change Issue state where permitted
  attachment download <id> --space <slug>       Download attachment bytes safely

DISCOVERY FLOW FOR AGENTS
  1. myagents space list --json
  2. myagents space whoami --space <slug> --json
  3. myagents space goal list --space <slug> --json
     myagents space assignee list --space <slug> --json
  4. Create/update using returned stable IDs
  5. myagents space issue view <issueId> --space <slug> --json

GOAL NAMESPACES
  myagents goal ...             Local Session Goal Mode
  myagents space goal list ...  Cloud Space organization Goals

HELP
  Run the exact command with --help for its Agent-oriented contract, for example:
  myagents space goal list --help
  myagents space issue update --help`,

  'space/issue': `myagents space issue — Read and mutate Cloud Space Issues

Commands:
  create                         Publish a new Issue; omit --goal for Inbox
  list                           Discover Issues by Goal, Inbox, state, or text
  view <issueId>                 Read authoritative Issue detail
  update <issueId>               Edit title/body/Goal/human-only metadata
  comments | comment get         Read comments without mutation
  comment | attachment add       Add discussion or top-level evidence
  claim | status | close | complete | cancel-claim
                                 Separate responsibility/workflow mutations

Run an exact leaf with --help before acting. Goal discovery is:
  myagents space goal list --space <slug> --json`,

  'space/list': `myagents space list — Discover canonical Space slugs

WHEN TO CALL
  Before any Space operation when the target slug is unknown or stale.
EFFECT
  Refreshes memberships from Cloud and returns only slug, name, and role.
REQUIRED CONTEXT
  A signed-in MyAgents Space session. This discovery command needs no --space.
OPTIONS
  --json  Return {items:[{slug,name,role}]} for reliable selection.
ACTOR AND PERMISSIONS
  Runs as the signed-in User and exposes only that User's memberships.
FILE SAFETY
  Does not read or upload files.
OUTPUT
  Canonical slugs accepted by every other Space command.
EXAMPLES
  myagents space list --json
RECOVERY
  If the expected Space is absent, verify membership in the Space UI and retry.`,

  'space/whoami': `myagents space whoami — Resolve the effective Space actor

WHEN TO CALL
  Before a mutation when you are unsure whether this workspace acts as User or Registered Agent.
EFFECT
  Resolves and reports the actor, Space, role, and binding source without exposing tokens.
REQUIRED CONTEXT
  --space <slug> is required. Run from the intended workspace.
OPTIONS
  --workspacePath <path>  Recovery override; current working directory is preferred.
  --json                  Return structured identity data.
ACTOR AND PERMISSIONS
  Active matching registration => Registered Agent; otherwise => signed-in User.
  Delivery-bound Sessions never fall back across a binding mismatch.
FILE SAFETY
  Does not read or upload files.
OUTPUT
  Effective actor type/id/name, membership role, and binding source.
EXAMPLES
  myagents space whoami --space myagents --json
RECOVERY
  Run \`myagents space list --json\` if the slug is rejected; remove duplicate registrations if binding is ambiguous.`,

  'space/assignee/list': `myagents space assignee list — List valid assignee targets

WHEN TO CALL
  Before creating an Issue with --assignee.
EFFECT
  Returns all assignee targets the resolved actor may use; it does not mutate an Issue.
REQUIRED CONTEXT
  --space <slug> is required. Run from the intended workspace.
OPTIONS
  --json  Recommended; copy one returned assigneeId exactly.
ACTOR AND PERMISSIONS
  Results are permission-filtered. IDs are typed as agent:<id> or user:<id>;
  never substitute a display name because names may collide.
FILE SAFETY
  Does not read or upload files.
OUTPUT
  items with assigneeId, type, name, isSelf, and Agent owner metadata when applicable.
EXAMPLES
  myagents space assignee list --space myagents --json
RECOVERY
  Run space whoami if expected candidates are missing; do not invent or strip the ID prefix.`,

  'space/goal/list': `myagents space goal list — List the Cloud Goal tree for one Space

WHEN TO CALL
  Before using --goal on space issue create, update, or list. Copy a stable active Goal ID; never guess from a title or path.
EFFECT
  Reads the selected Space's Goal tree only. By default archived Goals are omitted. It does not enter or modify Session Goal Mode.
REQUIRED CONTEXT
  --space <slug> is required. Run from the workspace whose User/Registered Agent identity should be used.
OPTIONS
  --include-archived  Include archived Goals for diagnosis; archived IDs cannot be assigned.
  --json              Recommended; copy one active data.items[].id exactly into --goal.
ACTOR AND PERMISSIONS
  Uses the automatically resolved User or Registered Agent. It never falls back to User when an Agent binding or Space context is invalid.
FILE SAFETY
  Does not read, write, or upload local files.
OUTPUT
  The full Goal tree with stable id, parentGoalId, depth, context, archivedAt, and goalPathLabel. No pagination.
EXAMPLES
  myagents space goal list --space myagents --json
  myagents space goal list --space myagents --include-archived --json
RECOVERY
  Run space list for a valid slug and space whoami for identity. If a write rejects a Goal, list active Goals again and copy a current items[].id.

NOTE
  \`myagents goal ...\` controls local Session Goal Mode. \`myagents space goal list ...\` reads Cloud Space organization Goals; they are different resources.`,

  'space/issue/create': `myagents space issue create — Create a Space Issue atomically

WHEN TO CALL
  When the User or current Agent needs to publish a new request, problem, or work item. Run space goal list before choosing --goal.
EFFECT
  Creates one Issue with its body and optional attachments in one operation. Without --goal it enters Inbox; default is unassigned.
REQUIRED CONTEXT
  --space <slug>, --title <text>, and a non-empty --body or --body-file are required.
OPTIONS
  --goal <goalId>  Optional active ID returned by space goal list. --assignee agent:<id>|user:<id>  Optional typed target.
  --attachment <path>  Repeatable (alias: --file). --human-only  Mark human-only.
ACTOR AND PERMISSIONS
  Uses the automatically resolved User or Registered Agent. Run assignee list before --assignee.
FILE SAFETY
  Files must be regular non-symlinks inside the current workspace; max 5 files, 25 MB each.
OUTPUT
  The created Issue including goalId, goalPathLabel, and top-level attachment metadata.
EXAMPLES
  myagents space issue create --space myagents --title "Inbox request" --body-file issue.md --json
  myagents space goal list --space myagents --json
  myagents space issue create --space myagents --title "Login fails" --body-file issue.md --goal goal_cli --attachment screenshot.png --json
RECOVERY
  For a rejected Goal, list active Goals again and copy data.items[].id; never guess from title/path. Run whoami for identity and assignee list for a rejected assignee ID.`,

  'space/issue/update': `myagents space issue update — Edit an existing Space Issue's metadata

WHEN TO CALL
  To edit title/body, move a published Issue to an active Space Goal, return it to Inbox, or change human-only metadata.
EFFECT
  Patches only the fields explicitly provided. It does not change workflow state, assignee, claim, comments, or attachments.
REQUIRED CONTEXT
  <issueId>, --space <slug>, and at least one update field are required. Read the current Issue first when acting on a delivery.
OPTIONS
  --title <text>
  --body <text> | --body-file <workspace-relative-path> | --stdin
  --goal <goalId> | --clear-goal
  --human-only <true|false>
  --json
  Goal and body alternatives are mutually exclusive. This command does not support --dry-run.
ACTOR AND PERMISSIONS
  Uses the automatically resolved User or Registered Agent. Owner/Admin may edit; otherwise only the creator may edit while the Issue is open.
FILE SAFETY
  --body-file must resolve inside the current workspace and is read as text. This command does not upload files.
OUTPUT
  The authoritative updated Issue, including goalId, goalPathLabel, state, assignee, notificationVersion, and updatedAt.
EXAMPLES
  myagents space goal list --space myagents --json
  myagents space issue update iss_123 --space myagents --goal goal_cli --json
  myagents space issue update iss_123 --space myagents --clear-goal --json
  myagents space issue update iss_123 --space myagents --title "Updated title" --body-file issue.md --human-only false --json
RECOVERY
  For a rejected Goal, list active Goals again and copy data.items[].id. For a conflict, view the current Issue and retry intentionally. For permission errors, run space whoami.

NOTE
  Omit both --goal and --clear-goal to leave Goal unchanged. Use --clear-goal, never --goal null/inbox/empty, to move the Issue to Inbox.`,

  'space/issue/comment': `myagents space issue comment — Post a comment with optional attachments

WHEN TO CALL
  To add progress, evidence, a reply, or files to an existing Issue.
EFFECT
  Creates one comment and binds all supplied files to that comment atomically; files do not enter the top attachment list.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required. Provide text, files, or both.
OPTIONS
  --body <text> | --body-file <path> | --stdin. --attachment <path> is repeatable (alias: --file).
ACTOR AND PERMISSIONS
  Uses the automatically resolved User or Registered Agent and normal Issue comment permissions.
FILE SAFETY
  Body/files resolve inside the workspace; attachment symlinks and files over 25 MB are rejected; max 5.
OUTPUT
  The created comment with nested attachment metadata.
EXAMPLES
  myagents space issue comment iss_123 --space myagents --body-file reply.md --attachment report.pdf --json
  myagents space issue comment iss_123 --space myagents --attachment evidence.zip --json
RECOVERY
  Use issue view to refresh state. If a file is rejected, choose a regular workspace file and retry the whole atomic operation.`,

  'space/issue/comment/get': `myagents space issue comment get — Read one complete comment

WHEN TO CALL
  When a delivery trigger says a comment is truncated or you need its exact attachment metadata.
EFFECT
  Reads one comment by stable ID without changing delivery or Issue state.
REQUIRED CONTEXT
  <issueId>, <commentId>, and --space <slug> are required.
OPTIONS
  --json  Recommended for body, author, and nested attachments.
ACTOR AND PERMISSIONS
  Uses the resolved actor and normal Issue read permission.
FILE SAFETY
  Does not download attachment bytes; use space attachment download explicitly.
OUTPUT
  One full comment with attachments.
EXAMPLES
  myagents space issue comment get iss_123 comment_456 --space myagents --json
RECOVERY
  Run issue view to verify current IDs if the Issue or comment is not found.`,

  'space/issue/complete': `myagents space issue complete — Complete an Issue with an optional result comment

WHEN TO CALL
  Only after the requested work is actually complete.
EFFECT
  Atomically completes Cloud state with optional result text/files, then safely marks --taskId done.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required. In attached work, pass the local --taskId.
OPTIONS
  --body-file <path>; --attachment <path> repeatable (alias: --file); --taskId <id>; --message <text>.
ACTOR AND PERMISSIONS
  Uses the resolved actor. The actor must own/hold the active assignment or have permitted completion rights.
FILE SAFETY
  Result files must be regular non-symlinks inside the workspace; max 5 files, 25 MB each.
OUTPUT
  Cloud completion, stable operation key, and local Task transition result.
EXAMPLES
  myagents space issue complete iss_123 --space myagents --taskId task_123 --body-file result.md --attachment artifact.zip --json
RECOVERY
  Treat an already-complete response as success. Rerun the same command if only the local Task transition failed.`,

  'space/issue/attachment/add': `myagents space issue attachment add — Add top-level files to a published Issue

WHEN TO CALL
  To supplement the Issue body itself after publication, not to attach files to a comment.
EFFECT
  Uploads files immediately as top-level Issue attachments and emits one Issue update/delivery.
REQUIRED CONTEXT
  <issueId>, --space <slug>, and at least one --file <path> are required.
OPTIONS
  --file <path>  Repeat up to five times. --json  Return attachment metadata.
ACTOR AND PERMISSIONS
  Uses the automatically resolved actor and normal Issue update permissions.
FILE SAFETY
  Each file must be a regular non-symlink inside the workspace and no larger than 25 MB.
OUTPUT
  Added top-level attachment metadata and updated Issue facts.
EXAMPLES
  myagents space issue attachment add iss_123 --space myagents --file report.pdf --file screenshot.png --json
RECOVERY
  Use issue comment instead when the files belong to a new comment.`,

  'space/attachment/download': `myagents space attachment download — Download one attachment

WHEN TO CALL
  After issue/comment metadata gives an attachment id and its bytes are needed.
EFFECT
  Downloads the attachment into the workspace without changing Issue state.
REQUIRED CONTEXT
  <attachmentId> and --space <slug> are required.
OPTIONS
  --output <workspace-relative-path>  Optional safe destination.
ACTOR AND PERMISSIONS
  Uses the resolved actor and verifies the attachment belongs to the selected Space.
FILE SAFETY
  Output stays inside the workspace; unsafe or escaping paths are rejected.
OUTPUT
  Name, relativePath, fullPath, and sizeBytes.
EXAMPLES
  myagents space attachment download att_123 --space myagents --output myagents_files/space/report.pdf --json
RECOVERY
  Re-read the Issue/comment for a current attachment id; verify --space with space list.`,

  'space/issue/list': `myagents space issue list — List Issues in one explicit Space

WHEN TO CALL
  To discover current Issue ids or filter work before reading one Issue.
EFFECT
  Reads Issues only; it does not claim or mutate them.
REQUIRED CONTEXT
  --space <slug> is required.
OPTIONS
  --goal <goalId>|inbox
  --include-subtree <true|false>  Defaults to true when filtering by a Goal ID.
  --state <state> --query <text> --limit <n> --cursor <cursor> --human-only.
  Copy <goalId> from space goal list. "inbox" is only a list filter; it is not the update clear syntax.
ACTOR AND PERMISSIONS
  Uses the resolved User or Registered Agent and returns only visible Issues.
FILE SAFETY
  Does not read or write local files.
OUTPUT
  A cursor-paged Issue list.
EXAMPLES
  myagents space goal list --space myagents --json
  myagents space issue list --space myagents --goal goal_product --include-subtree true --state todo --json
  myagents space issue list --space myagents --goal inbox --json
RECOVERY
  Run space list for a valid slug and goal list for a current Goal ID; set --include-subtree false to match only that exact Goal.`,

  'space/issue/get': `myagents space issue view — Read the current server state of one Issue

WHEN TO CALL
  Before acting on an Issue or after receiving a delivery trigger.
EFFECT
  Reads current Issue facts and optionally the latest five comments.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required.
OPTIONS
  --comments includes the latest five comments; --comments-cursor continues from a known cursor.
ACTOR AND PERMISSIONS
  Uses the resolved actor; visibility matches that actor's Space permissions.
FILE SAFETY
  Returns attachment metadata only; use attachment download for bytes.
OUTPUT
  Issue detail including issue.goalId and issue.goalPathLabel, top-level attachments, latest comments, and claim facts. goalId=null means Inbox in human output.
EXAMPLES
  myagents space issue view iss_123 --space myagents --comments --json
RECOVERY
  List Issues again if the id is stale; Goal reference/context comes from this current server detail, not delivery metadata.`,

  'space/issue/comments': `myagents space issue comments — Page older Issue comments

WHEN TO CALL
  When issue view reports more comments beyond its latest-five window.
EFFECT
  Reads a cursor page without mutating the Issue.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required.
OPTIONS
  --limit <n> and --cursor <opaque-cursor>.
ACTOR AND PERMISSIONS
  Uses the resolved actor and the same visibility as issue view.
FILE SAFETY
  Returns nested attachment metadata only.
OUTPUT
  Comment items plus hasMore/nextCursor.
EXAMPLES
  myagents space issue comments iss_123 --space myagents --limit 20 --json
RECOVERY
  Re-run issue view to obtain current pagination facts if a cursor is rejected.`,

  'space/issue/status': `myagents space issue status — Change an Issue workflow state

WHEN TO CALL
  Only when the requested workflow transition is intentional.
EFFECT
  Updates Issue state and triggers normal Cloud notification behavior.
REQUIRED CONTEXT
  <issueId>, <state>, and --space <slug> are required.
OPTIONS
  State is positional or --state; use the exact state accepted by Cloud.
ACTOR AND PERMISSIONS
  Uses the resolved actor; Cloud enforces role and ownership rules.
FILE SAFETY
  Does not read local files.
OUTPUT
  Updated state facts.
EXAMPLES
  myagents space issue status iss_123 todo --space myagents --json
RECOVERY
  Read the Issue again and choose a permitted transition; do not retry permission failures blindly.`,

  'space/issue/claim': `myagents space issue claim — Claim responsibility for an Issue

WHEN TO CALL
  When the current Registered Agent will own and process the Issue.
EFFECT
  Creates or reuses the Cloud claim; --create-attached also creates and links a local Task.
REQUIRED CONTEXT
  <issueId> and --space <slug>; delivery flows should also pass --deliveryId.
OPTIONS
  --create-attached plus task metadata links local execution after Cloud claim succeeds.
ACTOR AND PERMISSIONS
  Registered Agent claim rules are Cloud-enforced; User claim behavior follows User permissions.
FILE SAFETY
  Task markdown files must remain inside the workspace.
OUTPUT
  Claim facts and, when requested, the attached Task/session linkage.
EXAMPLES
  myagents space issue claim iss_123 --space myagents --deliveryId del_123 --json
RECOVERY
  Read the current Issue first; if attached Task creation fails, follow the returned rollback/recovery command.`,

  'space/issue/close': `myagents space issue close — Close an Issue without a completion payload

WHEN TO CALL
  When Cloud workflow rules allow the resolved actor to close the Issue directly.
EFFECT
  Transitions the Issue to closed and emits normal updates/deliveries.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required.
OPTIONS
  No file options; use issue complete for result comments or attachments.
ACTOR AND PERMISSIONS
  Cloud enforces creator/admin/owner rules.
FILE SAFETY
  Does not read local files.
OUTPUT
  Closed Issue facts.
EXAMPLES
  myagents space issue close iss_123 --space myagents --json
RECOVERY
  Read the Issue and use comment or complete when close is not permitted.`,

  'space/issue/cancel-claim': `myagents space issue cancel-claim — Release the current claim

WHEN TO CALL
  For explicit rollback/recovery of a claim that should no longer be owned.
EFFECT
  Cancels the claim and lets Cloud reopen/refanout according to Issue rules.
REQUIRED CONTEXT
  <issueId> and --space <slug> are required.
OPTIONS
  --rollback and --expected-notification-version support attached-task recovery.
ACTOR AND PERMISSIONS
  Only the owning actor or an authorized Space role may cancel the claim.
FILE SAFETY
  Does not access local files.
OUTPUT
  Claim cancellation and reopened Issue facts.
EXAMPLES
  myagents space issue cancel-claim iss_123 --space myagents --rollback --json
RECOVERY
  Re-read the Issue if the notification version changed; never fabricate rollback values.`,

  task: `myagents task — Manage Task Center tasks (v0.1.69+)

Commands:
  list                            Compact current-workspace list (--query / --limit supported)
  get <taskId>                    Task metadata + .task/ doc paths
  create-direct <name>            Create a task with inline task.md content
  create-attached                 Create a running task attached to the current AI session
  update <taskId>                 Patch task fields (schedule / notification /
                                  prompt / overrides). Rejected while running.
  update-status <taskId> <status> Transition state (running/verifying/done/blocked/stopped)
  append-session <taskId> <sid>   Link an SDK session id to a task
  run <taskId>                    Enable the Task scheduler from todo
  start <taskId>                  Resume a stopped schedule and return its next tick
  stop <taskId>                   Pause schedule and stop an active execution
  runs <taskId> [--limit N]       Show recent AI execution records
  exit [--reason <text>]          End the current eligible scheduled Task from inside its run
  readme                          Full scheduled/conditional automation guide
  run-now <taskId>                Bypass Detector and dispatch one AI execution
  rerun <taskId>                  Reset to 'todo' and dispatch
  check-now <taskId>              Run Detector now; activate AI only on a hit
  trigger validate --spec-file <json>
                                  Validate a Trigger without running it
  trigger test <taskId> [--checkpoint-file <json>] [--expect quiet|activate]
  trigger test --spec-file <json> --workspacePath <abs> [--checkpoint-file <json>]
                                  Really run the command, but do not commit MyAgents
                                  state, create an event, or activate AI
  reset-checkpoint <taskId>       Clear the platform-managed Detector checkpoint
  archive <taskId>                User-only recoverable long-lived archive state
  delete <taskId>                 Irreversible product deletion (alias: remove)

Options for 'create-direct':
  --name               Task name (required; may also be the 1st positional)
  --executor           'agent' | 'user' (default: agent)
  --description        Short description
  --workspaceId        Explicit cross-workspace project id (normally omit)
  --workspacePath      Explicit cross-workspace absolute path (normally omit)
  --taskMdFile <path>  Read task.md body from a file (preferred for multi-line
                       markdown — avoids shell-escape hell). Max 1 MB.
  --taskMdContent      Inline task.md body (use --taskMdFile instead when
                       content spans multiple lines / has backticks / quotes).
                       Exactly one of --taskMdFile / --taskMdContent must be set.
    --executionMode      'once' | 'scheduled' | 'recurring' (default: once)
  --runMode            'single-session' | 'new-session'
  --preselectedSessionId current|<id>
                       Required for single-session; current resolves from
                       MYAGENTS_SESSION_ID before the Task is created
  --trigger-file <path> Strict Trigger v1 JSON (always or command Detector)
  --tags               Comma-separated tag list
  --sourceRecordId     Link back to the originating Record

End conditions for scheduled/recurring Task creation:
  --deadline 2026-08-31T23:59:00+08:00  Stop starting AI turns after this instant
  --maxExecutions <n>                    Cap settled AI turns; quiet checks do not count
  --aiCanExit true|false                 Allow the Task AI to call 'task exit'

Scheduling (for executionMode = 'recurring' / 'scheduled'; omitting
--intervalMinutes on recurring silently defaults to 60 min — the CLI now
emits a warning when you do):
  --intervalMinutes <n>            Fixed interval in minutes (recurring; min 5)
  --startAt <ISO-with-offset>       First interval tick. Without it, the first
                                   interval tick is about 2 seconds after run.
  --cronExpression "0 */3 * * *"   Cron expression (recurring; takes precedence over interval)
  --cronTimezone Asia/Shanghai     IANA tz id for cronExpression; create-direct
                                  defaults to local timezone when omitted
  --dispatchAt 2026-06-01T09:00:00+08:00  Epoch-ms or ISO 8601 (scheduled mode;
                                          offset/Z required; offset MUST be
                                          +HH:MM, not +HH)

IM / desktop notification (forward to a bot configured via
\`myagents im channels\` — without --notificationBotChannelId the task runs
silently to disk, even if you set --notificationDesktop):
  --notificationBotChannelId <id>  IM bot id (see 'myagents im channels')
  --notificationBotThread <chat>   Override bot routing thread / channel id
  --notificationDesktop true|false Desktop notification toggle (default: true)
  --notificationEvents done,blocked,endCondition  Comma-separated events filter

Per-task RUNTIME overrides (all optional; omit to inherit workspace defaults):
  --runtime            Override runtime (${RUNTIMES_ENUM_LINE})
                       See: myagents runtime list
  --providerId         Override builtin provider; must be paired with --model
  --model              Override model — values depend on runtime
                       See: myagents runtime describe <runtime>
  --permissionMode     Override permission mode — values depend on runtime
                       See: myagents runtime describe <runtime>
  --runtimeConfig      JSON string for runtime-specific extra config
  --mcpEnabledServers  Comma-separated MCP ids; "" means explicit no MCP

Options for 'create-attached':
  --name                  Task name (required)
  --workspaceId           Workspace id (required)
  --workspacePath         Absolute workspace path (required)
  --taskMdFile <path>     Read task.md body from a file
  --taskMdContent-file <path>
                          Alias accepted by Space Issue workflows
  --taskMdContent         Inline task.md body
  --source space-issue    Required source kind (default: space-issue)
  --sourceIssueId <id>    Space Issue id (required)
  --sourceClaimId <id>    Space Issue claim id
  --sourceSpaceId <id>    Space id
  --sourceDeliveryId <id> Issue delivery id
  Must run inside a MyAgents AI session; current session id comes from
  MYAGENTS_SESSION_ID and is not guessed by the CLI.

Options for 'update' <taskId>:
  Accepts schedule, prompt, routing, notification and runtime fields from
  create-direct (each optional; missing = leave unchanged). End-condition
  flags are create-only; edit existing end conditions in Task Center.
  Additional flags for clearing overrides:
    --clearProviderOverride   Reset providerId + model to follow Agent
    --clearRuntimeOverride    Reset runtime + runtimeConfig to follow Agent
    --clearMcpOverride        Reset MCP override to follow Agent
    --clear-trigger           Restore the effective always Detector
  Update is rejected when the task is Running/Verifying.
  Notification semantics: --notification* flags MERGE with the existing
  config (CLI sends only provided fields; the Task owner merges them under
  its authoritative write lock). So
  '--notificationDesktop false' preserves botChannelId / botThread / events.
  To clear bot routing entirely, recreate the task — empty values are
  rejected at the CLI boundary to catch typos.

Detector safety:
  --trigger-file / --spec-file are regular non-symlink UTF-8 JSON files.
  Command args remain a JSON array and are never shell-split. trigger test is
  a real process execution: MyAgents does not commit checkpoint/event state or
  activate AI, but the script's own external side effects still happen.
  check-now uses the persisted checkpoint and commits the normal outcome.

Options for 'update-status':
  Positional: <taskId> <status>
  --message            Optional message attached to the transition

Output:
  - Default (human-readable) mode prints a compact summary + any override echo.
  - --json returns the full structured payload (task id, overrides, overridden[],
    inheritedFromWorkspace[], nextSteps.{dispatch,inspect,complete}).

Examples:
  myagents task list --query "review" --limit 20
  myagents task create-direct --name "review PR" \\
      --taskMdContent "Review the latest PR and verify the acceptance criteria" \\
      --runtime codex --model gpt-5.2 --permissionMode full-auto
  # Recurring + IM push — was GUI-only before issue #205
  myagents task create-direct --name "issue triage" \\
      --taskMdFile /tmp/triage-prompt.md \\
      --executionMode recurring --intervalMinutes 180 \\
      --notificationBotChannelId feishu_main
  myagents task create-attached --name "Space Issue #123" \\
      --workspaceId my-proj --workspacePath /path/to/my-proj \\
      --taskMdContent-file task.md --source space-issue --sourceIssueId iss_123
  myagents task run t_abc123
  myagents task run-now t_abc123  # force AI without running Detector
  myagents task update t_abc123 --intervalMinutes 240   # change cadence after the fact
  myagents task update-status t_abc123 done --message "shipped in v0.1.70"

Related:
  myagents agent show <id>          Inspect an agent's effective defaults first,
                                    so you know what you are overriding.`,

  'task/list': taskLeafHelp({
    usage: 'myagents task list — Discover Tasks in the current workspace',
    when: 'Before creating a possible duplicate, or when the Task id is unknown.',
    effect:
      'Read-only. Defaults to the current workspace and returns a compact projection; task get owns full detail.',
    options:
      '  --query <text>       Match id, name, description, or tag\n  --limit <1..200>     Bound returned rows\n  --status / --tag     Existing lifecycle/tag filters\n  --workspaceId <id>   Explicit cross-workspace scope',
    mutation:
      'None; never starts AI. JSON omits expanded sessionIds and returns sessionCount.',
    output:
      'Compact identity, status, schedule, detector type, counters, nextExecutionAt, and execution health.',
    example: 'myagents task list --query "release" --limit 20 --json',
    recovery:
      'Use myagents agent current --json when current workspace resolution fails; use task get <id> for full data.',
  }),

  'task/get': taskLeafHelp({
    usage: 'myagents task get <taskId> — Read one authoritative Task',
    when: 'After creation/mutation or whenever full configuration, docs, sessions, or Detector health is needed.',
    effect:
      'Read-only. Returns the full ordinary Task plus docs paths, runtime health, and computed nextExecutionAt.',
    options:
      '  <taskId>             Required Task id\n  --json               Machine-readable full record',
    mutation: 'None; never starts AI.',
    output:
      'Full Task record. Unlike task list, sessionIds and detailed Trigger state are intentionally included.',
    example: 'myagents task get <taskId> --json',
    recovery: 'Run task list --query <name> if the id is unknown.',
  }),

  'task/create-direct': taskLeafHelp({
    usage:
      'myagents task create-direct --name <name> --taskMdFile <path> — Create a Task',
    when: 'When work must persist beyond this turn and run once in the future, on a schedule, or after a conditional check.',
    effect:
      'Creates a Todo Task in the current workspace. Omit workspace flags normally; pass both only for explicit cross-workspace creation.',
    options:
      '  --taskMdFile <path>  Preferred action body (or --taskMdContent)\n  --executionMode once|scheduled|recurring\n  --dispatchAt <ISO>    Scheduled one-shot time\n  --intervalMinutes <n> Fixed interval; --startAt controls the first tick\n  --cronExpression / --cronTimezone for wall-clock recurrence\n  --trigger-file <path> Optional command Detector\n  --providerId <id> --model <id>  Optional builtin route pair',
    mutation:
      'Persists Todo only; does not start AI. A recurring interval without startAt gets its first tick about 2 seconds after task run.',
    output:
      'Persisted Task, caller audit provenance, docs path, overrides, nextExecutionAt, and next-step commands.',
    example:
      'myagents task create-direct --name "daily review" --taskMdFile task-action.md --executionMode recurring --cronExpression "0 9 * * *" --json',
    recovery:
      'Run task get <id> to verify. agent current is diagnostic, not a prerequisite.',
  }),

  'task/create-attached': taskLeafHelp({
    usage:
      'myagents task create-attached --name <name> --sourceIssueId <id> — Attach current Session work',
    when: 'Only for a claimed Space Issue already executing in the current MyAgents Session.',
    effect:
      'Creates a Running attached-session Task linked to the Space Issue and current canonical Session.',
    options:
      '  --name / --sourceIssueId / workspace identity are required\n  --taskMdFile <path>   Preferred action body\n  --source space-issue  Only supported source',
    mutation: 'Creates lifecycle state but does not start a second AI turn.',
    output: 'Attached Task, docs, and current Session linkage.',
    example:
      'myagents task create-attached --name "Issue" --sourceIssueId <id> --taskMdFile task.md --workspaceId <id> --workspacePath <abs> --json',
    recovery:
      'Run only inside a Session with MYAGENTS_SESSION_ID; use the Space claim recovery command on partial failure.',
  }),

  'task/update': taskLeafHelp({
    usage: 'myagents task update <taskId> [fields] — Patch Task configuration',
    when: 'When a non-running Task schedule, action, Trigger, notification, or runtime override must change.',
    effect:
      'Updates the existing Task under its authoritative lock; omitted fields stay unchanged.',
    options:
      '  <taskId>             Required Task id\n  Use create-direct schedule/runtime flags; --clear-trigger restores always\n  --clearProviderOverride / --clearRuntimeOverride / --clearMcpOverride',
    mutation: 'Rejected while Running/Verifying; does not start AI.',
    output: 'Authoritative updated Task and docs.',
    example: 'myagents task update <taskId> --intervalMinutes 30 --json',
    recovery:
      'Stop first when a running Task must be edited; inspect task get after failure.',
  }),

  'task/run': taskLeafHelp({
    usage: 'myagents task run <taskId> — Enable a Todo Task',
    when: 'Immediately after a Todo Task has been created and verified.',
    effect: 'Moves Todo to Running and arms the existing scheduler.',
    options:
      '  <taskId>             Required Todo Task id\n  --json               Return the authoritative post-mutation state',
    mutation:
      'Does not wait for an AI result. Interval recurrence without startAt gets a tick in about 2 seconds; Cron waits for its next wall-clock tick; scheduled waits for dispatchAt.',
    output:
      'Current Task, attemptOrdinal, and scheduler-computed nextExecutionAt.',
    example: 'myagents task run <taskId> --json',
    recovery:
      'Use task rerun for a terminal/stopped Task, or task get to inspect a schedule error.',
  }),

  'task/start': taskLeafHelp({
    usage: 'myagents task start <taskId> — Resume a stopped schedule',
    when: 'When a previously stopped scheduled/recurring Task should continue.',
    effect:
      'Re-arms the existing schedule through the Cron compatibility adapter; it does not bypass the Detector.',
    options:
      '  <taskId>             Required Task id\n  --json               Return the authoritative post-mutation state',
    mutation:
      'May schedule the next tick near now when the preserved interval anchor is overdue; returned nextExecutionAt is authoritative.',
    output:
      'Current Task status and nextExecutionAt; never an empty success object.',
    example: 'myagents task start <taskId> --json',
    recovery:
      'Use task get for schedule/Trigger health, or task rerun when the Task is terminal.',
  }),

  'task/rerun': taskLeafHelp({
    usage: 'myagents task rerun <taskId> — Re-dispatch a terminal Task',
    when: 'When blocked, stopped, done, or archived work should start again from Todo.',
    effect:
      'Writes the audited rerun transition and arms the same Task scheduler.',
    options:
      '  <taskId>             Required Task id\n  --json               Authoritative post-mutation state',
    mutation:
      'May start AI asynchronously according to the Task schedule; attached-session Tasks cannot rerun.',
    output: 'Current Task, attemptOrdinal, and nextExecutionAt.',
    example: 'myagents task rerun <taskId> --json',
    recovery:
      'Use task get when the current state or unresolved execution blocks rerun.',
  }),

  'task/stop': taskLeafHelp({
    usage: 'myagents task stop <taskId> — Pause a Task',
    when: 'When future ticks and any active execution must stop.',
    effect:
      'Stops the scheduler/execution and preserves command Detector checkpoint state.',
    options:
      '  <taskId>             Required Task id\n  --json               Return the authoritative post-mutation state',
    mutation:
      'Mutates lifecycle; does not delete the Task or its workspace script.',
    output: 'Current stopped state and nextExecutionAt=null.',
    example: 'myagents task stop <taskId> --json',
    recovery:
      'Use task start to resume or reset-checkpoint only when the managed cursor must be cleared.',
  }),

  'task/runs': taskLeafHelp({
    usage:
      'myagents task runs <taskId> [--limit N] — Read recent AI execution history',
    when: 'To inspect settled AI outputs/errors after asynchronous admission.',
    effect:
      'Read-only compatibility projection over the existing Task run history.',
    options:
      '  <taskId>             Required Task id\n  --limit <n>           Positive row limit\n  --full                Do not truncate human output',
    mutation: 'None; never waits, retries, or starts AI.',
    output:
      'Recent settled run rows; no new execution-receipt protocol is added.',
    example: 'myagents task runs <taskId> --limit 5 --json',
    recovery:
      'Use task get for current executionState when no settled row exists yet.',
  }),

  'task/update-status': taskLeafHelp({
    usage:
      'myagents task update-status <taskId> <status> — Write an ordinary lifecycle transition',
    when: 'When the current actor legitimately advances running work to verifying/done/blocked/stopped.',
    effect:
      'Applies the existing Task state machine with caller actor/source audit.',
    options:
      '  <taskId> <status>    Required\n  --message <text>      Optional audit reason',
    mutation:
      'Mutates lifecycle; illegal transitions and Agent archive attempts fail closed.',
    output: 'Authoritative Task, transition, and nextExecutionAt.',
    example:
      'myagents task update-status <taskId> done --message "shipped" --json',
    recovery:
      'Read task get and choose a legal next state; do not forge actor/source flags.',
  }),

  'task/append-session': taskLeafHelp({
    usage:
      'myagents task append-session <taskId> <sessionId> — Link an existing Session',
    when: 'When work moved into another Session and the Task history should reference it.',
    effect: 'Adds the canonical Session id once to the existing Task.',
    options: '  <taskId> <sessionId> Both required',
    mutation:
      'Mutates Task metadata only; does not message or start that Session.',
    output: 'Authoritative Task with updated sessionIds.',
    example: 'myagents task append-session <taskId> <sessionId> --json',
    recovery:
      'Use session discovery to obtain a real id; never use a workspace path as Session identity.',
  }),

  'task/exit': taskLeafHelp({
    usage:
      'myagents task exit --reason <text> — End the currently executing eligible Task',
    when: 'Only from inside that Task run when aiCanExit is enabled and the recurring goal is genuinely finished.',
    effect: 'Requests terminal settlement for the active Task-owned turn.',
    options: '  --reason <text>      Concise completion reason',
    mutation:
      'Mutates only the active authorized Task run; rejected outside Task context.',
    output: 'Accepted Task exit request.',
    example: 'myagents task exit --reason "goal achieved" --json',
    recovery:
      'Use ordinary error handling for transient failures; do not exit a Task that still serves user intent.',
  }),

  'task/run-now': taskLeafHelp({
    usage: 'myagents task run-now <taskId> — Force one AI turn',
    when: 'For an explicit manual execution that must bypass activation filtering.',
    effect: 'Dispatches one AI execution without running the Detector.',
    options:
      '  <taskId>             Required Running ordinary Task id\n  --json               Machine-readable admission result',
    mutation:
      'Starts AI asynchronously; schedule anchor and Detector checkpoint are unchanged.',
    output:
      'Admission data including taskId and sessionId. It is not a terminal execution receipt.',
    example: 'myagents task run-now <taskId> --json',
    recovery:
      'Use task runs <id> and task get <id> to inspect the eventual result.',
  }),

  'task/check-now': taskLeafHelp({
    usage: 'myagents task check-now <taskId> — Run the persisted Detector now',
    when: 'After a production Detector is deployed or repaired and a real stateful check is intended.',
    effect:
      'Runs the Detector with persisted checkpoint, commits checkpoint/health, and activates AI only on activate.',
    options:
      '  <taskId>             Required Running command-Detector Task id\n  --json               Structured decision/admission data',
    mutation:
      'quiet commits state without AI; activate starts AI asynchronously; failure commits health/backoff and is not a decision.',
    output:
      'Detector result and, on activate, durable admission identity. It is not a terminal execution receipt.',
    example: 'myagents task check-now <taskId> --json',
    recovery:
      'Use trigger test first for no-commit diagnosis, then task get for health and checkpoint.',
  }),

  'task/trigger/validate': taskLeafHelp({
    usage:
      'myagents task trigger validate --spec-file <json> — Validate a Trigger',
    when: 'Before running or attaching a command Detector spec.',
    effect:
      'Parses and validates strict Trigger v1 JSON without executing the command.',
    options:
      '  --spec-file <path>   Required regular non-symlink UTF-8 JSON file\n  --json               Return normalized Trigger JSON',
    mutation: 'None; never runs a process or AI.',
    output: 'Normalized Trigger on success; precise schema error on failure.',
    example:
      'myagents task trigger validate --spec-file trigger.production.json --json',
    recovery:
      'Read myagents-task-automation/references/command-detector.md and correct the strict schema.',
  }),

  'task/trigger/test': taskLeafHelp({
    usage:
      'myagents task trigger test <taskId>|--spec-file <json> — Execute a Detector without committing MyAgents state',
    when: 'During fixture validation or diagnosis before a real check-now.',
    effect:
      'Really executes the command using a snapshot/fixture checkpoint but does not commit MyAgents checkpoint, health, events, or AI activation.',
    options:
      '  <taskId>             Test the persisted Trigger\n  --spec-file <path>   Or test an unpersisted Trigger with --workspacePath\n  --checkpoint-file    Optional checkpoint fixture\n  --expect quiet|activate',
    mutation:
      'No MyAgents state or AI mutation. Script file/network/database side effects are real and are not rolled back.',
    output: 'Structured quiet/activate result or harness failure diagnostics.',
    example:
      'myagents task trigger test --spec-file trigger.test.json --workspacePath /abs/workspace --expect quiet --json',
    recovery:
      'Isolate fixtures; a failure is a program/harness error, not a third decision.',
  }),

  'task/reset-checkpoint': taskLeafHelp({
    usage:
      'myagents task reset-checkpoint <taskId> — Clear MyAgents-managed Detector checkpoint',
    when: 'Only when the persisted cursor must intentionally restart from null.',
    effect:
      'Clears the platform checkpoint and advances its revision; preserves check history and script-owned state.',
    options:
      '  <taskId>             Required command-Detector Task id\n  --json               Return the new state',
    mutation: 'Mutates checkpoint only; does not run the Detector or AI.',
    output: 'Authoritative Trigger runtime state after reset.',
    example: 'myagents task reset-checkpoint <taskId> --json',
    recovery:
      'Use task get first; do not reset merely to hide a Detector failure.',
  }),

  'task/archive': taskLeafHelp({
    usage:
      'myagents task archive <taskId> — Move a completed Task to long-lived archive',
    when: 'When a completed Task should leave active views but remain recoverable and auditable.',
    effect: 'Transitions Done to Archived. This is a user-only product action.',
    options:
      '  <taskId>             Required Done Task id\n  --message <text>      Optional audit message',
    mutation:
      'Mutates lifecycle; Agent callers are rejected by the Task authority.',
    output: 'Authoritative archived Task and nextExecutionAt=null.',
    example: 'myagents task archive <taskId> --message "shipped" --json',
    recovery: 'A user can use task rerun to reactivate an archived Task.',
  }),

  'task/delete': taskLeafHelp({
    usage:
      'myagents task delete <taskId> — Irreversibly remove a Task from product use',
    when: 'Only after the user confirms the exact Task to remove.',
    effect:
      'Stops execution, removes Trigger runtime state/pending activation, and hides the Task from ordinary surfaces. An internal tombstone/audit remains for authority and migration safety.',
    options:
      '  <taskId>             Required Task id (remove is a compatibility alias)',
    mutation:
      'Irreversible product deletion. It does not delete workspace-owned scripts, databases, or external state.',
    output: 'Deletion receipt with status=deleted and nextExecutionAt=null.',
    example: 'myagents task delete <taskId> --json',
    recovery:
      'There is no undelete command. Recreate a Task if deletion was a mistake; clean scripts only under separate explicit user intent.',
  }),

  'task/readme': taskLeafHelp({
    usage: 'myagents task readme — Read the compact Task automation contract',
    when: 'When the Task product model or canonical lifecycle is unclear before choosing a leaf command.',
    effect:
      'Read-only. Explains action, schedule, activation, Session routing, lifecycle, and safety boundaries.',
    options:
      '  --json               Return the readme text in a machine-readable response',
    mutation: 'None; never creates a Task, runs a Detector, or starts AI.',
    output: 'Current Task command model and links to exact leaf help.',
    example: 'myagents task readme',
    recovery: 'Use myagents task <leaf> --help for exact input/output details.',
  }),

  im: `myagents im — IM Bot capabilities (run 'myagents im readme' for long-form docs)

Commands:
  channels                            List configured IM bots (works anywhere)
  send-media --file <path> [--caption <text>]
                                      Send a file to the current IM chat (IM session only)
  wake [--text <text>]                Trigger a heartbeat wake (IM session only)
  readme                              Full reference + when-to-use guidance

Use 'myagents im channels' to discover bot ids for --notificationBotChannelId
on 'myagents task create-direct / update'.`,

  record: `myagents record — Manage unified text and audio Records

Commands:
  list                  List Records (--kind text|audio / --tag / --query / --limit)
  create <content>      Capture a text Record (also: --content / --content-file)

New workflows use this command. Creating audio Records and starting microphone
recording remain desktop product actions.`,

  thought: `myagents thought — Legacy compatibility alias for text Records

Published scripts may continue to use list/create. New Agent workflows use
'myagents record'; this alias does not read the legacy Thought directory.`,

  widget: `myagents widget — Generative UI widget design guidelines
(run 'myagents widget readme' for the full design system + modules)

Use to render inline charts / SVG / dashboards in desktop Chat replies.
IM bot sessions don't render widgets.`,

  skill: `myagents skill — Manage MyAgents skills (user skills live under ~/.myagents/skills/)

Commands:
  list                       List installed skills + enabled state
  info <name>                Show one skill's manifest + description
  add <source>               Install from GitHub, HTTPS .zip, or a local source
                             Local: absolute path, file://, explicit ./ or ../
                             Formats: directory, .zip, .skill (not .tar.gz/.tgz)
                             [--scope user|project] [--plugin <id>] [--skill <id>]
                             [--force] [--dry-run]
  remove <name>              Uninstall a skill   [--scope user|project]
  enable <name>              Enable an installed skill
  disable <name>             Disable without uninstalling
  sync                       Import skills from Claude Code (~/.claude/skills) into
                             MyAgents. Optional interop only — errors "directory not
                             found" when Claude Code is not installed; your own skills
                             always live under ~/.myagents/skills/ regardless.`,

  tool: `myagents tool — CLI tool registry (user tools live under ~/.myagents/tools/)

Registered tools get a shim on ~/.myagents/bin (already on PATH in every agent
session and terminal) and their description is injected into every new
session's context, so future AI sessions discover them automatically.
Create standards-compliant tools with the tool-creator skill.

Commands:
  list                       List registered tools + enabled state [--json]
  add <dir>                  Register a tool dir (must contain tool.json + entry)
                             [--dry-run]. Copies the dir into ~/.myagents/tools/
                             unless it is already there.
  remove <name>              Unregister (keeps the tool dir; --purge deletes it)
  enable <name>              Show the tool in new sessions' context
  disable <name>             Hide from context (shim stays on PATH)
  info <name>                Show manifest + enabled state + missing env keys
  readme <name>              Run the tool's readme subcommand (full usage doc)
  env <name> get             Show configured env (values redacted)
  env <name> set KEY=VALUE   Set per-tool env (API keys etc.; tool reads at launch)
  env <name> delete KEY      Remove env keys

Notes:
  - Tool names must not shadow existing commands (~/.myagents/bin precedes
    system paths on PATH) — add rejects collisions.
  - description in tool.json is capped at 800 chars (it goes into the system
    prompt of every session).
  - Registry changes affect other sessions at their next start.`,

  diagnose: `myagents diagnose — Diagnostic helpers

Commands:
  diagnose runtime <type>    Inspect why a runtime is not detected / responding.
                             Same as 'myagents runtime diagnose <type>'; the
                             top-level form is provided so AI guesses route
                             to a real handler (issue #194).`,

  agent: `myagents agent — Discover stable Workspace Agent identities

Every user-visible Workspace selects one stable Agent identity through
Project.agentId. Historical extra/orphan Agents remain addressable by exact ID.
The Agent owns execution defaults; Project.path owns the current workspace.
enabled=false pauses Heartbeat, Memory Update, and Memory Evo. Channels remain
independently controlled by channel.enabled.

Discovery:
  list [--active|--archived]      Find Agent IDs; marks this CLI caller's Agent
  show <agentId>                  Inspect identity and effective birth defaults

Management:
  enable <id>                     Enable an agent
  disable <id>                    Disable an agent
  archive <id>                    Archive an Agent workspace and pause proactive channels
  unarchive <id>                  Restore an archived Agent workspace
  set <id> <key> <value>          Set enabled/runtime/runtimeConfig or one of
                                  providerId/model/permissionMode; the latter
                                  sync the Project mirror and live channels
  runtime-status                  Runtime drift status across agents
  channel list <agent-id>         List channels
  channel add <agent-id>          Add a channel
  channel remove <a-id> <ch-id>   Remove a channel

Options for 'channel add':
  --type        telegram | feishu | dingtalk (required)
  --token       Bot token (for telegram)
  --app-id      App ID (for feishu/dingtalk)
  --app-secret  App Secret (for feishu/dingtalk)

Visibility: default list shows user-visible, non-archived Project-backed Agents
plus compatible historical orphan Agents. A conflicting exact target fails
without hiding healthy targets. Project lifecycle commands require an exact
Project.agentId claim.

Collaboration flow:
  myagents agent list
  myagents agent show <agentId>
  myagents session list --agent <agentId>
  myagents session start --agent <agentId> -p "<prompt>"

See also: myagents session --help`,

  'agent/list': `myagents agent list — Discover addressable Workspace Agents

WHEN TO CALL
  Before choosing a collaboration target, or to identify this Session's Agent.

EFFECT
  Read-only. Lists Project-backed and compatible historical Agent identities;
  does not start a Sidecar.

OPTIONS
  --active      Visible, non-archived Agents (default)
  --archived    Visible archived Agents; mutually exclusive with --active
  --json        Machine-readable records

OUTPUT
  agentId, name, projectId, workspacePath, association, enabled, archived,
  archivedAt, isCurrent, channelCount, channels. Human output marks the current
  Project-selected Agent with *.

IDENTITY / PERMISSIONS
  Use agentId from this command; never guess IDs or use workspace paths as
  selectors. enabled controls proactive behavior, not explicit addressability.

EXAMPLES
  myagents agent list
  myagents agent list --archived --json

RECOVERY
  No current marker is valid from Global/terminal contexts or when the caller
  is filtered out. Identity conflicts are reported instead of guessed.`,

  'agent/current': `myagents agent current — Inspect only this CLI caller's current context

WHEN TO CALL
  When a diagnostic needs the current Agent, workspace, or Session identity.
EFFECT
  Read-only. Resolves the Sidecar's current Project-backed Agent without listing other Agents.
OPTIONS
  --json        Machine-readable compact record
OUTPUT
  agentId, name, workspaceId, workspacePath, and sessionId when available.
IDENTITY / PERMISSIONS
  This is diagnostic only; Task create/list already inherit the current workspace.
EXAMPLE
  myagents agent current --json
RECOVERY
  Run myagents agent list if the current workspace is not Project-linked.`,

  'agent/show': `myagents agent show <agentId> — Inspect one Agent identity

WHEN TO CALL
  After agent list, when you need the target Workspace or Session birth defaults.

EFFECT
  Read-only. Resolves current effective defaults without starting a Session.

OPTIONS
  <agentId>     Required stable Agent ID
  --json        Machine-readable record

OUTPUT
  Identity, lifecycle, isCurrent, channel summary, and effectiveDefaults:
  runtime/source, model, permissionMode, provider, runtimeConfig, MCP, plugins,
  and official tools. Secret and environment values are never returned.

IDENTITY / PERMISSIONS
  Defaults belong to the target Agent. A later session start uses them and does
  not accept caller overrides.

EXAMPLE
  myagents agent show <agentId>

RECOVERY
  Run myagents agent list (or agent list --archived) to obtain a visible Agent
  ID. Archived and compatible historical orphan Agents remain inspectable.`,

  session: `myagents session — Discover and collaborate across Agent Sessions

An Agent owns many isolated Sessions. Choose by context intent:
  Fresh context:       session start --agent <agentId> -p "<prompt>"
  Reuse known context: session send <sessionId> -p "<prompt>"
  Observe only:        session watch <sessionId>

Discover before choosing:
  myagents agent list
  myagents session list --agent <agentId>

start and send are asynchronous admission requests: success means the target
accepted the request, not that work completed. By default the final target turn
is pushed back as a <myagents-session-event type="send.result"> block. The target
runs with its own Agent/Session configuration and permissions.

Run exact leaf help for flags, output, exit codes, and recovery:
  myagents session list --help
  myagents session start --help
  myagents session send --help
  myagents session watch --help`,

  'session/list': `myagents session list --agent <agentId> — Recent reusable contexts

WHEN TO CALL
  After agent list, when deciding whether prior context should be preserved.

EFFECT
  Read-only persisted-history lookup. Does not wake Sessions, probe live state,
  or read transcripts.

OPTIONS
  --agent <agentId>    Required; Agent ID from agent list
  --limit <1..50>      Maximum records (default 5)
  --json               Machine-readable envelope and records

OUTPUT
  History-visible Sessions ordered by persisted lastActiveAt: sessionId, title,
  existing lastMessagePreview, runtime/source, model, and origin. This is not
  proof that a Session is currently running.

IDENTITY / PERMISSIONS
  Agent IDs are selectors; workspace paths are not. Listing never changes or
  adopts the target Session's configuration.

EXAMPLE
  myagents session list --agent <agentId> --limit 10

RECOVERY
  Run myagents agent list (or agent list --archived) for a valid Agent ID.
  Archived Agent history remains readable; hidden targets are rejected and
  identity conflicts fail closed with diagnostics.`,

  'session/start': `myagents session start --agent <agentId> — Start clean work

WHEN TO CALL
  When the target Agent should work in a brand-new isolated context. Use send
  instead when an existing Session's context matters.

EFFECT
  Atomically creates a fresh Session and admits its first prompt. Returns
  immediately after admission; it does not wait for completion.

OPTIONS
  --agent <agentId>    Required target from agent list
  -p, --prompt TEXT    Short single-line prompt; exclusive with --prompt-file
  --prompt-file PATH   Prompt file for multiline/long text (maximum 1 MB)
  --no-reply           Do not push the target turn result back
  --json               Machine-readable receipt

OUTPUT
  accepted asynchronous receipt with agentId, new sessionId, messageId,
  replyBack, and (when replyBack=true) resultDelivery=send.result. messageId
  correlates with the later send.result requestEventId. No completion is implied.

IDENTITY / PERMISSIONS
  Must be called from a real MyAgents Session. The target Agent owns runtime,
  model, permission, provider, MCP, plugin, and tool defaults; caller overrides
  are rejected.

EXAMPLES
  myagents session start --agent <agentId> -p "Review this change"
  myagents session start --agent <agentId> --prompt-file request.txt --no-reply

RECOVERY
  Exit 1: Agent/lifecycle rejection. Exit 2: delivery rejection, transport
  failure, or admission unconfirmed. Exit 3: local argument error. On an
  unconfirmed receipt, keep its IDs, run session list --agent <agentId>, and do
  not automatically resend. Inline newline or >4 KB input must use a file.`,

  'session/send': `myagents session send <sessionId> — Assign work in existing context

WHEN TO CALL
  When a known Session should do new work and retain its existing context.

EFFECT
  Asynchronously injects one prompt into the target Session and returns after
  delivery, not completion. An idle/dead target can be awakened.

OPTIONS
  <sessionId>           Required target Session ID
  -p, --prompt TEXT     Short single-line prompt; exclusive with --prompt-file
  --prompt-file PATH    Prompt file for multiline/long text (maximum 1 MB)
  --no-reply            One-way delivery; suppress automatic result push
  --json                Machine-readable receipt

OUTPUT
  Delivery receipt with message ID. By default a later send.result event is
  pushed to the caller Session.

IDENTITY / PERMISSIONS
  Caller label is derived from Session metadata. The target keeps its own
  runtime, configuration, context, and permissions.

EXAMPLES
  myagents session send <sessionId> -p "Run the focused tests"
  myagents session send <sessionId> --prompt-file request.txt --no-reply

RECOVERY
  Exit 1: Session not found/business error. Exit 2: delivery failure/rejection.
  Exit 3: argument error. Inline newline or >4 KB input must use a file.`,

  'session/watch': `myagents session watch <sessionId> — Observe without assigning work

WHEN TO CALL
  When current work depends on another Session's current/latest result and no
  new instruction should be injected.

EFFECT
  Registers observation only. A running target later pushes watch.completed;
  an already-idle target returns watch.already_idle with its recent result.

OPTIONS
  <sessionId>    Required target Session ID
  --json         Machine-readable registration/result
  Prompt and then flags are rejected; use session send for new work.

OUTPUT
  Watch registration or a system-delivered <myagents-session-event> block.

IDENTITY / PERMISSIONS
  watch never changes target context, configuration, or permissions.

EXAMPLE
  myagents session watch <sessionId>

RECOVERY
  Exit 1: Session not found/business error. Exit 2: watch delivery failure.
  Discover Sessions with session list --agent <agentId>.`,
};

export function handleHelp(payload: { path?: string[] }): AdminResponse {
  const path = (payload.path ?? []).map((part) => part.trim()).filter(Boolean);
  const lookupPath =
    path[0] === 'space' && path[1] === 'issue' && path[2] === 'view'
      ? [...path.slice(0, 2), 'get', ...path.slice(3)]
      : path;
  const group = path[0];
  let matchedKey: string | undefined;
  for (let length = lookupPath.length; length > 0; length -= 1) {
    const candidate = lookupPath.slice(0, length).join('/');
    if (HELP_TEXTS[candidate]) {
      matchedKey = candidate;
      break;
    }
  }

  if (matchedKey) {
    if (group === 'tool' && !isCliToolRegistryEnabled()) {
      return { success: true, data: { text: CLI_TOOL_REGISTRY_DISABLED_HELP } };
    }
    return { success: true, data: { text: HELP_TEXTS[matchedKey] } };
  }

  // Derive the group list from HELP_TEXTS so it can't drift as new commands
  // are added (issue #205 gap #5: the previous hardcoded list claimed only
  // 8 groups existed and omitted im / task / runtime / cc-plugin / session,
  // turning `myagents im --help` into a misleading "use one of these
  // unrelated groups" message). Append the leaf commands that aren't in
  // HELP_TEXTS but are still valid top-level invocations.
  const groups = [
    ...new Set(Object.keys(HELP_TEXTS).map((key) => key.split('/')[0])),
  ].sort();
  const leafCommands = ['status', 'reload', 'version'];
  const header = group
    ? `Unknown command group "${group}".`
    : 'myagents — Available commands';
  return {
    success: true,
    data: {
      text: `${header}

Command groups (run "myagents <group> --help" for details):
  ${groups.join(', ')}

Leaf commands:
  ${leafCommands.join(', ')}`,
    },
  };
}

export async function handleAnydocConvert(payload: {
  sourcePath?: string;
  outputRoot?: string;
  password?: string;
}): Promise<AdminResponse> {
  const response = await managementApi('/api/document/convert', 'POST', {
    sourcePath: payload.sourcePath,
    outputRoot: payload.outputRoot,
    password: payload.password,
    currentWorkspace: getCurrentWorkspacePath(),
  });
  return wrapMgmtResponse(response);
}

export async function handleAnydocStatus(payload: {
  jobId?: string;
}): Promise<AdminResponse> {
  const response = await managementApi(
    `/api/document/status${qsFrom({ jobId: payload.jobId })}`,
  );
  return wrapMgmtResponse(response);
}

export async function handleAnydocCancel(payload: {
  jobId?: string;
}): Promise<AdminResponse> {
  const response = await managementApi('/api/document/cancel', 'POST', {
    jobId: payload.jobId,
  });
  return wrapMgmtResponse(response);
}

export async function handleAnydocList(payload: {
  limit?: number;
}): Promise<AdminResponse> {
  const response = await managementApi(
    `/api/document/list${qsFrom({ limit: payload.limit })}`,
  );
  return wrapMgmtResponse(response);
}

type SpeechAdminCaller = {
  sidecarId: string;
};

function resolveSpeechAdminCaller(): SpeechAdminCaller | AdminResponse {
  const context = getSessionEngine().getCurrentSessionContext();
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (
    !context.sessionId?.trim() ||
    !context.workspacePath?.trim() ||
    !sidecarId
  ) {
    return {
      success: false,
      code: 'SPEECH_SESSION_REQUIRED',
      error:
        'Speech recognition requires an active MyAgents Session with an authoritative Workspace.',
      suggestion:
        'Run the command from the MyAgents chat Session that should own the job.',
      suggestedCommand: 'myagents speech --help',
    };
  }
  const enabled = getEffectiveOfficialToolIdsForSession(
    context.workspacePath,
    context.sessionMeta ?? null,
  );
  if (!enabled.includes(SPEECH_RECOGNITION_TOOL_ID)) {
    return {
      success: false,
      code: 'SPEECH_TOOL_DISABLED',
      error: 'Speech recognition is not enabled for the current Session.',
      suggestion:
        'Enable Speech Recognition for this Agent or Workspace, then start a new Session.',
      suggestedCommand: 'myagents speech --help',
    };
  }
  return { sidecarId };
}

function speechCallerIsError(
  value: SpeechAdminCaller | AdminResponse,
): value is AdminResponse {
  return 'success' in value;
}

export async function handleSpeechTranscribe(payload: {
  sourcePath?: string;
  outputRoot?: string;
}): Promise<AdminResponse> {
  const caller = resolveSpeechAdminCaller();
  if (speechCallerIsError(caller)) return caller;
  return wrapMgmtResponse(
    await managementApi('/api/speech/transcribe', 'POST', {
      sidecarId: caller.sidecarId,
      sourcePath: payload.sourcePath,
      outputRoot: payload.outputRoot,
    }),
  );
}

export async function handleSpeechStatus(payload: {
  jobId?: string;
}): Promise<AdminResponse> {
  const caller = resolveSpeechAdminCaller();
  if (speechCallerIsError(caller)) return caller;
  return wrapMgmtResponse(
    await managementApi('/api/speech/status', 'POST', {
      sidecarId: caller.sidecarId,
      jobId: payload.jobId,
    }),
  );
}

export async function handleSpeechCancel(payload: {
  jobId?: string;
}): Promise<AdminResponse> {
  const caller = resolveSpeechAdminCaller();
  if (speechCallerIsError(caller)) return caller;
  return wrapMgmtResponse(
    await managementApi('/api/speech/cancel', 'POST', {
      sidecarId: caller.sidecarId,
      jobId: payload.jobId,
    }),
  );
}

export async function handleSpeechList(payload: {
  limit?: number;
}): Promise<AdminResponse> {
  const caller = resolveSpeechAdminCaller();
  if (speechCallerIsError(caller)) return caller;
  return wrapMgmtResponse(
    await managementApi('/api/speech/list', 'POST', {
      sidecarId: caller.sidecarId,
      limit: payload.limit,
    }),
  );
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

// Compile-time injected by esbuild (scripts/esbuild-bundle.mjs `define`).
// In dev (`npm run server` via tsx, no esbuild), the identifier is undefined
// at runtime — the `?? process.env.…` chain below reaches the env fallback.
declare const __MYAGENTS_VERSION__: string | undefined;

export function handleVersion(): AdminResponse {
  // Resolution order:
  //   1. esbuild-injected `__MYAGENTS_VERSION__` (production sidecar bundle).
  //   2. `npm_package_version` (set by npm in dev when launched via scripts).
  //   3. `MYAGENTS_VERSION` env override (build system / tests).
  //   4. 'dev' sentinel — visibly NOT a release version, so anyone reading
  //      `myagents version` knows they're on an un-stamped build instead of
  //      seeing a stale hardcoded number that lies about which build is
  //      installed (issue #149: users had no way to tell whether the dmg they
  //      reinstalled actually contained the patched CLI/sidecar — the old
  //      hardcoded '0.1.70' fallback shipped in every release).
  const version =
    (typeof __MYAGENTS_VERSION__ !== 'undefined'
      ? __MYAGENTS_VERSION__
      : undefined) ??
    process.env.npm_package_version ??
    process.env.MYAGENTS_VERSION ??
    'dev';
  return { success: true, data: { version } };
}

// ---------------------------------------------------------------------------
// Cron Task forwarding (Admin API → Management API)
//
// Workspace-scoped trust boundary
// -------------------------------
// The Rust Management API treats every cron task as global — it has no
// knowledge of which Sidecar made the call, and `cron/list` without
// `workspacePath` returns ALL tasks across the system. Before v0.2.11 the
// `im-cron` MCP enforced a per-bot/per-workspace ownership guard inside its
// tool handler. Now that cron CRUD flows through `myagents cron …` CLI
// (auto-approved Bash in IM/cron sessions), the same guard MUST be applied
// here at the admin-api boundary. Otherwise a prompt-injected IM bot can
// list and mutate tasks belonging to other workspaces.
//
// The guard works in two parts:
//
//  1. `defaultCronWorkspace()` — derive the active sidecar's "scope
//     workspace" from current IM-cron / session-cron context, falling back
//     to the agentDir. List/create/status calls default to this when the
//     caller didn't pass `--workspace`, matching the old MCP behaviour.
//
//  2. `verifyTaskOwnership(taskId)` — gate mutating ops (update/delete/
//     run-now/start/stop/runs). Calls Rust `cron/list?workspacePath=<scope>`
//     and rejects if `taskId` isn't in the returned set. One extra round-trip
//     per mutation, but Rust is co-resident on loopback so it's <5ms.
//
// Renderer-initiated calls (Settings UI / TaskCenter) come in with explicit
// `workspacePath` and bypass the default; they trust the user, not the AI.
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace this Sidecar should treat as "current" for cron CRUD.
 * Used to default `workspacePath` on AI-initiated `myagents cron` invocations
 * when the AI didn't (or can't) supply one.
 *
 * Resolution order — most-specific to least:
 *   1. IM-cron context (`/api/im/enqueue` sets this for IM bot sessions)
 *   2. Session-cron context (regular non-IM cron-bearing sessions)
 *   3. Sidecar `agentDir` (last-resort default — every Sidecar has one)
 */
function defaultCronWorkspace(): string {
  const imCron = getImCronContext();
  if (imCron?.workspacePath) return imCron.workspacePath;
  const sessionCron = getSessionCronContext();
  if (sessionCron?.workspacePath) return sessionCron.workspacePath;
  return getAgentState().agentDir;
}

/**
 * Verify that `taskId` belongs to the current Sidecar's workspace. Returns
 * `null` on success, an `AdminResponse` rejection otherwise. Replaces the
 * deleted im-cron MCP `verifyTaskOwnership` helper with the same semantics.
 *
 * Performs a `cron/list?workspacePath=<scope>` round-trip and checks
 * membership. The list endpoint returns up to ~100s of rows; for our scale
 * this is cheaper than adding a new owner-check Rust endpoint.
 */
async function verifyCronTaskOwnership(
  taskId: string,
): Promise<AdminResponse | null> {
  const workspacePath = defaultCronWorkspace();
  const qs = `?workspacePath=${encodeURIComponent(workspacePath)}`;
  const resp = await managementApi(`/api/cron/list${qs}`);
  if (!resp.ok) {
    return mgmtError(resp, 'Failed to verify task ownership');
  }
  const tasks =
    ((resp as Record<string, unknown>).tasks as
      | Array<{ id?: string }>
      | undefined) ?? [];
  const owned = tasks.some((t) => t.id === taskId);
  if (!owned) {
    return {
      success: false,
      error: `Task ${taskId} not found in current workspace. The current session can only manage cron tasks created in its own workspace.`,
    };
  }
  return null;
}

export async function handleCronList(payload: {
  workspacePath?: string;
}): Promise<AdminResponse> {
  // Default to current sidecar's workspace if caller didn't specify. Without
  // this, `myagents cron list` from an IM bot returns tasks across every
  // workspace on the system — see ownership-guard rationale above.
  const explicit = Boolean(payload.workspacePath);
  const workspacePath = payload.workspacePath ?? defaultCronWorkspace();
  const qs = `?workspacePath=${encodeURIComponent(workspacePath)}`;
  const resp = await managementApi(`/api/cron/list${qs}`);
  if (resp.ok) {
    const { scope, hint } = buildCronScope(workspacePath, explicit);
    return {
      success: true,
      data: (resp as Record<string, unknown>).tasks ?? [],
      scope,
      hint,
    };
  }
  return mgmtError(resp, 'Failed to list cron tasks');
}

export async function handleCronCreate(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  // Default workspacePath if caller didn't supply one. Rust requires the
  // field; without this default, every AI-issued `myagents cron add` would
  // 400 because the prompt examples (intentionally) don't mention --workspace.
  const resolvedWorkspacePath =
    (payload.workspacePath as string | undefined) ||
    (payload.workspace_path as string | undefined) ||
    defaultCronWorkspace();
  const finalPayload: Record<string, unknown> = payload.workspacePath
    ? payload
    : { ...payload, workspacePath: resolvedWorkspacePath };
  const schedule = finalPayload.schedule as { kind?: unknown } | undefined;
  if (schedule?.kind === 'loop') {
    return {
      success: false,
      error:
        'Loop schedules are Goal Mode tasks. Use myagents goal create --objective-file <path> after writing the objective to that file; do not use myagents cron add.',
    };
  }

  // Cron is a compatibility surface over the canonical Task store. Validate
  // the same runtime identity before both preview and mutation so --dry-run
  // cannot report a configuration that the real command would reject.
  const validationError = await validateTaskOverrides(finalPayload);
  if (validationError) return validationError;

  // Issue #149: --dry-run was silently ignored — the previous implementation
  // forwarded payload to Rust regardless, so `cron add --dry-run` would
  // actually write a task to disk. Honor the flag locally before any
  // mutation happens. The preview shape mirrors `mcp add`'s dry-run path
  // (printResult prints `[DRY RUN] Would apply:` when `dryRun: true`
  // appears alongside `preview`).
  if (finalPayload.dryRun) {
    // Strip the flag itself from the preview body so the user sees only
    // the task fields they're actually requesting.
    const { dryRun: _dryRun, ...preview } = finalPayload as Record<
      string,
      unknown
    >;
    return { success: true, dryRun: true, preview };
  }

  const resp = await managementApi('/api/cron/create', 'POST', finalPayload);
  return wrapMgmtResponse(resp);
}

export async function handleCronStop(payload: {
  taskId: string;
}): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const resp = await managementApi('/api/cron/stop', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronStart(payload: {
  taskId: string;
}): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const resp = await managementApi('/api/cron/run', 'POST', payload);
  return wrapMgmtResponse(resp);
}

/// PRD 0.2.5 R4 — fire one immediate execution without changing schedule.
/// Returns { taskId, sessionId, dispatchedAt } on success; { error, code } on
/// conflict (task currently executing).
export async function handleCronRunNow(payload: {
  taskId: string;
}): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const resp = await managementApi('/api/cron/trigger', 'POST', payload);
  if (resp.ok) {
    return {
      success: true,
      data: {
        taskId: (resp as Record<string, unknown>).taskId,
        sessionId: (resp as Record<string, unknown>).sessionId,
        dispatchedAt: (resp as Record<string, unknown>).dispatchedAt,
      },
    };
  }
  return mgmtError(resp, 'Failed to trigger cron');
}

export async function handleCronDelete(payload: {
  taskId: string;
}): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const resp = await managementApi('/api/cron/delete', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronUpdate(payload: {
  taskId: string;
  patch: Record<string, unknown>;
}): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  let validationPayload: Record<string, unknown> = {
    workspacePath: defaultCronWorkspace(),
    ...payload.patch,
  };
  if (hasTaskRuntimeOverride(payload.patch)) {
    const current = await handleTaskGet({ id: payload.taskId });
    if (!current.success) return current;
    if (
      !current.data ||
      typeof current.data !== 'object' ||
      Array.isArray(current.data)
    ) {
      return {
        success: false,
        error: `Task '${payload.taskId}' returned invalid persisted data.`,
      };
    }
    // Runtime updates are patches. Validate against the persisted complete
    // identity so changing runtimeConfig/model alone cannot inherit an
    // unrelated current-Agent default.
    validationPayload = {
      ...(current.data as Record<string, unknown>),
      ...payload.patch,
    };
  }
  const validationError = await validateTaskOverrides(validationPayload);
  if (validationError) return validationError;
  const resp = await managementApi('/api/cron/update', 'POST', payload);
  if (resp.ok) {
    // Issue #115 — surface the post-update task summary so CLI can echo
    // `nextExecutionAt` (computed with tz) right after `✓ update`. Avoids
    // the "I just changed schedule, why does the next run show +1h" UX
    // confusion that strict-after-now causes when the user re-checks
    // later via `cron list`.
    return {
      success: true,
      data: (resp as Record<string, unknown>).task ?? null,
    };
  }
  return mgmtError(resp, 'Failed to update cron task');
}

export async function handleCronRuns(payload: {
  taskId: string;
  limit?: number;
}): Promise<AdminResponse> {
  const reject = await verifyCronTaskOwnership(payload.taskId);
  if (reject) return reject;
  const qs = `?taskId=${encodeURIComponent(payload.taskId)}${payload.limit ? `&limit=${payload.limit}` : ''}`;
  const resp = await managementApi(`/api/cron/runs${qs}`);
  if (resp.ok) {
    return {
      success: true,
      data: (resp as Record<string, unknown>).runs ?? [],
    };
  }
  return mgmtError(resp, 'Failed to get cron runs');
}

export async function handleCronStatus(payload: {
  workspacePath?: string;
}): Promise<AdminResponse> {
  const explicit = Boolean(payload.workspacePath);
  const workspacePath = payload.workspacePath ?? defaultCronWorkspace();
  const qs = `?workspacePath=${encodeURIComponent(workspacePath)}`;
  const resp = await managementApi(`/api/cron/status${qs}`);
  const wrapped = wrapMgmtResponse(resp);
  // Same workspace-scoping as `cron list` → same "0 ≠ none anywhere" misread
  // guard. The issue's `cron status → Total tasks: 0` came from this path.
  if (wrapped.success) {
    const { scope, hint } = buildCronScope(workspacePath, explicit);
    wrapped.scope = scope;
    wrapped.hint = hint;
  }
  return wrapped;
}

function currentGoalContext(): {
  sessionId?: string;
  workspacePath: string;
  error?: string;
} {
  const sessionContext = getSessionEngine().getCurrentSessionContext();
  const sessionId = sessionContext.sessionId ?? process.env.MYAGENTS_SESSION_ID;
  if (!sessionId) {
    return {
      workspacePath: sessionContext.workspacePath ?? defaultCronWorkspace(),
      error:
        'No current session. Run this command from inside a MyAgents AI session.',
    };
  }
  return {
    sessionId,
    workspacePath: sessionContext.workspacePath ?? defaultCronWorkspace(),
  };
}

export async function handleGoalGet(): Promise<AdminResponse> {
  const ctx = currentGoalContext();
  if (ctx.error || !ctx.sessionId) return { success: false, error: ctx.error };
  const resp = await managementApi(
    `/api/goal/get${qsFrom({
      sessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
    })}`,
  );
  if (resp.ok) {
    return {
      success: true,
      data: { goal: (resp as Record<string, unknown>).goal ?? null },
    };
  }
  return mgmtError(resp, 'Failed to get Goal');
}

export async function handleGoalCreate(payload: {
  objective?: string;
  endConditions?: {
    deadline?: string;
    maxExecutions?: number;
    aiCanExit?: boolean;
  };
}): Promise<AdminResponse> {
  const objective = payload.objective?.trim();
  if (!objective)
    return { success: false, error: 'Missing required field: objective' };
  const ctx = currentGoalContext();
  if (ctx.error || !ctx.sessionId) return { success: false, error: ctx.error };
  const resp = await managementApi('/api/goal/create', 'POST', {
    sessionId: ctx.sessionId,
    workspacePath: ctx.workspacePath,
    objective,
    ...(payload.endConditions ? { endConditions: payload.endConditions } : {}),
  });
  if (resp.ok) {
    return {
      success: true,
      data: { goal: (resp as Record<string, unknown>).goal },
    };
  }
  return mgmtError(resp, 'Failed to create Goal');
}

export async function handleGoalUpdate(payload: {
  status?: string;
  reason?: string;
}): Promise<AdminResponse> {
  const status = payload.status;
  if (status !== 'complete' && status !== 'blocked') {
    return { success: false, error: 'Goal status must be complete or blocked' };
  }
  const ctx = currentGoalContext();
  if (ctx.error || !ctx.sessionId) return { success: false, error: ctx.error };
  const turn = getSessionEngine().getCurrentTurnIdentity();
  if (!turn || turn.owner.kind !== 'goal') {
    return {
      success: false,
      error: 'Goal terminal update requires the active Goal turn authority',
    };
  }
  const reason =
    payload.reason?.trim() ||
    (status === 'complete' ? 'Goal achieved' : 'Goal blocked');
  const resp = await managementApi('/api/goal/update', 'POST', {
    sessionId: ctx.sessionId,
    workspacePath: ctx.workspacePath,
    goalId: turn.owner.id,
    queueId: turn.queueId,
    status,
    reason,
  });
  if (resp.ok) {
    return {
      success: true,
      data: { goal: (resp as Record<string, unknown>).goal },
    };
  }
  return mgmtError(resp, 'Failed to update Goal');
}

// ---------------------------------------------------------------------------
// Task Center forwarding (v0.1.69)
//
// Audit-provenance note: the trusted local CLI stamps `actor` + `source` from its own env
// (a Session id means agent/cli; an ordinary terminal means user/cli) BEFORE
// posting here. The Sidecar cannot infer this from its own server env.
// We forward these fields to the Rust Management API, which validates legal
// combinations. This is not a separate authentication protocol. The renderer-
// originated path (Tauri IPC) never reaches this module — it goes through
// `cmd_task_update_status` in Rust which stamps `user/ui` authoritatively.
// ---------------------------------------------------------------------------

function qsFrom(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

type TaskCliCaller = {
  actor?: 'agent' | 'user';
  source?: 'cli';
};

function normalizedTaskCliCaller(
  payload: TaskCliCaller,
): Required<TaskCliCaller> {
  return {
    actor: payload.actor === 'agent' ? 'agent' : 'user',
    source: 'cli',
  };
}

function taskCliAnalyticsSource(payload: TaskCliCaller): 'cli' | 'cli_agent' {
  return payload.actor === 'agent' ? 'cli_agent' : 'cli';
}

function resolveTaskWorkspace(
  payload: Record<string, unknown>,
): { payload: Record<string, unknown> } | { response: AdminResponse } {
  const explicitId =
    typeof payload.workspaceId === 'string' && payload.workspaceId.trim()
      ? payload.workspaceId.trim()
      : undefined;
  const explicitPath =
    typeof payload.workspacePath === 'string' && payload.workspacePath.trim()
      ? payload.workspacePath.trim()
      : undefined;
  if (payload.workspaceId !== undefined && !explicitId) {
    return {
      response: {
        success: false,
        error: 'workspaceId must be a non-empty string',
      },
    };
  }
  if (payload.workspacePath !== undefined && !explicitPath) {
    return {
      response: {
        success: false,
        error: 'workspacePath must be a non-empty string',
      },
    };
  }

  const projects = loadProjects();
  const currentPath = getCurrentWorkspacePath() ?? defaultCronWorkspace();
  const projectById = explicitId
    ? projects.find((item) => item.id === explicitId)
    : undefined;
  const projectByPath = projects.find((item) =>
    workspacePathsEqual(item.path, explicitPath ?? currentPath),
  );
  if (explicitId && !projectById) {
    return {
      response: {
        success: false,
        error: `workspaceId does not identify a registered Task project: ${explicitId}`,
        recoveryHint: {
          recoveryCommand: 'myagents agent list',
          message: 'Choose a visible Project-backed Agent workspace.',
        },
      },
    };
  }
  if (
    explicitId &&
    explicitPath &&
    !workspacePathsEqual(projectById!.path, explicitPath)
  ) {
    return {
      response: {
        success: false,
        error: `workspaceId '${explicitId}' does not own workspacePath '${explicitPath}'.`,
        recoveryHint: {
          recoveryCommand: 'myagents agent current --json',
          message:
            'Use the id and path from the same Project-backed Agent workspace.',
        },
      },
    };
  }
  const project = projectById ?? projectByPath;
  const workspaceId = project?.id;
  const workspacePath = project?.path;
  if (!workspaceId || !workspacePath) {
    return {
      response: {
        success: false,
        error: 'Current workspace could not be resolved to a Task project.',
        recoveryHint: {
          recoveryCommand: 'myagents agent current --json',
          message:
            'Pass both --workspaceId and --workspacePath only for an explicit cross-workspace operation.',
        },
      },
    };
  }
  return { payload: { ...payload, workspaceId, workspacePath } };
}

function compactTaskForAgent(
  task: Record<string, unknown>,
): Record<string, unknown> {
  const trigger = task.trigger as { detector?: { type?: unknown } } | undefined;
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    workspaceId: task.workspaceId,
    executionMode: task.executionMode,
    runMode: task.runMode,
    dispatchOrigin: task.dispatchOrigin,
    detectorType: trigger?.detector?.type ?? 'always',
    intervalMinutes: task.intervalMinutes,
    cronExpression: task.cronExpression,
    cronTimezone: task.cronTimezone,
    startAt: task.startAt,
    dispatchAt: task.dispatchAt,
    nextExecutionAt: task.nextExecutionAt ?? null,
    executionCount: task.executionCount ?? 0,
    sessionCount: Array.isArray(task.sessionIds) ? task.sessionIds.length : 0,
    lastExecutedAt: task.lastExecutedAt,
    updatedAt: task.updatedAt,
    tags: task.tags,
    executionState: task.executionState,
    executionError: task.executionError,
  };
}

type TaskAgentReceiptOperation = 'create' | 'get' | 'run' | 'rerun';

function taskStatusMeaning(
  status: string | null,
  executionState: string | null,
): string {
  switch (status) {
    case 'todo':
      return 'The Task is saved but its scheduler is not enabled. Run it when it should start.';
    case 'running':
      return executionState
        ? `The Task scheduler is enabled; the current execution state is '${executionState}'.`
        : 'The Task scheduler is enabled. This status does not by itself mean an AI turn is executing now.';
    case 'verifying':
      return 'The Task is settling or verifying an execution. Do not dispatch a duplicate run.';
    case 'stopped':
      return 'The Task scheduler is paused. Use task start to resume it.';
    case 'blocked':
      return 'The Task stopped after a failure or blocker. Inspect it, resolve the cause, then use task rerun.';
    case 'done':
      return 'The Task reached a completed terminal state. Use task rerun only to start another execution.';
    case 'archived':
      return 'The Task is archived and not scheduled. Use task rerun only when intentionally reactivating it.';
    case 'deleted':
      return 'The Task has been deleted from ordinary Task surfaces.';
    default:
      return 'The authoritative Task status is unavailable in this response; inspect the Task before acting.';
  }
}

/**
 * Add one stable, AI-facing semantic receipt without replacing any legacy
 * response fields. Everything here is derived from the Task projection that
 * Rust already returned; this helper owns no lifecycle or persisted state.
 */
function withTaskAgentReceipt(
  response: AdminResponse,
  operation: TaskAgentReceiptOperation,
  options: { changed: boolean; taskId?: string },
): AdminResponse {
  if (
    !response.success ||
    !response.data ||
    typeof response.data !== 'object' ||
    Array.isArray(response.data)
  ) {
    return response;
  }
  const data = response.data as Record<string, unknown>;
  const task =
    data.task && typeof data.task === 'object' && !Array.isArray(data.task)
      ? (data.task as Record<string, unknown>)
      : data;
  const taskId =
    typeof task.id === 'string'
      ? task.id
      : typeof data.taskId === 'string'
        ? data.taskId
        : typeof data.task_id === 'string'
          ? data.task_id
          : options.taskId;
  if (!taskId) return response;

  const rawStatus =
    typeof data.status === 'string'
      ? data.status
      : typeof task.status === 'string'
        ? task.status
        : null;
  const status = rawStatus?.toLowerCase() ?? null;
  const executionState =
    typeof task.executionState === 'string'
      ? task.executionState
      : typeof data.executionState === 'string'
        ? data.executionState
        : null;
  const nextExecutionAt =
    typeof data.nextExecutionAt === 'number'
      ? data.nextExecutionAt
      : typeof task.nextExecutionAt === 'number'
        ? task.nextExecutionAt
        : null;
  const changed =
    typeof data.changed === 'boolean' ? data.changed : options.changed;
  const boundSession =
    task.runMode === 'single-session' ||
    task.dispatchOrigin === 'attached-session';

  return {
    ...response,
    data: {
      ...data,
      receipt: {
        operation,
        taskId,
        status,
        statusMeaning: taskStatusMeaning(status, executionState),
        changed,
        nextExecutionAt,
        executionState,
        resultAccess: {
          mode: boundSession ? 'bound-session' : 'execution-session',
          summary: boundSession
            ? 'Execution results stay in the Task bound Session and are not copied into Task comments automatically.'
            : 'Execution results stay in Task execution Sessions and run history; they are not pushed back to the creating Session or copied into Task comments automatically.',
          inspectTaskCommand: `myagents task get ${taskId} --json`,
          inspectRunsCommand: `myagents task runs ${taskId} --limit 5 --full --json`,
          inspectCommentsCommand: `myagents task comments ${taskId} --limit 50 --json`,
        },
      },
    },
  };
}

export async function handleTaskList(payload: {
  workspaceId?: string;
  workspacePath?: string;
  status?: string;
  tag?: string;
  query?: string;
  limit?: number;
  includeDeleted?: boolean;
}): Promise<AdminResponse> {
  const resolved = resolveTaskWorkspace(payload);
  if ('response' in resolved) return resolved.response;
  const {
    query,
    limit,
    workspacePath: _workspacePath,
    ...filters
  } = resolved.payload;
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200)
  ) {
    return { success: false, error: 'limit must be an integer from 1 to 200' };
  }
  const resp = await managementApi(
    `/api/task/list${qsFrom(filters as Record<string, string | number | boolean | undefined>)}`,
  );
  if (resp.ok) {
    const tasks = Array.isArray((resp as Record<string, unknown>).tasks)
      ? ((resp as Record<string, unknown>).tasks as Array<
          Record<string, unknown>
        >)
      : [];
    const needle =
      typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
    const matched = needle
      ? tasks.filter((task) => {
          const tags = Array.isArray(task.tags) ? task.tags.join(' ') : '';
          return [task.id, task.name, task.description, tags]
            .map((value) => String(value ?? '').toLocaleLowerCase())
            .some((value) => value.includes(needle));
        })
      : tasks;
    const limited =
      limit === undefined ? matched : matched.slice(0, Number(limit));
    return {
      success: true,
      data: limited.map(compactTaskForAgent),
      scope: {
        workspacePath: String(resolved.payload.workspacePath),
        source:
          payload.workspaceId || payload.workspacePath ? 'explicit' : 'default',
        visibility: 'current Task workspace',
      },
    };
  }
  return mgmtError(resp, 'Failed to list tasks');
}

export async function handleTaskGet(payload: {
  id: string;
}): Promise<AdminResponse> {
  const resp = await managementApi(
    `/api/task/get${qsFrom({ id: payload.id })}`,
  );
  if (resp.ok) {
    return withTaskAgentReceipt(
      { success: true, data: (resp as Record<string, unknown>).task },
      'get',
      { changed: false, taskId: payload.id },
    );
  }
  return mgmtError(resp, 'Failed to get task');
}

export async function handleTaskComments(payload: {
  id: string;
  before?: string;
  limit?: number;
}): Promise<AdminResponse> {
  const resp = await managementApi(
    `/api/task/comments${qsFrom(payload as Record<string, string | number | undefined>)}`,
  );
  if (resp.ok) return { success: true, data: resp.page };
  return mgmtError(resp, 'Failed to list Task comments');
}

export async function handleTaskComment(payload: {
  id?: string;
  body: string;
  replyToCommentId?: string;
}): Promise<AdminResponse> {
  // Session identity belongs to this Sidecar process. Never accept a
  // client-provided value: a CLI payload is untrusted and could otherwise
  // impersonate another Task-bound Session.
  const sessionId = process.env.MYAGENTS_SESSION_ID?.trim();
  if (!sessionId) {
    return {
      success: false,
      error:
        'Task Agent comments require MYAGENTS_SESSION_ID; run this command inside the associated Task Session.',
    };
  }
  const taskId = payload.id?.trim() || getCronTaskContext(sessionId).taskId;
  if (!taskId) {
    return {
      success: false,
      error:
        'Task ID is required outside an active Task turn. Pass <taskId> from the Task comment reminder.',
    };
  }
  const resp = await managementApi('/api/task/comment', 'POST', {
    id: taskId,
    body: payload.body,
    replyToCommentId: payload.replyToCommentId,
    sessionId,
  });
  return wrapMgmtResponse(resp);
}

export async function handleTaskCreateDirect(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  const resolved = resolveTaskWorkspace(payload);
  if ('response' in resolved) {
    // Preserve the most actionable argument error when an explicit runtime
    // override is malformed, even if current workspace discovery is also
    // unavailable. A valid request still fails closed on missing workspace.
    const validationError = await validateTaskOverrides(payload);
    return validationError ?? resolved.response;
  }
  const request: Record<string, unknown> = {
    ...resolved.payload,
    ...normalizedTaskCliCaller(resolved.payload as TaskCliCaller),
  };
  const validationError = await validateTaskOverrides(request);
  if (validationError) return validationError;

  const overridden = computeOverriddenFields(request);
  const resp = await managementApi('/api/task/create-direct', 'POST', request);
  const wrapped = wrapMgmtResponse(resp);
  const enriched = enrichTaskCreateResponse(wrapped, request, overridden);
  if (enriched.success) {
    trackServer('task_create', {
      source: taskCliAnalyticsSource(request as TaskCliCaller),
      origin: 'manual',
      has_workspace: true,
    });
  }
  return enriched;
}

export async function handleTaskCreateAttached(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  if (
    typeof payload.currentSessionId !== 'string' ||
    payload.currentSessionId.trim().length === 0
  ) {
    return {
      success: false,
      error:
        'currentSessionId is required; run this command from inside a MyAgents AI session',
    };
  }
  const resp = await managementApi(
    '/api/task/create-attached',
    'POST',
    payload,
  );
  const wrapped = wrapMgmtResponse(resp);
  const enriched = enrichTaskCreateResponse(wrapped, payload, [], {
    attached: true,
  });
  if (enriched.success) {
    trackServer('task_create', {
      source: cliSource(),
      origin: 'space_issue_attached',
      has_workspace:
        typeof payload.workspacePath === 'string' &&
        payload.workspacePath.length > 0,
    });
  }
  return enriched;
}

export async function handleTaskRun(payload: {
  id: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/run', 'POST', payload);
  const wrapped = withTaskAgentReceipt(wrapMgmtResponse(resp), 'run', {
    changed: resp.changed !== false,
    taskId: payload.id,
  });
  if (wrapped.success) {
    const { attemptOrdinal, changed } = wrapped.data as {
      attemptOrdinal?: number;
      changed?: boolean;
    };
    if (changed !== false && typeof attemptOrdinal === 'number') {
      trackServer('task_run', {
        source: taskCliAnalyticsSource(payload as TaskCliCaller),
        run_count: attemptOrdinal,
      });
    }
  }
  return wrapped;
}

export async function handleTaskRerun(payload: {
  id: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/rerun', 'POST', payload);
  const wrapped = withTaskAgentReceipt(wrapMgmtResponse(resp), 'rerun', {
    changed: true,
    taskId: payload.id,
  });
  if (wrapped.success) {
    const { attemptOrdinal } = wrapped.data as { attemptOrdinal?: number };
    if (typeof attemptOrdinal === 'number') {
      trackServer('task_run', {
        source: taskCliAnalyticsSource(payload as TaskCliCaller),
        run_count: attemptOrdinal,
      });
    }
  }
  return wrapped;
}

export async function handleTaskRunNow(payload: {
  id: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/run-now', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleTaskTriggerValidate(payload: {
  trigger?: unknown;
}): Promise<AdminResponse> {
  const resp = await managementApi(
    '/api/task/trigger/validate',
    'POST',
    payload,
  );
  return wrapMgmtResponse(resp);
}

export async function handleTaskTriggerTest(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  const { expect, ...request } = payload;
  if (expect !== undefined && expect !== 'quiet' && expect !== 'activate') {
    return { success: false, error: '--expect must be quiet or activate' };
  }
  // Rust accepts Detector timeouts up to 300s. Keep the transport alive for
  // the valid execution window plus bounded serialization/IPC overhead.
  const resp = await managementApi('/api/task/trigger/test', 'POST', request, {
    timeoutMs: 310_000,
  });
  const wrapped = wrapMgmtResponse(resp);
  if (!wrapped.success && resp.result && typeof resp.result === 'object') {
    wrapped.data = { result: resp.result };
  }
  if (!wrapped.success || expect === undefined) return wrapped;
  const data = wrapped.data as { result?: { decision?: unknown } } | undefined;
  const actual = data?.result?.decision;
  if (actual !== expect) {
    return {
      success: false,
      error: `Detector returned ${String(actual ?? 'unknown')}; expected ${expect}`,
      data: wrapped.data,
    };
  }
  return wrapped;
}

export async function handleTaskCheckNow(payload: {
  id: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/check-now', 'POST', payload, {
    timeoutMs: 310_000,
  });
  const wrapped = wrapMgmtResponse(resp);
  if (!wrapped.success && resp.result && typeof resp.result === 'object') {
    wrapped.data = { result: resp.result };
  }
  return wrapped;
}

export async function handleTaskResetCheckpoint(payload: {
  id: string;
}): Promise<AdminResponse> {
  const resp = await managementApi(
    '/api/task/reset-checkpoint',
    'POST',
    payload,
  );
  return wrapMgmtResponse(resp);
}

/**
 * Enrich a successful task-create response with:
 *   - the override values **as actually persisted** (read from the returned
 *     Task record, not echoed from the request — this proves the round-trip
 *     survived serde rather than just restating what the client sent);
 *   - `overridden` — the list of override fields the caller supplied that
 *     also show up on the persisted task (so "requested but dropped" is
 *     visible as a mismatch);
 *   - `nextSteps` — the next CLI commands the caller is most likely to run.
 *
 * No-op on failed responses (leaves the existing error / recoveryHint shape
 * untouched).
 */
function enrichTaskCreateResponse(
  response: AdminResponse,
  payload: Record<string, unknown>,
  requestedOverrides: string[],
  options: { attached?: boolean } = {},
): AdminResponse {
  if (!response.success) return response;
  const existing = (response.data ?? {}) as Record<string, unknown>;
  // Rust returns `{ task: {...} }` for task creation — unwrap so we can read
  // the authoritative persisted values.
  const persistedTask =
    (existing.task as Record<string, unknown> | undefined) ?? existing; // fallback for older Rust shapes that returned the task inline
  const taskId =
    typeof persistedTask.id === 'string'
      ? persistedTask.id
      : typeof existing.task_id === 'string'
        ? existing.task_id
        : typeof existing.taskId === 'string'
          ? existing.taskId
          : undefined;

  // Read the overrides from the persisted Task, NOT from the request payload.
  // Read persisted values so a DTO mismatch cannot masquerade as success.
  const persistedOverrides = {
    runtime: (persistedTask.runtime as string | undefined) ?? null,
    providerId: (persistedTask.providerId as string | undefined) ?? null,
    model: (persistedTask.model as string | undefined) ?? null,
    permissionMode:
      (persistedTask.permissionMode as string | undefined) ?? null,
    runtimeConfig: persistedTask.runtimeConfig ?? null,
  };

  // The authoritative "overridden" list: fields the caller requested AND that
  // actually landed on the persisted task. If the two diverge, the extra
  // `overridesRequested` field (below) lets the caller detect the drop.
  const fieldsWithValue = Object.entries(persistedOverrides)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k]) => k);

  const enriched: Record<string, unknown> = {
    ...existing,
    overrides: persistedOverrides,
    overridden: fieldsWithValue,
    // If the client requested an override that didn't land, this exposes the
    // drift (a diff between these two arrays means "server silently dropped
    // a field you sent").
    overridesRequested: requestedOverrides,
    inheritedFromWorkspace: [
      'runtime',
      'providerId',
      'model',
      'permissionMode',
    ].filter((f) => !fieldsWithValue.includes(f)),
  };
  if (taskId) {
    enriched.nextSteps = options.attached
      ? {
          inspect: `myagents task get ${taskId}`,
          complete: `myagents task update-status ${taskId} done --message "<summary>"`,
        }
      : {
          dispatch: `myagents task run ${taskId}`,
          inspect: `myagents task get ${taskId}`,
        };
  }
  return withTaskAgentReceipt({ ...response, data: enriched }, 'create', {
    changed: true,
    taskId,
  });
}

/**
 * Patch a Task's fields after creation. Rust handler reuses `TaskStore::update`,
 * which is rejected on Running/Verifying tasks and projects schedule /
 * notification / override changes back to the linked CronTask. The CLI accepts
 * the same flag set as `task create-direct`, and the same override validator
 * runs first so a bad `--runtime` / `--model` / `--permissionMode` is caught
 * before serde would silently drop it.
 *
 * The payload's `id` field is required by Rust (`TaskUpdateInput.id`); CLI
 * promotes the positional `taskId` into `id` so callers don't have to know
 * the wire field name.
 */
export async function handleTaskUpdate(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    return { success: false, error: 'task id is required' };
  }
  let validationPayload = payload;
  if (hasTaskRuntimeOverride(payload)) {
    const current = await handleTaskGet({ id: payload.id });
    if (!current.success) return current;
    if (
      !current.data ||
      typeof current.data !== 'object' ||
      Array.isArray(current.data)
    ) {
      return {
        success: false,
        error: `Task '${payload.id}' returned invalid persisted data.`,
      };
    }
    validationPayload = mergeTaskRuntimeValidationPayload(
      current.data as Record<string, unknown>,
      payload,
    );
  }
  const validationError = await validateTaskOverrides(validationPayload);
  if (validationError) return validationError;
  const resp = await managementApi('/api/task/update', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleTaskUpdateStatus(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  const request = {
    ...payload,
    ...normalizedTaskCliCaller(payload as TaskCliCaller),
  };
  const resp = await managementApi('/api/task/update-status', 'POST', request);
  const wrapped = wrapMgmtResponse(resp);
  // Only `stopped` counts as a "stop" event in analytics terms — other
  // status transitions (running/done/blocked/etc) flow through the same
  // endpoint but aren't user-initiated stops.
  if (wrapped.success && payload.status === 'stopped') {
    trackServer('task_stop', {
      source: taskCliAnalyticsSource(request as TaskCliCaller),
    });
  }
  return wrapped;
}

export async function handleTaskAppendSession(payload: {
  id: string;
  sessionId: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/append-session', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleTaskArchive(payload: {
  id: string;
  message?: string;
  actor?: 'agent' | 'user';
  source?: 'cli';
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/archive', 'POST', {
    ...payload,
    ...normalizedTaskCliCaller(payload),
  });
  return wrapMgmtResponse(resp);
}

export async function handleTaskDelete(payload: {
  id: string;
  actor?: 'agent' | 'user';
  source?: 'cli';
}): Promise<AdminResponse> {
  // Fetch the task's status BEFORE the delete so we can report it in the
  // analytics event. Best-effort — if the read fails (e.g. id doesn't exist),
  // we still attempt the delete and just report `status: 'unknown'`. We
  // accept the extra round-trip because delete is a low-frequency action
  // and the status field is the most useful dimension for understanding
  // what users are pruning (orphan todos vs. completed work etc.).
  let status = 'unknown';
  try {
    const fetched = await managementApi(
      `/api/task/get${qsFrom({ id: payload.id })}`,
    );
    if (fetched.ok) {
      const task = (fetched as Record<string, unknown>).task as
        | Record<string, unknown>
        | undefined;
      if (task && typeof task.status === 'string') {
        status = task.status;
      }
    }
  } catch {
    // Silent — analytics must not affect the main flow.
  }
  const resp = await managementApi('/api/task/delete', 'POST', {
    ...payload,
    ...normalizedTaskCliCaller(payload),
  });
  const wrapped = wrapMgmtResponse(resp);
  if (wrapped.success) {
    trackServer('task_delete', {
      source: taskCliAnalyticsSource(payload),
      status,
    });
  }
  return wrapped;
}

/**
 * Read a task's canonical `task.md` or a retained legacy markdown doc.
 * Missing legacy files return `{ ok: true, content: "" }` so
 * CLI scripting is idempotent. Task docs live under `~/.myagents/tasks/<id>/`
 * since v0.1.69 — this endpoint is the agent-facing read path because the
 * AI runs in the workspace cwd and can't know the user-profile dir.
 */
export async function handleTaskReadDoc(payload: {
  id: string;
  doc: string;
}): Promise<AdminResponse> {
  const resp = await managementApi(`/api/task/read-doc${qsFrom(payload)}`);
  if (resp.ok) {
    return {
      success: true,
      data: { content: (resp as Record<string, unknown>).content ?? '' },
    };
  }
  return mgmtError(resp, 'Failed to read task doc');
}

/**
 * Write canonical `task.md` or retained legacy `verify.md`. Legacy
 * `progress.md` / `alignment.md` remain read-only through this API.
 */
export async function handleTaskWriteDoc(payload: {
  id: string;
  doc: string;
  content: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/task/write-doc', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleThoughtList(payload: {
  tag?: string;
  query?: string;
  limit?: number;
}): Promise<AdminResponse> {
  const resp = await managementApi(`/api/thought/list${qsFrom(payload)}`);
  if (resp.ok) {
    return {
      success: true,
      data: (resp as Record<string, unknown>).thoughts ?? [],
    };
  }
  return mgmtError(resp, 'Failed to list thoughts');
}

export async function handleThoughtCreate(payload: {
  content: string;
  images?: string[];
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/thought/create', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleRecordList(payload: {
  kind?: 'text' | 'audio';
  tag?: string;
  query?: string;
  limit?: number;
  archived?: 'active' | 'archived' | 'all';
}): Promise<AdminResponse> {
  const resp = await managementApi(`/api/record/list${qsFrom(payload)}`);
  if (resp.ok) {
    return {
      success: true,
      data: (resp as Record<string, unknown>).records ?? [],
    };
  }
  return mgmtError(resp, 'Failed to list records');
}

export async function handleRecordCreate(payload: {
  content: string;
  images?: string[];
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/record/create', 'POST', payload);
  return wrapMgmtResponse(resp);
}

// ---------------------------------------------------------------------------
// Session-scoped capabilities for external runtimes (v0.1.67)
//
// These handlers expose Pattern 1 (context-injected) MCP tools to the `myagents`
// CLI so the AI running on external runtimes (Claude Code / Codex / Gemini CLI)
// can reach MyAgents-specific capabilities through plain shell tool calls
// instead of a Claude-Agent-SDK-only MCP protocol. See prd_0.1.67.
//
// Authorization model: Sidecar is session-scoped (1 Sidecar = 1 session), so
// most ambient context is already bound to the calling Sidecar. Commands that
// need a durable local Task/session link use MYAGENTS_SESSION_ID explicitly.
// ---------------------------------------------------------------------------

export function handleCronExit(payload: { reason?: string }): AdminResponse {
  const ctx = getCronTaskContext();
  if (!ctx.taskId) {
    return {
      success: false,
      error:
        'No active scheduled Task in this session. This command only works inside a scheduled Task run.',
    };
  }
  if (!ctx.canExit) {
    return {
      success: false,
      error:
        'This Task has "Allow AI to exit" disabled — only the user can stop it from the UI.',
    };
  }
  const reason = payload.reason?.trim() || 'AI requested task exit';
  const request = markCronTaskExitRequested(reason) ?? {
    taskId: ctx.taskId,
    reason,
    timestamp: new Date().toISOString(),
  };
  return {
    success: true,
    data: { taskId: request.taskId, reason: request.reason },
    hint: `${CRON_TASK_EXIT_TEXT}. Reason: ${request.reason}`,
  };
}

/**
 * `myagents im wake [--text "..."]` — trigger a heartbeat wake on the current
 * IM bot. Used by AI to nudge itself into the next reasoning cycle when it
 * needs another turn (e.g., long-running task that just produced new state).
 *
 * Only meaningful inside an IM session — there is no "current bot" outside
 * one, so we reject early instead of silently no-oping.
 */
export async function handleImWake(payload: {
  text?: string;
}): Promise<AdminResponse> {
  const ctx = getImMediaContext();
  if (!ctx) {
    return {
      success: false,
      error:
        'No IM context in this session. `myagents im wake` only works inside an IM Bot / Agent Channel session.',
    };
  }
  const resp = await managementApi('/api/im/wake', 'POST', {
    botId: ctx.botId,
    text: payload.text || undefined,
  });
  if (resp.ok) {
    return { success: true, hint: 'Heartbeat wake triggered.' };
  }
  return mgmtError(resp, 'Failed to trigger wake');
}

/**
 * `myagents im channels` — list all configured IM channels (Telegram /
 * Feishu / DingTalk / OpenClaw plugin bots). Useful for AI to discover what
 * delivery targets are available before creating a cron task that delivers
 * to IM. Works in any session — does not require an active IM context.
 */
export async function handleImChannels(): Promise<AdminResponse> {
  const resp = await managementApi('/api/im/channels');
  if (!resp.ok) {
    return mgmtError(resp, 'Failed to list IM channels');
  }
  // Defensive: Rust contract is `{ ok: true, channels: [...] }`, but a Rust
  // refactor could regress to `null` / object / missing without compile-time
  // help on our side. Validate explicitly so we don't propagate a broken
  // shape to CLI output.
  const channels = Array.isArray(resp.channels)
    ? (resp.channels as Array<Record<string, unknown>>)
    : [];
  return {
    success: true,
    data: { channels },
    hint:
      channels.length === 0
        ? 'No IM channels configured. The user needs to set up an Agent channel (Telegram/Feishu/DingTalk) in Settings first.'
        : `${channels.length} IM channel${channels.length === 1 ? '' : 's'} configured.`,
  };
}

export async function handleImSendMedia(payload: {
  filePath?: string;
  caption?: string;
}): Promise<AdminResponse> {
  if (!payload.filePath) {
    return {
      success: false,
      error: 'Missing required field: --file <absolute-path>',
    };
  }
  const ctx = getImMediaContext();
  if (!ctx) {
    return {
      success: false,
      error:
        'No IM context in this session. This command only works inside an IM Bot / Agent Channel session.',
    };
  }
  // Path traversal guard: prompt-injected AI on an external runtime could be
  // steered into `myagents im send-media --file ~/.ssh/id_rsa` and exfiltrate
  // secrets to the chat peer. assertSafeFilePath canonicalises (dereferencing
  // symlinks) and requires the real path to live under workspace / tmp / the
  // myagents scratch dir. Any other location is rejected with a clear error.
  const { agentDir } = getAgentState();
  let safePath: string;
  try {
    safePath = assertSafeFilePath(payload.filePath, {
      workspacePath: agentDir,
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const resp = await managementApi('/api/im/send-media', 'POST', {
    botId: ctx.botId,
    chatId: ctx.chatId,
    platform: ctx.platform,
    filePath: safePath,
    caption: payload.caption,
  });
  if (resp.ok) {
    return {
      success: true,
      data: {
        fileName: (resp as Record<string, unknown>).fileName,
        fileSize: (resp as Record<string, unknown>).fileSize,
      },
      hint: 'File sent to IM chat.',
    };
  }
  return mgmtError(resp, 'Failed to send media');
}

// ---------------------------------------------------------------------------
// Tool readme lookups — progressive disclosure (v0.1.67)
//
// Skill layer pre-injects BRIEF descriptions of these tools into the system
// prompt (system-prompt-cli-tools.ts). When the AI actually needs to use one,
// it calls `myagents X readme` to pull the full usage doc on demand.
// ---------------------------------------------------------------------------

const README_TASK_AUTOMATION = `myagents task — Scheduled and conditional automation

PRODUCT MODEL
  Every future or recurring automation is one Task:
    schedule + activation + task.md action + Session routing + end conditions

  The schedule decides when a tick happens. The effective activation is either:
    always            Run the AI action at every tick (default; omit --trigger-file)
    command Detector  Run a cheap program first; quiet stays silent and activate
                      dispatches the ordinary Task AI turn

  Use the required system skill 'myagents-task-automation' for the complete
  Agent workflow. It routes command Detector authoring to its protocol reference.

CANONICAL COMMANDS
  create-direct ...                 Create ordinary or scheduled Task
  get <taskId> --json               Read authoritative config and runtime health
  run <taskId>                      Enable a newly-created Todo Task
  start <taskId>                    Resume schedule; read returned nextExecutionAt
  stop <taskId>                     Pause schedule and stop active execution
  runs <taskId> [--limit N]         Read recent AI execution history
  run-now <taskId>                  Bypass Detector; does not change schedule/checkpoint
  check-now <taskId>                Real Detector check; commits state and may activate AI
  trigger validate/test ...         Validate without committing MyAgents state
  reset-checkpoint <taskId>         Clear only platform-managed Detector checkpoint
  rerun <taskId>                    Re-dispatch a terminal Task
  exit --reason <text>              End the current eligible scheduled Task from inside it
  delete <taskId>                   Delete after explicit user confirmation

SCHEDULE CREATION
  --executionMode scheduled --dispatchAt <ISO-with-offset>
  --executionMode recurring --intervalMinutes <n>             (minimum 5)
  --startAt <ISO-with-offset>                                 (optional first interval tick)
  --executionMode recurring --cronExpression "0 9 * * *" \
                            --cronTimezone Asia/Shanghai

  Wall-clock Cron schedules use an IANA timezone. Absolute dispatch/deadline
  inputs require ISO 8601 with an explicit offset or Z.

END CONDITIONS
  --deadline <ISO-with-offset>       Stop starting new AI turns after the instant
  --maxExecutions <n>                Cap settled AI turns; quiet checks do not count
  --aiCanExit true|false             Allow/disallow 'myagents task exit'

LIFECYCLE
  create --json -> parse taskId -> get --json -> run --json.
  'run' is initial Todo enablement; 'start' resumes Stopped; 'rerun' handles a
  terminal Task. Running means scheduler enabled, not necessarily executing now.
  create/get/run/rerun expose one stable data.receipt with statusMeaning,
  changed, nextExecutionAt, executionState, and resultAccess. Repeating run for
  an already-Running Task succeeds with changed=false and does not dispatch twice.
  Results remain in the bound/execution Session and run history; ordinary
  assistant output is never copied back to the creating Session or comments.
  A new fixed-interval Task without startAt gets its first tick about 2 seconds
  after run; Cron waits for the next wall-clock tick; scheduled waits for dispatchAt.

SAFETY
  Never use system cron/crontab/at/launchctl/schtasks for a MyAgents Task.
  The App must remain online. Archive is recoverable; delete is not and has no
  undelete/retention promise. Delete does not remove user workspace scripts.
  trigger test runs the external command for real; only MyAgents state is not
  committed, so isolate fixtures and external side effects.`;

const README_CRON = `myagents cron — Compatibility scheduled-task commands

NOTE
  Cron is not a separate store or scheduler. New Agent workflows use the
  canonical guide 'myagents task readme'; these commands remain compatible for
  existing users and scripts.

WHAT
  Create, list, stop, and delete scheduled AI tasks (cron / interval / one-shot).
  Inspect one task with the canonical 'myagents task get <taskId>' command.
  Tasks run inside MyAgents regardless of which runtime the current chat uses.
  A task can deliver results to an IM channel.

TIME SEMANTICS
  MyAgents stores execution facts as absolute instants (UTC internally), but
  recurring wall-clock schedules are defined by cron expression + IANA timezone.

  For recurring "every day at 09:00" style tasks, the default create path is:
    --schedule "0 9 * * *"

  On create, a bare non-JSON --schedule is normalized to the current machine's
  IANA timezone (for example Asia/Shanghai). The timezone field is optional and
  only needed when the user wants a different wall-clock timezone or explicit
  UTC:
    '{"kind":"cron","expr":"0 9 * * *","tz":"America/New_York"}'
    '{"kind":"cron","expr":"0 9 * * *","tz":"UTC"}'

  On update, a bare cron expression keeps the existing cron timezone when the
  previous schedule already had one.

  One-shot schedules are absolute timestamps. Use ISO 8601 with Z or an offset:
    '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}'

  When auditing tasks, look at schedule.kind + schedule.expr + schedule.tz first.
  lastExecutedAt / nextExecutionAt are instants; convert them to the schedule's
  timezone before judging what the user configured.

COMMANDS
  list                            List tasks in the current workspace
                                  For one task: myagents task get <taskId>
  status                          Totals + next execution time
  add OPTIONS                     Create a new task
  start <taskId>                  Enable scheduled task (resume from stopped).
                                  Does not bypass schedule/Detector; an overdue
                                  interval anchor may make the next tick near now.
  run-now <taskId>                Fire one execution immediately without
                                  changing the task's schedule or status.
  stop <taskId>                   Pause a running task
  remove <taskId>                 Delete a task
  update <taskId> OPTIONS         Change name / prompt / schedule
  runs <taskId> [--limit N]       Show recent execution records (output
                                  truncated to 80 chars per row; pass --full
                                  for untruncated output)

STATUS VOCABULARY (in 'list' / 'status' output and --json)
  Two ORTHOGONAL concepts. Don't confuse them.

  status field — the persistent scheduler state:
    Running    Scheduler is enabled. The task fires at its next scheduled
               time (see the 'Next' column). NOT the same as "currently
               executing" — see currentlyExecuting below.
    Stopped    Scheduler is disabled. The task never fires while in this
               state, even when the schedule expression matches. Resume
               with 'task start <taskId>' (or compatibility 'cron start').

  currentlyExecuting field (--json) / '*' marker after the ID (plain text):
    A tick is firing this very instant — either a scheduled fire or a
    'cron run-now' invocation. Calling 'cron run-now' on a task whose
    marker is showing returns a busy error.

  status=Running  +  no '*' marker     →  scheduled, not firing right now
  status=Running  +  '*' marker        →  scheduled AND firing this instant
  status=Stopped  +  no '*' marker     →  disabled, not firing
  status=Stopped  +  '*' marker        →  rare; a scheduled tick was already
                                          in flight when the task got stopped

CREATE OPTIONS (myagents cron add ...)
  --name <text>                   Human-readable label (optional)
  --prompt <text>                 The prompt the AI runs each tick. For short
                                  prompts use this. For multi-line / complex
                                  prompts, prefer --prompt-file.
                                  (Alias: --message.)
  --prompt-file <path>            Read prompt body from a file (recommended for
                                  anything longer than ~80 chars — avoids shell
                                  escape issues with quotes, newlines, \`\`\`).
  --every <minutes>               Run every N minutes (min 5)
  --schedule <expr|json>          Either a cron expression, e.g. "0 9 * * *",
                                  OR a JSON CronSchedule object:
                                    '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}'
                                    '{"kind":"every","minutes":30}'
                                    '{"kind":"cron","expr":"0 9 * * *","tz":"Asia/Shanghai"}'
                                  On create, non-JSON cron input is stored with
                                  the current machine's IANA timezone. JSON "tz"
                                  is optional; use it for a different timezone
                                  or explicit UTC.
  --workspace <path>              Workspace the task runs in. Defaults to the
                                  current session workspace.
  --runtime <builtin|claude-code|codex|gemini>
  --runtime-config <json-object>  Optional runtime identity/config override.
  --provider-id / --model / --permission-mode
                                  Optional Task execution overrides. Omit all
                                  override flags to inherit the target Agent.

UPDATE OPTIONS (myagents cron update <taskId> ...)
  --name / --prompt / --message / --prompt-file / --schedule / --every
  --runtime / --runtime-config / --provider-id / --model / --permission-mode

  Runtime override fields use the same validation as canonical Task creation;
  create dry-run validates the same payload as a real write. Unknown mutation
  flags fail instead of being ignored.
  (Same semantics as create. --message is an alias for --prompt; file and inline
   prompt sources are mutually exclusive.)

EXAMPLES
  # Short prompt, 30 min interval
  myagents cron add --name ping --prompt "ping example.com, report latency" --every 30

  # Long prompt from file (the recommended path)
  printf '%s\\n' 'Check the build log for new errors.' \\
    'If errors found, summarize and tag me.' > /tmp/cron-check.txt
  myagents cron add --name build-watch --prompt-file /tmp/cron-check.txt --every 15

  # Wall-clock daily run at 09:00 in this machine's local timezone
  myagents cron add --name daily-report --prompt "write daily report" \\
    --schedule "0 9 * * *"

  # Wall-clock daily run in an explicit non-local timezone
  myagents cron add --name ny-open --prompt "check market open news" \\
    --schedule '{"kind":"cron","expr":"30 9 * * 1-5","tz":"America/New_York"}'

  # Look at recent runs
  myagents cron list
  myagents cron runs <taskId> --limit 5

EXIT FROM INSIDE A TASK
  If you are currently running as a scheduled Task AND the task creator enabled
  "Allow AI to exit", call:
    myagents task exit --reason "goal achieved"
  to mark the task complete and stop future executions.

DO NOT
  Use system cron / crontab / at / launchctl — they can't see MyAgents state.
  Only the \`myagents task\` canonical surface or compatible \`myagents cron\`
  commands can create tasks inside MyAgents.`;

const README_IM = `myagents im — IM Bot capabilities

WHAT
  Commands that act on the current IM chat (Telegram / Feishu / DingTalk /
  OpenClaw plugin channels). Most commands only work inside an IM Bot
  session or Agent Channel session; \`channels\` works anywhere.

COMMANDS
  send-media --file <path> [--caption <text>]
      Send a file to the current chat. Images (jpg/png/gif/webp/svg — max
      10 MB) are sent as native photos; everything else (pdf/doc/xls/csv/json/
      audio/video/archives) as a file upload (max 50 MB).
      Write the file first using normal file-writing tools, then call this
      with the absolute path. Use for things the user explicitly wants to
      receive — not for intermediate work files. IM session only.

  wake [--text <text>]
      Trigger a heartbeat wake on the current IM bot. Use this when you've
      done work that produced new state and want to drive the next reasoning
      cycle yourself instead of waiting for the user. Optional --text adds
      a contextual hint into the wake message. IM session only.

  channels
      List configured IM channels (Telegram / Feishu / DingTalk / OpenClaw
      plugin bots) the user has set up. Useful before creating a cron task
      that should deliver results to a specific channel. Works in any
      session — does not require an active IM context.

EXAMPLES
  # Generate a CSV and send it
  myagents im send-media --file /tmp/report.csv --caption "Today's numbers"

  # Send a generated chart image
  myagents im send-media --file /tmp/chart.png

  # Discover available IM channels
  myagents im channels --json

  # Wake yourself with a hint
  myagents im wake --text "build finished, time to summarize"`;

const README_WIDGET = `myagents widget — Generative UI widget design guidelines

WHAT
  Returns the MyAgents widget design system (color palette, component specs, layout rules) and the output format you MUST use to embed an interactive widget in a chat reply. Widgets render inline in the conversation — charts, SVG diagrams, interactive explainers, dashboards.

WHEN TO CALL
  Before outputting your first <generative-ui-widget> tag in a desktop chat reply. Reach for a widget whenever ${WIDGET_TRIGGER_GUIDANCE}

WHEN NOT TO CALL
  - One-line answers, chitchat
  - User explicitly asked for plain text / code / markdown
  - IM bot sessions (widgets only render in the desktop client)

COMMAND
  myagents widget readme <module1> [<module2> ...]

MODULES
  chart         Chart.js line/bar/pie patterns, palette hex values, dashboards
  diagram       SVG flowcharts, architecture diagrams, connectors, markers
  interactive   Sliders, calculators, comparison cards, data records
  dashboard     Combines chart + interactive (multi-chart layouts + controls)
  art           SVG illustration / visual metaphor

EXAMPLES
  myagents widget readme chart
  myagents widget readme chart interactive
  myagents widget readme dashboard

The output begins with the required <generative-ui-widget> output format contract; do not skip reading it.`;

const README_THOUGHT = `myagents thought — Legacy compatibility alias for text Records

COMPATIBILITY
  This published alias maps list/create to the canonical RecordStore and keeps
  the legacy JSON shape. New Agent workflows must use 'myagents record'.

COMMANDS
  list [--tag X] [--limit N] [--json]
      Browse text Records through the compatibility projection.

  create '<content>'              # primary form, single-quoted on Linux/macOS
  create --content '<content>'    # explicit flag; keep content single-quoted
  create --content-file <path>    # read content from file (recommended for
                                    multi-line, CJK, or content with shell-
                                    special chars; bypasses any shell quoting
                                    quirk on Windows / pwsh)

  Tag inline with #xxx inside the content body — there is no separate
  --tag flag on create.

RECOVERY
  Run 'myagents record --help' and replace this alias in new commands. This
  compatibility surface cannot create audio Records.`;

async function spaceManagementResponse(
  path: string,
  payload: Record<string, unknown>,
  hint?: string,
): Promise<AdminResponse> {
  const resp = await managementApi(
    path,
    'POST',
    await enrichSpaceWorkspaceContext(payload),
  );
  if (!resp.ok) return mgmtError(resp, 'Space command failed');
  return { success: true, data: resp.data, ...(hint ? { hint } : {}) };
}

async function enrichSpaceWorkspaceContext(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestedPath =
    typeof payload.workspacePath === 'string' && payload.workspacePath.trim()
      ? payload.workspacePath.trim()
      : undefined;
  const currentPath = getCurrentWorkspacePath();
  const workspacePath = requestedPath ?? currentPath;
  const sessionId =
    typeof payload.sessionId === 'string' && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : undefined;
  const origin = sessionId
    ? getSessionEngine().getSessionOrigin(sessionId)
    : undefined;
  const sessionOrigin =
    origin?.kind === 'registered-agent'
      ? {
          spaceId: origin.context.spaceId,
          registeredAgentId: origin.context.registeredAgentId,
        }
      : undefined;
  if (!workspacePath) {
    return { ...payload, ...(sessionOrigin ? { sessionOrigin } : {}) };
  }
  const project = loadProjects().find((item) =>
    workspacePathsEqual(item.path, workspacePath),
  );
  return {
    ...payload,
    workspacePath,
    // An explicit id is identity evidence supplied by the caller. Preserve it
    // so Rust can fail closed when it disagrees with a delivery-bound Agent;
    // only enrich legacy/path-only requests that omitted the stable id.
    workspaceId: payload.workspaceId ?? project?.id,
    ...(sessionOrigin ? { sessionOrigin } : {}),
  };
}

export async function handleSpaceList(): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/list', {});
}

export async function handleSpaceWhoami(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/whoami', payload);
}

export async function handleSpaceAssigneeList(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/assignee-list', payload);
}

export async function handleSpaceGoalList(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/goal-list',
    payload,
    'Copy an active data.items[].id into --goal; never use a title or goalPathLabel as the ID.',
  );
}

export async function handleSpaceIssueCreate(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/issue-create',
    payload,
    'Issue created in MyAgents Space.',
  );
}

export async function handleSpaceIssueUpdate(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/issue-update',
    payload,
    'Issue updated in MyAgents Space. Re-read it before the next stateful action.',
  );
}

export async function handleSpaceIssueGet(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-get', payload);
}

export async function handleSpaceIssueList(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-list', payload);
}

export async function handleSpaceIssueComment(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/issue-comment',
    payload,
    'Comment posted to MyAgents Space.',
  );
}

export async function handleSpaceIssueComments(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-comments', payload);
}

export async function handleSpaceIssueCommentGet(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/issue-comment-get', payload);
}

export async function handleSpaceIssueStatus(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/issue-status',
    payload,
    'Issue status updated.',
  );
}

export async function handleSpaceIssueClaim(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/issue-claim',
    payload,
    'Issue claimed.',
  );
}

export async function handleSpaceIssueClose(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/issue-close',
    payload,
    'Issue closed.',
  );
}

export async function handleSpaceIssueComplete(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/issue-complete',
    payload,
    'Issue completed.',
  );
}

export async function handleSpaceIssueCancelClaim(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/issue-cancel-claim',
    payload,
    'Issue claim cancelled.',
  );
}

export async function handleSpaceClaimLocalTask(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/claim-local-task',
    payload,
    'Claim linked to local task.',
  );
}

export async function handleSpaceAttachmentDownload(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/attachment-download', payload);
}

export async function handleSpaceAttachmentAdd(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse(
    '/api/space/attachment-add',
    payload,
    'Issue attachments added.',
  );
}

export async function handleSpaceAttachmentInspect(
  payload: Record<string, unknown>,
): Promise<AdminResponse> {
  return spaceManagementResponse('/api/space/attachment-inspect', payload);
}

export function handleReadme(payload: {
  topic?: string;
  modules?: string[];
}): AdminResponse {
  const topic = (payload.topic ?? '').toLowerCase();
  if (topic === 'task') {
    return { success: true, data: { text: README_TASK_AUTOMATION } };
  }
  if (topic === 'cron') {
    return { success: true, data: { text: README_CRON } };
  }
  if (topic === 'im' || topic === 'im-media' || topic === 'media') {
    return { success: true, data: { text: README_IM } };
  }
  if (topic === 'thought') {
    return { success: true, data: { text: README_THOUGHT } };
  }
  if (topic === 'widget' || topic === 'generative-ui' || topic === 'ui') {
    const modules = (payload.modules ?? []).filter(
      (m) => typeof m === 'string' && m.length > 0,
    );
    if (modules.length === 0) {
      // No modules passed → return the meta-readme describing modules
      return { success: true, data: { text: README_WIDGET } };
    }
    const text = buildReadMeContent(modules);
    // buildReadMeContent returns a generic "Unknown module(s). Available: ..."
    // sentinel when it can't resolve any of the given modules. Surface that as
    // a failure so the CLI exits non-zero and the AI gets a clear error.
    if (text.startsWith('Unknown module(s)')) {
      return { success: false, error: text };
    }
    return { success: true, data: { text } };
  }
  return {
    success: false,
    error: `Unknown readme topic "${payload.topic}". Available: task, cron, im, widget.`,
  };
}

// ---------------------------------------------------------------------------
// Plugin forwarding (Admin API → Management API)
// ---------------------------------------------------------------------------

export async function handlePluginList(): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/list');
  if (resp.ok) {
    return {
      success: true,
      data: (resp as Record<string, unknown>).plugins ?? [],
    };
  }
  return mgmtError(resp, 'Failed to list plugins');
}

export async function handlePluginInstall(payload: {
  npmSpec: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/install', 'POST', payload);
  if (resp.ok) {
    return {
      success: true,
      data: (resp as Record<string, unknown>).plugin,
      hint: 'Plugin installed successfully.',
    };
  }
  return mgmtError(resp, 'Failed to install plugin');
}

export async function handlePluginUninstall(payload: {
  pluginId: string;
}): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/uninstall', 'POST', payload);
  return wrapMgmtResponse(resp);
}

// ---------------------------------------------------------------------------
// Claude Plugin handlers (PRD 0.2.17) — thin wrappers over the Node Sidecar's
// /api/cc-plugin/* routes. Named "cc-plugin" END-TO-END (admin command, HTTP
// path, store module) to avoid collision with the pre-existing OpenClaw
// channel-plugin commands (`myagents plugin list/install/remove`) above
// which target the Rust Management API at /api/plugin/*. Concepts are
// unrelated: OpenClaw plugins are npm-packaged IM channel adapters, Claude
// plugins are the Anthropic-spec directories containing skills/agents/MCP/
// hooks. Diagnostic curls now resolve unambiguously per process.
//
// Read paths (list / detail) call the store module directly — same process,
// no need for the HTTP loopback hop. Write paths (install / uninstall /
// toggle) go through sidecarSelf so the existing route handler can
// broadcast SSE progress / trigger pre-warm restart; they get the
// skill-tier 330s timeout because a github tarball can easily exceed the
// default 10s.
// ---------------------------------------------------------------------------

export async function handleCcPluginList(): Promise<AdminResponse> {
  const { listInstalledPlugins } = await import('./plugins/store');
  return { success: true, data: listInstalledPlugins() };
}

export async function handleCcPluginShow(payload: {
  id?: string;
  name?: string;
}): Promise<AdminResponse> {
  const { listInstalledPlugins, getPluginDetail } = await import(
    './plugins/store'
  );
  let id = payload.id;
  if (!id && payload.name) {
    const found = listInstalledPlugins().find((p) => p.name === payload.name);
    if (found) id = found.id;
  }
  if (!id) return { success: false, error: 'id or name is required' };
  const item = getPluginDetail(id);
  if (!item) return { success: false, error: '插件未安装' };
  return { success: true, data: item };
}

export async function handleCcPluginInstall(payload: {
  sourceUrl?: string;
  url?: string;
}): Promise<AdminResponse> {
  const sourceUrl = payload.sourceUrl ?? payload.url;
  if (!sourceUrl) return { success: false, error: 'sourceUrl is required' };
  const { json } = await sidecarSelf(
    '/api/cc-plugin/install',
    'POST',
    { sourceUrl },
    { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS },
  );
  if (json.success) {
    return {
      success: true,
      data: json.entry,
      hint: 'Plugin installed. Active after the next session pre-warm.',
    };
  }
  return {
    success: false,
    error:
      typeof json.error === 'string' ? json.error : 'Failed to install plugin',
  };
}

export async function handleCcPluginUninstall(payload: {
  id?: string;
  name?: string;
  purgeData?: boolean;
}): Promise<AdminResponse> {
  const { listInstalledPlugins } = await import('./plugins/store');
  let id = payload.id;
  if (!id && payload.name) {
    const found = listInstalledPlugins().find((p) => p.name === payload.name);
    if (found) id = found.id;
  }
  if (!id) return { success: false, error: 'id or name is required' };
  const { json } = await sidecarSelf(
    '/api/cc-plugin/uninstall',
    'POST',
    { id, purgeData: !!payload.purgeData },
    // Bumped to skill-tier so directory removal on slow disks (e.g. spinning
    // rust with large node_modules data dirs) doesn't abort half-way.
    { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS },
  );
  if (json.success) {
    return { success: true, data: json.removed, hint: 'Plugin removed.' };
  }
  return {
    success: false,
    error:
      typeof json.error === 'string'
        ? json.error
        : 'Failed to uninstall plugin',
  };
}

export async function handleCcPluginToggle(payload: {
  id?: string;
  name?: string;
  enabled: boolean;
}): Promise<AdminResponse> {
  const { listInstalledPlugins } = await import('./plugins/store');
  let id = payload.id;
  if (!id && payload.name) {
    const found = listInstalledPlugins().find((p) => p.name === payload.name);
    if (found) id = found.id;
  }
  if (!id) return { success: false, error: 'id or name is required' };
  const { json } = await sidecarSelf('/api/cc-plugin/toggle', 'POST', {
    id,
    enabled: payload.enabled,
  });
  if (json.success) {
    return {
      success: true,
      data: json.entry,
      hint: payload.enabled ? 'Plugin enabled.' : 'Plugin disabled.',
    };
  }
  return {
    success: false,
    error:
      typeof json.error === 'string' ? json.error : 'Failed to toggle plugin',
  };
}

// ---------------------------------------------------------------------------
// Skill handlers (thin wrappers over /api/skill/* self-loopback)
// ---------------------------------------------------------------------------

export async function handleSkillList(): Promise<AdminResponse> {
  const { json } = await sidecarSelf('/api/skills?scope=all');
  if (json.success) {
    return { success: true, data: json.skills ?? [] };
  }
  return {
    success: false,
    error: String(json.error ?? 'Failed to list skills'),
  };
}

export async function handleSkillInfo(payload: {
  name: string;
  scope?: 'user' | 'project';
}): Promise<AdminResponse> {
  if (!payload.name) return { success: false, error: 'name is required' };
  const scope = payload.scope ?? 'user';
  const { json } = await sidecarSelf(
    `/api/skill/${encodeURIComponent(payload.name)}?scope=${scope}`,
  );
  if (json.success) {
    return { success: true, data: json.skill ?? null };
  }
  return { success: false, error: String(json.error ?? 'Skill not found') };
}

export async function handleSkillAdd(payload: {
  url: string;
  scope?: 'user' | 'project';
  plugin?: string;
  skill?: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<AdminResponse> {
  if (!payload.url) return { success: false, error: 'url is required' };

  // Step 1: a probe must be explicitly non-mutating. Without previewOnly the
  // route intentionally auto-installs an unambiguous single Skill.
  const scope = payload.scope ?? 'user';
  const probe = await sidecarSelf(
    '/api/skill/install-from-url',
    'POST',
    {
      url: payload.url,
      scope,
      previewOnly: true,
    },
    { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS },
  );
  if (!probe.json.success) {
    return {
      success: false,
      error: String(probe.json.error ?? 'Install probe failed'),
    };
  }

  const mode = probe.json.mode as string | undefined;

  // Single, unambiguous, no conflict. Commit through the same confirmed path
  // as every other CLI mode so probe and dry-run are guaranteed write-free.
  if (mode === 'single') {
    const preview = probe.json.preview as {
      skill: {
        suggestedFolderName: string;
        name: string;
        description?: string;
      };
    };
    if (payload.dryRun) {
      return {
        success: true,
        dryRun: true,
        preview: {
          action: 'install',
          scope,
          source: payload.url,
          skills: [preview.skill.suggestedFolderName],
        },
      };
    }
    const commit = await sidecarSelf(
      '/api/skill/install-from-url',
      'POST',
      {
        url: payload.url,
        scope,
        confirmedSelection: {
          folderNames: [preview.skill.suggestedFolderName],
        },
      },
      { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS },
    );
    if (!commit.json.success) {
      return {
        success: false,
        error: String(commit.json.error ?? 'Install failed'),
      };
    }
    return {
      success: true,
      data: commit.json,
      hint: `Installed ${(commit.json.installed as unknown[] | undefined)?.length ?? 0} skill(s)`,
    };
  }

  // Marketplace — require --plugin, install all skills in that plugin
  if (mode === 'marketplace') {
    const preview = probe.json.preview as {
      plugins: Array<{
        name: string;
        description: string;
        skills: Array<{
          suggestedFolderName: string;
          name: string;
          conflict?: boolean;
        }>;
      }>;
    };
    if (!payload.plugin) {
      return {
        success: false,
        error:
          '该仓库是 Claude Plugins 市场，请用 --plugin <name> 指定要安装的 plugin 合集',
        data: {
          availablePlugins: preview.plugins.map((p) => ({
            name: p.name,
            description: p.description,
            skillCount: p.skills.length,
          })),
        },
      };
    }
    const plugin = preview.plugins.find((p) => p.name === payload.plugin);
    if (!plugin) {
      return { success: false, error: `plugin "${payload.plugin}" 不存在` };
    }
    const conflicts = plugin.skills
      .filter((s) => s.conflict)
      .map((s) => s.suggestedFolderName);
    if (conflicts.length > 0 && !payload.force) {
      return {
        success: false,
        error: `以下 skill 已存在：${conflicts.join(', ')}。使用 --force 覆盖。`,
      };
    }
    if (payload.dryRun) {
      return {
        success: true,
        dryRun: true,
        preview: {
          action: conflicts.length > 0 ? 'overwrite' : 'install',
          scope,
          source: payload.url,
          plugin: plugin.name,
          skills: plugin.skills.map((s) => s.suggestedFolderName),
        },
      };
    }
    const commit = await sidecarSelf(
      '/api/skill/install-from-url',
      'POST',
      {
        url: payload.url,
        scope,
        confirmedSelection: {
          pluginName: plugin.name,
          folderNames: plugin.skills.map((s) => s.suggestedFolderName),
          overwrite: payload.force ? conflicts : [],
        },
      },
      { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS },
    );
    if (!commit.json.success) {
      return {
        success: false,
        error: String(commit.json.error ?? 'Install failed'),
      };
    }
    return {
      success: true,
      data: commit.json,
      hint: `Installed ${(commit.json.installed as unknown[] | undefined)?.length ?? 0} skill(s) from ${plugin.name}`,
    };
  }

  // Multi — require --skill or install all
  if (mode === 'multi') {
    const preview = probe.json.preview as {
      candidates: Array<{
        suggestedFolderName: string;
        name: string;
        conflict?: boolean;
      }>;
    };
    let wanted = preview.candidates;
    if (payload.skill) {
      wanted = preview.candidates.filter(
        (c) =>
          c.name === payload.skill || c.suggestedFolderName === payload.skill,
      );
      if (wanted.length === 0) {
        return {
          success: false,
          error: `未找到 skill "${payload.skill}"。可用：${preview.candidates.map((c) => c.suggestedFolderName).join(', ')}`,
        };
      }
    }
    const conflicts = wanted
      .filter((c) => c.conflict)
      .map((c) => c.suggestedFolderName);
    if (conflicts.length > 0 && !payload.force) {
      return {
        success: false,
        error: `已存在：${conflicts.join(', ')}。使用 --force 覆盖。`,
      };
    }
    if (payload.dryRun) {
      return {
        success: true,
        dryRun: true,
        preview: {
          action: conflicts.length > 0 ? 'overwrite' : 'install',
          scope,
          source: payload.url,
          skills: wanted.map((c) => c.suggestedFolderName),
        },
      };
    }
    const commit = await sidecarSelf(
      '/api/skill/install-from-url',
      'POST',
      {
        url: payload.url,
        scope,
        confirmedSelection: {
          folderNames: wanted.map((c) => c.suggestedFolderName),
          overwrite: payload.force ? conflicts : [],
        },
      },
      { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS },
    );
    if (!commit.json.success) {
      return {
        success: false,
        error: String(commit.json.error ?? 'Install failed'),
      };
    }
    return {
      success: true,
      data: commit.json,
      hint: `Installed ${(commit.json.installed as unknown[] | undefined)?.length ?? 0} skill(s)`,
    };
  }

  // single-conflict — need --force to overwrite
  if (mode === 'single-conflict') {
    const preview = probe.json.preview as {
      skill: { suggestedFolderName: string; name: string };
    };
    if (!payload.force) {
      return {
        success: false,
        error: `技能 "${preview.skill.suggestedFolderName}" 已存在。使用 --force 覆盖。`,
      };
    }
    if (payload.dryRun) {
      return {
        success: true,
        dryRun: true,
        preview: {
          action: 'overwrite',
          scope,
          source: payload.url,
          skills: [preview.skill.suggestedFolderName],
        },
      };
    }
    const commit = await sidecarSelf(
      '/api/skill/install-from-url',
      'POST',
      {
        url: payload.url,
        scope,
        confirmedSelection: {
          folderNames: [preview.skill.suggestedFolderName],
          overwrite: [preview.skill.suggestedFolderName],
        },
      },
      { timeoutMs: SKILL_INSTALL_LOOPBACK_TIMEOUT_MS },
    );
    if (!commit.json.success) {
      return {
        success: false,
        error: String(commit.json.error ?? 'Install failed'),
      };
    }
    return {
      success: true,
      data: commit.json,
      hint: `Overwrote "${preview.skill.suggestedFolderName}"`,
    };
  }

  return { success: false, error: `未知的 install mode: ${mode}` };
}

export async function handleSkillRemove(payload: {
  name: string;
  scope?: 'user' | 'project';
}): Promise<AdminResponse> {
  if (!payload.name) return { success: false, error: 'name is required' };
  const scope = payload.scope ?? 'user';
  const { json } = await sidecarSelf(
    `/api/skill/${encodeURIComponent(payload.name)}?scope=${scope}`,
    'DELETE',
  );
  if (json.success) return { success: true, data: { name: payload.name } };
  return {
    success: false,
    error: String(json.error ?? 'Failed to remove skill'),
  };
}

export async function handleSkillToggle(payload: {
  name: string;
  enabled: boolean;
}): Promise<AdminResponse> {
  if (!payload.name) return { success: false, error: 'name is required' };
  const { json } = await sidecarSelf('/api/skill/toggle-enable', 'POST', {
    folderName: payload.name,
    enabled: payload.enabled,
  });
  if (json.success)
    return {
      success: true,
      data: { name: payload.name, enabled: payload.enabled },
    };
  return {
    success: false,
    error: String(json.error ?? 'Failed to toggle skill'),
  };
}

export async function handleSkillSync(): Promise<AdminResponse> {
  const { json } = await sidecarSelf('/api/skill/sync-from-claude', 'POST', {});
  if (json.success) {
    return {
      success: true,
      data: { synced: json.synced ?? 0, failed: json.failed ?? 0 },
      hint: `Synced ${json.synced ?? 0} skill(s) from ~/.claude/skills`,
    };
  }
  return { success: false, error: String(json.error ?? 'Sync failed') };
}

// ---------------------------------------------------------------------------
// Agent runtime status forwarding (Admin API → Management API)
// ---------------------------------------------------------------------------

export async function handleAgentRuntimeStatus(): Promise<AdminResponse> {
  const resp = await managementApi('/api/agent/runtime-status');
  if (resp.ok) {
    return {
      success: true,
      data: (resp as Record<string, unknown>).agents ?? {},
    };
  }
  return mgmtError(resp, 'Failed to get agent runtime status');
}

// ---------------------------------------------------------------------------
// Runtime discovery handlers (v0.1.69+)
//
// Give AI agents (and humans) a way to answer "what am I allowed to pass to
// --runtime / --model / --permissionMode?" *before* they commit to creating
// a task. Without this, the only feedback loop is "task gets created, task
// fails at dispatch time" — the AI then has to unwind multiple async steps
// to figure out it filled the wrong value.
// ---------------------------------------------------------------------------

/** One row in `runtime list` output. */
interface RuntimeListRow {
  runtime: RuntimeType;
  displayName: string;
  installed: boolean;
  version?: string;
  path?: string;
  /** Present when `installed=false` — suggests the install/inspect command. */
  notInstalledHint?: string;
}

/** Payload for `runtime describe <runtime>`. */
interface RuntimeDescribeResult {
  runtime: RuntimeType;
  displayName: string;
  installed: boolean;
  version?: string;
  models: RuntimeModelInfo[];
  permissionModes: RuntimePermissionMode[];
  defaultPermissionMode: string;
}

/** Per-runtime detection timeout — a wedged `<cli> --version` binary shouldn't
 *  block the whole command. Race each detect() against this timeout. */
const RUNTIME_DETECT_TIMEOUT_MS = 2_000;

/**
 * Race a promise against a timeout; on timeout resolves to `fallback`.
 * Used by `handleRuntimeList` / `handleRuntimeDescribe` so one misbehaving
 * runtime CLI doesn't hang the whole Admin API request.
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * List every runtime MyAgents knows about with its install status.
 *
 * Detection is best-effort and actually gated at `RUNTIME_DETECT_TIMEOUT_MS`
 * per runtime — each runtime's `detect()` spawns `<cli> --version`, and a
 * wedged binary would otherwise block the whole list. We *always* return the
 * full row list — even for not-installed runtimes — so the CLI reader sees
 * every valid `--runtime` value and can learn which ones need installing.
 */
export async function handleRuntimeList(): Promise<AdminResponse> {
  const rows: RuntimeListRow[] = [];
  for (const runtime of VALID_RUNTIMES) {
    if (runtime === 'builtin') {
      // builtin is always "installed" — it's the embedded Claude Agent SDK.
      rows.push({
        runtime,
        displayName: RUNTIME_DISPLAY_NAMES[runtime],
        installed: true,
      });
      continue;
    }
    let detection: RuntimeDetection = { installed: false };
    try {
      const rt = getExternalRuntime(runtime);
      detection = await raceWithTimeout(
        rt.detect(),
        RUNTIME_DETECT_TIMEOUT_MS,
        { installed: false },
      );
    } catch {
      // Runtime not supported in this build (should not happen given
      // VALID_RUNTIMES ⊆ supported types, but keep defensive).
    }
    const row: RuntimeListRow = {
      runtime,
      displayName: RUNTIME_DISPLAY_NAMES[runtime],
      installed: detection.installed,
      version: detection.version,
      path: detection.path,
    };
    if (!detection.installed) {
      row.notInstalledHint = hintForMissingRuntime(runtime);
    }
    rows.push(row);
  }
  return { success: true, data: rows };
}

/**
 * Describe a single runtime — its installed state, available models, and
 * permission modes. This is the command the AI is supposed to consult
 * *before* choosing values for `--model` / `--permissionMode`.
 */
export async function handleRuntimeDescribe(
  payload: {
    runtime?: string;
  },
  signal?: AbortSignal,
): Promise<AdminResponse> {
  const runtimeArg = payload.runtime;
  if (!runtimeArg) {
    return {
      success: false,
      error: 'Missing required argument: runtime',
      recoveryHint: {
        recoveryCommand: 'myagents runtime list',
        message: 'See valid runtime names.',
      },
    };
  }
  if (!isValidRuntimeType(runtimeArg)) {
    return {
      success: false,
      error: `Unknown runtime: '${runtimeArg}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
      recoveryHint: {
        recoveryCommand: 'myagents runtime list',
        message: 'See valid runtime names + install status.',
      },
    };
  }

  // builtin has no external CLI — models come from the configured provider,
  // not a spawnable CLI, so we intentionally return `models: []`. Permission
  // modes DO come from a static allowlist (PermissionMode enum) and are
  // surfaced so `runtime describe builtin` is as useful as `describe codex`.
  if (runtimeArg === 'builtin') {
    return {
      success: true,
      data: {
        runtime: runtimeArg,
        displayName: RUNTIME_DISPLAY_NAMES.builtin,
        installed: true,
        models: [],
        permissionModes: getRuntimePermissionModes('builtin'),
        defaultPermissionMode: getDefaultRuntimePermissionMode('builtin'),
        note:
          'Built-in runtime uses the configured provider + model from `myagents model list`. ' +
          'It does not have a runtime-specific model catalogue — override `--model` with any ' +
          'model id supported by the active provider.',
      } satisfies RuntimeDescribeResult & { note: string },
    };
  }

  let detection: RuntimeDetection = { installed: false };
  try {
    detection = await raceWithTimeout(
      getExternalRuntime(runtimeArg).detect(),
      RUNTIME_DETECT_TIMEOUT_MS,
      { installed: false },
    );
  } catch {
    /* detection returns installed:false below */
  }

  // Only query models when the CLI is actually installed — otherwise we'd
  // waste 10+ seconds trying to spawn a binary that doesn't exist.
  let models: RuntimeModelInfo[] = [];
  if (detection.installed) {
    try {
      models = (await queryRuntimeModels(runtimeArg, {
        runtimeSource: runtimeArg === 'codex' ? 'system-cli' : undefined,
        signal,
        throwOnError: true,
      })) as RuntimeModelInfo[];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        code: 'RUNTIME_MODEL_DISCOVERY_FAILED',
        error: `Failed to discover ${RUNTIME_DISPLAY_NAMES[runtimeArg]} models: ${detail}`,
        recoveryHint:
          runtimeArg === 'gemini'
            ? {
                recoveryCommand: 'gemini',
                message:
                  'Authenticate Gemini in a normal terminal, then retry `myagents runtime describe gemini`.',
              }
            : {
                recoveryCommand: `myagents runtime diagnose ${runtimeArg} --json`,
                message:
                  'Inspect runtime installation and authentication, then retry.',
              },
      };
    }
  }
  const permissionModes = getRuntimePermissionModes(runtimeArg);
  const defaultPermissionMode = getDefaultRuntimePermissionMode(runtimeArg);

  return {
    success: true,
    data: {
      runtime: runtimeArg,
      displayName: RUNTIME_DISPLAY_NAMES[runtimeArg],
      installed: detection.installed,
      version: detection.version,
      models,
      permissionModes,
      defaultPermissionMode,
    } satisfies RuntimeDescribeResult,
  };
}

/**
 * Run a one-shot runtime diagnostic — spawns a short-lived runtime process,
 * collects what it sees (auth, features, MCP, apps, effective env), and
 * returns the structured snapshot. Used by `myagents diagnose runtime <type>`
 * (issue #194) and the in-app "诊断" button.
 *
 * Codex: spawns `codex app-server`, no thread created.
 * Claude Code / Gemini / builtin: not yet implemented — returns
 * `unsupported` so the CLI can show a clear "not yet supported" message
 * without crashing.
 */
export async function handleRuntimeDiagnose(payload: {
  runtime?: string;
  workspacePath?: string;
}): Promise<AdminResponse> {
  const runtimeArg = payload.runtime;
  if (!runtimeArg) {
    return {
      success: false,
      error: 'Missing required argument: runtime',
      recoveryHint: {
        recoveryCommand: 'myagents runtime list',
        message: 'See valid runtime names.',
      },
    };
  }
  if (!isValidRuntimeType(runtimeArg)) {
    return {
      success: false,
      error: `Unknown runtime: '${runtimeArg}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
    };
  }

  // Codex is the only runtime with diagnostic RPCs today. Claude Code's
  // -p mode doesn't expose an equivalent surface (it's one-shot per turn);
  // Gemini's ACP has session-scoped state but no "list features / apps".
  if (runtimeArg !== 'codex') {
    return {
      success: false,
      error: `Diagnostic not yet implemented for runtime '${runtimeArg}'. Only 'codex' is currently supported.`,
      data: { runtime: runtimeArg, supported: false },
    };
  }

  let detection: RuntimeDetection = { installed: false };
  try {
    detection = await raceWithTimeout(
      getExternalRuntime(runtimeArg).detect(),
      RUNTIME_DETECT_TIMEOUT_MS,
      { installed: false },
    );
  } catch {
    /* falls through to installed:false */
  }

  if (!detection.installed) {
    return {
      success: false,
      error: `Codex CLI not installed. ${hintForMissingRuntime('codex')}`,
      data: { runtime: 'codex', installed: false },
    };
  }

  // Resolve the agent's envPolicy so the diagnostic reflects the same proxy
  // policy the real session would use (Codex review #3 catch — without this,
  // CLI diagnose silently reports the legacy `myagents` view even when the
  // agent is configured to inherit terminal or skip proxy entirely).
  //
  // Funnel through the shared helper in `env-utils.ts` so this path validates
  // the `proxy` literal the same way `external-session.ts` does — without
  // shared validation, a malformed `envPolicy.proxy` on disk would silently
  // appear as `'myagents'` in the diagnostic banner, hiding the misconfig.
  const { resolveAgentEnvPolicy } = await import('./runtimes/env-utils');
  const envPolicy = payload.workspacePath
    ? await resolveAgentEnvPolicy(payload.workspacePath)
    : undefined;

  try {
    const rt = getExternalRuntime('codex');
    // Type-check the optional method — only CodexRuntime implements it today.
    if (
      typeof (rt as { runStandaloneDiagnostics?: unknown })
        .runStandaloneDiagnostics !== 'function'
    ) {
      return {
        success: false,
        error:
          'Codex runtime adapter does not expose runStandaloneDiagnostics. Build is out of date.',
      };
    }
    const diagnose = (
      rt as unknown as {
        runStandaloneDiagnostics: (
          wp?: string,
          policy?: import('../shared/types/runtime').RuntimeEnvPolicy,
        ) => Promise<unknown>;
      }
    ).runStandaloneDiagnostics;
    const diagnostics = await diagnose(payload.workspacePath, envPolicy);
    return {
      success: true,
      data: {
        runtime: 'codex',
        installed: true,
        version: detection.version,
        diagnostics,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Codex diagnostic failed: ${msg}`,
    };
  }
}

/**
 * Show one agent's effective defaults so the AI can decide whether a given
 * task override is a no-op (same as workspace default) or meaningful.
 */
export async function handleAgentShow(payload: {
  id?: string;
  agentId?: string;
}): Promise<AdminResponse> {
  const id = payload.agentId ?? payload.id;
  if (!id) {
    return {
      success: false,
      error: 'Missing required argument: <agent-id>',
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message: 'See valid agent ids.',
      },
    };
  }
  let registry: Awaited<
    ReturnType<typeof resolvePersistedAgentWorkspaceRegistry>
  >;
  try {
    registry = await resolvePersistedAgentWorkspaceRegistry();
  } catch (error) {
    return agentWorkspaceIdentityFailure(error);
  }
  const diagnostic = registry.diagnostics.find((item) =>
    item.agentIds.includes(id),
  );
  if (diagnostic)
    return { success: false, error: diagnostic.message, code: diagnostic.code };
  const identity = registry.agentProjections.find(
    (item) => item.agentId === id,
  );
  if (
    !identity ||
    (identity.project && !isProjectVisibleToUser(identity.project))
  ) {
    return {
      success: false,
      error: `Agent '${id}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message: 'See valid agent ids.',
      },
    };
  }
  const { agent, project, workspacePath } = identity;

  // AgentConfigSlim is intentionally permissive (`[key: string]: unknown`) —
  // runtime / permissionMode / runtimeConfig exist on the full AgentConfig
  // but not on the slim shape. Extract defensively.
  const storedRuntime = (agent.runtime as RuntimeType | undefined) ?? 'builtin';
  const usesManagedCodex = agentUsesManagedCodexProvider({
    providerId: agent.providerId,
    runtime: storedRuntime,
    runtimeConfig: agent.runtimeConfig as { source?: string } | undefined,
  });
  const runtime: RuntimeType = usesManagedCodex ? 'codex' : storedRuntime;
  const agentPermissionMode =
    (agent.permissionMode as string | undefined) ?? '';
  const runtimeConfig =
    (agent.runtimeConfig as Record<string, unknown> | undefined) ?? undefined;

  // Per-runtime resolution of "effective" model / permissionMode
  // (cross-review fix, v0.1.69):
  //   - builtin       → read from agent.{model, permissionMode}
  //   - CC/Codex/Gemini → prefer agent.runtimeConfig.{model, permissionMode};
  //     fall back to the top-level agent fields only when absent.
  //
  // External runtimes use distinct permission-mode vocabularies (`suggest`,
  // `auto-edit`, `full-auto`, etc.) that do NOT intersect with the builtin
  // enum. Reporting `agent.permissionMode = 'fullAgency'` as the effective
  // value for a Codex agent would be actively misleading — the dispatch
  // path never consults that field.
  const isExternal = runtime !== 'builtin';
  const rcModel = isExternal
    ? (runtimeConfig?.model as string | undefined)
    : undefined;
  const rcPermissionMode = isExternal
    ? (runtimeConfig?.permissionMode as string | undefined)
    : undefined;
  const effectiveModel = usesManagedCodex
    ? (agent.model as string | undefined)
    : (rcModel ?? (agent.model as string | undefined));
  const effectivePermissionMode = usesManagedCodex
    ? (managedCodexProviderPermissionToRuntimePermission(agentPermissionMode) ??
      'auto-edit')
    : isExternal
      ? (projectPermissionModeForRuntime(rcPermissionMode, runtime) ??
        getDefaultRuntimePermissionMode(runtime))
      : agentPermissionMode;

  return {
    success: true,
    data: {
      agentId: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      projectId: project?.id ?? null,
      workspacePath,
      archived: project ? isProjectArchived(project) : false,
      archivedAt:
        project && isProjectArchived(project)
          ? (project.archivedAt ?? null)
          : null,
      association: identity.association,
      isCurrent: isCurrentAgentIdentity(identity, getCurrentWorkspacePath()),
      effectiveDefaults: {
        runtime,
        ...(runtime !== 'builtin'
          ? {
              runtimeSource: usesManagedCodex
                ? 'managed-provider'
                : 'system-cli',
            }
          : {}),
        model: effectiveModel || null,
        permissionMode: effectivePermissionMode || null,
        providerId: agent.providerId ?? null,
        runtimeConfig: runtimeConfig ?? {},
        mcpEnabledServers: Array.isArray(agent.mcpEnabledServers)
          ? agent.mcpEnabledServers
          : [],
        enabledPluginIds: Array.isArray(agent.enabledPluginIds)
          ? agent.enabledPluginIds
          : [],
        enabledOfficialToolIds: Array.isArray(agent.enabledOfficialToolIds)
          ? agent.enabledOfficialToolIds
          : [],
      },
      channelCount: (agent.channels ?? []).length,
    },
  };
}

export async function handleSessionList(payload: {
  agentId?: unknown;
  limit?: unknown;
}): Promise<AdminResponse> {
  const agentId =
    typeof payload.agentId === 'string' ? payload.agentId.trim() : '';
  if (!agentId) {
    return {
      success: false,
      error: 'Missing required option: --agent <agentId>',
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message: 'Discover a stable Agent id first.',
      },
    };
  }
  const limit = payload.limit === undefined ? 5 : Number(payload.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return {
      success: false,
      error: '--limit must be an integer from 1 to 50.',
    };
  }

  let registry: Awaited<
    ReturnType<typeof resolvePersistedAgentWorkspaceRegistry>
  >;
  try {
    registry = await resolvePersistedAgentWorkspaceRegistry();
  } catch (error) {
    return agentWorkspaceIdentityFailure(error);
  }
  const diagnostic = registry.diagnostics.find((item) =>
    item.agentIds.includes(agentId),
  );
  if (diagnostic)
    return { success: false, error: diagnostic.message, code: diagnostic.code };
  const identity = registry.agentProjections.find(
    (item) => item.agentId === agentId,
  );
  if (
    !identity ||
    (identity.project && !isProjectVisibleToUser(identity.project))
  ) {
    return {
      success: false,
      error: `Agent '${agentId}' not found.`,
      recoveryHint: {
        recoveryCommand: 'myagents agent list',
        message:
          'See visible active Agent ids; use --archived for archived workspaces.',
      },
    };
  }

  const sessions = getSessionsByAgentDir(identity.workspacePath)
    .filter(isHistoryVisibleSession)
    .slice(0, limit)
    .map((session) => ({
      sessionId: session.id,
      title: session.title,
      lastActiveAt: session.lastActiveAt,
      lastMessagePreview: session.lastMessagePreview ?? null,
      runtime: session.runtime ?? 'builtin',
      runtimeSource:
        session.runtime && session.runtime !== 'builtin'
          ? (session.runtimeSource ?? 'system-cli')
          : null,
      model: session.model ?? null,
      origin: session.origin ?? null,
    }));
  return {
    success: true,
    data: sessions,
    agentId,
    projectId: identity.projectId ?? null,
    workspacePath: identity.workspacePath,
    limit,
  };
}

/** Type guard for `runtime` string coming from CLI payloads. */
function isValidRuntimeType(runtime: unknown): runtime is RuntimeType {
  return (
    typeof runtime === 'string' &&
    (VALID_RUNTIMES as readonly string[]).includes(runtime)
  );
}

/** Install guidance keyed by runtime. Shown when a runtime is NOT installed. */
function hintForMissingRuntime(runtime: RuntimeType): string {
  switch (runtime) {
    case 'claude-code':
      return 'Install the Claude Code CLI — see https://docs.anthropic.com/claude/docs/claude-code';
    case 'codex':
      return 'Install the OpenAI Codex CLI — `npm i -g @openai/codex` or see https://github.com/openai/codex';
    case 'gemini':
      return 'Install the Gemini CLI — `npm i -g @google/gemini-cli` or see https://github.com/google/gemini-cli';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Task-creation pre-flight validation (v0.1.69+)
//
// Reject bad runtime/model/permissionMode overrides *here* in Node admin-api,
// before the payload hits Rust. Three reasons:
//   1. We have first-class access to `RuntimeFactory.detect()` / queryModels,
//      Rust does not.
//   2. Error strings here can cite the exact CLI recovery command — across
//      the Rust boundary those would turn into opaque serde errors.
//   3. The CLI is the primary caller; keeping validation adjacent to the CLI
//      glue means changes to flag semantics and error copy land in one file.
// ---------------------------------------------------------------------------

/** Fields on a task-create payload that we validate as overrides. */
interface TaskOverrideFields {
  runtime?: unknown;
  runtimeConfig?: unknown;
  providerId?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  /** Workspace path — used to resolve the agent's default runtime when the
   *  caller passes --model / --permissionMode *without* --runtime. */
  workspacePath?: unknown;
  /** Workspace id — alternative identifier for the same lookup as workspacePath. */
  workspaceId?: unknown;
}

function hasTaskRuntimeOverride(payload: Record<string, unknown>): boolean {
  return [
    'runtime',
    'runtimeConfig',
    'providerId',
    'model',
    'permissionMode',
    'clearProviderOverride',
    'clearRuntimeOverride',
  ].some(
    (field) =>
      payload[field] !== undefined &&
      payload[field] !== null &&
      payload[field] !== '',
  );
}

/** Project TaskUpdateInput clear semantics before validating a merged patch. */
function mergeTaskRuntimeValidationPayload(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...current,
    ...patch,
    ...(patch.clearProviderOverride === true
      ? { providerId: undefined, model: undefined }
      : {}),
    ...(patch.clearRuntimeOverride === true
      ? { runtime: undefined, runtimeConfig: undefined }
      : {}),
  };
}

/**
 * Validate the runtime/model/permissionMode fields on a task-create payload.
 * Returns an error `AdminResponse` on first failure, or `null` if all fields
 * are present-and-valid or absent.
 *
 * Effective-runtime resolution (cross-review fix, v0.1.69):
 *   - If `payload.runtime` is set → use it.
 *   - Else if `payload.providerId` is set → builtin; Rust owns provider/model
 *     pair validation and pins the persisted Task runtime to builtin.
 *   - Else if `payload.model` / `payload.permissionMode` is set → resolve the
 *     agent's default runtime from `workspacePath` so we can still validate
 *     the model/mode against the correct allowlist. Without this step a
 *     caller like `--model o3` with no `--runtime` would silently bypass
 *     validation and ship a garbage payload to Rust.
 *   - Else → no overrides at all; nothing to validate.
 */
async function validateTaskOverrides(
  payload: TaskOverrideFields,
): Promise<AdminResponse | null> {
  if (
    payload.providerId !== undefined &&
    payload.providerId !== null &&
    (typeof payload.providerId !== 'string' || payload.providerId.trim() === '')
  ) {
    return {
      success: false,
      error: '--providerId must be a non-empty string.',
    };
  }
  if (
    payload.model !== undefined &&
    payload.model !== null &&
    typeof payload.model !== 'string'
  ) {
    return { success: false, error: '--model must be a string.' };
  }
  if (
    payload.runtimeConfig !== undefined &&
    payload.runtimeConfig !== null &&
    (typeof payload.runtimeConfig !== 'object' ||
      Array.isArray(payload.runtimeConfig))
  ) {
    return { success: false, error: '--runtimeConfig must be a JSON object.' };
  }
  const runtimeConfigModel = taskRuntimeConfigField(
    payload.runtimeConfig,
    'model',
  );
  const rawRuntimeSource = taskRuntimeConfigField(
    payload.runtimeConfig,
    'source',
  );
  const hasProviderOverride =
    typeof payload.providerId === 'string' && payload.providerId.trim() !== '';
  const hasModelOverride =
    typeof payload.model === 'string' && payload.model.trim() !== '';
  if (hasProviderOverride && !hasModelOverride) {
    return {
      success: false,
      error:
        '--providerId requires --model so the Task cannot cross-route a provider to an inherited model.',
    };
  }
  if (
    hasProviderOverride &&
    typeof payload.runtime === 'string' &&
    ['claude-code', 'codex', 'gemini'].includes(payload.runtime)
  ) {
    return {
      success: false,
      error: `Runtime '${payload.runtime}' manages its own provider and cannot be combined with --providerId.`,
    };
  }
  if (
    rawRuntimeSource !== undefined &&
    rawRuntimeSource !== 'system-cli' &&
    rawRuntimeSource !== 'managed-provider'
  ) {
    return {
      success: false,
      error: `Invalid runtimeConfig.source: '${String(rawRuntimeSource)}'. Valid: system-cli, managed-provider.`,
    };
  }
  const runtimeConfigSource = rawRuntimeSource as RuntimeSource | undefined;
  // Step 1: resolve the complete runtime identity that downstream checks use.
  let effectiveRuntimeIdentity:
    | { runtime: RuntimeType; runtimeSource?: RuntimeSource }
    | undefined;
  if (
    payload.runtime !== undefined &&
    payload.runtime !== null &&
    payload.runtime !== ''
  ) {
    if (
      typeof payload.runtime !== 'string' ||
      !isValidRuntimeType(payload.runtime)
    ) {
      return {
        success: false,
        error: `Invalid --runtime value: '${String(payload.runtime)}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
        recoveryHint: {
          recoveryCommand: 'myagents runtime list',
          message: 'See valid runtimes + install status.',
        },
      };
    }
    const runtime = payload.runtime;
    effectiveRuntimeIdentity = {
      runtime,
      ...(runtime === 'codex'
        ? { runtimeSource: runtimeConfigSource ?? 'system-cli' }
        : {}),
    };
  } else if (
    payload.providerId !== undefined &&
    payload.providerId !== null &&
    payload.providerId !== ''
  ) {
    effectiveRuntimeIdentity = { runtime: 'builtin' };
  } else if (
    (payload.model !== undefined &&
      payload.model !== null &&
      payload.model !== '') ||
    (runtimeConfigModel !== undefined &&
      runtimeConfigModel !== null &&
      runtimeConfigModel !== '') ||
    runtimeConfigSource !== undefined ||
    (payload.permissionMode !== undefined &&
      payload.permissionMode !== null &&
      payload.permissionMode !== '')
  ) {
    // --model / --permissionMode passed without --runtime: try to resolve the
    // workspace's agent default so we can still validate against the correct
    // allowlist. If resolution fails, reject rather than silently trust.
    const resolved = resolveAgentRuntimeIdentityFromWorkspace(payload);
    if (resolved === undefined) {
      return {
        success: false,
        error:
          '--model / --permissionMode requires either an explicit --runtime, ' +
          'or a resolvable workspace (via --workspacePath / --workspaceId matching an agent).',
        recoveryHint: {
          recoveryCommand: 'myagents agent list',
          message:
            'Find your agent, then `myagents agent show <id>` to see its default runtime.',
        },
      };
    }
    effectiveRuntimeIdentity = resolved;
  } else {
    // No overrides at all — nothing to validate.
    return null;
  }
  const { runtime: effectiveRuntime, runtimeSource: effectiveRuntimeSource } =
    effectiveRuntimeIdentity;
  if (
    runtimeConfigSource === 'managed-provider' &&
    effectiveRuntime !== 'codex'
  ) {
    return {
      success: false,
      error: 'runtimeConfig.source=managed-provider requires runtime=codex.',
    };
  }
  if (effectiveRuntime !== 'builtin' && isRuntimeSupported(effectiveRuntime)) {
    try {
      const installed =
        effectiveRuntime === 'codex' &&
        effectiveRuntimeSource === 'managed-provider'
          ? isManagedCodexRuntimeInstalled()
          : (await getExternalRuntime(effectiveRuntime).detect()).installed;
      if (!installed) {
        return {
          success: false,
          error: `Runtime '${effectiveRuntime}' is not installed on this machine.`,
          recoveryHint: {
            recoveryCommand: 'myagents runtime list',
            message: 'See which runtimes are available + install hints.',
          },
        };
      }
    } catch {
      return {
        success: false,
        error: `Runtime '${effectiveRuntime}' detection failed.`,
        recoveryHint: {
          recoveryCommand: 'myagents runtime list',
          message: 'See which runtimes are available.',
        },
      };
    }
  }

  // Step 2: permissionMode is validated against the runtime's allowlist.
  // Works for both builtin (BUILTIN_PERMISSION_MODES: auto/plan/fullAgency/custom)
  // and external runtimes (CC/Codex/Gemini) — since `getRuntimePermissionModes`
  // returns an exhaustive list for every runtime including builtin, we don't
  // need a separate builtin escape hatch. Previously builtin was skipped on
  // the assumption that Rust validates it, but Rust stores the field as
  // `Option<String>` with no enum constraint, so a typo like `--permissionMode
  // fulAgency` would land silently.
  if (
    payload.permissionMode !== undefined &&
    payload.permissionMode !== null &&
    payload.permissionMode !== ''
  ) {
    if (typeof payload.permissionMode !== 'string') {
      return {
        success: false,
        error: `--permissionMode must be a string (got ${typeof payload.permissionMode}).`,
        recoveryHint: {
          recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
          message: 'See valid permission modes.',
        },
      };
    }
    const modes = getRuntimePermissionModes(effectiveRuntime).filter((mode) =>
      isPermissionModeForRuntimeIdentity(
        mode.value,
        effectiveRuntime,
        effectiveRuntimeSource,
      ),
    );
    if (
      !isPermissionModeForRuntimeIdentity(
        payload.permissionMode,
        effectiveRuntime,
        effectiveRuntimeSource,
      )
    ) {
      return {
        success: false,
        error: `--permissionMode '${payload.permissionMode}' is not valid for runtime '${effectiveRuntime}'. Valid: ${modes.map((m) => m.value).join(', ')}.`,
        recoveryHint: {
          recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
          message: 'See valid permission modes for this runtime.',
        },
      };
    }
  }

  // Step 3: model is validated for *external* runtimes that expose a known
  // model list. External CLI model lists can be dynamic (Gemini calls the
  // server to discover them) so an empty list is treated as "can't validate,
  // trust the caller". builtin runtime model ids depend on the active
  // provider — out of scope for this validator.
  const modelOverride =
    effectiveRuntime === 'builtin' || runtimeConfigModel === undefined
      ? payload.model
      : runtimeConfigModel;
  if (
    modelOverride !== undefined &&
    modelOverride !== null &&
    modelOverride !== '' &&
    effectiveRuntime !== 'builtin'
  ) {
    if (typeof modelOverride !== 'string') {
      return {
        success: false,
        error: `--model must be a string (got ${typeof modelOverride}).`,
        recoveryHint: {
          recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
          message: 'See valid model ids for this runtime.',
        },
      };
    }
    try {
      const models = (await queryRuntimeModels(effectiveRuntime, {
        runtimeSource: effectiveRuntimeSource,
      })) as RuntimeModelInfo[];
      // Empty list means either "runtime is not installed" (handled above)
      // or "discovery failed transiently" — in both cases, don't block the
      // write. The Rust side will surface the real dispatch error if any.
      if (models.length > 0 && !models.some((m) => m.value === modelOverride)) {
        const examples = models
          .slice(0, 5)
          .map((m) => m.value)
          .filter(Boolean)
          .join(', ');
        return {
          success: false,
          error: `--model '${modelOverride}' is not available for runtime '${effectiveRuntime}'. Examples: ${examples || '(none found)'}.`,
          recoveryHint: {
            recoveryCommand: `myagents runtime describe ${effectiveRuntime}`,
            message: 'See the full model list.',
          },
        };
      }
    } catch {
      /* swallow — same "trust and forward" rationale as above */
    }
  }

  return null;
}

/**
 * Compute which override fields the caller actually provided.
 * Surfaced in the success response so the AI can confirm its intent took
 * effect (vs. silently falling back to the workspace default).
 */
function computeOverriddenFields(payload: Record<string, unknown>): string[] {
  const fields = [
    'runtime',
    'providerId',
    'model',
    'permissionMode',
    'runtimeConfig',
  ];
  return fields.filter((f) => {
    const v = payload[f];
    return v !== undefined && v !== null && v !== '';
  });
}

/**
 * Look up the workspace's agent and return its effective runtime identity.
 * Managed Codex is stored in the builtin/provider shape, so model validation
 * must project that raw config to `codex/managed-provider` before choosing a
 * catalogue.
 *
 * Returns `undefined` when neither `workspacePath` nor `workspaceId` matches
 * an agent — forces the validator to reject rather than guess.
 */
function resolveAgentRuntimeIdentityFromWorkspace(payload: {
  workspacePath?: unknown;
  workspaceId?: unknown;
}): { runtime: RuntimeType; runtimeSource?: RuntimeSource } | undefined {
  const wsPath =
    typeof payload.workspacePath === 'string'
      ? payload.workspacePath
      : undefined;
  const wsId =
    typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined;
  if (!wsPath && !wsId) return undefined;

  const config = loadConfig();
  const agents = config.agents ?? [];
  const projects = loadProjects();
  const project =
    (wsPath
      ? projects.find((candidate) =>
          workspacePathsEqual(candidate.path, wsPath),
        )
      : undefined) ??
    (wsId ? projects.find((candidate) => candidate.id === wsId) : undefined);
  const agentId =
    project?.agentId ??
    (wsId && agents.some((candidate) => candidate.id === wsId)
      ? wsId
      : undefined);
  const agent = agentId
    ? agents.find((candidate) => candidate.id === agentId)
    : undefined;
  if (!agent) return undefined;

  const raw = agent.runtime as unknown;
  const runtime =
    typeof raw === 'string' && isValidRuntimeType(raw) ? raw : 'builtin';
  if (
    agentUsesManagedCodexProvider({
      providerId: agent.providerId,
      runtime,
      runtimeConfig: agent.runtimeConfig as { source?: string } | undefined,
    })
  ) {
    return { runtime: 'codex', runtimeSource: 'managed-provider' };
  }
  return runtime === 'codex'
    ? { runtime, runtimeSource: 'system-cli' }
    : { runtime };
}

function taskRuntimeConfigField(
  runtimeConfig: unknown,
  field: string,
): unknown {
  if (
    !runtimeConfig ||
    typeof runtimeConfig !== 'object' ||
    Array.isArray(runtimeConfig)
  ) {
    return undefined;
  }
  return (runtimeConfig as Record<string, unknown>)[field];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validate that an ID is safe for use as a filename (prevent path traversal) */
function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/** Reject dangerous property names to prevent prototype pollution */
function hasDangerousKeySegment(key: string): boolean {
  return key
    .split('.')
    .some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype');
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

type McpScope = 'global' | 'project' | 'both';

function parseMcpScope(scope: string | undefined): McpScope | null {
  if (scope === undefined || scope === '') return 'both';
  if (scope === 'global' || scope === 'project' || scope === 'both')
    return scope;
  return null;
}

/** Update Sidecar MCP state and notify frontend after config change.
 *  Respects project-scope: only servers enabled both globally AND in the
 *  current workspace project are pushed to the session. */
function mcpAlreadyExistsResponse(id: string): AdminResponse {
  return {
    success: false,
    error: `MCP server '${id}' already exists; mcp add only creates new servers`,
    recoveryHint: {
      recoveryCommand: `myagents mcp show ${id}`,
      message:
        'Inspect the existing definition. Remove it first if you intend to replace it.',
    },
  };
}

async function notifyMcpChange(action: string, id: string): Promise<void> {
  const workspacePath = getCurrentWorkspacePath();
  const config = loadConfig();
  const effectiveServers = resolveEffectiveMcpServersForWorkspace(
    config,
    workspacePath,
    'notifyMcpChange',
  );

  setMcpServers(effectiveServers);
  await notifyAppConfigChanged('mcp', action, id);
}

type ProjectMcpMutationResult =
  | { status: 'updated'; workspacePath: string }
  | { status: 'no-workspace' }
  | { status: 'project-not-found'; workspacePath: string };

function projectMcpMutationReason(result: ProjectMcpMutationResult): string {
  if (result.status === 'no-workspace')
    return 'current session has no workspace';
  if (result.status === 'project-not-found') {
    return `current workspace is not registered (${result.workspacePath})`;
  }
  return 'project updated';
}

function projectMcpMutationFailure(
  action: 'enable' | 'disable',
  id: string,
  result: ProjectMcpMutationResult,
): AdminResponse {
  return {
    success: false,
    error: `Cannot ${action} MCP server '${id}' for project scope: ${projectMcpMutationReason(result)}.`,
    recoveryHint: {
      recoveryCommand: `myagents mcp ${action} ${id} --scope global`,
      message:
        'Use global scope, or open/register the target workspace before changing project-scoped MCP settings.',
    },
  };
}

/** Enable MCP for the current workspace project */
async function enableMcpForCurrentProject(
  serverId: string,
): Promise<ProjectMcpMutationResult> {
  // The workspace path is set via process-global; use it to find the project
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) return { status: 'no-workspace' };

  let result: ProjectMcpMutationResult = {
    status: 'project-not-found',
    workspacePath,
  };
  await atomicModifyProjects((projects) => {
    const idx = projects.findIndex(
      (p) =>
        typeof p.path === 'string' &&
        workspacePathsEqual(p.path, workspacePath),
    );
    if (idx < 0) return projects;

    const project = projects[idx];
    const enabled = new Set(project.mcpEnabledServers ?? []);
    enabled.add(serverId);
    const next = [...projects];
    next[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };
    result = { status: 'updated', workspacePath };
    return next;
  });
  return result;
}

/** Disable MCP for the current workspace project */
async function disableMcpForCurrentProject(
  serverId: string,
): Promise<ProjectMcpMutationResult> {
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) return { status: 'no-workspace' };

  let result: ProjectMcpMutationResult = {
    status: 'project-not-found',
    workspacePath,
  };
  await atomicModifyProjects((projects) => {
    const idx = projects.findIndex(
      (p) =>
        typeof p.path === 'string' &&
        workspacePathsEqual(p.path, workspacePath),
    );
    if (idx < 0) return projects;

    const project = projects[idx];
    const enabled = new Set(project.mcpEnabledServers ?? []);
    enabled.delete(serverId);
    const next = [...projects];
    next[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };
    result = { status: 'updated', workspacePath };
    return next;
  });
  return result;
}

/** Get workspace path from agent-session (set during session init) */
function getCurrentWorkspacePath(): string | undefined {
  const state = getAgentState();
  return state.agentDir || undefined;
}

/** Modify an agent in config by ID */
async function modifyAgent(
  id: string,
  modifier: (agent: AgentConfigSlim) => AgentConfigSlim,
  action: string,
): Promise<AdminResponse> {
  // Pre-check existence (fast-fail before acquiring write)
  const config = loadConfig();
  if (!(config.agents ?? []).some((a) => a.id === id)) {
    return { success: false, error: `Agent '${id}' not found` };
  }

  // Find by ID inside the modifier to avoid TOCTOU stale-index bugs
  await atomicModifyConfig((c) => {
    const updated = [...(c.agents ?? [])];
    const freshIdx = updated.findIndex((a) => a.id === id);
    if (freshIdx < 0) return c; // agent disappeared between reads — no-op
    updated[freshIdx] = modifier(updated[freshIdx]);
    return { ...c, agents: updated };
  });

  broadcast('config:changed', { section: 'agent', action, id });
  return { success: true, data: { id } };
}

/**
 * Commit a typed Agent configuration intent across the authoritative Agent
 * record, the Launcher compatibility Project record, and any running Agent/IM
 * instance. The Project mirror remains optional because archived/legacy Agents
 * may not have one; the Agent record is always authoritative.
 */
type AgentConfigIntentResolution =
  | {
      ok: true;
      agent: AgentConfigSlim;
      projectPatch?: Record<string, unknown>;
      livePatch?: Record<string, unknown>;
    }
  | { ok: false; response: AdminResponse };

async function modifyAgentConfigIntent(
  id: string,
  resolveIntent: (
    agent: AgentConfigSlim,
    config: AdminAppConfig,
  ) => AgentConfigIntentResolution,
  action: string,
): Promise<AdminResponse> {
  let committedLivePatch: Record<string, unknown> | undefined;
  const commitResult = await withAgentConfigIntentLock(
    async (): Promise<AdminResponse | null> => {
      let previousAgent: AgentConfigSlim | undefined;
      let updatedAgent: AgentConfigSlim | undefined;
      let projectPatch: Record<string, unknown> | undefined;
      let rejected: AdminResponse | undefined;
      await atomicModifyConfig((current) => {
        const agents = [...(current.agents ?? [])];
        const index = agents.findIndex((agent) => agent.id === id);
        if (index < 0) return current;
        const resolution = resolveIntent(agents[index], current);
        if (!resolution.ok) {
          rejected = resolution.response;
          return current;
        }
        previousAgent = agents[index];
        updatedAgent = resolution.agent;
        projectPatch = resolution.projectPatch;
        committedLivePatch = resolution.livePatch;
        agents[index] = updatedAgent;
        return { ...current, agents };
      });

      if (rejected) return rejected;
      if (!previousAgent || !updatedAgent) {
        return { success: false, error: `Agent '${id}' not found` };
      }

      if (projectPatch) {
        try {
          await atomicModifyProjects((projects) => {
            const entry = findProjectForAgent(projects, updatedAgent!);
            if (!entry) return projects;
            const next = [...projects];
            next[entry.index] = { ...entry.project, ...projectPatch };
            return next;
          });
        } catch (error) {
          // The Agent record is authoritative, but this command promises a
          // composite Agent+Project intent. Roll back only if the current record
          // still equals our commit so an unrelated concurrent writer is never
          // clobbered. The outer cross-process lock prevents other CLI Sidecars
          // from reaching this branch concurrently.
          let rolledBack = false;
          try {
            await atomicModifyConfig((current) => {
              const agents = [...(current.agents ?? [])];
              const index = agents.findIndex((agent) => agent.id === id);
              if (
                index < 0 ||
                JSON.stringify(agents[index]) !== JSON.stringify(updatedAgent)
              ) {
                return current;
              }
              agents[index] = previousAgent!;
              rolledBack = true;
              return { ...current, agents };
            });
          } catch (rollbackError) {
            const rollbackReason =
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError);
            const reason =
              error instanceof Error ? error.message : String(error);
            return {
              success: false,
              error: `Project mirror save failed (${reason}) and Agent rollback also failed (${rollbackReason}). Retry the same command to reconcile from Agent authority.`,
            };
          }
          const reason = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            error: rolledBack
              ? `Agent configuration was not changed because its Project mirror could not be saved: ${reason}`
              : `Project mirror save failed after Agent configuration changed: ${reason}`,
          };
        }
      }

      return null;
    },
  );

  if (commitResult) return commitResult;

  if (committedLivePatch) {
    try {
      const response = await managementApi('/api/agent/reload-config', 'POST', {
        agentId: id,
        patch: committedLivePatch,
      });
      if (response.ok === false) {
        broadcast('config:changed', { section: 'agent', action, id });
        return {
          success: false,
          error: `Agent configuration was saved, but runtime or managed-task reconciliation failed: ${response.error ?? 'unknown error'}`,
          data: { id, configSaved: true },
        };
      }
    } catch (error) {
      broadcast('config:changed', { section: 'agent', action, id });
      return {
        success: false,
        error: `Agent configuration was saved, but runtime or managed-task reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        data: { id, configSaved: true },
      };
    }
  }

  broadcast('config:changed', { section: 'agent', action, id });
  return { success: true, data: { id } };
}

/** Keys and patterns that contain secrets and must be redacted in config get */
const SENSITIVE_KEY_PATTERNS = /apikey|api_key|secret|token|password/i;
const SENSITIVE_TOP_KEYS = new Set([
  'providerApiKeys',
  'mcpServerEnv',
  'cliToolEnv',
]);

/** Recursively redact sensitive values in config output */
function redactSensitiveValues(key: string, value: unknown): unknown {
  const rootKey = key.split('.')[0];

  // Top-level known sensitive maps
  if (
    SENSITIVE_TOP_KEYS.has(rootKey) &&
    typeof value === 'object' &&
    value !== null
  ) {
    return deepRedact(value);
  }

  // Any key path containing sensitive patterns
  if (SENSITIVE_KEY_PATTERNS.test(key) && typeof value === 'string') {
    return redactSecret(value);
  }

  // For arrays/objects that may contain sensitive nested fields (e.g., agents, imBotConfigs)
  if (typeof value === 'object' && value !== null) {
    return deepRedact(value);
  }

  return value;
}

/** Recursively walk an object and redact string values whose keys match sensitive patterns */
function deepRedact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map((item) => deepRedact(item));
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && SENSITIVE_KEY_PATTERNS.test(k)) {
        result[k] = redactSecret(v);
      } else if (typeof v === 'object' && v !== null) {
        result[k] = deepRedact(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }
  return obj;
}

/** Get nested value from object by dot-separated key */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object'
    )
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set nested value in object by dot-separated key */
function setNestedValue(
  obj: AdminAppConfig,
  key: string,
  value: unknown,
): AdminAppConfig {
  const parts = key.split('.');
  if (parts.length === 1) {
    return { ...obj, [key]: value };
  }
  const [first, ...rest] = parts;
  const child = (obj[first] ?? {}) as Record<string, unknown>;
  return {
    ...obj,
    [first]: setNestedValue(child as AdminAppConfig, rest.join('.'), value),
  };
}

// ---------------------------------------------------------------------------
// CLI tool registry (PRD 0.2.36 cli_first_tool_registry)
//
// `myagents tool …` + Settings 工具箱 both land here. Registry truth lives on
// disk (~/.myagents/tools/), per-tool env lives in config.cliToolEnv (same
// shape as mcpServerEnv). Prompt injection reads the registry independently
// (system-prompt-cli-tools.ts) — these handlers only mutate disk state, and
// changes take effect for other sessions at their next start / pre-warm.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

function requireCliToolRegistryEnabled(): AdminResponse | null {
  if (isCliToolRegistryEnabled()) return null;
  return {
    success: false,
    error:
      'CLI tool registry is disabled. Enable it in Settings → About & Feedback → Lab first.',
    recoveryHint: {
      message:
        '打开「设置 → 关于&反馈 → 实验室 → CLI 工具注册表」后再使用 myagents tool。',
    },
  };
}

/** Registry entry + derived display state (kind badge, unconfigured env keys) */
function enrichCliTool(entry: CliToolRegistryEntry, config?: AdminAppConfig) {
  const cfg = config ?? loadConfig();
  return {
    ...entry,
    kind: deriveCliToolKind(entry.envKeys),
    missingEnvKeys: findMissingEnvKeys(entry, cfg.cliToolEnv),
  };
}

export function handleToolList(): AdminResponse {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const registry = readCliToolsRegistry();
  const config = loadConfig();
  return {
    success: true,
    data: { tools: registry.tools.map((t) => enrichCliTool(t, config)) },
    hint:
      registry.tools.length === 0
        ? 'No CLI tools registered yet. Create one with the tool-creator skill, then `myagents tool add <dir>`.'
        : undefined,
  };
}

export function handleToolInfo(payload: { name?: string }): AdminResponse {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const { name } = payload;
  if (!name) return { success: false, error: 'Missing required field: name' };
  const entry = readCliToolsRegistry().tools.find((t) => t.name === name);
  if (!entry) {
    return {
      success: false,
      error: `CLI tool '${name}' is not registered`,
      recoveryHint: {
        recoveryCommand: 'myagents tool list',
        message: 'See registered tools.',
      },
    };
  }
  return { success: true, data: { tool: enrichCliTool(entry) } };
}

export async function handleToolAdd(payload: {
  dir?: string;
  dryRun?: boolean;
}): Promise<AdminResponse> {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const { dir, dryRun } = payload;
  if (!dir) {
    return {
      success: false,
      error:
        'Missing required field: dir (path to the tool directory containing tool.json)',
      recoveryHint: {
        recoveryCommand: 'myagents tool add ~/.myagents/tools/<name>',
        message:
          'The dir must contain tool.json + the entry script (see the tool-creator skill).',
      },
    };
  }
  const srcDir = resolve(dir);

  const read = readCliToolManifest(srcDir);
  if (!read.ok) {
    return {
      success: false,
      error: `[${read.code}] ${read.error}`,
      recoveryHint: read.recovery ? { message: read.recovery } : undefined,
    };
  }
  const manifest = read.manifest;
  try {
    assertCliToolTreeSelfContained(srcDir);
  } catch (e) {
    return {
      success: false,
      error: `[TOOL_DIR_NOT_SELF_CONTAINED] ${(e as Error).message}`,
      recoveryHint: {
        message:
          'Replace symlinks with real files inside the tool directory, then re-run tool add.',
      },
    };
  }
  const destDir = resolve(join(getCliToolsDir(), manifest.name));
  const needsCopy = srcDir !== destDir;
  const toolDir = needsCopy ? destDir : srcDir;
  const entryPath = join(toolDir, manifest.entry);

  // Re-add of an already-registered name from its canonical dir = REFRESH:
  // re-read manifest into the registry entry (description/version/envKeys/deps),
  // keep enabled + registeredAt + cliToolEnv, rewrite the shim. This is the
  // edit-then-re-add flow; without it the only path was remove→add, which by
  // design drops the tool's stored API keys.
  const existing = readCliToolsRegistry().tools.find(
    (t) => t.name === manifest.name,
  );
  if (existing) {
    if (srcDir !== destDir && srcDir !== resolve(existing.dir)) {
      return {
        success: false,
        error: `CLI tool '${manifest.name}' is already registered (dir: ${existing.dir})`,
        recoveryHint: {
          recoveryCommand: `myagents tool info ${manifest.name}`,
          message: `To update it, edit the tool at ${existing.dir} and re-run tool add there; to replace it, remove first (note: remove drops stored env keys).`,
        },
      };
    }
    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        preview: { name: manifest.name, action: 'refresh', dir: existing.dir },
      };
    }
    let refreshed: CliToolRegistryEntry | undefined;
    await modifyCliToolsRegistry((reg) => {
      const idx = reg.tools.findIndex((t) => t.name === manifest.name);
      if (idx === -1) return null;
      const tools = [...reg.tools];
      refreshed = {
        ...tools[idx],
        description: manifest.description,
        version: manifest.version,
        envKeys: manifest.envKeys,
        deps: manifest.deps,
        entryPath: join(tools[idx].dir, manifest.entry),
      };
      tools[idx] = refreshed;
      // 锁内重写 shim：与并发 remove 的 shim 删除在同一锁下互斥
      writeCliToolShim(manifest.name, refreshed.entryPath);
      return { ...reg, tools };
    });
    if (!refreshed) {
      return {
        success: false,
        error: `CLI tool '${manifest.name}' disappeared during refresh (concurrent remove?)`,
        recoveryHint: {
          recoveryCommand: 'myagents tool add ' + srcDir,
          message: 'Re-run to register it fresh.',
        },
      };
    }
    return {
      success: true,
      data: { tool: enrichCliTool(refreshed), refreshed: true },
      hint: 'Refreshed manifest data (description/version/envKeys) and rewrote the shim. Stored env keys and enabled state preserved.',
    };
  }

  // PATH shadow check: ~/.myagents/bin precedes system paths in agent sessions,
  // so a colliding name silently hijacks an existing command everywhere.
  // ensureShellPath(): the sidecar's own PATH is the launchd minimal set under
  // GUI launch — it misses /opt/homebrew/bin etc. and would let brew-installed
  // commands (ffmpeg/jq/gh) slip through the check.
  const collision = findPathCollision(manifest.name, await ensureShellPath());
  if (collision) {
    return {
      success: false,
      error: `[NAME_SHADOWS] Tool name '${manifest.name}' collides with an existing executable (${collision}); registering it would shadow that command in every agent session and terminal`,
      recoveryHint: {
        message:
          'Rename the tool with a domain prefix (update tool.json "name") and re-run tool add.',
      },
    };
  }

  if (needsCopy) {
    // lstat probe (not existsSync): a broken symlink at dest reads as "absent"
    // to existsSync and then crashes recursive copy (CLAUDE.md v0.2.5 red line).
    let destOccupied = false;
    try {
      lstatSync(destDir);
      destOccupied = true;
    } catch {
      destOccupied = false;
    }
    if (destOccupied) {
      return {
        success: false,
        error: `[DEST_OCCUPIED] ${destDir} already exists but '${manifest.name}' is not registered (leftover from a failed add?)`,
        recoveryHint: {
          message: `Inspect/remove ${destDir} manually, or register in place by running tool add on that directory.`,
        },
      };
    }
  }

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      preview: {
        name: manifest.name,
        dir: toolDir,
        wouldCopy: needsCopy,
        shim: join(
          getCliToolsBinDir(),
          process.platform === 'win32' ? `${manifest.name}.cmd` : manifest.name,
        ),
        envKeys: manifest.envKeys ?? [],
      },
    };
  }

  const entry: CliToolRegistryEntry = {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    envKeys: manifest.envKeys,
    deps: manifest.deps,
    dir: toolDir,
    entryPath,
    enabled: true,
    registeredAt: new Date().toISOString(),
  };

  let tempDir: string | null = null;
  if (needsCopy) {
    tempDir = join(
      getCliToolsDir(),
      `.import-${manifest.name}-${Date.now()}-${crypto.randomUUID()}`,
    );
    try {
      mkdirSync(getCliToolsDir(), { recursive: true });
      await fsCp(srcDir, tempDir, {
        recursive: true,
        dereference: false,
        force: false,
        errorOnExist: true,
      });
      // Second pass closes the TOCTOU window: if a symlink appeared while fs.cp
      // was walking the source, the staged payload is rejected before publish.
      assertCliToolTreeSelfContained(tempDir);
    } catch (e) {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      return {
        success: false,
        error: `[COPY_FAILED] Failed to stage tool dir for ${destDir}: ${(e as Error).message}`,
        recoveryHint: {
          message:
            'Check the source dir is readable and contains no symlinks, then re-run tool add.',
        },
      };
    }
  }

  // Publish only after the payload has been staged and re-validated. The
  // duplicate check, final rename, shim write, and registry write stay under the
  // same registry lock so concurrent adds cannot interleave into destDir.
  let duplicate = false;
  let renamedToDest = false;
  let publishError: Error | null = null;
  try {
    await modifyCliToolsRegistry((reg) => {
      if (reg.tools.some((t) => t.name === manifest.name)) {
        duplicate = true;
        return null;
      }
      try {
        if (needsCopy) {
          try {
            lstatSync(destDir);
            publishError = new Error(
              `${destDir} already exists but '${manifest.name}' is not registered`,
            );
            return null;
          } catch {
            // Absent is the expected publish path.
          }
          renameSync(tempDir!, destDir);
          renamedToDest = true;
          tempDir = null;
        }
        writeCliToolShim(manifest.name, entryPath);
        return { ...reg, tools: [...reg.tools, entry] };
      } catch (e) {
        publishError = e as Error;
        return null;
      }
    });
  } catch (e) {
    publishError = e as Error;
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  if (duplicate) {
    return {
      success: false,
      error: `CLI tool '${manifest.name}' is already registered`,
      recoveryHint: {
        recoveryCommand: `myagents tool info ${manifest.name}`,
        message: 'Remove it first if you want to re-register.',
      },
    };
  }
  if (publishError) {
    removeCliToolShim(manifest.name);
    if (renamedToDest) removeCliToolDir(manifest.name);
    return {
      success: false,
      error: publishError.message.startsWith('[')
        ? publishError.message
        : `[PUBLISH_FAILED] Failed to publish tool '${manifest.name}': ${publishError.message}`,
      recoveryHint: {
        message: 'Re-run tool add after inspecting the destination directory.',
      },
    };
  }

  const envHint =
    (manifest.envKeys ?? []).length > 0
      ? ` It declares env keys [${(manifest.envKeys ?? []).join(', ')}] — set them via \`myagents tool env ${manifest.name} set KEY=value\`.`
      : '';
  return {
    success: true,
    data: { tool: enrichCliTool(entry) },
    hint: `Registered. '${manifest.name}' is on PATH now; other sessions discover it on their next start.${envHint} Tell the user it is manageable under 设置 → 工具箱.`,
  };
}

export async function handleToolRemove(payload: {
  name?: string;
  purge?: boolean;
}): Promise<AdminResponse> {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const { name, purge } = payload;
  if (!name) return { success: false, error: 'Missing required field: name' };
  let removed: CliToolRegistryEntry | undefined;
  await modifyCliToolsRegistry((reg) => {
    removed = reg.tools.find((t) => t.name === name);
    if (!removed) return null;
    // shim 删除收进同一把锁：与并发 add/refresh 的 shim 写入互斥，
    // 防止 remove 误删一个刚被并发 add 重建的 shim
    removeCliToolShim(name);
    return { ...reg, tools: reg.tools.filter((t) => t.name !== name) };
  });
  if (!removed) {
    return {
      success: false,
      error: `CLI tool '${name}' is not registered`,
      recoveryHint: {
        recoveryCommand: 'myagents tool list',
        message: 'See registered tools.',
      },
    };
  }
  // Drop stored env values with the registration — no stale secrets in config.
  await atomicModifyConfig((c) => {
    if (!c.cliToolEnv?.[name]) return c;
    const cliToolEnv = { ...c.cliToolEnv };
    delete cliToolEnv[name];
    return { ...c, cliToolEnv };
  });
  // Containment guard: only delete dirs at the canonical registry location.
  // entry.dir is invariantly ~/.myagents/tools/<name> today, but a registry
  // file edited by hand could point anywhere — never rm outside our dir.
  const canonicalDir = resolve(join(getCliToolsDir(), name));
  const purgeable = resolve(removed.dir) === canonicalDir;
  if (purge && purgeable) {
    removeCliToolDir(name);
  }
  return {
    success: true,
    data: { name, purged: Boolean(purge && purgeable) },
    hint: purge
      ? purgeable
        ? undefined
        : `Tool dir ${removed.dir} is outside ~/.myagents/tools — not deleted; remove it manually if intended.`
      : `Tool dir kept at ${removed.dir} (pass --purge to delete it too).`,
  };
}

async function setToolEnabled(
  name: string | undefined,
  enabled: boolean,
): Promise<AdminResponse> {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  if (!name) return { success: false, error: 'Missing required field: name' };
  let found = false;
  await modifyCliToolsRegistry((reg) => {
    const idx = reg.tools.findIndex((t) => t.name === name);
    if (idx === -1) return null;
    found = true;
    if (reg.tools[idx].enabled === enabled) return null;
    const tools = [...reg.tools];
    tools[idx] = { ...tools[idx], enabled };
    return { ...reg, tools };
  });
  if (!found) {
    return {
      success: false,
      error: `CLI tool '${name}' is not registered`,
      recoveryHint: {
        recoveryCommand: 'myagents tool list',
        message: 'See registered tools.',
      },
    };
  }
  return {
    success: true,
    data: { name, enabled },
    hint: enabled
      ? "Tool will appear in new sessions' context. (It was on PATH the whole time.)"
      : "Tool hidden from new sessions' context; the shim stays on PATH for manual use.",
  };
}

export async function handleToolEnable(payload: {
  name?: string;
}): Promise<AdminResponse> {
  return setToolEnabled(payload.name, true);
}

export async function handleToolDisable(payload: {
  name?: string;
}): Promise<AdminResponse> {
  return setToolEnabled(payload.name, false);
}

/**
 * Run `<tool> readme` and return its stdout — feeds the Settings 工具箱 detail
 * view so humans read the exact doc the AI reads. Async execFile (never a sync
 * spawn: this runs on the sidecar event loop) with a hard timeout.
 */
export async function handleToolReadme(payload: {
  name?: string;
}): Promise<AdminResponse> {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const { name } = payload;
  if (!name) return { success: false, error: 'Missing required field: name' };
  const entry = readCliToolsRegistry().tools.find((t) => t.name === name);
  if (!entry) {
    return {
      success: false,
      error: `CLI tool '${name}' is not registered`,
      recoveryHint: {
        recoveryCommand: 'myagents tool list',
        message: 'See registered tools.',
      },
    };
  }
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [entry.entryPath, 'readme'],
      {
        timeout: 10_000,
        maxBuffer: 512 * 1024,
      },
    );
    return { success: true, data: { name, readme: stdout } };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return {
      success: false,
      error: `Failed to run '${name} readme': ${(err.stderr || err.message || 'unknown error').slice(0, 500)}`,
      recoveryHint: {
        message:
          'The tool may be broken — check its entry script, or remove and re-register it.',
      },
    };
  }
}

/** Same contract as handleMcpEnv, but against config.cliToolEnv. */
export async function handleToolEnv(payload: {
  name?: string;
  action?: 'set' | 'get' | 'delete';
  env?: Record<string, string>;
}): Promise<AdminResponse> {
  const gate = requireCliToolRegistryEnabled();
  if (gate) return gate;
  const { name, action, env } = payload;
  if (!name) return { success: false, error: 'Missing required field: name' };
  const entry = readCliToolsRegistry().tools.find((t) => t.name === name);
  if (!entry) {
    return {
      success: false,
      error: `CLI tool '${name}' is not registered`,
      recoveryHint: {
        recoveryCommand: 'myagents tool list',
        message: 'See registered tools.',
      },
    };
  }

  if (action === 'get' || action === undefined) {
    const config = loadConfig();
    const toolEnv = (config.cliToolEnv ?? {})[name] ?? {};
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(toolEnv)) {
      redacted[k] = redactSecret(v);
    }
    return {
      success: true,
      data: {
        name,
        env: redacted,
        declaredKeys: entry.envKeys ?? [],
        missingKeys: findMissingEnvKeys(entry, config.cliToolEnv),
      },
    };
  }

  if (action === 'set') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No environment variables provided' };
    }
    // The launcher merges these over process.env — overriding process-level
    // vars would confusingly break the tool's own subprocesses (PATH) or its
    // Node runtime (NODE_OPTIONS). No legitimate tool config needs them.
    const forbidden = Object.keys(env).filter((k) =>
      ['PATH', 'NODE_OPTIONS', 'HOME', 'USERPROFILE'].includes(k.toUpperCase()),
    );
    if (forbidden.length > 0) {
      return {
        success: false,
        error: `Refusing to set process-level variables for a tool: ${forbidden.join(', ')}`,
        recoveryHint: {
          message:
            'Tool env is for API keys and tool-specific config declared in tool.json envKeys.',
        },
      };
    }
    await atomicModifyConfig((c) => {
      const cliToolEnv = { ...(c.cliToolEnv || {}) };
      cliToolEnv[name] = { ...(cliToolEnv[name] || {}), ...env };
      return { ...c, cliToolEnv };
    });
    return {
      success: true,
      data: { name, keys: Object.keys(env) },
      hint: 'Environment variables updated. The tool reads them at launch — no re-registration needed.',
    };
  }

  if (action === 'delete') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No keys specified for deletion' };
    }
    await atomicModifyConfig((c) => {
      const cliToolEnv = { ...(c.cliToolEnv || {}) };
      if (cliToolEnv[name]) {
        const toolEnv = { ...cliToolEnv[name] };
        for (const key of Object.keys(env)) {
          delete toolEnv[key];
        }
        if (Object.keys(toolEnv).length === 0) {
          delete cliToolEnv[name];
        } else {
          cliToolEnv[name] = toolEnv;
        }
      }
      return { ...c, cliToolEnv };
    });
    return { success: true, data: { name, deletedKeys: Object.keys(env) } };
  }

  return {
    success: false,
    error: `Unknown action: ${String(action)}. Use 'set', 'get', or 'delete'.`,
  };
}
