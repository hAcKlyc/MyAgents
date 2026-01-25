import { Paperclip, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { formatFileSize } from '@/utils/formatFileSize';

export interface AttachmentPreviewItem {
  id: string;
  name: string;
  size: number;
  isImage?: boolean;
  previewUrl?: string;
  footnoteLines?: string[];
}

interface AttachmentPreviewListProps {
  attachments: AttachmentPreviewItem[];
  onRemove?: (id: string) => void;
  onPreview?: (url: string, name: string) => void;
  className?: string;
  cardClassName?: string;
  imageDimensions?: string;
  compact?: boolean; // Compact mode for 5-per-row grid
}

export default function AttachmentPreviewList({
  attachments,
  onRemove,
  onPreview,
  className = '',
  cardClassName = '',
  imageDimensions = 'h-16 w-16',
  compact = false
}: AttachmentPreviewListProps) {
  const [previewErrorIds, setPreviewErrorIds] = useState<string[]>([]);
  const previewErrorIdSet = useMemo(() => {
    const validIds = new Set(attachments.map((attachment) => attachment.id));
    return new Set(previewErrorIds.filter((id) => validIds.has(id)));
  }, [attachments, previewErrorIds]);

  const markPreviewError = (attachmentId: string) => {
    setPreviewErrorIds((prev) => (prev.includes(attachmentId) ? prev : [...prev, attachmentId]));
  };

  const handleRemove = (attachmentId: string) => {
    setPreviewErrorIds((prev) => prev.filter((id) => id !== attachmentId));
    onRemove?.(attachmentId);
  };

  if (attachments.length === 0) {
    return null;
  }

  // Use grid layout for compact mode (5 items per row)
  const containerClass = compact
    ? `grid grid-cols-5 gap-1.5 ${className}`
    : `flex flex-wrap gap-3 ${className}`;

  return (
    <div className={containerClass}>
      {attachments.map((attachment) => {
        const showImagePreview =
          attachment.isImage && attachment.previewUrl && !previewErrorIdSet.has(attachment.id);

        return (
          <div
            key={attachment.id}
            className={`relative ${compact ? 'rounded-lg' : 'rounded-2xl'} border border-[var(--line)] bg-[var(--paper-strong)] shadow-[var(--shadow-soft)] ${cardClassName}`}
          >
            {showImagePreview ?
              <div
                className={`relative overflow-hidden ${compact ? 'rounded-lg' : 'rounded-2xl'} ${imageDimensions} cursor-pointer`}
                onDoubleClick={() => onPreview?.(attachment.previewUrl!, attachment.name)}
              >
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-full w-full object-cover"
                  onError={() => markPreviewError(attachment.id)}
                  loading="lazy"
                />
                {!compact && (
                  <div className="absolute inset-x-1 bottom-1 rounded-md bg-[var(--ink)]/70 px-1 py-0.5 text-[10px] font-medium text-[var(--paper-strong)]">
                    <span className="block truncate">{attachment.name}</span>
                  </div>
                )}
              </div>
              : <div className="flex min-w-[14rem] items-center gap-3 px-3 py-2">
                <div className="rounded-full bg-[var(--paper-contrast)] p-2 text-[var(--ink)]">
                  <Paperclip className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-[var(--ink)]">
                    {attachment.name}
                  </p>
                  <p className="text-[11px] text-[var(--ink-muted)]">
                    {formatFileSize(attachment.size)}
                  </p>
                  {attachment.footnoteLines?.map((line, index) => (
                    <p
                      key={`${attachment.id}-footnote-${index}`}
                      className="text-[11px] text-[var(--ink-muted)]"
                    >
                      {line}
                    </p>
                  ))}
                </div>
              </div>
            }
            {onRemove && (
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => handleRemove(attachment.id)}
                className="absolute top-1.5 right-1.5 rounded-full bg-[var(--paper-strong)]/95 p-1 text-[var(--ink)] shadow-sm transition hover:bg-[var(--paper-strong)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
