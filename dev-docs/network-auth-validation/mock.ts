export { Resource, Channel } from "../../node_modules/@tauri-apps/api/core.js";
import type { NetworkRegistry } from "../../src/renderer/api/agentNetwork";
export const mode = new URLSearchParams(location.search).get("mode") || "expired";
const errors: Record<string, string> = { expired: "OWNED_SESSION_INVALID", transport: "NETWORK_TRANSPORT_FAILED", conflict: "KEY_GENERATION_CONFLICT" };
export const localId = "22222222-2222-4222-8222-222222222222";
const networkId = "11111111-1111-4111-8111-111111111111";
export let registry: NetworkRegistry = {
  revision: 1, selfhostEnabled: true, selected: "qa-owned", connections: [{
    id: "qa-owned", name: "MoXBots · 合成验收网络", official: false, url: "https://network.example.test", removing: false,
    snapshot: { state: mode === "ready" ? "ready" : "disconnected", principalId: "qa-account", networkId, revision: 1, authGeneration: 1, connectionId: "qa-owned", error: mode === "ready" ? null : { code: errors[mode] ?? errors.expired, retryable: mode === "transport" } },
    ownedAccount: { state: mode === "expired" ? "signInRequired" : "authenticated", principalId: "qa-account", expiresAt: mode === "expired" ? 100 : 1_900_000_000 },
  }],
};
// Isolated fixture: no OS credentials, real URLs, model execution or HTTP writes.
export async function invoke(command: string, args?: { request?: { kind: string } }) {
  if (command === "cmd_agent_network_connections") return structuredClone(registry);
  if (command === "cmd_agent_network_owned_start") return { attemptId: "qa-attempt", authorizationUrl: "https://network.example.test/authorize", expiresAt: 1_900_000_000 };
  if (command === "cmd_agent_network_owned_poll") {
    registry = { ...registry, revision: 2, connections: registry.connections.map(c => ({ ...c, snapshot: { ...c.snapshot, state: "ready", error: null, revision: 2, authGeneration: 2 }, ownedAccount: { state: "authenticated", principalId: "qa-account", expiresAt: 1_900_000_000 } })) };
    return { status: "authenticated", registry };
  }
  if (command === "cmd_agent_network_owned_cancel") return;
  if (command === "cmd_agent_network_select") return structuredClone(registry);
  if (command !== "cmd_agent_network_request") throw new Error(`Native command excluded from QA: ${command}`);
  if (args?.request?.kind === "network") return { serviceId: "33333333-3333-4333-8333-333333333333", networkId, principalId: "qa-account", environment: "development", name: registry.connections[0].name, revision: 1, protocol: 1, capabilities: [] };
  if (["devices", "agents", "callable"].includes(args?.request?.kind ?? "")) return { items: [], complete: true, nextCursor: null };
  throw new Error("Network mutation excluded from QA");
}
