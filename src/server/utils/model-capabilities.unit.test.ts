import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  applyContextWindowSuffix,
  applyContextWindowSuffixForContextLength,
  applyProviderContextWindowSuffix,
  parseLiteLLMCatalog,
  lookupModelContextLength,
  lookupModelCapability,
  modelSupportsModality,
  lookupProviderModelContextLength,
  __resetModelCapabilityCacheForTests,
} from './model-capabilities';

// #1 recurring red line: a >=1M-context model MUST be tagged `[1m]` before it
// reaches SDK ingress, or the SDK silently falls back to the 200K window
// (/context shows 200K, auto-compact fires at ~187K, attachments truncate).
// applyContextWindowSuffix is the single chokepoint. These lock its contract.
//
// Threshold cases lean on bundled PRESET_PROVIDERS (always ingested into the
// registry): claude-opus-4-7 = 1_000_000, claude-sonnet-4-6 = 200_000.
describe('applyContextWindowSuffix — registry-independent guards', () => {
  it('returns undefined for empty / null / undefined (never overwrite a model option with "")', () => {
    expect(applyContextWindowSuffix(undefined)).toBeUndefined();
    expect(applyContextWindowSuffix(null)).toBeUndefined();
    expect(applyContextWindowSuffix('')).toBeUndefined();
  });

  it('leaves an already-[1m]-tagged id untouched (case-insensitive, no double-wrap)', () => {
    expect(applyContextWindowSuffix('foo[1m]')).toBe('foo[1m]');
    expect(applyContextWindowSuffix('claude-opus-4-7[1m]')).toBe('claude-opus-4-7[1m]');
    expect(applyContextWindowSuffix('claude-opus-4-6[1m]')).toBe('claude-opus-4-6[1m]');
    expect(applyContextWindowSuffix('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6[1m]');
    expect(applyContextWindowSuffix('FOO[1M]')).toBe('FOO[1M]'); // matches SDK has1mContext regex
  });

  it('leaves an unregistered model unchanged (no entry → no suffix)', () => {
    expect(applyContextWindowSuffix('totally-made-up-model-xyz')).toBe('totally-made-up-model-xyz');
  });

  it('can decorate from a launch-local context snapshot without re-reading the registry', () => {
    expect(applyContextWindowSuffixForContextLength('Model-X', undefined)).toBe('Model-X');
    expect(applyContextWindowSuffixForContextLength('Model-X', 200_000)).toBe('Model-X');
    expect(applyContextWindowSuffixForContextLength('Model-X', 262_144)).toBe('Model-X[1m]');
    expect(applyContextWindowSuffixForContextLength('Model-X[1m]', undefined)).toBe('Model-X[1m]');
  });

});

describe('applyContextWindowSuffix — threshold via preset registry', () => {
  it('tags default-1M preset models with [1m]', () => {
    expect(applyContextWindowSuffix('claude-sonnet-5-5')).toBe('claude-sonnet-5-5[1m]');
    expect(applyContextWindowSuffix('claude-opus-4-8')).toBe('claude-opus-4-8[1m]');
    expect(applyContextWindowSuffix('claude-opus-4-7')).toBe('claude-opus-4-7[1m]');
  });

  it('does NOT auto-tag 200K wire-default Claude 4.6 models (#392)', () => {
    expect(applyContextWindowSuffix('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(applyContextWindowSuffix('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(applyContextWindowSuffix('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  // #335 — mid-band models (200K < ctx < 1M) MUST be unlocked too. The [1m]
  // suffix is the only lever that raises the SDK window above its 200K
  // default; CLAUDE_CODE_AUTO_COMPACT_WINDOW (injected from the same registry
  // value) then pulls the effective window back to the real limit. Without
  // the wrap, a 512K model's usable window is min(200K, 512K) − 33K ≈ 167K —
  // most of the model's capacity silently wasted.
  it('tags mid-band preset models (>200K, <1M) so the env cap can take effect (#335)', () => {
    // volcengine presets: doubao-seed-2.0-code = 262_144, kimi-k2.5 = 262_144
    expect(applyContextWindowSuffix('doubao-seed-2.0-code')).toBe('doubao-seed-2.0-code[1m]');
    expect(applyContextWindowSuffix('kimi-k2.5')).toBe('kimi-k2.5[1m]');
  });
});

// LiteLLM fallback parser. Shapes mirror the real
// model_prices_and_context_window.json (verified 2026-05: 2748 entries, a
// `sample_spec` doc entry, path-like image_generation keys, provider/model keys).
describe('parseLiteLLMCatalog', () => {
  it('maps max_input_tokens → contextLength and max_output_tokens, tagging source=litellm', () => {
    const m = parseLiteLLMCatalog({
      'gpt-4o': { max_input_tokens: 128000, max_output_tokens: 16384, max_tokens: 16384, litellm_provider: 'openai', mode: 'chat' },
    });
    expect(m.get('gpt-4o')).toEqual({ contextLength: 128000, maxOutputTokens: 16384, source: 'litellm' });
  });

  it('falls back to max_tokens when max_input_tokens is absent', () => {
    const m = parseLiteLLMCatalog({ 'weird-model': { max_tokens: 32000, mode: 'chat' } });
    expect(m.get('weird-model')?.contextLength).toBe(32000);
  });

  it('skips the sample_spec doc entry', () => {
    const m = parseLiteLLMCatalog({
      sample_spec: { max_input_tokens: 999999, max_output_tokens: 1, mode: 'chat' },
      'real-model': { max_input_tokens: 8000, mode: 'chat' },
    });
    expect(m.has('sample_spec')).toBe(false);
    expect(m.get('real-model')?.contextLength).toBe(8000);
  });

  it('filters out non-LLM modes (image_generation / embedding / audio_*) — they would poison the registry', () => {
    const m = parseLiteLLMCatalog({
      '1024-x-1024/50-steps/bedrock/amazon.nova-canvas-v1:0': { max_input_tokens: 2600, mode: 'image_generation' },
      'text-embedding-3-large': { max_input_tokens: 8191, mode: 'embedding' },
      'whisper-1': { max_input_tokens: 0, mode: 'audio_transcription' },
      'gpt-4o': { max_input_tokens: 128000, mode: 'chat' },
    });
    expect(m.has('amazon.nova-canvas-v1:0')).toBe(false);
    expect(m.has('text-embedding-3-large')).toBe(false);
    expect(m.has('whisper-1')).toBe(false);
    expect(m.get('gpt-4o')?.contextLength).toBe(128000);
  });

  it('keeps entries with no mode (some valid text models omit it)', () => {
    const m = parseLiteLLMCatalog({ 'no-mode-model': { max_input_tokens: 65536, max_output_tokens: 8192 } });
    expect(m.get('no-mode-model')?.contextLength).toBe(65536);
  });

  it('indexes provider/model keys under both the full key and the provider-stripped tail', () => {
    const m = parseLiteLLMCatalog({
      'deepseek/deepseek-chat': { max_input_tokens: 131072, max_output_tokens: 8192, mode: 'chat' },
    });
    expect(m.get('deepseek/deepseek-chat')?.contextLength).toBe(131072);
    expect(m.get('deepseek-chat')?.contextLength).toBe(131072); // bare id our presets use
  });

  it('a literal key always beats a provider/model tail collision, regardless of entry order', () => {
    // provider/model listed BEFORE the literal
    const a = parseLiteLLMCatalog({
      'azure/gpt-4': { max_input_tokens: 100, mode: 'chat' },
      'gpt-4': { max_input_tokens: 8192, mode: 'chat' },
    });
    expect(a.get('gpt-4')?.contextLength).toBe(8192); // literal wins, not the 100 tail
    // literal listed BEFORE provider/model
    const b = parseLiteLLMCatalog({
      'gpt-4': { max_input_tokens: 8192, mode: 'chat' },
      'azure/gpt-4': { max_input_tokens: 100, mode: 'chat' },
    });
    expect(b.get('gpt-4')?.contextLength).toBe(8192); // still the literal
  });

  it('uses a case-variant canonical literal instead of an unrelated provider tail (#516)', () => {
    const m = parseLiteLLMCatalog({
      'azure_ai/deepseek-v4-flash': { max_input_tokens: 1_000_000, mode: 'chat' },
      'tensormesh/deepseek-ai/DeepSeek-V4-Flash': { max_input_tokens: 32_768, mode: 'chat' },
      'deepseek-v4-flash': { max_input_tokens: 1_000_000, mode: 'chat' },
    });

    expect(m.get('deepseek-v4-flash')?.contextLength).toBe(1_000_000);
    expect(m.get('DeepSeek-V4-Flash')?.contextLength).toBe(1_000_000);
    expect(m.get('tensormesh/deepseek-ai/DeepSeek-V4-Flash')?.contextLength).toBe(32_768);
  });

  it('does not invent a bare context alias when provider-qualified candidates disagree and no literal exists', () => {
    const m = parseLiteLLMCatalog({
      'provider-a/Model-X': { max_input_tokens: 32_768, max_output_tokens: 8_192, mode: 'chat' },
      'provider-b/model-x': { max_input_tokens: 1_000_000, max_output_tokens: 8_192, mode: 'chat' },
    });

    expect(m.get('Model-X')?.contextLength).toBeUndefined();
    expect(m.get('model-x')?.contextLength).toBeUndefined();
    expect(m.get('Model-X')?.maxOutputTokens).toBe(8_192);
    expect(m.get('model-x')?.maxOutputTokens).toBe(8_192);
    expect(m.get('provider-a/Model-X')?.contextLength).toBe(32_768);
    expect(m.get('provider-b/model-x')?.contextLength).toBe(1_000_000);
  });

  it('skips entries with neither a context window nor an output limit', () => {
    const m = parseLiteLLMCatalog({ 'pricing-only': { input_cost_per_token: 0.0001, mode: 'chat' } });
    expect(m.has('pricing-only')).toBe(false);
  });

  it('retains LiteLLM modality-only entries and preserves unknown per field', () => {
    const m = parseLiteLLMCatalog({
      'openrouter/xiaomi/mimo-v2.5': {
        mode: 'chat',
        supports_vision: true,
        supports_audio_input: true,
      },
    });

    expect(m.get('openrouter/xiaomi/mimo-v2.5')?.inputModalitySupport).toEqual({
      image: { supported: true, source: 'litellm' },
      audio: { supported: true, source: 'litellm' },
    });
    expect(m.get('mimo-v2.5')?.inputModalitySupport?.video).toBeUndefined();
  });

  it('uses supported_modalities when dedicated LiteLLM booleans are absent', () => {
    const m = parseLiteLLMCatalog({
      'provider/multimodal-model': {
        mode: 'responses',
        supported_modalities: ['text', 'image'],
      },
    });

    expect(m.get('provider/multimodal-model')?.inputModalities).toEqual(['text', 'image']);
    expect(m.get('provider/multimodal-model')?.inputModalitySupport).toEqual({
      image: { supported: true, source: 'litellm' },
      video: { supported: false, source: 'litellm' },
      audio: { supported: false, source: 'litellm' },
    });
  });

  it('does not invent a bare image verdict when provider-qualified LiteLLM entries disagree', () => {
    const m = parseLiteLLMCatalog({
      'provider-a/Model-X': { mode: 'chat', max_input_tokens: 128_000, supports_vision: true },
      'provider-b/model-x': { mode: 'chat', max_input_tokens: 128_000, supports_vision: false },
    });

    expect(m.get('provider-a/Model-X')?.inputModalitySupport?.image?.supported).toBe(true);
    expect(m.get('provider-b/model-x')?.inputModalitySupport?.image?.supported).toBe(false);
    expect(m.get('Model-X')?.contextLength).toBe(128_000);
    expect(m.get('Model-X')?.inputModalitySupport?.image).toBeUndefined();
    expect(m.get('model-x')?.inputModalitySupport?.image).toBeUndefined();
  });

  it('is robust to non-object / null inputs', () => {
    expect(parseLiteLLMCatalog(null).size).toBe(0);
    expect(parseLiteLLMCatalog('nope').size).toBe(0);
    expect(parseLiteLLMCatalog({ x: null, y: 42, z: 'str' }).size).toBe(0);
  });
});

// #338 — the configured 1M contextLength silently fell back to 200K because the
// bare-keyed registry was queried with a suffixed/whitespace-cruft model id, OR
// an incomplete higher-priority entry shadowed the real window. These pin BOTH
// mechanisms. HOME is redirected to an empty temp dir so only bundled
// PRESET_PROVIDERS load (deterministic regardless of the dev's ~/.myagents),
// then a config.json is written per-case to exercise the disk sources.
describe('capability-suffix tolerance + per-field merge (#338)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'ma-modelcaps-'));
    mkdirSync(join(tmpHome, '.myagents'), { recursive: true });
    process.env.HOME = tmpHome;
    __resetModelCapabilityCacheForTests();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    __resetModelCapabilityCacheForTests();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // Mechanism #1: a [1m] / " 1m" suffixed active model id must resolve to its
  // BARE registry contextLength (pre-fix: lookup missed → undefined → 200K).
  it('resolves a [1m] / " 1m" suffixed id to the bare preset contextLength', () => {
    expect(lookupModelContextLength('claude-opus-4-7[1m]')).toBe(1_000_000);
    expect(lookupModelContextLength('claude-opus-4-7 1m')).toBe(1_000_000);
    expect(lookupModelContextLength('claude-opus-4-6[1m]')).toBe(200_000);
    expect(lookupModelContextLength('claude-opus-4-6 1m')).toBe(200_000);
    expect(lookupModelContextLength('claude-sonnet-4-6[1m]')).toBe(200_000);
    expect(lookupModelContextLength('claude-sonnet-4-6 1m')).toBe(200_000);
  });

  it('canonicalizes a hand-typed " 1m" id (#338): append [1m] >200K, strip it off otherwise', () => {
    expect(applyContextWindowSuffix('claude-opus-4-7 1m')).toBe('claude-opus-4-7[1m]');
    // ≤200K: drop the malformed " 1m" so it never leaks to the upstream wire.
    expect(applyContextWindowSuffix('claude-opus-4-6 1m')).toBe('claude-opus-4-6');
    expect(applyContextWindowSuffix('claude-sonnet-4-6 1m')).toBe('claude-sonnet-4-6');
  });

  // Mechanism #2: an incomplete higher-priority entry (modalities, NO
  // contextLength) must NOT shadow the bundled preset's window. Pre-fix this
  // exact on-disk shape (observed in a real config) made lookup return
  // undefined for a CLEAN model id → window collapsed to the SDK 200K default.
  it('an incomplete discovered entry does NOT shadow the preset contextLength', () => {
    writeFileSync(
      join(tmpHome, '.myagents', 'config.json'),
      JSON.stringify({ presetCustomModels: { zhipu: [{ model: 'glm-5-turbo', inputModalities: ['text'] }] } }),
    );
    __resetModelCapabilityCacheForTests();
    expect(lookupModelContextLength('glm-5-turbo')).toBe(202_752); // filled from preset, not shadowed
  });

  it('uses bundled model settings in both the provider-scoped and flat capability registry', () => {
    writeFileSync(join(tmpHome, '.myagents', 'config.json'), JSON.stringify({
      presetCustomModels: { zhipu: [{
        model: 'glm-5-turbo', source: 'preset', presetSettings: { contextLength: 128000, inputModalities: ['text', 'image'] },
      }] },
    }));
    expect(lookupProviderModelContextLength('glm-5-turbo', 'zhipu')).toBe(128000);
    expect(lookupProviderModelContextLength('glm-5-turbo', 'zhipu-ai')).toBe(202752);
    expect(modelSupportsModality('glm-5-turbo', 'image', 'zhipu')).toBe(true);
    expect(modelSupportsModality('glm-5-turbo', 'image', 'zhipu-ai')).toBe(false);
    expect(lookupModelCapability('glm-5-turbo')).toMatchObject({
      contextLength: 128000, inputModalities: ['text', 'image'],
    });
  });

  // A reseller reusing the bundled id claude-sonnet-4-6 at a 1M window, stored
  // with the suffix baked into the model id. Bare AND suffixed lookups must see
  // 1M (winning over the 200K bundled preset), and applyContextWindowSuffix
  // must tag it.
  it('a 1M override stored under a [1m]-suffixed custom key resolves by the bare id', () => {
    writeFileSync(
      join(tmpHome, '.myagents', 'config.json'),
      JSON.stringify({
        presetCustomModels: { 'custom-dragon': [{ model: 'claude-sonnet-4-6[1m]', contextLength: 1_000_000 }] },
      }),
    );
    __resetModelCapabilityCacheForTests();
    expect(lookupModelContextLength('claude-sonnet-4-6')).toBe(1_000_000);
    expect(lookupModelContextLength('claude-sonnet-4-6[1m]')).toBe(1_000_000);
    expect(applyContextWindowSuffix('claude-sonnet-4-6')).toBe('claude-sonnet-4-6[1m]');
  });

  it('prefers the active provider contextLength when duplicate custom providers reuse a model id', () => {
    const providersDir = join(tmpHome, '.myagents', 'providers');
    mkdirSync(providersDir, { recursive: true });
    writeFileSync(
      join(providersDir, 'dragon-a.json'),
      JSON.stringify({
        id: 'dragon-a',
        models: [{ model: 'claude-sonnet-4-6', contextLength: 1_000_000 }],
      }),
    );
    writeFileSync(
      join(providersDir, 'dragon-b.json'),
      JSON.stringify({
        id: 'dragon-b',
        models: [{ model: 'claude-sonnet-4-6', contextLength: 200_000 }],
      }),
    );
    __resetModelCapabilityCacheForTests();

    expect(lookupProviderModelContextLength('claude-sonnet-4-6[1m]', 'dragon-b')).toBe(200_000);
    expect(lookupProviderModelContextLength('claude-sonnet-4-6[1m]', 'dragon-a')).toBe(1_000_000);
  });

  it('does not borrow contextLength when the active provider owns a context-less model row (#516)', () => {
    const providersDir = join(tmpHome, '.myagents', 'providers');
    const cacheDir = join(tmpHome, '.myagents', 'cache');
    mkdirSync(providersDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(providersDir, 'amd.json'),
      JSON.stringify({
        id: 'amd',
        models: [{ model: 'DeepSeek-V4-Flash', modelName: 'DeepSeek V4 Flash' }],
      }),
    );
    writeFileSync(
      join(cacheDir, 'litellm_model_prices.json'),
      JSON.stringify({
        'deepseek-v4-flash': { max_input_tokens: 1_000_000, mode: 'chat' },
        'tensormesh/deepseek-ai/DeepSeek-V4-Flash': { max_input_tokens: 32_768, mode: 'chat' },
      }),
    );
    __resetModelCapabilityCacheForTests();

    expect(lookupModelContextLength('DeepSeek-V4-Flash')).toBe(1_000_000);
    expect(lookupProviderModelContextLength('DeepSeek-V4-Flash', 'amd')).toBeUndefined();
    expect(applyProviderContextWindowSuffix('DeepSeek-V4-Flash', 'amd')).toBe('DeepSeek-V4-Flash');
  });

  it('wraps SDK model ids with the active provider window, not a global duplicate model id', () => {
    writeFileSync(
      join(tmpHome, '.myagents', 'config.json'),
      JSON.stringify({
        presetCustomModels: {
          'custom-dragon': [{ model: 'claude-opus-4-6', contextLength: 1_000_000 }],
        },
      }),
    );
    __resetModelCapabilityCacheForTests();

    expect(lookupModelContextLength('claude-opus-4-6')).toBe(1_000_000);
    expect(applyContextWindowSuffix('claude-opus-4-6')).toBe('claude-opus-4-6[1m]');
    expect(applyProviderContextWindowSuffix('claude-opus-4-6', 'anthropic-sub')).toBe('claude-opus-4-6');
    expect(applyProviderContextWindowSuffix('claude-opus-4-6', 'custom-dragon')).toBe('claude-opus-4-6[1m]');
  });

  // Per-field merge interaction with modalities (Codex review note): a higher-
  // priority entry that defines inputModalities but omits contextLength keeps
  // its explicit modalities AND inherits the preset's contextLength. This is the
  // intended "undefined field = defer to lower source" semantics.
  it('per-field merge: explicit modalities win, missing contextLength fills from preset', () => {
    writeFileSync(
      join(tmpHome, '.myagents', 'config.json'),
      JSON.stringify({ presetCustomModels: { zhipu: [{ model: 'glm-5-turbo', inputModalities: ['text'] }] } }),
    );
    __resetModelCapabilityCacheForTests();
    const cap = lookupModelCapability('glm-5-turbo');
    expect(cap?.inputModalities).toEqual(['text']); // explicit override preserved
    expect(cap?.contextLength).toBe(202_752);        // gap filled from the bundled preset
  });

  it('uses LiteLLM only as positive evidence and never lets its negative veto a provider offering', () => {
    const cacheDir = join(tmpHome, '.myagents', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'litellm_model_prices.json'),
      JSON.stringify({
        'provider/unique-modality-model': { mode: 'chat', supports_vision: false },
      }),
    );
    __resetModelCapabilityCacheForTests();
    expect(modelSupportsModality('unique-modality-model', 'image')).toBe(true);

    const providersDir = join(tmpHome, '.myagents', 'providers');
    mkdirSync(providersDir, { recursive: true });
    writeFileSync(
      join(providersDir, 'explicit-text.json'),
      JSON.stringify({
        id: 'explicit-text',
        models: [{ model: 'unique-modality-model', inputModalities: ['text'] }],
      }),
    );
    __resetModelCapabilityCacheForTests();
    expect(modelSupportsModality('unique-modality-model', 'image')).toBe(false);
  });

  // applyContextWindowSuffix must not feed the SDK a garbage model option built
  // from whitespace-/suffix-only input (Codex review edge case).
  it('applyContextWindowSuffix returns undefined for whitespace-/suffix-only input', () => {
    expect(applyContextWindowSuffix(' 1m')).toBeUndefined();
    expect(applyContextWindowSuffix('[1m]')).toBeUndefined();
    expect(applyContextWindowSuffix('[1M]   ')).toBeUndefined();
    expect(applyContextWindowSuffix('   ')).toBeUndefined();
  });
});
