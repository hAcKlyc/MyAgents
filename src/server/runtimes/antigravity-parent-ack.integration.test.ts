import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { readAntigravityParentAcknowledgements, readAntigravityParentTailStep } from './antigravity-parent-ack';

const parent = 'ad824ddf-f48f-4d7b-9655-ef91b100517f';

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

const planner = (text: string) => field(20, field(1, text));
const report = (id: string, recipient = parent, body = '') => field(114, field(4, Buffer.concat([
  field(1, id), field(2, recipient), field(4, body),
])));

it('acknowledges exact report IDs only on the native side of a settled ACP reply', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agy-parent-ack-'));
  const conversations = join(directory, 'conversations');
  const brain = join(directory, 'brain');
  mkdirSync(conversations);
  const writer = new DatabaseSync(join(conversations, `${parent}.db`));
  try {
    writer.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB);
    `);
    const insert = writer.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)');
    const reports = new Set(['first', 'second', 'third', 'recipient-mismatch']);
    const read = (replies: string[], prior = 1, ids = reports) =>
      readAntigravityParentAcknowledgements(brain, parent, replies, ids, prior);

    insert.run(1, 15, 3, planner('Interim reply'));
    expect(readAntigravityParentTailStep(brain, parent)).toBe(1);
    expect(read(['Interim reply'])).toEqual({ plannerStep: 1, matchedReplies: 0, acknowledgedReportIds: new Set() });

    insert.run(2, 101, 3, report('first', parent, 'Body mentions second and third.'));
    insert.run(3, 101, 3, report('recipient-mismatch', 'other-parent'));
    insert.run(4, 15, 3, planner('Interim reply'));
    insert.run(5, 101, 3, report('second'));
    insert.run(6, 101, 3, report('third'));
    insert.run(7, 15, 2, planner('Final reply'));
    expect(read(['\n\nInterim reply', '\n\nFinal reply'])).toEqual({
      plannerStep: 4, matchedReplies: 1, acknowledgedReportIds: new Set(['first']),
    });

    expect(read([], 4, new Set(['first']))).toEqual({
      plannerStep: 4, matchedReplies: 0, acknowledgedReportIds: new Set(['first']),
    });
    expect(read(['Interim reply'], 4)).toEqual({
      plannerStep: 4, matchedReplies: 0, acknowledgedReportIds: new Set(['first']),
    });

    writer.prepare('UPDATE steps SET status = 3 WHERE idx = 7').run();
    expect(read(['An earlier unmatched ACP reply', '\n\nFinal reply'], 4)).toEqual({
      plannerStep: 7, matchedReplies: 2, acknowledgedReportIds: new Set(['first', 'second', 'third']),
    });
    expect(read([], 7)).toEqual({
      plannerStep: 7, matchedReplies: 0, acknowledgedReportIds: new Set(['first', 'second', 'third']),
    });
  } finally {
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
