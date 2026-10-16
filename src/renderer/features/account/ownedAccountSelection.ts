import type { NetworkConnection, NetworkRegistry } from "@/api/agentNetwork";
import { canonicalOwnedIssuer } from "@/utils/ownedCloud";

export function ownedAccountCandidates(
  registry: NetworkRegistry,
): NetworkConnection[] {
  const issuer = canonicalOwnedIssuer(registry.ownedServiceUrl);
  return issuer
    ? registry.connections.filter(
        (item) =>
          !item.official &&
          !item.removing &&
          item.ownedAccount &&
          canonicalOwnedIssuer(item.url) === issuer,
      )
    : [];
}

/** Never pick an arbitrary saved principal when multiple accounts match. */
export function selectedOwnedAccount(
  registry: NetworkRegistry,
): NetworkConnection | null {
  const eligible = ownedAccountCandidates(registry);
  return (
    eligible.find((item) => item.id === registry.selected) ??
    (eligible.length === 1 ? eligible[0] : null)
  );
}
