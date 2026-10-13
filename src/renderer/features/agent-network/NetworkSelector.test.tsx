import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { NetworkRegistry } from "@/api/agentNetwork";
const calls = vi.hoisted(() => ({
  select: vi.fn(),
  join: vi.fn(),
  ownedStart: vi.fn(),
  ownedOpen: vi.fn(),
  ownedPoll: vi.fn(),
  ownedCancel: vi.fn(),
  remove: vi.fn(),
  accept: vi.fn(),
}));
vi.mock("@/api/agentNetwork", async (original) => ({
  ...(await original<typeof import("@/api/agentNetwork")>()),
  selectNetworkConnection: calls.select,
  joinNetworkConnection: calls.join,
  startOwnedNetworkLogin: calls.ownedStart,
  openOwnedNetworkAuthorization: calls.ownedOpen,
  pollOwnedNetworkLogin: calls.ownedPoll,
  cancelOwnedNetworkLogin: calls.ownedCancel,
  removeNetworkConnection: calls.remove,
}));
vi.mock("./store", () => ({ acceptNetworkRegistry: calls.accept }));
import { NetworkSelector } from "./NetworkSelector";
const registry: NetworkRegistry = {
  selfhostEnabled: true,
  selected: "official",
  connections: ["official", "self-a", "self-b"].map((id) => ({
    id,
    name:
      id === "official" ? "MyAgents" : id === "self-a" ? "Team A" : "Team B",
    official: id === "official",
    url: null,
    removing: false,
    snapshot: {
      connectionId: id,
      state: "ready",
      principalId: id,
      networkId: id,
      error: null,
      revision: 1,
      authGeneration: 1,
    },
  })),
};
beforeEach(() => {
  vi.resetAllMocks();
  calls.select.mockResolvedValue({ ...registry, selected: "self-a" });
  calls.join.mockRejectedValue({ code: "ENROLLMENT_KEY_EXPIRED" });
  calls.ownedStart.mockResolvedValue({
    attemptId: "attempt-1",
    authorizationUrl: "https://login.example.test/authorize?state=opaque",
    expiresAt: 1_900_000_000,
  });
  calls.ownedOpen.mockResolvedValue(undefined);
  calls.ownedPoll.mockResolvedValue({ status: "pending" });
  calls.ownedCancel.mockResolvedValue(undefined);
});
it("defaults to the original official heading without network controls", () => {
  render(<NetworkSelector registry={{ ...registry, selfhostEnabled: undefined }} />);
  expect(screen.getByRole("heading", {name: "AgentNet 局域网络"})).toBeInTheDocument();
  expect(screen.queryByRole("button", {name: "选择网络"})).not.toBeInTheDocument();
});
it("disabling the gate unmounts an open join dialog and reopening starts clean", async () => {
  const view = render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", {name: "选择网络"}));
  fireEvent.click(await screen.findByRole("menuitem", {name: "加入自部署网络"}));
  fireEvent.click(screen.getByRole("tab", { name: "设备 key（旧方式）" }));
  expect(screen.getByLabelText("设备 key")).toBeInTheDocument();
  view.rerender(<NetworkSelector registry={{...registry, selfhostEnabled: false}} />);
  expect(screen.queryByLabelText("设备 key")).not.toBeInTheDocument();
  view.rerender(<NetworkSelector registry={registry} />);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("设备 key")).not.toBeInTheDocument();
});
it("switches only the selected view and never removes or reenrolls another connection", async () => {
  render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /Team A/ }));
  await waitFor(() => expect(calls.select).toHaveBeenCalledWith("self-a"));
  expect(calls.remove).not.toHaveBeenCalled();
  expect(calls.join).not.toHaveBeenCalled();
  expect(calls.accept).toHaveBeenCalledWith(
    expect.objectContaining({
      selected: "self-a",
      connections: registry.connections,
    }),
  );
});
it("retains the URL but clears enrollment material after a refused join", async () => {
  render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "加入自部署网络" }),
  );
  fireEvent.click(screen.getByRole("tab", { name: /设备 key/ }));
  const url = screen.getByLabelText("服务 URL");
  const key = screen.getByLabelText("设备 key");
  fireEvent.change(url, { target: { value: "https://hub.example.test" } });
  fireEvent.change(key, { target: { value: "ephemeral-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "加入网络" }));
  await screen.findByRole("alert");
  expect(url).toHaveValue("https://hub.example.test");
  expect(key).toHaveValue("");
  expect(calls.join).toHaveBeenCalledWith(
    "https://hub.example.test",
    "ephemeral-test-key",
  );
  expect(calls.accept).not.toHaveBeenCalled();
});

it("uses browser account sign-in by default and polls without exposing a token", async () => {
  calls.ownedPoll.mockResolvedValue({ status: "authenticated", registry });
  render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "加入自部署网络" }));
  fireEvent.change(screen.getByLabelText("服务 URL"), {
    target: { value: "https://hub.example.test" },
  });
  fireEvent.click(screen.getByText("高级连接选项"));
  fireEvent.change(screen.getByLabelText("公共 HTTPS CA 证书文件（可选）"), {
    target: { value: "/tmp/agentnet-test-ca.pem" },
  });
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中继续" }));
  expect(await screen.findByText("等待浏览器登录")).toBeInTheDocument();
  expect(calls.ownedStart).toHaveBeenCalledWith("https://hub.example.test", "/tmp/agentnet-test-ca.pem");
  expect(screen.getByText(/authorize\?state=opaque/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "打开浏览器" }));
  await waitFor(() => expect(calls.ownedOpen).toHaveBeenCalledWith("attempt-1"));
  fireEvent.click(screen.getByRole("button", { name: "检查登录状态" }));
  await waitFor(() => expect(calls.ownedPoll).toHaveBeenCalledWith("attempt-1"));
  expect(calls.accept).toHaveBeenCalledWith(registry);
  expect(screen.queryByLabelText("设备 key")).not.toBeInTheDocument();
});

it("cancels a pending owned attempt when the dialog is closed", async () => {
  render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "加入自部署网络" }));
  fireEvent.change(screen.getByLabelText("服务 URL"), {
    target: { value: "https://hub.example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中继续" }));
  await screen.findByText("等待浏览器登录");
  fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
  await waitFor(() => expect(calls.ownedCancel).toHaveBeenCalledWith("attempt-1"));
});
