import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolUseSimple } from '@/types/chat';

import BashOutputTool from './tools/BashOutputTool';
import BashTool from './tools/BashTool';
import { CollapsibleTool } from './tools/CollapsibleTool';
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
import CronTaskCard from './scheduled-tasks/CronTaskCard';
import { ExpandableResult } from './tools/utils';
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
  resultOnly?: boolean;
}

export default function ToolUse({ tool: rawTool, resultOnly = false }: ToolUseProps) {
  const { t } = useTranslation('chat');
  // Bash and file-patch tools own specialized, bounded projections. Generic
  // pre-clamping would corrupt their structured completion wrappers before the
  // authoritative parser can separate streams or applied file changes.
  const ownsBoundedProjection = ['Bash', 'bash', 'pwsh'].includes(rawTool.name)
    || rawTool.name === 'PowerShell'
    || dshToolDisplayName(rawTool.name) === 'Edit'
    || rawTool.name === 'MultiEdit'
    || dshToolDisplayName(rawTool.name) === 'Write';
  const tool = ownsBoundedProjection ? rawTool : clampResult(rawTool, t);
  // NOTE: tool.attachments are NOT rendered here. ToolUse lives inside
  // ProcessRow's collapsible body (BlockGroup), so rendering rich-media here
  // buried the player inside the folded tool window (PRD 0.2.30 bug). The
  // split (#293, by attachment.presentation): ARTIFACT media is hoisted to the
  // message flow in Message.tsx (standalone, always-visible in-flow cards);
  // PROCESS media (screenshots) is rendered by ProcessRow right after this
  // component inside the expanded body — deliberately behind the fold.
  return renderToolBody(tool, resultOnly, t);
}

function renderToolBody(tool: ToolUseSimple, resultOnly: boolean, t: ChatTranslator): React.JSX.Element {
  if (resultOnly && ['Read', 'Grep', 'Glob', 'Skill', 'BashOutput', 'KillShell'].includes(dshToolDisplayName(tool.name))) {
    return <ExpandableResult content={tool.result ?? t('process.result.awaiting')} />;
  }
  switch (dshToolDisplayName(tool.name)) {
    case 'bash':
    case 'pwsh':
    case 'Bash':
    case 'PowerShell':
      return <BashTool tool={tool} resultOnly={resultOnly} />;
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

      if (resultOnly) return <ExpandableResult content={tool.result ?? t('process.result.awaiting')} />;

      // Fallback for unknown tools - show raw JSON
      const collapsedContent = (
        <div className="text-sm text-[var(--ink-muted)]">
          <span className="font-medium">{tool.name}</span>
        </div>
      );

      const expandedContent =
        tool.inputJson ?
          <div className="ml-5">
            <pre className="overflow-x-auto rounded bg-[var(--paper-inset)]/50 px-2 py-1.5 font-mono text-sm wrap-break-word whitespace-pre-wrap text-[var(--ink-secondary)]">
              {tool.inputJson}
            </pre>
          </div>
        : null;

      return (
        <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />
      );
    }
  }
}
