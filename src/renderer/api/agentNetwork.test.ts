import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import {
  networkErrorKey,
  networkRequest,
  restoreOwnedCredentials,
  cancelOwnedCredentialRestore,
  setNetworkReadScope,
  type NetworkRequest,
} from "./agentNetwork";
beforeEach(() => {
  invoke.mockReset();
  setNetworkReadScope(null);
});
describe("network read and settings outcome", () => {
  it("uses the explicit owned-credential restore and cancellation commands", async () => {
    invoke.mockResolvedValueOnce({ revision: 8 }).mockResolvedValueOnce(undefined);
    await expect(
      restoreOwnedCredentials({
        connectionId: "owned-1",
        expectedRegistryRevision: 7,
        operationId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual({ revision: 8 });
    await cancelOwnedCredentialRestore(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(invoke.mock.calls).toEqual([
      ["cmd_agent_network_owned_restore_credentials", {
        connectionId: "owned-1",
        expectedRegistryRevision: 7,
        operationId: "00000000-0000-4000-8000-000000000001",
      }],
      ["cmd_agent_network_owned_restore_cancel", {
        operationId: "00000000-0000-4000-8000-000000000001",
      }],
    ]);
  });
  it("post-save refresh does not join a read started while the save was pending", async () => {
    let finishWrite!: (value: unknown) => void,
      finishRead!: (value: unknown) => void;
    invoke
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finishWrite = r;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finishRead = r;
          }),
      )
      .mockResolvedValueOnce({ revision: 2 });
    const saving = networkRequest({
      kind: "description",
      networkId: "net",
      mountId: "mount",
      description: "new",
      mutationId: "mutation",
      expectedMembershipRevision: 1,
      expectedDescriptionRevision: 0,
    });
    const during = networkRequest({ kind: "network" });
    finishWrite({ saved: true });
    await saving;
    await expect(networkRequest({ kind: "network" })).resolves.toEqual({
      revision: 2,
    });
    finishRead({ revision: 1 });
    await expect(during).resolves.toEqual({ revision: 1 });
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it("coalesces only identical in-flight directory reads, with independent projections", async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = networkRequest({ kind: "network" }),
      second = networkRequest({ kind: "network" });
    expect(invoke).toHaveBeenCalledOnce();
    resolve({ revision: 1 });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    invoke.mockResolvedValueOnce({ revision: 2 });
    await expect(networkRequest({ kind: "network" })).resolves.toEqual({
      revision: 2,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("does not reuse reads across newer revision/auth scopes or a mutation", async () => {
    let resolve!: (value: unknown) => void;
    invoke
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue({ revision: 2 });
    const old = networkRequest({ kind: "network" });
    setNetworkReadScope({
      state: "ready",
      principalId: "user",
      networkId: "net",
      authGeneration: 1,
      revision: 1,
      error: null,
    });
    await expect(networkRequest({ kind: "network" })).resolves.toEqual({
      revision: 2,
    });
    setNetworkReadScope({
      state: "ready",
      principalId: "user2",
      networkId: "net",
      authGeneration: 2,
      revision: 2,
      error: null,
    });
    await networkRequest({ kind: "network" });
    resolve({ revision: 0 });
    await old;
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it("releases failed reads and never coalesces mutations", async () => {
    invoke
      .mockRejectedValueOnce({ code: "NETWORK_TRANSPORT_FAILED" })
      .mockResolvedValue({ revision: 2 });
    await expect(networkRequest({ kind: "network" })).rejects.toMatchObject({
      code: "NETWORK_TRANSPORT_FAILED",
    });
    await networkRequest({ kind: "network" });
    expect(invoke).toHaveBeenCalledTimes(2);
    const request: NetworkRequest = {
      kind: "enabled",
      networkId: "net",
      mountId: "mount",
      enabled: true,
      mutationId: "mutation",
      expectedMembershipRevision: 1,
      expectedEnableRevision: 1,
    };
    await Promise.all([networkRequest(request), networkRequest(request)]);
    expect(invoke).toHaveBeenCalledTimes(4);
  });
  it("a write and late old read cannot remove or reuse the fresh in-flight read", async () => {
    let resolveOld!: (value: unknown) => void,
      resolveNew!: (value: unknown) => void;
    invoke
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveOld = r;
          }),
      )
      .mockResolvedValueOnce({ saved: true })
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveNew = r;
          }),
      );
    const old = networkRequest({ kind: "network" });
    await networkRequest({
      kind: "description",
      networkId: "net",
      mountId: "mount",
      description: "new",
      mutationId: "mutation",
      expectedMembershipRevision: 1,
      expectedDescriptionRevision: 0,
    });
    const fresh = networkRequest({ kind: "network" });
    resolveOld({ revision: 0 });
    await old;
    const duplicate = networkRequest({ kind: "network" });
    expect(invoke).toHaveBeenCalledTimes(3);
    resolveNew({ revision: 1 });
    expect(await fresh).toEqual(await duplicate);
  });
  it.each([
    "NETWORK_TRANSPORT_FAILED",
    "NETWORK_REQUEST_UNCONFIRMED",
    "MUTATION_RESULT_UNKNOWN",
  ])("keeps %s save wording scoped to mutations", (code) => {
    expect(networkErrorKey({ code })).toBe("failed");
    expect(networkErrorKey({ code }, "mutation")).toBe("unconfirmed");
  });
  it.each([
    [
      "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED",
      "credentialStoreAuthorizationRequired",
    ],
    ["NETWORK_CREDENTIAL_STORE_UNAVAILABLE", "credentialStoreUnavailable"],
    ["NETWORK_CREDENTIAL_STORE_INVALID", "credentialStoreInvalid"],
    ["OWNED_SESSION_RECORD_MISSING", "ownedSessionMissing"],
  ])("maps %s to a fixed credential-store message", (code, key) => {
    expect(networkErrorKey({ code })).toBe(key);
  });
  it("never checks a mutation receipt for a failed read", async () => {
    const error = { code: "NETWORK_TRANSPORT_FAILED" };
    invoke.mockRejectedValueOnce(error);
    await expect(networkRequest({ kind: "network" })).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledOnce();
  });
  const mutations: NetworkRequest[] = [
    {
      kind: "renameDevice",
      networkId: "net",
      deviceId: "device",
      name: "新设备",
      expectedName: "旧设备",
      mutationId: "mutation",
    },
    {
      kind: "membership",
      networkId: "net",
      deviceId: "device",
      joined: true,
      mutationId: "mutation",
      expectedMembershipRevision: 1,
    },
    {
      kind: "enabled",
      networkId: "net",
      mountId: "mount",
      enabled: true,
      mutationId: "mutation",
      expectedMembershipRevision: 1,
      expectedEnableRevision: 1,
    },
    {
      kind: "description",
      networkId: "net",
      mountId: "mount",
      description: "draft",
      mutationId: "mutation",
      expectedMembershipRevision: 1,
      expectedDescriptionRevision: 1,
    },
  ];
  it.each(mutations)(
    "checks only the receipt of an uncertain $kind write",
    async (request) => {
      const receipt = { revision: 2 };
      invoke
        .mockRejectedValueOnce({ code: "NETWORK_REQUEST_UNCONFIRMED" })
        .mockResolvedValueOnce(receipt);
      await expect(networkRequest(request)).resolves.toBe(receipt);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenLastCalledWith("cmd_agent_network_request", {
        connectionId: "official",
        request: { kind: "receipt", mutationId: "mutation" },
      });
    },
  );
  it.each(mutations)(
    "retains uncertainty after a failed $kind receipt read",
    async (request) => {
      const error = { code: "NETWORK_TRANSPORT_FAILED" };
      invoke
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce({ code: "CONNECTOR_NOT_READY" });
      await expect(networkRequest(request)).rejects.toBe(error);
      expect(invoke).toHaveBeenCalledTimes(2);
    },
  );
  it("does not probe or retry a definite conflict", async () => {
    const error = { code: "REVISION_CONFLICT" };
    invoke.mockRejectedValueOnce(error);
    await expect(networkRequest(mutations[0])).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledOnce();
    expect(networkErrorKey(error, "mutation")).toBe("conflict");
  });
});

it("keeps uncertain mutation receipt queries on their original network", async () => {
  invoke
    .mockRejectedValueOnce({ code: "NETWORK_REQUEST_UNCONFIRMED" })
    .mockResolvedValueOnce({ revision: 3 });
  await networkRequest(
    {
      kind: "membership",
      networkId: "network-a",
      deviceId: "device",
      joined: true,
      mutationId: "same-id",
      expectedMembershipRevision: 0,
    },
    "self-a",
  );
  expect(
    invoke.mock.calls.every(
      ([, args]) =>
        (args as { connectionId: string }).connectionId === "self-a",
    ),
  ).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith("cmd_agent_network_request", {
    connectionId: "self-a",
    request: { kind: "receipt", mutationId: "same-id" },
  });
});
