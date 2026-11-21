import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig, Project } from '../types';

const state = vi.hoisted(() => ({
  config: undefined as unknown as AppConfig,
  project: undefined as unknown as Project,
  failProject: false,
  concurrentAgentName: undefined as string | undefined,
  events: [] as string[],
}));

const invokeMock = vi.hoisted(() => vi.fn(async () => {
  state.events.push('live');
}));

vi.mock('./appConfigService', () => ({
  loadAppConfig: vi.fn(async () => state.config),
  atomicModifyConfig: vi.fn(async (
    modify: (config: AppConfig) => AppConfig,
    options: { notification: 'immediate' | 'deferred' } = { notification: 'immediate' },
  ) => {
    state.events.push('agent-disk');
    state.config = modify(state.config);
    if (options.notification === 'immediate') state.events.push('config-notify');
    return state.config;
  }),
  notifyConfigChanged: vi.fn(() => {
    state.events.push('config-notify');
  }),
}));

vi.mock('./projectService', () => ({
  loadProjects: vi.fn(async () => [state.project]),
  patchProject: vi.fn(async (_projectId: string, patch: Partial<Project>) => {
    state.events.push('project-disk');
    if (state.concurrentAgentName && state.config.agents?.[0]) {
      state.config = {
        ...state.config,
        agents: [{ ...state.config.agents[0], name: state.concurrentAgentName }],
      };
    }
    if (state.failProject) throw new Error('project disk full');
    state.project = { ...state.project, ...patch };
    return state.project;
  }),
}));

vi.mock('./configStore', () => ({
  withAgentConfigIntentLock: vi.fn(async <T>(fn: () => Promise<T>) => {
    state.events.push('intent:start');
    try {
      return await fn();
    } finally {
      state.events.push('intent:end');
    }
  }),
}));

vi.mock('@/utils/browserMock', () => ({
  isTauriEnvironment: () => true,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  patchAgentConfig,
  patchAgentProjectConfig,
  setProactiveAgentEnabled,
  stopAgentChannelsForLifecycle,
  startAndEnableAgentChannel,
  stopAndDisableAgentChannel,
} from './agentConfigService';

function initialConfig(): AppConfig {
  return {
    defaultPermissionMode: 'auto',
    themeId: 'myagents-default',
    appearanceMode: 'system',
    minimizeToTray: true,
    showDevTools: false,
    autoStart: false,
    osNotifications: true,
    notificationSound: true,
    agents: [{
      id: 'agent-1',
      name: 'Agent',
      enabled: true,
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
      channels: [],
    }],
  };
}

describe('Agent/Project configuration intent ownership', () => {
  beforeEach(() => {
    state.config = initialConfig();
    state.project = {
      id: 'project-1',
      name: 'Agent',
      path: '/tmp/agent',
      agentId: 'agent-1',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    };
    state.failProject = false;
    state.concurrentAgentName = undefined;
    state.events = [];
    invokeMock.mockClear();
  });

  it('keeps a newer model when a stale toolbar edits only effort', async () => {
    const { persistInputOptionChange } = await import('../../api/persistInputOption');
    const stale = { model: 'model-a', permissionMode: 'full-auto' };
    state.config.agents![0].runtimeConfig = { ...stale };
    await patchAgentConfig('agent-1', { runtimeConfigPatch: { model: 'model-b' } });
    await persistInputOptionChange({
      workspaceId: 'project-1', agentId: 'agent-1', isExternalRuntime: true, fields: { reasoningEffort: 'high' },
      patchAgentConfig, patchAgentProjectConfig, patchProject: async () => {},
    });
    expect(state.config.agents![0].runtimeConfig).toEqual({ model: 'model-b', permissionMode: 'full-auto', reasoningEffort: 'high' });
    expect(state.config.agents![0]).not.toHaveProperty('runtimeConfigPatch');
  });

  it('makes direct mirrored-field writers commit both authorities before live projection', async () => {
    await patchAgentConfig('agent-1', { model: 'claude-opus-4-6' });

    expect(state.events).toEqual([
      'intent:start',
      'agent-disk',
      'project-disk',
      'intent:end',
      'config-notify',
      'live',
    ]);
    expect(state.config.agents?.[0].model).toBe('claude-opus-4-6');
    expect(state.project.model).toBe('claude-opus-4-6');
  });

  it('preserves an old raw workspacePath while patching another Agent field', async () => {
    Object.assign(state.config.agents?.[0] ?? {}, { workspacePath: '/legacy/location' });

    await patchAgentConfig('agent-1', { model: 'claude-opus-4-6' });

    expect(state.config.agents?.[0]).toMatchObject({
      model: 'claude-opus-4-6',
      workspacePath: '/legacy/location',
    });
  });

  it('delegates proactive runtime and managed-task reconciliation to Rust', async () => {
    await patchAgentConfig('agent-1', { enabled: false });

    expect(invokeMock).toHaveBeenCalledWith('cmd_update_agent_config', {
      agentId: 'agent-1',
      patch: { enabled: false },
    });
  });

  it('derives the master toggle from disk-latest state and resets every child', async () => {
    const current = state.config.agents![0];
    state.config = {
      ...state.config,
      agents: [{
        ...current,
        enabled: false,
        heartbeat: { enabled: false, intervalMinutes: 48 },
        memoryEvolution: { enabled: false, lastMoltStatus: 'completed' },
        channels: [{ id: 'channel-1', type: 'telegram', enabled: false }],
      }],
    };

    await setProactiveAgentEnabled('agent-1', true);

    expect(state.config.agents?.[0]).toMatchObject({
      enabled: true,
      heartbeat: { enabled: true, intervalMinutes: 48 },
      memoryAutoUpdate: { enabled: true, intervalHours: 24 },
      memoryEvolution: { enabled: true, lastMoltStatus: 'completed' },
      channels: [{ id: 'channel-1', enabled: false }],
    });
    expect(invokeMock).toHaveBeenCalledWith('cmd_update_agent_config', {
      agentId: 'agent-1',
      patch: expect.objectContaining({ enabled: true }),
    });
  });

  it('reports a proactive toggle failure when runtime or managed tasks do not converge', async () => {
    invokeMock.mockRejectedValueOnce(new Error('managed task reconcile failed'));

    await expect(setProactiveAgentEnabled('agent-1', false))
      .rejects.toThrow('managed task reconcile failed');

    expect(state.config.agents?.[0]).toMatchObject({
      enabled: false,
      heartbeat: { enabled: false },
      memoryAutoUpdate: { enabled: false },
      memoryEvolution: { enabled: false },
    });
  });

  it('does not report archive Channel shutdown success when any stop fails', async () => {
    const current = state.config.agents![0];
    const agent = {
      ...current,
      channels: [
        { id: 'channel-ok', type: 'telegram' as const, enabled: true },
        { id: 'channel-fails', type: 'telegram' as const, enabled: true },
      ],
    };
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('IPC unavailable'));

    await expect(stopAgentChannelsForLifecycle(agent))
      .rejects.toThrow('channel-fails: IPC unavailable');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('commits both disk stores before releasing the intent lock and hot-reloading', async () => {
    await patchAgentProjectConfig(
      'agent-1',
      { model: 'claude-opus-4-6' },
      'project-1',
      { model: 'claude-opus-4-6' },
    );

    expect(state.events).toEqual([
      'intent:start',
      'agent-disk',
      'project-disk',
      'intent:end',
      'config-notify',
      'live',
    ]);
    expect(state.config.agents?.[0].model).toBe('claude-opus-4-6');
    expect(state.project.model).toBe('claude-opus-4-6');
  });

  it('rolls back an automatically mirrored direct write when the Project save fails', async () => {
    state.failProject = true;

    await expect(patchAgentConfig(
      'agent-1',
      { model: 'claude-opus-4-6' },
    )).rejects.toThrow('Project mirror could not be saved');

    expect(state.config.agents?.[0].model).toBe('claude-sonnet-4-6');
    expect(state.project.model).toBe('claude-sonnet-4-6');
    expect(state.events).toEqual([
      'intent:start',
      'agent-disk',
      'project-disk',
      'agent-disk',
      'intent:end',
      'config-notify',
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('rolls the Agent record back and skips live projection when the Project write fails', async () => {
    state.failProject = true;

    await expect(patchAgentProjectConfig(
      'agent-1',
      { model: 'claude-opus-4-6' },
      'project-1',
      { model: 'claude-opus-4-6' },
    )).rejects.toThrow('Project mirror could not be saved');

    expect(state.config.agents?.[0].model).toBe('claude-sonnet-4-6');
    expect(state.project.model).toBe('claude-sonnet-4-6');
    expect(state.events).toEqual([
      'intent:start',
      'agent-disk',
      'project-disk',
      'agent-disk',
      'intent:end',
      'config-notify',
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each(['permission', 'effort'])('managed %s edit preserves latest model and provider defaults', async field => {
    const { persistInputOptionChange } = await import('@/api/persistInputOption');
    state.config.agents![0] = { ...state.config.agents![0]!, providerId: 'codex-sub', runtime: 'builtin', model: 'model-b', runtimeConfig: { reasoningEffort: 'medium', envPolicy: { proxy: 'terminal' } } };
    const context = { kind: 'runtime-backed-provider' as const, providerId: 'codex-sub' as const, model: 'stale-model-a', runtime: 'codex' as const, runtimeSource: 'managed-provider' as const };
    const writeSnapshot = vi.fn();
    const result = await persistInputOptionChange({ workspaceId: 'project-1', agentId: 'agent-1', isExternalRuntime: true,
      fields: { runtimeBackedProviderContext: context, ...(field === 'permission' ? { permissionMode: 'fullAgency' } : { reasoningEffort: 'high' }) },
      patchProject: vi.fn(), patchAgentConfig, patchAgentProjectConfig, patchSnapshot: writeSnapshot,
    });
    expect(result.ok).toBe(true);
    expect(writeSnapshot).toHaveBeenCalledWith(field === 'permission' ? { permissionMode: 'no-restrictions' } : { reasoningEffort: 'high' });
    expect(state.config.agents![0]).toMatchObject({ providerId: 'codex-sub', runtime: 'builtin', model: 'model-b' });
    expect(state.config.agents![0]!.runtimeConfig).not.toHaveProperty('model');
    expect(state.config.agents![0]!.runtimeConfig).not.toHaveProperty('permissionMode');
    if (field === 'permission') expect(state.config.agents![0]!.permissionMode).toBe('fullAgency');
    else expect(state.config.agents![0]!.runtimeConfig?.reasoningEffort).toBe('high');
  });

  it('restores only committed fields and preserves an unrelated concurrent Agent update', async () => {
    state.failProject = true;
    state.concurrentAgentName = 'Renamed elsewhere';

    await expect(patchAgentProjectConfig(
      'agent-1',
      { model: 'claude-opus-4-6' },
      'project-1',
      { model: 'claude-opus-4-6' },
    )).rejects.toThrow('Project mirror could not be saved');

    expect(state.config.agents?.[0]).toMatchObject({
      name: 'Renamed elsewhere',
      model: 'claude-sonnet-4-6',
    });
  });
});

describe('Channel lifecycle intent', () => {
  it('sends one backend command and propagates failure while refreshing durable intent', async () => {
    invokeMock.mockRejectedValueOnce(new Error('connection failed'));
    await expect(startAndEnableAgentChannel('agent-1', 'channel-1')).rejects.toThrow('connection failed');
    expect(invokeMock).toHaveBeenLastCalledWith('cmd_set_agent_channel_enabled', { agentId: 'agent-1', channelId: 'channel-1', enabled: true });
    expect(state.events.at(-1)).toBe('config-notify');
    invokeMock.mockRejectedValueOnce(new Error('stop failed'));
    await expect(stopAndDisableAgentChannel('agent-1', 'channel-1')).rejects.toThrow('stop failed');
    expect(invokeMock).toHaveBeenLastCalledWith('cmd_set_agent_channel_enabled', { agentId: 'agent-1', channelId: 'channel-1', enabled: false });
  });
});
