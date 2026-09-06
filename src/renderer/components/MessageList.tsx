import { AlertCircle, CheckCircle, Loader2, X } from 'lucide-react';
import React, { createContext, memo, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, useLayoutEffect, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { ListItem, SizeFunction, VirtuosoHandle } from 'react-virtuoso';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import Message from '@/components/Message';
import { PermissionPrompt, type PermissionRequest } from '@/components/PermissionPrompt';
import { AskUserQuestionPrompt, type AskUserQuestionRequest } from '@/components/AskUserQuestionPrompt';
import { ExitPlanModePrompt } from '@/components/ExitPlanModePrompt';
import type { ExitPlanModeRequest } from '../../shared/types/planMode';
import type { Message as MessageType } from '@/types/chat';
import type { SessionState, SystemNotice } from '@/context/TabContext';
import { ChatRowLayoutProvider, type RowLayoutChangeReason } from '@/context/ChatRowLayoutContext';
import type { RowLayoutContract } from '@/utils/chatRowLayout';
import { useChatScrollDebugProbe } from '@/hooks/useChatScrollDebugProbe';
import { resolveChatBottomSpacerPx } from '@/utils/chatBottomSpacer';
import type { MainWindowPresentation } from '@/utils/mainWindowPresentation';

function formatElapsedTime(totalSeconds: number, t: TFunction<'chat'>): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return t('shell.messageList.elapsed.hms', { hours, minutes, seconds });
  if (minutes > 0) return t('shell.messageList.elapsed.ms', { minutes, seconds });
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
  onViewportAdmissionChanged?: (admitted: boolean, presentationGeneration: number) => void;
  /** Allows an event-driven pending anchor to settle once Virtuoso mounts its row. */
  onItemsRendered?: () => void;
  /** Hides only a known-wrong intermediate recovery position. */
  isViewportRecoveryFenced?: boolean;
  // Pagination: Virtuoso maintains the visible scroll position across
  // prepended items by the absolute index of data[0]. Default 0 = no pagination.
  firstItemIndex?: number;
  heightEstimateSeed?: number[];
  layoutByMessageId?: ReadonlyMap<string, RowLayoutContract>;
  /** Fires when Virtuoso reaches the top — time to load an older page. */
  onLoadOlder?: () => void;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  onScrollerRef?: (el: HTMLElement | Window | null) => void;
  followEnabledRef: React.MutableRefObject<boolean | 'force'>;
  /** Drives the session-switch scroll pin — goes through the hook so grace/degrade state stays consistent. */
  scrollToBottom: (behavior?: 'smooth' | 'auto') => void;
  handleAtBottomChange: (atBottom: boolean) => void;
  onRowLayoutChanged?: (messageId: string, reason: RowLayoutChangeReason) => void;
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (requestId: string, decision: 'deny' | 'allow_once' | 'always_allow') => void | Promise<void>;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
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
  conversationOperations?: 'builtin' | 'codex';
  /** Stable projection of persisted Codex root-turn anchors for user-row eligibility. */
  rewindableUserMessageIds?: ReadonlySet<string>;
  bottomSpacerPx?: number;
}

interface MessageActionContext {
  conversationOperations: 'builtin' | 'codex';
  rewindableUserMessageIds: ReadonlySet<string>;
  onRewind?: (messageId: string) => void;
  onFork?: (assistantMessageId: string) => void;
}

const STREAMING_MESSAGE_COUNT = 20;
const noopRowLayoutChanged = (_messageId: string, _reason: RowLayoutChangeReason) => {};
const STATUS_ROW_HEIGHT_PX = 30;
const EMPTY_MESSAGE_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_MESSAGES: readonly MessageType[] = [];
const noQueryElapsedSeconds = () => 0;
const DEFAULT_WINDOW_PRESENTATION: MainWindowPresentation = {
  surfaceAvailable: true,
  generation: 0,
};
const noopViewportAdmissionChanged = (_admitted: boolean, _presentationGeneration: number) => {};
const noopItemsRendered = () => {};

// Presentation admission remains owned by MessageList. Its projection must
// reach the sampler even while Virtuoso's data/context are deliberately frozen.
const MessageListPresentationContext = createContext(true);

function isLargeRowShrink(reason: RowLayoutChangeReason): boolean {
  return reason === 'process-row-collapse' || reason === 'user-message-collapse-measured';
}

function isRowExpansion(reason: RowLayoutChangeReason): boolean {
  return reason === 'process-row-expand'
    || reason === 'user-message-expand'
    || reason === 'block-group-expand'
    || reason === 'expandable-container-expand';
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

const StatusTimer = memo(function StatusTimer({ message, getElapsedSeconds }: { message: string; getElapsedSeconds: () => number }) {
  const { t } = useTranslation('chat');
  const canPresent = useContext(MessageListPresentationContext);
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (!canPresent) return () => {};
    const id = setInterval(onStoreChange, 1000);
    return () => clearInterval(id);
  }, [canPresent]);
  // The Tab clock keeps advancing without a timer. Re-subscription samples its
  // current value on restore; hidden snapshots never keep a polling loop alive.
  const elapsedSeconds = useSyncExternalStore(subscribe, getElapsedSeconds);
  const elapsedText = elapsedSeconds > 0 ? formatElapsedTime(elapsedSeconds, t) : null;
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
        {canPresent && <Loader2 className="h-full w-full animate-spin" />}
      </span>
      <span className="min-w-0 truncate">{displayText}</span>
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
  const Icon = isError ? AlertCircle : CheckCircle;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--ink-muted)]">
      <Icon className={`h-3 w-3 flex-shrink-0 ${isError ? 'text-[var(--error)]' : 'text-[var(--success)]'}`} />
      <span className="flex-1">{notice.message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-0.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-muted)]"
          title={t('shell.common.close')}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
});

function hasExitPlanModeTool(message: MessageType): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string') return false;
  return message.content.some(
    block => (block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool?.name === 'ExitPlanMode'
  );
}

// ── Virtuoso Footer — dynamic values arrive through the existing list context ──
// Must NOT be recreated on every render (inline arrow in `components` causes Virtuoso
// to remount the footer, resetting StatusTimer and forcing extra remeasurement).
type FooterProps = {
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (requestId: string, decision: 'deny' | 'allow_once' | 'always_allow') => void | Promise<void>;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  showStatus: boolean;
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
  pendingPermission, onPermissionDecision,
  pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel,
  showStatus, statusMessage, getQueryElapsedSeconds,
  systemNotice, onDismissSystemNotice,
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
      {pendingAskUserQuestion && onAskUserQuestionSubmit && onAskUserQuestionCancel && (
        <div className="py-2">
          <AskUserQuestionPrompt request={pendingAskUserQuestion} onSubmit={onAskUserQuestionSubmit} onCancel={onAskUserQuestionCancel} />
        </div>
      )}
      {showStatus && <StatusTimer message={statusMessage} getElapsedSeconds={getQueryElapsedSeconds} />}
      {!showStatus && systemNotice && (
        <SystemNoticeRow notice={systemNotice} onDismiss={onDismissSystemNotice} />
      )}
      {/* Footer spacer follows the measured floating input stack. The extra
          clearance in resolveChatBottomSpacerPx keeps both the status row and
          streaming tail comfortably above the composer without moving either
          out of Virtuoso's scroll geometry. */}
      <div data-chat-footer-spacer="" style={{ height: spacerHeight }} aria-hidden="true" />
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
  layoutByMessageId,
  onLoadOlder,
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
  const [readyPresentationGeneration, setReadyPresentationGeneration] = useState<number | null>(
    windowPresentation.surfaceAvailable && windowPresentation.generation === 0 ? 0 : null,
  );
  useLayoutEffect(() => {
    if (
      !isActive
      || !windowPresentation.surfaceAvailable
      || readyPresentationGeneration === windowPresentation.generation
    ) return;
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
  const canLayoutVirtualList = isActive
    && windowPresentation.surfaceAvailable
    && readyPresentationGeneration === windowPresentation.generation;
  useLayoutEffect(() => {
    onViewportAdmissionChanged(canLayoutVirtualList, windowPresentation.generation);
  }, [canLayoutVirtualList, onViewportAdmissionChanged, windowPresentation.generation]);
  const liveHeightEstimateSeed = heightEstimateSeed?.length === messages.length ? heightEstimateSeed : undefined;

  const streamingStatusMessage = useMemo(
    () => getRandomStreamingMessage(t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages.length, t]
  );

  // ExitPlanMode
  const exitPlanModeAnchorId = useMemo(() => {
    if (!pendingExitPlanMode) return null;
    if (streamingMessage && hasExitPlanModeTool(streamingMessage)) return streamingMessage.id;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (hasExitPlanModeTool(messages[i])) return messages[i].id;
    }
    return null;
  }, [pendingExitPlanMode, streamingMessage, messages]);
  const exitPlanModeSlot = useMemo(() => {
    if (!pendingExitPlanMode || !onExitPlanModeApprove || !onExitPlanModeReject) return undefined;
    return (
      <div className="py-2">
        <ExitPlanModePrompt key={pendingExitPlanMode.requestId} request={pendingExitPlanMode} onApprove={onExitPlanModeApprove} onReject={onExitPlanModeReject} />
      </div>
    );
  }, [pendingExitPlanMode, onExitPlanModeApprove, onExitPlanModeReject]);

  const showStatus = isLoading || !!systemStatus;
  // (issue #174) During 'starting' the SDK subprocess is alive but hasn't
  // sent system_init — the random "苦思冥想中…" line would falsely imply the
  // model is already thinking. Surface a startup-specific hint instead.
  // systemStatus (e.g. compacting / api_retry) still wins because it carries
  // a more specific signal that overrides both starting and the generic
  // thinking line.
  const statusMessage = systemStatus
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

  const guardedAtBottomChange = useCallback((atBottom: boolean) => {
    if (!canLayoutVirtualList) return;
    handleAtBottomChange(atBottom);
  }, [canLayoutVirtualList, handleAtBottomChange]);

  // ── Auto-scroll during streaming — keep the view pinned to the bottom as the
  // streaming item grows taller. `followOutput` only fires on item-COUNT change,
  // so the last item growing (text / thinking streaming in) needs an explicit nudge.
  //
  // This must stay inside Virtuoso's own scroll model — never write `el.scrollTop`
  // directly. The important detail is timing: `autoscrollToBottom()` is designed
  // for late size changes such as image loads; in react-virtuoso 4.18.3 it waits
  // for an atBottomState update and clears the observer after 100ms. Used for
  // per-token text streaming from a passive effect + rAF, it lets the browser
  // paint one frame where the growing row/footer push the status down, then snaps
  // back on Virtuoso's delayed correction. A layout-effect `scrollToIndex` lands
  // the LAST/end alignment before paint while still going through Virtuoso.
  //
  // Gated on `isLoading` (actual streaming), not merely `!!streamingMessage`: a
  // stale streaming message from the loadSession-REST / live-SSE mid-turn race
  // must NOT keep auto-scroll alive once the turn has completed.
  const wasViewportRecoveryFencedRef = useRef(isViewportRecoveryFenced);
  useLayoutEffect(() => {
    const justFinishedRecovery = wasViewportRecoveryFencedRef.current && !isViewportRecoveryFenced;
    wasViewportRecoveryFencedRef.current = isViewportRecoveryFenced;
    if (!streamingMessage || !isLoading || !followEnabledRef.current) return;
    // Skip while the internal Tab is hidden — scrolling against a
    // content-visibility:hidden scroller
    // can compute against stale geometry. The re-pin layout effect above restores
    // position on re-activation.
    if (!canLayoutVirtualList || isViewportRecoveryFenced) return;
    // The controller already issued the one authoritative recovery command.
    // Fence settlement alone is not new streaming output and must not replay it.
    if (justFinishedRecovery) return;
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
  }, [streamingMessage, isLoading, canLayoutVirtualList, isViewportRecoveryFenced, followEnabledRef, virtuosoRef]);

  // ── Terminal pin — pin to bottom once when a turn ends ──
  // At turn end the data-layer reveal drains the remaining text and the message moves to
  // history in a single React batch; the streaming-driven autoscroll effect above gates on
  // `isLoading`, so it won't fire for that final height growth. Without this, the last
  // revealed line(s) can land just below the fold. If we were still following (true/'force'),
  // re-pin once. Routes through scrollToBottom so the hook's grace/degrade state stays consistent.
  const prevIsLoadingRef = useRef(isLoading);
  useLayoutEffect(() => {
    const was = prevIsLoadingRef.current;
    prevIsLoadingRef.current = isLoading;
    if (was && !isLoading && canLayoutVirtualList && !isViewportRecoveryFenced && followEnabledRef.current) {
      scrollToBottom('auto');
    }
  }, [isLoading, canLayoutVirtualList, isViewportRecoveryFenced, followEnabledRef, scrollToBottom]);

  // ── Refs for stable callbacks — avoid recreating itemContent/Footer on every render ──
  const streamingMessageRef = useRef(streamingMessage);
  streamingMessageRef.current = streamingMessage;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const exitPlanModeAnchorIdRef = useRef(exitPlanModeAnchorId);
  exitPlanModeAnchorIdRef.current = exitPlanModeAnchorId;
  const exitPlanModeSlotRef = useRef(exitPlanModeSlot);
  exitPlanModeSlotRef.current = exitPlanModeSlot;
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;
  const layoutByMessageIdRef = useRef(layoutByMessageId);
  layoutByMessageIdRef.current = layoutByMessageId;
  const onRowLayoutChangedRef = useRef(onRowLayoutChanged ?? noopRowLayoutChanged);
  onRowLayoutChangedRef.current = onRowLayoutChanged ?? noopRowLayoutChanged;
  const isItemMeasurementActiveRef = useRef(canLayoutVirtualList);
  isItemMeasurementActiveRef.current = canLayoutVirtualList;
  const measureVisibleItemSize = useCallback<SizeFunction>((element, field) => {
    const knownSize = Number(element.dataset.knownSize);
    if (!isItemMeasurementActiveRef.current) {
      if (Number.isFinite(knownSize) && knownSize > 0) return knownSize;
    }
    const rectField = field === 'offsetWidth' ? 'width' : 'height';
    const measuredSize = Math.round(element.getBoundingClientRect()[rectField]);
    // A mounted row always has positive layout size. Some WebViews can briefly report
    // zero while updating a long virtualized list; feeding that transient geometry into
    // Virtuoso corrupts its size model and can move the viewport far from the anchor.
    if (measuredSize <= 0 && Number.isFinite(knownSize) && knownSize > 0) return knownSize;
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
  const handleRowLayoutChanged = useCallback((messageId: string, reason: RowLayoutChangeReason) => {
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
  }, [cancelPendingLargeRowShrink]);
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
  // Capture the committed admission state directly (not via a ref). Under React
  // 19's child-before-parent layout-effect ordering, a ref updated in our parent
  // layout effect could still be stale when Virtuoso's child effects fire during
  // an admitted→suspended commit. These callbacks are not row identities, so
  // recreating them at a rare lifecycle edge cannot remount message rows.
  const handleFollowOutput = useMemo(
    () => (isAtBottom: boolean) => {
      // Hidden tab (content-visibility:hidden): never drive follow-scroll against
      // skipped/stale geometry (same cache-poisoning class as the data freeze below).
      if (!canLayoutVirtualList || isViewportRecoveryFenced) return false;
      const mode = followEnabledRef.current;
      if (!mode) return false;
      if (mode === 'force') return 'smooth' as const;
      return isAtBottom ? 'smooth' as const : false;
    },
    [followEnabledRef, canLayoutVirtualList, isViewportRecoveryFenced]
  );

  // Pagination guard: don't load an older page off stale range math while hidden —
  // Virtuoso can fire startReached from corrupted offsets when our subtree's layout
  // was skipped (content-visibility:hidden), and a prepend in that state compounds the desync.
  const guardedLoadOlder = useCallback(() => {
    if (!canLayoutVirtualList || isViewportRecoveryFenced) return;
    onLoadOlder?.();
  }, [onLoadOlder, canLayoutVirtualList, isViewportRecoveryFenced]);

  const [debugScroller, setDebugScroller] = useState<HTMLElement | null>(null);
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const next = el instanceof HTMLElement ? el : null;
    setDebugScroller(prev => (prev === next ? prev : next));
    onScrollerRef?.(el);
  }, [onScrollerRef]);

  const messageActionContext = useMemo<MessageActionContext>(() => ({
    conversationOperations,
    rewindableUserMessageIds: rewindableUserMessageIds ?? EMPTY_MESSAGE_ID_SET,
    onRewind,
    onFork,
  }), [conversationOperations, onFork, onRewind, rewindableUserMessageIds]);

  // ── Stable itemContent — volatile row actions arrive through Virtuoso context ──
  // eslint-disable-next-line react/display-name
  const renderItem = useMemo(() => (index: number, message: MessageType, actionContext: MessageActionContext) => {
    const sm = streamingMessageRef.current;
    const isStreamingMsg = !!sm && message === sm;
    const codexOperations = actionContext.conversationOperations === 'codex';
    const canRewind = !codexOperations || actionContext.rewindableUserMessageIds.has(message.id);
    const canFork = !codexOperations || Boolean(message.runtimeTurnAnchor);
    // `flow-root` (not `overflow-hidden`) establishes a BFC so child Markdown
    // margins don't leak past the wrapper — that's what e6de7173 originally
    // wanted. `overflow-hidden` did the same job but added a hard clip side
    // effect: when Virtuoso's height estimate (`defaultItemHeight=480`) was
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
            isLoading={isStreamingMsg && isLoadingRef.current}
            onRewind={canRewind ? actionContext.onRewind : undefined}
            onRetry={onRetryRef.current}
            onFork={canFork ? actionContext.onFork : undefined}
            exitPlanModeSlot={message.id === exitPlanModeAnchorIdRef.current ? exitPlanModeSlotRef.current : undefined}
            initialUserCollapsed={layoutByMessageIdRef.current?.get(message.id)?.likelyUserCollapsed === true}
          />
        </ChatRowLayoutProvider>
      </div>
    );
  }, [handleRowLayoutChanged]);

  // ── Stable computeItemKey ──
  const computeItemKey = useMemo(() => (_i: number, m: MessageType) => m.id, []);

  const listContext = useMemo<MessageListContext>(() => ({
    ...messageActionContext,
    footer: {
      pendingPermission, onPermissionDecision,
      pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel,
      showStatus, statusMessage, getQueryElapsedSeconds,
      systemNotice, onDismissSystemNotice, bottomSpacerPx,
    },
  }), [messageActionContext, pendingPermission, onPermissionDecision, pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel, showStatus, statusMessage, getQueryElapsedSeconds, systemNotice, onDismissSystemNotice, bottomSpacerPx]);

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
    heightEstimateSeed: canLayoutVirtualList ? liveHeightEstimateSeed : undefined,
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
  }, [canLayoutVirtualList, messages, firstItemIndex, liveHeightEstimateSeed, listContext]);
  const virtuosoData = canLayoutVirtualList ? messages : frozenDataRef.current.data;
  const virtuosoFirstItemIndex = canLayoutVirtualList ? firstItemIndex : frozenDataRef.current.firstItemIndex;
  const virtuosoHeightEstimateSeed = canLayoutVirtualList ? liveHeightEstimateSeed : frozenDataRef.current.heightEstimateSeed;
  const virtuosoContext = canLayoutVirtualList ? listContext : frozenDataRef.current.context;
  const debugProbe = useChatScrollDebugProbe({
    sessionId,
    scroller: debugScroller,
    data: virtuosoData,
    heightEstimateSeed: virtuosoHeightEstimateSeed,
  });
  const handleItemsRendered = useCallback((items: ListItem<MessageType>[]) => {
    debugProbe?.handleItemsRendered(items);
    onItemsRendered();
  }, [debugProbe, onItemsRendered]);

  return (
    <MessageListPresentationContext.Provider value={canLayoutVirtualList}>
    <div
      ref={viewportRootRef}
      className="relative flex-1"
      data-streaming={isStreaming || undefined}
      data-viewport-phase={isViewportRecoveryFenced ? 'recovering' : (canLayoutVirtualList ? 'renderable' : 'suspended')}
      style={isViewportRecoveryFenced && windowPresentation.surfaceAvailable
        ? { visibility: 'hidden' }
        : undefined}
    >
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

        defaultItemHeight=480 is an empirical average across tool-use / text /
        thinking blocks; too low (200) causes Virtuoso to over-render initially,
        too high leaves holes at the bottom. 480 stays close to long-content
        reality but does produce sizeable post-mount corrections on short user
        bubbles (~80-150px). The previous wrapper used `overflow-hidden`, which
        amplified those corrections into hard clips: short bubbles vanished
        while neighbours merged. The wrapper is now `flow-root` (above), so any
        residual correction shows up as a small scroll bounce rather than a
        disappearing message.

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
        startReached={onLoadOlder ? guardedLoadOlder : undefined}
        followOutput={handleFollowOutput}
        atBottomStateChange={guardedAtBottomChange}
        rangeChanged={debugProbe?.handleRangeChanged}
        itemsRendered={handleItemsRendered}
        atBottomThreshold={50}
        itemSize={measureVisibleItemSize}
        defaultItemHeight={480}
        increaseViewportBy={{ top: 1600, bottom: 800 }}
        minOverscanItemCount={{ top: 3, bottom: 1 }}
        skipAnimationFrameInResizeObserver={!canLayoutVirtualList || !isLargeRowShrinking}
        className="h-full"
        style={{ overscrollBehavior: 'none', scrollbarGutter: 'stable', overflowAnchor: 'none' }}
        components={VIRTUOSO_COMPONENTS}
        itemContent={renderItem}
      />
    </div>
    </MessageListPresentationContext.Provider>
  );
});

export default MessageList;
