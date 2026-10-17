import {
  act,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";

import { ToastProvider } from "@/components/Toast";
import { DEFAULT_CONFIG, type AppConfig, type Provider } from "@/config/types";
import Settings from "./SettingsPage";

const settingsMocks = vi.hoisted(() => ({
  config: {} as AppConfig,
  atomicModifyConfig: vi.fn(),
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
const stableProjects: never[] = [];
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

vi.mock("@/hooks/useConfig", () => ({
  useConfig: () => ({
    apiKeys: stableApiKeys,
    saveApiKey: configNoop,
    deleteApiKey: configNoop,
    providerVerifyStatus: stableVerifyStatus,
    saveProviderVerifyStatus: configNoop,
    config: settingsMocks.config,
    updateConfig: configNoop,
    patchProxySettings: configNoop,
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
    getAllMcpServers: vi.fn().mockResolvedValue([{id:'myagents-browser', name:'浏览器', type:'stdio', command:'__browser_host__', isBuiltin:true}]),
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


const resourceListeners = vi.hoisted(() => ({ status: null as null | ((e: { payload: unknown }) => void) }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: async (event: string, fn: (e: { payload: unknown }) => void) => { if (event === 'browser-resource-status') resourceListeners.status = fn; } }));
vi.mock('@/utils/browserMock', async () => ({ ...await vi.importActual<typeof import('@/utils/browserMock')>('@/utils/browserMock'), isTauriEnvironment: () => true }));
const browserReady = { state: 'ready', requiredRevision: 'r1', installedRevision: 'r1', installAuthorized: true, retryable: false, automaticRetryCount: 0, statusRevision: 10, updatedAt: '' };

describe('Settings browser resource navigation and recovery', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    vi.clearAllMocks(); resourceListeners.status = null;
    settingsMocks.config = { ...DEFAULT_CONFIG, mcpEnabledServers: [] };
    settingsMocks.refreshConfig.mockResolvedValue(undefined);
    settingsMocks.apiPostJson.mockResolvedValue({success:true, data:{}});
    settingsMocks.invoke.mockImplementation(async () => undefined);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('focuses the browser resource card without opening generic MCP configuration', async () => {
    settingsMocks.invoke.mockImplementation(async (command: string) => command === 'cmd_browser_resource_status' ? browserReady : undefined);
    render(<ToastProvider><Settings mode="capabilities" initialSection="mcp" initialMcpId="myagents-browser" isActive /></ToastProvider>);
    await waitFor(() => expect(document.activeElement?.id).toBe('mcp-tool-myagents-browser'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not let an older failed status query overwrite a newer owner event', async () => {
    let reject!: (error: Error) => void;
    settingsMocks.invoke.mockImplementation(async (command: string) => command === 'cmd_browser_resource_status' ? new Promise((_, fail) => { reject = fail; }) : undefined);
    render(<ToastProvider><Settings mode="capabilities" initialSection="mcp" isActive /></ToastProvider>);
    await waitFor(() => expect(resourceListeners.status).not.toBeNull());
    act(() => resourceListeners.status!({ payload: browserReady }));
    await act(async () => reject(new Error('old read failed')));
    expect(screen.queryByText('无法读取浏览器资源状态，请重试检查。')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '浏览器' })).not.toBeDisabled();
  });
});
