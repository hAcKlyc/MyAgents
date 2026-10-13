import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { HostLocator } from "./hostManagement";

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
  | OwnedHostReceipt
  | { kind: "receipt-not-found"; owner: OwnedHostOwner; mutationId: string }
  | { kind: "error"; code: string };
export interface OwnedHostResponse {
  scope: OwnedHostScope;
  result: OwnedHostResult;
}
export type OwnedHostOperation =
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
export async function ownedHostManagement(
  locator: HostLocator,
  targetScope: OwnedHostScope | null,
  operation: OwnedHostOperation,
  signal: AbortSignal,
): Promise<OwnedHostResponse> {
  abortIfNeeded(signal);
  if (
    locator.connectionId === "official" ||
    (operation.method !== "host.snapshot" && !targetScope)
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
        (operation.method.endsWith(".set") ||
          operation.method === "resources.create")
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
        operation.method === "resources.create"
          ? "HOST_MANAGEMENT_UNCONFIRMED"
          : "HOST_MANAGEMENT_TARGET_CHANGED",
    };
  if (response.result?.kind === "error")
    throw { code: ownedHostErrorCode(response.result) };
  if (operation.method === "host.snapshot") {
    if (
      response.result?.kind !== "snapshot" ||
      response.result.hostId !== locator.deviceId
    )
      throw { code: "HOST_MANAGEMENT_RESPONSE_INVALID" };
  } else {
    const result = response.result;
    const owner =
      operation.method === "config.set"
        ? "config"
        : operation.method === "credential.set"
          ? "credentials"
          : operation.method === "resources.create"
            ? "resources"
            : operation.params.owner;
    const kind =
      owner === "config"
        ? "config-receipt"
        : owner === "credentials"
          ? "credential-receipt"
          : "resource-receipt";
    if (
      !result ||
      !("mutationId" in result) ||
      result.mutationId !== operation.params.mutationId ||
      !validReceipt(result, owner, operation.method === "receipt.get") ||
      (result.kind !== kind &&
        !(
          operation.method === "receipt.get" &&
          result.kind === "receipt-not-found" &&
          result.owner === owner
        ))
    )
      throw {
        code:
          operation.method === "receipt.get"
            ? "HOST_MANAGEMENT_RESPONSE_INVALID"
            : "HOST_MANAGEMENT_UNCONFIRMED",
      };
  }
  return response;
}
