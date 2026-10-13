import { afterEach, describe, expect, it, vi } from 'vitest';
const utilityMocks = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn(), release: vi.fn(async () => {}), terminal: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(async () => {}) }));
vi.mock('./runtimes/codex', () => ({ CodexRuntime: class { startSession = utilityMocks.start; stopSession = utilityMocks.stop; } }));
vi.mock('./runtimes/claude-code', () => ({ ClaudeCodeRuntime: class { startSession = utilityMocks.start; stopSession = utilityMocks.stop; } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: utilityMocks.query }));
vi.mock('./agent-session', () => ({ resolveClaudeCodeCli: () => '/fake/cli', buildClaudeSessionEnv: () => ({}), startOneShotBridge: () => null }));
vi.mock('./utils/fs-utils', () => ({ ensureDirSync: () => {} }));
vi.mock('./utils/sdk-child-launch-guard', () => ({ createGuardedSdkQuery: async (_path: string, create: () => unknown) => create() }));
vi.mock('./utils/managed-proxy-binding', () => ({ getPreparedSdkSystemPrompt: (_env: unknown, prompt: string) => prompt, prepareProviderBinding: async ({ providerEnv }: { providerEnv: unknown }) => ({ providerEnv, beforeTurn: async () => {}, release: utilityMocks.release, reportTerminal: utilityMocks.terminal }) }));
import {
  BUILTIN_TITLE_TIMEOUT_MS,
  generateUtilityText,
  generateTitleExternal,
  buildExternalTitleSessionOptions,
  extractTitleTextFromSdkMessage,
} from './title-generator';

describe('extractTitleTextFromSdkMessage', () => {
  it('reads text even when a thinking block precedes it', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hidden reasoning' },
          { type: 'text', text: '会话标题' },
        ],
      },
    })).toBe('会话标题');
  });

  it('joins multiple assistant text blocks and ignores non-text blocks', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'MyAgents ' },
          { type: 'tool_use', id: 'toolu_1' },
          { type: 'text', text: '标题修复' },
        ],
      },
    })).toBe('MyAgents 标题修复');
  });

  it('falls back to the last assistant message from a success result', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'result',
      subtype: 'success',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'first draft' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '最终标题' }] },
      ],
    })).toBe('最终标题');
  });

  it('reads the SDK 0.3 result.result field when no assistant message is present', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'result',
      subtype: 'success',
      result: 'Result 字段标题',
    })).toBe('Result 字段标题');
  });

  it('returns null for whitespace-only or failed result messages', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   ' }] },
    })).toBeNull();
    expect(extractTitleTextFromSdkMessage({
      type: 'result',
      subtype: 'error_during_execution',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ignored' }] }],
    })).toBeNull();
  });
});

describe('BUILTIN_TITLE_TIMEOUT_MS', () => {
  it('keeps builtin title generation within the same 30s budget as external title generation', () => {
    expect(BUILTIN_TITLE_TIMEOUT_MS).toBe(30_000);
  });
});

describe('buildExternalTitleSessionOptions', () => {
  const base = {
    sessionId: 'title-session',
    workspacePath: '/workspace',
    userPrompt: 'Write the title',
    clientUserMessageId: 'title-user-message',
    runtimeType: 'codex' as const,
    model: 'gpt-5.6-sol',
  };

  it('keeps Managed Codex identity while disabling workspace MCP for the utility turn', () => {
    const options = buildExternalTitleSessionOptions({
      ...base,
      runtimeSource: 'managed-provider',
    });

    expect(options).toMatchObject({
      initialTurn: {
        message: 'Write the title',
        clientUserMessageId: 'title-user-message',
      },
      runtimeSource: 'managed-provider',
      mcpServers: [],
      permissionMode: 'suggest',
      reasoningEffort: 'low',
      ephemeral: true,
      maxTurns: 1,
      scenario: { type: 'desktop' },
    });
  });

  it('preserves system-cli ownership without pretending an empty injected set clears user config', () => {
    const options = buildExternalTitleSessionOptions({
      ...base,
      runtimeSource: 'system-cli',
    });

    expect(options).toMatchObject({
      initialTurn: {
        message: 'Write the title',
        clientUserMessageId: 'title-user-message',
      },
      runtimeSource: 'system-cli',
    });
    expect(options).not.toHaveProperty('mcpServers');
    expect(options).not.toHaveProperty('reasoningEffort');
    expect(options).not.toHaveProperty('ephemeral');
  });
});


describe('isolated SDK text utility', () => {
  afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
  function response(messages: unknown[]) {
    return Object.assign((async function* () { for (const message of messages) yield message; })(), { close: utilityMocks.close });
  }
  const task = { prompt: 'transcript data', systemPrompt: 'utility instructions', clean: (text: string) => text, requireSuccessfulTerminal: true };
  it('uses supplied prompt and active model without tools, settings or persistence, closes child and binding', async () => {
    utilityMocks.query.mockReturnValue(response([{ type: 'assistant', message: { content: [{ type: 'text', text: '请验证刚才方案' }] } }, { type: 'result', subtype: 'success' }]));
    expect(await generateUtilityText(task, 'real-model')).toBe('请验证刚才方案');
    const options = utilityMocks.query.mock.calls.at(-1)![0].options;
    expect(options).toMatchObject({ model: 'real-model', tools: [], mcpServers: {}, strictMcpConfig: true, persistSession: false, maxTurns: 1, settingSources: [], systemPrompt: 'utility instructions' });
    expect(utilityMocks.close).toHaveBeenCalled(); expect(utilityMocks.release).toHaveBeenCalled();
  });
  it('does not publish partial text from an unsuccessful terminal', async () => {
    utilityMocks.query.mockReturnValue(response([{ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }, { type: 'result', subtype: 'error_during_execution' }]));
    expect(await generateUtilityText(task, 'model')).toBeNull();
    expect(utilityMocks.terminal).toHaveBeenCalledWith(false);
  });
  it('returns null on request cancellation and closes a late-created child', async () => {
    let ready!: (value: unknown) => void;
    utilityMocks.query.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
    const controller = new AbortController();
    const result = generateUtilityText({ ...task, signal: controller.signal }, 'model');
    await vi.waitFor(() => expect(utilityMocks.query).toHaveBeenCalled());
    controller.abort();
    expect(await result).toBeNull();
    ready(response([]));
    await vi.waitFor(() => expect(utilityMocks.close).toHaveBeenCalled());
  });
  it('bounds an unresponsive SDK launch to 30 seconds and clears deadline timers', async () => {
    vi.useFakeTimers();
    utilityMocks.query.mockImplementation(() => new Promise(() => {}));
    const result = generateUtilityText(task, 'model');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(utilityMocks.release).toHaveBeenCalled();
  });

});


describe('external title utility cleanup and permission failure', () => {
  afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
  it('rejects partial title text on permission request and clears its timeout', async () => {
    vi.useFakeTimers();
    const handle = { id: 'external-child' };
    utilityMocks.start.mockImplementation(async (_options: unknown, emit: (event: unknown) => void) => {
      emit({ kind: 'text_delta', text: 'Partial title' });
      emit({ kind: 'permission_request' });
      return handle;
    });
    expect(await generateTitleExternal([{ user: 'Analyze code', assistant: 'Analyzed' }], 'codex', 'model', '/workspace', 'managed-provider')).toBeNull();
    expect(utilityMocks.stop).toHaveBeenCalledWith(handle);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves successful title cleanup while clearing both startup grace and deadline timers', async () => {
    vi.useFakeTimers();
    const handle = { id: 'external-child' };
    utilityMocks.start.mockImplementation(async (_options: unknown, emit: (event: unknown) => void) => {
      emit({ kind: 'text_delta', text: '"MyAgents title test。"' });
      emit({ kind: 'session_complete', subtype: 'success' });
      return handle;
    });
    expect(await generateTitleExternal([{ user: 'Analyze code', assistant: 'Analyzed' }], 'codex', 'model', '/workspace', 'managed-provider')).toBe('MyAgents title test');
    expect(utilityMocks.stop).toHaveBeenCalledWith(handle);
    expect(vi.getTimerCount()).toBe(0);
  });
});
