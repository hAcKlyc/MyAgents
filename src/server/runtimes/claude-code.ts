import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
// ClaudeCodeRuntime — drives the Claude Code CLI as a subprocess (v0.1.59)
//
// Communication: NDJSON bidirectional via stdin/stdout
// Flags: --output-format stream-json --input-format stream-json --verbose
// Permission: --permission-prompt-tool stdio (delegates to MyAgents UI)
// System prompt: --append-system-prompt-file (file-based; inline would be silently truncated by cmd.exe on Windows)
// Session: --session-id / --resume

import { spawn, type Subprocess } from '../utils/subprocess';
import { writeFileSync , existsSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { RuntimeDetection, RuntimeModelInfo, RuntimePermissionMode, RuntimeType } from '../../shared/types/runtime';
import { CC_PERMISSION_MODES } from '../../shared/types/runtime';
import { isSdkEffortLevel } from '../../shared/reasoningEffort';
import type { AgentRuntime, RuntimeConfigCapabilities, RuntimeProcess, SessionStartOptions, UnifiedEvent, UnifiedEventCallback, ResolvedImagePayload } from './types';
import { augmentedProcessEnv, resolveCommand, stripAnsi } from './env-utils';
import { ensureDirSync } from '../utils/fs-utils';
import { ensureShellPath } from '../utils/shell';
import { killWithEscalation } from './utils/kill-with-escalation';
import { withLogContext } from '../logger-context';

/**
 * Build CC CLI message content — string for text-only, array of content blocks for images+text.
 * Matches Anthropic Messages API content format which CC CLI consumes natively.
 */
function buildMessageContent(text: string, images?: ResolvedImagePayload[]): string | unknown[] {
  if (!images || images.length === 0) return text;
  const blocks: unknown[] = [];
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType,
        data: img.data,
      },
    });
  }
  if (text) {
    blocks.push({ type: 'text', text });
  }
  return blocks;
}

// ─── SessionStart Hook settings generator ───
// CC's hooks fire on session lifecycle events. We inject a SessionStart hook
// that POSTs the session_id to our Sidecar HTTP endpoint for reliable tracking.

const HOOK_DIR = join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  APP_DATA_DIR_NAME, 'tmp', 'cc-hooks',
);

// System prompt tmp dir — separate from cc-hooks so the two concerns can be
// cleaned independently.
const SYSTEM_PROMPT_DIR = join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  APP_DATA_DIR_NAME, 'tmp', 'cc-system-prompt',
);

/**
 * Per-session prompt file path. The sessionId is sanitized to a strict
 * `[A-Za-z0-9._-]` charset to prevent directory traversal — upstream callers
 * give us UUID v4s in practice, but `external-session.ts:885` only upgrades
 * `pending-*` placeholders; it does NOT validate UUID shape. A malformed
 * sessionId reaching this helper without sanitization could escape
 * `SYSTEM_PROMPT_DIR` via `../`. The path is never derived from an unsanitized sessionId.
 */
function systemPromptPath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
  return join(SYSTEM_PROMPT_DIR, `${safe}.md`);
}

/**
 * Write the MyAgents system prompt to a tmp file and return its absolute path.
 *
 * Why file instead of `--append-system-prompt <inline>`: on Windows the CC
 * binary is invoked through a `.cmd` shim, which Node spawns via
 * `cmd.exe /d /s /c "<cmdline>"`. cmd.exe treats `\n` as a command boundary
 * inside the wrapped command string, silently truncating every arg that follows
 * the first newline. MyAgents' system prompt is multi-line (4–5KB, ~80 LFs), so
 * `--resume` / `--session-id` / `--model` / `--settings` all get dropped → CC
 * spawns a brand-new session every turn → multi-turn context completely lost.
 * `--append-system-prompt-file <path>` sidesteps the entire issue: the path
 * itself has no newlines, and the prompt body never crosses the cmd.exe parser.
 *
 * Supported on CC CLI ≥ v2.1.x (confirmed v2.1.119 + v2.1.138 both ship it).
 *
 * File hygiene:
 *  - `mode: 0o600` so the prompt (may carry workspace guidance / user-tunable
 *    context) is only readable by the running user.
 *  - One file per sessionId, overwritten on each spawn so prompt edits land
 *    immediately. Stale files from previous sessions are reaped by
 *    `cleanupStaleSystemPrompts()` on the next `startSession`.
 */
function writeSystemPromptFile(sessionId: string, content: string): string {
  ensureDirSync(SYSTEM_PROMPT_DIR);
  const promptPath = systemPromptPath(sessionId);
  writeFileSync(promptPath, content, { encoding: 'utf8', mode: 0o600 });
  return promptPath;
}

/**
 * Best-effort age-based GC for `SYSTEM_PROMPT_DIR`. Removes prompt files older
 * than 1 hour. Called from `startSession`.
 *
 * Not unlinked on `stopSession` because the prompt filename is sessionId-keyed
 * (deterministic across spawns of the same session); a late delete from a
 * failed prior attempt would clobber the file the next spawn just wrote.
 * Age-based cleanup avoids the race.
 */
function cleanupStaleSystemPrompts(): void {
  try {
    if (!existsSync(SYSTEM_PROMPT_DIR)) return;
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const file of readdirSync(SYSTEM_PROMPT_DIR)) {
      if (!file.endsWith('.md')) continue;
      const path = join(SYSTEM_PROMPT_DIR, file);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* ignore */ }
}

// Forwarder script content — inlined to avoid production bundle issues
// (bun build doesn't copy companion .cjs files into the output)
const FORWARDER_SCRIPT = `#!/usr/bin/env node
const http = require('http');
const port = parseInt(process.argv[2], 10);
if (!port || isNaN(port)) process.exit(0);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/hook/session-start',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, (r) => r.resume());
  req.on('error', () => {});
  req.end(body);
});
process.stdin.resume();
`;

/**
 * Generate temporary hook settings + forwarder script for CC SessionStart hook.
 * Both files are written to ~/.myagents/tmp/cc-hooks/ (outside the project).
 */
export function buildSessionStartHookCommand(
  forwarderPath: string,
  sidecarPort: number,
  nodePath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string {
  const quote = (path: string): string => {
    const normalized = platform === 'win32' ? path.replace(/\\/g, '/') : path;
    return `'${normalized.replace(/'/g, "'\\''")}'`;
  };
  return `${quote(nodePath)} ${quote(forwarderPath)} ${sidecarPort}`;
}

function generateHookSettings(sidecarPort: number): string | null {
  try {
    ensureDirSync(HOOK_DIR);

    // Write forwarder script (idempotent)
    const forwarderPath = join(HOOK_DIR, 'forwarder.cjs');
    if (!existsSync(forwarderPath)) {
      writeFileSync(forwarderPath, FORWARDER_SCRIPT, { mode: 0o755 });
    }

    // Write settings JSON (per-process to avoid collisions)
    const settingsPath = join(HOOK_DIR, `settings-${process.pid}.json`);
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '*',
          // Keep the Bash command-hook contract supported by older system CC
          // installs (exec-form args only arrived in 2.1.139). Explicit shell
          // also makes quoting independent of newer CC's PowerShell default.
          hooks: [{ type: 'command', shell: 'bash', command: buildSessionStartHookCommand(forwarderPath, sidecarPort) }],
        }],
      },
    }));
    return settingsPath;
  } catch (err) {
    console.warn('[claude-code] Failed to generate hook settings:', err);
    return null;
  }
}

// ─── RuntimeProcess wrapper ───

class ClaudeCodeProcess implements RuntimeProcess {
  readonly pid: number;
  exited = false;
  private proc: Subprocess;
  private encoder = new TextEncoder();

  constructor(proc: Subprocess) {
    this.proc = proc;
    this.pid = proc.pid;
  }

  async writeLine(line: string): Promise<void> {
    if (this.exited) throw new Error('Process has exited');
    const stdin = this.proc.stdin;
    if (!stdin) throw new Error('stdin not available');
    await stdin.write(this.encoder.encode(line + '\n'));
  }

  kill(signal?: NodeJS.Signals | number): void {
    if (this.exited) return;
    try {
      this.proc.kill(signal ?? 15); // SIGTERM
    } catch { /* already dead */ }
  }

  async waitForExit(): Promise<number> {
    const code = await this.proc.exited;
    this.exited = true;
    return code;
  }

  /**
   * Close stdin to signal the process to finish.
   * Resolves when the EOF has been flushed to the child's stdin — lets
   * graceful-shutdown callers know the signal has actually propagated.
   */
  async closeStdin(): Promise<void> {
    const stdin = this.proc.stdin;
    if (!stdin) return;
    try {
      await stdin.end();
    } catch { /* already closed / EPIPE */ }
  }
}

// ─── Model cache ───

let modelCache: { models: RuntimeModelInfo[]; timestamp: number } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── ClaudeCodeRuntime ───

/**
 * Pass Claude Code's native values through. Product values remain readable for
 * older scheduled/injected callers that have not materialized a native mode.
 */
function mapPermissionModeToCc(mode: string): string {
  switch (mode) {
    case 'plan': return 'plan';
    case 'fullAgency': return 'bypassPermissions';
    case 'auto':
    case 'manual':
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'dontAsk':
      return mode;
    case 'default':
    default: return 'manual';
  }
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'claude-code';

  // Track content_block_index → toolUseId for associating input_json_delta with tool blocks
  private blockIndexToToolUseId = new Map<string, string>();
  private nativeMessageIds = new Map<string, string>();
  // Track content_block_index → block type for correct stop events
  private blockIndexToType = new Map<string, 'text' | 'thinking' | 'tool_use'>();
  // PRD 0.2.32 — 最近一条主轮 assistant message 的 usage（context 占用源；result.usage 是
  // 整 turn 累计不能用）。每条主轮 assistant message 覆盖，turn 末（result）消费后重置。
  private lastMainAssistantUsage: { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null = null;

  async detect(): Promise<RuntimeDetection> {
    try {
      await ensureShellPath();
      const env = augmentedProcessEnv();
      const command = resolveCommand('claude', env);
      const proc = spawn([command, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env,
      });
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 0) {
        return {
          installed: true,
          version: text.trim(),
          path: command,
        };
      }
    } catch { /* not installed */ }
    return { installed: false };
  }

  async queryModels(): Promise<RuntimeModelInfo[]> {
    // Return cached if fresh
    if (modelCache && Date.now() - modelCache.timestamp < MODEL_CACHE_TTL_MS) {
      return modelCache.models;
    }

    // Reuse canonical CC_MODELS from shared types (single source of truth)
    const { CC_MODELS } = await import('../../shared/types/runtime');
    modelCache = { models: CC_MODELS, timestamp: Date.now() };
    return CC_MODELS;
  }

  getPermissionModes(): RuntimePermissionMode[] {
    return CC_PERMISSION_MODES;
  }

  getConfigCapabilities(): RuntimeConfigCapabilities {
    return {
      model: 'next_turn_state',
      permissionMode: 'next_turn_state',
      reasoningEffort: 'next_turn_state',
    };
  }

  async startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess> {
    // Clear stale state from previous sessions (singleton instance, maps persist)
    this.nativeMessageIds.clear();
    this.blockIndexToToolUseId.clear();
    this.blockIndexToType.clear();

    // Age-based GC for tmp system-prompt files — see cleanupStaleSystemPrompts().
    cleanupStaleSystemPrompts();

    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',  // Required to receive stream_event (text/thinking/tool deltas)
    ];

    // System Prompt injection
    const isImOrChannel = options.scenario.type === 'im' || options.scenario.type === 'agent-channel';
    const isHeadlessAutomation = isImOrChannel
      || options.scenario.type === 'cron'
      || options.scenario.type === 'registeredAgent';

    // NOTE: we used to pass `--bare` here for IM/agent-channel sessions,
    // intending to give the bot a clean slate without CC's default preset.
    // That silently broke OAuth users because `--bare` (per `claude --help`)
    // explicitly disables keychain + OAuth reads and requires
    // ANTHROPIC_API_KEY. Users logged in via `claude /login` on a
    // subscription account would get `Not logged in · Please run /login`
    // on every IM message while the desktop Tab (which never used --bare)
    // worked fine. Confirmed via unified-2026-04-15.log line 4820:
    //
    //   {"type":"result","subtype":"success","is_error":true,
    //    "result":"Not logged in · Please run /login",...}
    //
    // We drop --bare entirely. CC loads its default preset prompt + our
    // --append-system-prompt-file adds the MyAgents 3-layer context on top.
    // Keychain/OAuth auth is preserved for all IM users. The tradeoff:
    // the AI has CC's default preset loaded in an IM context, which may
    // leak occasional self-descriptions ("I'm Claude Code, a CLI tool…").
    // Acceptable for now — working > perfectly branded.
    //
    // Note: `isHeadlessAutomation` is still consulted below for the auto-bypass
    // permission branch, which is a separate concern.
    if (options.systemPromptAppend) {
      // File-based, not inline — see writeSystemPromptFile() rationale above.
      const promptPath = writeSystemPromptFile(options.sessionId, options.systemPromptAppend);
      args.push('--append-system-prompt-file', promptPath);
    }

    // Permission mode
    if (isHeadlessAutomation && !options.permissionMode) {
      // Headless automation: no human to approve → bypass
      // MUST pass --allow-dangerously-skip-permissions BEFORE --dangerously-skip-permissions
      args.push('--allow-dangerously-skip-permissions');
      args.push('--permission-mode', 'bypassPermissions');
      args.push('--dangerously-skip-permissions');
    } else {
      // Desktop and explicit runtime permission mode: delegate or bypass based on mode.
      const ccMode = options.permissionMode ? mapPermissionModeToCc(options.permissionMode) : 'manual';

      if (ccMode === 'bypassPermissions') {
        // bypassPermissions requires these two flags — even in desktop mode
        args.push('--allow-dangerously-skip-permissions');
        args.push('--dangerously-skip-permissions');
      } else {
        // Non-bypass modes: delegate permission prompts to MyAgents via stdio
        args.push('--permission-prompt-tool', 'stdio');
      }
      args.push('--permission-mode', ccMode);
    }

    // Model
    if (options.model) {
      args.push('--model', options.model);
    }

    // #324 — reasoning effort. CC's `--effort` vocabulary is exactly the SDK
    // EffortLevel set (low/medium/high/xhigh/max, per `claude --help`); gate
    // defensively so a cross-runtime stale value (e.g. Codex's 'minimal')
    // never reaches the CLI as an invalid flag value. Omitted = CC default.
    // CC -p mode spawns per turn, so a changed value applies on the next turn
    // without any explicit restart handling.
    if (options.reasoningEffort && isSdkEffortLevel(options.reasoningEffort)) {
      args.push('--effort', options.reasoningEffort);
    }

    // Session management
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    } else {
      args.push('--session-id', options.sessionId);
    }

    // Safety limits
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    // Tool control. Channel sessions receive their host-interaction overlay
    // from external-session; cron/registered-agent remain headless and cannot
    // render AskUserQuestion.
    const disallowedTools = new Set(options.disallowedTools ?? []);
    if (isHeadlessAutomation && !isImOrChannel) {
      disallowedTools.add('AskUserQuestion');
    }
    if (disallowedTools.size > 0) {
      args.push('--disallowed-tools', ...disallowedTools);
    }

    // Inject SessionStart hook settings for reliable session ID tracking
    // Read the sidecar's HTTP port from the --port CLI arg
    const portArgIdx = process.argv.indexOf('--port');
    const sidecarPort = portArgIdx >= 0 ? parseInt(process.argv[portArgIdx + 1], 10) : 0;
    if (sidecarPort > 0) {
      const hookSettingsPath = generateHookSettings(sidecarPort);
      if (hookSettingsPath) {
        args.push('--settings', hookSettingsPath);
      }
    }

    // Additional args from config
    if (options.additionalArgs?.length) {
      args.push(...options.additionalArgs);
    }

    // NOTE: Initial message is sent via stdin (not positional arg) because
    // --input-format stream-json mode ignores positional prompts and waits for stdin.

    // Log ALL args for debugging (don't truncate — user needs to see full command)
    console.log(`[claude-code] Starting session: claude ${args.join(' ')}`);

    // Augment PATH with user-level directories (e.g. ~/.local/bin where `claude` lives).
    // NOTE: Also inherits NO_PROXY from Sidecar (injected by proxy_config::apply_to_subprocess()).
    //
    // `detached: true` puts the runtime CLI in its own process group on POSIX so
    // we can later kill the entire tree via `process.kill(-pid, signal)`. Pre-fix,
    // `proc.kill()` only signalled the wrapper and orphaned model/tool subprocesses
    // (see killWithEscalation `killTree`).
    //
    // Windows: `detached: true` is incompatible with stdio:'pipe' — the parent
    // never receives the child's stdout, so JSON-RPC `initialize` hangs forever
    // (issue #170 #5). Windows also doesn't have process groups; tree-kill on
    // Windows uses `taskkill /F /T /PID` which works regardless of detached.
    // `windowsHide: true` suppresses the console window flash from cmd.exe
    // wrapping the .cmd shim.
    // Issue #194 — pass envPolicy and pin PWD to workspacePath for terminal
    // parity (same fix applied to Codex runtime).
    await ensureShellPath();
    const ccEnv = augmentedProcessEnv(options.envPolicy);
    ccEnv.PWD = options.workspacePath;
    ccEnv.MYAGENTS_SESSION_ID = options.sessionId;
    const proc = spawn([resolveCommand('claude', ccEnv), ...args], {
      cwd: options.workspacePath,
      env: ccEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const handle = new ClaudeCodeProcess(proc);

    // Send initial message via stdin (must happen before reading stdout to avoid deadlock)
    if (options.initialTurn) {
      const content = buildMessageContent(options.initialTurn.message, options.initialTurn.images);
      const userMsg = {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      };
      await handle.writeLine(JSON.stringify(userMsg));
      console.log(`[claude-code] Initial message sent via stdin (${options.initialTurn.message.length} chars, ${options.initialTurn.images?.length ?? 0} images)`);
    }

    if (!proc.stdout || !proc.stderr) {
      throw new Error('Claude Code process: stdout/stderr pipes unavailable');
    }
    // Pattern 6: every console.* and onEvent invocation triggered by the
    // event-pump runs inside an ALS frame stamped with `runtime` so the
    // unified log can be filtered by runtime. We wrap the read loops, NOT
    // the kill()/stopExternalSession path (P0-1 territory — must not
    // change behaviour there).
    // Read stderr for logging
    void withLogContext({ runtime: 'claude-code' }, () => this.readStderr(proc.stderr!));

    // Track process exit — only emit session_complete if NDJSON parser didn't already
    let sessionCompleteEmitted = false;
    const wrappedOnEvent: UnifiedEventCallback = (event) => {
      if (event.kind === 'session_complete') sessionCompleteEmitted = true;
      onEvent(event);
    };

    // Start reading stdout NDJSON in background (uses wrappedOnEvent).
    // Capture the promise so the exit handler can wait for the reader to drain
    // all buffered data before deciding whether to emit a fallback session_complete.
    const readerDone = withLogContext(
      { runtime: 'claude-code' },
      () => this.readEvents(proc.stdout!, wrappedOnEvent, handle),
    );

    proc.exited.then(async (code) => {
      handle.exited = true;
      console.log(`[claude-code] Process exited with code ${code}`);
      // CRITICAL: Wait for the NDJSON reader to finish processing all buffered stdout.
      // Without this, the exit handler races with the reader — on short responses,
      // proc.exited resolves before the reader processes the 'result' NDJSON line,
      // causing a premature session_complete with empty result.
      await readerDone;
      if (!sessionCompleteEmitted) {
        onEvent({
          kind: 'session_complete',
          result: '',
          subtype: code === 0 ? 'success' : 'error',
        });
      }
    });

    return handle;
  }

  async sendMessage(process: RuntimeProcess, message: string, images?: ResolvedImagePayload[]): Promise<void> {
    const content = buildMessageContent(message, images);
    const userMsg = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    await process.writeLine(JSON.stringify(userMsg));
  }

  async respondPermission(
    process: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    reason?: string,
    suggestions?: unknown[],
    updatedInput?: Record<string, unknown>,
    interrupt?: boolean,
  ): Promise<void> {
    // CC control_response schema (PermissionPromptToolResultSchema.ts):
    // allow: { behavior, updatedInput (required), updatedPermissions?, decisionClassification? }
    // deny:  { behavior, message, interrupt?, decisionClassification? }
    const response = decision !== 'deny'
      ? {
        type: 'control_response' as const,
        response: {
          request_id: requestId,
          subtype: 'success' as const,
          response: {
            behavior: 'allow' as const,
            // Required by CC schema. Empty = use original input (common case).
            // Populated for AskUserQuestion: caller injects `answers` so CC sees the user's reply.
            updatedInput: updatedInput ?? {},
            decisionClassification: decision === 'always_allow' ? 'user_permanent' as const : 'user_temporary' as const,
            // For always_allow: echo permission_suggestions back as updatedPermissions
            // so CC persists the rule and doesn't re-prompt for this tool
            ...(decision === 'always_allow' && suggestions?.length ? { updatedPermissions: suggestions } : {}),
          },
        },
      }
      : {
        type: 'control_response' as const,
        response: {
          request_id: requestId,
          subtype: 'success' as const,
          response: {
            behavior: 'deny' as const,
            message: reason || 'User denied the request',
            // PRD #131 — caller passes `interrupt: true` for control-
            // transfer tools (AskUserQuestion / ExitPlanMode) so the deny
            // also aborts the whole turn, not just the current tool. Defaults
            // false so generic permission denies keep the prior "let the
            // AI try again" semantic.
            interrupt: interrupt ?? false,
            decisionClassification: 'user_reject' as const,
          },
        },
      };
    await process.writeLine(JSON.stringify(response));
  }

  async stopSession(process: RuntimeProcess): Promise<void> {
    if (process.exited) return;

    // Close stdin to let CC finish naturally (awaits EOF propagation)
    await (process as ClaudeCodeProcess).closeStdin();

    await killWithEscalation(process as ClaudeCodeProcess, {
      gracefulMs: 5000,
      hardMs: 2000,
      killTree: true,
      onStep: (step, info) => {
        if (step === 'orphan') {
          console.warn(`[claude-code] Process pid=${info.pid} did not exit after SIGKILL; continuing with orphan risk`);
        }
      },
    });

    // Clean up per-process hook settings file
    try {
      const settingsPath = join(HOOK_DIR, `settings-${process.pid}.json`);
      if (existsSync(settingsPath)) unlinkSync(settingsPath);
    } catch { /* best-effort cleanup */ }
  }

  // ─── Private: NDJSON event stream reader ───

  private async readEvents(
    stdout: ReadableStream<Uint8Array>,
    onEvent: UnifiedEventCallback,
    handle: ClaudeCodeProcess,
  ): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lineCount = 0;

    console.log('[claude-code] NDJSON reader started, waiting for stdout data...');

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[claude-code] stdout stream ended after ${lineCount} lines`);
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          lineCount++;
          // Raw NDJSON is transport. With --include-partial-messages it can
          // contain text/thinking/tool deltas, so diagnostics begin only after
          // parseLine() has reduced the frame to a semantic event summary.
          const parsed = this.parseLine(line);
          if (parsed) {
            const events = Array.isArray(parsed) ? parsed : [parsed];
            for (const event of events) {
              // Skip delta events from logging (too frequent — hundreds per turn)
              if (event.kind === 'text_delta' || event.kind === 'thinking_delta' || event.kind === 'tool_input_delta') {
                // no-op
              } else {
                let detail = '';
                const e = event as Record<string, unknown>;
                switch (event.kind) {
                  case 'session_init':
                    detail = ` sessionId=${e.sessionId} model=${e.model} tools=${(e.tools as string[] || []).length}`;
                    break;
                  case 'session_complete':
                    detail = ` subtype=${e.subtype} result=${((e.result as string) || '').length > 0 ? `${((e.result as string) || '').length}chars` : 'empty'}`;
                    break;
                  case 'message_replay': {
                    const msg = (e.message as { role: string; content: unknown });
                    const contentLen = typeof msg.content === 'string' ? msg.content.length : Array.isArray(msg.content) ? JSON.stringify(msg.content).length : 0;
                    detail = ` role=${msg.role} content=${contentLen}chars`;
                    break;
                  }
                  case 'tool_use_start':
                    detail = ` tool=${e.toolName} id=${((e.toolUseId as string) || '').slice(0, 12)}`;
                    break;
                  case 'tool_use_stop':
                    detail = ` id=${((e.toolUseId as string) || '').slice(0, 12)}`;
                    break;
                  case 'tool_result':
                    detail = ` id=${((e.toolUseId as string) || '').slice(0, 12)} err=${e.isError || false} len=${((e.content as string) || '').length}`;
                    break;
                  case 'permission_request':
                    detail = ` tool=${e.toolName} id=${((e.requestId as string) || '').slice(0, 12)}`;
                    break;
                  case 'status_change':
                    detail = ` state=${e.state}`;
                    break;
                  case 'text_stop':
                    detail = ''; // external-session logs accumulated chars
                    break;
                  case 'thinking_start':
                  case 'thinking_stop':
                    detail = ` index=${e.index}`;
                    break;
                  case 'usage':
                    detail = ` in=${e.inputTokens} out=${e.outputTokens}`;
                    break;
                  case 'model_update':
                    detail = ` model=${e.model}`;
                    break;
                  case 'log':
                    detail = ` level=${e.level} msg=${(e.message as string) || ''}`;
                    break;
                }
                console.log(`[claude-code] ${event.kind}${detail}`);
              }
              onEvent(event);
            }
          }
        }
      }
    } catch (err) {
      if (!handle.exited) {
        console.error('[claude-code] stdout read error:', err);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          console.log(`[claude-code:stderr] ${stripAnsi(text.trim())}`);
        }
      }
    } catch { /* ignore */ } finally {
      reader.releaseLock();
    }
  }

  // ─── Private: NDJSON line parser ───

  private parseLine(line: string): UnifiedEvent | UnifiedEvent[] | null {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return null;
    }

    switch (msg.type) {
      case 'stream_event': {
        const event = msg.event as Record<string, unknown> | undefined;
        if (!event) return null;
        const parent = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : '';
        const nativeMessage = event.message as { id?: unknown } | undefined;
        if (event.type === 'message_start' && typeof nativeMessage?.id === 'string') this.nativeMessageIds.set(parent, nativeMessage.id);
        const messageId = this.nativeMessageIds.get(parent);
        const parsed = this.parseStreamEvent(event, parent);
        if (!messageId) return parsed;
        return {
          ...(parsed ?? { kind: 'raw' as const, data: null }),
          nativeSource: {
            messageId,
            ...(parent ? { parentToolUseId: parent } : {}),
            ...(typeof event.index === 'number' ? { blockIndex: event.index } : {}),
            ...(event.type === 'content_block_start' ? { blockStart: event.content_block as Record<string, unknown> } : {}),
          },
        };
      }

      case 'assistant': {
        // PRD 0.2.32 — context 占用：CC 的 `result.usage` 是整 turn 累计（多次工具往返求和），
        // 不能当占用。占用必须取**最近一条主轮 assistant message** 的 input+cache（每条 = 一次
        // API 调用，最后一条即当前窗口装了多少）。子 Agent 消息（parent_tool_use_id 存在）有
        // 独立上下文，排除。在 result 处用此值设 contextOccupiedTokens。
        const am = msg.message as Record<string, unknown> | undefined;
        const au = am?.usage as Record<string, unknown> | undefined;
        if (!msg.parent_tool_use_id && au) {
          this.lastMainAssistantUsage = {
            inputTokens: this.readNumber(au.input_tokens, au.inputTokens),
            cacheReadTokens: this.readNumber(
              au.cache_read_input_tokens,
              au.cacheReadInputTokens,
              (au.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
            ),
            cacheCreationTokens: this.readNumber(au.cache_creation_input_tokens, au.cacheCreationInputTokens),
          };
        }
        // Complete assistant message (for replay / resume)
        const replay: UnifiedEvent = {
          kind: 'message_replay',
          ...(typeof am?.id === 'string' ? { nativeSource: {
            messageId: am.id,
            ...(typeof msg.parent_tool_use_id === 'string' ? { parentToolUseId: msg.parent_tool_use_id } : {}),
          } } : {}),
          message: {
            id: (msg.uuid as string) || '',
            role: 'assistant',
            content: am?.content,
          },
        };
        const supersedes = Array.isArray(msg.supersedes) ? msg.supersedes.filter((id): id is string => typeof id === 'string') : [];
        return supersedes.length ? [{ kind: 'native_retraction', messageIds: supersedes,
          ...(typeof msg.parent_tool_use_id === 'string' ? { scope: 'local', parentToolUseId: msg.parent_tool_use_id } : {}),
        }, replay] : replay;
      }

      case 'user':
        return {
          kind: 'message_replay',
          message: {
            id: (msg.uuid as string) || '',
            role: 'user',
            content: (msg.message as Record<string, unknown>)?.content,
          },
        };

      case 'system':
        return this.parseSystemMessage(msg);

      case 'result':
        return this.parseResultMessage(msg);

      case 'control_request': {
        const request = msg.request as Record<string, unknown> | undefined;
        if (request?.subtype === 'can_use_tool') {
          return {
            kind: 'permission_request',
            // request_id is at the TOP level of control_request, not inside .request
            requestId: (msg.request_id as string) || '',
            toolName: (request.tool_name as string) || '',
            toolUseId: (request.tool_use_id as string) || '',
            affectsRootActivity: !request.agent_id,
            input: (request.input as Record<string, unknown>) || {},
            // Capture permission_suggestions — echoed back as updatedPermissions for "always_allow"
            suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions : undefined,
          };
        }
        return null;
      }

      case 'rate_limit_event':
        return { kind: 'log', level: 'warn', message: 'Rate limited by API' };

      default:
        return null;
    }
  }

  private parseStreamEvent(event: Record<string, unknown> | undefined, parent = ''): UnifiedEvent | null {
    if (!event) return null;
    const key = (index: number) => `${parent}:${index}`;

    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block as Record<string, unknown>;
        const index = event.index as number | undefined;
        if (block?.type === 'tool_use') {
          const toolUseId = (block.id as string) || '';
          if (index !== undefined) {
            this.blockIndexToToolUseId.set(key(index), toolUseId);
            this.blockIndexToType.set(key(index), 'tool_use');
          }
          return {
            kind: 'tool_use_start',
            toolUseId,
            toolName: (block.name as string) || '',
          };
        }
        if (block?.type === 'thinking') {
          const idx = index ?? 0;
          if (index !== undefined) {
            this.blockIndexToType.set(key(index), 'thinking');
          }
          return { kind: 'thinking_start', index: idx };
        }
        // Text block
        if (index !== undefined) {
          this.blockIndexToType.set(key(index), 'text');
        }
        return null;
      }

      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown>;
        const index = event.index as number | undefined;
        if (delta?.type === 'text_delta') {
          return { kind: 'text_delta', text: (delta.text as string) || '' };
        }
        if (delta?.type === 'thinking_delta') {
          return { kind: 'thinking_delta', text: (delta.thinking as string) || '', index: index ?? 0 };
        }
        if (delta?.type === 'input_json_delta') {
          const toolUseId = (index !== undefined ? this.blockIndexToToolUseId.get(key(index)) : undefined) || '';
          return {
            kind: 'tool_input_delta',
            toolUseId,
            delta: (delta.partial_json as string) || '',
          };
        }
        return null;
      }

      case 'content_block_stop': {
        const index = event.index as number | undefined;
        const blockType = index !== undefined ? this.blockIndexToType.get(key(index)) : undefined;
        if (blockType === 'tool_use') {
          const toolUseId = (index !== undefined ? this.blockIndexToToolUseId.get(key(index)) : undefined) || '';
          return { kind: 'tool_use_stop', toolUseId };
        }
        if (blockType === 'thinking') {
          return { kind: 'thinking_stop', index: index ?? 0 };
        }
        return { kind: 'text_stop' };
      }

      case 'message_stop':
        // NOT turn_complete — CC's -p mode outputs multiple message_stop per turn
        // (one for each API round-trip during tool loops). The true turn-end signal
        // is the 'result' NDJSON event (mapped to session_complete).
        // Mapping this to turn_complete causes: (1) premature end-of-message UI after
        // each tool call, (2) broken multi-turn resume because session_complete's
        // persistence is skipped when turnCompleted is already true. See: #71
        return null;

      case 'message_start':
        return { kind: 'status_change', state: 'running' };

      default:
        return null;
    }
  }

  private parseSystemMessage(msg: Record<string, unknown>): UnifiedEvent | null {
    switch (msg.subtype) {
      case 'model_refusal_fallback':
        return { kind: 'native_retraction', messageIds: Array.isArray(msg.retracted_message_uuids)
          ? msg.retracted_message_uuids.filter((id): id is string => typeof id === 'string') : [],
          scope: msg.scope === 'local' ? 'local' : 'session',
        };
      case 'init':
        return {
          kind: 'session_init',
          sessionId: (msg.session_id as string) || '',
          model: (msg.model as string) || '',
          tools: (msg.tools as string[]) || [],
        };
      case 'status':
      case 'session_state_changed':
        return { kind: 'status_change', state: 'running' };
      default:
        return null;
    }
  }

  private parseResultMessage(msg: Record<string, unknown>): UnifiedEvent | UnifiedEvent[] {
    const events: UnifiedEvent[] = [];
    const usage = this.extractUsage(msg);
    if (usage) {
      // PRD 0.2.32 — context 占用取「最近一条主轮 message」（Anthropic 系 input+cache），
      // 不是 result.usage（整 turn 累计）。无捕获到则不带 → 指示器不显示（不显错）。
      const occ = this.lastMainAssistantUsage;
      const contextOccupiedTokens = occ
        ? occ.inputTokens + occ.cacheReadTokens + occ.cacheCreationTokens
        : undefined;
      events.push({ kind: 'usage', ...usage, semantics: 'delta', contextOccupiedTokens });
    }
    this.lastMainAssistantUsage = null; // reset for next turn

    if (typeof msg.model === 'string' && msg.model) {
      events.push({ kind: 'model_update', model: msg.model });
    }
    events.push({
      kind: 'session_complete',
      result: (msg.result as string) || '',
      subtype: this.mapResultSubtype(msg.subtype as string),
    });
    return events.length === 1 ? events[0]! : events;
  }

  private extractUsage(msg: Record<string, unknown>): Omit<Extract<UnifiedEvent, { kind: 'usage' }>, 'kind' | 'semantics'> | null {
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (!usage) return null;

    const inputTokens = this.readNumber(usage.input_tokens, usage.inputTokens);
    const outputTokens = this.readNumber(usage.output_tokens, usage.outputTokens);
    const cacheReadTokens = this.readNumber(
      usage.cache_read_input_tokens,
      usage.cacheReadInputTokens,
      (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
    );
    const cacheCreationTokens = this.readNumber(
      usage.cache_creation_input_tokens,
      usage.cacheCreationInputTokens,
    );

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheReadTokens || undefined,
      cacheCreationTokens: cacheCreationTokens || undefined,
      model: typeof msg.model === 'string' ? msg.model : undefined,
    };
  }

  private readNumber(...values: unknown[]): number {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return 0;
  }

  private mapResultSubtype(subtype: string): 'success' | 'error' | 'error_max_turns' | 'error_max_budget' {
    switch (subtype) {
      case 'success': return 'success';
      case 'error_max_turns': return 'error_max_turns';
      case 'error_max_budget_usd': return 'error_max_budget';
      default: return 'error';
    }
  }
}
