import { describe, expect, it } from 'vitest';

import { MANAGED_CODEX_PROVIDER, PRESET_PROVIDERS, type Provider } from '@/config/types';
import {
  isProviderModelCompatibleWithRuntime,
  projectProvidersForRuntime,
} from './runtimeProviderProjection';

function provider(id: string, primaryModel: string, models: string[]): Provider {
  return {
    id,
    name: id,
    vendor: id,
    cloudProvider: 'test',
    type: 'api',
    isBuiltin: false,
    authType: 'api_key',
    apiProtocol: 'openai',
    upstreamFormat: 'chat_completions',
    enabled: true,
    primaryModel,
    models: models.map((model) => ({ model, modelName: model, modelSeries: id })),
    config: { baseUrl: 'https://example.test' },
  };
}

describe('runtime Provider projection', () => {
  it('keeps a saved official Claude provider selectable on a DSH base', () => {
    const official = provider('anthropic-sub', 'claude-example', ['claude-example']);
    expect(projectProvidersForRuntime([official], 'dsh', official.id)).toEqual([official]);
    expect(projectProvidersForRuntime([official], 'dsh', 'deepseek')).toEqual([]);
  });
  it('shows API transports in DSH while keeping both official Claude choices on the SDK', () => {
    const ids = ['anthropic-sub', 'anthropic-api', 'xai-sub', 'antigravity-sub', 'deepseek'];
    const presets = PRESET_PROVIDERS.filter(candidate => ids.includes(candidate.id));
    expect(projectProvidersForRuntime(presets, 'dsh').map(candidate => candidate.id))
      .toEqual(['xai-sub', 'antigravity-sub', 'deepseek']);
    expect(projectProvidersForRuntime(presets, 'builtin').map(candidate => candidate.id))
      .toEqual(presets.map(candidate => candidate.id));
  });
  it('keeps every ordinary API Provider and all of its configured models', () => {
    const projected = projectProvidersForRuntime([
      provider('deepseek', 'deepseek-v4-pro', ['deepseek-v4-pro', 'deepseek-v4-flash']),
      provider('openrouter', 'anthropic/claude', ['anthropic/claude']),
    ], 'dsh');

    expect(projected).toHaveLength(2);
    expect(projected[0].models?.map((model) => model.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
    expect(projected[1].models?.map((model) => model.model)).toEqual(['anthropic/claude']);
  });

  it('uses Product Provider/model membership without restricting Builtin', () => {
    const openrouter = provider('openrouter', 'claude', ['claude', 'future-model']);
    expect(isProviderModelCompatibleWithRuntime('dsh', openrouter, 'claude')).toBe(true);
    expect(isProviderModelCompatibleWithRuntime('dsh', openrouter, 'missing')).toBe(false);
    expect(isProviderModelCompatibleWithRuntime('builtin', openrouter, 'missing')).toBe(true);
  });

  it('keeps Managed Codex as a runtime-backed choice without admitting it as a DSH cell', () => {
    const managedCodex = {
      ...MANAGED_CODEX_PROVIDER,
      primaryModel: 'gpt-5.4-codex',
      models: [{
        model: 'gpt-5.4-codex',
        modelName: 'GPT-5.4 Codex',
        modelSeries: 'codex',
      }],
    };

    expect(projectProvidersForRuntime([managedCodex], 'dsh')).toEqual([managedCodex]);
    expect(isProviderModelCompatibleWithRuntime('dsh', managedCodex, 'gpt-5.4-codex')).toBe(true);
  });
});
