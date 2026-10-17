/** Legacy UI-side projection, NOT an AgentNet wire contract. Official and
 * legacy-key networks remain unsupported here. Owned-account management uses
 * ownedHostManagement.ts and its actual signed Rust channel/Host owner. */
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
  | "provider.test"
  | "resources.read"
  | "workspace.register"
  | "agent.create"
  | "agent.patch"
  | "mcp.configure"
  | "mcp.test"
  | "skill.configure"
  | "interactions.read"
  | "interaction.respond"
  | "logs.read";
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
  /** Optional preparation seam. A missing adapter never implies a capability. */
  pages?: HostPagesAdapter;
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

// Additional local renderer projections, not method names or network schema.
export interface HostResourceSnapshot {
  address: HostAddress;
  desiredRevision: number;
  effectiveRevision: number;
  applyState: HostApplyState;
  effectScope: HostEffectScope;
  roots: { id: string; label: string }[];
  runtimes: { id: string; label: string }[];
  mcpPresets: { id: string; label: string; transport: "https" | "stdio" }[];
  skillSources: { id: string; label: string }[];
  workspaces: { id: string; name: string; displayPath: string }[];
  agents: {
    id: string;
    name: string;
    workspaceId: string;
    runtimeId: string;
  }[];
  mcps: { id: string; name: string; presetId: string; enabled: boolean }[];
  skills: { id: string; name: string; sourceId: string; enabled: boolean }[];
}
export type HostResourcePatch =
  | {
      kind: "workspace.register";
      rootId: string;
      relativePath: string;
      name: string;
    }
  | {
      kind: "agent.create";
      workspaceId: string;
      runtimeId: string;
      name: string;
    }
  | { kind: "agent.patch"; agentId: string; name: string }
  | { kind: "mcp.configure"; presetId: string; enabled: boolean }
  | { kind: "skill.configure"; sourceId: string; enabled: boolean };
export interface HostPageReceipt {
  address: HostAddress;
  mutationId: string;
  resource: "resources" | "interaction";
  status: HostReceipt["status"] | "expired";
  desiredRevision: number;
  effectiveRevision: number;
  effectScope: HostEffectScope;
}
export interface HostInteractionIdentity {
  sessionId: string;
  requestId: string;
  turnId: string;
  runtimeGeneration: number;
}
export type HostInteraction = HostInteractionIdentity & {
  title: string;
  expiresAt: string;
} & (
    | { kind: "permission"; description: string }
    | { kind: "plan"; description: string }
    | {
        kind: "question";
        questions: { id: string; prompt: string; options: string[] }[];
      }
  );
export interface HostInteractionSnapshot {
  address: HostAddress;
  /** Fresh owner read token, invalidated by reconnect/replacement. */
  readToken: string;
  items: HostInteraction[];
}
export type HostInteractionResponse = HostInteractionIdentity & {
  mutationId: string;
  readToken: string;
} & (
    | { kind: "permission" | "plan"; approved: boolean }
    | { kind: "question"; answers: Record<string, string> }
  );
export interface HostLogQuery {
  limit: number;
  level: "all" | "info" | "warn" | "error" | "debug";
  cursor?: string;
}
export interface HostLogPage {
  address: HostAddress;
  /** Must be redacted by the Host logging owner before crossing the boundary.
   * No raw payload, arbitrary meta, credentials, or local file reader fallback. */
  redacted: true;
  entries: {
    id: string;
    timestamp: string;
    level: Exclude<HostLogQuery["level"], "all">;
    message: string;
    sessionId?: string;
    requestId?: string;
    turnId?: string;
  }[];
  nextCursor?: string;
}
export interface HostPagesAdapter {
  readResources(
    address: HostAddress,
    signal: AbortSignal,
  ): Promise<HostResourceSnapshot>;
  mutateResources(
    address: HostAddress,
    mutation: {
      mutationId: string;
      expectedRevision: number;
      patch: HostResourcePatch;
    },
    signal: AbortSignal,
  ): Promise<HostPageReceipt>;
  receipt(
    address: HostAddress,
    mutationId: string,
    signal: AbortSignal,
  ): Promise<HostPageReceipt>;
  testMcp(
    address: HostAddress,
    presetId: string,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<{ ok: boolean }>;
  readInteractions(
    address: HostAddress,
    signal: AbortSignal,
  ): Promise<HostInteractionSnapshot>;
  respondInteraction(
    address: HostAddress,
    response: HostInteractionResponse,
    signal: AbortSignal,
  ): Promise<HostPageReceipt>;
  readLogs(
    address: HostAddress,
    query: HostLogQuery,
    signal: AbortSignal,
  ): Promise<HostLogPage>;
}
export function hostInteractionKey(identity: HostInteractionIdentity): string {
  return JSON.stringify([
    identity.sessionId,
    identity.requestId,
    identity.turnId,
    identity.runtimeGeneration,
  ]);
}
export function validHostResourcePatch(
  patch: HostResourcePatch,
  snapshot: HostResourceSnapshot,
): boolean {
  const name = "name" in patch ? patch.name : "";
  if (
    "name" in patch &&
    (!name.trim() ||
      name.length > 160 ||
      [...name].some((c) => c.codePointAt(0)! < 32))
  )
    return false;
  switch (patch.kind) {
    case "workspace.register":
      return (
        snapshot.roots.some((root) => root.id === patch.rootId) &&
        !!patch.relativePath.trim() &&
        patch.relativePath.length <= 512 &&
        !patch.relativePath.startsWith("/") &&
        !patch.relativePath.includes("\\") &&
        patch.relativePath
          .split("/")
          .every((part) => !!part && part !== "." && part !== "..") &&
        [...patch.relativePath].every(
          (c) => c.codePointAt(0)! > 31 && c.codePointAt(0)! !== 127,
        )
      );
    case "agent.create":
      return (
        snapshot.workspaces.some(
          (workspace) => workspace.id === patch.workspaceId,
        ) && snapshot.runtimes.some((runtime) => runtime.id === patch.runtimeId)
      );
    case "agent.patch":
      return snapshot.agents.some((agent) => agent.id === patch.agentId);
    case "mcp.configure":
      return snapshot.mcpPresets.some((preset) => preset.id === patch.presetId);
    case "skill.configure":
      return snapshot.skillSources.some(
        (source) => source.id === patch.sourceId,
      );
  }
}
