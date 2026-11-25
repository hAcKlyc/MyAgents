import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  isProjectArchived,
  isProjectVisibleToUser,
  type Provider,
} from '../../shared/config-types';
import {
  isDshModelSelectable,
  isDshProviderEligible,
  providerRequiresClaudeSdk,
} from '../../shared/integrated-runtimes/provider-constraints';
import {
  agentUsesManagedCodexProvider,
  managedCodexProviderPermissionToRuntimePermission,
} from '../../shared/providerExecution';
import {
  REASONING_EFFORT_DEFAULT,
  normalizeReasoningEffort,
  reasoningEffortChoices,
} from '../../shared/reasoningEffort';
import {
  resolveSessionStartPermissionMode,
  type SessionBirthOverrides,
} from '../../shared/sessionPermissionCeiling';
import {
  VALID_RUNTIMES,
  getDefaultRuntimePermissionMode,
  modelLooksLikeRuntime,
  projectPermissionModeForRuntime,
  resolveEffectiveRuntime,
  runtimeSourceForRuntimeType,
  type RuntimeConfig,
  type RuntimeModelInfo,
  type RuntimeSource,
  type RuntimeType,
} from '../../shared/types/runtime';
import {
  getAllEffectiveProviders,
  getProviderSelectionError,
  type AdminAppConfig,
  type AgentConfigSlim,
  type ProjectSlim,
} from '../utils/admin-config';
import { isManagedCodexProviderReady } from '../utils/managed-codex-readiness';
import {
  agentWorkspaceIdentityFailure,
  resolvePersistedAgentWorkspaceRegistry,
} from '../utils/agent-workspace-identity';
import { cancellableFetch } from '../utils/cancellation';
import { managementRequestHeaders } from '../utils/management-api-client';
import { isManagedCodexRuntimeInstalled } from '../runtimes/codex-command-context';
import { queryRuntimeModels } from '../runtimes/external-session';
import { getExternalRuntime, isRuntimeSupported } from '../runtimes/factory';
import { getSessionMetadata } from '../SessionStore';
import { deriveCallerInboxLabel } from './admin-handler';

export interface AdminSessionStartRequest extends Record<string, unknown> {
  agentId?: unknown;
  prompt?: unknown;
  replyBack?: unknown;
  runtime?: unknown;
  providerId?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  permissionMode?: unknown;
}

export interface SessionStartEffectiveConfig {
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: string;
}

export interface AdminSessionStartResponse extends Record<string, unknown> {
  accepted: boolean | null;
  asynchronous?: boolean;
  agentId?: string;
  sessionId?: string;
  messageId?: string;
  replyBack?: boolean;
  resultDelivery?: 'send.result';
  effectiveConfig?: SessionStartEffectiveConfig;
  unconfirmed?: boolean;
  error?: { code: string; message: string };
  recoveryHint?: { recoveryCommand?: string; message: string };
}

interface RustFreshStartOutcome {
  status: 'accepted' | 'rejected' | 'unconfirmed' | 'delivery_failed';
  agentId: string;
  sessionId: string;
  messageId: string;
  replyBack: boolean;
  reason?: string;
}

function isFreshStartOutcome(value: unknown): value is RustFreshStartOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const outcome = value as Record<string, unknown>;
  return (
    ['accepted', 'rejected', 'unconfirmed', 'delivery_failed'].includes(String(outcome.status))
    && typeof outcome.agentId === 'string'
    && typeof outcome.sessionId === 'string'
    && typeof outcome.messageId === 'string'
    && typeof outcome.replyBack === 'boolean'
  );
}

/**
 * Capability & internal transport fields that a caller is NEVER allowed to
 * override on `session start`. One-shot execution fields (`runtime`,
 * `providerId`, `model`, `reasoningEffort`, `permissionMode`) are permitted for
 * local Agents under the target Agent's permission ceiling and written solely
 * to the new Session's birth snapshot.
 */
const FORBIDDEN_OVERRIDE_FIELDS = [
  'runtimeSource',
  'runtimeConfig',
  'mcpEnabledServers',
  'enabledPluginIds',
  'enabledOfficialToolIds',
] as const;

const ALLOWED_OVERRIDE_FIELDS = [
  'runtime',
  'providerId',
  'model',
  'reasoningEffort',
  'permissionMode',
] as const;

interface TargetAgentEffectiveDefaults {
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  usesManagedCodex: boolean;
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: string;
}

function resolveTargetAgentDefaults(
  agent: AgentConfigSlim,
  project: ProjectSlim | undefined,
  config: AdminAppConfig,
): TargetAgentEffectiveDefaults {
  const storedRuntime = typeof agent.runtime === 'string'
    ? (agent.runtime as RuntimeType)
    : undefined;
  const runtimeConfig =
    agent.runtimeConfig && typeof agent.runtimeConfig === 'object' && !Array.isArray(agent.runtimeConfig)
      ? (agent.runtimeConfig as RuntimeConfig)
      : undefined;
  const rawUsesManagedCodex = agentUsesManagedCodexProvider({
    runtimePreference: agent.runtimePreference,
    providerId: typeof agent.providerId === 'string' ? agent.providerId : undefined,
    runtime: storedRuntime,
    runtimeConfig,
  });
  const preferredRuntime = resolveEffectiveRuntime(
    storedRuntime,
    agent.runtimePreference,
    runtimeConfig?.source,
    agent.providerId,
    undefined,
    config.defaultIntegratedRuntime,
  );
  const usesManagedCodex = preferredRuntime === 'builtin' && rawUsesManagedCodex;
  const runtime: RuntimeType = usesManagedCodex ? 'codex' : preferredRuntime;
  const runtimeSource = runtime === 'builtin'
    ? undefined
    : runtimeSourceForRuntimeType(runtime, usesManagedCodex ? 'managed-provider' : undefined);
  const usesExternalCli =
    runtime === 'claude-code'
    || runtime === 'antigravity'
    || (runtime === 'codex' && !usesManagedCodex);
  const rawAgentPermission =
    typeof agent.permissionMode === 'string' && agent.permissionMode.trim()
      ? agent.permissionMode.trim()
      : undefined;
  const rawProjectPermission =
    typeof project?.permissionMode === 'string' && project.permissionMode.trim()
      ? project.permissionMode.trim()
      : undefined;
  const globalDefaultPermission =
    typeof config.defaultPermissionMode === 'string' && config.defaultPermissionMode.trim()
      ? config.defaultPermissionMode.trim()
      : undefined;
  const effectiveProductPermission =
    rawAgentPermission ?? rawProjectPermission ?? globalDefaultPermission;
  const permissionMode = usesManagedCodex
    ? (managedCodexProviderPermissionToRuntimePermission(effectiveProductPermission) ?? 'auto-edit')
    : usesExternalCli
      ? (projectPermissionModeForRuntime(runtimeConfig?.permissionMode, runtime) ?? getDefaultRuntimePermissionMode(runtime))
      : (projectPermissionModeForRuntime(rawAgentPermission, runtime)
        ?? projectPermissionModeForRuntime(rawProjectPermission, runtime)
        ?? projectPermissionModeForRuntime(globalDefaultPermission, runtime)
        ?? getDefaultRuntimePermissionMode(runtime));
  const providerId = !usesExternalCli
    ? (typeof agent.providerId === 'string' && agent.providerId.trim()
      ? agent.providerId.trim()
      : (typeof config.defaultProviderId === 'string' && config.defaultProviderId.trim()
        ? config.defaultProviderId.trim()
        : undefined))
    : undefined;
  const model = usesManagedCodex
    ? (typeof agent.model === 'string' && agent.model.trim() ? agent.model.trim() : undefined)
    : usesExternalCli
      ? (typeof runtimeConfig?.model === 'string' && runtimeConfig.model.trim() ? runtimeConfig.model.trim() : undefined)
      : (typeof agent.model === 'string' && agent.model.trim() ? agent.model.trim() : undefined);
  const reasoningEffort = usesExternalCli || usesManagedCodex
    ? (typeof runtimeConfig?.reasoningEffort === 'string' && runtimeConfig.reasoningEffort.trim()
      ? runtimeConfig.reasoningEffort.trim()
      : undefined)
    : (typeof agent.reasoningEffort === 'string' && agent.reasoningEffort.trim()
      ? agent.reasoningEffort.trim()
      : undefined);

  return {
    runtime,
    runtimeSource,
    usesManagedCodex,
    providerId,
    model,
    reasoningEffort,
    permissionMode,
  };
}

function invalidOverrideError(
  code: string,
  message: string,
  recoveryHint?: { recoveryCommand?: string; message: string },
): { status: number; response: AdminSessionStartResponse } {
  return {
    status: 400,
    response: {
      accepted: false,
      error: { code, message },
      ...(recoveryHint ? { recoveryHint } : {}),
    },
  };
}

const RUNTIME_DETECT_TIMEOUT_MS = 5_000;

async function isRuntimeInstalledForStart(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): Promise<boolean> {
  if (runtime === 'builtin') return true;
  if (runtime === 'codex' && runtimeSource === 'managed-provider') {
    return isManagedCodexRuntimeInstalled();
  }
  if (!isRuntimeSupported(runtime)) return false;
  try {
    const rt = getExternalRuntime(runtime);
    const detection = await Promise.race([
      rt.detect(),
      new Promise<{ installed: boolean }>((resolve) =>
        setTimeout(() => resolve({ installed: false }), RUNTIME_DETECT_TIMEOUT_MS),
      ),
    ]);
    return detection.installed === true;
  } catch {
    return false;
  }
}

async function validateExternalModelForStart(
  model: string,
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): Promise<{ status: number; response: AdminSessionStartResponse } | null> {
  if (!modelLooksLikeRuntime(model, runtime)) {
    return invalidOverrideError(
      'INVALID_MODEL',
      `Model '${model}' does not belong to runtime '${runtime}'.`,
      {
        recoveryCommand: `myagents runtime describe ${runtime}`,
        message: 'See valid model IDs for this runtime.',
      },
    );
  }
  try {
    const models = (await queryRuntimeModels(runtime, {
      runtimeSource,
    })) as RuntimeModelInfo[];
    if (models.length > 0 && !models.some((candidate) => candidate.value === model)) {
      const examples = models
        .slice(0, 5)
        .map((candidate) => candidate.value)
        .filter(Boolean)
        .join(', ');
      return invalidOverrideError(
        'INVALID_MODEL',
        `Model '${model}' is not available for runtime '${runtime}'. Examples: ${examples || '(none found)'}.`,
        {
          recoveryCommand: `myagents runtime describe ${runtime}`,
          message: 'See the full model list for this runtime.',
        },
      );
    }
  } catch {
    // Transient discovery failure does not mask an otherwise plausible model id.
  }
  return null;
}

export async function handleAdminSessionStart(
  callerSessionId: string,
  body: AdminSessionStartRequest,
  sourceKind: 'internal-session' | 'external-cli',
): Promise<{ status: number; response: AdminSessionStartResponse }> {
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (sourceKind === 'internal-session' && !callerSessionId) {
    return {
      status: 400,
      response: {
        accepted: false,
        error: {
          code: 'caller_session_required',
          message: 'session start must run from an initialized MyAgents Session',
        },
      },
    };
  }
  if (!agentId || !prompt) {
    return {
      status: 400,
      response: {
        accepted: false,
        error: { code: 'invalid_args', message: 'agentId and prompt are required' },
      },
    };
  }
  const forbidden = FORBIDDEN_OVERRIDE_FIELDS.find(field => body[field] !== undefined);
  if (forbidden) {
    return {
      status: 400,
      response: {
        accepted: false,
        error: {
          code: 'target_config_override_forbidden',
          message: `session start does not accept caller override '${forbidden}'; the target Agent owns capability configuration`,
        },
      },
    };
  }

  // Validate string shape of allowed one-shot override fields before IO.
  const rawOverrides: Partial<Record<(typeof ALLOWED_OVERRIDE_FIELDS)[number], string>> = {};
  for (const field of ALLOWED_OVERRIDE_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) {
      return invalidOverrideError('invalid_args', `--${field} must be a non-empty string`);
    }
    rawOverrides[field] = value.trim();
  }
  const hasAnyOverride = Object.keys(rawOverrides).length > 0;

  // Defense in depth: network routing intercepts ma-agent:1 references before
  // reaching this handler, but never allow remote references with overrides.
  if (hasAnyOverride && agentId.startsWith('ma-agent:')) {
    return invalidOverrideError(
      'REMOTE_TARGET_CONFIG_OVERRIDE_FORBIDDEN',
      'Remote network Agents do not accept caller configuration overrides; omit --runtime/--providerId/--model/--reasoningEffort/--permissionMode.',
    );
  }

  let registry: Awaited<ReturnType<typeof resolvePersistedAgentWorkspaceRegistry>>;
  try {
    registry = await resolvePersistedAgentWorkspaceRegistry();
  } catch (error) {
    const failure = agentWorkspaceIdentityFailure(error);
    return {
      status: 409,
      response: {
        accepted: false,
        error: { code: failure.code ?? 'agent_identity_conflict', message: failure.error },
      },
    };
  }
  const diagnostic = registry.diagnostics.find(item => item.agentIds.includes(agentId));
  if (diagnostic) {
    return {
      status: 409,
      response: {
        accepted: false,
        agentId,
        error: { code: diagnostic.code, message: diagnostic.message },
      },
    };
  }
  const identity = registry.agentProjections.find(item => item.agentId === agentId);
  if (!identity || (identity.project && !isProjectVisibleToUser(identity.project))) {
    return {
      status: 404,
      response: {
        accepted: false,
        agentId,
        error: { code: 'agent_not_found', message: `Agent '${agentId}' not found` },
      },
    };
  }
  if (identity.project && isProjectArchived(identity.project)) {
    return {
      status: 409,
      response: {
        accepted: false,
        agentId,
        error: { code: 'agent_archived', message: `Agent '${agentId}' belongs to an archived workspace` },
      },
    };
  }

  const rootConfig = registry.config ?? {};
  const targetDefaults = resolveTargetAgentDefaults(identity.agent, identity.project, rootConfig);

  let birthOverrides: SessionBirthOverrides | undefined;
  let effectiveConfig: SessionStartEffectiveConfig = {
    runtime: targetDefaults.runtime,
    ...(targetDefaults.runtimeSource ? { runtimeSource: targetDefaults.runtimeSource } : {}),
    ...(targetDefaults.providerId ? { providerId: targetDefaults.providerId } : {}),
    ...(targetDefaults.model ? { model: targetDefaults.model } : {}),
    ...(targetDefaults.reasoningEffort ? { reasoningEffort: targetDefaults.reasoningEffort } : {}),
    permissionMode: targetDefaults.permissionMode,
  };

  if (hasAnyOverride) {
    // 1. Validate & resolve requested runtime + runtimeSource
    let requestedRuntime: RuntimeType = targetDefaults.runtime;
    let requestedRuntimeSource: RuntimeSource | undefined = targetDefaults.runtimeSource;
    let usesManagedCodex = targetDefaults.usesManagedCodex;

    if (rawOverrides.runtime !== undefined) {
      if (!VALID_RUNTIMES.includes(rawOverrides.runtime as RuntimeType)) {
        return invalidOverrideError(
          'INVALID_RUNTIME',
          `Unknown runtime '${rawOverrides.runtime}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,
          { recoveryCommand: 'myagents runtime list', message: 'See valid runtimes and install status.' },
        );
      }
      requestedRuntime = rawOverrides.runtime as RuntimeType;
      usesManagedCodex = false;
      requestedRuntimeSource = requestedRuntime === 'builtin'
        ? undefined
        : runtimeSourceForRuntimeType(requestedRuntime);
    }

    // Handle --providerId compatibility with runtime (strict fail closed on external system-cli)
    const isExternalCliRequested =
      requestedRuntime === 'claude-code'
      || requestedRuntime === 'antigravity'
      || (requestedRuntime === 'codex' && !usesManagedCodex);

    if (rawOverrides.providerId !== undefined) {
      if (rawOverrides.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
        if (
          rawOverrides.runtime !== undefined
          && rawOverrides.runtime !== 'builtin'
        ) {
          return invalidOverrideError(
            'PROVIDER_NOT_SUPPORTED_FOR_RUNTIME',
            `Provider '${CODEX_SUBSCRIPTION_PROVIDER_ID}' cannot be combined with --runtime '${rawOverrides.runtime}'. Omit --runtime (or use --runtime builtin) to run Managed Codex.`,
            { recoveryCommand: 'myagents model list', message: 'Inspect configured providers.' },
          );
        }
        requestedRuntime = 'codex';
        requestedRuntimeSource = 'managed-provider';
        usesManagedCodex = true;
      } else if (isExternalCliRequested) {
        return invalidOverrideError(
          'PROVIDER_NOT_SUPPORTED_FOR_RUNTIME',
          `Runtime '${requestedRuntime}' uses its own login and cannot be combined with --providerId. Pass --runtime builtin or --runtime dsh explicitly to use a Provider catalog entry.`,
          {
            recoveryCommand: `myagents runtime describe ${requestedRuntime}`,
            message: 'Inspect models supported directly by this runtime.',
          },
        );
      } else if (usesManagedCodex && rawOverrides.runtime === undefined) {
        // Switching away from Managed Codex to an integrated API provider without explicit --runtime
        return invalidOverrideError(
          'PROVIDER_NOT_SUPPORTED_FOR_RUNTIME',
          `Target Agent uses Managed Codex; pass --runtime builtin or --runtime dsh explicitly alongside --providerId '${rawOverrides.providerId}'.`,
          { recoveryCommand: 'myagents model list', message: 'Choose a runtime and provider together.' },
        );
      }
    }

    const effectiveIsIntegrated = requestedRuntime === 'builtin' || requestedRuntime === 'dsh';
    const effectiveIsExternalCli = !effectiveIsIntegrated && !usesManagedCodex;

    // 2. Check runtime installation & Managed Codex readiness before Sidecar startup
    const runtimeChanged =
      requestedRuntime !== targetDefaults.runtime
      || requestedRuntimeSource !== targetDefaults.runtimeSource;
    if (usesManagedCodex) {
      if (!isManagedCodexProviderReady(rootConfig)) {
        return invalidOverrideError(
          'PROVIDER_NOT_READY',
          `Provider '${CODEX_SUBSCRIPTION_PROVIDER_ID}' is not ready (sign in or verify Codex subscription first).`,
          { recoveryCommand: 'myagents model list', message: 'Inspect configured providers.' },
        );
      }
      const installed = await isRuntimeInstalledForStart('codex', 'managed-provider');
      if (!installed) {
        return invalidOverrideError(
          'RUNTIME_NOT_INSTALLED',
          'Managed Codex runtime is not installed on this machine.',
          { recoveryCommand: 'myagents runtime list', message: 'See installed runtimes and install hints.' },
        );
      }
    } else if (rawOverrides.runtime !== undefined || runtimeChanged) {
      const installed = await isRuntimeInstalledForStart(requestedRuntime, requestedRuntimeSource);
      if (!installed) {
        return invalidOverrideError(
          'RUNTIME_NOT_INSTALLED',
          `Runtime '${requestedRuntime}' is not installed on this machine.`,
          { recoveryCommand: 'myagents runtime list', message: 'See installed runtimes and install hints.' },
        );
      }
    }

    // 3. Validate provider & model
    let effectiveProviderId: string | undefined;
    let effectiveModel: string | undefined;
    let effectiveProviderProtocol: 'anthropic' | 'openai' | undefined;
    let effectiveProviderBaseUrl: string | undefined;

    if (usesManagedCodex) {
      effectiveProviderId = CODEX_SUBSCRIPTION_PROVIDER_ID;
      effectiveModel = rawOverrides.model ?? (targetDefaults.usesManagedCodex ? targetDefaults.model : undefined);
      if (!effectiveModel) {
        return invalidOverrideError(
          'MODEL_REQUIRED',
          `Provider '${CODEX_SUBSCRIPTION_PROVIDER_ID}' requires --model.`,
          { recoveryCommand: 'myagents runtime describe codex', message: 'See valid Codex models.' },
        );
      }
      if (rawOverrides.model !== undefined) {
        const modelErr = await validateExternalModelForStart(
          rawOverrides.model,
          'codex',
          'managed-provider',
        );
        if (modelErr) return modelErr;
      }
    } else if (effectiveIsIntegrated) {
      effectiveProviderId = rawOverrides.providerId
        ?? (targetDefaults.runtime === 'builtin' || targetDefaults.runtime === 'dsh'
          ? targetDefaults.providerId
          : (typeof rootConfig.defaultProviderId === 'string' && rootConfig.defaultProviderId.trim()
            ? rootConfig.defaultProviderId.trim()
            : undefined));
      if (effectiveProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
        return invalidOverrideError(
          'PROVIDER_NOT_SUPPORTED_FOR_RUNTIME',
          `Provider '${CODEX_SUBSCRIPTION_PROVIDER_ID}' is runtime-backed Managed Codex and cannot execute on '${requestedRuntime}'. Pass an API/subscription --providerId explicitly.`,
          { recoveryCommand: 'myagents model list', message: 'Choose a provider compatible with this runtime.' },
        );
      }
      const allProviders = getAllEffectiveProviders(rootConfig);
      const selectedProvider = effectiveProviderId
        ? allProviders.find(candidate => candidate.id === effectiveProviderId)
        : undefined;
      if (rawOverrides.providerId !== undefined || rawOverrides.model !== undefined || runtimeChanged) {
        if (!selectedProvider) {
          return invalidOverrideError(
            'UNKNOWN_PROVIDER',
            effectiveProviderId
              ? `Unknown providerId '${effectiveProviderId}'.`
              : `No active provider configured for runtime '${requestedRuntime}'; pass --providerId <id>.`,
            { recoveryCommand: 'myagents model list', message: 'Inspect configured providers and models.' },
          );
        }
        const selectionError = getProviderSelectionError(selectedProvider, rootConfig);
        if (selectionError) {
          return invalidOverrideError(
            'PROVIDER_NOT_READY',
            selectionError,
            { recoveryCommand: 'myagents model list', message: 'Inspect provider readiness.' },
          );
        }
        if (requestedRuntime === 'dsh') {
          if (
            providerRequiresClaudeSdk(selectedProvider.id)
            || !isDshProviderEligible(selectedProvider as unknown as Provider)
          ) {
            return invalidOverrideError(
              'PROVIDER_NOT_SUPPORTED_FOR_RUNTIME',
              `Provider '${selectedProvider.id}' cannot run on runtime 'dsh'. Choose an enabled ordinary API provider or pass --runtime builtin.`,
              { recoveryCommand: 'myagents model list', message: 'Inspect DSH-compatible providers.' },
            );
          }
        }
      }
      // `apiProtocol` is a top-level field on Provider (fallback to nested config for defensive compat).
      const selectedProviderRecord = selectedProvider as
        | (Record<string, unknown> & { config?: { apiProtocol?: string; baseUrl?: string } })
        | undefined;
      const rawProtocol =
        typeof selectedProviderRecord?.apiProtocol === 'string'
          ? selectedProviderRecord.apiProtocol
          : selectedProviderRecord?.config?.apiProtocol;
      effectiveProviderProtocol = rawProtocol === 'openai' ? 'openai' : 'anthropic';
      effectiveProviderBaseUrl =
        typeof selectedProviderRecord?.config?.baseUrl === 'string'
          ? selectedProviderRecord.config.baseUrl
          : undefined;
      const selectedPrimaryModel =
        typeof selectedProvider?.primaryModel === 'string' && selectedProvider.primaryModel.trim()
          ? selectedProvider.primaryModel.trim()
          : undefined;

      if (rawOverrides.model !== undefined) {
        const catalogModels = Array.isArray(selectedProvider?.models)
          ? selectedProvider.models.map(m => m.model).filter(Boolean)
          : [];
        if (catalogModels.length > 0 && !catalogModels.includes(rawOverrides.model)) {
          return invalidOverrideError(
            'INVALID_MODEL',
            `Model '${rawOverrides.model}' is not in provider '${selectedProvider!.id}' catalog (available: ${catalogModels.join(', ')}).`,
            { recoveryCommand: 'myagents model list', message: 'See valid models for each provider.' },
          );
        }
        effectiveModel = rawOverrides.model;
      } else if (rawOverrides.providerId !== undefined && rawOverrides.providerId !== targetDefaults.providerId) {
        effectiveModel = selectedPrimaryModel;
      } else if (runtimeChanged) {
        effectiveModel = (targetDefaults.runtime === 'builtin' || targetDefaults.runtime === 'dsh')
          ? (targetDefaults.model ?? selectedPrimaryModel)
          : selectedPrimaryModel;
      } else {
        effectiveModel = targetDefaults.model ?? selectedPrimaryModel;
      }

      if (requestedRuntime === 'dsh' && selectedProvider) {
        if (!effectiveModel) {
          return invalidOverrideError(
            'MODEL_REQUIRED',
            `Runtime 'dsh' requires a concrete model for provider '${selectedProvider.id}'; pass --model <modelId>.`,
            { recoveryCommand: 'myagents model list', message: 'Inspect available models for this provider.' },
          );
        }
        if (!isDshModelSelectable(selectedProvider as unknown as Provider, effectiveModel)) {
          return invalidOverrideError(
            'INVALID_MODEL',
            `Provider/model '${selectedProvider.id}/${effectiveModel}' is not an enabled ordinary API route configured for DSH.`,
            { recoveryCommand: 'myagents model list', message: 'Choose a model from an enabled API Provider.' },
          );
        }
      }
    } else if (effectiveIsExternalCli) {
      effectiveProviderId = undefined;
      if (rawOverrides.model !== undefined) {
        const modelErr = await validateExternalModelForStart(
          rawOverrides.model,
          requestedRuntime,
          requestedRuntimeSource,
        );
        if (modelErr) return modelErr;
        effectiveModel = rawOverrides.model;
      } else {
        effectiveModel = !runtimeChanged ? targetDefaults.model : undefined;
      }
    }

    // 4. Validate reasoningEffort using full provider/model/baseUrl context
    let effectiveReasoningEffort: string | undefined = runtimeChanged ? undefined : targetDefaults.reasoningEffort;
    if (rawOverrides.reasoningEffort !== undefined) {
      const requestedEffort = rawOverrides.reasoningEffort;
      if (requestedEffort === REASONING_EFFORT_DEFAULT) {
        effectiveReasoningEffort = REASONING_EFFORT_DEFAULT;
      } else {
        const normalized = normalizeReasoningEffort(requestedEffort);
        const choices = reasoningEffortChoices(
          requestedRuntime,
          effectiveProviderProtocol,
          effectiveProviderId,
          effectiveModel,
          effectiveProviderBaseUrl,
        );
        const openEndedRuntime = requestedRuntime === 'codex' || requestedRuntime === 'antigravity';
        const validChoice =
          normalized !== undefined
          && (openEndedRuntime
            ? true
            : choices !== null && choices.includes(normalized));
        if (!validChoice) {
          const hintList = choices ? choices.join(', ') : null;
          return invalidOverrideError(
            'INVALID_REASONING_EFFORT',
            `Invalid --reasoningEffort '${requestedEffort}' for runtime '${requestedRuntime}'. Valid: default${hintList ? `, ${hintList}` : ''}.`,
          );
        }
        effectiveReasoningEffort = normalized;
      }
    }

    // 5. Enforce cross-runtime 4-tier permission ceiling (aware of managed-provider identity)
    const permissionResolution = resolveSessionStartPermissionMode({
      targetRuntime: targetDefaults.runtime,
      targetRuntimeSource: targetDefaults.runtimeSource,
      targetEffectivePermissionMode: targetDefaults.permissionMode,
      requestedRuntime,
      requestedRuntimeSource,
      requestedPermissionMode: rawOverrides.permissionMode,
    });
    if (!permissionResolution.ok) {
      return invalidOverrideError(
        permissionResolution.code,
        permissionResolution.message,
        {
          recoveryCommand: `myagents runtime describe ${requestedRuntime}`,
          message: 'Inspect valid permission modes for this runtime.',
        },
      );
    }

    birthOverrides = {
      runtime: requestedRuntime,
      ...(requestedRuntimeSource ? { runtimeSource: requestedRuntimeSource } : {}),
      ...(effectiveProviderId !== undefined ? { providerId: effectiveProviderId } : {}),
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      ...(effectiveReasoningEffort !== undefined ? { reasoningEffort: effectiveReasoningEffort } : {}),
      permissionMode: permissionResolution.permissionMode,
    };

    effectiveConfig = {
      runtime: requestedRuntime,
      ...(requestedRuntimeSource ? { runtimeSource: requestedRuntimeSource } : {}),
      ...(effectiveProviderId !== undefined ? { providerId: effectiveProviderId } : {}),
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      ...(effectiveReasoningEffort !== undefined ? { reasoningEffort: effectiveReasoningEffort } : {}),
      permissionMode: permissionResolution.permissionMode,
    };
  }

  const managementPort = process.env.MYAGENTS_MANAGEMENT_PORT;
  if (!managementPort) {
    return {
      status: 502,
      response: {
        accepted: false,
        agentId,
        error: { code: 'delivery_failed', message: 'MYAGENTS_MANAGEMENT_PORT not set' },
      },
    };
  }

  const replyBack =
    sourceKind === 'external-cli' ? false : body.replyBack !== false;
  let response: Response;
  try {
    response = await cancellableFetch(
      `http://127.0.0.1:${managementPort}/api/inbox/start-session`,
      {
        method: 'POST',
        headers: managementRequestHeaders(),
        body: JSON.stringify({
          agentId,
          workspacePath: identity.workspacePath,
          sourceKind,
          ...(sourceKind === 'internal-session'
            ? {
                fromSessionId: callerSessionId,
                fromLabel: await deriveCallerInboxLabel(
                  callerSessionId,
                  getSessionMetadata(callerSessionId) ?? null,
                ),
              }
            : { fromLabel: 'External CLI' }),
          prompt,
          replyBack,
          ...(birthOverrides ? { birthOverrides } : {}),
        }),
      },
      // Rust owns Sidecar startup plus target dispatch acknowledgement. Keep
      // this outer budget above those bounded inner phases so the source does
      // not abandon a still-running Rust operation before it can return IDs.
      { timeoutMs: 180_000 },
    );
  } catch (error) {
    return {
      status: 502,
      response: {
        accepted: null,
        unconfirmed: true,
        agentId,
        error: {
          code: 'admission_unconfirmed',
          message: `admission acknowledgement was not confirmed: ${error instanceof Error ? error.message : String(error)}`,
        },
      },
    };
  }

  const json = (await response.json().catch(() => null)) as {
    ok?: boolean;
    outcome?: RustFreshStartOutcome;
    error?: string;
  } | null;
  if (!response.ok || !json?.ok || !isFreshStartOutcome(json.outcome)) {
    return {
      status: 502,
      response: {
        accepted: null,
        unconfirmed: true,
        agentId,
        error: {
          code: 'admission_unconfirmed',
          message: json?.error ?? `admission acknowledgement was not confirmed (management API ${response.status})`,
        },
      },
    };
  }

  const outcome = json.outcome;
  const receipt = {
    agentId: outcome.agentId,
    sessionId: outcome.sessionId,
    messageId: outcome.messageId,
    replyBack: outcome.replyBack,
  };
  if (outcome.status === 'accepted') {
    return {
      status: 200,
      response: {
        accepted: true,
        asynchronous: true,
        ...receipt,
        ...(outcome.replyBack ? { resultDelivery: 'send.result' as const } : {}),
        effectiveConfig,
      },
    };
  }
  if (outcome.status === 'unconfirmed') {
    return {
      status: 502,
      response: {
        accepted: null,
        unconfirmed: true,
        ...receipt,
        error: {
          code: 'admission_unconfirmed',
          message: outcome.reason ?? 'admission acknowledgement was not confirmed',
        },
        recoveryHint: {
          recoveryCommand: `myagents session list --agent ${agentId}`,
          message: 'Check whether the new Session materialized; do not automatically resend.',
        },
      },
    };
  }
  return {
    status: outcome.status === 'rejected' ? 409 : 502,
    response: {
      accepted: false,
      ...receipt,
      error: {
        code: outcome.status === 'rejected' ? 'rejected' : 'delivery_failed',
        message: outcome.reason ?? 'fresh Session admission failed',
      },
    },
  };
}
