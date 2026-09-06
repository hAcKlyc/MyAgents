import { describe, expect, it } from 'vitest';
import { mergePresetCustomModels, PRESET_PROVIDERS } from './config-types';
import {
  formatTokenDanceBalance,
  MODEL_PROTOCOL_PRIORITY,
  parseSupportedProtocols,
  resolveProviderForModel,
  TOKENDANCE_PROVIDER_ID,
} from './tokendance';

const provider = PRESET_PROVIDERS.find((p) => p.id === TOKENDANCE_PROVIDER_ID)!;

describe('Token Dance model transport contract', () => {
  it('prefers Anthropic, then Responses, then Chat for every capability subset', () => {
    for (let mask = 1; mask < 8; mask++) {
      const capabilities = MODEL_PROTOCOL_PRIORITY.filter(
        (_, index) => mask & (1 << index),
      );
      const projection = resolveProviderForModel(
        {
          ...provider,
          models: [
            {
              model: 'added',
              modelName: 'Added',
              modelSeries: 'test',
              supportedProtocols: [...capabilities].reverse(),
            },
          ],
        },
        'added',
      );
      expect(projection.apiProtocol).toBe(
        capabilities[0] === 'anthropic:messages' ? 'anthropic' : 'openai',
      );
      expect(projection.upstreamFormat).toBe(
        capabilities[0] === 'anthropic:messages'
          ? undefined
          : capabilities[0] === 'openai:responses'
            ? 'responses'
            : 'chat_completions',
      );
      expect(projection.config.baseUrl).toBe(
        capabilities[0] === 'anthropic:messages'
          ? 'https://tokendance.space/gateway'
          : 'https://tokendance.space/gateway/v1',
      );
      expect(projection.authType).toBe('api_key');
    }
  });

  it('lets fresh capabilities override a bundled snapshot without changing curated names or mutating the provider', () => {
    const before = JSON.stringify(provider);
    const bundled = provider.models[0];
    const restored = mergePresetCustomModels([provider], {
      tokendance: [
        {
          ...bundled,
          modelName: 'Catalog name',
          supportedProtocols: ['openai:responses'],
          source: 'discovered',
        },
      ],
    })[0];
    expect(restored.models[0].modelName).toBe(bundled.modelName);
    expect(
      resolveProviderForModel(restored, bundled.model).upstreamFormat,
    ).toBe('responses');
    expect(JSON.stringify(provider)).toBe(before);
  });

  it('rejects missing/unknown capabilities and does not borrow the provider default protocol', () => {
    expect(parseSupportedProtocols(undefined)).toBeUndefined();
    expect(parseSupportedProtocols(['new:unsupported'])).toEqual([]);
    const model = { ...provider.models[0], supportedProtocols: [] };
    expect(() =>
      resolveProviderForModel({ ...provider, models: [model] }, model.model),
    ).toThrow('Refresh the model catalog');
    expect(() => resolveProviderForModel(provider, 'not-in-catalog')).toThrow(
      'no known supported',
    );
    const ordinary = PRESET_PROVIDERS.find((p) => p.id === 'anthropic-api')!;
    expect(resolveProviderForModel(ordinary, 'unknown')).toBe(ordinary);
  });

  it('ships the accepted 13-model snapshot and three usable transport families', () => {
    expect(provider.models).toHaveLength(13);
    const projections = provider.models.map((m) =>
      resolveProviderForModel(provider, m.model),
    );
    expect(
      projections.filter((p) => p.apiProtocol === 'anthropic'),
    ).toHaveLength(8);
    expect(
      projections.filter((p) => p.upstreamFormat === 'responses'),
    ).toHaveLength(3);
    expect(
      projections.filter((p) => p.upstreamFormat === 'chat_completions'),
    ).toHaveLength(2);
  });
});

describe('Token Dance balance presentation', () => {
  it.each([
    [0, '0.00'],
    [1, '0.00'],
    [9999, '0.00'],
    [10000, '0.01'],
    [48760000, '48.76'],
    [-1200000, '-1.20'],
  ])('formats raw microyuan %s as %s', (value, display) => {
    expect(formatTokenDanceBalance(value)).toBe(display);
  });
});
