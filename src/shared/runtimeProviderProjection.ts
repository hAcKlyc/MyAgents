import { ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID, CODEX_SUBSCRIPTION_PROVIDER_ID, type Provider } from './config-types';
import {
  getProviderExecutionConstraint,
  isDshModelSelectable,
  isDshProviderEligible,
  providerRequiresClaudeSdk,
} from './integrated-runtimes/provider-constraints';
import { isRuntimeBackedProvider, isRuntimeBackedProviderId } from './providerExecution';
import type { RuntimeType, RuntimeSource } from './types/runtime';
import { resolveAgentRuntimePreference } from './integrated-runtimes/identity';
import { AGENT_RUNTIME_DISTRIBUTION_POLICY, resolveDefaultIntegratedRuntime } from './integrated-runtimes/distribution-policy';

const LINUX_HIDDEN_PROVIDER_IDS = [CODEX_SUBSCRIPTION_PROVIDER_ID, ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID];
export function platformHiddenProviderIds(platform: string): readonly string[] {
  return platform === 'linux' || platform.startsWith('linux-') ? LINUX_HIDDEN_PROVIDER_IDS : [];
}

/** Project Product Provider choices through the selected Runtime's execution owners. */
export function projectProvidersForRuntime(
  providers: readonly Provider[],
  runtime: RuntimeType,
  selectedProviderId?: string | null,
): Provider[] {
  if (runtime !== 'dsh') return [...providers];
  return providers.filter((provider) => {
    // Keep a selected fixed-owner model across a base change. It runs with its own executor.
    return isRuntimeBackedProvider(provider)
      || (provider.id === selectedProviderId && providerRequiresClaudeSdk(provider.id))
      || isDshProviderEligible(provider);
  });
}

export function isProviderModelCompatibleWithRuntime(
  runtime: RuntimeType,
  provider: Provider | undefined,
  model: string | undefined,
): boolean {
  if (runtime !== 'dsh') return true;
  if (isRuntimeBackedProviderId(provider?.id)) return !!model;
  return !!provider && isDshModelSelectable(provider, model);
}

/**
 * Resolve the Integrated Runtime to return to when the current Session is a
 * runtime-backed Provider. A live Integrated Session wins; otherwise the
 * Agent's authoritative preference preserves the base Runtime selected before
 * entering Managed Codex. Official Claude routes still go to their declared
 * Integrated owner.
 */
export function resolveProviderSwitchIntegratedRuntime(args: {
  targetProvider: Provider;
  currentSessionRuntime: RuntimeType;
  agentRuntimePreference?: unknown;
  legacyAgentRuntime?: RuntimeType;
  legacyAgentRuntimeSource?: RuntimeSource;
  legacyAgentProviderId?: string;
  configuredDefaultIntegratedRuntime?: unknown;
}): 'builtin' | 'dsh' {
  const constraint = getProviderExecutionConstraint(args.targetProvider);
  if (constraint.kind === 'requires-integrated-runtime') return 'builtin';

  if (args.currentSessionRuntime === 'builtin' || args.currentSessionRuntime === 'dsh') {
    return args.currentSessionRuntime;
  }

  const preference = resolveAgentRuntimePreference({
    runtimePreference: args.agentRuntimePreference,
    runtime: args.legacyAgentRuntime,
    runtimeSource: args.legacyAgentRuntimeSource,
    providerId: args.legacyAgentProviderId,
    defaultIntegratedRuntime: resolveDefaultIntegratedRuntime(AGENT_RUNTIME_DISTRIBUTION_POLICY, args.configuredDefaultIntegratedRuntime),
  });
  if (preference?.family !== 'integrated') return 'builtin';
  return preference.id === 'dsh' ? 'dsh' : 'builtin';
}
