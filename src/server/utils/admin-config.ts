/**
 * Sidecar-side config read/write for Admin API
 *
 * Equivalent to the frontend's appConfigService.ts, but using native fs
 * instead of Tauri plugin-fs. Both read/write the same ~/.myagents/config.json.
 * Atomicity is guaranteed by write-to-tmp → rename pattern.
 */

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  renameSync,
  readdirSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  lstatSync,
} from 'fs';
import { resolve } from 'path';
import { getHomeDirOrNull } from './platform';
import { stripBom } from '../../shared/utils';
import { resolveProviderForModel } from '../../shared/tokendance';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { promoteAgentMcpJsonToGlobal } from '../../shared/mcpConfig';
import type { AppConfig, ManagedProviderCredential, McpServerDefinition, PermissionMode, Provider, ProviderVerifyStatus, SubscriptionAuthPolicy } from '../../shared/config-types';
import {
  applyManagedCodexProviderReadiness,
  applyProviderEnablementAndOrder,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  completeModelAliases,
  getManagedCodexProviderReadiness,
  isProviderEnabled,
  mergePresetCustomModels,
  PRESET_MCP_SERVERS,
  PRESET_PROVIDERS,
  withManagedCodexProviderCatalog,
  XAI_SUBSCRIPTION_API_BASE_URL,
  XAI_SUBSCRIPTION_PROVIDER_ID,
} from '../../shared/config-types';
import {
  agentUsesManagedCodexProvider,
  isRuntimeBackedProvider,
  projectManagedCodexPermissionToRuntime,
} from '../../shared/providerExecution';
import type { AgentConfig, ChannelConfig } from '../../shared/types/agent';
import {
  IMAGE_UNDERSTANDING_TOOL_ID,
  SPEECH_RECOGNITION_TOOL_ID,
  getExplicitImageInputSupport,
  isImageUnderstandingToolConfigured,
  normalizeOfficialToolIds,
  type ImageUnderstandingCapabilityConfidence,
  type ImageUnderstandingCapabilitySource,
  type ImageUnderstandingModelOption,
  type OfficialToolId,
  type OfficialToolSettings,
} from '../../shared/official-tools';
import { applyMcpServerConfigAdditions } from '../../shared/mcpConfig';
import { isReservedBuiltinBrowserMcpId } from '../../shared/browserTools';
import {
  coerceModelForRuntime,
  getDefaultRuntimePermissionMode,
  normalizeRuntime,
  projectPermissionModeForRuntime,
  type RuntimeType,
} from '../../shared/types/runtime';
import type { SessionMetadata } from '../types/session';
import { coerceReasoningEffortSettingForRuntime } from '../../shared/reasoningEffort';
import { ensureDirSync } from './fs-utils';
import { withFileLock, FileBusyError } from './file-lock';
import {
  isConcreteProviderRoute,
  resolveExplicitProviderRoute,
  resolveLegacyModelOnlyProviderRoute,
  type ProviderRoute,
} from '../../shared/providerRoute';
import { resolveSessionConfig } from './resolve-session-config';
import { normalizeThemeConfigRecord } from '../../shared/theme';
import { buildAvailableProvidersJson } from '../../shared/availableProvidersProjection';
import { resolveAgentWorkspaceProjections } from '../../shared/agentWorkspaceIdentity';
import { lookupModelModalitySupport } from './model-capabilities';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getConfigDir(): string {
  const home = getHomeDirOrNull();
  if (!home) throw new Error('Cannot determine home directory');
  return resolve(home, '.myagents');
}

function getConfigPath(): string {
  return resolve(getConfigDir(), 'config.json');
}

function getProjectsPath(): string {
  return resolve(getConfigDir(), 'projects.json');
}

const CONFIG_LOCK_TIMEOUT_MS = 5000;
const CONFIG_LOCK_STALE_MS = 30000;

function isProductPermissionMode(value: unknown): value is PermissionMode {
  return value === 'auto' || value === 'plan' || value === 'fullAgency';
}

export class ConfigBusyError extends Error {
  readonly code = 'CONFIG_BUSY';

  constructor(message = 'Config busy: could not acquire config.json.lock within 5000ms; retry') {
    super(message);
    this.name = 'ConfigBusyError';
  }
}

export class ProjectsBusyError extends Error {
  readonly code = 'PROJECTS_BUSY';

  constructor(message = 'Projects busy: could not acquire projects.json.lock within 5000ms; retry') {
    super(message);
    this.name = 'ProjectsBusyError';
  }
}

export class AgentConfigIntentBusyError extends Error {
  readonly code = 'AGENT_CONFIG_INTENT_BUSY';

  constructor(message = 'Agent config intent busy: could not acquire agent-config-intent.lock within 5000ms; retry') {
    super(message);
    this.name = 'AgentConfigIntentBusyError';
  }
}

export class ProviderBusyError extends Error {
  readonly code = 'PROVIDER_BUSY';

  constructor(providerId: string) {
    super(`Provider '${providerId}' is busy; retry the operation.`);
    this.name = 'ProviderBusyError';
  }
}

// ---------------------------------------------------------------------------
// Minimal types (mirrors renderer/config/types.ts — only the fields we touch)
// ---------------------------------------------------------------------------

/** Lightweight AppConfig subset used by admin operations */
export interface AdminAppConfig {
  themeId?: string;
  themeSelectionExplicit?: boolean;
  appearanceMode?: 'system' | 'light' | 'dark';
  // MCP
  mcpServers?: McpServerDefinition[];
  mcpEnabledServers?: string[];
  mcpServerEnv?: Record<string, Record<string, string>>;
  mcpServerArgs?: Record<string, string[]>;
  // CLI tool registry (PRD 0.2.36): per-tool env (API keys etc.), same shape as
  // mcpServerEnv. Read at launch by the ~/.myagents/bin shims — env changes
  // need no shim rewrite.
  cliToolEnv?: Record<string, Record<string, string>>;
  // Experimental gate for user-registered CLI tools. Omitted means disabled.
  cliToolRegistryEnabled?: boolean;
  // MyAgents official CLI tools
  enabledOfficialToolIds?: OfficialToolId[];
  officialToolSettings?: OfficialToolSettings;
  // Provider
  defaultProviderId?: string;
  providerApiKeys?: Record<string, string>;
  providerVerifyStatus?: Record<string, ProviderVerifyStatus>;
  providerOrder?: string[];
  disabledProviderIds?: string[];
  // Agent
  agents?: AgentConfigSlim[];
  defaultPermissionMode?: string;
  claudeTranscriptCleanupPeriodDays?: number;
  // Allow passthrough of all other fields
  [key: string]: unknown;
}

/** Minimal Agent config shape for admin operations */
export interface AgentConfigSlim {
  id: string;
  name: string;
  enabled: boolean;
  heartbeat?: AgentConfig['heartbeat'];
  memoryAutoUpdate?: AgentConfig['memoryAutoUpdate'];
  memoryEvolution?: AgentConfig['memoryEvolution'];
  providerId?: string;
  model?: string;
  permissionMode?: string;
  channels?: ChannelConfigSlim[];
  /** PRD 0.2.17 — plugins this Agent enables (subset of globally-visible). */
  enabledPluginIds?: string[];
  enabledOfficialToolIds?: OfficialToolId[];
  [key: string]: unknown;
}

/** Minimal Channel config shape */
export interface ChannelConfigSlim {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  botToken?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  [key: string]: unknown;
}

/** Minimal Project shape */
export interface ProjectSlim {
  id: string;
  name: string;
  path: string;
  agentId?: string;
  archivedAt?: string;
  hidden?: boolean;
  internal?: boolean;
  displayName?: string;
  icon?: string;
  isAgent?: boolean;
  templateId?: string;
  templateSource?: 'builtin' | 'user';
  archivedAgentEnabledBeforeArchive?: boolean;
  pinnedAt?: string;
  mcpEnabledServers?: string[];
  enabledPluginIds?: string[];
  enabledOfficialToolIds?: OfficialToolId[];
  providerId?: string;
  model?: string;
  permissionMode?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------

export function loadConfig(): AdminAppConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return normalizeThemeConfigRecord({}) as unknown as AdminAppConfig;
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = normalizeThemeConfigRecord(
      JSON.parse(stripBom(raw)) as AdminAppConfig,
    ) as AdminAppConfig;
    // Keep Admin API/CLI reads aligned with renderer and Rust IM config
    // readers: legacy Agent-only HTTP/SSE definitions are part of the MCP
    // catalogue until the user explicitly removes or disables them.
    promoteAgentMcpJsonToGlobal(config);
    return config;
  } catch {
    // Malformed JSON — try .bak fallback
    const bakPath = configPath + '.bak';
    if (existsSync(bakPath)) {
      try {
        console.warn('[admin-config] config.json parse failed, falling back to .bak');
        const config = normalizeThemeConfigRecord(
          JSON.parse(stripBom(readFileSync(bakPath, 'utf-8'))) as AdminAppConfig,
        ) as AdminAppConfig;
        promoteAgentMcpJsonToGlobal(config);
        return config;
      } catch { /* bak also corrupt */ }
    }
    console.error('[admin-config] config.json and .bak both unreadable, returning empty config');
    return normalizeThemeConfigRecord({}) as unknown as AdminAppConfig;
  }
}

export function isCliToolRegistryEnabled(config: AdminAppConfig = loadConfig()): boolean {
  return config.cliToolRegistryEnabled === true;
}

/**
 * Cross-process serialized read-modify-write on config.json.
 * Pattern: lock → read fresh → modify → write .tmp → fsync → backup .bak → rename → fsync dir.
 *
 * Async because acquiring the cross-process lockdir polls with `await delay()` —
 * never a sync busy-wait or `Atomics.wait` (Pattern 5 §5.3.4.a).
 */
export async function withConfigLock(
  modifier: (config: AdminAppConfig) => AdminAppConfig | Promise<AdminAppConfig>
): Promise<AdminAppConfig> {
  const configPath = getConfigPath();
  const configDir = getConfigDir();

  // Ensure directory exists
  if (!existsSync(configDir)) {
    ensureDirSync(configDir);
  }

  try {
    return await withFileLock(
      {
        lockPath: configPath + '.lock',
        timeoutMs: CONFIG_LOCK_TIMEOUT_MS,
        staleMs: CONFIG_LOCK_STALE_MS,
      },
      async () => {
        const config = loadConfig();
        const before = JSON.stringify(config);
        const modified = normalizeThemeConfigRecord(
          await modifier(config),
        ) as AdminAppConfig;

        if (JSON.stringify(modified) === before) {
          return modified;
        }

        const tmpPath = configPath + '.tmp';
        const bakPath = configPath + '.bak';

        writeFileSynced(tmpPath, JSON.stringify(modified, null, 2));
        if (existsSync(configPath)) {
          try { copyFileSync(configPath, bakPath); } catch { /* best-effort backup */ }
        }
        renameSync(tmpPath, configPath);
        fsyncDir(configDir);

        return modified;
      }
    );
  } catch (err) {
    if (err instanceof FileBusyError) {
      throw new ConfigBusyError();
    }
    throw err;
  }
}

export async function atomicModifyConfig(
  modifier: (config: AdminAppConfig) => AdminAppConfig | Promise<AdminAppConfig>
): Promise<AdminAppConfig> {
  return withConfigLock(modifier);
}

/**
 * Serialize a composite Agent configuration intent across config.json and its
 * projects.json compatibility mirror. This lock is intentionally distinct
 * from either file lock: callers still take the normal per-file locks in a
 * fixed order while the outer intent lock prevents two Sidecars from
 * interleaving the two commits.
 */
export async function withAgentConfigIntentLock<T>(fn: () => Promise<T>): Promise<T> {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) ensureDirSync(configDir);
  try {
    return await withFileLock(
      {
        lockPath: resolve(configDir, 'agent-config-intent.lock'),
        timeoutMs: CONFIG_LOCK_TIMEOUT_MS,
        staleMs: CONFIG_LOCK_STALE_MS,
      },
      fn,
    );
  } catch (error) {
    if (error instanceof FileBusyError) throw new AgentConfigIntentBusyError();
    throw error;
  }
}

function writeFileSynced(path: string, content: string): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeFileSync(fd, content, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Projects read/write
// ---------------------------------------------------------------------------

export function loadProjects(): ProjectSlim[] {
  const path = getProjectsPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as ProjectSlim[];
  } catch {
    return [];
  }
}

export function saveProjects(projects: ProjectSlim[]): void {
  const path = getProjectsPath();
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(projects, null, 2), 'utf-8');
  // Pattern 5 fix #13: if rename fails (e.g. permission denied, target on a
  // different filesystem), the .tmp file used to persist forever. Wrap so a
  // failure cleans up the artifact before rethrowing.
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore — tmp may not exist */ }
    throw err;
  }
}

/**
 * Cross-process serialized read-modify-write on projects.json.
 * New Admin API mutations should use this helper instead of open-coded
 * loadProjects() + saveProjects(), because Settings, CLI, and background
 * owner code can all mutate workspace metadata.
 */
export async function atomicModifyProjects(
  modifier: (projects: ProjectSlim[]) => ProjectSlim[] | Promise<ProjectSlim[]>
): Promise<ProjectSlim[]> {
  const projectsPath = getProjectsPath();
  const configDir = getConfigDir();

  if (!existsSync(configDir)) {
    ensureDirSync(configDir);
  }

  try {
    return await withFileLock(
      {
        lockPath: projectsPath + '.lock',
        timeoutMs: CONFIG_LOCK_TIMEOUT_MS,
        staleMs: CONFIG_LOCK_STALE_MS,
      },
      async () => {
        const projects = loadProjects();
        const before = JSON.stringify(projects);
        const modified = await modifier(projects);

        if (JSON.stringify(modified) === before) {
          return modified;
        }

        const tmpPath = projectsPath + '.tmp';
        writeFileSynced(tmpPath, JSON.stringify(modified, null, 2));
        try {
          renameSync(tmpPath, projectsPath);
          fsyncDir(configDir);
        } catch (err) {
          try { unlinkSync(tmpPath); } catch { /* ignore — tmp may not exist */ }
          throw err;
        }
        return modified;
      }
    );
  } catch (err) {
    if (err instanceof FileBusyError) {
      throw new ProjectsBusyError();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MCP helpers (preset + custom merge, matching renderer/config/services/mcpService.ts)
// ---------------------------------------------------------------------------

/** Preset MCP servers (statically imported — see top of file) */
function getPresetMcpServers(): McpServerDefinition[] {
  // Filter out presets whose `platforms` field doesn't include the host —
  // keeps platform-specific presets (e.g. cuse on darwin/win32) invisible
  // everywhere on unsupported hosts (catalogue, validation, effective
  // MCP lists, `myagents mcp list`).
  return (PRESET_MCP_SERVERS as McpServerDefinition[]).filter(p =>
    !p.platforms || p.platforms.includes(process.platform)
  );
}

/**
 * Get all MCP servers (preset + custom), with user env/args overrides applied.
 * Mirrors getAllMcpServers() from mcpService.ts.
 */
export function getAllMcpServers(config?: AdminAppConfig): McpServerDefinition[] {
  const c = config ?? loadConfig();
  const presets = getPresetMcpServers();
  const custom = (c.mcpServers ?? []).filter(server => !isReservedBuiltinBrowserMcpId(server.id));

  // Custom servers can override ordinary presets, but not the two exact
  // product-owned Browser identities.
  const customIds = new Set(custom.map(s => s.id));
  const merged = [
    ...presets.filter(p => !customIds.has(p.id)),
    ...custom,
  ];

  return applyMcpServerConfigAdditions(merged, c);
}

/**
 * Get globally enabled MCP server IDs
 */
export function getEnabledMcpServerIds(config?: AdminAppConfig): string[] {
  const c = config ?? loadConfig();
  return c.mcpEnabledServers ?? [];
}

export function getGloballyEnabledOfficialToolIds(config?: AdminAppConfig): OfficialToolId[] {
  const c = config ?? loadConfig();
  return normalizeOfficialToolIds(c.enabledOfficialToolIds);
}

export function isImageUnderstandingGloballyConfigured(config?: AdminAppConfig): boolean {
  const c = config ?? loadConfig();
  return isImageUnderstandingToolConfigured(c.officialToolSettings);
}

export type ImageUnderstandingToolUnavailableReason =
  | 'not-configured'
  | 'provider-unavailable'
  | 'runtime-backed-provider'
  | 'model-not-image-capable'
  | 'missing-credential'
  | 'subscription-not-verified';

export type ImageUnderstandingToolAvailability =
  | {
      ok: true;
      providerId: string;
      model: string;
      provider: ProviderRecord;
      modelEntry: {
        model: string;
        inputModalities?: string[];
        capabilityConfidence: ImageUnderstandingCapabilityConfidence;
        capabilitySource?: ImageUnderstandingCapabilitySource;
      };
    }
  | {
      ok: false;
      reason: ImageUnderstandingToolUnavailableReason;
      status: number;
      message: string;
      recoveryMessage: string;
    };

function unavailableImageUnderstandingTool(
  reason: ImageUnderstandingToolUnavailableReason,
  message: string,
  recoveryMessage: string,
  status = 409,
): ImageUnderstandingToolAvailability {
  return { ok: false, reason, status, message, recoveryMessage };
}

function findProviderImageModel(
  provider: Record<string, unknown>,
  model: string,
): {
  model: string;
  modelName: string;
  inputModalities?: string[];
  capabilityConfidence: ImageUnderstandingCapabilityConfidence;
  capabilitySource?: ImageUnderstandingCapabilitySource;
} | null {
  const models = Array.isArray(provider.models) ? provider.models : [];
  for (const entry of models) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.model !== model) continue;
    const inputModalities = Array.isArray(record.inputModalities)
      ? record.inputModalities.filter((value): value is string => typeof value === 'string')
      : undefined;
    const explicitSupport = getExplicitImageInputSupport(record);
    if (explicitSupport === false) return null;
    const declaredSource = record.source === 'preset'
      || record.source === 'custom'
      || record.source === 'discovered'
      ? record.source
      : 'provider';
    const fallback = explicitSupport === undefined
      ? lookupModelModalitySupport(model, 'image')
      : undefined;
    const inferred = fallback?.status === 'supported' && fallback.source === 'litellm';
    return {
      model,
      modelName: typeof record.modelName === 'string' && record.modelName.trim()
        ? record.modelName
        : model,
      inputModalities,
      capabilityConfidence: explicitSupport === true
        ? 'declared'
        : inferred
          ? 'inferred'
          : 'unknown',
      capabilitySource: explicitSupport === true
        ? declaredSource
        : inferred
          ? 'litellm'
          : undefined,
    };
  }
  return null;
}

/**
 * Canonical image-helper picker data. The provider offering is authoritative:
 * explicit text-only rows are excluded, explicit image rows are declared,
 * and missing metadata remains selectable. LiteLLM can upgrade that unknown
 * state to a positive inference, but its negative/absent data never vetoes a
 * provider offering that the user may explicitly confirm.
 */
export function listImageUnderstandingModelOptions(
  config?: AdminAppConfig,
): ImageUnderstandingModelOption[] {
  const c = config ?? loadConfig();
  const options: ImageUnderstandingModelOption[] = [];
  const seen = new Set<string>();
  for (const provider of getAllEffectiveProviders(c)) {
    if (isRuntimeBackedProvider(provider) || getProviderSelectionError(provider, c) !== null) continue;
    const providerName = typeof provider.name === 'string' && provider.name.trim()
      ? provider.name
      : provider.id;
    const models = Array.isArray(provider.models) ? provider.models : [];
    for (const entry of models) {
      if (!entry || typeof entry !== 'object') continue;
      const modelId = (entry as Record<string, unknown>).model;
      if (typeof modelId !== 'string' || !modelId.trim()) continue;
      const resolved = findProviderImageModel(provider, modelId);
      if (!resolved) continue;
      const key = `${provider.id}\u0000${modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        providerId: provider.id,
        providerName,
        model: modelId,
        modelName: resolved.modelName,
        capabilityConfidence: resolved.capabilityConfidence,
        capabilitySource: resolved.capabilitySource,
      });
    }
  }
  return options;
}

export function resolveImageUnderstandingToolAvailability(
  config?: AdminAppConfig,
): ImageUnderstandingToolAvailability {
  const c = config ?? loadConfig();
  const settings = c.officialToolSettings?.imageUnderstanding;
  const providerId = settings?.providerId?.trim();
  const model = settings?.model?.trim();
  if (!providerId || !model) {
    return unavailableImageUnderstandingTool(
      'not-configured',
      'Image understanding model is not configured.',
      'Open Settings -> Toolbox -> Image Understanding and select an image-capable model.',
    );
  }

  const provider = findEffectiveProvider(providerId, c);
  if (!provider || !isProviderEnabled(provider)) {
    return unavailableImageUnderstandingTool(
      'provider-unavailable',
      `Configured vision provider '${providerId}' is unavailable.`,
      'Open Settings -> Model Providers and re-enable or reconfigure the selected provider.',
    );
  }
  if (isRuntimeBackedProvider(provider)) {
    return unavailableImageUnderstandingTool(
      'runtime-backed-provider',
      `Provider '${providerId}' is runtime-backed and cannot drive the vision helper.`,
      'Choose an API-backed provider/model for Image Understanding.',
    );
  }

  const modelEntry = findProviderImageModel(provider, model);
  if (!modelEntry) {
    return unavailableImageUnderstandingTool(
      'model-not-image-capable',
      `Model '${model}' is missing or explicitly registered as text-only for provider '${providerId}'.`,
      'Open Model Providers and select a model that accepts image input.',
    );
  }

  if (provider.type === 'subscription') {
    const verifyStatus = c.providerVerifyStatus?.[providerId];
    if (verifyStatus?.status !== 'valid') {
      return unavailableImageUnderstandingTool(
        'subscription-not-verified',
        `Subscription provider '${providerId}' is not verified.`,
        'Open Settings -> Model Providers and verify the selected subscription provider.',
      );
    }
  } else if (!resolveProviderEnv(providerId, c)) {
    return unavailableImageUnderstandingTool(
      'missing-credential',
      `Provider '${providerId}' needs a valid API key before it can drive image understanding.`,
      'Open Settings -> Model Providers and configure or verify the provider API key.',
    );
  }

  return { ok: true, providerId, model, provider, modelEntry };
}

export function isImageUnderstandingToolCallable(config?: AdminAppConfig): boolean {
  return resolveImageUnderstandingToolAvailability(config).ok;
}

function configuredOfficialToolSet(config: AdminAppConfig): Set<OfficialToolId> {
  // Speech resource readiness is a runtime capability fact, not an
  // authorization/configuration fact. Keep an authorized speech ID in the
  // Session snapshot so the Admin boundary can return a precise
  // SPEECH_RESOURCE_REQUIRED error when the local model pack is absent.
  const configured = new Set<OfficialToolId>([SPEECH_RECOGNITION_TOOL_ID]);
  if (isImageUnderstandingToolCallable(config)) {
    configured.add(IMAGE_UNDERSTANDING_TOOL_ID);
  }
  return configured;
}

function filterEffectiveOfficialToolIds(
  config: AdminAppConfig,
  requested: unknown,
): OfficialToolId[] {
  const globalEnabled = new Set(getGloballyEnabledOfficialToolIds(config));
  const configured = configuredOfficialToolSet(config);
  return normalizeOfficialToolIds(requested).filter(
    id => globalEnabled.has(id) && configured.has(id),
  );
}

export function getDefaultEnabledOfficialToolIdsForWorkspace(
  agentDir: string | undefined | null,
  config?: AdminAppConfig,
): OfficialToolId[] {
  if (!agentDir) return [];
  const c = config ?? loadConfig();
  const projects = loadProjects();
  const matchingProjects = projects.filter(p =>
    typeof p.path === 'string' && workspacePathsEqual(p.path, agentDir)
  );
  const project = matchingProjects.length === 1 ? matchingProjects[0] : undefined;
  const agent = findRuntimeAgentForWorkspace(c, projects, agentDir);
  return filterEffectiveOfficialToolIds(
    c,
    agent?.enabledOfficialToolIds ?? project?.enabledOfficialToolIds,
  );
}

export function getEffectiveOfficialToolIdsForSession(
  agentDir: string | undefined | null,
  sessionMeta?: SessionMetadata | null,
  overrideIds?: readonly OfficialToolId[] | null,
  config?: AdminAppConfig,
): OfficialToolId[] {
  const c = config ?? loadConfig();
  if (overrideIds !== null && overrideIds !== undefined) {
    return filterEffectiveOfficialToolIds(c, overrideIds);
  }
  if (sessionMeta?.configSnapshotAt) {
    return filterEffectiveOfficialToolIds(c, sessionMeta.enabledOfficialToolIds);
  }
  if (sessionMeta?.enabledOfficialToolIds !== undefined) {
    return filterEffectiveOfficialToolIds(c, sessionMeta.enabledOfficialToolIds);
  }
  return getDefaultEnabledOfficialToolIdsForWorkspace(agentDir, c);
}

/**
 * Get effective MCP servers for a specific project (global enabled ∩ project enabled)
 */
export function getEffectiveMcpServers(projectPath: string): McpServerDefinition[] {
  if (!projectPath) return [];

  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  // Find project by path
  const projects = loadProjects();
  const project = projects.find(p => typeof p.path === 'string' && workspacePathsEqual(p.path, projectPath));
  const projectEnabled = new Set(project?.mcpEnabledServers ?? []);

  if (projectEnabled.size === 0) return [];

  return allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

/** Redact sensitive values for display (show first 4 + last 4 chars) */
export function redactSecret(value: string): string {
  if (value.length <= 10) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/** Path to custom provider files directory */
export function getProvidersDir(): string {
  const home = getHomeDirOrNull();
  if (!home) throw new Error('Cannot determine home directory');
  return resolve(home, '.myagents', 'providers');
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function writeProviderFileUnlocked(
  filePath: string,
  dir: string,
  contents: string,
): void {
  const tmpPath = filePath + '.tmp';
  const bakPath = filePath + '.bak';
  try {
    writeFileSynced(tmpPath, contents);
    const metadata = lstatIfPresent(filePath);
    if (metadata) {
      if (metadata.isDirectory()) {
        throw new Error(`Provider path is a directory: ${filePath}`);
      }
      if (metadata.isSymbolicLink()) {
        unlinkSync(filePath);
      } else {
        try { copyFileSync(filePath, bakPath); } catch { /* best-effort backup */ }
      }
    }
    renameSync(tmpPath, filePath);
    fsyncDir(dir);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
    throw error;
  }
}

function deleteProviderFileUnlocked(filePath: string, dir: string): boolean {
  const metadata = lstatIfPresent(filePath);
  if (!metadata) return false;
  if (metadata.isDirectory()) {
    throw new Error(`Provider path is a directory: ${filePath}`);
  }
  unlinkSync(filePath);
  fsyncDir(dir);
  return true;
}

async function withProviderFileLock<T>(
  providerId: string,
  operation: (filePath: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = getProvidersDir();
  ensureDirSync(dir);
  const filePath = resolve(dir, `${providerId}.json`);
  try {
    return await withFileLock(
      {
        lockPath: filePath + '.lock',
        timeoutMs: CONFIG_LOCK_TIMEOUT_MS,
        staleMs: CONFIG_LOCK_STALE_MS,
      },
      () => operation(filePath, dir),
    );
  } catch (error) {
    if (error instanceof FileBusyError) throw new ProviderBusyError(providerId);
    throw error;
  }
}

/**
 * Atomically replace one custom provider file under the same cross-process
 * lock protocol used by renderer config writes.
 */
export async function saveCustomProviderFile(provider: Record<string, unknown> & { id: string }): Promise<void> {
  await withProviderFileLock(provider.id, async (filePath, dir) => {
    writeProviderFileUnlocked(filePath, dir, JSON.stringify(provider, null, 2));
  });
}

/** Delete one custom provider file while holding its cross-process lock. */
export async function deleteCustomProviderFile(providerId: string): Promise<boolean> {
  return withProviderFileLock(providerId, async (filePath, dir) => (
    deleteProviderFileUnlocked(filePath, dir)
  ));
}

/** Find a provider by ID: checks PRESET_PROVIDERS first, then custom files in ~/.myagents/providers/ */
export function findProvider(id: string): Record<string, unknown> | null {
  // Check presets first (statically imported — see top of file).
  // Cast via `unknown` because Provider lacks a string index signature.
  const preset = (PRESET_PROVIDERS as unknown as Array<Record<string, unknown>>)?.find(
    (p: Record<string, unknown>) => p.id === id
  );
  if (preset) return preset;

  // Check custom providers
  try {
    const dir = getProvidersDir();
    const filePath = resolve(dir, `${id}.json`);
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    }
  } catch { /* ignore */ }
  return null;
}

/** Load all custom provider files from ~/.myagents/providers/ */
export function loadCustomProviderFiles(): Array<Record<string, unknown>> {
  try {
    const dir = getProvidersDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(readFileSync(resolve(dir, f), 'utf-8')) as Record<string, unknown>;
        } catch { return null; }
      })
      .filter((p): p is Record<string, unknown> => p !== null && !!p.id);
  } catch { return []; }
}

export type ProviderRecord = Record<string, unknown> & { id: string; enabled?: unknown };

function hasProviderId(provider: Record<string, unknown>): provider is ProviderRecord {
  return typeof provider.id === 'string' && provider.id.length > 0;
}

export function getAllEffectiveProviders(config?: AdminAppConfig): ProviderRecord[] {
  const c = config ?? loadConfig();
  const presetProviders = ((PRESET_PROVIDERS ?? []) as unknown as Array<Record<string, unknown>>)
    .filter(hasProviderId);
  const customProviders = loadCustomProviderFiles().filter(hasProviderId);
  // Managed Codex is intentionally not a PRESET_PROVIDERS entry: the product
  // catalog injects it only when its developer gate is enabled. Admin/CLI must
  // consume that same catalog instead of maintaining a second provider list,
  // otherwise a valid `agent set ... providerId codex-sub` is rejected while
  // the in-app picker accepts it.
  const providerConfig = c as unknown as AppConfig;
  const providersWithManagedCodex = withManagedCodexProviderCatalog(
    [...presetProviders, ...customProviders] as unknown as Provider[],
    providerConfig,
  );
  const providersWithUserModels = mergePresetCustomModels(
    providersWithManagedCodex,
    providerConfig.presetCustomModels,
    providerConfig.presetRemovedModels,
  );
  return applyManagedCodexProviderReadiness(
    applyProviderEnablementAndOrder(providersWithUserModels, providerConfig),
    providerConfig,
  ) as unknown as ProviderRecord[];
}

export function getProviderSelectionError(
  provider: ProviderRecord,
  config?: AdminAppConfig,
): string | null {
  const c = config ?? loadConfig();
  if (!isProviderEnabled(provider)) {
    return `Provider '${provider.id}' is disabled.`;
  }
  if (isRuntimeBackedProvider(provider)) {
    const readiness = getManagedCodexProviderReadiness(c);
    return readiness.selectable
      ? null
      : `Managed Codex provider is not ready (${readiness.reason}). Complete runtime installation and sign-in before selecting it.`;
  }
  if (provider.type === 'subscription') {
    return c.providerVerifyStatus?.[provider.id]?.status === 'valid'
      ? null
      : `Subscription provider '${provider.id}' is not verified. Verify its account before selecting it.`;
  }
  return resolveProviderEnv(provider.id, c)
    ? null
    : `Provider '${provider.id}' has no usable credential. Configure its API key before selecting it.`;
}

/**
 * Rebuild the Rust IM provider projection from the same effective provider
 * catalogue and readiness rules used by the Admin API. The projection remains
 * a derived cache; config/provider files are the authorities.
 */
export function withAvailableProvidersProjection(config: AdminAppConfig): AdminAppConfig {
  const apiKeys = config.providerApiKeys ?? {};
  const availableProvidersJson = buildAvailableProvidersJson({
    providers: getAllEffectiveProviders(config) as unknown as Provider[],
    apiKeys,
    verifyStatus: config.providerVerifyStatus ?? {},
    primaryModels: config.providerPrimaryModels as Record<string, string> | undefined,
  });

  return {
    ...config,
    availableProvidersJson,
  };
}

export function findEffectiveProvider(id: string, config?: AdminAppConfig): ProviderRecord | null {
  if (!id) return null;
  return getAllEffectiveProviders(config).find(provider => provider.id === id) ?? null;
}

export function isProviderDisabled(providerId: string, config?: AdminAppConfig): boolean {
  const provider = findEffectiveProvider(providerId, config);
  return !!provider && !isProviderEnabled(provider);
}

function providersForRouteResolution(config: AdminAppConfig): Array<{
  id: string;
  type: 'api' | 'subscription';
  enabled?: boolean;
  models: Array<{ model: string; modelName: string; modelSeries: string }>;
}> {
  return getAllEffectiveProviders(config).map(provider => {
    const models = Array.isArray(provider.models) ? provider.models : [];
    return {
      id: provider.id,
      type: provider.type === 'subscription' ? 'subscription' : 'api',
      enabled: provider.enabled === false ? false : true,
      models: models
        .map(model => {
          if (!model || typeof model !== 'object') return undefined;
          const value = (model as Record<string, unknown>).model;
          if (typeof value !== 'string' || !value.trim()) return undefined;
          return { model: value, modelName: value, modelSeries: value };
        })
        .filter((model): model is { model: string; modelName: string; modelSeries: string } => Boolean(model)),
    };
  });
}

// ---------------------------------------------------------------------------
// Provider resolution (Sidecar self-resolve — eliminates dependency on providerEnvJson snapshots)
// ---------------------------------------------------------------------------

/** Provider environment for SDK subprocess (structural match with ProviderEnv in agent-session.ts) */
export interface ResolvedProviderEnv {
  /** Provider registry id. Metadata only: not forwarded as an SDK env var. */
  providerId?: string;
  /** Provider display name. Analytics metadata only: not forwarded as an SDK env var. */
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
  apiProtocol?: 'anthropic' | 'openai';
  maxOutputTokens?: number;
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  upstreamFormat?: 'chat_completions' | 'responses';
  modelAliases?: { fable?: string; sonnet?: string; opus?: string; haiku?: string };
  credentialSource?: ManagedProviderCredential;
}

export function resolveSubscriptionAuthKind(
  providerId: string,
  config?: AdminAppConfig,
): SubscriptionAuthPolicy['kind'] | undefined {
  const provider = findEffectiveProvider(providerId, config ?? loadConfig());
  const auth = provider?.subscriptionAuth as SubscriptionAuthPolicy | undefined;
  return provider?.type === 'subscription' ? auth?.kind : undefined;
}

/**
 * Resolve provider environment from providerId by looking up the real provider definition
 * (preset or custom) and API key from config. Handles ALL providers including custom ones.
 *
 * Returns undefined for subscription providers or if provider/key not found.
 */
export function resolveProviderEnv(
  providerId: string,
  config?: AdminAppConfig,
  model?: string,
): ResolvedProviderEnv | undefined {
  if (!providerId) return undefined;

  const c = config ?? loadConfig();
  const registeredProvider = findEffectiveProvider(providerId, c);
  if (!registeredProvider) return undefined;
  // Some callers only check credentials/enablement. Execution callers must
  // pass the concrete route model; availability must not depend on a preset
  // primary model the user may have removed.
  const provider = model
    ? resolveProviderForModel(registeredProvider as unknown as Provider, model)
    : registeredProvider;
  if (!isProviderEnabled(provider)) return undefined;

  // Anthropic subscription remains SDK-native. Grok subscription is builtin
  // too, but its OAuth grant is owned by Rust and referenced here without a
  // bearer so the Bridge can resolve it per request.
  const subscriptionAuth = provider.subscriptionAuth as SubscriptionAuthPolicy | undefined;
  const subscriptionAuthKind = provider.type === 'subscription'
    ? subscriptionAuth?.kind
    : undefined;
  const isManagedOauth = subscriptionAuthKind === 'host-managed-oauth';
  if (provider.type === 'subscription' && !isManagedOauth) return undefined;
  if (isManagedOauth && providerId !== XAI_SUBSCRIPTION_PROVIDER_ID) return undefined;

  // Get API key from config. PRD 0.2.9 — also reject whitespace-only keys
  // (Codex review): a value like `"  "` is truthy and would silently be
  // sent to the upstream as the Authorization header, producing an opaque
  // 401 instead of an actionable "no API key" error.
  const apiKey = isManagedOauth ? undefined : (c.providerApiKeys ?? {})[providerId];
  if (!isManagedOauth && (!apiKey || !apiKey.trim())) return undefined;

  // Extract provider config fields (same shape as frontend Chat.tsx builds)
  const providerConfig = (provider.config ?? {}) as Record<string, unknown>;
  const result: ResolvedProviderEnv = {
    providerId,
    providerName: typeof provider.name === 'string' ? provider.name : providerId,
    baseUrl: providerConfig.baseUrl ? String(providerConfig.baseUrl) : undefined,
    ...(apiKey ? { apiKey } : {}),
    authType: (provider.authType as ResolvedProviderEnv['authType']) ?? 'both',
    ...(isManagedOauth
      ? { credentialSource: { kind: 'managed-oauth', providerId: XAI_SUBSCRIPTION_PROVIDER_ID } as const }
      : {}),
  };
  if (provider.apiProtocol) result.apiProtocol = provider.apiProtocol as ResolvedProviderEnv['apiProtocol'];
  if (provider.maxOutputTokens) result.maxOutputTokens = Number(provider.maxOutputTokens);
  if (provider.maxOutputTokensParamName) result.maxOutputTokensParamName = provider.maxOutputTokensParamName as ResolvedProviderEnv['maxOutputTokensParamName'];
  if (provider.upstreamFormat) result.upstreamFormat = provider.upstreamFormat as ResolvedProviderEnv['upstreamFormat'];

  // Model aliases: merge preset defaults with user overrides (from config.providerModelAliases)
  const presetAliases = (provider as Record<string, unknown>).modelAliases as Record<string, string> | undefined;
  const aliasOverrides = c.providerModelAliases as Record<string, Record<string, string>> | undefined;
  const userOverrides = aliasOverrides?.[providerId];
  const mergedAliases = presetAliases || userOverrides
    ? { ...presetAliases, ...userOverrides }
    : undefined;
  const completedAliases = completeModelAliases(mergedAliases);
  if (completedAliases) {
    result.modelAliases = completedAliases;
  } else {
    // Fallback: no aliases configured — use provider's primaryModel or first model
    // so sub-agents don't send raw claude-* model names to third-party APIs.
    const primaryModel = (provider as Record<string, unknown>).primaryModel as string | undefined;
    const models = (provider as Record<string, unknown>).models as Array<{ model: string }> | undefined;
    const fallback = primaryModel || models?.[0]?.model;
    result.modelAliases = completeModelAliases(undefined, fallback);
  }

  return result;
}

export function materializeProviderRouteEnv(
  route: ProviderRoute | null | undefined,
  config?: AdminAppConfig,
): ResolvedProviderEnv | undefined {
  if (!isConcreteProviderRoute(route)) return undefined;
  if (route.kind === 'subscription'
      && resolveSubscriptionAuthKind(route.providerId, config) !== 'host-managed-oauth') return undefined;
  return resolveProviderEnv(route.providerId, config, route.model);
}

/** Managed OAuth owns both the bearer and its destination. */
export function canonicalizeManagedProviderEnv(
  providerEnv: ResolvedProviderEnv,
): ResolvedProviderEnv {
  const source = providerEnv.credentialSource;
  if (!source) return providerEnv;
  if (source.kind !== 'managed-oauth'
      || source.providerId !== XAI_SUBSCRIPTION_PROVIDER_ID
      || providerEnv.providerId !== XAI_SUBSCRIPTION_PROVIDER_ID) {
    throw new Error('Unsupported managed OAuth provider identity');
  }
  return {
    providerId: XAI_SUBSCRIPTION_PROVIDER_ID,
    providerName: providerEnv.providerName,
    baseUrl: XAI_SUBSCRIPTION_API_BASE_URL,
    authType: 'both',
    apiProtocol: 'openai',
    upstreamFormat: 'responses',
    modelAliases: providerEnv.modelAliases,
    credentialSource: {
      kind: 'managed-oauth',
      providerId: XAI_SUBSCRIPTION_PROVIDER_ID,
    },
  };
}

function resolveOwnedBuiltinProviderRoute(args: {
  sessionMeta?: SessionMetadata | null;
  config: AdminAppConfig;
}): ProviderRoute | undefined {
  const { sessionMeta, config } = args;
  if (!sessionMeta) return undefined;
  if (isConcreteProviderRoute(sessionMeta.providerRoute)) {
    return sessionMeta.providerRoute;
  }
  const providers = providersForRouteResolution(config);
  if (sessionMeta.providerId) {
    return resolveExplicitProviderRoute({
      providerId: sessionMeta.providerId,
      model: sessionMeta.model,
      providers,
    });
  }
  if (sessionMeta.configSnapshotAt) {
    return resolveLegacyModelOnlyProviderRoute({
      model: sessionMeta.model,
      providers,
      credentials: {
        apiKeys: config.providerApiKeys,
        verifyStatus: config.providerVerifyStatus,
      },
    });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Workspace config resolution (Sidecar self-resolve at startup)
// ---------------------------------------------------------------------------

/**
 * Find the exact Agent selected by the Project whose path matches `agentDir`.
 * Used by session-snapshot helpers to capture the AgentConfig at session creation time (v0.1.69).
 *
 * Returns the raw on-disk shape — callers cast to AgentConfig at use sites (the session snapshot
 * helpers only read `runtime`/`providerId`/`providerEnvJson`/`model`/`permissionMode`/
 * `mcpEnabledServers`, all of which are documented optional/required on AgentConfig).
 */
function findRuntimeAgentForWorkspace(
  config: AdminAppConfig,
  projects: ProjectSlim[],
  agentDir: string,
): AgentConfigSlim | undefined {
  const matchingProjects = projects.filter(project => workspacePathsEqual(project.path, agentDir));
  if (matchingProjects.length === 1) {
    const project = matchingProjects[0];
    if (project.agentId) {
      return (config.agents ?? []).find(agent => agent.id === project.agentId);
    }
    return resolveAgentWorkspaceProjections(projects, config.agents ?? []).agentProjections
      .find(projection => projection.projectId === project.id)?.agent;
  }
  if (matchingProjects.length > 1) return undefined;
  return resolveAgentWorkspaceProjections(projects, config.agents ?? []).agentProjections
    .find(projection => projection.association === 'legacy-orphan'
      && workspacePathsEqual(projection.workspacePath, agentDir))?.agent;
}

/**
 * Select runtime config for a workspace. Project-backed paths are exact-ID
 * only; the legacy path adapter is consulted solely for an unlinked Project
 * or a true orphan that has no Project backing.
 */
export function findProjectAgentByWorkspacePath(agentDir: string): AgentConfigSlim | undefined {
  return findRuntimeAgentForWorkspace(loadConfig(), loadProjects(), agentDir);
}

export type ImProviderRoutingResult =
  | {
      kind: 'provider-route';
      providerRoute: ProviderRoute;
      providerId: string;
      model: string;
      providerEnv: ResolvedProviderEnv | undefined;
    }
  | {
      kind: 'external-runtime';
      runtime: RuntimeType;
      runtimeSource?: string;
      model?: string;
      providerId?: string;
      reason: 'runtime-not-builtin' | 'managed-codex-provider';
    }
  | {
      kind: 'legacy-fallback';
      reason: 'agent-not-found' | 'provider-id-missing';
    }
  | {
      kind: 'error';
      status: 409;
      reason:
        | 'managed-codex-provider-not-ready'
        | 'provider-route-unresolved'
        | 'provider-env-unavailable';
      message: string;
      providerId?: string;
      model?: string;
      providerRoute?: ProviderRoute;
    };

function findImAgentAndChannel(
  config: AdminAppConfig,
  agentDir: string,
  channelId: string | undefined,
): { agent?: AgentConfigSlim; channel?: ChannelConfigSlim } {
  const agent = findRuntimeAgentForWorkspace(config, loadProjects(), agentDir);
  if (!agent) return {};
  const channel = channelId
    ? ((agent.channels ?? []) as ChannelConfigSlim[]).find(ch => ch.id === channelId)
    : undefined;
  return { agent, channel };
}

function channelLevelProviderId(channel: ChannelConfigSlim | undefined): string | undefined {
  if (!channel) return undefined;
  const overrides = (channel.overrides as Record<string, unknown> | undefined) ?? undefined;
  const overrideProviderId = overrides?.providerId;
  if (typeof overrideProviderId === 'string' && overrideProviderId.trim()) {
    return overrideProviderId;
  }
  const legacyProviderId = (channel as Record<string, unknown>).providerId;
  if (typeof legacyProviderId === 'string' && legacyProviderId.trim()) {
    return legacyProviderId;
  }
  return undefined;
}

function channelForSessionConfig(channel: ChannelConfigSlim | undefined): ChannelConfig | undefined {
  if (!channel) return undefined;
  const providerId = channelLevelProviderId(channel);
  if (!providerId) return channel as unknown as ChannelConfig;
  const overrides = (channel.overrides as Record<string, unknown> | undefined) ?? {};
  return {
    ...channel,
    overrides: {
      ...overrides,
      providerId,
    },
  } as unknown as ChannelConfig;
}

function providerRouteFailureMessage(
  route: ProviderRoute,
  providerId: string | undefined,
  model: string | undefined,
): string {
  if (route.kind !== 'unknown-legacy') {
    return `Provider route for ${providerId ?? '<missing>'}/${model ?? '<missing>'} is not concrete.`;
  }
  return `Provider route for ${providerId ?? '<missing>'}/${model ?? '<missing>'} is unresolved: ${route.reason}.`;
}

/**
 * Resolve the canonical ProviderRoute for a pure IM enqueue from disk.
 *
 * Route identity is validated against the live provider catalogue before a
 * message is accepted. External runtime / managed Codex provider configs are
 * reported as not applicable instead of being coerced into builtin provider env.
 */
export function resolveImProviderRouting(
  agentDir: string,
  channelId: string | undefined,
  options?: {
    config?: AdminAppConfig;
    managedCodexProviderReady?: boolean;
  },
): ImProviderRoutingResult {
  const c = options?.config ?? loadConfig();
  const { agent, channel } = findImAgentAndChannel(c, agentDir, channelId);
  if (!agent) return { kind: 'legacy-fallback', reason: 'agent-not-found' };

  const resolved = resolveSessionConfig(
    undefined,
    agent as unknown as AgentConfig,
    channelForSessionConfig(channel),
    'im',
    { managedCodexProviderReady: options?.managedCodexProviderReady === true },
  );

  const providerId = resolved.providerId
    || channelLevelProviderId(channel)
    || agent.providerId
    || (c.defaultProviderId as string | undefined);
  const model = resolved.model;

  if (resolved.runtime !== 'builtin') {
    const isManagedCodexRuntime = resolved.runtime === 'codex'
      && resolved.runtimeSource === 'managed-provider';
    return {
      kind: 'external-runtime',
      runtime: resolved.runtime,
      runtimeSource: resolved.runtimeSource,
      model,
      providerId,
      reason: isManagedCodexRuntime ? 'managed-codex-provider' : 'runtime-not-builtin',
    };
  }

  if (providerId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
    if (options?.managedCodexProviderReady === true && model) {
      return {
        kind: 'external-runtime',
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model,
        providerId,
        reason: 'managed-codex-provider',
      };
    }
    return {
      kind: 'error',
      status: 409,
      reason: 'managed-codex-provider-not-ready',
      providerId,
      model,
      message: 'Managed Codex Provider is configured for this IM channel but is not ready.',
    };
  }

  if (!providerId) return { kind: 'legacy-fallback', reason: 'provider-id-missing' };

  const route = resolveExplicitProviderRoute({
    providerId,
    model,
    providers: providersForRouteResolution(c),
  });
  if (!isConcreteProviderRoute(route)) {
    return {
      kind: 'error',
      status: 409,
      reason: 'provider-route-unresolved',
      providerId,
      model,
      providerRoute: route,
      message: providerRouteFailureMessage(route, providerId, model),
    };
  }

  const providerEnv = materializeProviderRouteEnv(route, c);
  if (route.kind === 'provider' && !providerEnv) {
    return {
      kind: 'error',
      status: 409,
      reason: 'provider-env-unavailable',
      providerId,
      model: route.model,
      providerRoute: route,
      message: `Provider "${providerId}" is unavailable or missing an API key.`,
    };
  }

  return {
    kind: 'provider-route',
    providerRoute: route,
    providerId,
    model: route.model,
    providerEnv,
  };
}

/**
 * Re-resolve providerEnv for an IM channel from canonical `providerId` (issue #237).
 *
 * The IM bot's Rust runtime caches `provider_env_json` as an Arc at bot start and
 * forwards that blob in every `/api/im/enqueue` payload. The blob can drift away
 * from the agent's canonical `providerId` — channel.overrides.providerEnvJson stays
 * pinned to whatever was written when the user last touched that channel (the
 * Rust hot-reload for `patch.channels` only updates group fields — see
 * `src-tauri/src/im/mod.rs` patch.channels branch), and agent.providerEnvJson can
 * outlive a providerId change if the writer didn't go through patchAgentConfig.
 * Desktop Chat is immune because Chat.tsx builds providerEnv live from React state
 * on every send; IM was not.
 *
 * The canonical implementation is now `resolveImProviderRouting()`: it looks
 * up the agent + channel, resolves `providerId` via the same priority chain
 * Rust uses at `src-tauri/src/im/types.rs:968`
 * (`channel.overrides.providerId` → legacy channel-root `channel.providerId`
 * (pre-bc06386) → `agent.providerId` → `config.defaultProviderId`), validates
 * the `(providerId, model)` pair as a ProviderRoute, then materializes env only
 * for builtin API providers.
 *
 * Returns undefined when:
 *   - the agent can't be matched by workspacePath (legacy IM bot / drift) —
 *     deliberately does NOT fall through to `defaultProviderId` here, since
 *     rerouting every unmatched IM bot to the global default would be strictly
 *     worse than the stale-blob bug we're fixing,
 *   - or when the resolved route is not a builtin API provider with live env.
 *
 * New enqueue paths must consume `resolveImProviderRouting()` directly so known
 * provider/model/key failures return 409 instead of falling back to stale blobs.
 */
export function resolveImProviderEnv(
  agentDir: string,
  channelId: string | undefined,
  config?: AdminAppConfig,
): ResolvedProviderEnv | undefined {
  const routing = resolveImProviderRouting(agentDir, channelId, { config });
  return routing.kind === 'provider-route' ? routing.providerEnv : undefined;
}

/**
 * Decode a frozen providerEnv snapshot, enforcing the global enablement gate.
 *
 * Snapshot semantics: sessions / agents / cron tasks freeze provider env at
 * config time, so live edits to baseUrl/apiKey don't break a running session
 * ("snapshot wins"). But "provider globally disabled" must override the
 * snapshot — otherwise cron / IM handover paths silently keep using credentials
 * for a provider the user just turned off.
 *
 * Single source of truth for every snapshot consumer (resolveWorkspaceConfig,
 * cron followAgent, IM handover). Returns undefined when:
 *   - snapshot is missing or malformed
 *   - providerId is known and currently disabled (caller must fail loud)
 */
export function decodeProviderEnvSnapshot(
  snapshotJson: string | null | undefined,
  providerId: string | null | undefined,
  config?: AdminAppConfig,
): ResolvedProviderEnv | undefined {
  if (!snapshotJson) return undefined;
  if (providerId && isProviderDisabled(providerId, config)) return undefined;
  try {
    const parsed = JSON.parse(snapshotJson) as ResolvedProviderEnv;
    if (!parsed.providerName && providerId) {
      const provider = findEffectiveProvider(providerId, config);
      if (typeof provider?.name === 'string') parsed.providerName = provider.name;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** Result of self-resolution for a workspace */
export interface WorkspaceResolvedConfig {
  mcpServers: McpServerDefinition[];
  enabledOfficialToolIds: OfficialToolId[];
  providerEnv: ResolvedProviderEnv | undefined;
  providerRoute: ProviderRoute | undefined;
  model: string | undefined;
  permissionMode: string;
  /** #324 — reasoning effort setting ('default' | level | undefined). Raw chain
   *  value (NOT normalized); callers run normalizeReasoningEffort() themselves. */
  reasoningEffort: string | undefined;
}

const BUILTIN_PERMISSION_MODES = new Set(['auto', 'plan', 'fullAgency', 'custom']);

function asBuiltinPermissionMode(value: unknown): string | undefined {
  return typeof value === 'string' && BUILTIN_PERMISSION_MODES.has(value)
    ? value
    : undefined;
}

/**
 * Resolve the complete AI configuration for a workspace by reading source data from disk.
 *
 * This eliminates the dependency on pre-serialized snapshot fields (providerEnvJson, mcpServersJson)
 * that can fail to save or go stale. The Sidecar calls this during initializeAgent() so IM Bot
 * sessions work correctly without the frontend having been opened first.
 *
 * For desktop Chat sessions, the frontend's /api/mcp/set and per-message providerEnv will
 * override the self-resolved values — so there is no conflict.
 *
 * v0.1.69 / 0.2.39 — `sessionMeta`: when `configSnapshotAt` is present, the
 * session owns its runtime config and missing fields must not fall back to
 * Agent/Project defaults. Agent fallback is only for legacy sessions without a
 * snapshot marker, and is still read-only.
 *
 * IM sessions deliberately don't snapshot model/permission/mcp (D4 live-follow), so
 * the session-meta merge is a no-op for them — `meta?.<field>` is undefined and we
 * fall through to the existing agent path. The IM channel-overrides merge happens
 * elsewhere (at the IM bot delivery layer where `channel` context is available).
 */
export function resolveWorkspaceConfig(
  agentDir: string,
  sessionMeta?: SessionMetadata | null,
  options?: { includeMcp?: boolean },
): WorkspaceResolvedConfig {
  const config = loadConfig();
  // MCP resolution is the expensive part here (walks all agents, intersects
  // enable sets, builds McpServerDefinition from disk). Desktop Tab sessions
  // don't need it — the frontend's /api/mcp/set is authoritative — so callers
  // can short-circuit via `{ includeMcp: false }` to skip it entirely.
  const includeMcp = options?.includeMcp !== false;

  const projects = loadProjects();
  const matchingProjects = projects.filter(p => workspacePathsEqual(p.path, agentDir));
  const project = matchingProjects.length === 1 ? matchingProjects[0] : undefined;
  const agent = findRuntimeAgentForWorkspace(config, projects, agentDir);

  // --- Resolve MCP ---
  // Session snapshot first (PRD §6 D2/D9): if the session captured its own enabled
  // server list, intersect with the global-enabled set so users disabling a server
  // globally still wins (security stays at the global lever, locked sessions just
  // pin their feature surface).
  let mcpServers: McpServerDefinition[] = [];
  const snapshotOwnsConfig = Boolean(sessionMeta?.configSnapshotAt);

  if (includeMcp) {
    if (sessionMeta?.mcpEnabledServers) {
      const allServers = getAllMcpServers(config);
      const globalEnabled = new Set(getEnabledMcpServerIds(config));
      const sessionEnabled = new Set(sessionMeta.mcpEnabledServers);
      mcpServers = allServers.filter(s => globalEnabled.has(s.id) && sessionEnabled.has(s.id));
    } else if (!snapshotOwnsConfig) {
      // Lazy fallback for legacy / IM sessions — uses project ∩ global as before.
      mcpServers = getEffectiveMcpServers(agentDir);
    }
  }
  console.log(
    includeMcp
      ? `[config] mcpResolution=resolved mcpCount=${mcpServers.length}`
      : '[config] mcpResolution=skipped',
  );

  // --- Resolve MyAgents official CLI tools ---
  const globalOfficialTools = new Set(getGloballyEnabledOfficialToolIds(config));
  const configuredOfficialTools = configuredOfficialToolSet(config);
  const requestedOfficialTools = snapshotOwnsConfig
    ? normalizeOfficialToolIds(sessionMeta?.enabledOfficialToolIds)
    : normalizeOfficialToolIds(
      sessionMeta?.enabledOfficialToolIds
      ?? agent?.enabledOfficialToolIds
      ?? project?.enabledOfficialToolIds,
    );
  const enabledOfficialToolIds = requestedOfficialTools.filter(
    id => globalOfficialTools.has(id) && configuredOfficialTools.has(id),
  );

  const agentProviderId = agent?.providerId as string | undefined;
  const agentUsesRuntimeBackedProvider = agentUsesManagedCodexProvider({
    providerId: agentProviderId,
    runtime: typeof agent?.runtime === 'string' ? agent.runtime : undefined,
    runtimeConfig: agent?.runtimeConfig as { source?: string } | undefined,
  });
  const resolvedRuntime: RuntimeType = agentUsesRuntimeBackedProvider && !sessionMeta?.runtime
    ? 'codex'
    : normalizeRuntime(
        (sessionMeta?.runtime as string | undefined) ?? (agent?.runtime as string | undefined),
      );
  const agentRuntimeConfig = agent?.runtimeConfig as {
    source?: string;
    model?: string;
    permissionMode?: string;
    reasoningEffort?: string;
  } | undefined;
  const agentProductPermissionMode = isProductPermissionMode(agent?.permissionMode)
    ? agent.permissionMode
    : undefined;
  const resolvedRuntimeSource = resolvedRuntime === 'builtin'
    ? undefined
    : (sessionMeta?.runtime !== undefined
      ? (sessionMeta.runtimeSource
        ?? sessionMeta.providerExecutionIdentity?.runtimeSource
        ?? 'system-cli')
      : (agentUsesRuntimeBackedProvider ? 'managed-provider' : agentRuntimeConfig?.source ?? 'system-cli'));
  const usesManagedCodexExecution = resolvedRuntime === 'codex'
    && resolvedRuntimeSource === 'managed-provider';

  // --- Resolve Provider ---
  // Priority: session.providerId → agent.providerId → config.defaultProviderId → persisted snapshot
  let providerEnv: ResolvedProviderEnv | undefined;
  let providerRoute: ProviderRoute | undefined;
  let providerId: string | undefined;
  if (resolvedRuntime === 'builtin' && snapshotOwnsConfig) {
    providerRoute = resolveOwnedBuiltinProviderRoute({ sessionMeta, config });
    providerId = isConcreteProviderRoute(providerRoute) ? providerRoute.providerId : sessionMeta?.providerId;
    providerEnv = isConcreteProviderRoute(providerRoute)
      ? materializeProviderRouteEnv(providerRoute, config)
      : (providerId ? resolveProviderEnv(providerId, config, sessionMeta?.model) : undefined);
  } else if (resolvedRuntime === 'builtin') {
    providerId = sessionMeta?.providerId
      || (agent?.providerId as string | undefined)
      || (config.defaultProviderId as string | undefined);
    if (providerId) {
      const route = resolveExplicitProviderRoute({
        providerId,
        model: sessionMeta?.model ?? (agent?.model as string | undefined),
        providers: providersForRouteResolution(config),
      });
      providerRoute = isConcreteProviderRoute(route) ? route : undefined;
      providerEnv = resolveProviderEnv(providerId, config, providerRoute?.model);
    }
  }
  // Legacy env fallback: once a canonical providerRoute exists, live materialization
  // wins and the old providerEnvJson blob must not override it. Only route-less
  // historical data may still decode providerEnvJson for back-compat.
  // decodeProviderEnvSnapshot still enforces the global disable gate.
  if (sessionMeta?.providerEnvJson && !isConcreteProviderRoute(providerRoute)) {
    const decoded = decodeProviderEnvSnapshot(sessionMeta.providerEnvJson, providerId, config);
    if (decoded) providerEnv = decoded;
  } else if (!snapshotOwnsConfig && !providerEnv && agent?.providerEnvJson) {
    // Backward-compat: legacy sessions without a snapshot fall back to agent's persisted env
    const decoded = decodeProviderEnvSnapshot(agent.providerEnvJson as string, providerId, config);
    if (decoded) providerEnv = decoded;
  }

  // --- Resolve Model ---
  // Runtime-aware priority:
  // - builtin: session.model → agent.model → provider primary model
  // - external: session.model → agent.runtimeConfig.model → runtime default
  const rawModel = resolvedRuntime === 'builtin'
    ? (snapshotOwnsConfig
      ? (isConcreteProviderRoute(providerRoute) ? providerRoute.model : sessionMeta?.model)
      : (sessionMeta?.model ?? (agent?.model as string | undefined) ?? undefined))
    : (snapshotOwnsConfig
      ? sessionMeta?.model
      : (sessionMeta?.model ?? (agentUsesRuntimeBackedProvider ? agent?.model as string | undefined : agentRuntimeConfig?.model)));
  let model = coerceModelForRuntime(rawModel, resolvedRuntime);
  if (resolvedRuntime !== 'builtin'
      && typeof rawModel === 'string'
      && rawModel.trim().length > 0
      && model === undefined) {
    console.warn(
      `[runtime-coerce] dropping stale workspace model='${rawModel}' on runtime='${resolvedRuntime}'; falling back to runtime default. sessionId=${sessionMeta?.id ?? '<none>'} agentDir=${agentDir}`,
    );
  }
  if (!model && providerId && resolvedRuntime === 'builtin') {
    const provider = findEffectiveProvider(providerId, config);
    if (provider && isProviderEnabled(provider)) {
      model = (provider as Record<string, unknown>).primaryModel as string | undefined;
    }
  }

  // --- Resolve Reasoning Effort (#324) ---
  // Priority: session.reasoningEffort → agent.reasoningEffort (builtin) /
  // agent.runtimeConfig.reasoningEffort (external runtime). The snapshot may
  // hold the literal 'default' — that is a meaningful value ("session reverted
  // to default") and must win over a non-default agent value, which the ??
  // chain handles naturally.
  const rawReasoningEffort = snapshotOwnsConfig
    ? sessionMeta?.reasoningEffort
    : (sessionMeta?.reasoningEffort
      ?? (resolvedRuntime === 'builtin'
        ? (agent?.reasoningEffort as string | undefined)
        : agentRuntimeConfig?.reasoningEffort));
  const reasoningEffort = resolvedRuntime === 'builtin'
    ? rawReasoningEffort
    : coerceReasoningEffortSettingForRuntime(rawReasoningEffort, resolvedRuntime);
  if (resolvedRuntime !== 'builtin'
      && typeof rawReasoningEffort === 'string'
      && rawReasoningEffort.trim().length > 0
      && rawReasoningEffort.trim() !== 'default'
      && reasoningEffort === undefined) {
    console.warn(
      `[runtime-coerce] dropping stale workspace reasoningEffort='${rawReasoningEffort}' on runtime='${resolvedRuntime}'; falling back to runtime default. sessionId=${sessionMeta?.id ?? '<none>'} agentDir=${agentDir}`,
    );
  }

  // --- Resolve Permission Mode ---
  // Builtin keeps the historical precedence:
  // session snapshot → Agent → Project → global default. External runtimes use
  // only their runtime-specific fields; project/global builtin permission
  // values are not portable.
  let permissionMode: string;
  if (resolvedRuntime === 'builtin') {
    // Deliberate divergence from the renderer's UI fallback (which defaults a
    // missing defaultPermissionMode to 'plan'): headless pre-warm for IM/cron
    // sessions must default to 'auto' (classify, non-blocking), NOT 'plan'
    // (read-only) — defaulting headless sessions to plan would make them refuse
    // every write before the first user message. Only reachable on a brand-new
    // empty config; once the UI has run, config.defaultPermissionMode is set.
    permissionMode = snapshotOwnsConfig
      ? (asBuiltinPermissionMode(sessionMeta?.permissionMode) ?? 'auto')
      : (asBuiltinPermissionMode(sessionMeta?.permissionMode)
        ?? asBuiltinPermissionMode(agent?.permissionMode)
        ?? asBuiltinPermissionMode(project?.permissionMode)
        ?? asBuiltinPermissionMode(config.defaultPermissionMode)
        ?? 'auto');
  } else {
    const rawPermissionMode = sessionMeta
      ? sessionMeta.permissionMode
      : ((usesManagedCodexExecution ? agentProductPermissionMode : undefined)
        ?? agentRuntimeConfig?.permissionMode);
    const coercedPermissionMode = usesManagedCodexExecution
      ? projectManagedCodexPermissionToRuntime(rawPermissionMode)
      : projectPermissionModeForRuntime(rawPermissionMode, resolvedRuntime);
    if (typeof rawPermissionMode === 'string'
        && rawPermissionMode.trim().length > 0
        && coercedPermissionMode === undefined) {
      console.warn(
        `[runtime-coerce] dropping stale workspace permissionMode='${rawPermissionMode}' on runtime='${resolvedRuntime}'; falling back to runtime default. sessionId=${sessionMeta?.id ?? '<none>'} agentDir=${agentDir}`,
      );
    }
    permissionMode = coercedPermissionMode
      ?? (usesManagedCodexExecution ? 'auto-edit' : getDefaultRuntimePermissionMode(resolvedRuntime))
      ?? 'default';
  }

  // Gate on the signals that indicate a real workspace match — NOT permissionMode,
  // which now always resolves to a non-empty string ('auto' fallback) and would
  // make this log fire on every call (incl. no-match). Stay silent when nothing
  // resolved, as before.
  if (mcpServers.length > 0 || enabledOfficialToolIds.length > 0 || providerEnv || model || agent) {
    const source = sessionMeta?.configSnapshotAt ? 'session-snapshot' : 'agent';
    console.log(
      `[admin-config] resolveWorkspaceConfig (${source}): ` +
      `provider=${providerId ?? 'subscription'}, model=${model ?? 'default'}, ` +
      `permission=${permissionMode}, mcp=${mcpServers.length} server(s), ` +
      `officialTools=${enabledOfficialToolIds.join(',') || 'none'}${agent ? '' : ' (no agent match)'}`
    );
  }

  return { mcpServers, enabledOfficialToolIds, providerEnv, providerRoute, model, permissionMode, reasoningEffort };
}
