
import type { BashInput, ToolUseSimple } from '@/types/chat';

import { Terminal, AlertCircle, Loader2 } from 'lucide-react';

interface BashToolProps {
  tool: ToolUseSimple;
}

export default function BashTool({ tool }: BashToolProps) {
  const input = tool.parsedInput as BashInput;

  if (!input) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
        <Loader2 className="size-3 animate-spin" />
        <span>Initializing terminal...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 font-sans">
      {/* Command Display (Dark terminal style) */}
      <div className="group relative overflow-hidden rounded-lg bg-neutral-900 p-3 text-sm text-neutral-200 shadow-sm dark:bg-black border border-neutral-800">
        <div className="flex items-start gap-3 font-mono leading-relaxed">
          <span className="select-none text-green-500 font-bold mt-0.5">$</span>
          <span className="break-all whitespace-pre-wrap">{input.command}</span>
        </div>
        {input.run_in_background && (
          <div className="absolute right-2 top-2 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400 uppercase tracking-wider">
            Background
          </div>
        )}
      </div>

      {/* Result Display */}
      {tool.result && (
        <div className="space-y-1.5">
          <div className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Output</div>
          <pre className={`overflow-x-auto rounded-lg border p-3 font-mono text-xs shadow-sm transition-colors whitespace-pre-wrap ${tool.isError
            ? 'border-[var(--error)]/30 bg-[var(--error-bg)] text-[var(--error)]'
            : 'border-[var(--line-subtle)] bg-[var(--paper-contrast)]/50 text-[var(--ink-secondary)]'
            }`}>
            {tool.result}
          </pre>
        </div>
      )}

      {/* Error without result (?) */}
      {tool.isError && !tool.result && (
        <div className="flex items-center gap-2 rounded-md bg-[var(--error-bg)] p-2 text-xs text-[var(--error)]">
          <AlertCircle className="size-4" />
          <span>Command execution failed</span>
        </div>
      )}
    </div>
  );
}
