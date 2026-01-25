import type { GrepInput, ToolUseSimple } from '@/types/chat';

import { CollapsibleTool } from './CollapsibleTool';
import { InlineCode, ToolHeader } from './utils';

interface GrepToolProps {
  tool: ToolUseSimple;
}

export default function GrepTool({ tool }: GrepToolProps) {
  const input = tool.parsedInput as GrepInput;

  if (!input) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader tool={tool} toolName={tool.name} />
      <InlineCode>{input.pattern}</InlineCode>
      {input.path && (
        <span className="text-[10px] text-[var(--ink-muted)]">in {input.path}</span>
      )}
    </div>
  );

  const expandedContent =
    tool.result ?
      <pre className="overflow-x-auto rounded bg-[var(--paper-contrast)]/50 px-2 py-1 font-mono text-sm wrap-break-word whitespace-pre-wrap text-[var(--ink-secondary)]">
        {tool.result}
      </pre>
    : null;

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
