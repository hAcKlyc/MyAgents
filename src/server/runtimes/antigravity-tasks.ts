import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SAFE_TASK_SLUG = /^task-\d+$/;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const OPEN_READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export interface AntigravityTaskLogSnapshot {
  size: number;
  mtimeMs: number;
}

export interface AntigravityTaskUpdates {
  active: string[];
  settled: string[];
}

export interface AntigravityTaskObservation {
  filesObservable: boolean;
  settledTaskIds: string[];
  progressed: boolean;
  latestMessageTimestamp: number;
  nextLogSnapshots: Map<string, AntigravityTaskLogSnapshot>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fileNotPresent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
}

function withinBrain(brainRoot: string, candidate: string): boolean {
  const fromRoot = relative(brainRoot, candidate);
  return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

/**
 * Extract native Antigravity background task transitions (run_command background
 * tasks, schedule timers, manage_task status/cancel outputs) bound strictly to
 * the active native session ID.
 */
export function extractAntigravityTaskUpdates(
  nativeSessionId: string,
  content: string,
): AntigravityTaskUpdates {
  if (!NATIVE_ID.test(nativeSessionId) || !content) {
    return { active: [], settled: [] };
  }
  const escapedSession = escapeRegExp(nativeSessionId);
  const active = new Set<string>();
  const settled = new Set<string>();

  // 1. Backgrounded run_command / schedule launch notice.
  const launchRe = new RegExp(
    `background task with task id:\\s*["']?${escapedSession}/(task-\\d+)["']?`,
    'gi',
  );
  for (const match of content.matchAll(launchRe)) {
    const slug = match[1];
    if (slug && SAFE_TASK_SLUG.test(slug)) active.add(slug);
  }

  // 2. manage_task status / list blocks: "Task: <sid>/task-<N>\nStatus: <STATE>"
  const statusRe = new RegExp(
    `Task:\\s*${escapedSession}/(task-\\d+)\\r?\\nStatus:\\s*([A-Z_]+)`,
    'g',
  );
  for (const match of content.matchAll(statusRe)) {
    const slug = match[1];
    const status = match[2];
    if (!slug || !SAFE_TASK_SLUG.test(slug)) continue;
    if (status === 'RUNNING' || status === 'PENDING' || status === 'SCHEDULED') {
      active.add(slug);
    } else if (
      status === 'COMPLETED' ||
      status === 'DONE' ||
      status === 'FAILED' ||
      status === 'CANCELED' ||
      status === 'CANCELLED' ||
      status === 'STOPPED' ||
      status === 'KILLED'
    ) {
      settled.add(slug);
      active.delete(slug);
    }
  }

  // 3. manage_task kill/cancel confirmation: Task "<sid>/task-<N>" cancelled.
  const cancelRe = new RegExp(
    `Task\\s+["']?${escapedSession}/(task-\\d+)["']?\\s+(?:was\\s+)?(?:cancel(?:l)?ed|killed|stopped)`,
    'gi',
  );
  for (const match of content.matchAll(cancelRe)) {
    const slug = match[1];
    if (!slug || !SAFE_TASK_SLUG.test(slug)) continue;
    settled.add(slug);
    active.delete(slug);
  }

  return {
    active: [...active],
    settled: [...settled],
  };
}

function isTerminalTaskMessage(
  nativeSessionId: string,
  taskSlug: string,
  content: string,
): boolean {
  const escaped = escapeRegExp(`${nativeSessionId}/${taskSlug}`);
  return new RegExp(
    `Task id\\s+"${escaped}"\\s+(?:finished|was cancel(?:l)?ed|failed|stopped|killed)`,
    'i',
  ).test(content);
}

async function readMessageRecord(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const handle = await open(filePath, OPEN_READ_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_MESSAGE_BYTES) return undefined;
      const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (fileNotPresent(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Observe tracked Antigravity background tasks via their native `.system_generated`
 * log files and completion inbox messages. Degrades cleanly if the directory or
 * files are absent so a CLI layout change falls back safely to default watchdog behavior.
 */
export async function observeAntigravityBackgroundTasks(
  brainDirectory: string,
  nativeSessionId: string,
  activeTaskIds: ReadonlySet<string>,
  previousLogSnapshots: ReadonlyMap<string, AntigravityTaskLogSnapshot>,
  previousMessageTimestamp: number,
): Promise<AntigravityTaskObservation> {
  const nextLogSnapshots = new Map<string, AntigravityTaskLogSnapshot>(previousLogSnapshots);
  if (!NATIVE_ID.test(nativeSessionId) || activeTaskIds.size === 0) {
    return {
      filesObservable: false,
      settledTaskIds: [],
      progressed: false,
      latestMessageTimestamp: previousMessageTimestamp,
      nextLogSnapshots,
    };
  }

  let brainRoot: string;
  try {
    brainRoot = await realpath(brainDirectory);
  } catch (error) {
    if (fileNotPresent(error)) {
      return {
        filesObservable: false,
        settledTaskIds: [],
        progressed: false,
        latestMessageTimestamp: previousMessageTimestamp,
        nextLogSnapshots,
      };
    }
    throw error;
  }

  let filesObservable = false;
  let progressed = false;
  let latestMessageTimestamp = previousMessageTimestamp;
  const settled = new Set<string>();

  // 1. Check task log growth (size / mtimeMs) as a lightweight progress signal.
  try {
    const tasksDir = await realpath(
      join(brainRoot, nativeSessionId, '.system_generated', 'tasks'),
    );
    if (withinBrain(brainRoot, tasksDir)) {
      filesObservable = true;
      for (const taskSlug of activeTaskIds) {
        if (!SAFE_TASK_SLUG.test(taskSlug)) continue;
        const logPath = join(tasksDir, `${taskSlug}.log`);
        try {
          const resolvedLog = await realpath(logPath);
          if (!withinBrain(brainRoot, resolvedLog)) continue;
          const info = await stat(resolvedLog);
          if (!info.isFile()) continue;
          const next = { size: info.size, mtimeMs: info.mtimeMs };
          const prev = previousLogSnapshots.get(taskSlug);
          if (!prev) {
            nextLogSnapshots.set(taskSlug, next);
          } else if (prev.size !== next.size || prev.mtimeMs !== next.mtimeMs) {
            nextLogSnapshots.set(taskSlug, next);
            progressed = true;
          }
        } catch (error) {
          if (!fileNotPresent(error)) throw error;
        }
      }
    }
  } catch (error) {
    if (!fileNotPresent(error)) throw error;
  }

  // 2. Check native session inbox messages for task progress or completion.
  try {
    const messagesDir = await realpath(
      join(brainRoot, nativeSessionId, '.system_generated', 'messages'),
    );
    if (withinBrain(brainRoot, messagesDir)) {
      const entries = await readdir(messagesDir, { withFileTypes: true });
      filesObservable = true;
      const senderToSlug = new Map<string, string>();
      for (const taskSlug of activeTaskIds) {
        if (SAFE_TASK_SLUG.test(taskSlug)) {
          senderToSlug.set(`${nativeSessionId}/${taskSlug}`, taskSlug);
        }
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'read.json') {
          continue;
        }
        const record = await readMessageRecord(join(messagesDir, entry.name));
        if (!record || record.recipient !== nativeSessionId || typeof record.sender !== 'string') {
          continue;
        }
        const taskSlug = senderToSlug.get(record.sender);
        if (!taskSlug) continue;
        const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
        if (Number.isFinite(ts) && ts > latestMessageTimestamp) {
          latestMessageTimestamp = ts;
          progressed = true;
        }
        if (
          typeof record.content === 'string' &&
          isTerminalTaskMessage(nativeSessionId, taskSlug, record.content)
        ) {
          settled.add(taskSlug);
          progressed = true;
        }
      }
    }
  } catch (error) {
    if (!fileNotPresent(error)) throw error;
  }

  for (const slug of settled) {
    nextLogSnapshots.delete(slug);
  }

  return {
    filesObservable,
    settledTaskIds: [...settled],
    progressed,
    latestMessageTimestamp,
    nextLogSnapshots,
  };
}
