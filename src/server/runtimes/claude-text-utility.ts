import { modelqaUtilityCommand } from './modelqa-utility-command';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEnvPolicy } from '../../shared/types/runtime';
import type { RuntimeTextUtilityTask } from './types';
import { augmentedProcessEnv, resolveCommand } from './env-utils';
import { ensureShellPath } from '../utils/shell';
import { spawn } from '../utils/subprocess';
import { killWithEscalation } from './utils/kill-with-escalation';

export interface ClaudeTextUtilityInput extends RuntimeTextUtilityTask { model: string; envPolicy?: RuntimeEnvPolicy; workspacePath?: string }

/** Positive tool allowlist, no MCP/plugins/skills/hooks or native session persistence.
 * Auth still belongs to the user's actual CLI; --bare would disable CLI OAuth. */
export function claudeTextUtilityArgs(systemPromptPath: string, model: string): string[] {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands',
    '--no-chrome', '--settings', '{"disableAllHooks":true}',
    '--system-prompt-file', systemPromptPath, '--max-turns', '1', '--effort', 'low',
    ...(model ? ['--model', model] : [])];
}

/** Reject raw errors and any unexpected tool/control surface before accepting a result. */
export function claudeTextUtilityResult(stdout: string): string | null {
  let result: string | null = null;
  let terminal = false;
  for (const line of stdout.split('\n').filter(line => line.trim())) {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
    if (terminal) return null;
    if (message.type === 'control_request') return null;
    if (message.type === 'system') {
      if (message.subtype === 'init' && Array.isArray(message.tools) && message.tools.length) return null;
      continue;
    }
    if (message.type === 'assistant') {
      const content = (message.message as { content?: Array<{ type: string }> } | undefined)?.content;
      if (!Array.isArray(content) || content.some(block => block.type !== 'text' && block.type !== 'thinking')) return null;
      continue;
    }
    if (message.type === 'result') {
      terminal = true;
      if (message.subtype !== 'success' || message.is_error === true || typeof message.result !== 'string') return null;
      result = message.result.trim() || null;
    } else if (message.type !== 'rate_limit_event') return null;
  }
  return terminal ? result : null;
}

/** Preserve native configured provider/auth environment without loading user hooks,
 * plugins or instructions into this isolated utility. Never log these values. */
const NATIVE_AUTH_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'CLOUD_ML_REGION', 'GOOGLE_CLOUD_PROJECT', 'ANTHROPIC_VERTEX_PROJECT_ID',
]);
export function nativeClaudeAuthEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => NATIVE_AUTH_ENV_KEYS.has(key) && typeof item === 'string')) as Record<string, string>;
}
async function applyNativeAuthSettings(env: Record<string, string | undefined>, workspacePath?: string): Promise<void> {
  const paths = [join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    ...(workspacePath ? [join(workspacePath, '.claude/settings.json'), join(workspacePath, '.claude/settings.local.json')] : [])];
  for (const path of paths) {
    let settings: { env?: Record<string, unknown> };
    try { settings = JSON.parse(await readFile(path, 'utf8')) as typeof settings; } catch { continue; }
    Object.assign(env, nativeClaudeAuthEnv(settings.env));
  }
}

export async function generateClaudeTextUtility(input: ClaudeTextUtilityInput): Promise<string | null> {
  if (input.signal?.aborted) return null;
  const signal = AbortSignal.any([AbortSignal.timeout(input.timeoutMs ?? 30_000), ...(input.signal ? [input.signal] : [])]);
  let directory: string | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let done = false;
  try {
    await ensureShellPath();
    if (signal.aborted) return null;
    directory = await mkdtemp(join(tmpdir(), 'moxbots-claude-text-'));
    const promptPath = join(directory, 'system.txt');
    await writeFile(promptPath, input.systemPrompt, { mode: 0o600 });
    const env = augmentedProcessEnv(input.envPolicy);
    await applyNativeAuthSettings(env, input.workspacePath);
    env.PWD = directory;
    delete env.MYAGENTS_SESSION_ID;
    if (signal.aborted) return null;
    child = spawn([modelqaUtilityCommand('claude-code', 'system-cli', () => resolveCommand('claude', env)), ...claudeTextUtilityArgs(promptPath, input.model)], {
      cwd: directory, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      detached: process.platform !== 'win32', windowsHide: true,
    });
    const subprocess = child;
    const read = async (stream: ReadableStream<Uint8Array> | null, capture: boolean) => {
      let output = ''; let bytes = 0; const decoder = new TextDecoder();
      if (!stream) return output;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > 128_000) throw new Error('Utility output limit exceeded');
        if (capture) output += decoder.decode(chunk, { stream: true });
      }
      return output + (capture ? decoder.decode() : '');
    };
    let abortListener: () => void = () => {};
    const aborted = new Promise<null>(resolve => {
      abortListener = () => { void killWithEscalation({ pid: subprocess.pid, kill: s => subprocess.kill(s), get exited() { return done; }, waitForExit: () => subprocess.exited }, { gracefulMs: 200, hardMs: 1_000, killTree: true }); resolve(null); };
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    subprocess.stdin?.write(input.prompt); subprocess.stdin?.end();
    try {
      const response = await Promise.race([Promise.all([read(subprocess.stdout, true), read(subprocess.stderr, false), subprocess.exited.then(code => { done = true; return code; })]), aborted]);
      return response && !signal.aborted && response[2] === 0 ? claudeTextUtilityResult(response[0]) : null;
    } finally { signal.removeEventListener('abort', abortListener); }
  } catch { return null; }
  finally {
    if (child && !done) await killWithEscalation({ pid: child.pid, kill: s => child!.kill(s), get exited() { return done; }, waitForExit: () => child!.exited }, { gracefulMs: 200, hardMs: 1_000, killTree: true });
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
