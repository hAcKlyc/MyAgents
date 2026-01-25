import { ArrowUp, Loader2, Paperclip, Square } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import AttachmentPreviewList from '@/components/AttachmentPreviewList';

import type { ChatModelPreference, SmartModelVariant } from '../../shared/types/ipc';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  isLoading: boolean;
  onStopStreaming?: () => void;
  autoFocus?: boolean;
  onHeightChange?: (height: number) => void;
  attachments?: {
    id: string;
    file: File;
    previewUrl?: string;
    previewIsBlobUrl?: boolean;
    isImage: boolean;
  }[];
  onFilesSelected?: (files: FileList | File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  canSend?: boolean;
  attachmentError?: string | null;
  modelPreference: ChatModelPreference;
  onModelPreferenceChange: (preference: ChatModelPreference) => void;
  isModelPreferenceUpdating?: boolean;
}

export default function ChatInput({
  value,
  onChange,
  onSend,
  isLoading,
  onStopStreaming,
  autoFocus = false,
  onHeightChange,
  attachments = [],
  onFilesSelected,
  onRemoveAttachment,
  canSend,
  attachmentError,
  modelPreference,
  onModelPreferenceChange,
  isModelPreferenceUpdating = false
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const MIN_TEXTAREA_HEIGHT = 44;
  const MAX_TEXTAREA_HEIGHT = 200;
  const lastReportedHeightRef = useRef<number | null>(null);
  const dragCounterRef = useRef(0);
  const lastSmartPreferenceRef = useRef<ChatModelPreference>('smart-sonnet');
  const [isDragActive, setIsDragActive] = useState(false);
  const computedCanSend = canSend ?? Boolean(value.trim());
  const isSmartMode = modelPreference !== 'fast';
  const smartVariant = modelPreference === 'smart-opus' ? 'opus' : 'sonnet';

  const modelPillClass = (isActive: boolean, size: 'default' | 'compact' = 'default') =>
    `rounded-full ${size === 'compact' ? 'px-2.5 py-1' : 'px-3 py-1'} text-xs font-semibold transition ${
      isActive ?
        'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
      : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white'
    } ${isModelPreferenceUpdating ? 'opacity-70' : ''}`;

  const handleModelPreferenceSelect = (preference: ChatModelPreference) => {
    if (preference === modelPreference) return;
    if (isModelPreferenceUpdating) return;
    onModelPreferenceChange(preference);
  };

  const handlePrimaryModelToggle = (mode: 'fast' | 'smart') => {
    if (mode === 'fast') {
      handleModelPreferenceSelect('fast');
      return;
    }

    const nextPreference = isSmartMode ? modelPreference : lastSmartPreferenceRef.current;
    handleModelPreferenceSelect(nextPreference);
  };

  const handleSmartModelToggle = (variant: SmartModelVariant) => {
    const nextPreference: ChatModelPreference = variant === 'opus' ? 'smart-opus' : 'smart-sonnet';
    handleModelPreferenceSelect(nextPreference);
  };

  const reportHeight = useCallback(
    (height: number) => {
      if (!onHeightChange) return;
      const roundedHeight = Math.round(height);
      if (lastReportedHeightRef.current === roundedHeight) return;
      lastReportedHeightRef.current = roundedHeight;
      onHeightChange(roundedHeight);
    },
    [onHeightChange]
  );

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const measuredHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${Math.max(measuredHeight, MIN_TEXTAREA_HEIGHT)}px`;
  };

  // Auto-focus when autoFocus is true
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isLoading && computedCanSend) {
        onSend();
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    const items = Array.from(clipboardData.items);
    const fileItems = items.filter((item) => item.kind === 'file');

    if (fileItems.length > 0) {
      e.preventDefault();
      const files: File[] = [];

      for (const item of fileItems) {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }

      if (files.length > 0) {
        onFilesSelected?.(files);
      }
    }
  };

  const handleInputContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only focus if clicking on the container itself, not on interactive elements
    const target = e.target as HTMLElement;
    if (target.tagName !== 'TEXTAREA' && target.tagName !== 'BUTTON' && textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleTextareaInput = () => {
    adjustTextareaHeight();
  };

  const handleRemoveAttachmentClick = (attachmentId: string) => {
    onRemoveAttachment?.(attachmentId);
  };

  const handleAttachmentButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) {
      onFilesSelected?.(event.target.files);
    }
    event.target.value = '';
  };

  const isFileDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragCounterRef.current += 1;
    setIsDragActive(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragActive(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragCounterRef.current = 0;
    setIsDragActive(false);
    if (event.dataTransfer?.files?.length) {
      onFilesSelected?.(event.dataTransfer.files);
      event.dataTransfer.clearData();
    }
  };

  useEffect(() => {
    adjustTextareaHeight();
  }, [value]);

  useEffect(() => {
    if (isSmartMode) {
      lastSmartPreferenceRef.current = modelPreference;
    }
  }, [isSmartMode, modelPreference]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    reportHeight(element.getBoundingClientRect().height);

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      reportHeight(entry.contentRect.height);
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, [reportHeight]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-x-0 bottom-0 z-10 px-4 pt-6 pb-5 [-webkit-app-region:no-drag]"
    >
      <div className="mx-auto max-w-3xl">
        <div
          className={`rounded-3xl bg-white/95 p-2 shadow-[0_20px_60px_rgba(15,23,42,0.15)] backdrop-blur-xl dark:bg-neutral-900/90 dark:shadow-[0_16px_50px_rgba(0,0,0,0.65)] ${
            isDragActive ?
              'ring-2 ring-neutral-400/80 dark:ring-neutral-500/80'
            : 'ring-1 ring-neutral-200/80 dark:ring-neutral-700/70'
          }`}
          onClick={handleInputContainerClick}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />

          {attachments.length > 0 && (
            <AttachmentPreviewList
              attachments={attachments.map((attachment) => ({
                id: attachment.id,
                name: attachment.file.name,
                size: attachment.file.size,
                isImage: attachment.isImage,
                previewUrl: attachment.previewUrl
              }))}
              onRemove={handleRemoveAttachmentClick}
              className="mb-2 px-2"
            />
          )}

          {attachmentError && (
            <p className="px-3 pb-2 text-xs text-red-600 dark:text-red-400">{attachmentError}</p>
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="How can I help you today?"
            rows={1}
            className="w-full resize-none border-0 bg-transparent px-3 py-2 text-neutral-900 placeholder-neutral-400 focus:outline-none dark:text-neutral-100 dark:placeholder-neutral-500"
            style={{
              minHeight: `${MIN_TEXTAREA_HEIGHT}px`,
              maxHeight: `${MAX_TEXTAREA_HEIGHT}px`
            }}
            onInput={handleTextareaInput}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 px-2 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleAttachmentButtonClick}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-neutral-200/80 bg-neutral-100 text-neutral-600 transition hover:bg-neutral-200 focus:ring-2 focus:ring-neutral-400 focus:outline-none dark:border-neutral-700/70 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700 dark:focus:ring-neutral-500"
                title="Attach files"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <div className="flex h-10 items-center gap-2 rounded-full border border-neutral-200/80 bg-neutral-100 px-2 py-1 transition dark:border-neutral-700/70 dark:bg-neutral-800">
                <button
                  type="button"
                  aria-pressed={!isSmartMode}
                  onClick={() => handlePrimaryModelToggle('fast')}
                  disabled={isModelPreferenceUpdating}
                  className={modelPillClass(!isSmartMode)}
                >
                  Fast
                </button>
                <div className="relative flex items-center overflow-hidden">
                  <div
                    className={`transition-[max-width,opacity,transform] duration-200 ease-out ${
                      isSmartMode ?
                        'pointer-events-none max-w-0 scale-95 opacity-0'
                      : 'max-w-[96px] scale-100 opacity-100'
                    }`}
                    aria-hidden={isSmartMode}
                  >
                    <button
                      type="button"
                      aria-pressed={isSmartMode}
                      onClick={() => handlePrimaryModelToggle('smart')}
                      disabled={isModelPreferenceUpdating}
                      className={modelPillClass(isSmartMode)}
                    >
                      Smart
                    </button>
                  </div>
                  <div
                    className={`flex items-center gap-1.5 transition-[max-width,opacity,transform] duration-200 ease-out ${
                      isSmartMode ?
                        'max-w-[210px] scale-100 opacity-100'
                      : 'pointer-events-none max-w-0 scale-95 opacity-0'
                    }`}
                    aria-hidden={!isSmartMode}
                  >
                    <button
                      type="button"
                      aria-pressed={smartVariant === 'sonnet'}
                      onClick={() => handleSmartModelToggle('sonnet')}
                      disabled={!isSmartMode || isModelPreferenceUpdating}
                      className={modelPillClass(smartVariant === 'sonnet', 'compact')}
                      title="claude-sonnet-4-5-20250929"
                    >
                      Sonnet
                    </button>
                    <button
                      type="button"
                      aria-pressed={smartVariant === 'opus'}
                      onClick={() => handleSmartModelToggle('opus')}
                      disabled={!isSmartMode || isModelPreferenceUpdating}
                      className={modelPillClass(smartVariant === 'opus', 'compact')}
                      title="claude-opus-4-5-20251101"
                    >
                      Opus
                    </button>
                  </div>
                </div>
              </div>
              {isModelPreferenceUpdating && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400 dark:text-neutral-300" />
              )}
            </div>
            <button
              onClick={isLoading && onStopStreaming ? onStopStreaming : onSend}
              disabled={isLoading && onStopStreaming ? false : !computedCanSend || isLoading}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                isLoading && onStopStreaming ?
                  'bg-neutral-200 text-neutral-900 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-600'
                : 'bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200'
              }`}
            >
              {isLoading ?
                onStopStreaming ?
                  <Square className="h-5 w-5" />
                : <Loader2 className="h-5 w-5 animate-spin" />
              : <ArrowUp className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
