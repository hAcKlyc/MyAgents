import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import {
  remoteSessionRequestSchema,
  remoteSessionResultSchema,
  isRemoteMutation,
  REMOTE_SESSION_BYTES,
  type RemoteSessionRequest,
  type RemoteSessionResult,
} from "@/../shared/remoteSession";
import type { HostLocator } from "./hostManagement";
import { sameOwnedHostScope, type OwnedHostScope } from "./ownedHostManagement";
import { currentNetworkSnapshot } from "@/features/agent-network/store";

export const remoteScopeSchema = z
  .object({
    serviceId: z.string().min(1).max(256),
    environment: z.string().min(1).max(256),
    principalId: z.string().min(1).max(256),
    networkId: z.string().min(1).max(256),
    deviceId: z.string().min(1).max(256),
    keyGeneration: z.number().int().positive(),
  })
  .strict();
const responseSchema = z
  .object({
    scope: remoteScopeSchema,
    result: z
      .object({
        kind: z.literal("remote-session"),
        data: remoteSessionResultSchema,
      })
      .strict(),
  })
  .strict();
export function remoteAccountMatches(locator: HostLocator): boolean {
  const snapshot = currentNetworkSnapshot(locator.connectionId);
  return (
    !!snapshot &&
    snapshot.principalId === locator.principalId &&
    snapshot.networkId === locator.networkId &&
    snapshot.authGeneration === locator.authGeneration &&
    snapshot.state !== "signedOut"
  );
}
export function remoteErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,128}$/.test(error.code)
  )
    return error.code;
  return "REMOTE_SESSION_UNAVAILABLE";
}
export async function remoteSessionRequest(
  locator: HostLocator,
  targetScope: OwnedHostScope | null,
  request: RemoteSessionRequest,
  signal: AbortSignal,
): Promise<{ scope: OwnedHostScope; data: RemoteSessionResult }> {
  const fence = () => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!remoteAccountMatches(locator))
      throw { code: "REMOTE_SESSION_ACCOUNT_CHANGED" };
  };
  fence();
  const snapshot = currentNetworkSnapshot(locator.connectionId);
  if (
    locator.connectionId === "official" ||
    (!targetScope && request.kind !== "capabilities")
  )
    throw { code: "REMOTE_SESSION_TARGET_REQUIRED" };
  if (snapshot?.state !== "ready") throw { code: "REMOTE_SESSION_OFFLINE" };
  remoteSessionRequestSchema.parse(request);
  let raw: unknown;
  try {
    raw = await invoke("cmd_agent_network_management", {
      request: {
        ...locator,
        targetScope,
        method: "session.remote",
        params: { remoteSession: request },
      },
    });
  } catch (error) {
    fence();
    throw {
      code: isRemoteMutation(request)
        ? "REMOTE_SESSION_UNCONFIRMED"
        : remoteErrorCode(error),
    };
  }
  fence();
  const invalid = () => ({
    code: isRemoteMutation(request)
      ? "REMOTE_SESSION_UNCONFIRMED"
      : "REMOTE_SESSION_RESPONSE_INVALID",
  });
  if (
    new TextEncoder().encode(JSON.stringify(raw)).length >
    REMOTE_SESSION_BYTES + 4096
  )
    throw invalid();
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const {
    scope,
    result: { data },
  } = parsed.data;
  if (
    scope.principalId !== locator.principalId ||
    scope.networkId !== locator.networkId ||
    scope.deviceId !== locator.deviceId ||
    (targetScope && !sameOwnedHostScope(scope, targetScope))
  )
    throw invalid();
  if (data.kind === "error") throw { code: data.code };
  if (data.agentId !== request.agentId) throw invalid();
  const expected =
    request.kind === "get"
      ? "snapshot"
      : isRemoteMutation(request)
        ? "receipt"
        : request.kind;
  if (data.kind !== expected) throw invalid();
  if (
    "sessionId" in request &&
    data.kind === "snapshot" &&
    data.sessionId !== request.sessionId
  )
    throw invalid();
  if (
    "operationId" in request &&
    data.kind === "receipt" &&
    data.operationId !== request.operationId
  )
    throw invalid();
  if (
    "sessionId" in request &&
    data.kind === "receipt" &&
    data.sessionId !== null &&
    data.sessionId !== request.sessionId
  )
    throw invalid();
  return { scope, data };
}
