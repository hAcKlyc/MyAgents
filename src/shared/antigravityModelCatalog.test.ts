import { describe, expect, it } from 'vitest';
import {
  normalizeAntigravityFlatModels,
  resolveAntigravityModelSelection,
  splitAntigravityFlatModelId,
} from './antigravityModelCatalog';

describe('antigravityModelCatalog', () => {
  it('collapses flat agy models rows into family entries matching ACP configOptions', () => {
    const raw = [
      { value: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)' },
      { value: 'gemini-4-neon-xhigh', displayName: 'Gemini 4 Neon (XHigh)' },
      { value: 'gemini-4-neon-medium', displayName: 'Gemini 4 Neon (Medium)' },
      { value: 'gemini-4-neon-low', displayName: 'Gemini 4 Neon (Low)' },
      { value: 'gemini-4-carbon-medium', displayName: 'Gemini 4 Carbon (Medium)' },
      { value: 'gemini-4-carbon-high', displayName: 'Gemini 4 Carbon (High)' },
      { value: 'gemini-4-carbon-low', displayName: 'Gemini 4 Carbon (Low)' },
      { value: 'gemini-pro-orchestrator-neon', displayName: 'Orchestrator (Neon)' },
      { value: 'gemini-pro-orchestrator', displayName: 'Orchestrator (Carbon)' },
      { value: 'claude-opus-5-5-low', displayName: 'Claude Opus 5.5 (Low)' },
      { value: 'claude-opus-5-5-medium', displayName: 'Claude Opus 5.5 (Medium)' },
      { value: 'claude-opus-5-5-high', displayName: 'Claude Opus 5.5 (High)' },
      { value: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
    ];

    expect(normalizeAntigravityFlatModels(raw)).toEqual([
      {
        value: 'gemini-4-neon',
        displayName: 'Gemini 4 Neon',
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Low' },
          { reasoningEffort: 'medium', description: 'Medium' },
          { reasoningEffort: 'high', description: 'High' },
          { reasoningEffort: 'xhigh', description: 'Extra' },
        ],
      },
      {
        value: 'gemini-4-carbon',
        displayName: 'Gemini 4 Carbon',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Low' },
          { reasoningEffort: 'medium', description: 'Medium' },
          { reasoningEffort: 'high', description: 'High' },
        ],
      },
      { value: 'gemini-pro-orchestrator-neon', displayName: 'Orchestrator (Neon)' },
      { value: 'gemini-pro-orchestrator', displayName: 'Orchestrator (Carbon)' },
      {
        value: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Low' },
          { reasoningEffort: 'medium', description: 'Medium' },
          { reasoningEffort: 'high', description: 'High' },
        ],
      },
      { value: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
    ]);
  });

  it('leaves plain single models untouched without fabricating effort metadata', () => {
    expect(
      normalizeAntigravityFlatModels([{ value: 'model-id', displayName: 'Native Model' }]),
    ).toEqual([{ value: 'model-id', displayName: 'Native Model' }]);
  });

  it('splits legacy flat IDs and maps them onto matching family catalog rows', () => {
    expect(splitAntigravityFlatModelId('gemini-4-neon-xhigh')).toEqual({
      familyId: 'gemini-4-neon',
      effort: 'xhigh',
    });
    expect(splitAntigravityFlatModelId('gemini-pro-orchestrator-neon')).toBeNull();

    const catalog = normalizeAntigravityFlatModels([
      { value: 'gemini-4-neon-high', displayName: 'Gemini 4 Neon (High)' },
      { value: 'gemini-4-neon-low', displayName: 'Gemini 4 Neon (Low)' },
      { value: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
    ]);

    expect(resolveAntigravityModelSelection(catalog, 'gemini-4-neon')).toEqual({
      model: catalog[0],
    });
    expect(resolveAntigravityModelSelection(catalog, 'gemini-4-neon-high')).toEqual({
      model: catalog[0],
      legacyEffort: 'high',
    });
    expect(resolveAntigravityModelSelection(catalog, 'gemini-4-neon-xhigh')).toEqual({
      model: catalog[0],
    });
    expect(resolveAntigravityModelSelection(catalog, 'gpt-oss-120b-medium')).toEqual({
      model: catalog[1],
    });
    expect(resolveAntigravityModelSelection(catalog, 'unknown-model')).toEqual({
      model: undefined,
    });
  });
});
