import { describe, expect, it } from 'vitest';
import type { Message } from '@/types/chat';
import { applyTranscriptDisplayOperation } from './transcriptDisplay';
import { applyTranscriptToolDisplayEvent } from './transcriptToolDisplay';
import { TranscriptPage } from './transcriptPage';

function row(): Message {
    return { id: 'a1', role: 'assistant', timestamp: new Date(0), content: [
        { id: 'text', type: 'text', text: 'preview' },
        { id: 'block', type: 'tool_use', tool: {
            id: 'tool', name: 'Task', streamIndex: 0, input: { command: 'hello' }, result: 'old', isLoading: true,
            subagentCalls: [{ id: 'child', name: 'Read', input: {}, result: 'nested' }],
        } },
    ] };
}

describe('V2 displayed rows', () => {
    it('applies text correction by block identity and appends beyond a truncated REST preview', () => {
        let message = row();
        message = applyTranscriptDisplayOperation(message, { kind: 'text-append', messageId: 'a1', blockId: 'text', field: 'text', offset: 9000, text: '尾巴' });
        expect(message.content).toMatchObject([{ text: 'preview尾巴' }, {}]);
        message = applyTranscriptDisplayOperation(message, { kind: 'block-upsert', messageId: 'a1', block: { id: 'text', type: 'text', text: '完整修正', isComplete: true } });
        expect(message.content).toMatchObject([{ text: '完整修正', isComplete: true }, {}]);
        const omitted = applyTranscriptDisplayOperation(message, { kind: 'text-append', messageId: 'a1', blockId: 'omitted', field: 'text', offset: 0, text: 'ignored' });
        expect(omitted).toBe(message);
    });

    it('keeps tool previews across identity confirmation and updates nested results on the original row', () => {
        let message = applyTranscriptDisplayOperation(row(), { kind: 'block-upsert', messageId: 'a1', block: { id: 'block', type: 'tool_use', tool: { id: 'tool', name: 'Task' } } });
        message = applyTranscriptToolDisplayEvent(message, 'chat:subagent-tool-result-complete', { parentToolUseId: 'tool', toolUseId: 'child', content: 'finished' });
        expect(message.content).toMatchObject([{}, { tool: { input: { command: 'hello' }, result: 'old', isLoading: true, subagentCalls: [{ result: 'finished' }] } }]);
        // A preview/ref transport must not erase the already known input.
        message = applyTranscriptToolDisplayEvent(message, 'chat:subagent-tool-use', { parentToolUseId: 'tool', tool: { id: 'child', name: 'Read', input: {} }, inputRef: { id: 'ref' }, finalInput: true });
        expect(message.content).toMatchObject([{}, { tool: { subagentCalls: [{ result: 'finished' }] } }]);
    });

    it('reconciles only post-snapshot events into a late page, including removals and tool payloads', async () => {
        const page = new TranscriptPage('session', 1, 2);
        const observe = (revision: number, eventName: string, data: unknown) => page.observe({ sessionId: 'session', connectionGeneration: 2, liveRevision: revision, eventName, data });
        observe(9, 'chat:tool-result-delta', { toolUseId: 'tool', delta: 'already in snapshot' });
        observe(11, 'chat:tool-result-complete', { toolUseId: 'tool', content: 'late final' });
        observe(12, 'chat:transcript-operation', { operation: { kind: 'blocks-remove', messageId: 'a1', blockIds: ['text'] } });
        const messages = await page.complete([row()], 10, async () => ({}));
        expect(messages?.[0].content).toEqual([expect.objectContaining({ id: 'block', tool: expect.objectContaining({ result: 'late final' }) })]);
    });

    it.each(['root', 'nested'])('resolves %s input for a late page even when the live resolution preceded the page', async kind => {
        const page = new TranscriptPage('session', 1, 2);
        const input = { content: 'complete final input' };
        page.observe({ sessionId: 'session', connectionGeneration: 2, liveRevision: 11,
            eventName: kind === 'root' ? 'chat:content-block-stop' : 'chat:subagent-tool-use',
            data: kind === 'root' ? { toolId: 'tool', inputRef: 'ref' }
                : { parentToolUseId: 'tool', tool: { id: 'child', name: 'Read' }, inputRef: 'ref', finalInput: true },
        });
        const messages = await page.complete([row()], 10, async ref => { expect(ref).toBe('ref'); return input; });
        expect(messages?.[0].content).toMatchObject([{}, { tool: kind === 'root' ? { input }
            : { subagentCalls: [{ id: 'child', input }] } }]);
    });

    it('replays corrections arriving while a prefetched tool input resolves before the synchronous prepend', async () => {
        const page = new TranscriptPage('session', 1, 2);
        const observe = (liveRevision: number, eventName: string, data: unknown) =>
            page.observe({ sessionId: 'session', connectionGeneration: 2, liveRevision, eventName, data });
        observe(11, 'chat:content-block-stop', { toolId: 'tool', inputRef: 'ref' });
        const adopted: Message[] = [];
        await page.complete([row()], 10, async () => {
            await Promise.resolve();
            observe(12, 'chat:tool-result-complete', { toolUseId: 'tool', content: 'corrected' });
            return { command: 'latest' };
        }, rows => adopted.push(...rows));
        expect(adopted[0].content).toMatchObject([{}, { tool: { input: { command: 'latest' }, result: 'corrected' } }]);
    });

    it('bounds an abandoned page buffer independently of the live conversation', async () => {
        const page = new TranscriptPage('session', 1, 2);
        page.observe({ sessionId: 'session', connectionGeneration: 2, liveRevision: 1, eventName: 'chat:tool-result-delta', data: { toolUseId: 'tool', delta: 'x'.repeat(1024 * 1024) } });
        expect(await page.complete([row()], 0, async () => ({}))).toBeNull();
    });
});
