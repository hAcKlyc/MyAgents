/**
 * TabProvider - Provides isolated state for each Tab
 * 
 * Each TabProvider instance manages:
 * - Its own Sidecar instance (per-Tab isolation)
 * - Its own SSE connection
 * - Its own message history
 * - Its own loading/session state
 * - Its own logs and system info
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';

import { track, consumePendingSurface, setPendingSurface, hashAgentNameSync } from '@/analytics';
import type { Surface } from '@/analytics';
import { useConfigData } from '@/config/useConfigData';
import { getAgentByWorkspacePath } from '@/config/services/agentConfigService';
import { normalizeRuntime } from '@/utils/sessionOpenPlan';
import { generateSessionTitle } from '@/api/sessionClient';
import type { SessionMetadata } from '@/api/sessionClient';
import { createSseConnection, type SseConnection } from '@/api/SseConnection';
import type { ImageAttachment } from '@/components/SimpleChatInput';
import type { PermissionRequest } from '@/components/PermissionPrompt';
import type { AskUserQuestionRequest, AskUserQuestion } from '../../shared/types/askUserQuestion';
import type { ExitPlanModeRequest, EnterPlanModeRequest, ExitPlanModeAllowedPrompt } from '../../shared/types/planMode';
import { CUSTOM_EVENTS, isPendingSessionId } from '../../shared/constants';
import { TabContext, TabApiContext, TabActiveContext, type SessionState, type TabContextValue, type TabApiContextValue } from './TabContext';
import { isSubagentContainerTool } from '@/components/tools/toolBadgeConfig';
import type { Message, ContentBlock, ToolUseSimple, ToolInput, TaskStats, SubagentToolCall } from '@/types/chat';
import type { ToolUse } from '@/types/stream';
import type { SystemInitInfo } from '../../shared/types/system';
import type { RuntimeDiagnostics } from '../../shared/types/runtime';
import type { TerminalReason } from '../../shared/terminalReason';
import { shouldRecordTurnForTitle } from '../../shared/terminalReason';
import { isLikelyErrorTitle } from '../../shared/titleFilters';
import type { LogEntry } from '@/types/log';
import { parsePartialJson } from '@/utils/parsePartialJson';
import { subscribeFrontendLogs, setCurrentTabId } from '@/utils/frontendLogger';
import { getTabServerUrl, proxyFetch, isTauri, getSessionActivation, getSessionPort, ensureSessionSidecar, resetTabServerUrlCache, setActiveCorrelation } from '@/api/tauriClient';
import { resolveAttachmentUrl } from '@/utils/attachmentUrl';
import { isExistingSessionSwitch, isResetSessionBirth, shouldDegradedLoad } from '@/utils/optionResolve';
import { getSessionDisplayText } from '@/utils/sessionDisplay';
import { refreshWorkspaceFileIndex } from '@/api/searchClient';
import { listenWithCleanup } from '@/utils/tauriListen';
import type { PermissionMode } from '@/config/types';
import type { QueuedMessageInfo } from '@/types/queue';
import {
    notifyMessageComplete,
    notifyPermissionRequest,
    notifyAskUserQuestion,
    notifyPlanModeRequest,
} from '@/services/notificationService';
import { setBackgroundTaskStatus, setBackgroundTaskDescription, getBackgroundTaskDescription, clearAllBackgroundTaskStatuses, registerBackgroundTask } from '@/utils/backgroundTaskStatus';

/** Minimum QA rounds before triggering AI title generation */
const AUTO_TITLE_MIN_ROUNDS = 3;

// Pattern 3 §3.2.2 — display cap on streaming tool results. The renderer
// truncates the inline result to this many characters; the full result is
// available on completion (and Pattern 2's maybeSpill makes it accessible
// via the /refs/:id endpoint when oversize).
const TOOL_RESULT_DISPLAY_CAP = 8 * 1024;
const TOOL_RESULT_TAIL_KEEP = 1024;

/**
 * Force-complete any unclosed thinking blocks in a content array.
 * Used as a safety net at multiple points: when new content arrives (text/tool/thinking),
 * the previous thinking block must have ended. Returns the original array if no changes needed.
 */
function closeOpenThinkingBlocks(content: ContentBlock[]): ContentBlock[] {
    if (!content.some(b => b.type === 'thinking' && !b.isComplete)) return content;
    return content.map(b =>
        b.type === 'thinking' && !b.isComplete
            ? { ...b, isComplete: true, thinkingDurationMs: b.thinkingStartedAt ? Date.now() - b.thinkingStartedAt : undefined }
            : b
    );
}

// File-modifying tools that should trigger workspace refresh
// These tools can create, modify, or delete files in the workspace
const FILE_MODIFYING_TOOLS = new Set([
    'Bash',         // Shell commands can modify files
    'Edit',         // Single file edit
    'MultiEdit',    // Multiple file edits
    'Write',        // Create/overwrite files
    'NotebookEdit', // Jupyter notebook edits
]);

/**
 * Check if a content block is a tool block (either local tool_use or server_tool_use)
 * Used to unify handling of both tool types in event handlers
 */
const isToolBlock = (b: ContentBlock): boolean => b.type === 'tool_use' || b.type === 'server_tool_use';

/**
 * Helper to update subagent calls in a message's content blocks
 * Returns the updated message, or null if no matching tool block found.
 */
function applySubagentCallsUpdate(
    msg: Message,
    parentToolUseId: string,
    updater: (calls: SubagentToolCall[], tool: ToolUseSimple) => { calls: SubagentToolCall[]; stats?: TaskStats }
): Message | null {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') return null;

    const contentArray = msg.content;
    const idx = contentArray.findIndex(b => b.type === 'tool_use' && b.tool?.id === parentToolUseId);
    if (idx === -1) return null;

    const block = contentArray[idx];
    if (block.type !== 'tool_use' || !block.tool) return null;

    const { calls, stats } = updater(block.tool.subagentCalls || [], block.tool);
    const updated = [...contentArray];
    updated[idx] = {
        ...block,
        tool: {
            ...block.tool,
            subagentCalls: calls,
            ...(stats !== undefined && { taskStats: stats })
        }
    };
    return { ...msg, content: updated };
}

interface TabProviderProps {
    children: ReactNode;
    tabId: string;
    agentDir: string;
    sessionId?: string | null;
    /** Whether this Tab is currently visible — fed into TabActiveContext for useTabActive() consumers */
    isActive?: boolean;
    /** Callback when generating state changes (for close confirmation) */
    onGeneratingChange?: (isGenerating: boolean) => void;
    /** Callback when sessionId changes (e.g., backend creates real session from pending-xxx) */
    onSessionIdChange?: (newSessionId: string) => void;
    /** Callback when session title changes (auto-generated or renamed) */
    onTitleChange?: (title: string) => void;
    /** Callback when unread state changes (message completed on non-active tab) */
    onUnreadChange?: (hasUnread: boolean) => void;
    // Note: sidecarPort prop removed - now using Session-centric Sidecar (Owner model)
    // Port is dynamically retrieved via getSessionPort(sessionId)
}

/**
 * Handle API response - check for errors and throw if not ok
 */
async function handleApiResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error((errorData as { error?: string }).error || `HTTP ${response.status}`);
    }
    return (await response.json()) as T;
}

/**
 * Get the base URL for a Tab's Sidecar
 * With Session-centric Sidecar (Owner model), we first try to get the port from sessionId,
 * then fall back to tabId lookup for legacy compatibility.
 * @param tabId - Tab identifier
 * @param sessionId - Session identifier (optional, for Session-centric lookup)
 */
/**
 * Merge `incoming` ToolAttachment array into `existing`, preserving any entries
 * in `existing` that have already been resolved (no pendingId, or pendingId
 * present but refPath populated) when the corresponding `incoming` entry is
 * still a placeholder. Codex review SM1.
 *
 * Identity key: `pendingId` if present; falls back to `refPath` if not.
 */
function mergeAttachmentsByPendingId(
    existing: import('@/types/chat').ToolAttachment[] | undefined,
    incoming: import('@/types/chat').ToolAttachment[] | undefined,
): import('@/types/chat').ToolAttachment[] | undefined {
    if (!incoming) return existing;
    if (!existing) return incoming;
    return incoming.map(inc => {
        const key = inc.pendingId || inc.refPath;
        const prior = existing.find(e => (e.pendingId || e.refPath) === key);
        // If we already have a resolved version (refPath non-empty + no pendingId),
        // keep it instead of accepting an incoming placeholder.
        if (prior && prior.refPath && !prior.pendingId) return prior;
        return inc;
    });
}

async function getBaseUrl(tabId: string, sessionId?: string | null): Promise<string> {
    // Session-centric: try to get port from sessionId first
    if (sessionId) {
        const port = await getSessionPort(sessionId);
        if (port !== null) {
            return `http://127.0.0.1:${port}`;
        }
    }
    // Fallback to Tab-based lookup (legacy compatibility)
    return getTabServerUrl(tabId);
}

/** Optional per-call options for Tab-scoped fetch helpers. */
interface TabApiCallOptions {
    /**
     * Pass an AbortSignal to cancel the request from the renderer side. The
     * underlying Tauri invoke can't truly be cancelled, but if the signal is
     * aborted before / during the call, proxyFetch silently throws AbortError
     * instead of logging a "Sidecar gone" warning. The classic use case is a
     * useEffect cleanup that fires when the tab is closing — without this,
     * every tab close emits noisy lifecycle warnings for in-flight prewarm /
     * runtime/models requests that would have succeeded had the tab survived
     * a few more milliseconds.
     */
    signal?: AbortSignal;
}

/**
 * Create a Tab-scoped POST function
 * Uses Session-centric port lookup when sessionId is available
 */
function createPostJson(tabId: string, sessionIdRef: React.MutableRefObject<string | null>) {
    return async <T,>(path: string, body?: unknown, opts?: TabApiCallOptions): Promise<T> => {
        const baseUrl = await getBaseUrl(tabId, sessionIdRef.current);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: opts?.signal,
        });
        return handleApiResponse<T>(response);
    };
}

/**
 * Create a Tab-scoped GET function
 * Uses Session-centric port lookup when sessionId is available
 */
function createApiGetJson(tabId: string, sessionIdRef: React.MutableRefObject<string | null>) {
    return async <T,>(path: string, opts?: TabApiCallOptions): Promise<T> => {
        const baseUrl = await getBaseUrl(tabId, sessionIdRef.current);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url, { signal: opts?.signal });
        return handleApiResponse<T>(response);
    };
}

/**
 * Create a Tab-scoped PUT function
 * Uses Session-centric port lookup when sessionId is available
 */
function createApiPutJson(tabId: string, sessionIdRef: React.MutableRefObject<string | null>) {
    return async <T,>(path: string, body?: unknown, opts?: TabApiCallOptions): Promise<T> => {
        const baseUrl = await getBaseUrl(tabId, sessionIdRef.current);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: opts?.signal,
        });
        return handleApiResponse<T>(response);
    };
}

/**
 * Create a Tab-scoped DELETE function
 * Uses Session-centric port lookup when sessionId is available
 */
function createApiDelete(tabId: string, sessionIdRef: React.MutableRefObject<string | null>) {
    return async <T,>(path: string, opts?: TabApiCallOptions): Promise<T> => {
        const baseUrl = await getBaseUrl(tabId, sessionIdRef.current);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url, { method: 'DELETE', signal: opts?.signal });
        return handleApiResponse<T>(response);
    };
}

export default function TabProvider({
    children,
    tabId,
    agentDir,
    sessionId = null,
    isActive,
    onGeneratingChange,
    onSessionIdChange,
    onTitleChange,
    onUnreadChange,
}: TabProviderProps) {
    // Core state
    // currentSessionId tracks the actual loaded session (starts from prop, updated by loadSession)
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(sessionId);
    // Ref to track currentSessionId in SSE event handlers and API functions (avoid stale closure)
    const currentSessionIdRef = useRef<string | null>(currentSessionId);
    currentSessionIdRef.current = currentSessionId;

    // Create Tab-scoped API functions
    // Uses Session-centric port lookup via currentSessionIdRef
    const postJson = useMemo(() => createPostJson(tabId, currentSessionIdRef), [tabId]);
    const apiGetJson = useMemo(() => createApiGetJson(tabId, currentSessionIdRef), [tabId]);
    const apiPutJson = useMemo(() => createApiPutJson(tabId, currentSessionIdRef), [tabId]);
    const apiDeleteJson = useMemo(() => createApiDelete(tabId, currentSessionIdRef), [tabId]);

    // Analytics meta resolver — used by session_new tracking.
    // Reads through config to look up the agent bound to this tab's agentDir;
    // returns ('unknown' / null) when no agent is bound, which is itself a
    // useful signal (means launcher / no-agent session).
    const { config: appConfig } = useConfigData();
    // sendMessage is a useCallback keyed only on [tabId] (exhaustive-deps off), so
    // reading appConfig directly inside it would capture a stale render. Mirror it
    // into a ref (updated every render) so the per-send background-agent policy echo
    // reflects the user's latest Settings choice without recreating the callback.
    const appConfigRef = useRef(appConfig);
    appConfigRef.current = appConfig;
    const analyticsMetaRef = useRef({
        runtime: 'builtin' as 'builtin' | 'claude-code' | 'codex' | 'gemini' | 'unknown',
        agentHash: null as string | null,
    });
    useEffect(() => {
        if (!agentDir) {
            analyticsMetaRef.current = { runtime: 'builtin', agentHash: null };
            return;
        }
        const agent = getAgentByWorkspacePath(appConfig, agentDir);
        const runtime = agent ? normalizeRuntime(agent.runtime) : 'builtin';
        const agentHash = hashAgentNameSync(agent?.name ?? null);
        analyticsMetaRef.current = { runtime, agentHash };
    }, [appConfig, agentDir]);

    // PRD 0.2.19 cross-review fix (B2): Tab-scoped track wrapper that always
    // attaches THIS tab's session_id (from `currentSessionIdRef`) AND tab_id
    // (from the closure-captured `tabId` prop), not the global Active Context.
    //
    // Without this, SSE callbacks that fire on an inactive Tab inherit the
    // foreground Tab's session_id/tab_id from `setAnalyticsContext`, join to
    // the wrong session/tab, and make multi-tab analytics actively misleading
    // (Codex BLOCKER #1 + cross-review fix: tab_id was previously bypassed).
    // Stable callback — `tabId` is a stable prop, `currentSessionIdRef` is a
    // ref so it always reads the latest id.
    const trackTabEvent = useCallback((event: string, params: Record<string, string | number | boolean | null | undefined> = {}): void => {
        track(event, { session_id: currentSessionIdRef.current ?? null, tab_id: tabId, ...params });
    }, [tabId]);

    // ── Split message state: history (stable during streaming) + streaming (updates on every SSE event)
    const [historyMessages, setHistoryMessages] = useState<Message[]>([]);
    // Mirror of historyMessages for async listeners (cron incremental sync) that
    // need to read "what's on screen right now" without retriggering effects.
    // Eventual-consistency is fine — Tauri event handlers run in microtasks,
    // after the latest render commit.
    const historyMessagesRef = useRef<Message[]>(historyMessages);
    useEffect(() => { historyMessagesRef.current = historyMessages; }, [historyMessages]);
    const [streamingMessage, rawSetStreamingMessage] = useState<Message | null>(null);
    const streamingMessageRef = useRef<Message | null>(null);

    // Wrapper setter that keeps ref in sync (functional updates read latest via ref)
    const setStreamingMessage = useCallback((action: React.SetStateAction<Message | null>) => {
        rawSetStreamingMessage(prev => {
            const next = typeof action === 'function' ? action(prev) : action;
            streamingMessageRef.current = next;
            return next;
        });
    }, []);

    // Mid-turn injection: user messages yielded to SDK during active streaming.
    // Combined view for backward compat (used by Chat.tsx messagesRef, rewind, error handling)
    // Mid-turn injected user messages are inserted into historyMessages via the mid-turn break
    // mechanism (queue:started with midTurnBreak=true splits the streaming message).
    const messages = useMemo<Message[]>(() => {
        return streamingMessage
            ? [...historyMessages, streamingMessage]
            : historyMessages;
    }, [historyMessages, streamingMessage]);

    // Compat wrapper: setMessages operates on combined array, drains streaming into history.
    // Note: The functional-update path has side effects (clearing streamingMessage) inside
    // setHistoryMessages updater — technically impure, but safe because: (1) StrictMode is off,
    // (2) callers (rewind, error) only invoke this when NOT streaming (streamingMessage is already null).
    const setMessages = useCallback((action: React.SetStateAction<Message[]>) => {
        if (typeof action === 'function') {
            setHistoryMessages(prevHistory => {
                const combined = streamingMessageRef.current
                    ? [...prevHistory, streamingMessageRef.current]
                    : prevHistory;
                const next = action(combined);
                streamingMessageRef.current = null;
                rawSetStreamingMessage(null);
                return next;
            });
        } else {
            streamingMessageRef.current = null;
            rawSetStreamingMessage(null);
            setHistoryMessages(action);
        }
    }, []);

    const [isLoading, setIsLoading] = useState(false);
    const [isSessionLoading, setIsSessionLoading] = useState(false);
    // Pagination state for large sessions. firstItemIndex is Virtuoso's
    // mechanism for maintaining visible scroll position when items are
    // prepended — on prepend we decrement it by the number of added items.
    // Starts at a large constant so it can decrement without ever going
    // negative (even for sessions with millions of historical messages).
    const PAGINATION_START_INDEX = 1_000_000;
    const INITIAL_PAGE_SIZE = 80;
    const OLDER_PAGE_SIZE = 80;
    const [firstItemIndex, setFirstItemIndex] = useState(PAGINATION_START_INDEX);
    const [hasMoreBefore, setHasMoreBefore] = useState(false);
    const hasMoreBeforeRef = useRef(false);
    hasMoreBeforeRef.current = hasMoreBefore;
    const loadingOlderRef = useRef(false);
    const [sessionState, setSessionState] = useState<SessionState>('idle');
    const [sessionRuntime, setSessionRuntime] = useState<string | null>(null);
    const [sessionMeta, setSessionMeta] = useState<SessionMetadata | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [unifiedLogs, setUnifiedLogs] = useState<LogEntry[]>([]);
    const [systemInitInfo, setSystemInitInfo] = useState<SystemInitInfo | null>(null);
    // Issue #194 — runtime diagnostics snapshot for external runtimes (Codex
    // today; Claude Code / Gemini later). Replaces the previously-hardcoded
    // `systemInitInfo.tools: []` signal with a real diagnostic surface.
    const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnostics | null>(null);
    const [agentError, setAgentError] = useState<string | null>(null);
    const [systemStatus, setSystemStatus] = useState<string | null>(null);  // e.g., 'compacting'
    const [lastTerminalReason, setLastTerminalReason] = useState<TerminalReason | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
    const [pendingAskUserQuestion, setPendingAskUserQuestion] = useState<AskUserQuestionRequest | null>(null);
    const [pendingExitPlanMode, setPendingExitPlanMode] = useState<ExitPlanModeRequest | null>(null);
    const [pendingEnterPlanMode, setPendingEnterPlanMode] = useState<EnterPlanModeRequest | null>(null);
    const [toolCompleteCount, setToolCompleteCount] = useState(0);
    const [queuedMessages, setQueuedMessages] = useState<QueuedMessageInfo[]>([]);
    const queuedMessagesRef = useRef<QueuedMessageInfo[]>([]);
    queuedMessagesRef.current = queuedMessages;

    // Track started queueIds to prevent sendMessage .then() from re-adding them
    const startedQueueIdsRef = useRef(new Set<string>());

    // Sync currentSessionId when prop changes (e.g., from parent re-initializing)
    useEffect(() => {
        currentSessionIdRef.current = sessionId;
        setCurrentSessionId(sessionId);
    }, [sessionId]);

    // Store callbacks in refs to avoid triggering effects on every render
    const onGeneratingChangeRef = useRef(onGeneratingChange);
    onGeneratingChangeRef.current = onGeneratingChange;
    const onSessionIdChangeRef = useRef(onSessionIdChange);
    onSessionIdChangeRef.current = onSessionIdChange;
    const onTitleChangeRef = useRef(onTitleChange);
    onTitleChangeRef.current = onTitleChange;
    const onUnreadChangeRef = useRef(onUnreadChange);
    onUnreadChangeRef.current = onUnreadChange;
    // Ref for isActive to avoid stale closures in SSE event handlers
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;

    // Auto-title generation refs
    // Collect QA rounds; trigger AI title after 3+ rounds for sufficient context.
    // For 1-2 rounds, the default truncated user query is shown instead.
    const autoTitleAttemptedRef = useRef(false);
    const titleRoundsRef = useRef<Array<{ user: string; assistant: string }>>([]);
    // FIFO queue: supports queued sends where user sends B before A completes.
    // Each send pushes to the queue; each message-complete shifts from it.
    const pendingUserMessagesRef = useRef<string[]>([]);
    const lastCompletedTextRef = useRef('');
    const lastProviderEnvRef = useRef<{ baseUrl?: string; apiKey?: string; authType?: string; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses'; modelAliases?: { sonnet?: string; opus?: string; haiku?: string } } | undefined>(undefined);
    const lastModelRef = useRef<string | undefined>(undefined);

    // Notify parent when generating state changes (for close confirmation)
    useEffect(() => {
        onGeneratingChangeRef.current?.(isLoading);
    }, [isLoading]);

    // Refs for SSE handling
    const sseRef = useRef<SseConnection | null>(null);
    // The sessionId used by the currently connected SSE stream. App.tsx can
    // switch a tab to a new Session Sidecar without remounting this provider,
    // so "SSE connected" alone is not enough; it must be connected to THIS session.
    const connectedSseSessionIdRef = useRef<string | null>(null);
    const sseReconnectGenerationRef = useRef(0);
    const isStreamingRef = useRef(false);
    // Tracks whether the backend session is actively processing (system-init received → idle).
    // Separate from isStreamingRef which means "a streaming message exists in React state".
    // Used to prevent loadSession from running during pending→real session ID upgrade.
    const isSessionActiveRef = useRef(false);

    /**
     * Clear all session-active state. Called when the session finishes, errors, or resets.
     *
     * WHY THIS EXISTS (pit-of-success):
     * isStreamingRef ("streaming message exists in React") and isSessionActiveRef ("backend is
     * processing") have identical clear-time but different set-time. isStreamingRef is set by the
     * first message-chunk (via flushSync), while isSessionActiveRef is set by system-init (before
     * any chunks). They MUST be cleared together — if one is forgotten, either loadSession runs
     * during active sessions (disrupts streaming) or loadSession is permanently blocked (stale ref).
     * A single clearSessionActive() makes it impossible to forget.
     *
     * If you add a new "session active" ref in the future, add its cleanup HERE.
     */
    const clearSessionActive = useCallback(() => {
        isStreamingRef.current = false;
        isSessionActiveRef.current = false;
    }, []);

    // Ref for stop timeout cleanup
    const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const seenIdsRef = useRef<Set<string>>(new Set());
    // Flag to skip message-replay after user clicks "new session"
    const isNewSessionRef = useRef(false);
    // resetSession's real id may arrive after sendMessage clears isNewSessionRef.
    // Keep the birth identity separately so that live reset turns are not
    // misclassified as user history switches.
    const resetBirthPendingRef = useRef(false);
    const resetBirthSessionIdRef = useRef<string | null>(null);
    // Flag to skip SSE replays while loadSession REST API is in-flight.
    // Without this, SSE replays race with loadSession and create intermediate
    // render states (3→46→249) causing visible scroll jumps on session entry.
    const isLoadingSessionRef = useRef(false);
    const loadSessionGenerationRef = useRef(0);
    // Ref for cron task exit handler (set by useCronTask hook via context)
    const onCronTaskExitRequestedRef = useRef<((taskId: string, reason: string) => void) | null>(null);
    // Synchronous map: toolUseId → toolName. Updated outside React state updaters
    // to avoid React 18 automatic batching timing issues (state updaters run during
    // render, not during setState call — so reading a local variable set inside an
    // updater is unreliable). This ref is always synchronously up-to-date.
    const toolNameMapRef = useRef<Map<string, string>>(new Map());
    // Pending attachments to merge with next user message from SSE replay
    const pendingAttachmentsRef = useRef<{
        id: string;
        name: string;
        size: number;
        mimeType: string;
        previewUrl: string;
        isImage: boolean;
    }[] | null>(null);

    /**
     * Reset session for "新对话" functionality
     * This synchronizes frontend AND backend state:
     * - Stops any ongoing AI response
     * - Clears all messages on both sides
     * - Generates new session ID on backend
     * - Clears logs and permissions
     */

    // Shared cleanup for all session boundary transitions (reset, load, SSE init).
    // Single source of truth — add new interactive states here to avoid leaking across sessions.
    const clearInteractiveState = useCallback(() => {
        setPendingPermission(null);
        setPendingAskUserQuestion(null);
        setPendingExitPlanMode(null);
        setPendingEnterPlanMode(null);
        setQueuedMessages([]);
        startedQueueIdsRef.current.clear();
        clearAllBackgroundTaskStatuses();
    }, []);

    // Reset pagination state (firstItemIndex + hasMoreBefore + in-flight guard)
    // on any boundary where historyMessages is cleared or replaced without a
    // subsequent loadSession: resetSession, chat:init SSE-reconnect clear path,
    // and as a fallback for places that drop history. loadSession has its own
    // inline reset that uses the server's `hasMoreBefore` value from the
    // response, so it deliberately does not call this helper.
    const resetPaginationState = useCallback(() => {
        setFirstItemIndex(PAGINATION_START_INDEX);
        setHasMoreBefore(false);
        hasMoreBeforeRef.current = false;
        loadingOlderRef.current = false;
    }, []);

    const resetSession = useCallback(async (): Promise<boolean> => {
        console.log(`[TabProvider ${tabId}] resetSession: starting...`);

        // 1. Clear frontend state immediately for responsive UI
        setHistoryMessages([]);
        resetPaginationState();
        setStreamingMessage(null);
        seenIdsRef.current.clear();
        isNewSessionRef.current = true;
        resetBirthPendingRef.current = true;
        resetBirthSessionIdRef.current = null;
        clearSessionActive();
        toolNameMapRef.current.clear();
        // Pattern 3 §3.2.2 — reset delta buffers; stale fragments from a prior
        // session must not leak into a fresh tool block keyed on a recycled id.
        pendingToolResultDeltasRef.current.clear();
        pendingToolInputDeltasRef.current.clear();
        pendingSubagentToolResultDeltasRef.current.clear();
        pendingSubagentToolInputDeltasRef.current.clear();
        // Reveal state is per-tab; a session swap/reset must not let a stale reveal loop or
        // un-revealed pending text bleed into the next session. (Loop-stop is inlined rather
        // than calling stopRevealLoop — these reset callbacks are declared before it, so
        // referencing it in their dep arrays would be a TDZ error. Refs are safe in the body.
        // Staleness of any already-enqueued commit is handled by the message-id guard.)
        pendingTextRef.current = '';
        if (revealRafRef.current != null) { cancelAnimationFrame(revealRafRef.current); revealRafRef.current = null; }
        revealAccRef.current = 0;
        revealLastRef.current = 0;
        adoptedStreamRef.current = false;
        setIsLoading(false);
        setSessionState('idle');  // Reset session state for new conversation
        setSystemStatus(null);
        setAgentError(null);
        setLastTerminalReason(null);
        setUnifiedLogs([]);
        setLogs([]);
        setSessionMeta(null);
        // Issue #194 (Codex review #6) — clear runtime diagnostics on reset so
        // a stale Codex banner from the previous session doesn't leak into a
        // new one (or a Tab that just switched to builtin runtime).
        setRuntimeDiagnostics(null);
        clearInteractiveState();
        // Reset auto-title state for new conversation
        autoTitleAttemptedRef.current = false;
        titleRoundsRef.current = [];
        pendingUserMessagesRef.current = [];
        lastCompletedTextRef.current = '';
        lastProviderEnvRef.current = undefined;
        lastModelRef.current = undefined;
        // NOTE: Do NOT clear currentSessionId here. The old session ID is the only way
        // to find the still-running sidecar via getSessionPort(). Setting it to null
        // causes all subsequent API calls to fail ("No running sidecar for tab") because
        // getBaseUrl skips session-centric lookup when sessionId is null, and the tab-based
        // fallback also fails. The history dropdown naturally shows no selection when the
        // old session is deleted from the list, so no UI impact.
        // The session ID will be upgraded to the new value when chat:system-init arrives.

        // Reset tab title so SortableTabItem falls back to folder name
        onTitleChangeRef.current?.('New Chat');

        // 2. Tell backend to reset (this will also broadcast chat:init)
        try {
            const response = await postJson<{ success: boolean; error?: string }>('/chat/reset');
            if (!response.success) {
                console.error(`[TabProvider ${tabId}] resetSession failed:`, response.error);
                return false;
            }
            console.log(`[TabProvider ${tabId}] resetSession complete`);

            // PRD 0.2.19 cross-review fix (B1): defer session_new tracking to
            // chat:system-init. Tracking here used to pass `currentSessionIdRef.current`
            // (intentionally still the OLD session id — see L574-580) as the new
            // session's `session_id`, polluting analytics joins. Now we instead set
            // a pending surface so the chat:system-init handler — which has the
            // newly-minted id — tracks session_new with the right id.
            //
            // `isNewSessionRef.current` is already true (set above), which the
            // organic-mint detector in chat:system-init uses to know that the
            // upcoming id-change is an intentional reset (vs spurious sync).
            setPendingSurface(tabId, 'new_chat_button');

            return true;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] resetSession error:`, error);
            return false;
        }
    }, [tabId, postJson, setStreamingMessage, clearInteractiveState, clearSessionActive, resetPaginationState]);

    /**
     * Local-only session swap for the IM-handover "新对话保留绑定" flow.
     *
     * The Rust handover (`cmd_session_new_with_surface_migration`) has already
     * minted `newSessionId` on the running sidecar via `/api/im/session/new`
     * AND rotated `peer_sessions[*].session_id` to it. Calling resetSession()
     * here would post `/chat/reset` and mint a SECOND id — leaving the binding
     * pointing at the migrate-minted id while the tab adopts the second mint
     * (the v0.2.14 "tag disappears after 新对话" bug).
     *
     * This helper does the local UI clear (mirrors resetSession step 1) and
     * notifies the parent to update Tab.sessionId. The session-aware SSE
     * useEffect picks up the new id and reconnects; no backend call is made.
     */
    const adoptMigratedSession = useCallback((newSessionId: string) => {
        console.log(`[TabProvider ${tabId}] adoptMigratedSession: ${currentSessionIdRef.current?.slice(0, 8) ?? 'none'} → ${newSessionId.slice(0, 8)}`);

        // Suppress the chat:init that the migrate already broadcast on the
        // sidecar — we're treating the new session as "freshly created here"
        // even though it came from Rust, to keep the same race-free guard
        // resetSession uses.
        isNewSessionRef.current = true;
        resetBirthPendingRef.current = false;
        resetBirthSessionIdRef.current = newSessionId;

        // Mirror resetSession's local clear (kept in lockstep to avoid drift).
        setHistoryMessages([]);
        resetPaginationState();
        setStreamingMessage(null);
        seenIdsRef.current.clear();
        clearSessionActive();
        toolNameMapRef.current.clear();
        pendingToolResultDeltasRef.current.clear();
        pendingToolInputDeltasRef.current.clear();
        pendingSubagentToolResultDeltasRef.current.clear();
        pendingSubagentToolInputDeltasRef.current.clear();
        // Reveal state is per-tab; a session swap/reset must not let a stale reveal loop or
        // un-revealed pending text bleed into the next session. (Loop-stop is inlined rather
        // than calling stopRevealLoop — these reset callbacks are declared before it, so
        // referencing it in their dep arrays would be a TDZ error. Refs are safe in the body.
        // Staleness of any already-enqueued commit is handled by the message-id guard.)
        pendingTextRef.current = '';
        if (revealRafRef.current != null) { cancelAnimationFrame(revealRafRef.current); revealRafRef.current = null; }
        revealAccRef.current = 0;
        revealLastRef.current = 0;
        adoptedStreamRef.current = false;
        setIsLoading(false);
        setSessionState('idle');
        setSystemStatus(null);
        setAgentError(null);
        setLastTerminalReason(null);
        setUnifiedLogs([]);
        setLogs([]);
        setSessionMeta(null);
        clearInteractiveState();
        autoTitleAttemptedRef.current = false;
        titleRoundsRef.current = [];
        pendingUserMessagesRef.current = [];
        lastCompletedTextRef.current = '';
        lastProviderEnvRef.current = undefined;
        lastModelRef.current = undefined;

        // Reset tab title so SortableTabItem falls back to folder name.
        onTitleChangeRef.current?.('New Chat');

        // Adopt the migrate-minted id locally + push it up so App.tsx's
        // Tab.sessionId reflects the swap. The session-aware SSE useEffect
        // will detect the prop change on next render and reconnect.
        currentSessionIdRef.current = newSessionId;
        setCurrentSessionId(newSessionId);
        onSessionIdChangeRef.current?.(newSessionId);
    }, [tabId, setStreamingMessage, clearInteractiveState, clearSessionActive, resetPaginationState]);

    // Append log
    const appendLog = useCallback((line: string) => {
        setLogs(prev => {
            const next = [...prev, line];
            if (next.length > 2000) {
                return next.slice(-2000);
            }
            return next;
        });
    }, []);

    // Append unified log entry (from SSE chat:log events) - keep max 3000
    const appendUnifiedLog = useCallback((entry: LogEntry) => {
        setUnifiedLogs(prev => {
            const next = [...prev, entry];
            if (next.length > 3000) {
                return next.slice(-3000);
            }
            return next;
        });
    }, []);

    // Clear all unified logs
    const clearUnifiedLogs = useCallback(() => {
        setUnifiedLogs([]);
        setLogs([]);
    }, []);

    // Pattern 6: subscribe to the global FrontendLogStore with a tab-id
    // filter. Replaces the legacy "every TabProvider keeps its own copy of
    // every React log" model — entries with no tabId pass through (global)
    // and entries stamped for THIS tab are surfaced to its UI panel.
    useEffect(() => {
        const unsubscribe = subscribeFrontendLogs((entry) => {
            appendUnifiedLog(entry);
        }, tabId);
        return () => { unsubscribe(); };
    }, [appendUnifiedLog, tabId]);

    // Pattern 6 (FIXED): focus-aware tab registry. The previous "last mounted
    // wins" model mis-tagged logs and `X-MyAgents-Tab-Id` headers in multi-tab
    // sessions. Now each TabProvider mounts its tabId into the registry on
    // mount and removes it on unmount; document-visibility transitions move
    // the "focused" pointer so the active tab claims correlation.
    useEffect(() => {
        setCurrentTabId(tabId, true);
        setActiveCorrelation({ tabId, mounted: true });

        const handleVisibility = (): void => {
            if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
                // The browser/Tauri webview only has one "visible" state per
                // window; the active tab is whichever TabProvider is currently
                // mounted with focus. Promote ourselves on each visibility-on.
                import('@/utils/frontendLogger').then(({ setFocusedTabId }) => {
                    setFocusedTabId(tabId);
                }).catch(() => { /* ignore */ });
                import('@/api/tauriClient').then(({ setFocusedCorrelationTabId }) => {
                    setFocusedCorrelationTabId(tabId);
                }).catch(() => { /* ignore */ });
            }
        };
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', handleVisibility);
            // Run once at mount to claim focus if we're the visible tab.
            handleVisibility();
        }

        return () => {
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', handleVisibility);
            }
            // Pattern 6 fix: unmount cleanly. Without this, a closed tab's id
            // would linger in the registry and could be picked as "fallback"
            // for global logs, mis-tagging them with a dead tab.
            setCurrentTabId(tabId, false);
            setActiveCorrelation({ tabId, mounted: false });
        };
    }, [tabId]);

    // Listen for Rust logs via Tauri events (unified with React/Node logs)
    // Note: Rust logs are only displayed in UI, NOT persisted via frontend API
    // This avoids a log loop: Rust log → API call → Rust proxy logs the call → new Rust log → ...
    useEffect(() => {
        if (!isTauri()) return;
        const ac = new AbortController();
        void listenWithCleanup<LogEntry>('log:rust', (event) => {
            // Add to unified logs for UI display only
            // Do NOT call queueLogsForPersistence - that would cause infinite loop
            appendUnifiedLog(event.payload);
        }, ac.signal);
        return () => ac.abort();
    }, [appendUnifiedLog]);

    // ─── RAF batching for streaming chunks ───
    // Accumulates text chunks and flushes once per animation frame (~16ms),
    // reducing 50 render/s to ~16 render/s during streaming.
    // ── Data-layer typewriter (cross-bugfix: streaming-phantom-thinking-rows) ──
    // Reveal of received text into `streamingMessage` is paced HERE, on the data clock,
    // so ONE clock drives render + autoscroll + Virtuoso measurement together. (The prior
    // view-layer typewriter inside Markdown ran on its own rAF decoupled from scroll &
    // measurement → auto-scroll stopped following, follow got disabled, and a [full]-keyed
    // effect cancelled its own rAF → slow→freeze→burst. See specs/issues/.)
    //
    // pendingTextRef = received-but-not-yet-revealed text; a single persistent rAF reveals
    // a rate-matched prefix (cps = backlog / TAU) into streamingMessage. Every async append is
    // guarded by the TARGET MESSAGE ID (see commitText): a stale rAF from a previous turn/session
    // must never write into a newer message, and — unlike a generation counter bumped
    // synchronously by a same-batch handler — an id guard can't discard a prefix that was
    // already cut from the buffer (the id stays valid until the finalize updater runs last).
    const pendingTextRef = useRef<string>('');
    const revealAccRef = useRef(0);            // fractional char accumulator (sub-char pacing)
    const revealLastRef = useRef(0);           // last commit timestamp (continuous across flushes)
    const revealRafRef = useRef<number | null>(null);
    const adoptedStreamRef = useRef(false);    // loadSession mid-turn adopt → reveal instantly (no pacing)

    // ─── Pattern 3 §3.2.2 — RAF batching for tool-result deltas + tool-input deltas ───
    // Per-tool-id buffer. Each tool-result-delta event was previously its own
    // setStreamingMessage(...) update + string concat — that's O(deltas × n)
    // when the SDK emits a 5 MB result in 50 KB chunks. Now we accumulate
    // fragments per tool id and flush once per RAF (~16 ms).
    //
    // Subagent variants are keyed `<parentToolUseId>:<toolUseId>` to avoid
    // colliding with same-id local-tool deltas in nested Task calls.
    interface PendingDeltaBuffer {
        fragments: string[];
        flushScheduled: boolean;
    }
    const pendingToolResultDeltasRef = useRef<Map<string, PendingDeltaBuffer>>(new Map());
    const pendingToolInputDeltasRef = useRef<Map<string, PendingDeltaBuffer>>(new Map());
    const pendingSubagentToolResultDeltasRef = useRef<Map<string, PendingDeltaBuffer>>(new Map());
    const pendingSubagentToolInputDeltasRef = useRef<Map<string, PendingDeltaBuffer>>(new Map());

    // Append `text` to the streaming message's trailing text block. Reuses the exact merge
    // semantics the old flushPendingChunks had (string vs blocks, closeOpenThinkingBlocks,
    // merge-into-last-text-block, else open a new text block after a tool/thinking block).
    //
    // Staleness is guarded by TARGET MESSAGE ID, not a generation counter:
    //   - expectedId === null → synchronous-intent DRAIN (flushPendingTextNow): append to
    //                           whatever the current streaming message is (prev at run time).
    //   - expectedId === <id> → async reveal-loop tick captured for a specific message: no-ops
    //                           if `prev` is a different/cleared message (turn/session switched).
    // Why id over a generation ref: the reveal tick removes a prefix from pendingTextRef
    // synchronously, then enqueues this commit. A generation counter bumped synchronously by a
    // later same-batch handler (finalize/midTurnBreak) would make this commit no-op AFTER the
    // prefix was already cut → lost text. The message id stays stable until the finalize updater
    // (which is enqueued LAST) moves it to history, so this commit always lands first; a genuine
    // switch replaces the id, so it correctly no-ops without losing in-stream text.
    // Keep the v0.2.14 invariant: do NOT gate on isStreamingRef (idle can race ahead of
    // message-complete and clear it while text is still pending → would silently drop it).
    const commitText = useCallback((text: string, expectedId: string | null) => {
        if (!text) return;
        setStreamingMessage(prev => {
            if (!prev || prev.role !== 'assistant') return prev;
            if (expectedId !== null && prev.id !== expectedId) return prev;
            if (typeof prev.content === 'string') {
                return { ...prev, content: prev.content + text };
            }
            const contentArray = closeOpenThinkingBlocks(prev.content);
            const lastBlock = contentArray[contentArray.length - 1];
            if (lastBlock?.type === 'text') {
                return { ...prev, content: [...contentArray.slice(0, -1), { type: 'text', text: (lastBlock.text || '') + text }] };
            }
            return { ...prev, content: [...contentArray, { type: 'text', text }] };
        });
    }, [setStreamingMessage]);

    const stopRevealLoop = useCallback(() => {
        if (revealRafRef.current != null) {
            cancelAnimationFrame(revealRafRef.current);
            revealRafRef.current = null;
        }
        revealAccRef.current = 0;
        revealLastRef.current = 0;
    }, []);

    // Persistent rAF that reveals pendingTextRef into streamingMessage at a rate that
    // self-matches the model's output rate (steady-state backlog ≈ TAU × arrival rate), so
    // the chunky SSE/40ms-coalesced cadence becomes a smooth per-character glide. Commits at
    // ~30fps to bound markdown re-parse cost. Stops when caught up; the next chunk restarts it.
    const startRevealLoop = useCallback(() => {
        if (revealRafRef.current != null) return; // already running
        const loopMsgId = streamingMessageRef.current?.id;
        if (!loopMsgId) return; // no streaming message to reveal into yet
        const TAU = 0.32;       // steady-state trailing latency / cushion (s); larger = lazier
        const MIN_CPS = 8;      // chars/s floor — only bites at a burst's tail
        const COMMIT_MS = 33;   // ~30fps commit throttle
        revealLastRef.current = performance.now();
        const tick = (now: number) => {
            // Stop if the streaming message we were revealing into is gone/replaced
            // (finalized to history, session switch, midTurnBreak split).
            if (streamingMessageRef.current?.id !== loopMsgId) { revealRafRef.current = null; return; }
            const buf = pendingTextRef.current;
            if (buf.length === 0) { revealRafRef.current = null; revealAccRef.current = 0; revealLastRef.current = 0; return; }
            const last = revealLastRef.current || now;
            const elapsed = now - last;
            if (elapsed < COMMIT_MS) { revealRafRef.current = requestAnimationFrame(tick); return; }
            revealLastRef.current = now;
            const dt = Math.min(elapsed / 1000, 0.05); // clamp against tab-throttle / hitches
            const cps = Math.max(buf.length / TAU, MIN_CPS);
            revealAccRef.current += cps * dt;
            let n = Math.floor(revealAccRef.current);
            if (n > 0) {
                if (n > buf.length) n = buf.length;
                // Never cut inside a UTF-16 surrogate pair → no lone-surrogate '�' flash.
                if (n < buf.length) {
                    const code = buf.charCodeAt(n - 1);
                    if (code >= 0xd800 && code <= 0xdbff) n -= 1;
                }
                if (n > 0) {
                    revealAccRef.current -= n;
                    pendingTextRef.current = buf.slice(n);
                    commitText(buf.slice(0, n), loopMsgId);
                }
            }
            revealRafRef.current = requestAnimationFrame(tick);
        };
        revealRafRef.current = requestAnimationFrame(tick);
    }, [commitText]);

    /**
     * Reveal ALL un-revealed text immediately (no pacing) and stop the loop. Called:
     *  - before a new content block (thinking / tool) so text lands before the block
     *    (the [text-head][tool][text-tail] split the old flushPendingChunksNow prevented);
     *  - at finalize / midTurnBreak split so history captures the full text;
     *  - for adopted (loadSession mid-turn) streams, which bypass pacing entirely.
     * gen=null so a generation bump enqueued immediately after does not discard the drain.
     */
    const flushPendingTextNow = useCallback(() => {
        stopRevealLoop();
        const all = pendingTextRef.current;
        pendingTextRef.current = '';
        if (all) commitText(all, null);
    }, [stopRevealLoop, commitText]);

    // ── Pattern 3 §3.2.2 — flush helpers for tool-result / tool-input deltas ──
    // Truncate the displayed inline tool result to 8 KB so an O(n²) re-render
    // does not occur when the SDK emits multi-MB results. Pattern 2's
    // `maybeSpill` already runs on the sidecar before the SSE event leaves
    // the process; the renderer-side cap is a defence-in-depth bound on the
    // *displayed* text length, not on persisted data. Constants live at
    // module scope so the useCallback deps stay clean.

    const flushPendingToolResultDelta = useCallback((toolUseId: string) => {
        const buf = pendingToolResultDeltasRef.current.get(toolUseId);
        if (!buf) return;
        buf.flushScheduled = false;
        if (buf.fragments.length === 0) return;
        const merged = buf.fragments.join('');
        buf.fragments = [];
        setStreamingMessage(prev => {
            if (!prev || prev.role !== 'assistant' || typeof prev.content === 'string') return prev;
            const idx = prev.content.findIndex(b => isToolBlock(b) && b.tool?.id === toolUseId);
            if (idx === -1) return prev;
            const block = prev.content[idx];
            if (!isToolBlock(block) || !block.tool) return prev;
            const existing = block.tool.result || '';
            let nextResult = existing + merged;
            if (nextResult.length > TOOL_RESULT_DISPLAY_CAP) {
                // Keep head + tail; middle is dropped from the *displayed* state.
                const head = nextResult.slice(0, TOOL_RESULT_DISPLAY_CAP - TOOL_RESULT_TAIL_KEEP);
                const tail = nextResult.slice(-TOOL_RESULT_TAIL_KEEP);
                nextResult = `${head}\n…[truncated for display; full result available on completion]…\n${tail}`;
            }
            const updated = [...prev.content];
            updated[idx] = {
                ...block,
                tool: { ...block.tool, result: nextResult, isLoading: true },
            };
            return { ...prev, content: updated };
        });
    }, [setStreamingMessage]);

    const flushPendingToolInputDelta = useCallback((toolUseId: string) => {
        const buf = pendingToolInputDeltasRef.current.get(toolUseId);
        if (!buf) return;
        buf.flushScheduled = false;
        if (buf.fragments.length === 0) return;
        const merged = buf.fragments.join('');
        buf.fragments = [];
        setStreamingMessage(prev => {
            if (!prev || prev.role !== 'assistant' || typeof prev.content === 'string') return prev;
            const contentArray = prev.content;
            const idx = contentArray.findIndex(b => b.type === 'tool_use' && b.tool?.id === toolUseId);
            if (idx === -1) return prev;
            const block = contentArray[idx];
            if (block.type !== 'tool_use' || !block.tool) return prev;
            const newInputJson = (block.tool.inputJson || '') + merged;
            // Pattern 3 §3.2.2 — only re-parse on flush, not on every delta.
            const parsedInput = parsePartialJson<ToolInput>(newInputJson);
            const updated = [...contentArray];
            updated[idx] = {
                ...block,
                tool: { ...block.tool, inputJson: newInputJson, parsedInput: parsedInput || block.tool.parsedInput }
            };
            return { ...prev, content: updated };
        });
    }, [setStreamingMessage]);

    const flushPendingSubagentToolResultDelta = useCallback((bufKey: string, parentToolUseId: string, toolUseId: string) => {
        const buf = pendingSubagentToolResultDeltasRef.current.get(bufKey);
        if (!buf) return;
        buf.flushScheduled = false;
        if (buf.fragments.length === 0) return;
        const merged = buf.fragments.join('');
        buf.fragments = [];
        setStreamingMessage(prev => {
            if (!prev) return prev;
            return applySubagentCallsUpdate(prev, parentToolUseId, (calls) => {
                const updatedCalls = calls.map(call => {
                    if (call.id !== toolUseId) return call;
                    const existing = call.result || '';
                    let nextResult = existing + merged;
                    if (nextResult.length > TOOL_RESULT_DISPLAY_CAP) {
                        const head = nextResult.slice(0, TOOL_RESULT_DISPLAY_CAP - TOOL_RESULT_TAIL_KEEP);
                        const tail = nextResult.slice(-TOOL_RESULT_TAIL_KEEP);
                        nextResult = `${head}\n…[truncated for display; full result available on completion]…\n${tail}`;
                    }
                    return { ...call, result: nextResult, isLoading: true };
                });
                return { calls: updatedCalls };
            }) ?? prev;
        });
    }, [setStreamingMessage]);

    const flushPendingSubagentToolInputDelta = useCallback((bufKey: string, parentToolUseId: string, toolUseId: string) => {
        const buf = pendingSubagentToolInputDeltasRef.current.get(bufKey);
        if (!buf) return;
        buf.flushScheduled = false;
        if (buf.fragments.length === 0) return;
        const merged = buf.fragments.join('');
        buf.fragments = [];
        setStreamingMessage(prev => {
            if (!prev) return prev;
            return applySubagentCallsUpdate(prev, parentToolUseId, (calls) => {
                const updatedCalls = calls.map(call => {
                    if (call.id !== toolUseId) return call;
                    const nextInputJson = (call.inputJson || '') + merged;
                    const parsedInput = parsePartialJson<ToolInput>(nextInputJson);
                    return { ...call, inputJson: nextInputJson, parsedInput: parsedInput || call.parsedInput };
                });
                return { calls: updatedCalls };
            }) ?? prev;
        });
    }, [setStreamingMessage]);

    /** Drain all pending tool delta buffers immediately. Used at message-complete. */
    const flushAllPendingToolDeltas = useCallback(() => {
        for (const id of Array.from(pendingToolResultDeltasRef.current.keys())) {
            flushPendingToolResultDelta(id);
        }
        for (const id of Array.from(pendingToolInputDeltasRef.current.keys())) {
            flushPendingToolInputDelta(id);
        }
        for (const key of Array.from(pendingSubagentToolResultDeltasRef.current.keys())) {
            const [parent, tool] = key.split('::');
            if (parent && tool) flushPendingSubagentToolResultDelta(key, parent, tool);
        }
        for (const key of Array.from(pendingSubagentToolInputDeltasRef.current.keys())) {
            const [parent, tool] = key.split('::');
            if (parent && tool) flushPendingSubagentToolInputDelta(key, parent, tool);
        }
    }, [flushPendingToolResultDelta, flushPendingToolInputDelta, flushPendingSubagentToolResultDelta, flushPendingSubagentToolInputDelta]);

    // Cleanup reveal RAF on unmount
    useEffect(() => {
        return () => { if (revealRafRef.current != null) cancelAnimationFrame(revealRafRef.current); };
    }, []);

    /**
     * Move the current streaming message into history, marking incomplete blocks as finished.
     * Replaces the old markIncompleteBlocksAsFinished — does everything in one atomic step.
     */
    const moveStreamingToHistory = useCallback((status: 'completed' | 'stopped' | 'failed') => {
        // Stop the reveal loop + drain ALL un-revealed text into the streaming message before
        // finalizing — history must capture the full text. flushPendingTextNow drains with
        // expectedId=null (append to current message), and the finalize updater below is
        // enqueued AFTER the drain updater, so it sees the complete message. The reveal loop
        // self-stops next tick (its captured message id no longer matches the live one).
        flushPendingTextNow();
        adoptedStreamRef.current = false;
        // Pattern 3 §3.2.2 — also drain tool delta buffers so accumulated
        // fragments land on the streaming message before it is moved into
        // history. Buffers themselves are cleared once the next session/turn
        // begins (initSession path).
        flushAllPendingToolDeltas();

        // CRITICAL: Use rawSetStreamingMessage updater to read the LATEST streaming message.
        // Reading streamingMessageRef.current directly would race with pending setStreamingMessage
        // updates (React 18 batching delays updater execution), causing the last few text chunks
        // to be lost when chat:message-chunk and chat:message-complete arrive in the same batch.
        // The updater's `prev` parameter is guaranteed by React to include all pending updates.
        rawSetStreamingMessage(prev => {
            if (!prev) {
                clearSessionActive();
                streamingMessageRef.current = null;
                return null;
            }

            let finalMsg = prev;
            if (prev.role === 'assistant' && Array.isArray(prev.content)) {
                const statusFlags = status === 'stopped' ? { isStopped: true }
                    : status === 'failed' ? { isFailed: true }
                        : {};
                const hasIncomplete = prev.content.some(b =>
                    (b.type === 'thinking' && !b.isComplete) ||
                    (b.type === 'tool_use' && b.tool?.isLoading)
                );
                if (hasIncomplete) {
                    finalMsg = {
                        ...prev,
                        content: prev.content.map(block => {
                            if (block.type === 'thinking' && !block.isComplete) {
                                return {
                                    ...block,
                                    isComplete: true,
                                    ...statusFlags,
                                    thinkingDurationMs: block.thinkingStartedAt
                                        ? Date.now() - block.thinkingStartedAt
                                        : undefined
                                };
                            }
                            if (block.type === 'tool_use' && block.tool?.isLoading) {
                                return {
                                    ...block,
                                    tool: { ...block.tool, isLoading: false, ...statusFlags }
                                };
                            }
                            return block;
                        }),
                    };
                }
            }

            // Capture completed text for auto-title generation (skip if already attempted)
            if (!autoTitleAttemptedRef.current && status === 'completed' && finalMsg.role === 'assistant' && Array.isArray(finalMsg.content)) {
                const textParts = finalMsg.content
                    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
                    .map(b => b.text)
                    .join('');
                lastCompletedTextRef.current = textParts;
            }

            // Side effect inside updater — technically impure, but safe because:
            // (1) StrictMode is off (no double invocation), (2) same pattern as setMessages (line 243).
            setHistoryMessages(prevHistory => [...prevHistory, finalMsg]);
            // Set isStreamingRef inside the updater so pending message-chunk updaters
            // (which check isStreamingRef.current) still see true and correctly append
            // rather than creating a new message. Must NOT be set before this updater runs.
            clearSessionActive();
            streamingMessageRef.current = null;
            return null;
        });
    }, [flushPendingTextNow, flushAllPendingToolDeltas, clearSessionActive]);

    // Called at the START of every event that can begin a NEW assistant message
    // (message-chunk / thinking-start / tool-use-start / server-tool-use-start) when no
    // stream is active. Ensures a residual streaming message left un-finalized by a lost
    // message-complete is moved to history FIRST (so the new turn never appends into it),
    // and resets reveal state. Without this, a new turn whose first event is thinking/tool
    // (not text) would bleed its first block into the stale message. No-op mid-stream.
    const beginFreshStreamIfNeeded = useCallback(() => {
        if (isStreamingRef.current) return;
        if (streamingMessageRef.current) {
            moveStreamingToHistory('completed'); // drains residual pending + moves to history
        }
        pendingTextRef.current = '';
        if (revealRafRef.current != null) { cancelAnimationFrame(revealRafRef.current); revealRafRef.current = null; }
        revealAccRef.current = 0;
        revealLastRef.current = 0;
        adoptedStreamRef.current = false;
    }, [moveStreamingToHistory]);

    const recoverStreamingUi = useCallback((status: 'stopped' | 'failed') => {
        moveStreamingToHistory(status);
        flushSync(() => {
            clearSessionActive();
            setIsLoading(false);
            setSessionState('idle');
            setSystemStatus(null);
        });
    }, [moveStreamingToHistory, clearSessionActive]);

    // Handle SSE events
    const handleSseEvent = useCallback((eventName: string, data: unknown) => {
        switch (eventName) {
            case 'chat:init': {
                // chat:init is sent on SSE connect/reconnect
                // If user just started a new session, we've already cleared state - skip
                // This prevents race conditions where backend's init arrives after frontend reset
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping chat:init (new session in progress)');
                    break;
                }

                // Clear local state only if:
                //   1. loadSession is not in flight (it would overwrite anyway), AND
                //   2. we don't already have loaded history to protect.
                //
                // Rationale: chat:init is broadcast whenever the backend's session
                // state transitions — on first SSE connect (legitimate clear point),
                // on frontend-initiated resetSession (already cleared by the caller),
                // AND on backend-initiated auto-reset (e.g. stale SDK conversation).
                // The last case used to destroy the user's just-loaded history
                // because the old unconditional clear ran after loadSession had
                // already finished setting isLoadingSessionRef back to false.
                // With the history-length guard, any session the user can see
                // on screen stays on screen; the only scenario that still clears
                // is "first-ever chat:init before any history loaded", which is
                // exactly the case where the clear is correct (no-op on empty).
                if (!isLoadingSessionRef.current && historyMessagesRef.current.length === 0) {
                    seenIdsRef.current.clear();
                    setHistoryMessages([]);
                    resetPaginationState();
                    setStreamingMessage(null);
                    // Reset reveal state at this session/reset boundary too (any enqueued commit
                    // is id-guarded against the now-null message).
                    pendingTextRef.current = '';
                    if (revealRafRef.current != null) { cancelAnimationFrame(revealRafRef.current); revealRafRef.current = null; }
                    revealAccRef.current = 0;
                    revealLastRef.current = 0;
                    adoptedStreamRef.current = false;
                    setAgentError(null);
                    setLastTerminalReason(null);
                    clearInteractiveState();
                }

                // Sync isLoading with backend state on SSE connect/reconnect
                // When backend reports 'idle', unconditionally reset frontend loading state.
                // This catches: (1) message-complete lost during connection issues,
                // (2) Tab joining a sidecar whose query already finished (no streaming ref set).
                const initPayload = data as { sessionState?: SessionState } | null;
                if (initPayload?.sessionState) {
                    setSessionState(initPayload.sessionState);
                    if (initPayload.sessionState === 'idle') {
                        clearSessionActive();
                        setIsLoading(false);
                        setSystemStatus(null);
                    }
                }
                break;
            }

            case 'chat:message-replay': {
                // Skip replay if user started a new session or loadSession is in-flight.
                // During loadSession, SSE replays race with REST and create intermediate
                // render batches (3→46→249) causing visible scroll jumps.
                if (isNewSessionRef.current || isLoadingSessionRef.current) {
                    break;
                }
                const payload = data as { message: { id: string; role: 'user' | 'assistant'; content: string | ContentBlock[]; timestamp: string; sdkUuid?: string; metadata?: Message['metadata'] } } | null;
                if (!payload?.message) break;
                const msg = payload.message;
                if (seenIdsRef.current.has(msg.id)) break;
                seenIdsRef.current.add(msg.id);

                // Merge pending attachments with user messages
                let attachments = undefined;
                if (msg.role === 'user' && pendingAttachmentsRef.current) {
                    attachments = pendingAttachmentsRef.current;
                    pendingAttachmentsRef.current = null; // Clear after use
                }

                // Replayed assistant messages are completed — mark thinking blocks as isComplete
                // so the UI doesn't show a spinner on them.
                let replayContent = msg.content;
                if (msg.role === 'assistant' && Array.isArray(replayContent)) {
                    const needsPatch = replayContent.some(b => b.type === 'thinking' && !b.isComplete);
                    if (needsPatch) {
                        replayContent = replayContent.map(b =>
                            b.type === 'thinking' && !b.isComplete ? { ...b, isComplete: true } : b
                        );
                    }
                }

                setHistoryMessages(prev => [...prev, {
                    ...msg,
                    content: replayContent,
                    timestamp: new Date(msg.timestamp),
                    attachments,
                }]);
                break;
            }

            case 'chat:message-sdk-uuid': {
                // Backend assigns sdkUuid after SDK echoes messages — update React state.
                // SDK may emit multiple UUIDs per turn (thinking → text); always accept the
                // LATEST one so resumeSessionAt / fork use the final assistant message UUID.
                const payload = data as { messageId: string; sdkUuid: string } | null;
                if (payload?.messageId && payload?.sdkUuid) {
                    if (streamingMessageRef.current?.id === payload.messageId) {
                        setStreamingMessage(prev => prev ? { ...prev, sdkUuid: payload.sdkUuid } : prev);
                    } else {
                        setHistoryMessages(prev => {
                            const idx = prev.findIndex(m => m.id === payload.messageId);
                            if (idx < 0) return prev;
                            if (prev[idx].sdkUuid === payload.sdkUuid) return prev; // no-op
                            const updated = [...prev];
                            updated[idx] = { ...updated[idx], sdkUuid: payload.sdkUuid };
                            return updated;
                        });
                    }
                }
                break;
            }

            case 'chat:status': {
                const payload = data as { sessionState: SessionState } | null;
                if (payload?.sessionState) {
                    setSessionState(payload.sessionState);
                    if (payload.sessionState === 'idle') {
                        // When backend reports 'idle', unconditionally reset frontend loading state.
                        clearSessionActive();
                        setIsLoading(false);
                        setSystemStatus(null);
                    } else if (
                        (payload.sessionState === 'running' || payload.sessionState === 'starting')
                        && !isStreamingRef.current
                    ) {
                        // Session is busy (subprocess starting up or actively
                        // processing) but we haven't received any streaming
                        // events yet. This happens when a Tab connects
                        // mid-flight (e.g., IM session in progress) and
                        // receives a replayed chat:status from the SSE
                        // last-value cache, or during the (issue #174)
                        // startup-timeout window where the SDK subprocess is
                        // alive but system_init hasn't arrived. Set isLoading
                        // so the UI shows the loading state instead of action
                        // buttons; the 'starting' branch lets MessageList
                        // render a distinct "AI 启动中" hint.
                        setIsLoading(true);
                    }
                }
                break;
            }

            case 'chat:system-status': {
                // System status from SDK (e.g., 'compacting' for context compression)
                const payload = data as { status: string | null } | null;
                setSystemStatus(payload?.status ?? null);
                break;
            }

            case 'chat:permission-mode-changed': {
                // Backend permission mode changed (e.g., ExitPlanMode restored auto).
                // Dispatch to Chat.tsx so it can sync the UI toggle.
                // Include tabId for cross-tab isolation (SSE is tab-scoped but DOM events are global).
                const payload = data as { permissionMode: string } | null;
                if (payload?.permissionMode) {
                    window.dispatchEvent(new CustomEvent('permission-mode-sync', {
                        detail: { permissionMode: payload.permissionMode, tabId }
                    }));
                }
                break;
            }

            case 'chat:api-retry': {
                // SDK is retrying API call (rate limit or transient error)
                // null payload = retry resolved, streaming resumed — clear status
                const payload = data as { attempt?: number; maxRetries?: number; delayMs?: number } | null;
                if (payload) {
                    const retryKey = `api_retry:${payload.attempt ?? 1}:${payload.maxRetries ?? '?'}`;
                    setSystemStatus(retryKey);
                } else {
                    // Retry resolved — streaming resumed. Clear both the retry indicator
                    // and any error banner from the failed attempt (e.g. api_retry's
                    // informational .error field that was surfaced as agent-error).
                    setSystemStatus(null);
                    setAgentError(null);
                }
                break;
            }

            case 'chat:message-chunk': {
                // Skip stale chunks if user started a new session
                // (old stream may still be sending events before fully disconnecting)
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping message-chunk (new session, stale event)');
                    break;
                }

                const chunk = data as string;

                // If no streaming message exists yet, this is a NEW stream's first chunk.
                if (!isStreamingRef.current) {
                    // Finalize any residual (lost-complete) message + reset reveal state.
                    beginFreshStreamIfNeeded();
                    pendingTextRef.current = chunk;          // reveal this chunk via the loop
                    revealAccRef.current = 0;
                    // Create the (empty) assistant message synchronously so finalize logic always
                    // has a rendered message to move into history even if message-complete lands
                    // in the same React batch (very short responses). The reveal loop fills it.
                    flushSync(() => {
                        setIsLoading(true);
                        setStreamingMessage({
                            id: Date.now().toString(),
                            role: 'assistant',
                            content: '',
                            timestamp: new Date(),
                            streamingTextActive: true, // trailing text is the streaming edge → tail-fade on
                        });
                    });
                    // Set AFTER flushSync: if beginFreshStreamIfNeeded finalized a residual message,
                    // its finalize updater calls clearSessionActive() (→ isStreamingRef=false) and is
                    // flushed synchronously inside the flushSync — setting the flag before would be
                    // clobbered back to false, making the next chunk spawn a second message.
                    isStreamingRef.current = true;
                    adoptedStreamRef.current = false;
                    startRevealLoop();
                    break;
                }

                // Adopted (loadSession mid-turn) streams bypass pacing: reveal instantly so the
                // REST-snapshot / live-SSE boundary race is not amplified by buffered text.
                if (adoptedStreamRef.current) {
                    pendingTextRef.current += chunk;
                    flushPendingTextNow();
                    break;
                }

                // Subsequent chunks of a fresh stream: buffer + pace via the reveal loop
                // (restart it if it stopped after catching up). streamingMessage now grows on
                // the reveal clock → autoscroll + Virtuoso measurement follow the same clock.
                pendingTextRef.current += chunk;
                // Re-arm the tail-fade if a prior text block was closed (text→tool→text):
                // a real model delta just arrived, so the trailing text is streaming again.
                // Only flips on the false→true edge (no churn mid-stream); never set in the
                // reveal loop, so a post-stop drain won't re-activate it.
                setStreamingMessage(prev => (prev && !prev.streamingTextActive ? { ...prev, streamingTextActive: true } : prev));
                startRevealLoop();
                break;
            }

            case 'chat:thinking-start': {
                // Skip stale events if user started a new session
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping thinking-start (new session, stale event)');
                    break;
                }
                // If this thinking block is a new turn's first event, finalize any residual
                // stale message first so the block doesn't bleed into it.
                beginFreshStreamIfNeeded();
                // Drain un-revealed text before opening a new thinking block, otherwise the
                // trailing text of the previous text block lands AFTER the thinking block
                // (see flushPendingTextNow docstring).
                flushPendingTextNow();
                // First event of a new turn: synchronously materialize the assistant message +
                // isStreamingRef so a same-React-batch message-chunk can't see isStreamingRef=false,
                // flushSync-create a competing empty message, and overwrite this block (Codex). The
                // updater below then appends to this (now-assistant) message. Mirrors message-chunk.
                if (!isStreamingRef.current) {
                    flushSync(() => {
                        setIsLoading(true);
                        setStreamingMessage({ id: Date.now().toString(), role: 'assistant', content: [], timestamp: new Date() });
                    });
                    isStreamingRef.current = true;
                }
                const { index } = data as { index: number };
                setStreamingMessage(prev => {
                    const thinkingBlock: ContentBlock = {
                        type: 'thinking',
                        thinking: '',
                        thinkingStreamIndex: index,
                        thinkingStartedAt: Date.now()
                    };
                    if (prev?.role === 'assistant') {
                        // Implicit close FIRST: force-complete any unclosed thinking blocks.
                        // Must run before dedup check — a stale orphaned block with the same
                        // reused index should be closed, not block the new block from being added.
                        const content = closeOpenThinkingBlocks(
                            typeof prev.content === 'string'
                                ? [{ type: 'text' as const, text: prev.content }]
                                : prev.content
                        );
                        // Deduplicate: skip only if an ACTIVE (incomplete) thinking block with this index exists
                        if (content.some(b => b.type === 'thinking' && b.thinkingStreamIndex === index && !b.isComplete)) {
                            return prev;
                        }
                        return { ...prev, content: [...content, thinkingBlock] };
                    }
                    isStreamingRef.current = true;
                    setIsLoading(true);
                    return { id: Date.now().toString(), role: 'assistant', content: [thinkingBlock], timestamp: new Date() };
                });
                break;
            }

            case 'chat:thinking-chunk': {
                const { index, delta } = data as { index: number; delta: string };
                setStreamingMessage(prev => {
                    if (!prev || prev.role !== 'assistant' || typeof prev.content === 'string') return prev;
                    const contentArray = prev.content;
                    const idx = contentArray.findIndex(b => b.type === 'thinking' && b.thinkingStreamIndex === index && !b.isComplete);
                    if (idx === -1) return prev;
                    const block = contentArray[idx];
                    if (block.type !== 'thinking') return prev;
                    const updated = [...contentArray];
                    updated[idx] = { ...block, thinking: (block.thinking || '') + delta };
                    return { ...prev, content: updated };
                });
                break;
            }

            case 'chat:tool-use-start': {
                // Skip stale events if user started a new session
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping tool-use-start (new session, stale event)');
                    break;
                }
                // If this tool block is a new turn's first event, finalize any residual stale
                // message first so the tool card doesn't bleed into it.
                beginFreshStreamIfNeeded();
                // Drain un-revealed text before opening the tool block, otherwise the tool
                // card ends up wedged inside a single SDK text block (see flushPendingTextNow
                // docstring — this is the primary bug the helper fixes).
                flushPendingTextNow();
                // First event of a new turn: synchronously materialize the message + isStreamingRef
                // so a same-React-batch message-chunk can't overwrite this tool block (see thinking-start).
                if (!isStreamingRef.current) {
                    flushSync(() => {
                        setIsLoading(true);
                        setStreamingMessage({ id: Date.now().toString(), role: 'assistant', content: [], timestamp: new Date() });
                    });
                    isStreamingRef.current = true;
                }
                const tool = data as ToolUse;

                // Track tool_use event
                trackTabEvent('tool_use', { tool: tool.name });

                // Synchronously record toolUseId → toolName for file-modifying tool detection.
                // This map is read in chat:tool-result-complete to trigger directory refresh.
                toolNameMapRef.current.set(tool.id, tool.name);

                // For sub-agent container tools (builtin Task/Agent + Codex CollabAgent,
                // PRD 0.2.27), add taskStartTime + initial taskStats so the running stats
                // bar (with the trace toggle + live elapsed timer) renders. Single source
                // of truth: isSubagentContainerTool() (toolBadgeConfig.tsx).
                const isSubagentContainer = isSubagentContainerTool(tool.name);
                const initialInputJson = Object.keys(tool.input ?? {}).length > 0
                    ? JSON.stringify(tool.input, null, 2)
                    : '';
                const initialParsedInput = Object.keys(tool.input ?? {}).length > 0
                    ? tool.input as unknown as ToolInput
                    : undefined;
                const toolSimple: ToolUseSimple = isSubagentContainer
                    ? {
                        ...tool,
                        inputJson: initialInputJson,
                        parsedInput: initialParsedInput,
                        isLoading: true,
                        taskStartTime: Date.now(),
                        taskStats: { toolCount: 0, inputTokens: 0, outputTokens: 0 },
                      }
                    : { ...tool, inputJson: initialInputJson, parsedInput: initialParsedInput, isLoading: true };
                setStreamingMessage(prev => {
                    const toolBlock: ContentBlock = {
                        type: 'tool_use',
                        tool: toolSimple
                    };
                    if (prev?.role === 'assistant') {
                        const content = closeOpenThinkingBlocks(
                            typeof prev.content === 'string'
                                ? [{ type: 'text' as const, text: prev.content }]
                                : prev.content
                        );
                        return { ...prev, content: [...content, toolBlock] };
                    }
                    isStreamingRef.current = true;
                    setIsLoading(true);
                    return { id: Date.now().toString(), role: 'assistant', content: [toolBlock], timestamp: new Date() };
                });
                break;
            }

            case 'chat:server-tool-use-start': {
                // Server-side tool use (e.g., 智谱 GLM-4.7's webReader, analyze_image)
                // These are executed by the API provider, not locally
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping server-tool-use-start (new session, stale event)');
                    break;
                }
                // If this server-tool block is a new turn's first event, finalize any residual
                // stale message first so it doesn't bleed into the previous turn's message.
                beginFreshStreamIfNeeded();
                // Drain un-revealed text before opening the tool block (see flushPendingTextNow docstring).
                flushPendingTextNow();
                // First event of a new turn: synchronously materialize the message + isStreamingRef
                // so a same-React-batch message-chunk can't overwrite this tool block (see thinking-start).
                if (!isStreamingRef.current) {
                    flushSync(() => {
                        setIsLoading(true);
                        setStreamingMessage({ id: Date.now().toString(), role: 'assistant', content: [], timestamp: new Date() });
                    });
                    isStreamingRef.current = true;
                }
                const tool = data as ToolUse;

                // Track tool_use event (server-side tools)
                trackTabEvent('tool_use', { tool: tool.name });

                // Server tools come with complete input, no streaming
                const toolSimple: ToolUseSimple = {
                    ...tool,
                    inputJson: JSON.stringify(tool.input, null, 2),
                    parsedInput: tool.input as unknown as ToolInput,
                    isLoading: true
                };
                setStreamingMessage(prev => {
                    const toolBlock: ContentBlock = {
                        type: 'server_tool_use',
                        tool: toolSimple
                    };
                    if (prev?.role === 'assistant') {
                        const content = closeOpenThinkingBlocks(
                            typeof prev.content === 'string'
                                ? [{ type: 'text' as const, text: prev.content }]
                                : prev.content
                        );
                        return { ...prev, content: [...content, toolBlock] };
                    }
                    isStreamingRef.current = true;
                    setIsLoading(true);
                    return { id: Date.now().toString(), role: 'assistant', content: [toolBlock], timestamp: new Date() };
                });
                break;
            }

            case 'chat:tool-input-delta': {
                // Note: Only handle tool_use, NOT server_tool_use
                // server_tool_use comes with complete input, no streaming delta needed
                // Pattern 3 §3.2.2 — RAF-batched. Don't parsePartialJson on every event;
                // accumulate fragments and parse once per RAF tick.
                const { toolId, delta } = data as { index: number; toolId: string; delta: string };
                let buf = pendingToolInputDeltasRef.current.get(toolId);
                if (!buf) {
                    buf = { fragments: [], flushScheduled: false };
                    pendingToolInputDeltasRef.current.set(toolId, buf);
                }
                buf.fragments.push(delta);
                if (!buf.flushScheduled) {
                    buf.flushScheduled = true;
                    requestAnimationFrame(() => flushPendingToolInputDelta(toolId));
                }
                break;
            }

            case 'chat:content-block-stop': {
                const { index, toolId, type: blockType } = data as { index: number; toolId?: string; type?: string };
                // Pattern 3 §3.2.2 — drain RAF-batched tool-input deltas for this
                // tool block before applying the final JSON.parse on the
                // accumulated inputJson; otherwise the terminal parse races
                // against pending fragments.
                if (toolId && pendingToolInputDeltasRef.current.has(toolId)) {
                    flushPendingToolInputDelta(toolId);
                    pendingToolInputDeltasRef.current.delete(toolId);
                }
                setStreamingMessage(prev => {
                    if (!prev || prev.role !== 'assistant') return prev;
                    // Trailing text closed → it's no longer the streaming edge: clear the
                    // tail-fade flag. Done BEFORE the string-content bail below so pure-text
                    // (string) streaming messages are covered too. The flag is SET on text
                    // deltas (see chat:message-chunk), never in the reveal loop — so a
                    // post-stop reveal drain can't wrongly re-activate the fade.
                    if (blockType === 'text') {
                        return prev.streamingTextActive ? { ...prev, streamingTextActive: false } : prev;
                    }
                    if (typeof prev.content === 'string') return prev;
                    const contentArray = prev.content;

                    // Check thinking block
                    const thinkingIdx = contentArray.findIndex(b =>
                        b.type === 'thinking' && b.thinkingStreamIndex === index && !b.isComplete
                    );
                    if (thinkingIdx !== -1) {
                        const block = contentArray[thinkingIdx];
                        if (block.type === 'thinking') {
                            const updated = [...contentArray];
                            updated[thinkingIdx] = {
                                ...block,
                                isComplete: true,
                                thinkingDurationMs: block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined
                            };
                            return { ...prev, content: updated };
                        }
                    }

                    // Check tool block (both tool_use and server_tool_use)
                    const toolIdx = toolId
                        ? contentArray.findIndex(b => isToolBlock(b) && b.tool?.id === toolId)
                        : contentArray.findIndex(b => isToolBlock(b) && b.tool?.streamIndex === index);
                    if (toolIdx !== -1) {
                        const block = contentArray[toolIdx];
                        if (isToolBlock(block) && block.tool?.inputJson != null) {
                            let parsedInput: ToolInput | undefined;
                            try {
                                parsedInput = JSON.parse(block.tool.inputJson);
                            } catch {
                                parsedInput = parsePartialJson<ToolInput>(block.tool.inputJson) ?? undefined;
                            }
                            const updated = [...contentArray];
                            updated[toolIdx] = { ...block, tool: { ...block.tool, parsedInput } };
                            return { ...prev, content: updated };
                        }
                    }
                    return prev;
                });
                break;
            }

            case 'chat:tool-result-delta': {
                // Pattern 3 §3.2.2 — RAF-batched. Accumulate fragments per tool id
                // and flush once per animation frame instead of one setState per delta.
                const payload = data as { toolUseId: string; delta?: string };
                if (!payload?.toolUseId || !payload.delta) break;
                let buf = pendingToolResultDeltasRef.current.get(payload.toolUseId);
                if (!buf) {
                    buf = { fragments: [], flushScheduled: false };
                    pendingToolResultDeltasRef.current.set(payload.toolUseId, buf);
                }
                buf.fragments.push(payload.delta);
                if (!buf.flushScheduled) {
                    buf.flushScheduled = true;
                    const toolUseId = payload.toolUseId;
                    requestAnimationFrame(() => flushPendingToolResultDelta(toolUseId));
                }
                break;
            }

            case 'chat:tool-attachment-update': {
                // PRD 0.2.15 §4.7.1 — placeholder attachment fulfillment.
                // Replace the matching pendingId entry inside the target tool's attachments array.
                const payload = data as {
                    toolUseId: string;
                    pendingId: string;
                    attachment: import('@/types/chat').ToolAttachment;
                };
                setStreamingMessage(prev => {
                    if (!prev || prev.role !== 'assistant' || typeof prev.content === 'string') return prev;
                    const contentArray = prev.content;
                    const idx = contentArray.findIndex(b => isToolBlock(b) && b.tool?.id === payload.toolUseId);
                    if (idx === -1) return prev;
                    const block = contentArray[idx];
                    if (!isToolBlock(block) || !block.tool?.attachments) return prev;
                    const attIdx = block.tool.attachments.findIndex(a => a.pendingId === payload.pendingId);
                    if (attIdx === -1) return prev;
                    const newAttachments = [...block.tool.attachments];
                    newAttachments[attIdx] = payload.attachment;
                    const updated = [...contentArray];
                    updated[idx] = { ...block, tool: { ...block.tool, attachments: newAttachments } };
                    return { ...prev, content: updated };
                });
                break;
            }

            case 'chat:tool-result-start':
            case 'chat:tool-result-complete': {
                const payload = data as {
                    toolUseId: string;
                    content?: string;
                    isError?: boolean;
                    metadata?: import('@/types/chat').ToolResultMeta;
                    attachments?: import('@/types/chat').ToolAttachment[];
                };

                // Pattern 3 §3.2.2 — drain any pending RAF deltas for this tool
                // before applying the terminal start/complete payload, so the
                // accumulated fragments are not stranded behind the final value.
                if (pendingToolResultDeltasRef.current.has(payload.toolUseId)) {
                    flushPendingToolResultDelta(payload.toolUseId);
                    pendingToolResultDeltasRef.current.delete(payload.toolUseId);
                }

                setStreamingMessage(prev => {
                    if (!prev || prev.role !== 'assistant' || typeof prev.content === 'string') return prev;
                    const contentArray = prev.content;
                    // Find tool block (both tool_use and server_tool_use)
                    const idx = contentArray.findIndex(b => isToolBlock(b) && b.tool?.id === payload.toolUseId);
                    if (idx === -1) return prev;
                    const block = contentArray[idx];
                    if (!isToolBlock(block) || !block.tool) return prev;

                    // PRD 0.2.15 — merge attachments by pendingId so a tool-result-complete
                    // restate doesn't overwrite already-resolved entries. Codex review SM1.
                    const mergedAttachments = mergeAttachmentsByPendingId(
                        block.tool.attachments,
                        payload.attachments,
                    );

                    const updated = [...contentArray];
                    updated[idx] = {
                        ...block,
                        tool: {
                            ...block.tool,
                            result: payload.content ?? block.tool.result,
                            isError: payload.isError,
                            isLoading: eventName !== 'chat:tool-result-complete',
                            resultMeta: payload.metadata ?? block.tool.resultMeta,
                            attachments: mergedAttachments,
                        }
                    };

                    return { ...prev, content: updated };
                });

                // Fast-path: trigger workspace refresh for file-modifying tools.
                // Uses synchronous toolNameMapRef (NOT inside state updater) to avoid
                // React 18 automatic batching timing bug — state updaters run during
                // render, so a local variable set inside an updater would always be
                // false when checked outside.
                if (eventName === 'chat:tool-result-complete') {
                    const toolName = toolNameMapRef.current.get(payload.toolUseId);
                    if (toolName && FILE_MODIFYING_TOOLS.has(toolName)) {
                        console.log(`[TabProvider] File-modifying tool completed: ${toolName}, triggering workspace refresh`);
                        setToolCompleteCount(c => c + 1);
                    }
                    toolNameMapRef.current.delete(payload.toolUseId);
                }
                break;
            }

            case 'chat:message-complete': {
                console.log(`[TabProvider ${tabId}] message-complete received`);
                // Pattern 3 §3.2.2 — drain all pending RAF-batched tool deltas
                // before finalising the message; otherwise stragglers would
                // land on a freshly-cleared streaming slot.
                flushAllPendingToolDeltas();
                flushSync(() => {
                    // NOTE: isStreamingRef.current is set to false inside moveStreamingToHistory's
                    // updater, NOT here. Setting it here would cause pending message-chunk updaters
                    // (queued by React batching) to see false and create a new message instead
                    // of appending, losing the accumulated content.
                    moveStreamingToHistory('completed');
                    // Finalize the message in the same synchronous commit as the loading-state
                    // cleanup so ultra-short one-chunk responses do not disappear between batches.
                    setIsLoading(false);
                    setSessionState('idle');  // Reset session state to idle
                    setSystemStatus(null);  // Clear system status (e.g., 'compacting') when message completes
                    // Do NOT clear agentError here — chat:agent-error is only emitted for terminal,
                    // unrecoverable errors (rate_limit, auth fail, SDK is_error result, timeouts).
                    // Clearing on message-complete would hide the banner in the race where the error
                    // fires ~ms before the turn closes (e.g. five-hour quota hit mid-turn).
                    // Transient recoveries use chat:api-retry, not chat:agent-error.
                    // Banner is cleared on: new send, session load, api-retry resolved, reset.
                });

                // Send system notification if user is not focused on the app
                notifyMessageComplete(tabId);

                // Mark tab as unread if user is viewing a different tab
                if (!isActiveRef.current) {
                    onUnreadChangeRef.current?.(true);
                }

                // Track message_complete event with usage data
                const completePayload = data as {
                    model?: string;
                    input_tokens?: number;
                    output_tokens?: number;
                    cache_read_tokens?: number;
                    cache_creation_tokens?: number;
                    tool_count?: number;
                    duration_ms?: number;
                    terminal_reason?: TerminalReason;
                    assistant_sdk_uuid?: string;
                    assistant_message_id?: string;
                } | null;

                // SDK 0.2.91+: map terminal_reason to UI banner. Only SET when reason is
                // explicitly provided and non-completed — do NOT wipe to null on every
                // complete event. External-runtime `chat:message-complete` (external-session.ts)
                // never carries terminal_reason, so wiping would silently dismiss a
                // still-actionable banner from the previous builtin turn. Banner clearing
                // happens at send / reset / loadSession / chat:init instead (those are the
                // only events that semantically invalidate the prior turn's outcome).
                {
                    const reason = completePayload?.terminal_reason;
                    if (reason && reason !== 'completed') {
                        setLastTerminalReason(reason);
                    }
                }

                // Apply backend's real message ID + sdkUuid to the just-moved history message.
                // Streaming messages use Date.now() IDs that don't match backend's messageSequence IDs.
                // Without this, fork/rewind pass the wrong ID to the backend.
                if (completePayload?.assistant_sdk_uuid || completePayload?.assistant_message_id) {
                    const uuid = completePayload.assistant_sdk_uuid;
                    const realId = completePayload.assistant_message_id;
                    setHistoryMessages(prev => {
                        if (prev.length === 0) return prev;
                        const last = prev[prev.length - 1];
                        if (last.role !== 'assistant') return prev;
                        const needsUuid = uuid && last.sdkUuid !== uuid;
                        const needsId = realId && last.id !== realId;
                        if (!needsUuid && !needsId) return prev;
                        return [...prev.slice(0, -1), {
                            ...last,
                            ...(needsId ? { id: realId } : {}),
                            ...(needsUuid ? { sdkUuid: uuid } : {}),
                        }];
                    });
                }
                // Always track message_complete, use defaults if payload is missing
                trackTabEvent('message_complete', {
                    model: completePayload?.model,
                    input_tokens: completePayload?.input_tokens ?? 0,
                    output_tokens: completePayload?.output_tokens ?? 0,
                    cache_read_tokens: completePayload?.cache_read_tokens ?? 0,
                    cache_creation_tokens: completePayload?.cache_creation_tokens ?? 0,
                    tool_count: completePayload?.tool_count ?? 0,
                    duration_ms: completePayload?.duration_ms ?? 0,
                });

                // Auto-title: collect QA round, fire after 3+ rounds
                // Shift from FIFO queue to correctly pair sends with completions (handles queued sends)
                // #245 gate: SDK / openai-bridge surface upstream 4xx/5xx errors as
                // assistant text + terminate the turn with terminal_reason='aborted_streaming'.
                // Treating those as good rounds let title-gen name sessions after the error
                // string ("API Error: 400 ..."). shouldRecordTurnForTitle accepts only
                // 'completed' + undefined (external runtimes don't emit the field).
                const completedUserText = pendingUserMessagesRef.current.shift();
                const titleEligible = shouldRecordTurnForTitle(completePayload?.terminal_reason);
                if (!autoTitleAttemptedRef.current && currentSessionIdRef.current && completedUserText && titleEligible) {
                    // Record this completed QA round (truncate both sides to 200 chars)
                    titleRoundsRef.current.push({
                        user: completedUserText.slice(0, 200),
                        assistant: lastCompletedTextRef.current.slice(0, 200),
                    });

                    // Trigger AI title generation once we have enough rounds
                    if (titleRoundsRef.current.length >= AUTO_TITLE_MIN_ROUNDS) {
                        autoTitleAttemptedRef.current = true;
                        const sid = currentSessionIdRef.current;
                        const rounds = [...titleRoundsRef.current];
                        const model = completePayload?.model || lastModelRef.current || '';
                        const pEnv = lastProviderEnvRef.current;
                        // Fire-and-forget — guard against session switch during async call
                        generateSessionTitle(postJson, sid, rounds, model, pEnv)
                            .then(r => {
                                if (r?.success && r.title && currentSessionIdRef.current === sid) {
                                    onTitleChangeRef.current?.(r.title);
                                    // Backend already persisted — notify history/task center to refetch
                                    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED));
                                }
                            })
                            .catch(() => {});
                    }
                }

                break;
            }

            case 'chat:message-stopped': {
                console.log(`[TabProvider ${tabId}] message-stopped received`);
                flushSync(() => {
                    // isStreamingRef.current set inside moveStreamingToHistory's updater
                    moveStreamingToHistory('stopped');
                    setIsLoading(false);
                    setSessionState('idle');  // Reset session state to idle
                    setSystemStatus(null);  // Clear system status when user stops response
                });
                // Discard incomplete round from title tracking — stopped response is not a valid QA pair
                pendingUserMessagesRef.current.shift();
                // Clear stop timeout since we received confirmation
                if (stopTimeoutRef.current) {
                    clearTimeout(stopTimeoutRef.current);
                    stopTimeoutRef.current = null;
                }

                // Track message_stop event
                trackTabEvent('message_stop');
                break;
            }

            case 'chat:message-error': {
                console.log(`[TabProvider ${tabId}] message-error received`);
                const errorMessage = typeof data === 'string'
                    ? data
                    : data && typeof data === 'object' && 'message' in data
                        ? String((data as { message?: unknown }).message ?? '')
                        : '';
                flushSync(() => {
                    // isStreamingRef.current set inside moveStreamingToHistory's updater
                    moveStreamingToHistory('failed');
                    if (errorMessage) {
                        setAgentError(errorMessage);
                    }
                    setIsLoading(false);
                    setSessionState('idle');  // Reset session state to idle on error
                    setSystemStatus(null);  // Clear system status on error
                });
                // Discard incomplete round from title tracking — errored response is not a valid QA pair
                pendingUserMessagesRef.current.shift();
                // Clear stop timeout on error too
                if (stopTimeoutRef.current) {
                    clearTimeout(stopTimeoutRef.current);
                    stopTimeoutRef.current = null;
                }

                // Track message_error event (don't include actual error message for privacy)
                trackTabEvent('message_error');
                break;
            }

            case 'chat:system-init': {
                const payload = data as { info: SystemInitInfo; sessionId?: string; prewarm?: boolean; runtime?: string } | null;
                if (payload?.info) {
                    setSystemInitInfo(payload.info);
                    // v0.1.69: backend tags every system-init with the runtime that
                    // actually spawned the process (builtin / claude-code / codex /
                    // gemini). Freezing it here means a session created in this tab
                    // gets its sessionRuntime set on first system-init and is never
                    // affected by later agent.runtime changes — Chat.tsx's
                    // currentRuntime = sessionRuntime ?? agentRuntime then keeps the
                    // bottom-bar display consistent with how messages route.
                    if (payload.runtime) {
                        setSessionRuntime(payload.runtime);
                    }

                    // Mark session as active (prevents loadSession from interrupting) and loading.
                    // Do NOT set isStreamingRef — that must only be set when a streaming message
                    // is actually created (first message-chunk via flushSync). Setting it here
                    // without a streaming message causes chunks to skip the creation path.
                    //
                    // Pre-warm exception: a pre-warmed external runtime emits session_init when
                    // the CLI subprocess finishes handshake — no user turn has started. Flipping
                    // isLoading:true here would strand the UI at "加载智慧模块中..." until the
                    // user actually sends a message. Skip the loading flip for prewarm payloads;
                    // when the user actually sends a message the chat:status 'running' event
                    // (see line 827 branch above) will set isLoading:true, and Case 1/2 paths
                    // re-emit chat:system-init with prewarm cleared.
                    if (!payload.prewarm) {
                        isSessionActiveRef.current = true;
                        setIsLoading(true);
                    }

                    // Auto-sync sessionId when a new session is created (e.g., first message in empty session)
                    // This ensures currentSessionId stays in sync with the actual session
                    // Use our sessionId (for SessionStore matching) not SDK's session_id
                    const newSessionId = payload.sessionId;
                    if (newSessionId && currentSessionIdRef.current !== newSessionId) {
                        if (isNewSessionRef.current || resetBirthPendingRef.current) {
                            resetBirthSessionIdRef.current = newSessionId;
                            resetBirthPendingRef.current = false;
                        }
                        // PRD 0.2.19 cross-review fix (B1, B4): unified session_new tracking
                        // happens here for ALL three paths (after we have the real id):
                        //
                        //   - launcher_input: oldId=null|pending, isNewSessionRef=false
                        //     → fallback surface 'launcher_input', has_initial_message=true
                        //   - agent_card:     oldId=pending,      isNewSessionRef=false
                        //     → pendingSurface set by App.handleLaunchProject = 'agent_card'
                        //   - new_chat_button (reset OR App.handleNewSession bg-completion):
                        //     either isNewSessionRef=true (explicit resetSession) OR oldId=pending
                        //     (handleNewSession created a new sidecar/pending id) →
                        //     pendingSurface set to 'new_chat_button'
                        //
                        // The detector below catches all three. For the rare case where a
                        // non-birth id-sync slips through (none known today), the
                        // pendingSurface registry's consume-once semantics + the
                        // !currentSessionId/!pending guard limit damage.
                        const oldId = currentSessionIdRef.current;
                        const isSessionBirth =
                            isNewSessionRef.current ||
                            oldId === null ||
                            isPendingSessionId(oldId);

                        console.log(`[TabProvider ${tabId}] Auto-syncing sessionId from system_init: ${newSessionId}`);
                        // Update the ref synchronously alongside the state dispatch so that
                        // async handlers (cron sync, loadOlderMessages) running their
                        // post-await session-match guard see the new id immediately, rather
                        // than waiting until the next render commits line 233's assignment.
                        currentSessionIdRef.current = newSessionId;
                        setCurrentSessionId(newSessionId);
                        // Notify parent (App.tsx) to update Tab.sessionId for Session singleton constraint
                        // This ensures history dropdown can detect if this session is already open
                        onSessionIdChangeRef.current?.(newSessionId);

                        if (isSessionBirth) {
                            // Fallback policy:
                            //   - isNewSessionRef.current === true → explicit reset path,
                            //     resetSession should have setPendingSurface('new_chat_button'),
                            //     so fallback to 'new_chat_button' even if pending was lost
                            //   - otherwise → organic mint via launcher input (most common
                            //     case where caller didn't setPendingSurface)
                            const fallback: Surface = isNewSessionRef.current ? 'new_chat_button' : 'launcher_input';
                            const surface = consumePendingSurface(tabId, fallback);
                            const meta = analyticsMetaRef.current;
                            // has_initial_message: 'new_chat_button' creates an empty session
                            // (user must type after); the other surfaces all carry a first
                            // message (either typed in launcher or piggybacked on agent_card).
                            const hasInitialMessage = surface !== 'new_chat_button';
                            // Explicit tab_id — this track call is inside an SSE handler
                            // that may fire on a backgrounded tab; without an explicit value
                            // it would inherit the foreground tab's tab_id from Active Context.
                            // (cross-review fix matching trackTabEvent's behavior.)
                            track('session_new', {
                                session_id: newSessionId,
                                tab_id: tabId,
                                triggered_by: surface,
                                runtime: meta.runtime,
                                has_initial_message: hasInitialMessage,
                                agent_hash: meta.agentHash,
                            });
                        }
                    }
                }
                break;
            }

            case 'chat:logs': {
                const payload = data as { lines: string[] } | null;
                if (payload?.lines) {
                    setLogs(payload.lines);
                }
                break;
            }

            case 'chat:runtime-diagnostics': {
                // Issue #194 — external-runtime self-report (auth/features/MCP/apps/effective env).
                // Replaces the meaningless hardcoded `systemInitInfo.tools: []` as the actual
                // signal users / debuggers should look at. UI components subscribe via context.
                const diag = data as RuntimeDiagnostics | null;
                if (diag && typeof diag === 'object' && 'runtime' in diag) {
                    setRuntimeDiagnostics(diag);
                }
                break;
            }

            case 'chat:log': {
                // Handle both legacy string format and new LogEntry format
                if (typeof data === 'string') {
                    // Legacy format: plain string
                    appendLog(data);
                } else if (data && typeof data === 'object' && 'source' in data && 'message' in data) {
                    // New unified logger format: LogEntry
                    appendUnifiedLog(data as LogEntry);
                }
                break;
            }

            case 'chat:agent-error': {
                const payload = data as { message: string } | null;
                if (payload?.message) {
                    setAgentError(payload.message);
                }
                break;
            }

            // Cron task exit requested by AI via exit_cron_task tool
            case 'cron:task-exit-requested': {
                const payload = data as { taskId: string; reason: string; timestamp: string } | null;
                if (payload?.taskId && payload?.reason) {
                    console.log(`[TabProvider ${tabId}] Cron task exit requested: taskId=${payload.taskId}, reason=${payload.reason}`);
                    // Call the handler if registered by useCronTask
                    if (onCronTaskExitRequestedRef.current) {
                        onCronTaskExitRequestedRef.current(payload.taskId, payload.reason);
                    }
                }
                break;
            }

            // Subagent event handling for nested tool calls (Task tool)
            case 'chat:subagent-tool-use': {
                const payload = data as { parentToolUseId: string; tool: ToolUse; usage?: { input_tokens?: number; output_tokens?: number } };
                setStreamingMessage(prev => {
                    if (!prev) return prev;
                    return applySubagentCallsUpdate(prev, payload.parentToolUseId, (calls, tool) => {
                        const inputJson = JSON.stringify(payload.tool.input ?? {}, null, 2);
                        const existingIdx = calls.findIndex(c => c.id === payload.tool.id);

                        const updatedCalls: SubagentToolCall[] = existingIdx !== -1
                            ? calls.map(c => c.id === payload.tool.id
                                ? { ...c, name: payload.tool.name, input: payload.tool.input ?? {}, inputJson, isLoading: true }
                                : c)
                            : [...calls, { id: payload.tool.id, name: payload.tool.name, input: payload.tool.input ?? {}, inputJson, isLoading: true }];

                        // Update taskStats with new tool count and token usage
                        const prevStats = tool.taskStats || { toolCount: 0, inputTokens: 0, outputTokens: 0 };
                        const newStats: TaskStats = {
                            toolCount: updatedCalls.length,
                            inputTokens: prevStats.inputTokens + (payload.usage?.input_tokens || 0),
                            outputTokens: prevStats.outputTokens + (payload.usage?.output_tokens || 0)
                        };

                        return { calls: updatedCalls, stats: newStats };
                    }) ?? prev;
                });
                break;
            }

            case 'chat:subagent-tool-input-delta': {
                // Pattern 3 §3.2.2 — RAF-batched per (parent, tool) key.
                const payload = data as { parentToolUseId: string; toolId: string; delta: string };
                const bufKey = `${payload.parentToolUseId}::${payload.toolId}`;
                let buf = pendingSubagentToolInputDeltasRef.current.get(bufKey);
                if (!buf) {
                    buf = { fragments: [], flushScheduled: false };
                    pendingSubagentToolInputDeltasRef.current.set(bufKey, buf);
                }
                buf.fragments.push(payload.delta);
                if (!buf.flushScheduled) {
                    buf.flushScheduled = true;
                    const parent = payload.parentToolUseId;
                    const tool = payload.toolId;
                    requestAnimationFrame(() => flushPendingSubagentToolInputDelta(bufKey, parent, tool));
                }
                break;
            }

            case 'chat:subagent-tool-result-start': {
                const payload = data as { parentToolUseId: string; toolUseId: string; content: string; isError: boolean };
                setStreamingMessage(prev => {
                    if (!prev) return prev;
                    return applySubagentCallsUpdate(prev, payload.parentToolUseId, (calls) => {
                        const updatedCalls = calls.map(call =>
                            call.id === payload.toolUseId
                                ? { ...call, result: payload.content, isError: payload.isError, isLoading: true }
                                : call
                        );
                        return { calls: updatedCalls };
                    }) ?? prev;
                });
                break;
            }

            case 'chat:subagent-tool-result-delta': {
                // Pattern 3 §3.2.2 — RAF-batched per (parent, tool) key.
                const payload = data as { parentToolUseId: string; toolUseId: string; delta: string };
                const bufKey = `${payload.parentToolUseId}::${payload.toolUseId}`;
                let buf = pendingSubagentToolResultDeltasRef.current.get(bufKey);
                if (!buf) {
                    buf = { fragments: [], flushScheduled: false };
                    pendingSubagentToolResultDeltasRef.current.set(bufKey, buf);
                }
                buf.fragments.push(payload.delta);
                if (!buf.flushScheduled) {
                    buf.flushScheduled = true;
                    const parent = payload.parentToolUseId;
                    const tool = payload.toolUseId;
                    requestAnimationFrame(() => flushPendingSubagentToolResultDelta(bufKey, parent, tool));
                }
                break;
            }

            case 'chat:subagent-tool-result-complete': {
                const payload = data as { parentToolUseId: string; toolUseId: string; content: string; isError?: boolean };
                // Drain pending RAF deltas before terminal payload.
                const bufKey = `${payload.parentToolUseId}::${payload.toolUseId}`;
                if (pendingSubagentToolResultDeltasRef.current.has(bufKey)) {
                    flushPendingSubagentToolResultDelta(bufKey, payload.parentToolUseId, payload.toolUseId);
                    pendingSubagentToolResultDeltasRef.current.delete(bufKey);
                }
                setStreamingMessage(prev => {
                    if (!prev) return prev;
                    return applySubagentCallsUpdate(prev, payload.parentToolUseId, (calls) => {
                        const updatedCalls = calls.map(call =>
                            call.id === payload.toolUseId
                                ? { ...call, result: payload.content, isError: payload.isError, isLoading: false }
                                : call
                        );
                        return { calls: updatedCalls };
                    }) ?? prev;
                });
                break;
            }

            case 'permission:request': {
                // Agent is requesting permission to use a tool
                const payload = data as { requestId: string; toolName: string; input: string } | null;
                console.log(`[TabProvider] permission:request received:`, payload);
                if (payload?.requestId) {
                    console.log(`[TabProvider] Setting pendingPermission for: ${payload.toolName}`);
                    setPendingPermission({
                        requestId: payload.requestId,
                        toolName: payload.toolName,
                        input: payload.input || '',
                    });
                    // Send system notification if user is not focused on the app
                    notifyPermissionRequest(payload.toolName);
                }
                break;
            }

            case 'ask-user-question:request': {
                // Agent is asking user structured questions
                const payload = data as { requestId: string; questions: AskUserQuestion[]; previewFormat?: 'html' | 'markdown' } | null;
                console.log(`[TabProvider] ask-user-question:request received:`, payload);
                if (payload?.requestId && payload.questions?.length > 0) {
                    console.log(`[TabProvider] Setting pendingAskUserQuestion with ${payload.questions.length} questions`);
                    setPendingAskUserQuestion({
                        requestId: payload.requestId,
                        questions: payload.questions,
                        previewFormat: payload.previewFormat,
                    });
                    // Send system notification if user is not focused on the app
                    notifyAskUserQuestion();
                }
                break;
            }

            case 'exit-plan-mode:request': {
                const payload = data as { requestId: string; plan?: string; allowedPrompts?: ExitPlanModeAllowedPrompt[] } | null;
                if (payload?.requestId) {
                    setPendingExitPlanMode({
                        requestId: payload.requestId,
                        plan: payload.plan,
                        allowedPrompts: payload.allowedPrompts,
                    });
                    notifyPlanModeRequest();
                }
                break;
            }

            case 'enter-plan-mode:request': {
                const payload = data as { requestId: string; autoApproved?: boolean } | null;
                if (payload?.requestId) {
                    // Always auto-approve EnterPlanMode (no user card needed).
                    // For SDK-auto path, backend already proceeded; just update UI state.
                    // For canUseTool path, backend is waiting — notify it to proceed.
                    setPendingEnterPlanMode({ requestId: payload.requestId, autoApproved: true, resolved: 'approved' });
                    if (!payload.autoApproved) {
                        void postJson('/api/enter-plan-mode/respond', { requestId: payload.requestId, approved: true });
                    }
                }
                break;
            }

            // PRD #131 — backend expired the request (timeout / SDK abort).
            // Clear the matching pending state so the modal disappears and the
            // user can't click into a stale card whose backend entry is gone
            // (which would hit "Unknown request" on respond and leave the UI
            // wedged). We match by requestId so a stale event for a
            // long-replaced request never wipes a fresh modal.
            case 'ask-user-question:expired': {
                const payload = data as { requestId: string; reason?: string } | null;
                if (payload?.requestId) {
                    setPendingAskUserQuestion(prev =>
                        prev?.requestId === payload.requestId ? null : prev,
                    );
                }
                break;
            }
            case 'exit-plan-mode:expired': {
                const payload = data as { requestId: string; reason?: string } | null;
                if (payload?.requestId) {
                    setPendingExitPlanMode(prev =>
                        prev?.requestId === payload.requestId ? null : prev,
                    );
                }
                break;
            }
            case 'enter-plan-mode:expired': {
                const payload = data as { requestId: string; reason?: string } | null;
                if (payload?.requestId) {
                    setPendingEnterPlanMode(prev =>
                        prev?.requestId === payload.requestId ? null : prev,
                    );
                }
                break;
            }

            // Background task lifecycle (SDK Task tool)
            case 'chat:task-started': {
                console.log(`[TabProvider ${tabId}] ${eventName}:`, data);
                const startPayload = data as { taskId?: string; toolUseId?: string; description?: string };
                if (startPayload.taskId && startPayload.description) {
                    setBackgroundTaskDescription(startPayload.taskId, startPayload.description);
                }
                // Register the toolUseId↔taskId mapping so TaskTool components
                // (which only know their tool.id = toolUseId) can look up status
                // from task-notification events (which only carry taskId).
                if (startPayload.taskId && startPayload.toolUseId) {
                    registerBackgroundTask(startPayload.taskId, startPayload.toolUseId);
                } else if (startPayload.taskId && !startPayload.toolUseId) {
                    console.warn(`[TabProvider ${tabId}] chat:task-started missing toolUseId for task ${startPayload.taskId} — background task status matching will degrade`);
                }
                break;
            }
            case 'chat:task-notification': {
                console.log(`[TabProvider ${tabId}] ${eventName}:`, data);
                const payload = data as { taskId?: string; toolUseId?: string; status?: string; summary?: string };
                if (payload.taskId && payload.status) {
                    setBackgroundTaskStatus(payload.taskId, payload.status, payload.toolUseId);
                    // Inject a visible notification message into the chat so the user
                    // understands why AI continues responding (prevents "AI talking to itself" UX).
                    // toolUseId 写进 JSON 是给 PRD 0.2.17 Agent Status Panel 用的「持久化完成证据」：
                    // backgroundTaskStatus 模块是 renderer 进程级 Map，Cmd+R / LRU 驱逐后会丢；
                    // 注入到消息历史里能扛住这些场景，让 useAgentStatusState 反查到「这条 BG 任务
                    // 在历史里已经 notified-complete」。
                    const description = getBackgroundTaskDescription(payload.taskId);
                    const notificationData = JSON.stringify({
                        taskId: payload.taskId,
                        toolUseId: payload.toolUseId,
                        status: payload.status,
                        summary: payload.summary ?? '',
                        description: description ?? '',
                    });
                    const notificationMsg: Message = {
                        id: `task-notification-${payload.taskId}`,
                        role: 'user',
                        content: `<task-notification>${notificationData}</task-notification>`,
                        timestamp: new Date(),
                    };
                    // Upsert by id. The sidecar may broadcast a SECOND terminal
                    // event for the same task to ENRICH the summary: the SDK's
                    // task_updated channel often arrives first with an empty
                    // summary, then task_notification delivers the real one
                    // (#227). Replace the row in place so the bubble updates
                    // rather than duplicating under the same id. This also makes
                    // the renderer self-correct if sidecar dedup ever regresses.
                    setHistoryMessages(prev => {
                        const idx = prev.findIndex(m => m.id === notificationMsg.id);
                        if (idx === -1) return [...prev, notificationMsg];
                        const next = [...prev];
                        // Keep the original position + timestamp; only the
                        // enriched content/status changes.
                        next[idx] = { ...notificationMsg, timestamp: prev[idx].timestamp };
                        return next;
                    });
                }
                break;
            }

            // Queue events
            case 'queue:added': {
                // A message was queued — add to frontend queue state for UI rendering.
                // Deduplication: sendMessage's .then() may also add the same queueId,
                // and optimistic entries (opt-*) may already exist from sendMessage.
                // (v0.2.12) `isInFlight` indicates the backend has already yielded
                // this item to the SDK CLI — it is in CLI's commandQueue and the
                // X cancel button must be hidden (see QueuedMessageBubble).
                const payload = data as { queueId: string; messageText: string; isInFlight?: boolean } | null;
                if (payload?.queueId) {
                    console.log(`[TabProvider] queue:added queueId=${payload.queueId} isInFlight=${!!payload.isInFlight}`);
                    setQueuedMessages(prev => {
                        // Exact queueId match — already added by .then(); update isInFlight if it changed.
                        const existingIdx = prev.findIndex(q => q.queueId === payload.queueId);
                        if (existingIdx !== -1) {
                            if (prev[existingIdx].isInFlight === !!payload.isInFlight) return prev;
                            const next = [...prev];
                            next[existingIdx] = { ...prev[existingIdx], isInFlight: !!payload.isInFlight };
                            return next;
                        }
                        // Optimistic entry exists — .then() will reconcile with real queueId
                        if (prev.some(q => q.queueId.startsWith('opt-'))) return prev;
                        return [...prev, {
                            queueId: payload.queueId,
                            text: payload.messageText,
                            timestamp: Date.now(),
                            isInFlight: !!payload.isInFlight,
                        }];
                    });
                }
                break;
            }

            case 'queue:started': {
                // A queued message started executing:
                // 1. Add user message to chat
                // 2. Remove from frontend queue
                // For mid-turn breaks (midTurnBreak=true): split the streaming message at the
                // injection point so the user message appears at the correct chronological position.
                const payload = data as {
                    queueId: string;
                    midTurnBreak?: boolean;
                    userMessage?: {
                        id: string;
                        role: 'user';
                        content: string;
                        timestamp: string;
                        attachments?: Array<{ id: string; name: string; size: number; mimeType: string; relativePath?: string; savedPath?: string; previewUrl?: string; isImage?: boolean }>;
                    };
                } | null;
                if (payload?.queueId) {
                    // Track started IDs to prevent sendMessage .then() from re-adding
                    startedQueueIdsRef.current.add(payload.queueId);
                    console.log(`[TabProvider] queue:started queueId=${payload.queueId} midTurnBreak=${!!payload.midTurnBreak} streaming=${isStreamingRef.current}`);

                    // Build the user message
                    if (payload.userMessage) {
                        const msgId = payload.userMessage.id;
                        if (!seenIdsRef.current.has(msgId)) {
                            seenIdsRef.current.add(msgId);

                            // Merge backend attachments (authoritative path/size) with frontend preview URLs.
                            // Backend savedAttachments have relativePath but no previewUrl;
                            // frontend queuedMessages have the original data URL previews.
                            let attachments = payload.userMessage.attachments;
                            // Look up queued message by real queueId first;
                            // fall back to first opt-* entry when queue:started arrives
                            // before .then() replaces the optimistic ID (known race).
                            const queuedMsg = queuedMessagesRef.current?.find(
                                q => q.queueId === payload.queueId
                            ) ?? queuedMessagesRef.current?.find(
                                q => q.queueId.startsWith('opt-') && q.images?.length
                            );
                            if (attachments?.length && queuedMsg?.images?.length) {
                                // Merge: prefer frontend's local blob/data URL, fall back to
                                // the Tauri custom-protocol URL resolved from relativePath.
                                attachments = attachments.map(att => {
                                    const match = queuedMsg.images!.find(img => img.name === att.name);
                                    const previewUrl = match?.preview ?? resolveAttachmentUrl(att);
                                    return previewUrl ? { ...att, previewUrl } : att;
                                });
                            } else if (attachments?.length) {
                                // Sibling tab / reconnect case: no local upload state,
                                // resolve previews from the persisted attachment paths.
                                attachments = attachments.map(att => {
                                    const previewUrl = resolveAttachmentUrl(att);
                                    return previewUrl ? { ...att, previewUrl } : att;
                                });
                            } else if (!attachments?.length && queuedMsg?.images?.length) {
                                // Fallback: server sent no attachments, use frontend snapshot
                                attachments = queuedMsg.images.map(img => ({
                                    id: img.id,
                                    name: img.name,
                                    size: 0,
                                    mimeType: 'image/png',
                                    previewUrl: img.preview,
                                    isImage: true,
                                }));
                            }

                            const userMsg: Message = {
                                id: msgId,
                                role: 'user' as const,
                                content: payload.userMessage!.content,
                                timestamp: new Date(payload.userMessage!.timestamp),
                                attachments: attachments && attachments.length > 0 ? attachments : undefined,
                            };

                            if (payload.midTurnBreak && isStreamingRef.current) {
                                // Mid-turn break: AI consumed the injected message and started new content.
                                // Split the streaming: snapshot current streaming → history, insert user message.
                                // New streaming events will create a fresh streaming message automatically.
                                //
                                // Drain un-revealed text into the current streaming message FIRST (gen=null,
                                // enqueued before the snapshot updater) so the message moved to history captures
                                // the full text — otherwise the un-revealed tail is lost or bleeds into the next
                                // assistant segment.
                                flushPendingTextNow();
                                rawSetStreamingMessage(prev => {
                                    if (prev) {
                                        setHistoryMessages(prevHistory => [...prevHistory, prev, userMsg]);
                                    } else {
                                        setHistoryMessages(prevHistory => [...prevHistory, userMsg]);
                                    }
                                    streamingMessageRef.current = null;
                                    return null;
                                });
                                // Fresh segment: clear the buffer and, crucially, drop isStreamingRef so the
                                // NEXT streaming event takes the create-fresh-message path (the comment above
                                // promises "a fresh streaming message automatically"). Without this the next
                                // chunk would hit the subsequent-chunk path and commitText would no-op against
                                // prev=null, silently dropping the new segment. Do NOT clearSessionActive — the
                                // session is still running. The reveal loop self-stops (its message id is gone).
                                pendingTextRef.current = '';
                                if (revealRafRef.current != null) { cancelAnimationFrame(revealRafRef.current); revealRafRef.current = null; }
                                revealAccRef.current = 0;
                                revealLastRef.current = 0;
                                isStreamingRef.current = false;
                                adoptedStreamRef.current = false;
                            } else {
                                // Normal turn start: render immediately
                                setHistoryMessages(prev => [...prev, userMsg]);
                            }
                        }
                    }

                    setQueuedMessages(prev => {
                        const filtered = prev.filter(q => q.queueId !== payload.queueId);
                        // If exact match didn't remove anything, try first optimistic entry (FIFO).
                        // This happens when queue:started fires before .then() replaces opt- with real queueId.
                        if (filtered.length === prev.length) {
                            const optIdx = filtered.findIndex(q => q.queueId.startsWith('opt-'));
                            if (optIdx !== -1) {
                                return [...filtered.slice(0, optIdx), ...filtered.slice(optIdx + 1)];
                            }
                        }
                        return filtered;
                    });

                    // Eagerly clean up: if .then() already ran, the ref entry is stale.
                    // If .then() hasn't run yet, it will find & delete the entry itself.
                    // Either way, schedule removal to prevent unbounded growth.
                    setTimeout(() => startedQueueIdsRef.current.delete(payload.queueId), 5000);
                }
                break;
            }

            case 'queue:cancelled': {
                // A queued message was cancelled — remove from frontend queue
                const payload = data as { queueId: string } | null;
                if (payload?.queueId) {
                    console.log(`[TabProvider] queue:cancelled queueId=${payload.queueId}`);
                    setQueuedMessages(prev => prev.filter(q => q.queueId !== payload.queueId));
                }
                break;
            }

            case 'config:changed': {
                // Admin CLI modified config — notify global ConfigProvider to refresh
                console.log('[TabProvider] config:changed via Admin CLI', data);
                window.dispatchEvent(new CustomEvent('myagents:config-changed', { detail: data }));
                break;
            }

            // PRD 0.2.17 — plugin lifecycle. The Settings page's GlobalPluginsPanel
            // listens to the dispatched DOM events; we re-broadcast via window so
            // multiple Tab subscribers (renderer instances of the same panel)
            // converge on the same refresh trigger.
            case 'plugin:install-progress': {
                window.dispatchEvent(new CustomEvent('myagents:plugin-install-progress', { detail: data }));
                break;
            }
            case 'plugins:changed': {
                window.dispatchEvent(new CustomEvent('myagents:plugins-changed', { detail: data }));
                // Plugins live on AppConfig.{plugins, enabledPlugins} —
                // also nudge ConfigProvider to re-read so consumers like
                // SimpleChatInput's plugins submenu and Agent settings
                // pick up the install/toggle without needing a manual
                // refresh. Without this the Chat tool menu shows "no
                // plugins" even after the user just enabled 13 of them.
                window.dispatchEvent(new CustomEvent('myagents:config-changed', { detail: data }));
                break;
            }

            // (Phase E PRD 0.2.7: `workspace:files-changed` SSE handler
            // removed. The Rust workspace_files watcher emits a Tauri event
            // — `workspace:files-changed:<eventKey>` — that DirectoryPanel
            // subscribes to directly.)

            default: {
                // Log unhandled events for debugging
                if (!eventName.startsWith('chat:')) {
                    console.log(`[TabProvider] Unhandled SSE event: ${eventName}`);
                }
            }
        }
    }, [appendLog, appendUnifiedLog, tabId, moveStreamingToHistory, beginFreshStreamIfNeeded, setStreamingMessage, postJson, clearInteractiveState, flushPendingTextNow, startRevealLoop, flushAllPendingToolDeltas, flushPendingToolInputDelta, flushPendingToolResultDelta, flushPendingSubagentToolInputDelta, flushPendingSubagentToolResultDelta, clearSessionActive, resetPaginationState, trackTabEvent]);

    // Recovery guard — prevents concurrent recovery from both SSE failed + session-sidecar:restarted
    const recoveryInFlightRef = useRef(false);
    const recoveryAttemptsRef = useRef(0);
    const MAX_RECOVERY_ATTEMPTS = 3;
    // Stable ref for connectSse (avoids circular dependency: recoverSessionSidecar → connectSse → recoverSessionSidecar)
    const connectSseRef = useRef<() => Promise<void>>(() => Promise.resolve());
    // Connect serializer: each caller's task chains onto the *previous*
    // task, not just whatever was in flight when this call entered. This
    // gives true sequential semantics — `recoverSessionSidecar` racing with
    // the [agentDir, sessionId] effect, plus pending->real id upgrades, can
    // all queue up safely without producing two concurrent SseConnection
    // instances on the same tab. See specs/ARCHITECTURE.md §"通信模式 / SSE
    // 流式事件" — per-Tab single-subscription invariant.
    const connectSseTailRef = useRef<Promise<void> | null>(null);
    // Unmount guard for async recovery
    const isMountedRef = useRef(true);
    useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

    // Warm the workspace file search index on tab open. Cold cache → full
    // build; warm cache → metadata-only walk + diff. Fire-and-forget — the
    // user's search UX doesn't depend on the result, and the Rust side is
    // serialized by an internal mutex so duplicate calls across tabs of the
    // same workspace are safe. Search-mode entry triggers a second refresh
    // (see DirectoryPanel) to catch anything written after tab open.
    useEffect(() => {
        if (!isTauri() || !agentDir) return;
        refreshWorkspaceFileIndex(agentDir).catch(() => {});
    }, [agentDir]);

    // Recover a dead Session Sidecar: re-ensure + reconnect SSE.
    // Called when SSE retries exhaust OR when Rust health monitor restarts the sidecar.
    const recoverSessionSidecar = useCallback(async () => {
        if (recoveryInFlightRef.current) return; // Deduplicate concurrent calls
        const sid = currentSessionIdRef.current;
        if (!sid) return;
        if (sseRef.current?.isConnected() && connectedSseSessionIdRef.current === sid) return; // Already recovered
        if (recoveryAttemptsRef.current >= MAX_RECOVERY_ATTEMPTS) {
            console.error(`[TabProvider ${tabId}] Max recovery attempts (${MAX_RECOVERY_ATTEMPTS}) reached, giving up`);
            return;
        }
        recoveryInFlightRef.current = true;
        recoveryAttemptsRef.current++;
        try {
            console.log(`[TabProvider ${tabId}] Recovering Session Sidecar for ${sid} (attempt ${recoveryAttemptsRef.current}/${MAX_RECOVERY_ATTEMPTS})...`);
            // ensureSessionSidecar includes health check — sidecar is ready when it returns
            await ensureSessionSidecar(sid, agentDir, 'tab', tabId);
            if (!isMountedRef.current) return;
            // Invalidate the per-tab URL cache before reconnecting. The restart
            // may have bound a new port, and direct `getTabServerUrl(tabId)`
            // consumers (Markdown, FileAction, DirectoryPanel) would otherwise
            // hit the stale cached URL forever. SSE / session-keyed HTTP auto
            // pick the new port via `getSessionPort`, but tab-keyed callers
            // need an explicit bust. This keeps the pit-of-success guarantee
            // symmetric across startup AND mid-session recovery.
            resetTabServerUrlCache(tabId);
            // Disconnect old SSE and reconnect with fresh port
            if (sseRef.current) {
                await sseRef.current.disconnect();
                sseRef.current = null;
            }
            connectedSseSessionIdRef.current = null;
            if (!isMountedRef.current) return;
            await connectSseRef.current();
            if (!isMountedRef.current) return;
            console.log(`[TabProvider ${tabId}] Session Sidecar recovered successfully`);
            recoveryAttemptsRef.current = 0; // Reset on success
        } catch (err) {
            console.error(`[TabProvider ${tabId}] Session Sidecar recovery failed:`, err);
        } finally {
            recoveryInFlightRef.current = false;
        }
    }, [tabId, agentDir]);

    // Connect SSE.
    // Uses Session-centric port lookup via currentSessionIdRef.
    //
    // No explicit boot-window retry here — `sse.connect()` internally calls
    // `getTabServerUrl()`, which as of v0.1.69 waits for the Sidecar to
    // become ready (polls `cmd_get_tab_server_url` with backoff up to ~9s)
    // instead of throwing on the first miss. The AI-讨论 pre-seed race
    // (Chat mounts before `ensureSessionSidecar` finishes) is absorbed at
    // the `tauriClient` layer so every consumer — SSE, HTTP, DirectoryPanel,
    // model push — is automatically correct. See `tauriClient.getTabServerUrl`.
    const connectSseImpl = useCallback(async () => {
        const connectingSessionId = currentSessionIdRef.current;
        if (sseRef.current?.isConnected()) {
            if (connectedSseSessionIdRef.current === connectingSessionId) return;
            console.log(`[TabProvider ${tabId}] SSE is connected to ${connectedSseSessionIdRef.current ?? 'none'}, reconnecting for ${connectingSessionId ?? 'none'}`);
            connectedSseSessionIdRef.current = null;
            setIsConnected(false);
            resetTabServerUrlCache(tabId);
            await sseRef.current.disconnect();
            sseRef.current = null;
        } else {
            connectedSseSessionIdRef.current = null;
            setIsConnected(false);
            if (sseRef.current) {
                await sseRef.current.disconnect();
                sseRef.current = null;
            }
        }

        const sse = createSseConnection(tabId, currentSessionIdRef);
        sse.setEventHandler(handleSseEvent);
        sse.setStatusHandler((status) => {
            if (sseRef.current !== sse) return;
            if (status === 'disconnected' || status === 'failed') {
                connectedSseSessionIdRef.current = null;
                setIsConnected(false);
                setIsLoading(false);
            }
            // When SSE retries exhaust (failed), trigger sidecar recovery as fallback.
            // Primary recovery is via session-sidecar:restarted event from Rust health monitor,
            // but this catches cases where the monitor hasn't run yet or missed the death.
            if (status === 'failed') {
                console.warn(`[TabProvider ${tabId}] SSE failed — triggering sidecar recovery`);
                void recoverSessionSidecar();
            }
        });
        sseRef.current = sse;

        try {
            await sse.connect();
            // sse.connect() resolves cleanly even when the connect was
            // cancelled mid-flight via shouldReconnect=false (it returns
            // without flipping tauriConnected). Three things can leave us
            // here without a live connection:
            //   1. A newer connect superseded us → sseRef.current !== sse
            //   2. The provider unmounted in flight → isMountedRef false
            //   3. A racing disconnect cancelled us → sse.isConnected() false
            // In any of these cases, drop the stale instance instead of
            // marking the tab "connected" when no SSE stream actually exists.
            if (sseRef.current !== sse || !isMountedRef.current || !sse.isConnected()) {
                await sse.disconnect();
                return;
            }
            connectedSseSessionIdRef.current = connectingSessionId ?? currentSessionIdRef.current ?? null;
            setIsConnected(true);
            // Note: Log server URL is set once in App.tsx using global sidecar
            // Tab sidecars should not override it to avoid URL switching issues
        } catch (error) {
            if (sseRef.current === sse) {
                sseRef.current = null;
                connectedSseSessionIdRef.current = null;
                setIsConnected(false);
            }
            console.error(`[TabProvider ${tabId}] SSE connect failed:`, error);
            throw error;
        }
    }, [tabId, handleSseEvent, recoverSessionSidecar]);

    // Public connectSse — every caller chains its own task onto the
    // previous task's tail, giving true serial execution. Without chaining,
    // multiple callers awaiting the same in-flight promise would all race
    // past the post-await short-circuit and start concurrent connectSseImpls.
    const connectSse = useCallback(async () => {
        const previous = connectSseTailRef.current;
        const task = (async () => {
            if (previous) {
                try { await previous; } catch { /* ignore — chained task runs regardless */ }
            }
            // After the chain ahead of us has settled, the prior task may
            // have already produced the connection we wanted; skip in that case.
            const sid = currentSessionIdRef.current;
            if (sseRef.current?.isConnected() && connectedSseSessionIdRef.current === sid) return;
            await connectSseImpl();
        })();
        connectSseTailRef.current = task;
        try {
            await task;
        } finally {
            if (connectSseTailRef.current === task) {
                connectSseTailRef.current = null;
            }
        }
    }, [connectSseImpl]);
    connectSseRef.current = connectSse;

    // App.tsx switches Session Sidecars without remounting TabProvider. Keep the
    // event stream attached to the current session, otherwise /chat/send can
    // persist successfully while the visible tab waits on an old/dead SSE stream.
    //
    // Load-bearing invariant: this effect drives SSE connect on initial mount
    // and on session switch — the only OTHER caller is recoverSessionSidecar()
    // (Rust health-monitor restart path), which goes through the same
    // connectSseRef and the same chained serializer. App.tsx assigns a
    // sessionId (real or `pending-...`) on every chat-view transition, so
    // `sessionId` truthy here covers initial mount as well. If a future code
    // path opens a chat tab without setting sessionId, SSE will silently
    // never connect — keep that invariant intact.
    useEffect(() => {
        if (!agentDir || !sessionId) return;

        const connectedSessionId = connectedSseSessionIdRef.current;
        const isConnectedToAnySession = sseRef.current?.isConnected() ?? false;

        if (isConnectedToAnySession && connectedSessionId === sessionId) return;

        // Pending -> real id upgrade during an active turn keeps the same sidecar.
        // Reconnecting here can briefly drop streaming events; just re-label the
        // live stream so the load guard below knows it belongs to the real session.
        if (
            isConnectedToAnySession &&
            connectedSessionId &&
            isPendingSessionId(connectedSessionId) &&
            !isPendingSessionId(sessionId) &&
            (isSessionActiveRef.current || isStreamingRef.current)
        ) {
            connectedSseSessionIdRef.current = sessionId;
            return;
        }

        const generation = ++sseReconnectGenerationRef.current;
        let cancelled = false;

        void (async () => {
            if (isConnectedToAnySession) {
                console.log(`[TabProvider ${tabId}] SessionId changed from ${connectedSessionId ?? 'none'} to ${sessionId}, reconnecting SSE`);
                connectedSseSessionIdRef.current = null;
                setIsConnected(false);
                resetTabServerUrlCache(tabId);
                const oldSse = sseRef.current;
                sseRef.current = null;
                if (oldSse) {
                    await oldSse.disconnect();
                }
            }

            if (cancelled || !isMountedRef.current || sseReconnectGenerationRef.current !== generation) return;
            await connectSseRef.current();
        })().catch((error) => {
            if (!cancelled) {
                console.error(`[TabProvider ${tabId}] SSE reconnect for session ${sessionId} failed:`, error);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [agentDir, sessionId, tabId]);

    // Cleanup on unmount - disconnect SSE and clear pending timers
    // NOTE: Sidecar lifecycle is now managed by App.tsx performCloseTab(),
    // which checks for active cron tasks before stopping.
    // Do NOT call stopTabSidecar here - it would bypass cron task protection.
    useEffect(() => {
        return () => {
            if (sseRef.current) {
                void sseRef.current.disconnect();
                sseRef.current = null;  // Allow garbage collection
            }
            connectedSseSessionIdRef.current = null;
            if (stopTimeoutRef.current) {
                clearTimeout(stopTimeoutRef.current);
                stopTimeoutRef.current = null;
            }
            // Sidecar stop is handled by App.tsx performCloseTab()
            // which properly checks for active cron tasks before stopping
        };
    }, [tabId]);

    // Listen for Rust health monitor restarting our Session Sidecar.
    // Mirrors the Global Sidecar pattern (App.tsx global-sidecar:restarted).
    // When Rust detects a dead Session Sidecar and restarts it on a new port,
    // we need to reconnect SSE to the new port.
    useEffect(() => {
        if (!isTauri()) return;
        const ac = new AbortController();
        void listenWithCleanup<{ sessionId: string; port: number }>('session-sidecar:restarted', (event) => {
            const { sessionId: restartedSid, port } = event.payload;
            if (restartedSid === currentSessionIdRef.current) {
                console.log(`[TabProvider ${tabId}] Session Sidecar restarted on port ${port}, reconnecting SSE`);
                void recoverSessionSidecar();
            }
        }, ac.signal);
        return () => ac.abort();
    }, [tabId, recoverSessionSidecar]);

    // Send message with optional images, permission mode, and model
    // Returns true immediately (optimistic) to clear the input without waiting for HTTP response.
    // The actual API call runs in the background — backend may take time for provider changes,
    // session startup, etc. but the user shouldn't be blocked.
    const sendMessage = useCallback(async (
        text: string,
        images?: ImageAttachment[],
        permissionMode?: PermissionMode,
        model?: string,
        providerEnv?: { baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses'; modelAliases?: { sonnet?: string; opus?: string; haiku?: string } },
        isCron?: boolean
    ): Promise<boolean> => {
        const trimmed = text.trim();
        if (!trimmed && (!images || images.length === 0)) return false;

        // Detect skill/slash command: /command at start of message (for analytics)
        const skillMatch = trimmed.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)/);
        const skill = skillMatch ? skillMatch[1] : null;
        const hasImages = !!(images && images.length > 0);

        // Reset new session flag BEFORE sending - allow message replay to show user's message
        isNewSessionRef.current = false;

        // Clear prior turn's terminal_reason banner — a new user send semantically
        // invalidates the previous turn's outcome. Without this, banner stays visible
        // while the new stream renders (and chat:message-complete no longer wipes it
        // since that caused the external-runtime bug).
        setLastTerminalReason(null);

        // Capture user message for auto-title generation (FIFO queue for queued sends)
        if (!autoTitleAttemptedRef.current) {
            pendingUserMessagesRef.current.push(trimmed);
        }
        lastModelRef.current = model;
        lastProviderEnvRef.current = providerEnv ? { baseUrl: providerEnv.baseUrl, apiKey: providerEnv.apiKey, authType: providerEnv.authType, apiProtocol: providerEnv.apiProtocol, maxOutputTokens: providerEnv.maxOutputTokens, maxOutputTokensParamName: providerEnv.maxOutputTokensParamName, upstreamFormat: providerEnv.upstreamFormat, modelAliases: providerEnv.modelAliases } : undefined;

        // Store attachments for merging with SSE replay
        if (hasImages) {
            pendingAttachmentsRef.current = images.map((img) => ({
                id: img.id,
                name: img.file.name,
                size: img.file.size,
                mimeType: img.file.type,
                previewUrl: img.preview,
                isImage: true,
            }));
        }

        // Prepare image data for backend
        const imageData = images?.map((img) => ({
            name: img.file.name,
            mimeType: img.file.type,
            // Extract base64 data from data URL (remove "data:image/xxx;base64," prefix)
            data: img.preview.split(',')[1],
        }));

        // Optimistic queue: immediately show badge when AI is streaming.
        // We don't know the real queueId yet (backend assigns it), so use a local ID.
        // .then() will reconcile: replace opt- with real queueId, or clean up if already started.
        const localQueueId = isStreamingRef.current ? `opt-${crypto.randomUUID()}` : null;
        if (localQueueId) {
            setQueuedMessages(prev => [...prev, {
                queueId: localQueueId,
                text: trimmed,
                images: images?.map(img => ({ id: img.id, name: img.file.name, preview: img.preview })),
                timestamp: Date.now(),
            }]);
        }

        // Fire-and-forget: send to backend without blocking the UI.
        // The HTTP response may be delayed by provider changes or session startup,
        // but the input should clear immediately for a responsive experience.
        // Desktop is the ONLY caller that should trigger provider switches per-message.
        // When no providerEnv is given (subscription mode), send 'subscription' explicitly
        // so enqueueUserMessage knows this is an intentional switch, not "I don't know".
        // IM/Cron callers omit the field entirely (undefined = "keep current provider").
        postJson<{ success: boolean; error?: string; queued?: boolean; queueId?: string; isInFlight?: boolean }>('/chat/send', {
            text: trimmed,
            images: imageData,
            permissionMode: permissionMode ?? 'auto',
            // #264 — echo the global background-agent permission policy so the
            // builtin PermissionRequest hook applies it to run_in_background sub-agents.
            // Read via ref (not the closure-captured appConfig) so a Settings change
            // takes effect immediately in already-mounted tabs.
            backgroundAgentPermissionMode: appConfigRef.current?.backgroundAgentPermissionMode ?? 'inherit',
            model,
            providerEnv: providerEnv ?? 'subscription',
        }).then((response) => {
            if (response.success) {
                trackTabEvent('message_send', {
                    mode: permissionMode ?? 'auto',
                    model: model ?? 'default',
                    skill,
                    has_image: hasImages,
                    has_file: false,
                    is_cron: isCron ?? false,
                });

                if (response.queued && response.queueId) {
                    const realQueueId = response.queueId;
                    if (startedQueueIdsRef.current.has(realQueueId)) {
                        // Already started (mid-turn injection) — clean up optimistic entry
                        startedQueueIdsRef.current.delete(realQueueId);
                        if (localQueueId) {
                            setQueuedMessages(prev => prev.filter(q => q.queueId !== localQueueId));
                        }
                    } else if (localQueueId) {
                        // Replace optimistic entry with real queueId + isInFlight + enrich with image data
                        setQueuedMessages(prev => prev.map(q =>
                            q.queueId === localQueueId
                                ? {
                                    ...q,
                                    queueId: realQueueId,
                                    isInFlight: !!response.isInFlight,
                                    images: images?.map(img => ({ id: img.id, name: img.file.name, preview: img.preview })),
                                }
                                : q
                        ));
                    } else {
                        // Non-optimistic path (wasn't streaming when sent)
                        setQueuedMessages(prev => {
                            if (prev.some(q => q.queueId === realQueueId)) {
                                // SSE already added it — enrich with image data if available
                                if (!images?.length) return prev;
                                return prev.map(q => q.queueId === realQueueId
                                    ? { ...q, images: images.map(img => ({ id: img.id, name: img.file.name, preview: img.preview })) }
                                    : q
                                );
                            }
                            return [...prev, {
                                queueId: realQueueId,
                                text: trimmed,
                                images: images?.map(img => ({ id: img.id, name: img.file.name, preview: img.preview })),
                                timestamp: Date.now(),
                                isInFlight: !!response.isInFlight,
                            }];
                        });
                    }
                } else if (localQueueId) {
                    // Message wasn't queued (went through immediately) — remove optimistic entry
                    setQueuedMessages(prev => prev.filter(q => q.queueId !== localQueueId));
                }
            } else {
                // Backend rejected: queue full, validation error, etc.
                console.error(`[TabProvider ${tabId}] Send rejected:`, response.error);
                if (localQueueId) {
                    setQueuedMessages(prev => prev.filter(q => q.queueId !== localQueueId));
                }
                setAgentError(response.error ?? '发送失败');
                pendingAttachmentsRef.current = null;
            }
        }).catch((error) => {
            console.error(`[TabProvider ${tabId}] Send message failed:`, error);
            if (localQueueId) {
                setQueuedMessages(prev => prev.filter(q => q.queueId !== localQueueId));
            }
            const msg = error instanceof Error ? error.message : '网络错误';
            setAgentError(msg === 'Failed to fetch' ? '网络连接中断，请重试' : msg);
            pendingAttachmentsRef.current = null;
        });

        // Return true immediately — input clears without waiting for HTTP response
        return true;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [tabId]);

    // Stop response with timeout fallback
    const stopResponse = useCallback(async (): Promise<boolean> => {
        // Clear any existing stop timeout
        if (stopTimeoutRef.current) {
            clearTimeout(stopTimeoutRef.current);
            stopTimeoutRef.current = null;
        }

        // Immediately show "stopping" state for instant user feedback
        setSessionState('stopping');

        try {
            const response = await postJson<{ success: boolean; alreadyStopped?: boolean; error?: string }>('/chat/stop');
            if (response.success) {
                // Nothing was active — restore UI immediately, no need to wait for SSE.
                // Also reset isLoading: the backend may have drained orphaned queued messages
                // (queue:cancelled events will clean up queuedMessages), and the UI was stuck
                // with isLoading=true because no chat:message-complete ever arrived.
                if (response.alreadyStopped) {
                    flushSync(() => {
                        clearSessionActive();
                        setIsLoading(false);
                        setSessionState(prev => prev === 'stopping' ? 'idle' : prev);
                    });
                    return true;
                }
                // 设置 5 秒超时，如果没有收到 SSE 事件确认则强制恢复 UI
                stopTimeoutRef.current = setTimeout(() => {
                    if (isStreamingRef.current) {
                        console.warn(`[TabProvider ${tabId}] Stop timeout - forcing UI recovery`);
                        recoverStreamingUi('stopped');
                    }
                    // Also recover from 'stopping' state if SSE confirmation never arrived
                    setSessionState(prev => prev === 'stopping' ? 'idle' : prev);
                    stopTimeoutRef.current = null;
                }, 5000);
                return true;
            }
            // POST failed (success=false), recover UI
            recoverStreamingUi('stopped');
            return false;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] Stop response failed:`, error);
            // 请求失败也强制恢复 UI
            recoverStreamingUi('failed');
            return false;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [recoverStreamingUi, tabId]);

    // Load session from history
    // Options:
    // - skipLoadingReset: If true, don't reset isLoading to false. Useful when caller
    //   knows an operation is in progress (e.g., cron task execution) and will manage
    //   the loading state separately.
    //
    // Note: This option is currently available for future use cases but not actively used.
    // Chat.tsx manages loading state through pendingCronLoadingRef pattern instead of
    // calling loadSession directly, to avoid duplicate loadSession calls with TabProvider's
    // session loading effect.
    const loadSession = useCallback(async (
        targetSessionId: string,
        options?: { skipLoadingReset?: boolean; previousSessionId?: string | null }
    ): Promise<boolean> => {
        const loadGeneration = ++loadSessionGenerationRef.current;
        const requireTargetSessionRef = options?.previousSessionId !== undefined;
        const isStaleLoad = (phase: string): boolean => {
            const stale = loadSessionGenerationRef.current !== loadGeneration
                || (requireTargetSessionRef && currentSessionIdRef.current !== targetSessionId);
            if (stale) {
                console.log(`[TabProvider ${tabId}] Ignoring stale loadSession(${targetSessionId}) at ${phase}`);
            }
            return stale;
        };
        // Rollback target for the prop-sync ref/state move (line 340-344). Prop
        // sync fires synchronously when tab.sessionId changes, moving
        // `currentSessionIdRef` to target before /sessions/switch is verified.
        // On switch failure, restore so context.sessionId stays consistent with
        // the visible history (which we deliberately don't replace on failure).
        //
        // Scope-of-rollback note: only Provider-internal ref/state is reverted.
        // `tab.sessionId` (App-level) and the Rust-side sidecar swap that
        // App.handleSwitchSession performed before this loadSession ran are NOT
        // unwound. PRD 0.2.6 §5.3 step 5 explicitly accepts this: on rare
        // /sessions/switch failure, surface an error and keep the visible UI
        // stable, but do not implement a four-layer two-phase commit. Users
        // retry; closing/reopening the Tab fully resets state.
        const rollbackSessionId = options?.previousSessionId ?? null;
        const rollbackOnSwitchFailure = () => {
            if (rollbackSessionId && rollbackSessionId !== targetSessionId) {
                currentSessionIdRef.current = rollbackSessionId;
                setCurrentSessionId(rollbackSessionId);
            }
        };
        try {
            console.log(`[TabProvider ${tabId}] Loading session: ${targetSessionId}`);
            isLoadingSessionRef.current = true;
            setIsSessionLoading(true);

            // Check if session is already activated by another Tab or CronTask (Session singleton constraint)
            const activation = await getSessionActivation(targetSessionId);
            if (isStaleLoad('after-activation')) {
                return false;
            }
            if (activation) {
                // Case 1: Session is open in another Tab - jump to that Tab
                if (activation.tab_id && activation.tab_id !== tabId) {
                    console.log(`[TabProvider ${tabId}] Session ${targetSessionId} is already activated by tab ${activation.tab_id}, requesting jump`);
                    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.JUMP_TO_TAB, {
                        detail: { targetTabId: activation.tab_id, sessionId: targetSessionId }
                    }));
                    isLoadingSessionRef.current = false;
                    setIsSessionLoading(false);
                    return false;
                }

                // Case 2: Session is used by a CronTask without Tab - jump to show cron task UI
                // This happens when cron task is running in background (tab was closed)
                if (activation.is_cron_task && !activation.tab_id) {
                    console.log(`[TabProvider ${tabId}] Session ${targetSessionId} is used by background cron task, will connect to it`);
                    // Don't block - let the session load, Chat.tsx will restore cron task UI
                    // The session switch will update the activation's tab_id
                }
            }

            // Load only the last INITIAL_PAGE_SIZE messages. MessageList's
            // startReached handler pulls older history lazily via `?before=<id>`
            // as the user scrolls up. Keeps first-paint JSON body tiny on 600+
            // message sessions.
            const response = await apiGetJson<{ success: boolean; session?: SessionMetadata & { liveSessionState?: SessionState; liveStreamingMessage?: { id: string; role: 'assistant'; content: string; timestamp: string; sdkUuid?: string }; messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: string; sdkUuid?: string; attachments?: Array<{ id: string; name: string; mimeType: string; path: string; previewUrl?: string }>; metadata?: Message['metadata'] }>; totalCount?: number; hasMoreBefore?: boolean } }>(`/sessions/${targetSessionId}?limit=${INITIAL_PAGE_SIZE}`);
            if (isStaleLoad('after-session-fetch')) {
                return false;
            }

            if (!response.success || !response.session) {
                // Session not found is not necessarily an error - it may have been deleted
                // or be a newly created empty session. Log as info, not error.
                console.log(`[TabProvider ${tabId}] Session ${targetSessionId} not found in storage (may be deleted or empty)`);
                isLoadingSessionRef.current = false;
                setIsSessionLoading(false);
                return false;
            }

            // Confirm the sidecar runtime has switched before replacing the
            // visible message history. Otherwise a failed /sessions/switch can
            // leave the UI showing target history while subsequent send/SSE
            // traffic still belongs to the previous session.
            let switchResult: { success: boolean; error?: string };
            try {
                switchResult = await postJson<{ success: boolean; error?: string }>('/sessions/switch', { sessionId: targetSessionId });
            } catch (error) {
                if (isStaleLoad('after-switch-throw')) {
                    return false;
                }
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[TabProvider ${tabId}] Session switch failed for ${targetSessionId}: ${message}`);
                setAgentError(message);
                isLoadingSessionRef.current = false;
                setIsSessionLoading(false);
                rollbackOnSwitchFailure();
                return false;
            }
            if (isStaleLoad('after-switch')) {
                return false;
            }
            if (!switchResult.success) {
                const message = switchResult.error || 'Session switch failed.';
                console.warn(`[TabProvider ${tabId}] Session switch rejected for ${targetSessionId}: ${message}`);
                setAgentError(message);
                isLoadingSessionRef.current = false;
                setIsSessionLoading(false);
                rollbackOnSwitchFailure();
                return false;
            }

            // Convert session messages to Message format
            const loadedMessages: Message[] = response.session.messages.map((msg) => {
                // Parse content - it may be JSON stringified ContentBlock[] or plain text
                let parsedContent: string | ContentBlock[] = msg.content ?? '';

                // Only try to parse if content is a non-empty string starting with '['
                if (typeof msg.content === 'string' && msg.content.length > 0 && msg.content.startsWith('[') && msg.content.includes('"type"')) {
                    try {
                        parsedContent = JSON.parse(msg.content) as ContentBlock[];
                    } catch {
                        // Keep as string if parse fails
                        parsedContent = msg.content;
                    }
                }

                return {
                    id: msg.id,
                    role: msg.role,
                    content: parsedContent,
                    timestamp: new Date(msg.timestamp),
                    sdkUuid: msg.sdkUuid,
                    attachments: msg.attachments?.map((att: { id: string; name: string; mimeType: string; path: string; previewUrl?: string }) => ({
                        id: att.id,
                        name: att.name,
                        size: 0,
                        mimeType: att.mimeType,
                        savedPath: att.path,
                        relativePath: att.path,
                        // Server no longer embeds base64 previews — resolve to
                        // `myagents://` (Tauri) or `/api/attachment/*` (dev).
                        previewUrl: resolveAttachmentUrl({ savedPath: att.path, previewUrl: att.previewUrl }),
                        isImage: att.mimeType.startsWith('image/'),
                    })),
                    metadata: msg.metadata,
                };
            });

            let liveStreamingMessage: Message | null = null;
            const liveMsg = response.session.liveStreamingMessage;
            if (liveMsg?.content) {
                let parsedLiveContent: string | ContentBlock[] = liveMsg.content;
                if (typeof liveMsg.content === 'string' && liveMsg.content.length > 0 && liveMsg.content.startsWith('[') && liveMsg.content.includes('"type"')) {
                    try {
                        parsedLiveContent = JSON.parse(liveMsg.content) as ContentBlock[];
                    } catch {
                        parsedLiveContent = liveMsg.content;
                    }
                }
                liveStreamingMessage = {
                    id: liveMsg.id,
                    role: 'assistant',
                    content: parsedLiveContent,
                    timestamp: new Date(liveMsg.timestamp),
                    sdkUuid: liveMsg.sdkUuid,
                };
            }

            // Reset auto-title state when switching sessions
            // Skip auto-title only if already has an AI-generated or user-renamed title
            autoTitleAttemptedRef.current = response.session.titleSource === 'auto'
                || response.session.titleSource === 'user';
            pendingUserMessagesRef.current = [];
            lastCompletedTextRef.current = '';
            lastProviderEnvRef.current = undefined;
            lastModelRef.current = undefined;

            // Reconstruct completed QA rounds from loaded history so new messages
            // continue the count. A session with 2 loaded rounds + 1 new round = 3 → triggers title.
            if (!autoTitleAttemptedRef.current) {
                const rounds: Array<{ user: string; assistant: string }> = [];
                for (let i = 0; i < loadedMessages.length - 1; i++) {
                    const msg = loadedMessages[i];
                    const next = loadedMessages[i + 1];
                    if (msg.role === 'user' && next.role === 'assistant') {
                        const userText = typeof msg.content === 'string' ? msg.content
                            : msg.content.filter(b => b.type === 'text').map(b => (b as { text?: string }).text || '').join('');
                        // Skip system-injected messages
                        if (userText.includes('<HEARTBEAT>') || userText.includes('<MEMORY_UPDATE>') || userText.startsWith('<system-reminder>')) {
                            i++;
                            continue;
                        }
                        const assistantText = typeof next.content === 'string' ? next.content
                            : next.content.filter(b => b.type === 'text').map(b => (b as { text?: string }).text || '').join('');
                        // #245 reconstruction-path gate: messages persisted from a
                        // prior session don't carry SDK terminal_reason, so we
                        // can't use shouldRecordTurnForTitle here. Fall back to
                        // pattern matching on the assistant text — a turn that
                        // produced "API Error: 400 …" / "[Error]: …" / etc. as
                        // its only text content is an upstream-error round that
                        // must not seed title-gen, exactly like the live-flow
                        // gate at message-complete. The cleanTitle backstop in
                        // title-generator catches LLM echoes but cannot catch
                        // LLM paraphrases ("API 400 渠道限制") of error inputs,
                        // so we drop the bad rounds at the source.
                        if (isLikelyErrorTitle(assistantText)) {
                            i++;
                            continue;
                        }
                        rounds.push({ user: userText.slice(0, 200), assistant: assistantText.slice(0, 200) });
                        i++; // skip the assistant message
                    }
                }
                titleRoundsRef.current = rounds;
                // If loaded history already has enough rounds, trigger immediately
                if (rounds.length >= AUTO_TITLE_MIN_ROUNDS) {
                    autoTitleAttemptedRef.current = true;
                    const sid = targetSessionId;
                    const model = lastModelRef.current || '';
                    const pEnv = lastProviderEnvRef.current;
                    generateSessionTitle(postJson, sid, [...rounds], model, pEnv)
                        .then(r => {
                            if (r?.success && r.title && currentSessionIdRef.current === sid) {
                                onTitleChangeRef.current?.(r.title);
                                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED));
                            }
                        })
                        .catch(() => {});
                }
            } else {
                titleRoundsRef.current = [];
            }
            if (isStaleLoad('before-state-replace')) {
                return false;
            }

            // Clear current state and load new messages
            seenIdsRef.current.clear();
            isNewSessionRef.current = false; // Allow SSE replays again
            resetBirthPendingRef.current = false;
            resetBirthSessionIdRef.current = null;
            clearSessionActive();  // Stop any streaming/active state
            isLoadingSessionRef.current = false;
            setIsSessionLoading(false);
            // Reset pagination for the new session. Virtuoso sees this as a
            // full data replacement; firstItemIndex snaps back to the start
            // constant so subsequent prepends decrement into a fresh range.
            setFirstItemIndex(PAGINATION_START_INDEX);
            setHasMoreBefore(response.session.hasMoreBefore ?? false);
            hasMoreBeforeRef.current = response.session.hasMoreBefore ?? false;
            loadingOlderRef.current = false;
            // Preload seen IDs so SSE replays / cron sync don't re-append them.
            for (const m of loadedMessages) seenIdsRef.current.add(m.id);
            setHistoryMessages(loadedMessages);
            // Reveal state is per-tab; a session swap must not let a stale reveal loop or
            // un-revealed pending text bleed across. Clear buffer + stop loop (any enqueued
            // commit is id-guarded against the new/null message).
            pendingTextRef.current = '';
            if (revealRafRef.current != null) { cancelAnimationFrame(revealRafRef.current); revealRafRef.current = null; }
            revealAccRef.current = 0;
            revealLastRef.current = 0;
            if (liveStreamingMessage && response.session.liveSessionState === 'running') {
                isStreamingRef.current = true;
                isSessionActiveRef.current = true;
                // Adopted mid-turn stream: bypass the typewriter (reveal instantly) so the
                // REST-snapshot / live-SSE boundary race is not amplified by buffered text.
                adoptedStreamRef.current = true;
                setStreamingMessage(liveStreamingMessage);
            } else {
                adoptedStreamRef.current = false;
                setStreamingMessage(null);
            }
            // Old sessions (pre-v0.1.60) have no runtime field → treat as 'builtin'.
            // null is reserved strictly for "session not loaded yet" (initial state).
            setSessionRuntime(response.session.runtime || 'builtin');
            // Strip SessionData.messages so sessionMeta holds just the metadata slice
            // (prevents accidental reliance on .messages elsewhere and keeps the
            // snapshot concept clean — SessionData is a superset of SessionMetadata).
            const { messages: _meta_messages, ...metaOnly } = response.session as SessionMetadata & { messages?: unknown };
            void _meta_messages;
            setSessionMeta(metaOnly as SessionMetadata);
            // Only reset loading state if not explicitly skipped
            // (caller may be managing loading state for an in-progress operation like cron task)
            if (!options?.skipLoadingReset) {
                const isLiveRunning = response.session.liveSessionState === 'running';
                setIsLoading(isLiveRunning);
                setSessionState(isLiveRunning ? 'running' : 'idle');  // Preserve live external session state when reopening mid-turn
            }
            setSystemStatus(null);
            setAgentError(null);
            setLastTerminalReason(null);
            // Issue #194 — clear runtime diagnostics when loading a different
            // session; the runtime adapter will re-emit `runtime_diagnostics`
            // for the new session if it's external. Avoids showing previous
            // session's "X tools unreachable" warning on an unrelated session.
            setRuntimeDiagnostics(null);
            clearInteractiveState();
            // Update current session ID to reflect the loaded session.
            // Ref is updated synchronously so that any in-flight async handler
            // (cron incremental sync, loadOlderMessages) checking `currentSessionIdRef`
            // after its await resolves sees the new id immediately — otherwise
            // its post-await guard would pass against the old id and dispatch a
            // stale setHistoryMessages onto the already-switched session.
            currentSessionIdRef.current = targetSessionId;
            setCurrentSessionId(targetSessionId);

            // Keep Chat header and all session-list surfaces on the same
            // title/query fallback policy.
            onTitleChangeRef.current?.(getSessionDisplayText(response.session));

            console.log(`[TabProvider ${tabId}] Loaded ${loadedMessages.length} messages from session`);
            return true;
        } catch (error) {
            if (!isStaleLoad('catch')) {
                isLoadingSessionRef.current = false;
                setIsSessionLoading(false);
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            console.error(`[TabProvider ${tabId}] Load session failed:`, errorMessage);
            if (errorStack) {
                console.error(errorStack);
            }
            return false;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- apiGetJson and postJson are stable
    }, [tabId, clearInteractiveState]);

    // Fetch the page of messages immediately older than the one currently at
    // the top of the history. Called by MessageList when Virtuoso's
    // startReached fires. Safe to call repeatedly — the loadingOlderRef guard
    // coalesces concurrent triggers, and hasMoreBefore short-circuits once
    // the earliest message on disk is loaded.
    const loadOlderMessages = useCallback(async (): Promise<void> => {
        if (loadingOlderRef.current || !hasMoreBeforeRef.current) return;
        const sid = currentSessionIdRef.current;
        if (!sid) return;
        const oldest = historyMessagesRef.current[0];
        if (!oldest) return;

        loadingOlderRef.current = true;
        try {
            const resp = await apiGetJson<{
                success: boolean;
                session?: {
                    messages: Array<{
                        id: string;
                        role: 'user' | 'assistant';
                        content: string;
                        timestamp: string;
                        sdkUuid?: string;
                        attachments?: Array<{ id: string; name: string; mimeType: string; path: string }>;
                        metadata?: Message['metadata'];
                    }>;
                    hasMoreBefore?: boolean;
                };
            }>(`/sessions/${encodeURIComponent(sid)}?limit=${OLDER_PAGE_SIZE}&before=${encodeURIComponent(oldest.id)}`);

            // Session may have switched while the request was in flight.
            if (currentSessionIdRef.current !== sid) return;
            if (!resp.success || !resp.session) return;

            const older: Message[] = resp.session.messages.map((msg) => {
                let parsedContent: string | ContentBlock[] = msg.content ?? '';
                if (typeof msg.content === 'string' && msg.content.length > 0 && msg.content.startsWith('[') && msg.content.includes('"type"')) {
                    try {
                        parsedContent = JSON.parse(msg.content) as ContentBlock[];
                    } catch {
                        parsedContent = msg.content;
                    }
                }
                return {
                    id: msg.id,
                    role: msg.role,
                    content: parsedContent,
                    timestamp: new Date(msg.timestamp),
                    sdkUuid: msg.sdkUuid,
                    attachments: msg.attachments?.map((att) => ({
                        id: att.id,
                        name: att.name,
                        size: 0,
                        mimeType: att.mimeType,
                        savedPath: att.path,
                        relativePath: att.path,
                        previewUrl: resolveAttachmentUrl({ savedPath: att.path }),
                        isImage: att.mimeType.startsWith('image/'),
                    })),
                    metadata: msg.metadata,
                };
            });

            if (older.length === 0) {
                setHasMoreBefore(false);
                hasMoreBeforeRef.current = false;
                return;
            }

            // Prepend in a single React commit. Decrementing firstItemIndex by
            // the prepend count is Virtuoso's contract for keeping the visible
            // scroll position stable — the items the user is looking at retain
            // their absolute index and stay pinned on screen.
            setHistoryMessages(prev => {
                const known = new Set(prev.map(m => m.id));
                const fresh = older.filter(m => !known.has(m.id));
                if (fresh.length === 0) return prev;
                for (const m of fresh) seenIdsRef.current.add(m.id);
                setFirstItemIndex(idx => idx - fresh.length);
                return [...fresh, ...prev];
            });
            const nextHasMore = resp.session.hasMoreBefore ?? false;
            setHasMoreBefore(nextHasMore);
            hasMoreBeforeRef.current = nextHasMore;
        } catch (err) {
            console.warn(`[TabProvider ${tabId}] loadOlderMessages failed:`, err);
        } finally {
            loadingOlderRef.current = false;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- apiGetJson is stable
    }, [tabId]);

    // Auto-refresh session when a cron task completes and writes data to the session
    // we're currently viewing. This handles the case where a Tab opens a cron session
    // during/after execution on a different Sidecar — the Tab won't get SSE streaming,
    // so we reload from disk when cron:execution-complete fires.
    const loadSessionRef = useRef(loadSession);
    loadSessionRef.current = loadSession;

    useEffect(() => {
        if (!isTauri()) return;
        const ac = new AbortController();
        void listenWithCleanup<{ taskId: string; success: boolean; executionCount: number; internalSessionId?: string }>(
            'cron:execution-complete',
            async (event) => {
                const { internalSessionId } = event.payload;
                const currentSid = currentSessionIdRef.current;
                if (!internalSessionId || !currentSid || internalSessionId !== currentSid) return;

                // Don't disturb an in-flight turn. If the user is still streaming
                // or actively loading this session, let the normal SSE path
                // deliver new messages — appending mid-turn would compete with
                // the streaming message's final move-to-history step.
                if (isStreamingRef.current || isLoadingSessionRef.current) {
                    return;
                }

                const last = historyMessagesRef.current.at(-1);
                if (!last) {
                    // Empty tab view — fall through to a full load (first-time open).
                    console.log(`[TabProvider ${tabId}] Cron complete on empty view, full load`);
                    loadSessionRef.current(internalSessionId);
                    return;
                }

                try {
                    const resp = await apiGetJson<{
                        success: boolean;
                        fromIndex: number;
                        messages: Array<{
                            id: string;
                            role: 'user' | 'assistant';
                            content: string;
                            timestamp: string;
                            sdkUuid?: string;
                            attachments?: Array<{ id: string; name: string; mimeType: string; path: string }>;
                            metadata?: Message['metadata'];
                        }>;
                    }>(`/sessions/${encodeURIComponent(internalSessionId)}/since/${encodeURIComponent(last.id)}`);

                    if (!resp.success) return;

                    // Server couldn't locate our baseline (rewind / compaction /
                    // JSONL rewrite). Fall back to a full reload — still better
                    // than stale data.
                    if (resp.fromIndex === -1) {
                        console.log(`[TabProvider ${tabId}] Cron complete, baseline lost, full reload`);
                        loadSessionRef.current(internalSessionId);
                        return;
                    }

                    if (resp.messages.length === 0) return;

                    const appended: Message[] = resp.messages.map((msg) => {
                            let parsedContent: string | ContentBlock[] = msg.content ?? '';
                            if (typeof msg.content === 'string' && msg.content.length > 0 && msg.content.startsWith('[') && msg.content.includes('"type"')) {
                                try {
                                    parsedContent = JSON.parse(msg.content) as ContentBlock[];
                                } catch {
                                    parsedContent = msg.content;
                                }
                            }
                            return {
                                id: msg.id,
                                role: msg.role,
                                content: parsedContent,
                                timestamp: new Date(msg.timestamp),
                                sdkUuid: msg.sdkUuid,
                                attachments: msg.attachments?.map((att) => ({
                                    id: att.id,
                                    name: att.name,
                                    size: 0,
                                    mimeType: att.mimeType,
                                    savedPath: att.path,
                                    relativePath: att.path,
                                    previewUrl: resolveAttachmentUrl({ savedPath: att.path }),
                                    isImage: att.mimeType.startsWith('image/'),
                                })),
                                metadata: msg.metadata,
                            };
                        });

                        // Dedupe against any IDs already in history — guards against
                        // the rare race where SSE delivered the same message moments
                        // before cron:execution-complete fired.
                        setHistoryMessages(prev => {
                            const known = new Set(prev.map(m => m.id));
                            const fresh = appended.filter(m => !known.has(m.id));
                            if (fresh.length === 0) return prev;
                            // Mark seen so any subsequent SSE replay skips them.
                            for (const m of fresh) seenIdsRef.current.add(m.id);
                            return [...prev, ...fresh];
                        });
                        console.log(`[TabProvider ${tabId}] Cron incremental sync appended ${appended.length} message(s)`);
                } catch (err) {
                    console.warn(`[TabProvider ${tabId}] Incremental sync failed, falling back to full reload:`, err);
                    loadSessionRef.current(internalSessionId);
                }
            },
            ac.signal,
        );
        return () => ac.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- apiGetJson is stable via useMemo
    }, [tabId]);

    // Track whether initial session has been loaded
    const initialSessionLoadedRef = useRef(false);
    // Track previous sessionId to detect changes (must be before the effect that uses it)
    const prevSessionIdRef = useRef<string | null | undefined>(sessionId);

    // #235: degraded-load fallback. When SSE never (re)attaches after a
    // ConnectionReset cascade, the session-load effect's "waiting for SSE to
    // attach" / "!isConnected" early-returns would leave the tab blank forever
    // because loadSession never fires. This timer loads the session over HTTP
    // (which is independent of the SSE stream) after a grace period so the user
    // sees their conversation; live streaming resumes if/when SSE recovers.
    const sseAttachFallbackRef = useRef<{ timer: ReturnType<typeof setTimeout>; sessionId: string } | null>(null);
    const SSE_ATTACH_FALLBACK_MS = 8000;
    const clearSseAttachFallback = useCallback(() => {
        if (sseAttachFallbackRef.current) {
            clearTimeout(sseAttachFallbackRef.current.timer);
            sseAttachFallbackRef.current = null;
        }
    }, []);
    const armSseAttachFallback = useCallback((
        target: string,
        prevSessionId: string | null | undefined,
        options?: { allowWhileActive?: boolean },
    ) => {
        // Already armed for this exact session — don't restart the countdown.
        if (sseAttachFallbackRef.current?.sessionId === target) return;
        clearSseAttachFallback();
        const timer = setTimeout(() => {
            sseAttachFallbackRef.current = null;
            if (!shouldDegradedLoad({
                mounted: isMountedRef.current,
                currentSessionId: currentSessionIdRef.current,
                target,
                connectedSseSessionId: connectedSseSessionIdRef.current,
                alreadyLoaded: initialSessionLoadedRef.current,
                prevSessionId: prevSessionIdRef.current,
                sessionActiveOrStreaming: isSessionActiveRef.current || isStreamingRef.current,
                allowWhileActive: options?.allowWhileActive,
            })) return;
            console.warn(`[TabProvider ${tabId}] SSE attach timed out for ${target} after ${SSE_ATTACH_FALLBACK_MS}ms — loading session over HTTP (degraded)`);
            initialSessionLoadedRef.current = true;
            void loadSessionRef.current(target, { previousSessionId: prevSessionId ?? null });
        }, SSE_ATTACH_FALLBACK_MS);
        sseAttachFallbackRef.current = { timer, sessionId: target };
    }, [tabId, clearSseAttachFallback]);
    // #235: don't leak the degraded-load timer if the tab unmounts mid-wait.
    useEffect(() => clearSseAttachFallback, [clearSseAttachFallback]);

    // Unified session loading effect - handles both initial load and session changes
    useEffect(() => {
        const prevSessionId = prevSessionIdRef.current;
        const isPendingSession = isPendingSessionId(sessionId);
        const wasPendingSession = isPendingSessionId(prevSessionId);
        const sessionChanged = prevSessionId !== sessionId;
        const resetSessionBirth = isResetSessionBirth({
            resetBirthSessionId: resetBirthSessionIdRef.current,
            sessionId,
        });
        const existingSessionSwitch = isExistingSessionSwitch({
            sessionChanged,
            wasPendingSession,
            isPendingSession,
            isResetSessionBirth: resetSessionBirth,
        });
        prevSessionIdRef.current = sessionId;

        // #235: re-arm the degraded-load fallback fresh each run. During a real
        // hang none of this effect's deps change, so the armed timer survives to
        // fire; any re-run (e.g. isConnected flipping true) clears it before we
        // proceed normally, so a successful attach never triggers a degraded load.
        clearSseAttachFallback();

        // No sessionId - reset flag and return
        if (!sessionId) {
            initialSessionLoadedRef.current = false;
            return;
        }

        // A real session switch must be allowed to load after SSE reattaches.
        // Preserve the pending->real loaded flag because that path represents
        // the same live sidecar/session becoming durable, not a user switch.
        if (sessionChanged && !(wasPendingSession && !isPendingSession)) {
            initialSessionLoadedRef.current = false;
        }

        // Not connected yet - wait. For a real (non-pending) session, arm the
        // degraded-load fallback so a never-connecting SSE doesn't hang the tab.
        if (!isConnected) {
            if (!isPendingSession) {
                armSseAttachFallback(sessionId, prevSessionId, { allowWhileActive: existingSessionSwitch });
            }
            return;
        }

        // Case 1: Current sessionId is pending - skip (doesn't exist in backend yet)
        if (isPendingSession) {
            console.log(`[TabProvider ${tabId}] Session is pending (${sessionId}), skipping load`);
            return;
        }

        // Case 2: Upgraded from pending to real session
        // This happens when backend creates the real session after first message (including cron task)
        if (wasPendingSession) {
            // Case 2a: Already have data (normal message flow) - skip
            if (initialSessionLoadedRef.current) {
                console.log(`[TabProvider ${tabId}] SessionId upgraded from pending to ${sessionId}, already in session`);
                return;
            }

            // Case 2b: Session is currently running (e.g., cron task executing) - skip
            // CRITICAL: Do NOT call loadSession while AI is responding, as it would abort the current session!
            // The messages will come through SSE stream naturally.
            // Use isSessionActiveRef (set by system-init) OR isStreamingRef (set by first chunk).
            if (isSessionActiveRef.current || isStreamingRef.current) {
                console.log(`[TabProvider ${tabId}] SessionId upgraded from pending to ${sessionId}, session is active, skipping loadSession`);
                initialSessionLoadedRef.current = true;  // Mark as loaded to prevent future attempts
                return;
            }

            if (connectedSseSessionIdRef.current !== sessionId) {
                console.log(`[TabProvider ${tabId}] Waiting for SSE to attach to session ${sessionId} before loadSession`);
                armSseAttachFallback(sessionId, prevSessionId);
                return;
            }

            // Case 2c: Switching from an unused pending session to a real session - need to load data
            // This happens when user selects a history session while current tab has unused pending session
            console.log(`[TabProvider ${tabId}] Switching from unused pending to ${sessionId}, loading session`);
            initialSessionLoadedRef.current = true;
            void loadSession(sessionId, { previousSessionId: prevSessionId ?? null });
            return;
        }

        if (connectedSseSessionIdRef.current !== sessionId) {
            console.log(`[TabProvider ${tabId}] Waiting for SSE to attach to session ${sessionId} before loadSession`);
            armSseAttachFallback(sessionId, prevSessionId, { allowWhileActive: existingSessionSwitch });
            return;
        }

        // Case 3: Already loaded this session - skip
        if (initialSessionLoadedRef.current && prevSessionId === sessionId) {
            return;
        }

        // Case 4: Need to load session (initial load or session switch)
        // Exception 1: if resetSession was just called (isNewSessionRef=true), the session
        // upgrade (old→new) arrives via system:init. Messages are already streaming via SSE,
        // so calling loadSession would flash isLoading=false. Skip and let SSE handle it.
        if (isNewSessionRef.current && resetSessionBirth) {
            console.log(`[TabProvider ${tabId}] SessionId upgraded to ${sessionId} after resetSession, skipping loadSession (messages arriving via SSE)`);
            initialSessionLoadedRef.current = true;
            return;
        }
        if (isNewSessionRef.current) {
            console.log(`[TabProvider ${tabId}] Clearing stale new-session flag before loading existing session ${sessionId}`);
            isNewSessionRef.current = false;
            resetBirthPendingRef.current = false;
            resetBirthSessionIdRef.current = null;
        }
        // Exception 2: session is actively processing (session ID upgrade during first message).
        // This happens when: resetSession → sendMessage (clears isNewSessionRef) → chat:system-init
        // assigns real sessionId → parent re-renders with new prop → useEffect fires.
        // At this point isNewSessionRef is false but the session is actively processing.
        // loadSession would reset isLoading/sessionState, causing stop button to briefly disappear.
        if ((isSessionActiveRef.current || isStreamingRef.current) && !existingSessionSwitch) {
            console.log(`[TabProvider ${tabId}] SessionId changed to ${sessionId} while session active, skipping loadSession`);
            initialSessionLoadedRef.current = true;
            return;
        }
        if (prevSessionId !== sessionId) {
            console.log(`[TabProvider ${tabId}] SessionId changed from ${prevSessionId} to ${sessionId}, loading session`);
        } else {
            console.log(`[TabProvider ${tabId}] Initial session load: ${sessionId}`);
        }
        initialSessionLoadedRef.current = true;
        void loadSession(sessionId, { previousSessionId: prevSessionId ?? null });
    }, [sessionId, isConnected, tabId, loadSession, armSseAttachFallback, clearSseAttachFallback]);

    // Cancel a queued message — returns the original text (for restoring to input)
    const cancelQueuedMessage = useCallback(async (queueId: string): Promise<string | null> => {
        try {
            const response = await postJson<{ success: boolean; cancelledText?: string }>('/chat/queue/cancel', { queueId });
            if (response.success) {
                setQueuedMessages(prev => prev.filter(q => q.queueId !== queueId));
                return response.cancelledText ?? null;
            }
            return null;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] Cancel queue item failed:`, error);
            return null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [tabId]);

    // Force-execute a queued message (interrupt current + run immediately)
    // Does NOT optimistically remove from queue — queue:started SSE is the single source of truth
    const forceExecuteQueuedMessage = useCallback(async (queueId: string): Promise<boolean> => {
        try {
            const response = await postJson<{ success: boolean }>('/chat/queue/force', { queueId });
            return response.success;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] Force execute queue item failed:`, error);
            return false;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [tabId]);

    // Respond to permission request
    const respondPermission = useCallback(async (decision: 'deny' | 'allow_once' | 'always_allow') => {
        if (!pendingPermission) return;

        const requestId = pendingPermission.requestId;
        const toolName = pendingPermission.toolName;
        console.log(`[TabProvider] Permission response: ${decision} for ${toolName}`);

        // Track permission decision
        if (decision === 'deny') {
            trackTabEvent('permission_deny', { tool: toolName });
        } else {
            trackTabEvent('permission_grant', { tool: toolName, type: decision });
        }

        // Clear pending permission immediately for UI responsiveness
        setPendingPermission(null);

        // Send response to backend
        try {
            await postJson('/api/permission/respond', { requestId, decision });
        } catch (error) {
            console.error('[TabProvider] Failed to send permission response:', error);
        }
    }, [pendingPermission, postJson, trackTabEvent]);

    // Respond to AskUserQuestion request
    const respondAskUserQuestion = useCallback(async (answers: Record<string, string> | null) => {
        if (!pendingAskUserQuestion) return;

        const requestId = pendingAskUserQuestion.requestId;
        console.log(`[TabProvider] AskUserQuestion response: ${answers ? 'submitted' : 'cancelled'}`);

        // Clear pending question immediately for UI responsiveness
        setPendingAskUserQuestion(null);

        // Send response to backend
        try {
            await postJson('/api/ask-user-question/respond', { requestId, answers });
        } catch (error) {
            console.error('[TabProvider] Failed to send AskUserQuestion response:', error);
        }
    }, [pendingAskUserQuestion, postJson]);

    // Respond to ExitPlanMode request (keep card visible with resolved status).
    // `feedback` (issue #182): user's 「修改意见」 — only meaningful on reject.
    //
    // Returns `true` on success and `false` on failure (network error or
    // `{success:false}` body). We do an optimistic state flip before the POST
    // for UI responsiveness, then roll back on failure so the user can retry
    // their feedback — review-by-codex caught that without the rollback the
    // card would lock into "已拒绝" while the SDK's pendingExitPlanMode entry
    // hung waiting for a response that never arrives.
    const respondExitPlanMode = useCallback(async (approved: boolean, feedback?: string): Promise<boolean> => {
        if (!pendingExitPlanMode) return false;
        const snapshot = pendingExitPlanMode;
        const requestId = pendingExitPlanMode.requestId;
        setPendingExitPlanMode(prev => prev ? { ...prev, resolved: approved ? 'approved' : 'rejected' } : null);
        try {
            const res = await postJson<{ success?: boolean }>('/api/exit-plan-mode/respond', { requestId, approved, feedback });
            if (res && res.success === false) {
                console.error('[TabProvider] ExitPlanMode response rejected by backend');
                setPendingExitPlanMode(prev => prev && prev.requestId === requestId ? { ...snapshot } : prev);
                return false;
            }
            return true;
        } catch (error) {
            console.error('[TabProvider] Failed to send ExitPlanMode response:', error);
            setPendingExitPlanMode(prev => prev && prev.requestId === requestId ? { ...snapshot } : prev);
            return false;
        }
    }, [pendingExitPlanMode, postJson]);

    // Context value - use currentSessionId (which tracks the actually loaded session)
    const contextValue: TabContextValue = useMemo(() => ({
        tabId,
        agentDir,
        sessionId: currentSessionId,
        messages,
        historyMessages,
        streamingMessage,
        firstItemIndex,
        hasMoreBefore,
        isLoading,
        isSessionLoading,
        sessionState,
        sessionRuntime,
        sessionMeta,
        logs,
        unifiedLogs,
        systemInitInfo,
        runtimeDiagnostics,
        agentError,
        systemStatus,
        lastTerminalReason,
        pendingPermission,
        pendingAskUserQuestion,
        pendingExitPlanMode,
        pendingEnterPlanMode,
        toolCompleteCount,
        queuedMessages,
        isConnected,
        setMessages,
        setIsLoading,
        setSessionState,
        appendLog,
        appendUnifiedLog,
        clearUnifiedLogs,
        setSystemInitInfo,
        setAgentError,
        setLastTerminalReason,
        setSessionMeta,
        sendMessage,
        stopResponse,
        loadSession,
        loadOlderMessages,
        resetSession,
        adoptMigratedSession,
        // Tab-scoped API functions
        apiGet: apiGetJson,
        apiPost: postJson,
        apiPut: apiPutJson,
        apiDelete: apiDeleteJson,
        respondPermission,
        respondAskUserQuestion,
        respondExitPlanMode,
        cancelQueuedMessage,
        forceExecuteQueuedMessage,
        // Cron task exit handler ref (mutable, no need in deps)
        onCronTaskExitRequested: onCronTaskExitRequestedRef,
    }), [
        tabId, agentDir, currentSessionId, messages, historyMessages, streamingMessage, firstItemIndex, hasMoreBefore, isLoading, isSessionLoading, sessionState, sessionRuntime, sessionMeta,
        logs, unifiedLogs, systemInitInfo, runtimeDiagnostics, agentError, systemStatus, lastTerminalReason, pendingPermission, pendingAskUserQuestion, pendingExitPlanMode, pendingEnterPlanMode, toolCompleteCount, queuedMessages, isConnected,
        setMessages, appendLog, appendUnifiedLog, clearUnifiedLogs, sendMessage, stopResponse, loadSession, loadOlderMessages, resetSession, adoptMigratedSession,
        apiGetJson, postJson, apiPutJson, apiDeleteJson, respondPermission, respondAskUserQuestion, respondExitPlanMode, cancelQueuedMessage, forceExecuteQueuedMessage
    ]);

    // Lightweight API-only context value — deps are all stable (created once per tabId),
    // so this never rebuilds during streaming, protecting 11+ consumer components.
    const apiContextValue: TabApiContextValue = useMemo(() => ({
        tabId,
        agentDir,
        apiGet: apiGetJson,
        apiPost: postJson,
        apiPut: apiPutJson,
        apiDelete: apiDeleteJson,
    }), [tabId, agentDir, apiGetJson, postJson, apiPutJson, apiDeleteJson]);

    const isActiveValue = isActive ?? false;

    return (
        <TabActiveContext.Provider value={isActiveValue}>
            <TabApiContext.Provider value={apiContextValue}>
                <TabContext.Provider value={contextValue}>
                    {children}
                </TabContext.Provider>
            </TabApiContext.Provider>
        </TabActiveContext.Provider>
    );
}
