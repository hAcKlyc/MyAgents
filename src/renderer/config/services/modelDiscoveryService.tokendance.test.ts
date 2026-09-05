import { describe, expect, it, vi } from 'vitest';
import { mergePresetCustomModels, PRESET_PROVIDERS } from '../types';
import { resolveProviderForModel } from '../../../shared/tokendance';
import {
  fetchProviderModels,
  parseModelsResponse,
  toModelEntity,
} from './modelDiscoveryService';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const provider = PRESET_PROVIDERS.find((p) => p.id === 'tokendance')!;
describe('Token Dance public model discovery', () => {
  it('preserves protocol metadata through discovery, user editing and disk JSON reload', () => {
    const discovered = parseModelsResponse({
      data: [
        {
          id: 'future-model',
          name: 'Future Model',
          context_length: 123456,
          supported_protocols: ['openai:chat-completions', 'openai:responses'],
        },
      ],
    });
    const model = {
      ...toModelEntity(discovered[0], provider),
      modelName: 'My model',
      source: 'manual' as const,
    };
    const config = JSON.parse(
      JSON.stringify({ presetCustomModels: { tokendance: [model] } }),
    );
    const restored = mergePresetCustomModels(
      [provider],
      config.presetCustomModels,
    )[0];
    expect(
      restored.models.find((m) => m.model === model.model)?.modelName,
    ).toBe('My model');
    expect(resolveProviderForModel(restored, model.model).upstreamFormat).toBe(
      'responses',
    );
  });

  it('fetches the public catalog without sending an API key', async () => {
    vi.mocked(invoke).mockResolvedValue({ data: [] });
    await fetchProviderModels(provider, 'should-not-be-sent');
    expect(invoke).toHaveBeenCalledWith(
      'cmd_fetch_provider_models',
      expect.objectContaining({
        url: 'https://tokendance.space/gateway/v1/models',
        authHeaderName: null,
        authHeaderValue: null,
      }),
    );
  });
});
