
import type { ContentBlock } from '@/types/chat';
import ProcessRow from './ProcessRow';

interface BlockGroupProps {
  blocks: ContentBlock[];
  isLatestActiveSection?: boolean;
  isStreaming?: boolean;
  hasTextAfter?: boolean;
}

export default function BlockGroup({
  blocks,
  isLatestActiveSection = false,
  isStreaming = false
}: BlockGroupProps) {
  if (blocks.length === 0) return null;

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-contrast)]/30 transition-all">
      <div className="flex flex-col divide-y divide-[var(--line-subtle)]">
        {blocks.map((block, index) => (
          <ProcessRow
            key={index}
            block={block}
            index={index}
            totalBlocks={blocks.length}
            isStreaming={isStreaming && isLatestActiveSection}
          />
        ))}
      </div>
    </div>
  );
}
