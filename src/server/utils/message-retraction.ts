/**
 * Pure core for the SDK refusal-fallback retraction protocol (SDK 0.3.162+).
 *
 * When the primary model ends a stream with stop_reason "refusal", the SDK
 * retries the turn once on a fallback model and RETRACTS the already-delivered
 * messages of the refused leg. The retraction arrives through two idempotent,
 * overlapping channels:
 *
 *   1. `system/model_refusal_fallback` — `retracted_message_uuids` is the
 *      complete audit record for the turn (refused partials + tombstoned
 *      tool_results).
 *   2. The replacement assistant message's `supersedes?: UUID[]` field —
 *      names the messages it canonically replaces.
 *
 * Receivers must evict the named messages on arrival; eviction is idempotent
 * (unknown or already-removed uuids are a no-op).
 *
 * MyAgents mapping caveats:
 *
 * - One MessageWire bubble absorbs MULTIPLE SDK assistant messages within a
 *   turn, and `sdkUuid` keeps only the LATEST one (see `chat:message-sdk-uuid`
 *   semantics), so uuid matching identifies the refused bubble only when the
 *   refused leg delivered at least one final assistant frame.
 * - A refusal can cut the stream BEFORE any final assistant frame: the refused
 *   bubble then has no sdkUuid (or a stale one) and uuid matching misses it
 *   entirely. `fallbackToStreamingTail` covers this: a retraction event by
 *   protocol interrupts the CURRENT stream, so when the caller reports an
 *   active stream and no uuid matched the tail assistant bubble, the tail IS
 *   the refused content and is evicted too.
 */

export interface RetractionCandidate {
  /** MessageWire.id — the frontend bubble identity. */
  id: string;
  /** Message role — the streaming-tail fallback only ever evicts an assistant bubble. */
  role?: string;
  /** Latest SDK wire uuid absorbed by this bubble, if any. */
  sdkUuid?: string;
}

export interface RetractionOptions {
  /**
   * Caller reports a streaming bubble is currently open (isStreamingMessage).
   * When true and no retracted uuid matched the tail assistant bubble, the
   * tail is evicted anyway — the refusal interrupted exactly that stream.
   */
  fallbackToStreamingTail?: boolean;
}

export interface RetractionPlan {
  /** Bubbles to remove, in original order. Empty when nothing matches (no-op). */
  removedMessageIds: string[];
  /** Whether the LAST message in the list is among the removed ones — the
   * caller must then reset its streaming-bubble state so the replacement leg
   * starts a fresh bubble instead of concatenating onto refused content.
   * Receivers without server message ids (the live frontend) key on this flag
   * instead of the id list. */
  removedStreamingTail: boolean;
}

const EMPTY_PLAN: RetractionPlan = Object.freeze({ removedMessageIds: [], removedStreamingTail: false });

/**
 * Compute which messages a retraction evicts. Pure, total, idempotent:
 * uuids that match nothing simply don't contribute, and a second call after
 * the first eviction (double-channel replay) yields an empty plan because the
 * matched bubbles are gone and the caller's streaming flag has been reset.
 */
export function planRetraction(
  messages: readonly RetractionCandidate[],
  retractedUuids: readonly string[],
  options?: RetractionOptions,
): RetractionPlan {
  if (retractedUuids.length === 0 || messages.length === 0) {
    return EMPTY_PLAN;
  }
  const uuidSet = new Set(retractedUuids);
  const removedMessageIds: string[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.sdkUuid && uuidSet.has(m.sdkUuid)) {
      removedMessageIds.push(m.id);
    }
  }
  const tail = messages[messages.length - 1];
  let removedStreamingTail =
    removedMessageIds.includes(tail.id) &&
    tail.sdkUuid !== undefined &&
    uuidSet.has(tail.sdkUuid);
  if (
    !removedStreamingTail &&
    options?.fallbackToStreamingTail &&
    tail.role === 'assistant' &&
    !removedMessageIds.includes(tail.id)
  ) {
    removedMessageIds.push(tail.id);
    removedStreamingTail = true;
  }
  if (removedMessageIds.length === 0) {
    return EMPTY_PLAN;
  }
  return { removedMessageIds, removedStreamingTail };
}
