import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostInteraction,
  HostInteractionSnapshot,
  HostPageReceipt,
  HostPagesAdapter,
  HostSnapshot,
} from "@/api/hostManagement";
import { HostActivityPages } from "./HostActivityPages";
import { clearAllHostManagementState } from "./hostManagementState";
const address = {
  connectionId: "fixture",
  principalId: "human",
  authGeneration: 1,
  networkId: "net",
  deviceId: "device",
  serviceId: "service",
  targetIdentityGeneration: 2,
};
const snapshot: HostSnapshot = {
  address,
  product: "host",
  online: true,
  initialization: "ready",
  permissions: ["read", "approve"],
  capabilities: [
    "config.read",
    "interactions.read",
    "interaction.respond",
    "logs.read",
  ],
  environment: {
    os: "Linux",
    architecture: "x64",
    runtime: "SDK",
    workspaceCount: 0,
    agentCount: 0,
  },
  provider: {
    config: { baseUrl: "https://fixture.invalid", model: "fixture" },
    credentialConfigured: false,
    desiredRevision: 1,
    effectiveRevision: 1,
    applyState: "applied",
    effectScope: "newSession",
  },
};
const interaction: HostInteraction = {
  kind: "permission",
  sessionId: "session",
  requestId: "request",
  turnId: "turn",
  runtimeGeneration: 3,
  title: "Read approved workspace",
  description: "Read a bounded file",
  expiresAt: "2099-10-12T00:00:00Z",
};
const owner: HostInteractionSnapshot = {
  address,
  readToken: "read-1",
  items: [interaction],
};
function receipt(
  mutationId: string,
  status: HostPageReceipt["status"] = "applied",
): HostPageReceipt {
  return {
    address,
    mutationId,
    resource: "interaction",
    status,
    desiredRevision: 1,
    effectiveRevision: 1,
    effectScope: "immediate",
  };
}
function fixture() {
  return {
    readResources: vi.fn<HostPagesAdapter["readResources"]>(),
    mutateResources: vi.fn<HostPagesAdapter["mutateResources"]>(),
    receipt: vi.fn<HostPagesAdapter["receipt"]>(),
    testMcp: vi.fn<HostPagesAdapter["testMcp"]>(),
    readInteractions: vi.fn(async () => structuredClone(owner)),
    respondInteraction: vi.fn<HostPagesAdapter["respondInteraction"]>(),
    readLogs: vi.fn<HostPagesAdapter["readLogs"]>(async () => ({
      address,
      redacted: true,
      entries: [
        {
          id: "log1",
          timestamp: "2026-10-12T01:00:00Z",
          level: "info",
          message: "Safe owner projection",
        },
      ],
      nextCursor: "older-1",
    })),
  } satisfies HostPagesAdapter;
}
function mount(
  adapter = fixture(),
  current = snapshot,
  page: "approvals" | "logs" = "approvals",
) {
  return {
    ...render(
      <HostActivityPages
        snapshot={current}
        adapter={adapter}
        page={page}
        active
      />,
    ),
    adapter,
  };
}
beforeEach(clearAllHostManagementState);
describe("Host activity pages (isolated owner projections)", () => {
  it("requires an explicit adapter and each read capability", () => {
    const adapter = fixture();
    mount(adapter, { ...snapshot, capabilities: ["config.read"] });
    expect(adapter.readInteractions).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("不可用");
  });
  it("operate/configure never grant approval", async () => {
    const adapter = fixture();
    mount(adapter, {
      ...snapshot,
      permissions: ["read", "operate", "configure"],
    });
    expect(await screen.findByRole("button", { name: "批准" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(adapter.respondInteraction).not.toHaveBeenCalled();
  });
  it("preflights the original owner and binds exact session/request/turn/runtime with fresh token", async () => {
    const adapter = fixture();
    adapter.readInteractions
      .mockResolvedValueOnce(owner)
      .mockResolvedValueOnce({ ...owner, readToken: "fresh-2" })
      .mockResolvedValue({ ...owner, items: [] });
    adapter.respondInteraction.mockImplementation(async (_, response) =>
      receipt(response.mutationId),
    );
    mount(adapter);
    fireEvent.click(await screen.findByRole("button", { name: "批准" }));
    await screen.findByText("当前没有待处理审批。");
    expect(adapter.respondInteraction).toHaveBeenCalledOnce();
    expect(adapter.respondInteraction.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        sessionId: "session",
        requestId: "request",
        turnId: "turn",
        runtimeGeneration: 3,
        readToken: "fresh-2",
        approved: true,
        kind: "permission",
      }),
    );
  });
  it("a replaced runtime or expired request is never submitted", async () => {
    const adapter = fixture();
    adapter.readInteractions.mockResolvedValueOnce(owner).mockResolvedValue({
      ...owner,
      items: [{ ...interaction, runtimeGeneration: 4 }],
    });
    mount(adapter);
    fireEvent.click(await screen.findByRole("button", { name: "批准" }));
    await screen.findByText(/此审批已失效/);
    expect(adapter.respondInteraction).not.toHaveBeenCalled();
  });
  it("questions require every owner-provided choice and send no chat message", async () => {
    const adapter = fixture();
    const question: HostInteraction = {
      ...interaction,
      kind: "question",
      questions: [
        { id: "q1", prompt: "Choose scope", options: ["One file", "Cancel"] },
        { id: "q2", prompt: "Choose duration", options: ["This turn"] },
      ],
    };
    adapter.readInteractions.mockResolvedValue({ ...owner, items: [question] });
    adapter.respondInteraction.mockImplementation(async (_, response) =>
      receipt(response.mutationId, "accepted"),
    );
    mount(adapter);
    const submit = await screen.findByRole("button", { name: "提交答案" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Choose scope"));
    fireEvent.click(await screen.findByRole("button", { name: "One file" }));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Choose duration"));
    fireEvent.click(await screen.findByRole("button", { name: "This turn" }));
    fireEvent.click(submit);
    await waitFor(() =>
      expect(adapter.respondInteraction).toHaveBeenCalledOnce(),
    );
    expect(adapter.respondInteraction.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        kind: "question",
        answers: { q1: "One file", q2: "This turn" },
      }),
    );
  });
  it("unknown response survives close, blocks duplicate approval and only queries original ID", async () => {
    const adapter = fixture();
    adapter.respondInteraction.mockImplementation(async (_, response) =>
      receipt(response.mutationId, "unconfirmed"),
    );
    adapter.receipt.mockImplementation(async (_, id) =>
      receipt(id, "accepted"),
    );
    const first = mount(adapter);
    const approve = await screen.findByRole("button", { name: "批准" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(adapter.respondInteraction).toHaveBeenCalledOnce(),
    );
    const id = adapter.respondInteraction.mock.calls[0][1].mutationId;
    first.unmount();
    mount(adapter);
    const query = await screen.findByRole("button", { name: "查询原操作回执" });
    fireEvent.click(query);
    await waitFor(() => expect(adapter.receipt).toHaveBeenCalledOnce());
    expect(adapter.receipt.mock.calls[0][1]).toBe(id);
    expect(adapter.respondInteraction).toHaveBeenCalledOnce();
  });
  it("offline hides stale interactions; reconnect waits for a fresh owner read", async () => {
    const adapter = fixture();
    const view = mount(adapter);
    await screen.findByRole("button", { name: "批准" });
    view.rerender(
      <HostActivityPages
        snapshot={{ ...snapshot, online: false }}
        adapter={adapter}
        page="approvals"
        active
      />,
    );
    expect(
      screen.queryByRole("button", { name: "批准" }),
    ).not.toBeInTheDocument();
    adapter.readInteractions.mockReturnValue(new Promise(() => {}));
    view.rerender(
      <HostActivityPages
        snapshot={snapshot}
        adapter={adapter}
        page="approvals"
        active
      />,
    );
    expect(
      screen.queryByRole("button", { name: "批准" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/读取设备级管理能力/)).toBeInTheDocument();
  });
  it("permission revocation aborts late approval feedback", async () => {
    let settle!: (value: HostPageReceipt) => void;
    const adapter = fixture();
    adapter.respondInteraction.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const view = mount(adapter);
    fireEvent.click(await screen.findByRole("button", { name: "批准" }));
    await waitFor(() =>
      expect(adapter.respondInteraction).toHaveBeenCalledOnce(),
    );
    const [, response, signal] = adapter.respondInteraction.mock.calls[0];
    view.rerender(
      <HostActivityPages
        snapshot={{ ...snapshot, permissions: ["read"] }}
        adapter={adapter}
        page="approvals"
        active
      />,
    );
    expect(signal.aborted).toBe(true);
    await act(async () => settle(receipt(response.mutationId)));
    expect(screen.queryByText(/Host 已生效/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准" })).toBeDisabled();
  });
  it("foreign receipts stay unknown rather than falsely approve", async () => {
    const adapter = fixture();
    adapter.respondInteraction.mockImplementation(async (_, response) => ({
      ...receipt(response.mutationId),
      address: { ...address, targetIdentityGeneration: 99 },
    }));
    mount(adapter);
    fireEvent.click(await screen.findByRole("button", { name: "批准" }));
    await screen.findByText(/审批响应结果尚未确认/);
    expect(screen.getByRole("button", { name: "批准" })).toBeDisabled();
  });

  it("a changed approval payload requires reviewing the new request before response", async () => {
    const adapter = fixture();
    adapter.readInteractions.mockResolvedValueOnce(owner).mockResolvedValue({
      ...owner,
      items: [{ ...interaction, description: "A different operation" }],
    });
    mount(adapter);
    fireEvent.click(await screen.findByRole("button", { name: "批准" }));
    await screen.findByText(/此审批已失效/);
    expect(adapter.respondInteraction).not.toHaveBeenCalled();
  });
  it("persisted approval is recorded but remains locked until an effective receipt", async () => {
    const adapter = fixture();
    adapter.respondInteraction.mockImplementation(async (_, response) =>
      receipt(response.mutationId, "persisted"),
    );
    mount(adapter);
    fireEvent.click(await screen.findByRole("button", { name: "批准" }));
    await screen.findByText(/Host 已记录审批响应，尚未确认生效/);
    expect(screen.getByRole("button", { name: "批准" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "查询原操作回执" }),
    ).toBeEnabled();
    expect(adapter.readInteractions).toHaveBeenCalledTimes(2);
  });

  it("StrictMode lifecycle leaves a usable owner read and submits once", async () => {
    const adapter = fixture();
    adapter.respondInteraction.mockImplementation(async (_, response) =>
      receipt(response.mutationId, "accepted"),
    );
    render(
      <StrictMode>
        <HostActivityPages
          snapshot={snapshot}
          adapter={adapter}
          page="approvals"
          active
        />
      </StrictMode>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "批准" }));
    await screen.findByText(/Host 已接纳审批响应/);
    expect(adapter.respondInteraction).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "查询原操作回执" }),
    ).toBeEnabled();
  });
  it("logs use bounded owner pagination and filter resets cursor", async () => {
    const adapter = fixture();
    mount(adapter, snapshot, "logs");
    await screen.findByText("Safe owner projection");
    expect(adapter.readLogs.mock.calls[0][1]).toEqual({
      limit: 100,
      level: "all",
    });
    fireEvent.click(screen.getByRole("button", { name: "较早日志" }));
    await waitFor(() =>
      expect(adapter.readLogs.mock.calls.at(-1)?.[1]).toEqual({
        limit: 100,
        level: "all",
        cursor: "older-1",
      }),
    );
    fireEvent.click(screen.getByLabelText("日志级别"));
    fireEvent.click(await screen.findByRole("button", { name: "错误" }));
    await waitFor(() =>
      expect(adapter.readLogs.mock.calls.at(-1)?.[1]).toEqual({
        limit: 100,
        level: "error",
      }),
    );
  });
  it("rejects non-redacted or oversized log projections without rendering raw data", async () => {
    const adapter = fixture();
    adapter.readLogs.mockResolvedValue({
      address,
      redacted: false as true,
      entries: [
        {
          id: "private",
          timestamp: "",
          level: "info",
          message: "MUST_NOT_DISPLAY",
        },
      ],
    });
    mount(adapter, snapshot, "logs");
    await screen.findByRole("alert");
    expect(screen.queryByText("MUST_NOT_DISPLAY")).not.toBeInTheDocument();
  });
  it("ignores stale log responses after scope replacement", async () => {
    let resolve!: (
      page: Awaited<ReturnType<HostPagesAdapter["readLogs"]>>,
    ) => void;
    const adapter = fixture();
    adapter.readLogs.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = mount(adapter, snapshot, "logs");
    const next = { ...snapshot, address: { ...address, authGeneration: 2 } };
    view.rerender(
      <HostActivityPages
        snapshot={next}
        adapter={adapter}
        page="logs"
        active
      />,
    );
    await act(async () =>
      resolve({
        address,
        redacted: true,
        entries: [
          { id: "stale", timestamp: "", level: "info", message: "OLD_SCOPE" },
        ],
      }),
    );
    expect(screen.queryByText("OLD_SCOPE")).not.toBeInTheDocument();
  });
});
