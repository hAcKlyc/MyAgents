import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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
});
it("clears the write-only credential, submits once and reads the actual owner after save", async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  let id = "";
  invoke.mockImplementation((_command, { request }) => {
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
    request.method === "host.snapshot"
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
    request.method === "host.snapshot"
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
