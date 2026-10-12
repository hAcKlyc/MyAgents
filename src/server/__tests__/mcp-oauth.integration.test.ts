import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dynamicRegister } from '../mcp-oauth/registration';
import {
  authorizeServer,
  revokeAuthorization,
  startOAuthMaintenanceForSidecarRole,
} from '../mcp-oauth';
import { parseSidecarRole } from '../sidecar-role';
import {
  isFlowPending,
  startAuthorizationFlow,
} from '../mcp-oauth/authorization';
import {
  getRefreshLeadMs,
  onOAuthCredentialChange,
  pollOAuthCredentialChanges,
  refreshToken,
  startTokenRefreshScheduler,
  startTokenRevisionObserver,
  stopTokenRefreshScheduler,
  stopTokenRevisionObserver,
} from '../mcp-oauth/token-manager';
import {
  _getInheritedProxySnapshotForTests,
  _resetProxyStateForTests,
  getCurrentProxySettings,
} from '../proxy-state';
import {
  clearServerToken,
  getServerState,
  resetStateStoreCacheForTests,
  saveStateStore,
  setServerToken,
  updateServerState,
} from '../mcp-oauth/state-store';
import { _setGeneralFetchTransportForTests } from '../utils/cancellation';

const originalConfigDir = process.env.MYAGENTS_CONFIG_DIR;
const originalFetch = globalThis.fetch;
const originalProxySettings = getCurrentProxySettings();
const originalInheritedProxySnapshot = _getInheritedProxySnapshotForTests();

let configDir: string;
let removeCredentialListener: (() => void) | undefined;

function stateFile(): string {
  return join(configDir, 'mcp_oauth_state.json');
}

function writeExternalState(state: unknown): void {
  writeFileSync(stateFile(), JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  const future = new Date(Date.now() + 1000);
  utimesSync(stateFile(), future, future);
}

describe('mcp oauth', () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'myagents-oauth-test-'));
    process.env.MYAGENTS_CONFIG_DIR = configDir;
    resetStateStoreCacheForTests();
    globalThis.fetch = originalFetch;
    _setGeneralFetchTransportForTests(
      async (url, init) => globalThis.fetch(url, init as RequestInit),
    );
    // These tests own their transport through a per-case global fetch stub.
    // Do not let the developer machine's persisted MyAgents proxy route the
    // request through an undici ProxyAgent and escape that deterministic stub.
    _resetProxyStateForTests(null, {});
  });

  afterEach(() => {
    removeCredentialListener?.();
    removeCredentialListener = undefined;
    stopTokenRefreshScheduler();
    stopTokenRevisionObserver();
    vi.useRealTimers();
    resetStateStoreCacheForTests();
    globalThis.fetch = originalFetch;
    _setGeneralFetchTransportForTests();
    _resetProxyStateForTests(originalProxySettings, originalInheritedProxySnapshot);
    if (originalConfigDir === undefined) {
      delete process.env.MYAGENTS_CONFIG_DIR;
    } else {
      process.env.MYAGENTS_CONFIG_DIR = originalConfigDir;
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  test('dynamic registration advertises refresh token support', async () => {
    let registrationRequest: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      registrationRequest = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ client_id: 'client-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await dynamicRegister(
      'https://auth.example.com/register',
      'http://127.0.0.1:12345/callback',
      ['mcp:tools'],
    );

    expect(registrationRequest?.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(registrationRequest?.token_endpoint_auth_method).toBe('none');
  });

  test('process role parsing defaults safely and rejects unknown owners', () => {
    expect(parseSidecarRole('global')).toBe('global');
    expect(parseSidecarRole('session')).toBe('session');
    expect(parseSidecarRole(null)).toBe('session');
    expect(() => parseSidecarRole('worker')).toThrow('Invalid --sidecar-role: worker');
  });

  test('only the Global process role starts proactive OAuth maintenance', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-16T00:00:00.000Z') });
    await saveStateStore({
      notion: {
        token: {
          accessToken: 'expired-access',
          refreshToken: 'refresh-token',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
      },
    });
    let refreshCalls = 0;
    globalThis.fetch = (async () => {
      refreshCalls += 1;
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    startOAuthMaintenanceForSidecarRole('session');
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshCalls).toBe(0);
    stopTokenRevisionObserver();

    startOAuthMaintenanceForSidecarRole('global');
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshCalls).toBe(1);
  });

  test('state store reloads OAuth credentials written by another process', async () => {
    await saveStateStore({
      notion: {
        registration: { clientId: 'old-client', registeredAt: 1 },
        token: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          tokenType: 'Bearer',
        },
      },
    });
    expect(getServerState('notion')?.registration?.clientId).toBe('old-client');

    writeExternalState({
      notion: {
        registration: { clientId: 'new-client', registeredAt: 2 },
        token: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          tokenType: 'Bearer',
        },
      },
    });

    const state = getServerState('notion');
    expect(state?.registration?.clientId).toBe('new-client');
    expect(state?.token?.refreshToken).toBe('new-refresh');
  });

  test('state updates merge against fresh disk state instead of stale cache', async () => {
    await saveStateStore({
      notion: {
        registration: { clientId: 'old-client', registeredAt: 1 },
      },
    });
    expect(getServerState('notion')?.registration?.clientId).toBe('old-client');

    writeExternalState({
      notion: {
        registration: { clientId: 'new-client', registeredAt: 2 },
        token: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          tokenType: 'Bearer',
        },
      },
    });

    await updateServerState('notion', {
      discovery: {
        authServerUrl: 'https://auth.example.com',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        discoveredAt: Date.now(),
      },
    });

    const persisted = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(persisted.notion.registration.clientId).toBe('new-client');
    expect(persisted.notion.token.refreshToken).toBe('new-refresh');
    expect(persisted.notion.discovery.tokenEndpoint).toBe('https://auth.example.com/token');
  });

  test('state update can migrate legacy tokens while holding the write lock', async () => {
    writeFileSync(join(configDir, 'mcp_oauth_tokens.json'), JSON.stringify({
      notion: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
        serverUrl: 'https://auth.example.com/token',
        clientId: 'legacy-client',
      },
    }), { encoding: 'utf-8', mode: 0o600 });

    const startedAt = Date.now();
    await updateServerState('notion', {
      registration: { clientId: 'new-client', registeredAt: Date.now() },
    });

    const persisted = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(persisted.notion.token.refreshToken).toBe('legacy-refresh');
    expect(persisted.notion.registration.clientId).toBe('new-client');
  });

  test('state clear can migrate legacy tokens while holding the write lock', async () => {
    writeFileSync(join(configDir, 'mcp_oauth_tokens.json'), JSON.stringify({
      notion: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
        serverUrl: 'https://auth.example.com/token',
        clientId: 'legacy-client',
      },
    }), { encoding: 'utf-8', mode: 0o600 });

    const startedAt = Date.now();
    await clearServerToken('notion');

    expect(Date.now() - startedAt).toBeLessThan(1000);
    const state = getServerState('notion');
    expect(state?.token).toBeUndefined();
    expect(state?.manualConfig?.clientId).toBe('legacy-client');
  });

  test('refresh uses the latest stored client credentials', async () => {
    await saveStateStore({
      notion: {
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
        registration: { clientId: 'old-client', registeredAt: 1 },
        token: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1000,
        },
      },
    });
    expect(getServerState('notion')?.registration?.clientId).toBe('old-client');

    writeExternalState({
      notion: {
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
        registration: { clientId: 'new-client', registeredAt: 2 },
        token: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1000,
        },
      },
    });

    let refreshRequest: URLSearchParams | undefined;
    globalThis.fetch = (async (_url, init) => {
      refreshRequest = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({
        access_token: 'refreshed-access',
        refresh_token: 'refreshed-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const outcome = await refreshToken('notion');

    expect(refreshRequest?.get('client_id')).toBe('new-client');
    expect(refreshRequest?.get('refresh_token')).toBe('new-refresh');
    expect(outcome.kind).toBe('refreshed_by_self');
    if (outcome.kind !== 'refreshed_by_self') throw new Error('expected local refresh');
    expect(outcome.token.refreshToken).toBe('refreshed-refresh');
    expect(outcome.token.lifetimeMs).toBe(3_600_000);
    expect(outcome.tokenRevision).toBe(1);
  });

  test('refresh reuses a token another process already refreshed', async () => {
    await saveStateStore({
      notion: {
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
        registration: { clientId: 'old-client', registeredAt: 1 },
        token: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1000,
        },
      },
    });
    expect(getServerState('notion')?.token?.accessToken).toBe('old-access');

    writeExternalState({
      notion: {
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
        registration: { clientId: 'new-client', registeredAt: 2 },
        token: {
          accessToken: 'fresh-access',
          refreshToken: 'fresh-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() + 3600_000,
        },
      },
    });

    let refreshCalled = false;
    globalThis.fetch = (async (_url, _init) => {
      refreshCalled = true;
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    const outcome = await refreshToken('notion');

    expect(outcome.kind).toBe('observed_after_lock');
    if (outcome.kind !== 'observed_after_lock') throw new Error('expected observed refresh');
    expect(outcome.token.accessToken).toBe('fresh-access');
    expect(outcome.token.refreshToken).toBe('fresh-refresh');
    expect(refreshCalled).toBe(false);
  });

  test('proactive refresh treats a credential without expiry metadata as already usable', async () => {
    await saveStateStore({
      notion: {
        tokenRevision: 2,
        token: {
          accessToken: 'fresh-without-expiry',
          refreshToken: 'rotated-without-expiry',
          tokenType: 'Bearer',
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
      },
    });
    let refreshCalled = false;
    globalThis.fetch = (async () => {
      refreshCalled = true;
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    const outcome = await refreshToken('notion', 'proactive');

    expect(outcome.kind).toBe('observed_after_lock');
    expect(refreshCalled).toBe(false);
  });

  test('post-lock revision changes are reused only when the observed token is fresh', async () => {
    const discovery = {
      authServerUrl: 'https://auth.example.com',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      discoveredAt: Date.now(),
    };
    await saveStateStore({
      notion: {
        tokenRevision: 1,
        token: {
          accessToken: 'expired-access-1',
          refreshToken: 'expired-refresh-1',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
        },
        discovery,
      },
    });

    const lockDir = join(configDir, 'mcp_oauth_locks', 'notion.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner'), 'external-test-holder\n');
    let sentRefreshToken: string | null = null;
    globalThis.fetch = (async (_url, init) => {
      sentRefreshToken = new URLSearchParams(String(init?.body)).get('refresh_token');
      return new Response(JSON.stringify({
        access_token: 'fresh-access-3',
        refresh_token: 'fresh-refresh-3',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const refreshPromise = refreshToken('notion', 'inline');
    await new Promise(resolve => setTimeout(resolve, 150));
    writeExternalState({
      notion: {
        tokenRevision: 2,
        token: {
          accessToken: 'still-expired-access-2',
          refreshToken: 'still-expired-refresh-2',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
        },
        discovery,
      },
    });
    rmSync(lockDir, { recursive: true, force: true });

    const outcome = await refreshPromise;
    expect(outcome.kind).toBe('refreshed_by_self');
    expect(sentRefreshToken).toBe('still-expired-refresh-2');
  });

  test('credential writes increment one durable revision including revoke tombstones', async () => {
    const token = { accessToken: 'access-1', refreshToken: 'refresh-1', tokenType: 'Bearer' };

    expect(await setServerToken('notion', token)).toBe(1);
    expect(await setServerToken('notion', { ...token, accessToken: 'access-2' })).toBe(2);
    expect(await clearServerToken('notion')).toBe(3);

    const persisted = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(persisted.notion.token).toBeUndefined();
    expect(persisted.notion.tokenRevision).toBe(3);
  });

  test('observer baselines once and does not swallow a revision before the next poll', async () => {
    await saveStateStore({
      notion: {
        tokenRevision: 1,
        token: {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          tokenType: 'Bearer',
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    const changes: Array<{ tokenRevision: number; status: string; expiresAt?: number }> = [];
    removeCredentialListener = onOAuthCredentialChange(change => changes.push(change));
    startTokenRevisionObserver();

    const nextExpiry = Date.now() + 120_000;
    writeExternalState({
      notion: {
        tokenRevision: 2,
        token: {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          tokenType: 'Bearer',
          expiresAt: nextExpiry,
        },
      },
    });

    // Repeated initialization/config activity must not move the baseline.
    startTokenRevisionObserver();
    pollOAuthCredentialChanges();
    pollOAuthCredentialChanges();

    expect(changes).toEqual([{
      serverId: 'notion',
      tokenRevision: 2,
      status: 'available',
      expiresAt: nextExpiry,
    }]);
  });

  test('refresh lead is proportional, capped for short TTLs, and legacy-compatible', () => {
    const base = { accessToken: 'a', tokenType: 'Bearer' };

    expect(getRefreshLeadMs({ ...base, lifetimeMs: 2_000 }, 'proactive')).toBe(1_000);
    expect(getRefreshLeadMs({ ...base, lifetimeMs: 2_000 }, 'inline')).toBe(1_000);
    expect(getRefreshLeadMs({ ...base, lifetimeMs: 3_600_000 }, 'proactive')).toBe(300_000);
    expect(getRefreshLeadMs({ ...base, lifetimeMs: 3_600_000 }, 'inline')).toBe(60_000);
    expect(getRefreshLeadMs(base, 'proactive')).toBe(300_000);
    expect(getRefreshLeadMs(base, 'inline')).toBe(60_000);
  });

  test('global scheduler rescans the store and discovers a later short-TTL credential', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-16T00:00:00.000Z') });
    const now = Date.now();
    await saveStateStore({
      long: {
        token: {
          accessToken: 'long-access',
          refreshToken: 'long-refresh',
          tokenType: 'Bearer',
          expiresAt: now + 3_600_000,
          lifetimeMs: 3_600_000,
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: now,
        },
      },
      noExpiry: {
        token: {
          accessToken: 'no-expiry-access',
          refreshToken: 'no-expiry-refresh',
          tokenType: 'Bearer',
        },
      },
    });

    let refreshCalls = 0;
    globalThis.fetch = (async () => {
      refreshCalls += 1;
      return new Response(JSON.stringify({
        access_token: 'short-refreshed',
        refresh_token: 'short-rotated',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    startTokenRefreshScheduler();
    writeExternalState({
      ...JSON.parse(readFileSync(stateFile(), 'utf-8')),
      short: {
        token: {
          accessToken: 'short-access',
          refreshToken: 'short-refresh',
          tokenType: 'Bearer',
          expiresAt: now + 4_000,
          lifetimeMs: 10_000,
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: now,
        },
      },
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(refreshCalls).toBe(1);
    expect(getServerState('short')?.token?.accessToken).toBe('short-refreshed');
    expect(getServerState('short')?.token?.refreshToken).toBe('short-rotated');
    expect(getServerState('noExpiry')?.token?.accessToken).toBe('no-expiry-access');
  });

  test('bounded store rescans do not turn a failed token endpoint into a five-second request loop', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-16T00:00:00.000Z') });
    await saveStateStore({
      failing: {
        tokenRevision: 4,
        token: {
          accessToken: 'expired-access',
          refreshToken: 'failing-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
          lifetimeMs: 60_000,
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
      },
    });
    let refreshCalls = 0;
    globalThis.fetch = (async () => {
      refreshCalls += 1;
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    startTokenRefreshScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(refreshCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshCalls).toBe(2);
  });

  test('scheduler stop then restart cannot leave an untracked timer from the old cycle', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-16T00:00:00.000Z') });
    // This assertion owns the scheduler timer only. The refresh request's
    // AbortSignal deadline is orthogonal and may otherwise be counted by
    // Vitest fake timers under full-suite load.
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal);
    await saveStateStore({
      notion: {
        token: {
          accessToken: 'expired-access',
          refreshToken: 'refresh-token',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
          lifetimeMs: 60_000,
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
      },
    });

    let finishRequest!: (response: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => {
      finishRequest = resolve;
    })) as typeof fetch;

    const fakeSetTimeout = globalThis.setTimeout;
    const schedulerHandles: ReturnType<typeof setTimeout>[] = [];
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
      const handle = fakeSetTimeout(...args);
      // Attribute the handle at creation to the real scheduler owner, rather
      // than counting every timer/job on Vitest's shared fake clock.
      if (new Error().stack?.includes('scheduleNextRefreshCycle')) {
        schedulerHandles.push(handle);
      }
      return handle;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    let unrelatedHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      startTokenRefreshScheduler();
      await vi.advanceTimersByTimeAsync(0);
      stopTokenRefreshScheduler();
      startTokenRefreshScheduler();
      await vi.advanceTimersByTimeAsync(0);
      expect(schedulerHandles).toHaveLength(0);
      // An unrelated owner can publish during this same settlement window.
      // Its timer must not change the scheduler ownership assertion.
      unrelatedHandle = setTimeout(() => {}, 60_000);

      finishRequest(new Response(JSON.stringify({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      await vi.advanceTimersByTimeAsync(0);

      // Both generations awaited the same real refresh. Exactly one timer
      // proves only the restarted generation published after it settled.
      expect(schedulerHandles).toHaveLength(1);
      const restartedHandle = schedulerHandles[0];
      expect(clearTimeoutSpy).not.toHaveBeenCalledWith(restartedHandle);
      stopTokenRefreshScheduler();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(restartedHandle);
      expect(clearTimeoutSpy.mock.calls.filter(([handle]) => handle === restartedHandle))
        .toHaveLength(1);
      expect(schedulerHandles).toHaveLength(1);
    } finally {
      stopTokenRefreshScheduler();
      if (unrelatedHandle !== undefined) clearTimeout(unrelatedHandle);
      clearTimeoutSpy.mockRestore();
      timeoutSpy.mockRestore();
      abortTimeoutSpy.mockRestore();
    }
  });

  test('authorization callback reports failure when durable credential commit fails', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: 'unpersisted-access',
      refresh_token: 'unpersisted-refresh',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { authUrl, waitForToken } = await startAuthorizationFlow('notion', {
        clientId: 'client-id',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        callbackPort: 0,
      }, async () => {
        throw new Error('simulated durable write failure');
      });
      const authorizationUrl = new URL(authUrl);
      const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
      const state = authorizationUrl.searchParams.get('state');
      if (!redirectUri || !state) throw new Error('authorization URL missing callback parameters');

      const callbackResponse = await originalFetch(
        `${redirectUri}?code=authorization-code&state=${encodeURIComponent(state)}`,
      );
      const callbackHtml = await callbackResponse.text();

      expect(await waitForToken).toBeNull();
      expect(callbackHtml).toContain('Authorization failed while saving credentials');
      expect(callbackHtml).not.toContain('Authorization successful');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('a superseded authorization exchange cannot commit or close its replacement flow', async () => {
    let tokenRequestCount = 0;
    let finishFirstRequest!: (response: Response) => void;
    let markFirstRequestStarted!: () => void;
    const firstRequestStarted = new Promise<void>(resolve => {
      markFirstRequestStarted = resolve;
    });
    globalThis.fetch = vi.fn(() => {
      tokenRequestCount += 1;
      if (tokenRequestCount === 1) {
        markFirstRequestStarted();
        return new Promise<Response>(resolve => { finishFirstRequest = resolve; });
      }
      return Promise.resolve(new Response(JSON.stringify({
        access_token: 'replacement-access',
        refresh_token: 'replacement-refresh',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as typeof fetch;
    const firstCommits: string[] = [];
    const replacementCommits: string[] = [];
    const config = {
      clientId: 'client-id',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      callbackPort: 0,
    };

    const first = await startAuthorizationFlow('notion', config, async (token) => {
      firstCommits.push(token.accessToken);
    });
    const firstUrl = new URL(first.authUrl);
    const firstRedirect = firstUrl.searchParams.get('redirect_uri');
    const firstState = firstUrl.searchParams.get('state');
    if (!firstRedirect || !firstState) throw new Error('first authorization URL incomplete');
    const firstCallback = originalFetch(
      `${firstRedirect}?code=first-code&state=${encodeURIComponent(firstState)}`,
    ).catch(() => null);
    await firstRequestStarted;

    const replacement = await startAuthorizationFlow('notion', config, async (token) => {
      replacementCommits.push(token.accessToken);
    });
    finishFirstRequest(new Response(JSON.stringify({
      access_token: 'superseded-access',
      refresh_token: 'superseded-refresh',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await firstCallback;
    expect(await first.waitForToken).toBeNull();
    expect(firstCommits).toEqual([]);
    expect(isFlowPending('notion')).toBe(true);

    const replacementUrl = new URL(replacement.authUrl);
    const replacementRedirect = replacementUrl.searchParams.get('redirect_uri');
    const replacementState = replacementUrl.searchParams.get('state');
    if (!replacementRedirect || !replacementState) {
      throw new Error('replacement authorization URL incomplete');
    }
    const replacementResponse = await originalFetch(
      `${replacementRedirect}?code=replacement-code&state=${encodeURIComponent(replacementState)}`,
    );

    expect(await replacement.waitForToken).not.toBeNull();
    expect(await replacementResponse.text()).toContain('Authorization successful');
    expect(replacementCommits).toEqual(['replacement-access']);
    expect(isFlowPending('notion')).toBe(false);
  });

  test('duplicate callbacks for one flow cannot exchange or commit twice', async () => {
    let tokenRequests = 0;
    let finishRequest!: (response: Response) => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>(resolve => { markRequestStarted = resolve; });
    globalThis.fetch = vi.fn(() => {
      tokenRequests += 1;
      markRequestStarted();
      return new Promise<Response>(resolve => { finishRequest = resolve; });
    }) as typeof fetch;
    const commits: string[] = [];
    const flow = await startAuthorizationFlow('notion', {
      clientId: 'client-id',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      callbackPort: 0,
    }, async (token) => {
      commits.push(token.accessToken);
    });
    const authorizationUrl = new URL(flow.authUrl);
    const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
    const state = authorizationUrl.searchParams.get('state');
    if (!redirectUri || !state) throw new Error('authorization URL missing callback parameters');
    const callbackUrl = `${redirectUri}?code=same-code&state=${encodeURIComponent(state)}`;

    const firstCallback = originalFetch(callbackUrl);
    await requestStarted;
    const duplicateCallback = await originalFetch(callbackUrl);
    expect(duplicateCallback.status).toBe(409);
    expect(await duplicateCallback.text()).toContain('already being processed');

    finishRequest(new Response(JSON.stringify({
      access_token: 'single-access',
      refresh_token: 'single-refresh',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect((await firstCallback).status).toBe(200);
    expect(await flow.waitForToken).not.toBeNull();
    expect(tokenRequests).toBe(1);
    expect(commits).toEqual(['single-access']);
  });

  test('concurrent authorization starts leave exactly one live flow owner', async () => {
    const config = {
      clientId: 'client-id',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      callbackPort: 0,
    };
    const firstStart = startAuthorizationFlow('notion', config, async () => {});
    const secondStart = startAuthorizationFlow('notion', config, async () => {});

    await expect(firstStart).rejects.toThrow('Authorization start superseded for notion');
    const second = await secondStart;
    expect(isFlowPending('notion')).toBe(true);

    const authorizationUrl = new URL(second.authUrl);
    const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
    if (!redirectUri) throw new Error('authorization URL missing redirect URI');
    await originalFetch(`${redirectUri}?error=access_denied`);
    expect(await second.waitForToken).toBeNull();
    expect(isFlowPending('notion')).toBe(false);
  });

  test('a failed authorization attempt does not invalidate shared discovery metadata', async () => {
    const discovery = {
      authServerUrl: 'https://auth.example.com',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      discoveredAt: Date.now(),
    };
    await saveStateStore({ notion: { discovery } });

    const flow = await authorizeServer('notion', 'https://mcp.example.com', {
      clientId: 'client-id',
      authorizationUrl: discovery.authorizationEndpoint,
      tokenUrl: discovery.tokenEndpoint,
    });
    const authorizationUrl = new URL(flow.authUrl);
    const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
    if (!redirectUri) throw new Error('authorization URL missing redirect URI');
    await originalFetch(`${redirectUri}?error=access_denied`);

    expect(await flow.waitForCompletion).toBe(false);
    expect(getServerState('notion')?.discovery).toEqual(discovery);
  });

  test('revoke linearizes after an in-flight authorization flow and remains the final credential state', async () => {
    const discovery = {
      authServerUrl: 'https://auth.example.com',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      discoveredAt: Date.now(),
    };
    await saveStateStore({ notion: { discovery } });
    let finishExchange!: (response: Response) => void;
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>(resolve => { markExchangeStarted = resolve; });
    globalThis.fetch = vi.fn(() => {
      markExchangeStarted();
      return new Promise<Response>(resolve => { finishExchange = resolve; });
    }) as typeof fetch;

    const flow = await authorizeServer('notion', 'https://mcp.example.com', {
      clientId: 'client-id',
      authorizationUrl: discovery.authorizationEndpoint,
      tokenUrl: discovery.tokenEndpoint,
    });
    const authorizationUrl = new URL(flow.authUrl);
    const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
    const state = authorizationUrl.searchParams.get('state');
    if (!redirectUri || !state) throw new Error('authorization URL missing callback parameters');
    const callback = originalFetch(
      `${redirectUri}?code=soon-revoked-code&state=${encodeURIComponent(state)}`,
    ).catch(() => null);
    await exchangeStarted;

    await revokeAuthorization('notion');
    finishExchange(new Response(JSON.stringify({
      access_token: 'must-not-be-committed',
      refresh_token: 'must-not-be-persisted',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await callback;

    expect(await flow.waitForCompletion).toBe(false);
    expect(getServerState('notion')?.tokenRevision).toBe(1);
    expect(getServerState('notion')?.token).toBeUndefined();
    expect(readFileSync(stateFile(), 'utf-8')).not.toContain('must-not-be-committed');
  });

  test('revoke also invalidates an authorization start before its callback flow materializes', async () => {
    const start = startAuthorizationFlow('notion', {
      clientId: 'client-id',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      callbackPort: 0,
    }, async () => {});

    await revokeAuthorization('notion');

    await expect(start).rejects.toThrow('Authorization start superseded for notion');
    expect(getServerState('notion')?.tokenRevision).toBe(1);
    expect(getServerState('notion')?.token).toBeUndefined();
    expect(isFlowPending('notion')).toBe(false);
  });

  test('successful token response is reported failed when the credential cannot be persisted', async () => {
    await saveStateStore({
      notion: {
        token: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
      },
    });

    const validConfigDir = configDir;
    const invalidConfigDir = join(configDir, 'not-a-directory');
    globalThis.fetch = (async () => {
      writeFileSync(invalidConfigDir, 'file blocks directory creation');
      process.env.MYAGENTS_CONFIG_DIR = invalidConfigDir;
      return new Response(JSON.stringify({
        access_token: 'unpersisted-access',
        refresh_token: 'unpersisted-refresh',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const outcome = await refreshToken('notion');
    process.env.MYAGENTS_CONFIG_DIR = validConfigDir;
    resetStateStoreCacheForTests();

    expect(outcome.kind).toBe('failed');
    expect(getServerState('notion')?.token?.accessToken).toBe('old-access');
    expect(readFileSync(stateFile(), 'utf-8')).not.toContain('unpersisted-access');
  });

  test('an in-flight refresh response cannot resurrect a credential revoked after its request began', async () => {
    await saveStateStore({
      notion: {
        tokenRevision: 4,
        token: {
          accessToken: 'soon-revoked-access',
          refreshToken: 'soon-revoked-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
      },
    });

    let finishRequest!: (response: Response) => void;
    let requestStarted!: () => void;
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    globalThis.fetch = vi.fn(() => {
      requestStarted();
      return new Promise<Response>(resolve => { finishRequest = resolve; });
    }) as typeof fetch;

    const refreshPromise = refreshToken('notion', 'inline');
    await started;
    expect(await clearServerToken('notion')).toBe(5);
    finishRequest(new Response(JSON.stringify({
      access_token: 'obsolete-refresh-response',
      refresh_token: 'obsolete-rotated-refresh',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const outcome = await refreshPromise;
    expect(outcome).toEqual({
      kind: 'discarded_after_conflict',
      reason: 'credential_missing',
      tokenRevision: 5,
    });
    expect(getServerState('notion')?.tokenRevision).toBe(5);
    expect(getServerState('notion')?.token).toBeUndefined();
    expect(readFileSync(stateFile(), 'utf-8')).not.toContain('obsolete-refresh-response');
  });

  test('HTTP refresh failure preserves the prior credential and never logs token material', async () => {
    await saveStateStore({
      notion: {
        tokenRevision: 7,
        token: {
          accessToken: 'old-secret-access',
          refreshToken: 'old-secret-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
      },
    });
    globalThis.fetch = (async () => new Response(
      'server-error-including-secret-token-material',
      { status: 500 },
    )) as typeof fetch;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => logs.push(args.join(' ')));

    try {
      const outcome = await refreshToken('notion');
      expect(outcome).toEqual({ kind: 'failed', error: 'HTTP 500', http: 'failed' });
      expect(getServerState('notion')?.tokenRevision).toBe(7);
      expect(getServerState('notion')?.token?.accessToken).toBe('old-secret-access');
      expect(logs.join('\n')).not.toContain('old-secret-access');
      expect(logs.join('\n')).not.toContain('old-secret-refresh');
      expect(logs.join('\n')).not.toContain('server-error-including-secret-token-material');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test.each([
    {
      label: 'HTTP 401',
      transport: async () => new Response('{}', { status: 401 }),
      expectedError: 'HTTP 401',
    },
    {
      label: 'request timeout',
      transport: async () => { throw new DOMException('simulated token timeout', 'TimeoutError'); },
      expectedError: 'simulated token timeout',
    },
  ])('$label refresh failure is explicit and preserves the credential', async ({
    transport,
    expectedError,
  }) => {
    await saveStateStore({
      notion: {
        tokenRevision: 9,
        token: {
          accessToken: 'preserved-access',
          refreshToken: 'preserved-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
      },
    });
    globalThis.fetch = transport as typeof fetch;

    const outcome = await refreshToken('notion', 'inline');

    expect(outcome).toEqual({ kind: 'failed', error: expectedError, http: 'failed' });
    expect(getServerState('notion')?.tokenRevision).toBe(9);
    expect(getServerState('notion')?.token?.accessToken).toBe('preserved-access');
  });

  test('not-refreshable outcomes identify the missing prerequisite without network I/O', async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    await saveStateStore({ notion: {} });
    expect(await refreshToken('notion', 'manual')).toEqual({
      kind: 'not_refreshable',
      reason: 'missing_token',
    });

    await saveStateStore({
      notion: {
        token: { accessToken: 'access-only', tokenType: 'Bearer' },
      },
    });
    expect(await refreshToken('notion', 'manual')).toEqual({
      kind: 'not_refreshable',
      reason: 'missing_refresh_token',
    });

    await saveStateStore({
      notion: {
        token: {
          accessToken: 'access',
          refreshToken: 'refresh',
          tokenType: 'Bearer',
        },
      },
    });
    expect(await refreshToken('notion', 'manual')).toEqual({
      kind: 'not_refreshable',
      reason: 'missing_token_endpoint',
    });
    expect(fetchCalls).toBe(0);
  });

  test('stale cross-process refresh lock is reclaimed before refreshing', async () => {
    await saveStateStore({
      notion: {
        token: {
          accessToken: 'expired-access',
          refreshToken: 'refresh-after-stale-lock',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
        },
        discovery: {
          authServerUrl: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          discoveredAt: Date.now(),
        },
      },
    });
    const staleLock = join(configDir, 'mcp_oauth_locks', 'notion.lock');
    mkdirSync(staleLock, { recursive: true });
    writeFileSync(join(staleLock, 'owner'), 'stale-owner\n');
    const staleTime = new Date(Date.now() - 31_000);
    utimesSync(staleLock, staleTime, staleTime);
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: 'fresh-after-stale-lock',
      refresh_token: 'rotated-after-stale-lock',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const outcome = await refreshToken('notion');

    expect(outcome.kind).toBe('refreshed_by_self');
    expect(getServerState('notion')?.token?.accessToken).toBe('fresh-after-stale-lock');
  });

  test('cross-process refresh lock permits one HTTP refresh and followers observe it', async () => {
    const server = createServer((_request, response) => {
      requestCount += 1;
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          access_token: 'shared-access',
          refresh_token: 'shared-rotated-refresh',
        }));
      }, 500);
    });
    let requestCount = 0;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');

    await saveStateStore({
      notion: {
        token: {
          accessToken: 'expired-access',
          refreshToken: 'shared-refresh',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 1,
          lifetimeMs: 3_600_000,
        },
        discovery: {
          authServerUrl: `http://127.0.0.1:${address.port}`,
          authorizationEndpoint: `http://127.0.0.1:${address.port}/authorize`,
          tokenEndpoint: `http://127.0.0.1:${address.port}/token`,
          discoveredAt: Date.now(),
        },
      },
    });

    const fixture = fileURLToPath(new URL('./fixtures/mcp-oauth-refresh-child.ts', import.meta.url));
    const runChild = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', fixture, 'notion'], {
        env: {
          ...process.env,
          MYAGENTS_CONFIG_DIR: configDir,
          MYAGENTS_SIDECAR_ROLE: 'session',
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          NO_PROXY: '127.0.0.1,localhost',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', code => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`refresh child exited ${code}: ${stderr}`));
      });
    });

    try {
      const outputs = await Promise.all([runChild(), runChild(), runChild()]);
      const kinds = outputs.map(output => {
        const resultLine = output.split('\n').find(line => line.startsWith('RESULT:'));
        if (!resultLine) throw new Error(`missing child result: ${output}`);
        return (JSON.parse(resultLine.slice('RESULT:'.length)) as { kind: string }).kind;
      });

      expect(requestCount).toBe(1);
      expect(kinds.filter(kind => kind === 'refreshed_by_self')).toHaveLength(1);
      expect(kinds.filter(kind => kind === 'observed_after_lock')).toHaveLength(2);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20_000);

  test('concurrent saveStateStore calls serialize without losing entries', async () => {
    // Two separate async chains both writing to the same store. Without proper
    // per-chain reentrancy isolation, both could bypass the file lock and one
    // write could clobber the other (read-modify-write race).
    await saveStateStore({});

    const writeA = (async () => {
      await updateServerState('serverA', {
        registration: { clientId: 'client-a', registeredAt: 1 },
      });
    })();
    const writeB = (async () => {
      await updateServerState('serverB', {
        registration: { clientId: 'client-b', registeredAt: 2 },
      });
    })();

    await Promise.all([writeA, writeB]);

    const persisted = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(persisted.serverA?.registration?.clientId).toBe('client-a');
    expect(persisted.serverB?.registration?.clientId).toBe('client-b');
  });
});
