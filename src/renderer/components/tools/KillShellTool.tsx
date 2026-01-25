import type { ToolUseSimple } from '@/types/chat';

import { CollapsibleTool } from './CollapsibleTool';
import { ToolHeader } from './utils';

interface KillShellToolProps {
  tool: ToolUseSimple;
}

export default function KillShellTool({ tool }: KillShellToolProps) {
  const collapsedContent = <ToolHeader tool={tool} toolName={tool.name} />;

  const expandedContent =
    tool.result ?
      <pre className="overflow-x-auto rounded bg-[var(--paper-contrast)]/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--ink-secondary)]">
        {tool.result}
      </pre>
    : null;

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
