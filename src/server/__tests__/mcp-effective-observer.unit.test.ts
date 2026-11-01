import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const browser = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('../browser-host/capability-client', () => ({
  acquireBrowserCapability: browser.acquire,
  adoptBrowserProductSession: vi.fn(async () => {}),
}));
import {
  ensureSdkMcpInSync,
  forceReloadActiveSession,
  getBuiltinMcpEffectiveSnapshot,
  initializeAgent,
  retryBuiltinMcpServer,
} from '../agent-session';
import {
  lifecycleState,
  resetLifecycleForTest,
  setSessionProcessing,
  setPreWarmInProgress,
  setQuerySession,
  setPreWarmDisabled,
  recordQueryBackgroundTask,
  replaceQueryBackgroundActivity,
} from '../builtin-session/lifecycle';
import { resetConfigForTest, setCurrentMcpServers, setFrozenSdkMcpFingerprint } from '../builtin-session/config';
import { beginPromotedItem, resetQueueForTest } from '../builtin-session/queue';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const ready = [{ name: 'playwright', status: 'connected', tools: [{ name: 'browser_navigate' }] }];
function query(read: () => Promise<unknown>) {
  return {
    mcpServerStatus: vi.fn(read),
    setMcpServers: vi.fn(async (_servers?: unknown) => ({ added: ['playwright'], removed: [], errors: {} })),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(),
  };
}
async function install(target: ReturnType<typeof query>, fingerprint: string) {
  setQuerySession(target as never);
  setFrozenSdkMcpFingerprint(fingerprint);
  expect(await ensureSdkMcpInSync()).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
}

describe('effective MCP observer owns every asynchronous completion', () => {
  beforeEach(async () => {
    browser.acquire.mockReset();
    resetLifecycleForTest();
    resetQueueForTest();
    resetConfigForTest();
    await initializeAgent('/tmp/myagents-mcp-effective-observer', null, undefined, { preWarmDisabled: true });
    setCurrentMcpServers([{ id: 'playwright', name: 'Browser', isBuiltin: false, type: 'http', url: 'https://example.invalid/mcp' }]);
    vi.useFakeTimers();
  });
  afterEach(() => {
    forceReloadActiveSession();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps a selected server visible when configuration fails before SDK installation', async () => {
    setCurrentMcpServers([{ id: 'broken', name: 'Broken', isBuiltin: false, type: 'http',
      url: 'https://example.invalid/{{MYAGENTS_TEST_MISSING_MCP_ENV}}/mcp' }]);
    await install(query(async () => []), 'before-build');
    expect(getBuiltinMcpEffectiveSnapshot()?.servers).toEqual([
      expect.objectContaining({ id: 'broken', desired: true, state: 'failed', errorCode: 'MCP_CONFIG_INVALID' }),
    ]);
    setCurrentMcpServers([{ id: 'broken', name: 'Fixed', isBuiltin: false, type: 'http', url: 'https://example.invalid/mcp' }]);
    const fixed = query(async () => [{ name: 'broken', status: 'connected', tools: [{ name: 'test' }] }]);
    await install(fixed, 'config-corrected');
    expect(getBuiltinMcpEffectiveSnapshot()?.servers).toEqual([
      expect.objectContaining({ id: 'broken', desired: true, state: 'ready', toolCount: 1 }),
    ]);
    expect(getBuiltinMcpEffectiveSnapshot()?.servers[0].errorCode).toBeUndefined();
  });

  it.each(['constructor', 'toString'])('handles the opaque server ID %s without prototype lookups', async id => {
    setCurrentMcpServers([{ id, name: 'Custom', isBuiltin: false, type: 'http', url: 'https://example.invalid/mcp' }]);
    const target = query(async () => [{ name: id, status: 'connected', tools: [{ name: 'tool' }] }]);
    await install(target, 'new-map');
    expect(Object.hasOwn(target.setMcpServers.mock.calls[0][0] as object, id)).toBe(true);
    expect(getBuiltinMcpEffectiveSnapshot()?.servers).toEqual([
      expect.objectContaining({ id, state: 'ready', toolCount: 1 }),
    ]);
    setCurrentMcpServers([{ id, name: 'Custom', isBuiltin: false, type: 'http', url: 'https://example.invalid/{{MISSING}}' }]);
    await ensureSdkMcpInSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(getBuiltinMcpEffectiveSnapshot()?.servers).toEqual([
      expect.objectContaining({ id, state: 'failed', errorCode: 'MCP_CONFIG_INVALID', toolCount: 0 }),
    ]);
  });

  it('reports a prototype-named reserved server as a bounded configuration failure', async () => {
    setCurrentMcpServers([{ id: '__proto__', name: 'Reserved', isBuiltin: false, type: 'http', url: 'https://example.invalid/mcp' }]);
    const target = query(async () => []);
    await install(target, 'reserved-map');
    expect(Object.hasOwn(target.setMcpServers.mock.calls[0][0] as object, '__proto__')).toBe(false);
    expect(getBuiltinMcpEffectiveSnapshot()?.servers).toEqual([
      expect.objectContaining({ id: '__proto__', state: 'failed', errorCode: 'MCP_CONFIG_INVALID', toolCount: 0 }),
    ]);
  });

  it.each(['resolve', 'reject', 'timeout'] as const)('ignores a retired Query status %s', async completion => {
    const retiredRead = deferred<unknown>();
    await install(query(() => retiredRead.promise), 'first');
    await install(query(async () => ready), 'replacement');
    const current = getBuiltinMcpEffectiveSnapshot();
    expect(current?.servers[0].state).toBe('ready');
    if (completion === 'resolve') retiredRead.resolve([{ name: 'playwright', status: 'failed' }]);
    if (completion === 'reject') retiredRead.reject(new Error('retired failure'));
    await vi.advanceTimersByTimeAsync(completion === 'timeout' ? 2_000 : 0);
    expect(getBuiltinMcpEffectiveSnapshot()).toEqual(current);
  });

  it('also rejects a late result from the same Query with an older MCP map revision', async () => {
    const retiredRead = deferred<unknown>();
    const target = query(async () => ready);
    target.mcpServerStatus.mockImplementationOnce(() => retiredRead.promise);
    await install(target, 'first');
    setFrozenSdkMcpFingerprint('changed-map');
    await ensureSdkMcpInSync();
    await vi.advanceTimersByTimeAsync(0);
    const current = getBuiltinMcpEffectiveSnapshot();
    expect(current?.servers[0].state).toBe('ready');
    retiredRead.resolve([{ name: 'playwright', status: 'failed' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(getBuiltinMcpEffectiveSnapshot()).toEqual(current);
  });

  it('invalidates capabilities immediately on abort and advances the replay envelope', async () => {
    await install(query(async () => [{ name: 'playwright', status: 'failed', error: 'Connection timed out' }]), 'first');
    const failed = getBuiltinMcpEffectiveSnapshot()!;
    expect(failed.servers[0].errorCode).toBe('MCP_CONNECTION_TIMEOUT');
    forceReloadActiveSession();
    const cleared = getBuiltinMcpEffectiveSnapshot()!;
    expect(cleared.sessionId).toBe(failed.sessionId);
    expect(cleared.revision).toBeGreaterThan(failed.revision);
    expect(cleared.catalogGeneration).toBeGreaterThan(failed.catalogGeneration);
    expect(cleared.servers).toEqual([]);
    expect(cleared.tools).toEqual([]);
  });

  it('keeps observation failure distinct from a newly failed connection', async () => {
    const target = query(async () => ready);
    await install(target, 'first');
    target.mcpServerStatus.mockRejectedValueOnce(new Error('status control unavailable'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getBuiltinMcpEffectiveSnapshot()).toMatchObject({
      observationStale: true,
      servers: [{ state: 'ready' }],
    });
  });

  it('accepts an explicit retry for unchanged config and invalidates the old failed catalog', async () => {
    const target = query(async () => [{ name: 'playwright', status: 'failed' }]);
    await install(target, 'first');
    // A completed real turn leaves its persistent Query processing, but idle.
    setSessionProcessing(true);
    setPreWarmInProgress(false);
    setPreWarmDisabled(false);
    expect(retryBuiltinMcpServer('playwright')).toEqual({ success: true });
    expect(getBuiltinMcpEffectiveSnapshot()?.servers).toEqual([]);
    expect(target.interrupt).toHaveBeenCalledOnce();
    expect(lifecycleState.abortRequested).toBe(true);
    expect(lifecycleState.preWarmTimer).not.toBeNull();
    expect(retryBuiltinMcpServer('playwright').success).toBe(false);
  });

  it('refuses retry once disabled, missing, or owned by an active turn', async () => {
    await install(query(async () => [{ name: 'playwright', status: 'failed' }]), 'first');
    expect(retryBuiltinMcpServer('unknown')).toMatchObject({ success: false, errorCode: 'server_not_failed' });
    setCurrentMcpServers([]);
    expect(retryBuiltinMcpServer('playwright')).toMatchObject({ success: false, errorCode: 'server_not_failed' });
    beginPromotedItem({
      id: 'active-promotion', message: { role: 'user', content: [{ type: 'text', text: 'working' }] },
      messageText: 'working', wasQueued: false, resolve: () => {}, channelDelivery: NO_CHANNEL_DELIVERY,
    });
    expect(retryBuiltinMcpServer('playwright')).toMatchObject({ success: false, errorCode: 'session_busy' });
    expect(getBuiltinMcpEffectiveSnapshot()?.servers[0].state).toBe('failed');
  });

  it('keeps a background task alive even when the foreground conversation is idle', async () => {
    const target = query(async () => [{ name: 'playwright', status: 'failed' }]);
    await install(target, 'first');
    recordQueryBackgroundTask(target as never, 'background-task', { description: 'working' });
    replaceQueryBackgroundActivity(target as never, [{ task_id: 'background-task', task_type: 'local_agent', description: 'working' }]);
    expect(retryBuiltinMcpServer('playwright')).toMatchObject({ success: false, errorCode: 'session_busy' });
    expect(target.interrupt).not.toHaveBeenCalled();
    expect(getBuiltinMcpEffectiveSnapshot()?.servers[0].state).toBe('failed');
  });

  it('ignores a retired Host recovery build before it can overwrite the replacement capability', async () => {
    const staleBuild = deferred<unknown>();
    const cap = (generation: number) => ({
      url: `http://127.0.0.1:9000/mcp/${generation}`,
      token: String(generation).repeat(32), hostGeneration: generation,
    });
    browser.acquire.mockResolvedValueOnce(cap(10)); // Initial map.
    browser.acquire.mockResolvedValueOnce(cap(11)); // Observer recovery acquire.
    browser.acquire.mockImplementationOnce(() => staleBuild.promise); // Nested map build.
    setCurrentMcpServers([{ id: 'myagents-browser', name: 'Browser', isBuiltin: true, type: 'stdio', command: '__browser_host__' }]);
    await install(query(async () => [{ name: 'myagents-browser', status: 'failed' }]), 'browser-first');
    expect(browser.acquire).toHaveBeenCalledTimes(3);

    browser.acquire.mockResolvedValue(cap(12));
    const replacement = query(async () => [{ name: 'myagents-browser', status: 'connected' }]);
    await install(replacement, 'replacement');
    const current = getBuiltinMcpEffectiveSnapshot();
    staleBuild.resolve(cap(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(getBuiltinMcpEffectiveSnapshot()).toEqual(current);
    // A stale Host write would increment capability revision and force another
    // setMcpServers on this unchanged healthy replacement during the next sync.
    expect(await ensureSdkMcpInSync()).toBe(true);
    expect(replacement.setMcpServers).toHaveBeenCalledOnce();
  });

  it('does not apply a retiring observer’s late Browser Host capability to its replacement', async () => {
    const capability = deferred<unknown>();
    browser.acquire.mockResolvedValueOnce({ url: 'http://127.0.0.1:9000/mcp/playwright', token: 'a'.repeat(32), hostGeneration: 1 });
    browser.acquire.mockImplementationOnce(() => capability.promise);
    setCurrentMcpServers([{ id: 'myagents-browser', name: 'Browser', isBuiltin: true, type: 'stdio', command: '__browser_host__' }]);
    await install(query(async () => [{ name: 'myagents-browser', status: 'failed' }]), 'browser-first');
    expect(browser.acquire).toHaveBeenCalledTimes(2);
    setCurrentMcpServers([{ id: 'playwright', name: 'Browser', isBuiltin: false, type: 'http', url: 'https://example.invalid/mcp' }]);
    const replacement = query(async () => ready);
    await install(replacement, 'replacement');
    const current = getBuiltinMcpEffectiveSnapshot();
    capability.resolve({ url: 'http://127.0.0.1:9001/mcp/playwright', token: 'b'.repeat(32), hostGeneration: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(getBuiltinMcpEffectiveSnapshot()).toEqual(current);
    expect(replacement.setMcpServers).toHaveBeenCalledOnce();
  });
});
