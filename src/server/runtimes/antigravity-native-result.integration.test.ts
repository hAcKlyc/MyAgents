import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { decodeAntigravityPlannerToolCalls, readAntigravityFileResult } from './antigravity-native-result';

const sessionId = 'e50e1e25-04fd-42f2-89a1-409f99bdc51f';

function varint(value: number): number[] {
  const bytes: number[] = [];
  while (value >= 128) {
    bytes.push(value % 128 + 128);
    value = Math.floor(value / 128);
  }
  return [...bytes, value];
}

function field(number: number, value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([Buffer.from([...varint(number * 8 + 2), ...varint(bytes.length)]), bytes]);
}

function tool(id: string, name: string, args: Record<string, unknown>): Buffer {
  return Buffer.concat([field(1, id), field(2, name), field(3, JSON.stringify(args))]);
}

it('projects exact completed Read calls from a live native WAL database by call ID', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agy-native-results-'));
  const conversations = join(directory, 'conversations');
  const brain = join(directory, 'brain');
  mkdirSync(conversations);
  const writer = new DatabaseSync(join(conversations, `${sessionId}.db`));
  try {
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)');
    const insert = writer.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)');
    const first = tool('call_first', 'read_file', { Path: '/project/file.txt', StartLine: 1, EndLine: 1 });
    const second = tool('call_second', 'read_file', { Path: '/project/file.txt', StartLine: 2, EndLine: 2 });
    const result = (text: string) => field(140, field(2, field(1, text)));
    insert.run(1, 132, 3, field(4, first), result('1: first line'));
    insert.run(2, 132, 2, field(4, second), result('not complete yet'));
    expect(readAntigravityFileResult(brain, sessionId, 'call_second')).toBeUndefined();
    insert.run(3, 132, 3, field(4, second), result('2: second line'));
    insert.run(4, 132, 3, field(4, tool('call_unrelated', 'run_command', { summary: 'mentions call_first' })), result('unrelated'));

    expect(readAntigravityFileResult(brain, sessionId, 'call_first')).toBe('1: first line');
    expect(readAntigravityFileResult(brain, sessionId, 'call_second')).toBe('2: second line');
    expect(readAntigravityFileResult(brain, 'other/../session', 'call_first')).toBeUndefined();
    expect(decodeAntigravityPlannerToolCalls(field(20, Buffer.concat([field(7, first), field(7, second)])))
      .map(({ id }) => id)).toEqual(['call_first', 'call_second']);
  } finally {
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
