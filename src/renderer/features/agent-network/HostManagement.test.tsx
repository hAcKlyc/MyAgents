import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostAccess,
  HostManagementAdapter,
  HostReceipt,
  HostSnapshot,
} from "@/api/hostManagement";
import { HostManagement } from "./HostManagement";
import {
  clearAllHostManagementState,
  clearHostManagementScope,
  getHostDraft,
  getHostPending,
} from "./hostManagementState";

const locator = {
  connectionId: "fixture",
  principalId: "human-fixture",
  authGeneration: 2,
  networkId: "network-fixture",
  deviceId: "device-fixture",
};
const address = {
  ...locator,
  serviceId: "service-fixture",
  targetIdentityGeneration: 3,
};
function host(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    address,
    product: "host",
    online: true,
    initialization: "unconfigured",
    permissions: ["read", "configure", "operate"],
    capabilities: [
      "config.read",
      "provider.configure",
      "provider.credential.write",
      "provider.test",
    ],
    environment: {
      os: "Ubuntu 24.04",
      architecture: "x64",
      runtime: "Claude Agent SDK",
      workspaceCount: 0,
      agentCount: 0,
    },
    provider: {
      config: {
        baseUrl: "https://fixture.invalid/api",
        model: "model-fixture",
      },
      credentialConfigured: true,
      desiredRevision: 4,
      effectiveRevision: 4,
      applyState: "applied",
      effectScope: "newSession",
    },
    ...overrides,
  };
}
function receipt(
  status: HostReceipt["status"],
  mutationId: string,
  resource: HostReceipt["resource"] = "provider",
): HostReceipt {
  return {
    address,
    mutationId,
    resource,
    status,
    desiredRevision: 5,
    effectiveRevision: status === "applied" ? 5 : 4,
    effectScope: "newSession",
  };
}
function fixture(snapshot = host()) {
  return {
    inspect: vi.fn(
      async (): Promise<HostAccess> => ({ status: "ready", snapshot }),
    ),
    read: vi.fn(async () => snapshot),
    mutate: vi.fn<HostManagementAdapter["mutate"]>(),
    receipt: vi.fn<HostManagementAdapter["receipt"]>(),
    testProvider: vi.fn(async () => ({ ok: false })),
  } satisfies HostManagementAdapter;
}
async function mount(adapter = fixture(), online = true, strict = false) {
  const content = (
    <HostManagement locator={locator} online={online} adapter={adapter} />
  );
  const rendered = render(
    strict ? <StrictMode>{content}</StrictMode> : content,
  );
  fireEvent.click(screen.getByRole("button", { name: /Host 管理/ }));
  await screen.findByLabelText("默认模型");
  return { ...rendered, adapter };
}
function edit(model = "draft-model") {
  fireEvent.change(screen.getByLabelText("默认模型"), {
    target: { value: model },
  });
}
const save = () => screen.getByRole("button", { name: "保存 Provider" });
describe("Host management UI v0 seam (isolated fixtures only)", () => {
  beforeEach(() => clearAllHostManagementState());
  it("production adapter reports protocol unavailable without invoking a guessed command", async () => {
    render(<HostManagement locator={locator} online />);
    fireEvent.click(screen.getByRole("button", { name: /Host 管理/ }));
    expect(
      await screen.findByText(/当前客户端协议尚未提供/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("默认模型")).not.toBeInTheDocument();
  });
  it("all preparation pages remain protocol-gated and navigation supports keyboard focus", async () => {
    render(<HostManagement locator={locator} online />);
    fireEvent.click(screen.getByRole("button", { name: /Host 管理/ }));
    await screen.findByText(/当前客户端协议尚未提供/);
    const first = screen.getByRole("tab", { name: "环境 / Provider" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight", isComposing: true });
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "工作区 / Agent" })).toHaveFocus();
    for (const name of ["工作区 / Agent", "MCP / Skills", "审批", "日志"]) {
      fireEvent.click(screen.getByRole("tab", { name }));
      expect(screen.getByRole("tabpanel")).toHaveTextContent(
        "当前客户端协议尚未提供",
      );
      expect(
        screen.queryByRole("button", { name: "批准" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "保存资源配置" }),
      ).not.toBeInTheDocument();
    }
  });
  it("IME Enter and WebKit keyCode 229 do not save; an ordinary Enter submits once", async () => {
    const adapter = fixture();
    adapter.mutate.mockImplementation(async (_address, mutation) =>
      receipt("accepted", mutation.mutationId),
    );
    await mount(adapter);
    edit();
    const model = screen.getByLabelText("默认模型");
    fireEvent.keyDown(model, { key: "Enter", isComposing: true });
    fireEvent.keyDown(model, { key: "Enter", keyCode: 229 });
    expect(adapter.mutate).not.toHaveBeenCalled();
    fireEvent.keyDown(model, { key: "Enter" });
    fireEvent.keyDown(model, { key: "Enter" });
    expect(adapter.mutate).toHaveBeenCalledOnce();
    await screen.findByText(/尚未确认持久化/);
  });
  it("read-only grants do not acquire configure or operate from Agent callability", async () => {
    const adapter = fixture(host({ permissions: ["read", "approve"] }));
    await mount(adapter);
    expect(screen.getByLabelText("默认模型")).toBeDisabled();
    expect(save()).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "测试已生效配置" }),
    ).toBeDisabled();
    expect(adapter.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/此 Host 尚无 Agent/)).toBeInTheDocument();
  });
  it("denies reading if capability or grant is absent and rejects a mismatched identity", async () => {
    const adapter = fixture(host({ permissions: [] }));
    const first = render(
      <HostManagement locator={locator} online adapter={adapter} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Host 管理/ }));
    expect(
      await screen.findByText(/当前身份没有设备管理读取权限/),
    ).toBeInTheDocument();
    first.unmount();
    adapter.inspect.mockResolvedValue({
      status: "ready",
      snapshot: host({ address: { ...address, deviceId: "another-device" } }),
    });
    render(<HostManagement locator={locator} online adapter={adapter} />);
    fireEvent.click(screen.getByRole("button", { name: /Host 管理/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取");
  });
  it("retains draft while offline and across closing; invalid input never submits", async () => {
    const { adapter, rerender, unmount } = await mount();
    edit();
    rerender(
      <HostManagement locator={locator} online={false} adapter={adapter} />,
    );
    expect(screen.getByLabelText("默认模型")).toHaveValue("draft-model");
    expect(save()).toBeDisabled();
    fireEvent.click(save());
    expect(adapter.mutate).not.toHaveBeenCalled();
    unmount();
    await mount(adapter);
    expect(screen.getByLabelText("默认模型")).toHaveValue("draft-model");
    fireEvent.change(screen.getByLabelText("API 地址（HTTPS）"), {
      target: { value: "https://user:password@fixture.invalid" },
    });
    expect(save()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("有效的 HTTPS");
  });
  it("prevents duplicate mutations and reopening queries only the original mutationId", async () => {
    const adapter = fixture();
    let finish!: (value: HostReceipt) => void;
    adapter.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = await mount(adapter);
    edit();
    fireEvent.click(save());
    fireEvent.click(screen.getByRole("button", { name: "处理中…" }));
    expect(adapter.mutate).toHaveBeenCalledOnce();
    const mutation = adapter.mutate.mock.calls[0][1];
    expect(mutation).toEqual({
      resource: "provider",
      mutationId: expect.any(String),
      expectedRevision: 4,
      patch: { baseUrl: "https://fixture.invalid/api", model: "draft-model" },
    });
    first.unmount();
    await act(async () => finish(receipt("applied", mutation.mutationId)));
    adapter.receipt.mockResolvedValue(
      receipt("unconfirmed", mutation.mutationId),
    );
    await mount(adapter);
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "查询原操作回执" }));
    await waitFor(() =>
      expect(adapter.receipt).toHaveBeenCalledWith(
        address,
        mutation.mutationId,
        expect.any(AbortSignal),
      ),
    );
    expect(adapter.mutate).toHaveBeenCalledOnce();
    expect(getHostPending(address)?.mutationId).toBe(mutation.mutationId);
  });
  it("transport failures remain unconfirmed; a foreign receipt cannot unlock resubmission", async () => {
    const adapter = fixture();
    adapter.mutate.mockRejectedValue(new Error("transport"));
    await mount(adapter);
    edit();
    fireEvent.click(save());
    expect(await screen.findByText(/保存结果尚未确认/)).toBeInTheDocument();
    const id = adapter.mutate.mock.calls[0][1].mutationId;
    adapter.receipt.mockResolvedValue({
      ...receipt("applied", id),
      address: { ...address, targetIdentityGeneration: 4 },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询原操作回执" }));
    await waitFor(() => expect(adapter.receipt).toHaveBeenCalledOnce());
    expect(save()).toBeDisabled();
    expect(getHostPending(address)?.mutationId).toBe(id);
  });
  it("accepted is not saved; persisted uses owner readback and retains the new-Session boundary", async () => {
    const adapter = fixture();
    adapter.mutate.mockImplementation(async (_address, mutation) =>
      receipt("accepted", mutation.mutationId),
    );
    await mount(adapter);
    edit();
    fireEvent.click(save());
    expect(await screen.findByText(/尚未确认持久化/)).toBeInTheDocument();
    expect(screen.queryByText(/Host 已保存。/)).not.toBeInTheDocument();
    const id = adapter.mutate.mock.calls[0][1].mutationId;
    adapter.receipt.mockResolvedValue(receipt("persisted", id));
    const next = host();
    next.provider = {
      ...next.provider,
      config: { ...next.provider.config, model: "draft-model" },
      desiredRevision: 5,
      applyState: "pending",
    };
    adapter.read.mockResolvedValue(next);
    fireEvent.click(screen.getByRole("button", { name: "查询原操作回执" }));
    expect(await screen.findByText(/已保存待生效/)).toBeInTheDocument();
    expect(screen.getByText(/已有 Session 保留出生时/)).toBeInTheDocument();
    expect(getHostPending(address)).toBeUndefined();
    expect(getHostDraft(address)).toBeUndefined();
    expect(
      screen.getByRole("button", { name: "测试已生效配置" }),
    ).toBeDisabled();
  });
  it("persisted with failed readback pauses further mutations rather than claiming verified state", async () => {
    const adapter = fixture();
    adapter.mutate.mockImplementation(async (_address, mutation) =>
      receipt("persisted", mutation.mutationId),
    );
    adapter.read.mockRejectedValue(new Error("read unavailable"));
    await mount(adapter);
    edit();
    fireEvent.click(save());
    expect(await screen.findByText(/尚未读回配置/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(screen.getByLabelText("默认模型")).toHaveValue("draft-model");
  });
  it("conflict preserves draft, requires explicit revision adoption and never auto-retries", async () => {
    const adapter = fixture();
    adapter.mutate.mockImplementation(async (_address, mutation) =>
      receipt("conflict", mutation.mutationId),
    );
    const latest = host();
    latest.provider = {
      ...latest.provider,
      config: { ...latest.provider.config, model: "other-client-model" },
      desiredRevision: 5,
    };
    adapter.read.mockResolvedValue(latest);
    await mount(adapter);
    edit();
    fireEvent.click(save());
    const reconcile = await screen.findByRole("button", {
      name: "保留草稿，采用最新修订",
    });
    expect(screen.getByLabelText("默认模型")).toHaveValue("draft-model");
    expect(save()).toBeDisabled();
    expect(adapter.mutate).toHaveBeenCalledOnce();
    fireEvent.click(reconcile);
    fireEvent.click(save());
    expect(adapter.mutate.mock.calls[1][1].expectedRevision).toBe(5);
    expect(adapter.mutate.mock.calls[1][1].mutationId).not.toBe(
      adapter.mutate.mock.calls[0][1].mutationId,
    );
  });
  it("failed conflict readback blocks retries until a latest-state read succeeds", async () => {
    const adapter = fixture();
    adapter.mutate.mockImplementation(async (_address, mutation) =>
      receipt("conflict", mutation.mutationId),
    );
    adapter.read.mockRejectedValue(new Error("read unavailable"));
    await mount(adapter);
    edit();
    fireEvent.click(save());
    expect(await screen.findByText(/尚未读到最新状态/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(adapter.mutate).toHaveBeenCalledOnce();
  });
  it("credentials are write-only and not retained after closing; successful credential save updates CAS", async () => {
    const adapter = fixture();
    adapter.mutate.mockImplementation(async (_address, mutation) =>
      receipt("applied", mutation.mutationId, "credential"),
    );
    const next = host();
    next.provider = {
      ...next.provider,
      desiredRevision: 5,
      effectiveRevision: 5,
    };
    adapter.read.mockResolvedValue(next);
    const first = await mount(adapter);
    const input = screen.getByLabelText("API Key（只写）");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, {
      target: { value: "synthetic-key-not-a-credential" },
    });
    fireEvent.click(screen.getByRole("button", { name: "写入凭据" }));
    expect(
      await screen.findByText(/Host 确认该修改已生效/),
    ).toBeInTheDocument();
    expect(input).toHaveValue("");
    edit();
    expect(getHostDraft(address)?.expectedRevision).toBe(5);
    fireEvent.change(input, { target: { value: "another-synthetic-key" } });
    first.unmount();
    await mount(adapter);
    expect(screen.getByLabelText("API Key（只写）")).toHaveValue("");
    clearHostManagementScope(locator.principalId, locator.networkId);
    expect(getHostDraft(address)).toBeUndefined();
  });
  it("tests the effective Host revision only and shows a sanitized failure", async () => {
    const adapter = fixture();
    await mount(adapter);
    fireEvent.click(screen.getByRole("button", { name: "测试已生效配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Host 测试失败");
    expect(adapter.testProvider).toHaveBeenCalledWith(
      address,
      4,
      expect.any(AbortSignal),
    );
    edit();
    expect(
      screen.getByRole("button", { name: "测试已生效配置" }),
    ).toBeDisabled();
  });
  it("latest owner status updates after StrictMode remount and revoked read permission hides the form", async () => {
    const adapter = fixture();
    await mount(adapter, true, true);
    adapter.read.mockResolvedValue(host({ initialization: "error" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "读取最新状态" }));
      await adapter.read.mock.results.at(-1)?.value;
    });
    expect(adapter.read).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("button", { name: /Host 管理\s*异常/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "读取最新状态" })).toBeEnabled();
    adapter.read.mockResolvedValue(host({ permissions: [] }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "读取最新状态" }));
      await adapter.read.mock.results.at(-1)?.value;
    });
    expect(
      await screen.findByText(/当前身份没有设备管理读取权限/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("默认模型")).not.toBeInTheDocument();
  });
});
