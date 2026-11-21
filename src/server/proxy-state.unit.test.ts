import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProxySettings } from '../shared/config-types';
import { buildDshChildEnvironment } from './integrated-runtimes/dsh/child-environment';

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  // Initial proxy settings must not come from the developer's config.json.
  readFileSync: vi.fn(() => '{}'),
}));

const socksBridgeMocks = vi.hoisted(() => ({
  isSocksBridgeRunning: vi.fn(),
  startSocksBridge: vi.fn(),
  stopSocksBridge: vi.fn(),
}));

vi.mock('./utils/socks-bridge', () => ({
  isSocksBridgeRunning: socksBridgeMocks.isSocksBridgeRunning,
  startSocksBridge: socksBridgeMocks.startSocksBridge,
  stopSocksBridge: socksBridgeMocks.stopSocksBridge,
}));

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'MYAGENTS_PROXY_INJECTED',
  'MYAGENTS_PROXY_INHERITED_ENV_JSON',
] as const;

const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function clearProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadProxyState() {
  vi.resetModules();
  return await import('./proxy-state');
}

const scopedProxySettings: ProxySettings = {
  enabled: true,
  protocol: 'http',
  host: 'myagents.proxy',
  port: 7890,
  scope: { mode: 'custom', generalRequests: false, providerIds: ['included-provider'] },
};

describe('proxy-state provider scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearProxyEnv();
    socksBridgeMocks.isSocksBridgeRunning.mockReturnValue(false);
    socksBridgeMocks.startSocksBridge.mockResolvedValue(41234);
    socksBridgeMocks.stopSocksBridge.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreEnv();
  });

  it('captures an inherited startup baseline without an app-injection marker', async () => {
    process.env.HTTPS_PROXY = 'http://system.proxy:8443';
    process.env.no_proxy = '.corp.local,localhost';

    const proxyState = await loadProxyState();
    await proxyState.setProcessProxyConfig(scopedProxySettings);

    expect(process.env.HTTPS_PROXY).toBe('http://system.proxy:8443');
    expect(proxyState.getProxyForProviderUrl(
      'excluded-provider',
      'https://api.example.com/v1',
    )).toBe('http://system.proxy:8443');
    expect(proxyState._getInheritedProxySnapshotForTests().no_proxy).toBe(
      '.corp.local,localhost',
    );
  });

  it('drops an inherited bracketed IPv6 URL token before publishing NO_PROXY', async () => {
    process.env.no_proxy = '.corp.local,[::1]';

    const proxyState = await loadProxyState();
    await proxyState.setProcessProxyConfig(scopedProxySettings);

    expect(process.env.NO_PROXY?.split(',')).not.toContain('[::1]');
    expect(process.env.no_proxy?.split(',')).not.toContain('[::1]');
    expect(process.env.no_proxy?.split(',')).toContain('::1');
    expect(process.env.no_proxy?.split(',')).toContain('.corp.local');
  });

  it.each([
    { generalRequests: true, providerId: 'included-provider', generalUsesApp: true, providerUsesApp: true },
    { generalRequests: true, providerId: 'excluded-provider', generalUsesApp: true, providerUsesApp: false },
    { generalRequests: false, providerId: 'included-provider', generalUsesApp: false, providerUsesApp: true },
    { generalRequests: false, providerId: 'excluded-provider', generalUsesApp: false, providerUsesApp: false },
  ])('keeps general and provider proxy policy independent: $generalRequests / $providerId', async ({
    generalRequests,
    providerId,
    generalUsesApp,
    providerUsesApp,
  }) => {
    process.env.MYAGENTS_PROXY_INJECTED = '1';
    process.env.MYAGENTS_PROXY_INHERITED_ENV_JSON = JSON.stringify({
      HTTPS_PROXY: 'http://system.proxy:8080',
      NO_PROXY: '.corp.local',
    });
    process.env.HTTP_PROXY = 'http://myagents.proxy:7890';
    process.env.HTTPS_PROXY = 'http://myagents.proxy:7890';
    process.env.http_proxy = 'http://myagents.proxy:7890';
    process.env.https_proxy = 'http://myagents.proxy:7890';
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    process.env.no_proxy = 'localhost,127.0.0.1';

    const proxyState = await loadProxyState();
    await proxyState.setProcessProxyConfig({
      ...scopedProxySettings,
      scope: {
        mode: 'custom',
        generalRequests,
        providerIds: ['included-provider'],
      },
    });

    expect(process.env.HTTPS_PROXY).toBe(
      generalUsesApp ? 'http://myagents.proxy:7890' : 'http://system.proxy:8080',
    );
    expect(process.env.HTTP_PROXY).toBe(
      generalUsesApp ? 'http://myagents.proxy:7890' : undefined,
    );
    expect(proxyState.getProxyForUrl('https://space.example.com/v1')).toBe(
      generalUsesApp ? 'http://myagents.proxy:7890' : 'http://system.proxy:8080',
    );
    // WebFetch must follow the general owner's snapshot even if an unrelated
    // component changes process.env after proxy state was committed.
    process.env.HTTPS_PROXY = '';
    process.env.https_proxy = '';
    expect(proxyState.getProxyForUrl('https://example.com/page')).toBe(
      generalUsesApp ? 'http://myagents.proxy:7890' : 'http://system.proxy:8080',
    );
    expect(proxyState.getMyAgentsProxyForGeneralUrl('https://space.example.com/v1')).toBe(
      generalUsesApp ? 'http://myagents.proxy:7890' : undefined,
    );

    const shellEnv = buildDshChildEnvironment({
      nodeExecutablePath: '/verified/node',
      sessionCli: null,
      inheritedEnvironment: { HTTPS_PROXY: 'http://stale.proxy:9999' },
      proxyEnvironment: proxyState.getGeneralProxyEnvironment(),
    }).env;
    expect(shellEnv.HTTPS_PROXY).toBe(
      generalUsesApp ? 'http://myagents.proxy:7890' : 'http://system.proxy:8080',
    );
    expect(shellEnv.HTTP_PROXY).toBe(generalUsesApp ? 'http://myagents.proxy:7890' : undefined);
    expect(shellEnv.NO_PROXY).toContain('localhost');
    expect(shellEnv.no_proxy).toBe(shellEnv.NO_PROXY);
    if (!generalUsesApp) expect(shellEnv.NO_PROXY).toContain('.corp.local');

    const providerEnv: Record<string, string | undefined> = {};
    proxyState.applyProviderProxyPolicyToEnv(providerEnv, providerId);
    expect(providerEnv.HTTPS_PROXY).toBe(
      providerUsesApp ? 'http://myagents.proxy:7890' : 'http://system.proxy:8080',
    );
    expect(providerEnv.HTTP_PROXY).toBe(
      providerUsesApp ? 'http://myagents.proxy:7890' : undefined,
    );
    const requestPolicy = proxyState.getProviderRequestProxyPolicy(providerId);
    expect(requestPolicy.httpProxy).toBe(providerEnv.HTTP_PROXY);
    expect(requestPolicy.httpsProxy).toBe(providerEnv.HTTPS_PROXY);
    expect(requestPolicy.noProxy).toBe(providerEnv.NO_PROXY);
    expect(Object.isFrozen(requestPolicy)).toBe(true);
    expect(providerEnv.NO_PROXY).toContain('localhost');
    if (!providerUsesApp) expect(providerEnv.NO_PROXY).toContain('.corp.local');
    expect(providerEnv.MYAGENTS_PROXY_INJECTED).toBeUndefined();
    expect(providerEnv.MYAGENTS_PROXY_INHERITED_ENV_JSON).toBeUndefined();
    expect(proxyState.getProxyForProviderUrl(providerId, 'https://api.example.com/v1')).toBe(
      providerUsesApp ? 'http://myagents.proxy:7890' : 'http://system.proxy:8080',
    );
  });

  it.each([
    { protocol: 'http' as const, generalRequests: true, providerId: 'included-provider', generalUsesApp: true, providerUsesApp: true },
    { protocol: 'http' as const, generalRequests: true, providerId: 'excluded-provider', generalUsesApp: true, providerUsesApp: false },
    { protocol: 'http' as const, generalRequests: false, providerId: 'included-provider', generalUsesApp: false, providerUsesApp: true },
    { protocol: 'http' as const, generalRequests: false, providerId: 'excluded-provider', generalUsesApp: false, providerUsesApp: false },
    { protocol: 'https' as const, generalRequests: true, providerId: 'included-provider', generalUsesApp: true, providerUsesApp: true },
    { protocol: 'https' as const, generalRequests: true, providerId: 'excluded-provider', generalUsesApp: true, providerUsesApp: false },
    { protocol: 'https' as const, generalRequests: false, providerId: 'included-provider', generalUsesApp: false, providerUsesApp: true },
    { protocol: 'https' as const, generalRequests: false, providerId: 'excluded-provider', generalUsesApp: false, providerUsesApp: false },
  ])('selects independent $protocol baselines for general=$generalRequests provider=$providerId', async ({
    protocol,
    generalRequests,
    providerId,
    generalUsesApp,
    providerUsesApp,
  }) => {
    process.env.MYAGENTS_PROXY_INJECTED = '1';
    process.env.MYAGENTS_PROXY_INHERITED_ENV_JSON = JSON.stringify({
      HTTP_PROXY: 'http://system-http.proxy:8080',
      HTTPS_PROXY: 'http://system-https.proxy:8443',
    });

    const proxyState = await loadProxyState();
    await proxyState.setProcessProxyConfig({
      enabled: true,
      protocol,
      host: 'myagents.proxy',
      port: 7890,
      scope: { mode: 'custom', generalRequests, providerIds: ['included-provider'] },
    });

    const appUrl = `${protocol}://myagents.proxy:7890`;
    const generalOptions = proxyState._getGeneralRequestProxyOptionsForTests();
    expect(generalOptions.httpProxy).toBe(
      generalUsesApp ? appUrl : 'http://system-http.proxy:8080',
    );
    expect(generalOptions.httpsProxy).toBe(
      generalUsesApp ? appUrl : 'http://system-https.proxy:8443',
    );
    expect(proxyState.getProxyForProviderUrl(providerId, 'https://api.example.com/v1')).toBe(
      providerUsesApp ? appUrl : 'http://system-https.proxy:8443',
    );
  });

  it('keeps a SOCKS bridge overlay for a selected provider when general requests inherit', async () => {
    process.env.MYAGENTS_PROXY_INJECTED = '1';
    process.env.MYAGENTS_PROXY_INHERITED_ENV_JSON = JSON.stringify({
      HTTPS_PROXY: 'http://system.proxy:8080',
      NO_PROXY: '.corp.local',
    });
    process.env.HTTP_PROXY = 'socks5://127.0.0.1:1080';
    process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';

    const proxyState = await loadProxyState();
    await proxyState.setProcessProxyConfig({
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      scope: {
        mode: 'custom',
        generalRequests: false,
        providerIds: ['included-provider'],
      },
    });

    expect(socksBridgeMocks.startSocksBridge).toHaveBeenCalledWith('127.0.0.1', 1080);
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBe('http://system.proxy:8080');

    const providerEnv: Record<string, string | undefined> = {};
    proxyState.applyProviderProxyPolicyToEnv(providerEnv, 'included-provider');
    expect(providerEnv.HTTP_PROXY).toBe('http://127.0.0.1:41234');
    expect(providerEnv.HTTPS_PROXY).toBe('http://127.0.0.1:41234');
    expect(proxyState.getProxyForProviderUrl(
      'included-provider',
      'https://api.example.com/v1',
    )).toBe('http://127.0.0.1:41234');
  });

  it.each([
    { generalRequests: true, providerId: 'included-provider', generalUsesApp: true, providerUsesApp: true },
    { generalRequests: true, providerId: 'excluded-provider', generalUsesApp: true, providerUsesApp: false },
    { generalRequests: false, providerId: 'included-provider', generalUsesApp: false, providerUsesApp: true },
    { generalRequests: false, providerId: 'excluded-provider', generalUsesApp: false, providerUsesApp: false },
  ])('keeps SOCKS bridge routing independent for general=$generalRequests provider=$providerId', async ({
    generalRequests,
    providerId,
    generalUsesApp,
    providerUsesApp,
  }) => {
    process.env.MYAGENTS_PROXY_INJECTED = '1';
    process.env.MYAGENTS_PROXY_INHERITED_ENV_JSON = JSON.stringify({
      HTTP_PROXY: 'http://system.proxy:8080',
      HTTPS_PROXY: 'http://system.proxy:8080',
    });

    const proxyState = await loadProxyState();
    await proxyState.setProcessProxyConfig({
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      scope: { mode: 'custom', generalRequests, providerIds: ['included-provider'] },
    });

    const bridgeUrl = 'http://127.0.0.1:41234';
    expect(proxyState.getGeneralProxyEnvironment().http_proxy).toBe(generalUsesApp ? bridgeUrl : undefined);
    expect(proxyState.getGeneralProxyEnvironment().HTTPS_PROXY).toBe(
      generalUsesApp ? bridgeUrl : 'http://system.proxy:8080',
    );
    expect(proxyState._getGeneralRequestProxyOptionsForTests().httpsProxy).toBe(
      generalUsesApp ? bridgeUrl : 'http://system.proxy:8080',
    );
    expect(proxyState.getProxyForProviderUrl(providerId, 'https://api.example.com/v1')).toBe(
      providerUsesApp ? bridgeUrl : 'http://system.proxy:8080',
    );
  });

  it('gives only the selected CLI the SOCKS bridge and honors a terminal workspace override', async () => {
    process.env.HTTPS_PROXY = 'http://parent.proxy:8080';
    const state = await loadProxyState();
    await state.setProcessProxyConfig({
      ...scopedProxySettings, protocol: 'socks5',
      scope: { mode: 'custom', generalRequests: false, providerIds: [], runtimeIds: ['codex'] },
    });
    const { augmentedProcessEnv } = await import('./runtimes/env-utils');
    expect(augmentedProcessEnv('codex').HTTPS_PROXY).toBe('http://127.0.0.1:41234');
    expect(augmentedProcessEnv('claude-code').HTTPS_PROXY).toBe('http://parent.proxy:8080');
    expect(augmentedProcessEnv('antigravity').HTTPS_PROXY).toBe('http://parent.proxy:8080');
    expect(process.env.HTTPS_PROXY).toBe('http://parent.proxy:8080');
    expect(state.getProviderRequestProxyPolicy('codex-sub').httpsProxy).toBe('http://parent.proxy:8080');
    expect(augmentedProcessEnv('codex', { proxy: 'terminal' }).HTTPS_PROXY).toBeUndefined();
  });

  it('does not start a provider-only SOCKS bridge in a general-only process', async () => {
    const proxyState = await loadProxyState();
    proxyState._resetProxyStateForTests({
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      scope: {
        mode: 'custom',
        generalRequests: false,
        providerIds: ['included-provider'],
      },
    });

    await proxyState.initializeProxyStateFromCurrentSettings({ sessionConsumers: false });

    expect(socksBridgeMocks.startSocksBridge).not.toHaveBeenCalled();
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it('restores inherited ALL_PROXY after disabling the app overlay and seals each generation', async () => {
    process.env.ALL_PROXY = 'socks5://inherited.proxy:1080';
    process.env.NO_PROXY = '.corp.local';
    const proxyState = await loadProxyState();
    await proxyState.setProcessProxyConfig({ ...scopedProxySettings, scope: { mode: 'all' } });
    const previous = proxyState.getGeneralProxyEnvironment();
    expect(previous.https_proxy).toBe('http://myagents.proxy:7890');
    expect(previous.ALL_PROXY).toBeUndefined();

    await proxyState.setProcessProxyConfig({ ...scopedProxySettings, enabled: false });
    process.env.HTTPS_PROXY = 'http://unexpected.process-mutation:9999';
    const current = proxyState.getGeneralProxyEnvironment();
    expect(current.ALL_PROXY).toBe('socks5://inherited.proxy:1080');
    expect(current.HTTPS_PROXY).toBeUndefined();
    expect(current.NO_PROXY).toContain('.corp.local');
    expect(current.NO_PROXY).toContain('127.0.0.1');
    expect(current.NO_PROXY).toContain('::1');
    expect(previous.https_proxy).toBe('http://myagents.proxy:7890');
  });

  it('does not tear down a stable SOCKS bridge from a superseded transition', async () => {
    const socksStart = deferred<number>();
    socksBridgeMocks.startSocksBridge.mockReturnValueOnce(socksStart.promise);

    const proxyState = await loadProxyState();

    const first = proxyState.setProcessProxyConfig({
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
    });
    await vi.waitFor(() => {
      expect(socksBridgeMocks.startSocksBridge).toHaveBeenCalledTimes(1);
    });
    const second = proxyState.setProcessProxyConfig({
      enabled: false,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
    });

    socksStart.resolve(45678);
    await Promise.all([first, second]);

    expect(socksBridgeMocks.stopSocksBridge).not.toHaveBeenCalled();
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
  });

  it('retires the previous general dispatcher when the selected baseline changes', async () => {
    const proxyState = await loadProxyState();
    proxyState._resetProxyStateForTests(null, {
      HTTP_PROXY: 'http://127.0.0.1:18080',
    });
    const first = proxyState.getGeneralRequestDispatcher();
    expect(first).toBeDefined();
    const close = vi.spyOn(first!, 'close').mockResolvedValue(undefined);

    proxyState._resetProxyStateForTests({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      scope: { mode: 'custom', generalRequests: true, providerIds: [] },
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(proxyState.getGeneralRequestDispatcher()).not.toBe(first);
  });

  it('applies the canonical localhost CIDR and standard NO_PROXY root semantics', async () => {
    const proxyState = await loadProxyState();
    expect(proxyState._shouldBypassProxyForTests(
      'http://127.42.0.9:8080/check',
      '127.0.0.0/8',
    )).toBe(true);
    expect(proxyState._shouldBypassProxyForTests(
      'https://corp.local/check',
      '.corp.local',
    )).toBe(true);
    expect(proxyState._shouldBypassProxyForTests(
      'https://api.corp.local/check',
      '.corp.local',
    )).toBe(true);
  });
});
