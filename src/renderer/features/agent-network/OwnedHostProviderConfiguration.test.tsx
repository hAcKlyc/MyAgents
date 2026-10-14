import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { HostLocator } from "@/api/hostManagement";
import type { OwnedHostCapabilities, OwnedHostExtendedSnapshot, OwnedHostScope } from "@/api/ownedHostManagement";
const ownedHostManagementMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/ownedHostManagement", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/ownedHostManagement")>(),
  ownedHostManagement: ownedHostManagementMock,
}));
import { OwnedHostProviderConfiguration } from "./OwnedHostProviderConfiguration";

const locator: HostLocator = {
  connectionId: "owned:fixture",
  principalId: "principal-fixture",
  networkId: "network-fixture",
  deviceId: "device-fixture",
  authGeneration: 4,
};
const scope: OwnedHostScope = {
  serviceId: "service-fixture",
  environment: "test",
  principalId: locator.principalId,
  networkId: locator.networkId,
  deviceId: locator.deviceId,
  keyGeneration: 2,
};
const capabilities: OwnedHostCapabilities = {
  kind: "capabilities",
  version: 1,
  methods: ["host.inspect", "resources.create", "resources.register"],
  providerKinds: [],
  limits: { directoryEntries: 128, pathBytes: 4096 },
};
function snapshot(agents: OwnedHostExtendedSnapshot["resources"]["agents"] = [], revision = 0): OwnedHostExtendedSnapshot {
  return {
    kind: "extended-snapshot",
    version: 1,
    hostId: locator.deviceId,
    configured: false,
    settings: null,
    provider: null,
    stopping: false,
    activeSession: null,
    capabilities: [],
    agentNet: { available: true, reason: null },
    runtime: { node: "24.0.0", sdkBinaryPresent: true },
    credentials: { providerId: null, configured: false, revision: 0, writeAvailable: false },
    resources: {
      version: 1,
      revision,
      roots: [{ rootId: "root-fixture", workspacePath: "/srv/host/workspaces" }],
      agents,
    },
  };
}
function renderConfiguration(value: OwnedHostExtendedSnapshot, onRefresh = vi.fn()) {
  return render(
    <OwnedHostProviderConfiguration
      locator={locator}
      scope={scope}
      snapshot={value}
      capabilities={capabilities}
      online
      onRefresh={onRefresh}
    />,
  );
}

it("shows a registered disabled Agent from an extended Host snapshot as read-only", () => {
  renderConfiguration(snapshot([
    {
      agentId: "agent-fixture",
      projectId: "project-fixture",
      name: "remote-agent-qa-20261014",
      workspacePath: "/srv/host/workspaces/remote-agent-qa-20261014",
      enabled: false,
      archived: false,
    },
  ]));

  const region = screen.getByRole("region", { name: "Host 上的 Agent" });
  expect(within(region).getByText("remote-agent-qa-20261014 · 已禁用")).toBeInTheDocument();
  expect(within(region).getByText("/srv/host/workspaces/remote-agent-qa-20261014")).toBeInTheDocument();
  expect(within(region).queryByRole("button", { name: /启用|开放/ })).not.toBeInTheDocument();
});

it("shows the empty state when the extended Host snapshot has no registered Agents", () => {
  renderConfiguration(snapshot());

  const region = screen.getByRole("region", { name: "Host 上的 Agent" });
  expect(within(region).getByText("暂无 Agent")).toBeInTheDocument();
});

it("keeps the server-reported disabled state after a receipt refreshes the snapshot", async () => {
  const agent = {
    agentId: "agent-fixture",
    projectId: "project-fixture",
    name: "remote-agent-qa-20261014",
    workspacePath: "/srv/host/workspaces/remote-agent-qa-20261014",
    enabled: false,
    archived: false,
  };
  ownedHostManagementMock.mockResolvedValue({
    scope,
    result: {
      kind: "resource-receipt",
      mutationId: "mutation-fixture",
      status: "persisted",
      revision: 2,
      effect: "registered-disabled-agent",
      resource: {
        created: true,
        agentId: "new-agent-fixture",
        projectId: "new-project-fixture",
        name: "new-agent",
        workspacePath: "/srv/host/workspaces/new-agent",
        enabled: false,
        archived: false,
      },
    },
  });
  const initial = snapshot([agent], 1);
  initial.settings = {
    revision: 1,
    providerId: "provider-fixture",
    model: "model-fixture",
    workspace: { rootId: "root-fixture", relativePath: "" },
    executionAuthorized: false,
  };
  const onRefresh = vi.fn();
  const view = renderConfiguration(initial, onRefresh);
  expect(screen.getByText("remote-agent-qa-20261014 · 已禁用")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("新建子目录名称"), { target: { value: "new-agent" } });
  fireEvent.click(screen.getByRole("button", { name: "创建子目录和禁用 Agent" }));
  await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  expect(ownedHostManagementMock).toHaveBeenCalledWith(
    locator,
    scope,
    expect.objectContaining({
      method: "resources.create",
      params: expect.objectContaining({ relativePath: "new-agent", expectedRevision: 1 }),
    }),
    expect.any(AbortSignal),
  );

  view.rerender(
    <OwnedHostProviderConfiguration
      locator={locator}
      scope={scope}
      snapshot={snapshot([
        agent,
        {
          agentId: "new-agent-fixture",
          projectId: "new-project-fixture",
          name: "new-agent",
          workspacePath: "/srv/host/workspaces/new-agent",
          enabled: false,
          archived: false,
        },
      ], 2)}
      capabilities={capabilities}
      online
      onRefresh={vi.fn()}
    />,
  );

  expect(screen.getByText("remote-agent-qa-20261014 · 已禁用")).toBeInTheDocument();
  expect(screen.getByText("new-agent · 已禁用")).toBeInTheDocument();
  expect(screen.queryByText("remote-agent-qa-20261014 · 已启用")).not.toBeInTheDocument();
});
