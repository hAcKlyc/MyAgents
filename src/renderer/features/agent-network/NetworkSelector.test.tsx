import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { NetworkRegistry } from "@/api/agentNetwork";
const calls = vi.hoisted(() => ({
  select: vi.fn(),
  join: vi.fn(),
  ownedStart: vi.fn(),
  ownedOpen: vi.fn(),
  ownedPoll: vi.fn(),
  ownedCancel: vi.fn(),
  restoreCredentials: vi.fn(),
  cancelRestore: vi.fn(),
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
  restoreOwnedCredentials: calls.restoreCredentials,
  cancelOwnedCredentialRestore: calls.cancelRestore,
  removeNetworkConnection: calls.remove,
}));
vi.mock("./store", () => ({ acceptNetworkRegistry: calls.accept }));
import { NetworkSelector } from "./NetworkSelector";
const registry: NetworkRegistry = {
  revision: 11,
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
  calls.restoreCredentials.mockResolvedValue({ ...registry, revision: 12 });
  calls.cancelRestore.mockResolvedValue(undefined);
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

it("offers restore only for the selected owned connection with the exact authorization error", () => {
  const ownedError = {
    code: "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED",
    retryable: false,
  };
  const scoped: NetworkRegistry = {
    ...registry,
    selected: "self-a",
    connections: registry.connections.map((connection) =>
      connection.id === "self-a"
        ? { ...connection, snapshot: { ...connection.snapshot, error: ownedError } }
        : connection.id === "self-b"
          ? { ...connection, snapshot: { ...connection.snapshot, error: ownedError } }
          : connection,
    ),
  };
  const view = render(<NetworkSelector registry={scoped} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  expect(screen.getByRole("menuitem", { name: "授权并恢复" })).toBeInTheDocument();
  view.rerender(
    <NetworkSelector
      registry={{ ...scoped, selected: "official" }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  expect(screen.queryByRole("menuitem", { name: "授权并恢复" })).not.toBeInTheDocument();
  view.rerender(
    <NetworkSelector
      registry={{
        ...scoped,
        selected: "self-a",
        connections: scoped.connections.map((connection) =>
          connection.id === "self-a"
            ? { ...connection, snapshot: { ...connection.snapshot, error: { code: "NETWORK_CREDENTIAL_STORE_UNAVAILABLE", retryable: false } } }
            : connection,
        ),
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  expect(screen.queryByRole("menuitem", { name: "授权并恢复" })).not.toBeInTheDocument();
});

it("requires explicit confirmation and restores only the selected existing connection", async () => {
  const target: NetworkRegistry = {
    ...registry,
    selected: "self-a",
    connections: registry.connections.map((connection) =>
      connection.id === "self-a"
        ? {
            ...connection,
            url: "https://login.example.test/dex?access_token=must-not-display",
            snapshot: {
              ...connection.snapshot,
              error: {
                code: "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED",
                retryable: false,
              },
            },
          }
        : connection,
    ),
  };
  render(<NetworkSelector registry={target} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "授权并恢复" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Team A");
  expect(screen.getByRole("dialog")).toHaveTextContent("https://login.example.test/dex");
  expect(screen.queryByText(/access_token/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/密码|password/i)).not.toBeInTheDocument();
  expect(calls.restoreCredentials).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "继续并授权" }));
  await waitFor(() => expect(calls.restoreCredentials).toHaveBeenCalledWith({
    connectionId: "self-a",
    expectedRegistryRevision: 11,
    operationId: expect.any(String),
  }));
  await waitFor(() => expect(calls.accept).toHaveBeenCalledWith({ ...registry, revision: 12 }));
  expect(calls.join).not.toHaveBeenCalled();
  expect(calls.ownedStart).not.toHaveBeenCalled();
});

it("cancels an in-flight restore when closed and ignores its late result", async () => {
  let resolveRestore!: (value: NetworkRegistry) => void;
  calls.restoreCredentials.mockImplementationOnce(
    () => new Promise((resolve) => { resolveRestore = resolve; }),
  );
  const target: NetworkRegistry = {
    ...registry,
    selected: "self-a",
    connections: registry.connections.map((connection) =>
      connection.id === "self-a"
        ? { ...connection, snapshot: { ...connection.snapshot, error: { code: "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED", retryable: false } } }
        : connection,
    ),
  };
  render(<NetworkSelector registry={target} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "授权并恢复" }));
  fireEvent.click(screen.getByRole("button", { name: "继续并授权" }));
  await waitFor(() => expect(calls.restoreCredentials).toHaveBeenCalledOnce());
  const request = calls.restoreCredentials.mock.calls[0][0];
  fireEvent.click(screen.getByRole("button", { name: "取消恢复" }));
  await waitFor(() => expect(calls.cancelRestore).toHaveBeenCalledWith(request.operationId));
  resolveRestore({ ...registry, revision: 12 });
  await Promise.resolve();
  expect(calls.accept).not.toHaveBeenCalled();
});

it("cancels active restore if the selected connection changes", async () => {
  calls.restoreCredentials.mockImplementationOnce(() => new Promise(() => {}));
  const target: NetworkRegistry = {
    ...registry,
    selected: "self-a",
    connections: registry.connections.map((connection) =>
      connection.id === "self-a"
        ? { ...connection, snapshot: { ...connection.snapshot, error: { code: "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED", retryable: false } } }
        : connection,
    ),
  };
  const view = render(<NetworkSelector registry={target} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "授权并恢复" }));
  fireEvent.click(screen.getByRole("button", { name: "继续并授权" }));
  await waitFor(() => expect(calls.restoreCredentials).toHaveBeenCalledOnce());
  view.rerender(<NetworkSelector registry={{ ...target, selected: "self-b" }} />);
  await waitFor(() => expect(calls.cancelRestore).toHaveBeenCalledWith(
    calls.restoreCredentials.mock.calls[0][0].operationId,
  ));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("cancels active restore when the selected connection identity generation changes", async () => {
  calls.restoreCredentials.mockImplementationOnce(() => new Promise(() => {}));
  const target: NetworkRegistry = {
    ...registry,
    selected: "self-a",
    connections: registry.connections.map((connection) =>
      connection.id === "self-a"
        ? { ...connection, snapshot: { ...connection.snapshot, error: { code: "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED", retryable: false } } }
        : connection,
    ),
  };
  const view = render(<NetworkSelector registry={target} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "授权并恢复" }));
  fireEvent.click(screen.getByRole("button", { name: "继续并授权" }));
  await waitFor(() => expect(calls.restoreCredentials).toHaveBeenCalledOnce());
  const next = {
    ...target,
    connections: target.connections.map((connection) =>
      connection.id === "self-a"
        ? { ...connection, snapshot: { ...connection.snapshot, authGeneration: 2 } }
        : connection,
    ),
  };
  view.rerender(<NetworkSelector registry={next} />);
  await waitFor(() => expect(calls.cancelRestore).toHaveBeenCalledWith(
    calls.restoreCredentials.mock.calls[0][0].operationId,
  ));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not cancel same-scope authorization for ordinary reconnect diagnostics", async () => {
  calls.restoreCredentials.mockImplementationOnce(() => new Promise(() => {}));
  const target: NetworkRegistry = {
    ...registry,
    selected: "self-a",
    connections: registry.connections.map((connection) =>
      connection.id === "self-a"
        ? { ...connection, snapshot: { ...connection.snapshot, error: { code: "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED", retryable: false } } }
        : connection,
    ),
  };
  const view = render(<NetworkSelector registry={target} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "授权并恢复" }));
  fireEvent.click(screen.getByRole("button", { name: "继续并授权" }));
  await waitFor(() => expect(calls.restoreCredentials).toHaveBeenCalledOnce());
  view.rerender(
    <NetworkSelector
      registry={{
        ...target,
        connections: target.connections.map((connection) =>
          connection.id === "self-a"
            ? {
                ...connection,
                snapshot: {
                  ...connection.snapshot,
                  state: "connecting",
                  error: null,
                  revision: connection.snapshot.revision + 1,
                  principalId: null,
                  networkId: null,
                },
              }
            : connection,
        ),
      }}
    />,
  );
  expect(calls.cancelRestore).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消恢复" }));
});

it("treats a ready event before the invoke response as completion and ignores the late response", async () => {
  let resolveRestore!: (value: NetworkRegistry) => void;
  calls.restoreCredentials.mockImplementationOnce(
    () => new Promise((resolve) => { resolveRestore = resolve; }),
  );
  const target: NetworkRegistry = {
    ...registry,
    selected: "self-a",
    connections: registry.connections.map((connection) =>
      connection.id === "self-a"
        ? { ...connection, snapshot: { ...connection.snapshot, error: { code: "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED", retryable: false } } }
        : connection,
    ),
  };
  const view = render(<NetworkSelector registry={target} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "授权并恢复" }));
  fireEvent.click(screen.getByRole("button", { name: "继续并授权" }));
  await waitFor(() => expect(calls.restoreCredentials).toHaveBeenCalledOnce());
  view.rerender(
    <NetworkSelector
      registry={{
        ...target,
        revision: 12,
        connections: target.connections.map((connection) =>
          connection.id === "self-a"
            ? {
                ...connection,
                snapshot: {
                  ...connection.snapshot,
                  state: "ready",
                  error: null,
                  revision: connection.snapshot.revision + 1,
                },
              }
            : connection,
        ),
      }}
    />,
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(calls.cancelRestore).not.toHaveBeenCalled();
  resolveRestore({ ...registry, revision: 12 });
  await Promise.resolve();
  expect(calls.accept).not.toHaveBeenCalled();
});

it("shows only a fixed restore error and preserves the current registry on failure", async () => {
  calls.restoreCredentials.mockRejectedValueOnce({
    code: "NETWORK_CREDENTIAL_STORE_UNAVAILABLE",
    details: { secret: "must-not-render" },
  });
  const target: NetworkRegistry = {
    ...registry,
    selected: "self-a",
    connections: registry.connections.map((connection) =>
      connection.id === "self-a"
        ? { ...connection, snapshot: { ...connection.snapshot, error: { code: "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED", retryable: false } } }
        : connection,
    ),
  };
  render(<NetworkSelector registry={target} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "授权并恢复" }));
  fireEvent.click(screen.getByRole("button", { name: "继续并授权" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("系统凭据库暂不可用");
  expect(screen.queryByText(/must-not-render/)).not.toBeInTheDocument();
  expect(calls.restoreCredentials).toHaveBeenCalledOnce();
  expect(calls.accept).not.toHaveBeenCalled();
});

it("cancels an active restore when the selector unmounts", async () => {
  calls.restoreCredentials.mockImplementationOnce(() => new Promise(() => {}));
  const target: NetworkRegistry = {
    ...registry,
    selected: "self-a",
    connections: registry.connections.map((connection) =>
      connection.id === "self-a"
        ? { ...connection, snapshot: { ...connection.snapshot, error: { code: "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED", retryable: false } } }
        : connection,
    ),
  };
  const view = render(<NetworkSelector registry={target} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "授权并恢复" }));
  fireEvent.click(screen.getByRole("button", { name: "继续并授权" }));
  await waitFor(() => expect(calls.restoreCredentials).toHaveBeenCalledOnce());
  const request = calls.restoreCredentials.mock.calls[0][0];
  view.unmount();
  await waitFor(() => expect(calls.cancelRestore).toHaveBeenCalledWith(request.operationId));
});

it("cancels after the bounded authorization window without retrying", async () => {
  vi.useFakeTimers();
  calls.restoreCredentials.mockImplementationOnce(() => new Promise(() => {}));
  const target: NetworkRegistry = {
    ...registry,
    selected: "self-a",
    connections: registry.connections.map((connection) =>
      connection.id === "self-a"
        ? { ...connection, snapshot: { ...connection.snapshot, error: { code: "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED", retryable: false } } }
        : connection,
    ),
  };
  try {
    render(<NetworkSelector registry={target} />);
    fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "授权并恢复" }));
    fireEvent.click(screen.getByRole("button", { name: "继续并授权" }));
    expect(calls.restoreCredentials).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(180_000));
    expect(screen.getByRole("alert")).toHaveTextContent("等待系统凭据授权超时");
    expect(calls.cancelRestore).toHaveBeenCalledWith(
      calls.restoreCredentials.mock.calls[0][0].operationId,
    );
    expect(calls.restoreCredentials).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
