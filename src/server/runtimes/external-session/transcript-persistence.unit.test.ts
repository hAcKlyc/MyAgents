import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptWriteCursor } from '../../SessionStore';
import {
  appendSessionMessages,
  loadSessionTranscript,
  mutateSessionTranscript,
  updateSessionMetadata,
} from '../../SessionStore';
import type { SessionMessage } from '../../types/session';
import {
  appendAndPersistExternalAssistantTurn,
  clearExternalSessionMessages,
  getExternalSessionMessagesSnapshot,
  getExternalTranscriptSessionId,
  persistExternalUserMessageAppend,
  pushExternalSessionMessage,
  removeAndPersistExternalSessionMessage,
  retryUnadmittedDshTranscript,
  resetExternalTranscriptState,
  setExternalSessionMessages,
} from './transcript-persistence';

vi.mock('../../SessionStore', () => ({
  getActiveSessionTranscript: vi.fn(),
  appendSessionMessages: vi.fn(),
  loadSessionTranscript: vi.fn(),
  mutateSessionTranscript: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));

function cursor(persistedMessageCount: number): TranscriptWriteCursor {
  return { persistedMessageCount } as TranscriptWriteCursor;
}

function message(id: string, role: 'user' | 'assistant' = 'user'): SessionMessage {
  return {
    id,
    role,
    content: id,
    timestamp: '2026-08-05T00:00:00.000Z',
  };
}

describe('external transcript persistence owner', () => {
  beforeEach(() => {
    resetExternalTranscriptState();
    vi.clearAllMocks();
    vi.mocked(loadSessionTranscript).mockResolvedValue({
      messages: [],
      cursor: cursor(0),
      hasMalformedRows: false,
    });
    vi.mocked(appendSessionMessages).mockImplementation(async (_sessionId, current, messages) => ({
      ok: true,
      action: messages.length > 0 ? 'appended' : 'noop',
      count: messages.length,
      totalCount: current.persistedMessageCount + messages.length,
      cursor: cursor(current.persistedMessageCount + messages.length),
    }));
    vi.mocked(mutateSessionTranscript).mockImplementation(async (_sessionId, current) => ({
      ok: true,
      action: 'noop',
      cursor: current,
    }));
    vi.mocked(updateSessionMetadata).mockResolvedValue(null);
  });

  it('truncates only the proven unadmitted DSH retry target', async () => {
    const desktopQuery = { visibleText: 'target', primaryContext: { kind: 'floating-context' as const, input: { appName: 'Editor', selectedText: 'context' } } };
    setExternalSessionMessages('session-a', [message('prior'), { ...message('target'), desktopQuery }], cursor(2));
    vi.mocked(mutateSessionTranscript).mockResolvedValueOnce({
      ok: true,
      action: 'replaced',
      cursor: cursor(1),
    } as Awaited<ReturnType<typeof mutateSessionTranscript>>);

    await expect(retryUnadmittedDshTranscript('session-a', 'target')).resolves.toMatchObject({
      success: true,
      content: 'target',
      desktopQuery,
    });
    expect(mutateSessionTranscript).toHaveBeenCalledWith(
      'session-a',
      expect.objectContaining({ persistedMessageCount: 2 }),
      { kind: 'dsh-unadmitted-retry', targetMessageId: 'target', targetMessageCount: 1 },
    );
    expect(getExternalSessionMessagesSnapshot().map(item => item.id)).toEqual(['prior']);
  });

  it('tracks transcript Session ownership and cursor together', () => {
    setExternalSessionMessages('session-a', [message('a-1')], cursor(1));
    expect(getExternalTranscriptSessionId()).toBe('session-a');
    expect(getExternalSessionMessagesSnapshot().map(item => item.id)).toEqual(['a-1']);

    clearExternalSessionMessages('session-b');
    expect(getExternalTranscriptSessionId()).toBe('session-b');
    expect(getExternalSessionMessagesSnapshot()).toEqual([]);
  });

  it('passes only rows after the issued cursor to user append', async () => {
    setExternalSessionMessages('session-a', [message('old')], cursor(1));
    pushExternalSessionMessage(message('new'));

    await persistExternalUserMessageAppend('session-a', 'new', 'persist user');

    expect(appendSessionMessages).toHaveBeenCalledWith(
      'session-a',
      expect.objectContaining({ persistedMessageCount: 1 }),
      [expect.objectContaining({ id: 'new' })],
    );
    expect(updateSessionMetadata).toHaveBeenCalledWith('session-a', {
      lastMessagePreview: 'new',
    });
  });



  it('rehydrates a short projection before append instead of shrinking disk', async () => {
    const durable = [message('0'), message('1', 'assistant'), message('2')];
    setExternalSessionMessages('session-a', [message('partial')], cursor(3));
    vi.mocked(loadSessionTranscript).mockResolvedValueOnce({
      messages: durable,
      cursor: cursor(3),
      hasMalformedRows: false,
    });

    await expect(persistExternalUserMessageAppend('session-a', 'partial', 'persist user'))
      .rejects.toThrow('projection invariant failed');

    expect(appendSessionMessages).not.toHaveBeenCalled();
    expect(getExternalSessionMessagesSnapshot()).toEqual(durable);
  });

  it('commits a rejected-message mutation before changing live state', async () => {
    setExternalSessionMessages('session-a', [message('old'), message('rejected')], cursor(2));
    vi.mocked(mutateSessionTranscript).mockImplementationOnce(async () => {
      expect(getExternalSessionMessagesSnapshot().map(item => item.id)).toEqual(['old', 'rejected']);
      return { ok: true, action: 'replaced', cursor: cursor(1) };
    });

    await expect(removeAndPersistExternalSessionMessage(
      'session-a',
      'rejected',
      'rollback failed user',
    )).resolves.toBe(true);
    expect(getExternalSessionMessagesSnapshot().map(item => item.id)).toEqual(['old']);
  });

  it('appends one terminal assistant row and persists derived metadata', async () => {
    setExternalSessionMessages('session-a', [message('user-root')], cursor(1));
    const result = await appendAndPersistExternalAssistantTurn({
      sessionId: 'session-a',
      content: JSON.stringify([{ type: 'text', text: 'done' }]),
      usage: null,
      toolCount: 0,
      contextUsage: null,
      completedAt: '2026-11-07T05:00:05Z',
      runtimeTurnAnchor: { turnId: 'turn-1', rootUserMessageId: 'user-root' },
    });

    expect(getExternalSessionMessagesSnapshot().at(-1)?.completedAt).toBe('2026-11-07T05:00:05Z');
    expect(result).toMatchObject({ ok: true, appendedAssistant: true, messageCount: 2 });
    expect(appendSessionMessages).toHaveBeenCalledWith(
      'session-a',
      expect.objectContaining({ persistedMessageCount: 1 }),
      [expect.objectContaining({
        role: 'assistant',
        runtimeTurnAnchor: expect.objectContaining({ turnId: 'turn-1' }),
      })],
    );
  });

  it('keeps transcript success when only metadata projection fails', async () => {
    setExternalSessionMessages('session-a', [message('user-root')], cursor(1));
    vi.mocked(updateSessionMetadata).mockRejectedValueOnce(new Error('metadata unavailable'));

    await expect(appendAndPersistExternalAssistantTurn({
      sessionId: 'session-a',
      content: 'done',
      usage: null,
      toolCount: 0,
      contextUsage: null,
    })).resolves.toMatchObject({ ok: true, appendedAssistant: true });
  });
});
