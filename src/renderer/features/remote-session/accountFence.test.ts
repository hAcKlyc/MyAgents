import { expect, it } from "vitest";
import { remoteAccountState, restoreRemoteTabForAccount } from "./accountFence";
import type { NetworkSnapshot } from "@/api/agentNetwork";
import type { RemoteSessionTab } from "./tabContract";
const tab: RemoteSessionTab = {
  id: "restored",
  view: "remote-session",
  title: "a",
  locator: {
    connectionId: "owned:test",
    principalId: "p",
    networkId: "n",
    deviceId: "d",
    authGeneration: 4,
  },
  agentId: "a",
  agentName: "a",
  deviceName: "d",
  sessionId: "s",
  targetScope: {
    serviceId: "service",
    environment: "test",
    principalId: "p",
    networkId: "n",
    deviceId: "d",
    keyGeneration: 1,
  },
};
const connecting: NetworkSnapshot = {
  state: "connecting",
  principalId: null,
  networkId: null,
  authGeneration: 0,
  revision: 0,
  error: null,
};
it("keeps a restored remote locator locked during cold registry hydration", () => {
  expect(restoreRemoteTabForAccount(tab, null)).toBe(tab);
  expect(restoreRemoteTabForAccount(tab, connecting)).toBe(tab);
  expect(remoteAccountState(tab.locator, connecting)).toBe("pending");
  const ready = {
    ...connecting,
    state: "ready" as const,
    principalId: "p",
    networkId: "n",
    authGeneration: 9,
  };
  expect(restoreRemoteTabForAccount(tab, ready)).toMatchObject({
    id: tab.id,
    sessionId: tab.sessionId,
    locator: { ...tab.locator, authGeneration: 9 },
  });
});
it("drops restoration only after confirmed signout or a confirmed account/network mismatch", () => {
  expect(
    restoreRemoteTabForAccount(tab, { ...connecting, state: "signedOut" }),
  ).toBeNull();
  expect(
    restoreRemoteTabForAccount(tab, { ...connecting, principalId: "other" }),
  ).toBeNull();
  expect(
    restoreRemoteTabForAccount(tab, { ...connecting, networkId: "other" }),
  ).toBeNull();
  expect(
    restoreRemoteTabForAccount(tab, { ...connecting, principalId: "p" }),
  ).toBe(tab);
});
