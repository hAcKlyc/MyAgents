import { managementApi } from "../utils/management-api-client";
import {
  parseNetworkReturnReference,
  type NetworkReturnReference,
} from "../../shared/agentNetworkReturn";
import type { SessionEvent } from "../inbox/session-event";
import { returnSessionEventSchema } from "@myagents/agent-network-protocol";

export type NetworkReturnSettlement = "delivered" | "unconfirmed" | "dropped";

// Diagnostics contain correlation only, never event bodies or free-form errors.
function diagnosticToken(value: unknown, fallback = "none"): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : fallback;
}

/** Preserve the existing terminal hook and per-turn metadata. The App owns
 * the peer identity and encryption; a Sidecar cannot select a remote device. */
export async function deliverNetworkReturn(
  reference: NetworkReturnReference,
  event: SessionEvent,
): Promise<NetworkReturnSettlement> {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  const invalid = !sidecarId ? "SOURCE_OWNER_UNAVAILABLE"
    : !parseNetworkReturnReference(reference) ? "RETURN_REFERENCE_INVALID"
    : !returnSessionEventSchema.safeParse(event).success ? "RETURN_EVENT_INVALID" : null;
  if (invalid) {
    console.warn(`[agent-network/return] stage=reject settlement=dropped code=${invalid}`);
    return "dropped";
  }
  const correlation = `op_id=${reference.opId} route_id=${reference.returnRouteId}`
    + ` event_id=${diagnosticToken(event.eventId)} type=${event.type}`
    + ` request_event_id=${diagnosticToken('requestEventId' in event ? event.requestEventId : undefined)}`
    + ` watch_id=${diagnosticToken('watchId' in event ? event.watchId : undefined)}`
    + ` turn_id=${diagnosticToken(event.turnId)}`;
  console.log(`[agent-network/return] stage=submit ${correlation}`);
  const result = await managementApi(
    "/api/agent-network/return",
    "POST",
    {
      sidecarId,
      reference,
      event,
    },
    { timeoutMs: 32_000 },
  );
  const error = result.error;
  const code = result.ok === true ? "none" : diagnosticToken(
    error && typeof error === "object" && 'code' in error ? error.code : result.code,
    "RETURN_REJECTED",
  );
  const settlement = result.ok !== true
    ? result.code === "transport_outcome_unknown" ? "unconfirmed" : "dropped"
    : result.settlement === "delivered" || result.settlement === "dropped"
      ? result.settlement : "unconfirmed";
  const log = settlement === "delivered" ? console.log : console.warn;
  log(`[agent-network/return] stage=settle settlement=${settlement} code=${code} ${correlation}`);
  return settlement;
}
