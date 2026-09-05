import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelQueueItem,
  ensureSdkMcpInSync,
  initializeAgent,
} from '../agent-session';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';
import {
  getQueryMcpMutation,
  getQueryMcpPrewarmOwner,
  isAbortRequested,
  resetLifecycleForTest,
  setQueryMcpPrewarmOwner,
  setQuerySession,
} from '../builtin-session/lifecycle';
import {
  resetConfigForTest,
  setFrozenSdkMcpFingerprint,
  setCurrentMcpServers,
  snapshotConfig,
} from '../builtin-session/config';
import {
  beginPromotedItem,
  getPromotedItemCancellation,
  resetQueueForTest,
  setTurnAdmissionTicket,
} from '../builtin-session/queue';
import type { MessageQueueItem } from '../builtin-session/types';

describe('live Query MCP mutation ownership', () => {
  beforeEach(async () => {
    resetLifecycleForTest();
    resetQueueForTest();
    resetConfigForTest();
    await initializeAgent('/tmp/myagents-mcp-live-mutation', null, undefined, {
      preWarmDisabled: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('omits retired bundled definitions when rebuilding a restored SDK MCP map', async () => {
    setCurrentMcpServers([
      { id: 'legacy-cuse', name: 'Legacy', isBuiltin: true, type: 'stdio', command: '__bundled_cuse__' },
      { id: 'custom-remote', name: 'Custom', isBuiltin: false, type: 'http', url: 'https://example.invalid/mcp' },
    ]);
    const setMcpServers = vi.fn(async () => ({ added: ['custom-remote'], removed: [], errors: {} }));
    setQuerySession({ setMcpServers, interrupt: vi.fn(), close: vi.fn() } as never);
    setFrozenSdkMcpFingerprint('old-map');
    await expect(ensureSdkMcpInSync()).resolves.toBe(true);
    expect(setMcpServers).toHaveBeenCalledWith({
      'custom-remote': expect.objectContaining({ type: 'http', url: 'https://example.invalid/mcp' }),
    });
    expect(snapshotConfig().mcpServers?.map(server => server.id)).toEqual(['legacy-cuse', 'custom-remote']);
  });

  it('single-flights overlapping ensures and makes later callers recompute', async () => {
    let releaseMutation!: () => void;
    const setMcpServers = vi.fn(() => new Promise<{
      added: string[];
      removed: string[];
      errors: Record<string, string>;
    }>((resolve) => {
      releaseMutation = () => resolve({ added: [], removed: [], errors: {} });
    }));
    const query = {
      setMcpServers,
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
    } as never;
    setQuerySession(query);
    setFrozenSdkMcpFingerprint('stale-owner');

    const first = ensureSdkMcpInSync();
    await vi.waitFor(() => {
      expect(setMcpServers).toHaveBeenCalledTimes(1);
      expect(getQueryMcpMutation()).not.toBeNull();
    });
    const second = ensureSdkMcpInSync();
    await Promise.resolve();
    expect(setMcpServers).toHaveBeenCalledTimes(1);

    releaseMutation();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    // The second ensure shared the first mutation, then rebuilt the desired
    // fingerprint and observed that the installed map was already current.
    expect(setMcpServers).toHaveBeenCalledTimes(1);
    expect(getQueryMcpMutation()).toBeNull();
  });

  it('does not treat an added-but-failed SDK 0.3.257+ server as a successful mutation', async () => {
    const query = {
      setMcpServers: vi.fn(async () => ({ added: ['failed-server'], removed: [], errors: { 'failed-server': 'connection failed' } })),
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
    } as never;
    setQuerySession(query);
    setFrozenSdkMcpFingerprint('stale-owner');
    await expect(ensureSdkMcpInSync()).resolves.toBe(false);
    expect(isAbortRequested()).toBe(true);
    expect(getQueryMcpPrewarmOwner()).toBeNull();
  });

  it('bounds a wedged SDK control request and invalidates the unsafe Query', async () => {
    vi.useFakeTimers();
    const setMcpServers = vi.fn(() => new Promise(() => undefined));
    const query = {
      setMcpServers,
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
    } as never;
    setQuerySession(query);
    setFrozenSdkMcpFingerprint('stale-owner');

    const synchronization = ensureSdkMcpInSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(setMcpServers).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(synchronization).resolves.toBe(false);

    expect(isAbortRequested()).toBe(true);
    expect(getQueryMcpMutation()).toBeNull();
  });

  it('does not claim a live mutation after generator promotion wins ownership', async () => {
    const setMcpServers = vi.fn();
    const query = {
      setMcpServers,
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
    } as never;
    setQuerySession(query);
    setFrozenSdkMcpFingerprint('stale-owner');
    setQueryMcpPrewarmOwner({
      query,
      fingerprint: 'stale-owner',
      requiredServerIds: ['stale-owner'],
    });
    beginPromotedItem({
      id: 'promotion-during-mcp-build',
      message: { role: 'user', content: [{ type: 'text', text: 'run task' }] },
      messageText: 'run task',
      wasQueued: false,
      resolve: () => undefined,
      channelDelivery: NO_CHANNEL_DELIVERY,
    });

    await expect(ensureSdkMcpInSync()).resolves.toBe(false);

    expect(setMcpServers).not.toHaveBeenCalled();
    expect(getQueryMcpMutation()).toBeNull();
    expect(getQueryMcpPrewarmOwner()).not.toBeNull();
    expect(snapshotConfig().deferredRestartReasons).toContain('mcp');
    expect(isAbortRequested()).toBe(false);
  });

  it('cancels both admission and promotion owners while a mutation fence is pending', async () => {
    const item: MessageQueueItem = {
      id: 'cancel-mutation-fence',
      message: { role: 'user', content: [{ type: 'text', text: 'run task' }] },
      messageText: 'run task',
      wasQueued: false,
      resolve: () => undefined,
      turnOwner: { kind: 'task', id: 'task-1' },
      channelDelivery: NO_CHANNEL_DELIVERY,
    };
    beginPromotedItem(item);
    const promotedCancellation = getPromotedItemCancellation(item.id);
    setTurnAdmissionTicket({
      queueId: item.id,
      createdAt: Date.now(),
      messageText: item.messageText,
      turnOwner: item.turnOwner,
      canceled: false,
    });

    await expect(cancelQueueItem(item.id)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(promotedCancellation).resolves.toBeUndefined();
  });
});
