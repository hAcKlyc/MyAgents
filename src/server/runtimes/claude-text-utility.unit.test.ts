import { describe, it, expect } from 'vitest';
import { claudeTextUtilityArgs, claudeTextUtilityResult, nativeClaudeAuthEnv } from './claude-text-utility';
const line = (value: unknown) => JSON.stringify(value);
const success = { type: 'result', subtype: 'success', is_error: false, result: '请按方案补充回归测试。' };
describe('Claude native text utility', () => {
  it('positively disables all tools, MCP, settings, hooks, skills, Chrome and persistence without disabling CLI OAuth', () => {
    const args = claudeTextUtilityArgs('/tmp/system.txt', 'native-model');
    for (const [flag, value] of [['--tools', ''], ['--mcp-config', '{"mcpServers":{}}'], ['--setting-sources', ''], ['--settings', '{"disableAllHooks":true}'], ['--model', 'native-model']]) expect(args[args.indexOf(flag) + 1]).toBe(value);
    for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--no-chrome']) expect(args).toContain(flag);
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--resume');
  });
  it('projects only exact native auth/model fields, rejecting executable helpers and arbitrary credential files', () => {
    expect(nativeClaudeAuthEnv({ ANTHROPIC_AUTH_TOKEN: 'synthetic', ANTHROPIC_BASE_URL: 'https://example.test',
      CLAUDE_CODE_API_KEY_HELPER: 'bad', AWS_CONFIG_FILE: '/bad', GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '1', NODE_OPTIONS: 'bad', ANTHROPIC_ARBITRARY: 'bad' }))
      .toEqual({ ANTHROPIC_AUTH_TOKEN: 'synthetic', ANTHROPIC_BASE_URL: 'https://example.test' });
  });
  it('accepts only successful final native result, never assistant partial text', () => {
    expect(claudeTextUtilityResult([line({ type: 'system', subtype: 'init', tools: [] }), line({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }), line(success)].join('\n'))).toBe(success.result);
    expect(claudeTextUtilityResult(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }))).toBeNull();
  });
  it.each([
    { ...success, is_error: true }, { ...success, subtype: 'error_max_turns' },
    { type: 'control_request' }, { type: 'system', subtype: 'init', tools: ['NewUnknownTool'] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Unknown', input: {} }] } },
  ])('rejects errors, permissions and any unknown tool surface: %j', invalid => {
    expect(claudeTextUtilityResult(line(invalid) + '\n' + line(success))).toBeNull();
  });
  it('rejects malformed or double-terminal results', () => {
    expect(claudeTextUtilityResult('bad json')).toBeNull();
    expect(claudeTextUtilityResult(line(success) + '\n' + line(success))).toBeNull();
  });
});
