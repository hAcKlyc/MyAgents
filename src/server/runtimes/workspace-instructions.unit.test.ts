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

describe('resolveAntigravityWorkspaceInstructions', () => {
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

  it('skips root CLAUDE.md when root AGENTS.md is a symlink to CLAUDE.md, while keeping .claude supplements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-symlink-agents-'));
    roots.push(root);
    await mkdir(join(root, '.claude', 'rules'), { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), 'shared root guidance\n', 'utf8');
    await symlink('CLAUDE.md', join(root, 'AGENTS.md'));
    await writeFile(join(root, '.claude', 'CLAUDE.md'), 'companion claude doc', 'utf8');
    await writeFile(join(root, '.claude', 'rules', 'style.md'), 'follow style rule', 'utf8');

    const supplement = resolveAntigravityWorkspaceInstructions(root);
    expect(supplement).not.toContain('shared root guidance');
    expect(supplement).toContain('companion claude doc');
    expect(supplement).toContain('follow style rule');
  });

  it('returns empty string when AGENTS.md symlinks to CLAUDE.md and no .claude supplements exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-symlink-only-'));
    roots.push(root);
    await writeFile(join(root, 'CLAUDE.md'), 'root guidance', 'utf8');
    await symlink('CLAUDE.md', join(root, 'AGENTS.md'));

    expect(resolveAntigravityWorkspaceInstructions(root)).toBe('');
  });

  it('skips root CLAUDE.md when GEMINI.md symlinks to CLAUDE.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-symlink-gemini-'));
    roots.push(root);
    await writeFile(join(root, 'CLAUDE.md'), 'gemini root guidance', 'utf8');
    await symlink('CLAUDE.md', join(root, 'GEMINI.md'));

    expect(resolveAntigravityWorkspaceInstructions(root)).toBe('');
  });

  it('skips root CLAUDE.md when root AGENTS.md has identical trimmed content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-identical-content-'));
    roots.push(root);
    await mkdir(join(root, '.claude', 'rules'), { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), '  same instructions body\n\n', 'utf8');
    await writeFile(join(root, 'AGENTS.md'), 'same instructions body\n', 'utf8');
    await writeFile(join(root, '.claude', 'rules', '01.md'), 'extra rule', 'utf8');

    const supplement = resolveAntigravityWorkspaceInstructions(root);
    expect(supplement).not.toContain('same instructions body');
    expect(supplement).toContain('extra rule');
  });

  it('injects root CLAUDE.md when root AGENTS.md has distinct content or is absent', async () => {
    const rootDistinct = await mkdtemp(join(tmpdir(), 'agy-distinct-'));
    const rootMissing = await mkdtemp(join(tmpdir(), 'agy-missing-'));
    roots.push(rootDistinct, rootMissing);

    await writeFile(join(rootDistinct, 'CLAUDE.md'), 'claude-specific guidance', 'utf8');
    await writeFile(join(rootDistinct, 'AGENTS.md'), 'different agents guidance', 'utf8');
    expect(resolveAntigravityWorkspaceInstructions(rootDistinct)).toContain('claude-specific guidance');

    await writeFile(join(rootMissing, 'CLAUDE.md'), 'standalone claude guidance', 'utf8');
    expect(resolveAntigravityWorkspaceInstructions(rootMissing)).toContain('standalone claude guidance');
  });

  it('does not follow an out-of-workspace AGENTS.md symlink escape even with identical content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-escape-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'agy-escape-outside-'));
    roots.push(root, outside);

    await writeFile(join(root, 'CLAUDE.md'), 'workspace guidance', 'utf8');
    await writeFile(join(outside, 'secret.md'), 'workspace guidance', 'utf8');
    await symlink(join(outside, 'secret.md'), join(root, 'AGENTS.md'));

    const supplement = resolveAntigravityWorkspaceInstructions(root);
    expect(supplement).toContain('workspace guidance');
  });

  it('keeps root CLAUDE.md when AGENTS.md is a broken symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-broken-symlink-'));
    roots.push(root);

    await writeFile(join(root, 'CLAUDE.md'), 'valid root guidance', 'utf8');
    await symlink('does-not-exist.md', join(root, 'AGENTS.md'));

    expect(resolveAntigravityWorkspaceInstructions(root)).toContain('valid root guidance');
  });
});
