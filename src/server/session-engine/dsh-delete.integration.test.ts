import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDshBinding } from '../../shared/integrated-runtimes/identity';

const native = vi.hoisted(() => ({ request: vi.fn(), stop: vi.fn(), start: vi.fn() }));
vi.mock('../integrated-runtimes/dsh/runtime', () => ({
  startDshStorageManagement: native.start,
}));

let home: string;
let store: typeof import('../SessionStore');
let remove: typeof import('./dsh-delete');
let types: typeof import('../types/session');
const originalHome = process.env.HOME;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-storage-delete-'));
  process.env.HOME = home;
  vi.resetModules();
  store = await import('../SessionStore');
  types = await import('../types/session');
  remove = await import('./dsh-delete');
});
afterAll(async () => {
  process.env.HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

describe('DSH deletion after Rust owner retirement', () => {
  it.each(['prepare', 'commit', 'purge', 'physical-purge'])('retains the Product journal across %s failure and retries without resume', async failure => {
    const id = `delete-${failure}`;
    const pending = { schemaVersion: 1 as const, clientOperationId: 'old-operation', clientUserMessageId: 'old-user', sourceRuntimeSessionId: `native-${id}`, productImageSha256: [], productInputFingerprint: 'a'.repeat(64) };
    await store.saveSessionMetadata({
      ...types.createSessionMetadata(home, { id, runtimeBinding: createDshBinding('darwin-arm64'), runtimeSessionId: `native-${id}` }),
      transcriptFormat: undefined,
      pendingDshRootOperation: pending,
      pendingDshInputs: [{ ...pending, queueId: 'old-queue', runtimeInputFingerprint: 'b'.repeat(64), delivery: 'realtime', state: 'pending', userMessage: { id: 'old-user', role: 'user', content: 'old input', timestamp: '2026-10-13T00:00:00Z' } }],
    });
    await writeFile(join(home, '.myagents', 'sessions', `${id}.jsonl`), 'unreadable transcript\n');
    let state = 'prepared';
    let failed = false;
    const token = `token-${id}`;
    native.request.mockReset(); native.stop.mockReset(); native.start.mockReset();
    native.start.mockResolvedValue({ request: native.request, stop: native.stop });
    native.stop.mockResolvedValue(undefined);
    native.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'session/delete/prepare') {
        expect(params.runtimeSessionId).toBe(`native-${id}`);
        if (failure === 'prepare' && !failed) { failed = true; throw new Error('prepare response lost'); }
      } else if (method === 'session/delete/commit') {
        expect(params.token).toBe(token);
        state = 'committed';
        if (failure === 'commit' && !failed) { failed = true; throw new Error('commit response lost'); }
      } else if (method === 'session/delete/purge') {
        expect(store.getSessionMetadata(id)?.pendingDshMutation).toMatchObject({ runtimeCommitted: true });
        if (failure === 'physical-purge') state = 'purged';
        if ((failure === 'purge' || failure === 'physical-purge') && !failed) { failed = true; throw new Error('collection failed'); }
        state = 'purged';
      } else throw new Error(`Unexpected execution ${method}`);
      return { token, state };
    });
    expect(await remove.deleteDshProductSession(id)).toEqual({ deleted: false, reason: 'io-error' });
    const intent = store.getSessionMetadata(id)?.pendingDshMutation;
    expect(intent?.kind).toBe('dsh-delete');
    expect(store.getSessionMetadata(id)?.pendingDshRootOperation).toEqual(pending);
    expect(store.getSessionMetadata(id)?.pendingDshInputs).toHaveLength(1);
    expect(await remove.deleteDshProductSession(id)).toEqual({ deleted: true });
    expect(store.getSessionMetadata(id)).toBeNull();
    expect(native.stop).toHaveBeenCalledTimes(2);
    const prepares = native.request.mock.calls.filter(([method]) => method === 'session/delete/prepare');
    expect(prepares[1][1]).toEqual(prepares[0][1]);
    if (failure === 'physical-purge') expect(native.request.mock.calls.filter(([method]) => method === 'session/delete/purge')).toHaveLength(2);
  });
});
