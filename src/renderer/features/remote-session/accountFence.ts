import type { NetworkSnapshot } from "@/api/agentNetwork";
import type { HostLocator } from "@/api/hostManagement";
import type { RemoteSessionTab } from "./tabContract";

/** Cold startup has no account authority yet. Unknown identity locks the
 * content while keeping its locator; it must never discard a restore target. */
export function remoteAccountState(
  locator: HostLocator,
  current: NetworkSnapshot | null | undefined,
): "pending" | "match" | "mismatch" {
  if (!current) return "pending";
  if (current.state === "signedOut") return "mismatch";
  if (
    current.principalId !== null &&
    current.principalId !== locator.principalId
  )
    return "mismatch";
  if (current.networkId !== null && current.networkId !== locator.networkId)
    return "mismatch";
  if (current.principalId === null || current.networkId === null)
    return "pending";
  return "match";
}
export function restoreRemoteTabForAccount(
  tab: RemoteSessionTab,
  current: NetworkSnapshot | null | undefined,
): RemoteSessionTab | null {
  const state = remoteAccountState(tab.locator, current);
  if (state === "mismatch") return null;
  return state === "match" && current
    ? {
        ...tab,
        locator: { ...tab.locator, authGeneration: current.authGeneration },
      }
    : tab;
}
