import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  useContext,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UseConfigResult } from "@/hooks/useConfig";
import type SimpleChatInput from "@/components/SimpleChatInput";
import type { SessionMetadata } from "@/api/sessionClient";
import type { TabContextValue } from "@/context/TabContext";
import type { InitialMessage } from "@/types/tab";
import type { RuntimeSource, RuntimeType } from "../../shared/types/runtime";

const mocks = vi.hoisted(() => ({
  config: {} as UseConfigResult,
  input: null as ComponentProps<typeof SimpleChatInput> | null,
  publishMetadata: null as TabContextValue["setSessionMeta"] | null,
  send: vi.fn<TabContextValue["sendMessage"]>(async () => true),
  get: vi.fn(),
  post: vi.fn<TabContextValue["apiPost"]>(
    async <T,>() => ({ success: true }) as T,
  ),
  patchSession: vi.fn(),
  patchProject: vi.fn(async () => undefined),
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
  noop: vi.fn(),
  capabilities: {
    enabledSkills: [],
    enabledCommands: [],
    globalSkillFolderNames: [],
    loadSkillsAndCommands: vi.fn(),
  },
  cron: {
    state: { isEnabled: false, task: null, config: null, isExecuting: false },
  },
  goal: { state: { goal: null, isExecuting: false } },
  files: { isAvailable: false },
}));

// Keep Chat, its selection/projection helpers and persistence orchestration real.
// Only peripheral UI and external owners are replaced; assertions inspect Chat's
// actual send callback and the picker props wired to its user-action handlers.
vi.mock("@/hooks/useConfig", () => ({ useConfig: () => mocks.config }));
vi.mock("@/api/sessionClient", () => ({ updateSession: mocks.patchSession }));
vi.mock("@/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => mocks.toast }));
vi.mock("@/context/FileActionContext", () => ({
  FileActionProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({
    builtin: { installed: true },
    dsh: { installed: true, readiness: "ready" },
    codex: { installed: true },
    "claude-code": { installed: true },
  })),
}));
vi.mock("@/hooks/useBrowserResourceReady", () => ({
  useBrowserResourceReady: () => false,
}));
vi.mock("@/hooks/useWorkspaceFileService", () => ({
  useWorkspaceFileService: () => mocks.files,
}));
vi.mock("@/hooks/useWorkspaceChangeSignal", () => ({
  useWorkspaceChangeSignal: () => 0,
}));
vi.mock("@/hooks/useProjectCapabilities", () => ({
  useProjectCapabilities: () => mocks.capabilities,
}));
vi.mock("@/hooks/useCronTask", () => ({ useCronTask: () => mocks.cron }));
vi.mock("@/hooks/useSessionGoal", () => ({ useSessionGoal: () => mocks.goal }));
vi.mock("@/hooks/useSessionCronRestore", () => ({
  useSessionCronRestore: vi.fn(),
}));
vi.mock("@/hooks/useAgentStatuses", () => ({
  useAgentStatuses: () => ({ statuses: {} }),
}));
vi.mock("@/hooks/useTaskCenterData", () => ({
  usePassiveSessionMetadata: () => null,
}));
vi.mock("@/hooks/useTauriFileDrop", () => ({
  useTauriFileDrop: () => ({
    registerZone: mocks.noop,
    unregisterZone: mocks.noop,
  }),
}));
vi.mock("@/hooks/useChatWorkspaceLayout", () => ({
  useChatWorkspaceLayout: () => ({
    ready: true,
    workspacePanelMode: "overlay",
  }),
}));
vi.mock("@/config/configService", async (original) => ({
  ...(await original<typeof import("@/config/configService")>()),
  getAllMcpServers: vi.fn(async () => []),
  getEnabledMcpServerIds: vi.fn(async () => []),
}));

vi.mock("@/components/SimpleChatInput", () => ({
  default: (props: ComponentProps<typeof SimpleChatInput>) => {
    mocks.input = props;
    return (
      <div>
        <output data-testid="model">{props.selectedModel}</output>
        <output data-testid="provider">{props.provider?.id}</output>
        <output data-testid="permission">{props.permissionMode}</output>
        <button onClick={() => void props.onSend("follow-up")}>Send</button>
      </div>
    );
  },
}));
vi.mock("@/components/DirectoryPanel", () => ({ default: () => null }));
vi.mock("@/components/MessageList", () => ({ default: () => null }));
vi.mock("@/components/SessionHistoryDropdown", () => ({ default: () => null }));
vi.mock("@/components/SessionSurfaceTags", () => ({ default: () => null }));
vi.mock("@/components/SessionMenuButton", () => ({ default: () => null }));
vi.mock("@/components/session-tags/UserTagPills", () => ({
  default: () => null,
}));
vi.mock("@/components/agent-status/AgentStatusPanel", () => ({
  default: () => null,
}));
vi.mock("@/components/ContextUsageIndicator", () => ({ default: () => null }));
vi.mock("@/components/ChatBootOverlay", () => ({ default: () => null }));
vi.mock("@/components/chat/QueryNavigator", () => ({ default: () => null }));
vi.mock("@/components/ChatSearchPanel", () => ({ default: () => null }));
vi.mock("@/components/SelectionCommentMenu", () => ({ default: () => null }));
vi.mock("@/components/TerminalReasonBanner", () => ({ default: () => null }));
vi.mock("@/components/RuntimeDiagnosticsBanner", () => ({
  default: () => null,
}));
vi.mock("@/components/UnifiedLogsPanel", () => ({
  UnifiedLogsPanel: () => null,
}));
vi.mock("@/components/WorkspaceConfigPanel", () => ({ default: () => null }));
vi.mock("@/components/cron/CronTaskSettingsModal", () => ({
  default: () => null,
  GOAL_SLASH_PRESET: {},
}));
vi.mock("@/components/scheduled-tasks/CronTaskCard", () => ({
  default: () => null,
}));
vi.mock("@/components/CronTaskDetailPanel", () => ({ default: () => null }));

import Chat from "./Chat";
import { TabActiveContext, TabContext } from "@/context/TabContext";
import {
  DEFAULT_CONFIG,
  MANAGED_CODEX_PROVIDER,
  type Provider,
} from "@/config/types";
import { createRuntimeBackedProviderIdentity } from "../../shared/providerExecution";

const chosenModel = "gpt-6.1-sol";
const laterModel = "gpt-6.1";
const identity = createRuntimeBackedProviderIdentity({
  providerId: "codex-sub",
  model: chosenModel,
});
const managedProvider: Provider = {
  ...MANAGED_CODEX_PROVIDER,
  primaryModel: chosenModel,
  runtimeReady: true,
  models: [chosenModel, laterModel].map((model) => ({
    model,
    modelName: model,
    modelSeries: "gpt",
  })),
};
const apiProvider: Provider = {
  id: "old-api",
  name: "API",
  vendor: "Test",
  cloudProvider: "Test",
  type: "api",
  isBuiltin: false,
  config: { baseUrl: "https://example.invalid" },
  apiProtocol: "openai",
  primaryModel: "mimo-v2.5",
  models: ["mimo-v2.5", "explicit-api-model"].map((model) => ({
    model,
    modelName: model,
    modelSeries: "test",
  })),
};

function ownedMetadata(model = chosenModel): SessionMetadata {
  return {
    id: "session-selection",
    agentDir: "/workspace",
    title: "Selection",
    createdAt: "2026-11-02T00:00:00Z",
    lastActiveAt: "2026-11-02T00:00:00Z",
    runtime: "codex",
    runtimeSource: "managed-provider",
    configSnapshotAt: "2026-11-02T00:00:00Z",
    providerId: "codex-sub",
    providerExecutionIdentity: { ...identity, model },
    model,
    permissionMode: "auto-edit",
  } as SessionMetadata;
}

function Harness({
  runtime = "codex",
  source = "managed-provider",
  metadata = null,
  connected = true,
  ...props
}: Partial<ComponentProps<typeof Chat>> & {
  runtime?: RuntimeType;
  source?: RuntimeSource | null;
  metadata?: SessionMetadata | null;
  connected?: boolean;
}) {
  const defaults = useContext(TabContext);
  const [sessionMeta, setSessionMeta] = useState(metadata);
  useLayoutEffect(() => {
    mocks.publishMetadata = setSessionMeta;
  }, [setSessionMeta]);
  return (
    <TabActiveContext.Provider value={true}>
      <TabContext.Provider
        value={{
          ...defaults,
          tabId: "tab-selection",
          agentDir: "/workspace",
          sessionId: "session-selection",
          sessionRuntime: runtime,
          sessionRuntimeSource: source,
          sessionMeta,
          setSessionMeta,
          isConnected: connected,
          sendMessage: mocks.send,
          apiGet: mocks.get,
          apiPost: mocks.post as TabContextValue["apiPost"],
        }}
      >
        <Chat
          windowPresentation={{ surfaceAvailable: true, generation: 0 }}
          sidecarConfigDisposition="pending"
          {...props}
        />
      </TabContext.Provider>
    </TabActiveContext.Provider>
  );
}

function launchMessage(): InitialMessage {
  return {
    text: "feedback",
    providerExecutionIdentity: identity,
    runtimeModel: chosenModel,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.input = null;
  mocks.publishMetadata = null;
  mocks.config = {
    config: { ...DEFAULT_CONFIG },
    projects: [
      {
        id: "workspace",
        path: "/workspace",
        name: "Workspace",
        providerId: "old-api",
        model: "mimo-v2.5",
      },
    ],
    providers: [apiProvider, managedProvider],
    apiKeys: { "old-api": "test-only" },
    providerVerifyStatus: {
      "codex-sub": { status: "valid", verifiedAt: "2026-11-02T00:00:00Z" },
    },
    patchProject: mocks.patchProject,
    refreshProviderData: mocks.noop,
    refreshProviders: mocks.noop,
    refreshConfig: mocks.noop,
  } as unknown as UseConfigResult;
  mocks.get.mockImplementation(async (path: string) => {
    if (path === "/api/session/config")
      return {
        success: true,
        runtime: "codex",
        runtimeSource: "managed-provider",
        providerExecutionIdentity: identity,
        providerId: "codex-sub",
        model: chosenModel,
        permissionMode: "suggest",
        reasoningEffort: "default",
      };
    return { success: true, models: [], agents: {} };
  });
  mocks.patchSession.mockImplementation(
    async (_id: string, patch: Partial<SessionMetadata>) => ({
      ...ownedMetadata(),
      ...patch,
      configSnapshotAt: "2026-11-02T00:00:01Z",
    }),
  );
});

describe("Chat execution selection (#685)", () => {
  it.each(["mimo-v2.5", "gpt-6.1"])(
    "sends the launch identity before metadata arrives, ignoring workspace model %s",
    async (staleModel) => {
      mocks.config.projects[0].model = staleModel;
      const consumed = vi.fn();
      const view = render(
        <Harness
          initialMessage={launchMessage()}
          onInitialMessageConsumed={consumed}
        />,
      );
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      expect(mocks.send.mock.calls[0]?.[3]).toBe(chosenModel);
      expect(mocks.send.mock.calls[0]?.[4]).toBeUndefined();
      expect(mocks.send.mock.calls[0]?.[7]).toBeUndefined();
      expect(screen.getByTestId("model")).toHaveTextContent(chosenModel);
      expect(screen.getByTestId("provider")).toHaveTextContent("codex-sub");
      expect(consumed).toHaveBeenCalledOnce();
      // App retires the handoff; ordinary sends keep the projected selection.
      view.rerender(<Harness />);
      fireEvent.click(screen.getByText("Send"));
      await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
      expect(mocks.send.mock.calls[1]?.[3]).toBe(chosenModel);
    },
  );

  it.each([
    "unchanged",
    "equivalent snapshot",
    "unrelated tags",
    "new model metadata",
  ] as const)("adopts independent fields after %s", async (publication) => {
    const get = mocks.get.getMockImplementation()!;
    const response = {
      ...(await get("/api/session/config")),
      mcpServerIds: ["adopted-mcp"],
      enabledOfficialToolIds: ["image-understanding"],
      reasoningEffort: "high",
    };
    let finishAdoption!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finishAdoption = resolve;
    });
    mocks.get.mockImplementation((path: string) =>
      path === "/api/session/config" ? pending : get(path),
    );
    const metadata = ownedMetadata();
    const adopted = vi.fn();
    render(
      <Harness
        metadata={metadata}
        sidecarConfigDisposition="adopt"
        onSidecarConfigAdopted={adopted}
      />,
    );
    if (publication !== "unchanged") {
      const updated =
        publication === "new model metadata"
          ? {
              ...ownedMetadata(laterModel),
              configSnapshotAt: "2026-11-02T00:00:01Z",
            }
          : {
              ...metadata,
              providerExecutionIdentity: { ...identity },
              ...(publication === "unrelated tags"
                ? { userTags: ["triaged"] }
                : {}),
            };
      act(() => mocks.publishMetadata?.(updated));
    }
    await act(async () => {
      finishAdoption(response);
      await pending;
    });
    expect(adopted).toHaveBeenCalledOnce();
    expect(mocks.input?.permissionMode).toBe("plan");
    expect(mocks.input?.workspaceMcpEnabled).toEqual(["adopted-mcp"]);
    expect(mocks.input?.workspaceOfficialToolEnabled).toEqual([
      "image-understanding",
    ]);
    expect(mocks.input?.reasoningEffort).toBe("high");
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]?.[3]).toBe(
      publication === "new model metadata" ? laterModel : chosenModel,
    );
    expect(mocks.send.mock.calls[0]?.[2]).toBe("suggest");
  });

  it.each([
    ["suggest", "plan"],
    ["auto-edit", "auto"],
    ["no-restrictions", "fullAgency"],
  ])(
    "projects Managed adoption and maps %s to the %s picker permission",
    async (runtimePermission, pickerPermission) => {
      const get = mocks.get.getMockImplementation()!;
      mocks.get.mockImplementation(async (path: string) => {
        const response = await get(path);
        return path === "/api/session/config"
          ? { ...response, permissionMode: runtimePermission }
          : response;
      });
      const adopted = vi.fn();
      render(
        <Harness
          sidecarConfigDisposition="adopt"
          onSidecarConfigAdopted={adopted}
        />,
      );
      await waitFor(() => expect(adopted).toHaveBeenCalledOnce());
      expect(screen.getByTestId("model")).toHaveTextContent(chosenModel);
      expect(screen.getByTestId("provider")).toHaveTextContent("codex-sub");
      expect(screen.getByTestId("permission")).toHaveTextContent(
        pickerPermission,
      );
      fireEvent.click(screen.getByText("Send"));
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      expect(mocks.send.mock.calls[0]?.[2]).toBe(runtimePermission);
      expect(mocks.send.mock.calls[0]?.[3]).toBe(chosenModel);
    },
  );

  it("uses execution identity over stale duplicate launch fields without requiring catalog membership", async () => {
    const futureModel = "gpt-future-model";
    render(
      <Harness
        initialMessage={{
          ...launchMessage(),
          providerExecutionIdentity: { ...identity, model: futureModel },
          runtimeModel: laterModel,
          builtinSelection: { providerId: "old-api", model: "mimo-v2.5" },
        }}
      />,
    );
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]?.[3]).toBe(futureModel);
    expect(mocks.send.mock.calls[0]?.[7]).toBeUndefined();
    expect(screen.getByTestId("model")).toHaveTextContent(futureModel);
  });

  it("waits for the launch runtime source, then sends once without waiting for metadata", async () => {
    const initialMessage = launchMessage();
    const view = render(
      <Harness source="system-cli" initialMessage={initialMessage} />,
    );
    await act(async () => {});
    expect(mocks.send).not.toHaveBeenCalled();
    view.rerender(
      <Harness source="managed-provider" initialMessage={initialMessage} />,
    );
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]?.[3]).toBe(chosenModel);
    view.rerender(
      <Harness source="managed-provider" initialMessage={initialMessage} />,
    );
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it.each(["identity-only", "source-only"] as const)(
    "recognizes a Managed adoption from %s metadata",
    async (shape) => {
      const get = mocks.get.getMockImplementation()!;
      mocks.get.mockImplementation(async (path: string) => {
        const response = await get(path);
        if (path !== "/api/session/config") return response;
        return shape === "identity-only"
          ? {
              ...response,
              runtimeSource: undefined,
              providerId: "old-api",
              model: "mimo-v2.5",
            }
          : { ...response, providerExecutionIdentity: undefined };
      });
      const adopted = vi.fn();
      render(
        <Harness
          sidecarConfigDisposition="adopt"
          onSidecarConfigAdopted={adopted}
        />,
      );
      await waitFor(() => expect(adopted).toHaveBeenCalledOnce());
      expect(screen.getByTestId("model")).toHaveTextContent(chosenModel);
      expect(screen.getByTestId("provider")).toHaveTextContent("codex-sub");
      fireEvent.click(screen.getByText("Send"));
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      expect(mocks.send.mock.calls[0]?.[3]).toBe(chosenModel);
    },
  );

  it.each(["builtin", "dsh"] as const)(
    "keeps the existing %s model fallback when the launch has no explicit selection",
    async (runtime) => {
      render(
        <Harness
          runtime={runtime}
          source={runtime === "dsh" ? "integrated" : null}
          initialMessage={{ text: "feedback" }}
        />,
      );
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      expect(mocks.send.mock.calls[0]?.[3]).toBe("mimo-v2.5");
      expect(mocks.send.mock.calls[0]?.[7]).toMatchObject({
        providerId: "old-api",
        model: "mimo-v2.5",
      });
    },
  );

  it.each(["builtin", "dsh", "codex"] as const)(
    "preserves %s launch selection and send routing",
    async (runtime) => {
      const external = runtime === "codex";
      const source = external
        ? "system-cli"
        : runtime === "dsh"
          ? "integrated"
          : null;
      render(
        <Harness
          runtime={runtime}
          source={source}
          initialMessage={{
            text: "launch",
            // A CLI launch keeps its runtime model even if an old producer
            // carries a dormant product selection alongside it.
            ...(external ? { runtimeModel: chosenModel } : {}),
            builtinSelection: {
              providerId: "old-api",
              model: "explicit-api-model",
            },
          }}
        />,
      );
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      expect(mocks.send.mock.calls[0]?.[3]).toBe(
        external ? chosenModel : "explicit-api-model",
      );
      expect(mocks.send.mock.calls[0]?.[7]).toEqual(
        external
          ? undefined
          : {
              kind: "provider",
              providerId: "old-api",
              model: "explicit-api-model",
            },
      );
      expect(screen.getByTestId("model")).toHaveTextContent(
        external ? chosenModel : "explicit-api-model",
      );
    },
  );

  it.each(["builtin", "dsh", "codex"] as const)(
    "preserves %s adoption and ordinary sending",
    async (runtime) => {
      const external = runtime === "codex";
      const source = external
        ? "system-cli"
        : runtime === "dsh"
          ? "integrated"
          : null;
      const model = external ? chosenModel : "mimo-v2.5";
      const permission = external
        ? "full-auto"
        : runtime === "dsh"
          ? "workspace-autonomous"
          : "plan";
      const get = mocks.get.getMockImplementation()!;
      mocks.get.mockImplementation(async (path: string) =>
        path === "/api/session/config"
          ? {
              success: true,
              runtime,
              runtimeSource: source,
              model,
              permissionMode: permission,
              providerId: "old-api",
            }
          : get(path),
      );
      const adopted = vi.fn();
      const metadata: SessionMetadata = {
        ...ownedMetadata("before-adopt"),
        runtime,
        runtimeSource: source ?? undefined,
        providerExecutionIdentity: undefined,
        providerId: "old-api",
        permissionMode: permission,
        providerRoute: external
          ? undefined
          : { kind: "provider", providerId: "old-api", model: "before-adopt" },
      };
      render(
        <Harness
          runtime={runtime}
          source={source}
          metadata={metadata}
          sidecarConfigDisposition="adopt"
          onSidecarConfigAdopted={adopted}
        />,
      );
      await waitFor(() => expect(adopted).toHaveBeenCalledOnce());
      expect(screen.getByTestId("model")).toHaveTextContent(model);
      expect(screen.getByTestId("permission")).toHaveTextContent(permission);
      fireEvent.click(screen.getByText("Send"));
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      expect(mocks.send.mock.calls[0]?.[3]).toBe(model);
      expect(mocks.send.mock.calls[0]?.[2]).toBe(permission);
    },
  );

  it("lets an explicit model switch update the owned snapshot and subsequent send", async () => {
    render(
      <Harness metadata={ownedMetadata()} sidecarConfigDisposition="push" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("model")).toHaveTextContent(chosenModel),
    );
    await act(async () => {
      await mocks.input?.onBuiltinModelSelect?.({
        providerId: "codex-sub",
        model: laterModel,
      });
    });
    expect(mocks.patchSession).toHaveBeenCalledWith(
      "session-selection",
      expect.objectContaining({
        providerExecutionIdentity: { ...identity, model: laterModel },
        model: laterModel,
      }),
      { type: "tab", id: "tab-selection" },
    );
    expect(screen.getByTestId("model")).toHaveTextContent(laterModel);
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]?.[3]).toBe(laterModel);
  });

  it.each([
    ["existing snapshot", true, false],
    ["same-millisecond publication", true, true],
    ["newly materialized snapshot", false, false],
  ] as const)(
    "keeps a committed model switch when an older Managed adoption finishes later (%s)",
    async (_scenario, hasInitialSnapshot, sameTimestamp) => {
      const get = mocks.get.getMockImplementation()!;
      const oldConfig = {
        ...(await get("/api/session/config")),
        permissionMode: "auto-edit",
      };
      let finishAdoption!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        finishAdoption = resolve;
      });
      mocks.get.mockImplementation((path: string) =>
        path === "/api/session/config" ? pending : get(path),
      );
      mocks.config.projects[0].providerId = "codex-sub";
      mocks.config.projects[0].model = chosenModel;
      if (sameTimestamp) {
        mocks.patchSession.mockImplementation(
          async (_id: string, patch: Partial<SessionMetadata>) => ({
            ...ownedMetadata(),
            ...patch,
          }),
        );
      }
      const adopted = vi.fn();
      render(
        <Harness
          metadata={hasInitialSnapshot ? ownedMetadata() : null}
          sidecarConfigDisposition="adopt"
          onSidecarConfigAdopted={adopted}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("model")).toHaveTextContent(chosenModel),
      );
      await act(async () => {
        await mocks.input?.onBuiltinModelSelect?.({
          providerId: "codex-sub",
          model: laterModel,
        });
      });
      expect(mocks.patchSession).toHaveBeenCalledOnce();
      await act(async () => {
        finishAdoption(oldConfig);
        await pending;
      });
      expect(adopted).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByText("Send"));
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      expect(mocks.send.mock.calls[0]?.[3]).toBe(laterModel);
      expect(mocks.send.mock.calls[0]?.[2]).toBe("auto-edit");
    },
  );

  it("preserves committed permission and effort changes without skipping tool adoption", async () => {
    const get = mocks.get.getMockImplementation()!;
    const response = {
      ...(await get("/api/session/config")),
      mcpServerIds: ["adopted-mcp"],
      enabledOfficialToolIds: ["image-understanding"],
    };
    let finishAdoption!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finishAdoption = resolve;
    });
    mocks.get.mockImplementation((path: string) =>
      path === "/api/session/config" ? pending : get(path),
    );
    let metadata = ownedMetadata();
    // Snapshot publication can share a timestamp; the values carry the change.
    mocks.patchSession.mockImplementation(
      async (_id: string, patch: Partial<SessionMetadata>) => {
        metadata = { ...metadata, ...patch };
        return metadata;
      },
    );
    const adopted = vi.fn();
    render(
      <Harness
        metadata={metadata}
        sidecarConfigDisposition="adopt"
        onSidecarConfigAdopted={adopted}
      />,
    );
    await act(async () => {
      await mocks.input?.onPermissionModeChange?.("fullAgency");
    });
    await act(async () => {
      await mocks.input?.onReasoningEffortChange?.("high");
    });
    expect(mocks.patchSession).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishAdoption(response);
      await pending;
    });
    expect(adopted).toHaveBeenCalledOnce();
    expect(mocks.input?.permissionMode).toBe("fullAgency");
    expect(mocks.input?.reasoningEffort).toBe("high");
    expect(mocks.input?.workspaceMcpEnabled).toEqual(["adopted-mcp"]);
    expect(mocks.input?.workspaceOfficialToolEnabled).toEqual([
      "image-understanding",
    ]);
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]?.[2]).toBe("no-restrictions");
    expect(mocks.send.mock.calls[0]?.[6]).toBe("high");
  });

  it.each([true, false])(
    "keeps launch and follow-up payloads consistent when connected before adoption: %s",
    async (connected) => {
      const initialMessage = launchMessage();
      const adopted = vi.fn();
      const consumed = vi.fn();
      const view = render(
        <Harness
          connected={connected}
          initialMessage={initialMessage}
          onInitialMessageConsumed={consumed}
          sidecarConfigDisposition="adopt"
          onSidecarConfigAdopted={adopted}
        />,
      );
      await waitFor(() => expect(adopted).toHaveBeenCalledOnce());
      if (!connected) {
        expect(mocks.send).not.toHaveBeenCalled();
        view.rerender(
          <Harness
            initialMessage={initialMessage}
            onInitialMessageConsumed={consumed}
            sidecarConfigDisposition="push"
          />,
        );
      }
      await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      expect(mocks.send.mock.calls[0]?.[3]).toBe(chosenModel);
      expect(consumed).toHaveBeenCalledOnce();
      view.rerender(<Harness sidecarConfigDisposition="push" />);
      fireEvent.click(screen.getByText("Send"));
      await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
      expect(mocks.send.mock.calls[1]?.[3]).toBe(chosenModel);
    },
  );
});
