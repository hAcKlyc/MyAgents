import { describe, expect, it } from 'vitest';

import { describeProxyScopeSummary } from './proxyScopePresentation';

describe('describeProxyScopeSummary', () => {
  it('describes all and disabled modes', () => {
    expect(describeProxyScopeSummary({
      enabled: false,
      scope: { mode: 'all' },
      selectedProviderNames: ['Anthropic'],
    })[0].key).toBe('proxy.scopeDisabledHint');
    expect(describeProxyScopeSummary({
      enabled: true,
      scope: { mode: 'all' },
      selectedProviderNames: ['Anthropic'],
    })[0].key).toBe('proxy.scopeAllSummary');
  });

  it('summarizes each selected group, including runtime-only selections', () => {
    const summary = (generalRequests: boolean, providerIds: string[], runtimeIds: string[]) =>
      describeProxyScopeSummary({
        enabled: true, scope: { mode: 'custom', generalRequests, providerIds, runtimeIds },
        selectedProviderNames: providerIds,
      });
    expect(summary(false, [], [])).toEqual([{ key: 'proxy.scopeCustomEmptySummary' }]);
    expect(summary(false, [], ['codex'])).toEqual([{ key: 'proxy.scopeRuntimeCount', values: { count: 1 } }]);
    expect(summary(true, ['A'], ['codex', 'antigravity'])).toEqual([
      { key: 'proxy.scopeDialogGeneralRequests' },
      { key: 'proxy.scopeProviderNames', values: { names: 'A' } },
      { key: 'proxy.scopeRuntimeCount', values: { count: 2 } },
    ]);
    expect(summary(false, ['A', 'B', 'C', 'D'], [])).toEqual([
      { key: 'proxy.scopeProviderCount', values: { count: 4 } },
    ]);
  });
});
