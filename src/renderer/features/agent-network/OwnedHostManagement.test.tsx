import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
const loadSource = vi.hoisted(() => vi.fn());
const prepareProfile = vi.hoisted(() => vi.fn(async (profile: { id: string; sourceProviderId?: string }) => ({ ...profile, id: `${profile.sourceProviderId ?? profile.id}-v-immutable` })));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./desktopHostConfigSource", () => ({ loadDesktopHostConfigSource: loadSource, versionPortableHostProfile: prepareProfile }));
import { OwnedHostManagement } from "./OwnedHostManagement";
import type { HostLocator } from "@/api/hostManagement";
import type { OwnedHostSnapshot } from "@/api/ownedHostManagement";
let serial = 0;
function fixture() {
  const locator: HostLocator = {
    connectionId: "owned:test",
    principalId: "p",
    networkId: "n",
    authGeneration: 1,
    deviceId: `d-${++serial}`,
  };
  const scope = {
    serviceId: "s",
    environment: "e",
    keyGeneration: 1,
    principalId: "p",
    networkId: "n",
    deviceId: locator.deviceId,
  };
  const snapshot: OwnedHostSnapshot = {
    kind: "snapshot",
    version: 1,
    hostId: locator.deviceId,
    configured: false,
    settings: null,
    activeSession: null,
    stopping: false,
    credentials: {
      providerId: "moonshot-coding",
      configured: false,
      revision: 0,
      writeAvailable: true,
    },
    resources: {
      version: 1,
      revision: 0,
      roots: [{ rootId: "workspaces", workspacePath: "/isolated/workspaces" }],
      agents: [],
    },
  };
  return { locator, scope, snapshot };
}
beforeEach(() => {
  invoke.mockReset();
  loadSource.mockReset();
  prepareProfile.mockReset();
  prepareProfile.mockImplementation(async profile => ({ ...profile, id: `${profile.sourceProviderId ?? profile.id}-v-immutable` }));
});
async function selectHostRoot() {
  const select = await screen.findByRole("button", { name: "选择此目录" });
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.click(select);
}
it("clears the write-only credential, submits once and reads the actual owner after save", async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  let id = "";
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.reject({ code: "HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE" });
    if (request.method === "host.snapshot")
      return Promise.resolve({ scope: f.scope, result: f.snapshot });
    expect(request.method).toBe("credential.set");
    expect(request.targetScope).toEqual(f.scope);
    expect(request.params.credential).toBe("synthetic-dom-key");
    id = request.params.mutationId;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  const credential = await screen.findByLabelText("Kimi API Key");
  fireEvent.change(credential, { target: { value: "synthetic-dom-key" } });
  const button = screen.getByRole("button", { name: "保存密钥" });
  fireEvent.click(button);
  fireEvent.submit(button.closest("form")!);
  expect(credential).toHaveValue("");
  expect(
    invoke.mock.calls.filter(
      ([, { request }]) => request.method === "credential.set",
    ),
  ).toHaveLength(1);
  f.snapshot.credentials = {
    ...f.snapshot.credentials,
    configured: true,
    revision: 1,
  };
  await act(async () => {
    finish({
      scope: f.scope,
      result: {
        kind: "credential-receipt",
        mutationId: id,
        status: "persisted",
        revision: 1,
        effect: "new-session",
      },
    });
  });
  expect(await screen.findByText(/Host 已保存密钥/)).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("已持久化保存。");
});
it("keeps the original unknown receipt across closing the panel without retaining or replaying the secret", async () => {
  const f = fixture();
  let originalId = "";
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.reject({ code: "HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE" });
    if (request.method === "host.snapshot")
      return Promise.resolve({ scope: f.scope, result: f.snapshot });
    if (request.method === "credential.set") {
      originalId = request.params.mutationId;
      return Promise.reject({ code: "HOST_MANAGEMENT_UNCONFIRMED" });
    }
    expect(request.method).toBe("receipt.get");
    expect(request.params).toEqual({
      owner: "credentials",
      mutationId: originalId,
    });
    return Promise.resolve({
      scope: f.scope,
      result: {
        kind: "credential-receipt",
        mutationId: originalId,
        status: "persisted",
        revision: 1,
        effect: "new-session",
      },
    });
  });
  const first = render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.change(await screen.findByLabelText("Kimi API Key"), {
    target: { value: "synthetic-private-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));
  await screen.findByText(/尚未确认保存结果/);
  first.unmount();
  render(<OwnedHostManagement locator={f.locator} online />);
  expect(await screen.findByLabelText("Kimi API Key")).toHaveValue("");
  expect(screen.getByRole("button", { name: "保存密钥" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "查询保存结果" }));
  await screen.findByText("已持久化保存。");
  expect(
    invoke.mock.calls.filter(
      ([, { request }]) => request.method === "credential.set",
    ),
  ).toHaveLength(1);
});
it("submits a nested Agent workspace using the resource revision and displays the returned registry", async () => {
  const f = fixture();
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.reject({ code: "HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE" });
    if (request.method === "host.snapshot")
      return Promise.resolve({ scope: f.scope, result: f.snapshot });
    expect(request.method).toBe("resources.create");
    expect(request.params).toMatchObject({
      operation: "create",
      rootId: "workspaces",
      relativePath: "agents/research",
      expectedRevision: 0,
    });
    f.snapshot.resources = {
      ...f.snapshot.resources,
      revision: 1,
      agents: [
        {
          agentId: "a",
          projectId: "project",
          name: "research",
          workspacePath: "/isolated/workspaces/agents/research",
          enabled: false,
          archived: false,
        },
      ],
    };
    return Promise.resolve({
      scope: f.scope,
      result: {
        kind: "resource-receipt",
        mutationId: request.params.mutationId,
        status: "persisted",
        revision: 1,
        effect: "registered-disabled-agent",
        resource: { created: true, ...f.snapshot.resources.agents[0] },
      },
    });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.change(await screen.findByLabelText("新 Agent 的工作区相对路径"), {
    target: { value: "../escape" },
  });
  expect(screen.getByRole("button", { name: "创建 Agent" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("新 Agent 的工作区相对路径"), {
    target: { value: "agents/research" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建 Agent" }));
  expect(await screen.findByText(/research · 已禁用/)).toBeInTheDocument();
});
it("suppresses a write completion across offline/online replacement and restores receipt controls", async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  let id = "";
  invoke.mockImplementation((_command, { request }) =>
    request.method === "host.capabilities"
      ? Promise.reject({ code: "HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE" })
      : request.method === "host.snapshot"
      ? Promise.resolve({ scope: f.scope, result: f.snapshot })
      : new Promise((resolve) => {
          id = request.params.mutationId;
          finish = resolve;
        }),
  );
  const view = render(<OwnedHostManagement locator={f.locator} online />);
  await screen.findByLabelText("Kimi 模型 ID");
  fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
  view.rerender(<OwnedHostManagement locator={f.locator} online={false} />);
  await act(async () => {
    finish({
      scope: f.scope,
      result: {
        kind: "config-receipt",
        mutationId: id,
        status: "persisted",
        revision: 1,
        effect: "new-session",
        settings: {
          revision: 1,
          providerId: "moonshot-coding",
          model: "kimi-for-coding",
          workspace: "/isolated/workspaces",
          executionAuthorized: false,
        },
      },
    });
  });
  expect(screen.queryByText("已持久化保存。")).not.toBeInTheDocument();
  view.rerender(<OwnedHostManagement locator={f.locator} online />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "查询保存结果" })).toBeEnabled(),
  );
  expect(screen.getByRole("button", { name: "保存模型配置" })).toBeDisabled();
});
it("clears an unsubmitted secret and isolates unresolved receipts when the signed target changes", async () => {
  const f = fixture();
  invoke.mockImplementation((_command, { request }) =>
    request.method === "host.capabilities"
      ? Promise.reject({ code: "HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE" })
      : request.method === "host.snapshot"
      ? Promise.resolve({ scope: { ...f.scope }, result: f.snapshot })
      : Promise.reject({ code: "HOST_MANAGEMENT_UNCONFIRMED" }),
  );
  render(<OwnedHostManagement locator={f.locator} online />);
  const field = await screen.findByLabelText("Kimi API Key");
  fireEvent.change(field, { target: { value: "old-target-private-draft" } });
  f.scope.keyGeneration++;
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(field).toHaveValue(""));
  expect(await screen.findByText(/设备身份已变化/)).toBeInTheDocument();
  fireEvent.change(field, { target: { value: "old-target-unknown-key" } });
  fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));
  await screen.findByText(/尚未确认保存结果/);
  f.scope.keyGeneration++;
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "查询保存结果" }),
    ).not.toBeInTheDocument(),
  );
  expect(field).toHaveValue("");
  expect(screen.getByRole("button", { name: "保存模型配置" })).toBeEnabled();
  expect(
    invoke.mock.calls.filter(
      ([, { request }]) => request.method === "credential.set",
    ),
  ).toHaveLength(1);
});

it("applies a fresh desktop source profile and credential as separate writes while keeping the key out of the UI", async () => {
  const f = fixture();
  const extended = {
    ...f.snapshot,
    kind: "extended-snapshot" as const,
    settings: null,
    provider: null,
    credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true },
  };
  const source = {
    agentName: "主 Agent",
    localWorkspacePath: "/Users/source/工作区",
    provider: { id: "portable", name: "Provider", apiProtocol: "openai" as const, baseUrl: "https://api.example.test/v1", authType: "api_key" as const },
    model: "model-1",
    credential: "synthetic-desktop-secret",
  };
  loadSource.mockResolvedValue(source);
  const calls: Array<{ method: string; params: { provider?: { id: string }; providerId?: string; workspace?: unknown; executionAuthorized?: boolean; credential?: string } }> = [];
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    if (request.method === "resources.directory.list") return Promise.resolve({ scope: f.scope, result: { kind: "directory-list", rootId: "workspaces", relativePath: request.params.relativePath, entries: [], nextCursor: null } });
    calls.push(request);
    return Promise.resolve({ scope: f.scope, result: { kind: request.method === "config.provider.set" ? "provider-config-receipt" : "provider-credential-receipt", status: "persisted", mutationId: request.params.mutationId, revision: 1, effect: "new-session", ...(request.method === "config.provider.set" ? { settings: { revision: 1, providerId: "portable", model: "model-1", workspace: { rootId: "workspaces", relativePath: "" }, executionAuthorized: false } } : {}) } });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "重新读取并应用桌面配置" }));
  await selectHostRoot();
  fireEvent.click(screen.getByRole("checkbox", { name: "允许本地会话执行" }));
  fireEvent.click(screen.getByRole("button", { name: "重新读取并应用桌面配置" }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls.map(call => call.method)).toEqual(["config.provider.set", "credential.provider.set"]);
  expect(calls[0].params.workspace).toEqual({ rootId: "workspaces", relativePath: "" });
  expect(calls[0].params.provider?.id).toBe("portable-v-immutable");
  expect(calls[0].params.executionAuthorized).toBe(false);
  expect(calls[1].params.providerId).toBe("portable-v-immutable");
  expect(calls[1].params.credential).toBe("synthetic-desktop-secret");
  fireEvent.click(screen.getByRole("button", { name: "保存 Provider 和目录" }));
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2].params.executionAuthorized).toBe(true);
  expect(document.body).not.toHaveTextContent("synthetic-desktop-secret");
  expect(document.body).toHaveTextContent("/Users/source/工作区");
});

it("recovers an uncertain versioned key receipt without resending the desktop secret", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true } };
  const profileId = "portable-v-immutable";
  loadSource.mockResolvedValue({ agentName: "主 Agent", localWorkspacePath: "/Users/source/工作区", provider: { id: "portable", name: "Provider", apiProtocol: "openai", baseUrl: "https://api.example.test/v1", authType: "api_key" }, model: "model-1", credential: "one-time-secret" });
  let keyMutation = "";
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["anthropic", "openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    if (request.method === "resources.directory.list") return Promise.resolve({ scope: f.scope, result: { kind: "directory-list", rootId: "workspaces", relativePath: request.params.relativePath, entries: [], nextCursor: null } });
    if (request.method === "config.provider.set") return Promise.resolve({ scope: f.scope, result: { kind: "provider-config-receipt", mutationId: request.params.mutationId, status: "persisted", revision: 1, effect: "new-session", settings: { revision: 1, providerId: profileId, model: "model-1", workspace: { rootId: "workspaces", relativePath: "" }, executionAuthorized: false } } });
    if (request.method === "credential.provider.set") { keyMutation = request.params.mutationId; expect(request.params.providerId).toBe(profileId); expect(request.params.credential).toBe("one-time-secret"); return Promise.reject({ code: "HOST_MANAGEMENT_UNCONFIRMED" }); }
    expect(request.method).toBe("receipt.provider.get");
    expect(request.params).toEqual({ owner: "credentials", providerId: profileId, mutationId: keyMutation });
    return Promise.resolve({ scope: f.scope, result: { kind: "provider-credential-receipt", mutationId: keyMutation, status: "persisted", revision: 1, effect: "new-session" } });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "重新读取并应用桌面配置" }));
  await selectHostRoot();
  fireEvent.click(screen.getByRole("button", { name: "重新读取并应用桌面配置" }));
  await screen.findByText(/配置已保存，但密钥/);
  fireEvent.click(screen.getByRole("button", { name: "查询保存结果" }));
  await screen.findByText("Host 密钥已保存；不会显示或读回密钥。");
  expect(invoke.mock.calls.filter(([, { request }]) => request.method === "credential.provider.set")).toHaveLength(1);
  expect(document.body).not.toHaveTextContent("one-time-secret");
});

it("saves a manual key against the persisted immutable profile ID after saving the draft", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true } };
  const submitted: Array<{ method: string; params: Record<string, unknown> }> = [];
  loadSource.mockResolvedValue({ agentName: "主 Agent", localWorkspacePath: "/Users/source/工作区", provider: { id: "portable", name: "Provider", apiProtocol: "openai", baseUrl: "https://api.example.test/v1", authType: "api_key" }, model: "model-1" });
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["anthropic", "openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    if (request.method === "resources.directory.list") return Promise.resolve({ scope: f.scope, result: { kind: "directory-list", rootId: "workspaces", relativePath: request.params.relativePath, entries: [], nextCursor: null } });
    submitted.push(request);
    const profileId = request.method === "config.provider.set" ? request.params.provider.id : "portable-v-immutable";
    return Promise.resolve({ scope: f.scope, result: { kind: request.method === "config.provider.set" ? "provider-config-receipt" : "provider-credential-receipt", mutationId: request.params.mutationId, status: "persisted", revision: 1, effect: "new-session", ...(request.method === "config.provider.set" ? { settings: { revision: 1, providerId: profileId, model: "model-1", workspace: { rootId: "workspaces", relativePath: "" }, executionAuthorized: false } } : {}) } });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "重新读取并应用桌面配置" }));
  await selectHostRoot();
  fireEvent.click(screen.getByRole("button", { name: "重新读取并应用桌面配置" }));
  const saveProfile = await screen.findByRole("button", { name: "保存 Provider 和目录" });
  await waitFor(() => expect(saveProfile).toBeEnabled());
  fireEvent.click(saveProfile);
  await waitFor(() => expect(submitted.some(item => item.method === "config.provider.set")).toBe(true));
  const keyField = screen.getByLabelText("Host API Key");
  await waitFor(() => expect(keyField).toBeEnabled());
  fireEvent.change(keyField, { target: { value: "manual-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));
  await waitFor(() => expect(submitted.some(item => item.method === "credential.provider.set")).toBe(true));
  expect(submitted.find(item => item.method === "config.provider.set")?.params.provider).toMatchObject({ id: "portable-v-immutable" });
  expect(submitted.find(item => item.method === "credential.provider.set")?.params).toMatchObject({ providerId: "portable-v-immutable", credential: "manual-secret" });
});

it("does not write a delayed desktop source into a replacement Host and deduplicates source reads", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true } };
  let resolveSource!: (value: unknown) => void;
  loadSource.mockImplementation(() => new Promise(resolve => { resolveSource = resolve; }));
  invoke.mockImplementation((_command, { request }) => {
    const targetScope = { ...f.scope, deviceId: request.deviceId };
    return request.method === "host.capabilities"
      ? Promise.resolve({ scope: targetScope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["anthropic", "openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } })
      : Promise.resolve({ scope: targetScope, result: { ...extended, hostId: request.deviceId } });
  });
  const view = render(<OwnedHostManagement locator={f.locator} online />);
  const apply = await screen.findByRole("button", { name: "重新读取并应用桌面配置" });
  fireEvent.click(apply);
  fireEvent.click(apply);
  expect(loadSource).toHaveBeenCalledTimes(1);
  const replacement = { ...f.locator, deviceId: "replacement-device" };
  view.rerender(<OwnedHostManagement locator={replacement} online />);
  await screen.findByRole("button", { name: "重新读取并应用桌面配置" });
  await act(async () => resolveSource({ agentName: "主 Agent", localWorkspacePath: "/Users/source/work", provider: { id: "portable", name: "Provider", apiProtocol: "openai", baseUrl: "https://api.example.test/v1", authType: "api_key" }, model: "model-1", credential: "secret" }));
  expect(invoke.mock.calls.some(([, { request }]) => request.method === "config.provider.set" || request.method === "credential.provider.set")).toBe(false);
});

it("browses and selects a Unicode directory through the Host API", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true } };
  const listedPaths: string[] = [];
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["anthropic", "openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    if (request.method === "resources.register") return Promise.resolve({ scope: f.scope, result: { kind: "resource-receipt", mutationId: request.params.mutationId, status: "persisted", revision: 1, effect: "registered-disabled-agent", resource: { created: false, agentId: "agent", projectId: "project", name: "资料", workspacePath: "/isolated/workspaces/中文 资料", enabled: false, archived: false } } });
    expect(request.method).toBe("resources.directory.list");
    const currentPath = request.params.relativePath as string;
    listedPaths.push(currentPath);
    return Promise.resolve({ scope: f.scope, result: { kind: "directory-list", rootId: "workspaces", relativePath: currentPath, entries: currentPath ? [] : [{ name: "中文 资料", relativePath: "中文 资料" }], nextCursor: null } });
  });
  const view = render(<OwnedHostManagement locator={f.locator} online />);
  const browse = await screen.findByRole("button", { name: "浏览 Host 目录" });
  browse.focus();
  fireEvent.click(browse);
  const dialog = await screen.findByRole("dialog");
  const close = screen.getByRole("button", { name: "关闭" });
  expect(close).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape", isComposing: true });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  const lastDialogButton = screen.getByRole("button", { name: "选择此目录" });
  await waitFor(() => expect(lastDialogButton).toBeEnabled());
  lastDialogButton.focus();
  fireEvent.keyDown(lastDialogButton, { key: "Tab" });
  expect(close).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(browse).toHaveFocus();
  fireEvent.click(browse);
  await waitFor(() => expect(listedPaths).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "刷新目录" }));
  await waitFor(() => expect(listedPaths).toHaveLength(3));
  view.rerender(<OwnedHostManagement locator={{ ...f.locator }} online />);
  await act(async () => { await Promise.resolve(); });
  expect(listedPaths).toHaveLength(3);
  fireEvent.click(await screen.findByRole("button", { name: /中文 资料/ }));
  const parentButton = screen.getByRole("button", { name: "上一级" });
  await waitFor(() => expect(parentButton).toBeEnabled());
  fireEvent.click(parentButton);
  await waitFor(() => expect(listedPaths).toHaveLength(5));
  fireEvent.click(await screen.findByRole("button", { name: /中文 资料/ }));
  const select = screen.getByRole("button", { name: "选择此目录" });
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.click(select);
  expect(await screen.findByDisplayValue("/isolated/workspaces/中文 资料")).toBeInTheDocument();
  expect(invoke.mock.calls.some(([, { request }]) => request.method === "resources.directory.list" && request.params.relativePath === "")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "将所选目录注册为禁用 Agent" }));
  await screen.findByText("已注册为禁用 Agent。");
  expect(invoke.mock.calls.some(([, { request }]) => request.method === "resources.register" && request.params.relativePath === "中文 资料")).toBe(true);
});

it("disables only actions whose required capabilities are absent", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true } };
  invoke.mockImplementation((_command, { request }) => request.method === "host.capabilities"
    ? Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.capabilities", "host.inspect", "config.provider.set", "resources.directory.list"], providerKinds: ["anthropic", "openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } })
    : Promise.resolve({ scope: f.scope, result: extended }));
  render(<OwnedHostManagement locator={f.locator} online />);
  expect(await screen.findByRole("button", { name: "手动配置 Provider" })).toBeDisabled();
  expect(screen.getByLabelText("Host API Key")).toBeDisabled();
  expect(screen.getByRole("button", { name: "创建子目录和禁用 Agent" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "将所选目录注册为禁用 Agent" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "浏览 Host 目录" })).toBeEnabled();
});

it("retries a failed first-page directory read on explicit refresh", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true } };
  let directoryCalls = 0;
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.capabilities", "host.inspect", "resources.directory.list"], providerKinds: ["anthropic", "openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    directoryCalls++;
    if (directoryCalls === 1) return Promise.reject({ code: "HOST_MANAGEMENT_NOT_COMPLETED" });
    return Promise.resolve({ scope: f.scope, result: { kind: "directory-list", rootId: "workspaces", relativePath: "", entries: [{ name: "retry 成功", relativePath: "retry 成功" }], nextCursor: null } });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "浏览 Host 目录" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "刷新目录" }));
  expect(await screen.findByRole("button", { name: /retry 成功/ })).toBeInTheDocument();
  expect(directoryCalls).toBe(2);
});

it("applies the supported profile but never sends a source key when credential capability is absent", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: true, revision: 1, writeAvailable: true } };
  const methods = ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"];
  loadSource.mockResolvedValue({ agentName: "主 Agent", localWorkspacePath: "/Users/source/work", provider: { id: "portable", name: "Provider", apiProtocol: "openai", baseUrl: "https://api.example.test/v1", authType: "api_key" }, model: "model-1", credential: "never-send-me" });
  const writes: string[] = [];
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods, providerKinds: ["anthropic", "openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    if (request.method === "resources.directory.list") return Promise.resolve({ scope: f.scope, result: { kind: "directory-list", rootId: "workspaces", relativePath: "", entries: [], nextCursor: null } });
    writes.push(request.method);
    return Promise.resolve({ scope: f.scope, result: { kind: "provider-config-receipt", mutationId: request.params.mutationId, status: "persisted", revision: 1, effect: "new-session", settings: { revision: 1, providerId: request.params.provider.id, model: "model-1", workspace: { rootId: "workspaces", relativePath: "" }, executionAuthorized: false } } });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "重新读取并应用桌面配置" }));
  await selectHostRoot();
  fireEvent.click(screen.getByRole("button", { name: "重新读取并应用桌面配置" }));
  await screen.findByText(/未开放密钥写入/);
  expect(writes).toEqual(["config.provider.set"]);
  expect(invoke.mock.calls.some(([, { request }]) => request.method === "credential.provider.set")).toBe(false);
  expect(document.body).not.toHaveTextContent("never-send-me");
});

it("adds and selects a Host model through the real controlled panel without local registry writes", async () => {
  const f = fixture();
  const portable = { id: "portable-v-immutable", sourceProviderId: "portable", name: "Provider", apiProtocol: "openai", baseUrl: "https://api.example.test/v1", authType: "api_key" };
  const extended = {
    ...f.snapshot,
    kind: "extended-snapshot" as const,
    configured: true,
    settings: { revision: 3, providerId: portable.id, model: "qa-first-model", workspace: { rootId: "workspaces", relativePath: "" }, executionAuthorized: false },
    provider: portable,
    credentials: { providerId: portable.id, configured: true, revision: 1, writeAvailable: true },
  };
  const submitted: Array<{ method: string; params: Record<string, unknown> }> = [];
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    submitted.push(request);
    return Promise.resolve({ scope: f.scope, result: { kind: "provider-config-receipt", mutationId: request.params.mutationId, status: "persisted", revision: 4, effect: "new-session", settings: { revision: 4, providerId: request.params.provider.id, model: request.params.model, workspace: request.params.workspace, executionAuthorized: false } } });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "管理模型" }));
  const modelInput = await screen.findByPlaceholderText("输入模型 ID，按 Enter 设置并添加");
  fireEvent.change(modelInput, { target: { value: "qa-second-model" } });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  await waitFor(() => expect(screen.getByText("qa-second-model")).toBeInTheDocument());
  expect(screen.queryByText("模型参数")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "设为首选" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "管理模型" }));
  const selectedCandidate = await screen.findByText("qa-second-model");
  expect(selectedCandidate.closest(".group")).toHaveTextContent("首选");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存 Provider 和目录" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存 Provider 和目录" }));
  await waitFor(() => expect(submitted.some(item => item.method === "config.provider.set")).toBe(true));
  expect(submitted.find(item => item.method === "config.provider.set")?.params).toMatchObject({ model: "qa-second-model" });
  expect(submitted.map(item => item.method)).toEqual(["config.provider.set"]);
});

it("allows key rotation during an active session while blocking profile writes", async () => {
  const f = fixture();
  const provider = { id: "portable-v-immutable", sourceProviderId: "portable", name: "Provider", apiProtocol: "openai", baseUrl: "https://api.example.test/v1", authType: "api_key" };
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: { revision: 3, providerId: provider.id, model: "qa-first-model", workspace: { rootId: "workspaces", relativePath: "" }, executionAuthorized: false }, provider, activeSession: { sessionId: "session", generation: "1", closing: false }, credentials: { providerId: provider.id, configured: true, revision: 1, writeAvailable: true } };
  const submitted: Array<{ method: string; params: Record<string, unknown> }> = [];
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    submitted.push(request);
    return Promise.resolve({ scope: f.scope, result: { kind: "provider-credential-receipt", mutationId: request.params.mutationId, status: "persisted", revision: 2, effect: "new-session" } });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  const profileSave = await screen.findByRole("button", { name: "保存 Provider 和目录" });
  expect(profileSave).toBeDisabled();
  const key = screen.getByLabelText("Host API Key");
  expect(key).toBeEnabled();
  fireEvent.change(key, { target: { value: "rotated-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  expect(submitted[0].method).toBe("credential.provider.set");
  expect(submitted[0].params.providerId).toBe(provider.id);
});

it("discards a delayed source read across an offline-online cycle before a newer import", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true } };
  const pending: Array<(value: unknown) => void> = [];
  loadSource.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  invoke.mockImplementation((_command, { request }) => request.method === "host.capabilities"
    ? Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["anthropic", "openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } })
    : Promise.resolve({ scope: f.scope, result: extended }));
  const view = render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "读取并应用桌面配置" }));
  await waitFor(() => expect(pending).toHaveLength(1));
  view.rerender(<OwnedHostManagement locator={f.locator} online={false} />);
  view.rerender(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "读取并应用桌面配置" }));
  await waitFor(() => expect(pending).toHaveLength(2));
  const source = { agentName: "Agent", localWorkspacePath: "/desktop/work", provider: { id: "portable", name: "Provider", apiProtocol: "openai", baseUrl: "https://api.example.test/v1", authType: "api_key" }, model: "qa-first-model" };
  await act(async () => { pending[0](source); await Promise.resolve(); });
  expect(invoke.mock.calls.some(([, { request }]) => request.method === "config.provider.set")).toBe(false);
  await act(async () => { pending[1](source); await Promise.resolve(); });
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(invoke.mock.calls.some(([, { request }]) => request.method === "config.provider.set")).toBe(false);
});

it("serializes duplicate manual profile saves while the version hash is pending", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true } };
  let finish!: (profile: { id: string; name: string; apiProtocol: "anthropic"; baseUrl: string; authType: "auth_token" }) => void;
  const writes: Array<Record<string, unknown>> = [];
  prepareProfile.mockImplementationOnce(_profile => new Promise(resolve => { finish = resolve as typeof finish; }));
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["anthropic"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    if (request.method === "resources.directory.list") return Promise.resolve({ scope: f.scope, result: { kind: "directory-list", rootId: "workspaces", relativePath: request.params.relativePath, entries: [], nextCursor: null } });
    if (request.method === "config.provider.set") writes.push(request.params);
    return Promise.resolve({ scope: f.scope, result: { kind: "provider-config-receipt", mutationId: request.params.mutationId, status: "persisted", revision: 1, effect: "new-session", settings: { revision: 1, providerId: request.params.provider.id, model: request.params.model, workspace: request.params.workspace, executionAuthorized: false } } });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "手动配置 Provider" }));
  fireEvent.click(await screen.findByRole("button", { name: "浏览 Host 目录" }));
  await selectHostRoot();
  const save = await screen.findByRole("button", { name: "保存 Provider 和目录" });
  fireEvent.click(save);
  fireEvent.click(save);
  await waitFor(() => expect(prepareProfile).toHaveBeenCalledTimes(1));
  await act(async () => { finish({ id: "manual", name: "Custom Provider", apiProtocol: "anthropic", baseUrl: "https://api.anthropic.com", authType: "auth_token" }); });
  await waitFor(() => expect(writes).toHaveLength(1));
});

it("shows actionable key failure without a receipt button after a confirmed rejection", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true } };
  loadSource.mockResolvedValue({ agentName: "Desktop Agent", localWorkspacePath: "/desktop/work", provider: { id: "portable", name: "Provider", apiProtocol: "openai", baseUrl: "https://api.example.test/v1", authType: "api_key" }, model: "model-1", credential: "one-time-key" });
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    if (request.method === "resources.directory.list") return Promise.resolve({ scope: f.scope, result: { kind: "directory-list", rootId: "workspaces", relativePath: request.params.relativePath, entries: [], nextCursor: null } });
    if (request.method === "config.provider.set") return Promise.resolve({ scope: f.scope, result: { kind: "provider-config-receipt", mutationId: request.params.mutationId, status: "persisted", revision: 1, effect: "new-session", settings: { revision: 1, providerId: request.params.provider.id, model: "model-1", workspace: request.params.workspace, executionAuthorized: false } } });
    if (request.method === "credential.provider.set") return Promise.reject({ code: "HOST_CREDENTIAL_WRITE_UNAVAILABLE" });
    throw new Error(`Unexpected operation ${request.method}`);
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "重新读取并应用桌面配置" }));
  await selectHostRoot();
  fireEvent.click(screen.getByRole("button", { name: "重新读取并应用桌面配置" }));
  expect(await screen.findByText("配置已保存，但密钥未更新。请查看 Host 密钥状态后重试。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "查询保存结果" })).not.toBeInTheDocument();
});

it("hydrates Host model choices from Desktop Host source candidates", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true } };
  loadSource.mockResolvedValue({ agentName: "Desktop Agent", localWorkspacePath: "/desktop/work", provider: { id: "portable", name: "Provider", apiProtocol: "openai", baseUrl: "https://api.example.test/v1", authType: "api_key" }, model: "qa-first-model", models: [{ model: "qa-first-model", modelName: "First", modelSeries: "custom" }, { model: "qa-second-model", modelName: "Second", modelSeries: "custom" }] });
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods: ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"], providerKinds: ["openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    if (request.method === "resources.directory.list") return Promise.resolve({ scope: f.scope, result: { kind: "directory-list", rootId: "workspaces", relativePath: request.params.relativePath, entries: [], nextCursor: null } });
    if (request.method === "config.provider.set") return Promise.resolve({ scope: f.scope, result: { kind: "provider-config-receipt", mutationId: request.params.mutationId, status: "persisted", revision: 1, effect: "new-session", settings: { revision: 1, providerId: request.params.provider.id, model: request.params.model, workspace: request.params.workspace, executionAuthorized: false } } });
    throw new Error(`Unexpected operation ${request.method}`);
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "读取并应用桌面配置" }));
  await selectHostRoot();
  fireEvent.click(screen.getByRole("button", { name: "重新读取并应用桌面配置" }));
  await waitFor(() => expect(invoke.mock.calls.some(([, { request }]) => request.method === "config.provider.set")).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: "管理模型" }));
  expect(await screen.findByText("Second")).toBeInTheDocument();
});

it("applies only the profile when credential methods exist but writeAvailable is false", async () => {
  const f = fixture();
  const extended = { ...f.snapshot, kind: "extended-snapshot" as const, settings: null, provider: null, credentials: { providerId: null, configured: false, revision: 0, writeAvailable: false } };
  const methods = ["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"];
  loadSource.mockResolvedValue({ agentName: "Desktop Agent", localWorkspacePath: "/desktop/work", provider: { id: "portable", name: "Provider", apiProtocol: "openai", baseUrl: "https://api.example.test/v1", authType: "api_key" }, model: "model-1", credential: "do-not-send-key" });
  const writes: string[] = [];
  invoke.mockImplementation((_command, { request }) => {
    if (request.method === "host.capabilities") return Promise.resolve({ scope: f.scope, result: { kind: "capabilities", version: 1, methods, providerKinds: ["openai"], limits: { directoryEntries: 128, pathBytes: 4096 } } });
    if (request.method === "host.inspect") return Promise.resolve({ scope: f.scope, result: extended });
    if (request.method === "resources.directory.list") return Promise.resolve({ scope: f.scope, result: { kind: "directory-list", rootId: "workspaces", relativePath: request.params.relativePath, entries: [], nextCursor: null } });
    writes.push(request.method);
    return Promise.resolve({ scope: f.scope, result: { kind: "provider-config-receipt", mutationId: request.params.mutationId, status: "persisted", revision: 1, effect: "new-session", settings: { revision: 1, providerId: request.params.provider.id, model: "model-1", workspace: request.params.workspace, executionAuthorized: false } } });
  });
  render(<OwnedHostManagement locator={f.locator} online />);
  fireEvent.click(await screen.findByRole("button", { name: "重新读取并应用桌面配置" }));
  await selectHostRoot();
  fireEvent.click(screen.getByRole("button", { name: "重新读取并应用桌面配置" }));
  await screen.findByText(/未开放密钥写入/);
  expect(writes).toEqual(["config.provider.set"]);
  expect(invoke.mock.calls.some(([, { request }]) => request.method === "credential.provider.set")).toBe(false);
  expect(document.body).not.toHaveTextContent("do-not-send-key");
});
