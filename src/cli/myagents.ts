/**
 * myagents — Self-Configuration CLI for MyAgents
 *
 * Parses local CLI concerns and forwards stateful work to the Sidecar Admin
 * API. This source is bundled into the app; HOME launchers contain no copy of
 * these route/body/output contracts.
 *
 * Environment:
 *   MYAGENTS_PORT — Sidecar port (injected by buildClaudeSessionEnv)
 *   MYAGENTS_SESSION_ID — current MyAgents session id for attached-session tasks
 *
 * No shebang here. `npm run build:cli` (esbuild) injects `#!/usr/bin/env node`
 * through `--banner:js` so the *built* `myagents.cjs` artifact is what carries
 * the shebang. A leftover `#!/usr/bin/env bun` on this source file used to
 * stack with the banner and produced a TWO-shebang artifact (issue #107):
 * bun parses the first line as shebang, the second line `#!/usr/bin/env node`
 * is then read as JS and rejected as a syntax error. Same outcome under node.
 */

// ---------------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------------

// Port is resolved after arg parsing (--port flag can override env)
let PORT = process.env.MYAGENTS_PORT ?? '';
let BASE = '';

export function resolveCliPort(portFlag: unknown, inheritedPort: string): string {
  return typeof portFlag === 'string' && portFlag.length > 0
    ? portFlag
    : inheritedPort;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

function isSpaceJsonInvocation(): boolean {
  return (rawArgs[0] === 'space' || rawArgs[0] === 'issue')
    && rawArgs.some(arg => arg === '--json' || arg.startsWith('--json='));
}

/** Parse CLI arguments into structured flags and positional args */
export function parseArgs(args: string[]): { positional: string[]; flags: Record<string, unknown> } {
  const positional: string[] = [];
  const flags: Record<string, unknown> = {};
  const repeatable = new Set(['args', 'env', 'headers', 'models', 'model-names', 'image', 'file', 'attachment']);

  // PRD 0.2.18 cross-review fix (Codex): added short-flag → long-flag mapping
  // so `myagents session send <sid> -p "..."` works as documented in PRD §3.1
  // and SKILL.md. Only specific aliases are mapped; bare `-` prefixed positional
  // args remain valid (none of the current commands actually use bare-`-`
  // positional, but the explicit allow-list keeps the door open if needed).
  const shortFlagAliases: Record<string, string> = {
    'p': 'prompt',
    // Add more here if PRD documents additional short flags.
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      // Support both `--key value` and `--key=value` forms. The equals form
      // is ubiquitous in GNU-style CLIs; without it, callers (especially AI
      // agents) get silently-dropped values + confusing "missing flag" errors
      // downstream.
      const raw = arg.slice(2);
      const eq = raw.indexOf('=');
      const key = eq >= 0 ? raw.slice(0, eq) : raw;
      const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
      if (key === 'human-only') {
        const nextValue = args[i + 1];
        if (inlineValue !== undefined) {
          flags.humanOnly = inlineValue;
        } else if (nextValue === 'true' || nextValue === 'false') {
          flags.humanOnly = nextValue;
          i++;
        } else {
          // Preserve the historical bare form as true. Keep (but do not
          // consume) an invalid adjacent value so Space validators can emit
          // BOOLEAN_VALUE_INVALID instead of silently treating it as true.
          flags.humanOnly = true;
          if (nextValue !== undefined && !nextValue.startsWith('-')) {
            flags.humanOnlyInvalidValue = nextValue;
          }
        }
        i++;
        continue;
      }
      // Boolean flags (no value follows). Missing entries trigger the
      // generic key-value branch below — which consumes the NEXT token as
      // value when it doesn't start with `--`. That silently eats short
      // flags like `-p` (cross-review CC BLOCKER #2: `session send <sid>
      // --no-reply -p "..."` parsed `noReply='-p'` and dropped the prompt).
      // Add any new presence-only flag here.
      if (
        key === 'help' ||
        key === 'json' ||
        key === 'dry-run' ||
        key === 'disable-nonessential' ||
        key === 'full' ||
        key === 'no-reply' ||
        key === 'clear-provider-override' ||
        key === 'clear-runtime-override' ||
        key === 'clear-mcp-override' ||
        key === 'clear-trigger' ||
        key === 'purge' ||
        key === 'stdin' ||
        key === 'active' ||
        key === 'archived' ||
        key === 'all' ||
        key === 'include-archived' ||
        key === 'clear-goal' ||
        key === 'create-attached' ||
        key === 'wait' ||
        key === 'rollback'
      ) {
        if (key === 'wait' && inlineValue !== undefined) {
          flags.waitInvalidValue = inlineValue;
        }
        flags[camelCase(key)] = key === 'create-attached'
          ? parseInlineBooleanFlag(key, inlineValue)
          : true;
        i++;
        continue;
      }
      // Repeatable flags: ALWAYS consume the next token as a value, even if it
      // starts with '--' (e.g. --args "--stdio"). The boolean-fallback check
      // below must NOT run for repeatable flags — it would overwrite the
      // accumulated array with `true`.
      if (repeatable.has(key)) {
        const cKey = camelCase(key);
        const arr = (flags[cKey] as string[]) || [];
        if (inlineValue !== undefined) {
          arr.push(inlineValue);
          flags[cKey] = arr;
          i++;
          continue;
        }
        const value = args[i + 1];
        const requiresOrdinaryPathValue = key === 'file' || key === 'attachment';
        if (value === undefined || (requiresOrdinaryPathValue && value.startsWith('--'))) {
          // No value — normalize to empty array (not boolean) to keep type consistent
          if (!flags[cKey]) flags[cKey] = [];
          if (requiresOrdinaryPathValue) flags[`${cKey}ValueMissing`] = true;
          i++;
          continue;
        }
        arr.push(value);
        let j = i + 2;
        while (j < args.length && !args[j].startsWith('--')) {
          arr.push(args[j]);
          j++;
        }
        flags[cKey] = arr;
        i = j;
        continue;
      }
      // Key-value flags (non-repeatable)
      if (inlineValue !== undefined) {
        flags[camelCase(key)] = inlineValue;
        i++;
        continue;
      }
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      flags[camelCase(key)] = value;
      i += 2;
    } else if (arg.length === 2 && arg.startsWith('-') && shortFlagAliases[arg.slice(1)]) {
      // Short flag (e.g. -p) maps to long flag (--prompt). Always consumes the
      // next token as value (or treats as boolean if next is missing/another flag).
      const longKey = shortFlagAliases[arg.slice(1)]!;
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        flags[camelCase(longKey)] = true;
        i++;
      } else {
        flags[camelCase(longKey)] = value;
        i += 2;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

/**
 * Reject flags that arrived without a value (parser fell back to `true`
 * when the next token was another `--flag`). Surfaces a clear, exit-1
 * CLI error BEFORE any HTTP call — prevents the downstream handler from
 * seeing a bool where it expected a string and returning an opaque
 * "transport/parse failed" error to the AI caller.
 */
function assertStringFlag(value: unknown, flagName: string): asserts value is string | undefined {
  if (value === true) {
    console.error(`Error: --${flagName} requires a value (e.g. --${flagName} foo or --${flagName}=foo)`);
    process.exit(2);
  }
}

function parseZonedInstantFlag(raw: unknown, flagName: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) {
    console.error(`Error: --${flagName} requires an ISO-8601 timestamp with an explicit timezone offset or Z.`);
    process.exit(2);
  }
  const value = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([zZ]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) {
    console.error(`Error: --${flagName} "${raw}" must include an explicit timezone offset or Z (e.g. 2026-07-22T09:00:00+08:00).`);
    process.exit(2);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? '0');
  const offsetHour = Number(offsetHourText ?? '0');
  const offsetMinute = Number(offsetMinuteText ?? '0');
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const calendarIsValid = month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]!
    && hour <= 23
    && minute <= 59
    && second <= 59
    && (offset.toLowerCase() === 'z' || (offsetHour <= 23 && offsetMinute <= 59));
  const timestamp = Date.parse(value);
  if (!calendarIsValid || Number.isNaN(timestamp)) {
    console.error(`Error: --${flagName} "${raw}" is not a valid ISO-8601 timestamp.`);
    process.exit(2);
  }
  return new Date(timestamp).toISOString();
}

function parseGoalDeadlineFlag(raw: unknown): string | undefined {
  return parseZonedInstantFlag(raw, 'deadline');
}

function taskCliCaller(): { actor: 'agent' | 'user'; source: 'cli' } {
  return {
    actor: process.env.MYAGENTS_SESSION_ID?.trim() ? 'agent' : 'user',
    source: 'cli',
  };
}

function parseGoalMaxExecutionsFlag(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw.trim())
      ? Number(raw.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xFFFF_FFFF) {
    console.error('Error: --max-executions must be a positive integer between 1 and 4294967295.');
    process.exit(2);
  }
  return value;
}

function parseGoalAiCanExitFlag(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  console.error('Error: --ai-can-exit must be true or false.');
  process.exit(2);
}

function parseInlineBooleanFlag(key: string, inlineValue: string | undefined): boolean {
  if (inlineValue === undefined) return true;
  const normalized = inlineValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  console.error(`Error: --${key} expects a boolean value when using --${key}=...`);
  process.exit(2);
}

function camelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Demand a positional argument BEFORE issuing an API call. Issue #149: on
 * Windows some commands' positional args were getting silently dropped
 * before reaching the server, surfacing as a server-side "Missing required
 * argument" or "missing field" — which makes the AI think the CLI itself
 * is at fault. This shortcut exits at the CLI boundary with a concrete
 * usage hint so the AI's recovery path is clearer than parsing a server
 * 422.
 *
 * If `value` is non-empty, returns it (narrowed to `string`). If empty,
 * exits 1 with a `myagents <command>` usage line for the AI to follow.
 *
 * `flagAlternative` documents the `--<flag>` form a caller can use as a
 * workaround when shell quoting drops a positional.
 */
function requirePositional(
  value: string | undefined,
  argName: string,
  command: string,
  flagAlternative?: string,
): string {
  const v = (value ?? '').trim();
  if (v) return v;
  console.error(`Error: ${command} requires <${argName}>.`);
  console.error(`  Usage: myagents ${command} <${argName}>${flagAlternative ? ` (or --${flagAlternative} <${argName}>)` : ''}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const TOP_HELP = `myagents — MyAgents Self-Configuration CLI

Usage: myagents <command> [options]

Commands:
  anydoc    Convert one local document to Markdown (including offline OCR)
  speech    Transcribe one local audio/video attachment with local models
  mcp       Manage MCP tool servers
  vision    Official image-understanding CLI tool
  tool      Manage registered CLI tools (Lab-gated; enable in Settings first)
  model     Manage model providers
  agent     Discover stable Workspace Agents and manage proactive channels
  runtime   Inspect Agent Runtimes (list installed + describe models/modes)
  skill     Manage skills (install from URL/local source, list, enable/disable, sync)
  cron      Legacy-compatible scheduled Task aliases
  goal      Manage the current session Goal (get/create/update)
  task      Manage Task Center and scheduled automation tasks
  record    Manage unified text and audio Records (list/create)
  thought   Legacy compatibility alias for text Record list/create
  space     Discover Cloud Goals and manage Space Issues/attachments
  im        IM runtime actions for current chat (send-media)
  session   Discover, start, message, and observe Agent execution contexts
  widget    Generative UI widget design guidelines (readme)
  plugin    Manage OpenClaw channel plugins (IM npm-packaged adapters)
  cc-plugin Manage Claude plugins (PRD 0.2.17 — Anthropic plugin protocol)
  config    Read/write application config
  status    Show app running state
  version   Show app version
  reload    Hot-reload configuration
  diagnose  Diagnose external runtime state (auth, features, MCP, apps, env)

Global flags:
  --help      Show help for any command
  --json      Output as JSON
  --dry-run   Preview only commands whose exact leaf help documents support;
              unsupported mutations fail without applying changes
  --port NUM  Override Sidecar port (default: $MYAGENTS_PORT)

Examples:
  myagents mcp list
  myagents mcp show playwright
  myagents mcp add --id playwright --type stdio --command npx --args @playwright/mcp@latest
  myagents mcp enable playwright --scope both
  myagents mcp oauth discover notion-mcp
  myagents mcp oauth start notion-mcp
  myagents vision readme
  myagents vision analyze --image myagents_files/screenshot.png --prompt "Summarize the UI state"
  myagents speech transcribe --file myagents_files/meeting.m4a
  myagents model list
  myagents model set-key deepseek sk-xxx
  myagents skill list
  myagents skill add vercel-labs/skills --skill react-best-practices
  myagents skill add https://github.com/anthropics/skills --plugin document-skills
  myagents skill add ./private-skill --dry-run
  myagents skill add "npx skills add foo/bar --skill baz" --force
  myagents skill remove my-skill
  myagents skill sync
  myagents task readme
  myagents goal get
  myagents goal create --objective-file goal-objective.txt --max-executions 12
  myagents goal update --status complete
  myagents runtime list                       # see installed runtimes + install hints
  myagents runtime describe codex             # models + permission modes
  myagents runtime diagnose codex             # auth / features / MCP / apps / env snapshot (issue #194)
  myagents diagnose runtime codex             # alias for runtime diagnose
  myagents agent list --archived              # archived Agent workspaces
  myagents agent current --json               # compact current context diagnostic
  myagents agent show <agentId>                # identity + effective defaults
  myagents session list --agent <agentId>      # recent reusable contexts
  myagents session start --agent <agentId> -p "review this" # fresh context
  myagents agent archive <agent-id>
  myagents agent unarchive <agent-id>
  myagents task list --query "review" --limit 20
  myagents task get <taskId>            # returns metadata + docs paths
                                        # (task.md is canonical; retained
                                        #  legacy docs are listed if present)
  myagents task comments <taskId> --limit 50
  myagents task comment <taskId> --body-file result.md
  myagents task append-session <taskId> <sessionId>
  myagents task run <taskId>
  myagents task start <taskId>          # resume a stopped schedule
  myagents task stop <taskId>           # pause schedule and active execution
  myagents task runs <taskId> --limit 5
  myagents task exit --reason "goal achieved" # only inside an eligible Task run
  myagents task run-now <taskId>        # bypass Detector; does not change checkpoint
  myagents task rerun <taskId>
  myagents task trigger validate --spec-file trigger.json
  myagents task trigger test <taskId> --expect quiet|activate
    # Test does not commit MyAgents checkpoint/Activation state, but the local
    # command really runs and its own external side effects are not rolled back.
  myagents task check-now <taskId>
  myagents task reset-checkpoint <taskId>
  myagents task create-direct --name "review PR" \\
      --taskMdContent "Review this PR and verify the acceptance criteria" \\
      --runtime codex --model gpt-5.2 --permissionMode full-auto
    # Per-task runtime/model/permissionMode overrides — consult
    #   myagents runtime list  +  myagents runtime describe <runtime>
    # before choosing values. Omit any flag to inherit the agent workspace default.
  myagents task create-attached --name "Space Issue #123" \\
      --workspaceId proj --workspacePath /path/to/proj \\
      --taskMdContent-file task.md --source space-issue --sourceIssueId iss_123
  myagents space list --json
  myagents space --help
  myagents space whoami --space <slug> --json
  myagents space goal list --space <slug> --json
  myagents space issue list --space <slug> --goal <goalId> --state todo --limit 30
  myagents space issue view <issueId> --space <slug> --comments --json
  myagents space issue claim <issueId> --space <slug> --deliveryId <deliveryId>
  myagents space issue claim <issueId> --space <slug> --deliveryId <deliveryId> --create-attached \\
      --workspaceId proj --workspacePath /path/to/proj \\
      --name "Space Issue #123" --taskMdContent-file task.md
  myagents space issue comment <issueId> --space <slug> --body-file result.md --attachment report.pdf
  myagents space issue comment get <issueId> <commentId> --space <slug> --json
  myagents space issue complete <issueId> --space <slug> --taskId <taskId> --body-file result.md \\
      --message "completed Space issue"
  myagents space issue attachment add <issueId> --space <slug> --file report.pdf
  myagents space issue close <issueId> --space <slug>
  myagents space attachment download <attachmentId> --space <slug> --output myagents_files/space/file.bin
  myagents record list
  myagents plugin list
  myagents cc-plugin list
  myagents cc-plugin install anthropics/example-plugin
  myagents cc-plugin install file:///path/to/dev-plugin
  myagents cc-plugin enable my-plugin
  myagents version
  myagents reload

Run 'myagents <command> --help' for details on a specific command.`;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function callApi(route: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Non-JSON error bodies (e.g. axum 4xx returns plain text like
    // "Failed to deserialize query string: missing field `doc`") would
    // crash `resp.json()` with a SyntaxError — translate to an
    // AdminResponse-shaped error so the caller can surface it cleanly.
    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = await resp.text();
      return adminHttpErrorResult(
        route,
        resp.status,
        text.trim() || `HTTP ${resp.status} ${resp.statusText}`,
      );
    }
    return await resp.json() as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      if (isSpaceJsonInvocation()) {
        console.log(JSON.stringify({
          success: false,
          code: 'MYAGENTS_UNAVAILABLE',
          error: 'Cannot connect to the MyAgents app.',
          suggestion: 'Start MyAgents and retry the same Space command.',
        }, null, 2));
        process.exit(3);
      }
      console.error('Error: Cannot connect to MyAgents. Is the app running?');
      if (process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
        console.error('  This command appears to be running inside the Codex sandbox.');
        console.error('  If MyAgents is running on localhost, switch Codex to no-restrictions or run the command from your normal terminal.');
      }
      process.exit(sessionTransportExitCode(route));
    }
    throw err;
  }
}

export function adminHttpErrorResult(
  route: string,
  status: number,
  text: string,
): Record<string, unknown> {
  if (route === 'reload' && status === 404) {
    return {
      success: false,
      code: 'SESSION_SIDECAR_REQUIRED',
      error: 'Reload requires a Session Sidecar; the current Global Sidecar does not own session runtime state.',
      suggestion: 'Run the command from an active MyAgents chat session, or open its help for details.',
      suggestedCommand: 'myagents reload --help',
    };
  }
  return {
    success: false,
    error: text,
  };
}

export function sessionTransportExitCode(route: string): 2 | 3 {
  return route === 'session/start' || route === 'session/send' || route === 'session/watch'
    ? 2
    : 3;
}

export function commandResultExitCode(result: Record<string, unknown>): 0 | 1 {
  return result.success ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function printResult(
  group: string,
  action: string,
  result: Record<string, unknown>,
  jsonMode: boolean,
  flags: Record<string, unknown> = {},
  rest: string[] = [],
): void {
  if (jsonMode) {
    let output = result;
    if (group === 'task' && (action === 'run' || action === 'rerun') && result.data) {
      const data = { ...(result.data as Record<string, unknown>) };
      // attemptOrdinal is an internal accepted-mutation receipt consumed by
      // analytics. The public AI contract is data.receipt; keep that semantic
      // projection while hiding this implementation-only counter.
      delete data.attemptOrdinal;
      output = { ...result, data };
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (group === 'anydoc') {
    printAnydocResult(action, result);
    return;
  }

  if (group === 'speech') {
    printSpeechResult(action, result);
    return;
  }

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    if (group === 'task' && action === 'trigger' && rest[0] === 'test') {
      const data = result.data as { result?: Record<string, unknown> } | undefined;
      const failed = data?.result ?? {};
      const detectorError = (failed.error as Record<string, unknown> | undefined) ?? {};
      console.error(`  code:     ${String(detectorError.code ?? 'unknown')}`);
      console.error(`  duration: ${String(failed.durationMs ?? 0)} ms`);
      console.error(`  exit:     ${String(detectorError.exitCode ?? 'n/a')}`);
      console.error(`  signal:   ${String(detectorError.signal ?? 'n/a')}`);
      console.error(`  timeout:  ${String(detectorError.timedOut ?? false)}`);
      console.error(`  occurred: ${formatDetectorOccurredAt(detectorError.occurredAt)}`);
      const stderr = detectorError.stderrTail;
      if (stderr) console.error(`  stderr:   ${String(stderr)}`);
      if (failed.stdout) console.error(`  stdout:   ${String(failed.stdout)}`);
    }
    if (group === 'task' && action === 'check-now') {
      const data = result.data as { result?: Record<string, unknown> } | undefined;
      const state = (data?.result?.state as Record<string, unknown> | undefined) ?? {};
      const detectorError = (state.lastError as Record<string, unknown> | undefined) ?? {};
      console.error(`  code:     ${String(detectorError.code ?? result.code ?? 'unknown')}`);
      console.error(`  exit:     ${String(detectorError.exitCode ?? 'n/a')}`);
      console.error(`  signal:   ${String(detectorError.signal ?? 'n/a')}`);
      console.error(`  timeout:  ${String(detectorError.timedOut ?? false)}`);
      console.error(`  occurred: ${formatDetectorOccurredAt(detectorError.occurredAt)}`);
      if (detectorError.stderrTail) console.error(`  stderr:   ${String(detectorError.stderrTail)}`);
    }
    if (group === 'session' && action === 'start' && result.sessionId && result.messageId) {
      console.error(`  agent:   ${String(result.agentId ?? '(unknown)')}`);
      console.error(`  session: ${String(result.sessionId)}`);
      console.error(`  request: ${String(result.messageId)}`);
      if (result.accepted === null || result.unconfirmed === true) {
        console.error('  state:   admission unconfirmed; do not automatically resend.');
      }
    }
    const hasSuggestion = typeof result.suggestion === 'string' && result.suggestion.trim();
    if (hasSuggestion) {
      console.error(`Suggestion: ${result.suggestion}`);
    }
    if (typeof result.suggestedCommand === 'string' && result.suggestedCommand.trim()) {
      console.error(`  \u2192 Run: ${result.suggestedCommand}`);
      return;
    }
    if (hasSuggestion) {
      return;
    }
    // Structured recovery hint (v0.1.69+): print `→ Run: <command>   <message>`
    // below the error line in human mode so a downstream AI reader has a
    // concrete next step, not just a rejection. JSON mode preserves the full
    // shape via the `JSON.stringify` branch above.
    const hint = result.recoveryHint as { recoveryCommand?: string; message?: string } | undefined;
    if (hint && typeof hint === 'object') {
      if (hint.recoveryCommand) {
        const suffix = hint.message ? `   ${hint.message}` : '';
        console.error(`  \u2192 Run: ${hint.recoveryCommand}${suffix}`);
      } else if (hint.message) {
        console.error(`  ${hint.message}`);
      }
    }
    return;
  }

  // Dry-run
  if (result.dryRun) {
    console.log('[DRY RUN] Would apply:');
    console.log(formatObject(result.preview as Record<string, unknown>));
    console.log('\nRun without --dry-run to apply.');
    return;
  }

  // Group-specific formatting
  if (group === 'mcp' && action === 'list') {
    printMcpList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'mcp' && action === 'show') {
    printMcpShow(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'mcp' && action === 'test') {
    printMcpTest(result.data as Record<string, unknown>, result.hint);
    return;
  }
  if (group === 'tool' && action === 'list') {
    const data = result.data as { tools?: Array<Record<string, unknown>> } | undefined;
    printToolList(data?.tools ?? []);
    if (result.hint) console.log(`\n${result.hint}`);
    return;
  }
  if (group === 'tool' && action === 'env') {
    const data = (result.data as Record<string, unknown>) ?? {};
    const env = (data.env as Record<string, unknown>) ?? {};
    if (Object.keys(env).length > 0) {
      console.log(formatObject(env));
    } else {
      console.log('(no env vars set)');
    }
    const missing = data.missingKeys as string[] | undefined;
    if (missing && missing.length > 0) {
      console.log(`\nDeclared but unconfigured: ${missing.join(', ')}`);
      console.log(`  → Run: myagents tool env ${String(data.name)} set ${missing[0]}=<value>`);
    }
    if (result.hint) console.log(`\n${result.hint}`);
    return;
  }
  if (group === 'model' && action === 'list') {
    printModelList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'agent' && action === 'list') {
    printAgentList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cron' && action === 'list') {
    printCronList(result.data as Array<Record<string, unknown>>);
    // Surface the workspace-scope note so an empty list isn't misread as
    // "no cron tasks anywhere" (#320 secondary). --json carries it inline.
    if (result.hint) console.log(`\n${result.hint}`);
    return;
  }
  if ((group === 'cron' || group === 'task') && action === 'runs') {
    printCronRuns(result.data as Array<Record<string, unknown>>, !!flags.full);
    return;
  }
  if (group === 'cron' && action === 'run-now') {
    const data = result.data as Record<string, unknown> | undefined;
    if (!data) {
      console.log('✓ Triggered.');
      return;
    }
    console.log(`✓ Triggered ${data.taskId ?? '(unknown)'}`);
    if (data.sessionId) console.log(`  session: ${data.sessionId}`);
    if (data.dispatchedAt) {
      console.log(`  dispatched: ${formatCronInstantWithUtc(data.dispatchedAt, resolveLocalTimezone())}`);
    }
    console.log(`  runs:    myagents cron runs ${data.taskId ?? '<id>'} --limit 1`);
    return;
  }
  if ((group === 'cron' || group === 'task') && action === 'stop') {
    const data = result.data as Record<string, unknown> | undefined;
    const taskId = data?.taskId ?? '(unknown)';
    const status = data?.status ?? 'unknown';
    console.log(`✓ Task ${taskId} is not running`);
    console.log(`  status: ${status}`);
    printTaskNextExecution(data?.nextExecutionAt);
    if (status === 'blocked') {
      console.log(`  restart: myagents task rerun ${taskId}`);
    }
    return;
  }
  if (group === 'task' && action === 'start') {
    const data = result.data as Record<string, unknown> | undefined;
    const task = (data?.task as Record<string, unknown> | undefined) ?? data;
    console.log(`✓ Task schedule enabled ${String(task?.id ?? task?.taskId ?? '')}`.trim());
    console.log(`  status: ${String(task?.status ?? data?.status ?? 'unknown')}`);
    printTaskNextExecution(task?.nextExecutionAt ?? data?.nextExecutionAt);
    return;
  }
  if (group === 'cron' && action === 'update') {
    // Issue #115 — echo the computed next fire time + tz so users see
    // exactly when their schedule edit will fire next. Avoids the
    // strict-after-now confusion ("I changed to minute 33, why does
    // list show 33 next hour") by anchoring the display at update time.
    const task = result.data as Record<string, unknown> | null;
    const taskId = task?.id ?? '<id>';
    console.log(`✓ Updated ${taskId}`);
    if (task) {
      const tz = cronDisplayTimezone(task.schedule);
      console.log(`  schedule: ${formatCronTaskScheduleForDisplay(task, 'long')}`);
      const nextRaw = task.nextExecutionAt as string | undefined;
      if (nextRaw) {
        const nextMs = parseInstantMs(nextRaw);
        if (nextMs !== null) {
          const local = formatCronInstantForDisplay(nextMs, tz.timezone, 'long');
          const diffMs = nextMs - Date.now();
          const diffStr = diffMs > 0
            ? ` (in ${formatRelativeMs(diffMs)})`
            : ' (in the past)';
          console.log(`  next fire: ${local}${diffStr}`);
        }
      }
    }
    return;
  }
  if (group === 'cron' && action === 'status') {
    printCronStatus(result.data as Record<string, unknown>);
    if (result.hint) console.log(`\n${result.hint}`);
    return;
  }
  if (group === 'goal') {
    printGoalResult(action, result.data as Record<string, unknown> | undefined);
    return;
  }
  if (group === 'space' && action === 'goal' && (rest[0] || 'list') === 'list') {
    printSpaceGoalList(result.data as Record<string, unknown>, flags);
    return;
  }
  if (group === 'space' && action === 'issue' && rest[0] === 'update') {
    printSpaceIssueUpdate(result.data as Record<string, unknown>, flags);
    return;
  }
  if (group === 'plugin' && action === 'list') {
    printPluginList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cc-plugin' && action === 'list') {
    printCcPluginList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'task' && action === 'list') {
    printTaskList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'task' && action === 'get') {
    printTaskDetail(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'thought' && action === 'list') {
    printThoughtList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'record' && action === 'list') {
    printRecordList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'skill' && action === 'list') {
    printSkillList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'skill' && action === 'info') {
    printSkillInfo(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'skill' && action === 'add') {
    printSkillAdd(result as Record<string, unknown>);
    return;
  }
  if (group === 'mcp' && action === 'oauth') {
    printMcpOAuth(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'version') {
    console.log((result.data as { version: string })?.version ?? 'Unknown');
    return;
  }
  if (group === 'agent' && action === 'runtime-status') {
    printAgentRuntimeStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'agent' && action === 'channel') {
    // `agent channel list/add/remove` — list returns an array of channel
    // descriptors; add/remove return small ack objects. Issue #149.
    const subAction = (typeof flags.action === 'string' ? flags.action : undefined)
      ?? (Array.isArray(result.data) ? 'list' : undefined);
    if (Array.isArray(result.data) || subAction === 'list') {
      printChannelList(result.data as Array<Record<string, unknown>>);
      return;
    }
    // add/remove fallthrough to generic ✓ formatter below
  }
  if (group === 'config' && action === 'get') {
    // Issue #149: was falling through to `✓ get` (id-only generic
    // formatter). Now show the actual key + (possibly redacted) value.
    const data = (result.data as Record<string, unknown>) ?? {};
    const key = data.key ?? '';
    const value = data.value;
    if (typeof value === 'object' && value !== null) {
      console.log(`${key}:`);
      console.log(formatObject(value as Record<string, unknown>));
    } else {
      console.log(`${key}: ${value === undefined ? '(unset)' : String(value)}`);
    }
    return;
  }
  if (group === 'mcp' && action === 'env') {
    // `mcp env get/set/delete` — generic ✓ formatter swallowed values for
    // get. Render env map for any sub-action (issue #149).
    const data = (result.data as Record<string, unknown>) ?? {};
    const env = (data.env as Record<string, unknown>) ?? data;
    if (env && typeof env === 'object' && Object.keys(env).length > 0) {
      console.log(formatObject(env as Record<string, unknown>));
    } else {
      console.log('(no env vars set)');
    }
    if (result.hint) console.log(`\n${result.hint}`);
    return;
  }
  if (group === 'agent' && action === 'show') {
    printAgentShow(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'agent' && action === 'current') {
    printAgentCurrent(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'session' && action === 'list') {
    printSessionList(result.data as Array<Record<string, unknown>>, result);
    return;
  }
  if (group === 'session' && action === 'start') {
    console.log('✓ fresh Session request accepted');
    console.log(`  agent:   ${String(result.agentId ?? '(unknown)')}`);
    console.log(`  session: ${String(result.sessionId ?? '(unknown)')}`);
    console.log(`  request: ${String(result.messageId ?? '(unknown)')}`);
    console.log('  state:   accepted; target is running asynchronously');
    if (result.replyBack === false) {
      console.log('  result:  one-way; MyAgents will not push the target turn result back here.');
    } else {
      console.log('  result:  MyAgents will push the target turn result back as a <myagents-session-event type="send.result"> block.');
    }
    console.log(`  follow-up: myagents session send ${String(result.sessionId ?? '<sessionId>')} -p "<prompt>"`);
    console.log(`             myagents session watch ${String(result.sessionId ?? '<sessionId>')}`);
    return;
  }
  if (group === 'runtime' && action === 'list') {
    printRuntimeList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'runtime' && action === 'describe') {
    printRuntimeDescribe(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'runtime' && action === 'diagnose') {
    printRuntimeDiagnose(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'vision' && action === 'analyze') {
    const data = result.data as Record<string, unknown> | undefined;
    const text = typeof data?.text === 'string' ? data.text : '';
    if (text.trim()) {
      console.log(text);
    } else {
      console.log('\u2713 vision analyze completed');
    }
    return;
  }
  if (group === 'diagnose') {
    // `myagents diagnose runtime <type>` — sugar for `runtime diagnose`.
    printRuntimeDiagnose(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'status') {
    printStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'session' && action === 'send') {
    const messageId = result.messageId ? ` ${result.messageId}` : '';
    console.log(`\u2713 session send delivered${messageId}`);
    if (result.replyBack === false) {
      console.log('  notification: one-way; MyAgents will not push the target turn result back here.');
    } else {
      console.log('  notification: MyAgents will push the target turn result back as a <myagents-session-event type="send.result"> block.');
    }
    return;
  }
  if (group === 'session' && action === 'watch') {
    if (typeof result.eventPrompt === 'string' && result.eventPrompt.trim()) {
      console.log(result.eventPrompt);
      return;
    }
    console.log(`\u2713 session watch registered ${result.watchId ?? ''}`.trim());
    console.log(`  target: ${result.targetSessionId ?? '(unknown)'}`);
    console.log(`  state:  ${result.targetStateAtRegistration ?? 'unknown'}`);
    console.log('  result: MyAgents will push a <myagents-session-event type="watch.completed"> block when the target finishes.');
    return;
  }
  if (group === 'help') {
    console.log((result.data as { text: string })?.text ?? '');
    return;
  }

  // Tool readmes: canonical `task readme`, compatible `cron readme`,
  // `im readme`, and any `widget ...` form all
  // return a raw text body in result.data.text. Print it as-is — no padding,
  // no status line, no ticks — so AI can consume it directly as context.
  if (action === 'readme' || group === 'widget') {
    console.log((result.data as { text: string })?.text ?? '');
    return;
  }

  // Task create-* — AI-facing flow: print task_id + docs path + next-step
  // hint + any override echo so the caller doesn't have to guess the id via
  // `ls -lt ~/.myagents/tasks/`. JSON mode above returns the full payload.
  // All create-* forms go through the same enriched server-side response.
  // `enrichTaskCreateResponse` server-side, so one printer covers both.
  if (group === 'task' && (action === 'create-direct' || action === 'create-attached')) {
    printTaskCreateResult(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'space' && action === 'issue' && shouldCreateAttachedTaskForClaim(flags)) {
    printSpaceClaimAttachedResult(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'space' && action === 'issue' && objectValue(result.data)?.issueComplete !== undefined) {
    printSpaceIssueCompleteResult(result.data as Record<string, unknown>);
    return;
  }

  // Task run — print the engine/model the task will execute on, plus the
  // task_id echo so the caller has observability on what was dispatched.
  if (group === 'task' && (action === 'run' || action === 'rerun')) {
    printTaskDispatchResult(action, result.data as Record<string, unknown>);
    return;
  }
  if (group === 'task' && action === 'run-now') {
    const data = result.data as Record<string, unknown> | undefined;
    console.log('\u2713 AI execution dispatched without running Detector');
    console.log(`  task:    ${String(data?.taskId ?? '')}`);
    console.log(`  session: ${String(data?.sessionId ?? '')}`);
    console.log('  checkpoint: unchanged');
    return;
  }
  if (group === 'task' && action === 'trigger') {
    const triggerAction = rest[0] ?? 'validate';
    if (triggerAction === 'validate') {
      console.log('\u2713 Trigger spec is valid');
      return;
    }
    const data = result.data as { result?: Record<string, unknown> } | undefined;
    const tested = data?.result ?? {};
    const reason = (tested.reason as Record<string, unknown> | undefined) ?? {};
    const event = (tested.event as Record<string, unknown> | undefined) ?? null;
    const handoff = (tested.handoff as Record<string, unknown> | undefined) ?? null;
    console.log('\u2713 Detector test completed (MyAgents state was not committed)');
    console.log(`  decision: ${String(tested.decision ?? 'unknown')}`);
    console.log(`  reason:   ${String(reason.code ?? 'unknown')} · ${String(reason.message ?? '')}`);
    if (event) {
      console.log(`  event:    ${String(event.id ?? '')} · ${String(event.kind ?? '')} · ${String(event.occurredAt ?? '')}`);
    }
    if (handoff?.summary) console.log(`  handoff:  ${String(handoff.summary)}`);
    if (Object.hasOwn(tested, 'nextCheckpoint')) {
      console.log(`  checkpoint: ${JSON.stringify(tested.nextCheckpoint)}`);
    }
    console.log(`  duration: ${String(tested.durationMs ?? 0)} ms`);
    console.log(`  exit:     ${String(tested.exitCode ?? 'unknown')}`);
    if (tested.stderrTail) console.log(`  stderr:   ${String(tested.stderrTail)}`);
    console.log('  note: the command really ran; its own external side effects are not rolled back');
    return;
  }
  if (group === 'task' && action === 'check-now') {
    const data = result.data as { result?: Record<string, unknown> } | undefined;
    const checked = data?.result ?? {};
    const state = (checked.state as Record<string, unknown> | undefined) ?? {};
    console.log('\u2713 Detector check completed');
    console.log(`  outcome: ${String(checked.outcome ?? state.lastOutcome ?? 'unknown')}`);
    console.log(`  checks:  ${String(state.checkCount ?? 0)}`);
    return;
  }
  if (group === 'task' && action === 'reset-checkpoint') {
    console.log('\u2713 Detector checkpoint reset');
    return;
  }

  // Generic success output
  const symbol = '\u2713'; // ✓
  const hint = result.hint ? ` ${result.hint}` : '';
  const id = (result.data as Record<string, unknown>)?.id ?? '';
  console.log(`${symbol} ${action} ${id}${hint}`);
}

function formatDetectorOccurredAt(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
}

/**
 * Format output for task create-* commands.
 *
 * AI scripts need at minimum the `task_id` of the newly minted task so they
 * can either dispatch it (`create-direct`) or keep working in the current
 * session (`create-attached`). Also surfaces
 * `docs_path` because the AI often wants to tell the human "I wrote the task
 * docs to X" and having that string in the CLI output saves a re-lookup.
 *
 * Plaintext shape deliberately mirrors what `--json` produces so readers
 * can mentally switch between the two without re-learning fields:
 *
 *   ✓ Task created
 *     task_id:   <uuid>
 *     name:      <string>
 *     docs_path: ~/.myagents/tasks/<uuid>/
 *     dispatch:  myagents task run <uuid>          # non-attached tasks
 *     complete:  myagents task update-status ...   # attached tasks
 */
function printTaskCreateResult(data: Record<string, unknown>): void {
  // Handler returns { task, dispatched?, runResult? } — `task` is the full
  // Task record; `dispatched/runResult` appear when the caller passed --run.
  const task = (data?.task as Record<string, unknown>) ?? data;
  const id = String(task?.id ?? '');
  const name = String(task?.name ?? '');
  const home = process.env.HOME ?? '';
  const absDocs = `${home}/.myagents/tasks/${id}/`;
  const displayDocs = home && absDocs.startsWith(home)
    ? `~${absDocs.slice(home.length)}`
    : absDocs;

  console.log('\u2713 Task created');
  if (id) console.log(`  task_id:   ${id}`);
  if (name) console.log(`  name:      ${name}`);
  console.log(`  docs_path: ${displayDocs}`);
  printTaskNextExecution(task?.nextExecutionAt ?? data?.nextExecutionAt);

  // Surface which runtime/model/permission overrides actually landed on the
  // persisted task (read from the server-returned Task record, not echoed
  // from the request). Visible here — not buried in --json — because the AI
  // needs to confirm "the override I specified stuck" before dispatching.
  // A mismatch between `overridesRequested` and `overridden` indicates the
  // server silently dropped a field, which the AI should flag to the user.
  const overridden = (data?.overridden as string[] | undefined) ?? [];
  const overridesRequested = (data?.overridesRequested as string[] | undefined) ?? [];
  const overrides = (data?.overrides as Record<string, unknown> | undefined) ?? {};
  if (overridden.length > 0) {
    console.log(`  overrides: ${overridden.join(', ')}`);
    for (const field of overridden) {
      const v = overrides[field];
      if (v !== null && v !== undefined && v !== '') {
        const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
        console.log(`    ${field.padEnd(14)} = ${display}`);
      }
    }
  } else {
    console.log('  overrides: (none — inherits workspace defaults)');
  }
  // Drift warning: requested override didn't reach the persisted task.
  const droppedFields = overridesRequested.filter(f => !overridden.includes(f));
  if (droppedFields.length > 0) {
    console.log('');
    console.log(`  \u26A0 warning: requested overrides were NOT persisted: ${droppedFields.join(', ')}`);
    console.log('    This likely indicates a server-side deserialization gap — please report.');
  }

  const nextSteps = data?.nextSteps as Record<string, string> | undefined;
  const isAttached = task?.dispatchOrigin === 'attached-session';
  const dispatch = nextSteps?.dispatch ?? (!isAttached && id ? `myagents task run ${id}` : '');
  if (dispatch) console.log(`  dispatch:  ${dispatch}`);
  const inspect = nextSteps?.inspect;
  if (inspect && isAttached) console.log(`  inspect:   ${inspect}`);
  const complete = nextSteps?.complete;
  if (complete) console.log(`  complete:  ${complete}`);

  // If --run was bundled with create, the backend also dispatched; echo
  // the dispatch summary inline so the caller sees both in one output.
  const runResult = data?.runResult as Record<string, unknown> | undefined;
  if (runResult) {
    console.log('');
    printTaskDispatchResult('run', runResult);
  }
}

function printSpaceClaimAttachedResult(data: Record<string, unknown>): void {
  const claim = objectValue(data.claim) ?? {};
  const taskData = objectValue(data.taskCreate) ?? {};
  const task = objectValue(data.task) ?? objectValue(taskData.task) ?? {};
  const issueId = String(data.issueId ?? claim.issueId ?? '');
  const claimId = String(claim.id ?? claim.claimId ?? '');
  const taskId = String(task.id ?? task.taskId ?? '');
  const sessionId = String(data.localSessionId ?? task.currentSessionId ?? process.env.MYAGENTS_SESSION_ID ?? '');
  const workspacePath = typeof task.workspacePath === 'string' && task.workspacePath.trim()
    ? task.workspacePath.trim()
    : '';
  const workspaceArg = workspacePath ? ` --workspacePath ${shellQuoteArg(workspacePath)}` : '';
  const spaceArg = typeof data.spaceSlug === 'string' && data.spaceSlug.trim()
    ? ` --space ${shellQuoteArg(data.spaceSlug.trim())}`
    : '';

  console.log('\u2713 Issue claimed and attached task created');
  if (issueId) console.log(`  issue_id:  ${issueId}`);
  if (claimId) console.log(`  claim_id:  ${claimId}`);
  if (taskId) console.log(`  task_id:   ${taskId}`);
  if (sessionId) console.log(`  session:   ${sessionId}`);
  if (taskId) console.log(`  inspect:   myagents task get ${taskId}`);
  if (issueId && taskId) {
    console.log(`  finish:    myagents space issue complete ${shellQuoteArg(issueId)}${spaceArg}${workspaceArg} --taskId ${shellQuoteArg(taskId)} --body-file result.md --message "completed Space issue"`);
  } else if (issueId) {
    console.log(`  complete:  myagents space issue complete ${shellQuoteArg(issueId)}${spaceArg}${workspaceArg}`);
  }
}

function printSpaceIssueCompleteResult(data: Record<string, unknown>): void {
  const issueId = String(data.issueId ?? '');
  const issueComplete = objectValue(data.issueComplete) ?? {};
  const taskUpdate = objectValue(data.taskUpdate) ?? {};
  const task = objectValue(taskUpdate.task) ?? taskUpdate;
  const taskId = String(data.taskId ?? task.id ?? '');
  const taskStatus = String(data.taskStatus ?? task.status ?? '');
  const comment = data.comment ? 'yes' : 'no';

  console.log('\u2713 Issue completion recorded');
  if (issueId) console.log(`  issue_id:  ${issueId}`);
  if (issueComplete.state || issueComplete.status) {
    console.log(`  issue:     ${String(issueComplete.state ?? issueComplete.status)}`);
  }
  console.log(`  comment:   ${comment}`);
  if (taskId) console.log(`  task_id:   ${taskId}`);
  if (taskStatus) console.log(`  task:      ${taskStatus}`);
}

function printSpaceGoalList(data: Record<string, unknown>, flags: Record<string, unknown>): void {
  const items = Array.isArray(data?.items) ? data.items as Array<Record<string, unknown>> : [];
  const slug = typeof flags.space === 'string' ? flags.space : '';
  const includeArchived = flags.includeArchived === true;
  if (items.length === 0) {
    console.log(`No ${includeArchived ? '' : 'active '}Goals in Space "${slug}".`);
    console.log('Create the Issue without --goal to place it in Inbox.');
    return;
  }

  console.log(`Goals in Space "${slug}"`);
  console.log('');
  console.log(includeArchived ? 'GOAL ID                 STATUS      PATH' : 'GOAL ID                 PATH');
  for (const goal of items) {
    const id = String(goal.id ?? '');
    const depth = typeof goal.depth === 'number' ? Math.max(0, goal.depth) : 0;
    const path = `${'  '.repeat(depth)}${String(goal.goalPathLabel ?? goal.title ?? '')}`;
    if (includeArchived) {
      const status = goal.archivedAt ? 'archived' : 'active';
      console.log(`${id.padEnd(24)}${status.padEnd(12)}${path}`);
    } else {
      console.log(`${id.padEnd(24)}${path}`);
    }
  }
  console.log('');
  console.log('Use an active GOAL ID exactly as returned:');
  console.log(`  create: myagents space issue create --space ${shellQuoteArg(slug)} ... --goal <goalId>`);
  console.log(`  move:   myagents space issue update <issueId> --space ${shellQuoteArg(slug)} --goal <goalId>`);
  console.log(`  inbox:  myagents space issue update <issueId> --space ${shellQuoteArg(slug)} --clear-goal`);
}

function printSpaceIssueUpdate(data: Record<string, unknown>, flags: Record<string, unknown>): void {
  const issue = objectValue(data?.issue) ?? data;
  const issueId = String(issue.id ?? '');
  const state = String(issue.state ?? issue.status ?? '');
  const goalId = typeof issue.goalId === 'string' && issue.goalId.trim() ? issue.goalId.trim() : '';
  const goalPathLabel = typeof issue.goalPathLabel === 'string' && issue.goalPathLabel.trim()
    ? issue.goalPathLabel.trim()
    : '';
  const slug = typeof flags.space === 'string' ? flags.space : '';

  console.log('\u2713 Issue updated');
  if (issueId) console.log(`  issue_id: ${issueId}`);
  console.log(`  goal: ${goalId ? `${goalPathLabel || '(unnamed Goal)'} (${goalId})` : 'Inbox'}`);
  if (state) console.log(`  state: ${state}`);
  if (issueId && slug) {
    console.log(`  inspect: myagents space issue view ${shellQuoteArg(issueId)} --space ${shellQuoteArg(slug)} --json`);
  }
}

/**
 * Format `myagents runtime list` output.
 *
 * Structure each row as `runtime  installed  version  displayName`, with
 * non-installed rows following up on the next line with the install hint.
 * AI callers scan this to learn which `--runtime` values are safe to pass.
 */
function printRuntimeList(rows: Array<Record<string, unknown>>): void {
  if (!rows || rows.length === 0) {
    console.log('No runtimes found.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('RUNTIME', 14) + pad('INSTALLED', 11) + pad('VERSION', 18) + 'NAME');
  for (const row of rows) {
    const rt = String(row.runtime ?? '');
    const installed = row.installed ? 'yes' : 'no';
    const version = String(row.version ?? '').split('\n')[0].slice(0, 16) || '-';
    console.log(pad(rt, 14) + pad(installed, 11) + pad(version, 18) + String(row.displayName ?? ''));
    const hint = row.notInstalledHint;
    if (hint) console.log(`    \u2192 ${String(hint)}`);
  }
  console.log('');
  console.log('Describe a runtime:  myagents runtime describe <runtime>');
}

/**
 * Format `myagents runtime describe <runtime>` output.
 *
 * Show the four things an AI needs before choosing override values:
 *   - install state (version string when installed, install hint otherwise)
 *   - available models  (`--model` accepts any of these)
 *   - permission modes  (`--permissionMode` accepts any of these)
 *   - default permission mode (so the caller knows what "no override" means)
 */
function printRuntimeDescribe(data: Record<string, unknown>): void {
  const runtime = String(data.runtime ?? '');
  const name = String(data.displayName ?? runtime);
  const installed = data.installed ? 'yes' : 'no';
  const version = data.version ? ` (${String(data.version).split('\n')[0]})` : '';
  console.log(`${name}  [${runtime}]`);
  console.log(`  installed: ${installed}${version}`);
  const defaultMode = String(data.defaultPermissionMode ?? '');
  if (defaultMode) console.log(`  default permissionMode: ${defaultMode}`);

  const models = (data.models as Array<Record<string, unknown>>) ?? [];
  console.log('');
  console.log('Models:');
  if (models.length === 0) {
    console.log('  (none reported — runtime may not be installed, or has no static model list)');
  } else {
    for (const m of models) {
      const value = String(m.value ?? '');
      const display = String(m.displayName ?? '');
      const mark = m.isDefault ? ' *' : '';
      console.log(`  ${value.padEnd(28) || '(default)'}  ${display}${mark}`);
    }
  }

  const modes = (data.permissionModes as Array<Record<string, unknown>>) ?? [];
  console.log('');
  console.log('Permission modes:');
  if (modes.length === 0) {
    console.log('  (runtime uses the built-in PermissionMode enum; set via --permissionMode)');
  } else {
    for (const mode of modes) {
      const value = String(mode.value ?? '');
      const label = String(mode.label ?? '');
      const desc = String(mode.description ?? '');
      console.log(`  ${value.padEnd(22)} ${label}${desc ? '  —  ' + desc : ''}`);
    }
  }

  const note = data.note;
  if (note) {
    console.log('');
    console.log(`Note: ${String(note)}`);
  }
}

/**
 * Format `myagents diagnose runtime <type>` output.
 *
 * Five sections: header (runtime + version + installed state) + auth + features
 * + mcpServers + apps + effectiveEnv. Each section reports `unsupported` or an
 * `error` string when the underlying RPC didn't complete. Designed for paste-
 * to-issue triage of issue #194 / future runtime-divergence reports.
 */
function printRuntimeDiagnose(data: Record<string, unknown>): void {
  if (!data) {
    console.log('(no diagnostic data)');
    return;
  }
  const runtime = String(data.runtime ?? '');
  const version = String(data.version ?? '');
  console.log(`Runtime: ${runtime}${version ? `  (${version})` : ''}`);

  const diag = (data.diagnostics ?? {}) as Record<string, unknown>;
  const status = (diag.status ?? {}) as Record<string, unknown>;
  const issues = (diag.issues as Array<Record<string, unknown>>) ?? [];

  const renderStatus = (s: unknown): string => {
    if (s === 'ok') return 'ok';
    if (s === 'unsupported') return 'unsupported by this runtime';
    if (s && typeof s === 'object' && 'error' in (s as Record<string, unknown>)) {
      return `error: ${String((s as { error: unknown }).error)}`;
    }
    return '(not reported)';
  };

  // Auth
  console.log('');
  console.log(`Auth [${renderStatus(status.auth)}]`);
  const auth = diag.auth as Record<string, unknown> | undefined;
  if (auth) {
    console.log(`  method: ${auth.authMethod ?? '(null)'}`);
    if (auth.requiresLogin) console.log('  requiresLogin: true');
    if (auth.details) console.log(`  details: ${auth.details}`);
  }

  // Features
  console.log('');
  console.log(`Feature flags [${renderStatus(status.features)}]`);
  const features = (diag.features as Array<Record<string, unknown>>) ?? [];
  if (features.length === 0) {
    if (status.features === 'ok') console.log('  (none enabled / all at default)');
  } else {
    for (const f of features) {
      const name = String(f.name ?? '');
      const enabled = f.enabled ? 'on ' : 'off';
      const def = f.defaultEnabled ? 'default-on ' : 'default-off';
      const stage = f.stage ? ` (${String(f.stage)})` : '';
      console.log(`  ${enabled}  ${name.padEnd(38)}  ${def}${stage}`);
    }
  }

  // MCP servers
  console.log('');
  console.log(`MCP servers [${renderStatus(status.mcpServers)}]`);
  const mcp = (diag.mcpServers as Array<Record<string, unknown>>) ?? [];
  if (mcp.length === 0) {
    if (status.mcpServers === 'ok') console.log('  (none)');
  } else {
    for (const s of mcp) {
      const name = String(s.name ?? '');
      const tools = Number(s.toolCount ?? 0);
      const resources = Number(s.resourceCount ?? 0);
      const authStatus = s.authStatus ? ` auth=${String(s.authStatus)}` : '';
      console.log(`  ${name.padEnd(28)} tools=${tools} resources=${resources}${authStatus}`);
    }
  }

  // Apps — THE diagnostic for issue #194
  console.log('');
  console.log(`Apps [${renderStatus(status.apps)}]`);
  const apps = (diag.apps as Array<Record<string, unknown>>) ?? [];
  if (apps.length === 0) {
    if (status.apps === 'ok') console.log('  (none — app discovery returned an empty list)');
  } else {
    for (const a of apps) {
      const id = String(a.id ?? '');
      const enabled = a.isEnabled ? 'enabled ' : 'disabled';
      const accessible = a.isAccessible ? 'accessible' : 'NOT accessible';
      const needs = a.needsAuth ? ' needs-auth' : '';
      console.log(`  ${enabled}  ${accessible.padEnd(15)}  ${id}${needs}`);
    }
  }

  // Effective env
  console.log('');
  console.log('Effective env (sanitized):');
  const env = (diag.effectiveEnv ?? {}) as Record<string, unknown>;
  console.log(`  cwd: ${env.cwd ?? '(unknown)'}`);
  const proxy = (env.proxy ?? {}) as Record<string, unknown>;
  console.log(`  HTTP_PROXY:  ${proxy.http ?? '(unset)'}`);
  console.log(`  HTTPS_PROXY: ${proxy.https ?? '(unset)'}`);
  console.log(`  ALL_PROXY:   ${proxy.all ?? '(unset)'}`);
  console.log(`  NO_PROXY:    ${proxy.no ?? '(unset)'}`);
  console.log(`  proxyPolicy: ${env.proxyPolicy ?? 'myagents'}`);
  console.log(`  MYAGENTS_PROXY_INJECTED: ${env.myagentsProxyInjected ? 'yes' : 'no'}`);
  const sandbox = env.codexSandbox as Record<string, unknown> | undefined;
  if (sandbox) {
    console.log(`  Codex sandbox detected: ${sandbox.detected ? 'yes' : 'no'}`);
    if ('networkDisabled' in sandbox) {
      console.log(`  Codex sandbox network disabled: ${sandbox.networkDisabled ? 'yes' : 'no'}`);
    }
    const probe = sandbox.proxyProbe as Record<string, unknown> | undefined;
    if (probe) {
      console.log(`  Loopback proxy probe: ${probe.reachable ? 'reachable' : 'blocked'} (${probe.url ?? 'unknown'})${probe.error ? ` — ${probe.error}` : ''}`);
    }
  }
  const pathHead = (env.pathHead as string[]) ?? [];
  if (pathHead.length > 0) {
    console.log(`  PATH (first ${pathHead.length}): ${pathHead.join(' : ')}`);
  }
  console.log(`  has OPENAI_API_KEY:     ${env.hasOpenaiApiKey ? 'yes' : 'no'}`);
  console.log(`  has ANTHROPIC_API_KEY:  ${env.hasAnthropicApiKey ? 'yes' : 'no'}`);
  console.log(`  has CODEX_HOME:         ${env.hasCodexHome ? 'yes' : 'no'}`);
  console.log(`  has XDG_CONFIG_HOME:    ${env.hasXdgConfigHome ? 'yes' : 'no'}`);

  if (issues.length > 0) {
    console.log('');
    console.log('Issues:');
    for (const issue of issues) {
      const sev = String(issue.severity ?? 'warn').toUpperCase();
      console.log(`  [${sev}] ${issue.code ?? 'runtime_issue'}: ${issue.title ?? issue.message ?? ''}`);
      if (issue.message) console.log(`        ${issue.message}`);
      if (issue.hint) console.log(`        Hint: ${issue.hint}`);
    }
  }

  console.log('');
  console.log(`Collected at: ${diag.timestamp ?? '(unknown)'}`);
}

/**
 * Format `myagents agent show <id>` output.
 *
 * Exposes the resolved defaults an AI would need to decide whether a task
 * override is meaningful or a no-op. Keys are printed one-per-line with
 * `(inherits provider / workspace default)` for null/empty values so the
 * reader doesn't have to guess what an absent field means.
 */
function printAgentShow(data: Record<string, unknown>): void {
  if (!data) {
    console.log('No agent data.');
    return;
  }
  console.log(`Agent:       ${String(data.name ?? '')}`);
  console.log(`  agentId:   ${String(data.agentId ?? '')}`);
  console.log(`  projectId: ${String(data.projectId ?? '')}`);
  console.log(`  current:   ${data.isCurrent ? 'yes' : 'no'}`);
  console.log(`  lifecycle: ${data.archived ? 'archived' : 'active'}`);
  console.log(`  proactive: ${data.enabled ? 'enabled' : 'disabled'}`);
  if (data.workspacePath) console.log(`  workspace: ${String(data.workspacePath)}`);
  const channelCount = data.channelCount;
  if (typeof channelCount === 'number') console.log(`  channels:  ${channelCount}`);
  console.log('');
  console.log('Effective defaults:');
  const defaults = (data.effectiveDefaults as Record<string, unknown>) ?? {};
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '(inherits default)';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  console.log(`  runtime:        ${fmt(defaults.runtime)}`);
  if (defaults.runtimeSource) console.log(`  runtimeSource:  ${fmt(defaults.runtimeSource)}`);
  console.log(`  model:          ${fmt(defaults.model)}`);
  console.log(`  permissionMode: ${fmt(defaults.permissionMode)}`);
  console.log(`  providerId:     ${fmt(defaults.providerId)}`);
  if (defaults.runtimeConfig) {
    console.log(`  runtimeConfig:  ${JSON.stringify(defaults.runtimeConfig)}`);
  }
  console.log(`  MCP servers:    ${fmt(defaults.mcpEnabledServers)}`);
  console.log(`  Claude plugins: ${fmt(defaults.enabledPluginIds)}`);
  console.log(`  official tools: ${fmt(defaults.enabledOfficialToolIds)}`);
  console.log('');
  console.log('Describe this runtime:  myagents runtime describe <runtime>');
}

/**
 * Format output for `task run` / `task rerun`.
 *
 * Answers the "what will this actually run on?" question so the AI caller
 * can relay engine/model back to the human in chat. `runtime` and `model`
 * are read from the updated Task record — both can be null/undefined
 * (meaning "use agent default" / "use provider default"); we explicitly
 * label that case rather than hiding it.
 */
function printTaskDispatchResult(
  action: string,
  data: Record<string, unknown>,
): void {
  const task = (data?.task as Record<string, unknown>) ?? data;
  const id = String(task?.id ?? '');
  const runtime = (task?.runtime as string) || 'builtin';
  const model = (task?.model as string) || '(agent default)';

  console.log(`\u2713 Task ${action === 'rerun' ? 'redispatched' : 'dispatched'}`);
  if (id) console.log(`  task_id:  ${id}`);
  console.log(`  runtime:  ${runtime}`);
  console.log(`  model:    ${model}`);
  printTaskNextExecution(task?.nextExecutionAt ?? data?.nextExecutionAt);
}

function printTaskNextExecution(value: unknown): void {
  const timestamp = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isNaN(timestamp)) {
    console.log(`  next:     ${new Date(timestamp).toISOString()}`);
  } else if (value === null) {
    console.log('  next:     none');
  }
}

function printToolList(tools: Array<Record<string, unknown>>): void {
  if (!tools || tools.length === 0) {
    console.log('No CLI tools registered.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('NAME', 22) + pad('KIND', 8) + pad('STATUS', 10) + 'DESCRIPTION');
  for (const t of tools) {
    const status = t.enabled ? 'enabled' : 'disabled';
    const desc = String(t.description ?? '').replace(/\s+/g, ' ');
    const missing = (t.missingEnvKeys as string[] | undefined) ?? [];
    const warn = missing.length > 0 ? `  [missing env: ${missing.join(', ')}]` : '';
    console.log(pad(String(t.name), 22) + pad(String(t.kind ?? ''), 8) + pad(status, 10) + desc.slice(0, 80) + warn);
  }
  const enabled = tools.filter(t => t.enabled).length;
  console.log(`\n${tools.length} CLI tools (${enabled} in AI context)`);
}

function printMcpList(servers: Array<Record<string, unknown>>): void {
  if (!servers || servers.length === 0) {
    console.log('No MCP servers configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Type', 8) + pad('Status', 10) + 'Name');
  for (const s of servers) {
    const status = s.enabled ? 'enabled' : 'disabled';
    const builtin = s.isBuiltin ? ' (built-in)' : '';
    console.log(pad(String(s.id), 24) + pad(String(s.type), 8) + pad(status, 10) + String(s.name) + builtin);
  }
  const enabled = servers.filter(s => s.enabled).length;
  console.log(`\n${servers.length} MCP servers (${enabled} enabled)`);
}

/**
 * Format `myagents mcp show <id>` output.
 *
 * Parallels printAgentShow — prints the user-visible config + enable state
 * (global / per-project) for a single server. Env and headers are rendered
 * as `key = <redacted>` lines when values exist; AI callers can read the
 * structure without ever seeing a secret.
 */
function printMcpShow(data: Record<string, unknown>): void {
  if (!data) {
    console.log('No MCP data.');
    return;
  }
  console.log(`MCP Server:   ${String(data.name ?? '')}`);
  console.log(`  id:         ${String(data.id ?? '')}`);
  console.log(`  type:       ${String(data.type ?? '')}`);
  if (data.description) console.log(`  description:${String(data.description)}`);
  console.log(`  built-in:   ${data.isBuiltin ? 'yes' : 'no'}`);

  const enabled = (data.enabled as { global?: boolean; project?: boolean | null }) ?? {};
  const globalState = enabled.global ? 'enabled' : 'disabled';
  const projectState = enabled.project === null || enabled.project === undefined
    ? '(no active workspace)'
    : enabled.project
      ? 'enabled'
      : 'disabled';
  console.log('');
  console.log('Enable state:');
  console.log(`  global:     ${globalState}`);
  console.log(`  project:    ${projectState}`);
  if (data.workspacePath) console.log(`  workspace:  ${String(data.workspacePath)}`);

  console.log('');
  console.log('Transport:');
  if (data.command) console.log(`  command:    ${String(data.command)}`);
  if (Array.isArray(data.args) && (data.args as unknown[]).length > 0) {
    console.log(`  args:       ${(data.args as unknown[]).map(String).join(' ')}`);
  }
  if (data.url) console.log(`  url:        ${String(data.url)}`);

  const env = data.env as Record<string, string> | undefined;
  if (env && Object.keys(env).length > 0) {
    console.log('');
    console.log('Env (values redacted):');
    for (const [k, v] of Object.entries(env)) {
      console.log(`  ${k} = ${v}`);
    }
  }
  const headers = data.headers as Record<string, string> | undefined;
  if (headers && Object.keys(headers).length > 0) {
    console.log('');
    console.log('Headers (values redacted):');
    for (const [k, v] of Object.entries(headers)) {
      console.log(`  ${k} = ${v}`);
    }
  }

  if (data.requiresConfig) {
    console.log('');
    console.log('Note: this server requires configuration before it can be enabled.');
    if (data.websiteUrl) console.log(`  See: ${String(data.websiteUrl)}`);
  }
}

function printMcpTest(data: Record<string, unknown>, hint?: unknown): void {
  const id = String(data?.id ?? 'unknown');
  console.log(`✓ MCP ${id} validated`);
  if (hint) console.log(`\n${String(hint)}`);
}

export function printModelList(providers: Array<Record<string, unknown>>): void {
  if (!providers || providers.length === 0) {
    console.log('No model providers configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Status', 12) + 'Name');
  for (const p of providers) {
    // Disabled providers retain their verify status but the disabled label
    // overrides — they can't be used until re-enabled in Settings.
    const status = p.enabled === false ? 'disabled' : String(p.status);
    console.log(pad(String(p.id), 24) + pad(status, 12) + String(p.name));
    const models = Array.isArray(p.models)
      ? p.models.flatMap(model => {
        if (!model || typeof model !== 'object') return [];
        const record = model as Record<string, unknown>;
        const id = typeof record.model === 'string' ? record.model : '';
        if (!id) return [];
        const name = typeof record.modelName === 'string' && record.modelName !== id
          ? ` (${record.modelName})`
          : '';
        return [`${id}${name}`];
      })
      : [];
    console.log(`  Primary: ${String(p.primaryModel ?? 'not set')}`);
    console.log(`  Models:  ${models.length > 0 ? models.join(', ') : 'none'}`);
  }
}

function printAgentList(agents: Array<Record<string, unknown>>): void {
  if (!agents || agents.length === 0) {
    console.log('No agents configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('', 3) + pad('Agent ID', 38) + pad('Lifecycle', 11) + pad('Proactive', 11) + pad('Channels', 10) + 'Name');
  for (const a of agents) {
    const current = a.isCurrent ? '* ' : '  ';
    const lifecycle = a.archived ? 'archived' : 'active';
    const proactive = a.enabled ? 'enabled' : 'disabled';
    console.log(
      pad(current, 3)
      + pad(String(a.agentId).slice(0, 36), 38)
      + pad(lifecycle, 11)
      + pad(proactive, 11)
      + pad(String(a.channelCount), 10)
      + String(a.name),
    );
  }
  console.log('\n* current Agent for this CLI caller');
}

function printSessionList(
  sessions: Array<Record<string, unknown>>,
  envelope: Record<string, unknown>,
): void {
  if (!sessions || sessions.length === 0) {
    console.log(`No recent Sessions for Agent ${String(envelope.agentId ?? '')}.`);
    return;
  }
  const pad = (value: string, width: number) => value.padEnd(width);
  console.log(pad('Session ID', 38) + pad('Last active', 26) + pad('Runtime', 14) + 'Title');
  for (const session of sessions) {
    console.log(
      pad(String(session.sessionId ?? '').slice(0, 36), 38)
      + pad(String(session.lastActiveAt ?? ''), 26)
      + pad(String(session.runtime ?? 'builtin'), 14)
      + String(session.title ?? 'New Chat'),
    );
    if (session.lastMessagePreview) {
      console.log(`  ${String(session.lastMessagePreview)}`);
    }
  }
}

function printStatus(data: Record<string, unknown>): void {
  const mcp = data.mcpServers as Record<string, number>;
  console.log(`MCP Servers: ${mcp?.total ?? 0} total, ${mcp?.enabled ?? 0} enabled`);
  console.log(`Active MCP in session: ${data.activeMcpInSession}`);
  console.log(`Default provider: ${data.defaultProvider}`);
  console.log(`Agents: ${data.agents}`);
}

export function resolveLocalTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimezone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function parseInstantMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const raw = value.trim();
    const asNumber = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = new Date(raw).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timezoneOffset(ms: number, timezone: string, prefix: 'utc' | 'plain' = 'utc'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date(ms));
    const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    if (raw === 'GMT' || raw === 'UTC') return prefix === 'utc' ? 'UTC+00:00' : '+00:00';
    const match = raw.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!match) return prefix === 'utc' ? raw.replace(/^GMT/, 'UTC') : raw;
    const [, sign, hour, minute = '00'] = match;
    const normalized = `${sign}${hour.padStart(2, '0')}:${minute}`;
    return prefix === 'utc' ? `UTC${normalized}` : normalized;
  } catch {
    return prefix === 'utc' ? 'UTC?' : '?';
  }
}

function formatDateTimeInTimezone(ms: number, timezone: string, withSeconds = false): string {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function formatCronInstantForDisplay(
  value: unknown,
  timezone = resolveLocalTimezone(),
  style: 'long' | 'table' | 'tableSeconds' = 'long',
): string {
  const ms = parseInstantMs(value);
  if (ms === null) return '—';
  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  const local = formatDateTimeInTimezone(ms, tz, style === 'tableSeconds');
  if (style === 'table' || style === 'tableSeconds') {
    return `${local} ${timezoneOffset(ms, tz, 'plain')}`;
  }
  return `${local} ${tz} (${timezoneOffset(ms, tz, 'utc')})`;
}

function formatCronInstantWithUtc(value: unknown, timezone = resolveLocalTimezone()): string {
  const ms = parseInstantMs(value);
  if (ms === null) return '—';
  return `${formatCronInstantForDisplay(ms, timezone, 'long')} [UTC ${new Date(ms).toISOString()}]`;
}

function cronDisplayTimezone(schedule: unknown): { timezone: string; label: string } {
  if (schedule && typeof schedule === 'object') {
    const s = schedule as Record<string, unknown>;
    if (s.kind === 'cron') {
      const raw = typeof s.tz === 'string' ? s.tz.trim() : '';
      if (!raw) return { timezone: 'UTC', label: 'UTC(default)' };
      if (isValidTimezone(raw)) return { timezone: raw, label: raw };
      return { timezone: 'UTC', label: `${raw}(invalid; UTC shown)` };
    }
  }
  const local = resolveLocalTimezone();
  return { timezone: local, label: local };
}

export function formatCronTaskScheduleForDisplay(
  task: Record<string, unknown>,
  style: 'short' | 'long' = 'short',
): string {
  const schedule = task.schedule as Record<string, unknown> | undefined;
  if (schedule && typeof schedule === 'object') {
    switch (schedule.kind) {
      case 'cron': {
        const expr = String(schedule.expr ?? '').trim() || '<empty cron>';
        const tz = cronDisplayTimezone(schedule);
        return style === 'long' ? `${expr} @ ${tz.label}` : expr;
      }
      case 'every': {
        const minutes = Number(schedule.minutes);
        return Number.isFinite(minutes) ? `every ${minutes}m` : 'every ?m';
      }
      case 'at': {
        if (style === 'long') {
          const tz = cronDisplayTimezone(schedule);
          return `once @ ${formatCronInstantForDisplay(schedule.at, tz.timezone, 'long')}`;
        }
        return 'once';
      }
      case 'loop':
        return 'loop';
      default:
        return String(schedule.kind ?? 'unknown');
    }
  }
  const interval = Number(task.intervalMinutes);
  return Number.isFinite(interval) ? `every ${interval}m` : 'every ?m';
}

function clipCell(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function printCronList(tasks: Array<Record<string, unknown>>): void {
  if (!tasks || tasks.length === 0) {
    console.log('No cron tasks configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);

  // R9: status carries the raw enum name (Running / Stopped) — the
  // scheduler-state vocabulary. The transient "currently executing" state
  // is a separate concept, surfaced via `t.currentlyExecuting` and
  // rendered as a `*` marker after the task ID. See `task readme` for
  // the full vocabulary explanation.

  const fmtDuration = (ms: unknown): string => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  console.log(
    pad('ID', 24) +
    pad('Status', 10) +
    pad('Schedule', 22) +
    pad('TZ', 20) +
    pad('Next', 26) +
    pad('Last', 28) +
    pad('Dur', 9) +
    pad('Runs', 6) +
    'Name'
  );
  for (const t of tasks) {
    const schedule = formatCronTaskScheduleForDisplay(t, 'short');
    const tz = cronDisplayTimezone(t.schedule);
    const lastOk = t.lastRunOk;
    const lastMark = lastOk === true ? '✓ ' : lastOk === false ? '✗ ' : '  ';
    const lastTime = formatCronInstantForDisplay(t.lastExecutedAt, tz.timezone, 'table');
    const last = lastTime === '—' ? '—' : `${lastMark}${lastTime}`;
    // Asterisk marker = a tick is firing this very instant (scheduled or
    // run-now). Distinct from `Running` status — see `task readme`.
    const idDisplay = `${String(t.id).slice(0, 22)}${t.currentlyExecuting ? '*' : ''}`;
    console.log(
      pad(idDisplay, 24) +
      pad(String(t.status), 10) +
      pad(clipCell(schedule, 20), 22) +
      pad(clipCell(tz.label, 18), 20) +
      pad(formatCronInstantForDisplay(t.nextExecutionAt, tz.timezone, 'table'), 26) +
      pad(clipCell(last, 26), 28) +
      pad(fmtDuration(t.lastRunDurationMs), 9) +
      pad(String(t.executionCount ?? 0), 6) +
      String(t.name ?? (t.prompt as string)?.slice(0, 40) ?? '')
    );
  }
  const running = tasks.filter(t => t.status === 'Running').length;
  const executing = tasks.filter(t => t.currentlyExecuting === true).length;
  const execNote = executing > 0 ? `, ${executing} executing now` : '';
  console.log(`\n${tasks.length} cron tasks (${running} running${execNote})`);
}

function printCronRuns(runs: Array<Record<string, unknown>>, full: boolean = false): void {
  if (!runs || runs.length === 0) {
    console.log('No execution records.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);

  // PRD 0.2.5 R7 \u2014 collapse all whitespace runs (newlines included) so a
  // multi-line content cell doesn't break column alignment of the next row.
  // `full` mode keeps original content but renders one line per row anyway \u2014
  // user opts into that explicitly.
  const formatCell = (s: string, maxLen: number): string => {
    const collapsed = s.replace(/\s+/g, ' ').trim();
    if (full || collapsed.length <= maxLen) return collapsed;
    return collapsed.slice(0, maxLen - 1) + '\u2026';
  };

  const outputMaxLen = full ? Number.POSITIVE_INFINITY : 80;
  const localTz = resolveLocalTimezone();
  console.log(`Times shown in ${localTz} (${timezoneOffset(Date.now(), localTz, 'utc')}). Raw timestamps are available with --json.`);
  console.log(pad('Time', 31) + pad('Status', 8) + pad('Duration', 12) + 'Output');
  for (const r of runs) {
    const time = formatCronInstantForDisplay(r.ts, localTz, 'tableSeconds');
    const status = r.ok ? '\u2713' : '\u2717';
    const dur = r.durationMs ? `${(Number(r.durationMs) / 1000).toFixed(1)}s` : '?';
    const raw = r.ok ? String(r.content ?? '') : String(r.error ?? '');
    const output = formatCell(raw, outputMaxLen);
    console.log(pad(time, 31) + pad(status, 8) + pad(dur, 12) + output);
  }
}

function printCronStatus(data: Record<string, unknown>): void {
  const localTz = resolveLocalTimezone();
  console.log(`Total tasks: ${data.totalTasks ?? 0}`);
  console.log(`Running:     ${data.runningTasks ?? 0}`);
  if (data.lastExecutedAt) {
    console.log(`Last executed: ${formatCronInstantWithUtc(data.lastExecutedAt, localTz)}`);
  }
  if (data.nextExecutionAt) {
    console.log(`Next execution: ${formatCronInstantWithUtc(data.nextExecutionAt, localTz)}`);
  }
  if (data.lastExecutedAt || data.nextExecutionAt) {
    console.log(`Display timezone: ${localTz} (${timezoneOffset(Date.now(), localTz, 'utc')}); per-task cron tz is shown by 'myagents cron list'.`);
  }
}

export function printGoalResult(action: string, data?: Record<string, unknown>): void {
  const goal = (data?.goal as Record<string, unknown> | null | undefined) ?? null;
  if (!goal) {
    console.log('No active Goal in the current session.');
    return;
  }
  const prefix = action === 'create'
    ? '✓ Goal created'
    : action === 'update'
      ? '✓ Goal updated'
      : 'Goal';
  console.log(prefix);
  console.log(`  id:            ${goal.id ?? '(unknown)'}`);
  console.log(`  status:        ${goal.status ?? '(unknown)'}`);
  console.log(`  settled turns: ${goal.turnCount ?? 0}`);
  if (typeof goal.executionNumber === 'number') {
    console.log(`  current turn:  ${goal.executionNumber}${goal.isExecuting === true ? ' (executing)' : ''}`);
  }
  if (goal.updatedAt) console.log(`  updated: ${goal.updatedAt}`);
  if (goal.terminalReason) console.log(`  reason:  ${goal.terminalReason}`);
  const endConditions = goal.endConditions as Record<string, unknown> | undefined;
  if (endConditions && (
    endConditions.deadline !== undefined
    || endConditions.maxExecutions !== undefined
    || typeof endConditions.aiCanExit === 'boolean'
  )) {
    console.log('  end conditions:');
    if (endConditions.deadline !== undefined) {
      console.log(`    deadline:       ${formatCronInstantWithUtc(endConditions.deadline, resolveLocalTimezone())}`);
    }
    if (endConditions.maxExecutions !== undefined) {
      console.log(`    max executions: ${endConditions.maxExecutions}`);
    }
    if (typeof endConditions.aiCanExit === 'boolean') {
      console.log(`    AI can exit:    ${endConditions.aiCanExit ? 'yes' : 'no'}`);
    }
  }
  if (goal.objective) {
    const objective = String(goal.objective).replace(/\s+/g, ' ').trim();
    console.log(`  objective: ${objective.length > 180 ? `${objective.slice(0, 179)}…` : objective}`);
  }
}

function printChannelList(channels: Array<Record<string, unknown>>): void {
  if (!channels || channels.length === 0) {
    console.log('No channels configured for this agent.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 38) + pad('Type', 26) + pad('Enabled', 10) + 'Name');
  for (const ch of channels) {
    const id = String(ch.id ?? '?').slice(0, 36);
    const type = String(ch.type ?? '?').slice(0, 24);
    const enabled = ch.enabled === false ? 'off' : 'on';
    const name = String(ch.name ?? '');
    console.log(pad(id, 38) + pad(type, 26) + pad(enabled, 10) + name);
  }
  console.log(`\n${channels.length} channel(s)`);
}

function printCcPluginList(plugins: Array<Record<string, unknown>>): void {
  if (!plugins || plugins.length === 0) {
    console.log('No Claude plugins installed.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('STATUS', 10) + pad('NAME', 24) + pad('VERSION', 12) + pad('SOURCE', 24) + 'DESCRIPTION');
  for (const p of plugins) {
    const enabled = p.enabled === true;
    const status = p.status as string;
    const statusLabel = status === 'ok'
      ? (enabled ? '✓ enabled' : '· disabled')
      : `! ${status}`;
    const name = String(p.name ?? '?').slice(0, 22);
    const version = String(p.version ?? '?').slice(0, 10);
    const source = String(p.sourceUrl ?? '').slice(0, 22);
    const desc = String(p.description ?? '');
    console.log(pad(statusLabel, 10) + pad(name, 24) + pad(version, 12) + pad(source, 24) + desc);
  }
  console.log(`\n${plugins.length} plugin(s) installed`);
}

function printPluginList(plugins: Array<Record<string, unknown>>): void {
  if (!plugins || plugins.length === 0) {
    console.log('No plugins installed.');
    return;
  }
  // Issue #149: Rust returns plugin objects with `pluginId / npmSpec /
  // packageVersion / manifest` fields, NOT `id / name / version /
  // description`. The previous formatter read the wrong fields and printed
  // `?` for every cell. The display name comes from the manifest's `name`
  // (a friendly label like "Feishu" or "WeChat"); the `pluginId` is a
  // slug-style internal id. Description lives at `manifest.description`.
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 28) + pad('Version', 14) + pad('Name', 22) + 'Description');
  for (const p of plugins) {
    const manifest = (p.manifest as Record<string, unknown> | undefined) ?? {};
    const id = String(p.pluginId ?? p.npmSpec ?? '?').slice(0, 26);
    const version = String(p.packageVersion ?? '?');
    const name = String(manifest.name ?? p.npmSpec ?? '').slice(0, 20);
    const desc = String(manifest.description ?? '');
    console.log(pad(id, 28) + pad(version, 14) + pad(name, 22) + desc);
  }
  console.log(`\n${plugins.length} plugin(s) installed`);
}

function printSkillList(skills: Array<Record<string, unknown>>): void {
  if (!skills || skills.length === 0) {
    console.log('No skills installed.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('Folder', 28) + pad('Scope', 10) + pad('Enabled', 10) + 'Description');
  for (const s of skills) {
    const enabled = s.enabled === false ? 'off' : 'on';
    const desc = String(s.description ?? '').slice(0, 60);
    console.log(
      pad(String(s.folderName ?? s.name ?? '?').slice(0, 26), 28) +
      pad(String(s.scope ?? 'user'), 10) +
      pad(enabled, 10) +
      desc,
    );
  }
  console.log(`\n${skills.length} skill(s)`);
}

function printSkillInfo(data: Record<string, unknown>): void {
  if (!data) {
    console.log('Skill not found.');
    return;
  }
  const fm = (data.frontmatter as Record<string, unknown>) || {};
  console.log(`Name:        ${fm.name ?? data.name ?? '?'}`);
  console.log(`Folder:      ${data.folderName ?? '?'}`);
  console.log(`Scope:       ${data.scope ?? 'user'}`);
  console.log(`Description: ${fm.description ?? ''}`);
  if (fm.author) console.log(`Author:      ${fm.author}`);
  if (fm['allowed-tools']) console.log(`Allowed:     ${JSON.stringify(fm['allowed-tools'])}`);
  console.log(`Path:        ${data.path ?? ''}`);
}

function printSkillAdd(result: Record<string, unknown>): void {
  const installed = result.installed as Array<Record<string, unknown>> | undefined;
  if (installed && installed.length > 0) {
    console.log(`\u2713 Installed ${installed.length} skill(s):`);
    for (const s of installed) {
      console.log(`  - ${s.folderName} — ${s.description ?? ''}`);
    }
    if (result.sourceUrl) console.log(`\nSource: ${result.sourceUrl}`);
    return;
  }
  // Fall-through: preview / dry-run / error path already handled by generic branch
  console.log(`\u2713 ${result.hint ?? 'done'}`);
}

function printTaskList(tasks: Array<Record<string, unknown>>): void {
  if (!tasks || tasks.length === 0) {
    console.log('(no tasks)');
    return;
  }
  console.log(`Tasks (${tasks.length}):`);
  for (const t of tasks) {
    const status = String(t.status ?? '?');
    const mode = String(t.executionMode ?? 'once');
    const origin = String(t.dispatchOrigin ?? 'direct');
    console.log(`  ${t.id}  [${status}]  ${t.name}`);
    console.log(
      `     mode=${mode}  origin=${origin}  workspace=${t.workspaceId}  sessions=${String(t.sessionCount ?? 0)}`,
    );
  }
}

function printAgentCurrent(current: Record<string, unknown>): void {
  console.log(`Current Agent: ${String(current.name ?? current.agentId ?? '(unknown)')}`);
  console.log(`  Agent ID:     ${String(current.agentId ?? '(unknown)')}`);
  console.log(`  Workspace ID: ${String(current.workspaceId ?? '(unknown)')}`);
  console.log(`  Workspace:    ${String(current.workspacePath ?? '(unknown)')}`);
  if (current.sessionId) console.log(`  Session:      ${String(current.sessionId)}`);
}

function printTaskDetail(task: Record<string, unknown>): void {
  if (!task) {
    console.log('(task not found)');
    return;
  }

  // Identity + top-line state
  console.log(`Task: ${task.name ?? '(unnamed)'}`);
  console.log(`  ID:             ${task.id}`);
  const statusLine = String(task.status ?? '?');
  const updatedAt = typeof task.updatedAt === 'number' ? new Date(task.updatedAt).toISOString() : undefined;
  console.log(`  Status:         ${statusLine}${updatedAt ? ` (updated ${updatedAt})` : ''}`);
  console.log(`  Executor:       ${task.executor ?? '?'}`);
  console.log(`  Execution mode: ${task.executionMode ?? '?'}`);
  console.log(`  Dispatch:       ${task.dispatchOrigin ?? '?'}`);
  if (task.workspacePath || task.workspaceId) {
    console.log(`  Workspace:      ${task.workspacePath ?? task.workspaceId}`);
  }
  if (task.description) console.log(`  Description:    ${task.description}`);
  if (task.runMode) console.log(`  Run mode:       ${task.runMode}`);
  if (task.runtime) console.log(`  Runtime:        ${task.runtime}`);
  if (task.model) console.log(`  Model override: ${task.model}`);
  if (task.permissionMode) console.log(`  Permission:     ${task.permissionMode}`);
  if (Array.isArray(task.tags) && (task.tags as string[]).length > 0) {
    console.log(`  Tags:           ${(task.tags as string[]).join(', ')}`);
  }

  // task.md is the only editable Task contract. Older companion files remain
  // visible as read-only migration evidence, never as parallel instructions.
  const docs = task.docs as Record<string, string | undefined> | undefined;
  if (docs) {
    console.log('\nTask document (read/edit/write this file):');
    if (docs.dir) console.log(`  Dir:            ${docs.dir}`);
    if (docs.taskMd) console.log(`  task.md:        ${docs.taskMd}`);
    const legacyDocs = [
      ['verify.md', docs.verifyMd],
      ['progress.md', docs.progressMd],
      ['alignment.md', docs.alignmentMd],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]));
    if (legacyDocs.length > 0) {
      console.log('  Legacy read-only files (not execution inputs):');
      for (const [name, path] of legacyDocs) console.log(`    ${name}: ${path}`);
    }
  }

  // Schedule — only for scheduled / recurring / loop tasks
  const mode = String(task.executionMode ?? 'once');
  if (mode !== 'once') {
    console.log('\nSchedule:');
    if (task.cronExpression) {
      const cronTz = typeof task.cronTimezone === 'string' && task.cronTimezone.trim()
        ? task.cronTimezone.trim()
        : 'UTC(default legacy)';
      console.log(
        `  Cron:           ${task.cronExpression} @ ${cronTz}`,
      );
    } else if (task.intervalMinutes) {
      console.log(`  Interval:       every ${task.intervalMinutes} minute(s)`);
      if (task.startAt) {
        console.log(`  First tick:     ${formatCronInstantWithUtc(task.startAt, resolveLocalTimezone())}`);
      }
    } else if (task.dispatchAt) {
      console.log(`  Dispatch at:    ${formatCronInstantWithUtc(task.dispatchAt, resolveLocalTimezone())}`);
    }
    if (task.lastExecutedAt) {
      console.log(`  Last executed:  ${formatCronInstantWithUtc(task.lastExecutedAt, resolveLocalTimezone())}`);
    }
    printTaskNextExecution(task.nextExecutionAt);
  }

  // End conditions — when present, they're decision-relevant
  const end = task.endConditions as Record<string, unknown> | undefined;
  if (end && (end.deadline || end.maxExecutions || end.aiCanExit === false)) {
    console.log('\nEnd conditions:');
    if (end.deadline) {
      console.log(`  Deadline:       ${formatCronInstantWithUtc(end.deadline, resolveLocalTimezone())}`);
    }
    if (end.maxExecutions) console.log(`  Max executions: ${end.maxExecutions}`);
    if (end.aiCanExit === false) console.log(`  AI can exit:    no (must run to end conditions)`);
  }

  // Notification — for unattended modes (recurring / scheduled / loop), the
  // absence of a bot channel is decision-relevant: the task runs to disk but
  // nothing reaches the user's IM. Surface this even when `notification` is
  // None so CLI users don't have to grep `management_api.rs` to learn the
  // mechanism exists (issue #205 gap #6).
  const notif = task.notification as Record<string, unknown> | undefined;
  const unattended = mode === 'recurring' || mode === 'scheduled' || mode === 'loop';
  if (notif) {
    console.log('\nNotification:');
    console.log(`  Desktop:        ${notif.desktop !== false ? 'on' : 'off'}`);
    if (notif.botChannelId) {
      console.log(`  Bot channel:    ${notif.botChannelId}`);
    } else if (unattended) {
      console.log('  Bot channel:    (not set — IM push disabled; set --notificationBotChannelId via `task update`)');
    }
    if (Array.isArray(notif.events) && (notif.events as string[]).length > 0) {
      console.log(`  Events:         ${(notif.events as string[]).join(', ')}`);
    }
  } else if (unattended) {
    console.log('\nNotification:');
    console.log('  Desktop:        on (default)');
    console.log('  Bot channel:    (not set — IM push disabled; set --notificationBotChannelId via `task update`)');
  }

  // Sessions + source Record
  const sessionIds = Array.isArray(task.sessionIds) ? (task.sessionIds as string[]) : [];
  if (sessionIds.length > 0) {
    console.log(`\nSessions:         ${sessionIds.join(', ')} (${sessionIds.length} total)`);
  }

  // Recent status changes — last 5, with counter
  const hist = task.statusHistory as Array<Record<string, unknown>> | undefined;
  if (hist && hist.length > 0) {
    const last5 = hist.slice(-5);
    console.log(`\nRecent changes (${last5.length} of ${hist.length}):`);
    for (const h of last5) {
      const at = typeof h.at === 'number' ? new Date(h.at).toISOString() : String(h.at ?? '');
      const actor = String(h.actor ?? '?');
      const source = h.source ? `/${h.source}` : '';
      const from = h.from ?? '—';
      const msg = h.message ? `   "${h.message}"` : '';
      console.log(`  ${at}  ${actor}${source}  ${from} → ${h.to}${msg}`);
    }
  }

  // Footer — next-step hints so the AI / user doesn't have to guess
  console.log('\nNext steps:');
  console.log('  myagents task update-status <id> <status> [--message ...]  # transition state machine');
  console.log('  myagents task run <id>                                     # dispatch immediately');
  console.log('  myagents task rerun <id>                                   # re-arm stopped/blocked task');
  console.log('  myagents task --help                                       # full Task CLI reference');
}

function printThoughtList(thoughts: Array<Record<string, unknown>>): void {
  if (!thoughts || thoughts.length === 0) {
    console.log('(no thoughts)');
    return;
  }
  console.log(`Thoughts (${thoughts.length}):`);
  for (const t of thoughts) {
    const content = String(t.content ?? '');
    const preview = content.length > 80 ? content.slice(0, 77) + '...' : content;
    const tags = Array.isArray(t.tags) ? (t.tags as string[]) : [];
    const convCount = Array.isArray(t.convertedTaskIds)
      ? (t.convertedTaskIds as string[]).length
      : 0;
    console.log(`  ${t.id}  ${preview}`);
    if (tags.length || convCount) {
      const bits: string[] = [];
      if (tags.length) bits.push(`tags=${tags.join(',')}`);
      if (convCount) bits.push(`tasks=${convCount}`);
      console.log(`     ${bits.join('  ')}`);
    }
  }
}

function printRecordList(records: Array<Record<string, unknown>>): void {
  if (!records || records.length === 0) {
    console.log('(no records)');
    return;
  }
  console.log(`Records (${records.length}):`);
  for (const record of records) {
    const title = String(record.title ?? '') || '(untitled record)';
    const kind = String(record.kind ?? 'text');
    const tags = Array.isArray(record.tags) ? (record.tags as string[]) : [];
    console.log(`  ${record.id}  [${kind}] ${title}`);
    if (tags.length > 0) console.log(`     tags=${tags.join(',')}`);
  }
}

function printMcpOAuth(data: Record<string, unknown>): void {
  if (!data) return;
  const id = data.id ?? '';

  // discover result
  if (data.required !== undefined) {
    console.log(`MCP: ${id}`);
    console.log(`OAuth required: ${data.required ? 'yes' : 'no'}`);
    if (data.supportsDynamicRegistration) console.log('Dynamic registration: supported (zero-config)');
    if (data.scopes) console.log(`Scopes: ${(data.scopes as string[]).join(', ')}`);
    return;
  }

  // status result
  if (data.status !== undefined) {
    const symbol = data.status === 'connected' ? '\u2713' : data.status === 'expired' ? '\u26A0' : '\u2717';
    console.log(`${symbol} ${id}: ${data.status}`);
    if (data.expiresAt) console.log(`  Expires: ${new Date(Number(data.expiresAt)).toLocaleString()}`);
    if (data.scope) console.log(`  Scope: ${data.scope}`);
    return;
  }

  // start result (authUrl present)
  if (data.authUrl) {
    console.log(`OAuth authorization URL:\n  ${data.authUrl}`);
    return;
  }

  // Generic fallback (revoke, etc.)
  console.log(`\u2713 ${id}: done`);
}

function printAgentRuntimeStatus(data: Record<string, unknown>): void {
  const entries = Object.values(data);
  if (entries.length === 0) {
    console.log('No agents running.');
    return;
  }
  for (const a of entries as Array<Record<string, unknown>>) {
    const enabled = a.enabled ? 'enabled' : 'disabled';
    console.log(`Agent: ${a.agentName} (${a.agentId}) [${enabled}]`);
    const channels = (a.channels as Array<Record<string, unknown>>) ?? [];
    if (channels.length === 0) {
      console.log('  No channels');
    } else {
      const pad = (s: string, n: number) => s.padEnd(n);
      for (const ch of channels) {
        const uptime = ch.uptimeSeconds ? `uptime: ${Math.round(Number(ch.uptimeSeconds) / 60)}m` : '';
        const err = ch.errorMessage ? `error: ${ch.errorMessage}` : '';
        console.log(`  ${pad(String(ch.channelId).slice(0, 16), 18)} ${pad(String(ch.channelType), 12)} ${pad(String(ch.status), 12)} ${uptime || err}`);
      }
    }
    console.log('');
  }
}

/// Issue #115 — format a millisecond-precision delta into a coarse
/// "in X" string for `cron update` next-fire echoes. Reads naturally for
/// the cases users care about: a few seconds, a few minutes, an hour-ish,
/// a day-ish. Beyond a day we fall back to days+hours.
function formatRelativeMs(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

function formatObject(obj: Record<string, unknown> | undefined, indent = '  '): string {
  if (!obj) return `${indent}(empty)`;
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${indent}${k}: ${v.join(' ')}`;
      if (typeof v === 'object') return `${indent}${k}: ${JSON.stringify(v)}`;
      return `${indent}${k}: ${v}`;
    })
    .join('\n');
}

function printAnydocResult(action: string, result: Record<string, unknown>): void {
  const data = (result.data as Record<string, unknown> | undefined) ?? {};
  const job = data.job as Record<string, unknown> | undefined;
  if (!result.success) {
    const code = typeof result.code === 'string' ? ` [${result.code}]` : '';
    console.error(`Error${code}: ${String(result.error ?? 'Document conversion failed.')}`);
    if (job) {
      console.error(`Job: ${String(job.jobId ?? '(unknown)')}`);
      console.error(`Status: ${String(job.state ?? '(unknown)')}`);
    }
    if (typeof result.suggestion === 'string' && result.suggestion.trim()) {
      console.error(`Suggestion: ${result.suggestion}`);
    }
    printAnydocRecovery(result.recoveryHint);
    return;
  }
  if (action === 'list') {
    const jobs = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
    if (jobs.length === 0) {
      console.log('No recent AnyDoc jobs.');
      return;
    }
    for (const item of jobs) {
      const output = (item.output as Record<string, unknown> | undefined) ?? {};
      const state = String(item.state ?? '(unknown)');
      const artifactAvailable = output.artifactAvailable === true;
      const artifact = artifactAvailable && output.documentPath
        ? String(output.documentPath)
        : ANYDOC_TERMINAL_STATES.has(state) ? '(no artifact)' : '(pending)';
      console.log(`${String(item.jobId)}  ${state}  ${artifact}`);
    }
    return;
  }
  if (!job) {
    console.log(formatObject(data));
    return;
  }
  const output = (job.output as Record<string, unknown> | undefined) ?? {};
  const jobId = String(job.jobId ?? '(unknown)');
  const state = String(job.state ?? '(unknown)');
  if (action === 'convert' && (state === 'queued' || state === 'running')) {
    console.log(`AnyDoc job accepted: ${jobId}`);
    console.log(`Status: ${state}`);
    console.log(`Output when ready: ${String(output.documentPath ?? '(unknown)')}`);
    console.log(`→ Run: myagents anydoc status ${jobId}`);
    console.log(`→ Run: myagents anydoc cancel ${jobId}`);
    return;
  }
  console.log(`AnyDoc job: ${jobId}`);
  console.log(`Status: ${state}`);
  const isTerminal = ANYDOC_TERMINAL_STATES.has(state);
  if (!isTerminal) console.log(`Stage: ${String(job.stage ?? '(unknown)')}`);
  if (output.artifactAvailable === true && output.documentPath) {
    console.log(`Document: ${String(output.documentPath)}`);
  } else if (isTerminal) {
    console.log('Document: unavailable');
  }
  const warnings = Array.isArray(job.warnings) ? job.warnings as Array<Record<string, unknown>> : [];
  for (const warning of warnings) {
    console.error(`Warning [${String(warning.code ?? 'DOCUMENT_WARNING')}]: ${String(warning.message ?? '')}`);
  }
  const terminalError = job.error as Record<string, unknown> | undefined;
  if (terminalError) {
    console.error(`Error [${String(terminalError.code ?? 'DOCUMENT_FAILED')}]: ${String(terminalError.message ?? '')}`);
    printAnydocRecovery(terminalError.recoveryHint);
  }
}

function printAnydocRecovery(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const hint = value as { recoveryCommand?: unknown; message?: unknown };
  if (typeof hint.recoveryCommand === 'string' && hint.recoveryCommand) {
    const message = typeof hint.message === 'string' && hint.message ? `   ${hint.message}` : '';
    console.error(`→ Run: ${hint.recoveryCommand}${message}`);
  } else if (typeof hint.message === 'string' && hint.message) {
    console.error(hint.message);
  }
}

const ANYDOC_TERMINAL_STATES = new Set([
  'succeeded',
  'succeeded_with_warnings',
  'failed',
  'cancelled',
  'interrupted',
]);

async function waitForAnydocJob(
  jobId: string,
  initial: Record<string, unknown>,
  jsonMode: boolean,
): Promise<Record<string, unknown>> {
  let result = initial;
  let delayMs = 250;
  let lastStage = '';
  const onInterrupt = () => {
    console.error(`AnyDoc wait interrupted; job ${jobId} is still app-owned and was not cancelled.`);
    console.error(`→ Run: myagents anydoc status ${jobId}`);
    console.error(`→ Run: myagents anydoc cancel ${jobId}`);
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  try {
    while (result.success) {
      const data = (result.data as Record<string, unknown> | undefined) ?? {};
      const job = data.job as Record<string, unknown> | undefined;
      if (!job || job.jobId !== jobId) {
        return {
          success: false,
          code: 'DOCUMENT_PROTOCOL_ERROR',
          error: 'The status response did not contain the expected document job.',
          suggestion: `Retry with myagents anydoc status ${jobId}.`,
        };
      }
      const state = String(job.state ?? '');
      if (ANYDOC_TERMINAL_STATES.has(state)) {
        if (state === 'failed' || state === 'cancelled' || state === 'interrupted') {
          const terminalError = (job.error as Record<string, unknown> | undefined) ?? {};
          return {
            ...result,
            success: false,
            code: terminalError.code ?? 'DOCUMENT_FAILED',
            error: terminalError.message ?? `Document job ended as ${state}.`,
            recoveryHint: terminalError.recoveryHint,
          };
        }
        return result;
      }
      const stage = String(job.stage ?? state);
      if (!jsonMode && stage !== lastStage) {
        console.error(`AnyDoc ${jobId}: ${stage}`);
        lastStage = stage;
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
      delayMs = Math.min(delayMs * 2, 2_000);
      result = await callApi('anydoc/status', { jobId });
    }
    return result;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

const SPEECH_TERMINAL_STATES = new Set([
  'succeeded',
  'succeeded_with_warnings',
  'failed',
  'cancelled',
  'interrupted',
]);

function printSpeechResult(action: string, result: Record<string, unknown>): void {
  const data = (result.data as Record<string, unknown> | undefined) ?? {};
  const job = data.job as Record<string, unknown> | undefined;
  if (!result.success) {
    const code = typeof result.code === 'string' ? ` [${result.code}]` : '';
    console.error(`Error${code}: ${String(result.error ?? 'Speech transcription failed.')}`);
    if (typeof result.suggestion === 'string' && result.suggestion.trim()) {
      console.error(`Suggestion: ${result.suggestion}`);
    }
    printAnydocRecovery(result.recoveryHint);
    return;
  }
  if (action === 'list') {
    const jobs = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
    if (jobs.length === 0) {
      console.log('No speech jobs from this Session.');
      return;
    }
    for (const item of jobs) {
      const output = (item.output as Record<string, unknown> | undefined) ?? {};
      const state = String(item.state ?? '(unknown)');
      const artifact = output.artifactAvailable === true && output.transcriptMarkdownPath
        ? String(output.transcriptMarkdownPath)
        : SPEECH_TERMINAL_STATES.has(state) ? '(no artifact)' : '(pending)';
      console.log(`${String(item.jobId)}  ${state}  ${artifact}`);
    }
    return;
  }
  if (!job) {
    console.log(formatObject(data));
    return;
  }
  const output = (job.output as Record<string, unknown> | undefined) ?? {};
  const jobId = String(job.jobId ?? '(unknown)');
  const state = String(job.state ?? '(unknown)');
  if (action === 'transcribe' && (state === 'queued' || state === 'running')) {
    console.log(`Speech job accepted: ${jobId}`);
    console.log(`Status: ${state}`);
    console.log(`Output when ready: ${String(output.transcriptMarkdownPath ?? '(unknown)')}`);
    console.log(`→ Run: myagents speech status ${jobId}`);
    console.log(`→ Run: myagents speech cancel ${jobId}`);
    return;
  }
  console.log(`Speech job: ${jobId}`);
  console.log(`Status: ${state}`);
  if (!SPEECH_TERMINAL_STATES.has(state)) {
    console.log(`Stage: ${String(job.stage ?? '(unknown)')}`);
  }
  if (output.artifactAvailable === true && output.transcriptMarkdownPath) {
    console.log(`Transcript: ${String(output.transcriptMarkdownPath)}`);
  } else if (SPEECH_TERMINAL_STATES.has(state)) {
    console.log('Transcript: unavailable');
  }
  const terminalError = job.error as Record<string, unknown> | undefined;
  if (terminalError) {
    console.error(`Error [${String(terminalError.code ?? 'SPEECH_FAILED')}].`);
  }
}

async function waitForSpeechJob(
  jobId: string,
  initial: Record<string, unknown>,
  jsonMode: boolean,
): Promise<Record<string, unknown>> {
  let result = initial;
  let delayMs = 250;
  let lastStage = '';
  const onInterrupt = () => {
    console.error(`Speech wait interrupted; job ${jobId} is still app-owned and was not cancelled.`);
    console.error(`→ Run: myagents speech status ${jobId}`);
    console.error(`→ Run: myagents speech cancel ${jobId}`);
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  try {
    while (result.success) {
      const data = (result.data as Record<string, unknown> | undefined) ?? {};
      const job = data.job as Record<string, unknown> | undefined;
      if (!job || job.jobId !== jobId) {
        return {
          success: false,
          code: 'SPEECH_PROTOCOL_ERROR',
          error: 'The status response did not contain the expected speech job.',
          suggestion: `Retry with myagents speech status ${jobId}.`,
        };
      }
      const state = String(job.state ?? '');
      if (SPEECH_TERMINAL_STATES.has(state)) {
        if (state === 'failed' || state === 'cancelled' || state === 'interrupted') {
          const terminalError = (job.error as Record<string, unknown> | undefined) ?? {};
          return {
            ...result,
            success: false,
            code: terminalError.code ?? 'SPEECH_FAILED',
            error: `Speech job ended as ${state}.`,
          };
        }
        return result;
      }
      const stage = String(job.stage ?? state);
      if (!jsonMode && stage !== lastStage) {
        console.error(`Speech ${jobId}: ${stage}`);
        lastStage = stage;
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
      delayMs = Math.min(delayMs * 2, 2_000);
      result = await callApi('speech/status', { jobId });
    }
    return result;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(rawArgs);
  const jsonMode = !!flags.json;

  // Top-level help (no args, or bare --help)
  if (positional.length === 0) {
    console.log(TOP_HELP);
    return;
  }

  if (!flags.help) rejectUnsupportedSpaceDryRun(positional, flags);

  const commandError = validateCliCommand(positional, !!flags.help);
  if (commandError) return exitAgentCliError(flags, commandError);

  // Resolve port: --port flag overrides env
  PORT = resolveCliPort(flags.port, PORT);
  if (!PORT) {
    if (groupIsSpaceCommand(positional[0]) && jsonMode) {
      return exitAgentCliError(flags, {
        code: 'MYAGENTS_PORT_REQUIRED',
        error: 'The MyAgents local API port is unavailable.',
        suggestion: 'Run this command from an active MyAgents Session or start the app and retry.',
      }, 3);
    }
    console.error('Error: MYAGENTS_PORT not set. This CLI runs within the MyAgents app.');
    process.exit(3);
  }
  BASE = `http://127.0.0.1:${PORT}/api/admin`;

  // Help flag for sub-commands
  if (flags.help) {
    const result = await callApi('help', { path: positional });
    printResult('help', 'help', result, jsonMode);
    return;
  }

  const group = positional[0];
  const action = positional[1] || 'list';

  // Simple commands (no subcommand)
  let result: Record<string, unknown>;
  if (group === 'status') {
    result = await callApi('status');
    printResult('status', 'status', result, jsonMode);
  } else if (group === 'reload') {
    result = await callApi('reload', { workspacePath: flags.workspacePath });
    printResult('reload', 'reload', result, jsonMode);
  } else if (group === 'version') {
    result = await callApi('version');
    printResult('version', 'version', result, jsonMode);
  } else {
    // Build request body based on group/action
    const restArgs = positional.slice(2);
    const body = buildRequestBody(group, action, restArgs, flags);
    const route = buildRoute(group, action, restArgs);

    if (
      group === 'space' &&
      action === 'issue' &&
      restArgs[0] === 'claim' &&
      shouldCreateAttachedTaskForClaim(flags)
    ) {
      result = await claimSpaceIssueWithAttachedTask(body, flags);
    } else if (
      group === 'space' &&
      action === 'issue' &&
      restArgs[0] === 'complete' &&
      shouldFinalizeSpaceIssue(flags)
    ) {
      result = await completeSpaceIssueWithLocalFollowup(body, flags);
    } else {
      result = await callApi(route, body);
    }

    if (group === 'anydoc' && result.success) {
      const job = ((result.data as Record<string, unknown> | undefined)?.job ?? undefined) as Record<string, unknown> | undefined;
      const shouldWait = action === 'wait' || (action === 'convert' && flags.wait === true);
      if (shouldWait && job && typeof job.jobId === 'string') {
        result = await waitForAnydocJob(job.jobId, result, jsonMode);
      }
    }
    if (group === 'speech' && result.success) {
      const job = ((result.data as Record<string, unknown> | undefined)?.job ?? undefined) as Record<string, unknown> | undefined;
      const shouldWait = action === 'wait' || (action === 'transcribe' && flags.wait === true);
      if (shouldWait && job && typeof job.jobId === 'string') {
        result = await waitForSpeechJob(job.jobId, result, jsonMode);
      }
    }

    printResult(group, action, result, jsonMode, flags, restArgs);
  }

  // PRD 0.2.18 session send — granular exit codes per --help contract:
  //   0 = delivered, 1 = sessionId not found, 2 = delivery failed/rejected,
  //   3 = arg error (already handled in buildRequestBody).
  // Cross-review CC flagged the generic exit(1) override loses CLI exit contract.
  if (result && !result.success && group === 'session' && (action === 'start' || action === 'send' || action === 'watch')) {
    const errorBody = result.error ?? result;
    const code = typeof errorBody === 'object' && errorBody && 'code' in errorBody
      ? (errorBody as { code?: string }).code
      : (result as { code?: string }).code;
    if (code === 'session_not_found' || code === 'agent_not_found' || code === 'agent_archived') process.exit(1);
    if (
      code === 'rejected'
      || code === 'delivery_failed'
      || code === 'admission_unconfirmed'
      || code === 'caller_session_required'
      || code === 'watch_failed'
    ) process.exit(2);
    process.exit(1); // fallback
  }

  // Exit with proper code: 0 = success, 1 = business error
  if (result) {
    const exitCode = commandResultExitCode(result);
    if (exitCode !== 0) process.exit(exitCode);
  }
}

function groupIsSpaceCommand(group: string | undefined): boolean {
  return group === 'space' || group === 'issue';
}

export function rejectUnsupportedSpaceDryRun(
  positional: string[],
  flags: Record<string, unknown>,
): void {
  if (flags.dryRun !== true || positional[0] !== 'space') return;
  const area = positional[1] ?? '';
  const action = positional[2] ?? '';
  const nested = positional[3] ?? '';
  const issueMutation = area === 'issue' && (
    ['create', 'update', 'comment', 'status', 'claim', 'close', 'complete', 'cancel-claim'].includes(action)
    || (action === 'attachment' && nested === 'add')
  ) && !(action === 'comment' && nested === 'get');
  const otherWrite = (area === 'claim' && action === 'local-task')
    || (area === 'attachment' && ['add', 'download'].includes(action));
  if (!issueMutation && !otherWrite) return;
  const commandLength = area === 'issue' && action === 'attachment' ? 4 : 3;
  const command = positional.slice(0, commandLength).join(' ');

  if (area === 'issue' && action === 'update') {
    requireSpacePositional(
      flags,
      positional[3] ?? flags.issueId,
      'issueId',
      'space issue update',
      'issueId',
    );
    requireSpaceSlug(flags);
  }
  exitSpaceInputError(
    flags,
    'DRY_RUN_UNSUPPORTED',
    `myagents ${command} does not support --dry-run. No changes were applied.`,
    `Read myagents ${command} --help; remove --dry-run only when ready to apply the mutation.`,
  );
}

export function buildRoute(group: string, action: string, rest: string[]): string {
  if (group === 'anydoc' && action === 'wait') {
    return 'anydoc/status';
  }
  if (group === 'speech' && action === 'wait') {
    return 'speech/status';
  }
  if (group === 'task' && action === 'trigger') {
    const triggerAction = rest[0] || 'validate';
    return `task/trigger/${triggerAction}`;
  }
  // Canonical Task automation vocabulary. These are CLI aliases over the
  // existing Cron compatibility handlers, which already mutate the one Rust
  // TaskStore authority. Keeping the alias here avoids a second Admin/API
  // implementation while letting Agent-facing docs stop teaching two dialects.
  if (group === 'task' && ['start', 'stop', 'runs', 'exit'].includes(action)) {
    return `cron/${action}`;
  }
  // `diagnose runtime <type>` sugar maps to `runtime/diagnose` so handlers
  // and admin routes stay singular (issue #194).
  if (group === 'diagnose' && action === 'runtime') {
    return 'diagnose/runtime';
  }
  // Handle nested commands like "agent channel list/add/remove"
  if (group === 'agent' && action === 'channel') {
    const channelAction = rest[0] || 'list';
    return `agent/channel/${channelAction}`;
  }
  // Agent runtime status
  if (group === 'agent' && action === 'runtime-status') {
    return 'agent/runtime-status';
  }
  // MCP OAuth subcommands: mcp oauth discover/start/status/revoke
  if (group === 'mcp' && action === 'oauth') {
    const oauthAction = rest[0] || 'status';
    return `mcp/oauth/${oauthAction}`;
  }
  // Tool readmes: `myagents task readme`, compatibility `cron readme`,
  // `myagents im readme`, `myagents widget ...`,
  // `myagents thought readme`. `thought` is included so the AI's natural
  // generalization from cron/im/widget readme doesn't 404 — the server returns
  // a brief "no separate readme" message redirecting back to the prompt brief.
  if (action === 'readme' && (group === 'task' || group === 'cron' || group === 'im' || group === 'widget' || group === 'thought')) {
    return `readme/${group}`;
  }
  if (group === 'goal') {
    if (action === 'get' || action === 'list') return 'goal/get';
    if (action === 'create') return 'goal/create';
    if (action === 'update') return 'goal/update';
  }
  // `widget` only exists for readme lookup — any form of invocation
  // (`myagents widget`, `myagents widget chart`, `myagents widget readme chart`)
  // routes to the same handler. The handler parses modules from the payload.
  if (group === 'widget') {
    return 'readme/widget';
  }
  // `task remove` is an alias for `task delete` — the cron CLI uses `remove`
  // for the same operation, so AI / users who generalize the verb hit a real
  // route instead of the previous opaque "Unknown admin route" 404 (issue
  // #205 gap #4). buildRequestBody already treats them as the same shape.
  if (group === 'task' && action === 'remove') {
    return 'task/delete';
  }
  if (group === 'issue') {
    return 'space/issue-get';
  }
  if (group === 'space' && action === 'issue') {
    const issueAction = rest[0] || 'get';
    if (issueAction === 'create') return 'space/issue-create';
    if (issueAction === 'update') return 'space/issue-update';
    if (issueAction === 'list') return 'space/issue-list';
    if (issueAction === 'get' || issueAction === 'view') return 'space/issue-get';
    if (issueAction === 'comments') return 'space/issue-comments';
    if (issueAction === 'comment' && rest[1] === 'get') return 'space/issue-comment-get';
    if (issueAction === 'comment') return 'space/issue-comment';
    if (issueAction === 'status') return 'space/issue-status';
    if (issueAction === 'claim') return 'space/issue-claim';
    if (issueAction === 'attachment' && rest[1] === 'add') return 'space/attachment-add';
    if (issueAction === 'close') return 'space/issue-close';
    if (issueAction === 'complete') return 'space/issue-complete';
    if (issueAction === 'cancel-claim') return 'space/issue-cancel-claim';
  }
  if (group === 'space' && action === 'list') return 'space/list';
  if (group === 'space' && action === 'whoami') return 'space/whoami';
  if (group === 'space' && action === 'goal' && (rest[0] || 'list') === 'list') {
    return 'space/goal-list';
  }
  if (group === 'space' && action === 'assignee' && (rest[0] || 'list') === 'list') {
    return 'space/assignee-list';
  }
  if (group === 'space' && action === 'claim') {
    const claimAction = rest[0] || '';
    if (claimAction === 'local-task') return 'space/claim-local-task';
  }
  if (group === 'space' && action === 'attachment') {
    const attachmentAction = rest[0] || 'download';
    if (attachmentAction === 'download') return 'space/attachment-download';
    if (attachmentAction === 'add') return 'space/attachment-add';
    if (attachmentAction === 'inspect') return 'space/attachment-inspect';
  }
  return `${group}/${action}`;
}

const PUBLISHED_ADMIN_ROUTES = new Set([
  'anydoc/convert', 'anydoc/status', 'anydoc/cancel', 'anydoc/list',
  'speech/transcribe', 'speech/status', 'speech/cancel', 'speech/list',
  'mcp/list', 'mcp/show', 'mcp/add', 'mcp/remove', 'mcp/enable', 'mcp/disable', 'mcp/env', 'mcp/test',
  'mcp/oauth/discover', 'mcp/oauth/start', 'mcp/oauth/status', 'mcp/oauth/revoke',
  'tool/list', 'tool/info', 'tool/add', 'tool/remove', 'tool/enable', 'tool/disable', 'tool/readme', 'tool/env',
  'vision/readme', 'vision/models', 'vision/analyze',
  'model/list', 'model/add', 'model/remove', 'model/set-key', 'model/set-default', 'model/verify',
  'agent/list', 'agent/current', 'agent/show', 'agent/enable', 'agent/disable', 'agent/archive', 'agent/unarchive',
  'agent/set', 'agent/channel/list', 'agent/channel/add', 'agent/channel/remove', 'agent/runtime-status',
  'runtime/list', 'runtime/describe', 'runtime/diagnose', 'diagnose/runtime',
  'cron/list', 'cron/add', 'cron/start', 'cron/run-now', 'cron/stop', 'cron/remove', 'cron/update', 'cron/runs',
  'cron/status', 'cron/exit',
  'goal/get', 'goal/create', 'goal/update',
  'im/send-media', 'im/wake', 'im/channels',
  'readme/task', 'readme/cron', 'readme/im', 'readme/widget', 'readme/thought',
  'plugin/list', 'plugin/install', 'plugin/remove',
  'cc-plugin/list', 'cc-plugin/show', 'cc-plugin/install', 'cc-plugin/uninstall', 'cc-plugin/enable', 'cc-plugin/disable',
  'skill/list', 'skill/info', 'skill/add', 'skill/remove', 'skill/enable', 'skill/disable', 'skill/sync',
  'config/get', 'config/set',
  'task/list', 'task/get', 'task/comments', 'task/comment', 'task/create-direct', 'task/create-attached', 'task/run',
  'task/run-now', 'task/rerun', 'task/trigger/validate', 'task/trigger/test', 'task/check-now',
  'task/reset-checkpoint', 'task/update', 'task/update-status', 'task/append-session', 'task/archive', 'task/delete',
  'thought/list', 'thought/create', 'record/list', 'record/create',
  'space/list', 'space/whoami', 'space/assignee-list', 'space/goal-list', 'space/issue-create', 'space/issue-update',
  'space/issue-list', 'space/issue-get', 'space/issue-comment', 'space/issue-comments', 'space/issue-comment-get',
  'space/issue-status', 'space/issue-claim', 'space/issue-close', 'space/issue-complete', 'space/issue-cancel-claim',
  'space/claim-local-task', 'space/attachment-download', 'space/attachment-add', 'space/attachment-inspect',
  'session/list', 'session/start', 'session/send', 'session/watch',
]);

const PUBLISHED_COMMAND_GROUPS = new Set([
  'anydoc', 'speech', 'mcp', 'tool', 'vision', 'model', 'agent', 'runtime', 'diagnose', 'cron', 'goal', 'im', 'widget',
  'plugin', 'cc-plugin', 'skill', 'config', 'task', 'thought', 'record', 'space', 'issue', 'session',
  'status', 'reload', 'version',
]);

export function validateCliCommand(
  positional: string[],
  helpMode = false,
): AgentCliError | undefined {
  const group = positional[0];
  if (!group) return undefined;
  if (!PUBLISHED_COMMAND_GROUPS.has(group)) {
    const isRetiredDocumentDraft = group === 'document';
    return {
      code: 'UNKNOWN_COMMAND_GROUP',
      error: `Unknown command group: ${group}`,
      suggestion: isRetiredDocumentDraft
        ? 'Use the published local document conversion command group.'
        : 'List the commands supported by this MyAgents build.',
      suggestedCommand: isRetiredDocumentDraft ? 'myagents anydoc --help' : 'myagents --help',
    };
  }
  if (helpMode && positional.length === 1) return undefined;

  if (group === 'status' || group === 'reload' || group === 'version') {
    if (positional.length === 1) return undefined;
  } else if (group === 'widget' || group === 'issue') {
    return undefined;
  } else {
    const action = positional[1] || 'list';
    const route = buildRoute(group, action, positional.slice(2));
    if (PUBLISHED_ADMIN_ROUTES.has(route)) return undefined;
  }

  const command = positional.join(' ');
  return {
    code: 'UNKNOWN_COMMAND',
    error: `Unknown command: ${command}`,
    suggestion: `List the published ${group} commands and retry with one of them.`,
    suggestedCommand: `myagents ${group} --help`,
  };
}

function resolveSpaceWorkspacePath(flags: Record<string, unknown>): string {
  const explicit = typeof flags.workspacePath === 'string'
    ? flags.workspacePath
    : typeof flags.workspace === 'string'
      ? flags.workspace
      : undefined;
  return explicit && explicit.trim() ? explicit : process.cwd();
}

type AgentCliError = {
  code: string;
  error: string;
  suggestion?: string;
  suggestedCommand?: string;
};

function exitAgentCliError(
  flags: Record<string, unknown>,
  error: AgentCliError,
  exitCode = 2,
): never {
  if (flags.json) {
    console.log(JSON.stringify({ success: false, ...error }, null, 2));
  } else {
    console.error(`Error: ${error.error}`);
    if (error.suggestion) console.error(`Suggestion: ${error.suggestion}`);
    if (error.suggestedCommand) console.error(`Try: ${error.suggestedCommand}`);
  }
  process.exit(exitCode);
}

function requireSpaceSlug(flags: Record<string, unknown>): string {
  const value = typeof flags.space === 'string' ? flags.space.trim() : '';
  if (value) return value;
  return exitAgentCliError(flags, {
    code: 'SPACE_REQUIRED',
    error: 'This command requires --space <slug>.',
    suggestion: 'Run `myagents space list --json`, then retry with one returned slug.',
    suggestedCommand: 'myagents space list --json',
  });
}

function requireSpacePositional(
  flags: Record<string, unknown>,
  value: unknown,
  argName: string,
  command: string,
  flagAlternative?: string,
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized) return normalized;
  return exitAgentCliError(flags, {
    code: 'ARGUMENT_REQUIRED',
    error: `${command} requires <${argName}>.`,
    suggestion: `Run \`myagents ${command} --help\` and retry with <${argName}>${flagAlternative ? ` or --${flagAlternative} <${argName}>` : ''}.`,
    suggestedCommand: `myagents ${command} --help`,
  });
}

function optionalSpaceStringFlag(
  flags: Record<string, unknown>,
  value: unknown,
  flagName: string,
  command: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return exitSpaceInputError(
    flags,
    'FLAG_VALUE_REQUIRED',
    `${command} requires --${flagName} <value>.`,
    `Run \`myagents ${command} --help\`, then retry with a non-empty --${flagName} value.`,
  );
}

function optionalSpaceBooleanFlag(
  flags: Record<string, unknown>,
  value: unknown,
  flagName: string,
  command: string,
  invalidCandidate?: unknown,
  allowBare = false,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (invalidCandidate !== undefined) {
    return exitSpaceInputError(
      flags,
      'BOOLEAN_VALUE_INVALID',
      `${command} --${flagName} must be true or false; got "${String(invalidCandidate)}".`,
      `Use --${flagName} true or --${flagName} false.`,
    );
  }
  if (value === true) {
    if (allowBare) return true;
    return exitSpaceInputError(
      flags,
      'FLAG_VALUE_REQUIRED',
      `${command} requires --${flagName} <true|false>.`,
      `Use --${flagName} true or --${flagName} false.`,
    );
  }
  if (value === 'true') return true;
  if (value === false || value === 'false') return false;
  return exitSpaceInputError(
    flags,
    'BOOLEAN_VALUE_INVALID',
    `${command} --${flagName} must be true or false; got "${String(value)}".`,
    `Use --${flagName} true or --${flagName} false.`,
  );
}

function exitSpaceInputError(
  flags: Record<string, unknown>,
  code: string,
  error: string,
  suggestion: string,
): never {
  return exitAgentCliError(flags, { code, error, suggestion });
}

function spaceCommandContext(flags: Record<string, unknown>, workspacePath: string): Record<string, unknown> {
  return {
    spaceSlug: requireSpaceSlug(flags),
    sessionId: process.env.MYAGENTS_SESSION_ID,
    workspaceId: flags.workspaceId,
    workspacePath,
    agentId: flags.agentId,
  };
}

function spaceAttachmentPaths(flags: Record<string, unknown>): string[] {
  const missingFlag = flags.attachmentValueMissing ? 'attachment' : flags.fileValueMissing ? 'file' : undefined;
  const paths = [
    ...((flags.attachment as string[] | undefined) ?? []),
    ...((flags.file as string[] | undefined) ?? []),
  ];
  if (missingFlag || paths.some(path => typeof path !== 'string' || !path.trim())) {
    return exitSpaceInputError(
      flags,
      'FLAG_VALUE_REQUIRED',
      `Space attachment input requires --${missingFlag ?? 'file'} <path>.`,
      'Pass a non-empty workspace file path after every --file or --attachment flag.',
    );
  }
  return paths;
}

function resolveImMediaFilePath(
  flags: Record<string, unknown>,
  positionalPath: string | undefined,
): string {
  const rawFile = flags.file;
  const filePaths = rawFile === undefined
    ? []
    : Array.isArray(rawFile)
      ? rawFile
      : [rawFile];

  if (filePaths.length > 1) {
    return exitAgentCliError(flags, {
      code: 'FILE_COUNT_INVALID',
      error: 'im send-media accepts exactly one --file <path>.',
      suggestion: 'Run `myagents im send-media --help`, then retry with one absolute file path.',
    });
  }

  const filePath = filePaths[0] ?? positionalPath;
  if (
    flags.fileValueMissing
    || typeof filePath !== 'string'
    || !filePath.trim()
  ) {
    return exitAgentCliError(flags, {
      code: 'FILE_REQUIRED',
      error: 'im send-media requires --file <path>.',
      suggestion: 'Run `myagents im send-media --help`, then retry with one absolute file path.',
    });
  }

  return filePath;
}

function optionalNumberFlag(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type GuardedTextFileScope =
  | { kind: 'workspace'; root: string }
  | { kind: 'local'; basePath: string };

/** Open once, validate the opened descriptor, and read at most max+1 bytes.
 * This prevents the path-swap and post-stat growth races of lstat+readFile. */
function readGuardedFileBytes(
  path: string,
  scope: GuardedTextFileScope,
  maxBytes: number,
): Buffer {
  const fs = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const basePath = scope.kind === 'workspace' ? scope.root : scope.basePath;
  const baseReal = fs.realpathSync(pathMod.resolve(basePath));
  const requested = pathMod.resolve(baseReal, path);
  const parentReal = fs.realpathSync(pathMod.dirname(requested));
  const target = pathMod.join(parentReal, pathMod.basename(requested));
  const assertInsideWorkspace = (candidate: string) => {
    if (scope.kind !== 'workspace') return;
    const workspaceReal = fs.realpathSync(pathMod.resolve(scope.root));
    const rel = pathMod.relative(workspaceReal, candidate);
    if (rel === '' || rel.startsWith('..') || pathMod.isAbsolute(rel)) {
      throw new Error(`path must stay inside workspace "${scope.root}"`);
    }
  };
  assertInsideWorkspace(target);
  const leaf = fs.lstatSync(target);
  if (leaf.isSymbolicLink()) {
    throw new Error('path must not be a symlink');
  }
  if (!leaf.isFile()) throw new Error('path must be a regular file');

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('path must be a regular file');
    if (scope.kind === 'workspace') {
      const openedReal = fs.realpathSync(target);
      assertInsideWorkspace(openedReal);
    }
    const current = fs.lstatSync(target);
    if (current.isSymbolicLink()) {
      throw new Error('path became a symlink while it was being opened');
    }
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new Error('path changed while it was being opened');
    }

    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
    return bytes.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function readGuardedTextFile(path: string, scope: GuardedTextFileScope): string {
  const body = readGuardedFileBytes(path, scope, 1024 * 1024).toString('utf8');
  if (body.includes('\0')) {
    throw new Error('file contains NUL bytes');
  }
  return body;
}

export function readWorkspaceTextFile(path: string, workspacePath = process.cwd()): string {
  return readGuardedTextFile(path, { kind: 'workspace', root: workspacePath });
}

function readLocalTextFile(path: string, basePath = process.cwd()): string {
  return readGuardedTextFile(path, { kind: 'local', basePath });
}

function readTextFileFlag(path: string, flagName: string, exitCode = 1): string {
  try {
    return readLocalTextFile(path);
  } catch (err) {
    console.error(`Error: failed to read --${flagName} "${path}": ${err instanceof Error ? err.message : String(err)}`);
    process.exit(exitCode);
  }
}

function resolveTaskCommentBody(flags: Record<string, unknown>): string {
  if (flags.body !== undefined && flags.bodyFile !== undefined) {
    console.error('Error: task comment accepts only one of --body or --body-file.');
    process.exit(2);
  }
  const body = typeof flags.bodyFile === 'string'
    ? readTextFileFlag(flags.bodyFile, 'body-file')
    : typeof flags.body === 'string'
      ? flags.body
      : '';
  if (!body.trim()) {
    console.error('Error: task comment requires non-empty --body-file or --body.');
    process.exit(2);
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > 64 * 1024) {
    console.error('Error: task comment body exceeds the 65536 byte limit.');
    process.exit(2);
  }
  return body;
}

function resolveCronPromptText(flags: Record<string, unknown>): string | undefined {
  for (const flagName of ['prompt', 'message', 'promptFile'] as const) {
    const value = flags[flagName];
    if (value !== undefined && typeof value !== 'string') {
      const displayName = flagName === 'promptFile' ? 'prompt-file' : flagName;
      console.error(`Error: --${displayName} requires a value.`);
      process.exit(2);
    }
  }

  const prompt = flags.prompt as string | undefined;
  const message = flags.message as string | undefined;
  const promptFile = flags.promptFile as string | undefined;
  if (promptFile !== undefined && (prompt !== undefined || message !== undefined)) {
    console.error('Error: --prompt-file cannot be combined with --prompt or --message.');
    process.exit(2);
  }
  const resolved = promptFile !== undefined
    ? readTextFileFlag(promptFile, 'prompt-file')
    // Preserve the established alias behavior: --prompt wins when both inline
    // spellings are supplied.
    : prompt ?? message;
  if (resolved !== undefined && resolved.trim().length === 0) {
    console.error('Error: cron prompt cannot be empty.');
    process.exit(2);
  }
  return resolved;
}

function resolveSpaceCommentBody(flags: Record<string, unknown>, workspacePath: string): string {
  if (typeof flags.body === 'string') return flags.body;
  if (typeof flags.bodyFile === 'string') {
    try {
      return readWorkspaceTextFile(flags.bodyFile, workspacePath);
    } catch (error) {
      return exitSpaceInputError(
        flags,
        'BODY_FILE_INVALID',
        `Failed to read --body-file "${flags.bodyFile}": ${error instanceof Error ? error.message : String(error)}.`,
        'Choose a regular, non-symlink text file inside the current workspace.',
      );
    }
  }
  if (flags.stdin) {
    try {
      const fs = require('fs') as typeof import('fs');
      return fs.readFileSync(0, 'utf-8');
    } catch (err) {
      return exitSpaceInputError(
        flags,
        'STDIN_READ_FAILED',
        `Failed to read stdin: ${err instanceof Error ? err.message : String(err)}.`,
        'Retry with --body-file <workspace-relative-path>.',
      );
    }
  }
  return '';
}

function truthyCliFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shouldCreateAttachedTaskForClaim(flags: Record<string, unknown>): boolean {
  return truthyCliFlag(flags.createAttached);
}

function hasSpaceCommentBodyFlags(flags: Record<string, unknown>): boolean {
  return flags.body !== undefined || flags.bodyFile !== undefined || truthyCliFlag(flags.stdin);
}

function shouldFinalizeSpaceIssue(flags: Record<string, unknown>): boolean {
  return (
    hasSpaceCommentBodyFlags(flags)
    || spaceAttachmentPaths(flags).length > 0
    || flags.taskId !== undefined
    || flags.localTaskId !== undefined
    || flags.taskStatus !== undefined
  );
}

function requireNonEmptyStringFlag(
  value: unknown,
  flagName: string,
  command: string,
): string {
  assertStringFlag(value, flagName);
  if (typeof value === 'string' && value.trim()) return value.trim();
  console.error(`Error: ${command} requires --${flagName} <value>.`);
  process.exit(2);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function extractClaimData(data: unknown): Record<string, unknown> {
  const envelope = objectValue(data) ?? {};
  const nested = objectValue(envelope.data);
  return objectValue(envelope.claim) ?? objectValue(nested?.claim) ?? nested ?? envelope;
}

function extractTaskData(data: unknown): Record<string, unknown> {
  const envelope = objectValue(data) ?? {};
  const nested = objectValue(envelope.data);
  return objectValue(envelope.task) ?? objectValue(nested?.task) ?? nested ?? envelope;
}

function parseSpaceCommaTags(flags: Record<string, unknown>, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    return exitSpaceInputError(
      flags,
      'FLAG_VALUE_REQUIRED',
      'space issue claim --create-attached requires --tags <comma-separated-values>.',
      'Pass a comma-separated string after --tags, or omit the flag.',
    );
  }
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function validateSpaceAttachedNotificationFlags(flags: Record<string, unknown>): void {
  const stringFlags = [
    ['notificationBotChannelId', 'notificationBotChannelId'],
    ['notificationBotThread', 'notificationBotThread'],
    ['notificationEvents', 'notificationEvents'],
  ] as const;
  for (const [key, display] of stringFlags) {
    const value = flags[key];
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      exitSpaceInputError(
        flags,
        'FLAG_VALUE_REQUIRED',
        `space issue claim --create-attached requires --${display} <value>.`,
        `Pass a non-empty value after --${display}, or omit the flag.`,
      );
    }
  }
  if (typeof flags.notificationEvents === 'string') {
    const events = flags.notificationEvents.split(',').map(value => value.trim()).filter(Boolean);
    if (events.length === 0) {
      exitSpaceInputError(
        flags,
        'NOTIFICATION_EVENTS_INVALID',
        '--notificationEvents must contain at least one event.',
        'Pass events such as done,blocked,endCondition, or omit the flag.',
      );
    }
  }
}

function buildAttachedTaskBodyForSpaceClaim(
  claimBody: Record<string, unknown>,
  claim: Record<string, unknown>,
  flags: Record<string, unknown>,
  currentSessionId: string,
): Record<string, unknown> {
  const source = (flags.source as string | undefined) ?? 'space-issue';
  if (source !== 'space-issue') {
    return exitSpaceInputError(
      flags,
      'SOURCE_INVALID',
      `space issue claim --create-attached supports only --source "space-issue"; received "${source}".`,
      'Remove --source or set it to "space-issue".',
    );
  }

  const issueId = requireSpacePositional(flags, claimBody.issueId as string | undefined, 'issueId', 'space issue claim');
  const workspaceId = requireSpacePositional(flags, flags.workspaceId as string | undefined, 'workspaceId', 'space issue claim --create-attached');
  const workspacePath = optionalSpaceStringFlag(flags, flags.workspacePath, 'workspacePath', 'space issue claim --create-attached')
    ?? stringValue(claimBody, 'workspacePath')
    ?? process.cwd();
  const taskMdContent = resolveTaskMdContent(
    flags,
    workspacePath,
    (error, exitCode) => exitAgentCliError(flags, error, exitCode),
  );
  if (typeof taskMdContent !== 'string' || !taskMdContent.trim()) {
    return exitSpaceInputError(
      flags,
      'TASK_CONTENT_REQUIRED',
      'space issue claim --create-attached requires task markdown content.',
      'Pass --taskMdFile, --taskMdContentFile, or --taskMdContent.',
    );
  }

  const explicitName = optionalSpaceStringFlag(flags, flags.name, 'name', 'space issue claim --create-attached');
  const executor = optionalSpaceStringFlag(flags, flags.executor, 'executor', 'space issue claim --create-attached') ?? 'agent';
  const description = optionalSpaceStringFlag(flags, flags.description, 'description', 'space issue claim --create-attached');
  const sourceSpaceId = optionalSpaceStringFlag(flags, flags.sourceSpaceId, 'sourceSpaceId', 'space issue claim --create-attached')
    ?? stringValue(claim, 'spaceId');
  const deliveryId = stringValue(claimBody, 'deliveryId')
    ?? optionalSpaceStringFlag(flags, flags.sourceDeliveryId, 'sourceDeliveryId', 'space issue claim --create-attached');
  validateSpaceAttachedNotificationFlags(flags);

  return {
    name: explicitName ?? `Space Issue ${issueId}`,
    executor,
    description,
    workspaceId,
    workspacePath,
    taskMdContent,
    currentSessionId,
    source,
    sourceSpaceId,
    sourceIssueId: issueId,
    sourceClaimId: stringValue(claim, 'id', 'claimId'),
    sourceDeliveryId: deliveryId,
    tags: parseSpaceCommaTags(flags, flags.tags),
    notification: buildNotificationFromFlags(flags),
  };
}

export function buildClaimCancelBody(
  claimBody: Record<string, unknown>,
  claimResult: Record<string, unknown>,
): Record<string, unknown> {
  const cloudData = objectValue(claimResult.data) ?? {};
  const claim = extractClaimData(claimResult.data);
  const origin = stringValue(claim, 'origin') ?? 'self_claim';
  return {
    issueId: claimBody.issueId,
    ...(claimBody.spaceSlug !== undefined ? { spaceSlug: claimBody.spaceSlug } : {}),
    ...(claimBody.sessionId !== undefined ? { sessionId: claimBody.sessionId } : {}),
    ...(claimBody.workspaceId !== undefined ? { workspaceId: claimBody.workspaceId } : {}),
    agentId: claimBody.agentId,
    workspacePath: claimBody.workspacePath,
    rollback: true,
    ...(origin === 'self_claim'
      ? { expectedNotificationVersion: cloudData.notificationVersion }
      : {}),
  };
}

export function buildSpaceCompleteOperationKey(input: {
  issueId: string;
  taskOrSessionId: string;
  resultComment?: string;
  fileContentHashes?: string[];
}): string {
  const crypto = require('crypto') as typeof import('crypto');
  const basis = [
    input.issueId,
    input.taskOrSessionId,
    input.resultComment ?? '',
    ...(input.fileContentHashes ?? []),
  ].join('\0');
  return `desktop-complete-${crypto.createHash('sha256').update(basis).digest('hex')}`;
}

async function cancelClaimAfterAttachedFailure(
  claimBody: Record<string, unknown>,
  claimResult: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return callApi('space/issue-cancel-claim', buildClaimCancelBody(claimBody, claimResult));
}

async function stopAttachedTaskAfterClaimFailure(
  taskId: string,
  message: string,
): Promise<Record<string, unknown>> {
  return callApi('task/update-status', {
    id: taskId,
    status: 'stopped',
    message,
  });
}

function rollbackSuffix(rollback: Record<string, unknown>): string {
  if (rollback.success) return 'The operational cloud claim rollback completed.';
  return `Cloud claim cancellation also failed: ${String(rollback.error ?? 'unknown error')}.`;
}

function failedAttachedClaimResult(
  message: string,
  claimResult: Record<string, unknown>,
  rollback: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    success: false,
    code: 'ATTACHED_TASK_TRANSACTION_FAILED',
    error: `${message} ${rollbackSuffix(rollback)}`,
    suggestion: rollback.success
      ? 'Inspect the Issue claim and local Task state before retrying; the cloud claim was rolled back.'
      : 'Inspect both the cloud claim and local Task state, then repair the failed rollback before retrying.',
    data: {
      claim: claimResult.data,
      rollback,
      ...extra,
    },
  };
}

async function claimSpaceIssueWithAttachedTask(
  claimBody: Record<string, unknown>,
  flags: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const currentSessionId =
    typeof flags.currentSessionId === 'string' && flags.currentSessionId.trim()
      ? flags.currentSessionId.trim()
      : process.env.MYAGENTS_SESSION_ID;
  if (!currentSessionId) {
    return exitSpaceInputError(
      flags,
      'SESSION_REQUIRED',
      'space issue claim --create-attached requires an active MyAgents Session.',
      'Run this command inside the MyAgents AI Session that will own the attached Task.',
    );
  }

  const taskBody = buildAttachedTaskBodyForSpaceClaim(claimBody, {}, flags, currentSessionId);

  const claimResult = await callApi('space/issue-claim', claimBody);
  if (!claimResult.success) return claimResult;

  const claim = extractClaimData(claimResult.data);
  const claimId = stringValue(claim, 'id', 'claimId');
  if (!claimId) {
    const rollback = await cancelClaimAfterAttachedFailure(claimBody, claimResult);
    return failedAttachedClaimResult(
      'Issue claim succeeded but the response did not include a claim id.',
      claimResult,
      rollback,
    );
  }

  if (!taskBody.sourceSpaceId) taskBody.sourceSpaceId = stringValue(claim, 'spaceId');
  taskBody.sourceClaimId = claimId;

  const existingTaskId = stringValue(claim, 'localTaskId');
  const existingSessionId = stringValue(claim, 'localSessionId');
  if (existingTaskId && existingSessionId) {
    return {
      success: true,
      data: {
        issueId: claimBody.issueId,
        spaceSlug: claimBody.spaceSlug,
        claim,
        task: { id: existingTaskId },
        localSessionId: existingSessionId,
        reusedExistingLink: true,
      },
      hint: 'Issue assignment already has an attached local Task/Session; reused the existing link.',
    };
  }
  if (existingTaskId || existingSessionId) {
    return {
      success: false,
      code: 'ATTACHED_TASK_LINK_INCOMPLETE',
      error: 'The cloud claim has an incomplete local Task/Session link. Refusing to create a duplicate Task; repair the existing link first.',
      suggestion: 'Inspect the claim and its local Task/Session references, repair the incomplete link, then retry without creating a duplicate Task.',
      data: { issueId: claimBody.issueId, claim },
    };
  }

  const taskResult = await callApi('task/create-attached', taskBody);
  if (!taskResult.success) {
    const rollback = await cancelClaimAfterAttachedFailure(claimBody, claimResult);
    return failedAttachedClaimResult(
      `Issue claim succeeded but attached task creation failed: ${String(taskResult.error ?? 'unknown error')}.`,
      claimResult,
      rollback,
      { taskCreate: taskResult },
    );
  }

  const task = extractTaskData(taskResult.data);
  const taskId = stringValue(task, 'id', 'taskId');
  if (!taskId) {
    const rollback = await cancelClaimAfterAttachedFailure(claimBody, claimResult);
    return failedAttachedClaimResult(
      'Issue claim and attached task creation succeeded, but the task response did not include a task id.',
      claimResult,
      rollback,
      { taskCreate: taskResult.data },
    );
  }

  const localTaskResult = await callApi('space/claim-local-task', {
    spaceSlug: claimBody.spaceSlug,
    sessionId: claimBody.sessionId,
    workspaceId: claimBody.workspaceId,
    claimId,
    localTaskId: taskId,
    localSessionId: currentSessionId,
    agentId: claimBody.agentId,
    workspacePath: claimBody.workspacePath,
  });
  const localTaskData = objectValue(localTaskResult.data);
  const localTaskBound = localTaskData?.updated === true
    || (
      stringValue(localTaskData, 'localTaskId') === taskId
      && stringValue(localTaskData, 'localSessionId') === currentSessionId
    );
  if (!localTaskResult.success || !localTaskBound) {
    const taskRollback = await stopAttachedTaskAfterClaimFailure(
      taskId,
      'Space claim local-task binding failed; cloud claim cancelled.',
    );
    const rollback = await cancelClaimAfterAttachedFailure(claimBody, claimResult);
    const linkError = localTaskResult.success
      ? 'cloud response did not confirm the requested local task/session binding'
      : String(localTaskResult.error ?? 'unknown error');
    return failedAttachedClaimResult(
      `Issue claim and attached task creation succeeded, but local-task binding failed: ${linkError}. Local task id: ${taskId}.`,
      claimResult,
      rollback,
      { taskCreate: taskResult.data, taskRollback, localTaskRef: localTaskResult },
    );
  }

  return {
    success: true,
    data: {
      issueId: claimBody.issueId,
      spaceSlug: claimBody.spaceSlug,
      claim,
      taskCreate: taskResult.data,
      task,
      localTaskRef: localTaskResult.data,
      localSessionId: currentSessionId,
    },
    hint: 'Issue claimed and attached task created.',
  };
}

function resolveSpaceCompleteTaskId(flags: Record<string, unknown>): string | undefined {
  if (flags.taskId !== undefined) {
    return requireSpacePositional(flags, flags.taskId as string | undefined, 'taskId', 'space issue complete');
  }
  if (flags.localTaskId !== undefined) {
    return requireSpacePositional(flags, flags.localTaskId as string | undefined, 'localTaskId', 'space issue complete');
  }
  return undefined;
}

async function completeSpaceIssueWithLocalFollowup(
  completeBody: Record<string, unknown>,
  flags: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const issueId = requireSpacePositional(flags, completeBody.issueId as string | undefined, 'issueId', 'space issue complete');
  const workspacePath = stringValue(completeBody, 'workspacePath') ?? process.cwd();
  const taskId = resolveSpaceCompleteTaskId(flags);
  if (flags.taskStatus !== undefined && !taskId) {
    return exitSpaceInputError(
      flags,
      'TASK_ID_REQUIRED',
      'space issue complete --taskStatus requires --taskId <taskId>.',
      'Pass the attached Task id or omit --taskStatus.',
    );
  }
  const requestedTaskStatus = optionalSpaceStringFlag(flags, flags.taskStatus, 'taskStatus', 'space issue complete');
  if (requestedTaskStatus && requestedTaskStatus !== 'done') {
    return exitSpaceInputError(
      flags,
      'TASK_STATUS_INVALID',
      'space issue complete can only update the local Task to done.',
      'For blocked or stopped work, update the Task separately and cancel the Issue claim.',
    );
  }
  const taskStatus = taskId ? 'done' : undefined;
  const message = optionalSpaceStringFlag(flags, flags.message, 'message', 'space issue complete');

  let resultComment: string | undefined;
  const attachmentPaths = spaceAttachmentPaths(flags);
  if (hasSpaceCommentBodyFlags(flags)) {
    resultComment = resolveSpaceCommentBody(flags, workspacePath);
    if (!resultComment.trim()) {
      if (attachmentPaths.length > 0) {
        resultComment = undefined;
      } else {
        return exitAgentCliError(flags, {
          code: 'COMMENT_CONTENT_REQUIRED',
          error: 'The completion comment body is empty.',
          suggestion: 'Add non-empty --body-file content, add --attachment <path>, or omit comment flags.',
        });
      }
    }
  }

  let existingTaskStatus: string | undefined;
  let taskAlreadyDone = false;
  let taskRead: Record<string, unknown> | undefined;
  if (taskId) {
    taskRead = await callApi('task/get', { id: taskId });
    if (!taskRead.success) {
      return {
        success: false,
        code: 'LOCAL_TASK_READ_FAILED',
        error: `Cannot complete the Space Issue because attached Task ${taskId} could not be read: ${String(taskRead.error ?? 'unknown error')}.`,
        suggestion: `Run \`myagents task get ${shellQuoteArg(taskId)} --json\` to verify the Task id, then retry without changing the cloud Issue.`,
        data: { issueId, taskId, taskRead },
      };
    }
    existingTaskStatus = stringValue(extractTaskData(taskRead.data), 'status');
    taskAlreadyDone = existingTaskStatus === 'done';
    if (!taskAlreadyDone && existingTaskStatus !== 'running' && existingTaskStatus !== 'verifying') {
      return {
        success: false,
        code: 'LOCAL_TASK_STATE_INVALID',
        error: `Cannot complete the Space Issue while attached Task ${taskId} is ${existingTaskStatus ?? 'in an unknown state'}. Move the Task to running or verifying first; the cloud Issue was not changed.`,
        suggestion: `Move Task ${taskId} to running or verifying, then retry this exact Space completion command.`,
        data: { issueId, taskId, taskStatus: existingTaskStatus, taskRead },
      };
    }
  }

  const operationKey = buildSpaceCompleteOperationKey({
    issueId,
    taskOrSessionId: taskId ?? process.env.MYAGENTS_SESSION_ID ?? 'no-local-task',
    resultComment,
  });
  const completeResult = await callApi('space/issue-complete', {
    ...completeBody,
    resultComment,
    operationKey,
    operationKeySubject: taskId ?? process.env.MYAGENTS_SESSION_ID ?? 'no-local-task',
  });
  if (!completeResult.success) {
    return {
      success: false,
      code: stringValue(completeResult, 'code') ?? 'SPACE_ISSUE_COMPLETE_FAILED',
      error: String(completeResult.error ?? 'Issue completion failed'),
      suggestion: stringValue(completeResult, 'suggestion')
        ?? 'Inspect the Issue with `myagents space issue view <issueId> --space <slug> --json`, then retry only after resolving the reported cloud conflict.',
      data: {
        issueId,
        issueComplete: completeResult,
        operationKey,
      },
    };
  }

  let taskResult: Record<string, unknown> | undefined;
  if (taskId && taskStatus && !taskAlreadyDone) {
    taskResult = await callApi('task/update-status', {
      id: taskId,
      status: taskStatus,
      message,
    });
    if (!taskResult.success) {
      const taskAfterFailure = await callApi('task/get', { id: taskId });
      taskAlreadyDone = taskAfterFailure.success === true
        && stringValue(extractTaskData(taskAfterFailure.data), 'status') === 'done';
      if (!taskAlreadyDone) {
        return {
          success: false,
          code: 'LOCAL_TASK_UPDATE_FAILED',
          error: `Issue completed but local task status update failed: ${String(taskResult.error ?? 'unknown error')}.`,
          suggestion: `Rerun the recovery command to finish the local Task transition; the cloud Issue is already complete.`,
          recoveryHint: {
            recoveryCommand: `myagents space issue complete ${shellQuoteArg(issueId)} --space ${shellQuoteArg(String(completeBody.spaceSlug))} --workspacePath ${shellQuoteArg(workspacePath)} --taskId ${shellQuoteArg(taskId)} --message "completed Space issue"`,
            message: 'Cloud Issue is already complete; rerun the Space completion command so it can finish the local Task transition safely.',
          },
          data: {
            issueId,
            issueComplete: completeResult.data,
            taskId,
            taskStatus,
            taskUpdate: taskResult,
            taskAfterFailure,
          },
        };
      }
    }
  }

  return {
    success: true,
    data: {
      issueId,
      issueComplete: completeResult.data,
      operationKey: stringValue(objectValue(completeResult.data), 'operationKey') ?? operationKey,
      taskId,
      taskStatus,
      taskAlreadyDone,
      taskUpdate: taskResult?.data,
    },
    hint: taskId
      ? 'Issue completed. Attached task has already been marked done. Do not call task update-status again.'
      : 'Issue completed.',
    nextAction: taskId ? 'Do not update the attached Task status again.' : undefined,
  };
}

function resolveSessionPromptText(
  flags: Record<string, unknown>,
  action: 'send' | 'start',
): string {
  if (flags.prompt !== undefined && typeof flags.prompt !== 'string') {
    console.error('Error: -p / --prompt requires a value');
    process.exit(3);
  }
  if (flags.promptFile !== undefined && typeof flags.promptFile !== 'string') {
    console.error('Error: --prompt-file requires a file path value');
    process.exit(3);
  }
  let promptText = flags.prompt as string | undefined;
  const promptFile = typeof flags.promptFile === 'string' ? flags.promptFile : undefined;
  const MAX_PROMPT_BYTES = 4 * 1024;

  if (promptFile) {
    if (promptText !== undefined) {
      console.error('Error: --prompt-file and -p/--prompt are mutually exclusive');
      process.exit(3);
    }
    promptText = readTextFileFlag(promptFile, 'prompt-file', 3);
  }

  if (!promptText || promptText.length === 0) {
    console.error(`Error: session ${action} requires --prompt "<text>" or --prompt-file <path>`);
    console.error(`  → Tip: see \`myagents session ${action} --help\` for usage examples`);
    process.exit(3);
  }

  if (!promptFile) {
    if (promptText.includes('\n')) {
      console.error('Error: -p / --prompt content contains newlines (\\n) — Windows cmd.exe truncates flags after \\n,');
      console.error('       which would drop subsequent flags. Write the content to a file and use --prompt-file instead:');
      console.error(action === 'send'
        ? '         myagents session send <sessionId> --prompt-file <path>'
        : '         myagents session start --agent <agentId> --prompt-file <path>');
      process.exit(3);
    }
    const promptBytes = Buffer.byteLength(promptText, 'utf8');
    if (promptBytes > MAX_PROMPT_BYTES) {
      console.error(`Error: -p / --prompt content is ${promptBytes} bytes, exceeds ${MAX_PROMPT_BYTES} (4 KB) limit.`);
      console.error('       Write the content to a file and use --prompt-file instead:');
      console.error(action === 'send'
        ? '         myagents session send <sessionId> --prompt-file <path>'
        : '         myagents session start --agent <agentId> --prompt-file <path>');
      process.exit(3);
    }
  }

  return promptText;
}

function buildAnydocRequestBody(
  action: string,
  rest: string[],
  flags: Record<string, unknown>,
): Record<string, unknown> {
  const allowedByAction: Record<string, Set<string>> = {
    convert: new Set(['file', 'fileValueMissing', 'output', 'password', 'wait', 'waitInvalidValue', 'json', 'port']),
    status: new Set(['json', 'port']),
    wait: new Set(['json', 'port']),
    cancel: new Set(['json', 'port']),
    list: new Set(['limit', 'json', 'port']),
  };
  const allowed = allowedByAction[action];
  if (!allowed) {
    return exitAgentCliError(flags, {
      code: 'UNKNOWN_COMMAND',
      error: `Unknown AnyDoc command: ${action}`,
      suggestion: 'Inspect the published AnyDoc commands.',
      suggestedCommand: 'myagents anydoc --help',
    });
  }
  const unsupported = Object.keys(flags).find(key => !allowed.has(key));
  if (unsupported) {
    const displayFlag = unsupported.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`);
    return exitAgentCliError(flags, {
      code: unsupported === 'dryRun' ? 'DRY_RUN_UNSUPPORTED' : 'FLAG_UNSUPPORTED',
      error: `myagents anydoc ${action} does not support --${displayFlag}.`,
      suggestion: 'Read the exact leaf help and retry with only documented options.',
      suggestedCommand: `myagents anydoc ${action} --help`,
    });
  }

  if (action === 'convert') {
    const files = Array.isArray(flags.file) ? flags.file : [];
    if (flags.fileValueMissing || files.length !== 1 || typeof files[0] !== 'string' || !files[0].trim()) {
      return exitAgentCliError(flags, {
        code: 'DOCUMENT_FILE_COUNT_INVALID',
        error: 'anydoc convert requires exactly one --file <input>.',
        suggestion: 'Choose one supported local document and retry.',
        suggestedCommand: 'myagents anydoc convert --help',
      });
    }
    if (rest.length > 0) {
      return exitAgentCliError(flags, {
        code: 'DOCUMENT_ARGUMENT_UNEXPECTED',
        error: `anydoc convert does not accept positional input: ${rest.join(' ')}`,
        suggestion: 'Pass the single input through --file <input>.',
        suggestedCommand: 'myagents anydoc convert --help',
      });
    }
    if (flags.waitInvalidValue !== undefined) {
      return exitAgentCliError(flags, {
        code: 'DOCUMENT_WAIT_VALUE_INVALID',
        error: '--wait is a presence flag and does not accept true or false.',
        suggestion: 'Use bare --wait, or omit it for immediate acceptance.',
        suggestedCommand: 'myagents anydoc convert --help',
      });
    }
    if (flags.output !== undefined && (typeof flags.output !== 'string' || !flags.output.trim())) {
      return exitAgentCliError(flags, {
        code: 'DOCUMENT_OUTPUT_PATH_INVALID',
        error: '--output requires a directory path.',
        suggestion: 'Pass an output root directory, not a document filename.',
        suggestedCommand: 'myagents anydoc convert --help',
      });
    }
    if (flags.password !== undefined && typeof flags.password !== 'string') {
      return exitAgentCliError(flags, {
        code: 'DOCUMENT_PASSWORD_VALUE_REQUIRED',
        error: '--password requires a value.',
        suggestion: 'Pass the document password or omit --password.',
        suggestedCommand: 'myagents anydoc convert --help',
      });
    }
    const source = files[0].trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
      return exitAgentCliError(flags, {
        code: 'DOCUMENT_SOURCE_PATH_INVALID',
        error: 'anydoc convert accepts one local file path, not a URL.',
        suggestion: 'Choose a local file and retry.',
        suggestedCommand: 'myagents anydoc convert --help',
      });
    }
    const pathMod = require('path') as typeof import('path');
    return {
      sourcePath: pathMod.resolve(process.cwd(), source),
      ...(typeof flags.output === 'string'
        ? { outputRoot: pathMod.resolve(process.cwd(), flags.output.trim()) }
        : {}),
      ...(typeof flags.password === 'string' ? { password: flags.password } : {}),
    };
  }

  if (action === 'list') {
    if (rest.length > 0) {
      return exitAgentCliError(flags, {
        code: 'DOCUMENT_ARGUMENT_UNEXPECTED',
        error: 'anydoc list does not accept positional arguments.',
        suggestedCommand: 'myagents anydoc list --help',
      });
    }
    const rawLimit = flags.limit ?? '20';
    const limit = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return exitAgentCliError(flags, {
        code: 'DOCUMENT_LIST_LIMIT_INVALID',
        error: '--limit must be an integer from 1 to 100.',
        suggestion: 'Retry with --limit 20 or another allowed value.',
        suggestedCommand: 'myagents anydoc list --help',
      });
    }
    return { limit };
  }

  if (rest.length !== 1 || typeof rest[0] !== 'string' || !rest[0].trim()) {
    return exitAgentCliError(flags, {
      code: 'DOCUMENT_JOB_ID_REQUIRED',
      error: `anydoc ${action} requires exactly one <job-id>.`,
      suggestion: 'Copy the exact job ID from anydoc list.',
      suggestedCommand: 'myagents anydoc list',
    });
  }
  return { jobId: rest[0].trim() };
}

function buildSpeechRequestBody(
  action: string,
  rest: string[],
  flags: Record<string, unknown>,
): Record<string, unknown> {
  const allowedByAction: Record<string, Set<string>> = {
    transcribe: new Set(['file', 'fileValueMissing', 'output', 'wait', 'waitInvalidValue', 'json', 'port']),
    status: new Set(['json', 'port']),
    wait: new Set(['json', 'port']),
    cancel: new Set(['json', 'port']),
    list: new Set(['limit', 'json', 'port']),
  };
  const allowed = allowedByAction[action];
  if (!allowed) {
    return exitAgentCliError(flags, {
      code: 'UNKNOWN_COMMAND',
      error: `Unknown speech command: ${action}`,
      suggestion: 'Inspect the published speech commands.',
      suggestedCommand: 'myagents speech --help',
    });
  }
  const unsupported = Object.keys(flags).find(key => !allowed.has(key));
  if (unsupported) {
    const displayFlag = unsupported.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`);
    return exitAgentCliError(flags, {
      code: unsupported === 'dryRun' ? 'DRY_RUN_UNSUPPORTED' : 'FLAG_UNSUPPORTED',
      error: `myagents speech ${action} does not support --${displayFlag}.`,
      suggestion: 'Session and Workspace scope are injected automatically; use only documented options.',
      suggestedCommand: `myagents speech ${action} --help`,
    });
  }
  if (action === 'transcribe') {
    const files = Array.isArray(flags.file) ? flags.file : [];
    if (flags.fileValueMissing || files.length !== 1 || typeof files[0] !== 'string' || !files[0].trim()) {
      return exitAgentCliError(flags, {
        code: 'SPEECH_FILE_COUNT_INVALID',
        error: 'speech transcribe requires exactly one --file <input>.',
        suggestion: 'Choose one local audio/video attachment in the current Workspace.',
        suggestedCommand: 'myagents speech transcribe --help',
      });
    }
    if (rest.length > 0) {
      return exitAgentCliError(flags, {
        code: 'SPEECH_ARGUMENT_UNEXPECTED',
        error: `speech transcribe does not accept positional input: ${rest.join(' ')}`,
        suggestion: 'Pass the single input through --file <input>.',
        suggestedCommand: 'myagents speech transcribe --help',
      });
    }
    if (flags.waitInvalidValue !== undefined) {
      return exitAgentCliError(flags, {
        code: 'SPEECH_WAIT_VALUE_INVALID',
        error: '--wait is a presence flag and does not accept true or false.',
        suggestion: 'Use bare --wait, or omit it for immediate acceptance.',
        suggestedCommand: 'myagents speech transcribe --help',
      });
    }
    if (flags.output !== undefined && (typeof flags.output !== 'string' || !flags.output.trim())) {
      return exitAgentCliError(flags, {
        code: 'SPEECH_OUTPUT_PATH_INVALID',
        error: '--output requires a directory path.',
        suggestion: 'Pass an output root inside the current Workspace.',
        suggestedCommand: 'myagents speech transcribe --help',
      });
    }
    const source = files[0].trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
      return exitAgentCliError(flags, {
        code: 'SPEECH_SOURCE_PATH_INVALID',
        error: 'speech transcribe accepts one local file path, not a URL.',
        suggestion: 'Choose a local attachment in the current Workspace.',
        suggestedCommand: 'myagents speech transcribe --help',
      });
    }
    const pathMod = require('path') as typeof import('path');
    return {
      sourcePath: pathMod.resolve(process.cwd(), source),
      ...(typeof flags.output === 'string'
        ? { outputRoot: pathMod.resolve(process.cwd(), flags.output.trim()) }
        : {}),
    };
  }
  if (action === 'list') {
    if (rest.length > 0) {
      return exitAgentCliError(flags, {
        code: 'SPEECH_ARGUMENT_UNEXPECTED',
        error: 'speech list does not accept positional arguments.',
        suggestedCommand: 'myagents speech list --help',
      });
    }
    const rawLimit = flags.limit ?? '20';
    const limit = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return exitAgentCliError(flags, {
        code: 'SPEECH_LIST_LIMIT_INVALID',
        error: '--limit must be an integer from 1 to 100.',
        suggestion: 'Retry with --limit 20 or another allowed value.',
        suggestedCommand: 'myagents speech list --help',
      });
    }
    return { limit };
  }
  if (rest.length !== 1 || typeof rest[0] !== 'string' || !rest[0].trim()) {
    return exitAgentCliError(flags, {
      code: 'SPEECH_JOB_ID_REQUIRED',
      error: `speech ${action} requires exactly one <job-id>.`,
      suggestion: 'Copy the exact job ID from speech list.',
      suggestedCommand: 'myagents speech list',
    });
  }
  return { jobId: rest[0].trim() };
}

function assertSupportedCronFlags(
  action: 'add' | 'update',
  flags: Record<string, unknown>,
): void {
  const shared = [
    'name',
    'prompt',
    'message',
    'promptFile',
    'schedule',
    'every',
    'runtime',
    'runtimeConfig',
    'providerId',
    'model',
    'permissionMode',
    'json',
    'help',
    'port',
  ];
  const allowed = new Set(action === 'add'
    ? [...shared, 'workspace', 'dryRun']
    : [...shared, 'id']);
  const unsupported = Object.keys(flags).find(key => !allowed.has(key));
  if (!unsupported) return;
  const displayFlag = unsupported.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`);
  exitAgentCliError(flags, {
    code: 'FLAG_UNSUPPORTED',
    error: `myagents cron ${action} does not support --${displayFlag}.`,
    suggestion: 'Retry with only the documented Cron fields; unsupported flags are never ignored.',
    suggestedCommand: 'myagents cron readme',
  });
}

export function buildRequestBody(
  group: string,
  action: string,
  rest: string[],
  flags: Record<string, unknown>,
): Record<string, unknown> {
  if (group === 'anydoc') {
    return buildAnydocRequestBody(action, rest, flags);
  }
  if (group === 'speech') {
    return buildSpeechRequestBody(action, rest, flags);
  }
  // Official image understanding tool. Unlike the user-defined CLI tool
  // registry, this is a built-in product capability backed by AppConfig model
  // settings, so it routes directly to the official vision admin handlers.
  if (group === 'vision') {
    if (action === 'readme') return {};
    if (action === 'analyze') {
      const images = [
        ...((flags.image as string[] | undefined) ?? []),
        ...rest,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (flags.promptFile !== undefined && typeof flags.promptFile !== 'string') {
        console.error('Error: --prompt-file must be a file path string.');
        process.exit(2);
      }
      if (typeof flags.prompt === 'string' && typeof flags.promptFile === 'string') {
        console.error('Error: --prompt and --prompt-file are mutually exclusive.');
        process.exit(2);
      }
      const invalidImageValue = images.find(value => value.startsWith('-'));
      if (invalidImageValue) {
        console.error(`Error: --image requires a path value; got "${invalidImageValue}".`);
        process.exit(1);
      }
      const prompt = typeof flags.prompt === 'string' ? flags.prompt : undefined;
      const promptFile = typeof flags.promptFile === 'string' ? flags.promptFile : undefined;
      if (images.length === 0) {
        console.error('Error: vision analyze requires at least one --image <path> (or positional image path).');
        process.exit(1);
      }
      return { images, prompt, promptFile };
    }
    return {};
  }

  if (group === 'goal') {
    if (action === 'get' || action === 'list') return {};
    if (action === 'create') {
      assertStringFlag(flags.objectiveFile, 'objective-file');
      if (flags.objective !== undefined || rest.length > 0) {
        console.error('Error: inline Goal objectives are not accepted; write the objective to a local text file.');
        process.exit(2);
      }
      const objective = typeof flags.objectiveFile === 'string'
        ? readTextFileFlag(flags.objectiveFile, 'objective-file').trim()
        : '';
      if (!objective) {
        console.error('Error: goal create requires --objective-file <local-path>.');
        console.error('  Usage: myagents goal create --objective-file goal-objective.txt');
        process.exit(2);
      }
      const deadline = parseGoalDeadlineFlag(flags.deadline);
      const maxExecutions = parseGoalMaxExecutionsFlag(flags.maxExecutions);
      const aiCanExit = parseGoalAiCanExitFlag(flags.aiCanExit);
      const endConditions = {
        ...(deadline !== undefined ? { deadline } : {}),
        ...(maxExecutions !== undefined ? { maxExecutions } : {}),
        ...(aiCanExit !== undefined ? { aiCanExit } : {}),
      };
      return Object.keys(endConditions).length > 0
        ? { objective, endConditions }
        : { objective };
    }
    if (action === 'update') {
      assertStringFlag(flags.status, 'status');
      assertStringFlag(flags.reasonFile, 'reason-file');
      if (flags.reason !== undefined || rest.length > 0) {
        console.error('Error: inline Goal status/reason values are not accepted; use --status and --reason-file.');
        process.exit(2);
      }
      const status = ((flags.status as string | undefined) ?? '').trim();
      if (status !== 'complete' && status !== 'blocked') {
        console.error('Error: goal update requires --status complete|blocked.');
        console.error('  Usage: myagents goal update --status complete');
        process.exit(2);
      }
      const reason = (
        typeof flags.reasonFile === 'string'
          ? readTextFileFlag(flags.reasonFile, 'reason-file')
          : ''
      ).trim();
      return { status, reason: reason || undefined };
    }
    return {};
  }

  // CLI tool registry commands (PRD 0.2.36)
  if (group === 'tool') {
    if (action === 'add') {
      // `myagents tool add <dir>` — dir is positional; --dir also accepted
      return { dir: rest[0] ?? flags.dir, dryRun: flags.dryRun };
    }
    if (action === 'env') {
      // Same surface as `mcp env`: tool env <name> set|get|delete KEY[=VALUE]...
      const toolName = rest[0];
      const subAction = rest[1] ?? 'get';
      const envPairs = rest.slice(2);
      const envInput = subAction === 'delete'
        ? envPairs.map(k => (k.includes('=') ? k : `${k}=`))
        : envPairs;
      return {
        name: toolName,
        action: subAction,
        env: parseEnvFlags(envInput.length > 0 ? envInput : (flags.env as string[] | undefined)),
      };
    }
    if (action === 'remove') {
      return { name: rest[0], purge: flags.purge };
    }
    // list / info / enable / disable / readme — single positional name (or none)
    return rest[0] ? { name: rest[0] } : {};
  }

  if (group === 'space') {
    const workspacePath = resolveSpaceWorkspacePath(flags);
    if (action === 'list') return {};
    const context = spaceCommandContext(flags, workspacePath);
    if (action === 'whoami') return context;
    if (action === 'assignee' && (rest[0] || 'list') === 'list') return context;
    if (action === 'goal' && (rest[0] || 'list') === 'list') {
      return {
        ...context,
        includeArchived: flags.includeArchived === true,
      };
    }
    if (action === 'issue') {
      const issueAction = rest[0] || 'get';
      const issueId = rest[1] || flags.issueId;
      if (issueAction === 'create') {
        const title = requireSpacePositional(
          flags,
          flags.title as string | undefined,
          'title',
          'space issue create',
          'title',
        );
        const body = resolveSpaceCommentBody(flags, workspacePath);
        if (!body.trim()) {
          return exitSpaceInputError(
            flags,
            'ISSUE_BODY_REQUIRED',
            'space issue create requires a non-empty body.',
            'Use --body-file <workspace-relative-path> for reliable multi-line content.',
          );
        }
        const hasGoal = flags.goalId !== undefined || flags.goal !== undefined;
        const goalId = hasGoal
          ? optionalSpaceStringFlag(
              flags,
              flags.goalId ?? flags.goal,
              'goal',
              'space issue create',
            )
          : undefined;
        return {
          ...context,
          title,
          body,
          goalId,
          assigneeId: flags.assignee,
          humanOnly: optionalSpaceBooleanFlag(
            flags,
            flags.humanOnly,
            'human-only',
            'space issue create',
            flags.humanOnlyInvalidValue,
            true,
          ) ?? false,
          filePaths: spaceAttachmentPaths(flags),
        };
      }
      if (issueAction === 'update') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          'space issue update',
          'issueId',
        );
        const unsupportedFlag = Object.keys(flags).find(key => ![
          'space',
          'workspacePath',
          'workspace',
          'workspaceId',
          'sessionId',
          'agentId',
          'issueId',
          'title',
          'body',
          'bodyFile',
          'stdin',
          'goal',
          'goalId',
          'clearGoal',
          'humanOnly',
          'humanOnlyInvalidValue',
          'json',
          'help',
          'port',
          'dryRun',
        ].includes(key));
        if (unsupportedFlag) {
          return exitSpaceInputError(
            flags,
            'UPDATE_FIELD_UNSUPPORTED',
            `space issue update does not accept --${unsupportedFlag}.`,
            'Use issue status/claim/comment/attachment commands for non-metadata mutations.',
          );
        }
        const hasGoal = flags.goal !== undefined || flags.goalId !== undefined;
        if (hasGoal && flags.clearGoal === true) {
          return exitSpaceInputError(
            flags,
            'GOAL_SELECTION_CONFLICT',
            'space issue update accepts either --goal <goalId> or --clear-goal, not both.',
            'Keep exactly one Goal operation and retry.',
          );
        }
        const bodySourceCount = [
          flags.body !== undefined,
          flags.bodyFile !== undefined,
          flags.stdin === true,
        ].filter(Boolean).length;
        if (bodySourceCount > 1) {
          return exitSpaceInputError(
            flags,
            'BODY_SOURCE_CONFLICT',
            'space issue update accepts only one of --body, --body-file, or --stdin.',
            'Keep exactly one body source and retry.',
          );
        }

        const title = optionalSpaceStringFlag(
          flags,
          flags.title,
          'title',
          'space issue update',
        );
        const goalId = hasGoal
          ? optionalSpaceStringFlag(
              flags,
              flags.goal ?? flags.goalId,
              'goal',
              'space issue update',
            )
          : undefined;
        if (flags.body !== undefined) {
          optionalSpaceStringFlag(flags, flags.body, 'body', 'space issue update');
        }
        if (flags.bodyFile !== undefined) {
          optionalSpaceStringFlag(flags, flags.bodyFile, 'body-file', 'space issue update');
        }
        const bareFollowerIsIssueId = rest.length === 2
          && flags.humanOnlyInvalidValue === rest[1];
        const humanOnly = optionalSpaceBooleanFlag(
          flags,
          flags.humanOnly,
          'human-only',
          'space issue update',
          bareFollowerIsIssueId ? undefined : flags.humanOnlyInvalidValue,
          true,
        );
        const hasBody = bodySourceCount === 1;
        const body = hasBody ? resolveSpaceCommentBody(flags, workspacePath) : undefined;
        if (hasBody && !body?.trim()) {
          return exitSpaceInputError(
            flags,
            'ISSUE_BODY_REQUIRED',
            'space issue update requires a non-empty body when a body source is provided.',
            'Provide non-empty text through exactly one of --body, --body-file, or --stdin.',
          );
        }
        if (
          title === undefined
          && body === undefined
          && !hasGoal
          && flags.clearGoal !== true
          && humanOnly === undefined
        ) {
          return exitSpaceInputError(
            flags,
            'ISSUE_UPDATE_EMPTY',
            'space issue update requires at least one metadata field.',
            'Run `myagents space issue update --help` and provide title, body, Goal, or human-only metadata.',
          );
        }
        return {
          ...context,
          issueId: requiredIssueId,
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(hasGoal ? { goalUpdate: { action: 'set', goalId } } : {}),
          ...(flags.clearGoal === true ? { goalUpdate: { action: 'clear' } } : {}),
          ...(humanOnly !== undefined ? { humanOnly } : {}),
        };
      }
      if (issueAction === 'list') {
        return {
          ...context,
          goalId: flags.goalId ?? flags.goal,
          state: flags.state ?? flags.status,
          includeSubtree: optionalSpaceBooleanFlag(
            flags,
            flags.includeSubtree,
            'include-subtree',
            'space issue list',
          ),
          humanOnly: optionalSpaceBooleanFlag(
            flags,
            flags.humanOnly,
            'human-only',
            'space issue list',
            flags.humanOnlyInvalidValue,
            true,
          ),
          query: flags.query ?? flags.q,
          cursor: flags.cursor,
          limit: optionalNumberFlag(flags.limit),
        };
      }
      if (issueAction === 'comments') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          'space issue comments',
          'issueId',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          cursor: flags.cursor,
          limit: optionalNumberFlag(flags.limit) ?? 20,
        };
      }
      if (issueAction === 'get' || issueAction === 'view') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          `space issue ${issueAction}`,
          'issueId',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          commentsLimit: optionalNumberFlag(flags.commentsLimit) ?? (flags.comments ? 5 : undefined),
          commentsCursor: flags.commentsCursor ?? flags.cursor,
        };
      }
      if (issueAction === 'comment') {
        if (rest[1] === 'get') {
          const requiredIssueId = requireSpacePositional(
            flags,
            (rest[2] || flags.issueId) as string | undefined,
            'issueId',
            'space issue comment get',
            'issueId',
          );
          const requiredCommentId = requireSpacePositional(
            flags,
            (rest[3] || flags.commentId) as string | undefined,
            'commentId',
            'space issue comment get',
            'commentId',
          );
          return {
            ...context,
            issueId: requiredIssueId,
            commentId: requiredCommentId,
          };
        }
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          'space issue comment',
          'issueId',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          body: resolveSpaceCommentBody(flags, workspacePath),
          filePaths: spaceAttachmentPaths(flags),
        };
      }
      if (issueAction === 'status') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          'space issue status',
          'issueId',
        );
        const state = rest[2] || flags.state || flags.status;
        const requiredState = requireSpacePositional(
          flags,
          state as string | undefined,
          'state',
          'space issue status',
          'state',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          state: requiredState,
        };
      }
      if (issueAction === 'claim') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          'space issue claim',
          'issueId',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          deliveryId: flags.deliveryId,
        };
      }
      if (issueAction === 'attachment' && rest[1] === 'add') {
        const requiredIssueId = requireSpacePositional(
          flags,
          (rest[2] || flags.issueId) as string | undefined,
          'issueId',
          'space issue attachment add',
          'issueId',
        );
        const filePaths = spaceAttachmentPaths(flags);
        if (filePaths.length === 0) {
          return exitSpaceInputError(
            flags,
            'ATTACHMENT_REQUIRED',
            'space issue attachment add requires --file <path>.',
            'Add one or more workspace files with repeated --file flags.',
          );
        }
        return { ...context, issueId: requiredIssueId, filePaths };
      }
      if (issueAction === 'close' || issueAction === 'complete' || issueAction === 'cancel-claim') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          `space issue ${issueAction}`,
          'issueId',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          ...(issueAction === 'cancel-claim'
            ? {
                rollback: truthyCliFlag(flags.rollback),
                expectedNotificationVersion: optionalNumberFlag(flags.expectedNotificationVersion),
              }
            : {}),
          filePaths: issueAction === 'complete'
            ? spaceAttachmentPaths(flags)
            : [],
        };
      }
    }
    if (action === 'claim') {
      const claimAction = rest[0] || '';
      if (claimAction === 'local-task') {
        const claimId = requireSpacePositional(
          flags,
          (rest[1] || flags.claimId) as string | undefined,
          'claimId',
          'space claim local-task',
          'claimId',
        );
        const localTaskId = requireSpacePositional(
          flags,
          flags.localTaskId as string | undefined,
          'localTaskId',
          'space claim local-task',
          'localTaskId',
        );
        const localSessionId = requireSpacePositional(
          flags,
          (flags.localSessionId ?? process.env.MYAGENTS_SESSION_ID) as string | undefined,
          'localSessionId',
          'space claim local-task',
          'localSessionId',
        );
        return {
          ...context,
          claimId,
          localTaskId,
          localSessionId,
        };
      }
    }
    if (action === 'attachment') {
      const attachmentAction = rest[0] || 'download';
      if (attachmentAction === 'download') {
        const attachmentId = requireSpacePositional(
          flags,
          (rest[1] || flags.attachmentId) as string | undefined,
          'attachmentId',
          'space attachment download',
          'attachmentId',
        );
        return {
          ...context,
          attachmentId,
          issueId: flags.issueId,
          output: flags.output,
        };
      }
      if (attachmentAction === 'add' || attachmentAction === 'inspect') {
        const filePaths = spaceAttachmentPaths(flags);
        if (filePaths.length === 0) {
          return exitSpaceInputError(
            flags,
            'ATTACHMENT_REQUIRED',
            `space attachment ${attachmentAction} requires --file <path>.`,
            'Add one or more workspace files with repeated --file flags.',
          );
        }
        return {
          ...context,
          issueId: rest[1] || flags.issueId || '',
          filePaths,
        };
      }
    }
    return {};
  }

  if (group === 'issue') {
    const workspacePath = resolveSpaceWorkspacePath(flags);
    const context = spaceCommandContext(flags, workspacePath);
    if (action === 'comment' || action === 'comments' || action === 'status') {
      return exitSpaceInputError(
        flags,
        'COMMAND_MOVED',
        `myagents issue only reads an Issue; "${action}" is not supported by this alias.`,
        `Use myagents space issue ${action} ... with an explicit --space <slug>.`,
      );
    }
    const positionalIssueId = action === 'list' || action === 'get' ? rest[0] : action;
    const issueId = requireSpacePositional(
      flags,
      (positionalIssueId ?? flags.issueId) as string | undefined,
      'issueId',
      'issue',
      'issueId',
    );
    return {
      ...context,
      issueId,
      commentsLimit: optionalNumberFlag(flags.commentsLimit),
      commentsCursor: flags.commentsCursor ?? flags.cursor,
    };
  }

  // MCP commands
  if (group === 'mcp') {
    if (action === 'add') {
      return {
        server: {
          id: flags.id,
          name: flags.name,
          type: flags.type || 'stdio',
          command: flags.command,
          args: flags.args,
          url: flags.url,
          env: parseEnvFlags(flags.env as string[] | undefined),
          headers: parseEnvFlags(flags.headers as string[] | undefined),
          description: flags.description,
        },
        dryRun: flags.dryRun,
      };
    }
    if (action === 'remove' || action === 'enable' || action === 'disable' || action === 'test') {
      return { id: rest[0] || flags.id, scope: flags.scope };
    }
    if (action === 'show') {
      return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'mcp-id', 'mcp show', 'id') };
    }
    if (action === 'oauth') {
      const oauthAction = rest[0] || 'status'; // discover | start | status | revoke
      const serverId = rest[1] || (flags.id as string);
      if (!serverId) return { id: undefined }; // will trigger missing field error
      if (oauthAction === 'start') {
        return {
          id: serverId,
          clientId: flags.clientId,
          clientSecret: flags.clientSecret,
          scopes: flags.scopes,
          callbackPort: flags.callbackPort ? Number(flags.callbackPort) : undefined,
        };
      }
      return { id: serverId };
    }
    if (action === 'env') {
      const serverId = rest[0];
      const subAction = rest[1]; // set | get | delete
      const envPairs = rest.slice(2);
      // For 'delete', bare keys (no =value) are valid — convert to KEY=1 for parseEnvFlags
      const envInput = subAction === 'delete'
        ? envPairs.map(k => k.includes('=') ? k : `${k}=`)
        : envPairs;
      return {
        id: serverId,
        action: subAction,
        env: parseEnvFlags(envInput.length > 0 ? envInput : flags.env as string[] | undefined),
      };
    }
    return {};
  }

  // Model commands
  if (group === 'model') {
    if (action === 'set-key') return { id: rest[0] || flags.id, apiKey: rest[1] || flags.apiKey };
    if (action === 'verify') return { id: rest[0] || flags.id, model: flags.model };
    if (action === 'set-default') return { id: rest[0] || flags.id };
    if (action === 'add') {
      // Structure the provider object from flags
      const provider: Record<string, unknown> = {
        id: flags.id,
        name: flags.name,
        baseUrl: flags.baseUrl,
        models: flags.models,           // array (repeatable)
        modelNames: flags.modelNames,   // array (repeatable)
        modelSeries: flags.modelSeries,
        primaryModel: flags.primaryModel,
        authType: flags.authType,
        apiProtocol: flags.protocol,    // --protocol maps to apiProtocol
        upstreamFormat: flags.upstreamFormat,
        maxOutputTokens: flags.maxOutputTokens,
        vendor: flags.vendor,
        websiteUrl: flags.websiteUrl,
        timeout: flags.timeout,
        disableNonessential: flags.disableNonessential,
      };
      // Build aliases from --aliases sonnet=model-id,opus=model-id
      if (typeof flags.aliases === 'string') {
        const aliases: Record<string, string> = {};
        for (const pair of (flags.aliases as string).split(',')) {
          const [k, v] = pair.split('=');
          if (k && v) aliases[k.trim()] = v.trim();
        }
        provider.aliases = aliases;
      }
      return { provider, dryRun: flags.dryRun };
    }
    if (action === 'remove') return { id: rest[0] || flags.id };
    return {};
  }

  // Agent commands
  if (group === 'agent') {
    if (action === 'list') {
      if (flags.archived && flags.active) {
        throw new Error('agent list accepts only one lifecycle filter: use --active or --archived, not both.');
      }
      return {
        lifecycle: flags.archived ? 'archived' : 'active',
      };
    }
    if (action === 'enable' || action === 'disable' || action === 'archive' || action === 'unarchive') return { id: rest[0] || flags.id };
    if (action === 'show') return {
      agentId: requirePositional(
        rest[0] ?? (flags.agentId as string | undefined) ?? (flags.id as string | undefined),
        'agentId',
        'agent show',
        'agent',
      ),
    };
    if (action === 'current') return {};
    if (action === 'set') return { id: rest[0], key: rest[1], value: tryParseJson(rest[2]) };
    if (action === 'channel') {
      const channelAction = rest[0] || 'list'; // list | add | remove
      if (channelAction === 'list') return { agentId: rest[1] || flags.agentId };
      if (channelAction === 'add') return { agentId: rest[1] || flags.agentId, channel: stripGlobalFlags(flags) };
      if (channelAction === 'remove') return { agentId: rest[1], channelId: rest[2] };
      return { agentId: rest[1] };
    }
    return {};
  }

  // Runtime discovery commands (v0.1.69+): `myagents runtime list|describe`
  // Pure query endpoints — no body mutation — meant to be consulted BEFORE
  // choosing values for `task create-direct --runtime/--model/...`.
  if (group === 'runtime') {
    if (action === 'list') return {};
    if (action === 'describe') return { runtime: requirePositional(rest[0] ?? (flags.runtime as string | undefined), 'runtime', 'runtime describe', 'runtime') };
    if (action === 'diagnose') return {
      runtime: requirePositional(rest[0] ?? (flags.runtime as string | undefined), 'runtime', 'runtime diagnose', 'runtime'),
      workspacePath: flags.workspacePath,
    };
    return {};
  }
  // Sugar form: `myagents diagnose runtime <type>` (issue #194).
  if (group === 'diagnose' && action === 'runtime') {
    return {
      runtime: requirePositional(rest[0] ?? (flags.runtime as string | undefined), 'runtime', 'diagnose runtime', 'runtime'),
      workspacePath: flags.workspacePath,
    };
  }

  // Cron commands
  if (group === 'cron') {
    if (action === 'add') {
      assertSupportedCronFlags(action, flags);
      return {
        name: flags.name,
        message: resolveCronPromptText(flags),
        workspacePath: flags.workspace,
        schedule: normalizeScheduleFlag(flags.schedule, { fillMissingCronTimezone: true }),
        intervalMinutes: flags.every ? Number(flags.every) : undefined,
        runtime: flags.runtime,
        runtimeConfig: parseRuntimeConfigFlag(flags.runtimeConfig),
        providerId: flags.providerId,
        model: flags.model,
        permissionMode: flags.permissionMode,
        // Forward --dry-run so the admin handler can return a preview
        // instead of writing to the cron store. Issue #149.
        dryRun: flags.dryRun,
      };
    }
    if (action === 'exit') {
      return { reason: flags.reason || rest[0] };
    }
    if (action === 'readme') {
      return {}; // no body
    }
    if (action === 'start' || action === 'stop' || action === 'remove' || action === 'run-now') {
      return { taskId: rest[0] || flags.id };
    }
    if (action === 'update') {
      assertSupportedCronFlags(action, flags);
      // Map CLI flags to Rust field names expected by update_task_fields
      const patch: Record<string, unknown> = {};
      if (flags.name !== undefined) patch.name = flags.name;
      const updatePrompt = resolveCronPromptText(flags);
      if (updatePrompt !== undefined) patch.prompt = updatePrompt;
      if (flags.schedule !== undefined) patch.schedule = normalizeScheduleFlag(flags.schedule);
      if (flags.every !== undefined) patch.intervalMinutes = Number(flags.every);
      if (flags.runtime !== undefined) patch.runtime = flags.runtime;
      if (flags.runtimeConfig !== undefined) patch.runtimeConfig = parseRuntimeConfigFlag(flags.runtimeConfig);
      if (flags.providerId !== undefined) patch.providerId = flags.providerId;
      if (flags.model !== undefined) patch.model = flags.model;
      if (flags.permissionMode !== undefined) patch.permissionMode = flags.permissionMode;
      if (Object.keys(patch).length === 0) {
        console.error('Error: cron update requires at least one update option.');
        process.exit(2);
      }
      return { taskId: rest[0] || flags.id, patch };
    }
    if (action === 'runs') {
      return { taskId: rest[0] || flags.id, limit: flags.limit ? Number(flags.limit) : undefined };
    }
    if (action === 'list' || action === 'status') {
      return { workspacePath: flags.workspace };
    }
    return {};
  }

  // IM runtime commands — session-scoped, only work inside an IM Bot session
  if (group === 'im') {
    if (action === 'send-media') {
      return {
        filePath: resolveImMediaFilePath(flags, rest[0]),
        caption: flags.caption,
      };
    }
    if (action === 'wake') {
      return { text: flags.text || rest[0] };
    }
    if (action === 'channels') {
      return {};
    }
    if (action === 'readme') {
      return {};
    }
    return {};
  }

  // Generative UI widget readme. Accept any of:
  //   myagents widget                         → action='list',    rest=[]           → modules=[]
  //   myagents widget readme                  → action='readme',  rest=[]           → modules=[]
  //   myagents widget readme chart            → action='readme',  rest=['chart']    → modules=['chart']
  //   myagents widget readme chart interactive → rest=['chart','interactive']       → modules=['chart','interactive']
  //   myagents widget chart                   → action='chart',   rest=[]           → modules=['chart']
  //   myagents widget chart interactive       → action='chart',   rest=['interactive'] → modules=['chart','interactive']
  // Modules = positional args AFTER `widget`, minus any leading `readme`/`list` keyword.
  if (group === 'widget') {
    const candidates = [action, ...rest].filter(Boolean);
    const modules = candidates[0] === 'readme' || candidates[0] === 'list'
      ? candidates.slice(1)
      : candidates;
    return { modules };
  }

  // Plugin commands
  if (group === 'plugin') {
    if (action === 'install') return { npmSpec: rest[0] || flags.npmSpec };
    if (action === 'remove') return { pluginId: rest[0] || flags.pluginId };
    return {};
  }

  // Claude Plugin commands (PRD 0.2.17). Separate group from the OpenClaw
  // channel-plugin `plugin` above — different concept, different storage.
  if (group === 'cc-plugin') {
    if (action === 'install') {
      return {
        sourceUrl: rest[0] || flags.sourceUrl || flags.url,
      };
    }
    if (action === 'uninstall') {
      return {
        // Allow either positional name or full id via flag
        id: flags.id,
        name: rest[0],
        purgeData: !!flags.purgeData,
      };
    }
    if (action === 'enable' || action === 'disable') {
      return { id: flags.id, name: rest[0] };
    }
    if (action === 'show') {
      return { id: rest[0] || flags.id };
    }
    if (action === 'list') {
      return {};
    }
    return {};
  }

  // Skill commands
  if (group === 'skill') {
    if (action === 'add') {
      const source = rest[0] || flags.url;
      return {
        url: typeof source === 'string' ? normalizeSkillSourceForRequest(source) : source,
        scope: (flags.scope as string) || 'user',
        plugin: flags.plugin,
        skill: flags.skill,
        force: !!flags.force,
        dryRun: !!flags.dryRun,
      };
    }
    if (action === 'remove' || action === 'info' || action === 'enable' || action === 'disable') {
      return { name: rest[0] || flags.name, scope: (flags.scope as string) || 'user' };
    }
    if (action === 'list' || action === 'sync') {
      return {};
    }
    return {};
  }

  // Config commands
  if (group === 'config') {
    if (action === 'get') return { key: rest[0] || flags.key };
    if (action === 'set') return { key: rest[0] || flags.key, value: tryParseJson(rest[1] ?? String(flags.value ?? '')), dryRun: flags.dryRun };
    return {};
  }

  // Task Center (v0.1.69) — covers all `myagents task <action>` subcommands.
  //
  // Caller provenance is internal CLI metadata, never a user-settable flag.
  // The CLI process can observe its own Session identity; the Sidecar process
  // cannot infer that from its server environment.
  if (group === 'task') {
    if (action === 'list') {
      assertStringFlag(flags.workspaceId, 'workspaceId');
      assertStringFlag(flags.status, 'status');
      assertStringFlag(flags.tag, 'tag');
      assertStringFlag(flags.query, 'query');
      assertStringFlag(flags.limit, 'limit');
      const limit = flags.limit === undefined ? undefined : Number(flags.limit);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) {
        console.error('Error: task list --limit must be an integer from 1 to 200.');
        process.exit(2);
      }
      return {
        workspaceId: flags.workspaceId,
        status: flags.status,
        tag: flags.tag,
        query: flags.query,
        limit,
        includeDeleted: flags.includeDeleted,
      };
    }
    if (action === 'get') return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'task-id', 'task get', 'id') };
    if (action === 'comments') {
      const limit = flags.limit === undefined ? undefined : Number(flags.limit);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
        console.error('Error: task comments --limit must be an integer from 1 to 100.');
        process.exit(2);
      }
      return {
        id: requirePositional(
          rest[0] ?? (flags.id as string | undefined),
          'task-id',
          'task comments',
          'id',
        ),
        before: flags.before,
        limit,
      };
    }
    if (action === 'comment') {
      const id = rest[0] ?? (flags.id as string | undefined) ?? process.env.MYAGENTS_TASK_ID;
      if (!process.env.MYAGENTS_SESSION_ID?.trim()) {
        console.error('Error: task comment requires MYAGENTS_SESSION_ID and must run inside an associated Task Session.');
        process.exit(2);
      }
      return {
        // The Sidecar resolves an omitted ID from the exact active Task-turn
        // context. Outside that turn (for example, a later user-comment
        // injection) the hidden reminder supplies the explicit Task ID.
        id: id?.trim() || undefined,
        body: resolveTaskCommentBody(flags),
        replyToCommentId: flags.replyTo,
      };
    }
    if (action === 'update-status') {
      return {
        id: rest[0],
        status: rest[1],
        message: flags.message,
        ...taskCliCaller(),
      };
    }
    if (action === 'append-session') {
      return { id: rest[0], sessionId: rest[1] || flags.sessionId };
    }
    if (action === 'archive') return {
      id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'task-id', 'task archive', 'id'),
      message: flags.message,
      ...taskCliCaller(),
    };
    if (action === 'readme') return {};
    if (action === 'exit') {
      assertStringFlag(flags.reason, 'reason');
      return { reason: flags.reason || rest[0] };
    }
    if (action === 'start' || action === 'stop') {
      assertStringFlag(flags.id, 'id');
      return {
        taskId: requirePositional(
          rest[0] ?? (flags.id as string | undefined),
          'task-id',
          `task ${action}`,
          'id',
        ),
        ...taskCliCaller(),
      };
    }
    if (action === 'runs') {
      assertStringFlag(flags.id, 'id');
      assertStringFlag(flags.limit, 'limit');
      const limit = flags.limit === undefined ? undefined : Number(flags.limit);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        console.error('Error: task runs --limit must be a positive integer.');
        process.exit(2);
      }
      return {
        taskId: requirePositional(
          rest[0] ?? (flags.id as string | undefined),
          'task-id',
          'task runs',
          'id',
        ),
        limit,
      };
    }
    // `remove` is the cron-side vocabulary for the same operation; before this
    // alias the CLI accepted `task remove` and forwarded to a non-existent
    // /api/admin/task/remove route, leaving the user with an opaque "Unknown
    // admin route" error (issue #205 gap #4). Accept both so AI / users who
    // generalized from `cron remove` don't hit a dead end.
    if (action === 'delete' || action === 'remove') return {
      id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'task-id', `task ${action}`, 'id'),
      ...taskCliCaller(),
    };
    if (action === 'trigger') {
      const triggerAction = rest[0];
      if (triggerAction === 'validate') {
        return { trigger: resolveTaskTriggerFile(flags.specFile, '--spec-file') };
      }
      if (triggerAction === 'test') {
        const taskId = rest[1] ?? (flags.id as string | undefined);
        const hasSpec = flags.specFile !== undefined;
        if (!!taskId === hasSpec) {
          console.error('Error: task trigger test requires exactly one of <taskId> or --spec-file.');
          process.exit(2);
        }
        const body: Record<string, unknown> = hasSpec
          ? {
            trigger: resolveTaskTriggerFile(flags.specFile, '--spec-file'),
            workspacePath: requireNonEmptyStringFlag(
              flags.workspacePath,
              'workspacePath',
              'task trigger test --spec-file',
            ),
          }
          : { taskId };
        if (
          flags.expect !== undefined
          && flags.expect !== 'quiet'
          && flags.expect !== 'activate'
        ) {
          console.error('Error: --expect must be quiet or activate.');
          process.exit(2);
        }
        if (flags.checkpointFile !== undefined) {
          body.checkpoint = resolveTaskCheckpointFile(flags.checkpointFile);
        }
        if (flags.expect !== undefined) body.expect = flags.expect;
        return body;
      }
      console.error('Error: task trigger supports validate or test.');
      process.exit(2);
    }
    if (action === 'check-now' || action === 'reset-checkpoint') {
      return {
        id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'task-id', `task ${action}`, 'id'),
      };
    }
    if (action === 'create-direct') {
      assertStringFlag(flags.name, 'name');
      // Resolve task.md body: `--taskMdFile` (industry-standard for long
      // text — avoids shell-escape hell for multi-line / backtick / quoted
      // markdown) takes precedence over `--taskMdContent` when both are
      // set. Mirrors the `cron add --prompt-file` pattern above.
      const taskMdContent = resolveTaskMdContent(flags);
      const taskMdFile = flags.taskMdFile ?? flags.taskMdContentFile;
      const executionMode = (flags.executionMode as string | undefined) ?? 'once';
      const preselectedSessionId = resolvePreselectedSessionId(flags.preselectedSessionId, flags);
      validateTaskSessionBinding(flags.runMode, preselectedSessionId, flags);
      maybeWarnRecurringWithoutInterval(executionMode, flags);
      const cronExpression = typeof flags.cronExpression === 'string' ? flags.cronExpression : undefined;
      const cronTimezone = typeof flags.cronTimezone === 'string'
        ? flags.cronTimezone
        : (executionMode === 'recurring' && cronExpression?.trim() ? resolveLocalTimezone() : undefined);
      const endConditions = buildTaskEndConditions(flags);
      return {
        name: rest[0] || flags.name,
        executor: flags.executor ?? 'agent',
        description: flags.description,
        workspaceId: flags.workspaceId,
        workspacePath: flags.workspacePath,
        taskMdContent,
        taskMdFile: typeof taskMdFile === 'string' ? taskMdFile : undefined,
        executionMode,
        runMode: flags.runMode,
        ...(endConditions !== undefined ? { endConditions } : {}),
        preselectedSessionId,
        trigger: flags.triggerFile !== undefined
          ? resolveTaskTriggerFile(flags.triggerFile)
          : undefined,
        sourceRecordId: flags.sourceRecordId,
        tags: typeof flags.tags === 'string'
          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
        // Scheduling-detail fields the Rust TaskCreateDirectInput already
        // accepts. Before issue #205 the CLI parser dropped them on
        // create-direct, forcing every
        // recurring task to default to 60 min and every cron / dispatchAt
        // schedule to be set via GUI afterward.
        intervalMinutes: parseIntervalMinutesFlag(flags.intervalMinutes),
        cronExpression,
        cronTimezone,
        dispatchAt: parseDispatchAtFlag(flags.dispatchAt),
        startAt: parseZonedInstantFlag(flags.startAt, 'startAt'),
        notification: buildNotificationFromFlags(flags),
        // Per-task runtime overrides. Admin-api validates these before
        // forwarding to Rust — if the caller mistypes a value, they get a
        // recovery hint pointing to `runtime list` / `runtime describe`.
        runtime: flags.runtime,
        providerId: flags.providerId,
        model: flags.model,
        permissionMode: flags.permissionMode,
        runtimeConfig: parseRuntimeConfigFlag(flags.runtimeConfig),
        mcpEnabledServers: parseMcpEnabledServersFlag(flags.mcpEnabledServers),
        ...taskCliCaller(),
      };
    }
    if (action === 'create-attached') {
      assertStringFlag(flags.name, 'name');
      const currentSessionId =
        typeof flags.currentSessionId === 'string' && flags.currentSessionId.trim()
          ? flags.currentSessionId.trim()
          : process.env.MYAGENTS_SESSION_ID;
      if (!currentSessionId) {
        console.error('Error: task create-attached requires MYAGENTS_SESSION_ID. Run it from inside a MyAgents AI session.');
        process.exit(2);
      }
      const source = (flags.source as string | undefined) ?? 'space-issue';
      if (source !== 'space-issue') {
        console.error(`Error: task create-attached --source currently supports only "space-issue" (got "${source}")`);
        process.exit(2);
      }
      const workspaceId = requireNonEmptyStringFlag(
        flags.workspaceId,
        'workspaceId',
        'task create-attached',
      );
      const workspacePath = requireNonEmptyStringFlag(
        flags.workspacePath,
        'workspacePath',
        'task create-attached',
      );
      const sourceIssueId = requireNonEmptyStringFlag(
        flags.sourceIssueId,
        'sourceIssueId',
        'task create-attached',
      );
      const taskMdContent = resolveTaskMdContent(flags);
      if (typeof taskMdContent !== 'string' || !taskMdContent.trim()) {
        console.error('Error: task create-attached requires --taskMdFile, --taskMdContentFile, or --taskMdContent');
        process.exit(2);
      }
      return {
        name: rest[0] || flags.name,
        executor: flags.executor ?? 'agent',
        description: flags.description,
        workspaceId,
        workspacePath,
        taskMdContent,
        currentSessionId,
        source,
        sourceSpaceId: flags.sourceSpaceId,
        sourceIssueId,
        sourceClaimId: flags.sourceClaimId,
        sourceDeliveryId: flags.sourceDeliveryId,
        tags: typeof flags.tags === 'string'
          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
        notification: buildNotificationFromFlags(flags),
      };
    }
    if (action === 'update') {
      // Patch shape mirrors `create-direct`: the same flag set, but every
      // field is optional. Rust `TaskUpdateInput` treats `None` as
      // "leave unchanged" except for the explicit clear-override flags
      // (`clearProviderOverride` / `clearRuntimeOverride` /
      // `clearMcpOverride`), which the CLI
      // exposes for the AI's "reset to follow Agent" intent.
      const id = requirePositional(rest[0] ?? (flags.id as string | undefined), 'task-id', 'task update', 'id');
      // `--taskMdFile` / `--taskMdContent` map to TaskUpdateInput.prompt
      // (Rust writes the body to task.md atomically under the row's write
      // lock). Reuse the create-side helper so size / NUL / file-not-found
      // errors stay consistent.
      const promptFromTaskMd =
        flags.taskMdFile !== undefined || flags.taskMdContent !== undefined
          ? resolveTaskMdContent(flags)
          : undefined;
      const executionMode = flags.executionMode as string | undefined;
      if (executionMode) maybeWarnRecurringWithoutInterval(executionMode, flags);
      const body: Record<string, unknown> = { id };
      const preselectedSessionId = resolvePreselectedSessionId(flags.preselectedSessionId, flags);
      if (flags.runMode !== undefined || preselectedSessionId !== undefined) {
        validateTaskSessionBinding(flags.runMode, preselectedSessionId, flags, false);
      }
      if (flags.name !== undefined) body.name = flags.name;
      if (flags.executor !== undefined) body.executor = flags.executor;
      if (flags.description !== undefined) body.description = flags.description;
      if (executionMode !== undefined) body.executionMode = executionMode;
      if (flags.runMode !== undefined) body.runMode = flags.runMode;
      if (flags.preselectedSessionId !== undefined) {
        body.preselectedSessionId = preselectedSessionId;
      }
      if (flags.triggerFile !== undefined) body.trigger = resolveTaskTriggerFile(flags.triggerFile);
      if (flags.clearTrigger) body.clearTrigger = true;
      if (flags.intervalMinutes !== undefined) body.intervalMinutes = parseIntervalMinutesFlag(flags.intervalMinutes);
      if (flags.cronExpression !== undefined) body.cronExpression = flags.cronExpression;
      if (flags.cronTimezone !== undefined) body.cronTimezone = flags.cronTimezone;
      if (flags.dispatchAt !== undefined) body.dispatchAt = parseDispatchAtFlag(flags.dispatchAt);
      if (flags.startAt !== undefined) body.startAt = parseZonedInstantFlag(flags.startAt, 'startAt');
      if (flags.model !== undefined) body.model = flags.model;
      if (flags.providerId !== undefined) body.providerId = flags.providerId;
      if (flags.clearProviderOverride) body.clearProviderOverride = true;
      if (flags.permissionMode !== undefined) body.permissionMode = flags.permissionMode;
      if (flags.runtime !== undefined) body.runtime = flags.runtime;
      if (flags.runtimeConfig !== undefined) body.runtimeConfig = parseRuntimeConfigFlag(flags.runtimeConfig);
      if (flags.clearRuntimeOverride) body.clearRuntimeOverride = true;
      if (flags.mcpEnabledServers !== undefined) body.mcpEnabledServers = parseMcpEnabledServersFlag(flags.mcpEnabledServers);
      if (flags.clearMcpOverride) body.clearMcpOverride = true;
      if (typeof flags.tags === 'string') {
        body.tags = (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean);
      }
      const notification = buildNotificationFromFlags(flags);
      // Rust merges this field-level patch under the authoritative Task lock.
      if (notification !== undefined) body.notificationPatch = notification;
      if (promptFromTaskMd !== undefined) body.prompt = promptFromTaskMd;
      return body;
    }
    if (action === 'run' || action === 'run-now' || action === 'rerun') {
      return {
        id: requirePositional(
          rest[0] ?? (flags.id as string | undefined),
          'task-id',
          `task ${action}`,
          'id',
        ),
        ...taskCliCaller(),
      };
    }
    return {};
  }

  // Canonical Record CLI plus the published Thought compatibility alias.
  if (group === 'record' || group === 'thought') {
    if (action === 'list') {
      if (group === 'thought' && flags.kind !== undefined) {
        console.error('Error: thought list does not support --kind. Use myagents record list --kind text|audio.');
        process.exit(1);
      }
      const kind = typeof flags.kind === 'string' ? flags.kind : undefined;
      if (group === 'record' && kind !== undefined && kind !== 'text' && kind !== 'audio') {
        console.error('Error: record list --kind must be text or audio.');
        process.exit(1);
      }
      return {
        kind: group === 'record' ? kind : undefined,
        tag: flags.tag,
        query: flags.query,
        limit: flags.limit ? Number(flags.limit) : undefined,
        archived: flags.archived ? 'archived' : flags.all ? 'all' : undefined,
      };
    }
    if (action === 'create') {
      // Issue #149: on Windows the AI-emitted text-Record create command
      // sometimes loses the positional argument (root cause not reproducible
      // from macOS — likely a shell-quoting interaction in
      // git-bash → cmd.exe → node argv). The result was a silent
      // `{ content: undefined }` → JSON.stringify drops the field → Rust 422
      // "missing field `content`". Two layers of defense added here:
      //   1. `--content-file <path>` reads the body from a file on disk —
      //      bypasses every shell quoting issue, mirrors `cron add`'s
      //      `--prompt-file` (which exists for the exact same reason).
      //   2. Reject empty content at the CLI boundary with an actionable
      //      error pointing at --content-file, so the AI can self-recover
      //      on retry instead of routing through an opaque server 422.
      let contentText: string | undefined =
        (typeof flags.content === 'string' ? flags.content : undefined) ?? rest.join(' ');
      if (flags.contentFile && typeof flags.contentFile === 'string') {
        try {
          // Lazy-require keeps the cold path short for other commands.
          const fs = require('fs') as typeof import('fs');
          const MAX_BYTES = 1024 * 1024; // 1 MB — pathological for a text Record
          const stat = fs.statSync(flags.contentFile);
          if (stat.size > MAX_BYTES) {
            console.error(`Error: --content-file "${flags.contentFile}" is ${stat.size} bytes, exceeds ${MAX_BYTES} (1 MB) limit`);
            process.exit(1);
          }
          const raw = fs.readFileSync(flags.contentFile, 'utf-8');
          if (raw.includes('\0')) {
            console.error(`Error: --content-file "${flags.contentFile}" contains NUL bytes (is this a binary file?)`);
            process.exit(1);
          }
          contentText = raw;
        } catch (err) {
          console.error(`Error: failed to read --content-file "${flags.contentFile}": ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }
      const trimmed = contentText?.trim() ?? '';
      if (!trimmed) {
        console.error(`Error: ${group} create requires non-empty content. Pass it as a positional arg, --content "<text>", or --content-file <path>.`);
        console.error('  → Tip: shells with quirky quoting (Windows / pwsh) drop quoted args sometimes — write the text to a file and pass --content-file.');
        process.exit(1);
      }
      return { content: trimmed };
    }
    if (group === 'thought' && action === 'readme') return {}; // legacy readme
    return {};
  }

  // ===== Agent / Session collaboration (PRD 0.4.3) =====
  if (group === 'session') {
    if (action === 'list') {
      const agentId = typeof flags.agent === 'string' && flags.agent.trim()
        ? flags.agent.trim()
        : typeof flags.agentId === 'string' && flags.agentId.trim()
          ? flags.agentId.trim()
          : '';
      if (!agentId) {
        console.error('Error: session list requires --agent <agentId>.');
        console.error('  → Run: myagents agent list');
        process.exit(3);
      }
      const limit = flags.limit === undefined ? 5 : Number(flags.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        console.error('Error: session list --limit must be an integer from 1 to 50.');
        process.exit(3);
      }
      if (rest.length > 0) {
        console.error('Error: session list accepts Agent identity only through --agent <agentId>.');
        process.exit(3);
      }
      return { agentId, limit };
    }
    if (action === 'start') {
      const agentId = typeof flags.agent === 'string' && flags.agent.trim()
        ? flags.agent.trim()
        : typeof flags.agentId === 'string' && flags.agentId.trim()
          ? flags.agentId.trim()
          : '';
      if (!agentId) {
        console.error('Error: session start requires --agent <agentId>.');
        console.error('  → Run: myagents agent list');
        process.exit(3);
      }
      if (rest.length > 0) {
        console.error('Error: session start accepts Agent identity only through --agent <agentId>.');
        process.exit(3);
      }
      return {
        agentId,
        prompt: resolveSessionPromptText(flags, 'start'),
        replyBack: !flags.noReply,
      };
    }
    if (action === 'send') {
      // Positional: <sessionId>
      // Flags: -p / --prompt | --prompt-file (mutually exclusive), --no-reply
      const toSessionId = requirePositional(
        rest[0] ?? (flags.toSessionId as string | undefined) ?? (flags.to as string | undefined),
        'sessionId',
        'session send',
        'toSessionId',
      );

      return {
        toSessionId,
        prompt: resolveSessionPromptText(flags, 'send'),
        replyBack: !flags.noReply,
      };
    }
    if (action === 'watch') {
      const targetSessionId = requirePositional(
        rest[0] ?? (flags.targetSessionId as string | undefined) ?? (flags.to as string | undefined),
        'sessionId',
        'session watch',
        'targetSessionId',
      );
      const unsupportedFlag = ['prompt', 'promptFile', 'then', 'thenFile', 'thenPrompt', 'thenPromptFile']
        .find((key) => flags[key] !== undefined);
      if (unsupportedFlag) {
        console.error('Error: session watch does not accept prompt/then flags. Use `myagents session send` to ask the target session to do new work.');
        process.exit(3);
      }
      if (rest.length > 1) {
        console.error('Error: session watch accepts exactly one <sessionId> argument.');
        process.exit(3);
      }
      return { targetSessionId };
    }
    return {};
  }

  return flags;
}

/**
 * The Sidecar cannot observe the shell caller's cwd. Resolve only explicit
 * relative path forms here; ambiguous `owner/repo` remains GitHub shorthand.
 */
export function normalizeSkillSourceForRequest(source: string, cwd = process.cwd()): string {
  const trimmed = source.trim();
  const pathMod = require('path') as typeof import('path');
  if (/^\.\.?[\\/]/.test(trimmed)) {
    return pathMod.resolve(cwd, trimmed);
  }

  // Preserve the established pasted-command surface while moving only its
  // explicit local positional source across the CLI→Sidecar cwd boundary.
  const wrapped = trimmed.match(
    /^(npx(?:\s+-y)?\s+skills\s+(?:add|install)\s+)(\.\.?[\\/][^\s]+)([\s\S]*)$/i,
  );
  if (wrapped) {
    return `${wrapped[1]}${pathMod.resolve(cwd, wrapped[2])}${wrapped[3]}`;
  }
  return source;
}

/** Parse KEY=VALUE pairs from --env flags */
function parseEnvFlags(envPairs: string[] | undefined): Record<string, string> | undefined {
  if (!envPairs || envPairs.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const pair of envPairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Strip CLI-global flags that should not be persisted into config data */
function stripGlobalFlags(flags: Record<string, unknown>): Record<string, unknown> {
  const globalKeys = new Set(['json', 'dryRun', 'help', 'port', 'workspacePath']);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (!globalKeys.has(k)) result[k] = v;
  }
  return result;
}

/** Try to parse a string as JSON, otherwise return as-is */
function tryParseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Normalize `--schedule` into a CronSchedule object.
 *
 * Accepted forms:
 *   - Cron expression string (legacy, most common):
 *       --schedule "*\/30 * * * *"
 *     → { kind: 'cron', expr: "*\/30 * * * *" }
 *
 *   - JSON object matching CronSchedule (the internal wire shape):
 *       --schedule '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}'
 *       --schedule '{"kind":"every","minutes":30}'
 *       --schedule '{"kind":"cron","expr":"0 9 * * *","tz":"Asia/Shanghai"}'
 *     → parsed object, passed through as-is
 *
 * Fails hard (exit 2) on a malformed JSON-looking input so callers get a
 * clear rejection at the CLI boundary rather than an opaque axum
 * deserialize error three hops away. We detect "looks like JSON" by the
 * leading `{` — a real cron expression never starts with that.
 */
export function normalizeScheduleFlag(
  raw: unknown,
  options: { fillMissingCronTimezone?: boolean; defaultTimezone?: string } = {},
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const defaultTimezone = options.defaultTimezone ?? resolveLocalTimezone();
  const withDefaultCronTimezone = (obj: Record<string, unknown>): Record<string, unknown> => {
    if (!options.fillMissingCronTimezone || obj.kind !== 'cron') return obj;
    const tz = typeof obj.tz === 'string' ? obj.tz.trim() : '';
    return tz ? obj : { ...obj, tz: defaultTimezone };
  };
  if (typeof raw !== 'string') {
    console.error('Error: --schedule must be a cron expression string or a JSON object (e.g. \'{"kind":"at","at":"2026-04-23T09:10:00+08:00"}\')');
    process.exit(2);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: --schedule looks like JSON but failed to parse: ${msg}`);
      console.error('  Expected shapes: {"kind":"at","at":"<ISO>"} | {"kind":"every","minutes":<n>} | {"kind":"cron","expr":"<expr>"[,"tz":"<tz>"]}');
      process.exit(2);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('Error: --schedule JSON must be an object with a "kind" field');
      process.exit(2);
    }
    const obj = parsed as Record<string, unknown>;
    const kind = obj.kind;
    if (kind === 'loop') {
      console.error('Error: Cron Loop has retired. Use Goal Mode instead:');
      console.error('  myagents goal create --objective-file <path>');
      process.exit(2);
    }
    if (kind !== 'at' && kind !== 'every' && kind !== 'cron') {
      console.error(`Error: --schedule JSON has invalid "kind": ${JSON.stringify(kind)} (expected one of: at, every, cron)`);
      process.exit(2);
    }
    // Per-kind required-field validation so missing fields fail at the CLI
    // boundary with a clear message instead of turning into a cryptic Rust
    // deserialize error "Failed to parse JSON" downstream.
    if (kind === 'at' && typeof obj.at !== 'string') {
      console.error('Error: --schedule {"kind":"at"} requires string field "at" (ISO-8601, e.g. "2026-04-23T09:10:00+08:00")');
      process.exit(2);
    }
    if (kind === 'every') {
      if (typeof obj.minutes !== 'number' || !Number.isFinite(obj.minutes)) {
        console.error('Error: --schedule {"kind":"every"} requires numeric field "minutes" (>= 5)');
        process.exit(2);
      }
      if (!Number.isInteger(obj.minutes) || obj.minutes < 5) {
        // Match Rust's `interval_minutes.max(5)` contract — Rust silently clamps
        // but that's a surprise; reject up front for clarity.
        console.error(`Error: --schedule {"kind":"every"}.minutes must be an integer >= 5 (got ${obj.minutes})`);
        process.exit(2);
      }
      if (obj.startAt !== undefined && typeof obj.startAt !== 'string') {
        console.error('Error: --schedule {"kind":"every"}.startAt must be a string (ISO-8601) when provided');
        process.exit(2);
      }
    }
    if (kind === 'cron') {
      if (typeof obj.expr !== 'string') {
        console.error('Error: --schedule {"kind":"cron"} requires string field "expr" (e.g. "0 9 * * *")');
        process.exit(2);
      }
      if (obj.tz !== undefined && obj.tz !== null && typeof obj.tz !== 'string') {
        console.error('Error: --schedule {"kind":"cron"}.tz must be a string (IANA tz name) when provided');
        process.exit(2);
      }
    }
    return withDefaultCronTimezone(obj);
  }
  // Non-JSON input → treat as a standard cron expression.
  return withDefaultCronTimezone({ kind: 'cron', expr: trimmed });
}

/** Hard cap for `--taskMdContent` (inline string). Mirrors the `--taskMdFile`
 *  1 MB cap so neither ingress path can ship a pathologically large body
 *  through to Rust, where it would bloat `.task/<id>/task.md` without bound. */
const TASK_MD_MAX_BYTES = 1024 * 1024;
const TASK_TRIGGER_SPEC_MAX_BYTES = 256 * 1024;
const TASK_TRIGGER_CHECKPOINT_MAX_BYTES = 64 * 1024;

function readTaskTriggerJsonFile(
  rawPath: unknown,
  flag: '--trigger-file' | '--spec-file' | '--checkpoint-file',
  maxBytes: number,
  allowNull: boolean,
): Record<string, unknown> | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    console.error(`Error: ${flag} requires a file path.`);
    process.exit(2);
  }
  try {
    const bytes = readGuardedFileBytes(
      rawPath,
      { kind: 'local', basePath: process.cwd() },
      maxBytes,
    );
    if (bytes.includes(0)) throw new Error('file contains NUL bytes');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    if (value === null && allowNull) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(allowNull ? 'JSON must be an object or null' : 'JSON must be an object');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    console.error(`Error: failed to read ${flag} "${rawPath}": ${error instanceof Error ? error.message : String(error)}.`);
    process.exit(2);
  }
}

function resolveTaskTriggerFile(
  rawPath: unknown,
  flag: '--trigger-file' | '--spec-file' = '--trigger-file',
): Record<string, unknown> {
  return readTaskTriggerJsonFile(
    rawPath,
    flag,
    TASK_TRIGGER_SPEC_MAX_BYTES,
    false,
  ) as Record<string, unknown>;
}

function resolveTaskCheckpointFile(rawPath: unknown): Record<string, unknown> | null {
  return readTaskTriggerJsonFile(
    rawPath,
    '--checkpoint-file',
    TASK_TRIGGER_CHECKPOINT_MAX_BYTES,
    true,
  );
}

function resolvePreselectedSessionId(
  raw: unknown,
  flags: Record<string, unknown>,
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) {
    return exitAgentCliError(flags, {
      code: 'TASK_SESSION_REQUIRED',
      error: '--preselectedSessionId requires current or a Session id.',
      suggestion: 'Pass `--preselectedSessionId current` inside a MyAgents Session, or use an id from `myagents session list --json`.',
      suggestedCommand: 'myagents session list --json',
    });
  }
  const value = raw.trim();
  if (value !== 'current') return value;
  const current = process.env.MYAGENTS_SESSION_ID?.trim();
  if (current) return current;
  return exitAgentCliError(flags, {
    code: 'CURRENT_SESSION_UNAVAILABLE',
    error: '--preselectedSessionId current requires MYAGENTS_SESSION_ID.',
    suggestion: 'Run this command inside a MyAgents Session, or pass an explicit id from `myagents session list --json`.',
    suggestedCommand: 'myagents session list --json',
  });
}

function validateTaskSessionBinding(
  runMode: unknown,
  preselectedSessionId: string | undefined,
  flags: Record<string, unknown>,
  requireForSingle = true,
): void {
  if (preselectedSessionId && runMode !== undefined && runMode !== 'single-session') {
    exitAgentCliError(flags, {
      code: 'TASK_SESSION_MODE_MISMATCH',
      error: '--preselectedSessionId is only valid with --runMode single-session.',
      suggestion: 'Use `--runMode single-session`, or remove --preselectedSessionId for a fresh Session on every AI execution.',
    });
  }
  if (requireForSingle && runMode === 'single-session' && !preselectedSessionId) {
    exitAgentCliError(flags, {
      code: 'TASK_SESSION_REQUIRED',
      error: '--runMode single-session requires --preselectedSessionId current|<session-id>.',
      suggestion: 'Use `current` inside MyAgents, or choose a materialized id from `myagents session list --json`.',
      suggestedCommand: 'myagents session list --json',
    });
  }
}

/**
 * Resolve `task create-direct --taskMdFile` / `--taskMdContentFile` /
 * `--taskMdContent` into a
 * single `taskMdContent` string.
 *
 * Precedence (both flags set → `--taskMdFile` wins):
 *   1. `--taskMdFile <path>` or `--taskMdContentFile <path>` — read the file (size + NUL guarded).
 *      Chosen as primary because inline markdown on the shell is hostile to
 *      backticks, quotes, and newlines.
 *   2. `--taskMdContent <string>` — raw inline content (size-guarded).
 *
 * Earlier revisions silently joined trailing positional args as a "legacy"
 * fallback — that was undocumented surface area and a fat-fingered positional
 * could silently become task body. Removed after cross-review (v0.1.69).
 */
function resolveTaskMdContent(
  flags: Record<string, unknown>,
  workspacePath?: string,
  structuredExit?: (error: AgentCliError, exitCode: number) => never,
): string | undefined {
  const fail = (error: AgentCliError, exitCode: number): never => {
    if (structuredExit) return structuredExit(error, exitCode);
    console.error(`Error: ${error.error}`);
    if (error.suggestion) console.error(`Suggestion: ${error.suggestion}`);
    process.exit(exitCode);
  };
  const filePath = flags.taskMdFile ?? flags.taskMdContentFile;
  if (filePath !== undefined && filePath !== '') {
    if (typeof filePath !== 'string') {
      return fail({
        code: 'TASK_CONTENT_FILE_INVALID',
        error: '--taskMdFile/--taskMdContentFile requires a file path string.',
        suggestion: 'Pass a regular text file path inside the current workspace.',
      }, 2);
    }
    try {
      if (workspacePath) {
        return readWorkspaceTextFile(filePath, workspacePath);
      }
      // Lazy require — same pattern as the cron `--prompt-file` reader
      // (keeps startup fast for commands that don't need fs).
      const fs = require('fs') as typeof import('fs');
      const stat = fs.statSync(filePath);
      if (stat.size > TASK_MD_MAX_BYTES) {
        return fail({
          code: 'TASK_CONTENT_TOO_LARGE',
          error: `--taskMdFile "${filePath}" is ${stat.size} bytes and exceeds the ${TASK_MD_MAX_BYTES} byte limit.`,
          suggestion: 'Reduce the Task markdown to 1 MB or less, then retry.',
        }, 1);
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (raw.includes('\0')) {
        return fail({
          code: 'TASK_CONTENT_FILE_INVALID',
          error: `--taskMdFile "${filePath}" contains NUL bytes and is not valid Task markdown.`,
          suggestion: 'Choose a UTF-8 text file, then retry.',
        }, 1);
      }
      return raw;
    } catch (err) {
      return fail({
        code: 'TASK_CONTENT_FILE_INVALID',
        error: `Failed to read --taskMdFile "${filePath}": ${err instanceof Error ? err.message : String(err)}.`,
        suggestion: 'Choose a regular, non-symlink text file inside the current workspace.',
      }, 1);
    }
  }
  const contentFlag = flags.taskMdContent;
  if (typeof contentFlag === 'string' && contentFlag !== '') {
    // Byte-length cap — a 1 MB inline arg on the shell is almost always a
    // copy-paste gone wrong, and downstream JSON serialisation / logging
    // would otherwise choke silently.
    const byteLen = Buffer.byteLength(contentFlag, 'utf-8');
    if (byteLen > TASK_MD_MAX_BYTES) {
      return fail({
        code: 'TASK_CONTENT_TOO_LARGE',
        error: `--taskMdContent is ${byteLen} bytes and exceeds the ${TASK_MD_MAX_BYTES} byte limit.`,
        suggestion: 'Reduce the Task markdown to 1 MB or less, then retry.',
      }, 1);
    }
    return contentFlag;
  }
  return undefined;
}

/**
 * Parse the value of `--runtimeConfig` (a JSON object string) into an object.
 *
 * Fails hard (exit 2) on malformed JSON — unlike `tryParseJson` which falls
 * back to the raw string. Reason: silently forwarding a broken string to the
 * server would surface as a cryptic Rust deserialization error 3 hops later.
 * An early, typed rejection with "must be a JSON object" is a much more
 * fixable error for the AI caller.
 */
function parseRuntimeConfigFlag(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    console.error('Error: --runtimeConfig must be a JSON object string (e.g. --runtimeConfig \'{"model":"o3"}\')');
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: --runtimeConfig is not valid JSON: ${msg}`);
    process.exit(2);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('Error: --runtimeConfig must be a JSON object (not array, null, or primitive)');
    process.exit(2);
  }
  return parsed as Record<string, unknown>;
}

function parseMcpEnabledServersFlag(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    console.error('Error: --mcpEnabledServers must be a comma-separated string (e.g. --mcpEnabledServers playwright,im-cron). Use --mcpEnabledServers "" for explicit no MCP.');
    process.exit(2);
  }
  if (raw.trim() === '') return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Build the TaskEndConditions replacement used at Task creation. Task
 * deadlines are persisted as epoch milliseconds, while the CLI accepts the
 * same strict, timezone-bearing ISO input as Goal Mode. Omission keeps the
 * Rust defaults (`aiCanExit=true`) and avoids manufacturing an empty config.
 */
function buildTaskEndConditions(
  flags: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const deadlineIso = parseGoalDeadlineFlag(flags.deadline);
  const maxExecutions = parseGoalMaxExecutionsFlag(flags.maxExecutions);
  const aiCanExit = parseGoalAiCanExitFlag(flags.aiCanExit);
  if (deadlineIso === undefined && maxExecutions === undefined && aiCanExit === undefined) {
    return undefined;
  }
  return {
    ...(deadlineIso !== undefined ? { deadline: Date.parse(deadlineIso) } : {}),
    ...(maxExecutions !== undefined ? { maxExecutions } : {}),
    ...(aiCanExit !== undefined ? { aiCanExit } : {}),
  };
}

/**
 * Build a `notification` sub-object from the `--notification*` flags so the
 * Rust create `notification` and update `notificationPatch` fields use the
 * same flag-to-field mapping. Update merge happens under the Task lock.
 *
 * Returns `undefined` when no notification flag was set — the Rust update
 * path treats `None` as "leave unchanged", and create-direct already defaults
 * to `{ desktop: true }` via serde so omitting it is the right behavior.
 *
 * Flags supported:
 *   --notificationBotChannelId <bot-id>     IM bot id (see `myagents im channels`)
 *   --notificationBotThread <chat-id>       Override bot routing thread / channel
 *   --notificationDesktop true|false        Toggle desktop notification (default true)
 *   --notificationEvents done,blocked,...   Comma-separated event filter
 */
function buildNotificationFromFlags(
  flags: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const channel = flags.notificationBotChannelId;
  const thread = flags.notificationBotThread;
  const desktop = flags.notificationDesktop;
  const events = flags.notificationEvents;
  if (
    channel === undefined
    && thread === undefined
    && desktop === undefined
    && events === undefined
  ) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  if (desktop !== undefined) {
    // Accept `true` / `false` strings (CLI parser leaves un-quoted bools as
    // strings) and any truthy/falsy value; explicit `false` MUST disable.
    if (typeof desktop === 'boolean') {
      out.desktop = desktop;
    } else if (typeof desktop === 'string') {
      const v = desktop.toLowerCase();
      if (v === 'false' || v === '0' || v === 'no' || v === 'off') {
        out.desktop = false;
      } else {
        out.desktop = true;
      }
    } else {
      out.desktop = !!desktop;
    }
  }
  if (channel !== undefined) {
    // Bare `--notificationBotChannelId` (no value) parses as boolean `true`;
    // forwarding `"true"` as a bot id is a near-certain mistake. Require a
    // non-empty string so the AI / user gets a clear error instead of a
    // confused router that says "no such bot 'true'".
    if (typeof channel !== 'string' || channel.length === 0) {
      console.error('Error: --notificationBotChannelId requires a bot id (e.g. --notificationBotChannelId feishu_main). See: myagents im channels');
      process.exit(2);
    }
    out.botChannelId = channel;
  }
  if (thread !== undefined) {
    if (typeof thread !== 'string' || thread.length === 0) {
      console.error('Error: --notificationBotThread requires a non-empty value');
      process.exit(2);
    }
    out.botThread = thread;
  }
  if (events !== undefined) {
    if (typeof events !== 'string') {
      console.error('Error: --notificationEvents must be a comma-separated string (e.g. done,blocked,endCondition)');
      process.exit(2);
    }
    const eventsList = events.split(',').map(s => s.trim()).filter(Boolean);
    if (eventsList.length === 0) {
      // Empty list would silently mean "subscribe to nothing" — almost
      // certainly a typo (`--notificationEvents=,,,` or empty string).
      console.error('Error: --notificationEvents resolved to an empty list. Pass at least one event (e.g. done,blocked,endCondition) or omit the flag to use the default set.');
      process.exit(2);
    }
    out.events = eventsList;
  }
  return out;
}

/**
 * Parse `--dispatchAt` flag into milliseconds since epoch. Accepts either a
 * raw epoch-ms integer (what Rust persists) or an ISO 8601 / RFC 3339 string
 * (what humans type). Bails with a precise error on unparseable input — a
 * silent fall-through would later become a confusing "task never fires"
 * because Rust treats `None` as "no schedule".
 */
export function parseDispatchAtValue(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('Error: --dispatchAt must be a number (epoch ms) or an ISO 8601 timestamp');
  }
  const trimmed = raw.trim();
  // Pure-integer path: epoch-ms (the Rust wire format). `parseInt` would
  // silently chop `"123abc"`; require the whole string to be digits to
  // surface typos.
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  if (!/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    throw new Error(`Error: --dispatchAt "${raw}" must include an explicit timezone offset or Z (e.g. 2026-06-01T09:00:00+08:00). For recurring cron schedules, use --cronTimezone/JSON "tz" instead.`);
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(`Error: --dispatchAt "${raw}" is not a valid timestamp (try epoch ms or ISO 8601, e.g. 2026-06-01T09:00:00+08:00)`);
  }
  return ms;
}

function parseDispatchAtFlag(raw: unknown): number | undefined {
  try {
    return parseDispatchAtValue(raw);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

/**
 * Recurring tasks with no explicit interval / cron silently default to 60min
 * on the Rust side (`schedule_from_task` falls through to
 * `interval_minutes.unwrap_or(60).max(5)`). Surface this so the AI / user
 * doesn't ship a "let me poll every minute" task that quietly runs hourly.
 * Print to stderr so JSON output stays parseable.
 */
function maybeWarnRecurringWithoutInterval(
  executionMode: string,
  flags: Record<string, unknown>,
): void {
  if (executionMode !== 'recurring') return;
  if (flags.intervalMinutes !== undefined || flags.cronExpression !== undefined) {
    return;
  }
  console.error(
    'Warning: --executionMode recurring without --intervalMinutes or --cronExpression — '
    + 'task will run every 60 minutes (Rust default). Add --intervalMinutes <n> to set the cadence.',
  );
}

/**
 * Parse `--intervalMinutes` into a positive integer. Without this validator
 * `Number("abc")` produces `NaN`, which `JSON.stringify` emits as `null`,
 * which Rust serde drops via `#[serde(default)]` → the task silently falls
 * back to the 60-minute default with no error surfaced to the user.
 * Codex review (issue #205) caught this as a class-of-bug pattern.
 */
function parseIntervalMinutesFlag(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(`Error: --intervalMinutes must be a positive integer (got: ${JSON.stringify(raw)})`);
    process.exit(2);
  }
  if (n < 5) {
    // The Rust scheduler clamps to .max(5), so anything lower would silently
    // be ignored. Reject so the user knows their "every 2 min" turned into
    // "every 5 min" before they ship a misconfigured cadence.
    console.error(`Error: --intervalMinutes minimum is 5 (got: ${n}). The scheduler enforces this floor; lower values are silently clamped.`);
    process.exit(2);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (!process.env.VITEST) {
  main().catch(err => {
    const message = err instanceof Error ? err.message : String(err);
    if (isSpaceJsonInvocation()) {
      console.log(JSON.stringify({
        success: false,
        code: 'SPACE_CLI_ERROR',
        error: message,
        suggestion: 'Check the command leaf help and retry with explicit, non-empty flag values.',
        suggestedCommand: `myagents ${rawArgs.slice(0, 4).filter(arg => !arg.startsWith('-')).join(' ')} --help`,
      }, null, 2));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  });
}
