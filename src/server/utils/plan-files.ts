import { constants as fsConstants } from 'fs';
import { lstat, open, readdir, realpath, unlink, type FileHandle } from 'fs/promises';
import { basename, dirname, join, relative, resolve } from 'path';

const SESSION_PLANS_SEGMENTS = ['.claude', 'plans', 'myagents'] as const;
export const SESSION_PLANS_GITIGNORE_PATTERN = `${SESSION_PLANS_SEGMENTS.join('/')}/`;
export const MAX_PLAN_BYTES = 128 * 1024;
const OPEN_READ_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export function sanitizePlanSessionSegment(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'session';
}

export function getSessionPlansDirectorySetting(sessionId: string): string {
  return [...SESSION_PLANS_SEGMENTS, sanitizePlanSessionSegment(sessionId)].join('/');
}

export function getSessionPlansDirectoryPath(agentDir: string, sessionId: string): string {
  return join(agentDir, ...SESSION_PLANS_SEGMENTS, sanitizePlanSessionSegment(sessionId));
}

/** Only the current Product Session's direct Markdown files are writable in plan mode.
 * Check each existing component rather than following symlinks; a plan exception
 * must never grant writes to project source, another session, or a linked file.
 */
export async function isSessionPlanFileTool(
  toolName: string,
  input: unknown,
  agentDir: string | null,
  sessionId: string,
): Promise<boolean> {
  if (!agentDir || (toolName !== 'Write' && toolName !== 'Edit')) return false;
  const obj = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (typeof obj.file_path !== 'string' || !obj.file_path || obj.file_path.includes('\0')) return false;
  const root = resolve(agentDir);
  const target = resolve(root, obj.file_path);
  const plansDir = getSessionPlansDirectoryPath(root, sessionId);
  if (dirname(target) !== plansDir || !basename(target).toLowerCase().endsWith('.md')) return false;
  const segments = [...SESSION_PLANS_SEGMENTS, sanitizePlanSessionSegment(sessionId), basename(target)];
  let current = root;
  try {
    for (let i = 0; i < segments.length; i += 1) {
      current = join(current, segments[i]);
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        // Write creates missing parents; no existing links can redirect this path.
        if ((error as { code?: string }).code === 'ENOENT') return true;
        return false;
      }
      if (stat.isSymbolicLink()) return false;
      if (i === segments.length - 1) return stat.isFile() && stat.nlink === 1;
      if (!stat.isDirectory()) return false;
    }
  } catch {
    return false; // permission/IO errors must not widen the exception
  }
  return false;
}

export type LatestPlanReadResult = {
  content: string;
  path: string;
  truncated: boolean;
};

type PlanReadOptions = {
  minMtimeMs?: number;
  expectedRoot?: string;
};

type PlanCandidate = {
  path: string;
  mtimeMs: number;
  size: number;
};

export async function readLatestPlanMarkdown(
  plansDir: string,
  options: PlanReadOptions = {},
): Promise<LatestPlanReadResult | null> {
  if (!(await isPlanDirectoryAllowed(plansDir, options.expectedRoot))) {
    return null;
  }

  let entries;
  try {
    entries = await readdir(plansDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }

  const candidates: PlanCandidate[] = [];
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) return;
    const fullPath = join(plansDir, entry.name);
    let stat;
    try {
      stat = await lstat(fullPath);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isFile()) return;
    if (options.minMtimeMs !== undefined && stat.mtimeMs < options.minMtimeMs) return;
    candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
  }));

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  for (const candidate of candidates) {
    const result = await readPlanCandidate(candidate, options);
    if (result) return result;
  }
  return null;
}

async function readPlanCandidate(
  candidate: PlanCandidate,
  options: PlanReadOptions,
): Promise<LatestPlanReadResult | null> {
  let file: FileHandle;
  try {
    file = await open(candidate.path, OPEN_READ_NOFOLLOW);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null;
    throw error;
  }

  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    if (options.minMtimeMs !== undefined && stat.mtimeMs < options.minMtimeMs) return null;

    const bytesToRead = Math.min(stat.size, MAX_PLAN_BYTES + 1);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
    const truncated = bytesRead > MAX_PLAN_BYTES || stat.size > MAX_PLAN_BYTES;
    const content = buffer
      .subarray(0, Math.min(bytesRead, MAX_PLAN_BYTES))
      .toString('utf8');
    return {
      content: truncated
        ? `${content}\n\n[Plan content truncated at ${MAX_PLAN_BYTES} bytes for display.]`
        : content,
      path: candidate.path,
      truncated,
    };
  } finally {
    await file.close();
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function readLatestPlanMarkdownWithRetry(
  plansDir: string,
  options: {
    minMtimeMs?: number;
    expectedRoot?: string;
    signal?: AbortSignal;
    attempts?: number;
    delayMs?: number;
  } = {},
): Promise<LatestPlanReadResult | null> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const delayMs = Math.max(0, options.delayMs ?? 50);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const latest = await readLatestPlanMarkdown(plansDir, {
      minMtimeMs: options.minMtimeMs,
      expectedRoot: options.expectedRoot,
    });
    if (latest) return latest;

    if (attempt < attempts - 1 && delayMs > 0) {
      await delay(delayMs, options.signal);
    }
  }

  return null;
}

async function isRealPathInside(childPath: string, rootPath: string): Promise<boolean> {
  try {
    const [childReal, rootReal] = await Promise.all([realpath(childPath), realpath(rootPath)]);
    const rel = relative(rootReal, childReal);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !/^[a-zA-Z]:/.test(rel));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return true;
    throw error;
  }
}

async function isPlanDirectoryAllowed(plansDir: string, expectedRoot?: string): Promise<boolean> {
  try {
    const stat = await lstat(plansDir);
    if (!stat.isDirectory()) return false;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    throw error;
  }

  return !expectedRoot || isRealPathInside(plansDir, expectedRoot);
}

export async function clearSessionPlanMarkdown(
  plansDir: string,
  options: { expectedRoot?: string } = {},
): Promise<void> {
  if (!(await isPlanDirectoryAllowed(plansDir, options.expectedRoot))) {
    return;
  }

  let entries;
  try {
    entries = await readdir(plansDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) return;
    const fullPath = join(plansDir, entry.name);
    let stat;
    try {
      stat = await lstat(fullPath);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isFile()) return;
    await unlink(fullPath);
  }));
}
