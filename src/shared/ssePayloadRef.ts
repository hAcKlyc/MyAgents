import type { LargeValueRef } from './types/large-value';

export const SSE_PAYLOAD_INLINE_MAX_BYTES = 256 * 1024;

/** Transport-only envelope. Decode before applying any business event/revision. */
export interface SsePayloadRef {
  kind: 'sse-payload-ref';
  ref: LargeValueRef;
}

export function isSsePayloadRef(value: unknown): value is SsePayloadRef {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<SsePayloadRef>;
  return envelope.kind === 'sse-payload-ref'
    && envelope.ref?.kind === 'ref'
    && typeof envelope.ref.id === 'string'
    && /^[a-f0-9]{8,32}$/.test(envelope.ref.id)
    && envelope.ref.mimetype === 'application/json';
}
