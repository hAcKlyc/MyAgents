import { describe, expect, it } from 'vitest';

import {
  CLIENT_HISTORY_AUXILIARY_MAX_BYTES,
  isHumanUserMessage,
  resolveLastVisibleTurnPreview,
  resolveVisibleUserTurnText,
  shrinkSessionMessageForClient,
  shrinkReplayContentForClient,
} from './session-message-preview';
import type { SessionMessage } from '../types/session';
import {
  buildFloatingBallContextReminder,
  LOCAL_COMMAND_OUTPUT_TAG,
  SESSION_EVENT_TAG,
} from '../../shared/systemReminder';

function msg(content: string): SessionMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content,
    timestamp: '2026-05-25T00:00:00.000Z',
  };
}

describe('session-message-preview', () => {
  it('distinguishes human-visible queries from maintenance and scheduled turns', () => {
    const isHuman = (content: string, attachments?: SessionMessage['attachments']) => (
      isHumanUserMessage({ content, attachments })
    );

    expect(isHuman('普通用户消息')).toBe(true);
    expect(isHuman(
      '<system-reminder><MEMORY_UPDATE>maintain</MEMORY_UPDATE></system-reminder>',
    )).toBe(false);
    expect(isHuman(
      '<system-reminder><CRON_TASK>scheduled</CRON_TASK></system-reminder>task prompt',
    )).toBe(false);
    expect(isHuman(
      '<system-reminder><GOAL_CONTINUATION>continue</GOAL_CONTINUATION></system-reminder>',
    )).toBe(false);
    expect(isHuman(
      '<system-reminder><GOAL_CONTINUATION>continue</GOAL_CONTINUATION></system-reminder>用户发起的 Goal 输入',
    )).toBe(true);
    expect(isHuman(
      '<system-reminder><GOAL_CONTEXT>context</GOAL_CONTEXT></system-reminder>用户追问',
    )).toBe(true);
    expect(isHuman('请解释为什么会出现 /UPDATE_MEMORY')).toBe(true);
    expect(isHuman('请解释 <CRON_TASK> 标签')).toBe(true);
    expect(isHuman(
      `<system-reminder><${LOCAL_COMMAND_OUTPUT_TAG}>local</${LOCAL_COMMAND_OUTPUT_TAG}></system-reminder><local-command-stdout>cost output</local-command-stdout>`,
    )).toBe(false);
    expect(isHuman(
      `<system-reminder><${SESSION_EVENT_TAG}>result</${SESSION_EVENT_TAG}></system-reminder>`,
    )).toBe(false);
    expect(isHuman(
      '<system-reminder><myagents-space-issue>issue</myagents-space-issue></system-reminder>',
    )).toBe(false);
    expect(isHuman('请解释 <inbox-message> 标签')).toBe(true);
    expect(isHuman('', [{
      id: 'image-1',
      name: 'image.png',
      mimeType: 'image/png',
      path: 'image.png',
    }])).toBe(true);
    expect(isHumanUserMessage(
      { content: '<system-reminder><CRON_TASK>quoted</CRON_TASK></system-reminder>human text' },
      { kind: 'desktop', surface: 'launcher_input' },
    )).toBe(false);
    expect(isHumanUserMessage(
      { content: '<system-reminder><myagents-space-issue>issue</myagents-space-issue></system-reminder>Visible issue' },
      { kind: 'registered-agent', surface: 'space_issue_delivery', context: { spaceId: 'space-1', registeredAgentId: 'ra-1' } },
    )).toBe(false);
  });

  it.each(['rest', 'replay-array', 'replay-string'] as const)('preserves every answer block under tool pressure through %s (#665)', (path) => {
    const finalText = '结论'.repeat(372); // 2,232 UTF-8 bytes; small on its own.
    const blocks = [
      ...Array.from({ length: 191 }, (_, i) => ({ type: 'tool_use', id: `block-${i}`, tool: {
        id: `call-${i}`, name: 'Read', inputJson: JSON.stringify({ query: 'i'.repeat(10_000) }),
        parsedInput: { query: 'i'.repeat(10_000) }, result: JSON.stringify({ output: 'o'.repeat(20_000) }),
      } })),
      ...Array.from({ length: 118 }, (_, i) => ({ type: 'thinking', id: `thinking-${i}`, thinking: 't'.repeat(8_000) })),
      ...Array.from({ length: 17 }, (_, i) => ({ type: 'text', id: `text-${i}`, text: `Progress ${i}.` })),
      { type: 'text', id: 'final', text: finalText },
    ];
    const serialized = JSON.stringify(blocks);
    const projected = path === 'rest' ? shrinkSessionMessageForClient(msg(serialized)).content
      : shrinkReplayContentForClient(path === 'replay-array' ? blocks : serialized);
    const output = typeof projected === 'string' ? JSON.parse(projected) : projected;
    expect(output.filter((block: { type: string }) => block.type === 'text')).toEqual(blocks.filter(block => block.type === 'text'));
    expect(JSON.stringify(blocks)).toBe(serialized);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(CLIENT_HISTORY_AUXILIARY_MAX_BYTES);
  });

  it('retains huge prose and middle answer blocks even when auxiliary blocks must be omitted', () => {
    const body = { type: 'text', id: 'middle', text: '完整😀'.repeat(100_000) };
    const tools = Array.from({ length: 1800 }, (_, i) => ({
      type: 'tool_use', id: `block-${i}`, tool: { id: `tool-${i}`, name: 'Read', result: 'x'.repeat(1000) },
    }));
    const input = [...tools.slice(0, 900), body, ...tools.slice(900)];
    const output = shrinkReplayContentForClient(input) as typeof input;
    expect(output.find(block => block.id === 'middle')).toEqual(body);
    expect(output.filter(block => block.type !== 'text').length).toBeLessThan(1800);
    expect(Buffer.byteLength(JSON.stringify(output.filter(block => block.type !== 'text')))).toBeLessThan(CLIENT_HISTORY_AUXILIARY_MAX_BYTES);
    expect(output.findIndex(block => block.id === 'middle')).toBeGreaterThan(0);
    expect(output.at(-1)?.id).toBe('block-1799');
    expect(input[900]).toEqual(body);
  });

  it('keeps normal history messages unchanged by reference', () => {
    const input = msg('short message');
    expect(shrinkSessionMessageForClient(input)).toBe(input);
  });

  it('preserves oversized plain body for transport spilling', () => {
    const original = `HEAD-${'a'.repeat(CLIENT_HISTORY_AUXILIARY_MAX_BYTES)}-TAIL`;
    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content).toBe(original);
  });

  it('preserves every UTF-8 character in a huge body', () => {
    const original = `开头${'界'.repeat(CLIENT_HISTORY_AUXILIARY_MAX_BYTES)}结尾`;
    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content).toContain('开头');
    expect(output.content).toContain('结尾');
    expect(output.content).toBe(original);
  });

  it('preserves oversized structured assistant history as parseable content blocks', () => {
    const inputJson = JSON.stringify({
      command: 'npm test',
      cwd: '/tmp/project',
      large: 'input-'.repeat(20_000),
    }, null, 2);
    const resultJson = JSON.stringify({
      stdout: 'output-'.repeat(CLIENT_HISTORY_AUXILIARY_MAX_BYTES),
      stderr: '',
      exitCode: 0,
    }, null, 2);
    const original = JSON.stringify([
      {
        type: 'thinking',
        thinking: 'thought-'.repeat(20_000),
        isComplete: true,
      },
      {
        type: 'tool_use',
        tool: {
          id: 'call_1',
          name: 'Bash',
          input: JSON.parse(inputJson),
          inputJson,
          parsedInput: JSON.parse(inputJson),
          result: resultJson,
          isLoading: false,
        },
      },
      {
        type: 'text',
        text: 'final answer',
      },
    ]);

    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content).not.toBe(original);
    expect(output.content.startsWith('[')).toBe(true);
    expect(Buffer.byteLength(output.content, 'utf8')).toBeLessThan(CLIENT_HISTORY_AUXILIARY_MAX_BYTES);

    const parsed = JSON.parse(output.content) as Array<{
      type: string;
      thinking?: string;
      text?: string;
      tool?: {
        id?: string;
        name?: string;
        input?: unknown;
        inputJson?: string;
        parsedInput?: unknown;
        result?: string;
      };
    }>;
    expect(parsed.map((block) => block.type)).toEqual(['thinking', 'tool_use', 'text']);
    expect(parsed[0].thinking).toContain('history display truncated');
    expect(parsed[1].tool?.id).toBe('call_1');
    expect(parsed[1].tool?.name).toBe('Bash');
    expect(parsed[1].tool?.input).toBeUndefined();
    expect(parsed[1].tool?.inputJson).toBeDefined();
    expect(parsed[1].tool?.parsedInput).toBeDefined();
    expect(JSON.parse(parsed[1].tool?.result ?? '{}')).toMatchObject({
      stderr: '',
      exitCode: 0,
    });
    expect(JSON.parse(parsed[1].tool?.result ?? '{}').stdout).toContain('history display truncated');
    expect(parsed[2].text).toBe('final answer');
  });

  it('preserves malformed JSON-looking legacy body as plain text', () => {
    const original = `[{"type":"text","text":"${'x'.repeat(CLIENT_HISTORY_AUXILIARY_MAX_BYTES)}"`;
    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content).toBe(original);
    expect(() => JSON.parse(output.content)).toThrow();
  });

  it('extracts last real user preview instead of the trailing assistant response', () => {
    const result = resolveLastVisibleTurnPreview([
      { role: 'user', content: '用户真正的问题', id: 'u1', timestamp: 't1' } as SessionMessage,
      { role: 'assistant', content: '我会先处理这个问题', id: 'a1', timestamp: 't2' } as SessionMessage,
    ]);

    expect(result).toEqual({ found: true, preview: '用户真正的问题' });
  });

  it('keeps the previous visible preview after an attachment-only turn', () => {
    const result = resolveLastVisibleTurnPreview([
      { role: 'user', content: '前一条可见问题' },
      { role: 'user', content: '   ' },
    ]);

    expect(result).toEqual({ found: true, preview: '前一条可见问题' });
  });

  it('keeps local command output visible without making it the conversation preview', () => {
    const localCommand = `<system-reminder><${LOCAL_COMMAND_OUTPUT_TAG}>local</${LOCAL_COMMAND_OUTPUT_TAG}></system-reminder><local-command-stdout>cost output</local-command-stdout>`;
    expect(resolveVisibleUserTurnText(localCommand)).toBe(
      '<local-command-stdout>cost output</local-command-stdout>',
    );
    expect(resolveLastVisibleTurnPreview([
      { role: 'user', content: '真人问题' },
      { role: 'user', content: localCommand },
    ])).toEqual({ found: true, preview: '真人问题' });
  });

  it('skips pure system reminders but keeps mixed user-visible text', () => {
    const result = resolveLastVisibleTurnPreview([
      {
        role: 'user',
        content: '<system-reminder><HEARTBEAT>A schedule fired</HEARTBEAT></system-reminder>',
        id: 'system',
        timestamp: 't1',
      } as SessionMessage,
      {
        role: 'user',
        content: '<system-reminder>context</system-reminder>用户群聊消息',
        id: 'mixed',
        timestamp: 't2',
      } as SessionMessage,
      { role: 'assistant', content: 'assistant', id: 'a1', timestamp: 't3' } as SessionMessage,
    ]);

    expect(result).toEqual({ found: true, preview: '用户群聊消息' });
  });

  it('does not mine hidden cron payloads for a display preview', () => {
    const result = resolveLastVisibleTurnPreview([
      {
        role: 'user',
        content: '<system-reminder>\n<CRON_TASK>\n\n执行任务：# GitHub Issue 自动化处理\n\n每 6 小时自动 triage\n</CRON_TASK>\n</system-reminder>',
        id: 'cron',
        timestamp: 't1',
      } as SessionMessage,
      { role: 'assistant', content: 'assistant', id: 'a1', timestamp: 't2' } as SessionMessage,
    ]);

    expect(result).toEqual({ found: false });
  });

  it('keeps floating-ball mixed queries but skips pure floating context', () => {
    const result = resolveLastVisibleTurnPreview([
      {
        role: 'user',
        content: buildFloatingBallContextReminder({ screenshotAttached: true }),
        id: 'shot-only',
        timestamp: 't1',
      } as SessionMessage,
      {
        role: 'user',
        content: `${buildFloatingBallContextReminder({ appName: 'Safari', selectedText: 'selected' })}\n\n解释这段文字`,
        id: 'mixed',
        timestamp: 't2',
      } as SessionMessage,
    ]);

    expect(result).toEqual({ found: true, preview: '解释这段文字' });
  });

  // ── Shared REST/replay auxiliary projection ──
  describe('shrinkReplayContentForClient', () => {
    it('passes through small string content by reference', () => {
      const s = 'short reply';
      expect(shrinkReplayContentForClient(s)).toBe(s);
    });

    it('passes through small ContentBlock[] content by reference', () => {
      const blocks = [{ type: 'text', text: 'hi' }];
      expect(shrinkReplayContentForClient(blocks)).toBe(blocks);
    });

    it('shrinks an oversized ContentBlock[] but KEEPS the array shape (renderer needs blocks)', () => {
      // Mirrors a Codex sub-agent fan-out turn: many tool blocks with huge results.
      const blocks = Array.from({ length: 400 }, (_, i) => ({
        type: 'tool_use',
        tool: { id: `call_${i}`, name: 'Bash', result: 'output-'.repeat(2000), isLoading: false },
      }));
      const out = shrinkReplayContentForClient(blocks);

      expect(Array.isArray(out)).toBe(true); // shape preserved — NOT a JSON string
      const arr = out as Array<{ type: string; tool?: { id?: string; name?: string } }>;
      expect(arr[0].type).toBe('tool_use');
      expect(arr[0].tool?.name).toBe('Bash');
      // Tool-only payload stays within the auxiliary budget.
      expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(CLIENT_HISTORY_AUXILIARY_MAX_BYTES);
    });

    it('guarantees under-cap (array shape) even at extreme block counts where minimal blocks alone exceed the cap', () => {
      // 900 tool blocks: even the minimal per-block form (id/name/result≤256B) sums
      // > 256KB. This is the real 757-block Codex fan-out class that the first fix
      // pass missed (Codex review HIGH). Must still come back under cap AS AN ARRAY.
      const blocks = Array.from({ length: 900 }, (_, i) => ({
        type: 'tool_use',
        tool: { id: `call_${i}`, name: 'Bash', result: 'output-'.repeat(2000), isLoading: false },
      }));
      const out = shrinkReplayContentForClient(blocks);

      expect(Array.isArray(out)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(CLIENT_HISTORY_AUXILIARY_MAX_BYTES);
      // An omission marker block is present so the user knows content was dropped.
      const arr = out as Array<{ type: string; text?: string }>;
      expect(arr.some(b => b.type === 'text' && (b.text ?? '').includes('blocks omitted'))).toBe(true);
    });

    it('preserves oversized plain replay body', () => {
      const big = `HEAD-${'z'.repeat(CLIENT_HISTORY_AUXILIARY_MAX_BYTES)}-TAIL`;
      const out = shrinkReplayContentForClient(big);
      expect(typeof out).toBe('string');
      expect(out).toBe(big);
    });
  });

  it('keeps heartbeat and memory-update system reminders out of previews', () => {
    const result = resolveLastVisibleTurnPreview([
      {
        role: 'user',
        content: '<system-reminder><HEARTBEAT>A schedule fired</HEARTBEAT></system-reminder>',
        id: 'heartbeat',
        timestamp: 't1',
      } as SessionMessage,
      {
        role: 'user',
        content: '<system-reminder><MEMORY_UPDATE>remember this</MEMORY_UPDATE></system-reminder>',
        id: 'memory',
        timestamp: 't2',
      } as SessionMessage,
      { role: 'assistant', content: 'assistant', id: 'a1', timestamp: 't3' } as SessionMessage,
    ]);

    expect(result).toEqual({ found: false });
  });
});
