import {
  SuccessIcon,
  StopCircleIcon,
  ClockIcon,
  LoaderIcon,
  TerminalIcon,
  WarningIcon,
} from '@/components/icons';
import { useId, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import { useResolvedTheme } from '@/theme';
import type { ToolUseSimple } from '@/types/chat';

import {
  BASH_TRANSCRIPT_MAX_CHARACTER_BUDGET,
  BASH_TRANSCRIPT_MAX_LINE_BUDGET,
  formatBashDuration,
  resolveBashTranscriptModel,
} from './bashTranscript';
import type {
  BashStreamFormat,
  BashStreamKind,
  BashTranscriptModel,
  BashTranscriptStatus,
  BashTranscriptStream,
} from './bashTranscript';

interface BashToolProps {
  tool: ToolUseSimple;
  resultOnly?: boolean;
}

type ChatTranslator = (key: string, options?: Record<string, unknown>) => string;

const INITIAL_TRANSCRIPT_LINE_BUDGET = 400;
const INITIAL_TRANSCRIPT_CHARACTER_BUDGET = 100 * 1024;
const INITIAL_VISIBLE_PRESENTATION_ROWS = 16;
const SYNTAX_HIGHLIGHT_LINE_BUDGET = 1_000;
const SYNTAX_HIGHLIGHT_CHARACTER_BUDGET = 100 * 1024;
const SYNTAX_HIGHLIGHT_COMMAND_SEGMENT_BUDGET = 100;

export default function BashTool({ tool, resultOnly = false }: BashToolProps) {
  const { t } = useTranslation('chat');
  const model = useMemo(
    () => resolveBashTranscriptModel(tool),
    [tool],
  );

  return <BashTerminal model={resultOnly ? { ...model, command: null, shell: undefined, hasHiddenCommandContent: false,
    meta: { ...model.meta, cwd: undefined, processId: undefined } } : model} t={t} resultOnly={resultOnly} />;
}

function BashTerminal({ model, t, resultOnly }: { model: BashTranscriptModel; t: ChatTranslator; resultOnly: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const notifyRowLayoutChanged = useNotifyRowLayoutChanged();
  const expandDescriptionId = useId();
  const truncationId = useId();
  const transcriptWindow = useMemo(
    () => buildTranscriptWindow(
      model.command,
      model.streams,
      isExpanded,
      model.hasHiddenCommandContent,
    ),
    [model.command, model.streams, isExpanded, model.hasHiddenCommandContent],
  );
  const isVisuallyLong = exceedsPresentationRowBudget(model.command, model.streams);
  const shouldOfferShowAll = !isExpanded && (isVisuallyLong || transcriptWindow.hasHiddenContent);
  const isHardTruncated = isExpanded && transcriptWindow.hasHiddenContent;
  const statusLabel = t(`shell.toolChrome.bash.status.${model.status}`);
  const metaItems = buildMetaItems(model, t);

  return (
    <section
      data-bash-terminal="true"
      className="min-w-0 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--code-bg)] text-[var(--code-text)] shadow-[var(--shadow-xs)] select-none"
      aria-label={t('shell.toolChrome.bash.terminalAria', { status: statusLabel })}
    >
      <header className="flex min-h-10 min-w-0 items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--code-header-bg)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {!resultOnly && <TerminalIcon className="size-4 shrink-0 text-[var(--code-line-number)]" aria-hidden="true" />}
          <span className="truncate font-mono text-xs text-[var(--code-text)]">
            {resultOnly ? t('process.heading.execute') : model.shell ?? t('shell.toolChrome.bash.terminal')}
          </span>
        </div>
        <BashStatus status={model.status} label={statusLabel} />
      </header>

      <div className="relative min-w-0">
        <div
          data-bash-transcript="true"
          tabIndex={0}
          aria-label={t('shell.toolChrome.bash.transcriptAria')}
          aria-describedby={shouldOfferShowAll ? expandDescriptionId : isHardTruncated ? truncationId : undefined}
          className={`${shouldOfferShowAll ? 'max-h-96 overflow-y-hidden' : ''} min-w-0 overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-border)]/30`}
        >
          {transcriptWindow.command && <ShellCommandView command={transcriptWindow.command} language={model.commandLanguage ?? 'bash'} t={t} />}

          {transcriptWindow.streams.map((stream, index) => (
            <TerminalStreamView
              key={`${stream.kind}:${index}`}
              stream={stream}
              t={t}
            />
          ))}

          {transcriptWindow.streams.length === 0 && (
            <TerminalEmptyState status={model.status} t={t} />
          )}
        </div>

        {shouldOfferShowAll && (
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center justify-end bg-gradient-to-t from-[var(--code-bg)] via-[var(--code-bg)]/95 to-[var(--paper-a0)] pb-3 pt-14">
            <span id={expandDescriptionId} className="mb-1 text-xs text-[var(--code-line-number)]">
              {t('shell.toolChrome.bash.moreOutput')}
            </span>
            <button
              type="button"
              data-bash-show-all="true"
              onClick={() => {
                setIsExpanded(true);
                notifyRowLayoutChanged('expandable-container-expand');
              }}
              className="rounded-full border border-[var(--line)] bg-[var(--code-header-bg)] px-3 py-1 text-xs font-medium text-[var(--code-text)] shadow-[var(--shadow-xs)] transition-colors duration-150 hover:border-[var(--code-line-number)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-border)]/40 motion-reduce:transition-none"
            >
              {t('shell.toolChrome.bash.showAll')}
            </button>
          </div>
        )}
      </div>

      {isHardTruncated && (
        <div
          id={truncationId}
          role="status"
          data-bash-truncated="true"
          className="border-t border-[var(--line)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning)]"
        >
          {t('shell.toolChrome.bash.contentTruncated')}
        </div>
      )}

      {metaItems.length > 0 && (
        <footer
          data-bash-meta="true"
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 overflow-hidden border-t border-[var(--line)] bg-[var(--code-header-bg)] px-3 py-2 font-mono text-xs text-[var(--code-line-number)]"
        >
          {metaItems.map((item, index) => (
            <span key={item} className={index === 0 && model.meta.cwd ? 'min-w-0 truncate' : 'shrink-0'}>
              {item}
            </span>
          ))}
        </footer>
      )}
    </section>
  );
}

function BashStatus({ status, label }: { status: BashTranscriptStatus; label: string }) {
  const icon = statusIcon(status);
  return (
    <span
      data-bash-status={status}
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${statusTone(status)}`}
    >
      {icon}
      {label}
    </span>
  );
}

function ShellCommandView({
  command,
  language,
  t,
}: {
  command: NonNullable<BashTranscriptModel['command']>;
  language: 'bash' | 'powershell';
  t: ChatTranslator;
}) {
  const commandText = command.displayLines.join('\n');
  const canHighlight = command.displayLines.length <= SYNTAX_HIGHLIGHT_COMMAND_SEGMENT_BUDGET
    && countTextLines(commandText) <= SYNTAX_HIGHLIGHT_LINE_BUDGET
    && commandText.length <= SYNTAX_HIGHLIGHT_CHARACTER_BUDGET;
  return (
    <section
      data-bash-command-source={command.source}
      className="min-w-0 border-b border-[var(--line)] px-3 py-3"
      aria-label={t('shell.toolChrome.bash.command')}
    >
      <h3 className="mb-2 text-xs font-medium text-[var(--code-line-number)]">
        {t('shell.toolChrome.bash.command')}
      </h3>
      <div
        data-syntax-highlighted={canHighlight ? 'true' : 'false'}
        className="min-w-max space-y-1 font-mono text-sm select-text"
      >
        {command.displayLines.map((line, index) => (
          <div key={`${index}:${line}`} className="grid grid-cols-[1.25rem_minmax(max-content,1fr)] items-start">
            <span className="font-semibold leading-6 text-[var(--success)]" aria-hidden="true">
              {command.source === 'command-actions' || index === 0 ? '$' : '›'}
            </span>
            {canHighlight ? (
              <TerminalSyntax text={line || ' '} language={language} />
            ) : (
              <pre className="m-0 min-w-max whitespace-pre font-mono text-sm leading-6 text-[var(--code-text)]">{line}</pre>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function TerminalStreamView({ stream, t }: { stream: BashTranscriptStream; t: ChatTranslator }) {
  const label = streamLabel(stream.kind, t);
  return (
    <section
      data-bash-stream={stream.kind}
      data-bash-format={stream.format}
      className={`min-w-0 border-b border-[var(--line)] px-3 py-3 last:border-b-0 ${stream.kind === 'stderr' ? 'border-l-2 border-l-[var(--error)]' : ''}`}
      aria-label={label}
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className={`text-xs font-medium ${stream.kind === 'stderr' ? 'text-[var(--error)]' : 'text-[var(--code-line-number)]'}`}>
          {label}
        </h3>
        {stream.format !== 'plain' && (
          <span className="rounded border border-[var(--line)] bg-[var(--code-header-bg)] px-1.5 py-0.5 font-mono text-xs text-[var(--code-line-number)]">
            {formatLabel(stream.format, t)}
          </span>
        )}
      </div>
      <TerminalOutput text={stream.displayText} format={stream.format} />
    </section>
  );
}

function TerminalOutput({ text, format }: { text: string; format: BashStreamFormat }) {
  const lineCount = countTextLines(text);
  const canHighlight = format !== 'plain'
    && lineCount <= SYNTAX_HIGHLIGHT_LINE_BUDGET
    && text.length <= SYNTAX_HIGHLIGHT_CHARACTER_BUDGET;

  return (
    <div data-syntax-highlighted={canHighlight ? 'true' : 'false'} className="min-w-max font-mono text-sm leading-6 text-[var(--code-text)] select-text">
      {canHighlight ? (
        <TerminalSyntax text={text || ' '} language={format} />
      ) : (
        <pre className="m-0 min-w-max whitespace-pre font-mono text-sm leading-6 text-[var(--code-text)]">{text}</pre>
      )}
    </div>
  );
}

function TerminalSyntax({ text, language }: { text: string; language: 'bash' | 'powershell' | 'json' | 'diff' }) {
  const prismTheme = useResolvedTheme().adapters.prism;
  const syntaxTheme = useMemo<Record<string, CSSProperties>>(() => ({
    ...prismTheme,
    'pre[class*="language-"]': {
      ...prismTheme['pre[class*="language-"]'],
      margin: 0,
      padding: 0,
      overflow: 'visible',
      background: 'transparent',
      textShadow: 'none',
      borderRadius: 0,
      fontFamily: 'var(--font-code)',
      fontSize: 'var(--text-sm)',
      lineHeight: '1.5rem',
      whiteSpace: 'pre',
    },
    'code[class*="language-"]': {
      ...prismTheme['code[class*="language-"]'],
      display: 'block',
      minWidth: 'max-content',
      background: 'transparent',
      textShadow: 'none',
      fontFamily: 'var(--font-code)',
      fontSize: 'var(--text-sm)',
      lineHeight: '1.5rem',
      whiteSpace: 'pre',
    },
  }), [prismTheme]);
  return (
    <SyntaxHighlighter
      language={language}
      style={syntaxTheme}
      PreTag="div"
      CodeTag="code"
      customStyle={{ margin: 0, padding: 0, overflow: 'visible', background: 'transparent' }}
      codeTagProps={{ className: 'block min-w-max whitespace-pre font-mono text-sm leading-6' }}
      wrapLongLines={false}
    >
      {text}
    </SyntaxHighlighter>
  );
}

function TerminalEmptyState({ status, t }: { status: BashTranscriptStatus; t: ChatTranslator }) {
  const waiting = status === 'initializing' || status === 'running';
  return (
    <div
      data-bash-empty-output="true"
      className="flex min-h-16 items-center gap-2 px-3 py-4 font-mono text-sm text-[var(--code-line-number)]"
    >
      {waiting && (
        <LoaderIcon className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      )}
      <span>{t(waiting ? 'shell.toolChrome.bash.waitingForOutput' : 'shell.toolChrome.bash.noOutput')}</span>
    </div>
  );
}

function statusIcon(status: BashTranscriptStatus): ReactNode {
  if (status === 'running' || status === 'initializing') {
    return <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  }
  if (status === 'completed') return <SuccessIcon className="size-3.5" aria-hidden="true" />;
  if (status === 'timeout') return <ClockIcon className="size-3.5" aria-hidden="true" />;
  if (status === 'stopped' || status === 'interrupted') {
    return <StopCircleIcon className="size-3.5" aria-hidden="true" />;
  }
  if (status === 'failed') return <WarningIcon className="size-3.5" aria-hidden="true" />;
  return <TerminalIcon className="size-3.5" aria-hidden="true" />;
}

function statusTone(status: BashTranscriptStatus): string {
  if (status === 'completed') return 'bg-[var(--success-bg)] text-[var(--success)]';
  if (status === 'failed') return 'bg-[var(--error-bg)] text-[var(--error)]';
  if (status === 'timeout' || status === 'stopped' || status === 'interrupted') {
    return 'bg-[var(--warning-bg)] text-[var(--warning)]';
  }
  if (status === 'running' || status === 'initializing') {
    return 'bg-[var(--accent-warm-subtle)] text-[var(--accent)]';
  }
  return 'bg-[var(--paper-inset)] text-[var(--code-line-number)]';
}

function streamLabel(kind: BashStreamKind, t: ChatTranslator): string {
  if (kind === 'stdout') return t('shell.toolChrome.bash.stdout');
  if (kind === 'stderr') return t('shell.toolChrome.bash.stderr');
  return t('shell.toolChrome.bash.rawOutput');
}

function formatLabel(format: BashStreamFormat, t: ChatTranslator): string {
  if (format === 'json') return t('shell.toolChrome.bash.format.json');
  if (format === 'diff') return t('shell.toolChrome.bash.format.diff');
  return t('shell.toolChrome.bash.format.plain');
}

function buildMetaItems(model: BashTranscriptModel, t: ChatTranslator): string[] {
  const durationLabel = formatBashDuration(model.meta.durationMs);
  const backgroundAfter = formatBashDuration(model.meta.timedOutAfterMs);
  return [
    model.meta.cwd,
    backgroundAfter
      ? t('shell.toolChrome.bash.backgroundedAfter', { duration: backgroundAfter })
      : null,
    model.meta.backgroundCwdHint
      ? t('shell.toolChrome.bash.backgroundCwdUnchanged')
      : null,
    durationLabel ? t('shell.toolChrome.bash.duration', { duration: durationLabel }) : null,
    model.meta.processId ? `PID ${model.meta.processId}` : null,
    model.meta.exitCode !== undefined ? `exit ${model.meta.exitCode}` : null,
  ].filter((item): item is string => !!item);
}

interface TranscriptWindow {
  command: BashTranscriptModel['command'];
  streams: BashTranscriptStream[];
  hasHiddenContent: boolean;
}

function buildTranscriptWindow(
  command: BashTranscriptModel['command'],
  streams: BashTranscriptStream[],
  expanded: boolean,
  hasHiddenCommandContent: boolean,
): TranscriptWindow {
  const lineBudget = expanded ? BASH_TRANSCRIPT_MAX_LINE_BUDGET : INITIAL_TRANSCRIPT_LINE_BUDGET;
  const characterBudget = expanded ? BASH_TRANSCRIPT_MAX_CHARACTER_BUDGET : INITIAL_TRANSCRIPT_CHARACTER_BUDGET;
  const commandNeed = command
    ? measureCommandNeed(command.displayLines, lineBudget, characterBudget)
    : null;
  const streamNeeds = streams.map((stream) => (
    measureTextNeed(stream.displayText, lineBudget, characterBudget)
  ));
  const lineAllocations = allocateFairBudget(
    [
      ...(commandNeed ? [commandNeed.lines] : []),
      ...streamNeeds.map((need) => need.lines),
    ],
    lineBudget,
  );
  const characterAllocations = allocateFairBudget(
    [
      ...(commandNeed ? [commandNeed.characters] : []),
      ...streamNeeds.map((need) => need.characters),
    ],
    characterBudget,
  );
  let hasHiddenContent = hasHiddenCommandContent;
  const commandWindow = command
    ? truncateCommandDisplayLines(
        command.displayLines,
        lineAllocations[0] ?? 0,
        characterAllocations[0] ?? 0,
      )
    : null;
  if (commandWindow?.hasHiddenContent) hasHiddenContent = true;
  const streamOffset = command ? 1 : 0;

  const visibleStreams = streams.map((stream, index) => {
    const displayText = truncateText(
      stream.displayText,
      lineAllocations[index + streamOffset] ?? 0,
      characterAllocations[index + streamOffset] ?? 0,
    );
    if (displayText !== stream.displayText) hasHiddenContent = true;
    return { ...stream, displayText };
  });

  return {
    command: command
      ? {
          ...command,
          displayLines: commandWindow?.displayLines ?? [],
        }
      : null,
    streams: visibleStreams,
    hasHiddenContent,
  };
}

function allocateFairBudget(needs: number[], totalBudget: number): number[] {
  const allocations = needs.map(() => 0);
  let active = needs.map((_, index) => index);
  let remaining = Math.max(0, totalBudget);

  while (active.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / active.length);
    const satisfied = active.filter((index) => needs[index] <= share);
    if (satisfied.length === 0) {
      active.forEach((index) => {
        const allocation = Math.min(needs[index], share);
        allocations[index] = allocation;
        remaining -= allocation;
      });
      for (const index of active) {
        if (remaining <= 0) break;
        if (allocations[index] < needs[index]) {
          allocations[index] += 1;
          remaining -= 1;
        }
      }
      break;
    }
    satisfied.forEach((index) => {
      allocations[index] = needs[index];
      remaining -= needs[index];
    });
    active = active.filter((index) => !satisfied.includes(index));
  }
  return allocations;
}

function truncateText(text: string, maxLines: number, maxCharacters: number): string {
  if (!text || maxLines <= 0 || maxCharacters <= 0) return '';
  let end = Math.min(text.length, maxCharacters);
  let line = 1;
  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    if (line === maxLines) {
      end = index;
      break;
    }
    line += 1;
  }
  const finalCodeUnit = text.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) end -= 1;
  return text.slice(0, end);
}

function truncateCommandDisplayLines(
  displayLines: string[],
  maxLines: number,
  maxCharacters: number,
): { displayLines: string[]; hasHiddenContent: boolean } {
  const visible: string[] = [];
  let remainingLines = maxLines;
  let remainingCharacters = maxCharacters;

  for (const segment of displayLines) {
    if (remainingLines <= 0 || remainingCharacters <= 0) break;
    const truncated = truncateText(segment, remainingLines, remainingCharacters);
    if (truncated) visible.push(truncated);
    remainingLines -= countTextLines(truncated);
    remainingCharacters -= truncated.length;
    if (truncated !== segment) break;
  }

  const hasHiddenContent = visible.length !== displayLines.length
    || visible.some((segment, index) => segment !== displayLines[index]);
  return { displayLines: visible, hasHiddenContent };
}

function countTextLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

interface ContentNeed {
  lines: number;
  characters: number;
  truncated: boolean;
}

function measureTextNeed(text: string, maxLines: number, maxCharacters: number): ContentNeed {
  if (!text) return { lines: 0, characters: 0, truncated: false };
  if (maxLines <= 0 || maxCharacters <= 0) {
    return { lines: 1, characters: Math.min(text.length, 1), truncated: true };
  }
  const scanEnd = Math.min(text.length, maxCharacters + 1);
  let lines = 1;
  for (let index = 0; index < scanEnd; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    lines += 1;
    if (lines > maxLines) break;
  }
  const characters = Math.min(text.length, maxCharacters + 1);
  return {
    lines: Math.min(lines, maxLines + 1),
    characters,
    truncated: text.length > maxCharacters || lines > maxLines,
  };
}

function measureCommandNeed(
  displayLines: string[],
  maxLines: number,
  maxCharacters: number,
): ContentNeed {
  let lines = 0;
  let characters = 0;
  for (const segment of displayLines) {
    const remainingLines = Math.max(0, maxLines - lines);
    const remainingCharacters = Math.max(0, maxCharacters - characters);
    const need = measureTextNeed(segment, remainingLines, remainingCharacters);
    lines += need.lines;
    characters += need.characters;
    if (need.truncated || lines > maxLines || characters > maxCharacters) {
      return {
        lines: Math.min(lines, maxLines + 1),
        characters: Math.min(characters, maxCharacters + 1),
        truncated: true,
      };
    }
  }
  return { lines, characters, truncated: false };
}

function exceedsPresentationRowBudget(
  command: BashTranscriptModel['command'],
  streams: BashTranscriptStream[],
): boolean {
  let rows = 0;
  if (command) {
    rows += 3;
    const need = measureCommandNeed(
      command.displayLines,
      INITIAL_VISIBLE_PRESENTATION_ROWS - rows,
      INITIAL_TRANSCRIPT_CHARACTER_BUDGET,
    );
    rows += need.lines;
    if (need.truncated && need.lines > INITIAL_VISIBLE_PRESENTATION_ROWS - 3) return true;
  }
  for (const stream of streams) {
    rows += 3;
    if (rows > INITIAL_VISIBLE_PRESENTATION_ROWS) return true;
    const need = measureTextNeed(
      stream.displayText,
      INITIAL_VISIBLE_PRESENTATION_ROWS - rows,
      INITIAL_TRANSCRIPT_CHARACTER_BUDGET,
    );
    rows += need.lines;
    if (rows > INITIAL_VISIBLE_PRESENTATION_ROWS) return true;
  }
  if (streams.length === 0) rows += 3;
  return rows > INITIAL_VISIBLE_PRESENTATION_ROWS;
}
