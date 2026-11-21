import { describe, expect, it } from 'vitest';

import type { Provider } from './config-types';
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  MANAGED_CODEX_PROVIDER,
  PRESET_PROVIDERS,
  SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
} from './config-types';
import {
  agentDefaultsForRuntimeBackedProvider,
  agentUsesManagedCodexProvider,
  assertBuiltinExecutionProvider,
  canReuseSessionAcrossProviderExecutionBoundary,
  getProviderExecutionHistoryFamily,
  isAnthropicSubscriptionProviderIntent,
  isPermissionModeForRuntimeIdentity,
  isRuntimeBackedProvider,
  managedCodexProviderPermissionToRuntimePermission,
  managedCodexRuntimePermissionToProviderPermission,
  projectManagedCodexPermissionToRuntime,
  runtimeConfigForRuntimeBackedProvider,
  toProviderExecutionIntent,
} from './providerExecution';

function apiProvider(id: string, model = 'model'): Provider {
  return {
    id,
    name: id,
    vendor: id,
    cloudProvider: id,
    type: 'api',
    primaryModel: model,
    isBuiltin: true,
    config: {},
    models: [{ model, modelName: model, modelSeries: model }],
  };
}

describe('provider execution identity', () => {
  it('materializes API providers as builtin provider routes', () => {
    expect(toProviderExecutionIntent(apiProvider('deepseek', 'deepseek-v4'), 'deepseek-v4')).toEqual({
      kind: 'builtin-provider',
      route: { kind: 'provider', providerId: 'deepseek', model: 'deepseek-v4' },
    });
  });

  it('materializes Managed Codex as a runtime-backed provider identity', () => {
    expect(toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex')).toEqual({
      kind: 'runtime-backed-provider',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      model: 'gpt-5.4-codex',
    });
  });

  it('does not let runtime-backed providers enter builtin ProviderEnv paths', () => {
    expect(isRuntimeBackedProvider(MANAGED_CODEX_PROVIDER)).toBe(true);
    expect(() => assertBuiltinExecutionProvider(MANAGED_CODEX_PROVIDER)).toThrow(/runtime-backed/);
  });

  it('separates session runtime snapshots from agent/provider defaults', () => {
    const intent = toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex');
    if (intent.kind !== 'runtime-backed-provider') throw new Error('expected runtime-backed intent');

    expect(runtimeConfigForRuntimeBackedProvider(intent, {
      envPolicy: { proxy: 'terminal' },
      permissionMode: 'full-auto',
      reasoningEffort: 'xhigh',
      additionalArgs: ['--legacy'],
    })).toEqual({
      envPolicy: { proxy: 'terminal' },
      source: 'managed-provider',
      model: 'gpt-5.4-codex',
    });

    expect(agentDefaultsForRuntimeBackedProvider(intent, {
      envPolicy: { proxy: 'terminal' },
      source: 'system-cli',
      model: 'stale-system-cli-model',
      additionalArgs: ['--legacy'],
      permissionMode: 'suggest',
    }, {
      permissionMode: 'no-restrictions',
    })).toEqual({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'gpt-5.4-codex',
      runtime: 'builtin',
      permissionMode: 'fullAgency',
      runtimeConfig: {
        envPolicy: { proxy: 'terminal' },
      },
    });
  });

  it('maps Managed Codex provider permission semantics onto Codex runtime permissions', () => {
    expect(managedCodexProviderPermissionToRuntimePermission('auto')).toBe('auto-edit');
    expect(managedCodexProviderPermissionToRuntimePermission('plan')).toBe('suggest');
    expect(managedCodexProviderPermissionToRuntimePermission('fullAgency')).toBe('no-restrictions');
    expect(managedCodexProviderPermissionToRuntimePermission('no-restrictions')).toBeUndefined();
    expect(managedCodexProviderPermissionToRuntimePermission('full-auto')).toBeUndefined();

    expect(managedCodexRuntimePermissionToProviderPermission('auto-edit')).toBe('auto');
    expect(managedCodexRuntimePermissionToProviderPermission('suggest')).toBe('plan');
    expect(managedCodexRuntimePermissionToProviderPermission('no-restrictions')).toBe('fullAgency');
    expect(managedCodexRuntimePermissionToProviderPermission('full-auto')).toBeUndefined();

    expect(projectManagedCodexPermissionToRuntime('fullAgency')).toBe('no-restrictions');
    expect(projectManagedCodexPermissionToRuntime('no-restrictions')).toBe('no-restrictions');
    expect(projectManagedCodexPermissionToRuntime('full-auto')).toBeUndefined();
  });

  it('validates permission against the complete runtime identity', () => {
    expect(isPermissionModeForRuntimeIdentity('no-restrictions', 'codex', 'managed-provider')).toBe(true);
    expect(isPermissionModeForRuntimeIdentity('full-auto', 'codex', 'managed-provider')).toBe(false);
    expect(isPermissionModeForRuntimeIdentity('full-auto', 'codex', 'system-cli')).toBe(true);
  });

  it('does not let a dormant managed provider id override an explicit system runtime', () => {
    expect(agentUsesManagedCodexProvider({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, runtime: 'builtin', runtimePreference: { family: 'external', id: 'codex' },
    })).toBe(false);
    expect(agentUsesManagedCodexProvider({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'builtin',
    })).toBe(true);
    expect(agentUsesManagedCodexProvider({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex',
    })).toBe(false);
    expect(agentUsesManagedCodexProvider({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex',
      runtimeConfig: { source: 'managed-provider' },
    })).toBe(true);
    expect(agentUsesManagedCodexProvider({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'claude-code',
      runtimeConfig: { source: 'managed-provider' },
    })).toBe(false);
  });

  it('keeps Anthropic subscription as a builtin subscription provider intent', () => {
    const intent = toProviderExecutionIntent({
      id: SUBSCRIPTION_PROVIDER_ID,
    }, 'claude-sonnet-4-6');

    expect(isAnthropicSubscriptionProviderIntent(intent)).toBe(true);
    expect(intent).toEqual({
      kind: 'builtin-provider',
      route: {
        kind: 'subscription',
        providerId: SUBSCRIPTION_PROVIDER_ID,
        model: 'claude-sonnet-4-6',
      },
    });
  });

  it('keeps Grok subscription on the builtin ProviderRoute path', () => {
    const grok = PRESET_PROVIDERS.find(provider => provider.id === XAI_SUBSCRIPTION_PROVIDER_ID);
    if (!grok) throw new Error('missing Grok preset');
    expect(toProviderExecutionIntent(grok, 'grok-4.5')).toEqual({
      kind: 'builtin-provider',
      route: {
        kind: 'subscription',
        providerId: XAI_SUBSCRIPTION_PROVIDER_ID,
        model: 'grok-4.5',
      },
    });
  });

  it('blocks transcript reuse when entering or leaving Managed Codex', () => {
    const builtin = toProviderExecutionIntent(apiProvider('deepseek', 'deepseek-v4'), 'deepseek-v4');
    const codex = toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex');

    expect(canReuseSessionAcrossProviderExecutionBoundary({
      currentIntent: builtin,
      nextIntent: codex,
      currentProviderEnv: {
        providerId: 'deepseek',
        model: 'deepseek-v4',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiProtocol: 'anthropic',
      },
    })).toBe(false);

    expect(canReuseSessionAcrossProviderExecutionBoundary({
      currentIntent: codex,
      nextIntent: builtin,
      nextProviderEnv: {
        providerId: 'deepseek',
        model: 'deepseek-v4',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiProtocol: 'anthropic',
      },
    })).toBe(false);
  });

  it('allows Managed Codex to change between its own models inside the same session family', () => {
    const currentIntent = toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex');
    const nextIntent = toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.5-codex');

    expect(canReuseSessionAcrossProviderExecutionBoundary({
      currentIntent,
      nextIntent,
    })).toBe(true);
  });

  it('keeps builtin provider reuse delegated to provider history policy', () => {
    const currentIntent = toProviderExecutionIntent(apiProvider('deepseek', 'deepseek-v4'), 'deepseek-v4');
    const nextIntent = toProviderExecutionIntent(apiProvider('zhipu', 'glm-4.6'), 'glm-4.6');

    expect(canReuseSessionAcrossProviderExecutionBoundary({
      currentIntent,
      nextIntent,
      currentProviderEnv: {
        providerId: 'deepseek',
        model: 'deepseek-v4',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiProtocol: 'anthropic',
      },
      nextProviderEnv: {
        providerId: 'zhipu',
        model: 'glm-4.6',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiProtocol: 'anthropic',
      },
    })).toBe(true);
  });

  it('exposes stable history families for diagnostics and future callers', () => {
    const codex = toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex');

    expect(getProviderExecutionHistoryFamily({ intent: codex })).toBe('runtime-backed:codex-sub');
    expect(getProviderExecutionHistoryFamily({ providerHistoryEnv: undefined })).toBe('builtin:anthropic');
    expect(getProviderExecutionHistoryFamily({
      providerHistoryEnv: {
        providerId: 'deepseek',
        model: 'deepseek-v4',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiProtocol: 'anthropic',
      },
    })).toBe('builtin:third-party');
  });
});
