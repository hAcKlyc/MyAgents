import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_SYSTEM_SKILLS } from '../../shared/systemSkills';
import type { EffectiveProjectCapabilitySnapshot } from '../../shared/projectCapabilities';
import { resolveEffectiveProjectCapabilities } from '../project-capabilities';

import { getMyAgentsUserDir, syncProjectUserConfigFiles, trySyncProjectUserConfigFiles } from './project-user-config-sync';

describe('project-user-config-sync', () => {
  const tempRoots: string[] = [];
  const itNonWindows = process.platform === 'win32' ? it.skip : it;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeEnv(): { root: string; home: string; workspace: string } {
    const root = join(tmpdir(), `myagents-project-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const home = join(root, 'home');
    const temp = join(root, 'tmp');
    const workspace = join(root, 'workspace');
    mkdirSync(home, { recursive: true });
    mkdirSync(temp, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    tempRoots.push(root);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('TMPDIR', temp);
    vi.stubEnv('TEMP', temp);
    vi.stubEnv('TMP', temp);
    for (const name of REQUIRED_SYSTEM_SKILLS) writeUserSkill(home, name);
    return { root, home, workspace };
  }

  function writeUserSkill(home: string, name: string): void {
    const dir = join(home, '.myagents', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  }

  function writeUserCommand(home: string, name: string): void {
    const dir = join(home, '.myagents', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
  }

  it('links enabled MyAgents user skills into the project .claude/skills directory', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    const linkPath = join(workspace, '.claude', 'skills', 'review-helper');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(join(linkPath, 'SKILL.md'))).toBe(true);
    expect(getMyAgentsUserDir()).toBe(join(home, '.myagents'));
  });

  it('keeps the Cuse CLI and references together and preserves disable across content updates', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'cuse');
    const source = join(home, '.myagents', 'skills', 'cuse');
    mkdirSync(join(source, 'scripts'));
    mkdirSync(join(source, 'references'));
    const binary = process.platform === 'win32' ? 'cuse.exe' : 'cuse';
    writeFileSync(join(source, 'scripts', binary), 'native CLI');
    writeFileSync(join(source, 'references', 'setup.md'), 'setup');
    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    const projected = join(workspace, '.claude', 'skills', 'cuse');
    expect(readFileSync(join(projected, 'scripts', binary), 'utf8')).toBe('native CLI');
    expect(readFileSync(join(projected, 'references', 'setup.md'), 'utf8')).toBe('setup');
    const config = join(home, '.myagents', 'skills-config.json');
    writeFileSync(config, JSON.stringify({ disabled: ['cuse'] }));
    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    expect(existsSync(projected)).toBe(false);
    writeFileSync(join(source, 'scripts', binary), 'updated CLI');
    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    expect(existsSync(projected)).toBe(false);
    expect(JSON.parse(readFileSync(config, 'utf8')).disabled).toEqual(['cuse']);
    writeFileSync(config, JSON.stringify({ disabled: [] }));
    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    expect(readFileSync(join(projected, 'scripts', binary), 'utf8')).toBe('updated CLI');
  });

  it('removes managed skill symlinks when the skill is disabled', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    const linkPath = join(workspace, '.claude', 'skills', 'review-helper');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    const configPath = join(home, '.myagents', 'skills-config.json');
    writeFileSync(configPath, JSON.stringify({ disabled: ['review-helper'] }));

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    expect(existsSync(linkPath)).toBe(false);
  });

  it('keeps all required system skills exposed while honoring an optional system skill disable', () => {
    const { home, workspace } = makeEnv();
    const required = [
      'myagents-memory-update',
      'myagents-memory-gardener',
      'myagents-memory-molt',
      'myagents-cli',
      'myagents-docs',
    ];
    for (const name of [...required, 'prompt-writer']) writeUserSkill(home, name);
    writeFileSync(
      join(home, '.myagents', 'skills-config.json'),
      JSON.stringify({ disabled: [...required, 'prompt-writer'] }),
    );

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    for (const name of required) {
      const linkPath = join(workspace, '.claude', 'skills', name);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    }
    expect(existsSync(join(workspace, '.claude', 'skills', 'prompt-writer'))).toBe(false);
  });

  it('does not overwrite real project skill directories', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');
    const projectSkillDir = join(workspace, '.claude', 'skills', 'review-helper');
    mkdirSync(projectSkillDir, { recursive: true });
    writeFileSync(join(projectSkillDir, 'SKILL.md'), 'project-owned');

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    expect(lstatSync(projectSkillDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(projectSkillDir, 'SKILL.md'), 'utf-8')).toBe('project-owned');
  });

  it('removes a global projection shadowed by a project canonical winner', () => {
    const { home, workspace } = makeEnv();
    const globalName = 'review-helper';
    writeUserSkill(home, globalName);
    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    const globalLink = join(workspace, '.claude', 'skills', globalName);
    expect(lstatSync(globalLink).isSymbolicLink()).toBe(true);

    const projectFolder = 'local-review';
    const projectSkill = join(workspace, '.claude', 'skills', projectFolder);
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(
      join(projectSkill, 'SKILL.md'),
      `---\nname: ${globalName}\ndescription: Project winner\n---\n`,
    );
    const capabilitySnapshot: EffectiveProjectCapabilitySnapshot = {
      workspacePath: workspace,
      agentId: 'agent-1',
      revision: 'revision',
      integrityRevision: 'integrity',
      integrityIssues: [],
      candidates: [{
        id: `project:skill:${projectFolder}`,
        kind: 'skill',
        source: 'project',
        sourceLocalId: projectFolder,
        canonicalName: globalName,
        name: globalName,
        description: 'Project winner',
        path: join(projectSkill, 'SKILL.md'),
        required: false,
        systemOwned: false,
        enabled: true,
        contentSha256: 'project-winner',
      }],
      enabledSkills: [],
      enabledCommands: [],
    };

    const result = syncProjectUserConfigFiles(workspace, {
      cliToolRegistryEnabled: true,
      capabilitySnapshot,
    });

    expect(existsSync(globalLink)).toBe(false);
    expect(result.unavailableSkillNames).toEqual([]);
    expect(readFileSync(join(projectSkill, 'SKILL.md'), 'utf8')).toContain('Project winner');
  });

  itNonWindows('marks a canonical Skill unavailable when a shadowed global link cannot be removed', () => {
    const { home, workspace } = makeEnv();
    const globalFolder = 'global-review';
    const canonicalName = 'review';
    const globalSkill = join(home, '.myagents', 'skills', globalFolder);
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(
      join(globalSkill, 'SKILL.md'),
      `---\nname: ${canonicalName}\ndescription: Global review\n---\n`,
    );
    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    const projectSkillsDir = join(workspace, '.claude', 'skills');
    const staleGlobalLink = join(projectSkillsDir, globalFolder);
    expect(lstatSync(staleGlobalLink).isSymbolicLink()).toBe(true);

    const projectFolder = 'local-review';
    const projectSkill = join(projectSkillsDir, projectFolder);
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(
      join(projectSkill, 'SKILL.md'),
      `---\nname: ${canonicalName}\ndescription: Project review\n---\n`,
    );
    const capabilitySnapshot = resolveEffectiveProjectCapabilities(workspace);

    chmodSync(projectSkillsDir, 0o555);
    const result = (() => {
      try {
        return syncProjectUserConfigFiles(workspace, {
          cliToolRegistryEnabled: true,
          capabilitySnapshot,
        });
      } finally {
        chmodSync(projectSkillsDir, 0o755);
      }
    })();

    expect(lstatSync(staleGlobalLink).isSymbolicLink()).toBe(true);
    expect(result.unavailableSkillNames).toContain(canonicalName);
  });

  itNonWindows('replaces broken managed skill symlinks with current user skills', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');
    const projectSkillsDir = join(workspace, '.claude', 'skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    const linkPath = join(projectSkillsDir, 'review-helper');
    symlinkSync(join(home, '.myagents', 'skills', 'missing-old-skill'), linkPath, 'dir');
    expect(existsSync(linkPath)).toBe(false);

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linkPath, 'SKILL.md'), 'utf-8')).toContain('review-helper');
  });

  itNonWindows('links MyAgents user commands into the project .claude/commands directory', () => {
    const { home, workspace } = makeEnv();
    writeUserCommand(home, 'ship-it');

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    const linkPath = join(workspace, '.claude', 'commands', 'ship-it.md');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(linkPath, 'utf-8')).toBe('# ship-it\n');
  });

  it('does not make healthy Skills unavailable when the Command source cannot be scanned', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');
    const userCommandsPath = join(home, '.myagents', 'commands');
    writeFileSync(userCommandsPath, 'not a directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capabilitySnapshot = resolveEffectiveProjectCapabilities(workspace);

    const result = trySyncProjectUserConfigFiles(workspace, {
      cliToolRegistryEnabled: true,
      capabilitySnapshot,
    });

    expect(result.unavailableSkillNames).toEqual([]);
    expect(lstatSync(join(workspace, '.claude', 'skills', 'review-helper')).isSymbolicLink()).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[command-sync] Failed to reconcile project Commands: ENOTDIR'),
    );
  });

  itNonWindows('keeps already-correct managed links stable across Session births', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');
    writeUserCommand(home, 'ship-it');
    const first = syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    const skillLink = join(workspace, '.claude', 'skills', 'review-helper');
    const commandLink = join(workspace, '.claude', 'commands', 'ship-it.md');
    const before = { skill: lstatSync(skillLink).ino, command: lstatSync(commandLink).ino };

    const second = syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(lstatSync(skillLink).ino).toBe(before.skill);
    expect(lstatSync(commandLink).ino).toBe(before.command);
  });

  itNonWindows('does not project symlinked global Skill sources', () => {
    const { home, root, workspace } = makeEnv();
    const globalSkills = join(home, '.myagents', 'skills');
    const outsideSkill = join(root, 'outside-skill');
    writeUserSkill(home, 'real-skill');
    mkdirSync(outsideSkill, { recursive: true });
    writeFileSync(join(outsideSkill, 'SKILL.md'), 'outside');
    symlinkSync(join(globalSkills, 'real-skill'), join(globalSkills, 'inside-alias'), 'dir');
    symlinkSync(outsideSkill, join(globalSkills, 'outside-alias'), 'dir');

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    expect(existsSync(join(workspace, '.claude', 'skills', 'real-skill'))).toBe(true);
    expect(existsSync(join(workspace, '.claude', 'skills', 'inside-alias'))).toBe(false);
    expect(existsSync(join(workspace, '.claude', 'skills', 'outside-alias'))).toBe(false);
  });

  it('projects only global Skill candidates admitted by the effective snapshot', () => {
    const { home, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');
    const invalidFolder = 'bad\nname';
    const invalidDir = join(home, '.myagents', 'skills', invalidFolder);
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(
      join(invalidDir, 'SKILL.md'),
      '---\nname: review-helper\ndescription: Invalid source identity\n---\n',
    );
    const capabilitySnapshot = resolveEffectiveProjectCapabilities(workspace);

    syncProjectUserConfigFiles(workspace, {
      cliToolRegistryEnabled: true,
      capabilitySnapshot,
    });

    expect(existsSync(join(workspace, '.claude', 'skills', invalidFolder))).toBe(false);
    expect(lstatSync(join(workspace, '.claude', 'skills', 'review-helper')).isSymbolicLink()).toBe(true);
  });

  itNonWindows('removes only the stale managed link for a blocked optional Skill', () => {
    const { home, workspace } = makeEnv();
    const damaged = join(home, '.myagents', 'skills', 'pdf');
    mkdirSync(damaged, { recursive: true });
    writeFileSync(join(damaged, 'SKILL(1).md'), 'preserved backup');
    const projectSkills = join(workspace, '.claude', 'skills');
    mkdirSync(projectSkills, { recursive: true });
    const link = join(projectSkills, 'pdf');
    symlinkSync(damaged, link, 'dir');

    const result = syncProjectUserConfigFiles(workspace, {
      cliToolRegistryEnabled: true,
    });

    expect(result.changed).toBe(true);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(damaged, 'SKILL(1).md'), 'utf8')).toBe('preserved backup');
  });

  itNonWindows('replaces broken managed command symlinks with current user commands', () => {
    const { home, workspace } = makeEnv();
    writeUserCommand(home, 'ship-it');
    const projectCommandsDir = join(workspace, '.claude', 'commands');
    mkdirSync(projectCommandsDir, { recursive: true });
    const linkPath = join(projectCommandsDir, 'ship-it.md');
    symlinkSync(join(home, '.myagents', 'commands', 'missing-old-command.md'), linkPath);
    expect(existsSync(linkPath)).toBe(false);

    syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(linkPath, 'utf-8')).toBe('# ship-it\n');
  });

  itNonWindows('preserves foreign project symlinks without failing projection', () => {
    const { home, root, workspace } = makeEnv();
    writeUserSkill(home, 'review-helper');
    const foreignTarget = join(root, 'foreign-skill');
    mkdirSync(foreignTarget, { recursive: true });
    writeFileSync(join(foreignTarget, 'SKILL.md'), 'foreign-project-skill', 'utf8');
    const projectSkillsDir = join(workspace, '.claude', 'skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    const linkPath = join(projectSkillsDir, 'review-helper');
    symlinkSync(foreignTarget, linkPath, 'dir');

    const result = syncProjectUserConfigFiles(workspace, { cliToolRegistryEnabled: true });
    expect(readFileSync(join(linkPath, 'SKILL.md'), 'utf8')).toBe('foreign-project-skill');
    expect(result.unavailableSkillNames).toContain('review-helper');
  });

  it('reports sync failures without throwing from the tolerant wrapper', () => {
    const { home, root } = makeEnv();
    writeUserSkill(home, 'review-helper');
    const workspaceFile = join(root, 'workspace-file');
    writeFileSync(workspaceFile, 'not a directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(trySyncProjectUserConfigFiles(
      workspaceFile,
      { cliToolRegistryEnabled: true },
      'test-sync',
    )).toEqual({ changed: false, unavailableSkillNames: [] });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[test-sync] project user config sync failed; continuing without refreshed .claude config:'),
      expect.any(String),
    );
  });
});
