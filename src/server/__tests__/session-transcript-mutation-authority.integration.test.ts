import { createLegacySession } from './fixtures/session-store';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '../types/session';

type SessionStoreModule = typeof import('../SessionStore');

let testHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let store: SessionStoreModule;

function message(id: string, role: 'user' | 'assistant' = 'user'): SessionMessage {
  return {
    id,
    role,
    content: id,
    timestamp: '2026-08-05T00:00:00.000Z',
  };
}

function transcriptPath(sessionId: string): string {
  return join(testHome, '.myagents', 'sessions', `${sessionId}.jsonl`);
}

function legacyTranscriptPath(sessionId: string): string {
  return join(testHome, '.myagents', 'sessions', `${sessionId}.json`);
}

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'myagents-transcript-authority-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  vi.resetModules();
  store = await import('../SessionStore');
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(testHome, { recursive: true, force: true });
});

describe('Session transcript mutation authority', () => {
  it('refuses a stale short owner after another writer advances the durable transcript (#510)', async () => {
    const session = await createLegacySession(store, '/tmp/transcript-authority');
    const initial = await store.loadSessionTranscript(session.id);
    const history = Array.from({ length: 22 }, (_, index) => message(String(index), index % 2 ? 'assistant' : 'user'));
    const seeded = await store.appendSessionMessages(session.id, initial.cursor, history);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const staleOwner = await store.loadSessionTranscript(session.id);
    const currentOwner = await store.loadSessionTranscript(session.id);
    const advanced = await store.appendSessionMessages(session.id, currentOwner.cursor, [message('22')]);
    expect(advanced.ok).toBe(true);

    const before = readFileSync(transcriptPath(session.id), 'utf-8');
    const refused = await store.appendSessionMessages(
      session.id,
      staleOwner.cursor,
      [message('partial-live-row')],
    );

    expect(refused).toMatchObject({ ok: false, reason: 'stale-cursor' });
    expect(readFileSync(transcriptPath(session.id), 'utf-8')).toBe(before);
    expect((await store.loadSessionTranscript(session.id)).messages).toHaveLength(23);
  });

  it('recognizes an exact append retry without duplicating the durable suffix', async () => {
    const session = await createLegacySession(store, '/tmp/transcript-exact-retry');
    const snapshot = await store.loadSessionTranscript(session.id);
    const tail = [message('user-1')];

    expect((await store.appendSessionMessages(session.id, snapshot.cursor, tail)).ok).toBe(true);
    const retry = await store.appendSessionMessages(session.id, snapshot.cursor, tail);

    expect(retry).toMatchObject({ ok: true, action: 'appended', totalCount: 1 });
    expect((await store.loadSessionTranscript(session.id)).messages.map(item => item.id)).toEqual(['user-1']);
  });

  it('preserves malformed historical bytes for append but refuses destructive mutation', async () => {
    const session = await createLegacySession(store, '/tmp/transcript-malformed');
    const malformed = `${JSON.stringify(message('valid-1'))}\n{"broken"\n`;
    writeFileSync(transcriptPath(session.id), malformed, 'utf-8');
    const snapshot = await store.loadSessionTranscript(session.id);
    expect(snapshot.hasMalformedRows).toBe(true);

    const append = await store.appendSessionMessages(session.id, snapshot.cursor, [message('valid-2')]);
    expect(append.ok).toBe(true);
    expect(readFileSync(transcriptPath(session.id), 'utf-8')).toContain('{"broken"');

    if (!append.ok) return;
    const before = readFileSync(transcriptPath(session.id), 'utf-8');
    const mutation = await store.mutateSessionTranscript(session.id, append.cursor, {
      kind: 'sdk-retraction',
      sdkUuids: ['sdk-valid-1'],
    });
    expect(mutation).toMatchObject({ ok: false, reason: 'malformed-transcript' });
    expect(readFileSync(transcriptPath(session.id), 'utf-8')).toBe(before);
  });

  it('commits an explicit rewind truncation and advances the cursor to the target prefix', async () => {
    const session = await createLegacySession(store, '/tmp/transcript-retry');
    const snapshot = await store.loadSessionTranscript(session.id);
    const rows = [message('old'), message('failed'), message('partial', 'assistant')];
    const appended = await store.appendSessionMessages(session.id, snapshot.cursor, rows);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    const mutation = await store.mutateSessionTranscript(session.id, appended.cursor, {
      kind: 'builtin-rewind',
      targetMessageId: 'failed',
      targetMessageCount: 1,
    });

    expect(mutation).toMatchObject({ ok: true, action: 'replaced' });
    if (mutation.ok) expect(mutation.cursor.persistedMessageCount).toBe(1);
    expect((await store.loadSessionTranscript(session.id)).messages.map(item => item.id)).toEqual(['old']);
  });

  it('validates SDK UUID retraction against durable rows and only removes the open tail by message id', async () => {
    const session = await createLegacySession(store, '/tmp/transcript-sdk-retraction');
    const snapshot = await store.loadSessionTranscript(session.id);
    const rows = [
      { ...message('human-with-old-wrong-anchor', 'user'), sdkUuid: 'sdk-1' },
      { ...message('named-1', 'assistant'), sdkUuid: 'sdk-1' },
      { ...message('keep', 'assistant'), sdkUuid: 'sdk-2' },
      message('streaming-tail', 'assistant'),
    ];
    const appended = await store.appendSessionMessages(session.id, snapshot.cursor, rows);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    const result = await store.mutateSessionTranscript(session.id, appended.cursor, {
      kind: 'sdk-retraction',
      sdkUuids: ['sdk-1'],
      streamingTailMessageId: 'streaming-tail',
    });
    expect(result.ok).toBe(true);
    expect((await store.loadSessionTranscript(session.id)).messages.map(row => row.id)).toEqual(['human-with-old-wrong-anchor', 'keep']);
  });

  it('atomically migrates legacy JSON before the first cursor append', async () => {
    const session = await createLegacySession(store, '/tmp/transcript-legacy');
    writeFileSync(legacyTranscriptPath(session.id), JSON.stringify({ messages: [message('legacy')] }), 'utf-8');

    const snapshot = await store.loadSessionTranscript(session.id);
    expect(snapshot.messages.map(row => row.id)).toEqual(['legacy']);
    const appended = await store.appendSessionMessages(session.id, snapshot.cursor, [message('new')]);
    expect(appended.ok).toBe(true);
    expect((await store.loadSessionTranscript(session.id)).messages.map(row => row.id)).toEqual(['legacy', 'new']);
  });

  it('rechecks pending identity authority at the locked commit point', async () => {
    const sourceId = 'pending-authority-source';
    const targetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await store.saveSessionMetadata({
      id: sourceId,
      runtime: 'builtin',
      agentDir: '/tmp/transcript-authority',
      title: 'Pending',
      createdAt: '2026-08-05T00:00:00.000Z',
      lastActiveAt: '2026-08-05T00:00:00.000Z',
    });

    const result = await store.migratePendingSessionIdentity(
      sourceId,
      targetId,
      { sdkSessionId: targetId, unifiedSession: true },
      () => false,
    );
    expect(result).toEqual({ migrated: false, reason: 'authority-revoked' });
    expect(store.getSessionMetadata(sourceId)?.id).toBe(sourceId);
    expect(store.getSessionMetadata(targetId)).toBeNull();
  });
});
