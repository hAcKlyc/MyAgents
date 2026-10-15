import { AGENT_MENTIONS_TAG } from "../../shared/agentMentions";
import AsyncQuestionCard from '@/components/AsyncQuestionCard';
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDownIcon,
  CopyIcon,
  CheckIcon,
  UndoIcon,
  GitBranchIcon,
  DownloadIcon,
} from '@/components/icons';
import { useTranslation } from 'react-i18next';

import { track } from '@/analytics';
import AttachmentPreviewList from '@/components/AttachmentPreviewList';
import BlockGroup from '@/components/BlockGroup';
import { projectCitationMarkdown, type CitationSources } from '@/utils/runtimeCitations';
import Markdown from '@/components/Markdown';
import { useToastOptional } from '@/components/Toast';
import WidgetRenderer from '@/components/tools/WidgetRenderer';
import { parseWidgetTags, hasWidgetTags } from '@/components/tools/widgetTagParser';
import Tip from '@/components/Tip';
import ToolAttachmentGallery from '@/components/tools/ToolAttachmentGallery';
import { TurnFileEditSummary } from '@/components/TurnFileEditSummary';
import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import { buildReplyMarkdown, downloadMarkdown, localDateStr } from '@/utils/markdownExport';
import { formatDuration, formatTokens } from '@/utils/formatTokens';
import { groupContentBlocksForDisplay } from '@/utils/contentBlockDisplay';
import { parseBackgroundTaskNotificationContent } from '@/utils/backgroundTaskStatus';
import { copyPlainText } from '@/utils/clipboard';
import { useImagePreview } from '@/context/ImagePreviewContext';
import type { ContentBlock, Message as MessageType } from '@/types/chat';
import { SOURCE_LABELS, type MessageSource } from '../../shared/types/im';
import {
  FLOATING_BALL_CONTEXT_TAG,
  GOAL_CONTEXT_TAG,
  GOAL_CONTINUATION_TAG,
  SESSION_EVENT_TAG,
  SPACE_ISSUE_CONTEXT_TAG,
  TASK_COMMENT_TAG,
  parseLeadingSystemReminder,
  parseSessionSendRequestDisplay,
} from '../../shared/systemReminder';

interface MessageProps {
  message: MessageType;
  citationSources?: CitationSources;
  isLoading?: boolean;
  onRewind?: (messageId: string) => void;
  onRetry?: (assistantMessageId: string) => void;
  onFork?: (assistantMessageId: string) => void;
  /** Slot rendered after the BlockGroup containing ExitPlanMode tool */
  exitPlanModeSlot?: ReactNode;
  initialUserCollapsed?: boolean;
}

/**
 * Format timestamp to "YYYY-MM-DD HH:mm:ss"
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getTurnMetaLabel(message: MessageType, t: (key: string, options?: Record<string, unknown>) => string): string | null {
  const parts: string[] = [];
  if (typeof message.durationMs === 'number' && Number.isFinite(message.durationMs) && message.durationMs > 0) {
    parts.push(t('message.turnDuration', { duration: formatDuration(message.durationMs) }));
  }

  const usage = message.usage;
  if (usage) {
    const totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (totalTokens > 0) {
      parts.push(`${formatTokens(totalTokens)} tokens`);
    }
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Compare immutable row identity and the optional render slots/actions.
 */
function areMessagesEqual(prev: MessageProps, next: MessageProps): boolean {
  // Different loading state -> must re-render
  if (prev.isLoading !== next.isLoading || prev.citationSources !== next.citationSources) return false;
  // NOTE: isStreaming was removed from props — rewind button visibility is now
  // controlled via CSS ([data-streaming] selector on the scroll container).
  // This eliminates mass re-renders of ALL N history messages when streaming
  // state changes (~30px × N ≈ 1500+px layout-recalc in long sessions).
  // exitPlanModeSlot — useMemo in MessageList keeps reference stable during streaming
  if (prev.exitPlanModeSlot !== next.exitPlanModeSlot) return false;
  // initialUserCollapsed is consumed only by the initial state of a user row.
  // Once mounted, DOM measurement and explicit user expansion own the state.
  // Callback identities are stable, but optional action presence is row data:
  // Codex rewind/fork availability changes after terminal anchor persistence and
  // across the shared busy/idle operation gate.
  if (Boolean(prev.onRewind) !== Boolean(next.onRewind)) return false;
  if (Boolean(prev.onFork) !== Boolean(next.onFork)) return false;
  // onRetry is always present and stable, so its identity remains intentionally ignored.

  // Message updates are immutable. Comparing the complete row identity covers
  // attachments and other visible metadata while unchanged history stays cheap.
  return prev.message === next.message;
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
 * Extract plain text from assistant message content for clipboard copy.
 * Only includes text blocks (excludes thinking/tool content).
 */
function extractAssistantText(content: MessageType['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map(b => b.text || '')
    .join('\n\n');
}

/**
 * Action bar for assistant messages: copy + retry.
 * Always visible (not hover), left-aligned icon buttons.
 */
function AssistantActions({ message, onRetry, onFork, citationSources, className = '' }: {
  message: MessageType;
  citationSources?: CitationSources;
  onRetry?: (id: string) => void;
  onFork?: (id: string) => void;
  className?: string;
}) {
  const { t } = useTranslation('app');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const exportingRef = useRef(false);
  const toast = useToastOptional();

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const text = extractAssistantText(message.content);
  const presentedText = () => projectCitationMarkdown(text, { sources: citationSources, unavailableLabel: t('markdown.citationUnavailable') });
  const turnMetaLabel = getTurnMetaLabel(message, t);

  const handleExport = async () => {
    // In-flight guard against double-click → duplicate download + toast.
    if (!text.trim() || exportingRef.current) return;
    exportingRef.current = true;
    try {
      track('message_export', {});
      const fileName = t('message.replyFileName', { date: localDateStr() });
      toast?.success(await downloadMarkdown(fileName, buildReplyMarkdown(presentedText())));
    } finally {
      exportingRef.current = false;
    }
  };

  return (
    <div className={`group/actions flex min-h-8 w-full items-center gap-1 -ml-2 pt-1 ${className}`}>
      <Tip label={copied ? t('message.actions.copied') : t('message.actions.copy')}>
        <button type="button"
          aria-label={t('message.actions.copy')}
          onClick={async () => {
            try {
              await copyPlainText(presentedText());
              track('message_copy', {});
              setCopied(true);
              if (timerRef.current) clearTimeout(timerRef.current);
              timerRef.current = setTimeout(() => setCopied(false), 1500);
            } catch (error) {
              console.warn('[Message] Failed to copy assistant message:', error);
              toast?.error(t('fileActions.copyFailed'));
            }
          }}
          className="compact-action text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </button>
      </Tip>
      <Tip label={t('message.actions.exportMarkdown')}>
        <button type="button"
          aria-label={t('message.actions.exportMarkdown')}
          onClick={handleExport}
          className="compact-action text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
          <DownloadIcon className="size-3.5" />
        </button>
      </Tip>
      {onRetry && (
        <Tip label={t('message.actions.retry')}>
          <button type="button"
            aria-label={t('message.actions.retry')}
            onClick={() => onRetry(message.id)}
            className="compact-action text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <UndoIcon className="size-3.5" />
          </button>
        </Tip>
      )}
      {onFork && (message.sdkUuid || message.runtimeTurnAnchor) && (
        <Tip label={t('message.actions.fork')}>
          <button type="button"
            aria-label={t('message.actions.fork')}
            onClick={() => onFork(message.id)}
            className="compact-action text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <GitBranchIcon className="size-3.5" />
          </button>
        </Tip>
      )}
      <TurnFileEditSummary content={message.content} />
      {turnMetaLabel && (
        <span
          className="ml-2 min-w-0 flex-1 truncate text-xs text-[var(--ink-muted)]/60 opacity-0 transition-opacity duration-150 group-hover/actions:opacity-100 group-focus-within/actions:opacity-100"
          title={turnMetaLabel}
        >
          {turnMetaLabel}
        </span>
      )}
    </div>
  );
}

function systemTagLabel(kind: string, t: (key: string) => string): string | null {
  if (kind === 'HEARTBEAT') return t('message.systemTags.heartbeat');
  if (kind === AGENT_MENTIONS_TAG) return t('message.systemTags.agentMentions');
  if (kind === 'CRON_TASK') return t('message.systemTags.cronTask');
  if (kind === FLOATING_BALL_CONTEXT_TAG) return t('message.systemTags.floatingContext');
  if (kind === SPACE_ISSUE_CONTEXT_TAG) return t('message.systemTags.spaceIssue');
  if (kind === TASK_COMMENT_TAG) return t('message.systemTags.taskComment');
  if (kind === GOAL_CONTINUATION_TAG || kind === GOAL_CONTEXT_TAG) return t('message.systemTags.goalMode');
  return null;
}

function renderWidgetSegments(text: string, isLoading: boolean, unclosedNotice: string, citationSources?: CitationSources): ReactNode {
  const segments = parseWidgetTags(text);
  return segments.map((seg, si) => {
    if (seg.type === 'text') {
      return (
        <div key={`t-${si}`} className="flex justify-start w-full px-1 py-1 select-none">
          <div className="ai-message-content w-full max-w-none text-[var(--ink)] select-text">
            <Markdown citationSources={citationSources}>{seg.content}</Markdown>
          </div>
        </div>
      );
    }

    if (!seg.isComplete && !isLoading) {
      return (
        <div key={`w-${si}`} className="w-full px-1" data-testid="unclosed-widget-source">
          <p className="text-sm text-[var(--ink-muted)]">{unclosedNotice}</p>
          <pre className="whitespace-pre-wrap break-words select-text"><code>{seg.raw}</code></pre>
        </div>
      );
    }

    return (
      <div key={`w-${si}`} className="w-full px-1">
        <WidgetRenderer
          widgetCode={seg.code}
          // Parser incompleteness means "more bytes may arrive" only while the turn is live.
          isStreaming={isLoading && !seg.isComplete}
          title={seg.title || 'widget'}
        />
      </div>
    );
  });
}

/**
 * Message component with memo optimization.
 * History messages won't re-render when streaming message updates.
 */
const Message = memo(function Message({ message, citationSources, isLoading = false, onRewind, onRetry, onFork, exitPlanModeSlot, initialUserCollapsed = false }: MessageProps) {
  const { t } = useTranslation('app');
  const { openPreview } = useImagePreview();
  const toast = useToastOptional();
  const notifyRowLayoutChanged = useNotifyRowLayoutChanged();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // User message collapse: default collapsed, expand on click (no re-collapse)
  const [userExpanded, setUserExpanded] = useState(false);
  const userContentRef = useRef<HTMLDivElement>(null);
  const [userOverflows, setUserOverflows] = useState(() => initialUserCollapsed);

  // Actions join the terminal commit. Delaying their mount introduces a second
  // height change after the loading footer has already disappeared.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Collapse threshold: 50vh at mount time (no resize reactivity needed — memo prevents re-render)
  const USER_COLLAPSE_HEIGHT = useMemo(() => typeof window !== 'undefined' ? window.innerHeight * 0.5 : 400, []);
  // Measure content height after DOM commit to determine if collapse is needed.
  // Uses rAF to avoid synchronous setState in effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (message.role !== 'user' || userExpanded || userOverflows) return;
    const rafId = requestAnimationFrame(() => {
      const el = userContentRef.current;
      if (el && el.scrollHeight > USER_COLLAPSE_HEIGHT) {
        notifyRowLayoutChanged('user-message-collapse-measured');
        setUserOverflows(true);
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [message.role, userExpanded, userOverflows, USER_COLLAPSE_HEIGHT, notifyRowLayoutChanged]);

  if (message.role === 'user') {
    const rawUserContent = typeof message.content === 'string' ? message.content : '';

    const reminder = parseLeadingSystemReminder(rawUserContent);
    const sessionSendRequest = parseSessionSendRequestDisplay(reminder);

    // Detect system injection type from <system-reminder><TAG> wrapper (whitelist)
    let systemTag: string | null = null;
    if (reminder.kind) systemTag = systemTagLabel(reminder.kind, t);
    if (reminder.kind === SESSION_EVENT_TAG && sessionSendRequest) {
      const sourceSuffix = sessionSendRequest.sourceLabel ? ` · ${sessionSendRequest.sourceLabel}` : '';
      systemTag = `${t('message.systemTags.sessionRequest')}${sourceSuffix}`;
    }

    const hasAttachments = Boolean(message.attachments?.length);

    // Pure hidden reminders are transport/control messages, not user chat.
    // If a visible tail exists, render only that tail plus a small badge.
    if (reminder.hasReminder && !reminder.visibleText.trim() && !sessionSendRequest && !hasAttachments) {
      return null;
    }

    // Strip system injection tags that wrap delivered content. These HTML-like tags trigger
    // Markdown's HTML block mode, breaking \n rendering and Markdown syntax.
    const displaySource = reminder.hasReminder
      ? (reminder.visibleText || sessionSendRequest?.payload || '')
      : rawUserContent;
    const userContent = displaySource
      .replace(/<\/?system-reminder>/g, '')
      .replace(/<\/?HEARTBEAT>/g, '')
      .replace(/<\/?MEMORY_UPDATE>/g, '')
      .replace(/<\/?CRON_TASK>/g, '')
      .replace(/<\/?TASK_COMMENT>/g, '')
      .replace(/<\/?FLOATING_BALL_CONTEXT>/g, '')
      .replace(/<\/?GOAL_CONTINUATION>/g, '')
      .replace(/<\/?GOAL_CONTEXT>/g, '')
      .replace(/<\/?myagents-space-issue>/g, '')
      .trim();
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

    // Check if this is a background task notification
    const taskNotif = parseBackgroundTaskNotificationContent(userContent);
    if (taskNotif) {
      return null;
    }

    // Check if this is a local command output (like /cost, /context)
    const parsed = parseLocalCommandOutput(userContent);

    // Local command output - render as system info block (left-aligned)
    if (parsed.isLocalCommand) {
      const formattedContent = formatLocalCommandOutput(parsed.content);
      return (
        <div className="flex justify-start w-full px-4 py-2 select-none">
          <div className="w-full max-w-none rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]/50 p-4">
            <div className="text-xs font-medium text-[var(--ink-muted)] mb-2">{t('message.systemInfo')}</div>
            <div className="text-sm text-[var(--ink)] select-text">
              <Markdown>{formattedContent}</Markdown>
            </div>
          </div>
        </div>
      );
    }

    const hasText = userContent.trim().length > 0;
    const imSource = message.metadata?.source;
    const isImMessage = imSource && imSource !== 'desktop';

    return (
      <div className="flex justify-end px-1 select-none"
           data-role="user" data-message-id={message.id}>
        <div className="flex w-full flex-col items-end">
          {/* IM source indicator */}
          {isImMessage && (
            <div className="mr-2 mb-1 flex items-center gap-1 text-xs text-[var(--ink-muted)]">
              {imSource?.includes('group') && <span>👥</span>}
              <span>via {SOURCE_LABELS[imSource as MessageSource] ?? imSource}</span>
            </div>
          )}
          {/* 用户与 AI 正文都由 Markdown 默认变体承载 16px/1.7；article 的
              text-base 只负责气泡内非 Markdown prose fallback。 */}
          <div className="group/user-actions flex w-fit max-w-[85%] flex-col items-end">
            <article className="relative w-fit max-w-full rounded-2xl bg-[var(--message-user-bg)] p-4 text-base text-[var(--ink)] select-text">
              {/* System injection tag badge */}
              {systemTag && (
                <div className="mb-2 -mt-0.5">
                  <span className="inline-block rounded-md bg-[var(--accent-warm-subtle)] px-1.5 py-0.5 text-xs font-medium text-[var(--accent-warm)]">
                    {systemTag}
                  </span>
                </div>
              )}
              {/* Collapsible content wrapper: max 50vh when collapsed */}
              <div
                ref={userContentRef}
                className={!userExpanded && userOverflows ? 'overflow-hidden' : ''}
                style={!userExpanded && userOverflows ? { maxHeight: `${USER_COLLAPSE_HEIGHT}px` } : undefined}
              >
                {hasAttachments && (
                  <div className={hasText ? 'mb-2' : ''}>
                    <AttachmentPreviewList
                      attachments={attachmentItems}
                      compact
                      onPreview={openPreview}
                    />
                  </div>
                )}
                {hasText && (
                  <div className="user-message-content text-[var(--ink)]">
                    <Markdown preserveNewlines allowSetextHeadings={false}>{userContent}</Markdown>
                  </div>
                )}
              </div>
              {/* Expand button with gradient fade — gradient overlaps bottom of content */}
              {!userExpanded && userOverflows && (
                <div className="relative z-10 -mx-4 -mb-4 -mt-14">
                  <div className="pointer-events-none h-14 bg-gradient-to-t from-[var(--message-user-bg)] to-[var(--message-user-bg-a0)]" />
                  <button
                    type="button"
                    onClick={() => {
                      notifyRowLayoutChanged('user-message-expand');
                      setUserExpanded(true);
                    }}
                    className="flex w-full items-center justify-center gap-1 rounded-b-2xl bg-[var(--message-user-bg)] py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    {t('message.expand')}
                  </button>
                </div>
              )}
            </article>
            {message.deliveryStatus === 'failed' && (
              <p className="mr-2 mt-1 text-xs text-[var(--error)]">{t('app:tabProvider.sendFailed')}</p>
            )}
            {/* 操作栏：时间 + 图标按钮，随气泡/操作栏局部 hover 或键盘 focus 淡入 */}
            <div className="mr-2 mt-1 flex items-center gap-2 opacity-0 transition-opacity duration-150 group-hover/user-actions:opacity-100 group-focus-within/user-actions:opacity-100">
              <span className="mr-1 text-xs text-[var(--ink-muted)]">{formatTimestamp(message.timestamp)}</span>
              {onRewind && !message.deliveryStatus && (
                <span data-rewind-btn>
                  <Tip label={t('message.actions.rewind')}>
                    <button type="button"
                      aria-label={t('message.actions.rewind')}
                      onClick={() => onRewind(message.id)}
                      className="compact-action text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                      <UndoIcon className="size-3.5" />
                    </button>
                  </Tip>
                </span>
              )}
              <Tip label={copied ? t('message.actions.copied') : t('message.actions.copy')}>
                <button type="button"
                  aria-label={t('message.actions.copy')}
                  onClick={async () => {
                    try {
                      await copyPlainText(userContent);
                      setCopied(true);
                      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
                      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
                    } catch (error) {
                      console.warn('[Message] Failed to copy user message:', error);
                      toast?.error(t('fileActions.copyFailed'));
                    }
                  }}
                  className="compact-action text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                  {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                </button>
              </Tip>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  if (typeof message.content === 'string') {
    const hasWidgets = hasWidgetTags(message.content);
    return (
      <div className="flex justify-start w-full px-4 py-2 select-none" data-role="assistant">
        <div className="w-full max-w-none">
          {hasWidgets ? (
            <div className="w-full space-y-3">
              {renderWidgetSegments(message.content, isLoading, t('message.widgetUnclosed'), citationSources)}
            </div>
          ) : (
            /* ai-message-content 标记 host prose 上下文；具体 16px/1.7、零字距和
               各语义块节奏由 Markdown 默认变体统一拥有。三个 assistant 分支
               （string/blocks/widget-segment）与文档预览共用这一条路径。 */
            <div className="ai-message-content text-[var(--ink)] select-text">
              {/* Tail-fade only while text is the actively-streaming edge — `streamingTextActive`
                  clears on the text block's content-block-stop, so it doesn't linger during a
                  slow gap before the next block (string-content path). */}
              <Markdown citationSources={citationSources} streaming={isLoading && !!message.streamingTextActive}>{message.content}</Markdown>
            </div>
          )}
          {!isLoading && <AssistantActions citationSources={citationSources} message={message} onRetry={onRetry} onFork={onFork} />}
        </div>
      </div>
    );
  }

  const groupedBlocks = groupContentBlocksForDisplay(message.content);

  // Determine which BlockGroup is the latest active section
  // Find the last BlockGroup index
  const lastBlockGroupIndex = groupedBlocks.findLastIndex((item) => Array.isArray(item));

  // Check if there are any incomplete blocks (still streaming)
  const hasIncompleteBlocks = message.content.some((block) => {
    if (block.type === 'thinking') {
      return !block.isComplete;
    }
    if (block.type === 'server_tool_use') {
      // Provider tools own their own completion bit. An empty Provider result is
      // still a valid terminal result and must not keep the message streaming.
      return Boolean(block.tool?.isLoading);
    }
    if (block.type === 'tool_use') {
      // Local tools can predate the explicit loading bit, so retain the legacy
      // result fallback for history compatibility.
      const subagentRunning = block.tool?.subagentCalls?.some((call) => call.isLoading);
      return Boolean(block.tool?.isLoading) || Boolean(subagentRunning) || block.tool?.result === undefined;
    }
    return false;
  });

  const isAssistantStreaming = isLoading && hasIncompleteBlocks;

  // Find the LAST BlockGroup containing ExitPlanMode for slot placement.
  // Only the last one gets the slot — avoids duplicates when reject → re-plan
  // produces multiple ExitPlanMode tool calls in the same message.
  const exitPlanModeGroupIndex = exitPlanModeSlot
    ? groupedBlocks.findLastIndex(item =>
        Array.isArray(item) && item.some(
          block => (block.type === 'tool_use' || block.type === 'server_tool_use')
            && block.tool?.name === 'ExitPlanMode'
        )
      )
    : -1;

  return (
    <div className="flex justify-start select-none" data-role="assistant">
      <div className="w-full">
        <article className="w-full px-3 py-2">
          <div className="space-y-3">
            {groupedBlocks.map((item, index) => {
              // Single text block — may contain <widget> tags for inline rendering
              if (!Array.isArray(item)) {
                if (item.type === 'text' && item.asyncQuestions) {
                  return <div key={index} className="w-full px-1">
                    {item.text && <Markdown citationSources={citationSources}>{item.text}</Markdown>}
                    <AsyncQuestionCard questions={item.asyncQuestions} />
                  </div>;
                }
                if (item.type === 'text' && item.text) {
                  // Check for <widget> tags in the text
                  if (hasWidgetTags(item.text)) {
                    return (
                      <div key={index} className="w-full space-y-3">
                        {renderWidgetSegments(item.text, isLoading, t('message.widgetUnclosed'), citationSources)}
                      </div>
                    );
                  }
                  // Plain text — no widget tags. The tail-fade applies only to the
                  // actively-streaming edge: last block of a still-loading message AND
                  // `streamingTextActive` (set on text deltas, cleared on the text block's
                  // content-block-stop). The flag is the key guard — once the model finishes
                  // this text (moved to next tool/thinking, or a slow gap), the fade clears
                  // even though the turn is still loading. Without it the last chars linger faded.
                  return (
                    <div
                      key={index}
                      className="flex justify-start w-full px-1 py-1 select-none"
                    >
                      <div className="ai-message-content w-full max-w-none text-[var(--ink)] select-text">
                        <Markdown citationSources={citationSources} streaming={isLoading && index === groupedBlocks.length - 1 && !!message.streamingTextActive}>{item.text}</Markdown>
                      </div>
                    </div>
                  );
                }
                return null;
              }

              // Group of thinking/tool blocks
              const isLatestActiveSection = index === lastBlockGroupIndex;
              // Hoist rich-media attachments OUT of the collapsible tool window
              // (BlockGroup → ProcessRow) into the message flow, so generated
              // audio / image render as standalone, always-visible cards in the
              // conversation rather than buried inside the folded tool body
              // (PRD 0.2.30 bug). Sub-agent (Task) attachments live on
              // subagentCalls and are rendered inside TaskTool — not here — so
              // pulling top-level `tool.attachments` never double-renders them.
              //
              // #293 — only ARTIFACT media (deliverables: generated images/audio)
              // is hoisted into the flow. PROCESS media (Playwright / computer-use
              // screenshots — the AI's "eyes") stays inside the folded tool row
              // (rendered by ProcessRow), so a 30-screenshot browse run doesn't
              // flood the conversation. Missing field = artifact (old data).
              const groupAttachments = item.flatMap((b) =>
                (b.type === 'tool_use' || b.type === 'server_tool_use')
                  ? (b.tool?.attachments ?? []).filter((a) => a.presentation !== 'process')
                  : []
              );
              return (
                <Fragment key={`group-${index}`}>
                  <BlockGroup
                    blocks={item}
                    isLatestActiveSection={isLatestActiveSection}
                    isStreaming={isAssistantStreaming}
                  />
                  {groupAttachments.length > 0 && (
                    <div className="px-1">
                      <ToolAttachmentGallery attachments={groupAttachments} />
                    </div>
                  )}
                  {index === exitPlanModeGroupIndex && exitPlanModeSlot}
                </Fragment>
              );
            })}
          </div>
        </article>
        {!isLoading && <AssistantActions citationSources={citationSources} className="px-4" message={message} onRetry={onRetry} onFork={onFork} />}
      </div>
    </div>
  );
}, areMessagesEqual);

export default Message;
