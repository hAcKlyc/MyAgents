import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { NetworkRegistry } from "@/api/agentNetwork";

const mocks = vi.hoisted(() => ({
  registry: null as NetworkRegistry | null,
  accept: vi.fn(),
  start: vi.fn(),
  open: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(),
  remove: vi.fn(),
  connections: vi.fn(),
  openAgentNetwork: vi.fn(),
  toastError: vi.fn(),
  external: vi.fn(),
  helper: vi.fn(),
}));

vi.mock("@/features/agent-network/store", () => ({
  acceptNetworkRegistry: mocks.accept,
  useAgentNetworkRegistry: () => mocks.registry,
}));
vi.mock("@/api/agentNetwork", async (original) => ({
  ...(await original<typeof import("@/api/agentNetwork")>()),
  startOwnedNetworkLogin: mocks.start,
  openOwnedNetworkAuthorization: mocks.open,
  pollOwnedNetworkLogin: mocks.poll,
  cancelOwnedNetworkLogin: mocks.cancel,
  selectNetworkConnection: mocks.select,
  removeNetworkConnection: mocks.remove,
  networkConnections: mocks.connections,
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ error: mocks.toastError }),
}));

vi.mock("@/utils/openExternal", () => ({ openExternal: mocks.external }));

import OwnedAccountEntry from "./OwnedAccountEntry";

function accountAction(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(screen.getAllByRole("button", { name }).at(-1)!);
}

const makeRegistry = (ownedAccount?: {
  state: string;
  principalId: string;
  expiresAt: number | null;
}) =>
  ({
    revision: 2,
    selected: ownedAccount ? "owned-a" : "official",
    ownedServiceUrl: "https://login.example.test",
    connections: [
      {
        id: "official",
        name: "MyAgents",
        official: true,
        url: null,
        removing: false,
        snapshot: {
          connectionId: "official",
          state: "ready",
          principalId: "p",
          networkId: "n",
          error: null,
          revision: 1,
          authGeneration: 1,
        },
      },
      ...(ownedAccount
        ? [
            {
              id: "owned-a",
              name: "MoXBots Test",
              official: false,
              url: "https://login.example.test",
              removing: false,
              ownedAccount,
              snapshot: {
                connectionId: "owned-a",
                state: "disconnected",
                principalId: ownedAccount.principalId,
                networkId: "net",
                error: null,
                revision: 1,
                authGeneration: 1,
              },
            },
          ]
        : []),
    ],
  }) as unknown as NetworkRegistry;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registry = makeRegistry();
  mocks.start.mockResolvedValue({
    attemptId: "attempt-a",
    authorizationUrl: "https://login.example.test/authorize",
    expiresAt: 1_900_000_000,
  });
  mocks.open.mockResolvedValue(undefined);
  mocks.poll.mockResolvedValue({ status: "pending" });
  mocks.cancel.mockResolvedValue(undefined);
  mocks.select.mockImplementation(async () => mocks.registry);
  mocks.remove.mockResolvedValue(makeRegistry());
  mocks.connections.mockImplementation(async () => mocks.registry!);
});

it("shows a clear unconfigured state and does not call any login or official account flow", () => {
  mocks.registry = {
    ...makeRegistry(),
    ownedServiceUrl: null,
  } as NetworkRegistry;
  render(<OwnedAccountEntry expanded />);
  expect(
    screen.getByRole("button", { name: "未配置 MoXBots 登录服务" }),
  ).toBeEnabled();
  fireEvent.click(
    screen.getByRole("button", { name: "未配置 MoXBots 登录服务" }),
  );
  expect(screen.getByRole("button", { name: "帮助与反馈" })).toBeDisabled();
  expect(mocks.start).not.toHaveBeenCalled();
});

it("keeps a valid account signed in while the network is offline and removes only this instance on sign-out", async () => {
  const registry = makeRegistry({
    state: "authenticated",
    principalId: "principal-123456",
    expiresAt: null,
  });
  mocks.registry = registry;
  render(
    <div className="global-sidebar-account-row">
      <OwnedAccountEntry expanded />
    </div>,
  );
  const trigger = screen.getByRole("button", {
    name: "MoXBots Test · principa",
  });
  expect(trigger).toHaveAttribute("data-owned-account-trigger");
  expect(trigger).toHaveAttribute("data-global-account-trigger");
  expect(
    trigger.matches(
      ".global-sidebar-account-row > [data-global-account-trigger]",
    ),
  ).toBe(true);
  fireEvent.click(trigger);
  expect(
    screen.getByRole("dialog", { name: "MoXBots 账号" }),
  ).toBeInTheDocument();
  expect(screen.getByText("网络暂时离线不会退出账号。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "退出此实例" }));
  fireEvent.click(screen.getByRole("button", { name: "确认退出此实例" }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("owned-a"));
  expect(mocks.accept).toHaveBeenCalledWith(
    expect.objectContaining({ selected: "official" }),
  );
});

it("routes authorization recovery through the existing AgentNet page", async () => {
  mocks.registry = makeRegistry({
    state: "authorizationRequired",
    principalId: "principal-1",
    expiresAt: null,
  });
  const onOpenAgentNetwork = vi.fn();
  render(
    <OwnedAccountEntry expanded onOpenAgentNetwork={onOpenAgentNetwork} />,
  );
  accountAction("授权恢复 MoXBots 账号");
  await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("owned-a"));
  expect(onOpenAgentNetwork).toHaveBeenCalledOnce();
  expect(mocks.start).not.toHaveBeenCalled();
});

it("uses the configured product issuer even when another owned instance is selected", async () => {
  const authenticated = makeRegistry({
    state: "authenticated",
    principalId: "principal-2",
    expiresAt: null,
  });
  const selectedQa = {
    ...makeRegistry(),
    selected: "qa-owned",
    connections: [
      ...makeRegistry().connections,
      {
        id: "qa-owned",
        name: "Isolated QA",
        official: false,
        url: "https://qa.example.test",
        removing: false,
        ownedAccount: {
          state: "authenticated",
          principalId: "qa-principal",
          expiresAt: null,
        },
        snapshot: {
          connectionId: "qa-owned",
          state: "ready",
          principalId: "qa-principal",
          networkId: "qa-net",
          error: null,
          revision: 1,
          authGeneration: 1,
        },
      },
    ],
  } as unknown as NetworkRegistry;
  mocks.registry = selectedQa;
  mocks.poll.mockResolvedValue({
    status: "authenticated",
    registry: authenticated,
  });
  mocks.select.mockResolvedValue(authenticated);
  render(<OwnedAccountEntry expanded />);
  accountAction("登录 MoXBots");
  expect(
    screen.queryByRole("tab", { name: "设备 key（旧方式）" }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("服务 URL")).toHaveValue(
    "https://login.example.test",
  );
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中继续" }));
  await screen.findByText("等待浏览器登录");
  fireEvent.click(screen.getByRole("button", { name: "检查登录状态" }));
  await waitFor(() =>
    expect(mocks.start).toHaveBeenCalledWith(
      "https://login.example.test",
      undefined,
    ),
  );
  await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("owned-a"));
  expect(mocks.accept).toHaveBeenCalledWith(authenticated);
});

it("shows an unauthenticated product account when only an isolated QA account exists", () => {
  const registry = makeRegistry({
    state: "authenticated",
    principalId: "qa-principal",
    expiresAt: null,
  });
  mocks.registry = {
    ...registry,
    selected: "qa-owned",
    connections: registry.connections.map((connection) =>
      connection.id === "owned-a"
        ? { ...connection, url: "https://qa.example.test", name: "Isolated QA" }
        : connection,
    ),
  } as NetworkRegistry;
  render(<OwnedAccountEntry expanded />);
  accountAction("登录 MoXBots");
  expect(screen.getByLabelText("服务 URL")).toHaveValue(
    "https://login.example.test",
  );
  expect(screen.getByLabelText("服务 URL")).toHaveAttribute("readonly");
  fireEvent.change(screen.getByLabelText("服务 URL"), {
    target: { value: "https://attacker.example.test" },
  });
  expect(screen.getByLabelText("服务 URL")).toHaveValue(
    "https://login.example.test",
  );
  expect(mocks.start).not.toHaveBeenCalled();
});

it("fails closed when the configured issuer contains a path or query", () => {
  mocks.registry = {
    ...makeRegistry(),
    ownedServiceUrl: "https://login.example.test/dex?tenant=qa",
  } as NetworkRegistry;
  render(<OwnedAccountEntry expanded />);
  expect(
    screen.getByRole("button", { name: "未配置 MoXBots 登录服务" }),
  ).toBeEnabled();
  expect(mocks.start).not.toHaveBeenCalled();
});

it("refreshes the read-only account projection when its session expires", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const initial = makeRegistry({
    state: "authenticated",
    principalId: "principal-expiring",
    expiresAt: nowSeconds + 10,
  });
  const expired = makeRegistry({
    state: "signInRequired",
    principalId: "principal-expiring",
    expiresAt: null,
  });
  mocks.registry = initial;
  mocks.connections.mockResolvedValue(expired);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(nowSeconds * 1000);
    render(<OwnedAccountEntry expanded />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.connections).toHaveBeenCalledOnce();
    mocks.connections.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.connections).toHaveBeenCalledOnce();
    expect(mocks.accept).toHaveBeenCalledWith(expired);
  } finally {
    vi.useRealTimers();
  }
});

it("refreshes after an authorization error changes without treating offline as sign-out", async () => {
  const authenticated = makeRegistry({
    state: "authenticated",
    principalId: "principal-live",
    expiresAt: null,
  });
  const authorizationRequired = {
    ...makeRegistry({
      state: "authorizationRequired",
      principalId: "principal-live",
      expiresAt: null,
    }),
    connections: makeRegistry({
      state: "authorizationRequired",
      principalId: "principal-live",
      expiresAt: null,
    }).connections.map((connection) =>
      connection.id === "owned-a"
        ? {
            ...connection,
            snapshot: {
              ...connection.snapshot,
              state: "disconnected" as const,
              error: { code: "NETWORK_OFFLINE", retryable: true },
            },
          }
        : connection,
    ),
  } as NetworkRegistry;
  mocks.registry = authenticated;
  mocks.connections
    .mockResolvedValueOnce(authenticated)
    .mockResolvedValueOnce(authorizationRequired);
  const view = render(<OwnedAccountEntry expanded />);
  await waitFor(() => expect(mocks.connections).toHaveBeenCalledOnce());
  mocks.registry = {
    ...authenticated,
    connections: authenticated.connections.map((connection) =>
      connection.id === "owned-a"
        ? {
            ...connection,
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
  } as NetworkRegistry;
  view.rerender(<OwnedAccountEntry expanded />);
  await waitFor(() => expect(mocks.connections).toHaveBeenCalledTimes(2));
  expect(mocks.accept).toHaveBeenCalledWith(authorizationRequired);
});

it("ignores an account refresh that completes after unmount", async () => {
  let resolveRead!: (registry: NetworkRegistry) => void;
  mocks.connections.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  const view = render(<OwnedAccountEntry expanded />);
  await waitFor(() => expect(mocks.connections).toHaveBeenCalledOnce());
  view.unmount();
  const late = makeRegistry({
    state: "authenticated",
    principalId: "late-refresh",
    expiresAt: null,
  });
  await act(async () => resolveRead(late));
  expect(mocks.accept).not.toHaveBeenCalledWith(late);
});

it("ignores an account refresh after the configured issuer boundary changes", async () => {
  let resolveOldRead!: (registry: NetworkRegistry) => void;
  mocks.connections
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldRead = resolve;
        }),
    )
    .mockResolvedValueOnce({
      ...makeRegistry(),
      ownedServiceUrl: "https://new.example.test",
    } as NetworkRegistry);
  const view = render(<OwnedAccountEntry expanded />);
  await waitFor(() => expect(mocks.connections).toHaveBeenCalledOnce());
  mocks.registry = {
    ...makeRegistry(),
    ownedServiceUrl: "https://new.example.test",
  } as NetworkRegistry;
  view.rerender(<OwnedAccountEntry expanded />);
  await waitFor(() => expect(mocks.connections).toHaveBeenCalledTimes(2));
  const stale = makeRegistry({
    state: "authenticated",
    principalId: "old-boundary",
    expiresAt: null,
  });
  await act(async () => resolveOldRead(stale));
  expect(mocks.accept).not.toHaveBeenCalledWith(stale);
});

it("cancels a pending login when the same issuer account generation changes", async () => {
  let resolvePoll!: (value: unknown) => void;
  mocks.cancel.mockRejectedValueOnce(new Error("cancel unavailable"));
  mocks.poll.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
  );
  const view = render(<OwnedAccountEntry expanded />);
  await waitFor(() => expect(mocks.connections).toHaveBeenCalledOnce());
  accountAction("登录 MoXBots");
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中继续" }));
  await screen.findByText("等待浏览器登录");
  fireEvent.click(screen.getByRole("button", { name: "检查登录状态" }));
  await waitFor(() => expect(mocks.poll).toHaveBeenCalledWith("attempt-a"));

  const next = makeRegistry({
    state: "signInRequired",
    principalId: "principal-new",
    expiresAt: null,
  });
  mocks.registry = {
    ...next,
    connections: next.connections.map((connection) =>
      connection.id === "owned-a"
        ? {
            ...connection,
            snapshot: { ...connection.snapshot, authGeneration: 2 },
          }
        : connection,
    ),
  } as NetworkRegistry;
  view.rerender(<OwnedAccountEntry expanded />);
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith("attempt-a"));
  expect(screen.queryByText("等待浏览器登录")).not.toBeInTheDocument();
  accountAction("登录 MoXBots");
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中继续" }));
  await screen.findByText("等待浏览器登录");
  expect(mocks.start).toHaveBeenCalledTimes(2);

  const stale = makeRegistry({
    state: "authenticated",
    principalId: "stale-poll",
    expiresAt: null,
  });
  await act(async () =>
    resolvePoll({ status: "authenticated", registry: stale }),
  );
  expect(mocks.accept).not.toHaveBeenCalledWith(stale);
  expect(mocks.select).not.toHaveBeenCalledWith("owned-a");
});

it("ends locally after explicit cancellation fails and permits a new login", async () => {
  mocks.cancel.mockRejectedValueOnce(new Error("cancel unavailable"));
  render(<OwnedAccountEntry expanded />);
  await waitFor(() => expect(mocks.connections).toHaveBeenCalledOnce());
  accountAction("登录 MoXBots");
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中继续" }));
  await screen.findByText("等待浏览器登录");
  fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith("attempt-a"));
  await waitFor(() =>
    expect(screen.queryByText("等待浏览器登录")).not.toBeInTheDocument(),
  );
  accountAction("登录 MoXBots");
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中继续" }));
  await screen.findByText("等待浏览器登录");
  expect(mocks.start).toHaveBeenCalledTimes(2);
});

it("does not accept a late authenticated poll after the account entry unmounts", async () => {
  let resolvePoll!: (value: unknown) => void;
  mocks.poll.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
  );
  const view = render(<OwnedAccountEntry expanded />);
  await waitFor(() => expect(mocks.connections).toHaveBeenCalledOnce());
  mocks.accept.mockClear();
  accountAction("登录 MoXBots");
  fireEvent.click(screen.getByRole("button", { name: "在浏览器中继续" }));
  await screen.findByText("等待浏览器登录");
  fireEvent.click(screen.getByRole("button", { name: "检查登录状态" }));
  await waitFor(() => expect(mocks.poll).toHaveBeenCalledWith("attempt-a"));
  view.unmount();
  expect(mocks.cancel).toHaveBeenCalledWith("attempt-a");
  await act(async () => {
    resolvePoll({
      status: "authenticated",
      registry: makeRegistry({
        state: "authenticated",
        principalId: "late",
        expiresAt: null,
      }),
    });
  });
  expect(mocks.accept).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
});

it("merges helper and cloud feedback into account menu even while signed out", async () => {
  mocks.external.mockResolvedValue(undefined);
  render(<OwnedAccountEntry expanded onOpenHelper={mocks.helper} />);
  fireEvent.click(screen.getByRole("button", { name: "登录 MoXBots" }));
  fireEvent.click(screen.getByRole("button", { name: "小助理" }));
  expect(mocks.helper).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "登录 MoXBots" }));
  fireEvent.click(screen.getByRole("button", { name: "帮助与反馈" }));
  await waitFor(() =>
    expect(mocks.external).toHaveBeenCalledWith(
      "https://login.example.test/feedback",
    ),
  );
  expect(mocks.start).not.toHaveBeenCalled();
});
it("keeps help accessible from the narrow account icon without a hidden label", () => {
  render(<OwnedAccountEntry expanded={false} onOpenHelper={mocks.helper} />);
  fireEvent.click(screen.getByRole("button", { name: "MoXBots 账号" }));
  fireEvent.click(screen.getByRole("button", { name: "小助理" }));
  expect(mocks.helper).toHaveBeenCalledOnce();
});
it("keeps the account menu usable after cloud feedback cannot open", async () => {
  mocks.external.mockRejectedValueOnce(new Error("failed"));
  render(<OwnedAccountEntry expanded onOpenHelper={mocks.helper} />);
  fireEvent.click(screen.getByRole("button", { name: "登录 MoXBots" }));
  fireEvent.click(screen.getByRole("button", { name: "帮助与反馈" }));
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "小助理" })).toBeInTheDocument();
});
