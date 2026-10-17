import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  snapshot: {
    state: "ready",
    principalId: "p",
    networkId: "n",
    authGeneration: 4,
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/agent-network/store", () => ({
  currentNetworkSnapshot: () => mocks.snapshot,
}));
import { remoteSessionRequest } from "./remoteSession";
const locator = {
  connectionId: "owned:test",
  principalId: "p",
  networkId: "n",
  deviceId: "d",
  authGeneration: 4,
};
const scope = {
  serviceId: "s",
  environment: "e",
  principalId: "p",
  networkId: "n",
  deviceId: "d",
  keyGeneration: 2,
};
const operationId = "11111111-1111-4111-8111-111111111111";
const signal = () => new AbortController().signal;
const envelope = (data: unknown) => ({
  scope,
  result: { kind: "remote-session", data },
});
const capabilities = {
  kind: "capabilities",
  agentId: "agent",
  version: 1,
  runtime: "builtin",
  maxActiveSessions: 1,
  liveUpdates: "snapshot",
};
beforeEach(() => {
  mocks.invoke.mockReset();
  Object.assign(mocks.snapshot, {
    state: "ready",
    principalId: "p",
    networkId: "n",
    authGeneration: 4,
  });
});
it("permits unscoped capabilities only and binds every subsequent call to signed target", async () => {
  mocks.invoke.mockResolvedValue(envelope(capabilities));
  expect(
    await remoteSessionRequest(
      locator,
      null,
      { kind: "capabilities", agentId: "agent" },
      signal(),
    ),
  ).toEqual({ scope, data: capabilities });
  await expect(
    remoteSessionRequest(
      locator,
      null,
      { kind: "list", agentId: "agent", limit: 30 },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "REMOTE_SESSION_TARGET_REQUIRED" });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith("cmd_agent_network_management", {
    request: {
      ...locator,
      targetScope: null,
      method: "session.remote",
      params: { remoteSession: { kind: "capabilities", agentId: "agent" } },
    },
  });
});
it("discards late responses after account generation changed", async () => {
  mocks.invoke.mockImplementation(async () => {
    mocks.snapshot.authGeneration++;
    return envelope(capabilities);
  });
  await expect(
    remoteSessionRequest(
      locator,
      null,
      { kind: "capabilities", agentId: "agent" },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "REMOTE_SESSION_ACCOUNT_CHANGED" });
});
it("never retries uncertain writes and preserves operation identity for receipt lookup", async () => {
  mocks.invoke.mockRejectedValue({ code: "NETWORK_DISCONNECTED" });
  await expect(
    remoteSessionRequest(
      locator,
      scope,
      { kind: "start", agentId: "agent", operationId, text: "task" },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "REMOTE_SESSION_UNCONFIRMED" });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
it("rejects mismatched target, receipt id and unsupported data fields", async () => {
  mocks.invoke.mockResolvedValue({
    ...envelope(capabilities),
    scope: { ...scope, keyGeneration: 3 },
  });
  await expect(
    remoteSessionRequest(
      locator,
      scope,
      { kind: "capabilities", agentId: "agent" },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "REMOTE_SESSION_RESPONSE_INVALID" });
  mocks.invoke.mockResolvedValue(
    envelope({
      kind: "receipt",
      agentId: "agent",
      operationId: "22222222-2222-4222-8222-222222222222",
      sessionId: "s",
      status: "accepted",
      code: null,
    }),
  );
  await expect(
    remoteSessionRequest(
      locator,
      scope,
      { kind: "start", agentId: "agent", operationId, text: "task" },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "REMOTE_SESSION_UNCONFIRMED" });
  mocks.invoke.mockResolvedValue(
    envelope({ ...capabilities, credential: "not-allowed" }),
  );
  await expect(
    remoteSessionRequest(
      locator,
      scope,
      { kind: "capabilities", agentId: "agent" },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "REMOTE_SESSION_RESPONSE_INVALID" });
});
it("rejects official, offline, signed out and invalid locator before dispatch", async () => {
  await expect(
    remoteSessionRequest(
      { ...locator, connectionId: "official" },
      null,
      { kind: "capabilities", agentId: "agent" },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "REMOTE_SESSION_TARGET_REQUIRED" });
  mocks.snapshot.state = "disconnected";
  await expect(
    remoteSessionRequest(
      locator,
      null,
      { kind: "capabilities", agentId: "agent" },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "REMOTE_SESSION_OFFLINE" });
  mocks.snapshot.state = "signedOut";
  await expect(
    remoteSessionRequest(
      locator,
      null,
      { kind: "capabilities", agentId: "agent" },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "REMOTE_SESSION_ACCOUNT_CHANGED" });
  expect(mocks.invoke).not.toHaveBeenCalled();
});
