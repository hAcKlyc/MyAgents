import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTranscriptOperation, createTranscriptProjection, transcriptMessages } from '../../shared/sessionTranscript';
import { withFileLock } from '../utils/file-lock';
import { TranscriptFile } from './file';
import { decodeTranscript, encodeTranscriptBatch, TRANSCRIPT_MAX_LINE_BYTES, type TranscriptBatch } from './codec';
import { TranscriptWriter } from './writer';
import { ProductTranscriptContent } from './content';

const faults = vi.hoisted(() => ({ mode: '' as '' | 'partial' | 'sync' | 'access' | 'short' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.mode === 'access') {
        faults.mode = '';
        throw Object.assign(new Error('injected access denied'), { code: 'EACCES' });
      }
      const file = await actual.open(...args);
      return new Proxy(file, {
        get(target, name) {
          if (name === 'write') return async (...params: [Buffer, number, number, number]) => {
            if (faults.mode === 'partial' && Buffer.isBuffer(params[0])) {
              faults.mode = '';
              const bytes = params[0];
              await target.write(bytes, 0, Math.max(1, Math.floor(bytes.length / 2)), params[3]);
              throw new Error('injected partial write');
            }
            if (faults.mode === 'short') return target.write(params[0], params[1], Math.min(params[2], 17), params[3]);
            return target.write(...params);
          };
          if (name === 'sync') return async () => {
            if (faults.mode === 'sync') { faults.mode = ''; throw new Error('injected sync failure'); }
            return target.sync();
          };
          const value: unknown = Reflect.get(target, name);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

const roots: string[] = [];
async function setup(publishBirth?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'myagents-transcript-v2-'));
  roots.push(root);
  const filePath = join(root, 'session-test.jsonl');
  const file = new TranscriptFile({
    sessionId: 'session-test', filePath, generation: 'g1', allowCreate: true,
    withLock: run => withFileLock({ lockPath: join(root, 'session.lock') }, run), publishBirth,
  });
  const initial: TranscriptBatch = {
    id: 'b1', mode: 'delta', fromRevision: 1, revision: 1,
    operations: [{ kind: 'message-create', message: { id: 'a', role: 'assistant', content: '', timestamp: 't' } }],
  };
  await file.append({ generation: 'g1', revision: 0 }, initial);
  return { file, filePath };
}

afterEach(async () => {
  faults.mode = '';
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('V2 real file commit and replacement', () => {
  it('retains the exact valid prefix at UTF-8, newline and maximum-record boundaries', async () => {
    const { file, filePath } = await setup();
    const header = (await readFile(filePath, 'utf8')).split('\n')[0] + '\n';
    const batch = (content: string) => encodeTranscriptBatch({id:'b',mode:'delta',fromRevision:1,revision:1,
      operations:[{kind:'message-create',message:{id:'a',role:'assistant',timestamp:'t',content}}]});
    const empty = batch('');
    const beforeChar = Buffer.byteLength(header) + empty.indexOf('"content":"') + '"content":"'.length;
    const multibyte = batch('a'.repeat(65535 - beforeChar) + '😀中文'.repeat(5000));
    const boundary = batch('a'.repeat(65536 - Buffer.byteLength(header + empty)));
    expect(Buffer.byteLength(header + boundary)).toBe(65536);
    const largest = batch('a'.repeat(TRANSCRIPT_MAX_LINE_BYTES - Buffer.byteLength(empty)));
    for (const suffix of [multibyte,boundary,boundary.slice(0,-1),multibyte + 'bad checksum\n',largest]) {
      const input = header + suffix;
      await writeFile(filePath,input);
      expect(await file.read()).toEqual(decodeTranscript(input,'session-test'));
    }
    await writeFile(filePath, header+'x'.repeat(TRANSCRIPT_MAX_LINE_BYTES+1));
    await expect(file.read()).rejects.toMatchObject({reason:'invalid-history'});
  });

  it('persists coalesced appends and reads them back with the original revision span', async () => {
    const { file, filePath } = await setup();
    const source = await file.read();
    const writer = new TranscriptWriter({
      sessionId: 'session-test', generation: 'g1', revision: 1,
      projection: source.projection, storage: file,
    });
    try {
      for (let offset = 0; offset < 200; offset++) {
        writer.observe({ kind: 'text-append', messageId: 'a', field: 'text', offset, text: 'x' });
      }
      expect(await writer.flush(5000)).toBe(true);
      const restored = await file.read();
      expect(restored).toMatchObject({ revision: 201, tail: 'clean' });
      expect(restored.projection.messages.get('a')?.content).toBe('x'.repeat(200));
      const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[2]).batch).toMatchObject({
        fromRevision: 2, revision: 201,
        operations: [{ kind: 'text-append', messageId: 'a', field: 'text', offset: 0, text: 'x'.repeat(200) }],
      });
    } finally { await writer.close(); }
  });

  it.each(['header-only', 'zero-length'] as const)('recovers a %s target from the complete live projection', async shape => {
    const { file, filePath } = await setup();
    const source = await file.read();
    const writer = new TranscriptWriter({
      sessionId: 'session-test', generation: 'g1', revision: 1,
      projection: source.projection, storage: file,
    });
    try {
      await writeFile(filePath, shape === 'header-only'
        ? JSON.stringify({ kind: 'session-transcript', version: 2, sessionId: 'session-test', generation: 'other', baseRevision: 0, baseline: false }) + '\n'
        : '');
      writer.observe({ kind: 'text-append', messageId: 'a', field: 'text', offset: 0, text: 'kept in memory' });
      expect(await writer.flush(5000)).toBe(true);
      expect(writer.status).toMatchObject({ state: 'healthy', durableRevision: 2 });
      expect((await file.read()).projection.messages.get('a')?.content).toBe('kept in memory');
    } finally { await writer.close(); }
  });

  it('refuses recovery when a different target contains one committed batch', async () => {
    const { file, filePath } = await setup();
    const source = await file.read();
    const writer = new TranscriptWriter({
      sessionId: 'session-test', generation: 'g1', revision: 1,
      projection: source.projection, storage: file,
    });
    try {
      const otherRoot = await setup();
      const other = Buffer.from((await readFile(otherRoot.filePath, 'utf8')).replace('"generation":"g1"', '"generation":"other"'));
      await writeFile(filePath, other);
      writer.observe({ kind: 'text-append', messageId: 'a', field: 'text', offset: 0, text: 'live only' });
      expect(await writer.flush(5000)).toBe(false);
      expect(writer.status).toMatchObject({ state: 'degraded', reason: 'invalid-history' });
      expect(await readFile(filePath)).toEqual(other);
    } finally { await writer.close(); }
  });
  it.each(['partial', 'sync', 'access'] as const)('retries the exact batch after %s failure without duplicates', async mode => {
    const { file, filePath } = await setup();
    const batch: TranscriptBatch = {
      id: 'b2', mode: 'delta', fromRevision: 2, revision: 2,
      operations: [{ kind: 'text-append', messageId: 'a', field: 'text', offset: 0, text: '未结束🙂' }],
    };
    faults.mode = mode;
    await expect(file.append({ generation: 'g1', revision: 1 }, batch)).rejects.toThrow('injected');
    await file.append({ generation: 'g1', revision: 1 }, batch);
    const restored = await file.read();
    expect(restored).toMatchObject({ revision: 2, tail: 'clean' });
    expect(transcriptMessages(restored.projection)[0].content).toBe('未结束🙂');
    expect((await readFile(filePath, 'utf8')).split('\n').filter(line => line.includes('"id":"b2"'))).toHaveLength(1);
  });

  it('continues successful short writes until the complete record is synced', async () => {
    const { file } = await setup();
    faults.mode = 'short';
    await file.append({ generation: 'g1', revision: 1 }, {
      id: 'short', mode: 'delta', fromRevision: 2, revision: 2,
      operations: [{ kind: 'text-append', messageId: 'a', field: 'text', offset: 0, text: '完整记录🙂' }],
    });
    expect((await file.read()).projection.messages.get('a')?.content).toBe('完整记录🙂');
    expect((await file.read()).tail).toBe('clean');
  });

  it.each(['x'.repeat(8 * 1024 * 1024), '\u0000'.repeat(2 * 1024 * 1024)])('persists large user content and the following turn without poisoning the queue (%#)', async text => {
    const { file } = await setup();
    const decoded = await file.read();
    const writer = new TranscriptWriter({ sessionId: 'session-test', generation: 'g1', revision: 1, projection: decoded.projection, storage: file });
    try {
      const content = new ProductTranscriptContent(writer);
      content.admitUser({ id: 'u1', role: 'user', timestamp: 't', content: text });
      content.append(content.block('reply', 'text', { text: '' }), 'text', 'received');
      content.finishTurn('complete');
      content.admitUser({ id: 'u2', role: 'user', timestamp: 't', content: 'next turn' });
      expect(await writer.flush(5000)).toBe(true);
      expect(transcriptMessages((await file.read()).projection)).toEqual(transcriptMessages(writer.projection));
      expect(transcriptMessages((await file.read()).projection).find(row => row.id === 'u1')?.content).toBe(text);
    } finally { await writer.close(); }
  });

  it('publishes a complete chunked baseline and preserves optional metadata and late tool content', async () => {
    const { file } = await setup();
    const projection = createTranscriptProjection();
    const text = '🙂'.repeat(40_000);
    applyTranscriptOperation(projection, { kind: 'message-create', message: {
      id: 'a', role: 'assistant', timestamp: 't', usage: undefined,
      content: [{ id: 'tool', type: 'tool_use', tool: { id: 'call', name: 'Bash', result: text, subagentCalls: [{ id: 'child', name: 'Read', inputJson: text, result: 'done' }] } }],
    } });
    const committed = await file.replace({ generation: 'g1', revision: 1 }, projection, 19);
    expect(committed.revision).toBe(19);
    const restored = await file.read();
    expect(restored).toMatchObject({ revision: 19, tail: 'clean', header: { generation: committed.generation, baseline: true } });
    expect(transcriptMessages(restored.projection)).toEqual(transcriptMessages(projection));
  });

  it('confirms a replacement whose publication ack failed instead of overwriting it', async () => {
    let failPublication = false;
    const { file } = await setup(async () => {
      if (failPublication) { failPublication = false; throw new Error('publication ack failed'); }
    });
    const projection = (await file.read()).projection;
    applyTranscriptOperation(projection, { kind: 'text-append', messageId: 'a', field: 'text', offset: 0, text: 'first snapshot' });
    failPublication = true;
    await expect(file.replace({ generation: 'g1', revision: 1 }, projection, 2)).rejects.toThrow('publication ack');
    const published = await file.read();
    applyTranscriptOperation(projection, { kind: 'text-append', messageId: 'a', field: 'text', offset: 14, text: ' later' });
    const confirmed = await file.replace({ generation: 'g1', revision: 1 }, projection, 3);
    expect(confirmed).toEqual({ generation: published.header.generation, revision: 2 });
    expect(transcriptMessages((await file.read()).projection)[0].content).toBe('first snapshot');
  });
});
