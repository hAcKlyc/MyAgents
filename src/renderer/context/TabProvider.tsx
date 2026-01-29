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
import type { ReactNode } from 'react';

import { createSseConnection, type SseConnection } from '@/api/SseConnection';
import type { ImageAttachment } from '@/components/SimpleChatInput';
import type { PermissionRequest } from '@/components/PermissionPrompt';
import type { AskUserQuestionRequest, AskUserQuestion } from '../../shared/types/askUserQuestion';
import { TabContext, type SessionState, type TabContextValue } from './TabContext';
import type { Message, ContentBlock, ToolUseSimple, ToolInput, TaskStats, SubagentToolCall } from '@/types/chat';
import type { ToolUse } from '@/types/stream';
import type { SystemInitInfo } from '../../shared/types/system';
import type { LogEntry } from '@/types/log';
import { parsePartialJson } from '@/utils/parsePartialJson';
import { REACT_LOG_EVENT } from '@/utils/frontendLogger';
import { getTabServerUrl, proxyFetch, stopTabSidecar, isTauri } from '@/api/tauriClient';
import type { PermissionMode } from '@/config/types';

// File-modifying tools that should trigger workspace refresh
const FILE_MODIFYING_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);

/**
 * Helper to update subagent calls in a parent tool
 * Reduces code duplication across subagent event handlers
 */
function updateSubagentCallsInMessages(
    prev: Message[],
    parentToolUseId: string,
    updater: (calls: SubagentToolCall[], tool: ToolUseSimple) => { calls: SubagentToolCall[]; stats?: TaskStats }
): Message[] {
    const last = prev[prev.length - 1];
    if (last?.role !== 'assistant' || typeof last.content === 'string') return prev;

    const contentArray = last.content;
    const idx = contentArray.findIndex(b => b.type === 'tool_use' && b.tool?.id === parentToolUseId);
    if (idx === -1) return prev;

    const block = contentArray[idx];
    if (block.type !== 'tool_use' || !block.tool) return prev;

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
    return [...prev.slice(0, -1), { ...last, content: updated }];
}

interface TabProviderProps {
    children: ReactNode;
    tabId: string;
    agentDir: string;
    sessionId?: string | null;
    /** @deprecated Currently unused - reserved for future optimization (lazy rendering) */
    isActive?: boolean;
    /** Callback when generating state changes (for close confirmation) */
    onGeneratingChange?: (isGenerating: boolean) => void;
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
 * Create a Tab-scoped POST function
 */
function createPostJson(tabId: string) {
    return async <T,>(path: string, body?: unknown): Promise<T> => {
        const baseUrl = await getTabServerUrl(tabId);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined
        });
        return handleApiResponse<T>(response);
    };
}

/**
 * Create a Tab-scoped GET function
 */
function createApiGetJson(tabId: string) {
    return async <T,>(path: string): Promise<T> => {
        const baseUrl = await getTabServerUrl(tabId);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url);
        return handleApiResponse<T>(response);
    };
}

/**
 * Create a Tab-scoped PUT function
 */
function createApiPutJson(tabId: string) {
    return async <T,>(path: string, body?: unknown): Promise<T> => {
        const baseUrl = await getTabServerUrl(tabId);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined
        });
        return handleApiResponse<T>(response);
    };
}

/**
 * Create a Tab-scoped DELETE function
 */
function createApiDelete(tabId: string) {
    return async <T,>(path: string): Promise<T> => {
        const baseUrl = await getTabServerUrl(tabId);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url, { method: 'DELETE' });
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
}: TabProviderProps) {
    // Create Tab-scoped API functions
    const postJson = useMemo(() => createPostJson(tabId), [tabId]);
    const apiGetJson = useMemo(() => createApiGetJson(tabId), [tabId]);
    const apiPutJson = useMemo(() => createApiPutJson(tabId), [tabId]);
    const apiDeleteJson = useMemo(() => createApiDelete(tabId), [tabId]);

    // Core state
    // currentSessionId tracks the actual loaded session (starts from prop, updated by loadSession)
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(sessionId);
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [sessionState, setSessionState] = useState<SessionState>('idle');
    const [logs, setLogs] = useState<string[]>([]);
    const [unifiedLogs, setUnifiedLogs] = useState<LogEntry[]>([]);
    const [systemInitInfo, setSystemInitInfo] = useState<SystemInitInfo | null>(null);
    const [agentError, setAgentError] = useState<string | null>(null);
    const [systemStatus, setSystemStatus] = useState<string | null>(null);  // e.g., 'compacting'
    const [isConnected, setIsConnected] = useState(false);
    const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
    const [pendingAskUserQuestion, setPendingAskUserQuestion] = useState<AskUserQuestionRequest | null>(null);
    const [toolCompleteCount, setToolCompleteCount] = useState(0);

    // Sync currentSessionId when prop changes (e.g., from parent re-initializing)
    useEffect(() => {
        setCurrentSessionId(sessionId);
    }, [sessionId]);

    // Store callback in ref to avoid triggering effect on every render
    const onGeneratingChangeRef = useRef(onGeneratingChange);
    onGeneratingChangeRef.current = onGeneratingChange;

    // Notify parent when generating state changes (for close confirmation)
    useEffect(() => {
        onGeneratingChangeRef.current?.(isLoading);
    }, [isLoading]);

    // Refs for SSE handling
    const sseRef = useRef<SseConnection | null>(null);
    const isStreamingRef = useRef(false);
    // Ref for stop timeout cleanup
    const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const seenIdsRef = useRef<Set<string>>(new Set());
    // Flag to skip message-replay after user clicks "new session"
    const isNewSessionRef = useRef(false);
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
    const resetSession = useCallback(async (): Promise<boolean> => {
        console.log(`[TabProvider ${tabId}] resetSession: starting...`);

        // 1. Clear frontend state immediately for responsive UI
        setMessages([]);
        seenIdsRef.current.clear();
        isNewSessionRef.current = true;
        isStreamingRef.current = false;
        setIsLoading(false);
        setSessionState('idle');  // Reset session state for new conversation
        setSystemStatus(null);
        setAgentError(null);
        setUnifiedLogs([]);
        setLogs([]);
        // Clear pending prompts to prevent stale UI
        setPendingPermission(null);
        setPendingAskUserQuestion(null);

        // 2. Tell backend to reset (this will also broadcast chat:init)
        try {
            const response = await postJson<{ success: boolean; error?: string }>('/chat/reset');
            if (!response.success) {
                console.error(`[TabProvider ${tabId}] resetSession failed:`, response.error);
                return false;
            }
            console.log(`[TabProvider ${tabId}] resetSession complete`);
            return true;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] resetSession error:`, error);
            return false;
        }
    }, [tabId, postJson]);

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

    // Listen for React frontend logs
    useEffect(() => {
        const handleReactLog = (event: Event) => {
            const customEvent = event as CustomEvent<LogEntry>;
            appendUnifiedLog(customEvent.detail);
        };

        window.addEventListener(REACT_LOG_EVENT, handleReactLog);
        return () => {
            window.removeEventListener(REACT_LOG_EVENT, handleReactLog);
        };
    }, [appendUnifiedLog]);

    // Listen for Rust logs via Tauri events (unified with React/Bun logs)
    // Note: Rust logs are only displayed in UI, NOT persisted via frontend API
    // This avoids a log loop: Rust log → API call → Rust proxy logs the call → new Rust log → ...
    useEffect(() => {
        if (!isTauri()) return;

        let unlisten: (() => void) | undefined;

        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            unlisten = await listen<LogEntry>('log:rust', (event) => {
                const entry = event.payload;
                // Add to unified logs for UI display only
                // Do NOT call queueLogsForPersistence - that would cause infinite loop
                appendUnifiedLog(entry);
            });
        })();

        return () => {
            unlisten?.();
        };
    }, [appendUnifiedLog]);

    // Helper: Mark all incomplete thinking/tool blocks as finished (stopped or failed)
    const markIncompleteBlocksAsFinished = useCallback((status: 'completed' | 'stopped' | 'failed') => {
        setMessages(prev => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'assistant' || typeof last.content === 'string') return prev;
            const hasIncomplete = last.content.some(b =>
                (b.type === 'thinking' && !b.isComplete) ||
                (b.type === 'tool_use' && b.tool?.isLoading)
            );
            if (!hasIncomplete) return prev;
            // 'completed' = normal finish (no extra flags)
            // 'stopped'  = user interrupted (isStopped: true, yellow icon)
            // 'failed'   = error occurred (isFailed: true, red icon)
            const statusFlags = status === 'stopped' ? { isStopped: true }
                : status === 'failed' ? { isFailed: true }
                : {};
            const updatedContent = last.content.map(block => {
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
            });
            return [...prev.slice(0, -1), { ...last, content: updatedContent }];
        });
    }, []);

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
                seenIdsRef.current.clear();
                setMessages([]);
                setAgentError(null);

                // Sync isLoading with backend state on SSE connect/reconnect
                // This catches cases where message-complete was lost during connection issues
                const initPayload = data as { sessionState?: SessionState } | null;
                if (initPayload?.sessionState) {
                    setSessionState(initPayload.sessionState);
                    if (initPayload.sessionState === 'idle' && isStreamingRef.current) {
                        console.debug(`[TabProvider ${tabId}] chat:init state=idle, syncing isLoading`);
                        isStreamingRef.current = false;
                        setIsLoading(false);
                        setSystemStatus(null);  // Also clear system status when syncing to idle
                    }
                }
                break;
            }

            case 'chat:message-replay': {
                // Skip replay if user started a new session
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping message-replay (new session)');
                    break;
                }
                const payload = data as { message: { id: string; role: 'user' | 'assistant'; content: string | ContentBlock[]; timestamp: string } } | null;
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

                setMessages(prev => [...prev, {
                    ...msg,
                    timestamp: new Date(msg.timestamp),
                    attachments,
                }]);
                break;
            }

            case 'chat:status': {
                const payload = data as { sessionState: SessionState } | null;
                if (payload?.sessionState) {
                    setSessionState(payload.sessionState);
                    // Sync isLoading with sessionState - defensive fix for when message-complete event is lost
                    // When backend reports 'idle', ensure frontend isLoading is also false
                    if (payload.sessionState === 'idle' && isStreamingRef.current) {
                        console.debug(`[TabProvider ${tabId}] chat:status=idle, syncing isLoading`);
                        isStreamingRef.current = false;
                        setIsLoading(false);
                        setSystemStatus(null);  // Also clear system status when syncing to idle
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

            case 'chat:message-chunk': {
                // Skip stale chunks if user started a new session
                // (old stream may still be sending events before fully disconnecting)
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping message-chunk (new session, stale event)');
                    break;
                }
                const chunk = data as string;
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.role === 'assistant' && isStreamingRef.current) {
                        if (typeof last.content === 'string') {
                            return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
                        }
                        const contentArray = last.content;
                        const lastBlock = contentArray[contentArray.length - 1];
                        if (lastBlock?.type === 'text') {
                            return [...prev.slice(0, -1), {
                                ...last,
                                content: [...contentArray.slice(0, -1), { type: 'text', text: (lastBlock.text || '') + chunk }]
                            }];
                        }
                        return [...prev.slice(0, -1), {
                            ...last,
                            content: [...contentArray, { type: 'text', text: chunk }]
                        }];
                    }
                    isStreamingRef.current = true;
                    setIsLoading(true);
                    return [...prev, {
                        id: Date.now().toString(),
                        role: 'assistant',
                        content: chunk,
                        timestamp: new Date()
                    }];
                });
                break;
            }

            case 'chat:thinking-start': {
                // Skip stale events if user started a new session
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping thinking-start (new session, stale event)');
                    break;
                }
                const { index } = data as { index: number };
                setMessages(prev => {
                    const thinkingBlock: ContentBlock = {
                        type: 'thinking',
                        thinking: '',
                        thinkingStreamIndex: index,
                        thinkingStartedAt: Date.now()
                    };
                    const last = prev[prev.length - 1];
                    if (last?.role === 'assistant') {
                        const content = typeof last.content === 'string'
                            ? [{ type: 'text' as const, text: last.content }]
                            : last.content;
                        return [...prev.slice(0, -1), { ...last, content: [...content, thinkingBlock] }];
                    }
                    isStreamingRef.current = true;
                    setIsLoading(true);
                    return [...prev, { id: Date.now().toString(), role: 'assistant', content: [thinkingBlock], timestamp: new Date() }];
                });
                break;
            }

            case 'chat:thinking-chunk': {
                const { index, delta } = data as { index: number; delta: string };
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.role !== 'assistant' || typeof last.content === 'string') return prev;
                    const contentArray = last.content;
                    const idx = contentArray.findIndex(b => b.type === 'thinking' && b.thinkingStreamIndex === index && !b.isComplete);
                    if (idx === -1) return prev;
                    const block = contentArray[idx];
                    if (block.type !== 'thinking') return prev;
                    const updated = [...contentArray];
                    updated[idx] = { ...block, thinking: (block.thinking || '') + delta };
                    return [...prev.slice(0, -1), { ...last, content: updated }];
                });
                break;
            }

            case 'chat:tool-use-start': {
                // Skip stale events if user started a new session
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping tool-use-start (new session, stale event)');
                    break;
                }
                const tool = data as ToolUse;
                // For Task tool, add taskStartTime and initial taskStats
                const toolSimple: ToolUseSimple = tool.name === 'Task'
                    ? { ...tool, inputJson: '', isLoading: true, taskStartTime: Date.now(), taskStats: { toolCount: 0, inputTokens: 0, outputTokens: 0 } }
                    : { ...tool, inputJson: '', isLoading: true };
                setMessages(prev => {
                    const toolBlock: ContentBlock = {
                        type: 'tool_use',
                        tool: toolSimple
                    };
                    const last = prev[prev.length - 1];
                    if (last?.role === 'assistant') {
                        const content = typeof last.content === 'string'
                            ? [{ type: 'text' as const, text: last.content }]
                            : last.content;
                        return [...prev.slice(0, -1), { ...last, content: [...content, toolBlock] }];
                    }
                    isStreamingRef.current = true;
                    setIsLoading(true);
                    return [...prev, { id: Date.now().toString(), role: 'assistant', content: [toolBlock], timestamp: new Date() }];
                });
                break;
            }

            case 'chat:tool-input-delta': {
                const { toolId, delta } = data as { index: number; toolId: string; delta: string };
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.role !== 'assistant' || typeof last.content === 'string') return prev;
                    const contentArray = last.content;
                    const idx = contentArray.findIndex(b => b.type === 'tool_use' && b.tool?.id === toolId);
                    if (idx === -1) return prev;
                    const block = contentArray[idx];
                    if (block.type !== 'tool_use' || !block.tool) return prev;
                    const newInputJson = (block.tool.inputJson || '') + delta;
                    const parsedInput = parsePartialJson<ToolInput>(newInputJson);
                    const updated = [...contentArray];
                    updated[idx] = {
                        ...block,
                        tool: { ...block.tool, inputJson: newInputJson, parsedInput: parsedInput || block.tool.parsedInput }
                    };
                    return [...prev.slice(0, -1), { ...last, content: updated }];
                });
                break;
            }

            case 'chat:content-block-stop': {
                const { index, toolId } = data as { index: number; toolId?: string };
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.role !== 'assistant' || typeof last.content === 'string') return prev;
                    const contentArray = last.content;

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
                            return [...prev.slice(0, -1), { ...last, content: updated }];
                        }
                    }

                    // Check tool block
                    const toolIdx = toolId
                        ? contentArray.findIndex(b => b.type === 'tool_use' && b.tool?.id === toolId)
                        : contentArray.findIndex(b => b.type === 'tool_use' && b.tool?.streamIndex === index);
                    if (toolIdx !== -1) {
                        const block = contentArray[toolIdx];
                        if (block.type === 'tool_use' && block.tool?.inputJson) {
                            let parsedInput: ToolInput | undefined;
                            try {
                                parsedInput = JSON.parse(block.tool.inputJson);
                            } catch {
                                parsedInput = parsePartialJson<ToolInput>(block.tool.inputJson) ?? undefined;
                            }
                            const updated = [...contentArray];
                            updated[toolIdx] = { ...block, tool: { ...block.tool, parsedInput } };
                            return [...prev.slice(0, -1), { ...last, content: updated }];
                        }
                    }
                    return prev;
                });
                break;
            }

            case 'chat:tool-result-start':
            case 'chat:tool-result-delta':
            case 'chat:tool-result-complete': {
                const payload = data as { toolUseId: string; content?: string; delta?: string; isError?: boolean };
                // Track if we need to trigger workspace refresh (for file-modifying tools)
                let shouldTriggerRefresh = false;

                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    if (last?.role !== 'assistant' || typeof last.content === 'string') return prev;
                    const contentArray = last.content;
                    const idx = contentArray.findIndex(b => b.type === 'tool_use' && b.tool?.id === payload.toolUseId);
                    if (idx === -1) return prev;
                    const block = contentArray[idx];
                    if (block.type !== 'tool_use' || !block.tool) return prev;

                    const updated = [...contentArray];
                    if (eventName === 'chat:tool-result-delta') {
                        updated[idx] = {
                            ...block,
                            tool: { ...block.tool, result: (block.tool.result || '') + (payload.delta ?? ''), isLoading: true }
                        };
                    } else {
                        updated[idx] = {
                            ...block,
                            tool: {
                                ...block.tool,
                                result: payload.content ?? block.tool.result,
                                isError: payload.isError,
                                isLoading: eventName !== 'chat:tool-result-complete'
                            }
                        };
                    }

                    // Mark for workspace refresh when file-modifying tool completes
                    if (eventName === 'chat:tool-result-complete' && block.tool.name && FILE_MODIFYING_TOOLS.has(block.tool.name)) {
                        shouldTriggerRefresh = true;
                    }

                    return [...prev.slice(0, -1), { ...last, content: updated }];
                });

                // Trigger workspace refresh after state update (outside setMessages callback)
                if (shouldTriggerRefresh) {
                    setToolCompleteCount(c => c + 1);
                }
                break;
            }

            case 'chat:message-complete': {
                isStreamingRef.current = false;
                setIsLoading(false);
                setSessionState('idle');  // Reset session state to idle
                setSystemStatus(null);  // Clear system status (e.g., 'compacting') when message completes
                // Defensively mark any remaining incomplete thinking/tool blocks as complete.
                // Normally content_block_stop handles this, but third-party providers may not
                // send it, leaving blocks stuck in loading state.
                markIncompleteBlocksAsFinished('completed');
                break;
            }

            case 'chat:message-stopped': {
                isStreamingRef.current = false;
                setIsLoading(false);
                setSessionState('idle');  // Reset session state to idle
                setSystemStatus(null);  // Clear system status when user stops response
                // Clear stop timeout since we received confirmation
                if (stopTimeoutRef.current) {
                    clearTimeout(stopTimeoutRef.current);
                    stopTimeoutRef.current = null;
                }
                // Mark all incomplete thinking blocks and tool_use blocks as stopped
                markIncompleteBlocksAsFinished('stopped');
                break;
            }

            case 'chat:message-error': {
                isStreamingRef.current = false;
                setIsLoading(false);
                setSessionState('idle');  // Reset session state to idle on error
                setSystemStatus(null);  // Clear system status on error
                // Clear stop timeout on error too
                if (stopTimeoutRef.current) {
                    clearTimeout(stopTimeoutRef.current);
                    stopTimeoutRef.current = null;
                }
                // Mark all incomplete thinking blocks and tool_use blocks as failed
                markIncompleteBlocksAsFinished('failed');
                break;
            }

            case 'chat:system-init': {
                const payload = data as { info: SystemInitInfo } | null;
                if (payload?.info) {
                    setSystemInitInfo(payload.info);
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

            // Subagent event handling for nested tool calls (Task tool)
            case 'chat:subagent-tool-use': {
                const payload = data as { parentToolUseId: string; tool: ToolUse; usage?: { input_tokens?: number; output_tokens?: number } };
                setMessages(prev => updateSubagentCallsInMessages(prev, payload.parentToolUseId, (calls, tool) => {
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
                }));
                break;
            }

            case 'chat:subagent-tool-input-delta': {
                const payload = data as { parentToolUseId: string; toolId: string; delta: string };
                setMessages(prev => updateSubagentCallsInMessages(prev, payload.parentToolUseId, (calls) => {
                    const updatedCalls = calls.map(call => {
                        if (call.id !== payload.toolId) return call;
                        const nextInputJson = (call.inputJson || '') + payload.delta;
                        const parsedInput = parsePartialJson<ToolInput>(nextInputJson);
                        return { ...call, inputJson: nextInputJson, parsedInput: parsedInput || call.parsedInput };
                    });
                    return { calls: updatedCalls };
                }));
                break;
            }

            case 'chat:subagent-tool-result-start': {
                const payload = data as { parentToolUseId: string; toolUseId: string; content: string; isError: boolean };
                setMessages(prev => updateSubagentCallsInMessages(prev, payload.parentToolUseId, (calls) => {
                    const updatedCalls = calls.map(call =>
                        call.id === payload.toolUseId
                            ? { ...call, result: payload.content, isError: payload.isError, isLoading: true }
                            : call
                    );
                    return { calls: updatedCalls };
                }));
                break;
            }

            case 'chat:subagent-tool-result-delta': {
                const payload = data as { parentToolUseId: string; toolUseId: string; delta: string };
                setMessages(prev => updateSubagentCallsInMessages(prev, payload.parentToolUseId, (calls) => {
                    const updatedCalls = calls.map(call =>
                        call.id === payload.toolUseId
                            ? { ...call, result: (call.result || '') + payload.delta, isLoading: true }
                            : call
                    );
                    return { calls: updatedCalls };
                }));
                break;
            }

            case 'chat:subagent-tool-result-complete': {
                const payload = data as { parentToolUseId: string; toolUseId: string; content: string; isError?: boolean };
                setMessages(prev => updateSubagentCallsInMessages(prev, payload.parentToolUseId, (calls) => {
                    const updatedCalls = calls.map(call =>
                        call.id === payload.toolUseId
                            ? { ...call, result: payload.content, isError: payload.isError, isLoading: false }
                            : call
                    );
                    return { calls: updatedCalls };
                }));
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
                }
                break;
            }

            case 'ask-user-question:request': {
                // Agent is asking user structured questions
                const payload = data as { requestId: string; questions: AskUserQuestion[] } | null;
                console.log(`[TabProvider] ask-user-question:request received:`, payload);
                if (payload?.requestId && payload.questions?.length > 0) {
                    console.log(`[TabProvider] Setting pendingAskUserQuestion with ${payload.questions.length} questions`);
                    setPendingAskUserQuestion({
                        requestId: payload.requestId,
                        questions: payload.questions,
                    });
                }
                break;
            }

            default: {
                // Log unhandled events for debugging
                if (!eventName.startsWith('chat:')) {
                    console.log(`[TabProvider] Unhandled SSE event: ${eventName}`);
                }
            }
        }
    }, [appendLog, appendUnifiedLog, tabId, markIncompleteBlocksAsFinished]);

    // Connect SSE
    const connectSse = useCallback(async () => {
        if (sseRef.current?.isConnected()) return;

        const sse = createSseConnection(tabId);
        sse.setEventHandler(handleSseEvent);
        sseRef.current = sse;

        try {
            await sse.connect();
            setIsConnected(true);
            // Note: Log server URL is set once in App.tsx using global sidecar
            // Tab sidecars should not override it to avoid URL switching issues
        } catch (error) {
            console.error(`[TabProvider ${tabId}] SSE connect failed:`, error);
            throw error;
        }
    }, [tabId, handleSseEvent]);

    // Disconnect SSE
    const disconnectSse = useCallback(() => {
        if (sseRef.current) {
            void sseRef.current.disconnect();
            sseRef.current = null;
            setIsConnected(false);
        }
    }, []);

    // Track agentDir for cleanup (need ref because cleanup runs after props may change)
    const agentDirRef = useRef(agentDir);
    agentDirRef.current = agentDir;

    // Cleanup on unmount - disconnect SSE, clear pending timers, and stop Tab's Sidecar
    useEffect(() => {
        return () => {
            if (sseRef.current) {
                void sseRef.current.disconnect();
            }
            if (stopTimeoutRef.current) {
                clearTimeout(stopTimeoutRef.current);
                stopTimeoutRef.current = null;
            }
            // Only stop Sidecar if this Tab had one (i.e., was running a project)
            // Settings/Launcher tabs don't have sidecars (agentDir is empty string)
            if (agentDirRef.current) {
                void stopTabSidecar(tabId);
            }
        };
    }, [tabId]);

    // Send message with optional images, permission mode, and model
    const sendMessage = useCallback(async (
        text: string,
        images?: ImageAttachment[],
        permissionMode?: PermissionMode,
        model?: string,
        providerEnv?: { baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key' }
    ): Promise<boolean> => {
        const trimmed = text.trim();
        if (!trimmed && (!images || images.length === 0)) return false;

        try {
            // Reset new session flag BEFORE sending - allow message replay to show user's message
            // This must happen before API call because chat:message-replay arrives during the call
            isNewSessionRef.current = false;

            // Store attachments for merging with SSE replay
            if (images && images.length > 0) {
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

            const response = await postJson<{ success: boolean; error?: string }>('/chat/send', {
                text: trimmed,
                images: imageData,
                permissionMode: permissionMode ?? 'auto',
                model,
                providerEnv,
            });

            return response.success;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] Send message failed:`, error);
            pendingAttachmentsRef.current = null; // Clear on error
            return false;
        }
    }, [tabId]);

    // Stop response with timeout fallback
    const stopResponse = useCallback(async (): Promise<boolean> => {
        // Clear any existing stop timeout
        if (stopTimeoutRef.current) {
            clearTimeout(stopTimeoutRef.current);
            stopTimeoutRef.current = null;
        }

        try {
            const response = await postJson<{ success: boolean; error?: string }>('/chat/stop');
            if (response.success) {
                // 设置 5 秒超时，如果没有收到 SSE 事件确认则强制恢复 UI
                stopTimeoutRef.current = setTimeout(() => {
                    if (isStreamingRef.current) {
                        console.warn(`[TabProvider ${tabId}] Stop timeout - forcing UI recovery`);
                        isStreamingRef.current = false;
                        setIsLoading(false);
                        setSessionState('idle');  // Reset session state on timeout
                        setSystemStatus(null);
                    }
                    stopTimeoutRef.current = null;
                }, 5000);
                return true;
            }
            return false;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] Stop response failed:`, error);
            // 请求失败也强制恢复 UI
            isStreamingRef.current = false;
            setIsLoading(false);
            setSessionState('idle');  // Reset session state on error
            setSystemStatus(null);
            return false;
        }
    }, [tabId]);

    // Load session from history
    const loadSession = useCallback(async (targetSessionId: string): Promise<boolean> => {
        try {
            console.log(`[TabProvider ${tabId}] Loading session: ${targetSessionId}`);
            const response = await apiGetJson<{ success: boolean; session?: { messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: string; attachments?: Array<{ id: string; name: string; mimeType: string; path: string; previewUrl?: string }> }> } }>(`/sessions/${targetSessionId}`);

            if (!response.success || !response.session) {
                console.error(`[TabProvider ${tabId}] Session not found`);
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
                    attachments: msg.attachments?.map((att: { id: string; name: string; mimeType: string; path: string; previewUrl?: string }) => ({
                        id: att.id,
                        name: att.name,
                        size: 0,
                        mimeType: att.mimeType,
                        savedPath: att.path,
                        relativePath: att.path,
                        previewUrl: att.previewUrl,
                        isImage: att.mimeType.startsWith('image/'),
                    })),
                };
            });

            // Clear current state and load new messages
            seenIdsRef.current.clear();
            isNewSessionRef.current = false; // Allow SSE replays again
            isStreamingRef.current = false;  // Stop any streaming state
            setMessages(loadedMessages);
            setIsLoading(false);
            setSessionState('idle');  // Reset session state when loading historical session
            setSystemStatus(null);
            setAgentError(null);
            // Update current session ID to reflect the loaded session
            setCurrentSessionId(targetSessionId);

            // Also update backend to switch session (for continuity)
            await postJson('/sessions/switch', { sessionId: targetSessionId });

            console.log(`[TabProvider ${tabId}] Loaded ${loadedMessages.length} messages from session`);
            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            console.error(`[TabProvider ${tabId}] Load session failed:`, errorMessage);
            if (errorStack) {
                console.error(errorStack);
            }
            return false;
        }
    }, [tabId]);

    // Track whether initial session has been loaded
    const initialSessionLoadedRef = useRef(false);

    // Auto-load session when initial sessionId is provided and SSE is connected
    useEffect(() => {
        // Only load if:
        // 1. sessionId is provided
        // 2. SSE is connected (sidecar is ready)
        // 3. We haven't loaded this session yet
        if (sessionId && isConnected && !initialSessionLoadedRef.current) {
            initialSessionLoadedRef.current = true;
            console.log(`[TabProvider ${tabId}] Auto-loading initial session: ${sessionId}`);
            void loadSession(sessionId);
        }
    }, [sessionId, isConnected, tabId, loadSession]);

    // Reset the loaded flag when sessionId changes to a different value
    useEffect(() => {
        if (!sessionId) {
            initialSessionLoadedRef.current = false;
        }
    }, [sessionId]);

    // Respond to permission request
    const respondPermission = useCallback(async (decision: 'deny' | 'allow_once' | 'always_allow') => {
        if (!pendingPermission) return;

        const requestId = pendingPermission.requestId;
        console.log(`[TabProvider] Permission response: ${decision} for ${pendingPermission.toolName}`);

        // Clear pending permission immediately for UI responsiveness
        setPendingPermission(null);

        // Send response to backend
        try {
            await postJson('/api/permission/respond', { requestId, decision });
        } catch (error) {
            console.error('[TabProvider] Failed to send permission response:', error);
        }
    }, [pendingPermission, postJson]);

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

    // Context value - use currentSessionId (which tracks the actually loaded session)
    const contextValue: TabContextValue = useMemo(() => ({
        tabId,
        agentDir,
        sessionId: currentSessionId,
        messages,
        isLoading,
        sessionState,
        logs,
        unifiedLogs,
        systemInitInfo,
        agentError,
        systemStatus,
        isActive: isActive ?? false,
        pendingPermission,
        pendingAskUserQuestion,
        toolCompleteCount,
        isConnected,
        setMessages,
        setIsLoading,
        setSessionState,
        appendLog,
        appendUnifiedLog,
        clearUnifiedLogs,
        setSystemInitInfo,
        setAgentError,
        connectSse,
        disconnectSse,
        sendMessage,
        stopResponse,
        loadSession,
        resetSession,
        // Tab-scoped API functions
        apiGet: apiGetJson,
        apiPost: postJson,
        apiPut: apiPutJson,
        apiDelete: apiDeleteJson,
        respondPermission,
        respondAskUserQuestion,
    }), [
        tabId, agentDir, currentSessionId, messages, isLoading, sessionState,
        logs, unifiedLogs, systemInitInfo, agentError, systemStatus, isActive, pendingPermission, pendingAskUserQuestion, toolCompleteCount, isConnected,
        appendLog, appendUnifiedLog, clearUnifiedLogs, connectSse, disconnectSse, sendMessage, stopResponse, loadSession, resetSession,
        apiGetJson, postJson, apiPutJson, apiDeleteJson, respondPermission, respondAskUserQuestion
    ]);

    return (
        <TabContext.Provider value={contextValue}>
            {children}
        </TabContext.Provider>
    );
}
