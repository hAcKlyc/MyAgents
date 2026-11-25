import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractAntigravityTaskUpdates,
  observeAntigravityBackgroundTasks,
} from './antigravity-tasks';

const SESSION_ID = '87361ac8-8654-4053-91b5-163b1affdfaa';
const FOREIGN_ID = '11111111-2222-3333-4444-555555555555';

let tempBrain: string | undefined;

afterEach(async () => {
  if (tempBrain) {
    await rm(tempBrain, { recursive: true, force: true });
    tempBrain = undefined;
  }
});

describe('extractAntigravityTaskUpdates', () => {
  it('detects background launches, manage_task status updates, and cancellations for the bound session only', () => {
    expect(
      extractAntigravityTaskUpdates(
        SESSION_ID,
        `Tool is running as a background task with task id: ${SESSION_ID}/task-104\nOther: ${FOREIGN_ID}/task-999`,
      ),
    ).toEqual({ active: ['task-104'], settled: [] });

    expect(
      extractAntigravityTaskUpdates(
        SESSION_ID,
        `Task: ${SESSION_ID}/task-104\nStatus: RUNNING\nLog: file:///tmp/task-104.log`,
      ),
    ).toEqual({ active: ['task-104'], settled: [] });

    expect(
      extractAntigravityTaskUpdates(
        SESSION_ID,
        `Task "${SESSION_ID}/task-104" cancelled.`,
      ),
    ).toEqual({ active: [], settled: ['task-104'] });

    expect(
      extractAntigravityTaskUpdates(
        SESSION_ID,
        `Task: ${SESSION_ID}/task-104\nStatus: COMPLETED`,
      ),
    ).toEqual({ active: [], settled: ['task-104'] });
  });

  it('rejects non-UUID session IDs and unsafe task slugs', () => {
    expect(
      extractAntigravityTaskUpdates(
        'not-a-uuid',
        'Tool is running as a background task with task id: not-a-uuid/task-1',
      ),
    ).toEqual({ active: [], settled: [] });

    expect(
      extractAntigravityTaskUpdates(
        SESSION_ID,
        `Tool is running as a background task with task id: ${SESSION_ID}/../escape`,
      ),
    ).toEqual({ active: [], settled: [] });
  });
});

describe('observeAntigravityBackgroundTasks', () => {
  it('tracks task log growth, interim notifications, and terminal completion messages', async () => {
    tempBrain = await mkdtemp(join(tmpdir(), 'MyAgents-agy-tasks-'));
    const tasksDir = join(tempBrain, SESSION_ID, '.system_generated', 'tasks');
    const messagesDir = join(tempBrain, SESSION_ID, '.system_generated', 'messages');
    await mkdir(tasksDir, { recursive: true });
    await mkdir(messagesDir, { recursive: true });

    const logPath = join(tasksDir, 'task-104.log');
    await writeFile(logPath, '[1s] query status=RUNNING\n', 'utf8');

    const active = new Set(['task-104']);
    const first = await observeAntigravityBackgroundTasks(
      tempBrain,
      SESSION_ID,
      active,
      new Map(),
      0,
    );
    expect(first.progressed).toBe(false);
    expect(first.settledTaskIds).toEqual([]);
    expect(first.nextLogSnapshots.has('task-104')).toBe(true);

    // Log growth counts as real background progress.
    await appendFile(logPath, '[30s] query status=RUNNING\n', 'utf8');
    const second = await observeAntigravityBackgroundTasks(
      tempBrain,
      SESSION_ID,
      active,
      first.nextLogSnapshots,
      first.latestMessageTimestamp,
    );
    expect(second.progressed).toBe(true);
    expect(second.settledTaskIds).toEqual([]);

    // Non-terminal notification timeout message advances progress without settling.
    await writeFile(
      join(messagesDir, 'interim.json'),
      JSON.stringify({
        id: 'interim',
        sender: `${SESSION_ID}/task-104`,
        recipient: SESSION_ID,
        timestamp: '2026-11-25T07:06:13.000Z',
        content: 'Background command is still running after 300s.',
      }),
      'utf8',
    );
    const third = await observeAntigravityBackgroundTasks(
      tempBrain,
      SESSION_ID,
      active,
      second.nextLogSnapshots,
      second.latestMessageTimestamp,
    );
    expect(third.progressed).toBe(true);
    expect(third.settledTaskIds).toEqual([]);
    expect(third.latestMessageTimestamp).toBe(Date.parse('2026-11-25T07:06:13.000Z'));

    // Terminal finish message settles the task and bumps progress for parent wakeup.
    await writeFile(
      join(messagesDir, 'done.json'),
      JSON.stringify({
        id: 'done',
        sender: `${SESSION_ID}/task-104`,
        recipient: SESSION_ID,
        timestamp: '2026-11-25T07:12:00.000Z',
        content: `Task id "${SESSION_ID}/task-104" finished with result:\nCommand exited with code 0.`,
      }),
      'utf8',
    );
    const fourth = await observeAntigravityBackgroundTasks(
      tempBrain,
      SESSION_ID,
      active,
      third.nextLogSnapshots,
      third.latestMessageTimestamp,
    );
    expect(fourth.progressed).toBe(true);
    expect(fourth.settledTaskIds).toEqual(['task-104']);
    expect(fourth.nextLogSnapshots.has('task-104')).toBe(false);
  });

  it('degrades cleanly when the native brain directory does not exist', async () => {
    const observation = await observeAntigravityBackgroundTasks(
      join(tmpdir(), 'nonexistent-agy-brain-dir'),
      SESSION_ID,
      new Set(['task-104']),
      new Map(),
      0,
    );
    expect(observation.progressed).toBe(false);
    expect(observation.settledTaskIds).toEqual([]);
  });
});
