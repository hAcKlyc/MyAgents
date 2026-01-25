import type { NotebookEditInput, ToolUseSimple } from '@/types/chat';

import { CollapsibleTool } from './CollapsibleTool';
import { FilePath, ToolHeader } from './utils';

interface NotebookEditToolProps {
  tool: ToolUseSimple;
}

export default function NotebookEditTool({ tool }: NotebookEditToolProps) {
  const input = tool.parsedInput as NotebookEditInput;

  if (!input) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  const editMode = input.edit_mode || 'replace';
  const cellType = input.cell_type || 'code';

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader tool={tool} toolName={tool.name} />
      <FilePath path={input.notebook_path} />
      {input.cell_id && (
        <span className="text-[10px] text-[var(--ink-muted)]">
          cell: {input.cell_id}
        </span>
      )}
    </div>
  );

  const expandedContent = (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="rounded border border-[var(--accent-cool)]/30 bg-[var(--accent-cool)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-cool)]">
          {cellType}
        </span>
      </div>

      {editMode !== 'delete' && (
        <pre className="overflow-x-auto rounded bg-[var(--paper-contrast)]/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--ink-secondary)]">
          {input.new_source || ''}
        </pre>
      )}
    </div>
  );

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
