import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import {
  ownedHostManagement,
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
