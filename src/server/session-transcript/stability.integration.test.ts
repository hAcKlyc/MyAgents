import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async original => ({ ...await original<typeof import('os')>(), homedir: () => state.home }));
let store: typeof import('../SessionStore');
let id: string;
beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'myagents-transcript-stability-'));
  vi.resetModules();
  store = await import('../SessionStore');
  id = (await store.createSession('/synthetic-stability')).id;
  const active = store.getActiveSessionTranscript(id)!;
  for (const key of ['u1', 'u2']) active.writer.observe({ kind: 'message-create', message: { id: key, role: 'user', content: 'synthetic', timestamp: 't' } });
  expect(await active.writer.flush()).toBe(true);
});
afterEach(async () => {
  await store.getActiveSessionTranscript(id)?.revoke();
  vi.restoreAllMocks();
  await rm(state.home, { recursive: true, force: true });
});

it('adopts the real history after lock contention beyond the former two-second cutoff', async () => {
  await store.releaseSessionTranscriptForBinding(id);
  const { withFileLock } = await import('../utils/file-lock');
  let release!: () => void;
  let held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holder = withFileLock({ lockPath: join(state.home, '.myagents/session-locks', `${id}.jsonl.lock`) }, async () => { held = true; await gate; });
  await vi.waitFor(() => expect(held).toBe(true));
  const binding = store.activateSessionTranscript(id);
  try {
    await new Promise(resolve => setTimeout(resolve, 2150));
    expect(store.getActiveSessionTranscript(id)).toBeUndefined();
  } finally { release(); await holder; }
  const active = (await binding)!;
  expect([...active.writer.projection.messages.keys()]).toEqual(['u1', 'u2']);
  active.writer.observe({ kind: 'message-create', message: { id: 'u3', role: 'user', content: 'after restore', timestamp: 't' } });
  expect(await active.writer.flush()).toBe(true);
  await store.releaseSessionTranscriptForBinding(id);
  expect([...(await store.activateSessionTranscript(id))!.writer.projection.messages.keys()]).toEqual(['u1', 'u2', 'u3']);
});

it('leaves cold activation retryable after a transient read error', async () => {
  await store.releaseSessionTranscriptForBinding(id);
  const files = await import('./file');
  vi.spyOn(files, 'readTranscriptFile').mockRejectedValueOnce(Object.assign(new Error('temporary busy'), { code: 'EBUSY' }));
  await expect(store.activateSessionTranscript(id)).rejects.toThrow('temporary busy');
  expect(store.getActiveSessionTranscript(id)).toBeUndefined();
  expect((await store.activateSessionTranscript(id))!.writer.projection.messages.size).toBe(2);
});

it('retries a transient first append reread without poisoning the writer', async () => {
  await store.releaseSessionTranscriptForBinding(id);
  const active = (await store.activateSessionTranscript(id))!;
  vi.spyOn(active.file, 'read').mockRejectedValueOnce(Object.assign(new Error('temporary busy'), { code: 'EBUSY' }));
  active.writer.observe({ kind: 'message-create', message: { id: 'u3', role: 'user', content: 'retryable', timestamp: 't' } });
  expect(await active.writer.flush()).toBe(true);
  expect(active.writer.status.state).toBe('healthy');
  expect((await active.file.read()).projection.messages.has('u3')).toBe(true);
});

it('settles an accepted native-binding mutation before the next history edit', async () => {
  const active = store.getActiveSessionTranscript(id)!;
  const { createTranscriptProjection } = await import('../../shared/sessionTranscript');
  const target = createTranscriptProjection();
  target.messages.set('u1', active.writer.projection.messages.get('u1')!);
  active.beginConversationMutation({ schemaVersion: 1, kind: 'builtin-rewind', sourceSdkSessionId: id, replacementSdkSessionId: 'new-sdk', sourceMessageCount: 2, targetMessageCount: 1 }, {}, target);
  const snapshot = await store.loadSessionTranscript(id);
  expect(await store.mutateSessionTranscript(id, snapshot.cursor, { kind: 'builtin-rewind', targetMessageId: 'u1', targetMessageCount: 0 }))
    .toMatchObject({ ok: true });
  expect(await active.writer.flush()).toBe(true);
  expect(active.writer.projection.messages.size).toBe(0);
});

it.each(['builtin', 'builtin-new-sdk', 'codex-rewind'] as const)('can send, save, reopen and rewind after %s truncation', async mode => {
  const active = store.getActiveSessionTranscript(id)!;
  const { createTranscriptProjection } = await import('../../shared/sessionTranscript');
  active.writer.replaceProjection(createTranscriptProjection());
  const builtin = await import('../builtin-session/transcript');
  const persistence = await import('../builtin-session/transcript-persistence');
  const external = await import('../runtimes/external-session/transcript-persistence');
  builtin.configureBuiltinTranscriptBinding(() => id);
  const initial = await store.loadSessionTranscript(id);
  external.setExternalSessionMessages(id, initial.messages, initial.cursor);
  const content = mode === 'codex-rewind' ? external.getExternalProductContent()! : builtin.getBuiltinProductContent()!;
  for (const n of [1, 2]) {
    content.admitUser({ id: `u${n}`, role: 'user', content: 'synthetic', timestamp: 't' });
    content.assistant(`a${n}`);
    content.finishTurn('complete');
  }
  expect(await active.writer.flush()).toBe(true);
  if (mode === 'codex-rewind') {
    active.patchMetadata({ runtime: 'codex', runtimeSessionId: 'native-source' });
    const source = await store.loadSessionTranscript(id);
    expect(await store.commitCodexConversationRewind({ sessionId: id, sourceRuntimeSessionId: 'native-source',
      replacementRuntimeSessionId: 'native-target', sourceMessages: source.messages, targetMessages: source.messages.slice(0, 2),
    })).toMatchObject({ success: true });
  } else {
    await persistence.truncateTranscriptPersistenceForRewind(id, 'u2', 2, mode === 'builtin-new-sdk'
      ? { sourceSdkSessionId: id, replacementSdkSessionId: 'replacement-sdk' } : undefined);
    builtin.truncateMessages(2);
  }
  expect(content.currentAssistantId).toBeNull();
  content.admitUser({ id: 'u3', role: 'user', content: 'after rewind', timestamp: 't' });
  expect(await active.writer.flush()).toBe(true);
  await store.releaseSessionTranscriptForBinding(id);
  const restored = (await store.activateSessionTranscript(id))!;
  expect([...restored.writer.projection.messages.keys()]).toEqual(['u1', 'a1', 'u3']);
  const snapshot = await store.loadSessionTranscript(id);
  expect(await store.mutateSessionTranscript(id, snapshot.cursor, { kind: 'builtin-rewind', targetMessageId: 'u3', targetMessageCount: 2 }))
    .toMatchObject({ ok: true });
  expect(await restored.writer.flush()).toBe(true);
});


it('keeps an idle but unsaved answer alive until its actual writer commits before update', async () => {
  const active = store.getActiveSessionTranscript(id)!;
  let finish!: () => void;
  const commit = new Promise<void>(resolve => { finish = resolve; });
  const append = active.file.append.bind(active.file);
  vi.spyOn(active.file, 'append').mockImplementationOnce(async (...args) => {
    await commit;
    return append(...args);
  });
  active.writer.observe({ kind: 'message-create', message: { id: 'saved-before-update', role: 'assistant', content: 'must survive', timestamp: 't' } });
  const flushing = active.writer.flush(5000);
  expect(() => store.assertSessionTranscriptsDurableForUpdate()).toThrow('UPDATE_BUSY');
  expect(active.isRevoked).toBe(false);
  finish();
  expect(await flushing).toBe(true);
  expect(() => store.assertSessionTranscriptsDurableForUpdate()).not.toThrow();
  expect((await active.file.read()).projection.messages.get('saved-before-update')?.content).toBe('must survive');
});
