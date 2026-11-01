import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, PROXY_DEFAULTS, PRESET_PROVIDERS, MANAGED_CODEX_REQUIRED_RUNTIME, type AppConfig } from './types';
import { ConfigProvider } from './ConfigProvider';
import { useConfigActions } from './useConfigActions';
import { useConfigData } from './useConfigData';
import type { atomicModifyConfig } from './services/appConfigService';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    apiGetJson: vi.fn(),
    atomicModifyConfig: vi.fn<typeof atomicModifyConfig>(),
    platform: 'darwin-aarch64',
    loadAppConfig: vi.fn(),
    loadProjects: vi.fn(),
    statusPromise: undefined as Promise<void> | undefined,
    resolveStatus: undefined as (() => void) | undefined,
    downloadPromise: undefined as Promise<never> | undefined,
    rejectDownload: undefined as ((error: Error) => void) | undefined,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/identity/deviceIdentity', () => ({ getPlatform: () => mocks.platform }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async () => {}) }));
vi.mock('@/api/apiFetch', () => ({ apiGetJson: mocks.apiGetJson }));
vi.mock('./services/configStore', () => ({
    isLockBusyError: (error: unknown) => (
        !!error && typeof error === 'object' && 'code' in error && String(error.code).endsWith('BUSY')
    ),
    withAgentConfigIntentLock: vi.fn(async <T,>(run: () => Promise<T>) => run()),
    withProjectsLock: vi.fn(async <T,>(run: () => Promise<T>) => run()),
}));

vi.mock('./services/appConfigService', () => ({
    loadAppConfig: mocks.loadAppConfig,
    atomicModifyConfig: mocks.atomicModifyConfig,
    ensureBundledWorkspace: vi.fn(async () => {}),
    ensureManagedCodexProviderDevGateDefault: vi.fn(async () => {}),
    mergePresetCustomModels: vi.fn((providers: unknown[]) => providers),
}));

vi.mock('./services/providerService', () => ({
    getAllProviders: vi.fn(async () => PRESET_PROVIDERS),
    loadApiKeys: vi.fn(async () => ({})),
    saveApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    loadProviderVerifyStatus: vi.fn(async () => ({})),
    saveProviderVerifyStatus: vi.fn(),
    saveCustomProvider: vi.fn(),
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
    migrateImBotConfigsToAgents: vi.fn((config: object) => config),
    persistAgents: vi.fn(async () => {}),
    reconcilePersistedAgentWorkspaceIdentities: vi.fn(async () => ({
        config: {}, projects: [], changed: false, createdAgents: [],
    })),
    reconcilePersistedAgentWorkspaceIdentitiesLocked: vi.fn(),
}));

describe('ConfigProvider Managed Codex startup update lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.apiGetJson.mockReset().mockResolvedValue({ models: [] });
        mocks.platform = 'darwin-aarch64';
        mocks.atomicModifyConfig.mockImplementation(async modify => modify({ ...DEFAULT_CONFIG }));
        mocks.loadProjects.mockResolvedValue([]);
        mocks.loadAppConfig.mockImplementation(async () => ({
            ...DEFAULT_CONFIG,
            agents: [],
            managedCodexProviderDevGate: true,
            managedCodexRuntimeInstall: {
                status: 'error',
                usable: true,
                installedVersion: '0.0.0-previous',
            },
            managedCodexAuth: {
                status: 'valid',
                authMethod: 'chatgpt',
            },
        }));
        mocks.statusPromise = new Promise<void>(resolve => {
            mocks.resolveStatus = resolve;
        });
        mocks.downloadPromise = new Promise<never>((_, reject) => {
            mocks.rejectDownload = reject;
        });
        mocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'cmd_managed_codex_status') {
                return mocks.statusPromise;
            }
            if (command === 'cmd_managed_codex_download') {
                return mocks.downloadPromise;
            }
            return undefined;
        });
    });

    function UpdateStateProbe() {
        const { managedCodexRuntimeUpdateInFlight } = useConfigData();
        const { requestManagedCodexRuntimeUpdate } = useConfigActions();
        return (
            <>
                <div data-testid="managed-codex-update-in-flight">
                    {String(managedCodexRuntimeUpdateInFlight)}
                </div>
                <button
                    type="button"
                    onClick={() => void requestManagedCodexRuntimeUpdate().catch(() => {})}
                >
                    request update
                </button>
            </>
        );
    }

    it('Linux preserves saved config while excluding unsupported providers and runtime actions', async () => {
        mocks.platform = 'linux-x86_64';
        function LinuxProbe() {
            const { providers, config, isLoading } = useConfigData();
            return <div data-testid="linux-projection">{JSON.stringify({
                ids: providers.map(provider => provider.id), gate: config.managedCodexProviderDevGate, isLoading,
            })}</div>;
        }
        const view = render(<ConfigProvider><UpdateStateProbe /><LinuxProbe /></ConfigProvider>);
        await waitFor(() => expect(JSON.parse(screen.getByTestId('linux-projection').textContent!).isLoading).toBe(false));
        const projection = JSON.parse(screen.getByTestId('linux-projection').textContent!);
        expect(projection.gate).toBe(true);
        expect(projection.ids).not.toContain('codex-sub');
        expect(projection.ids).not.toContain('antigravity-sub');
        expect(projection.ids.length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: 'request update' }));
        await waitFor(() => expect(screen.getByTestId('managed-codex-update-in-flight')).toHaveTextContent('false'));
        expect(mocks.invoke.mock.calls.filter(([command]) => String(command).startsWith('cmd_managed_codex'))).toHaveLength(0);
        view.unmount();
    });

    it('merges Linux order and proxy edits with hidden preferences read inside the config lock', async () => {
        mocks.platform = 'linux-x86_64';
        let disk: AppConfig = { ...DEFAULT_CONFIG, agents: [],
            providerOrder: ['anthropic', 'codex-sub', 'deepseek', 'antigravity-sub'],
            disabledProviderIds: ['codex-sub'],
            proxySettings: { ...PROXY_DEFAULTS, enabled: true, scope: { mode: 'custom', generalRequests: false, providerIds: ['codex-sub'] } },
        };
        mocks.loadAppConfig.mockImplementation(async () => disk);
        mocks.atomicModifyConfig.mockImplementation(async modify => {
            disk = await modify(disk);
            return disk;
        });
        function EditProbe() {
            const { isLoading, config } = useConfigData();
            const { updateConfig, patchProxySettings } = useConfigActions();
            return <><span data-testid="saved-preferences">{JSON.stringify({ isLoading, config })}</span>
                <button onClick={async () => {
                    await updateConfig({ providerOrder: ['deepseek', 'anthropic'], disabledProviderIds: undefined });
                    await patchProxySettings({ scope: { mode: 'custom', generalRequests: true, providerIds: ['anthropic'] } });
                }}>save visible preferences</button></>;
        }
        const view = render(<ConfigProvider><EditProbe /></ConfigProvider>);
        await waitFor(() => expect(JSON.parse(screen.getByTestId('saved-preferences').textContent!).isLoading).toBe(false));
        // Another writer changes hidden preferences after this Settings snapshot.
        disk = { ...disk, disabledProviderIds: ['antigravity-sub'], proxySettings: { ...PROXY_DEFAULTS, enabled: true,
            scope: { mode: 'custom', generalRequests: false, providerIds: ['antigravity-sub'] } } };
        fireEvent.click(screen.getByRole('button', { name: 'save visible preferences' }));
        await waitFor(() => expect(disk.proxySettings?.scope?.generalRequests).toBe(true));
        expect(disk.providerOrder).toEqual(['deepseek', 'codex-sub', 'anthropic', 'antigravity-sub']);
        expect(disk.disabledProviderIds).toEqual(['antigravity-sub']);
        expect(disk.proxySettings?.scope?.providerIds).toEqual(['antigravity-sub', 'anthropic']);
        view.unmount();
    });

    it('attempts once per App module, without looping after refresh or React remount', async () => {
        const first = render(<ConfigProvider><UpdateStateProbe /></ConfigProvider>);

        await waitFor(() => expect(screen.getByTestId('managed-codex-update-in-flight')).toHaveTextContent('true'));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'request update' }));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(0);

        mocks.resolveStatus?.();
        await waitFor(() => {
            expect(mocks.invoke.mock.calls.filter(([command]) => (
                command === 'cmd_managed_codex_download'
            ))).toHaveLength(1);
        });
        const invokedCommands = mocks.invoke.mock.calls.map(([command]) => command);
        expect(invokedCommands.indexOf('cmd_managed_codex_status'))
            .toBeLessThan(invokedCommands.indexOf('cmd_managed_codex_download'));

        first.unmount();
        const loadsBeforeRemount = mocks.loadAppConfig.mock.calls.length;
        render(<ConfigProvider><UpdateStateProbe /></ConfigProvider>);
        await waitFor(() => expect(screen.getByTestId('managed-codex-update-in-flight')).toHaveTextContent('true'));
        fireEvent.click(screen.getByRole('button', { name: 'request update' }));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(1);

        mocks.rejectDownload?.(new Error('offline'));
        await waitFor(() => expect(screen.getByTestId('managed-codex-update-in-flight')).toHaveTextContent('false'));
        await waitFor(() => expect(mocks.loadAppConfig.mock.calls.length).toBeGreaterThanOrEqual(3));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(1);

        await waitFor(() => expect(mocks.loadAppConfig.mock.calls.length).toBeGreaterThan(loadsBeforeRemount));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(1);
    });
    it('saves the editable proxy subset against current disk membership on supported platforms', async () => {
        let disk: AppConfig = { ...DEFAULT_CONFIG, agents: [],
            proxySettings: { ...PROXY_DEFAULTS, enabled: true, scope: {
                mode: 'custom', generalRequests: false, providerIds: ['codex-sub', 'anthropic'],
            } },
        };
        mocks.loadAppConfig.mockImplementation(async () => disk);
        mocks.atomicModifyConfig.mockImplementation(async modify => {
            disk = await modify(disk);
            return disk;
        });
        function ProxyProbe() {
            const { isLoading } = useConfigData();
            const { patchProxySettings } = useConfigActions();
            return <><span data-testid="proxy-loaded">{String(!isLoading)}</span>
                <button onClick={() => void patchProxySettings({ scope: {
                    mode: 'custom', generalRequests: true, providerIds: ['codex-sub', 'deepseek'],
                } }, ['anthropic', 'deepseek'])}>save proxy subset</button></>;
        }
        const view = render(<ConfigProvider><ProxyProbe /></ConfigProvider>);
        await waitFor(() => expect(screen.getByTestId('proxy-loaded')).toHaveTextContent('true'));
        // The dialog captured Codex selected. A different writer deselects it
        // and selects a currently missing provider before this save obtains the lock.
        disk = { ...disk, proxySettings: { ...PROXY_DEFAULTS, enabled: true, port: 9001,
            scope: { mode: 'custom', generalRequests: false, providerIds: ['antigravity-sub', 'new-hidden', 'anthropic'] },
        } };
        fireEvent.click(screen.getByRole('button', { name: 'save proxy subset' }));
        await waitFor(() => expect(disk.proxySettings?.scope?.generalRequests).toBe(true));
        expect(disk.proxySettings?.scope?.providerIds).toEqual(['antigravity-sub', 'new-hidden', 'deepseek']);
        expect(disk.proxySettings?.port).toBe(9001);
        view.unmount();
    });


    it('keeps managed execution available after catalogue failure and refreshes without changing auth', async () => {
        const { isProviderAvailable } = await vi.importActual<typeof import('./services/providerService')>('./services/providerService');
        const disk: AppConfig = { ...DEFAULT_CONFIG, agents: [], managedCodexProviderDevGate: true,
            managedCodexRuntimeInstall: { status: 'installed', usable: true, installedVersion: MANAGED_CODEX_REQUIRED_RUNTIME.version },
            managedCodexAuth: { status: 'valid', authMethod: 'chatgpt', verifiedAt: 'unchanged' },
            providerPrimaryModels: { 'codex-sub': 'saved-model' },
        };
        mocks.loadAppConfig.mockResolvedValue(disk);
        mocks.atomicModifyConfig.mockImplementation(async modify => modify(disk));
        mocks.apiGetJson.mockRejectedValueOnce(new Error('HTTP 503: sidecar warming up'));
        mocks.apiGetJson.mockResolvedValue({ models: [{ value: 'saved-model', displayName: 'Saved model', isDefault: true }] });
        function CatalogueProbe() {
            const { providers, managedCodexModelCatalogStatus } = useConfigData();
            const { refreshProviders } = useConfigActions();
            const provider = providers.find(p => p.id === 'codex-sub');
            return <><span data-testid="catalogue-state">{JSON.stringify({
                available: !!provider && isProviderAvailable(provider, {}, {}), count: provider?.models.length,
                model: provider?.primaryModel, status: managedCodexModelCatalogStatus,
            })}</span><button onClick={() => void refreshProviders()}>refresh catalogue</button></>;
        }
        render(<ConfigProvider><CatalogueProbe /></ConfigProvider>);
        await waitFor(() => expect(mocks.apiGetJson).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(JSON.parse(screen.getByTestId('catalogue-state').textContent!))
            .toEqual({ available: true, count: 0, model: 'saved-model', status: 'error' }));
        fireEvent.click(screen.getByRole('button', { name: 'refresh catalogue' }));
        await waitFor(() => expect(JSON.parse(screen.getByTestId('catalogue-state').textContent!))
            .toEqual({ available: true, count: 1, model: 'saved-model', status: 'ready' }));
        expect(disk.managedCodexAuth?.verifiedAt).toBe('unchanged');
        expect(mocks.apiGetJson).toHaveBeenCalledTimes(2);
        mocks.apiGetJson.mockRejectedValueOnce(new Error('refresh failed'));
        fireEvent.click(screen.getByRole('button', { name: 'refresh catalogue' }));
        await waitFor(() => expect(JSON.parse(screen.getByTestId('catalogue-state').textContent!))
            .toEqual({ available: true, count: 1, model: 'saved-model', status: 'error' }));
    });
    it('retires the previous account catalogue and ignores its late discovery response', async () => {
        let disk: AppConfig = { ...DEFAULT_CONFIG, agents: [], managedCodexProviderDevGate: true,
            managedCodexRuntimeInstall: { status: 'installed', usable: true, installedVersion: MANAGED_CODEX_REQUIRED_RUNTIME.version },
            managedCodexAuth: { status: 'valid', authMethod: 'chatgpt', accountEmail: 'first@example.test' },
        };
        mocks.loadAppConfig.mockImplementation(async () => disk);
        mocks.atomicModifyConfig.mockImplementation(async modify => modify(disk));
        let finishOldRefresh!: (value: unknown) => void;
        let finishNewRefresh!: (value: unknown) => void;
        const result = (value: string) => ({ models: [{ value, displayName: value, isDefault: true }] });
        mocks.apiGetJson.mockResolvedValueOnce(result('old-model'))
            .mockImplementationOnce(() => new Promise(resolve => { finishOldRefresh = resolve; }))
            .mockImplementationOnce(() => new Promise(resolve => { finishNewRefresh = resolve; }));
        function Probe() {
            const { providers } = useConfigData();
            const { refreshProviders } = useConfigActions();
            return <><span data-testid="models">{JSON.stringify(providers.find(p => p.id === 'codex-sub')?.models.map(m => m.model))}</span>
                <button onClick={() => void refreshProviders()}>refresh</button></>;
        }
        render(<ConfigProvider><Probe /></ConfigProvider>);
        await waitFor(() => expect(screen.getByTestId('models')).toHaveTextContent('["old-model"]'));
        fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
        await waitFor(() => expect(mocks.apiGetJson).toHaveBeenCalledTimes(2));
        disk = { ...disk, managedCodexAuth: { ...disk.managedCodexAuth!, accountEmail: 'second@example.test' } };
        fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
        await waitFor(() => expect(mocks.apiGetJson).toHaveBeenCalledTimes(3));
        expect(screen.getByTestId('models')).toHaveTextContent('[]');
        await act(async () => finishNewRefresh(result('new-model')));
        await act(async () => finishOldRefresh(result('stale-model')));
        expect(screen.getByTestId('models')).toHaveTextContent('["new-model"]');
    });
});
