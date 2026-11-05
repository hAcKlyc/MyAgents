import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertProductSystemSkillCandidate } from '../shared/projectCapabilities';
import { TASK_ALIGNMENT_SKILL_REQUIREMENT, REQUIRED_SYSTEM_SKILLS } from '../shared/systemSkills';

import {
  projectCapabilitySnapshotForWire,
  resolveEffectiveProjectCapabilities,
  setProjectCapabilityEnabled,
} from './project-capabilities';

const roots: string[] = [];

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nRun it.\n`;
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'myagents-project-capability-'));
  roots.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('TMPDIR', join(root, 'tmp'));
  vi.stubEnv('TEMP', join(root, 'tmp'));
  vi.stubEnv('TMP', join(root, 'tmp'));
  write(join(home, '.myagents', 'config.json'), JSON.stringify({
    agents: [{ id: 'agent-1', path: workspace }],
  }));
  write(join(home, '.myagents', 'projects.json'), JSON.stringify([
    { id: 'project-1', path: workspace, agentId: 'agent-1' },
  ]));
  for (const name of REQUIRED_SYSTEM_SKILLS) {
    write(join(home, '.myagents', 'skills', name, 'SKILL.md'), skill(name, 'required'));
  }
  return { home, workspace };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('effective project capabilities', () => {
  it.each(['LF', 'CRLF', 'mixed'])('admits bundled product Skill with %s line endings but rejects content changes', (ending) => {
    const { home, workspace } = makeFixture();
    const bundled = readFileSync('bundled-skills/myagents-task-alignment/SKILL.md', 'utf8').replace(/\r\n/g, '\n');
    const content = ending === 'LF' ? bundled : ending === 'CRLF'
      ? bundled.replace(/\n/g, '\r\n') : bundled.replace('\n', '\r\n');
    const path = join(home, '.myagents', 'skills', 'myagents-task-alignment', 'SKILL.md');
    write(path, content);
    expect(() => assertProductSystemSkillCandidate(resolveEffectiveProjectCapabilities(workspace), TASK_ALIGNMENT_SKILL_REQUIREMENT)).not.toThrow();
    write(path, content + 'Changed instructions.');
    expect(() => assertProductSystemSkillCandidate(resolveEffectiveProjectCapabilities(workspace), TASK_ALIGNMENT_SKILL_REQUIREMENT)).toThrow('does not match');
  });

  it('keeps display metadata separate from a Unicode filename-derived invocation identity', () => {
    const { home, workspace } = makeFixture();
    write(
      join(home, '.myagents', 'commands', '中文-总结.md'),
      '---\nname: 中文 总结\ndescription: 总结当前工作\n---\n执行总结。\n',
    );

    const snapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(snapshot.enabledCommands).toContainEqual(expect.objectContaining({
      source: 'global',
      sourceLocalId: '中文-总结',
      canonicalName: '中文-总结',
      name: '中文 总结',
    }));
    expect(projectCapabilitySnapshotForWire(snapshot).commands).toContainEqual(expect.objectContaining({
      name: '中文 总结',
      invocationName: '中文-总结',
      fileName: '中文-总结',
    }));
  });

  it('uses the same nested path identity for global Commands', () => {
    const { home, workspace } = makeFixture();
    write(
      join(home, '.myagents', 'commands', '发布', '生成-周报.md'),
      '---\nname: 全局周报\ndescription: 总结当前工作\n---\n执行总结。\n',
    );

    const snapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(snapshot.enabledCommands).toContainEqual(expect.objectContaining({
      source: 'global',
      sourceLocalId: '发布/生成-周报',
      canonicalName: '发布:生成-周报',
      name: '全局周报',
    }));
  });

  it('defaults candidates on, resolves project before global, and disables the winner without fallback', async () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'skills', 'global-review', 'SKILL.md'), skill('review', 'global'));
    write(join(workspace, '.claude', 'skills', 'local-review', 'SKILL.md'), skill('review', 'project'));
    write(join(home, '.myagents', 'commands', 'ship.md'), '---\nname: ship\n---\nGlobal ship.\n');

    const initial = resolveEffectiveProjectCapabilities(workspace);
    const review = initial.candidates.find(item => item.canonicalName === 'review');
    expect(review).toMatchObject({
      id: 'project:skill:local-review',
      source: 'project',
      enabled: true,
    });
    expect(initial.candidates.filter(item => item.canonicalName === 'review')).toHaveLength(1);

    const updated = await setProjectCapabilityEnabled({
      workspacePath: workspace,
      capabilityId: 'project:skill:local-review',
      enabled: false,
    });
    expect(updated.candidates.filter(item => item.canonicalName === 'review')).toEqual([
      expect.objectContaining({ id: 'project:skill:local-review', enabled: false }),
    ]);
    expect(updated.enabledSkills.some(item => item.canonicalName === 'review')).toBe(false);

    const config = JSON.parse(readFileSync(join(home, '.myagents', 'config.json'), 'utf8'));
    expect(config.agents[0].capabilitySelection.disabled.skills).toEqual([
      'project:skill:local-review',
    ]);
  });

  it('loads both workspace Skill conventions with deterministic Claude-first precedence', () => {
    const { workspace } = makeFixture();
    write(join(workspace, '.claude', 'skills', 'shared', 'SKILL.md'), skill('claude-shared', 'claude'));
    write(join(workspace, '.agents', 'skills', 'shared', 'SKILL.md'), skill('agents-shared', 'agents'));
    write(join(workspace, '.agents', 'skills', 'portable', 'SKILL.md'), skill('portable', 'portable'));

    const defaultSnapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(defaultSnapshot.enabledSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalName: 'claude-shared', path: expect.stringContaining('.claude/skills/shared/SKILL.md') }),
      expect.objectContaining({ canonicalName: 'portable', path: expect.stringContaining('.agents/skills/portable/SKILL.md') }),
    ]));
    expect(defaultSnapshot.candidates.some(item => item.canonicalName === 'agents-shared')).toBe(false);

    const agentsOnly = resolveEffectiveProjectCapabilities(workspace, {
      projectSkillDirectories: ['.agents/skills'],
    });
    expect(agentsOnly.enabledSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalName: 'agents-shared' }),
      expect.objectContaining({ canonicalName: 'portable' }),
    ]));
    expect(agentsOnly.candidates.some(item => item.canonicalName === 'claude-shared')).toBe(false);
    expect(agentsOnly.revision).not.toBe(defaultSnapshot.revision);
  });

  it('lets a valid later-root Skill replace an invalid earlier-root folder', () => {
    const { workspace } = makeFixture();
    mkdirSync(join(workspace, '.claude', 'skills', 'shared'), { recursive: true });
    write(join(workspace, '.agents', 'skills', 'shared', 'SKILL.md'), skill('agents-shared', 'agents'));

    expect(resolveEffectiveProjectCapabilities(workspace).enabledSkills).toContainEqual(
      expect.objectContaining({ canonicalName: 'agents-shared' }),
    );
  });

  it('keeps required system Skills enabled and rejects disabling them', async () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'skills', 'myagents-cli', 'SKILL.md'), skill('myagents-cli', 'required'));

    const snapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(snapshot.enabledSkills).toContainEqual(expect.objectContaining({
      id: 'global:skill:myagents-cli',
      required: true,
    }));
    await expect(setProjectCapabilityEnabled({
      workspacePath: workspace,
      capabilityId: 'global:skill:myagents-cli',
      enabled: false,
    })).rejects.toThrow('Required system Skill cannot be disabled');
  });

  it('uses the default enabled set without an exact owner but keeps writes strict', async () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'projects.json'), JSON.stringify([]));
    expect(resolveEffectiveProjectCapabilities(workspace)).toMatchObject({
      agentId: '',
      enabledSkills: expect.arrayContaining([
        expect.objectContaining({ canonicalName: 'myagents-cli' }),
      ]),
    });
    await expect(setProjectCapabilityEnabled({
      workspacePath: workspace,
      capabilityId: 'global:skill:myagents-cli',
      enabled: true,
    })).rejects.toThrow('unique Project owner');
  });

  it('treats historical project task-alignment copies as ordinary optional Skills', async () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'config.json'), JSON.stringify({
      agents: [{
        id: 'agent-1',
        path: workspace,
        capabilitySelection: {
          version: 1,
          disabled: {
            skills: ['project:skill:task-alignment'],
            commands: [],
          },
        },
      }],
    }));
    write(
      join(workspace, '.claude', 'skills', 'task-alignment', 'SKILL.md'),
      skill('task-alignment', 'historical project copy'),
    );

    const snapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(snapshot.candidates.filter(item => item.canonicalName === 'task-alignment')).toEqual([
      expect.objectContaining({
        id: 'project:skill:task-alignment',
        source: 'project',
        required: false,
        systemOwned: false,
        enabled: false,
      }),
    ]);
    await setProjectCapabilityEnabled({
      workspacePath: workspace,
      capabilityId: 'project:skill:task-alignment',
      enabled: true,
    });
    expect(resolveEffectiveProjectCapabilities(workspace).enabledSkills).toContainEqual(
      expect.objectContaining({ id: 'project:skill:task-alignment' }),
    );
  });

  it('keeps a project alias for retired task-alignment as an ordinary winner', () => {
    const { workspace } = makeFixture();
    write(
      join(workspace, '.claude', 'skills', 'local-alignment', 'SKILL.md'),
      skill('task-alignment', 'project override'),
    );

    const snapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(snapshot.candidates.filter(item => item.canonicalName === 'task-alignment')).toEqual([
      expect.objectContaining({
        id: 'project:skill:local-alignment',
        source: 'project',
        sourceLocalId: 'local-alignment',
        required: false,
        systemOwned: false,
        enabled: true,
      }),
    ]);
  });

  it('does not let ambiguous persistence ownership block capability reads', async () => {
    const { home, workspace } = makeFixture();
    const secondWorkspace = join(home, 'second-workspace');
    mkdirSync(secondWorkspace, { recursive: true });
    write(join(home, '.myagents', 'projects.json'), JSON.stringify([
      { id: 'project-1', path: workspace, agentId: 'agent-1' },
      { id: 'project-2', path: secondWorkspace, agentId: 'agent-1' },
    ]));
    expect(resolveEffectiveProjectCapabilities(workspace).agentId).toBe('');
    await expect(setProjectCapabilityEnabled({
      workspacePath: workspace,
      capabilityId: 'global:skill:myagents-cli',
      enabled: true,
    })).rejects.toThrow('claimed by multiple Projects');
  });

  it('isolates a global Skill that aliases a required system identity', () => {
    const { home, workspace } = makeFixture();
    write(
      join(home, '.myagents', 'skills', 'not-system-owned', 'SKILL.md'),
      skill('myagents-cli', 'not the official install'),
    );
    const snapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:skill:not-system-owned',
    }));
    expect(snapshot.integrityIssues).toContainEqual(expect.objectContaining({
      folderName: 'not-system-owned',
      reason: 'untrusted_global_source',
    }));
  });

  it('keeps reserved product command names outside project selection', () => {
    const { workspace } = makeFixture();
    write(join(workspace, '.claude', 'commands', 'custom.md'), '---\nname: compact\n---\nCustom compact.\n');
    write(join(workspace, '.claude', 'commands', 'goal.md'), '---\nname: goal\n---\nCustom goal.\n');
    write(join(workspace, '.claude', 'commands', 'invalid.md'), '---\nname: invalid name\n---\nInvalid.\n');
    expect(resolveEffectiveProjectCapabilities(workspace).candidates).not.toContainEqual(
      expect.objectContaining({ kind: 'command', canonicalName: 'compact' }),
    );
    expect(resolveEffectiveProjectCapabilities(workspace).candidates).not.toContainEqual(
      expect.objectContaining({ kind: 'command', canonicalName: 'invalid name' }),
    );
    expect(resolveEffectiveProjectCapabilities(workspace).candidates).not.toContainEqual(
      expect.objectContaining({ kind: 'command', canonicalName: 'goal' }),
    );
  });

  it('treats a real project entry as the owner of its physical projection slot', () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'skills', 'shared-slot', 'SKILL.md'), skill('global-name', 'global'));
    write(join(workspace, '.claude', 'skills', 'shared-slot', 'SKILL.md'), skill('project-name', 'project'));

    const snapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(snapshot.candidates).toContainEqual(expect.objectContaining({
      id: 'project:skill:shared-slot',
      canonicalName: 'project-name',
    }));
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:skill:shared-slot',
    }));
  });

  it('keeps invalid real project entries in control of their physical slots', () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'skills', 'occupied-skill', 'SKILL.md'), skill('global-skill', 'global'));
    mkdirSync(join(workspace, '.claude', 'skills', 'occupied-skill'), { recursive: true });
    write(join(home, '.myagents', 'commands', 'occupied-command.md'), 'Global command.\n');
    write(join(workspace, '.claude', 'commands', 'occupied-command.md'), '---\nname: local\n---\n');

    const snapshot = resolveEffectiveProjectCapabilities(workspace);

    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:skill:occupied-skill',
    }));
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:command:occupied-command',
    }));
  });

  it('rejects global Skill and Command symlinks inside or outside their capability roots', () => {
    const { home, workspace } = makeFixture();
    const outsideSkill = join(home, 'outside', 'skill');
    const outsideCommand = join(home, 'outside', 'command.md');
    write(join(outsideSkill, 'SKILL.md'), skill('outside-skill', 'outside'));
    write(outsideCommand, 'Outside command.\n');
    const globalSkills = join(home, '.myagents', 'skills');
    const globalCommands = join(home, '.myagents', 'commands');
    write(join(globalSkills, 'real-skill', 'SKILL.md'), skill('real-skill', 'real'));
    write(join(globalCommands, 'real-command.md'), 'Real command.\n');
    symlinkSync(outsideSkill, join(globalSkills, 'outside-skill'));
    symlinkSync(outsideCommand, join(globalCommands, 'outside-command.md'));
    symlinkSync(join(globalSkills, 'real-skill'), join(globalSkills, 'alias-skill'));
    symlinkSync(join(globalCommands, 'real-command.md'), join(globalCommands, 'alias-command.md'));

    const snapshot = resolveEffectiveProjectCapabilities(workspace);

    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:skill:outside-skill',
    }));
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:command:outside-command',
    }));
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:skill:alias-skill',
    }));
    expect(snapshot.candidates).not.toContainEqual(expect.objectContaining({
      id: 'global:command:alias-command',
    }));
  });

  it('treats a retired project Skill symlink as an ordinary winner by canonical name', () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'skills', 'global-alignment', 'SKILL.md'), skill('task-alignment', 'global'));
    const foreign = join(home, 'foreign-project-skill');
    write(join(foreign, 'SKILL.md'), skill('task-alignment', 'project link'));
    const projectSkills = join(workspace, '.claude', 'skills');
    mkdirSync(projectSkills, { recursive: true });
    symlinkSync(foreign, join(projectSkills, 'local-alignment'));

    const snapshot = resolveEffectiveProjectCapabilities(workspace);
    expect(snapshot.candidates.filter(item => item.canonicalName === 'task-alignment')).toEqual([
      expect.objectContaining({
        id: 'project:skill:local-alignment',
        source: 'project',
        required: false,
        enabled: true,
      }),
    ]);
  });

  it('supports a platform-valid colon in a Skill folder identity', () => {
    const { home, workspace } = makeFixture();
    write(join(home, '.myagents', 'skills', 'bad:name', 'SKILL.md'), skill('bad-name', 'colon folder'));
    write(join(home, '.myagents', 'skills', 'healthy', 'SKILL.md'), skill('healthy', 'healthy'));

    const snapshot = resolveEffectiveProjectCapabilities(workspace);

    expect(snapshot.candidates).toContainEqual(expect.objectContaining({
      id: 'global:skill:bad:name',
      canonicalName: 'bad-name',
    }));
    expect(snapshot.enabledSkills).toContainEqual(expect.objectContaining({
      id: 'global:skill:healthy',
      canonicalName: 'healthy',
    }));
  });
});
