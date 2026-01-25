import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';

interface CollapsibleToolProps {
  collapsedContent: ReactNode;
  expandedContent: ReactNode | null;
  defaultExpanded?: boolean;
}

export function CollapsibleTool({
  collapsedContent,
  expandedContent,
  defaultExpanded = false
}: CollapsibleToolProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const hasExpandedContent = expandedContent !== null && expandedContent !== undefined;

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => hasExpandedContent && setIsExpanded(!isExpanded)}
        disabled={!hasExpandedContent}
        aria-expanded={isExpanded}
        className={`flex w-full items-center gap-1.5 text-left transition-colors ${
          hasExpandedContent ?
            'cursor-pointer text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
          : 'cursor-default text-[var(--ink-muted)]/70'
        }`}
      >
        <div className="flex-1">{collapsedContent}</div>
        {hasExpandedContent && (
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-[var(--ink-muted)] transition-colors">
            {isExpanded ?
              <ChevronUp className="size-3" />
            : <ChevronDown className="size-3" />}
          </span>
        )}
      </button>
      {isExpanded && hasExpandedContent && (
        <div className="collapsible-tool-expanded mt-1 ml-3 border-l border-[var(--line-subtle)] pl-2.5">
          <div className="space-y-1.5">{expandedContent}</div>
        </div>
      )}
    </div>
  );
}
