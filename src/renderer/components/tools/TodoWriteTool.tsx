
import { Check, Circle, Loader2 } from 'lucide-react';

import type { TodoWriteInput, ToolUseSimple } from '@/types/chat';

interface TodoWriteToolProps {
  tool: ToolUseSimple;
}

export default function TodoWriteTool({ tool }: TodoWriteToolProps) {
  const input = tool.parsedInput as TodoWriteInput;

  if (!input || !input.todos) {
    return <div className="text-sm text-[var(--ink-muted)]">加载待办事项...</div>;
  }

  const completedCount = input.todos.filter((t) => t.status === 'completed').length;
  const totalCount = input.todos.length;

  return (
    <div className="flex flex-col gap-3">
      {/* Summary Header */}
      <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
        <span className="font-medium tabular-nums">
          {completedCount}/{totalCount} 已完成
        </span>
      </div>

      {/* Todo Items with checkbox style */}
      <div className="space-y-1">
        {input.todos.map((todo, index) => {
          const isCompleted = todo.status === 'completed';
          const isInProgress = todo.status === 'in_progress';

          return (
            <div
              key={index}
              className={`flex items-start gap-3 rounded-lg px-3 py-2 transition-colors ${isInProgress
                  ? 'bg-[var(--accent)]/10'
                  : 'hover:bg-[var(--paper-contrast)]'
                }`}
            >
              {/* Checkbox */}
              <div className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border-2 transition-colors ${isCompleted
                  ? 'border-[var(--success)] bg-[var(--success)] text-white'
                  : isInProgress
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                    : 'border-[var(--line)]'
                }`}>
                {isCompleted ? (
                  <Check className="size-3.5" strokeWidth={3} />
                ) : isInProgress ? (
                  <Loader2 className="size-3 animate-spin text-[var(--accent)]" />
                ) : null}
              </div>

              {/* Content */}
              <span
                className={`flex-1 text-sm leading-relaxed ${isCompleted
                    ? 'text-[var(--ink-muted)] line-through'
                    : isInProgress
                      ? 'text-[var(--accent)] font-medium'
                      : 'text-[var(--ink-secondary)]'
                  }`}
              >
                {todo.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
