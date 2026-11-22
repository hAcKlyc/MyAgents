import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchTextLargeValueRef } from '@/api/largeValueRef';
import { getTabServerUrl } from '@/api/tauriClient';
import { useTabApiOptional } from '@/context/TabContext';
import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import type { ToolInput, ToolUseSimple } from '@/types/chat';
import { parsePartialJson } from '@/utils/parsePartialJson';

import BashOutputTool from './tools/BashOutputTool';
import BashTool from './tools/BashTool';
import EditTool from './tools/EditTool';
import FilePatchTool from './tools/FilePatchTool';
import EdgeTtsTool from './tools/EdgeTtsTool';
import GeminiImageTool from './tools/GeminiImageTool';
import GlobTool from './tools/GlobTool';
import GrepTool from './tools/GrepTool';
import KillShellTool from './tools/KillShellTool';
import NotebookEditTool from './tools/NotebookEditTool';
import ReadTool from './tools/ReadTool';
import SkillTool from './tools/SkillTool';
import TaskTool from './tools/TaskTool';
import TodoWriteTool from './tools/TodoWriteTool';
import TaskTodoTool from './tools/TaskTodoTool';
import WebFetchTool from './tools/WebFetchTool';
import WebSearchTool from './tools/WebSearchTool';
import WriteTool from './tools/WriteTool';
import { ExpandableContainer } from './tools/utils';
import CronTaskCard from './scheduled-tasks/CronTaskCard';
import { dshToolDisplayName } from '../../shared/toolDisplay/dshToolNames';


/** Parse cron tool result JSON, returning structured data for card rendering or null on failure */
function parseCronResult(result: string): { taskId: string; name?: string; scheduleDesc?: string; nextExecutionAt?: string } | null {
  try {
    const parsed = JSON.parse(result);
    if (parsed.ok && parsed.taskId) return parsed;
  } catch { /* invalid JSON, fall through */ }
  return null;
}

/** Max chars to display for tool results in the UI.
 *  Larger results (e.g., 16MB Read of a generated HTML file) would create
 *  millions of DOM nodes, destroying virtualization performance.
 *  This is display-only — the full result is still available to the AI.
 *
 *  JSON results (starting with { or [) get a higher limit because
 *  specialized components (TaskTool, WebSearchTool, etc.) parse them
 *  into rich UI — clamping too early would corrupt the JSON. */
const TEXT_DISPLAY_LIMIT = 50_000;
const JSON_DISPLAY_LIMIT = 200_000;

type ChatTranslator = (key: string, options?: Record<string, unknown>) => string;

function clampResult(tool: ToolUseSimple, t: ChatTranslator): ToolUseSimple {
  if (!tool.result) return tool;
  const trimmed = tool.result.trimStart();
  const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  const limit = isJson ? JSON_DISPLAY_LIMIT : TEXT_DISPLAY_LIMIT;
  if (tool.result.length <= limit) return tool;
  const shown = limit.toLocaleString();
  const total = tool.result.length.toLocaleString();
  return {
    ...tool,
    result: `${tool.result.slice(0, limit)}\n\n${t('shell.toolChrome.truncate.result', { shown, total })}`,
  };
}

interface ToolUseProps {
  tool: ToolUseSimple;
}

export default function ToolUse({ tool: rawTool }: ToolUseProps) {
  const { t } = useTranslation('chat');
  const input = rawTool.parsedInput
    ?? (rawTool.inputJson ? parsePartialJson(rawTool.inputJson) as ToolInput | null : null)
    ?? (Object.keys(rawTool.input ?? {}).length > 0 ? rawTool.input as ToolInput : undefined);
  const toolWithInput = input === rawTool.parsedInput ? rawTool : { ...rawTool, parsedInput: input };
  const resultRef = toolWithInput.resultMeta?.largeValueRef;
  if (resultRef) return <ToolUseWithResultRef key={resultRef.id} tool={toolWithInput} resultRef={resultRef} t={t} />;
  return renderToolBody(toolWithInput, t);
}

function ToolUseWithResultRef({ tool, resultRef, t }: {
  tool: ToolUseSimple;
  resultRef: NonNullable<NonNullable<ToolUseSimple['resultMeta']>['largeValueRef']>;
  t: ChatTranslator;
}) {
  const tab = useTabApiOptional();
  const notifyRowLayoutChanged = useNotifyRowLayoutChanged();
  const pending = useRef<AbortController | null>(null);
  const [fullResult, setFullResult] = useState<string>();
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  useEffect(() => () => pending.current?.abort(), []);

  const loadResult = async () => {
    if (!tab || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoadState('loading');
    try {
      const baseUrl = await getTabServerUrl(tab.tabId);
      const value = await fetchTextLargeValueRef(baseUrl, resultRef, controller.signal);
      if (controller.signal.aborted) return;
      notifyRowLayoutChanged('expandable-container-expand');
      setFullResult(value);
      setLoadState('idle');
    } catch {
      if (!controller.signal.aborted) setLoadState('error');
    } finally {
      pending.current = null;
    }
  };

  const displayedTool = fullResult === undefined ? tool : {
    ...tool,
    result: fullResult,
    resultMeta: { ...tool.resultMeta, largeValueRef: undefined },
  };
  // NOTE: tool.attachments are NOT rendered here. ToolUse lives inside
  // ProcessRow's collapsible body (BlockGroup), so rendering rich-media here
  // buried the player inside the folded tool window (PRD 0.2.30 bug). The
  // split (#293, by attachment.presentation): ARTIFACT media is hoisted to the
  // message flow in Message.tsx (standalone, always-visible in-flow cards);
  // PROCESS media (screenshots) is rendered by ProcessRow right after this
  // component inside the expanded body — deliberately behind the fold.
  return (
    <div className="space-y-2">
      {renderToolBody(displayedTool, t)}
      {fullResult === undefined && tab && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={loadState === 'loading'}
            onClick={() => void loadResult()}
            className="min-h-8 rounded-md border border-[var(--line)] px-2 text-xs text-[var(--ink-secondary)] hover:bg-[var(--paper-inset)] disabled:cursor-wait"
          >
            {t(loadState === 'loading' ? 'shell.toolChrome.common.loadingOutput' : 'shell.toolChrome.common.loadOutput')}
          </button>
          {loadState === 'error' && <span role="alert" className="text-xs text-[var(--error)]">{t('shell.toolChrome.common.loadOutputFailed')}</span>}
        </div>
      )}
    </div>
  );
}

function renderToolBody(fullTool: ToolUseSimple, t: ChatTranslator): React.JSX.Element {
  const name = dshToolDisplayName(fullTool.name);
  // These components parse their structured result before limiting its presentation.
  const tool = ['Bash', 'PowerShell', 'bash', 'pwsh', 'Edit', 'MultiEdit', 'Write'].includes(name)
    ? fullTool : clampResult(fullTool, t);
  switch (name) {
    case 'bash':
    case 'pwsh':
    case 'Bash':
    case 'PowerShell':
      return <BashTool tool={tool} />;
    case 'BashOutput':
      return <BashOutputTool tool={tool} />;
    case 'KillShell':
      return <KillShellTool tool={tool} />;
    case 'Read':
      return <ReadTool tool={tool} />;
    case 'Write':
      return <WriteTool tool={tool} />;
    case 'Edit':
      return <EditTool tool={tool} />;
    case 'MultiEdit':
      return <FilePatchTool tool={tool} />;
    case 'Glob':
      return <GlobTool tool={tool} />;
    case 'Grep':
      return <GrepTool tool={tool} />;
    case 'Skill':
      return <SkillTool tool={tool} />;
    // PRD 0.2.27 — Codex 'CollabAgent' spawn card renders as a sub-agent
    // container (same expandable nested-trace UI as builtin Task / Agent).
    case 'Task':
    case 'Agent':
    case 'CollabAgent':
      return <TaskTool tool={tool} />;
    case 'TodoWrite':
      return <TodoWriteTool tool={tool} />;
    // SDK 0.3.142+ incremental Task tools (replaced TodoWrite). NOTE: distinct from
    // the sub-agent launcher 'Task'/'Agent' above — different tools, same word.
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList':
      return <TaskTodoTool tool={tool} />;
    case 'WebFetch':
      return <WebFetchTool tool={tool} />;
    case 'WebSearch':
      return <WebSearchTool tool={tool} />;
    case 'NotebookEdit':
      return <NotebookEditTool tool={tool} />;
    default: {
      // Route gemini-image MCP tools to custom component
      if (tool.name.startsWith('mcp__gemini-image__')) {
        return <GeminiImageTool tool={tool} />;
      }
      // Route edge-tts MCP tools to custom component
      if (tool.name.startsWith('mcp__edge-tts__')) {
        return <EdgeTtsTool tool={tool} />;
      }
      // Route cron tool results to task card
      if (
        (tool.name.startsWith('mcp__cron-tools__') || tool.name.startsWith('mcp__im-cron__'))
        && tool.result
      ) {
        const cronResult = parseCronResult(tool.result);
        if (cronResult) {
          return (
            <CronTaskCard
              taskId={cronResult.taskId}
              name={cronResult.name}
              scheduleDesc={cronResult.scheduleDesc}
              nextExecutionAt={cronResult.nextExecutionAt}
            />
          );
        }
      }

      return (
        <div className="space-y-3">
          {tool.parsedInput || tool.inputJson ? (
            <ToolDetailsSection title={t('shell.toolChrome.common.parameters')}>
              {tool.inputJson ?? JSON.stringify(tool.parsedInput, null, 2)}
            </ToolDetailsSection>
          ) : null}
          {tool.result !== undefined || tool.isError || tool.isFailed || tool.isStopped ? (
            <ToolDetailsSection title={t('shell.toolChrome.common.output')} error={tool.isError || tool.isFailed}>
              {tool.result || t('shell.toolChrome.bash.noOutput')}
            </ToolDetailsSection>
          ) : null}
        </div>
      );
    }
  }
}

function ToolDetailsSection({ title, children, error }: { title: string; children: string | undefined; error?: boolean }) {
  return (
    <section className="space-y-1" aria-label={title}>
      <h3 className={`text-xs font-medium ${error ? 'text-[var(--error)]' : 'text-[var(--ink-muted)]'}`}>{title}</h3>
      <ExpandableContainer wrapperClassName="rounded bg-[var(--paper-inset)]">
        <pre className="whitespace-pre-wrap wrap-break-word px-2 py-1.5 font-mono text-sm text-[var(--ink-secondary)]">
          {children}
        </pre>
      </ExpandableContainer>
    </section>
  );
}
