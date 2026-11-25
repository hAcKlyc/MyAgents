import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAppConfig, ProjectSlim } from './admin-config';

const state = vi.hoisted(() => ({
  config: { defaultPermissionMode: 'auto', agents: [] } as AdminAppConfig,
  projects: [] as ProjectSlim[],
  writes: [] as string[],
  failProjectOnce: false,
  failConfigOnce: false,
  lockTail: Promise.resolve() as Promise<void>,
}));

vi.mock('../sse', () => ({ broadcast: vi.fn() }));
vi.mock('./management-api-client', () => ({ managementApi: vi.fn(async () => ({ ok: true })) }));
import { managementApi } from './management-api-client';
vi.mock('./admin-config', async importOriginal => {
  const actual = await importOriginal<typeof import('./admin-config')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => state.config),
    loadProjects: vi.fn(() => state.projects),
    withAgentConfigIntentLock: vi.fn(async (run: () => Promise<unknown>) => {
      let release!: () => void;
      const prior = state.lockTail;
      state.lockTail = new Promise<void>(resolve => { release = resolve; });
      await prior;
      try {
        return await run();
      } finally {
        release();
      }
    }),
    atomicModifyProjects: vi.fn(async (modify: (projects: ProjectSlim[]) => ProjectSlim[] | Promise<ProjectSlim[]>) => {
      state.writes.push('projects');
      if (state.failProjectOnce) {
        state.failProjectOnce = false;
        throw new Error('projects write interrupted');
      }
      state.projects = await modify(state.projects);
      return state.projects;
    }),
    atomicModifyConfig: vi.fn(async (modify: (config: AdminAppConfig) => AdminAppConfig) => {
      state.writes.push('config');
      if (state.failConfigOnce) {
        state.failConfigOnce = false;
        throw new Error('config write interrupted');
      }
      state.config = modify(state.config);
      return state.config;
    }),
  };
});

import {
  createEmptyManagedWorkspaceDir,
  getManagedProjectsRoot,
  registerWorkspaceAgent,
  resolveManagedWorkspaceCreationPath,
  resolvePersistedAgentWorkspaceRegistry,
  resolvePersistedAgentWorkspaceConflict,
  sanitizeManagedWorkspaceDirName,
  stripWindowsVerbatimPrefix,
} from './agent-workspace-identity';

function project(overrides: Partial<ProjectSlim> = {}): ProjectSlim {
  return {
    id: 'project-1',
    name: 'Workspace',
    path: '/repo/current',
    ...overrides,
  };
}

describe('persisted Agent workspace identity', () => {
  let tempWorkspace: string | null = null;

  beforeEach(() => {
    state.config = { defaultPermissionMode: 'auto', agents: [] };
    state.projects = [project()];
    state.writes = [];
    state.failProjectOnce = false;
    state.failConfigOnce = false;
    state.lockTail = Promise.resolve();
  });

  afterEach(() => {
    if (tempWorkspace) rmSync(tempWorkspace, { recursive: true, force: true });
    tempWorkspace = null;
  });

  function workspace(): string {
    tempWorkspace ??= mkdtempSync(
      join(process.cwd(), '.myagents-agent-register-'),
    );
    return tempWorkspace;
  }

  function conflict() {
    state.projects = [project({ agentId: 'shared' }), project({ id: 'split', path: '/other', agentId: 'shared', hidden: true }),
      project({ id: 'unrelated', path: '/unrelated' })];
    state.config.agents = [{ id: 'shared', name: 'Original', enabled: false, channels: [{ id: 'channel', type: 'telegram', enabled: false, botToken: 'preserve' }] }];
    return { agentId: 'shared', keepProjectId: 'project-1', expectedClaims: state.projects.slice(0, 2).map(({ id, path }) => ({ id, path })) };
  }

  it('stops while claims are still ambiguous and commits only the chosen group using latest config', async () => {
    const choice = conflict();
    const stop = vi.fn(async () => {
      expect(state.projects.filter(p => p.agentId === 'shared')).toHaveLength(2);
      state.config.agents![0].name = 'Latest';
    });
    await resolvePersistedAgentWorkspaceConflict(choice, stop);
    expect(stop).toHaveBeenCalledOnce();
    expect(state.writes).toEqual(['projects', 'config']);
    expect(managementApi).toHaveBeenCalledWith('/api/app/config-changed', 'POST', {}, { timeoutMs: 2_000 });
    expect(state.projects[0].agentId).toBe('shared');
    expect(state.projects[1]).toMatchObject({ hidden: true });
    expect(state.projects[1].agentId).not.toBe('shared');
    expect(state.projects[2].agentId).toBeUndefined();
    expect(state.config.agents![0]).toMatchObject({ name: 'Latest', channels: [{ id: 'channel', botToken: 'preserve' }] });
  });

  it('does not change claims when stopping fails or the choice is stale', async () => {
    const choice = conflict();
    await expect(resolvePersistedAgentWorkspaceConflict(choice, async () => { throw new Error('cannot stop'); })).rejects.toThrow('cannot stop');
    expect(state.projects.filter(p => p.agentId === 'shared')).toHaveLength(2);
    const stop = vi.fn();
    state.projects[1].path = '/changed';
    await expect(resolvePersistedAgentWorkspaceConflict(choice, stop)).rejects.toThrow('Refresh');
    expect(stop).not.toHaveBeenCalled();
  });

  it('reports incomplete materialization, then normal reconciliation reuses the saved independent ID', async () => {
    const choice = conflict();
    state.projects[1].templateId = 'mino';
    state.projects[1].templateSource = 'builtin';
    state.failConfigOnce = true;
    await expect(resolvePersistedAgentWorkspaceConflict(choice, async () => {})).rejects.toMatchObject({ code: 'AGENT_MATERIALIZATION_DEFERRED' });
    const independentId = state.projects[1].agentId;
    expect(independentId).not.toBe('shared');
    expect(state.config.agents).toHaveLength(1);
    await resolvePersistedAgentWorkspaceRegistry();
    expect(state.config.agents!.filter(a => a.id === independentId)).toHaveLength(1);
    expect(state.projects[1].agentId).toBe(independentId);
    expect(state.config.agents!.find(a => a.id === independentId)?.channels).toEqual([]);
    expect(state.config.agents!.find(a => a.id === independentId)?.heartbeat?.enabled).toBe(true);
  });

  it('does not write Agent config when the Project write fails', async () => {
    const choice = conflict();
    const before = structuredClone({ config: state.config, projects: state.projects });
    state.failProjectOnce = true;
    await expect(resolvePersistedAgentWorkspaceConflict(choice, vi.fn())).rejects.toThrow('projects write interrupted');
    expect({ config: state.config, projects: state.projects }).toEqual(before);
    expect(state.writes).toEqual(['projects']);
  });

  it('commits Project.agentId before creating the pathless Agent record', async () => {
    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(state.writes).toEqual(['projects', 'config']);
    expect(result.projects[0].agentId).toBeTruthy();
    expect(result.config.agents).toEqual([
      expect.objectContaining({ id: result.projects[0].agentId, name: 'Workspace' }),
    ]);
    expect(result.config.agents?.[0]).not.toHaveProperty('workspacePath');
    expect(result.agentProjections[0]).toMatchObject({
      agentId: result.projects[0].agentId,
      workspacePath: '/repo/current',
      association: 'project-linked',
    });
  });

  it('rebuilds a stale Project link with the same id after an interrupted Agent write', async () => {
    state.projects = [project({ agentId: 'stale-agent-id' })];

    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(result.config.agents?.map(agent => agent.id)).toEqual(['stale-agent-id']);
    expect(result.projects[0].agentId).toBe('stale-agent-id');
  });

  it('recovers a Project-first birth after the Agent write is interrupted', async () => {
    state.failConfigOnce = true;

    const interrupted = await resolvePersistedAgentWorkspaceRegistry();
    const persistedAgentId = state.projects[0].agentId;
    expect(persistedAgentId).toBeTruthy();
    expect(state.config.agents).toEqual([]);
    expect(interrupted.repairDeferred).toBe(true);
    expect(interrupted.agentProjections).toEqual([]);

    const retried = await resolvePersistedAgentWorkspaceRegistry();
    expect(retried.projects[0].agentId).toBe(persistedAgentId);
    expect(retried.config.agents?.map(agent => agent.id)).toEqual([persistedAgentId]);
  });

  it('keeps a deterministic legacy match usable when Project repair persistence is deferred', async () => {
    state.projects = [project()];
    state.config = {
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'legacy-agent',
        name: 'Legacy',
        enabled: true,
        workspacePath: '/repo/current',
      } as unknown as NonNullable<AdminAppConfig['agents']>[number]],
    };
    state.failProjectOnce = true;

    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(result.repairDeferred).toBe(true);
    expect(result.projects[0].agentId).toBe('legacy-agent');
    expect(result.agentProjections).toContainEqual(expect.objectContaining({
      agentId: 'legacy-agent',
      workspacePath: '/repo/current',
    }));
    expect(state.projects[0].agentId).toBeUndefined();
  });

  it('does not create an Agent when the Project link write is interrupted', async () => {
    state.failProjectOnce = true;

    await expect(resolvePersistedAgentWorkspaceRegistry())
      .rejects.toThrow('projects write interrupted');
    expect(state.projects[0].agentId).toBeUndefined();
    expect(state.config.agents).toEqual([]);
  });

  it('serializes concurrent births to one Project link and one Agent id', async () => {
    const [first, second] = await Promise.all([
      resolvePersistedAgentWorkspaceRegistry(),
      resolvePersistedAgentWorkspaceRegistry(),
    ]);

    const persistedAgentId = state.projects[0].agentId;
    expect(persistedAgentId).toBeTruthy();
    expect(state.config.agents?.map(agent => agent.id)).toEqual([persistedAgentId]);
    expect(first.projects[0].agentId).toBe(persistedAgentId);
    expect(second.projects[0].agentId).toBe(persistedAgentId);
  });

  it('keeps an exact id link authoritative when its historical path disagrees', async () => {
    state.projects = [project({ agentId: 'selected' })];
    state.config = {
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'selected',
        name: 'Selected',
        enabled: true,
        workspacePath: '/repo/old',
      } as unknown as NonNullable<AdminAppConfig['agents']>[number]],
    };

    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(result.agentProjections[0]).toMatchObject({
      agentId: 'selected',
      workspacePath: '/repo/current',
    });
    expect(result.createdAgentIds).toEqual([]);
  });

  it('registers an existing absolute directory Project-first and is idempotent', async () => {
    state.projects = [];

    const first = await registerWorkspaceAgent(workspace());
    const lastOpened = state.projects[0].lastOpened;
    const second = await registerWorkspaceAgent(workspace());

    expect(first).toMatchObject({
      created: true,
      workspacePath: workspace(),
      archived: false,
    });
    expect(second).toMatchObject({
      created: false,
      projectId: first.projectId,
      agentId: first.agentId,
      workspacePath: workspace(),
    });
    expect(state.projects).toHaveLength(1);
    expect(state.config.agents).toHaveLength(1);
    expect(state.projects[0].lastOpened).toBe(lastOpened);
  });

  it('serializes concurrent registration to one Project and Agent identity', async () => {
    state.projects = [];

    const [first, second] = await Promise.all([
      registerWorkspaceAgent(workspace()),
      registerWorkspaceAgent(workspace()),
    ]);

    expect(first.agentId).toBe(second.agentId);
    expect(first.projectId).toBe(second.projectId);
    expect(state.projects).toHaveLength(1);
    expect(state.config.agents?.map((agent) => agent.id)).toEqual([
      first.agentId,
    ]);
  });

  it('reuses the committed Project identity after an interrupted Agent materialization', async () => {
    state.projects = [];
    state.failConfigOnce = true;

    await expect(registerWorkspaceAgent(workspace())).rejects.toMatchObject({
      code: 'AGENT_MATERIALIZATION_DEFERRED',
    });
    const committedAgentId = state.projects[0].agentId;
    const retried = await registerWorkspaceAgent(workspace());

    expect(retried.agentId).toBe(committedAgentId);
    expect(state.projects).toHaveLength(1);
    expect(state.config.agents?.map((agent) => agent.id)).toEqual([
      committedAgentId,
    ]);
  });

  it('reuses a legacy path-backed Agent id when creating its Project selector', async () => {
    const workspacePath = workspace();
    state.projects = [];
    state.config = {
      defaultPermissionMode: 'auto',
      agents: [
        {
          id: 'legacy-agent',
          name: 'Legacy',
          enabled: false,
          workspacePath,
        } as unknown as NonNullable<AdminAppConfig['agents']>[number],
      ],
    };

    const result = await registerWorkspaceAgent(workspacePath);

    expect(result.agentId).toBe('legacy-agent');
    expect(state.projects).toEqual([
      expect.objectContaining({ agentId: 'legacy-agent', path: workspacePath }),
    ]);
    expect(state.config.agents).toHaveLength(1);
  });

  it('fails closed for invalid, non-directory, and archived workspaces', async () => {
    await expect(registerWorkspaceAgent('relative/path')).rejects.toMatchObject(
      {
        code: 'WORKSPACE_PATH_NOT_ABSOLUTE',
      },
    );
    const file = join(workspace(), 'file.txt');
    writeFileSync(file, 'not a directory');
    await expect(registerWorkspaceAgent(file)).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_NOT_DIRECTORY',
    });
    await expect(registerWorkspaceAgent('/etc')).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_UNSAFE',
    });

    state.projects = [
      project({ path: workspace(), archivedAt: '2026-09-19T00:00:00.000Z' }),
    ];
    await expect(registerWorkspaceAgent(workspace())).rejects.toMatchObject({
      code: 'WORKSPACE_ARCHIVED',
    });
  });

  describe('managed workspace creation under ~/.myagents/projects/', () => {
    const originalHome = process.env.HOME;
    let fakeHome: string | null = null;

    beforeEach(() => {
      // Use a temp dir under process.cwd() rather than os.tmpdir() because
      // macOS tmpdir lives under /var (/private/var), which path-safety blocks.
      fakeHome = mkdtempSync(join(process.cwd(), '.myagents-managed-home-'));
      process.env.HOME = fakeHome;
      state.projects = [];
    });

    afterEach(() => {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
      fakeHome = null;
    });

    it('sanitizes valid display names and rejects path traversal, empty, or Windows reserved device names', () => {
      expect(sanitizeManagedWorkspaceDirName('Code Reviewer')).toBe('Code-Reviewer');
      expect(sanitizeManagedWorkspaceDirName('设计评审助手')).toBe('设计评审助手');
      for (const bad of [
        '', '   ', '..', '.', '../evil', 'a/b', 'a\\b', 'foo\0bar', '!!!',
        'CON', 'prn', 'aux', 'NUL', 'COM1', 'lpt9', 'con.txt',
      ]) {
        expect(() => sanitizeManagedWorkspaceDirName(bad), `expected reject for '${bad}'`).toThrow();
      }
      expect(stripWindowsVerbatimPrefix('\\\\?\\C:\\Users\\demo\\.myagents\\projects\\foo')).toBe(
        'C:\\Users\\demo\\.myagents\\projects\\foo',
      );
      expect(stripWindowsVerbatimPrefix('//?/C:/Users/demo/.myagents')).toBe(
        'C:/Users/demo/.myagents',
      );
      expect(stripWindowsVerbatimPrefix('\\\\?\\UNC\\server\\share\\ws')).toBe(
        '\\\\server\\share\\ws',
      );
    });

    it('allows direct children of ~/.myagents/projects/ while still blocking ~/.myagents internals, nested paths, and symlink escapes', async () => {
      const myagentsDir = join(fakeHome!, '.myagents');
      const credsDir = join(myagentsDir, 'credentials');
      const projectsRoot = getManagedProjectsRoot();
      const nestedDir = join(projectsRoot, 'parent', 'nested');
      mkdirSync(credsDir, { recursive: true });
      mkdirSync(nestedDir, { recursive: true });

      const evilSymlink = join(projectsRoot, 'evil-link');
      symlinkSync(credsDir, evilSymlink);

      await expect(registerWorkspaceAgent(myagentsDir)).rejects.toMatchObject({ code: 'WORKSPACE_PATH_UNSAFE' });
      await expect(registerWorkspaceAgent(credsDir)).rejects.toMatchObject({ code: 'WORKSPACE_PATH_UNSAFE' });
      await expect(registerWorkspaceAgent(projectsRoot)).rejects.toMatchObject({ code: 'WORKSPACE_PATH_UNSAFE' });
      await expect(registerWorkspaceAgent(nestedDir)).rejects.toMatchObject({ code: 'WORKSPACE_PATH_UNSAFE' });
      await expect(registerWorkspaceAgent(evilSymlink)).rejects.toMatchObject({ code: 'WORKSPACE_PATH_UNSAFE' });
      expect(() => resolveManagedWorkspaceCreationPath('evil-link')).toThrow(/already exists/i);

      const direct = resolveManagedWorkspaceCreationPath('QA Helper');
      const created = await registerWorkspaceAgent(direct.workspacePath, {
        name: 'QA Helper',
        templateId: 'mino',
        templateSource: 'builtin',
        createManagedDirectory: () => createEmptyManagedWorkspaceDir(direct.projectsRoot, direct.workspacePath),
      });
      expect(created.created).toBe(true);
      expect(created.enabled).toBe(false);
      expect(created.workspacePath).toBe(realpathSync(direct.workspacePath));
      // CLI-created mino Agents MUST NOT inherit template proactive tasks (Heartbeat/Memory).
      const savedAgent = state.config.agents?.[0];
      expect(savedAgent).toMatchObject({
        id: created.agentId,
        name: 'QA Helper',
        enabled: false,
      });
      expect(savedAgent?.heartbeat).toBeUndefined();
      expect(savedAgent?.memoryAutoUpdate).toBeUndefined();
      expect(savedAgent?.memoryEvolution).toBeUndefined();
      // Re-resolving same name must fail closed with WORKSPACE_ALREADY_EXISTS.
      expect(() => resolveManagedWorkspaceCreationPath('QA Helper')).toThrow(/already exists/i);
    });

    it('rolls back managed dir before projects.json commit, but preserves it if atomicModifyConfig defers after Project commit', async () => {
      const target1 = resolveManagedWorkspaceCreationPath('Rollback Patch');
      await expect(
        registerWorkspaceAgent(target1.workspacePath, {
          name: 'Rollback Patch',
          createManagedDirectory: () => createEmptyManagedWorkspaceDir(target1.projectsRoot, target1.workspacePath),
          applyInitialAgentPatch: () => ({ ok: false, code: 'INVALID_CONFIG', message: 'bad initial config' }),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(existsSync(target1.workspacePath)).toBe(false);

      const target2 = resolveManagedWorkspaceCreationPath('Rollback Project');
      state.failProjectOnce = true;
      await expect(
        registerWorkspaceAgent(target2.workspacePath, {
          name: 'Rollback Project',
          createManagedDirectory: () => createEmptyManagedWorkspaceDir(target2.projectsRoot, target2.workspacePath),
        }),
      ).rejects.toThrow('projects write interrupted');
      expect(existsSync(target2.workspacePath)).toBe(false);

      // If projects.json commits and config.json fails (AGENT_MATERIALIZATION_DEFERRED),
      // the directory MUST stay on disk so retrying reuses the saved Project claim cleanly.
      const target3 = resolveManagedWorkspaceCreationPath('Deferred Config');
      state.failConfigOnce = true;
      await expect(
        registerWorkspaceAgent(target3.workspacePath, {
          name: 'Deferred Config',
          createManagedDirectory: () => createEmptyManagedWorkspaceDir(target3.projectsRoot, target3.workspacePath),
        }),
      ).rejects.toMatchObject({ code: 'AGENT_MATERIALIZATION_DEFERRED' });
      expect(existsSync(target3.workspacePath)).toBe(true);
      const committedAgentId = state.projects[0]?.agentId;
      expect(committedAgentId).toBeTruthy();

      const retried = await registerWorkspaceAgent(target3.workspacePath);
      expect(retried.agentId).toBe(committedAgentId);
      expect(retried.enabled).toBe(false);
    });

    it('fails closed with WORKSPACE_ALREADY_REGISTERED when rejectIfAlreadyRegistered is true (project-linked and legacy)', async () => {
      const ws = workspace();
      await registerWorkspaceAgent(ws);
      await expect(
        registerWorkspaceAgent(ws, { name: 'New Name', rejectIfAlreadyRegistered: true }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_ALREADY_REGISTERED' });

      state.projects = [];
      state.config = {
        defaultPermissionMode: 'auto',
        agents: [{
          id: 'legacy-existing',
          name: 'Legacy',
          enabled: true,
          workspacePath: ws,
        } as unknown as NonNullable<AdminAppConfig['agents']>[number]],
      };
      await expect(
        registerWorkspaceAgent(ws, { name: 'Overwrite Legacy', rejectIfAlreadyRegistered: true }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_ALREADY_REGISTERED' });
    });
  });
});
