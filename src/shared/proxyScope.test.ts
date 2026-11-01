import { describe, expect, it } from 'vitest';

import type { ProxySettings } from './config-types';
import {
  effectiveGeneralProxyScopeKey,
  effectiveProxyScopeKey,
  normalizeProxyScope,
  removeProviderFromProxySettingsScope,
  shouldUseMyAgentsProxyForGeneralRequests,
  shouldUseMyAgentsProxyForProvider,
} from './proxyScope';

function proxy(scope?: ProxySettings['scope'], enabled = true): ProxySettings {
  return {
    enabled,
    protocol: 'http',
    host: '127.0.0.1',
    port: 7897,
    ...(scope ? { scope } : {}),
  };
}

describe('proxy scope normalization', () => {
  it('defaults missing or non-custom scope to all', () => {
    expect(normalizeProxyScope(undefined)).toEqual({ mode: 'all' });
    expect(normalizeProxyScope({ mode: 'all', providerIds: ['deepseek'] })).toEqual({ mode: 'all' });
  });

  it('dedupes custom provider ids and drops blanks', () => {
    expect(normalizeProxyScope({ mode: 'custom', providerIds: ['deepseek', '', 'deepseek', ' openrouter '] }))
      .toEqual({ mode: 'custom', generalRequests: true, providerIds: ['deepseek', 'openrouter'] });
  });

  it('keeps legacy general behavior and only falls back for legacy empty custom scopes', () => {
    expect(normalizeProxyScope({ mode: 'custom', providerIds: ['antigravity-sub'] }))
      .toEqual({ mode: 'custom', generalRequests: true, providerIds: ['antigravity-sub'] });
    expect(normalizeProxyScope({ mode: 'custom', providerIds: [] }))
      .toEqual({ mode: 'all' });
  });

  it('preserves explicit general selection and allows zero providers', () => {
    expect(normalizeProxyScope({ mode: 'custom', generalRequests: false, providerIds: ['temporarily-unloaded'] }))
      .toEqual({ mode: 'custom', generalRequests: false, providerIds: ['temporarily-unloaded'] });
    expect(normalizeProxyScope({ mode: 'custom', generalRequests: true, providerIds: [] }))
      .toEqual({ mode: 'custom', generalRequests: true, providerIds: [] });
    expect(normalizeProxyScope({ mode: 'custom', generalRequests: false, providerIds: [] }))
      .toEqual({ mode: 'custom', generalRequests: false, providerIds: [] });
  });

  it('preserves unknown identities while cleaning only invalid values and duplicates', () => {
    expect(normalizeProxyScope({ mode: 'custom', generalRequests: true,
      providerIds: [' antigravity-sub ', null, 'gated-provider', 'antigravity-sub', 7, ''] }))
      .toEqual({ mode: 'custom', generalRequests: true, providerIds: ['antigravity-sub', 'gated-provider'] });
  });
});

describe('general request proxy decision', () => {
  it('requires the global switch and defaults legacy scopes to enabled', () => {
    expect(shouldUseMyAgentsProxyForGeneralRequests(proxy(undefined, false))).toBe(false);
    expect(shouldUseMyAgentsProxyForGeneralRequests(proxy())).toBe(true);
    expect(shouldUseMyAgentsProxyForGeneralRequests(proxy({ mode: 'custom', providerIds: ['deepseek'] })))
      .toBe(true);
  });

  it('honors explicit custom general selection independently from providers', () => {
    expect(shouldUseMyAgentsProxyForGeneralRequests(proxy({
      mode: 'custom', generalRequests: false, providerIds: ['deepseek'],
    }))).toBe(false);
    expect(shouldUseMyAgentsProxyForGeneralRequests(proxy({
      mode: 'custom', generalRequests: true, providerIds: [],
    }))).toBe(true);
  });

  it('changes the effective key only when the general path changes', () => {
    const generalOff = proxy({ mode: 'custom', generalRequests: false, providerIds: ['deepseek'] });
    const generalOffOtherProvider = proxy({ mode: 'custom', generalRequests: false, providerIds: ['openrouter'] });
    expect(effectiveGeneralProxyScopeKey(generalOff))
      .toBe(effectiveGeneralProxyScopeKey(generalOffOtherProvider));
    expect(effectiveGeneralProxyScopeKey(proxy()))
      .toBe('myagents-proxy:general:http://127.0.0.1:7897');
  });
});

describe('provider-owned proxy decision', () => {
  it('does not use MyAgents proxy when disabled', () => {
    expect(shouldUseMyAgentsProxyForProvider(proxy(undefined, false), 'deepseek')).toBe(false);
  });

  it('uses MyAgents proxy for all providers by default', () => {
    expect(shouldUseMyAgentsProxyForProvider(proxy(), 'deepseek')).toBe(true);
  });

  it('uses MyAgents proxy only for selected custom providers', () => {
    const settings = proxy({ mode: 'custom', providerIds: ['anthropic-sub'] });
    expect(shouldUseMyAgentsProxyForProvider(settings, 'anthropic-sub')).toBe(true);
    expect(shouldUseMyAgentsProxyForProvider(settings, 'deepseek')).toBe(false);
  });

  it('includes provider and proxy url in the effective restart key', () => {
    expect(effectiveProxyScopeKey(proxy(), 'deepseek')).toBe('myagents-proxy:deepseek:http://127.0.0.1:7897');
    expect(effectiveProxyScopeKey(proxy({ mode: 'custom', providerIds: ['anthropic-sub'] }), 'deepseek'))
      .toBe('myagents-proxy:disabled-for-provider:deepseek');
  });

  it('removes deleted provider ids while preserving custom general scope', () => {
    expect(removeProviderFromProxySettingsScope(
      proxy({ mode: 'custom', generalRequests: false, providerIds: ['deepseek', 'openrouter'] }),
      'deepseek',
    )?.scope).toEqual({ mode: 'custom', generalRequests: false, providerIds: ['openrouter'] });
    expect(removeProviderFromProxySettingsScope(
      proxy({ mode: 'custom', providerIds: ['deepseek'] }),
      'deepseek',
    )?.scope).toEqual({ mode: 'custom', generalRequests: true, providerIds: [] });
  });

  it('keeps provider restart keys independent from general-only changes', () => {
    const providerOn = proxy({ mode: 'custom', generalRequests: true, providerIds: ['deepseek'] });
    const providerOnGeneralOff = proxy({ mode: 'custom', generalRequests: false, providerIds: ['deepseek'] });
    expect(effectiveProxyScopeKey(providerOn, 'deepseek'))
      .toBe(effectiveProxyScopeKey(providerOnGeneralOff, 'deepseek'));
  });
});
