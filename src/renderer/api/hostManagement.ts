/** UI-side v0 seam, NOT an AgentNet wire contract. Replace this adapter only
 * after Agenthub publishes a fixed protocol artifact and Rust verifies the
 * device-level service, target generation and human management grants. */
export interface HostLocator {
  connectionId: string;
  principalId: string;
  authGeneration: number;
  networkId: string;
  deviceId: string;
}

export interface HostAddress extends HostLocator {
  serviceId: string;
  targetIdentityGeneration: number;
}

export type HostPermission = "read" | "configure" | "approve" | "operate";
export type HostCapability =
  | "config.read"
  | "provider.configure"
  | "provider.credential.write"
  | "provider.test";
export type HostApplyState = "pending" | "applied" | "error";
export type HostEffectScope =
  | "immediate"
  | "nextTurn"
  | "newSession"
  | "restartRequired";

export interface HostProviderConfig {
  baseUrl: string;
  model: string;
}

/** Redacted projection from the Host owner. Never includes a credential. */
export interface HostSnapshot {
  address: HostAddress;
  product: "desktop" | "host";
  online: boolean;
  initialization: "unconfigured" | "configured" | "ready" | "error";
  permissions: HostPermission[];
  capabilities: HostCapability[];
  environment: {
    os: string;
    architecture: string;
    runtime: string;
    workspaceCount: number;
    agentCount: number;
  };
  provider: {
    config: HostProviderConfig;
    credentialConfigured: boolean;
    desiredRevision: number;
    effectiveRevision: number;
    applyState: HostApplyState;
    effectScope: HostEffectScope;
  };
}

export type HostAccess =
  | {
      status: "unsupported";
      reason: "clientProtocolUnavailable" | "deviceUnsupported";
    }
  | { status: "unavailable" }
  | { status: "denied" }
  | { status: "ready"; snapshot: HostSnapshot };

export type HostMutation = {
  mutationId: string;
  expectedRevision: number;
} & (
  | { resource: "provider"; patch: HostProviderConfig }
  | { resource: "credential"; credential: string }
);

export interface HostReceipt {
  address: HostAddress;
  mutationId: string;
  resource: HostMutation["resource"];
  status:
    | "rejected"
    | "accepted"
    | "persisted"
    | "applied"
    | "conflict"
    | "unconfirmed";
  desiredRevision: number;
  effectiveRevision: number;
  effectScope: HostEffectScope;
}

export interface HostManagementAdapter {
  inspect(locator: HostLocator, signal: AbortSignal): Promise<HostAccess>;
  read(address: HostAddress, signal: AbortSignal): Promise<HostSnapshot>;
  mutate(
    address: HostAddress,
    mutation: HostMutation,
    signal: AbortSignal,
  ): Promise<HostReceipt>;
  receipt(
    address: HostAddress,
    mutationId: string,
    signal: AbortSignal,
  ): Promise<HostReceipt>;
  testProvider(
    address: HostAddress,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<{ ok: boolean }>;
}

const unavailable = async (): Promise<never> => {
  throw new Error("HOST_PROTOCOL_UNAVAILABLE");
};

/** No mock, guessed capability or draft network method in production. Protocol
 * 1.1.0 cannot negotiate this service; an appVersion/platform is not evidence. */
export const hostManagementAdapter: HostManagementAdapter = {
  inspect: async () => ({
    status: "unsupported",
    reason: "clientProtocolUnavailable",
  }),
  read: unavailable,
  mutate: unavailable,
  receipt: unavailable,
  testProvider: unavailable,
};

export function hostLocatorKey(locator: HostLocator): string {
  return JSON.stringify([
    locator.principalId,
    locator.networkId,
    locator.connectionId,
    locator.authGeneration,
    locator.deviceId,
  ]);
}

export function hostAddressKey(address: HostAddress): string {
  return JSON.stringify([
    hostLocatorKey(address),
    address.serviceId,
    address.targetIdentityGeneration,
  ]);
}

export function sameHostLocator(
  left: HostLocator,
  right: HostLocator,
): boolean {
  return hostLocatorKey(left) === hostLocatorKey(right);
}

export function sameHostAddress(
  left: HostAddress,
  right: HostAddress,
): boolean {
  return hostAddressKey(left) === hostAddressKey(right);
}

export function canManageHost(
  snapshot: HostSnapshot,
  permission: HostPermission,
  capability: HostCapability,
): boolean {
  return (
    snapshot.online &&
    snapshot.permissions.includes("read") &&
    snapshot.permissions.includes(permission) &&
    snapshot.capabilities.includes(capability)
  );
}

export function validHostProvider(config: HostProviderConfig): boolean {
  try {
    const url = new URL(config.baseUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      config.model.trim().length > 0 &&
      config.model.length <= 160 &&
      [...config.model, ...config.baseUrl].every((character) => {
        const code = character.codePointAt(0)!;
        return code > 31 && code !== 127;
      })
    );
  } catch {
    return false;
  }
}
