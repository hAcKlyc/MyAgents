import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";

import { ToastProvider } from "@/components/Toast";
import { DEFAULT_CONFIG, PROXY_DEFAULTS, type AppConfig, type Provider, type Project } from "@/config/types";
import Settings from "./SettingsPage";

const settingsMocks = vi.hoisted(() => ({
  linux: true,
  config: {} as AppConfig,
  spaceAvailable: true,
  updateConfig: vi.fn(),
  atomicModifyConfig: vi.fn(),
  patchProxySettings: vi.fn(),
  refreshConfig: vi.fn(),
  apiPostJson: vi.fn(),
  invoke: vi.fn(),
}));

const visionProvider = {
  id: "vision-provider",
  name: "Vision Provider",
  vendor: "Test",
  cloudProvider: "模型官方",
  type: "api",
  primaryModel: "vision-model",
  isBuiltin: false,
  config: { baseUrl: "https://example.invalid" },
  models: [
    {
      model: "vision-model",
      modelName: "Vision Model",
      modelSeries: "test",
      inputModalities: ["text", "image"],
    },
  ],
} as Provider;
const stableProviders = [visionProvider];
const stableProjects: Project[] = [];
const stableApiKeys = { "vision-provider": "configured-key" };
const stableVerifyStatus = {};
const configNoop = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: settingsMocks.invoke }));
vi.mock("@/components/MonacoEditor", () => ({ default: () => null }));
vi.mock("@/components/SettingsHelperInbox", () => ({ default: () => null }));
vi.mock("@/components/UnifiedLogsPanel", () => ({
  UnifiedLogsPanel: () => null,
}));
vi.mock("@/components/WorkspaceConfigPanel", () => ({ default: () => null }));
vi.mock("@/components/GlobalPluginsPanel", () => ({ default: () => null }));
vi.mock("@/components/dev/CronTaskDebugPanel", () => ({ default: () => null }));
vi.mock("@/components/ImSettings", () => ({ BotPlatformRegistry: () => null }));
vi.mock("@/utils/debug", async () => {
  const actual = await vi.importActual<typeof import("@/utils/debug")>("@/utils/debug");
  return {
    ...actual,
    getBuildVersions: () => ({ claudeAgentSdk: "test", node: "test", tauri: "test" }),
  };
});

vi.mock("@/hooks/useConfig", () => ({
  useConfig: () => ({
    apiKeys: stableApiKeys,
    saveApiKey: configNoop,
    deleteApiKey: configNoop,
    providerVerifyStatus: stableVerifyStatus,
    saveProviderVerifyStatus: configNoop,
    config: settingsMocks.config,
    updateConfig: settingsMocks.updateConfig,
    patchProxySettings: settingsMocks.patchProxySettings,
    providers: stableProviders,
    projects: stableProjects,
    addProject: configNoop,
    updateProject: configNoop,
    addCustomProvider: configNoop,
    updateCustomProvider: configNoop,
    deleteCustomProvider: configNoop,
    refreshProviders: configNoop,
    savePresetCustomModels: configNoop,
    removePresetCustomModel: configNoop,
    savePrimaryModel: configNoop,
    saveProviderModelAliases: configNoop,
    refreshConfig: settingsMocks.refreshConfig,
    managedCodexRuntimeUpdateInFlight: false,
    requestManagedCodexRuntimeUpdate: configNoop,
  }),
}));

vi.mock("@/config/configService", async () => {
  const actual = await vi.importActual<typeof import("@/config/configService")>(
    "@/config/configService",
  );
  return {
    ...actual,
    atomicModifyConfig: settingsMocks.atomicModifyConfig,
    getAllMcpServers: vi.fn().mockResolvedValue([]),
    getEnabledMcpServerIds: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/api/apiFetch", () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
  apiGetJson: vi.fn().mockResolvedValue({ success: true, data: {} }),
  apiPostJson: settingsMocks.apiPostJson,
}));

vi.mock("@/hooks/useSpaceBuildCapability", () => ({
  useSpaceBuildCapability: () => ({
    available: settingsMocks.spaceAvailable,
    isLoading: false,
    activeEnvironment: "production",
    environments: ["production"],
  }),
}));

vi.mock("@/hooks/useAutostart", () => ({
  useAutostart: () => ({
    isEnabled: false,
    isLoading: false,
    setAutostart: vi.fn(),
  }),
}));

vi.mock("@/hooks/useHelperAgentModelDefaults", () => ({
  useHelperAgentModelDefaults: () => ({}),
}));

vi.mock("@/theme", async () => {
  const actual = await vi.importActual<typeof import("@/theme")>("@/theme");
  return { ...actual, useResolvedTheme: () => ({ id: "warm-paper" }) };
});

vi.mock("@/api/recording", () => ({
  speechModelPackInstall: vi.fn(),
  speechModelPackRemove: vi.fn(),
  speechModelPackStatus: vi.fn().mockResolvedValue(null),
}));


vi.mock('@/utils/desktopPlatform', () => ({
  isLinuxDesktop: () => settingsMocks.linux,
  getPlatformHiddenProviderIds: () => settingsMocks.linux ? ['codex-sub', 'antigravity-sub'] : [],
}));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async () => {}) }));

describe('Ubuntu settings availability', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    settingsMocks.spaceAvailable = true;
    stableProjects.length = 0;
    settingsMocks.config = { ...DEFAULT_CONFIG, agents: [], showDevTools: true,
      floatingBallDevGate: true, managedCodexProviderDevGate: true,
      proxySettings: { ...PROXY_DEFAULTS, enabled: true, scope: { mode: 'custom', generalRequests: false,
        providerIds: ['codex-sub', 'vision-provider', 'antigravity-sub'] } } };
    settingsMocks.invoke.mockImplementation(async (command) => command === 'cmd_detect_runtimes' ? {
      builtin: { installed: true }, dsh: { installed: true },
      'claude-code': { installed: false }, codex: { installed: false },
    } : undefined);
    settingsMocks.apiPostJson.mockResolvedValue({ success: true, data: { models: [] } });
    await i18n.changeLanguage('en-US');
  });

  it('uses the Agent workspace selector and the same defaultWorkspacePath as Launcher', async () => {
    const project = (id: string, displayName: string, extra: Partial<Project> = {}): Project => ({
      id, name: id, displayName, path: `/agents/${id}`, lastOpened: '2026-10-02T00:00:00Z',
      providerId: null, permissionMode: null, ...extra,
    });
    stableProjects.push(project('alpha', 'Agent Alpha'), project('beta', 'Agent Beta'),
      project('hidden', 'Hidden Agent', { hidden: true }),
      project('archived', 'Archived Agent', { archivedAt: '2026-10-01T00:00:00Z' }));
    settingsMocks.config.defaultWorkspacePath = '/agents/alpha';
    render(<ToastProvider><Settings mode="settings" initialSection="general" isActive /></ToastProvider>);
    const trigger = await screen.findByRole('button', { name: 'Agent Alpha' });
    fireEvent.click(trigger);
    expect(screen.getByText('Agent Workspaces')).toBeInTheDocument();
    expect(screen.queryByText('Hidden Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Archived Agent')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Agent Beta/ }));
    await waitFor(() => expect(settingsMocks.updateConfig).toHaveBeenCalledWith({ defaultWorkspacePath: '/agents/beta' }));
  });

  it('redirects a saved desktop-pet route and removes unsupported/update controls without changing config', async () => {
    settingsMocks.linux = true;
    const onCheckForUpdate = vi.fn();
    render(<ToastProvider><Settings mode="settings" initialSection="desktop-pet" isActive
      onCheckForUpdate={onCheckForUpdate} /></ToastProvider>);
    await waitFor(() => expect(screen.getByText(String(i18n.t('about.manualLinuxUpdate', { ns: 'settings' })))).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: String(i18n.t('about.checkUpdates', { ns: 'settings' })) })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: String(i18n.t('sidebar.nav.floatingBall', { ns: 'settings' })) })).not.toBeInTheDocument();
    expect(screen.queryByText(String(i18n.t('about.desktopPetTitle', { ns: 'settings' })))).not.toBeInTheDocument();
    expect(screen.queryByText(String(i18n.t('about.developer.codexProviderTitle', { ns: 'settings' })))).not.toBeInTheDocument();
    expect(onCheckForUpdate).not.toHaveBeenCalled();
    expect(settingsMocks.config.floatingBallDevGate).toBe(true);
    expect(settingsMocks.config.managedCodexProviderDevGate).toBe(true);
    expect(settingsMocks.patchProxySettings).not.toHaveBeenCalled();
    expect(settingsMocks.invoke.mock.calls.filter(([command]) => String(command).startsWith('cmd_managed_codex'))).toHaveLength(0);
  });

  it('keeps the normal update and desktop-pet controls on supported platforms', async () => {
    settingsMocks.linux = false;
    render(<ToastProvider><Settings mode="settings" initialSection="about" isActive /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: String(i18n.t('about.checkUpdates', { ns: 'settings' })) })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: String(i18n.t('sidebar.nav.floatingBall', { ns: 'settings' })) })).toBeInTheDocument();
    expect(screen.queryByText(String(i18n.t('about.manualLinuxUpdate', { ns: 'settings' })))).not.toBeInTheDocument();
  });

  it('redirects a Developer deep link to About until the gesture unlocks it', async () => {
    settingsMocks.linux = false;
    render(<ToastProvider><Settings mode="settings" initialSection="developer" isActive /></ToastProvider>);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'MyAgents' })).toBeInTheDocument());
    expect(within(screen.getByRole('navigation')).queryByRole('button', { name: String(i18n.t('sidebar.nav.developer', { ns: 'settings' })) })).not.toBeInTheDocument();
    expect(screen.queryByText(String(i18n.t('general.defaultRuntimeTitle', { ns: 'settings' })))).not.toBeInTheDocument();
  });

  it('keeps the default Runtime in General without requiring Developer mode', async () => {
    settingsMocks.linux = false;
    render(<ToastProvider><Settings mode="settings" initialSection="about" isActive /></ToastProvider>);

    const navigation = screen.getByRole('navigation');
    const developerLabel = String(i18n.t('sidebar.nav.developer', { ns: 'settings' }));
    const runtimeLabel = String(i18n.t('general.defaultRuntimeTitle', { ns: 'settings' }));
    expect(within(navigation).queryByRole('button', { name: developerLabel })).not.toBeInTheDocument();
    expect(screen.queryByText(runtimeLabel)).not.toBeInTheDocument();

    const wordmark = screen.getByRole('heading', { name: 'MyAgents' });
    for (let i = 0; i < 5; i += 1) fireEvent.click(wordmark);

    const developerTab = within(navigation).getByRole('button', { name: developerLabel });
    expect(screen.queryByText(runtimeLabel)).not.toBeInTheDocument();
    fireEvent.click(developerTab);

    expect(screen.queryByText(runtimeLabel)).not.toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole('button', { name: String(i18n.t('sidebar.nav.general', { ns: 'settings' })) }));
    expect(screen.getByText(runtimeLabel)).toBeInTheDocument();
    expect(screen.getByText(String(i18n.t('general.agentFeaturesTitle', { ns: 'settings' })))).toBeInTheDocument();
    fireEvent.click(developerTab);
    expect(screen.getByText(String(i18n.t('about.developer.devModeTitle', { ns: 'settings' })))).toBeInTheDocument();
    expect(screen.getByText(String(i18n.t('about.developer.cronTaskTitle', { ns: 'settings' })))).toBeInTheDocument();
    const spaceLabel = String(i18n.t('about.teamSpaceTitle', { ns: 'settings' }));
    const spaceToggle = screen.getByRole('button', { name: spaceLabel });
    expect(spaceToggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(spaceToggle);
    expect(settingsMocks.updateConfig).toHaveBeenCalledWith({ teamSpaceDevGate: false });
    fireEvent.click(within(navigation).getByRole('button', { name: String(i18n.t('sidebar.nav.about', { ns: 'settings' })) }));
    expect(screen.queryByText(spaceLabel)).not.toBeInTheDocument();

  });
  it.each([false, true])('keeps the Developer Space switch functional (build available: %s)', async (available) => {
    const { unlockDeveloperSection } = await import('@/utils/developerMode');
    unlockDeveloperSection();
    settingsMocks.spaceAvailable = available;
    settingsMocks.config.teamSpaceDevGate = false;
    render(<ToastProvider><Settings mode="settings" initialSection="developer" isActive /></ToastProvider>);
    const toggle = await screen.findByRole('button', { name: 'Team Space' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    if (available) {
      expect(toggle).toBeEnabled();
      fireEvent.click(toggle);
      expect(settingsMocks.updateConfig).toHaveBeenCalledWith({ teamSpaceDevGate: true });
    } else {
      expect(toggle).toBeDisabled();
      fireEvent.click(toggle);
      expect(settingsMocks.updateConfig).not.toHaveBeenCalled();
    }
  });

  it.each(['zh-CN', 'en-US'])('shows the bundled B2 market banner in Capabilities for %s', async (locale) => {
    await i18n.changeLanguage(locale);
    const open = vi.fn();
    render(<ToastProvider><Settings mode="capabilities" initialSection="plugins" onOpenToolMarket={open} isActive /></ToastProvider>);
    const label = String(i18n.t('capabilities.toolMarketOpen', { ns: 'settings' }));
    const button = screen.getByRole('button', { name: label });
    const image = within(button).getByRole('img');
    expect(image).toHaveAttribute('src', expect.stringContaining(`tool-market-${locale}.png`));
    fireEvent.click(button);
    expect(open).toHaveBeenCalledOnce();
  });

  it.each(['build', 'developer'])('hides the market banner when unavailable via %s', (gate) => {
    settingsMocks.spaceAvailable = gate !== 'build';
    settingsMocks.config.teamSpaceDevGate = gate !== 'developer';
    render(<ToastProvider><Settings mode="capabilities" initialSection="plugins" onOpenToolMarket={vi.fn()} isActive /></ToastProvider>);
    expect(document.querySelector('[data-tool-market-entry]')).not.toBeInTheDocument();
  });

  it('keeps the targeted capabilities section when the host consumes navigation', async () => {
    const consumed = vi.fn();
    function NavigationHost() {
      const [pending, setPending] = useState(true);
      return <ToastProvider><Settings mode="capabilities" initialSection={pending ? 'plugins' : undefined}
        navigationNonce={pending ? 1 : undefined} isActive
        onSectionChange={pending ? () => { consumed(); setPending(false); } : undefined} /></ToastProvider>;
    }
    render(<NavigationHost />);
    await waitFor(() => expect(consumed).toHaveBeenCalledOnce());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.getByRole('tab', { name: String(i18n.t('capabilities.plugins', { ns: 'settings' })) }))
      .toHaveAttribute('aria-selected', 'true');
  });

  it.each([undefined, false, true])('writes the AgentNet developer gate through config (stored: %s)', async (enabled) => {
    const { unlockDeveloperSection } = await import('@/utils/developerMode');
    unlockDeveloperSection();
    settingsMocks.config.agentNetworkSelfhostDevGate = enabled;
    render(<ToastProvider><Settings mode="settings" initialSection="developer" isActive /></ToastProvider>);
    const toggle = await screen.findByRole('button', { name: 'AgentNet multiple networks (experimental)' });
    expect(toggle).toHaveAttribute('aria-pressed', String(enabled === true));
    fireEvent.click(toggle);
    expect(settingsMocks.updateConfig).toHaveBeenCalledWith({ agentNetworkSelfhostDevGate: enabled !== true });
  });

});
