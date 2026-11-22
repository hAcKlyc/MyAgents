import type { AskUserQuestionAnswers } from '../../shared/types/askUserQuestion';
import {
  AlertIcon,
  SuccessIcon,
  LoaderIcon,
  CloseIcon,
} from '@/components/icons';
import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useLayoutEffect,
  useRef,
} from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { ListItem, SizeFunction, VirtuosoHandle } from 'react-virtuoso';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { citationScope, createWebSearchCitationIndex } from '@/utils/webSearchCitations';
import type { CitationSources } from '@/utils/runtimeCitations';
import Message from '@/components/Message';
import {
  PermissionPrompt,
  type PermissionRequest,
} from '@/components/PermissionPrompt';
import {
  AskUserQuestionPrompt,
  type AskUserQuestionRequest,
} from '@/components/AskUserQuestionPrompt';
import { ExitPlanModePrompt } from '@/components/ExitPlanModePrompt';
import type { ExitPlanModeRequest } from '../../shared/types/planMode';
import type { Message as MessageType } from '@/types/chat';
import type { SessionState, SystemNotice } from '@/context/TabContext';
import {
  ChatRowLayoutProvider,
  type RowLayoutChangeReason,
} from '@/context/ChatRowLayoutContext';
import type { RowLayoutContract } from '@/utils/chatRowLayout';
import { useChatScrollDebugProbe } from '@/hooks/useChatScrollDebugProbe';
import { useChatFollowMotion } from '@/hooks/useChatFollowMotion';
import { resolveChatBottomSpacerPx } from '@/utils/chatBottomSpacer';
import type { MainWindowPresentation } from '@/utils/mainWindowPresentation';

function formatElapsedTime(totalSeconds: number, t: TFunction<'chat'>): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0)
    return t('shell.messageList.elapsed.hms', { hours, minutes, seconds });
  if (minutes > 0)
    return t('shell.messageList.elapsed.ms', { minutes, seconds });
  return t('shell.messageList.elapsed.seconds', { seconds });
}

interface MessageListProps {
  messages: readonly MessageType[];
  streamingMessage: MessageType | null;
  isLoading: boolean;
  getQueryElapsedSeconds?: () => number;
  sessionId?: string | null;
  /**
   * Whether this Tab is currently visible. When `false`, the host wraps this
   * subtree in `content-visibility: hidden`, which lets WebKit defer/skip
   * descendant layout. Virtuoso's ResizeObserver can then fire with zero or
   * stale geometry and erroneously emit `atBottomStateChange(false)` —
   * corrupting the follow-state machine. We use this flag to (a) ignore
   * those bogus measurements and (b) re-pin scroll to bottom on re-activation
   * if we were following before the tab went hidden.
   */
  isActive?: boolean;
  /** Native shown/not-minimized generation; focus is intentionally excluded. */
  windowPresentation?: MainWindowPresentation;
  /** Commits the single list-admission edge to the Chat scroll owner. */
  onViewportAdmissionChanged?: (
    admitted: boolean,
    presentationGeneration: number,
  ) => void;
  /** Publishes committed rows for startup handoff and pending scroll anchors. */
  onItemsRendered?: (messages: readonly MessageType[]) => void;
  /** Hides only a known-wrong intermediate recovery position. */
  isViewportRecoveryFenced?: boolean;
  // Pagination: Virtuoso maintains the visible scroll position across
  // prepended items by the absolute index of data[0]. Default 0 = no pagination.
  firstItemIndex?: number;
  heightEstimateSeed?: number[];
  visibleHistory?: readonly MessageType[];
  layoutByMessageId?: ReadonlyMap<string, RowLayoutContract>;
  /** Fires when Virtuoso reaches the top — time to load an older page. */
  onLoadOlder?: () => void;
  olderPageFailed?: boolean;
  onPrefetchOlder?: () => void;
  onCancelOlder?: () => void;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  onScrollerRef?: (el: HTMLElement | Window | null) => void;
  followEnabledRef: React.MutableRefObject<boolean | 'force'>;
  /** Drives the session-switch scroll pin — goes through the hook so grace/degrade state stays consistent. */
  scrollToBottom: (behavior?: 'smooth' | 'auto') => void;
  handleAtBottomChange: (atBottom: boolean) => void;
  onRowLayoutChanged?: (
    messageId: string,
    reason: RowLayoutChangeReason,
  ) => void;
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    optionId?: string,
  ) => void | Promise<void>;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (
    requestId: string,
    answers: AskUserQuestionAnswers,
  ) => void | Promise<void>;
  onAskUserQuestionCancel?: (requestId: string) => void | Promise<void>;
  pendingExitPlanMode?: ExitPlanModeRequest | null;
  onExitPlanModeApprove?: () => void;
  onExitPlanModeReject?: (feedback?: string) => void;
  systemStatus?: string | null;
  systemNotice?: SystemNotice | null;
  onDismissSystemNotice?: () => void;
  isStreaming?: boolean;
  /**
   * (issue #174) Pulled in so the loading footer can swap the random
   * "苦思冥想中…" thinking line for an explicit "AI 启动中…" hint while the
   * SDK subprocess is alive but system_init hasn't arrived. Without this
   * the user can't tell whether the long wait is startup or actual work.
   */
  sessionState?: SessionState;
  onRewind?: (messageId: string) => void;
  onRetry?: (assistantMessageId: string) => void;
  onFork?: (assistantMessageId: string) => void;
  conversationOperations?: 'builtin' | 'codex' | 'dsh';
  /** Stable projection of persisted native root-turn anchors for user-row eligibility. */
  rewindableUserMessageIds?: ReadonlySet<string>;
  bottomSpacerPx?: number;
}

interface MessageActionContext {
  citationSources: ReadonlyMap<string, CitationSources>;
  conversationOperations: 'builtin' | 'codex' | 'dsh';
  rewindableUserMessageIds: ReadonlySet<string>;
  onRewind?: (messageId: string) => void;
  onFork?: (assistantMessageId: string) => void;
}

const STREAMING_MESSAGE_COUNT = 20;
const noopRowLayoutChanged = (
  _messageId: string,
  _reason: RowLayoutChangeReason,
) => {};
const STATUS_ROW_HEIGHT_PX = 30;
const EMPTY_MESSAGE_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_MESSAGES: readonly MessageType[] = [];
const noQueryElapsedSeconds = () => 0;
const DEFAULT_WINDOW_PRESENTATION: MainWindowPresentation = {
  surfaceAvailable: true,
  generation: 0,
};
const noopViewportAdmissionChanged = (
  _admitted: boolean,
  _presentationGeneration: number,
) => {};
const noopItemsRendered = () => {};

// Presentation admission remains owned by MessageList. Its projection must
// reach the sampler even while Virtuoso's data/context are deliberately frozen.
const MessageListPresentationContext = createContext(true);

function isLargeRowShrink(reason: RowLayoutChangeReason): boolean {
  return (
    reason === 'process-row-collapse' ||
    reason === 'user-message-collapse-measured'
  );
}

function isRowExpansion(reason: RowLayoutChangeReason): boolean {
  return (
    reason === 'process-row-expand' ||
    reason === 'user-message-expand' ||
    reason === 'block-group-expand' ||
    reason === 'expandable-container-expand'
  );
}

/** Resolve dynamic system status keys (e.g., api_retry:2:5 → human-readable) */
function resolveSystemStatus(status: string, t: TFunction<'chat'>): string {
  if (status === 'compacting' || status === 'rewinding') {
    return t(`shell.messageList.systemStatus.${status}`);
  }
  // API retry: "api_retry:{attempt}:{maxAttempts}"
  if (status.startsWith('api_retry:')) {
    const parts = status.split(':');
    const attempt = parts[1] || '1';
    const max = parts[2] || '?';
    return t('shell.messageList.systemStatus.apiRetry', { attempt, max });
  }
  return status;
}
function getRandomStreamingMessage(t: TFunction<'chat'>): string {
  const index = Math.floor(Math.random() * STREAMING_MESSAGE_COUNT);
  return t(`shell.messageList.streaming.${index}`);
}

const StatusTimer = memo(function StatusTimer({
  message,
  getElapsedSeconds,
}: {
  message: string;
  getElapsedSeconds: () => number;
}) {
  const { t } = useTranslation('chat');
  const canPresent = useContext(MessageListPresentationContext);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!canPresent) return () => {};
      const id = setInterval(onStoreChange, 1000);
    return () => clearInterval(id);
    },
    [canPresent],
  );
  // The Tab clock keeps advancing without a timer. Re-subscription samples its
  // current value on restore; hidden snapshots never keep a polling loop alive.
  const elapsedSeconds = useSyncExternalStore(subscribe, getElapsedSeconds);
  const elapsedText =
    elapsedSeconds > 0 ? formatElapsedTime(elapsedSeconds, t) : null;
  const displayText = elapsedText ? `${message} (${elapsedText})` : message;
  return (
    <div
      data-chat-status-row=""
      className="flex items-center gap-2 overflow-hidden px-3 py-1.5 text-xs text-[var(--ink-muted)]"
      style={{ height: STATUS_ROW_HEIGHT_PX }}
      title={displayText}
    >
      {/* Retire the animated node, preserving its slot. Chromium can defer a
          class/style removal inside content-visibility:hidden, retaining the
          old CSS animation until the subtree becomes renderable again. */}
      <span className="h-3 w-3 shrink-0" aria-hidden="true">
        {canPresent && <LoaderIcon className="h-full w-full animate-spin" />}
      </span>
      <span className="min-w-0 truncate">{displayText}</span>
    </div>
  );
});

const InteractionWaitingStatus = memo(function InteractionWaitingStatus({
  message,
}: {
  message: string;
}) {
  return (
    <div
      data-chat-status-row=""
      data-chat-waiting-for-interaction=""
      className="flex items-center gap-2 overflow-hidden px-3 py-1.5 text-xs text-[var(--ink-muted)]"
      style={{ height: STATUS_ROW_HEIGHT_PX }}
      title={message}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{message}</span>
    </div>
  );
});

const SystemNoticeRow = memo(function SystemNoticeRow({
  notice,
  onDismiss,
}: {
  notice: SystemNotice;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation('chat');
  const isError = notice.level === 'error';
  const isWarning = notice.level === 'warning';
  const Icon = isError || isWarning ? AlertIcon : SuccessIcon;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--ink-muted)]">
      <Icon className={`h-3 w-3 flex-shrink-0 ${isError ? 'text-[var(--error)]' : isWarning ? 'text-[var(--ink-muted)]' : 'text-[var(--success)]'}`} />
      <span className="flex-1">{notice.message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-0.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-muted)]"
          title={t('shell.common.close')}
        >
          <CloseIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
});

function hasExitPlanModeTool(message: MessageType): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string')
    return false;
  return message.content.some(
    (block) =>
      (block.type === 'tool_use' || block.type === 'server_tool_use') &&
      block.tool?.name === 'ExitPlanMode',
  );
}

// ── Virtuoso Footer — dynamic values arrive through the existing list context ──
// Must NOT be recreated on every render (inline arrow in `components` causes Virtuoso
// to remount the footer, resetting StatusTimer and forcing extra remeasurement).
type FooterProps = {
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    optionId?: string,
  ) => void | Promise<void>;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (
    requestId: string,
    answers: AskUserQuestionAnswers,
  ) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  showStatus: boolean;
  waitingForInteraction: boolean;
  statusMessage: string;
  getQueryElapsedSeconds: () => number;
  systemNotice?: SystemNotice | null;
  onDismissSystemNotice?: () => void;
  bottomSpacerPx?: number;
};

interface MessageListContext extends MessageActionContext {
  footer: FooterProps;
}

const VirtuosoFooter = memo(function VirtuosoFooter({
  pendingPermission,
  onPermissionDecision,
  pendingAskUserQuestion,
  onAskUserQuestionSubmit,
  onAskUserQuestionCancel,
  showStatus,
  waitingForInteraction,
  statusMessage,
  getQueryElapsedSeconds,
  systemNotice,
  onDismissSystemNotice,
  bottomSpacerPx,
}: FooterProps) {
  const spacerHeight = resolveChatBottomSpacerPx(bottomSpacerPx);
  return (
    <div className="mx-auto max-w-3xl px-3">
      {pendingPermission && onPermissionDecision && (
        <div className="py-2">
          <PermissionPrompt
            key={pendingPermission.requestId}
            request={pendingPermission}
            onDecision={onPermissionDecision}
          />
        </div>
      )}
      {pendingAskUserQuestion &&
        onAskUserQuestionSubmit &&
        onAskUserQuestionCancel && (
          <div className="py-2">
            <AskUserQuestionPrompt
              key={pendingAskUserQuestion.requestId}
              request={pendingAskUserQuestion}
              onSubmit={onAskUserQuestionSubmit}
              onCancel={onAskUserQuestionCancel}
            />
          </div>
        )}
      {showStatus &&
        (waitingForInteraction ? (
          <InteractionWaitingStatus message={statusMessage} />
        ) : (
          <StatusTimer
            message={statusMessage}
            getElapsedSeconds={getQueryElapsedSeconds}
          />
        ))}
      {!showStatus && systemNotice && (
        <SystemNoticeRow
          notice={systemNotice}
          onDismiss={onDismissSystemNotice}
        />
      )}
      {/* Footer spacer follows the measured floating input stack. The extra
          clearance in resolveChatBottomSpacerPx keeps both the status row and
          streaming tail comfortably above the composer without moving either
          out of Virtuoso's scroll geometry. */}
      <div
        data-chat-footer-spacer=""
        style={{ height: spacerHeight }}
        aria-hidden="true"
      />
    </div>
  );
});

// Virtuoso renders this as a component type. Dynamic footer values belong in
// context, not in a function factory that remounts prompts and the status row.
function MessageListFooter({ context }: { context?: MessageListContext }) {
  return context ? <VirtuosoFooter {...context.footer} /> : null;
}
const VIRTUOSO_COMPONENTS = { Footer: MessageListFooter };

// ── No custom Scroller/List components ──
// Tested: custom Scroller (py-3 padding) and List (mx-auto max-w-3xl) break Virtuoso's
// internal height tracking — scrollHeight diverges from totalListHeight by 12,000+ px,
// causing phantom repeated content. Styling is applied inside itemContent instead.

const MessageList = memo(function MessageList({
  messages,
  streamingMessage,
  isLoading,
  getQueryElapsedSeconds = noQueryElapsedSeconds,
  sessionId,
  isActive = true,
  windowPresentation = DEFAULT_WINDOW_PRESENTATION,
  onViewportAdmissionChanged = noopViewportAdmissionChanged,
  onItemsRendered = noopItemsRendered,
  isViewportRecoveryFenced = false,
  firstItemIndex,
  heightEstimateSeed,
  visibleHistory,
  layoutByMessageId,
  onLoadOlder,
  olderPageFailed,
  onPrefetchOlder,
  onCancelOlder,
  virtuosoRef,
  onScrollerRef,
  followEnabledRef,
  scrollToBottom,
  handleAtBottomChange,
  onRowLayoutChanged,
  pendingPermission,
  onPermissionDecision,
  pendingAskUserQuestion,
  onAskUserQuestionSubmit,
  onAskUserQuestionCancel,
  pendingExitPlanMode,
  onExitPlanModeApprove,
  onExitPlanModeReject,
  systemStatus,
  systemNotice,
  onDismissSystemNotice,
  isStreaming,
  sessionState,
  onRewind,
  onRetry,
  onFork,
  conversationOperations = 'builtin',
  rewindableUserMessageIds,
  bottomSpacerPx,
}: MessageListProps) {
  const { t } = useTranslation('chat');
  const viewportRootRef = useRef<HTMLDivElement>(null);
  const [readyPresentationGeneration, setReadyPresentationGeneration] =
    useState<number | null>(
      windowPresentation.surfaceAvailable && windowPresentation.generation === 0
        ? 0
        : null,
    );
  useLayoutEffect(() => {
    if (
      !isActive ||
      !windowPresentation.surfaceAvailable ||
      readyPresentationGeneration === windowPresentation.generation
    )
      return;
    const viewport = viewportRootRef.current;
    if (!viewport) return;
    let disposed = false;
    const commitIfUsable = (width: number, height: number) => {
      if (disposed || width <= 0 || height <= 0) return;
      setReadyPresentationGeneration(windowPresentation.generation);
    };
    if (typeof ResizeObserver === 'undefined') {
      const rect = viewport.getBoundingClientRect();
      commitIfUsable(rect.width, rect.height);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      commitIfUsable(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(viewport);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [isActive, readyPresentationGeneration, windowPresentation]);
  const canLayoutVirtualList =
    isActive &&
    windowPresentation.surfaceAvailable &&
    readyPresentationGeneration === windowPresentation.generation;
  useLayoutEffect(() => {
    onViewportAdmissionChanged(
      canLayoutVirtualList,
      windowPresentation.generation,
    );
  }, [
    canLayoutVirtualList,
    onViewportAdmissionChanged,
    windowPresentation.generation,
  ]);
  const liveHeightEstimateSeed =
    heightEstimateSeed?.length === messages.length
      ? heightEstimateSeed
      : undefined;

  const streamingStatusMessage = useMemo(
    () => getRandomStreamingMessage(t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages.length, t],
  );

  // ExitPlanMode
  const exitPlanModeAnchorId = useMemo(() => {
    if (!pendingExitPlanMode) return null;
    if (streamingMessage && hasExitPlanModeTool(streamingMessage))
      return streamingMessage.id;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (hasExitPlanModeTool(messages[i])) return messages[i].id;
    }
    return null;
  }, [pendingExitPlanMode, streamingMessage, messages]);
  const exitPlanModeSlot = useMemo(() => {
    if (!pendingExitPlanMode || !onExitPlanModeApprove || !onExitPlanModeReject)
      return undefined;
    return (
      <div className="py-2">
        <ExitPlanModePrompt
          key={pendingExitPlanMode.requestId}
          request={pendingExitPlanMode}
          onApprove={onExitPlanModeApprove}
          onReject={onExitPlanModeReject}
        />
      </div>
    );
  }, [pendingExitPlanMode, onExitPlanModeApprove, onExitPlanModeReject]);

  const waitingForInteraction = Boolean(
    pendingPermission ||
      pendingAskUserQuestion ||
      (pendingExitPlanMode && pendingExitPlanMode.resolved === undefined),
  );
  const showStatus = waitingForInteraction || isLoading || !!systemStatus;
  // (issue #174) During 'starting' the SDK subprocess is alive but hasn't
  // sent system_init — the random "苦思冥想中…" line would falsely imply the
  // model is already thinking. Surface a startup-specific hint instead.
  // systemStatus (e.g. compacting / api_retry) still wins because it carries
  // a more specific signal that overrides both starting and the generic
  // thinking line.
  const statusMessage = waitingForInteraction
    ? t('shell.messageList.waitingForInteraction')
    : systemStatus
      ? resolveSystemStatus(systemStatus, t)
      : sessionState === 'starting'
        ? t('shell.messageList.starting')
        : streamingStatusMessage;

  // Scroll to bottom after session load / switch. Runs synchronously before
  // the next paint so there's no visible top→bottom jump when the new session's
  // data prop arrives — critical now that Virtuoso stays mounted across switches
  // (see the note below about removing `key={sessionId}`). Routes through the hook's
  // scrollToBottom('auto') so the force/grace/auto-degrade state machine stays in one
  // place — writing `followEnabledRef.current = 'force'` inline would leak force into
  // subsequent content changes without the safety timer.
  const lastScrolledSessionRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    // Never drive Virtuoso while hidden (content-visibility:hidden → stale geometry,
    // same cache-poisoning class as the data freeze below). If the session changed
    // while inactive, defer the pin: leaving lastScrolledSessionRef unset means this
    // effect re-fires and pins once isActive flips true.
    if (!canLayoutVirtualList) return;
    if (!sessionId || sessionId === lastScrolledSessionRef.current) return;
    if (messages.length === 0) return;
    lastScrolledSessionRef.current = sessionId;
    scrollToBottom('auto');
  }, [canLayoutVirtualList, sessionId, messages.length, scrollToBottom]);

  const guardedAtBottomChange = useCallback(
    (atBottom: boolean) => {
      if (!canLayoutVirtualList) return;
      handleAtBottomChange(atBottom);
    },
    [canLayoutVirtualList, handleAtBottomChange],
  );

  const [debugScroller, setDebugScroller] = useState<HTMLElement | null>(null);
  const alignFollowingViewport = useChatFollowMotion({
    scroller: debugScroller,
    virtuosoRef,
    followEnabledRef,
    admitted: canLayoutVirtualList,
    recoveryFenced: isViewportRecoveryFenced,
    sessionId,
    presentationGeneration: windowPresentation.generation,
  });

  // ── Refs for stable callbacks — avoid recreating itemContent/Footer on every render ──
  const streamingMessageRef = useRef(streamingMessage);
  streamingMessageRef.current = streamingMessage;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const exitPlanModeAnchorIdRef = useRef(exitPlanModeAnchorId);
  exitPlanModeAnchorIdRef.current = exitPlanModeAnchorId;
  const exitPlanModeSlotRef = useRef(exitPlanModeSlot);
  exitPlanModeSlotRef.current = exitPlanModeSlot;
  const retryAvailable = !!onRetry;
  const onRetryRef = useRef(onRetry);
  useLayoutEffect(() => { onRetryRef.current = onRetry; }, [onRetry]);
  // Virtual history rows and Message are memoized. Pass a stable forwarding
  // callback so a later model/effort selection is read at click time.
  const handleRetry = useCallback((messageId: string) => onRetryRef.current?.(messageId), []);
  const layoutByMessageIdRef = useRef(layoutByMessageId);
  layoutByMessageIdRef.current = layoutByMessageId;
  const onRowLayoutChangedRef = useRef(
    onRowLayoutChanged ?? noopRowLayoutChanged,
  );
  onRowLayoutChangedRef.current = onRowLayoutChanged ?? noopRowLayoutChanged;
  const isItemMeasurementActiveRef = useRef(canLayoutVirtualList);
  isItemMeasurementActiveRef.current = canLayoutVirtualList;
  const measureVisibleItemSize = useCallback<SizeFunction>((element, field) => {
    const knownSize = Number(element.dataset.knownSize);
    if (!isItemMeasurementActiveRef.current) {
      if (Number.isFinite(knownSize) && knownSize > 0) return knownSize;
    }
    const rectField = field === 'offsetWidth' ? 'width' : 'height';
    // Preserve layout precision: rounding each row accumulates into a wrong
    // index target. Virtuoso quantizes only the final scroll extent.
    const measuredSize = element.getBoundingClientRect()[rectField];
    // A mounted row always has positive layout size. Some WebViews can briefly report
    // zero while updating a long virtualized list; feeding that transient geometry into
    // Virtuoso corrupts its size model and can move the viewport far from the anchor.
    if (measuredSize <= 0 && Number.isFinite(knownSize) && knownSize > 0)
      return knownSize;
    return measuredSize;
  }, []);
  const [isLargeRowShrinking, setIsLargeRowShrinking] = useState(false);
  const collapseMeasureFrameRef = useRef<number | null>(null);
  const collapseSettleFrameRef = useRef<number | null>(null);
  const cancelPendingLargeRowShrink = useCallback(() => {
    if (collapseMeasureFrameRef.current !== null) {
      cancelAnimationFrame(collapseMeasureFrameRef.current);
      collapseMeasureFrameRef.current = null;
    }
    if (collapseSettleFrameRef.current !== null) {
      cancelAnimationFrame(collapseSettleFrameRef.current);
      collapseSettleFrameRef.current = null;
    }
  }, []);
  const handleRowLayoutChanged = useCallback(
    (messageId: string, reason: RowLayoutChangeReason) => {
      if (isLargeRowShrink(reason)) {
        cancelPendingLargeRowShrink();
        // Keep the normal synchronous measurement path for expansion: it prevents
        // Virtuoso from correcting the viewport one frame after the user clicks.
        // A large shrink is the inverse WebKit hazard, so hold the rAF-delayed path
        // through React's commit and Virtuoso's following measurement commit, then
        // restore the fast path. This is a bounded geometry transaction, not a retry.
        setIsLargeRowShrinking(true);
        collapseMeasureFrameRef.current = requestAnimationFrame(() => {
          collapseMeasureFrameRef.current = null;
          collapseSettleFrameRef.current = requestAnimationFrame(() => {
            collapseSettleFrameRef.current = null;
            setIsLargeRowShrinking(false);
          });
        });
      } else if (isRowExpansion(reason)) {
        // A rapid re-open (or another row's expand) takes precedence over a pending
        // shrink settlement. Restore synchronous measurement in the same React
        // batch as the expansion so the clicked content never jumps out of view.
        cancelPendingLargeRowShrink();
        setIsLargeRowShrinking(false);
      }
      onRowLayoutChangedRef.current(messageId, reason);
    },
    [cancelPendingLargeRowShrink],
  );
  useLayoutEffect(() => {
    if (canLayoutVirtualList) return;
    // A delayed ResizeObserver callback may already be queued when the host hides
    // this Tab with content-visibility. Cancel our transaction before the next
    // frame; measureVisibleItemSize also fences any already-queued Virtuoso callback
    // to its last known size so hidden geometry cannot poison the size cache.
    cancelPendingLargeRowShrink();
    setIsLargeRowShrinking(false);
  }, [cancelPendingLargeRowShrink, canLayoutVirtualList]);
  useEffect(() => cancelPendingLargeRowShrink, [cancelPendingLargeRowShrink]);
  // Pagination guard: don't load an older page off stale range math while hidden —
  // Virtuoso can fire startReached from corrupted offsets when our subtree's layout
  // was skipped (content-visibility:hidden), and a prepend in that state compounds the desync.
  const [atPageStart, setAtPageStart] = useState(false);
  const guardedLoadOlder = useCallback(() => {
    if (!canLayoutVirtualList || isViewportRecoveryFenced) return;
    onLoadOlder?.();
  }, [onLoadOlder, canLayoutVirtualList, isViewportRecoveryFenced]);

  const handleAtPageStart = useCallback((atTop: boolean) => {
    setAtPageStart(atTop);
    if (atTop && !olderPageFailed) guardedLoadOlder();
  }, [olderPageFailed, guardedLoadOlder]);

  useEffect(() => {
    if (!canLayoutVirtualList || isViewportRecoveryFenced) {
      onCancelOlder?.();
      return;
    }
    if (!debugScroller || !onPrefetchOlder) return;
    let previousTop = debugScroller.scrollTop;
    const onScroll = () => {
      const top = debugScroller.scrollTop;
      if (top < previousTop && top > 0 && top <= debugScroller.clientHeight && followEnabledRef.current === false) {
        onPrefetchOlder();
      }
      previousTop = top;
    };
    debugScroller.addEventListener('scroll', onScroll, { passive: true });
    return () => debugScroller.removeEventListener('scroll', onScroll);
  }, [canLayoutVirtualList, isViewportRecoveryFenced, onCancelOlder, onPrefetchOlder, debugScroller, followEnabledRef]);

  const handleScrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      const next = el instanceof HTMLElement ? el : null;
      setDebugScroller((prev) => (prev === next ? prev : next));
      onScrollerRef?.(el);
    },
    [onScrollerRef],
  );

  const indexCitations = useMemo(() => createWebSearchCitationIndex(), []);
  const historyForCitations = visibleHistory ?? messages;
  const historySources = useMemo(() => indexCitations(historyForCitations), [indexCitations, historyForCitations]);
  const indexTail = useMemo(() => createWebSearchCitationIndex(), []);
  const tailSources = useMemo(() => indexTail(visibleHistory && streamingMessage ? [streamingMessage] : []),
    [indexTail, visibleHistory, streamingMessage]);
  const citationSources = useMemo(() => {
    if (!tailSources.size) return historySources;
    const next = new Map(historySources);
    for (const [scope, sources] of tailSources) {
      const history = historySources.get(scope);
      if (!history) { next.set(scope, sources); continue; }
      const merged = new Map(history);
      for (const [id, source] of sources) {
        const prior = history.get(id);
        merged.set(id, !history.has(id) || (prior && source && prior.url === source.url && prior.title === source.title) ? source : null);
      }
      next.set(scope, merged);
    }
    return next;
  }, [historySources, tailSources]);

  const messageActionContext = useMemo<MessageActionContext>(
    () => ({
      conversationOperations,
      citationSources,
      rewindableUserMessageIds:
        rewindableUserMessageIds ?? EMPTY_MESSAGE_ID_SET,
      onRewind,
      onFork,
    }),
    [conversationOperations, onFork, onRewind, rewindableUserMessageIds, citationSources],
  );

  // ── Stable itemContent — volatile row actions arrive through Virtuoso context ──
  const renderItem = useMemo(
    () =>
      function MessageListItem(
        index: number,
        message: MessageType,
        actionContext: MessageActionContext,
      ) {
        const sm = streamingMessageRef.current;
        const isStreamingMsg = !!sm && message === sm;
        const nativeOperations =
          actionContext.conversationOperations !== 'builtin';
        const canRewind =
          !nativeOperations ||
          actionContext.rewindableUserMessageIds.has(message.id);
        const canFork = !nativeOperations || Boolean(message.runtimeTurnAnchor);
        // `flow-root` (not `overflow-hidden`) establishes a BFC so child Markdown
        // margins don't leak past the wrapper — that's what e6de7173 originally
        // wanted. `overflow-hidden` did the same job but added a hard clip side
        // effect: when Virtuoso's initial height estimate was
        // far from actual short-item height (~80px), the post-mount measurement
        // correction shifted scroll anchors enough that short user bubbles got
        // visually clipped instead of merely positioned slightly off — they
        // disappeared while neighbouring items merged. flow-root keeps the
        // measurement fix without the clipping.
        return (
          <div
            className="mx-auto max-w-3xl px-3 py-1 flow-root"
            data-chat-search-scope=""
            data-message-id={message.id}
          >
            <ChatRowLayoutProvider
              messageId={message.id}
              onRowLayoutChanged={handleRowLayoutChanged}
            >
              <Message
                message={message}
                citationSources={actionContext.citationSources.get(citationScope(message))}
                isLoading={isStreamingMsg && isLoadingRef.current}
                onRewind={canRewind ? actionContext.onRewind : undefined}
                onRetry={retryAvailable ? handleRetry : undefined}
                onFork={canFork ? actionContext.onFork : undefined}
                exitPlanModeSlot={
                  message.id === exitPlanModeAnchorIdRef.current
                    ? exitPlanModeSlotRef.current
                    : undefined
                }
                initialUserCollapsed={
                  layoutByMessageIdRef.current?.get(message.id)
                    ?.likelyUserCollapsed === true
                }
              />
            </ChatRowLayoutProvider>
          </div>
        );
      },
    [handleRowLayoutChanged, handleRetry, retryAvailable],
  );

  // ── Stable computeItemKey ──
  const computeItemKey = useMemo(
    () => (_i: number, m: MessageType) => m.id,
    [],
  );

  const listContext = useMemo<MessageListContext>(
    () => ({
      ...messageActionContext,
      footer: {
        pendingPermission,
        onPermissionDecision,
        pendingAskUserQuestion,
        onAskUserQuestionSubmit,
        onAskUserQuestionCancel,
        showStatus,
        waitingForInteraction,
        statusMessage,
        getQueryElapsedSeconds,
        systemNotice,
        onDismissSystemNotice,
        bottomSpacerPx,
      },
    }),
    [
      messageActionContext,
      pendingPermission,
      onPermissionDecision,
      pendingAskUserQuestion,
      onAskUserQuestionSubmit,
      onAskUserQuestionCancel,
      showStatus,
      waitingForInteraction,
      statusMessage,
      getQueryElapsedSeconds,
      systemNotice,
      onDismissSystemNotice,
      bottomSpacerPx,
    ],
  );

  // ── Freeze the data fed to Virtuoso while the internal Tab is inactive ──────
  // An inactive internal Tab is wrapped in `content-visibility: hidden`, so any
  // data/height change Virtuoso processes is measured against skipped / stale
  // geometry, which poisons its internal offset+range cache → PHANTOM REPEATED ROWS,
  // then a BLANK viewport once the user scrolls back — recoverable only by remount
  // (close+reopen rebuilds the cache).
  //
  // The trigger is streaming-while-hidden: TabProvider's per-character reveal rAF
  // loop (and the tool-delta rAF flushes) keep growing the last row's height even
  // while we're hidden. Rather than chase every producer that can mutate the live
  // array, we pin the `data` / `firstItemIndex` handed to Virtuoso to the last
  // snapshot taken while active. With a referentially-stable data prop, Virtuoso
  // does no measurement work while hidden no matter how much the live array churns.
  // On re-activation we swap back to the live array (Virtuoso reconciles by
  // computeItemKey=m.id and re-measures the grown last row with real geometry); the
  // inactive→active re-pin effect above restores scroll position.
  //
  // The snapshot advances in a post-commit layout effect, NOT during render: a
  // render-phase write could persist a speculative (interrupted/discarded) active
  // snapshot under React 19 concurrency, which a later hidden render could then hand
  // to Virtuoso — exactly the post-hide measurement we're preventing. A committed
  // layout effect guarantees the snapshot is always a real, measured-while-visible state.
  const frozenDataRef = useRef<{
    data: readonly MessageType[];
    firstItemIndex: number | undefined;
    heightEstimateSeed?: number[];
    context: MessageListContext;
  }>({
    data: canLayoutVirtualList ? messages : EMPTY_MESSAGES,
    firstItemIndex: canLayoutVirtualList ? firstItemIndex : undefined,
    heightEstimateSeed: canLayoutVirtualList
      ? liveHeightEstimateSeed
      : undefined,
    context: listContext,
  });
  useLayoutEffect(() => {
    if (canLayoutVirtualList) {
      frozenDataRef.current = {
        data: messages,
        firstItemIndex,
        heightEstimateSeed: liveHeightEstimateSeed,
        context: listContext,
      };
    }
  }, [
    canLayoutVirtualList,
    messages,
    firstItemIndex,
    liveHeightEstimateSeed,
    listContext,
  ]);
  const virtuosoData = canLayoutVirtualList
    ? messages
    : frozenDataRef.current.data;
  const virtuosoFirstItemIndex = canLayoutVirtualList
    ? firstItemIndex
    : frozenDataRef.current.firstItemIndex;
  const virtuosoHeightEstimateSeed = canLayoutVirtualList
    ? liveHeightEstimateSeed
    : frozenDataRef.current.heightEstimateSeed;
  const virtuosoContext = canLayoutVirtualList
    ? listContext
    : frozenDataRef.current.context;
  const debugProbe = useChatScrollDebugProbe({
    sessionId,
    scroller: debugScroller,
    data: virtuosoData,
    heightEstimateSeed: virtuosoHeightEstimateSeed,
  });
  const handleItemsRendered = useCallback(
    (items: ListItem<MessageType>[]) => {
      debugProbe?.handleItemsRendered(items);
      // Always notify the scroll owner: recovery itself settles from this event.
      // Only publish rows eligible for the startup reveal when presentation is ready.
      onItemsRendered(canLayoutVirtualList && !isViewportRecoveryFenced
        ? items.flatMap(item => item.data ? [item.data] : [])
        : EMPTY_MESSAGES);
    },
    [debugProbe, onItemsRendered, canLayoutVirtualList, isViewportRecoveryFenced],
  );

  return (
    <MessageListPresentationContext.Provider value={canLayoutVirtualList}>
    <div
      ref={viewportRootRef}
        className="relative flex-1 markdown-wide-surface"
      data-streaming={isStreaming || undefined}
      data-viewport-phase={
        isViewportRecoveryFenced
          ? 'recovering'
          : canLayoutVirtualList
            ? 'renderable'
            : 'suspended'
      }
      style={
        isViewportRecoveryFenced && windowPresentation.surfaceAvailable
          ? { visibility: 'hidden' }
          : undefined
      }
    >
      {olderPageFailed && atPageStart && <button type="button" onClick={guardedLoadOlder}
        className="absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-md bg-[var(--paper-elevated)] px-3 py-1 text-xs text-[var(--ink)] shadow">
        {t('retryOlderPage')}
      </button>}
      {/*
        Virtuoso stays mounted across session switches. Previously `key={sessionId}`
        forced a full remount, which dropped every cached item height, rebuilt
        every ResizeObserver, and kicked off a measure→reflow→remeasure storm on
        large sessions — the single biggest contributor to "click a notification,
        come back, UI frozen for 3-5s". Now session changes are a pure data swap:
        `computeItemKey={m.id}` ensures Virtuoso reconciles items by identity,
        and the useLayoutEffect above lands the scroll on the last item in a
        single pre-paint call. Heights are recomputed lazily as items come into
        view, not up front.

        heightEstimates seeds the initial size tree with each message's content
        estimate; real measurements replace those estimates as rows mount.
        Do not also provide defaultItemHeight: in Virtuoso 4.18.3 it initializes
        the tree first and prevents the per-row seed from being used, even if
        the list starts empty before history loads. Callers without a seed use
        Virtuoso's normal first-row probe.

        The extra top viewport and item-count overscan bias reverse scrolling
        toward pre-measuring tall Markdown/code rows before they enter view.
        Synchronous ResizeObserver delivery keeps expansions visually anchored,
        but a large one-commit collapse needs the normal animation-frame boundary
        so WebKit can publish the shorter overflow and hit-test geometry together.
        `overflowAnchor` leaves scroll anchoring to Virtuoso instead of the browser.
      */}
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={handleScrollerRef}
        data={virtuosoData}
        context={virtuosoContext}
        computeItemKey={computeItemKey}
        firstItemIndex={virtuosoFirstItemIndex}
        heightEstimates={virtuosoHeightEstimateSeed}
        atTopThreshold={1}
        atTopStateChange={onLoadOlder ? handleAtPageStart : undefined}
          // The built-in size/viewport paths bypass function-valued followOutput.
          // Literal false leaves all following to the existing chat intent owner.
          followOutput={false}
          totalListHeightChanged={alignFollowingViewport}
        atBottomStateChange={guardedAtBottomChange}
        rangeChanged={debugProbe?.handleRangeChanged}
        itemsRendered={handleItemsRendered}
        atBottomThreshold={50}
        itemSize={measureVisibleItemSize}
        increaseViewportBy={{ top: 1600, bottom: 800 }}
        minOverscanItemCount={{ top: 3, bottom: 1 }}
        skipAnimationFrameInResizeObserver={
          !canLayoutVirtualList || !isLargeRowShrinking
        }
        className="h-full"
        style={{
          overscrollBehavior: 'none',
          scrollbarGutter: 'stable',
          overflowAnchor: 'none',
        }}
        components={VIRTUOSO_COMPONENTS}
        itemContent={renderItem}
      />
    </div>
    </MessageListPresentationContext.Provider>
  );
});

export default MessageList;
