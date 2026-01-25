import type { ToolUseSimple } from '@/types/chat';

import BashOutputTool from './tools/BashOutputTool';
import BashTool from './tools/BashTool';
import { CollapsibleTool } from './tools/CollapsibleTool';
import EditTool from './tools/EditTool';
import GlobTool from './tools/GlobTool';
import GrepTool from './tools/GrepTool';
import KillShellTool from './tools/KillShellTool';
import NotebookEditTool from './tools/NotebookEditTool';
import ReadTool from './tools/ReadTool';
import SkillTool from './tools/SkillTool';
import TaskTool from './tools/TaskTool';
import TodoWriteTool from './tools/TodoWriteTool';
import WebFetchTool from './tools/WebFetchTool';
import WebSearchTool from './tools/WebSearchTool';
import WriteTool from './tools/WriteTool';

interface ToolUseProps {
  tool: ToolUseSimple;
}

export default function ToolUse({ tool }: ToolUseProps) {
  // Route to tool-specific component based on tool name
  switch (tool.name) {
    case 'Bash':
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
    case 'Glob':
      return <GlobTool tool={tool} />;
    case 'Grep':
      return <GrepTool tool={tool} />;
    case 'Skill':
      return <SkillTool tool={tool} />;
    case 'Task':
      return <TaskTool tool={tool} />;
    case 'TodoWrite':
      return <TodoWriteTool tool={tool} />;
    case 'WebFetch':
      return <WebFetchTool tool={tool} />;
    case 'WebSearch':
      return <WebSearchTool tool={tool} />;
    case 'NotebookEdit':
      return <NotebookEditTool tool={tool} />;
    default: {
      // Fallback for unknown tools - show raw JSON
      const collapsedContent = (
        <div className="text-sm text-[var(--ink-muted)]">
          <span className="font-medium">{tool.name}</span>
        </div>
      );

      const expandedContent =
        tool.inputJson ?
          <div className="ml-5">
            <pre className="overflow-x-auto rounded bg-[var(--paper-contrast)]/50 px-2 py-1.5 font-mono text-sm wrap-break-word whitespace-pre-wrap text-[var(--ink-secondary)]">
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
