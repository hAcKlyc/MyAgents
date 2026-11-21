import type { Message } from '@/types/chat';
import type { TranscriptOperation } from '../../shared/sessionTranscript';
import type { BufferedLiveRevisionEvent } from './liveRevisionFence';
import { applyTranscriptDisplayOperation } from './transcriptDisplay';
import { applyTranscriptToolDisplayEvent, TRANSCRIPT_TOOL_DISPLAY_EVENTS, type TranscriptToolDisplayEvent } from './transcriptToolDisplay';

/** A request-scoped buffer for the previously unloaded rows. Live rows keep
 * rendering normally while REST is in flight. Overflow discards that page,
 * never current chat state or the ability to continue talking. */
export class TranscriptPage {
    private events: BufferedLiveRevisionEvent[] = [];
    private bytes = 0;
    private overflow = false;

    constructor(readonly sessionId: string, readonly restoreToken: number, readonly connectionGeneration: number) {}

    get isOverflowed(): boolean { return this.overflow; }

    observe(event: BufferedLiveRevisionEvent): void {
        if (this.overflow || event.sessionId !== this.sessionId || event.connectionGeneration !== this.connectionGeneration) return;
        if (event.eventName !== 'chat:transcript-operation' && !TRANSCRIPT_TOOL_DISPLAY_EVENTS.has(event.eventName)) return;
        this.bytes += JSON.stringify(event.data).length * 2;
        if (this.bytes > 1024 * 1024 || this.events.length >= 2048) {
            this.overflow = true;
            this.events = [];
        } else this.events.push(event);
    }

    async complete(messages: Message[], snapshotRevision: number,
        resolveInput: (ref: unknown) => Promise<Record<string, unknown>>,
        adopt?: (rows: Message[]) => void,
    ): Promise<Message[] | null> {
        if (this.overflow) return null;
        let rows = messages;
        for (const event of this.events) {
            if (event.liveRevision <= snapshotRevision) continue;
            if (event.eventName === 'chat:transcript-operation') {
                const { operation } = event.data as { operation: TranscriptOperation };
                if (operation.kind === 'messages-remove') {
                    const removed = new Set(operation.messageIds);
                    rows = rows.filter(row => !removed.has(row.id));
                } else if (operation.kind !== 'message-create' && operation.kind !== 'turn-update') {
                    rows = rows.map(row => applyTranscriptDisplayOperation(row, operation));
                }
            } else {
                let payload = event.data as TranscriptToolDisplayEvent;
                if (payload.inputRef) {
                    // A ref may have resolved before these rows were loaded.
                    // Resolve it for this page too; keep only the small event
                    // reference in the request buffer, not a second large body.
                    const input = await resolveInput(payload.inputRef);
                    if (this.overflow) return null;
                    payload = { ...payload, inputRef: undefined, input, finalInput: true };
                }
                rows = rows.map(row => applyTranscriptToolDisplayEvent(row, event.eventName, payload));
            }
        }
        adopt?.(rows);
        return rows;
    }
}
