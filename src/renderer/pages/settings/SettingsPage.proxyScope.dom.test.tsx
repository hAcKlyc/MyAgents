import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";

import { ToastProvider } from "@/components/Toast";
import { DEFAULT_CONFIG, PROXY_DEFAULTS, type AppConfig, type Provider, type Project } from "@/config/types";
import Settings from "./SettingsPage";

const settingsMocks = vi.hoisted(() => ({
  linux: false,
  statusChanged: undefined as (() => void) | undefined,
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
const stableProviders = [visionProvider,
  { ...visionProvider, id: 'codex-sub', name: 'Codex' },
  { ...visionProvider, id: 'antigravity-sub', name: 'Antigravity' },
];
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
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async (event, listener) => {
  if (event === 'cliproxy:changed') settingsMocks.statusChanged = listener;
}) }));


const healthyStatus = {
  policy: { mode: 'enabled', usable: true, revision: 1 },
  component: { version: '8.0.13', phase: 'installed', source: 'updated' },
  update: { phase: 'idle' },
  active: { generation: 'account-1', status: 'connected' }, candidate: null,
  instances: { active: 'running', candidate: 'stopped' }, cleanup: null,
  models: [], modelsStale: false,
};

describe('proxy scope remains user configuration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    settingsMocks.statusChanged = undefined;
    settingsMocks.config = { ...DEFAULT_CONFIG, agents: [],
      proxySettings: { ...PROXY_DEFAULTS, enabled: true, scope: {
        mode: 'custom', generalRequests: true,
        providerIds: ['codex-sub', 'vision-provider', 'antigravity-sub', 'temporarily-unloaded'],
      } },
    };
    settingsMocks.apiPostJson.mockResolvedValue({ success: true, data: { models: [] } });
    settingsMocks.invoke.mockImplementation(async (command) => {
      if (command === 'cmd_cliproxy_status') return healthyStatus;
      if (command === 'cmd_detect_runtimes') return {
        builtin: { installed: true }, dsh: { installed: true },
        'claude-code': { installed: false }, codex: { installed: false },
      };
      return undefined;
    });
    await i18n.changeLanguage('en-US');
  });

  it.each(['settings', 'capabilities'] as const)(
    '%s keeps selections while hidden and while CLIProxy status loads, disappears and recovers',
    async (mode) => {
      let resolveStatus!: (value: typeof healthyStatus) => void;
      const pending = new Promise<typeof healthyStatus>(resolve => { resolveStatus = resolve; });
      settingsMocks.invoke.mockImplementation(async command => command === 'cmd_cliproxy_status' ? pending : undefined);
      const view = render(<ToastProvider><Settings mode={mode} initialSection={mode === 'settings' ? 'about' : 'mcp'} isActive={false} /></ToastProvider>);
      expect(settingsMocks.patchProxySettings).not.toHaveBeenCalled();
      await act(async () => { resolveStatus(healthyStatus); });
      expect(settingsMocks.patchProxySettings).not.toHaveBeenCalled();
      settingsMocks.invoke.mockResolvedValue({ ...healthyStatus, policy: { ...healthyStatus.policy, usable: false }, active: null });
      await act(async () => { settingsMocks.statusChanged?.(); });
      expect(settingsMocks.patchProxySettings).not.toHaveBeenCalled();
      settingsMocks.invoke.mockResolvedValue(healthyStatus);
      await act(async () => { settingsMocks.statusChanged?.(); });
      view.rerender(<ToastProvider><Settings mode={mode} initialSection={mode === 'settings' ? 'about' : 'mcp'} isActive /></ToastProvider>);
      expect(settingsMocks.patchProxySettings).not.toHaveBeenCalled();
    },
  );

  it('does not rewrite a legacy provider-only scope as all while its provider is hidden', async () => {
    settingsMocks.config.proxySettings!.scope = { mode: 'custom', providerIds: ['antigravity-sub'] };
    render(<ToastProvider><Settings mode="settings" initialSection="about" isActive /></ToastProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(settingsMocks.patchProxySettings).not.toHaveBeenCalled();
  });

  it('uses the configured catalog for the dialog and saves a custom selection without dropping unseen IDs', async () => {
    settingsMocks.invoke.mockImplementation(() => new Promise(() => {}));
    settingsMocks.config.proxySettings!.scope = { mode: 'custom', generalRequests: false,
      providerIds: ['antigravity-sub', 'codex-sub', 'temporarily-unloaded'] };
    render(<ToastProvider><Settings mode="settings" initialSection="proxy" isActive /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByRole('checkbox', { name: /Antigravity/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: /Vision Provider/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /General network requests/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(settingsMocks.patchProxySettings).toHaveBeenCalledWith({ scope: {
      mode: 'custom', generalRequests: true,
      providerIds: ['antigravity-sub', 'codex-sub', 'temporarily-unloaded', 'vision-provider'],
    } }, ['vision-provider', 'codex-sub', 'antigravity-sub']));
  });
  it('keeps an unchanged All scope and honors explicit provider deselection', async () => {
    settingsMocks.config.proxySettings!.scope = { mode: 'all' };
    render(<ToastProvider><Settings mode="settings" initialSection="proxy" isActive /></ToastProvider>);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(settingsMocks.patchProxySettings).toHaveBeenCalledWith({ scope: { mode: 'all' } },
      ['vision-provider', 'codex-sub', 'antigravity-sub']);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Antigravity/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(settingsMocks.patchProxySettings).toHaveBeenCalledWith({ scope: {
      mode: 'custom', generalRequests: true, providerIds: ['vision-provider', 'codex-sub'],
    } }, ['vision-provider', 'codex-sub', 'antigravity-sub']);
  });

});
