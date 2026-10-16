import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { NetworkRegistry } from "@/api/agentNetwork";
const mocks = vi.hoisted(() => ({
  registry: null as NetworkRegistry | null,
  connections: vi.fn(),
  select: vi.fn(),
  accept: vi.fn(),
}));
vi.mock("@/features/agent-network/store", () => ({
  useAgentNetworkRegistry: () => mocks.registry,
  acceptNetworkRegistry: mocks.accept,
}));
vi.mock("@/api/agentNetwork", () => ({
  networkConnections: mocks.connections,
  selectNetworkConnection: mocks.select,
}));
vi.mock("./CommunityPage", () => ({
  default: ({
    scope,
  }: {
    scope: { connectionId: string; bindingId: string };
  }) => (
    <div>
      {scope.connectionId}/{scope.bindingId}
    </div>
  ),
}));
import CommunityContainer from "./CommunityContainer";
function fixture(): NetworkRegistry {
  return {
    ownedServiceUrl: "https://cloud.test",
    selected: "a",
    connections: [
      {
        id: "a",
        name: "Cloud",
        url: "https://cloud.test",
        official: false,
        removing: false,
        snapshot: {
          state: "disconnected",
          principalId: "principal",
          networkId: null,
          error: null,
          revision: 1,
          authGeneration: 1,
          connectionId: "a",
        },
        ownedAccount: {
          state: "authenticated",
          principalId: "principal",
          bindingId: "binding1",
          expiresAt: Date.now() / 1000 + 3600,
        },
      },
    ],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.registry = fixture();
  mocks.connections.mockImplementation(async () => mocks.registry);
});
it("uses the signed in account while device relay is disconnected", async () => {
  render(<CommunityContainer />);
  expect(screen.getByText("a/binding1")).toBeInTheDocument();
  await waitFor(() => expect(mocks.accept).toHaveBeenCalled());
});
it("requires a real login binding and routes account repair to the existing owner", () => {
  delete mocks.registry!.connections[0].ownedAccount!.bindingId;
  const open = vi.fn();
  render(<CommunityContainer onOpenAccount={open} />);
  fireEvent.click(screen.getByRole("button", { name: "管理账号" }));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.queryByText("a/undefined")).not.toBeInTheDocument();
});
it("clears the community when logout removes the saved account", () => {
  const { rerender } = render(<CommunityContainer />);
  mocks.registry = { ...mocks.registry!, connections: [] };
  rerender(<CommunityContainer />);
  expect(screen.queryByText("a/binding1")).not.toBeInTheDocument();
});
it("makes ambiguous same-issuer accounts an explicit choice", async () => {
  const a = mocks.registry!.connections[0];
  mocks.registry = {
    ...mocks.registry!,
    selected: "official",
    connections: [
      a,
      {
        ...a,
        id: "b",
        ownedAccount: { ...a.ownedAccount!, principalId: "second" },
      },
    ],
  };
  mocks.select.mockResolvedValue({ ...mocks.registry, selected: "b" });
  render(<CommunityContainer />);
  fireEvent.click(screen.getByRole("button", { name: "Cloud · second" }));
  await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("b"));
  expect(screen.queryByText("a/binding1")).not.toBeInTheDocument();
});
