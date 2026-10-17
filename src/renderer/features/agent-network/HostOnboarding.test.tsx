import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CallableAgent,
  NetworkDevice,
  NetworkSnapshot,
} from "@/api/agentNetwork";
const mocks = vi.hoisted(() => ({
  devices: vi.fn(),
  callable: vi.fn(),
  open: vi.fn(),
  copy: vi.fn(),
  generation: 1,
}));
vi.mock("@/api/agentNetwork", () => ({
  allNetworkDevices: mocks.devices,
  allCallableAgents: mocks.callable,
}));
vi.mock("@/utils/openExternal", () => ({ openExternal: mocks.open }));
vi.mock("@/utils/clipboard", () => ({ copyPlainText: mocks.copy }));
vi.mock("./store", () => ({
  currentNetworkGeneration: () => mocks.generation,
}));
import { HostOnboarding, HOST_INSTALL_INSTRUCTIONS } from "./HostOnboarding";
const snapshot: NetworkSnapshot = {
  state: "ready",
  networkId: "network",
  principalId: "account",
  revision: 1,
  authGeneration: 1,
  error: null,
};
const device = {
  deviceId: "remote",
  networkId: "network",
  principalId: "account",
  name: "Linux-Host",
  joined: true,
  connectionState: "ready",
} as NetworkDevice;
const agent = {
  deviceId: "remote",
  mountId: "mount",
  source: { networkId: "network" },
} as CallableAgent;
const props = {
  connectionId: "owned",
  snapshot,
  networkName: "Team Network",
  serviceUrl: "https://network.example",
  official: false,
  localDeviceId: "local",
  onClose: vi.fn(),
  onManage: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.generation = 1;
  mocks.devices.mockResolvedValue({ items: [device], complete: true });
  mocks.callable.mockResolvedValue({ items: [], complete: true });
});
function next() {
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
}
async function reachCheck() {
  next();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "我已在目标设备完成安装" }),
  );
  next();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "我已在目标设备登录并加入网络" }),
  );
  next();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "刷新连接检查" })).toBeEnabled(),
  );
  if (
    screen
      .getByRole("button", { name: "选择要检查的目标设备" })
      .hasAttribute("disabled")
  )
    return;
  fireEvent.click(screen.getByRole("button", { name: "选择要检查的目标设备" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Linux-Host · remote" }),
  );
}
describe("Host onboarding", () => {
  it("requires explicit installation/login acknowledgements and never autoselects existing devices", async () => {
    render(<HostOnboarding {...props} />);
    next();
    expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    next();
    expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
    expect(screen.getByText("Team Network")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    next();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "刷新连接检查" }),
      ).toBeEnabled(),
    );
    expect(screen.getByText("请选择设备（名称与 ID）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成引导" })).toBeDisabled();
  });
  it("distinguishes an online empty Host from callable Agents and opens its management", async () => {
    render(<HostOnboarding {...props} />);
    await reachCheck();
    expect(screen.getByText("已在线")).toBeInTheDocument();
    expect(screen.getByText("尚无可调用 Agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成引导" })).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "打开设备并配置 Agent" }),
    );
    expect(props.onManage).toHaveBeenCalledWith(device);
  });
  it("does not claim actual execution when callable directory contains the target", async () => {
    mocks.callable.mockResolvedValue({ items: [agent], complete: true });
    render(<HostOnboarding {...props} />);
    await reachCheck();
    expect(screen.getByText("1 个可调用，执行待验证")).toBeInTheDocument();
    expect(mocks.callable).toHaveBeenCalledWith("network", "owned");
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it.each(["offline", "syncing"] as const)(
    "does not allow finish for %s even with stale callable entries",
    async (connectionState) => {
      mocks.devices.mockResolvedValue({
        items: [{ ...device, connectionState }],
        complete: true,
      });
      mocks.callable.mockResolvedValue({ items: [agent], complete: true });
      render(<HostOnboarding {...props} />);
      await reachCheck();
      expect(screen.getByRole("button", { name: "完成引导" })).toBeDisabled();
      expect(
        screen.queryByText("1 个可调用，执行待验证"),
      ).not.toBeInTheDocument();
    },
  );
  it("preserves online evidence independently when callable fails, and refresh recovers", async () => {
    mocks.callable.mockRejectedValue(new Error("offline"));
    render(<HostOnboarding {...props} />);
    await reachCheck();
    expect(screen.getByText("已在线")).toBeInTheDocument();
    expect(screen.getAllByText("查询失败，请刷新重试").length).toBeGreaterThan(
      0,
    );
    mocks.callable.mockResolvedValue({ items: [agent], complete: true });
    fireEvent.click(screen.getByRole("button", { name: "刷新连接检查" }));
    await screen.findByText("1 个可调用，执行待验证");
  });
  it("keeps a partial callable directory unknown instead of claiming no Agents", async () => {
    mocks.callable.mockResolvedValue({ items: [], complete: false });
    render(<HostOnboarding {...props} />);
    await reachCheck();
    expect(screen.queryByText("尚无可调用 Agent")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("目录不完整，请刷新；不能确认未列出的设备或 Agent。")
        .length,
    ).toBeGreaterThan(0);
  });
  it("rejects device responses for another account", async () => {
    mocks.devices.mockResolvedValue({
      items: [{ ...device, principalId: "someone-else" }],
      complete: true,
    });
    render(<HostOnboarding {...props} />);
    await reachCheck();
    expect(screen.getByRole("button", { name: "完成引导" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Linux-Host · remote" }),
    ).not.toBeInTheDocument();
  });
  it("invalidates previous success on disconnection and ignores late old responses", async () => {
    const view = render(<HostOnboarding {...props} />);
    await reachCheck();
    expect(screen.getByText("已在线")).toBeInTheDocument();
    let resolve!: (value: unknown) => void;
    mocks.devices.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新连接检查" }));
    view.rerender(
      <HostOnboarding
        {...props}
        snapshot={{ ...snapshot, state: "disconnected", revision: 2 }}
      />,
    );
    await act(async () => resolve({ items: [device], complete: true }));
    expect(screen.queryByText("已在线")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成引导" })).toBeDisabled();
  });
  it("provides test-scoped Linux instructions and copies only explicit enrollment commands", async () => {
    render(<HostOnboarding {...props} />);
    fireEvent.click(screen.getByRole("radio", { name: /Linux 服务器/ }));
    next();
    expect(
      screen.getByText(/当前没有适用于此网络的公开一键安装包/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "打开 Linux 安装说明" }),
    );
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith(HOST_INSTALL_INSTRUCTIONS),
    );
    fireEvent.click(screen.getByRole("checkbox"));
    next();
    fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
    await screen.findByText("已复制");
    expect(mocks.copy).toHaveBeenCalledWith(
      expect.stringContaining(
        "scripts/host/network-control.py --profile myagents-test start",
      ),
    );
    expect(mocks.copy.mock.calls[0][0]).not.toContain("https://");
  });
  it("handles copy failure and Escape dismissal", async () => {
    mocks.copy.mockRejectedValue(new Error("denied"));
    render(<HostOnboarding {...props} />);
    fireEvent.click(screen.getByRole("radio", { name: /Linux 服务器/ }));
    next();
    fireEvent.click(screen.getByRole("checkbox"));
    next();
    fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
    await screen.findByText("操作失败，请重试。");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
