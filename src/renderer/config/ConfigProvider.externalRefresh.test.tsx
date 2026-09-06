import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigProvider } from './ConfigProvider';
import { DEFAULT_CONFIG, type AppConfig, type Project, type Provider } from './types';
import { useConfigData } from './useConfigData';
import { useConfigActions } from './useConfigActions';
import { rebuildAndPersistAvailableProviders } from './services/providerService';

const mocks = vi.hoisted(() => ({
  config: {} as AppConfig,
  projects: [] as Project[],
  providers: [] as Provider[],
  listeners: new Map<string, () => void>(),
  loadAppConfig: vi.fn(),
  loadProjects: vi.fn(),
  getAllProviders: vi.fn(),
  atomicModifyCustomProvider: vi.fn(),
  reconcileIdentities: vi.fn(),
  ensureBundledWorkspace: vi.fn(),
  withAgentConfigIntentLock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(async (event: string, handler: () => void) => {
    mocks.listeners.set(event, handler);
  }),
}));
vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(async () => ({ models: [] })) }));
vi.mock('./services/configStore', () => ({
  isLockBusyError: (error: unknown) => (
    !!error && typeof error === 'object' && 'code' in error && String(error.code).endsWith('BUSY')
  ),
  withAgentConfigIntentLock: mocks.withAgentConfigIntentLock,
  withProjectsLock: vi.fn(async (run: () => Promise<unknown>) => run()),
}));

vi.mock('./services/appConfigService', () => ({
  loadAppConfig: mocks.loadAppConfig,
  atomicModifyConfig: vi.fn(async (modify: (config: AppConfig) => AppConfig) => {
    mocks.config = modify(mocks.config);
    return mocks.config;
  }),
  ensureBundledWorkspace: mocks.ensureBundledWorkspace,
  ensureManagedCodexProviderDevGateDefault: vi.fn(async () => {}),
  mergePresetCustomModels: vi.fn((providers: Provider[]) => providers),
}));

vi.mock('./services/providerService', () => ({
  getAllProviders: mocks.getAllProviders,
  loadApiKeys: vi.fn(async () => ({})),
  saveApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  loadProviderVerifyStatus: vi.fn(async () => ({})),
  saveProviderVerifyStatus: vi.fn(),
  saveCustomProvider: vi.fn(),
  atomicModifyCustomProvider: mocks.atomicModifyCustomProvider,
  deleteCustomProvider: vi.fn(),
  rebuildAndPersistAvailableProviders: vi.fn(async () => {}),
}));

vi.mock('./services/projectService', () => ({
  loadProjects: mocks.loadProjects,
  saveProjects: vi.fn(async () => {}),
  addProject: vi.fn(),
  updateProject: vi.fn(),
  patchProject: vi.fn(),
  removeOrHideProject: vi.fn(),
  touchProject: vi.fn(),
}));

vi.mock('./services/agentConfigService', () => ({
  configureMemoryAutoUpdateTaskForAgent: vi.fn(),
  configureMemoryEvolutionTasksForAgent: vi.fn(),
  migrateImBotConfigsToAgents: vi.fn((config: AppConfig) => config),
  persistAgents: vi.fn(async () => {}),
  reconcilePersistedAgentWorkspaceIdentities: mocks.reconcileIdentities,
  reconcilePersistedAgentWorkspaceIdentitiesLocked: vi.fn(),
}));

function provider(id: string): Provider {
  return {
    id,
    name: id,
    vendor: id,
    cloudProvider: '',
    type: 'api',
    primaryModel: `${id}-model`,
    isBuiltin: false,
    config: { baseUrl: 'https://provider.example' },
    authType: 'api_key',
    models: [{ model: `${id}-model`, modelName: `${id} model`, modelSeries: id }],
  };
}

function project(id: string, name: string, path: string): Project {
  return { id, name, path, providerId: null, permissionMode: null };
}

function Probe() {
  const { config, projects, providers, apiKeys, providerVerifyStatus, error } = useConfigData();
  const { updateConfig, updateCustomProvider } = useConfigActions();
  return (
    <>
      <output data-testid="snapshot">
        {JSON.stringify({
          defaultProviderId: config.defaultProviderId,
          projects: projects.map(project => project.id),
          providers: providers.map(item => item.id),
          apiKeys: Object.keys(apiKeys),
          verified: Object.keys(providerVerifyStatus),
          error,
        })}
      </output>
      <button type="button" onClick={() => void updateConfig({ defaultProviderId: 'local-provider' })}>
        Save local config
      </button>
      <button
        type="button"
        onClick={() => providers[0] && void updateCustomProvider(
          providers[0],
          [{ id: providers[0].primaryModel, contextLength: 1_048_576 }],
        )}
      >
        Merge discovered capability
      </button>
    </>
  );
}

describe('ConfigProvider external config invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.config = {
      ...DEFAULT_CONFIG,
      agents: [],
      defaultProviderId: 'old-provider',
      providerApiKeys: { 'old-provider': 'old-key' },
      providerVerifyStatus: {
        'old-provider': { status: 'valid', verifiedAt: '2026-07-23T00:00:00.000Z' },
      },
    };
    mocks.projects = [project('old-project', 'Old', '/old')];
    mocks.providers = [provider('old-provider')];
    mocks.loadAppConfig.mockImplementation(async () => mocks.config);
    mocks.loadProjects.mockImplementation(async () => mocks.projects);
    mocks.getAllProviders.mockImplementation(async () => mocks.providers);
    mocks.atomicModifyCustomProvider.mockImplementation(async (
      providerId: string,
      modify: (current: Provider) => Provider,
    ) => {
      const current = mocks.providers.find(item => item.id === providerId);
      if (!current) return null;
      const next = modify(current);
      mocks.providers = mocks.providers.map(item => item.id === providerId ? next : item);
      return next;
    });
    mocks.ensureBundledWorkspace.mockResolvedValue(false);
    mocks.withAgentConfigIntentLock.mockImplementation(async (run: () => Promise<unknown>) => run());
    mocks.reconcileIdentities.mockResolvedValue({
      config: mocks.config,
      projects: mocks.projects,
      changed: false,
      createdAgents: [],
      agentProjections: [],
      diagnostics: [],
    });
  });

  it('keeps the readable disk snapshot visible when identity materialization is deferred', async () => {
    mocks.reconcileIdentities.mockRejectedValueOnce(new Error('config write interrupted'));

    render(<ConfigProvider><Probe /></ConfigProvider>);

    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('old-project'));
    expect(screen.getByTestId('snapshot')).toHaveTextContent('old-provider');
  });

  it('projects a native Token Dance login with no Settings or auth panel mounted', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>);
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('old-provider'));
    vi.mocked(rebuildAndPersistAvailableProviders).mockClear();
    mocks.config = { ...mocks.config, providerApiKeys: { ...mocks.config.providerApiKeys, tokendance: 'test-key' } };
    const callback = mocks.listeners.get('tokendance:auth-changed') as unknown as (event: { payload: { phase: string } }) => void;
    act(() => callback({ payload: { phase: 'connected' } }));
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('tokendance'));
    expect(rebuildAndPersistAvailableProviders).toHaveBeenCalledTimes(1);
  });

  it('merges late discovery into the lock-current Provider without replacing a newer explicit value', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>);
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('old-provider'));

    const current = mocks.providers[0]!;
    mocks.providers = [{
      ...current,
      models: current.models.map(model => ({ ...model, contextLength: 262_144 })),
    }];
    fireEvent.click(screen.getByRole('button', { name: 'Merge discovered capability' }));

    await waitFor(() => expect(mocks.atomicModifyCustomProvider).toHaveBeenCalledTimes(1));
    expect(mocks.providers[0]?.models[0]?.contextLength).toBe(262_144);
  });

  it('keeps the readable disk snapshot available when startup maintenance is lock-busy', async () => {
    mocks.withAgentConfigIntentLock.mockRejectedValueOnce(Object.assign(
      new Error('Agent config intent busy; retry'),
      { code: 'AGENT_CONFIG_INTENT_BUSY' },
    ));

    render(<ConfigProvider><Probe /></ConfigProvider>);

    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('old-project'));
    expect(screen.getByTestId('snapshot')).toHaveTextContent('old-provider');
    expect(JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}')).toMatchObject({ error: null });
  });

  it('runs at most one deferred maintenance retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const busy = Object.assign(new Error('Projects busy; retry'), { code: 'PROJECTS_BUSY' });
    mocks.ensureBundledWorkspace.mockRejectedValue(busy);

    try {
      render(<ConfigProvider><Probe /></ConfigProvider>);
      await waitFor(() => expect(mocks.ensureBundledWorkspace).toHaveBeenCalledTimes(1));

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      await waitFor(() => expect(mocks.ensureBundledWorkspace).toHaveBeenCalledTimes(2));

      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(mocks.ensureBundledWorkspace).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a deferred maintenance retry on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const busy = Object.assign(new Error('Projects busy; retry'), { code: 'PROJECTS_BUSY' });
    mocks.ensureBundledWorkspace.mockRejectedValue(busy);

    try {
      const view = render(<ConfigProvider><Probe /></ConfigProvider>);
      await waitFor(() => expect(mocks.ensureBundledWorkspace).toHaveBeenCalledTimes(1));
      view.unmount();

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(mocks.ensureBundledWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a true initial snapshot read failure', async () => {
    mocks.loadAppConfig.mockRejectedValueOnce(new Error('config disk unavailable'));

    render(<ConfigProvider><Probe /></ConfigProvider>);

    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('config disk unavailable'));
  });

  it('keeps the current snapshot visible when external reconciliation is lock-busy', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>);

    await waitFor(() => expect(mocks.listeners.has('app:config-changed')).toBe(true));
    await waitFor(() => expect(mocks.reconcileIdentities).toHaveBeenCalledTimes(1));
    mocks.reconcileIdentities.mockRejectedValueOnce(Object.assign(
      new Error('Projects busy; retry'),
      { code: 'PROJECTS_BUSY' },
    ));

    await act(async () => {
      mocks.listeners.get('app:config-changed')?.();
    });

    await waitFor(() => expect(mocks.reconcileIdentities).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('snapshot')).toHaveTextContent('old-project');
    expect(JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}')).toMatchObject({ error: null });
  });

  it('reloads config, projects, providers, keys, and verify state from one app event', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>);

    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('old-provider'));
    await waitFor(() => expect(mocks.listeners.has('app:config-changed')).toBe(true));

    mocks.config = {
      ...DEFAULT_CONFIG,
      agents: [],
      defaultProviderId: 'new-provider',
      providerApiKeys: { 'new-provider': 'new-key' },
      providerVerifyStatus: {
        'new-provider': { status: 'valid', verifiedAt: '2026-07-23T01:00:00.000Z' },
      },
    };
    mocks.projects = [project('new-project', 'New', '/new')];
    mocks.providers = [provider('new-provider')];

    await act(async () => {
      mocks.listeners.get('app:config-changed')?.();
    });

    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('new-project'));
    const snapshot = JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}') as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      defaultProviderId: 'new-provider',
      projects: ['new-project'],
      apiKeys: ['new-provider'],
      verified: ['new-provider'],
    });
    expect(snapshot.providers).toEqual(expect.arrayContaining(['new-provider']));
    expect(mocks.getAllProviders).toHaveBeenLastCalledWith(mocks.config);
  });

  it('does not let an older overlapping disk read overwrite a newer event', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>);
    await waitFor(() => expect(mocks.listeners.has('app:config-changed')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('old-project'));

    const slowConfig: AppConfig = {
      ...DEFAULT_CONFIG,
      agents: [],
      defaultProviderId: 'slow-provider',
      providerApiKeys: { 'slow-provider': 'slow-key' },
    };
    let resolveSlow: ((config: AppConfig) => void) | undefined;
    const slowRead = new Promise<AppConfig>(resolve => { resolveSlow = resolve; });
    const loadCountBefore = mocks.loadAppConfig.mock.calls.length;
    mocks.loadAppConfig.mockImplementationOnce(async () => slowRead);

    act(() => { mocks.listeners.get('app:config-changed')?.(); });
    await waitFor(() => expect(mocks.loadAppConfig.mock.calls.length).toBe(loadCountBefore + 1));

    mocks.config = {
      ...DEFAULT_CONFIG,
      agents: [],
      defaultProviderId: 'latest-provider',
      providerApiKeys: { 'latest-provider': 'latest-key' },
    };
    mocks.projects = [project('latest-project', 'Latest', '/latest')];
    mocks.providers = [provider('latest-provider')];
    await act(async () => { mocks.listeners.get('app:config-changed')?.(); });
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('latest-project'));

    await act(async () => { resolveSlow?.(slowConfig); });
    expect(screen.getByTestId('snapshot')).toHaveTextContent('latest-provider');
    expect(screen.getByTestId('snapshot')).not.toHaveTextContent('slow-provider');
  });

  it('does not let an older external read overwrite a newer local disk commit', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>);
    await waitFor(() => expect(mocks.listeners.has('app:config-changed')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('old-project'));

    const staleConfig: AppConfig = {
      ...DEFAULT_CONFIG,
      agents: [],
      defaultProviderId: 'stale-external-provider',
    };
    let resolveStale: ((config: AppConfig) => void) | undefined;
    const staleRead = new Promise<AppConfig>(resolve => { resolveStale = resolve; });
    const loadCountBefore = mocks.loadAppConfig.mock.calls.length;
    mocks.loadAppConfig.mockImplementationOnce(async () => staleRead);

    act(() => { mocks.listeners.get('app:config-changed')?.(); });
    await waitFor(() => expect(mocks.loadAppConfig.mock.calls.length).toBe(loadCountBefore + 1));

    fireEvent.click(screen.getByRole('button', { name: 'Save local config' }));
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('local-provider'));

    await act(async () => { resolveStale?.(staleConfig); });
    expect(screen.getByTestId('snapshot')).toHaveTextContent('local-provider');
    expect(screen.getByTestId('snapshot')).not.toHaveTextContent('stale-external-provider');
  });
});
