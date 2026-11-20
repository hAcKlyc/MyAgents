import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAntigravityWorkspaceInstructions, resolveDshWorkspaceSupplement } from './workspace-instructions';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

describe('resolveDshWorkspaceSupplement', () => {
  it('includes only Claude companion sources with relative deterministic paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'myagents-dsh-context-'));
    roots.push(root);
    await mkdir(join(root, '.claude', 'rules', 'nested'), { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), 'primary claude', 'utf8');
    await writeFile(join(root, 'AGENTS.md'), 'primary agents', 'utf8');
    await writeFile(join(root, '.claude', 'CLAUDE.md'), 'companion memory', 'utf8');
    await writeFile(join(root, '.claude', 'rules', 'z.md'), 'rule z', 'utf8');
    await writeFile(join(root, '.claude', 'rules', 'a.md'), 'rule {{literal}}', 'utf8');
    await writeFile(join(root, '.claude', 'rules', 'nested', 'b.md'), 'rule b', 'utf8');

    const result = resolveDshWorkspaceSupplement(root);
    expect(result).toContain('## .claude/CLAUDE.md\ncompanion memory');
    expect(result).toContain('## .claude/rules/a.md\nrule {{literal}}');
    expect(result).not.toContain('primary claude');
    expect(result).not.toContain('primary agents');
    expect(result.indexOf('.claude/rules/a.md')).toBeLessThan(result.indexOf('.claude/rules/z.md'));
    expect(result).not.toContain(root);
  });
});

it('does not inject linked Claude companion directories into Antigravity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-project-'));
  const outside = await mkdtemp(join(tmpdir(), 'agy-outside-'));
  roots.push(root, outside);
  await writeFile(join(root, 'CLAUDE.md'), 'local guidance');
  await writeFile(join(outside, 'CLAUDE.md'), 'external guidance');
  await symlink(outside, join(root, '.claude'), 'junction');
  const supplement = resolveAntigravityWorkspaceInstructions(root);
  expect(supplement).toContain('local guidance');
  expect(supplement).not.toContain('external guidance');
});
