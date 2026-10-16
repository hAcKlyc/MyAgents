import { describe, expect, it } from "vitest";
import type { NetworkConnection, NetworkRegistry } from "@/api/agentNetwork";
import { selectedOwnedAccount } from "./ownedAccountSelection";
const account = (
  id: string,
  url = "https://cloud.test",
): NetworkConnection => ({
  id,
  name: id,
  url,
  official: false,
  removing: false,
  snapshot: {
    state: "disconnected",
    principalId: id,
    networkId: null,
    error: null,
    revision: 1,
    authGeneration: 1,
    connectionId: id,
  },
  ownedAccount: {
    state: "authenticated",
    principalId: id,
    bindingId: `binding-${id}`,
    expiresAt: null,
  },
});
const registry = (
  selected: string,
  connections: NetworkConnection[],
): NetworkRegistry => ({
  selected,
  ownedServiceUrl: "https://cloud.test/",
  connections,
});
describe("owned account selection shared by menu and community", () => {
  it("uses the selected principal among multiple accounts on the same issuer", () => {
    expect(
      selectedOwnedAccount(registry("b", [account("a"), account("b")]))?.id,
    ).toBe("b");
  });
  it("requires selection rather than choosing an arbitrary saved principal", () => {
    expect(
      selectedOwnedAccount(registry("official", [account("a"), account("b")])),
    ).toBeNull();
  });
  it("uses a sole eligible account independently of relay state or selected peer", () => {
    expect(
      selectedOwnedAccount(
        registry("other", [
          account("a"),
          account("other", "https://peer.test"),
        ]),
      )?.id,
    ).toBe("a");
  });
  it("excludes official, removed and different issuer records", () => {
    const removed = { ...account("removed"), removing: true };
    const official = { ...account("official"), official: true };
    expect(
      selectedOwnedAccount(
        registry("removed", [
          removed,
          official,
          account("peer", "https://peer.test"),
        ]),
      ),
    ).toBeNull();
  });
});
