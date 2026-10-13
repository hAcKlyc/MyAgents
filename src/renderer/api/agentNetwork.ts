import { invoke } from "@tauri-apps/api/core";
import {
  metadataSchemas,
  NETWORK_BUDGETS,
} from "@myagents/agent-network-protocol";
import type { z } from "zod";
export type NetworkInfo = z.infer<typeof metadataSchemas.network>;
export type NetworkDevice = z.infer<
  typeof metadataSchemas.devices
>["items"][number];
export type NetworkAgent = z.infer<
  typeof metadataSchemas.agents
>["items"][number];
export type CallableAgent = z.infer<
  typeof metadataSchemas.callable
>["items"][number];
export interface NetworkFailure {
  code: string;
  retryable: boolean;
  details?: unknown;
}
export interface NetworkSnapshot {
  state: "signedOut" | "connecting" | "ready" | "disconnected" | "unavailable";
  principalId: string | null;
  networkId: string | null;
  error: NetworkFailure | null;
  revision: number;
  authGeneration: number;
  connectionId?: string;
  /** Current connection's read-only network display name (older hosts omit it). */
  deviceName?: string | null;
}
export type NetworkRequest =
  | { kind: "network" }
  | { kind: "devices"; cursor: string | null; limit: number }
  | { kind: "agents"; deviceId: string; cursor: string | null; limit: number }
  | {
      kind: "renameDevice";
      networkId: string;
      deviceId: string;
      name: string;
      expectedName: string;
      mutationId: string;
    }
  | {
      kind: "callable";
      networkId: string;
      cursor: string | null;
      limit: number;
    }
  | {
      kind: "membership";
      networkId: string;
      deviceId: string;
      joined: boolean;
      mutationId: string;
      expectedMembershipRevision: number;
    }
  | {
      kind: "enabled";
      networkId: string;
      mountId: string;
      enabled: boolean;
      mutationId: string;
      expectedMembershipRevision: number;
      expectedEnableRevision: number;
    }
  | {
      kind: "description";
      networkId: string;
      mountId: string;
      description: string | null;
      mutationId: string;
      expectedMembershipRevision: number;
      expectedDescriptionRevision: number;
    }
  | { kind: "receipt"; mutationId: string };
export function networkSnapshot(
  connectionId = "official",
): Promise<NetworkSnapshot> {
  return invoke("cmd_agent_network_snapshot", { connectionId });
}
const directoryReads = new Map<string, Promise<unknown>>();
const readScopes = new Map<string, string>();
/** In-flight reuse only; no response or permission cache. A newly observed
 * revision/account/connection and every write fence the previous requests. */
export function setNetworkReadScope(snapshot: NetworkSnapshot | null): void {
  if (snapshot === null) readScopes.clear();
  const connectionId = snapshot?.connectionId ?? "official";
  const readScope = readScopes.get(connectionId) ?? "";
  const next =
    snapshot === null
      ? ""
      : JSON.stringify([
          snapshot.authGeneration,
          snapshot.revision,
          snapshot.principalId,
          snapshot.networkId,
          snapshot.state,
        ]);
  if (next !== readScope || snapshot === null) {
    readScopes.set(connectionId, next);
    directoryReads.clear();
  }
}
function requestOnce(
  request: NetworkRequest,
  connectionId: string,
): Promise<unknown> {
  if (!["network", "devices", "agents", "callable"].includes(request.kind)) {
    if (request.kind !== "receipt") directoryReads.clear();
    return invoke("cmd_agent_network_request", { request, connectionId });
  }
  const key = JSON.stringify([
    connectionId,
    readScopes.get(connectionId),
    request,
  ]);
  let pending = directoryReads.get(key);
  if (!pending) {
    pending = invoke("cmd_agent_network_request", { request, connectionId });
    directoryReads.set(key, pending);
    const current = pending;
    const release = () => {
      if (directoryReads.get(key) === current) directoryReads.delete(key);
    };
    void pending.then(release, release);
  }
  // Each reader keeps its own mutable projection, as with independent invokes.
  return pending.then((value) => structuredClone(value));
}
export async function networkRequest(
  request: NetworkRequest,
  connectionId = "official",
): Promise<unknown> {
  try {
    return await requestOnce(request, connectionId);
  } catch (error) {
    // Rechecking a mutation receipt is a read, never a second mutation.
    if (
      "mutationId" in request &&
      request.kind !== "receipt" &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ["NETWORK_REQUEST_UNCONFIRMED", "NETWORK_TRANSPORT_FAILED"].includes(
        String(error.code),
      )
    ) {
      try {
        return await invoke("cmd_agent_network_request", {
          request: { kind: "receipt", mutationId: request.mutationId },
          connectionId,
        });
      } catch {
        throw error;
      } // A failed receipt read cannot turn an uncertain write into a definite failure.
    }
    throw error;
  } finally {
    // A read started during a write can still contain the pre-write snapshot.
    // Fence completion too, including receipt recovery and uncertain failures.
    if ("mutationId" in request && request.kind !== "receipt")
      directoryReads.clear();
  }
}
export async function allNetworkDevices(connectionId = "official"): Promise<{
  items: NetworkDevice[];
  complete: boolean;
}> {
  const items: NetworkDevice[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const page = metadataSchemas.devices.parse(
      await networkRequest(
        {
          kind: "devices",
          cursor,
          limit: NETWORK_BUDGETS.pageMax,
        },
        connectionId,
      ),
    );
    for (const device of page.items) {
      if (seen.has(device.deviceId)) throw new Error("NETWORK_PAGE_INVALID");
      seen.add(device.deviceId);
      items.push(device);
    }
    if (page.complete) return { items, complete: true };
    if (!page.nextCursor || page.nextCursor === cursor)
      throw new Error("NETWORK_PAGE_INVALID");
    if (items.length >= NETWORK_BUDGETS.catalogItems)
      return { items, complete: false };
    cursor = page.nextCursor;
  }
}
export async function allDeviceAgents(
  deviceId: string,
  connectionId = "official",
): Promise<{ items: NetworkAgent[]; complete: boolean }> {
  const items: NetworkAgent[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const page = metadataSchemas.agents.parse(
      await networkRequest(
        {
          kind: "agents",
          deviceId,
          cursor,
          limit: NETWORK_BUDGETS.pageMax,
        },
        connectionId,
      ),
    );
    for (const agent of page.items) {
      if (seen.has(agent.mountId)) throw new Error("NETWORK_PAGE_INVALID");
      seen.add(agent.mountId);
      items.push(agent);
    }
    if (page.complete) return { items, complete: true };
    if (!page.nextCursor || page.nextCursor === cursor)
      throw new Error("NETWORK_PAGE_INVALID");
    if (items.length >= NETWORK_BUDGETS.catalogItems)
      return { items, complete: false };
    cursor = page.nextCursor;
  }
}
export function networkErrorKey(
  error: unknown,
  operation: "read" | "mutation" = "read",
): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "NETWORK_FEATURE_DISABLED") return "featureDisabled";
  if (
    [
      "REVISION_CONFLICT",
      "MEMBERSHIP_REVISION_CONFLICT",
      "CONNECTION_EPOCH_MISMATCH",
    ].includes(code)
  )
    return "conflict";
  if (code === "NETWORK_URL_INVALID") return "urlInvalid";
  if (/^ENROLLMENT_KEY_|^KEY_(EXPIRED|REVOKED|BOUND)/.test(code))
    return "keyInvalid";
  if (code === "NETWORK_TRUST_CHANGED") return "trustChanged";
  if (code === "NETWORK_REMOVAL_UNCONFIRMED") return "removalPending";
  if (code === "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED")
    return "credentialStoreAuthorizationRequired";
  if (code === "NETWORK_CREDENTIAL_STORE_UNAVAILABLE")
    return "credentialStoreUnavailable";
  if (code === "NETWORK_CREDENTIAL_STORE_INVALID")
    return "credentialStoreInvalid";
  if (code === "OWNED_SESSION_RECORD_MISSING") return "ownedSessionMissing";
  if (code === "NETWORK_PRIVATE_KEY_MISSING" || code === "DEVICE_REVOKED")
    return "privateKeyMissing";
  if (
    code === "NETWORK_PROTOCOL_UNSUPPORTED" ||
    code === "NETWORK_DESCRIPTOR_INVALID"
  )
    return "protocolUnsupported";
  if (code === "DESCRIPTION_TOO_LARGE") return "descriptionTooLong";
  if (
    operation === "mutation" &&
    [
      "NETWORK_REQUEST_UNCONFIRMED",
      "NETWORK_TRANSPORT_FAILED",
      "MUTATION_RESULT_UNKNOWN",
    ].includes(code)
  )
    return "unconfirmed";
  if (code === "NETWORK_SERVICE_UNCONFIGURED") return "unconfigured";
  return "failed";
}

export interface NetworkConnection {
  id: string;
  name: string;
  official: boolean;
  url: string | null;
  removing: boolean;
  snapshot: NetworkSnapshot;
}
export interface NetworkRegistry {
  revision?: number;
  selfhostEnabled?: boolean;
  selected: string;
  connections: NetworkConnection[];
}
export const networkConnections = (): Promise<NetworkRegistry> =>
  invoke("cmd_agent_network_connections");
export const selectNetworkConnection = (
  connectionId: string,
): Promise<NetworkRegistry> =>
  invoke("cmd_agent_network_select", { connectionId });
export const joinNetworkConnection = (
  url: string,
  key: string,
): Promise<NetworkRegistry> => invoke("cmd_agent_network_join", { url, key });
export interface OwnedLoginAttempt {
  attemptId: string;
  authorizationUrl: string;
  expiresAt: number;
}
export type OwnedLoginPoll =
  | { status: "pending" }
  | { status: "authenticated"; registry: NetworkRegistry };
export const startOwnedNetworkLogin = (
  issuer: string,
  publicTlsCaFile?: string,
): Promise<OwnedLoginAttempt> =>
  invoke("cmd_agent_network_owned_start", {
    issuer,
    publicTlsCaFile: publicTlsCaFile?.trim() || null,
  });
export const openOwnedNetworkAuthorization = (
  attemptId: string,
): Promise<void> =>
  invoke("cmd_agent_network_owned_open_authorization", { attemptId });
export const pollOwnedNetworkLogin = (
  attemptId: string,
): Promise<OwnedLoginPoll> =>
  invoke("cmd_agent_network_owned_poll", { attemptId });
export const cancelOwnedNetworkLogin = (attemptId: string): Promise<void> =>
  invoke("cmd_agent_network_owned_cancel", { attemptId });
export const removeNetworkConnection = (
  connectionId: string,
): Promise<NetworkRegistry> =>
  invoke("cmd_agent_network_remove", { connectionId });
export const restoreOwnedCredentials = (input: {
  connectionId: string;
  expectedRegistryRevision: number;
  operationId: string;
}): Promise<NetworkRegistry> =>
  invoke("cmd_agent_network_owned_restore_credentials", input);
export const cancelOwnedCredentialRestore = (
  operationId: string,
): Promise<void> =>
  invoke("cmd_agent_network_owned_restore_cancel", { operationId });
