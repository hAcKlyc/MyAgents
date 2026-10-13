import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSseClient } from '../sse';
import { SSE_PAYLOAD_INLINE_MAX_BYTES, isSsePayloadRef } from '../../shared/ssePayloadRef';

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'sse-ref-'));
  vi.stubEnv('MYAGENTS_REFS_DIR', join(scratch, 'refs'));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(scratch, { recursive: true, force: true }); });

describe('SSE complete transcript payload transport', () => {
  it.each(['chat:init', 'chat:message-replay', 'chat:transcript-operation'])('spills %s losslessly before later deltas and graceful EOF', async event => {
    const { client, response } = createSseClient(() => {});
    const original = { sessionId: 'synthetic', liveRevision: 10, payload: { text: '正文😀\n'.repeat(200_000) } };
    const reading = response.text();
    client.send(event, original);
    client.send('chat:transcript-operation', { revision: 11, type: 'text-append', text: 'tail' });
    client.close();
    const raw = await reading;
    const frames = raw.trim().split('\n\n');
    expect(frames).toHaveLength(2);
    expect(Buffer.byteLength(frames[0])).toBeLessThan(SSE_PAYLOAD_INLINE_MAX_BYTES);
    const envelope: unknown = JSON.parse(frames[0].split('\ndata: ')[1]);
    expect(isSsePayloadRef(envelope)).toBe(true);
    if (!isSsePayloadRef(envelope)) throw new Error('Missing payload ref');
    const restored = JSON.parse(await readFile(join(scratch, 'refs', envelope.ref.id), 'utf8'));
    expect(restored).toEqual(original);
    expect(frames[1]).toContain('"revision":11');
  });

  it('fails the stream on spill IO failure without admitting later deltas', async () => {
    const blocked = join(scratch, 'file');
    await writeFile(blocked, 'not a directory');
    vi.stubEnv('MYAGENTS_REFS_DIR', blocked);
    const closed = vi.fn();
    const { client, response } = createSseClient(closed);
    const reading = response.text();
    const rejected = expect(reading).rejects.toThrow();
    client.send('chat:message-replay', { text: 'x'.repeat(300_000) });
    client.send('chat:transcript-operation', { text: 'must not arrive' });
    await rejected;
    expect(closed).toHaveBeenCalledTimes(1);
    client.close();
  });
});
