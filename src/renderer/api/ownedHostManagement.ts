import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { HostLocator } from "./hostManagement";
import { isHostModelId, isHostProviderId, isHostProviderProfile, isHostRelativePath, isHostWorkspaceSelection, type PortableApiProvider } from "@/../shared/hostProviderConfig";

/** Renderer projections of host-management/v1. Rust owns the bounded codec,
 * signed device address, local account fence and encrypted transport. */
export interface OwnedHostScope {
  serviceId: string;
  environment: string;
  principalId: string;
  networkId: string;
  deviceId: string;
  keyGeneration: number;
}
export interface OwnedHostSettings {
  revision: number;
  providerId: "moonshot-coding";
  model: string;
  workspace: string;
  executionAuthorized: boolean;
}
export type PortableHostProvider = PortableApiProvider;
export interface OwnedHostWorkspace { rootId: string; relativePath: string }
export interface OwnedHostSnapshot {
  kind: "snapshot";
  version: 1;
  hostId: string;
  configured: boolean;
  settings: OwnedHostSettings | null;
  stopping: boolean;
  activeSession: {
    sessionId: string;
    generation: string;
    closing: boolean;
  } | null;
  credentials: {
    providerId: "moonshot-coding";
    configured: boolean;
    revision: number;
    writeAvailable: boolean;
  };
  resources: {
    version: 1;
    revision: number;
    roots: { rootId: string; workspacePath: string }[];
    agents: {
      agentId: string;
      projectId: string;
      name: string;
      workspacePath: string;
      enabled: boolean;
      archived: boolean;
    }[];
  };
}
export interface OwnedHostExtendedSettings {
  revision: number; providerId: string; model: string;
  workspace: OwnedHostWorkspace; executionAuthorized: boolean;
}
export interface OwnedHostExtendedSnapshot extends Omit<OwnedHostSnapshot, "kind" | "settings" | "credentials"> {
  kind: "extended-snapshot"; settings: OwnedHostExtendedSettings | null;
  provider: PortableHostProvider | null;
  credentials: { providerId: string | null; configured: boolean; revision: number; writeAvailable: boolean };
  capabilities: Array<"local-session" | "permission" | "stop" | "persistent-history" | "local-config-receipt">;
  agentNet: { available: boolean; reason: string | null };
  runtime: { node: string; sdkBinaryPresent: boolean };
}
export interface OwnedHostCapabilities {
  kind: "capabilities"; version: 1;
  methods: Array<"host.snapshot" | "config.set" | "credential.set" | "resources.create" | "receipt.get" | "host.capabilities" | "host.inspect" | "config.provider.set" | "credential.provider.set" | "receipt.provider.get" | "resources.directory.list" | "resources.register">;
  providerKinds: Array<"anthropic" | "openai">;
  limits: { directoryEntries: 128; pathBytes: 4096 };
}
export interface OwnedHostDirectoryList {
  kind: "directory-list"; rootId: string; relativePath: string;
  entries: { name: string; relativePath: string }[]; nextCursor: string | null;
}
export type OwnedHostOwner = "config" | "credentials" | "resources";
export type OwnedHostReceipt = {
  kind: "config-receipt" | "credential-receipt" | "resource-receipt";
  mutationId: string;
  status: "persisted" | "conflict" | "pending" | "not-found";
  revision?: number;
  effect?: string;
};
export type OwnedHostResult =
  | OwnedHostSnapshot
  | OwnedHostExtendedSnapshot
  | OwnedHostCapabilities
  | OwnedHostDirectoryList
  | OwnedHostReceipt
  | { kind: "receipt-not-found"; owner: OwnedHostOwner; mutationId: string }
  | { kind: "error"; code: string };
export interface OwnedHostResponse {
  scope: OwnedHostScope;
  result: OwnedHostResult;
}
export type OwnedHostOperation =
  | { method: "host.capabilities"; params: Record<string, never> }
  | { method: "host.inspect"; params: Record<string, never> }
  | { method: "config.provider.set"; params: { provider: PortableHostProvider; model: string; workspace: OwnedHostWorkspace; executionAuthorized: boolean; expectedRevision: number; mutationId: string } }
  | { method: "credential.provider.set"; params: { providerId: string; credential: string; expectedRevision: number; mutationId: string } }
  | { method: "receipt.provider.get"; params: { owner: "config" | "credentials"; providerId: string; mutationId: string } }
  | { method: "resources.directory.list"; params: { rootId: string; relativePath: string; cursor?: string } }
  | { method: "resources.register"; params: { rootId: string; relativePath: string; expectedRevision: number; mutationId: string } }
  | { method: "host.snapshot"; params: Record<string, never> }
  | {
      method: "config.set";
      params: {
        providerId: "moonshot-coding";
        model: string;
        executionAuthorized: boolean;
        expectedRevision: number;
        mutationId: string;
      };
    }
  | {
      method: "credential.set";
      params: {
        providerId: "moonshot-coding";
        credential: string;
        expectedRevision: number;
        mutationId: string;
      };
    }
  | {
      method: "resources.create";
      params: {
        rootId: string;
        relativePath: string;
        operation: "create";
        expectedRevision: number;
        mutationId: string;
      };
    }
  | {
      method: "receipt.get";
      params: { owner: OwnedHostOwner; mutationId: string };
    };

export function ownedHostErrorCode(error: unknown): string {
  const value =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return typeof value === "string" && /^[A-Z0-9_]{1,128}$/.test(value)
    ? value
    : "HOST_MANAGEMENT_NOT_COMPLETED";
}
export function sameOwnedHostScope(
  a: OwnedHostScope,
  b: OwnedHostScope,
): boolean {
  return (
    a.serviceId === b.serviceId &&
    a.environment === b.environment &&
    a.principalId === b.principalId &&
    a.networkId === b.networkId &&
    a.deviceId === b.deviceId &&
    a.keyGeneration === b.keyGeneration
  );
}
function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const mutationId = z.string().min(1).max(36);
const settings = z
  .object({
    revision: revision.min(1),
    providerId: z.literal("moonshot-coding"),
    model: z.string().min(1).max(128),
    workspace: z.string().min(1).max(4096),
    executionAuthorized: z.boolean(),
  })
  .strict();
const providerId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
// eslint-disable-next-line no-control-regex -- Reject control characters in bounded wire text.
const safeText = (max: number) => z.string().min(1).max(max).refine(v => !/[\u0000-\u001f\u007f]/.test(v));
const provider = z.object({
  id: providerId, sourceProviderId: providerId.optional(), name: safeText(256), apiProtocol: z.enum(["anthropic", "openai"]),
  baseUrl: z.string().url().max(4096).refine(v => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && !["localhost", "127.0.0.1", "::1"].includes(u.hostname); } catch { return false; } }),
  authType: z.enum(["auth_token", "api_key", "both", "auth_token_clear_api_key"]), upstreamFormat: z.enum(["chat_completions", "responses"]).optional(),
  maxOutputTokens: z.number().int().positive().optional(), maxOutputTokensParamName: z.enum(["max_tokens", "max_completion_tokens", "max_output_tokens"]).optional(),
  modelAliases: z.object({ fable: safeText(160).optional(), sonnet: safeText(160).optional(), opus: safeText(160).optional(), haiku: safeText(160).optional() }).strict().optional(),
}).strict();
const extendedSettings = z.object({ revision: revision.min(1), providerId, model: safeText(160), workspace: z.object({ rootId: safeText(128), relativePath: z.string().max(4096) }).strict(), executionAuthorized: z.boolean() }).strict();
const extendedSnapshot = z.object({
  kind: z.literal("extended-snapshot"), version: z.literal(1), hostId: z.string().min(1), configured: z.boolean(), settings: extendedSettings.nullable(), provider: provider.nullable(), stopping: z.boolean(),
  activeSession: z.object({ sessionId: z.string().min(1), generation: z.string().min(1), closing: z.boolean() }).nullable(),
  capabilities: z.array(z.enum(["local-session", "permission", "stop", "persistent-history", "local-config-receipt"])).max(16),
  agentNet: z.object({ available: z.boolean(), reason: z.string().max(64).nullable() }).strict(),
  runtime: z.object({ node: z.string().min(1).max(32).regex(/^[0-9.\-+]+$/), sdkBinaryPresent: z.boolean() }).strict(),
  credentials: z.object({ providerId: providerId.nullable(), configured: z.boolean(), revision, writeAvailable: z.boolean() }).strict(),
  resources: z.object({ version: z.literal(1), revision, roots: z.array(z.object({ rootId: z.string().min(1), workspacePath: z.string().min(1) }).strict()), agents: z.array(z.object({ agentId: z.string().min(1), projectId: z.string().min(1), name: z.string().min(1), workspacePath: z.string().min(1), enabled: z.boolean(), archived: z.boolean() }).strict()) }).strict(),
}).strict();
const capabilities = z.object({ kind: z.literal("capabilities"), version: z.literal(1), methods: z.array(z.enum(["host.snapshot", "config.set", "credential.set", "resources.create", "receipt.get", "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register"])), providerKinds: z.array(z.enum(["anthropic", "openai"])), limits: z.object({ directoryEntries: z.literal(128), pathBytes: z.literal(4096) }).strict() }).strict();
const directoryList = z.object({ kind: z.literal("directory-list"), rootId: safeText(128), relativePath: z.string().max(4096), entries: z.array(z.object({ name: safeText(255), relativePath: z.string().min(1).max(4096) }).strict()).max(128), nextCursor: z.string().max(4096).nullable() }).strict();
const safeRelative = (value: string, allowRoot: boolean) => {
  return isHostRelativePath(value, allowRoot);
};
function validateExtensionRequest(operation: OwnedHostOperation) {
  if (operation.method === "config.provider.set") {
    const params = operation.params;
    const valid = provider.safeParse(params.provider).success && isHostProviderProfile(params.provider) && isHostModelId(params.model) && isHostWorkspaceSelection(params.workspace) && revision.safeParse(params.expectedRevision).success && z.string().uuid().safeParse(params.mutationId).success;
    if (!valid) throw { code: "HOST_MANAGEMENT_REQUEST_INVALID" };
  } else if (operation.method === "credential.provider.set") {
    const params = operation.params;
    if (!isHostProviderId(params.providerId) || !params.credential || /[\r\n\0]/.test(params.credential) || new TextEncoder().encode(params.credential).length > 16 * 1024 || !revision.safeParse(params.expectedRevision).success || !z.string().uuid().safeParse(params.mutationId).success) throw { code: "HOST_MANAGEMENT_REQUEST_INVALID" };
  } else if (operation.method === "receipt.provider.get") {
    const params = operation.params;
    if (!isHostProviderId(params.providerId) || !z.string().uuid().safeParse(params.mutationId).success) throw { code: "HOST_MANAGEMENT_REQUEST_INVALID" };
  } else if (operation.method === "resources.directory.list") {
    const params = operation.params;
    if (!safeText(128).safeParse(params.rootId).success || !safeRelative(params.relativePath, true) || (params.cursor !== undefined && params.cursor.length > 4096)) throw { code: "HOST_MANAGEMENT_REQUEST_INVALID" };
  } else if (operation.method === "resources.register") {
    const params = operation.params;
    if (!safeText(128).safeParse(params.rootId).success || !safeRelative(params.relativePath, false) || !revision.safeParse(params.expectedRevision).success || !z.string().uuid().safeParse(params.mutationId).success) throw { code: "HOST_MANAGEMENT_REQUEST_INVALID" };
  }
}
const resource = z
  .object({
    created: z.boolean(),
    agentId: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1).max(160),
    workspacePath: z.string().min(1).max(4096),
    enabled: z.boolean(),
    archived: z.boolean(),
  })
  .strict();
function validReceipt(
  result: unknown,
  owner: OwnedHostOwner,
  allowMissing: boolean,
): boolean {
  const kind =
    owner === "config"
      ? "config-receipt"
      : owner === "credentials"
        ? "credential-receipt"
        : "resource-receipt";
  const identity = { kind: z.literal(kind), mutationId };
  const schemas = [
    z
      .object({
        ...identity,
        status: z.literal("conflict"),
        revision,
        effect: z.literal("none"),
      })
      .strict(),
    owner === "resources"
      ? z
          .object({
            ...identity,
            status: z.literal("persisted"),
            revision: revision.min(1),
            effect: z.enum(["registered-disabled-agent", "existing-agent"]),
            resource,
          })
          .strict()
      : z
          .object({
            ...identity,
            status: z.literal("persisted"),
            revision: revision.min(1),
            effect: z.literal("new-session"),
            ...(owner === "config" ? { settings } : {}),
          })
          .strict(),
    ...(owner === "resources"
      ? [
          z
            .object({
              ...identity,
              status: z.literal("pending"),
              revision,
              effect: z.literal("none"),
            })
            .strict(),
        ]
      : []),
    ...(allowMissing
      ? [
          z.object({ ...identity, status: z.literal("not-found") }).strict(),
          z
            .object({
              kind: z.literal("receipt-not-found"),
              owner: z.literal(owner),
              mutationId,
            })
            .strict(),
        ]
      : []),
  ];
  return schemas.some((schema) => schema.safeParse(result).success);
}
function validExtendedReceipt(result: unknown, owner: "config" | "credentials", allowMissing: boolean): boolean {
  const kind = owner === "config" ? "provider-config-receipt" : "provider-credential-receipt";
  const identity = { kind: z.literal(kind), mutationId };
  const schemas = [
    z.object({ ...identity, status: z.literal("conflict"), revision, effect: z.literal("none") }).strict(),
    owner === "config"
      ? z.object({ ...identity, status: z.literal("persisted"), revision: revision.min(1), effect: z.literal("new-session"), settings: extendedSettings }).strict()
      : z.object({ ...identity, status: z.literal("persisted"), revision: revision.min(1), effect: z.literal("new-session") }).strict(),
    z.object({ ...identity, status: z.literal("pending"), revision, effect: z.literal("none") }).strict(),
    ...(allowMissing ? [z.object({ ...identity, status: z.literal("not-found") }).strict(), z.object({ kind: z.literal("receipt-not-found"), owner: z.literal(owner), mutationId }).strict()] : []),
  ];
  return schemas.some(s => s.safeParse(result).success);
}
export async function ownedHostManagement(
  locator: HostLocator,
  targetScope: OwnedHostScope | null,
  operation: OwnedHostOperation,
  signal: AbortSignal,
): Promise<OwnedHostResponse> {
  abortIfNeeded(signal);
  validateExtensionRequest(operation);
  if (
    locator.connectionId === "official" ||
    (!(["host.snapshot", "host.capabilities"] as string[]).includes(operation.method) && !targetScope)
  )
    throw { code: "HOST_MANAGEMENT_TARGET_REQUIRED" };
  let response: OwnedHostResponse;
  try {
    response = await invoke<OwnedHostResponse>("cmd_agent_network_management", {
      request: { ...locator, targetScope, ...operation },
    });
  } catch (error) {
    const code = ownedHostErrorCode(error);
    const hasCode = error && typeof error === "object" && "code" in error
      && typeof error.code === "string" && /^[A-Z0-9_]{1,128}$/.test(error.code);
    throw {
      code:
        !hasCode &&
        (operation.method.endsWith(".set") || operation.method === "resources.create" || operation.method === "resources.register")
          ? "HOST_MANAGEMENT_UNCONFIRMED"
          : code,
    };
  }
  // Cancellation suppresses stale UI completion; it never retracts a sent write.
  abortIfNeeded(signal);
  const scope = response?.scope;
  if (
    !scope ||
    scope.deviceId !== locator.deviceId ||
    scope.networkId !== locator.networkId ||
    scope.principalId !== locator.principalId ||
    !scope.serviceId ||
    !scope.environment ||
    !Number.isSafeInteger(scope.keyGeneration) ||
    scope.keyGeneration < 1 ||
    (targetScope && !sameOwnedHostScope(scope, targetScope))
  )
    throw {
      code:
        operation.method.endsWith(".set") ||
        operation.method === "resources.create" ||
        operation.method === "resources.register"
          ? "HOST_MANAGEMENT_UNCONFIRMED"
          : "HOST_MANAGEMENT_TARGET_CHANGED",
    };
  if (response.result?.kind === "error")
    throw { code: ownedHostErrorCode(response.result) };
  if (operation.method === "host.snapshot") {
    if (response.result?.kind !== "snapshot" || response.result.hostId !== locator.deviceId)
      throw { code: "HOST_MANAGEMENT_RESPONSE_INVALID" };
  } else if (operation.method === "host.inspect") {
    if (!extendedSnapshot.safeParse(response.result).success || response.result?.kind !== "extended-snapshot" || response.result.hostId !== locator.deviceId)
      throw { code: "HOST_MANAGEMENT_RESPONSE_INVALID" };
  } else if (operation.method === "host.capabilities") {
    if (!capabilities.safeParse(response.result).success) throw { code: "HOST_MANAGEMENT_RESPONSE_INVALID" };
  } else if (operation.method === "resources.directory.list") {
    const parsed = directoryList.safeParse(response.result);
    const location = operation.params.relativePath;
    if (!parsed.success || parsed.data.rootId !== operation.params.rootId || parsed.data.relativePath !== location || parsed.data.entries.some(entry => !isHostRelativePath(entry.relativePath, false) || entry.name === "." || entry.name === ".." || /[\\/]/.test(entry.name) || entry.relativePath !== (location ? `${location}/${entry.name}` : entry.name))) throw { code: "HOST_MANAGEMENT_RESPONSE_INVALID" };
  } else {
    const result = response.result;
    const owner =
      operation.method === "config.provider.set"
        ? "config"
        : operation.method === "credential.provider.set"
          ? "credentials"
          : operation.method === "config.set"
        ? "config"
        : operation.method === "credential.set"
          ? "credentials"
          : operation.method === "resources.create"
            ? "resources"
          : operation.method === "receipt.get" || operation.method === "receipt.provider.get"
            ? operation.params.owner
            : "resources";
    const generic = operation.method === "config.provider.set" || operation.method === "credential.provider.set" || operation.method === "receipt.provider.get";
    const kind = generic ? undefined :
      owner === "config"
        ? "config-receipt"
        : owner === "credentials"
          ? "credential-receipt"
          : "resource-receipt";
    if (
      !result ||
      !("mutationId" in result) ||
      result.mutationId !== operation.params.mutationId ||
      !(generic
        ? validExtendedReceipt(result, owner as "config" | "credentials", operation.method === "receipt.provider.get")
        : validReceipt(result, owner, operation.method === "receipt.get")) ||
      (!generic && result.kind !== kind &&
        !(
          operation.method === "receipt.get" &&
          result.kind === "receipt-not-found" &&
          result.owner === owner
        ))
    )
      throw {
        code:
        operation.method === "receipt.get" || operation.method === "receipt.provider.get"
            ? "HOST_MANAGEMENT_RESPONSE_INVALID"
            : "HOST_MANAGEMENT_UNCONFIRMED",
      };
  }
  return response;
}
