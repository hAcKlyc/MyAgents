import { memo } from 'react';

import AttachmentPreviewList from '@/components/AttachmentPreviewList';
import BlockGroup from '@/components/BlockGroup';
import Markdown from '@/components/Markdown';
import { useImagePreview } from '@/context/ImagePreviewContext';
import type { ContentBlock, Message as MessageType } from '@/types/chat';

interface MessageProps {
  message: MessageType;
  isLoading?: boolean;
}

/**
 * Deep compare message content for memo optimization.
 * Returns true if content is equal (skip re-render), false otherwise.
 */
function areMessagesEqual(prev: MessageProps, next: MessageProps): boolean {
  // Different loading state -> must re-render
  if (prev.isLoading !== next.isLoading) return false;

  const prevMsg = prev.message;
  const nextMsg = next.message;

  // Same reference -> definitely equal (fast path for history messages)
  if (prevMsg === nextMsg) return true;

  // Different ID -> different message
  if (prevMsg.id !== nextMsg.id) return false;

  // For streaming messages, check content changes
  if (typeof prevMsg.content === 'string' && typeof nextMsg.content === 'string') {
    return prevMsg.content === nextMsg.content;
  }

  // ContentBlock array - compare by reference (streaming updates create new arrays)
  // This allows streaming message to re-render while history messages stay stable
  return prevMsg.content === nextMsg.content;
}

/**
 * Parse SDK local command output tags from user message content.
 * SDK wraps local command output (like /cost, /context) in <local-command-stdout> tags.
 * Returns { isLocalCommand: true, content: string } if found, otherwise { isLocalCommand: false }.
 */
function parseLocalCommandOutput(content: string): { isLocalCommand: boolean; content: string } {
  const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (match) {
    return { isLocalCommand: true, content: match[1].trim() };
  }
  return { isLocalCommand: false, content };
}

/**
 * Format local command output for better readability.
 * SDK outputs like /cost already have proper newlines, but contain $ signs
 * that trigger LaTeX math mode in our Markdown renderer (KaTeX).
 * This function escapes $ to prevent unintended math rendering.
 */
function formatLocalCommandOutput(content: string): string {
  // Escape $ signs that trigger LaTeX math mode
  // Example: "$0.0576" -> "\$0.0576"
  return content.replace(/\$/g, '\\$');
}

/**
 * Message component with memo optimization.
 * History messages won't re-render when streaming message updates.
 */
const Message = memo(function Message({ message, isLoading = false }: MessageProps) {
  const { openPreview } = useImagePreview();

  if (message.role === 'user') {
    const userContent = typeof message.content === 'string' ? message.content : '';
    const hasAttachments = Boolean(message.attachments?.length);
    const attachmentItems =
      message.attachments?.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        isImage: attachment.isImage ?? attachment.mimeType.startsWith('image/'),
        previewUrl: attachment.previewUrl,
        footnoteLines: [attachment.relativePath ?? attachment.savedPath].filter(
          (line): line is string => Boolean(line)
        )
      })) ?? [];

    // Check if this is a local command output (like /cost, /context)
    const parsed = parseLocalCommandOutput(userContent);

    // Local command output - render as system info block (left-aligned)
    if (parsed.isLocalCommand) {
      const formattedContent = formatLocalCommandOutput(parsed.content);
      return (
        <div className="flex justify-start w-full px-4 py-2">
          <div className="w-full max-w-none rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]/50 p-4">
            <div className="text-xs font-medium text-[var(--ink-muted)] mb-2">系统信息</div>
            <div className="text-sm text-[var(--ink)]">
              <Markdown>{formattedContent}</Markdown>
            </div>
          </div>
        </div>
      );
    }

    const hasText = userContent.trim().length > 0;

    return (
      <div className="flex justify-end px-1" data-role="user" data-message-id={message.id}>
        <article className="relative max-w-[min(34rem,calc(100%-2rem))] rounded-2xl border border-[var(--line)] bg-[var(--paper-strong)] px-4 py-3 text-base leading-relaxed text-[var(--ink)] shadow-[var(--shadow-soft)]">
          {/* Images first (above text) - compact mode for 5 per row */}
          {hasAttachments && (
            <div className={hasText ? 'mb-2' : ''}>
              <AttachmentPreviewList
                attachments={attachmentItems}
                compact
                onPreview={openPreview}
              />
            </div>
          )}
          {/* Text below images */}
          {hasText && (
            <div className="text-[var(--ink)]">
              <Markdown preserveNewlines>{userContent}</Markdown>
            </div>
          )}
        </article>
      </div>
    );
  }

  // Assistant message
  if (typeof message.content === 'string') {
    return (
      <div className="flex justify-start w-full px-4 py-2">
        <div className="w-full max-w-none text-[var(--ink)]">
          <Markdown>{message.content}</Markdown>
        </div>
      </div>
    );
  }

  // Group consecutive thinking/tool blocks together
  const groupedBlocks: (ContentBlock | ContentBlock[])[] = [];
  let currentGroup: ContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'text') {
      // If we have a group, add it before the text block
      if (currentGroup.length > 0) {
        groupedBlocks.push([...currentGroup]);
        currentGroup = [];
      }
      groupedBlocks.push(block);
    } else if (block.type === 'thinking' || block.type === 'tool_use' || block.type === 'server_tool_use') {
      // Add to current group (server_tool_use is treated like tool_use for display)
      currentGroup.push(block);
    }
  }

  // Add any remaining group
  if (currentGroup.length > 0) {
    groupedBlocks.push(currentGroup);
  }

  // Determine which BlockGroup is the latest active section
  // Find the last BlockGroup index
  const lastBlockGroupIndex = groupedBlocks.findLastIndex((item) => Array.isArray(item));

  // Check if there are any incomplete blocks (still streaming)
  const hasIncompleteBlocks = message.content.some((block) => {
    if (block.type === 'thinking') {
      return !block.isComplete;
    }
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      // Tool is incomplete if it doesn't have a result yet
      // server_tool_use is treated the same as tool_use for streaming state
      const subagentRunning = block.tool?.subagentCalls?.some((call) => call.isLoading);
      return Boolean(block.tool?.isLoading) || Boolean(subagentRunning) || !block.tool?.result;
    }
    return false;
  });

  const isStreaming = isLoading && hasIncompleteBlocks;

  return (
    <div className="flex justify-start">
      <article className="w-full px-3 py-2">
        <div className="space-y-3">
          {groupedBlocks.map((item, index) => {
            // Single text block
            if (!Array.isArray(item)) {
              if (item.type === 'text' && item.text) {
                return (
                  <div
                    key={index}
                    className="flex justify-start w-full px-1 py-1"
                  >
                    <div className="w-full max-w-none text-[var(--ink)]">
                      <Markdown>{item.text}</Markdown>
                    </div>
                  </div>
                );
              }
              return null;
            }

            // Group of thinking/tool blocks
            const isLatestActiveSection = index === lastBlockGroupIndex;
            const hasTextAfter =
              index < groupedBlocks.length - 1 &&
              groupedBlocks
                .slice(index + 1)
                .some((nextItem) => !Array.isArray(nextItem) && nextItem.type === 'text');

            return (
              <BlockGroup
                key={`group-${index}`}
                blocks={item}
                isLatestActiveSection={isLatestActiveSection}
                isStreaming={isStreaming}
                hasTextAfter={hasTextAfter}
              />
            );
          })}
        </div>
      </article>
    </div>
  );
}, areMessagesEqual);

export default Message;
