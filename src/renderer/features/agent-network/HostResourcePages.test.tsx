import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import {
  clearAllHostManagementState,
  getHostPageDraft,
  setHostPageDraft,
  setHostPagePending,
} from "./hostManagementState";
import { HostResourcePages } from "./HostResourcePages";
import type {
  HostAddress,
  HostPagesAdapter,
  HostResourceSnapshot,
  HostSnapshot,
} from "@/api/hostManagement";

const address: HostAddress = {
  connectionId: "c",
  principalId: "p",
  authGeneration: 1,
  networkId: "n",
  deviceId: "d",
  serviceId: "s",
  targetIdentityGeneration: 2,
};
const snapshot: HostSnapshot = {
  address,
  product: "host",
  online: true,
  initialization: "ready",
  permissions: ["read", "configure", "operate"],
  capabilities: [
    "resources.read",
    "workspace.register",
    "agent.create",
    "agent.patch",
    "mcp.configure",
    "mcp.test",
    "skill.configure",
  ],
  environment: {
    os: "linux",
    architecture: "x64",
    runtime: "node",
    workspaceCount: 1,
    agentCount: 1,
  },
  provider: {
    config: { baseUrl: "https://example.test", model: "m" },
    credentialConfigured: true,
    desiredRevision: 4,
    effectiveRevision: 4,
    applyState: "applied",
    effectScope: "immediate",
  },
};
const data: HostResourceSnapshot = {
  address,
  desiredRevision: 4,
  effectiveRevision: 4,
  applyState: "applied",
  effectScope: "immediate",
  roots: [{ id: "root", label: "Projects" }],
  runtimes: [{ id: "rt", label: "Runtime" }],
  mcpPresets: [{ id: "preset", label: "MCP preset", transport: "https" }],
  skillSources: [{ id: "source", label: "Trusted source" }],
  workspaces: [
    {
      id: "ws",
      name: "Workspace",
      displayPath: "/home/user/" + "a".repeat(120),
    },
  ],
  agents: [{ id: "agent", name: "Agent", workspaceId: "ws", runtimeId: "rt" }],
  mcps: [{ id: "mcp", name: "MCP", presetId: "preset", enabled: true }],
  skills: [{ id: "skill", name: "Skill", sourceId: "source", enabled: false }],
};
const receipt = (
  mutationId: string,
  status: "accepted" | "persisted" | "applied" | "conflict" = "persisted",
) => ({
  address,
  mutationId,
  resource: "resources" as const,
  status,
  desiredRevision: 5,
  effectiveRevision: 4,
  effectScope: "nextTurn" as const,
});
function adapter(overrides: Partial<HostPagesAdapter> = {}): HostPagesAdapter {
  return {
    readResources: vi.fn(async () => data),
    mutateResources: vi.fn(async (_a, m) => receipt(m.mutationId)),
    receipt: vi.fn(async (_a, id) => receipt(id)),
    testMcp: vi.fn(async () => ({ ok: true })),
    readInteractions: vi.fn(async () => ({
      address,
      readToken: "",
      items: [],
    })),
    respondInteraction: vi.fn(async (_a, r) => receipt(r.mutationId)),
    readLogs: vi.fn(async () => ({
      address,
      redacted: true as const,
      entries: [],
    })),
    ...overrides,
  };
}
afterEach(() => clearAllHostManagementState());
beforeEach(async () => i18n.changeLanguage("en-US"));

describe("HostResourcePages", () => {
  it("reads only while active and renders long owner paths without losing them", async () => {
    const api = adapter();
    const { rerender } = render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="workspaces"
        active={false}
      />,
    );
    expect(api.readResources).not.toHaveBeenCalled();
    rerender(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    expect(
      await screen.findByText("/home/user/" + "a".repeat(120)),
    ).toBeInTheDocument();
    expect(api.readResources).toHaveBeenCalledTimes(1);
  });

  it("does not read without resources.read, and immediately disables writes offline", async () => {
    const api = adapter();
    const denied = { ...snapshot, capabilities: [] };
    const { rerender } = render(
      <HostResourcePages
        snapshot={denied}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Resource read permission",
    );
    expect(api.readResources).not.toHaveBeenCalled();
    rerender(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    await screen.findByText("/home/user/" + "a".repeat(120));
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "New workspace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Host-approved root" }));
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    fireEvent.change(screen.getByLabelText("Relative path within root"), {
      target: { value: "docs" },
    });
    expect(
      screen.getByRole("button", { name: "Save resource configuration" }),
    ).toBeEnabled();
    rerender(
      <HostResourcePages
        snapshot={{ ...snapshot, online: false }}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Host offline");
    expect(api.mutateResources).not.toHaveBeenCalled();
  });

  it("discards a late read from before an offline and reconnect cycle", async () => {
    let releaseOldRead!: (value: HostResourceSnapshot) => void;
    const oldRead = new Promise<HostResourceSnapshot>((resolve) => {
      releaseOldRead = resolve;
    });
    const api = adapter({
      readResources: vi
        .fn()
        .mockReturnValueOnce(oldRead)
        .mockResolvedValueOnce(data),
    });
    const { rerender } = render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    await waitFor(() => expect(api.readResources).toHaveBeenCalledTimes(1));
    rerender(
      <HostResourcePages
        snapshot={{ ...snapshot, online: false }}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    rerender(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    expect(
      await screen.findByText("/home/user/" + "a".repeat(120)),
    ).toBeInTheDocument();
    releaseOldRead({
      ...data,
      workspaces: [{ ...data.workspaces[0], name: "Old response" }],
    });
    await waitFor(() => expect(api.readResources).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Old response")).not.toBeInTheDocument();
  });

  it("sends owner-root registration with CAS and clears the draft only after owner readback", async () => {
    const api = adapter({
      readResources: vi.fn(async () => ({ ...data, desiredRevision: 5 })),
    });
    render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    await screen.findByText("/home/user/" + "a".repeat(120));
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "Docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Host-approved root" }));
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    fireEvent.change(screen.getByLabelText("Relative path within root"), {
      target: { value: "docs" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save resource configuration" }),
    );
    await waitFor(() => expect(api.mutateResources).toHaveBeenCalledTimes(1));
    const mutation = vi.mocked(api.mutateResources).mock.calls[0][1];
    expect(mutation).toMatchObject({
      expectedRevision: 5,
      patch: {
        kind: "workspace.register",
        rootId: "root",
        relativePath: "docs",
        name: "Docs",
      },
    });
    expect(mutation.mutationId).toEqual(expect.any(String));
    await waitFor(() => expect(api.readResources).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByText("Non-secret draft retained in this window only."),
      ).not.toBeInTheDocument(),
    );
  });

  it("clears the transient Agent name after a persisted create and owner readback", async () => {
    const api = adapter({
      readResources: vi.fn(async () => ({ ...data, desiredRevision: 5 })),
    });
    render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    await screen.findByText("/home/user/" + "a".repeat(120));
    fireEvent.click(screen.getByRole("button", { name: "Host workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Host-provided Runtime" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    fireEvent.change(screen.getByLabelText("Agent name"), {
      target: { value: "Transient Agent Name" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save resource configuration" }),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Agent name") as HTMLInputElement).value,
      ).toBe(""),
    );
    expect(vi.mocked(api.mutateResources).mock.calls[0][1].patch).toMatchObject(
      {
        kind: "agent.create",
        workspaceId: "ws",
        runtimeId: "rt",
        name: "Transient Agent Name",
      },
    );
  });

  it("clears the transient Agent name when safely discarding its draft", async () => {
    render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={adapter()}
        page="workspaces"
        active
      />,
    );
    await screen.findByText("/home/user/" + "a".repeat(120));
    fireEvent.change(screen.getByLabelText("Agent name"), {
      target: { value: "Discarded Agent Name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(
      (screen.getByLabelText("Agent name") as HTMLInputElement).value,
    ).toBe("");
  });

  it("returns to an empty Agent create form after a persisted rename", async () => {
    const api = adapter({
      readResources: vi.fn(async () => ({ ...data, desiredRevision: 5 })),
    });
    render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    await screen.findByText("/home/user/" + "a".repeat(120));
    fireEvent.click(screen.getByRole("button", { name: "Rename Agent" }));
    fireEvent.change(screen.getByLabelText("Agent name"), {
      target: { value: "Renamed Agent" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save resource configuration" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Create Agent" }),
      ).toBeInTheDocument(),
    );
    expect(
      (screen.getByLabelText("Agent name") as HTMLInputElement).value,
    ).toBe("");
    expect(vi.mocked(api.mutateResources).mock.calls[0][1].patch).toMatchObject(
      {
        kind: "agent.patch",
        agentId: "agent",
        name: "Renamed Agent",
      },
    );
  });

  it("prevents replacing a draft and hides its save action on the other page", async () => {
    const api = adapter();
    const { rerender } = render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    await screen.findByText("/home/user/" + "a".repeat(120));
    expect(screen.getByLabelText("Workspace name")).toBeEnabled();
    expect(screen.getByLabelText("Agent name")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "Docs" },
    });
    expect(
      screen.getByText(
        "Save or discard the current draft before editing another resource.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Agent name")).toBeDisabled();
    rerender(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="extensions"
        active
      />,
    );
    expect(
      screen.getByText(
        "Another resource page has an unsubmitted draft. Return to that page or discard it.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save resource configuration" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Declared MCP preset" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeEnabled();
  });

  it("keeps a pending operation and resolves it by the original mutation id only", async () => {
    const api = adapter({
      mutateResources: vi.fn(async (_a, m) =>
        receipt(m.mutationId, "accepted"),
      ),
      receipt: vi.fn(async (_a, id) => receipt(id, "applied")),
    });
    render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="extensions"
        active
      />,
    );
    await screen.findByText("MCP");
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save resource configuration" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check original receipt" }),
      ).toBeInTheDocument(),
    );
    const submitted = vi.mocked(api.mutateResources).mock.calls[0][1];
    fireEvent.click(
      screen.getByRole("button", { name: "Check original receipt" }),
    );
    await waitFor(() =>
      expect(api.receipt).toHaveBeenCalledWith(
        address,
        submitted.mutationId,
        expect.any(AbortSignal),
      ),
    );
    expect(api.mutateResources).toHaveBeenCalledTimes(1);
  });

  it("never queries an interaction pending receipt from the resources page", async () => {
    const api = adapter();
    setHostPagePending(address, {
      mutationId: "approval-operation",
      resource: "interaction",
      receipt: null,
    });
    render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="extensions"
        active
      />,
    );
    await screen.findByText("MCP");
    expect(
      screen.queryByRole("button", { name: "Check original receipt" }),
    ).toBeNull();
    expect(
      screen.getByText(
        "The Approvals page has an unconfirmed operation. Check its original receipt first.",
      ),
    ).toBeInTheDocument();
    expect(api.receipt).not.toHaveBeenCalled();
  });

  it("keeps readonly controls disabled but allows safe local draft discard", async () => {
    const api = adapter();
    const draft = {
      patch: {
        kind: "workspace.register" as const,
        rootId: "root",
        relativePath: "docs",
        name: "Docs",
      },
      expectedRevision: 4,
    };
    setHostPageDraft(address, draft);
    render(
      <HostResourcePages
        snapshot={{
          ...snapshot,
          permissions: ["read"],
          capabilities: ["resources.read"],
        }}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    await screen.findByText("/home/user/" + "a".repeat(120));
    expect(
      screen
        .getAllByLabelText(/Workspace name|Agent name/)
        .every((input) => input.hasAttribute("disabled")),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Save resource configuration" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(getHostPageDraft(address)).toBeUndefined();
  });

  it("requires explicit adoption of the owner revision after conflict", async () => {
    const api = adapter({
      readResources: vi
        .fn()
        .mockResolvedValueOnce(data)
        .mockResolvedValue({ ...data, desiredRevision: 5 }),
      mutateResources: vi.fn(async (_a, m) =>
        receipt(m.mutationId, "conflict"),
      ),
    });
    render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="extensions"
        active
      />,
    );
    await screen.findByText("MCP");
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save resource configuration" }),
    );
    await screen.findByText(
      "Host configuration changed. Keep the draft and explicitly adopt the latest revision before saving.",
    );
    expect(
      vi.mocked(api.mutateResources).mock.calls[0][1].expectedRevision,
    ).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(
      screen.getByRole("button", { name: "Save resource configuration" }),
    ).toBeDisabled();
    expect(getHostPageDraft(address)?.expectedRevision).toBe(4);
    fireEvent.click(
      screen.getByRole("button", { name: "Adopt latest revision, keep draft" }),
    );
    expect(
      screen.getByRole("button", { name: "Save resource configuration" }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Save resource configuration" }),
    );
    await waitFor(() => expect(api.mutateResources).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(api.mutateResources).mock.calls[1][1].expectedRevision,
    ).toBe(5);
  });

  it("aborts a refresh read on unmount", async () => {
    const api = adapter();
    const { unmount } = render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="workspaces"
        active
      />,
    );
    await screen.findByText("/home/user/" + "a".repeat(120));
    fireEvent.click(screen.getByRole("button", { name: "Read latest state" }));
    await waitFor(() => expect(api.readResources).toHaveBeenCalledTimes(2));
    const refreshSignal = vi.mocked(api.readResources).mock.calls[1][1];
    unmount();
    expect(refreshSignal.aborted).toBe(true);
  });

  it("requires applied matching revisions and operate+mcp.test for testing", async () => {
    const api = adapter();
    render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="extensions"
        active
      />,
    );
    await screen.findByText("MCP");
    const button = screen.getByRole("button", { name: "Test effective MCP" });
    expect(button).toBeEnabled();
    expect(screen.getByText("MCP preset · https")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.testMcp).toHaveBeenCalledWith(
        address,
        "preset",
        4,
        expect.any(AbortSignal),
      ),
    );
  });

  it("does not allow MCP tests when the page becomes inactive", async () => {
    const api = adapter();
    const { rerender } = render(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="extensions"
        active
      />,
    );
    await screen.findByText("MCP");
    rerender(
      <HostResourcePages
        snapshot={snapshot}
        adapter={api}
        page="extensions"
        active={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Test effective MCP" }),
    ).toBeNull();
    expect(api.testMcp).not.toHaveBeenCalled();
  });
});
