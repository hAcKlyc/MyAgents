import type { AgentConfigMutation } from '../../shared/agentConfigMutation';
// Shared "user changed an option in the input toolbar" persistence policy.
//
// Both the chat-tab input and the launcher input write to the same trio
// (session snapshot / project / agent) when the user toggles provider, model,
// permission mode, or MCP. Until v0.2.7 each surface had its own copy of the
// patch logic; the two copies had drifted (Chat ignored runtimeConfig for
// permission mode, Launcher correctly branched on runtime). This module
// captures the dual-write policy in one place so future changes only happen
// in one file.
//
// Two contracts:
//
// 1. Pure-data: callers tell us "what fields changed, on which workspace,
//    with which session" — we figure out where on disk to write. No React
//    state ownership, no implicit hooks. Easy to test, easy to reason about.
//
// 2. Side-effect locality: the only side-effect this function performs is
//    disk writes via injected callbacks (`patchProject`, `patchSnapshot`,
//    `patchAgentConfig`) and an optional sidecar `/api/mcp/set` call. UI state
//    updates (setSelectedModel etc.) are caller responsibility — keeping them
//    out keeps this function pure across both Chat (with a session) and
//    Launcher (without).

import { type PermissionMode, type Project, type McpServerDefinition } from '@/config/types';
import { type RuntimeConfig } from '@/../shared/types/runtime';
import { createConcreteProviderRoute, type ProviderRoute } from '@/../shared/providerRoute';
import {
  runtimeBackedProviderPermissionMode,
  type RuntimeBackedProviderIdentity,
} from '@/../shared/providerExecution';
import type { OfficialToolId } from '@/../shared/official-tools';

export interface BuiltinModelSelection {
  providerId: string;
  model: string;
}

export type BuiltinProviderEnvPolicy = 'preserve-provider-env' | 'clear-stale-provider-env';

/** What the user just changed in the toolbar. All fields optional. */
export interface InputOptionFields {
  /** Provider-scoped builtin model selection. Preferred over the loose legacy
   *  providerId/builtinModel pair because builtin model ids are not globally
   *  unique across providers. */
  builtinSelection?: BuiltinModelSelection;
  /** Snapshot env policy for provider-scoped builtin selections. Cross-provider
   *  edits clear stale frozen env; same-provider model edits preserve the
   *  session's exact provider env identity. */
  builtinProviderEnvPolicy?: BuiltinProviderEnvPolicy;
  /** Selected provider id. Builtin runtime only. */
  providerId?: string | null;
  /** Selected model when on the builtin runtime. Legacy loose field; Chat's
   *  provider/model picker must use builtinSelection instead. */
  builtinModel?: string | null;
  /** Selected model when on an external runtime (Codex/CC). */
  runtimeModel?: string | null;
  /** Provider-shaped selection whose execution is owned by an external runtime
   *  (currently Codex 订阅). This is intentionally separate from
   *  `builtinSelection`: the user picked a Provider, but the running session
   *  must carry runtime/source identity. */
  runtimeBackedProviderSelection?: RuntimeBackedProviderIdentity;
  /** Existing Session execution context, not an instruction to change provider/model defaults. */
  runtimeBackedProviderContext?: RuntimeBackedProviderIdentity;
  /** Permission mode — split between `agent.permissionMode` (builtin) and
   *  `agent.runtimeConfig.permissionMode` (external) at the storage layer. */
  permissionMode?: PermissionMode | string;
  /** #324 — 推理强度 setting ('default' | level, shared/reasoningEffort.ts).
   *  Split between `agent.reasoningEffort` (builtin) and
   *  `agent.runtimeConfig.reasoningEffort` (external), mirroring model. */
  reasoningEffort?: string;
  /** MCP server ids enabled at the workspace level. */
  mcpEnabledServers?: string[];
  /** PRD 0.2.17 — Claude plugin ids enabled at the workspace level. Mirrors
   *  mcpEnabledServers exactly (project + agent + snapshot dual-write). */
  enabledPluginIds?: string[];
  /** MyAgents official CLI tool ids enabled at the workspace level. */
  enabledOfficialToolIds?: OfficialToolId[];
}

export interface PersistInputOptionParams {
  /** Workspace (Project) id. Required — both Chat and Launcher always have one. */
  workspaceId: string;
  /** Agent id; null when the workspace has no Basic Agent yet. */
  agentId?: string | null;

  /** Whether the active runtime uses the shared non-builtin process adapter.
   *  `usesProductConfiguration` separates Integrated DSH from External CLIs. */
  isExternalRuntime: boolean;
  /** Integrated runtimes such as DSH use the shared process adapter while
   * Product Agent/Project fields continue to own Provider/model/permission. */
  usesProductConfiguration?: boolean;
  fields: InputOptionFields;

  /** Disk writers — injected so the helper has zero direct module imports
   *  and can be unit-tested with mocks. */
  patchProject: (
    projectId: string,
    updates: Partial<Omit<Project, 'id'>>,
  ) => Promise<unknown>;
  patchAgentConfig: (
    agentId: string,
    patch: AgentConfigMutation,
  ) => Promise<unknown>;
  patchAgentProjectConfig: (
    agentId: string,
    agentPatch: AgentConfigMutation,
    projectId: string,
    projectPatch: Partial<Omit<Project, 'id'>>,
  ) => Promise<unknown>;

  /** Session snapshot writer — chat-tab only (owned sessions). Omit for
   *  launcher (no session yet) or unlocked sessions (no snapshot). */
  patchSnapshot?: (patch: SessionSnapshotPatch) => Promise<unknown>;
  /** Chat-owned sessions require the snapshot write to succeed before any
   *  Project/Agent default mutation. Launcher keeps the historical optional
   *  mode because no session owner exists yet. */
  snapshotWriteMode?: 'optional' | 'required' | 'disabled';
  /** `disabled` keeps the change on the Session only: Team AI workspaces edit
   *  Agent defaults solely from Agent settings, never from a conversation. */
  defaultsWriteMode?: 'enabled' | 'disabled';

  /** Live sidecar push for MCP — chat-tab only (launcher has no Sidecar to
   *  push to; the new sidecar created during handoff picks up the disk write). */
  pushMcpToSidecar?: (effectiveServers: McpServerDefinition[]) => Promise<unknown>;
  /** Helpers for resolving effective MCP set for the sidecar push. Required
   *  iff `pushMcpToSidecar` and `fields.mcpEnabledServers` are both set. */
  getAllMcpServers?: () => Promise<McpServerDefinition[]>;
  getGlobalMcpEnabled?: () => Promise<string[]>;

  /** PRD 0.2.17 — live sidecar push for plugin enabled set. Chat-tab only
   *  (same reasoning as pushMcpToSidecar). When provided + fields.enabledPluginIds
   *  is set, the helper POSTs /api/cc-plugin/session-enable so the running
   *  session restart picks up the new plugin selection immediately. */
  pushPluginsToSidecar?: (enabledIds: string[]) => Promise<unknown>;

  /** Live sidecar push for MyAgents official CLI tool enabled set. */
  pushOfficialToolsToSidecar?: (enabledIds: OfficialToolId[]) => Promise<unknown>;

  /** Live sidecar push for external runtime model / permission-mode changes.
   *  Chat-tab only. Launcher has no active Sidecar; the next session reads disk. */
  pushRuntimeConfigToSidecar?: (
    runtimeConfig: Pick<RuntimeConfig, 'model' | 'permissionMode' | 'reasoningEffort'>,
  ) => Promise<unknown>;
}

/** Subset of the session snapshot fields we touch. Defined here (not imported
 *  from session types) to keep this helper free of session schema deps. */
export interface SessionSnapshotPatch {
  providerId?: string | null;
  providerRoute?: ProviderRoute | null;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity | null;
  model?: string | null;
  /** #324 — persisted literally (incl. 'default', which meaningfully pins the
   *  session back to default over a non-default agent value). */
  reasoningEffort?: string | null;
  permissionMode?: string | null;
  mcpEnabledServers?: string[] | null;
  enabledPluginIds?: string[] | null;
  enabledOfficialToolIds?: OfficialToolId[] | null;
  /** #300/#401 — credential snapshot. `null` clears it so the sidecar re-resolves
   *  the env live from `providerId`. Same-provider builtin model edits must not
   *  clear it because owned sessions treat frozen env as part of exact identity. */
  providerEnvJson?: string | null;
}

function routeFromBuiltinSelection(selection: BuiltinModelSelection): ProviderRoute {
  return createConcreteProviderRoute(selection.providerId, selection.model);
}

/**
 * Apply the input-option change to disk + (optionally) sidecar.
 *
 * Layered:
 * 1. Build the project patch + agent patch + snapshot patch from `fields`,
 *    branching permission/model on `isExternalRuntime`.
 * 2. Fire all writes; failures are surfaced as a result for the caller to
 *    decide UX (toast etc.) — we do NOT throw.
 * 3. If MCP changed and a sidecar push is configured, send /api/mcp/set with
 *    the resolved effective server list.
 */
export async function persistInputOptionChange(
  params: PersistInputOptionParams,
): Promise<{ ok: boolean; errors: string[]; snapshotWriteFailed: boolean }> {
  const errors: string[] = [];
  let snapshotWriteFailed = false;

  const writesDefaults = params.defaultsWriteMode !== 'disabled';
  const projectPatch = writesDefaults ? buildProjectPatch(params) : {};
  const snapshotPatch = buildSnapshotPatch(params);
  const agentPatch = writesDefaults ? buildAgentPatch(params) : {};

  // Order: snapshot first (matches the existing dual-write order in
  // Chat.tsx::persistTabConfigChange) so a snapshot failure surfaces before
  // we update the live config.
  const snapshotWriteMode = params.snapshotWriteMode ?? (params.patchSnapshot ? 'optional' : 'disabled');
  if (snapshotWriteMode !== 'disabled' && Object.keys(snapshotPatch).length > 0) {
    try {
      if (!params.patchSnapshot) {
        throw new Error('session snapshot writer is required but unavailable');
      }
      await params.patchSnapshot(snapshotPatch);
    } catch (e) {
      snapshotWriteFailed = true;
      errors.push(`session snapshot: ${describe(e)}`);
      if (snapshotWriteMode === 'required') {
        return { ok: false, errors, snapshotWriteFailed };
      }
    }
  }

  const hasProjectPatch = Object.keys(projectPatch).length > 0;
  const hasAgentPatch = Object.keys(agentPatch).length > 0;
  if (params.agentId && hasProjectPatch && hasAgentPatch) {
    try {
      await params.patchAgentProjectConfig(
        params.agentId,
        agentPatch,
        params.workspaceId,
        projectPatch,
      );
    } catch (e) {
      errors.push(`agent/project intent: ${describe(e)}`);
    }
  } else {
    if (hasProjectPatch) {
      try {
        await params.patchProject(params.workspaceId, projectPatch);
      } catch (e) {
        errors.push(`project: ${describe(e)}`);
      }
    }

    if (params.agentId && hasAgentPatch) {
      try {
        await params.patchAgentConfig(params.agentId, agentPatch);
      } catch (e) {
        errors.push(`agent: ${describe(e)}`);
      }
    }
  }

  // Sidecar push is optional and only runs when the caller wired all three
  // helpers (push + resolve all + resolve enabled). Launcher passes none of
  // the three and skips this branch entirely.
  if (
    params.pushMcpToSidecar &&
    params.getAllMcpServers &&
    params.getGlobalMcpEnabled &&
    params.fields.mcpEnabledServers !== undefined
  ) {
    try {
      const allServers = await params.getAllMcpServers();
      const globalEnabled = await params.getGlobalMcpEnabled();
      const effective = allServers.filter(
        s =>
          globalEnabled.includes(s.id) &&
          params.fields.mcpEnabledServers!.includes(s.id),
      );
      await params.pushMcpToSidecar(effective);
    } catch (e) {
      errors.push(`sidecar mcp push: ${describe(e)}`);
    }
  }

  // Plugin sidecar push — same shape as MCP. The session-enable endpoint
  // applies AppConfig.enabledPlugins visibility gate inside the sidecar, so
  // we just send the workspace-selected IDs and let the backend filter.
  if (params.pushPluginsToSidecar && params.fields.enabledPluginIds !== undefined) {
    try {
      await params.pushPluginsToSidecar(params.fields.enabledPluginIds);
    } catch (e) {
      errors.push(`sidecar plugin push: ${describe(e)}`);
    }
  }

  if (params.pushOfficialToolsToSidecar && params.fields.enabledOfficialToolIds !== undefined) {
    try {
      await params.pushOfficialToolsToSidecar(params.fields.enabledOfficialToolIds);
    } catch (e) {
      errors.push(`sidecar official tools push: ${describe(e)}`);
    }
  }

  if (
    params.isExternalRuntime &&
    params.pushRuntimeConfigToSidecar &&
    (
      params.fields.runtimeModel !== undefined
      || (params.usesProductConfiguration && (
        params.fields.builtinSelection !== undefined
        || params.fields.builtinModel !== undefined
      ))
      || params.fields.permissionMode !== undefined
      || params.fields.runtimeBackedProviderSelection !== undefined
    )
  ) {
    try {
      const runtimeConfig: Pick<RuntimeConfig, 'model' | 'permissionMode' | 'reasoningEffort'> = {};
      if (params.fields.runtimeBackedProviderSelection) {
        runtimeConfig.model = params.fields.runtimeBackedProviderSelection.model;
      } else if (params.usesProductConfiguration) {
        if (params.fields.builtinSelection !== undefined) {
          runtimeConfig.model = params.fields.builtinSelection.model;
        } else if (params.fields.builtinModel !== undefined) {
          runtimeConfig.model = params.fields.builtinModel ?? undefined;
        }
      } else if (params.fields.runtimeModel !== undefined) {
        runtimeConfig.model = params.fields.runtimeModel ?? undefined;
      }
      if (params.fields.permissionMode !== undefined) {
        runtimeConfig.permissionMode = (params.fields.runtimeBackedProviderSelection ?? params.fields.runtimeBackedProviderContext)
          ? runtimeBackedProviderPermissionMode(
            (params.fields.runtimeBackedProviderSelection ?? params.fields.runtimeBackedProviderContext)!,
            params.fields.permissionMode,
          )
          : params.fields.permissionMode;
      }
      // Model and its effort reset are one user intent. Forward both so a
      // later switch back cannot revive the process's previous override.
      if (params.fields.reasoningEffort !== undefined) {
        runtimeConfig.reasoningEffort = params.fields.reasoningEffort;
      }
      await params.pushRuntimeConfigToSidecar(runtimeConfig);
    } catch (e) {
      errors.push(`sidecar runtime config push: ${describe(e)}`);
    }
  }

  return { ok: errors.length === 0, errors, snapshotWriteFailed };
}

// ─── builders ────────────────────────────────────────────────────────────

function buildProjectPatch(
  params: PersistInputOptionParams,
): Partial<Omit<Project, 'id'>> {
  const patch: Partial<Omit<Project, 'id'>> = {};
  const { fields } = params;
  const runtimeOwnsConfiguration = params.isExternalRuntime
    && !params.usesProductConfiguration;

  if (fields.runtimeBackedProviderSelection !== undefined) {
    patch.providerId = fields.runtimeBackedProviderSelection.providerId;
    patch.model = fields.runtimeBackedProviderSelection.model;
  } else if (!runtimeOwnsConfiguration && fields.builtinSelection !== undefined) {
    patch.providerId = fields.builtinSelection.providerId;
    patch.model = fields.builtinSelection.model;
  } else if (fields.providerId !== undefined) {
    patch.providerId = fields.providerId ?? undefined;
  }
  // builtinModel goes to project.model — that's the project-level "default
  // model" used by future sessions. runtimeModel does NOT go to the project
  // because the project doesn't track a per-runtime model; that field lives
  // on the agent.runtimeConfig.
  if (!runtimeOwnsConfiguration && fields.builtinSelection === undefined && fields.builtinModel !== undefined) {
    patch.model = fields.builtinModel ?? null;
  }
  if (fields.permissionMode !== undefined && !runtimeOwnsConfiguration) {
    patch.permissionMode = fields.permissionMode as PermissionMode;
  }
  if (fields.mcpEnabledServers !== undefined) {
    patch.mcpEnabledServers = fields.mcpEnabledServers;
  }
  if (fields.enabledPluginIds !== undefined) {
    patch.enabledPluginIds = fields.enabledPluginIds;
  }
  if (fields.enabledOfficialToolIds !== undefined) {
    patch.enabledOfficialToolIds = fields.enabledOfficialToolIds;
  }
  return patch;
}

function buildSnapshotPatch(params: PersistInputOptionParams): SessionSnapshotPatch {
  const patch: SessionSnapshotPatch = {};
  const { fields } = params;
  const runtimeOwnsConfiguration = params.isExternalRuntime
    && !params.usesProductConfiguration;

  if (fields.runtimeBackedProviderSelection !== undefined) {
    patch.providerId = fields.runtimeBackedProviderSelection.providerId;
    patch.providerRoute = null;
    patch.providerExecutionIdentity = fields.runtimeBackedProviderSelection;
    patch.model = fields.runtimeBackedProviderSelection.model;
    patch.providerEnvJson = null;
  } else if (!runtimeOwnsConfiguration && fields.builtinSelection !== undefined) {
    patch.providerId = fields.builtinSelection.providerId;
    patch.providerRoute = routeFromBuiltinSelection(fields.builtinSelection);
    patch.providerExecutionIdentity = null;
    patch.model = fields.builtinSelection.model;
    patch.providerEnvJson = null;
  } else if (fields.providerId !== undefined) {
    patch.providerId = fields.providerId;
    patch.providerRoute = null;
    patch.providerExecutionIdentity = null;
    // #300: the session's frozen `providerEnvJson` was captured for the OLD
    // provider. Once providerId changes it is stale credentials (e.g. a deepseek
    // baseUrl/apiKey/modelAliases blob living under a skywork-ai providerId).
    // resolveWorkspaceConfig treats "snapshot env wins" (admin-config.ts), so on
    // a headless handover (IM / cron / pre-warm) that stale blob would override
    // the freshly-resolved env and send to the wrong upstream. Clear it so the
    // sidecar re-resolves the env live from the new providerId.
    patch.providerEnvJson = null;
  }
  // Snapshot.model is the session's "current model" regardless of runtime —
  // pre-PRD-0.2.7 Chat persisted to it via the unified `model` field. Now
  // that callers split by runtime, we have to write whichever one applies
  // for the current runtime; otherwise external-runtime model changes (e.g.
  // `handleRuntimeModelChange`) silently bypass the snapshot and consumers
  // reading `snapshot.model` (sidecar restore, IM bot bridge) see stale
  // builtin values.
  if (fields.runtimeBackedProviderSelection !== undefined) {
    patch.model = fields.runtimeBackedProviderSelection.model;
  } else if (runtimeOwnsConfiguration) {
    if (fields.runtimeModel !== undefined) patch.model = fields.runtimeModel;
  } else if (fields.builtinSelection !== undefined) {
    patch.model = fields.builtinSelection.model;
  } else if (fields.builtinModel !== undefined) {
    patch.model = fields.builtinModel;
  }
  if (fields.permissionMode !== undefined) {
    patch.permissionMode = (fields.runtimeBackedProviderSelection ?? fields.runtimeBackedProviderContext)
      ? runtimeBackedProviderPermissionMode(
        (fields.runtimeBackedProviderSelection ?? fields.runtimeBackedProviderContext)!,
        fields.permissionMode,
      )
      : fields.permissionMode;
  }
  // Effort is one snapshot field regardless of runtime (like snapshot.model).
  if (fields.reasoningEffort !== undefined) {
    patch.reasoningEffort = fields.reasoningEffort;
  }
  if (fields.mcpEnabledServers !== undefined) {
    patch.mcpEnabledServers = fields.mcpEnabledServers;
  }
  if (fields.enabledPluginIds !== undefined) {
    patch.enabledPluginIds = fields.enabledPluginIds;
  }
  if (fields.enabledOfficialToolIds !== undefined) {
    patch.enabledOfficialToolIds = fields.enabledOfficialToolIds;
  }
  return patch;
}

function buildAgentPatch(params: PersistInputOptionParams): AgentConfigMutation {
  const patch: AgentConfigMutation = {};
  const { fields } = params;
  const runtimeOwnsConfiguration = params.isExternalRuntime && !params.usesProductConfiguration;
  if (fields.runtimeBackedProviderSelection) {
    patch.runtimeBackedProviderSelection = fields.runtimeBackedProviderSelection;
    if (fields.permissionMode !== undefined) patch.permissionMode = fields.permissionMode as PermissionMode;
    if (fields.reasoningEffort !== undefined) patch.reasoningEffort = fields.reasoningEffort;
  } else if (fields.builtinSelection !== undefined) {
    patch.providerId = fields.builtinSelection.providerId;
  } else if (fields.providerId !== undefined) {
    patch.providerId = fields.providerId ?? undefined;
  }
  if (fields.mcpEnabledServers !== undefined) patch.mcpEnabledServers = fields.mcpEnabledServers;
  if (fields.enabledPluginIds !== undefined) patch.enabledPluginIds = fields.enabledPluginIds;
  if (fields.enabledOfficialToolIds !== undefined) patch.enabledOfficialToolIds = fields.enabledOfficialToolIds;

  const writesOrdinaryProviderDefault = fields.builtinSelection !== undefined || fields.providerId !== undefined || fields.builtinModel !== undefined;
  if (fields.runtimeBackedProviderSelection !== undefined) {
    // The locked config writer resolves selection and strips stale managed fields.
  } else if (fields.runtimeBackedProviderContext) {
    if (fields.permissionMode !== undefined) patch.permissionMode = fields.permissionMode as PermissionMode;
    if (fields.reasoningEffort !== undefined) patch.runtimeConfigPatch = { reasoningEffort: fields.reasoningEffort };
  } else if (runtimeOwnsConfiguration && !writesOrdinaryProviderDefault) {
    const next: Partial<RuntimeConfig> = {};
    if (fields.permissionMode !== undefined) next.permissionMode = fields.permissionMode;
    if (fields.runtimeModel !== undefined) next.model = fields.runtimeModel ?? undefined;
    if (fields.reasoningEffort !== undefined) next.reasoningEffort = fields.reasoningEffort;
    if (Object.keys(next).length > 0) patch.runtimeConfigPatch = next;
  } else {
    if (fields.permissionMode !== undefined) patch.permissionMode = fields.permissionMode as PermissionMode;
    if (fields.builtinSelection !== undefined) patch.model = fields.builtinSelection.model;
    else if (fields.builtinModel !== undefined) patch.model = fields.builtinModel ?? undefined;
    if (fields.reasoningEffort !== undefined) patch.reasoningEffort = fields.reasoningEffort;
  }
  return patch;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
