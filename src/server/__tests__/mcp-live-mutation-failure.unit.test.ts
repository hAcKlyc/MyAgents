import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tools/builtin-mcp-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/builtin-mcp-registry')>();
  return {
    ...actual,
    getBuiltinMcpInstance: vi.fn(() => Promise.reject(new Error('builtin factory failed'))),
  };
});

vi.mock('../tools/im-bridge-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/im-bridge-tools')>();
  return { ...actual, getImBridgeToolSurface: vi.fn(actual.getImBridgeToolSurface) };
});

import {
  ensureSdkMcpInSync,
  forceReloadActiveSession,
  getBuiltinMcpEffectiveSnapshot,
  initializeAgent,
} from '../agent-session';
import { getImBridgeToolSurface } from '../tools/im-bridge-tools';
import {
  getQueryMcpPrewarmOwner,
  isAbortRequested,
  resetLifecycleForTest,
  setQueryMcpPrewarmOwner,
  setQuerySession,
} from '../builtin-session/lifecycle';
import {
  resetConfigForTest,
  setCurrentMcpServers,
  setFrozenSdkMcpFingerprint,
} from '../builtin-session/config';
import { resetQueueForTest } from '../builtin-session/queue';

describe('live Query MCP mutation recovery', () => {
  beforeEach(async () => {
    resetLifecycleForTest();
    resetQueueForTest();
    resetConfigForTest();
    await initializeAgent('/tmp/myagents-mcp-live-mutation-failure', null, undefined, {
      preWarmDisabled: true,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    forceReloadActiveSession();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('isolates a builtin factory failure while installing healthy servers on the same Query', async () => {
    const setMcpServers = vi.fn(async () => ({ added: ['healthy'], removed: [], errors: {} }));
    const query = {
      setMcpServers,
      mcpServerStatus: vi.fn(async () => [{ name: 'healthy', status: 'connected', tools: [{ name: 'test' }] }]),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(),
    } as never;
    setQuerySession(query);
    setQueryMcpPrewarmOwner({
      query,
      fingerprint: 'old',
      requiredServerIds: ['old'],
    });
    setFrozenSdkMcpFingerprint('old');
    setCurrentMcpServers([{
      id: 'factory-failure',
      name: 'factory-failure',
      isBuiltin: true,
      type: 'stdio',
      command: '__builtin__',
      args: [],
    }, {
      id: 'healthy', name: 'Healthy', isBuiltin: false, type: 'http', url: 'https://example.invalid/mcp',
    }]);

    await expect(ensureSdkMcpInSync()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(isAbortRequested()).toBe(false);
    expect(setMcpServers).toHaveBeenCalledWith({
      healthy: expect.objectContaining({ type: 'http', url: 'https://example.invalid/mcp' }),
    });
    expect(getQueryMcpPrewarmOwner()).toMatchObject({
      query, requiredServerIds: ['factory-failure', 'healthy'],
      buildFailures: { 'factory-failure': 'MCP_STARTUP_FAILED' },
    });
    expect(getBuiltinMcpEffectiveSnapshot()?.servers).toEqual([
      expect.objectContaining({ id: 'factory-failure', desired: true, state: 'failed', errorCode: 'MCP_STARTUP_FAILED', toolCount: 0 }),
      expect.objectContaining({ id: 'healthy', state: 'ready', toolCount: 1 }),
    ]);
  });

  it('invalidates the Query when the shared MCP map cannot be constructed', async () => {
    const setMcpServers = vi.fn();
    const query = { setMcpServers, interrupt: vi.fn(async () => {}), close: vi.fn() } as never;
    setQuerySession(query);
    setQueryMcpPrewarmOwner({ query, fingerprint: 'old', requiredServerIds: ['old'] });
    setFrozenSdkMcpFingerprint('old');
    vi.mocked(getImBridgeToolSurface).mockImplementationOnce(() => { throw new Error('shared map unavailable'); });

    await expect(ensureSdkMcpInSync()).resolves.toBe(false);

    expect(isAbortRequested()).toBe(true);
    expect(getQueryMcpPrewarmOwner()).toBeNull();
    expect(setMcpServers).not.toHaveBeenCalled();
  });
});
