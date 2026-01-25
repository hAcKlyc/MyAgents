import type { ToolUseSimple, WriteInput } from '@/types/chat';

import { CollapsibleTool } from './CollapsibleTool';
import { FilePath, ToolHeader } from './utils';

interface WriteToolProps {
  tool: ToolUseSimple;
}

export default function WriteTool({ tool }: WriteToolProps) {
  const input = tool.parsedInput as WriteInput;

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
      <FilePath path={input.file_path} />
    </div>
  );

  const expandedContent = (
    <pre className="overflow-x-auto rounded bg-[var(--paper-contrast)]/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--ink-secondary)]">
      {input.content || ''}
    </pre>
  );

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
