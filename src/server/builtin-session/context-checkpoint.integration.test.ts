import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async original => ({ ...await original<typeof import('os')>(), homedir: () => state.home }));
let store: typeof import('../SessionStore');
let id: string;
beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'moxbots-checkpoint-'));
  vi.resetModules();
  store = await import('../SessionStore');
  id = (await store.createSession('/workspace')).id;
});
afterEach(async () => {
  await store.getActiveSessionTranscript(id)?.revoke();
  await rm(state.home, { recursive: true, force: true });
});

it('backs up the exact request privately and commits a restart-safe identity-scoped ledger', async () => {
  const request = { messages: [{ role: 'user', content: 'synthetic evidence' }] };
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const archive = await store.archiveBuiltinContextRequest(id, request, { digest, scope: 'goal-turn' }, () => true);
  expect(JSON.parse(await readFile(archive, 'utf8')).request).toEqual(request);
  expect((await stat(archive)).mode & 0o777).toBe(0o600);
  const original = await readFile(archive, 'utf8');
  await store.archiveBuiltinContextRequest(id, request, { digest, scope: 'same-request-new-turn' }, () => true);
  expect(await readFile(archive, 'utf8')).toBe(original);
  const ledger = { version: 1, completed: [], uncertain: ['a'.repeat(64)], denied: [], blocked: false };
  await store.saveBuiltinContextLedger(id, id, ledger, () => true);
  expect(store.loadBuiltinContextLedger(id, id)).toEqual(ledger);
  expect(store.loadBuiltinContextLedger(id, 'different-sdk-history')).toBeUndefined();
  await expect(store.saveBuiltinContextLedger(id, 'different-sdk-history', ledger, () => true)).rejects.toThrow('owner changed');
  await store.getActiveSessionTranscript(id)?.revoke();
  vi.resetModules(); store = await import('../SessionStore');
  expect(store.loadBuiltinContextLedger(id, id)).toEqual(ledger);
  const ledgerPath = join(archive, '..', `ledger-${id}.json`);
  await writeFile(ledgerPath, '{invalid');
  expect(() => store.loadBuiltinContextLedger(id, id)).toThrow('context_recovery_required');
});

it('refuses cancelled archives and stale-owner ledger writes', async () => {
  await expect(store.archiveBuiltinContextRequest(id, {}, { digest: 'a'.repeat(64), scope: 'turn' }, () => false)).rejects.toThrow('changed');
  await expect(store.saveBuiltinContextLedger(id, id, {}, () => false)).rejects.toThrow('changed');
  expect(store.loadBuiltinContextLedger(id, id)).toBeUndefined();
});
