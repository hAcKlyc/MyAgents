import {
  hostAddressKey,
  type HostAddress,
  type HostProviderConfig,
  type HostReceipt,
  type HostPageReceipt,
  type HostResourcePatch,
} from "@/api/hostManagement";

// Window-lifetime drafts only. Credentials never enter this store or disk.
// A pending mutation survives closing details so reopening cannot replay it.
export interface HostDraft {
  config: HostProviderConfig;
  expectedRevision: number;
}
export interface HostPending {
  mutationId: string;
  resource: "provider" | "credential";
  receipt: HostReceipt | null;
}
interface HostLocalState {
  address: HostAddress;
  draft?: HostDraft;
  pending?: HostPending;
  pageDraft?: { patch: HostResourcePatch; expectedRevision: number };
  pagePending?: {
    mutationId: string;
    resource: "resources" | "interaction";
    receipt: HostPageReceipt | null;
  };
}
const states = new Map<string, HostLocalState>();
function state(address: HostAddress): HostLocalState {
  const key = hostAddressKey(address);
  const found = states.get(key) ?? { address };
  states.set(key, found);
  return found;
}
export const getHostDraft = (address: HostAddress) => state(address).draft;
export const getHostPending = (address: HostAddress) => state(address).pending;
export function setHostDraft(address: HostAddress, draft?: HostDraft) {
  state(address).draft = draft;
}
export function setHostPending(address: HostAddress, pending?: HostPending) {
  state(address).pending = pending;
}
export function clearHostManagementScope(
  principalId: string | null,
  networkId: string | null,
) {
  for (const [key, value] of states) {
    if (
      value.address.principalId === principalId &&
      value.address.networkId === networkId
    )
      states.delete(key);
  }
}
export function clearAllHostManagementState() {
  states.clear();
}

export const getHostPageDraft = (address: HostAddress) =>
  state(address).pageDraft;
export function setHostPageDraft(
  address: HostAddress,
  draft?: { patch: HostResourcePatch; expectedRevision: number },
) {
  state(address).pageDraft = draft;
}
export const getHostPagePending = (address: HostAddress) =>
  state(address).pagePending;
export function setHostPagePending(
  address: HostAddress,
  pending?: HostLocalState["pagePending"],
) {
  state(address).pagePending = pending;
}
