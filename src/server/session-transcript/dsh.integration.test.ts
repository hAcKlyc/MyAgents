import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTranscript } from './session';
import { createTranscriptProjection } from '../../shared/sessionTranscript';
import { createDshBinding } from '../../shared/integrated-runtimes/identity';
import type { SessionMessage, SessionMetadata } from '../types/session';

const state = vi.hoisted(() => ({ home: '', denyBody: false, denyMetadata: false, denyReplacement: false, beforeBodyWrite: undefined as (() => Promise<void>) | undefined,
  publicationDenied: undefined as ((kind: 'replacement' | 'metadata') => void) | undefined }));
vi.mock('os', async original => ({ ...await original<typeof import('os')>(), homedir: () => state.home }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: (...args: Parameters<typeof actual.rename>) => {
    if (state.denyReplacement && String(args[1]).includes('sessions-v2') && String(args[1]).endsWith('.jsonl')) {
      state.publicationDenied?.('replacement');
      return Promise.reject(new Error('replacement publication denied'));
    }
    if (state.denyMetadata && String(args[1]).endsWith('sessions.json')) {
      state.publicationDenied?.('metadata');
      return Promise.reject(new Error('metadata publication denied'));
    }
    return actual.rename(...args);
  }, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    if (String(args[0]).endsWith('sessions-v2')) await state.beforeBodyWrite?.();
    if (state.denyBody && String(args[0]).endsWith('sessions-v2')) return Promise.reject(Object.assign(new Error('body storage denied'), { code: 'EACCES' }));
    return actual.mkdir(...args);
  } };
});
let store: typeof import('../SessionStore');
let contentModule: typeof import('./content');
let births: typeof import('../types/session');
beforeEach(async () => {
  state.home = await mkdtemp(join(process.cwd(), '.tmp-dsh-v2-'));
  state.denyBody = false;
  state.denyMetadata = false;
  state.denyReplacement = false;
  state.beforeBodyWrite = undefined;
  state.publicationDenied = undefined;
  vi.resetModules();
  store = await import('../SessionStore');
  contentModule = await import('./content');
  births = await import('../types/session');
});
afterEach(async () => {
  state.denyBody = false;
  state.denyMetadata = false;
  state.denyReplacement = false;
  state.publicationDenied = undefined;
  await store.drainSessionTranscripts();
  await rm(state.home, { recursive: true, force: true });
});
async function birth(id = 'dsh-v2') {
  const metadata = births.createSessionMetadata('/synthetic/workspace', { id, runtimeBinding: createDshBinding('darwin-arm64'), runtimeSessionId: `runtime-${id}` });
  await store.saveSessionMetadata(metadata);
  const active = store.getActiveSessionTranscript(id)!;
  const content = new contentModule.ProductTranscriptContent(active.writer);
  return { metadata, active, content };
}
function user(id: string): SessionMessage { return { id, role: 'user', content: id, timestamp: '2026-09-17T00:00:00Z' }; }
async function admit(session: Awaited<ReturnType<typeof birth>>, id: string) {
  session.content.admitUser(user(id));
  const result = await store.beginDshRootOperation({ sessionId: session.metadata.id,
    cursor: (await store.loadSessionTranscript(session.metadata.id)).cursor,
    runtimeSessionId: session.metadata.runtimeSessionId!, clientOperationId: `op-${id}`, userMessage: user(id), productImageSha256: [],
  });
  expect(result).toMatchObject({ success: true });
}
async function disk(id: string): Promise<SessionMetadata> {
  return (JSON.parse(await readFile(join(state.home, '.myagents/sessions.json'), 'utf8')) as SessionMetadata[]).find(row => row.id === id)!;
}
async function settle(session: Awaited<ReturnType<typeof birth>>, id: string) {
  const block = session.content.block(`answer-${id}`, 'text');
  session.content.confirmText(block, 'text', `answer ${id}`);
  session.content.finishTurn('complete', { runtimeTurnAnchor: { turnId: `turn-${id}`, rootUserMessageId: id } });
  expect(await store.settleDshRootOperation({ sessionId: session.metadata.id, clientOperationId: `op-${id}` })).toMatchObject({ success: true });
}

describe('DSH execution journals with V2 product history', () => {
  it('keeps execution updates when an older metadata publication finishes', async () => {
    const session = await birth();
    await admit(session, 'one');
    const metadata = store.getSessionMetadata(session.metadata.id)!;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let firstPublication = true;
    const transcript = new SessionTranscript({
      metadata: { ...metadata, pendingDshRootOperation: undefined }, birth: true,
      filePath: join(state.home, 'publication-race.jsonl'),
      generation: 'publication-race', revision: 0, projection: createTranscriptProjection(),
      withLock: run => run(),
      publishMetadata: async (current, patch) => {
        const updated = { ...current, ...patch };
        if (firstPublication) {
          firstPublication = false;
          // A superseded body commit leaves the durable execution journal intact.
          updated.pendingDshRootOperation = metadata.pendingDshRootOperation;
          entered.resolve(); await release.promise;
        }
        return updated;
      },
      contentBoundMetadataKeys: ['pendingDshRootOperation'],
      deriveMetadata: () => ({ stats: metadata.stats, lastMessagePreview: metadata.lastMessagePreview }),
      onStatus: () => undefined, publishMutationIntent: async () => undefined,
    });
    const flushing = transcript.writer.flush();
    await entered.promise;
    try {
      transcript.patchMetadata({ title: 'next revision' });
      transcript.adoptExecutionMetadata(transcript.metadata, ['pendingDshRootOperation']);
    } finally { release.resolve(); }
    expect(await flushing).toBe(true);
    expect(transcript.metadata.pendingDshRootOperation).toBeUndefined();
    await transcript.revoke();
  });

  it('reloads a stopped partial assistant turn without disabling future transcript saves', async () => {
    const session = await birth();
    await admit(session, 'one');
    const block = session.content.block('partial', 'text');
    session.content.confirmText(block, 'text', 'partial answer');
    session.content.finishTurn('stopped', {
      runtimeTurnAnchor: { turnId: 'turn-one', rootUserMessageId: 'one' },
      runtimeOperationAnchor: { runtime: 'dsh', clientOperationId: 'op-one', runtimeSessionId: session.metadata.runtimeSessionId! },
      completionState: 'partial', terminalStatus: 'stopped',
    });
    expect(await store.settleDshRootOperation({ sessionId: session.metadata.id, clientOperationId: 'op-one' }))
      .toMatchObject({ success: true });
    expect(await session.active.writer.flush()).toBe(true);
    await session.active.revoke();
    vi.resetModules(); store = await import('../SessionStore');
    const restored = (await store.activateSessionTranscript(session.metadata.id))!;
    expect(restored.writer.status.reason).not.toBe('invalid-history');
    expect((await store.getSessionData(session.metadata.id))?.messages.at(-1))
      .toMatchObject({ completionState: 'partial', terminalStatus: 'stopped' });
    restored.writer.requestCommit();
    expect(await restored.writer.flush()).toBe(true);
  });

  it('admits and settles native inputs while a body write holds the physical file lock', async () => {
    let release!: () => void;
    let entered!: () => void;
    const bodyBlocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    state.beforeBodyWrite = async () => { entered(); await gate; };
    const session = await birth();
    const flushing = session.active.writer.flush(100);
    await bodyBlocked;
    try {
      await admit(session, 'one');
      const followup: SessionMessage = { ...user('followup'), runtimeOperationAnchor: {
        runtime: 'dsh', clientOperationId: 'followup-op', runtimeSessionId: session.metadata.runtimeSessionId!,
      } };
      expect(await store.beginDshInput({ sessionId: session.metadata.id,
        runtimeSessionId: session.metadata.runtimeSessionId!, clientOperationId: 'followup-op',
        queueId: 'followup-queue', userMessage: followup, productImageSha256: [], runtimeInputFingerprint: 'a'.repeat(64),
      })).toMatchObject({ success: true });
      session.content.admitUser(followup);
      expect(await store.settleDshInput({ sessionId: session.metadata.id, clientOperationId: 'followup-op',
        clientUserMessageId: 'followup', state: 'projected',
      })).toMatchObject({ success: true });
      await settle(session, 'one');
      await admit(session, 'two');
      await settle(session, 'two');
      expect((await disk(session.metadata.id)).pendingDshRootInputs?.map(root => root.clientUserMessageId)).toEqual(['one', 'two']);
      expect((await disk(session.metadata.id)).pendingDshInputs?.map(input => input.clientUserMessageId)).toEqual(['followup']);
    } finally {
      release();
      state.beforeBodyWrite = undefined;
      await flushing;
    }
    expect(await session.active.writer.flush()).toBe(true);
    expect((await disk(session.metadata.id)).pendingDshInputs).toBeUndefined();
  }, 3000);

  it('keeps consecutive admitted inputs recoverable while body storage fails, then retires them after saving', async () => {
    state.denyBody = true;
    const session = await birth();
    await admit(session, 'one');
    await settle(session, 'one');
    await admit(session, 'two');
    await settle(session, 'two');
    expect(await session.active.writer.flush(50)).toBe(false);
    expect((await disk(session.metadata.id)).pendingDshRootInputs?.map(input => input.clientUserMessageId)).toEqual(['one', 'two']);
    expect(store.getSessionMetadata(session.metadata.id)?.pendingDshRootOperation).toBeUndefined();
    state.denyBody = false;
    expect(await session.active.writer.flush()).toBe(true);
    expect((await disk(session.metadata.id)).pendingDshRootInputs).toBeUndefined();
    expect((await disk(session.metadata.id)).pendingDshRootOperation).toBeUndefined();
  });

  it('keeps pending execution bound to its runtime across V2 metadata entrypoints', async () => {
    const session = await birth();
    await admit(session, 'one');
    await expect(store.saveSessionMetadata({ ...session.active.metadata, runtimeSessionId: 'foreign' })).rejects.toThrow('Pending DSH execution');
    expect(await store.updateSessionMetadata(session.metadata.id, { runtimeSessionId: 'foreign' })).toBeNull();
    expect(await store.updateSessionMetadataForBinding(session.metadata.id, { runtimeSessionId: 'foreign' }, () => true)).toBeNull();
    expect(await store.updateSessionMetadata(session.metadata.id, { runtimeSessionId: 'foreign' }, () => true)).toBeNull();
    expect(store.getSessionMetadata(session.metadata.id)?.runtimeSessionId).toBe(session.metadata.runtimeSessionId);
    expect(await store.updateSessionMetadata(session.metadata.id, { title: 'Still editable' })).toMatchObject({ title: 'Still editable' });
    await settle(session, 'one');
  });

  it('recovers an explicitly journaled unpublished birth without losing either admitted root', async () => {
    state.denyBody = true;
    const session = await birth();
    await admit(session, 'one');
    await settle(session, 'one');
    await admit(session, 'two');
    await settle(session, 'two');
    await session.active.revoke();
    vi.resetModules();
    store = await import('../SessionStore');
    state.denyBody = false;
    const restored = await store.activateSessionTranscript(session.metadata.id);
    expect(restored?.writer.status.reason).not.toBe('invalid-history');
    expect((await store.getSessionData(session.metadata.id))?.messages.map(row => row.id)).toEqual(['one', 'two']);
    const assistantMessages: SessionMessage[] = ['one', 'two'].map(id => ({ id: `assistant-${id}`, role: 'assistant', content: `answer ${id}`, timestamp: '2026-09-17T00:00:01Z', runtimeTurnAnchor: { turnId: `turn-${id}`, rootUserMessageId: id } }));
    expect(await store.reconcileDshTurnProjections({ sessionId: session.metadata.id, runtimeSessionId: session.metadata.runtimeSessionId!, cursor: { schemaVersion: 1, runtimeSessionId: session.metadata.runtimeSessionId!, durableSequence: 8, transcriptPostcondition: 'a'.repeat(64) }, assistantMessages,
      nativeRootOperations: ['one', 'two'].map(id => ({ clientOperationId: `op-${id}`, clientUserMessageId: id, productTurnId: `turn-${id}`, terminal: true })),
    })).toMatchObject({ success: true });
    expect((await store.getSessionData(session.metadata.id))?.messages.map(row => row.id)).toEqual(['one', 'assistant-one', 'two', 'assistant-two']);
    expect(await restored!.writer.flush()).toBe(true);
  });

  it('does not recreate an ordinary missing published V2 file', async () => {
    const session = await birth();
    await admit(session, 'one');
    await settle(session, 'one');
    expect(await session.active.writer.flush()).toBe(true);
    await session.active.revoke();
    await rm(join(state.home, '.myagents/sessions-v2', `${session.metadata.id}.jsonl`));
    vi.resetModules(); store = await import('../SessionStore');
    expect((await store.activateSessionTranscript(session.metadata.id))?.writer.status.reason).toBe('invalid-history');
  });

  it('retains steered display segments and gives only the last segment its native terminal anchor', async () => {
    const session = await birth();
    await admit(session, 'one');
    session.content.confirmText(session.content.block('first', 'text'), 'text', 'before');
    session.content.admitUser(user('followup'));
    session.content.confirmText(session.content.block('last', 'text'), 'text', 'after');
    session.content.finishTurn('complete', { runtimeTurnAnchor: { turnId: 'turn-one', rootUserMessageId: 'one' } });
    const before = (await store.getSessionData(session.metadata.id))!.messages;
    expect(await store.reconcileDshTurnProjections({ sessionId: session.metadata.id, runtimeSessionId: session.metadata.runtimeSessionId!, cursor: { schemaVersion: 1, runtimeSessionId: session.metadata.runtimeSessionId!, durableSequence: 9, transcriptPostcondition: 'a'.repeat(64) },
      assistantMessages: [{ id: 'native-full', role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'beforeafter' }]), timestamp: 't', runtimeTurnAnchor: { turnId: 'turn-one', rootUserMessageId: 'one' } }],
      nativeRootOperations: [{ clientOperationId: 'op-one', clientUserMessageId: 'one', productTurnId: 'turn-one', terminal: true, consumedUserMessageIds: ['followup'] }],
    })).toMatchObject({ success: true });
    const after = (await store.getSessionData(session.metadata.id))!.messages;
    expect(after.map(row => row.id)).toEqual(before.map(row => row.id));
    expect(after[1]?.content).toBe(before[1]?.content);
    expect(after[1]?.runtimeTurnAnchor).toBeUndefined();
    expect(after[3]?.content).toBe(before[3]?.content);
    expect(after[3]?.runtimeTurnAnchor?.turnId).toBe('turn-one');
    expect(await session.active.writer.flush()).toBe(true);
    await expect(access(join(state.home, '.myagents/sessions', `${session.metadata.id}.jsonl`))).rejects.toThrow();
  });
  it.each(['commit', 'abort'] as const)('stages a V2 fork invisibly and settles it through %s', async outcome => {
    const session = await birth();
    await admit(session, 'one'); await settle(session, 'one');
    expect(await session.active.writer.flush()).toBe(true);
    const assistantId = (await store.getSessionData(session.metadata.id))!.messages[1]!.id;
    const begun = await store.beginDshForkMutation({ sourceSessionId: session.metadata.id, sourceAssistantMessageId: assistantId,
      clientMutationId: 'fork', targetProductSessionId: 'fork-target', targetRuntimeSessionId: 'fork-runtime',
      targetRuntimeHome: '/synthetic/fork-home', targetPersistenceRef: 'fork-persistence', targetWorkspaceIdentity: 'workspace',
    });
    expect(begun).toMatchObject({ success: true });
    if (!begun.success) throw new Error(begun.error);
    expect(await store.recordPreparedDshFork({ sourceSessionId: session.metadata.id, clientMutationId: 'fork', token: 'token', sourceStableBoundaryId: 'boundary' })).toMatchObject({ success: true });
    const { snapshotForForkedSession } = await import('../utils/session-snapshot');
    const target = births.createSessionMetadata(session.metadata.agentDir, { ...snapshotForForkedSession(begun.value.source), id: 'fork-target', runtimeSessionId: 'fork-runtime', materializationState: 'prepared', materializationSourceSessionId: session.metadata.id });
    expect(await store.stageDshForkProduct({ sourceSessionId: session.metadata.id, clientMutationId: 'fork', targetMetadata: target, targetMessages: begun.value.targetMessages })).toMatchObject({ success: true });
    expect(store.getActiveSessionTranscript(target.id)).toBeUndefined();
    expect(store.isHistoryVisibleSession(store.getSessionMetadata(target.id)!)).toBe(false);
    await expect(access(join(state.home, '.myagents/sessions-v2', `${target.id}.jsonl`))).resolves.toBeUndefined();
    if (outcome === 'commit') {
      expect(await store.commitDshForkProduct({ sourceSessionId: session.metadata.id, clientMutationId: 'fork', token: 'token' })).toMatchObject({ success: true });
      expect(store.isHistoryVisibleSession(store.getSessionMetadata(target.id)!)).toBe(true);
      expect((await store.getSessionData(target.id))?.messages.map(row => row.id)).toEqual(begun.value.targetMessages.map(row => row.id));
    } else {
      expect(await store.requestDshForkAbort({ sourceSessionId: session.metadata.id, clientMutationId: 'fork', token: 'token' })).toMatchObject({ success: true });
      expect(await store.abortDshForkProduct({ sourceSessionId: session.metadata.id, clientMutationId: 'fork' })).toMatchObject({ success: true });
      expect(store.getSessionMetadata(target.id)).toBeNull();
      await expect(access(join(state.home, '.myagents/sessions-v2', `${target.id}.jsonl`))).rejects.toThrow();
    }
  });

  it('reopens a rewound V2 history without the retired native mutation intent', async () => {
    const session = await birth();
    await admit(session, 'one'); await settle(session, 'one');
    await admit(session, 'two'); await settle(session, 'two');
    expect(await session.active.writer.flush()).toBe(true);
    expect(await store.beginDshRewindMutation({ sessionId: session.metadata.id, targetUserMessageId: 'two', clientMutationId: 'rewind' })).toMatchObject({ success: true });
    expect(await store.recordPreparedDshRewind({ sessionId: session.metadata.id, clientMutationId: 'rewind', token: 'token', targetStableBoundaryId: 'boundary', sourceTranscriptPostcondition: 'a'.repeat(64), targetTranscriptPostcondition: 'b'.repeat(64) })).toMatchObject({ success: true });
    expect(await store.commitDshRewindProduct({ sessionId: session.metadata.id, clientMutationId: 'rewind', token: 'token' })).toMatchObject({ success: true });
    expect(await session.active.writer.flush()).toBe(true);
    await session.active.revoke();
    vi.resetModules(); store = await import('../SessionStore');
    expect(store.getSessionMetadata(session.metadata.id)?.pendingDshMutation).toBeUndefined();
    expect(store.getSessionMetadata(session.metadata.id)?.stats?.messageCount).toBe(1);
    expect(store.getSessionMetadata(session.metadata.id)?.lastMessagePreview).toBe('one');
    expect((await store.getSessionData(session.metadata.id))?.messages.map(row => row.role)).toEqual(['user', 'assistant']);
  });

  it('retires the V2 writer before deleting the native-purged Product history', async () => {
    const session = await birth();
    await admit(session, 'one'); await settle(session, 'one');
    expect(await session.active.writer.flush()).toBe(true);
    const identity = { sessionId: session.metadata.id, clientMutationId: 'delete', token: 'token' };
    expect(await store.beginDshDeleteMutation(identity)).toMatchObject({ success: true });
    expect(await store.recordPreparedDshDelete(identity)).toMatchObject({ success: true });
    expect(await store.recordCommittedDshDelete(identity)).toMatchObject({ success: true });
    expect(await store.deleteCommittedDshProduct(identity)).toMatchObject({ success: true });
    expect(store.getSessionMetadata(session.metadata.id)).toBeNull();
    expect(store.getActiveSessionTranscript(session.metadata.id)).toBeUndefined();
    await expect(access(join(state.home, '.myagents/sessions-v2', `${session.metadata.id}.jsonl`))).rejects.toThrow();
  });

  it('continues native execution with a damaged V2 prefix without overwriting that file', async () => {
    const session = await birth();
    await admit(session, 'one'); await settle(session, 'one');
    expect(await session.active.writer.flush()).toBe(true);
    await session.active.revoke();
    const path = join(state.home, '.myagents/sessions-v2', `${session.metadata.id}.jsonl`);
    const damaged = (await readFile(path, 'utf8')) + '{"not":"a-valid-batch"}\n';
    await writeFile(path, damaged);
    vi.resetModules(); store = await import('../SessionStore');
    contentModule = await import('./content');
    const active = (await store.activateSessionTranscript(session.metadata.id))!;
    expect(active.writer.status.reason).toBe('invalid-history');
    expect(await store.reconcileDshTurnProjections({ sessionId: session.metadata.id, runtimeSessionId: session.metadata.runtimeSessionId!, cursor: { schemaVersion: 1, runtimeSessionId: session.metadata.runtimeSessionId!, durableSequence: 8, transcriptPostcondition: 'a'.repeat(64) }, assistantMessages: [],
      nativeRootOperations: [{ clientOperationId: 'op-one', clientUserMessageId: 'one', productTurnId: 'turn-one', terminal: true }],
    })).toMatchObject({ success: true });
    const resumed = { metadata: session.metadata, active, content: new contentModule.ProductTranscriptContent(active.writer) };
    await admit(resumed, 'two'); await settle(resumed, 'two');
    expect((await store.getSessionData(session.metadata.id))?.messages.at(-1)?.content).toContain('answer two');
    expect(await active.writer.flush(20)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(damaged);
  });

  it.each(['replacement', 'metadata'] as const)('retains rewind generation proof when a new root arrives before %s publication', async failure => {
    const session = await birth();
    await admit(session, 'one'); await settle(session, 'one');
    await admit(session, 'two'); await settle(session, 'two');
    expect(await session.active.writer.flush()).toBe(true);
    expect(await store.beginDshRewindMutation({ sessionId: session.metadata.id, targetUserMessageId: 'two', clientMutationId: 'rewind' })).toMatchObject({ success: true });
    expect(await store.recordPreparedDshRewind({ sessionId: session.metadata.id, clientMutationId: 'rewind', token: 'token', targetStableBoundaryId: 'boundary', sourceTranscriptPostcondition: 'a'.repeat(64), targetTranscriptPostcondition: 'b'.repeat(64) })).toMatchObject({ success: true });
    const publicationDenied = Promise.withResolvers<void>();
    state.publicationDenied = kind => { if (kind === failure) publicationDenied.resolve(); };
    const releaseBodyWrite = Promise.withResolvers<void>();
    state.beforeBodyWrite = () => releaseBodyWrite.promise;
    state.denyMetadata = failure === 'metadata';
    state.denyReplacement = failure === 'replacement';
    try {
      expect(await store.commitDshRewindProduct({ sessionId: session.metadata.id, clientMutationId: 'rewind', token: 'token' })).toMatchObject({ success: true });
      expect(await session.active.writer.flush(50)).toBe(false);
    } finally {
      state.beforeBodyWrite = undefined;
      releaseBodyWrite.resolve();
    }
    // A flush deadline does not settle physical IO. Observe the injected
    // publication failure before checking the preceding durable proof.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        publicationDenied.promise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Expected rewind publication failure was not reached')), 2000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      state.publicationDenied = undefined;
    }
    expect((await disk(session.metadata.id)).pendingDshMutation).toMatchObject({ kind: 'dsh-rewind', transcript: { format: 2, targetGeneration: expect.any(String) } });
    await admit(session, 'three');
    expect((await disk(session.metadata.id)).pendingDshMutation).toMatchObject({ kind: 'dsh-rewind', transcript: { format: 2 } });
    await session.active.revoke();
    vi.resetModules(); store = await import('../SessionStore');
    state.denyMetadata = false;
  state.denyReplacement = false;
    const restored = await store.activateSessionTranscript(session.metadata.id);
    expect(await store.commitDshRewindProduct({ sessionId: session.metadata.id, clientMutationId: 'rewind', token: 'token' })).toMatchObject({ success: true });
    expect((await store.getSessionData(session.metadata.id))?.messages.map(row => row.role)).toEqual(['user', 'assistant', 'user']);
    // Exact unsaved input survives separately for native admission recovery.
    expect(store.getSessionMetadata(session.metadata.id)?.pendingDshRootOperation?.clientUserMessageId).toBe('three');
    expect((await store.getSessionData(session.metadata.id))?.messages.at(-1)?.id).toBe('three');
    expect(restored?.writer.status.reason).not.toBe('invalid-history');
  });

});
