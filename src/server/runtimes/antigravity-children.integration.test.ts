import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as subprocess from '../utils/subprocess';
import * as nativeChildren from './antigravity-children';
import { readAntigravityChildren } from './antigravity-children';
import { AntigravityChildTrace } from './antigravity-child-trace';
import { AntigravityRuntime } from './antigravity';
import type { RuntimeProcess, UnifiedEvent } from './types';

const parent = 'c03d26d5-fc26-48f4-8c79-6c8c46dc9119';
const first = '8a894d5e-ab0c-46a7-9f6d-e354773415c6';
const second = '1a62d51a-50c1-4e27-98ca-ced1e950cf5f';
const third = 'f7051ef5-7f65-4a2e-9b30-d76640809d9d';
const anotherParent = '475cc2f3-e8ec-4b89-85f8-86c4ef1328c7';
const started = '2026-11-22T07:08:22.000Z';
const delivered = '2026-11-22T07:13:41.421466Z';

let fixture: string;
let brain: string;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'myagents-antigravity-children-'));
  brain = join(fixture, 'brain');
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function writeRecord(session: string, folder: string, name: string, value: unknown) {
  const directory = join(brain, session, '.system_generated', folder);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), JSON.stringify(value));
}

async function descriptor(child: string, state = 'SUBAGENT_STATE_ALIVE') {
  await writeRecord(parent, 'subagents', child, {
    conversationId: child,
    state,
    subagentDescriptor: { role: 'Fixture tester', typeName: 'research' },
  });
}

async function launch(child: string, toolCallId: string, sender = parent) {
  await writeRecord(child, 'messages', 'launch', {
    sender,
    recipient: child,
    timestamp: started,
    sourceMetadata: { tool: { conversationId: sender, toolCall: { id: toolCallId, name: 'invoke_subagent' } } },
  });
}

async function report(child: string, result: string, name = 'send_message', timestamp = delivered) {
  const id = `report-${child}-${name}`;
  await writeRecord(parent, 'messages', id, {
    id,
    sender: child,
    recipient: parent,
    timestamp,
    content: result,
    sourceMetadata: { tool: { conversationId: child, stepIndex: 17, toolCall: { id: 'call_report', name } } },
  });
}

async function childStep(child: string, value: unknown) {
  const directory = join(brain, child, '.system_generated', 'logs');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'transcript.jsonl'), `${JSON.stringify(value)}\n`);
}

function varint(value: number): Uint8Array {
  const bytes = [];
  while (value >= 128) {
    bytes.push((value % 128) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function bytesField(tag: number, body: Uint8Array | string): Buffer {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  return Buffer.concat([varint(tag * 8 + 2), varint(bytes.length), bytes]);
}

function nativeToolCall(id: string, name: string, input: Record<string, unknown>): Buffer {
  return Buffer.concat([bytesField(1, id), bytesField(2, name), bytesField(3, JSON.stringify(input))]);
}

async function childDatabase(child: string) {
  const conversations = join(fixture, 'conversations');
  await mkdir(conversations, { recursive: true });
  const db = new DatabaseSync(join(conversations, `${child}.db`));
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)');
  return db;
}

it('projects committed child thoughts and exact tool results incrementally without pairing by step order', async () => {
  const db = await childDatabase(first);
  const insert = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)');
  const readA = nativeToolCall('call_A', 'read_file', { Path: '/workspace/a.txt', StartLine: 1, EndLine: 2 });
  const readB = nativeToolCall('call_B', 'read_file', { Path: '/workspace/b.txt', StartLine: 3, EndLine: 5 });
  const planner = Buffer.concat([bytesField(3, 'Check both fixtures.'), bytesField(7, readA), bytesField(7, readB)]);
  insert.run(1, 15, 3, null, bytesField(20, planner));
  insert.run(2, 132, 2, bytesField(4, readB), null);
  insert.run(3, 132, 3, bytesField(4, readA), bytesField(140, bytesField(2, bytesField(1, 'Independent output A'))));

  const trace = new AntigravityChildTrace({
    toolCallId: 'launch', sessionId: first, startedAt: Date.parse(started), status: 'running',
  });
  const events: UnifiedEvent[] = [];
  try {
    trace.observe(brain, event => events.push(event));
    trace.observe(brain, event => events.push(event));
    expect(events).toMatchObject([
      { kind: 'thinking_start', subAgent: { parentToolUseId: 'launch' } },
      { kind: 'thinking_delta', text: 'Check both fixtures.', subAgent: { parentToolUseId: 'launch' } },
      { kind: 'thinking_stop', subAgent: { parentToolUseId: 'launch' } },
      { kind: 'tool_use_start', toolUseId: `${first}:call_A`, toolName: 'Read', input: { file_path: '/workspace/a.txt', limit: 2 } },
      { kind: 'tool_use_start', toolUseId: `${first}:call_B`, toolName: 'Read', input: { file_path: '/workspace/b.txt', offset: 3 } },
      { kind: 'tool_use_stop', toolUseId: `${first}:call_A` },
      { kind: 'tool_result', toolUseId: `${first}:call_A`, content: 'Independent output A' },
    ]);
    events.length = 0;
    db.prepare('UPDATE steps SET status = ?, step_payload = ? WHERE idx = 2')
      .run(7, bytesField(140, bytesField(2, bytesField(1, 'The second file could not be read.'))));
    insert.run(4, 15, 3, null, bytesField(20, bytesField(1, 'Child report is ready.')));
    trace.observe(brain, event => events.push(event));
    trace.observe(brain, event => events.push(event));
    expect(events).toMatchObject([
      { kind: 'tool_use_stop', toolUseId: `${first}:call_B` },
      { kind: 'tool_result', toolUseId: `${first}:call_B`, content: 'The second file could not be read.', isError: true },
      { kind: 'text_delta', text: 'Child report is ready.', subAgent: { parentToolUseId: 'launch' } },
      { kind: 'text_stop', nativeText: 'Child report is ready.', subAgent: { parentToolUseId: 'launch' } },
    ]);
  } finally {
    db.close();
  }
});

it('observes only children launched by the current ACP operation', async () => {
  await descriptor(first);
  await descriptor(second);
  await launch(first, 'call_1');
  await launch(second, 'call_2', anotherParent);

  expect(await readAntigravityChildren(brain, parent, new Set(['call_1', 'call_2']))).toEqual([{
    toolCallId: 'call_1',
    sessionId: first,
    role: 'Fixture tester',
    agentType: 'research',
    startedAt: Date.parse(started),
    status: 'running',
  }]);
  expect(await readAntigravityChildren(brain, parent, new Set(['call_future']))).toEqual([]);
});

it('uses the parent inbox receipt for delivery and the child final response for completion', async () => {
  await descriptor(first);
  await descriptor(second);
  await launch(first, 'call_1');
  await launch(second, 'call_2');
  await report(first, 'Independent report');
  await report(second, 'Earlier than this launch', 'send_message', '2026-11-22T07:07:22.000Z');
  await report(second, 'Unrelated tool activity', 'run_command');

  await childStep(first, { step_index: 18, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: delivered,
    tool_calls: [{ name: 'read_file' }], content: 'Still checking details.' });
  expect(await readAntigravityChildren(brain, parent, new Set(['call_1']))).toEqual([
    expect.objectContaining({ toolCallId: 'call_1', status: 'running', deliveredAt: Date.parse(delivered),
      result: 'Independent report', parentRead: false }),
  ]);

  const finished = '2026-11-22T07:13:41Z';
  await writeRecord(parent, 'messages', 'read', { [`report-${first}-send_message`]: true });
  await childStep(first, { step_index: 20, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: finished,
    content: 'Report sent to the main agent.' });
  expect(await readAntigravityChildren(brain, parent, new Set(['call_1', 'call_2']))).toEqual(expect.arrayContaining([
    expect.objectContaining({ toolCallId: 'call_1', status: 'completed', deliveredAt: Date.parse(delivered),
      finishedAt: Date.parse(delivered), result: 'Independent report', parentRead: true }),
    expect.objectContaining({ toolCallId: 'call_2', status: 'running' }),
  ]));
});

it('observes when the native handle was killed before it reported back', async () => {
  await descriptor(first, 'SUBAGENT_STATE_KILLED');
  await launch(first, 'call_1');

  expect(await readAntigravityChildren(brain, parent, new Set(['call_1']))).toEqual([
    expect.objectContaining({ status: 'interrupted' }),
  ]);
});

it('does not associate an ambiguous call ID or enter a linked directory outside the native brain', async () => {
  await descriptor(first);
  await descriptor(second);
  await launch(first, 'call_1');
  await launch(second, 'call_1');
  expect(await readAntigravityChildren(brain, parent, new Set(['call_1']))).toEqual([]);

  const nativeDirectory = join(brain, second);
  const outside = join(fixture, 'outside');
  const otherInbox = join(outside, '.system_generated', 'messages');
  await mkdir(otherInbox, { recursive: true });
  await writeFile(join(otherInbox, 'launch.json'), JSON.stringify({
    sender: parent, recipient: second, timestamp: started,
    sourceMetadata: { tool: { conversationId: parent, toolCall: { id: 'call_1', name: 'invoke_subagent' } } },
  }));
  await rm(nativeDirectory, { recursive: true, force: true });
  await symlink(outside, nativeDirectory, 'junction');
  expect(await readAntigravityChildren(brain, parent, new Set(['call_1']))).toEqual([
    expect.objectContaining({ sessionId: first }),
  ]);
});

it('keeps a three-child delegation alive until native reports and the unsolicited parent summary settle', async () => {
  const parentSession = JSON.stringify(parent);
  const controlPath = join(fixture, 'parent-reply');
  const fakeAgy = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\\n');
    const update = (data) => send({ method: 'session/update', params: { sessionId: ${parentSession}, update: data } });
    const text = (value) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
    let timer;
    let lastReply = '';
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const frame = JSON.parse(line);
      const reply = (result) => send({ id: frame.id, result });
      switch (frame.method) {
        case 'initialize': return reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
        case 'session/new': return reply({ sessionId: ${parentSession}, configOptions: [] });
        case 'session/set_config_option': return reply({ configOptions: [{ id: 'mode', name: 'Mode', type: 'select', currentValue: frame.params.value, options: [] }] });
        case 'session/prompt': {
          for (const n of [1, 2, 3]) update({ sessionUpdate: 'tool_call', toolCallId: 'call_' + n,
            title: 'Run invoke_subagent', kind: 'other', status: 'completed',
            rawInput: { TypeName: 'research', Role: 'Fixture tester ' + n, Prompt: 'Return a marker.' } });
          text('Waiting for three child reports.');
          reply({ stopReason: 'end_turn' });
          timer = setInterval(() => {
            if (!fs.existsSync(process.argv[1])) return;
            const latest = fs.readFileSync(process.argv[1], 'utf8');
            if (!latest || latest === lastReply) return;
            lastReply = latest;
            text(latest);
            update({ sessionUpdate: 'usage_update', used: 20, size: 100 });
          }, 15);
          return;
        }
        case 'session/close': clearInterval(timer); return reply({});
      }
    });
  `;
  const realSpawn = subprocess.spawn;
  vi.spyOn(subprocess, 'spawn').mockImplementation((_argv, options) =>
    realSpawn([process.execPath, '-e', fakeAgy, controlPath], options));
  vi.spyOn(nativeChildren, 'antigravityBrainDirectory').mockReturnValue(brain);
  const runtime = new AntigravityRuntime();
  let worker: RuntimeProcess | undefined;
  const events: UnifiedEvent[] = [];
  const nativeChildrenIds = [first, second, third];
  const reportId = (id: string) => `report-${id}-send_message`;
  const readReportMarkers = (ids: string[]) => writeRecord(parent, 'messages', 'read',
    Object.fromEntries(ids.map(id => [reportId(id), true])));
  const finishChild = async (id: string, index: number) => {
    await report(id, `Report ${index}`);
    await childStep(id, { step_index: 18, type: 'PLANNER_RESPONSE', status: 'DONE',
      created_at: '2026-11-22T07:13:41Z', content: 'Delivered report.' });
  };
  const completedChildren = () => events.filter(event => event.kind === 'subagent_lifecycle' && event.status === 'completed');
  const parents = () => events.filter(event => event.kind === 'turn_complete' && event.status === 'completed');
  const parentDb = await childDatabase(parent);
  const parentWrite = parentDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)');
  const parentReply = (step: number, text: string) => parentWrite.run(step, 15, 3, null,
    bytesField(20, bytesField(1, text)));
  const parentReport = (step: number, child: string) => parentWrite.run(step, 101, 3, null,
    bytesField(114, bytesField(4, Buffer.concat([bytesField(1, reportId(child)), bytesField(2, parent)]))));
  try {
    await Promise.all(nativeChildrenIds.map(async (id, i) => {
      await descriptor(id);
      await launch(id, `call_${i + 1}`);
    }));
    const db = await childDatabase(first);
    try {
      db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)')
        .run(1, 15, 3, null, bytesField(20, bytesField(3, 'Tracing this real child fixture.')));
    } finally {
      db.close();
    }
    worker = await runtime.startSession({ workspacePath: fixture, sessionId: 'fixture-product', scenario: { type: 'desktop' } },
      event => events.push(event));
    await runtime.sendMessage(worker, 'Delegate three independent jobs.');
    parentReply(1, 'Waiting for three child reports.');
    await expect.poll(() => parents().length, { timeout: 5000 }).toBe(1);
    await expect.poll(() => events.filter(event => event.kind === 'subagent_lifecycle' && event.status === 'running').length,
      { timeout: 5000 }).toBe(3);
    expect(events.some(event => event.kind === 'thinking_delta' && event.subAgent?.parentToolUseId === 'call_1'
      && event.text === 'Tracing this real child fixture.')).toBe(true);
    expect(worker.hasPendingBackgroundWork?.()).toBe(true);

    await Promise.all([...nativeChildrenIds.map((id, index) => finishChild(id, index + 1)), readReportMarkers(nativeChildrenIds)]);
    parentReport(2, first);
    parentReport(3, second);
    parentReply(4, 'Two children have reported.');
    await writeFile(controlPath, 'Two children have reported.');
    await expect.poll(() => parents().length, { timeout: 5000 }).toBe(2);
    await expect.poll(() => completedChildren().length, { timeout: 5000 }).toBe(3);
    expect(worker.hasPendingBackgroundWork?.()).toBe(true);
    parentReport(5, third);
    parentReply(6, 'All three independent reports are included in this summary.');
    await writeFile(controlPath, 'All three independent reports are included in this summary.');
    await expect.poll(() => parents().length, { timeout: 5000 }).toBe(3);
    await expect.poll(() => worker?.hasPendingBackgroundWork?.(), { timeout: 5000 }).toBe(false);
    expect(events.filter(event => event.kind === 'text_delta').map(event => event.text)).toEqual([
      'Waiting for three child reports.', 'Two children have reported.',
      'All three independent reports are included in this summary.',
    ]);
  } finally {
    if (worker) await runtime.stopSession(worker);
    parentDb.close();
    vi.restoreAllMocks();
  }
});
