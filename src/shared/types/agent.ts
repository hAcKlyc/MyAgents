import { providerRequiresClaudeSdk } from '../integrated-runtimes/provider-constraints';
// Agent architecture types (v0.1.41)
// Agent = upgraded workspace with pluggable I/O channels

import type {
  ImPlatform,
  HeartbeatConfig,
  MemoryAutoUpdateConfig,
  MemoryEvolutionConfig,
  GroupPermission,
  GroupActivation,
} from './im';
import {
  getMaxPermissionForRuntime,
  type RuntimeType,
  type RuntimeConfig,
} from './runtime';
import {
  resolveAgentRuntimePreference,
  runtimeTypeForAgentRuntimePreference,
} from '../integrated-runtimes/identity';
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
} from '../config-types';
import type { OfficialToolId } from '../official-tools';
import type { ProjectCapabilitySelectionV1 } from '../projectCapabilities';
import type { AgentRuntimePreference } from '../integrated-runtimes/identity';

/**
 * Channel type — reuses ImPlatform, not redefined
 */
export type ChannelType = ImPlatform;

/**
 * Last active channel tracking for heartbeat/cron routing
 */
export interface LastActiveChannel {
  channelId: string;
  sessionKey: string;
  lastActiveAt: string; // ISO timestamp
}

/**
 * Private-only heartbeat/cron target tracking.
 * LastActiveChannel may point at a group; heartbeat delivery never should.
 */
export interface LastActivePrivateTarget {
  channelId: string;
  sessionKey: string;
  lastActiveAt: string; // ISO timestamp
}

/**
 * Channel tool restrictions. Execution fields remain read-only legacy migration data.
 */
export interface ChannelOverrides {
  providerId?: string;
  providerEnvJson?: string;
  model?: string;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfig;
  /** Authoritative Runtime family preference. Legacy runtime fields remain a compatibility projection. */
  runtimePreference?: AgentRuntimePreference;
  permissionMode?: string;
  toolsDeny?: string[];
}

/** Writers preserve existing legacy bytes, but cannot create or edit execution overrides. */
export function channelExecutionConfigChangeError(current: unknown, next: unknown): string | undefined {
  const keys = ['providerId', 'providerEnvJson', 'model', 'runtime', 'runtimeConfig', 'runtimePreference', 'permissionMode', 'mcpEnabledServers', 'mcpServersJson', 'reasoningEffort', 'enabledPluginIds', 'enabledOfficialToolIds'];
  const before = current as Record<string, unknown> | undefined;
  const after = next as Record<string, unknown>;
  for (const location of [undefined, 'overrides']) {
    const oldFields = location ? before?.[location] as Record<string, unknown> | undefined : before;
    const newFields = location ? after[location] as Record<string, unknown> | undefined : after;
    for (const key of keys) {
      if (JSON.stringify(oldFields?.[key]) !== JSON.stringify(newFields?.[key])) {
        return `Channel execution override '${key}' is no longer supported. Update the Agent or Session instead.`;
      }
    }
  }
  if (JSON.stringify(before?.peerProfiles) !== JSON.stringify(after.peerProfiles)) {
    return 'Team AI peer settings are managed from the Team AI page.';
  }
  return undefined;
}

/**
 * Channel configuration — a single I/O endpoint within an Agent
 */
export interface ChannelConfig {
  // Identity
  id: string;
  type: ChannelType;
  name?: string;           // Defaults to platform display name
  enabled: boolean;

  /** Frozen at execution admission; missing persisted values retain auto. */
  messageDeliveryMode?: import('../channelContext').ChannelDeliveryMode;

  // Platform credentials (vary by type)
  botToken?: string;
  telegramUseDraft?: boolean;

  feishuAppId?: string;
  feishuAppSecret?: string;

  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  dingtalkUseAiCard?: boolean;
  dingtalkCardTemplateId?: string;

  // OpenClaw Plugin
  openclawPluginId?: string;
  openclawNpmSpec?: string;
  openclawPluginConfig?: Record<string, unknown>;
  openclawManifest?: Record<string, string>;
  /** Enabled tool groups for OpenClaw plugins with tools (e.g. feishu) */
  openclawEnabledToolGroups?: string[];

  // User management
  /** Omitted mode defaults to whitelist (review); QR-bound WeChat does not use it. */
  accessMode?: 'review' | 'open';
  blockedUserIds?: string[];
  blockedGroupIds?: string[];
  allowedUsers?: string[];
  /** Display metadata only; authorization continues to use allowedUsers IDs. */
  userDisplayNames?: Record<string, string>;

  // Group chat
  groupPermissions?: GroupPermission[];
  groupActivation?: GroupActivation;

  // Channel tool restrictions; legacy execution fields are read-only migration data.
  overrides?: ChannelOverrides;

  /** Team AI peer birth templates keyed by sessionKey. Written only by the Rust
   *  Team AI owner; shape defined in `src/server/utils/peer-profile.ts`. */
  peerProfiles?: Record<string, unknown>;

  // Runtime
  setupCompleted?: boolean;
}

/**
 * Agent configuration — an upgraded workspace with AI config and channels
 */
export interface AgentConfig {
  // Identity
  id: string;
  name: string;
  icon?: string;           // Phosphor icon ID or emoji
  enabled: boolean;

  // AI Configuration (defaults for all channels)
  providerId?: string;
  model?: string;
  providerEnvJson?: string;
  permissionMode: string;  // 'plan' | 'auto' | 'fullAgency'
  /** #324 — builtin-runtime reasoning effort default ('default' | level; see
   *  shared/reasoningEffort.ts). External runtimes use runtimeConfig.reasoningEffort. */
  reasoningEffort?: string;
  mcpEnabledServers?: string[];
  /** Resolved MCP server definitions JSON (persisted for auto-start, rebuilt on manual start) */
  mcpServersJson?: string;
  /** PRD 0.2.17 — Claude plugins enabled for this Agent (subset of globally
   *  visible plugins; gated by AppConfig.enabledPlugins). Sessions started from
   *  this Agent inherit this list as their initial selection; per-Tab UI can
   *  override transiently. Mirrors mcpEnabledServers semantics exactly. */
  enabledPluginIds?: string[];
  /** MyAgents official CLI tools enabled for this Agent. Separate from MCP/plugin ids. */
  enabledOfficialToolIds?: OfficialToolId[];
  /** Per-project Skill/Command disabled overrides. The owning Project selects
   * this Agent by stable `agentId`; workspace files never mirror the value. */
  capabilitySelection?: ProjectCapabilitySelectionV1;

  // Heartbeat (Agent-level, shared across channels)
  heartbeat?: HeartbeatConfig;

  // Memory Auto-Update (v0.1.43)
  memoryAutoUpdate?: MemoryAutoUpdateConfig;

  // Long-term Memory Evolution (v0.2.49)
  memoryEvolution?: MemoryEvolutionConfig;

  // Channels
  channels: ChannelConfig[];

  // Active message routing
  lastActiveChannel?: LastActiveChannel;
  lastActivePrivateTarget?: LastActivePrivateTarget;

  // Agent Runtime (v0.1.59)
  runtime?: RuntimeType;           // 'builtin' | 'claude-code' | 'codex', defaults to 'builtin'
  runtimeConfig?: RuntimeConfig;   // Runtime-specific model/permission/args
  /** Authoritative Runtime family preference for new Sessions. */
  runtimePreference?: AgentRuntimePreference;

  // Runtime
  setupCompleted?: boolean;
}

function resolveAgentChannelProviderId(agent: AgentConfig, _channel: ChannelConfig): string | undefined {
  return agent.providerId;
}

function resolveAgentChannelPreference(agent: AgentConfig, channel: ChannelConfig) {
  return resolveAgentRuntimePreference({
    runtimePreference: agent.runtimePreference,
    runtime: agent.runtime,
    runtimeSource: agent.runtimeConfig?.source,
    providerId: resolveAgentChannelProviderId(agent, channel),
  });
}

export function agentChannelUsesManagedCodexProvider(
  agent: AgentConfig,
  channel: ChannelConfig,
): boolean {
  if (resolveAgentChannelProviderId(agent, channel) !== CODEX_SUBSCRIPTION_PROVIDER_ID) {
    return false;
  }
  return resolveAgentChannelPreference(agent, channel)?.family === 'integrated';
}

/**
 * Resolve the future Channel-session Runtime from Agent preference and Provider
 * constraints. Legacy Channel execution overrides are read-only data. Runtime-backed
 * providers are projected here so the renderer/shared view matches Rust
 * `ChannelConfigRust::to_im_config`.
 */
export function resolveAgentChannelRuntime(agent: AgentConfig, channel: ChannelConfig): RuntimeType {
  const preference = resolveAgentChannelPreference(agent, channel);
  if (!preference) return 'builtin';
  const preferredRuntime = runtimeTypeForAgentRuntimePreference(preference);
  if (preference.family === 'external') return preferredRuntime;
  const providerId = resolveAgentChannelProviderId(agent, channel);
  if (providerId === CODEX_SUBSCRIPTION_PROVIDER_ID) return 'codex';
  if (providerRequiresClaudeSdk(providerId)) {
    return 'builtin';
  }
  return preferredRuntime;
}

export function resolveAgentChannelDefaultPermissionMode(agent: AgentConfig, channel: ChannelConfig): string {
  if (agentChannelUsesManagedCodexProvider(agent, channel)) {
    return 'fullAgency';
  }
  return getMaxPermissionForRuntime(resolveAgentChannelRuntime(agent, channel));
}

/**
 * IM births use the selected Runtime's maximum unattended permission.
 * Existing Session permissions remain owned by their snapshot.
 */
export function resolveAgentChannelPermissionMode(agent: AgentConfig, channel: ChannelConfig): string {
  return resolveAgentChannelDefaultPermissionMode(agent, channel);
}

/**
 * Resolve future-session Agent defaults plus live Channel tool restrictions.
 */
export function resolveEffectiveConfig(agent: AgentConfig, channel: ChannelConfig) {
  const runtime = resolveAgentChannelRuntime(agent, channel);
  return {
    providerId: agent.providerId,
    providerEnvJson: agent.providerEnvJson,
    model: agent.model,
    permissionMode: resolveAgentChannelPermissionMode(agent, channel),
    mcpEnabledServers: agent.mcpEnabledServers,      // Channel cannot override
    enabledPluginIds: agent.enabledPluginIds,        // Channel cannot override (mirrors MCP)
    toolsDeny: channel.overrides?.toolsDeny ?? [],
    heartbeat: agent.heartbeat,                       // Always Agent's
    runtime,
    runtimeConfig: agent.runtimeConfig,
  };
}
