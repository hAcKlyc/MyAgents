export { Resource, Channel } from "../../node_modules/@tauri-apps/api/core.js";
// Isolated metadata only: no credentials, native calls, HTTP requests or writes.
export const networkId = "11111111-1111-4111-8111-111111111111";
export const localId = "22222222-2222-4222-8222-222222222222";
export const remoteId = "33333333-3333-4333-8333-333333333333";
const epoch = "44444444-4444-4444-8444-444444444444";
export const snapshot = { state: "ready", connectionId: "qa-owned", networkId, principalId: "qa-account", revision: 1, authGeneration: 1, error: null };
export const mode = new URLSearchParams(location.search).get("mode") || "empty";
const base = { principalId: "qa-account", networkId, osVersion: "Ubuntu 24.04", appVersion: "0.5.6-qa", lastNetworkSeenAt: Date.now(), lastAccountSeenAt: "2026-10-16T00:00:00Z", rosterRevision: "1", catalogEpoch: epoch, catalogSeq: 1, catalogSyncedAt: Date.now(), joined: true, membershipRevision: 1, connectionState: "ready", onlineAgentCount: 0 };
export const devices = [{ ...base, deviceId: localId, name: "Mac mini · 本机", platform: "darwin-aarch64" }, { ...base, deviceId: remoteId, name: "Linux Host · 验收服务器", platform: "linux-x86_64", connectionState: mode === "offline" ? "offline" : "ready" }];
const mountId = "55555555-5555-4555-8555-555555555555";
const source = { serviceId: "66666666-6666-4666-8666-666666666666", networkId };
const callable = { mountId, localAgentId: "qa-agent", name: "资料整理", description: null, deviceId: remoteId, deviceName: devices[1].name, platform: "linux-x86_64", membershipRevision: 1, enableRevision: 1, selector: "qa-agent", isLocal: false, source, connectionEpoch: epoch, keyGeneration: 1, signedBinding: null };
export const audit: unknown[] = [];
export async function invoke(command: string, args?: { request?: { kind: string; deviceId?: string } }) {
  audit.push({ command, args });
  if (command !== "cmd_agent_network_request") throw new Error(`Native call excluded from QA: ${command}`);
  const kind = args?.request?.kind;
  if (kind === "network") return { ...source, principalId: "qa-account", environment: "development", name: "MoXBots · 验收网络", revision: 1, protocol: 1, capabilities: [] };
  if (kind === "devices") {
    if (mode === "failure") throw new Error("QA metadata unavailable");
    return { items: devices, nextCursor: null, complete: true };
  }
  if (kind === "agents") return { items: [], nextCursor: null, complete: true };
  if (kind === "callable") {
    if (mode === "callable-failure") throw new Error("QA callable unavailable");
    return { items: mode === "callable" || mode === "offline" ? [callable] : [], nextCursor: mode === "partial" ? remoteId : null, complete: mode !== "partial" };
  }
  throw new Error(`Mutation excluded from QA: ${kind}`);
}
