import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_PLANS_GITIGNORE_PATTERN,
  isSessionPlanFileTool,
  clearSessionPlanMarkdown,
  getSessionPlansDirectoryPath,
  getSessionPlansDirectorySetting,
  readLatestPlanMarkdown,
  readLatestPlanMarkdownWithRetry,
  sanitizePlanSessionSegment,
} from './plan-files';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'myagents-plan-files-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('session plan files', () => {
  it('uses a sanitized session-scoped plansDirectory setting', () => {
    expect(sanitizePlanSessionSegment('sid/../bad:value')).toBe('sid_bad_value');
    expect(getSessionPlansDirectorySetting('sid/../bad:value')).toBe('.claude/plans/myagents/sid_bad_value');
    expect(getSessionPlansDirectoryPath('/workspace', 'sid/../bad:value')).toContain(join('.claude', 'plans', 'myagents', 'sid_bad_value'));
    expect(SESSION_PLANS_GITIGNORE_PATTERN).toBe('.claude/plans/myagents/');
  });

  it('reads the latest markdown plan newer than the current-turn cutoff', async () => {
    const root = makeRoot();
    const dir = join(root, '.claude', 'plans', 'myagents', 'session-1');
    mkdirSync(dir, { recursive: true });

    const stale = join(dir, 'stale.md');
    const current = join(dir, 'current.md');
    const ignored = join(dir, 'notes.txt');
    writeFileSync(stale, 'stale plan');
    writeFileSync(current, 'current plan');
    writeFileSync(ignored, 'not a markdown plan');

    const cutoff = new Date('2026-06-15T00:00:00.000Z');
    utimesSync(stale, cutoff, new Date(cutoff.getTime() - 1000));
    utimesSync(current, cutoff, new Date(cutoff.getTime() + 1000));

    const result = await readLatestPlanMarkdown(dir, {
      minMtimeMs: cutoff.getTime(),
      expectedRoot: root,
    });

    expect(result?.path).toBe(current);
    expect(result?.content).toBe('current plan');
    expect(result?.truncated).toBe(false);
  });

  it('retries briefly for a plan file created during approval handoff', async () => {
    const dir = join(makeRoot(), '.claude', 'plans', 'myagents', 'session-1');
    mkdirSync(dir, { recursive: true });

    const pending = readLatestPlanMarkdownWithRetry(dir, { attempts: 3, delayMs: 10 });
    setTimeout(() => writeFileSync(join(dir, 'later.md'), 'later plan'), 1);

    const result = await pending;

    expect(result?.content).toBe('later plan');
  });

  it('ignores symlink leaves instead of following them', async () => {
    const root = makeRoot();
    const dir = join(root, '.claude', 'plans', 'myagents', 'session-1');
    mkdirSync(dir, { recursive: true });
    const target = join(root, 'secret.md');
    writeFileSync(target, 'secret');

    try {
      symlinkSync(target, join(dir, 'plan.md'));
    } catch {
      return;
    }

    await expect(readLatestPlanMarkdown(dir)).resolves.toBeNull();
  });

  it('does not read a plans directory symlink that resolves outside the expected root', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    const parent = join(root, '.claude', 'plans', 'myagents');
    const dir = join(parent, 'session-1');
    mkdirSync(parent, { recursive: true });
    writeFileSync(join(outside, 'outside.md'), 'do not read');

    try {
      symlinkSync(outside, dir, 'dir');
    } catch {
      return;
    }

    await expect(readLatestPlanMarkdown(dir, { expectedRoot: root })).resolves.toBeNull();
    await expect(readLatestPlanMarkdownWithRetry(dir, { expectedRoot: root, attempts: 1 })).resolves.toBeNull();
  });

  it('truncates large plan files before they enter SSE payloads', async () => {
    const dir = join(makeRoot(), '.claude', 'plans', 'myagents', 'session-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'big.md'), Buffer.alloc(129 * 1024, 'a'));

    const result = await readLatestPlanMarkdown(dir);

    expect(result?.truncated).toBe(true);
    expect(result?.content).toContain('Plan content truncated');
    expect(result?.content.length).toBeLessThan(132_000);
  });

  it('clears stale markdown plans without touching non-markdown files', async () => {
    const dir = join(makeRoot(), '.claude', 'plans', 'myagents', 'session-1');
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'stale.md');
    const note = join(dir, 'note.txt');
    writeFileSync(stale, 'old');
    writeFileSync(note, 'keep');

    await clearSessionPlanMarkdown(dir);

    await expect(readLatestPlanMarkdown(dir)).resolves.toBeNull();
    expect(existsSync(note)).toBe(true);
    await expect(readLatestPlanMarkdown(join(dir, 'missing'))).resolves.toBeNull();
  });

  it('does not clear a plans directory that resolves outside the expected root', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    const parent = join(root, '.claude', 'plans', 'myagents');
    const dir = join(parent, 'session-1');
    mkdirSync(parent, { recursive: true });
    const outsidePlan = join(outside, 'outside.md');
    writeFileSync(outsidePlan, 'keep');

    try {
      symlinkSync(outside, dir, 'dir');
    } catch {
      return;
    }

    await clearSessionPlanMarkdown(dir, { expectedRoot: root });

    expect(existsSync(outsidePlan)).toBe(true);
  });
});


describe('plan-mode file exception', () => {
  it('allows only direct current-session Markdown Write/Edit, including missing parents', async () => {
    const root = makeRoot();
    const plan = join(getSessionPlansDirectoryPath(root, 'session-1'), 'plan.md');
    for (const tool of ['Write', 'Edit']) {
      expect(await isSessionPlanFileTool(tool, { file_path: plan }, root, 'session-1')).toBe(true);
    }
    for (const path of ['.agent-sync/plan.md', 'src/plan.md',
      getSessionPlansDirectoryPath(root, 'session-2') + '/plan.md',
      plan + '/nested.md', plan.replace('plan.md', 'script.ts')]) {
      expect(await isSessionPlanFileTool('Write', { file_path: path }, root, 'session-1')).toBe(false);
    }
    expect(await isSessionPlanFileTool('MultiEdit', { file_path: plan }, root, 'session-1')).toBe(false);
    expect(await isSessionPlanFileTool('Bash', { file_path: plan }, root, 'session-1')).toBe(false);
    expect(await isSessionPlanFileTool('Write', {}, root, 'session-1')).toBe(false);
    expect(await isSessionPlanFileTool('Write', { file_path: plan }, null, 'session-1')).toBe(false);
    mkdirSync(getSessionPlansDirectoryPath(root, 'session-1'), { recursive: true });
    writeFileSync(plan, '# Plan');
    expect(await isSessionPlanFileTool('Edit', { file_path: plan }, root, 'session-1')).toBe(true);
  });

  it.each(['.claude', '.claude/plans', '.claude/plans/myagents', '.claude/plans/myagents/session-1'])(
    'rejects symlink directory %s, including links staying inside the project', async segment => {
      const root = makeRoot();
      const target = join(root, 'linked');
      mkdirSync(target);
      const link = join(root, segment);
      mkdirSync(join(link, '..'), { recursive: true });
      symlinkSync(target, link, 'dir');
      const plan = join(getSessionPlansDirectoryPath(root, 'session-1'), 'plan.md');
      expect(await isSessionPlanFileTool('Write', { file_path: plan }, root, 'session-1')).toBe(false);
    },
  );

  it('rejects symlink and hardlink files, directories, and traversal to other sessions', async () => {
    const root = makeRoot();
    const dir = getSessionPlansDirectoryPath(root, 'session-1');
    mkdirSync(dir, { recursive: true });
    const target = join(root, 'source.md');
    writeFileSync(target, 'source');
    symlinkSync(target, join(dir, 'link.md'));
    linkSync(target, join(dir, 'hard.md'));
    mkdirSync(join(dir, 'directory.md'));
    for (const name of ['link.md', 'hard.md', 'directory.md', '../session-2/plan.md']) {
      expect(await isSessionPlanFileTool('Edit', { file_path: join(dir, name) }, root, 'session-1')).toBe(false);
    }
  });
});
