import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import {
  ownedHostManagement,
  type PortableHostProvider,
  type OwnedHostScope,
} from "./ownedHostManagement";
const locator = {
  connectionId: "owned:test",
  authGeneration: 4,
  principalId: "p",
  networkId: "n",
  deviceId: "d",
};
const scope: OwnedHostScope = {
  serviceId: "s",
  environment: "e",
  principalId: "p",
  networkId: "n",
  deviceId: "d",
  keyGeneration: 2,
};
const write = {
  method: "credential.set" as const,
  params: {
    providerId: "moonshot-coding" as const,
    credential: "synthetic-test-only",
    expectedRevision: 0,
    mutationId: "original-id",
  },
};
beforeEach(() => {
  invoke.mockReset();
});
it("requires an inspected target for writes and never sends owned commands to official", async () => {
  await expect(
    ownedHostManagement(locator, null, write, new AbortController().signal),
  ).rejects.toMatchObject({ code: "HOST_MANAGEMENT_TARGET_REQUIRED" });
  await expect(
    ownedHostManagement(
      { ...locator, connectionId: "official" },
      scope,
      write,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "HOST_MANAGEMENT_TARGET_REQUIRED" });
  expect(invoke).not.toHaveBeenCalled();
});
it("binds the actual Rust command to the full target identity and original receipt", async () => {
  invoke.mockResolvedValue({
    scope,
    result: {
      kind: "credential-receipt",
      mutationId: "original-id",
      status: "persisted",
      revision: 1,
      effect: "new-session",
    },
  });
  await ownedHostManagement(
    locator,
    scope,
    write,
    new AbortController().signal,
  );
  expect(invoke).toHaveBeenCalledWith("cmd_agent_network_management", {
    request: { ...locator, targetScope: scope, ...write },
  });
  invoke.mockResolvedValue({
    scope,
    result: {
      kind: "config-receipt",
      mutationId: "original-id",
      status: "persisted",
    },
  });
  await expect(
    ownedHostManagement(
      locator,
      scope,
      {
        method: "receipt.get",
        params: { owner: "credentials", mutationId: "original-id" },
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "HOST_MANAGEMENT_RESPONSE_INVALID" });
});
it("never reports success or replays a sent write when its target or transport outcome changes", async () => {
  invoke.mockResolvedValue({
    scope: { ...scope, keyGeneration: 3 },
    result: {
      kind: "credential-receipt",
      mutationId: "original-id",
      status: "persisted",
    },
  });
  await expect(
    ownedHostManagement(locator, scope, write, new AbortController().signal),
  ).rejects.toMatchObject({ code: "HOST_MANAGEMENT_UNCONFIRMED" });
  expect(invoke).toHaveBeenCalledTimes(1);
  invoke
    .mockReset()
    .mockRejectedValue(new Error("synthetic opaque transport failure"));
  await expect(
    ownedHostManagement(locator, scope, write, new AbortController().signal),
  ).rejects.toMatchObject({ code: "HOST_MANAGEMENT_UNCONFIRMED" });
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("suppresses an obsolete inspection after its invoke was dispatched", async () => {
  let finish!: (value: unknown) => void;
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const abort = new AbortController();
  const read = ownedHostManagement(
    locator,
    null,
    { method: "host.snapshot", params: {} },
    abort.signal,
  );
  abort.abort();
  finish({ scope, result: { kind: "snapshot", hostId: "d" } });
  await expect(read).rejects.toMatchObject({ name: "AbortError" });
});
it("accepts the complete strict Rust extended-snapshot DTO and rejects unknown fields", async () => {
  const hostId = "00000000-0000-4000-8000-000000000001";
  const hostLocator = { ...locator, deviceId: hostId };
  const hostScope = { ...scope, deviceId: hostId };
  const result = {
    kind: "extended-snapshot",
    version: 1,
    hostId,
    configured: false,
    provider: null,
    settings: null,
    activeSession: null,
    stopping: false,
    capabilities: ["local-session", "permission", "stop", "persistent-history", "local-config-receipt"],
    agentNet: { available: true, reason: null },
    runtime: { node: "24.14.0", sdkBinaryPresent: true },
    credentials: { providerId: null, configured: false, revision: 0, writeAvailable: true },
    resources: { version: 1, revision: 0, roots: [], agents: [] },
  };
  invoke.mockResolvedValue({ scope: hostScope, result });
  await expect(
    ownedHostManagement(
      hostLocator,
      hostScope,
      { method: "host.inspect", params: {} },
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ result });

  invoke.mockResolvedValue({
    scope: hostScope,
    result: { ...result, agentNet: { ...result.agentNet, state: "ready" } },
  });
  await expect(
    ownedHostManagement(
      hostLocator,
      hostScope,
      { method: "host.inspect", params: {} },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "HOST_MANAGEMENT_RESPONSE_INVALID" });
});
it("keeps malformed and secret-bearing write receipts unconfirmed", async () => {
  for (const malformed of [
    { status: "garbage", revision: 1, effect: "new-session" },
    { status: "persisted", revision: 0, effect: "new-session" },
    {
      status: "persisted",
      revision: 1,
      effect: "new-session",
      credential: "must-never-read-back",
    },
  ]) {
    invoke.mockResolvedValue({
      scope,
      result: {
        kind: "credential-receipt",
        mutationId: "original-id",
        ...malformed,
      },
    });
    await expect(
      ownedHostManagement(locator, scope, write, new AbortController().signal),
    ).rejects.toMatchObject({ code: "HOST_MANAGEMENT_UNCONFIRMED" });
  }
});

const profile: PortableHostProvider = {
  id: "fixture-provider", name: "Fixture Provider", apiProtocol: "openai",
  baseUrl: "https://api.example.test/v1", authType: "api_key",
  upstreamFormat: "responses", maxOutputTokensParamName: "max_output_tokens",
};
it("validates portable provider receipts without accepting secret-bearing response fields", async () => {
  const operation = { method: "config.provider.set" as const, params: {
    provider: profile, model: "model-a", workspace: { rootId: "workspace", relativePath: "团队/工作" },
    executionAuthorized: false, expectedRevision: 0, mutationId: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
  } };
  invoke.mockResolvedValue({ scope, result: {
    kind: "provider-config-receipt", status: "persisted", mutationId: operation.params.mutationId,
    revision: 1, effect: "new-session", settings: { revision: 1, providerId: profile.id, model: "model-a", workspace: operation.params.workspace, executionAuthorized: false },
  } });
  await ownedHostManagement(locator, scope, operation, new AbortController().signal);
  expect(invoke).toHaveBeenCalledWith("cmd_agent_network_management", { request: { ...locator, targetScope: scope, ...operation } });
  invoke.mockResolvedValue({ scope, result: {
    kind: "provider-config-receipt", status: "persisted", mutationId: operation.params.mutationId,
    revision: 1, effect: "new-session", settings: { revision: 1, providerId: profile.id, model: "model-a", workspace: operation.params.workspace, executionAuthorized: false }, credential: "leak",
  } });
  await expect(ownedHostManagement(locator, scope, operation, new AbortController().signal)).rejects.toMatchObject({ code: "HOST_MANAGEMENT_UNCONFIRMED" });
});

it("requires bounded relative remote directory requests and binds returned pages to the requested location", async () => {
  const list = { method: "resources.directory.list" as const, params: { rootId: "workspace", relativePath: "团队" } };
  invoke.mockResolvedValue({ scope, result: { kind: "directory-list", rootId: "workspace", relativePath: "团队", entries: [{ name: "资料 空间", relativePath: "团队/资料 空间" }], nextCursor: null } });
  await ownedHostManagement(locator, scope, list, new AbortController().signal);
  await expect(ownedHostManagement(locator, scope, { ...list, params: { ...list.params, relativePath: "../outside" } }, new AbortController().signal)).rejects.toMatchObject({ code: "HOST_MANAGEMENT_REQUEST_INVALID" });
  invoke.mockResolvedValue({ scope, result: { kind: "directory-list", rootId: "workspace", relativePath: "elsewhere", entries: [], nextCursor: null } });
  await expect(ownedHostManagement(locator, scope, list, new AbortController().signal)).rejects.toMatchObject({ code: "HOST_MANAGEMENT_RESPONSE_INVALID" });
});
