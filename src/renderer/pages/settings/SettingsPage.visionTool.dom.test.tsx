import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { REACT_LOG_EVENT } from "@/utils/frontendLogger";

import { ToastProvider } from "@/components/Toast";
import { DEFAULT_CONFIG, MANAGED_CODEX_PROVIDER, type AppConfig, type Provider } from "@/config/types";
import { dismissTopmost } from "@/utils/closeLayer";
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

function renderSettings() {
  return render(
    <ToastProvider>
      <Settings mode="capabilities" initialSection="mcp" isActive />
    </ToastProvider>,
  );
}

function getImageToolSwitch(): HTMLElement {
  const imageToolCard = document.getElementById(
    "official-tool-image-understanding",
  );
  const imageToolSwitch =
    imageToolCard?.querySelector<HTMLElement>('[role="switch"]');
  if (!imageToolSwitch) throw new Error("Image Understanding switch missing");
  return imageToolSwitch;
}

describe("Settings image-understanding enable flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMocks.config = {
      ...DEFAULT_CONFIG,
      enabledOfficialToolIds: [],
      officialToolSettings: {},
    };
    settingsMocks.refreshConfig.mockResolvedValue(undefined);
    settingsMocks.apiPostJson.mockImplementation(async (path: string) => {
      if (path === "/api/admin/vision/models") {
        return {
          success: true,
          data: {
            models: [
              {
                providerId: "vision-provider",
                providerName: "Vision Provider",
                model: "vision-model",
                modelName: "Vision Model",
                capabilityConfidence: "declared",
              },
            ],
          },
        };
      }
      return { success: true, data: {} };
    });
  });

  it("places Codex and tool dialogs above the shell only while their tab is active", async () => {
    const user = userEvent.setup();
    stableProviders.push(MANAGED_CODEX_PROVIDER);
    settingsMocks.config.managedCodexProviderDevGate = true;
    settingsMocks.config.managedCodexRuntimeInstall = { status: "installed", installedVersion: "0.167.0", usable: true };
    try {
      const settings = (active: boolean) => <ToastProvider><Settings mode="settings" initialSection="providers" isActive={active} /></ToastProvider>;
      const view = render(settings(true));
      await user.click(await screen.findByTitle("Codex 订阅设置"));
      const backdrop = () => screen.getByRole("heading", { name: "Codex 订阅设置" }).closest("[data-overlay-backdrop]");
      expect(backdrop()?.parentElement).toBe(document.body);
      expect(backdrop()).toHaveClass("z-[100]");
      view.rerender(settings(false));
      expect(document.querySelector("[data-overlay-backdrop]")).not.toBeVisible();
      expect(document.querySelector('.fixed.inset-0[class*="backdrop-blur"]')).toBeNull();
      act(() => expect(dismissTopmost()).toBe(false));
      view.rerender(settings(true));
      expect(backdrop()).toBeVisible();
      view.unmount();
    } finally {
      stableProviders.pop();
    }
    renderSettings();
    await user.click(getImageToolSwitch());
    const tools = screen.getByRole("heading", { name: "图片理解设置" }).closest("[data-overlay-backdrop]");
    expect(tools?.parentElement).toBe(document.body);
    expect(tools).toHaveClass("z-[100]");
  });

  it("keeps a real provider model panel stable when Settings receives request logs (#582)", async () => {
    await i18n.changeLanguage('en-US');
    let resolveModels!: (value: unknown) => void;
    settingsMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'cmd_fetch_provider_models') {
        return new Promise(resolve => { resolveModels = resolve; });
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<ToastProvider><Settings mode="settings" initialSection="providers" isActive /></ToastProvider>);
    await user.click(screen.getByTitle('Manage'));
    await user.click(screen.getByRole('button', { name: 'Manage models' }));
    const calls = () => settingsMocks.invoke.mock.calls.filter(([command]) => command === 'cmd_fetch_provider_models');
    expect(calls()).toHaveLength(1);
    for (let index = 0; index < 5; index++) {
      act(() => window.dispatchEvent(new CustomEvent(REACT_LOG_EVENT, { detail: {
        source: 'rust', level: 'info', message: '[model-discovery] Fetching models', timestamp: '2026-09-11 12:00:00',
      } })));
    }
    expect(calls()).toHaveLength(1);
    await act(async () => resolveModels({ data: [{ id: 'settings-discovered-model' }] }));
    expect(screen.getByText('settings-discovered-model')).toBeInTheDocument();
    expect(calls()).toHaveLength(1);
  });

  it("keeps identical vision models distinct and cancels a capability-unconfirmed draft", async () => {
    const user = userEvent.setup();
    settingsMocks.apiPostJson.mockResolvedValue({ success: true, data: { models: [
      { providerId: 'a', providerName: 'First Vision', model: 'shared', modelName: 'Shared', capabilityConfidence: 'declared' },
      { providerId: 'b', providerName: 'Second Vision', model: 'shared', modelName: 'Shared', capabilityConfidence: 'unknown' },
    ] } });
    renderSettings();
    await user.click(getImageToolSwitch());
    await user.click(await screen.findByRole('button', { name: 'First Vision / Shared' }));
    await user.click(screen.getByRole('button', { name: 'Second Vision' }));
    await user.click(screen.getByRole('button', { name: /Shared.*待确认/ }));
    expect(screen.getByRole('button', { name: /Second Vision.*Shared.*待确认/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(settingsMocks.atomicModifyConfig).not.toHaveBeenCalled();
    await user.click(getImageToolSwitch());
    expect(await screen.findByRole('button', { name: 'First Vision / Shared' })).toBeInTheDocument();
  });

  it("keeps the switch off on cancel, then locks dismissal until confirmed save enables it", async () => {
    const user = userEvent.setup();
    let releaseMutation!: () => void;
    settingsMocks.atomicModifyConfig.mockImplementationOnce(
      async (modifier: (current: AppConfig) => AppConfig) => {
        await new Promise<void>((resolve) => {
          releaseMutation = () => {
            settingsMocks.config = modifier(settingsMocks.config);
            resolve();
          };
        });
      },
    );
    const view = renderSettings();
    const imageToolSwitch = getImageToolSwitch();

    await user.click(imageToolSwitch);
    expect(
      screen.getByRole("heading", { name: "图片理解设置" }),
    ).toBeInTheDocument();
    expect(imageToolSwitch).not.toBeChecked();
    expect(settingsMocks.atomicModifyConfig).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(
      screen.queryByRole("heading", { name: "图片理解设置" }),
    ).not.toBeInTheDocument();
    expect(imageToolSwitch).not.toBeChecked();
    expect(settingsMocks.atomicModifyConfig).not.toHaveBeenCalled();

    await user.click(imageToolSwitch);
    const closeButton = document.querySelector(".app-icon-close")?.closest("button");
    expect(closeButton).not.toBeNull();
    await user.click(closeButton!);
    expect(
      screen.queryByRole("heading", { name: "图片理解设置" }),
    ).not.toBeInTheDocument();

    await user.click(imageToolSwitch);
    const backdrop = screen
      .getByRole("heading", { name: "图片理解设置" })
      .closest(".fixed.inset-0");
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    expect(
      screen.queryByRole("heading", { name: "图片理解设置" }),
    ).not.toBeInTheDocument();

    await user.click(imageToolSwitch);
    act(() => expect(dismissTopmost()).toBe(true));
    expect(
      screen.queryByRole("heading", { name: "图片理解设置" }),
    ).not.toBeInTheDocument();

    await user.click(imageToolSwitch);
    const saveButton = await screen.findByRole("button", { name: "保存" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    expect(settingsMocks.atomicModifyConfig).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    fireEvent.mouseDown(
      screen
        .getByRole("heading", { name: "图片理解设置" })
        .closest(".fixed.inset-0")!,
    );
    act(() => expect(dismissTopmost()).toBe(true));
    expect(
      screen.getByRole("heading", { name: "图片理解设置" }),
    ).toBeInTheDocument();

    await act(async () => releaseMutation());
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "图片理解设置" }),
      ).not.toBeInTheDocument();
    });
    view.rerender(
      <ToastProvider>
        <Settings mode="capabilities" initialSection="mcp" isActive />
      </ToastProvider>,
    );

    expect(
      document
        .getElementById("official-tool-image-understanding")!
        .querySelector('[role="switch"]'),
    ).toBeChecked();
    expect(
      settingsMocks.config.officialToolSettings?.imageUnderstanding,
    ).toEqual({
      providerId: "vision-provider",
      model: "vision-model",
    });
  });

  it("keeps the pending modal open on save failure and then allows cancellation", async () => {
    const user = userEvent.setup();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    settingsMocks.atomicModifyConfig.mockRejectedValueOnce(
      new Error("config write failed"),
    );
    renderSettings();

    await user.click(getImageToolSwitch());
    const saveButton = await screen.findByRole("button", { name: "保存" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
    });
    expect(
      screen.getByRole("heading", { name: "图片理解设置" }),
    ).toBeInTheDocument();
    expect(settingsMocks.config.enabledOfficialToolIds).toEqual([]);

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(
      screen.queryByRole("heading", { name: "图片理解设置" }),
    ).not.toBeInTheDocument();
    expect(errorLog).toHaveBeenCalledWith(
      "[Settings] Failed to save vision tool settings:",
      expect.any(Error),
    );
    errorLog.mockRestore();
  });
});
