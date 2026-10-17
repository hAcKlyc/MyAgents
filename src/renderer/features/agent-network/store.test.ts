import { readRemoteDraft, writeRemoteDraft, readRemoteOperation, writeRemoteOperation } from '@/features/remote-session/drafts';
import type { RemoteSessionTab } from '@/features/remote-session/tabContract';
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NetworkSnapshot, NetworkRegistry } from "@/api/agentNetwork";
import {
  getHostDraft,
  setHostDraft,
  getHostPending,
  setHostPending,
} from "./hostManagementState";
const mocks = vi.hoisted(() => ({ read: vi.fn(), listen: vi.fn() }));
vi.mock("@/api/agentNetwork", () => ({
  networkConnections: mocks.read,
  setNetworkReadScope: vi.fn(),
}));
vi.mock("@/utils/tauriListen", () => ({ listenWithCleanup: mocks.listen }));
import {
  startAgentNetworkStore,
  currentNetworkGeneration,
  descriptionDraftKey,
  setDescriptionDraft,
  getDescriptionDraft,
  acceptNetworkRegistry,
} from "./store";
const base: NetworkSnapshot = {
  state: "ready",
  principalId: "account",
  networkId: "network",
  error: null,
  revision: 1,
  authGeneration: 1,
  connectionId: "official",
};
function registry(
  snapshots: NetworkSnapshot[],
  selected = "official",
): NetworkRegistry {
  return {
    selected,
    connections: snapshots.map((s) => ({
      id: s.connectionId!,
      name: s.connectionId!,
      official: s.connectionId === "official",
      url: null,
      removing: false,
      snapshot: s,
    })),
  };
}
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.clearAllMocks();
});
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
describe("App network projection", () => {
  it("subscribes to both streams before reading, then fences a late old snapshot per connection", async () => {
    let resolve!: (v: NetworkRegistry) => void;
    let event!: (e: { payload: NetworkSnapshot }) => void;
    mocks.listen.mockImplementation(async (name, handler) => {
      if (name === "agent-network:changed") event = handler;
      return { isRegistered: () => true };
    });
    mocks.read.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    stop = startAgentNetworkStore();
    expect(mocks.read).not.toHaveBeenCalled();
    await flush();
    expect(mocks.listen).toHaveBeenCalledTimes(2);
    event({ payload: { ...base, authGeneration: 2, revision: 3 } });
    resolve(registry([base]));
    await flush();
    expect(currentNetworkGeneration()).toBe(2);
  });
  it("selection never changes generations; one network boundary clears only its drafts", async () => {
    let event!: (e: { payload: NetworkSnapshot }) => void;
    mocks.listen.mockImplementation(async (name, handler) => {
      if (name === "agent-network:changed") event = handler;
      return { isRegistered: () => true };
    });
    const second = {
      ...base,
      connectionId: "self",
      principalId: "self-account",
      networkId: "self-network",
    };
    mocks.read.mockResolvedValue(registry([base, second]));
    stop = startAgentNetworkStore();
    await flush();
    const firstDraft = descriptionDraftKey("account", "network", "mount"),
      secondDraft = descriptionDraftKey(
        "self-account",
        "self-network",
        "mount",
      );
    setDescriptionDraft(firstDraft, "official text");
    setDescriptionDraft(secondDraft, "self text");
    const hostAddress = {
      connectionId: "official",
      principalId: "account",
      networkId: "network",
      authGeneration: 1,
      deviceId: "host",
      serviceId: "service",
      targetIdentityGeneration: 1,
    };
    const otherHost = {
      ...hostAddress,
      connectionId: "self",
      principalId: "self-account",
      networkId: "self-network",
    };
    setHostDraft(hostAddress, {
      config: { baseUrl: "https://fixture.invalid", model: "draft" },
      expectedRevision: 1,
    });
    setHostPending(hostAddress, {
      mutationId: "pending",
      resource: "provider",
      receipt: null,
    });
    setHostDraft(otherHost, {
      config: { baseUrl: "https://fixture.invalid", model: "other" },
      expectedRevision: 1,
    });
    acceptNetworkRegistry(registry([base, second], "self"));
    expect(currentNetworkGeneration("official")).toBe(1);
    expect(currentNetworkGeneration("self")).toBe(1);
    expect(getHostPending(hostAddress)?.mutationId).toBe("pending");
    event({
      payload: { ...base, state: "signedOut", authGeneration: 2, revision: 3 },
    });
    expect(getDescriptionDraft(firstDraft)).toBeUndefined();
    expect(getDescriptionDraft(secondDraft)).toBe("self text");
    expect(getHostDraft(hostAddress)).toBeUndefined();
    expect(getHostPending(hostAddress)).toBeUndefined();
    expect(getHostDraft(otherHost)?.config.model).toBe("other");
    event({ payload: { ...second, revision: 2 } });
    expect(getDescriptionDraft(secondDraft)).toBe("self text");
    acceptNetworkRegistry(registry([{ ...base, authGeneration: 2 }]));
    expect(getDescriptionDraft(secondDraft)).toBeUndefined();
    expect(getHostDraft(otherHost)).toBeUndefined();
  });
  it("does not read when teardown wins registration", async () => {
    let resolve!: (v: { isRegistered: () => boolean }) => void;
    mocks.listen.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    stop = startAgentNetworkStore();
    stop();
    resolve({ isRegistered: () => false });
    await flush();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

it('registry-only account change clears remote drafts and pending IDs before the next render', () => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
  const owned = { ...base, connectionId: 'owned:test' };
  acceptNetworkRegistry(registry([owned]));
  const tab: RemoteSessionTab = { id: 'tab', view: 'remote-session', title: 'draft', locator: { connectionId: 'owned:test', principalId: 'account', networkId: 'network', authGeneration: 1, deviceId: 'device' }, agentId: 'agent', agentName: 'Agent', deviceName: 'Host', sessionId: null, targetScope: null };
  writeRemoteDraft(tab, 'private draft');
  writeRemoteOperation(tab, { operationId: '11111111-1111-4111-8111-111111111111', kind: 'start', status: 'unconfirmed' });
  acceptNetworkRegistry(registry([{ ...owned, principalId: 'different-account', authGeneration: 2, revision: 2 }]));
  expect(readRemoteDraft(tab)).toBe('');
  expect(readRemoteOperation(tab)).toBeNull();
  vi.unstubAllGlobals();
});
