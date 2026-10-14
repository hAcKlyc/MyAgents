import { z } from "zod";
import type { RemoteSessionTab } from "./tabContract";
import { remoteTabIdentity } from "./tabContract";

const PREFIX = "moxbots.remoteSession.operation.v1:";
const operationSchema = z
  .object({
    operationId: z.string().uuid(),
    kind: z.enum(["start", "send", "respond", "stop"]),
    status: z.enum(["processing", "unconfirmed"]),
  })
  .strict();
export type KnownRemoteOperation = z.infer<typeof operationSchema>;
export type PendingRemoteOperation =
  | KnownRemoteOperation
  | { operationId: null; kind: "unknown"; status: "unknown" };
const unknown: PendingRemoteOperation = {
  operationId: null,
  kind: "unknown",
  status: "unknown",
};
const keyFor = (tab: RemoteSessionTab) =>
  PREFIX + encodeURIComponent(remoteTabIdentity(tab));
function storage(): Storage {
  return globalThis.localStorage;
}

/** Only operation identifiers are durable. Missing/corrupt storage is never
 * evidence that a sent operation did not execute. No prompt or answers persist. */
export function readRemoteOperation(
  tab: RemoteSessionTab,
): PendingRemoteOperation | null {
  try {
    const value = storage().getItem(keyFor(tab));
    if (value === null) return null;
    if (value.length > 1024) return { ...unknown };
    const parsed = operationSchema.safeParse(JSON.parse(value));
    if (
      !parsed.success ||
      (parsed.data.kind === "start") !== (tab.sessionId === null)
    )
      return { ...unknown };
    return parsed.data;
  } catch {
    return { ...unknown };
  }
}
export function writeRemoteOperation(
  tab: RemoteSessionTab,
  value: KnownRemoteOperation | null,
): void {
  try {
    const ledger = storage(),
      key = keyFor(tab);
    if (!ledger) throw new Error("storage unavailable");
    if (value === null) {
      ledger.removeItem(key);
      if (ledger.getItem(key) !== null)
        throw new Error("receipt removal failed");
    } else {
      const encoded = JSON.stringify(operationSchema.parse(value));
      ledger.setItem(key, encoded);
      if (ledger.getItem(key) !== encoded)
        throw new Error("receipt write failed");
    }
  } catch {
    throw { code: "REMOTE_OPERATION_STORAGE_UNAVAILABLE" };
  }
}
const drafts = new Map<string, string>();
export const readRemoteDraft = (tab: RemoteSessionTab) =>
  drafts.get(remoteTabIdentity(tab)) ?? "";
export const writeRemoteDraft = (tab: RemoteSessionTab, text: string) => {
  if (text) drafts.set(remoteTabIdentity(tab), text);
  else drafts.delete(remoteTabIdentity(tab));
};
export function clearRemoteDraftScope(
  principalId: string | null,
  networkId: string | null,
) {
  for (const key of drafts.keys()) {
    const identity = JSON.parse(key) as (string | null)[];
    if (identity[2] === principalId && identity[3] === networkId)
      drafts.delete(key);
  }
  try {
    const ledger = storage();
    const keys = Array.from({ length: ledger.length }, (_, index) =>
      ledger.key(index),
    ).filter((key): key is string => !!key && key.startsWith(PREFIX));
    for (const key of keys) {
      try {
        const identity: unknown = JSON.parse(
          decodeURIComponent(key.slice(PREFIX.length)),
        );
        if (
          !Array.isArray(identity) ||
          (identity[2] === principalId && identity[3] === networkId)
        )
          ledger.removeItem(key);
      } catch {
        ledger.removeItem(key);
      }
    }
  } catch {
    /* A later operation read remains unknown while storage is unavailable. */
  }
}
/** App lifecycle cleanup drops text only. Durable operation IDs must survive a
 * window close/restart; explicit account boundaries call clearRemoteDraftScope. */
export const clearRemoteDrafts = () => drafts.clear();
