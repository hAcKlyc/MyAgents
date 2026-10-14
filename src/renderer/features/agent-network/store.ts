import { useSyncExternalStore } from "react";
import {
  clearAllHostManagementState,
  clearHostManagementScope,
} from "./hostManagementState";
import { listenWithCleanup } from "@/utils/tauriListen";
import {
  networkConnections,
  setNetworkReadScope,
  type NetworkSnapshot,
  type NetworkRegistry,
} from "@/api/agentNetwork";
import { clearRemoteDraftScope, clearRemoteDrafts } from '@/features/remote-session/drafts';
const initialSnapshot: NetworkSnapshot = {
  state: "connecting",
  principalId: null,
  networkId: null,
  error: null,
  revision: 0,
  authGeneration: 0,
  connectionId: "official",
};
const initial: NetworkRegistry = {
  selfhostEnabled: false,
  selected: "official",
  connections: [
    {
      id: "official",
      name: "MyAgents",
      official: true,
      url: null,
      removing: false,
      snapshot: initialSnapshot,
    },
  ],
};
let registry = initial;
const listeners = new Set<() => void>();
const pending = new Map<string, NetworkSnapshot>();
const drafts = new Map<string, string>();
function notify() {
  listeners.forEach((fn) => fn());
}
function clearScope(snapshot: NetworkSnapshot) {
  clearRemoteDraftScope(snapshot.principalId, snapshot.networkId);
  clearHostManagementScope(snapshot.principalId, snapshot.networkId);
  for (const key of drafts.keys()) {
    const [principal, network] = JSON.parse(key) as string[];
    if (principal === snapshot.principalId && network === snapshot.networkId)
      drafts.delete(key);
  }
}
function accept(next: NetworkSnapshot) {
  const id = next.connectionId ?? "official",
    old =
      pending.get(id) ??
      registry.connections.find((c) => c.id === id)?.snapshot;
  if (
    old &&
    (next.authGeneration < old.authGeneration ||
      (next.authGeneration === old.authGeneration &&
        next.revision < old.revision))
  )
    return;
  if (
    old &&
    (next.authGeneration !== old.authGeneration || next.principalId !== old.principalId || next.networkId !== old.networkId || next.state === "signedOut")
  )
    clearScope(old);
  pending.set(id, next);
  setNetworkReadScope(next);
  registry = {
    ...registry,
    connections: registry.connections.map((c) =>
      c.id === id ? { ...c, snapshot: next } : c,
    ),
  };
  notify();
}
export function acceptNetworkRegistry(next: NetworkRegistry) {
  const previousConnections = registry.connections;
  if ((next.revision ?? 0) < (registry.revision ?? 0)) return;
  const removed = registry.connections.filter(
    (c) => !next.connections.some((n) => n.id === c.id),
  );
  for (const c of removed) {
    clearScope(c.snapshot);
    pending.delete(c.id);
  }
  registry = {
    ...next,
    connections: next.connections.map((c) => {
      const newer = pending.get(c.id);
      return !c.removing &&
        newer &&
        (newer.authGeneration > c.snapshot.authGeneration ||
          (newer.authGeneration === c.snapshot.authGeneration &&
            newer.revision > c.snapshot.revision))
        ? { ...c, snapshot: newer }
        : c;
    }),
  };
  for (const old of previousConnections) {
    const current = registry.connections.find(c => c.id === old.id)?.snapshot;
    if (current && (current.authGeneration !== old.snapshot.authGeneration || current.principalId !== old.snapshot.principalId || current.networkId !== old.snapshot.networkId || current.state === 'signedOut')) clearScope(old.snapshot);
  }
  for (const c of registry.connections)
    setNetworkReadScope({ ...c.snapshot, connectionId: c.id });
  notify();
}
export function startAgentNetworkStore(): () => void {
  const abort = new AbortController();
  void (async () => {
    try {
      const first = await listenWithCleanup<NetworkSnapshot>(
        "agent-network:changed",
        (e) => accept(e.payload),
        abort.signal,
      );
      if (abort.signal.aborted) return;
      const second = await listenWithCleanup<NetworkRegistry>(
        "agent-network:connections-changed",
        (e) => acceptNetworkRegistry(e.payload),
        abort.signal,
      );
      if (abort.signal.aborted) return;
      if (!first.isRegistered() || !second.isRegistered())
        throw Error("NETWORK_LISTENER_UNAVAILABLE");
      const value = await networkConnections();
      if (!abort.signal.aborted) acceptNetworkRegistry(value);
    } catch {
      if (!abort.signal.aborted && registry === initial)
        accept({ ...initialSnapshot, state: "unavailable" });
    }
  })();
  return () => {
    abort.abort();
    drafts.clear();
    clearRemoteDrafts();
    clearAllHostManagementState();
    pending.clear();
    registry = initial;
    setNetworkReadScope(null);
  };
}
const subscribe = (callback: () => void) => {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
};
export function useAgentNetworkRegistry(): NetworkRegistry {
  return useSyncExternalStore(subscribe, () => registry);
}
export function useAgentNetworkSnapshot(
  connectionId?: string,
): NetworkSnapshot {
  const state = useAgentNetworkRegistry();
  return (
    state.connections.find((c) => c.id === (connectionId ?? state.selected))
      ?.snapshot ?? initialSnapshot
  );
}
export function useAgentNetworkDirectoryVersion(): string {
  const state = useAgentNetworkRegistry();
  return JSON.stringify(
    state.connections.map((c) => [
      c.id,
      c.removing,
      c.snapshot.authGeneration,
      c.snapshot.principalId,
      c.snapshot.networkId,
    ]),
  );
}
export const currentNetworkGeneration = (connectionId = "official") =>
  registry.connections.find((c) => c.id === connectionId)?.snapshot
    .authGeneration ?? -1;
export function descriptionDraftKey(
  principalId: string,
  networkId: string,
  mountId: string,
) {
  return JSON.stringify([principalId, networkId, mountId]);
}
export const getDescriptionDraft = (key: string) => drafts.get(key);
export function setDescriptionDraft(key: string, value: string) {
  drafts.set(key, value);
}
export function clearDescriptionDraft(key: string) {
  drafts.delete(key);
}

export const currentNetworkSnapshot = (connectionId: string): NetworkSnapshot | null => registry.connections.find(c => c.id === connectionId)?.snapshot ?? null;
