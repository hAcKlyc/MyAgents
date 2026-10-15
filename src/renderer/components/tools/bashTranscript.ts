import type { ToolUseSimple } from '@/types/chat';

export type BashTranscriptStatus =
  | 'initializing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'timeout'
  | 'background';

export type BashStreamKind = 'stdout' | 'stderr' | 'combined';
export type BashStreamFormat = 'json' | 'diff' | 'plain';

export interface BashTranscriptCommand {
  /** Untouched input.command, or a bounded synthesis of commandActions. */
  raw: string;
  displayLines: string[];
  source: 'command-actions' | 'safe-format' | 'raw';
}

export interface BashTranscriptStream {
  kind: BashStreamKind;
  format: BashStreamFormat;
  /** Untouched stream text received from the runtime. */
  text: string;
  /** A presentation-only representation, e.g. pretty-printed JSON. */
  displayText: string;
}

export interface BashTranscriptModel {
  shell?: string;
  commandLanguage?: 'bash' | 'powershell';
  command: BashTranscriptCommand | null;
  /** Command content exists beyond the bounded commandActions projection. */
  hasHiddenCommandContent: boolean;
  streams: BashTranscriptStream[];
  status: BashTranscriptStatus;
  meta: {
    cwd?: string;
    durationMs?: number;
    processId?: string;
    exitCode?: number;
    timedOutAfterMs?: number;
    backgroundCwdHint?: string;
  };
}

interface BashDisplayInput extends Record<string, unknown> {
  command?: string;
  cwd?: string;
  workdir?: string;
  run_in_background?: boolean;
  commandActions?: unknown[];
  timeout?: number;
  description?: string;
  dangerouslyDisableSandbox?: boolean;
}

interface ParsedSdkBashResult {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  background: boolean;
  timedOutAfterMs?: number;
  backgroundCwdHint?: string;
}

const SHELL_WRAPPER_PATTERN = /^\s*((?:"[^"]+"|'[^']+'|[^\s]+))\s+-(?:lc|cl)(?:\s|$)/;
// `cat<<EOF` is valid shell syntax too. Any heredoc-like token makes the
// formatter fail closed; this intentionally also declines to format rarer
// arithmetic-shift / here-string lookalikes rather than splitting payload text.
const HEREDOC_PATTERN = /<<-?/;
const COMPLETE_STATUS_PATTERN = /^(?:complete|completed|success|succeeded|ok|exit(?:ed)?|done)$/;
const RUNNING_STATUS_PATTERN = /^(?:running|in[_ -]?progress|started|pending)$/;
const BACKGROUND_STATUS_PATTERN = /background/;
const TIMEOUT_STATUS_PATTERN = /^(?:timeout|timed[_ -]?out)$/;
const STOPPED_STATUS_PATTERN = /^(?:stop|stopped|cancelled|canceled)$/;
const INTERRUPTED_STATUS_PATTERN = /^(?:interrupt|interrupted|aborted)$/;
const FAILED_STATUS_PATTERN = /^(?:fail|failed|error|errored|declined|denied)$/;
// Detection/parsing is presentation work on the renderer thread. Above this
// bound, retain the untouched text and let BashTool's window project a prefix;
// never scan/parse an arbitrarily large result before the render cap applies.
const FORMAT_DETECTION_CHARACTER_BUDGET = 512 * 1024;
const SDK_WRAPPER_PARSE_CHARACTER_BUDGET = 512 * 1024;
const SHELL_FORMAT_CHARACTER_BUDGET = 512 * 1024;
const INPUT_JSON_PARSE_CHARACTER_BUDGET = 512 * 1024;
const INPUT_PREFIX_SCAN_CHARACTER_BUDGET = 4 * 1024;
const STATUS_SCAN_CHARACTER_BUDGET = 128;
export const BASH_TRANSCRIPT_MAX_LINE_BUDGET = 5_000;
export const BASH_TRANSCRIPT_MAX_CHARACTER_BUDGET = 512 * 1024;
const COMMAND_ACTION_SCAN_BUDGET = BASH_TRANSCRIPT_MAX_LINE_BUDGET;
const SDK_BASH_OUTPUT_KEYS = new Set([
  'stdout',
  'stderr',
  'rawOutputPath',
  'interrupted',
  'isImage',
  'backgroundTaskId',
  'backgroundedByUser',
  'timedOutAfterMs',
  'backgroundCwdHint',
  'dangerouslyDisableSandbox',
  'returnCodeInterpretation',
  'noOutputExpected',
  'structuredContent',
  'persistedOutputPath',
  'persistedOutputSize',
  'staleReadFileStateHint',
  'ghRateLimitHint',
  'gitOperation',
]);
const BASH_INPUT_FIELDS = new Set([
  'command',
  'cwd',
  'workdir',
  'description',
  'run_in_background',
  'dangerouslyDisableSandbox',
  'commandActions',
  'timeout',
]);

/** Lightweight status projection for folded process rows; shares the terminal
 * precedence with the expanded transcript without formatting output/commands. */
export function resolveBashTranscriptStatus(tool: ToolUseSimple): BashTranscriptStatus {
  const input = resolveBashInput(tool);
  return resolveBashStatus(tool, input, parseSdkBashResult(tool.result), Boolean(input.command));
}

export function resolveBashTranscriptModel(tool: ToolUseSimple): BashTranscriptModel {
  const input = resolveBashInput(tool);
  const rawCommand = typeof input.command === 'string' ? input.command : '';
  const rawCommandInspection = inspectCommandText(rawCommand);
  const actionProjection = projectCommandActions(input.commandActions);
  const commandText = rawCommandInspection.hasVisibleContent
    ? rawCommand
    : actionProjection.displayLines.join('\n');
  const formattedProjection = actionProjection.displayLines.length > 0
    ? actionProjection
    : projectShellCommandForDisplay(commandText);
  const formattedLines = formattedProjection.displayLines;
  const commandSource = actionProjection.displayLines.length > 0
    ? 'command-actions'
    : formattedLines.length > 1
      ? 'safe-format'
      : 'raw';
  const parsedResult = parseSdkBashResult(tool.result);
  const status = resolveBashStatus(
    tool,
    input,
    parsedResult,
    commandText.length > 0
      || actionProjection.hasHiddenContent
      || rawCommandInspection.hasUnknownContent,
  );

  return {
    shell: tool.name === 'pwsh' ? 'PowerShell' : tool.name === 'bash' ? 'Bash' : detectShellWrapper(rawCommand),
    commandLanguage: tool.name === 'PowerShell' || tool.name === 'pwsh' ? 'powershell' : 'bash',
    command: commandText
      ? {
          raw: commandText,
          displayLines: formattedLines,
          source: commandSource,
        }
      : null,
    hasHiddenCommandContent: actionProjection.hasHiddenContent
      || formattedProjection.hasHiddenContent
      || (
        actionProjection.displayLines.length === 0
        && rawCommandInspection.hasUnknownContent
      ),
    streams: resolveBashStreams(tool, parsedResult),
    status,
    meta: {
      cwd: stringOrUndefined(tool.resultMeta?.cwd) ?? stringOrUndefined(input.cwd) ?? stringOrUndefined(input.workdir),
      durationMs: nonNegativeNumberOrUndefined(tool.resultMeta?.durationMs),
      processId: stringOrUndefined(tool.resultMeta?.processId),
      exitCode: finiteNumberOrUndefined(tool.resultMeta?.exitCode),
      timedOutAfterMs: parsedResult?.timedOutAfterMs,
      backgroundCwdHint: parsedResult?.backgroundCwdHint,
    },
  };
}

/**
 * Inserts presentation-only line breaks after unambiguous top-level shell
 * operators. The source string is returned separately by the view model and is
 * never mutated. Shell grammar is intentionally handled fail-closed: heredocs,
 * unbalanced quotes/nesting, and ambiguous control constructs remain untouched.
 */
export function formatShellCommandForDisplay(command: string): string[] {
  return projectShellCommandForDisplay(command).displayLines;
}

function projectShellCommandForDisplay(
  command: string,
): { displayLines: string[]; hasHiddenContent: boolean } {
  if (!command) return { displayLines: [], hasHiddenContent: false };
  if (command.length > SHELL_FORMAT_CHARACTER_BUDGET) {
    return { displayLines: [command], hasHiddenContent: false };
  }
  if (HEREDOC_PATTERN.test(command)) {
    return { displayLines: [command], hasHiddenContent: false };
  }

  const lines: string[] = [];
  let hasHiddenContent = false;
  let current = '';
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  let inComment = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  const pushBreak = () => {
    if (lines.length < BASH_TRANSCRIPT_MAX_LINE_BUDGET) {
      lines.push(current.trimEnd());
    } else {
      hasHiddenContent = true;
    }
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (inComment) {
      current += char;
      if (char === '\n') inComment = false;
      continue;
    }

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      // Double-quoted command/parameter/arithmetic substitutions introduce
      // their own nested quote grammar. This lightweight presentation
      // formatter deliberately does not emulate Bash's quote stack: retain
      // the whole command instead of splitting an operator inside the nested
      // expression. Escaped `$`/backticks were consumed by the branch above.
      if (
        quote === '"'
        && (
          char === '`'
          || (char === '$' && (next === '(' || next === '{' || next === '['))
        )
      ) return { displayLines: [command], hasHiddenContent: false };
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    const previous = command[index - 1];
    const startsComment = char === '#'
      && (index === 0 || previous === undefined || /[\s;&|()]/.test(previous));
    if (startsComment) {
      // Nested shell grammars own their own comment/newline and delimiter
      // semantics. A lightweight display formatter cannot safely decide where
      // the enclosing substitution resumes, so preserve the source whole.
      if (parenDepth > 0 || braceDepth > 0 || bracketDepth > 0) {
        return { displayLines: [command], hasHiddenContent: false };
      }
      inComment = true;
      current += char;
      continue;
    }

    if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth -= 1;
    else if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth -= 1;
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth -= 1;

    if (parenDepth < 0 || braceDepth < 0 || bracketDepth < 0) {
      return { displayLines: [command], hasHiddenContent: false };
    }

    const atTopLevel = parenDepth === 0 && braceDepth === 0 && bracketDepth === 0;
    // `>|` is Bash's noclobber override redirection, not a pipeline.
    if (atTopLevel && char === '|' && previous === '>') {
      return { displayLines: [command], hasHiddenContent: false };
    }
    const twoCharacterOperator = atTopLevel && (
      (char === '&' && next === '&')
      || (char === '|' && next === '|')
      || (char === '|' && next === '&')
    );
    const oneCharacterOperator = atTopLevel
      && (char === ';' || (char === '|' && next !== '|' && next !== '&'));

    // `;;`, `;&`, and `;;&` belong to case-clause grammar. Formatting the
    // semicolon alone would visually rewrite the operator, so keep the whole
    // command untouched instead of pretending to parse full Bash grammar.
    if (atTopLevel && char === ';' && (next === ';' || next === '&')) {
      return { displayLines: [command], hasHiddenContent: false };
    }

    if (twoCharacterOperator) {
      current += `${char}${next}`;
      index += 1;
      pushBreak();
      while (command[index + 1] === ' ' || command[index + 1] === '\t') index += 1;
      continue;
    }
    if (oneCharacterOperator) {
      current += char;
      pushBreak();
      while (command[index + 1] === ' ' || command[index + 1] === '\t') index += 1;
      continue;
    }
    current += char;
  }

  if (quote || escaped || parenDepth !== 0 || braceDepth !== 0 || bracketDepth !== 0) {
    return { displayLines: [command], hasHiddenContent: false };
  }
  if (current || lines.length === 0) {
    if (lines.length < BASH_TRANSCRIPT_MAX_LINE_BUDGET) {
      lines.push(current.trimEnd());
    } else if (current) {
      hasHiddenContent = true;
    }
  }
  return {
    displayLines: lines.filter((line, index) => line.length > 0 || index === lines.length - 1),
    hasHiddenContent,
  };
}

export function detectBashStreamFormat(text: string): Pick<BashTranscriptStream, 'format' | 'displayText'> {
  if (text.length > FORMAT_DETECTION_CHARACTER_BUDGET) {
    return { format: 'plain', displayText: text };
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        const compact = JSON.stringify(parsed);
        // Native parsing changes unsafe integers, -0, duplicate keys, escape
        // spellings, and some key orders. Pretty-print only when stringify is
        // a lossless textual round trip after insignificant whitespace removal.
        const displayText = compact === stripJsonWhitespaceOutsideStrings(trimmed)
          ? JSON.stringify(parsed, null, 2)
          : text;
        return { format: 'json', displayText };
      }
    } catch {
      // Incomplete or mixed JSON is terminal text, not a syntax claim.
    }
  }

  const hasHunk = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m.test(text);
  const hasChangedLine = /^(?:\+[^+]|-[^-])/m.test(text);
  const hasGitHeader = /^diff --git\s+/m.test(text);
  const hasFileHeaders = /^---\s+.+\n\+\+\+\s+.+/m.test(text);
  if ((hasHunk && hasChangedLine) || (hasGitHeader && (hasHunk || hasFileHeaders))) {
    return { format: 'diff', displayText: text };
  }

  return { format: 'plain', displayText: text };
}

export function formatBashDuration(durationMs?: number): string | null {
  if (durationMs === undefined || durationMs < 0 || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function resolveBashInput(tool: ToolUseSimple): BashDisplayInput {
  const fromJson = parseInputJson(tool.inputJson);
  if (fromJson && hasKnownBashInputField(fromJson)) return fromJson;
  if (isRecord(tool.parsedInput) && hasKnownBashInputField(tool.parsedInput)) {
    return tool.parsedInput as BashDisplayInput;
  }
  if (isRecord(tool.input) && hasKnownBashInputField(tool.input)) {
    return tool.input as BashDisplayInput;
  }
  const raw = tool.inputJson;
  // Older external-runtime history stored a bare command instead of JSON.
  // Object-looking raw text is inherently ambiguous with a streaming JSON
  // payload (and fully parsing Bash grammar belongs outside the renderer), so
  // fail closed until a parsed/structured authority exists. Non-object legacy
  // commands retain the raw fallback.
  const rawInspection = inspectCommandText(raw ?? '');
  if (
    (rawInspection.hasVisibleContent || rawInspection.hasUnknownContent)
    && !looksLikeAmbiguousObjectInput(raw ?? '')
  ) return { command: raw as string };
  return {};
}

function parseInputJson(inputJson?: string): BashDisplayInput | null {
  if (!inputJson) return null;
  if (inputJson.length > INPUT_JSON_PARSE_CHARACTER_BUDGET) return null;
  try {
    const parsed: unknown = JSON.parse(inputJson);
    return isRecord(parsed) ? parsed as BashDisplayInput : null;
  } catch {
    return null;
  }
}

function hasKnownBashInputField(input: Record<string, unknown>): boolean {
  for (const field of BASH_INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) return true;
  }
  return false;
}

function looksLikeAmbiguousObjectInput(raw: string): boolean {
  const prefix = raw.slice(0, INPUT_JSON_PARSE_CHARACTER_BUDGET);
  for (let index = 0; index < prefix.length; index += 1) {
    if (/\s/.test(prefix[index])) continue;
    return prefix[index] === '{';
  }
  return false;
}

function projectCommandActions(actions: unknown): { displayLines: string[]; hasHiddenContent: boolean } {
  if (!Array.isArray(actions)) return { displayLines: [], hasHiddenContent: false };
  const displayLines: string[] = [];
  let remainingLines = BASH_TRANSCRIPT_MAX_LINE_BUDGET;
  let remainingCharacters = BASH_TRANSCRIPT_MAX_CHARACTER_BUDGET;
  let remainingInspectionCharacters = BASH_TRANSCRIPT_MAX_CHARACTER_BUDGET;
  const scanEnd = Math.min(actions.length, COMMAND_ACTION_SCAN_BUDGET);

  for (let index = 0; index < scanEnd; index += 1) {
    const action = actions[index];
    if (!isRecord(action) || typeof action.command !== 'string') {
      continue;
    }
    if (remainingInspectionCharacters <= 0) {
      if (action.command.length > 0) return { displayLines, hasHiddenContent: true };
      continue;
    }
    const inspectionEnd = Math.min(action.command.length, remainingInspectionCharacters);
    const inspectedPrefix = action.command.slice(0, inspectionEnd);
    remainingInspectionCharacters -= inspectionEnd;
    if (!/\S/.test(inspectedPrefix)) {
      if (inspectionEnd < action.command.length) {
        return { displayLines, hasHiddenContent: true };
      }
      continue;
    }
    const separatorCharacters = displayLines.length > 0 ? 1 : 0;
    if (remainingCharacters <= separatorCharacters) {
      return { displayLines, hasHiddenContent: true };
    }
    remainingCharacters -= separatorCharacters;
    const projected = projectTextPrefix(action.command, remainingLines, remainingCharacters);
    if (projected.text) displayLines.push(projected.text);
    remainingLines -= projected.lines;
    remainingCharacters -= projected.text.length;
    if (projected.hasHiddenContent) {
      return { displayLines, hasHiddenContent: true };
    }
    if (remainingLines <= 0 || remainingCharacters <= 0) {
      return {
        displayLines,
        hasHiddenContent: index + 1 < actions.length,
      };
    }
  }

  return {
    displayLines,
    hasHiddenContent: scanEnd < actions.length,
  };
}

function projectTextPrefix(
  text: string,
  maxLines: number,
  maxCharacters: number,
): { text: string; lines: number; hasHiddenContent: boolean } {
  if (maxLines <= 0 || maxCharacters <= 0) {
    return { text: '', lines: 0, hasHiddenContent: text.length > 0 };
  }
  let end = Math.min(text.length, maxCharacters);
  let lines = text.length > 0 ? 1 : 0;
  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    if (lines === maxLines) {
      end = index;
      break;
    }
    lines += 1;
  }
  const finalCodeUnit = text.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) end -= 1;
  return {
    text: end === text.length ? text : text.slice(0, end),
    lines,
    hasHiddenContent: end < text.length,
  };
}

function detectShellWrapper(command: string): string | undefined {
  const prefix = command.slice(0, INPUT_PREFIX_SCAN_CHARACTER_BUDGET);
  const match = prefix.match(SHELL_WRAPPER_PATTERN);
  if (!match) return undefined;
  const matchedSyntheticEnd = command.length > prefix.length
    && (match.index ?? 0) + match[0].length === prefix.length
    && !/\s$/.test(match[0])
    && !/\s/.test(command[prefix.length]);
  if (matchedSyntheticEnd) return undefined;
  return match[1].replace(/^(?:"|')|(?:"|')$/g, '');
}

function parseSdkBashResult(result?: string): ParsedSdkBashResult | null {
  if (result === undefined) return null;
  if (result.length > SDK_WRAPPER_PARSE_CHARACTER_BUDGET) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) return null;
    if (typeof parsed.stdout !== 'string' || typeof parsed.stderr !== 'string') return null;
    if (typeof parsed.interrupted !== 'boolean') return null;
    if (Object.keys(parsed).some((key) => !SDK_BASH_OUTPUT_KEYS.has(key))) return null;
    return {
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      interrupted: parsed.interrupted,
      background:
        typeof parsed.backgroundTaskId === 'string'
        || parsed.backgroundedByUser === true
        || nonNegativeNumberOrUndefined(parsed.timedOutAfterMs) !== undefined,
      timedOutAfterMs: nonNegativeNumberOrUndefined(parsed.timedOutAfterMs),
      backgroundCwdHint: stringOrUndefined(parsed.backgroundCwdHint),
    };
  } catch {
    return null;
  }
}

function resolveBashStreams(
  tool: ToolUseSimple,
  parsedResult: ParsedSdkBashResult | null,
): BashTranscriptStream[] {
  if (parsedResult) {
    return [
      ...(parsedResult.stdout ? [createStream('stdout', parsedResult.stdout)] : []),
      ...(parsedResult.stderr ? [createStream('stderr', parsedResult.stderr)] : []),
    ];
  }
  if (!tool.result) return [];
  // External runtimes expose one aggregated output string. A non-zero exit
  // establishes failure state, not stream provenance: stdout may still be
  // present, so never relabel the combined transcript as stderr.
  return [createStream('combined', tool.result)];
}

function createStream(kind: BashStreamKind, text: string): BashTranscriptStream {
  const detected = detectBashStreamFormat(text);
  return { kind, text, ...detected };
}

function resolveBashStatus(
  tool: ToolUseSimple,
  input: BashDisplayInput,
  parsedResult: ParsedSdkBashResult | null,
  hasCommand: boolean,
): BashTranscriptStatus {
  const rawStatus = tool.resultMeta?.status
    ?.slice(0, STATUS_SCAN_CHARACTER_BUDGET)
    .trim()
    .toLowerCase() ?? '';
  if (tool.isStopped || STOPPED_STATUS_PATTERN.test(rawStatus)) return 'stopped';
  if (parsedResult?.interrupted || INTERRUPTED_STATUS_PATTERN.test(rawStatus)) return 'interrupted';
  if (TIMEOUT_STATUS_PATTERN.test(rawStatus)) return 'timeout';
  if (
    tool.isFailed
    || tool.isError
    || (typeof tool.resultMeta?.exitCode === 'number' && tool.resultMeta.exitCode !== 0)
    || FAILED_STATUS_PATTERN.test(rawStatus)
  ) return 'failed';
  if (parsedResult?.background || input.run_in_background === true || BACKGROUND_STATUS_PATTERN.test(rawStatus)) return 'background';
  if (tool.isLoading || RUNNING_STATUS_PATTERN.test(rawStatus)) return tool.input && !hasCommand ? 'initializing' : 'running';
  if (tool.result !== undefined || COMPLETE_STATUS_PATTERN.test(rawStatus)) return 'completed';
  return hasCommand ? 'running' : 'initializing';
}

function inspectCommandText(value: string): {
  hasVisibleContent: boolean;
  hasUnknownContent: boolean;
} {
  const prefix = value.slice(0, BASH_TRANSCRIPT_MAX_CHARACTER_BUDGET);
  const hasVisibleContent = /\S/.test(prefix);
  return {
    hasVisibleContent,
    hasUnknownContent: !hasVisibleContent && value.length > prefix.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumberOrUndefined(value: unknown): number | undefined {
  const number = finiteNumberOrUndefined(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function stripJsonWhitespaceOutsideStrings(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char !== ' ' && char !== '\t' && char !== '\r' && char !== '\n') result += char;
  }
  return result;
}
