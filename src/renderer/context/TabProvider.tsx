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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';

import {
    track,
    consumePendingSessionBirth,
    peekPendingSessionBirth,
    setPendingSessionBirth,
    hashAgentNameSync,
    birthContextForSurface,
} from '@/analytics';
import type { PendingSessionBirthContext } from '@/analytics';
import { useConfigData } from '@/config/useConfigData';
import { getProjectAgent } from '@/config/services/agentConfigService';
import { notifyConfigChanged } from '@/config/services/appConfigService';
import { normalizeRuntime, resolveEffectiveRuntime } from '@/utils/sessionOpenPlan';
import type { RuntimeDiagnostics, RuntimeSource, RuntimeType } from '@/../shared/types/runtime';
import { updateSession } from '@/api/sessionClient';
import type { SessionMetadata } from '@/api/sessionClient';
import { originAnalyticsFields, originFromDesktopSurface } from '../../shared/session-origin';
import {
    createSseConnection,
    type SseConnection,
    type SseEventMetadata,
} from '@/api/SseConnection';
import type { ImageAttachment } from '@/components/SimpleChatInput';
import type { PermissionRequest } from '@/components/PermissionPrompt';
import type { AskUserQuestionRequest, AskUserQuestion } from '../../shared/types/askUserQuestion';
import type { ExitPlanModeRequest, EnterPlanModeRequest, ExitPlanModeAllowedPrompt } from '../../shared/types/planMode';
import { CUSTOM_EVENTS, isPendingSessionId } from '../../shared/constants';
import { TabContext, TabApiContext, TabActiveContext, type AdoptMigratedSessionOptions, type CurrentSessionRestoreResult, type LoadOlderMessagesOptions, type SessionState, type SystemNotice, type TabContextValue, type TabApiContextValue } from './TabContext';
import { appendUniqueMessageById, upsertMessageById, updateMessageById, shouldAcceptLiveTurnEvent, shouldSkipHistoryReplay, shouldClearHistoryOnInit, reconcileLiveRecoveryHistory, normalizeSessionMessageContent, isRestoreActionBlocked } from './sessionRestoreGuards';
import {
    classifySessionActivity,
    decideSystemInitSessionId,
    decidePersistedContextUsageSeed,
    shouldAcceptSessionScopedSseSnapshot,
    shouldPreserveSnapshotOnPendingBirthPropSync,
} from './sessionScopedEventGuards';
import { isSubagentContainerTool } from '@/components/tools/toolBadgeConfig';
import type { AgentStatusTodoSnapshot, Message, MessageAttachment, ContentBlock, ToolUseSimple, ToolInput, TaskStats, SubagentToolCall } from '@/types/chat';
import type { ToolUse } from '@/types/stream';
import type { SystemInitInfo } from '../../shared/types/system';
import {
    finalizeResidualSubagentCall,
    type SubagentLifecycle,
} from '../../shared/types/subagent-lifecycle';
import type { ContextUsage } from '../../shared/types/context-usage';
import type { TerminalReason } from '../../shared/terminalReason';
import type { SlashCommand } from '../../shared/slashCommands';
import type { LogEntry } from '@/types/log';
import { applySubagentLifecycleToContent } from '@/components/tools/subagentActivity';
import type { ProviderRoute } from '../../shared/providerRoute';
import type { ProductSystemSkillRequirement } from '../../shared/systemSkills';
import { stripLeadingSystemReminder } from '../../shared/systemReminder';
import { deriveSessionTitle } from '../../shared/sessionTitle';
import {
    reduceMcpEffectiveSnapshot,
    type McpEffectiveSnapshot,
} from '../../shared/mcpEffectiveState';
import {
    COLD_HISTORY_REPLAY_KIND,
    LIVE_USER_ECHO_REPLAY_KIND,
    type ChatMessageReplayPayload,
} from '../../shared/chatMessageReplay';
import { imagePayloadForSend, mergeAttachmentPreviews } from './userImageAttachmentProjection';
import { parsePartialJson } from '@/utils/parsePartialJson';
import { useQueryElapsedClock } from '@/hooks/useQueryElapsedClock';
import { enqueuePermissionRequest, peekPermissionRequest, removePermissionRequest } from '@/utils/permissionQueue';
import { i18n } from '@/i18n';
import { subscribeFrontendLogs, setCurrentTabId } from '@/utils/frontendLogger';
import { getTabServerUrl, sessionSidecarFetch, isTauri, getSessionPort, resetTabServerUrlCache, setActiveCorrelation } from '@/api/tauriClient';
import { fetchJsonLargeValueRef } from '@/api/largeValueRef';
import { resolveAttachmentUrl } from '@/utils/attachmentUrl';
import { isResetSessionBirth, shouldDegradedLoad, shouldReuseSseSubscriptionForSessionChange } from '@/utils/optionResolve';
import { getSessionDisplayText } from '@/utils/sessionDisplay';
import { listenWithCleanup } from '@/utils/tauriListen';
import type { PermissionMode } from '@/config/types';
import type { QueuedImageInfo, QueuedMessageInfo } from '@/types/queue';
import {
    notifyPermissionRequest,
    notifyAskUserQuestion,
    notifyPlanModeRequest,
    shouldNotifyUser,
} from '@/services/notificationService';
import { setBackgroundTaskStatus, setBackgroundTaskDescription, getBackgroundTaskDescription, clearAllBackgroundTaskStatuses, registerBackgroundTask } from '@/utils/backgroundTaskStatus';
import { countVisibleChatTimelineRows, shiftFirstItemIndexForVisiblePrepend } from '@/utils/chatTimelineRows';
import {
    EMPTY_LIVE_REVISION_FENCE,
    beginLiveRevisionRestore,
    completeLiveRevisionRestore,
    ingestLiveRevisionEvent,
    type LiveRevisionFence,
} from './liveRevisionFence';

// Pattern 3 §3.2.2 — display cap on streaming tool results. The renderer
// truncates the inline result to this many characters; the full result is
// available on completion (and Pattern 2's maybeSpill makes it accessible
// via the /refs/:id endpoint when oversize).
const TOOL_RESULT_DISPLAY_CAP = 8 * 1024;
const TOOL_RESULT_TAIL_KEEP = 1024;

function replaceFinalToolInput(
    message: Message,
    toolId: string,
    input: Record<string, unknown>,
): Message {
    if (message.role !== 'assistant' || typeof message.content === 'string') return message;
    const toolIdx = message.content.findIndex(block => isToolBlock(block) && block.tool?.id === toolId);
    if (toolIdx === -1) return message;
    const block = message.content[toolIdx];
    if (!isToolBlock(block) || !block.tool) return message;
    const updated = [...message.content];
    updated[toolIdx] = {
        ...block,
        tool: {
            ...block.tool,
            input,
            inputJson: undefined,
            parsedInput: input as ToolInput,
        },
    };
    return { ...message, content: updated };
}

function appText(key: string, options?: Record<string, unknown>): string {
    return String(i18n.t(`app:${key}`, options));
}

function queueDisplayText(raw: string): string {
    const visible = stripLeadingSystemReminder(raw).trim();
    return visible || appText('tabProvider.hiddenSystemMessage');
}

function analyticsRuntimeSource(
    runtime: RuntimeType,
    runtimeSource: RuntimeSource | null | undefined,
): RuntimeSource | null {
    if (runtime === 'builtin') return null;
    return runtimeSource ?? 'system-cli';
}

function imageAttachmentName(img: ImageAttachment): string {
    return img.name || img.file.name;
}

function imageAttachmentMimeType(img: ImageAttachment): string {
    return img.mimeType || img.file.type || 'application/octet-stream';
}

function imageAttachmentSize(img: ImageAttachment): number {
    return img.sizeBytes ?? img.file.size;
}

function queuedImageInfo(img: ImageAttachment): QueuedImageInfo {
    return {
        id: img.id,
        name: imageAttachmentName(img),
        preview: img.preview,
        mimeType: imageAttachmentMimeType(img),
        sizeBytes: imageAttachmentSize(img),
        source: img.source,
        relativePath: img.relativePath,
    };
}

type WireMessageAttachment = {
    id: string;
    name: string;
    size?: number;
    mimeType: string;
    path?: string;
    relativePath?: string;
    savedPath?: string;
    previewUrl?: string;
    isImage?: boolean;
};

type WireMessageUsage = NonNullable<Message['usage']>;

type WireSessionMessage = {
    id: string;
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
    timestamp: string;
    sdkUuid?: string;
    runtimeTurnAnchor?: Message['runtimeTurnAnchor'];
    metadata?: Message['metadata'];
    attachments?: WireMessageAttachment[];
    usage?: WireMessageUsage;
    toolCount?: number;
    durationMs?: number | null;
};

type PersistedRestoreMode = 'initial' | 'live-recovery';

type PersistedRestoreLifecycle = {
    phase: 'inactive' | 'restoring' | 'ready' | 'failed';
    mode: PersistedRestoreMode;
    sessionId: string | null;
    restoreToken: number;
    connectionGeneration: number;
    error: string | null;
};

type AssistantCompletionPatch = {
    realId?: string;
    sdkUuid?: string;
    usage?: Message['usage'];
    toolCount?: number;
    durationMs?: number;
    runtimeTurnAnchor?: Message['runtimeTurnAnchor'];
};

function applyAssistantCompletionPatch(message: Message, patch: AssistantCompletionPatch | undefined): Message {
    if (!patch || message.role !== 'assistant') return message;
    const needsUuid = patch.sdkUuid && message.sdkUuid !== patch.sdkUuid;
    const needsId = patch.realId && message.id !== patch.realId;
    const needsUsage = patch.usage && message.usage !== patch.usage;
    const needsToolCount = patch.toolCount !== undefined && message.toolCount !== patch.toolCount;
    const needsDuration = patch.durationMs !== undefined && message.durationMs !== patch.durationMs;
    const needsRuntimeTurnAnchor = patch.runtimeTurnAnchor !== undefined
        && message.runtimeTurnAnchor !== patch.runtimeTurnAnchor;
    if (!needsUuid && !needsId && !needsUsage && !needsToolCount && !needsDuration && !needsRuntimeTurnAnchor) return message;
    return {
        ...message,
        ...(needsId ? { id: patch.realId } : {}),
        ...(needsUuid ? { sdkUuid: patch.sdkUuid } : {}),
        ...(patch.usage ? { usage: patch.usage } : {}),
        ...(patch.toolCount !== undefined ? { toolCount: patch.toolCount } : {}),
        ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
        ...(patch.runtimeTurnAnchor ? { runtimeTurnAnchor: patch.runtimeTurnAnchor } : {}),
    };
}

// Force-close incomplete thinking/tool blocks on an assistant message before it
// moves into history. Shared by moveStreamingToHistory (turn terminal) and the
// queue:started midTurnBreak split — a force-send interrupts the old turn, so the
// snapshot must mark its thinking as stopped rather than leave it "in progress".
function finalizeAssistantForHistory(msg: Message, status: 'completed' | 'stopped' | 'failed'): Message {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
    const statusFlags = status === 'stopped' ? { isStopped: true }
        : status === 'failed' ? { isFailed: true }
            : {};
    const hasIncomplete = msg.content.some(b =>
        (b.type === 'thinking' && !b.isComplete) ||
        (b.type === 'tool_use' && b.tool?.isLoading)
    );
    if (!hasIncomplete) return msg;
    return {
        ...msg,
        content: msg.content.map(block => {
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

function normalizeFiniteNumber(value: number | null | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeTurnDurationMs(value: number | null | undefined): number | undefined {
    return normalizeFiniteNumber(value);
}

function getAssistantTurnMetrics(msg: Pick<WireSessionMessage, 'role' | 'usage' | 'toolCount' | 'durationMs'>): Pick<Message, 'usage' | 'toolCount' | 'durationMs'> {
    if (msg.role !== 'assistant') return {};
    return {
        usage: msg.usage,
        toolCount: typeof msg.toolCount === 'number' && Number.isFinite(msg.toolCount) ? msg.toolCount : undefined,
        durationMs: normalizeTurnDurationMs(msg.durationMs),
    };
}

function wireAssistantToStreamingMessage(message: WireSessionMessage | null | undefined): Message | null {
    if (!message || message.role !== 'assistant') return null;
    return {
        id: message.id,
        role: 'assistant',
        content: normalizeSessionMessageContent(message.content),
        timestamp: new Date(message.timestamp),
        sdkUuid: message.sdkUuid,
        runtimeTurnAnchor: message.runtimeTurnAnchor,
        ...getAssistantTurnMetrics(message),
    };
}

function normalizeWireAttachments(
    attachments: WireMessageAttachment[] | undefined,
): MessageAttachment[] | undefined {
    if (!attachments || attachments.length === 0) return undefined;
    return attachments.map((att) => {
        const relativePath = att.relativePath ?? att.path ?? att.savedPath;
        const normalized: MessageAttachment = {
            id: att.id,
            name: att.name,
            size: att.size ?? 0,
            mimeType: att.mimeType,
            relativePath,
            savedPath: att.savedPath,
            isImage: att.isImage ?? att.mimeType.startsWith('image/'),
        };
        const previewUrl = att.previewUrl ?? resolveAttachmentUrl(normalized);
        return previewUrl ? { ...normalized, previewUrl } : normalized;
    });
}

function wireSessionMessageToMessage(message: WireSessionMessage): Message {
    return {
        id: message.id,
        role: message.role,
        content: normalizeSessionMessageContent(message.content),
        timestamp: new Date(message.timestamp),
        sdkUuid: message.sdkUuid,
        runtimeTurnAnchor: message.runtimeTurnAnchor,
        attachments: normalizeWireAttachments(message.attachments),
        metadata: message.metadata,
        ...getAssistantTurnMetrics(message),
    };
}

function normalizeAgentPlanTodos(value: unknown): AgentStatusTodoSnapshot[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((raw, idx): AgentStatusTodoSnapshot[] => {
        if (!raw || typeof raw !== 'object') return [];
        const item = raw as Record<string, unknown>;
        const content = typeof item.content === 'string' ? item.content.trim() : '';
        if (!content) return [];
        const status = item.status === 'completed' || item.status === 'in_progress' || item.status === 'pending'
            ? item.status
            : 'pending';
        return [{
            key: typeof item.key === 'string' && item.key ? item.key : `runtime-plan-${idx}`,
            content,
            activeForm: typeof item.activeForm === 'string' && item.activeForm ? item.activeForm : content,
            status,
        }];
    });
}

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

export function applySubagentLifecycleUpdate(
    msg: Message,
    parentToolUseId: string,
    lifecycle: SubagentLifecycle,
): Message | null {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') return null;
    const content = applySubagentLifecycleToContent(msg.content, parentToolUseId, lifecycle);
    if (!content) return null;
    if (content === msg.content) return msg;
    return { ...msg, content };
}

export function finalizeMessageSubagentProjection(
    message: Message,
    rootStatus: 'completed' | 'stopped' | 'failed',
    observedAt = Date.now(),
): Message {
    if (message.role !== 'assistant' || typeof message.content === 'string') return message;
    let changed = false;
    const fallbackStatus = rootStatus === 'stopped' ? 'interrupted' : 'failed';
    const content = message.content.map(block => {
        if (block.type !== 'tool_use' || !block.tool?.subagentLifecycle) return block;
        const tool = block.tool;
        let lifecycle: SubagentLifecycle = block.tool.subagentLifecycle;
        if (lifecycle.status === 'running') {
            lifecycle = {
                status: fallbackStatus,
                startedAt: lifecycle.startedAt,
                finishedAt: Math.max(lifecycle.startedAt, observedAt),
            };
            changed = true;
        }
        const subagentCalls = tool.subagentCalls?.map(call => {
            const finalized = finalizeResidualSubagentCall(call, fallbackStatus);
            if (finalized !== call) changed = true;
            return finalized;
        });
        if (lifecycle === tool.subagentLifecycle && subagentCalls === tool.subagentCalls) return block;
        return {
            ...block,
            tool: {
                ...tool,
                subagentLifecycle: lifecycle,
                subagentCalls,
            },
        };
    });
    return changed ? { ...message, content } : message;
}

function replaceFinalSubagentToolInput(
    message: Message,
    parentToolUseId: string,
    toolId: string,
    input: Record<string, unknown>,
): Message {
    return applySubagentCallsUpdate(message, parentToolUseId, (calls) => ({
        calls: calls.map(call => call.id === toolId
            ? {
                ...call,
                input,
                inputJson: undefined,
                parsedInput: input as ToolInput,
            }
            : call),
    })) ?? message;
}

interface TabProviderProps {
    children: ReactNode;
    tabId: string;
    agentDir: string;
    sessionId?: string | null;
    /** Current App-shell title projection, used to preserve newer manual/AI titles during rollback. */
    sessionTitle?: string;
    /** Whether this Tab is currently visible — fed into TabActiveContext for useTabActive() consumers */
    isActive?: boolean;
    /** Callback when generating state changes (for close confirmation) */
    onGeneratingChange?: (isGenerating: boolean) => void;
    /** Callback when sessionId changes (e.g., backend creates real session from pending-xxx) */
    onSessionIdChange?: (newSessionId: string, options?: AdoptMigratedSessionOptions) => boolean | void | Promise<boolean | void>;
    /** Callback when session title changes (auto-generated or renamed) */
    onTitleChange?: (title: string) => void;
    /** Callback when unread state changes (message completed on non-active tab) */
    onUnreadChange?: (hasUnread: boolean) => void;
    /**
     * App-owned admission for fixed-Session recovery and turn submission.
     * Neither may race deletion of the same Session identity.
     */
    claimSessionOpeningTransition: (sessionId: string) => (() => void) | null;
    // Note: sidecarPort prop removed - now using Session-centric Sidecar (Owner model)
    // Ready port is dynamically retrieved via getSessionPort(sessionId)
}

/**
 * Handle API response - check for errors and throw if not ok
 */
export async function handleApiResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as {
            error?: unknown;
            errorCode?: unknown;
        };
        const error = new Error(
            typeof errorData.error === 'string' ? errorData.error : `HTTP ${response.status}`,
        ) as Error & { status: number; errorCode?: string };
        error.status = response.status;
        if (typeof errorData.errorCode === 'string') error.errorCode = errorData.errorCode;
        throw error;
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

async function getDataPlaneBaseUrl(tabId: string, sessionId?: string | null): Promise<string> {
    // Session-centric: try to get a ready port from sessionId first.
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
     * aborted before / during the call, the control dispatcher throws AbortError
     * instead of logging a "Sidecar gone" warning. The classic use case is a
     * useEffect cleanup that fires when the tab is closing — without this,
     * every tab close emits noisy lifecycle warnings for in-flight prewarm /
     * runtime/models requests that would have succeeded had the tab survived
     * a few more milliseconds.
     */
    signal?: AbortSignal;
}

function tabCorrelationHeaders(tabId: string, sessionId?: string | null): Record<string, string> {
    return {
        'X-MyAgents-Tab-Id': tabId,
        ...(sessionId ? { 'X-MyAgents-Session-Id': sessionId } : {}),
    };
}

/**
 * Create a Tab-scoped POST function
 * Uses Session-centric port lookup when sessionId is available
 */
function createPostJson(tabId: string, sessionIdRef: React.MutableRefObject<string | null>) {
    return async <T,>(path: string, body?: unknown, opts?: TabApiCallOptions): Promise<T> => {
        const sessionId = sessionIdRef.current;
        const response = await sessionSidecarFetch(sessionId ?? '', { type: 'tab', id: tabId }, path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...tabCorrelationHeaders(tabId, sessionId),
            },
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
        const sessionId = sessionIdRef.current;
        const response = await sessionSidecarFetch(sessionId ?? '', { type: 'tab', id: tabId }, path, {
            headers: tabCorrelationHeaders(tabId, sessionId),
            signal: opts?.signal,
        });
        return handleApiResponse<T>(response);
    };
}

/**
 * Create a Tab-scoped PUT function
 * Uses Session-centric port lookup when sessionId is available
 */
function createApiPutJson(tabId: string, sessionIdRef: React.MutableRefObject<string | null>) {
    return async <T,>(path: string, body?: unknown, opts?: TabApiCallOptions): Promise<T> => {
        const sessionId = sessionIdRef.current;
        const response = await sessionSidecarFetch(sessionId ?? '', { type: 'tab', id: tabId }, path, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...tabCorrelationHeaders(tabId, sessionId),
            },
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
        const sessionId = sessionIdRef.current;
        const response = await sessionSidecarFetch(sessionId ?? '', { type: 'tab', id: tabId }, path, {
            method: 'DELETE',
            headers: tabCorrelationHeaders(tabId, sessionId),
            signal: opts?.signal,
        });
        return handleApiResponse<T>(response);
    };
}

export default function TabProvider({
    children,
    tabId,
    agentDir,
    sessionId = null,
    sessionTitle,
    isActive,
    onGeneratingChange,
    onSessionIdChange,
    onTitleChange,
    onUnreadChange,
    claimSessionOpeningTransition,
}: TabProviderProps) {
    const initialPersistedSessionId = sessionId && !isPendingSessionId(sessionId)
        ? sessionId
        : null;
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
    const { config: appConfig, projects: configProjects } = useConfigData();
    // sendMessage is a useCallback keyed only on [tabId] (exhaustive-deps off), so
    // reading appConfig directly inside it would capture a stale render. Mirror it
    // into a ref (updated every render) so the per-send background-agent policy echo
    // reflects the user's latest Settings choice without recreating the callback.
    const appConfigRef = useRef(appConfig);
    appConfigRef.current = appConfig;
    const analyticsMetaRef = useRef({
        runtime: 'builtin' as RuntimeType,
        runtimeSource: null as RuntimeSource | null,
        agentHash: null as string | null,
    });
    // NOTE: the effect that POPULATES analyticsMetaRef lives below, after the
    // `sessionRuntime` state declaration — it depends on the session-frozen
    // runtime (cross-review C1) which isn't in scope here yet.

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
    // after the latest render commit. NOTE: because this mirror lags by a commit,
    // it must NOT be the sole basis for a synchronous "is history already loaded?"
    // decision — the chat:init clear guard additionally consults the synchronous
    // persisted restore lifecycle so a late chat:init can't wipe a just-restored
    // page before this ref catches up (#0608).
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
    // Persisted history owns the first visible frame. Seed the shell during
    // render so the synchronous cold-history replay sent on initial SSE attach
    // can never become an intermediate projection.
    const initialPersistedRestoreLifecycle: PersistedRestoreLifecycle = initialPersistedSessionId
        ? {
            phase: 'restoring',
            mode: 'initial',
            sessionId: initialPersistedSessionId,
            restoreToken: 1,
            connectionGeneration: 0,
            error: null,
        }
        : {
            phase: 'inactive',
            mode: 'initial',
            sessionId: null,
            restoreToken: 0,
            connectionGeneration: 0,
            error: null,
        };
    const [persistedRestoreLifecycle, setPersistedRestoreLifecycle] = useState<PersistedRestoreLifecycle>(
        initialPersistedRestoreLifecycle,
    );
    const persistedRestoreLifecycleRef = useRef<PersistedRestoreLifecycle>(
        initialPersistedRestoreLifecycle,
    );
    const publishPersistedRestoreLifecycle = useCallback((next: PersistedRestoreLifecycle) => {
        persistedRestoreLifecycleRef.current = next;
        setPersistedRestoreLifecycle(next);
    }, []);
    const isSessionLoading = persistedRestoreLifecycle.phase === 'restoring'
        || persistedRestoreLifecycle.phase === 'failed';
    const sessionRestoreError = persistedRestoreLifecycle.phase === 'failed'
        ? persistedRestoreLifecycle.error
        : null;
    const sessionRestoreMode = persistedRestoreLifecycle.mode;
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
    const [sessionRuntimeSource, setSessionRuntimeSource] = useState<RuntimeSource | null>(null);
    // Populate analyticsMetaRef (declared above). The session-FROZEN runtime is
    // authoritative once known — it mirrors the runtime the sidecar was actually
    // spawned with (Rust resolve_session_runtime takes precedence over agent
    // config), which is exactly what the server-side ai_turn_complete.runtime
    // reports. This is the canonical `sessionRuntime ?? agentRuntime` precedence
    // (see Chat.tsx currentRuntime). resolveEffectiveRuntime(agent config) is
    // only the pre-session / new-session fallback. Without the frozen value,
    // session_new / message_send / message_complete would diverge from
    // ai_turn_complete after a user changes an agent's runtime (cross-review C1).
    useEffect(() => {
        const agent = agentDir ? getProjectAgent(appConfig, configProjects, agentDir) : undefined;
        const runtime: RuntimeType = sessionRuntime
            ? normalizeRuntime(sessionRuntime)
            : resolveEffectiveRuntime(agent?.runtime, !!appConfig.multiAgentRuntime);
        const runtimeSource = sessionRuntime
            ? analyticsRuntimeSource(runtime, sessionRuntimeSource)
            : analyticsRuntimeSource(runtime, agent?.runtimeConfig?.source);
        const agentHash = hashAgentNameSync(agent?.name ?? null);
        analyticsMetaRef.current = { runtime, runtimeSource, agentHash };
    }, [appConfig, configProjects, agentDir, sessionRuntime, sessionRuntimeSource]);
    const [sessionMeta, setSessionMeta] = useState<SessionMetadata | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [unifiedLogs, setUnifiedLogs] = useState<LogEntry[]>([]);
    const [systemInitInfo, setSystemInitInfo] = useState<SystemInitInfo | null>(null);
    const [mcpEffectiveSnapshot, setMcpEffectiveSnapshot] = useState<McpEffectiveSnapshot | null>(null);
    const [sdkSlashCommands, setSdkSlashCommands] = useState<SlashCommand[]>([]);
    // Issue #194 — runtime diagnostics snapshot for external runtimes (Codex
    // today; Claude Code / Gemini later). Replaces the previously-hardcoded
    // `systemInitInfo.tools: []` signal with a real diagnostic surface.
    const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnostics | null>(null);
    const [agentError, setAgentError] = useState<string | null>(null);
    const [systemStatus, setSystemStatus] = useState<string | null>(null);  // e.g., 'compacting'
    const [systemNotice, setSystemNotice] = useState<SystemNotice | null>(null);
    // PRD 0.2.32 — 归一化 context 用量快照（tab-scoped）。Set on chat:context-usage,
    // cleared on session switch / reset. 见 ContextUsageIndicator。
    const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
    const liveContextUsageSessionIdRef = useRef<string | null>(null);
    const [agentPlanTodos, setAgentPlanTodos] = useState<AgentStatusTodoSnapshot[] | null>(null);
    const clearRuntimePlanTodos = useCallback(() => {
        setAgentPlanTodos(prev => prev === null ? prev : []);
    }, []);
    const [lastTerminalReason, setLastTerminalReason] = useState<TerminalReason | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
    const pendingPermission = useMemo(() => peekPermissionRequest(pendingPermissions), [pendingPermissions]);
    const [pendingAskUserQuestion, setPendingAskUserQuestion] = useState<AskUserQuestionRequest | null>(null);
    const [pendingExitPlanMode, setPendingExitPlanMode] = useState<ExitPlanModeRequest | null>(null);
    const [pendingEnterPlanMode, setPendingEnterPlanMode] = useState<EnterPlanModeRequest | null>(null);
    const getQueryElapsedSeconds = useQueryElapsedClock(
        isLoading || classifySessionActivity(sessionState) === 'active',
        Boolean(pendingPermission || pendingAskUserQuestion || (pendingExitPlanMode && !pendingExitPlanMode.resolved)),
        currentSessionId,
    );
    const [toolCompleteCount, setToolCompleteCount] = useState(0);
    const [queuedMessages, setQueuedMessages] = useState<QueuedMessageInfo[]>([]);
    const queuedMessagesRef = useRef<QueuedMessageInfo[]>([]);
    queuedMessagesRef.current = queuedMessages;

    // Track started queueIds to prevent sendMessage .then() from re-adding them
    const startedQueueIdsRef = useRef(new Set<string>());
    const previousSessionPropRef = useRef<string | null>(sessionId);

    // Sync currentSessionId when prop changes (e.g., from parent re-initializing)
    useEffect(() => {
        const previousSessionId = previousSessionPropRef.current;
        const currentSessionIdBeforePropSync = currentSessionIdRef.current;
        previousSessionPropRef.current = sessionId;
        const shouldPreservePendingBirthSnapshots = shouldPreserveSnapshotOnPendingBirthPropSync({
            previousSessionId,
            nextSessionId: sessionId,
            currentSessionIdBeforeSync: currentSessionIdBeforePropSync,
            wasPreviousSessionPending: previousSessionId ? isPendingSessionId(previousSessionId) : false,
            isNextSessionPending: sessionId ? isPendingSessionId(sessionId) : false,
        });

        currentSessionIdRef.current = sessionId;
        setCurrentSessionId(sessionId);
        // PRD 0.2.32 — clear the context 用量 ring synchronously the moment the session
        // PROP changes. Keyed on the prop (not currentSessionId) so loadSession's post-await
        // seed (which doesn't change the prop) is NOT clobbered. This fires BEFORE loadSession
        // (which may be deferred until SSE re-attach), so a cold builtin→external switch never
        // paints the previous session's ring / builtin compact button on the new session
        // (review: stale-source transient). loadSession then re-seeds from the persisted
        // lastContextUsage; new-session paths (reset/adopt) also clear explicitly for immediacy.
        liveContextUsageSessionIdRef.current = null;
        setContextUsage(null);
        if (!shouldPreservePendingBirthSnapshots) {
            setAgentPlanTodos(null);
            setSdkSlashCommands([]);
            setSystemInitInfo(null);
            setMcpEffectiveSnapshot(null);
        }
    }, [sessionId]);

    // Store callbacks in refs to avoid triggering effects on every render
    const onGeneratingChangeRef = useRef(onGeneratingChange);
    onGeneratingChangeRef.current = onGeneratingChange;
    const onSessionIdChangeRef = useRef(onSessionIdChange);
    onSessionIdChangeRef.current = onSessionIdChange;
    const onTitleChangeRef = useRef(onTitleChange);
    onTitleChangeRef.current = onTitleChange;
    const currentSessionTitleRef = useRef(sessionTitle);
    currentSessionTitleRef.current = sessionTitle;
    type FirstUserTitleProjection = 'established' | {
        messageId: string;
        title: string;
    } | null;
    // The SessionStore owns the persisted default title, but the active Tab is
    // a live App-shell projection. Keep one Tab-local marker so a provisional
    // accepted-user echo can be compensated by chat:messages-retracted without
    // ever replacing a newer manual/AI title.
    const firstUserTitleProjectionRef = useRef<FirstUserTitleProjection>(null);
    const projectAcceptedFirstUserTitle = useCallback((params: {
        content: unknown;
        messageId: string;
    }) => {
        if (firstUserTitleProjectionRef.current !== null) return;
        if (historyMessagesRef.current.some(message => (
            message.role === 'user'
            && typeof message.content === 'string'
            && Boolean(deriveSessionTitle(message.content, 40))
        ))) {
            firstUserTitleProjectionRef.current = 'established';
            return;
        }
        if (typeof params.content !== 'string') return;
        const title = deriveSessionTitle(params.content, 40);
        if (!title) return;
        firstUserTitleProjectionRef.current = {
            messageId: params.messageId,
            title,
        };
        currentSessionTitleRef.current = title;
        onTitleChangeRef.current?.(title);
    }, []);
    const onUnreadChangeRef = useRef(onUnreadChange);
    onUnreadChangeRef.current = onUnreadChange;
    // Ref for isActive to avoid stale closures in SSE event handlers
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;

    // Auto-title generation is backend-owned (#296): the sidecar triggers it
    // after a successful turn and pushes the result via the
    // `chat:session-title-changed` SSE event (handled below). The frontend does
    // not accumulate rounds or decide AI-title policy. It only projects the
    // shared deterministic first-query title at the accepted-user boundary and
    // displays later backend title changes.

    // Notify parent when generating state changes (for close confirmation)
    useEffect(() => {
        onGeneratingChangeRef.current?.(isLoading);
    }, [isLoading]);

    // Refs for SSE handling
    const sseRef = useRef<SseConnection | null>(null);
    // The sessionId owned by the currently attached SSE subscription. App.tsx can
    // switch a tab to a new Session Sidecar without remounting this provider,
    // so attachment must be scoped to THIS session independently of transport liveness.
    const attachedSseSessionIdRef = useRef<string | null>(null);
    const sseReconnectGenerationRef = useRef(0);
    const liveRevisionFenceRef = useRef<LiveRevisionFence>(
        initialPersistedSessionId
            ? {
                sessionId: initialPersistedSessionId,
                connectionGeneration: 0,
                restoreToken: 1,
                restoring: true,
                lastAppliedRevision: null,
                buffered: [],
            }
            : { ...EMPTY_LIVE_REVISION_FENCE },
    );
    const requestLiveRestoreRef = useRef<(
        sessionId: string,
        restoreToken: number,
        mode?: PersistedRestoreMode,
        gapRecoveryAttempted?: boolean,
    ) => void>(() => {});
    const activeRestoreRequestRef = useRef<{
        sessionId: string;
        restoreToken: number;
        connectionGeneration: number;
        controller: AbortController;
    } | null>(null);
    const abortActiveRestoreRequest = useCallback(() => {
        activeRestoreRequestRef.current?.controller.abort();
        activeRestoreRequestRef.current = null;
    }, []);
    const beginPersistedRestore = useCallback((
        targetSessionId: string,
        connectionGeneration: number,
        mode: PersistedRestoreMode,
    ): LiveRevisionFence => {
        abortActiveRestoreRequest();
        const fence = beginLiveRevisionRestore(
            liveRevisionFenceRef.current,
            targetSessionId,
            connectionGeneration,
        );
        liveRevisionFenceRef.current = fence;
        publishPersistedRestoreLifecycle({
            phase: 'restoring',
            mode,
            sessionId: targetSessionId,
            restoreToken: fence.restoreToken,
            connectionGeneration,
            error: null,
        });
        return fence;
    }, [abortActiveRestoreRequest, publishPersistedRestoreLifecycle]);
    const isStreamingRef = useRef(false);
    // Tracks whether the authoritative backend session state is starting/running.
    // Separate from isStreamingRef which means "a streaming message exists in React state".
    // Used to prevent loadSession from running during pending→real session ID upgrade.
    const isSessionActiveRef = useRef(false);

    /**
     * Clear all session-active state. Called when the session finishes, errors, or resets.
     *
     * WHY THIS EXISTS (pit-of-success):
     * isStreamingRef ("streaming message exists in React") and isSessionActiveRef ("backend is
     * processing") have identical clear-time but different set-time. isStreamingRef is set by the
     * first message-chunk (via flushSync), while isSessionActiveRef is set by chat:status or the
     * REST live-session snapshot (before any chunks). They MUST be cleared together — if one is
     * forgotten, either loadSession runs during active sessions (disrupts streaming) or loadSession
     * is permanently blocked (stale ref).
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
    const isPersistedRestoreInFlight = useCallback(() => (
        persistedRestoreLifecycleRef.current.phase === 'restoring'
    ), []);
    const restoredPersistedSessionId = useCallback(() => {
        const restore = persistedRestoreLifecycleRef.current;
        return restore.phase === 'ready' ? restore.sessionId : null;
    }, []);
    // A supported persisted-history navigation normally mounts a target-bound
    // Tab. This layout guard also covers a future prop replacement without
    // reopening the old mutable-runtime switch path. Reset and pending births
    // remain SSE-native under their existing owner markers.
    useLayoutEffect(() => {
        const previousSessionId = previousSessionPropRef.current;
        if (previousSessionId === sessionId) return;

        abortActiveRestoreRequest();
        if (!sessionId || isPendingSessionId(sessionId)) {
            liveRevisionFenceRef.current = {
                ...EMPTY_LIVE_REVISION_FENCE,
                restoreToken: liveRevisionFenceRef.current.restoreToken + 1,
            };
            publishPersistedRestoreLifecycle({
                phase: 'inactive',
                mode: 'initial',
                sessionId: null,
                restoreToken: liveRevisionFenceRef.current.restoreToken,
                connectionGeneration: 0,
                error: null,
            });
            return;
        }

        const isSseNativeBirth = isPendingSessionId(previousSessionId)
            || isResetSessionBirth({
                resetBirthSessionId: resetBirthSessionIdRef.current,
                sessionId,
        });
        if (isSseNativeBirth) {
            publishPersistedRestoreLifecycle({
                phase: 'inactive',
                mode: 'initial',
                sessionId,
                restoreToken: liveRevisionFenceRef.current.restoreToken,
                connectionGeneration: liveRevisionFenceRef.current.connectionGeneration,
                error: null,
            });
            return;
        }

        beginPersistedRestore(
            sessionId,
            sseRef.current?.getConnectionGeneration() ?? 0,
            'initial',
        );
    }, [sessionId, abortActiveRestoreRequest, beginPersistedRestore, publishPersistedRestoreLifecycle]);
    // Ref for cron task exit handler (set by useCronTask hook via context)
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
        relativePath?: string;
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
        setPendingPermissions([]);
        setPendingAskUserQuestion(null);
        setPendingExitPlanMode(null);
        setPendingEnterPlanMode(null);
        setQueuedMessages([]);
        startedQueueIdsRef.current.clear();
        clearAllBackgroundTaskStatuses(currentSessionIdRef.current);
    }, []);

    // Reset pagination state (firstItemIndex + hasMoreBefore + in-flight guard)
    // on any boundary where historyMessages is cleared or replaced without a
    // subsequent persisted restore: resetSession, chat:init SSE-reconnect clear
    // path, and as a fallback for places that drop history. The REST restore has its own
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
        abortActiveRestoreRequest();
        const titleBeforeReset = currentSessionTitleRef.current;
        const titleProjectionBeforeReset = firstUserTitleProjectionRef.current;
        const restoreTitleAfterRejectedReset = () => {
            if (currentSessionTitleRef.current === 'New Chat' && titleBeforeReset) {
                currentSessionTitleRef.current = titleBeforeReset;
                firstUserTitleProjectionRef.current = titleProjectionBeforeReset;
                onTitleChangeRef.current?.(titleBeforeReset);
                return;
            }
            // A manual/AI title may have landed while reset was pending. Keep it
            // authoritative instead of restoring the older projection.
            firstUserTitleProjectionRef.current = currentSessionTitleRef.current === 'New Chat'
                ? titleProjectionBeforeReset
                : 'established';
        };

        // 1. Clear frontend state immediately for responsive UI
        setHistoryMessages([]);
        resetPaginationState();
        setStreamingMessage(null);
        liveContextUsageSessionIdRef.current = null;
        setContextUsage(null);  // PRD 0.2.32 — 新会话无持久占用；仅清展示态（不碰后端持久数据）
        setAgentPlanTodos(null);
        setSdkSlashCommands([]);
        seenIdsRef.current.clear();
        liveRevisionFenceRef.current = {
            ...EMPTY_LIVE_REVISION_FENCE,
            restoreToken: liveRevisionFenceRef.current.restoreToken + 1,
        };
        publishPersistedRestoreLifecycle({
            phase: 'inactive',
            mode: 'initial',
            sessionId: null,
            restoreToken: liveRevisionFenceRef.current.restoreToken,
            connectionGeneration: 0,
            error: null,
        });
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
        setSystemNotice(null);
        setAgentError(null);
        setLastTerminalReason(null);
        setUnifiedLogs([]);
        setLogs([]);
        setSessionMeta(null);
        setSessionRuntimeSource(null);
        setSystemInitInfo(null);
        setMcpEffectiveSnapshot(null);
        // Issue #194 (Codex review #6) — clear runtime diagnostics on reset so
        // a stale Codex banner from the previous session doesn't leak into a
        // new one (or a Tab that just switched to builtin runtime).
        setRuntimeDiagnostics(null);
        clearInteractiveState();
        // NOTE: Do NOT clear currentSessionId here. The old session ID is the only way
        // to find the ready sidecar port for the /chat/reset call. Once the backend
        // returns its freshly-minted sessionId we adopt it immediately; chat:system-init
        // remains the fallback confirmation path.

        // Reset tab title so SortableTabItem falls back to folder name
        currentSessionTitleRef.current = 'New Chat';
        onTitleChangeRef.current?.('New Chat');

        // 2. Tell backend to reset (this will also broadcast chat:init)
        try {
            const response = await postJson<{ success: boolean; sessionId?: string; error?: string }>('/chat/reset');
            if (!response.success) {
                isNewSessionRef.current = false;
                resetBirthPendingRef.current = false;
                resetBirthSessionIdRef.current = null;
                restoreTitleAfterRejectedReset();
                console.error(`[TabProvider ${tabId}] resetSession failed:`, response.error);
                return false;
            }
            if (response.sessionId) {
                resetBirthSessionIdRef.current = response.sessionId;
                if (currentSessionIdRef.current !== response.sessionId) {
                    const previousSessionId = currentSessionIdRef.current;
                    console.log(`[TabProvider ${tabId}] resetSession adopting backend sessionId: ${previousSessionId ?? 'none'} -> ${response.sessionId}`);
                    const relabeledAttachment = Boolean(
                        sseRef.current?.isActive() &&
                        attachedSseSessionIdRef.current === previousSessionId
                    );
                    if (relabeledAttachment) {
                        attachedSseSessionIdRef.current = response.sessionId;
                    }
                    currentSessionIdRef.current = response.sessionId;
                    setCurrentSessionId(response.sessionId);
                    let changed: boolean | void;
                    try {
                        changed = await onSessionIdChangeRef.current?.(response.sessionId);
                    } catch (error) {
                        if (currentSessionIdRef.current === response.sessionId) {
                            currentSessionIdRef.current = previousSessionId;
                            setCurrentSessionId(previousSessionId);
                        }
                        if (relabeledAttachment && attachedSseSessionIdRef.current === response.sessionId) {
                            attachedSseSessionIdRef.current = previousSessionId;
                        }
                        throw error;
                    }
                    if (changed === false) {
                        if (currentSessionIdRef.current === response.sessionId) {
                            currentSessionIdRef.current = previousSessionId;
                            setCurrentSessionId(previousSessionId);
                        }
                        if (relabeledAttachment && attachedSseSessionIdRef.current === response.sessionId) {
                            attachedSseSessionIdRef.current = previousSessionId;
                        }
                        isNewSessionRef.current = false;
                        resetBirthPendingRef.current = false;
                        resetBirthSessionIdRef.current = null;
                        restoreTitleAfterRejectedReset();
                        console.error(`[TabProvider ${tabId}] resetSession failed to upgrade parent session id to ${response.sessionId}`);
                        return false;
                    }
                }
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
            firstUserTitleProjectionRef.current = null;
            setPendingSessionBirth(tabId, birthContextForSurface('new_chat_button'));

            return true;
        } catch (error) {
            isNewSessionRef.current = false;
            resetBirthPendingRef.current = false;
            resetBirthSessionIdRef.current = null;
            restoreTitleAfterRejectedReset();
            console.error(`[TabProvider ${tabId}] resetSession error:`, error);
            return false;
        }
    }, [tabId, postJson, setStreamingMessage, clearInteractiveState, clearSessionActive, resetPaginationState, abortActiveRestoreRequest, publishPersistedRestoreLifecycle]);

    /**
     * Local-only session swap for the IM-handover "新对话保留绑定" flow.
     *
     * The Rust handover (`cmd_session_new_with_surface_migration`) has already
     * migrated the exact Tab + Agent owners and minted `newSessionId` through
     * the surface-migration endpoint. Calling resetSession()
     * here would post `/chat/reset` and mint a SECOND id — leaving the binding
     * pointing at the migrate-minted id while the tab adopts the second mint
     * (the v0.2.14 "tag disappears after 新对话" bug).
     *
     * This helper does the local UI clear (mirrors resetSession step 1) and
     * notifies the parent to update Tab.sessionId. The session-aware SSE
     * useEffect re-labels the same owner-resolved subscription; no backend call
     * or transport replacement is made.
     */
    const adoptMigratedSession = useCallback(async (newSessionId: string, options?: AdoptMigratedSessionOptions): Promise<boolean> => {
        const previousSessionId = currentSessionIdRef.current;
        console.log(`[TabProvider ${tabId}] adoptMigratedSession: ${previousSessionId?.slice(0, 8) ?? 'none'} → ${newSessionId.slice(0, 8)}`);
        abortActiveRestoreRequest();

        // Suppress the chat:init that the migrate already broadcast on the
        // sidecar — we're treating the new session as "freshly created here"
        // even though it came from Rust, to keep the same race-free guard
        // resetSession uses.
        isNewSessionRef.current = true;
        resetBirthPendingRef.current = false;

        // Mirror resetSession's local clear (kept in lockstep to avoid drift).
        setHistoryMessages([]);
        resetPaginationState();
        setStreamingMessage(null);
        liveContextUsageSessionIdRef.current = null;
        setContextUsage(null);  // PRD 0.2.32 — 新会话无持久占用；仅清展示态（不碰后端持久数据）
        setAgentPlanTodos(null);
        setSdkSlashCommands([]);
        seenIdsRef.current.clear();
        liveRevisionFenceRef.current = {
            ...EMPTY_LIVE_REVISION_FENCE,
            restoreToken: liveRevisionFenceRef.current.restoreToken + 1,
        };
        publishPersistedRestoreLifecycle({
            phase: 'inactive',
            mode: 'initial',
            sessionId: null,
            restoreToken: liveRevisionFenceRef.current.restoreToken,
            connectionGeneration: 0,
            error: null,
        });
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
        setSystemNotice(null);
        setAgentError(null);
        setLastTerminalReason(null);
        setUnifiedLogs([]);
        setLogs([]);
        setSessionMeta(null);
        firstUserTitleProjectionRef.current = null;
        setSessionRuntimeSource(null);
        clearInteractiveState();

        // Reset tab title so SortableTabItem falls back to folder name.
        currentSessionTitleRef.current = 'New Chat';
        onTitleChangeRef.current?.('New Chat');

        const relabeledAttachment = Boolean(
            sseRef.current?.isActive() &&
            attachedSseSessionIdRef.current === previousSessionId
        );
        if (relabeledAttachment) {
            attachedSseSessionIdRef.current = newSessionId;
        }
        // This marker is only the one-shot birth/history expectation. Transport
        // ownership was already relabeled above and never consults this ref.
        resetBirthSessionIdRef.current = newSessionId;
        // Rust/backend already accepted the migration. Move the business
        // identity together with the attachment before yielding to App so sends
        // and scoped events cannot observe an A/B split during parent adoption.
        currentSessionIdRef.current = newSessionId;
        setCurrentSessionId(newSessionId);
        let changed: boolean | void;
        try {
            changed = await onSessionIdChangeRef.current?.(newSessionId, options);
        } catch (error) {
            resetBirthSessionIdRef.current = null;
            if (currentSessionIdRef.current === newSessionId) {
                currentSessionIdRef.current = previousSessionId;
                setCurrentSessionId(previousSessionId);
            }
            if (relabeledAttachment && attachedSseSessionIdRef.current === newSessionId) {
                attachedSseSessionIdRef.current = previousSessionId;
            }
            throw error;
        }
        if (changed === false) {
            resetBirthSessionIdRef.current = null;
            if (currentSessionIdRef.current === newSessionId) {
                currentSessionIdRef.current = previousSessionId;
                setCurrentSessionId(previousSessionId);
            }
            if (relabeledAttachment && attachedSseSessionIdRef.current === newSessionId) {
                attachedSseSessionIdRef.current = previousSessionId;
            }
            console.error(`[TabProvider ${tabId}] adoptMigratedSession aborted: parent refused session id change to ${newSessionId}`);
            return false;
        }
        return true;
    }, [tabId, setStreamingMessage, clearInteractiveState, clearSessionActive, resetPaginationState, abortActiveRestoreRequest, publishPersistedRestoreLifecycle]);

    const trackSessionNewForBirth = useCallback((
        newSessionId: string,
        fallback: PendingSessionBirthContext,
        runtimeOverride?: RuntimeType,
        runtimeSourceOverride?: RuntimeSource | null,
    ) => {
        const birth = consumePendingSessionBirth(tabId, fallback);
        const meta = analyticsMetaRef.current;
        const runtime = runtimeOverride ?? meta.runtime;
        const runtimeSource = runtimeSourceOverride !== undefined
            ? analyticsRuntimeSource(runtime, runtimeSourceOverride)
            : meta.runtimeSource;
        const origin = originFromDesktopSurface(birth.surface);
        const originFields = originAnalyticsFields(origin);
        track('session_new', {
            session_id: newSessionId,
            tab_id: tabId,
            triggered_by: birth.surface,
            ...originFields,
            entry_intent: birth.entryIntent,
            runtime,
            runtime_source: runtimeSource,
            has_initial_message: birth.hasInitialMessage,
            assistant_entry: birth.assistantEntry,
            agent_hash: meta.agentHash,
        });
        void updateSession(newSessionId, { origin }).catch((error) => {
            console.warn(`[TabProvider] Failed to persist origin for session ${newSessionId}:`, error);
        });
    }, [tabId]);

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

    // Pattern 6 (FIXED): Chat tab registry for renderer correlation. App.tsx
    // owns the active tab across Launcher / Settings / TaskCenter / Chat; each
    // TabProvider only contributes mounted Chat tab context and the fallback
    // focused pointer used when App has not synced yet.
    useEffect(() => {
        setCurrentTabId(tabId, true);
        setActiveCorrelation({ tabId, mounted: true });

        const handleVisibility = (): void => {
            if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
                // The browser/Tauri webview only has one "visible" state per
                // window. Promote this mounted Chat tab as the fallback focused
                // pointer; App-level active-tab sync remains authoritative.
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
    const moveStreamingToHistory = useCallback((
        status: 'completed' | 'stopped' | 'failed',
        completionPatch?: AssistantCompletionPatch,
    ) => {
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

            let finalMsg = finalizeAssistantForHistory(prev, status);

            finalMsg = finalizeMessageSubagentProjection(finalMsg, status);

            finalMsg = applyAssistantCompletionPatch(finalMsg, completionPatch);

            // Side effect inside updater — technically impure, but safe because:
            // (1) StrictMode is off (no double invocation), (2) same pattern as setMessages (line 243).
            setHistoryMessages(prevHistory => {
                seenIdsRef.current.add(finalMsg.id);
                return upsertMessageById(prevHistory, finalMsg);
            });
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
            setSystemNotice(null);
            clearRuntimePlanTodos();
        });
    }, [moveStreamingToHistory, clearSessionActive, clearRuntimePlanTodos]);

    const shouldAcceptInteractiveEvent = useCallback((payloadSessionId?: string | null): boolean => {
        if (!payloadSessionId) return true;
        const currentId = currentSessionIdRef.current;
        const connectedId = attachedSseSessionIdRef.current;
        return shouldAcceptSessionScopedSseSnapshot({
            connectedSessionId: connectedId,
            currentSessionId: currentId,
            payloadSessionId,
            isConnectedSessionPending: connectedId ? isPendingSessionId(connectedId) : false,
            isCurrentSessionPending: currentId ? isPendingSessionId(currentId) : false,
        });
    }, []);

    // Handle SSE events
    const applySseEvent = useCallback((eventName: string, data: unknown) => {
        switch (eventName) {
            case 'chat:init': {
                const initPayload = data as {
                    sessionId?: string | null;
                    sessionState?: SessionState;
                    liveStreamingMessage?: WireSessionMessage | null;
                } | null;
                const payloadSessionId = initPayload?.sessionId ?? null;
                if (payloadSessionId && !shouldAcceptSessionScopedSseSnapshot({
                    connectedSessionId: attachedSseSessionIdRef.current,
                    currentSessionId: currentSessionIdRef.current,
                    payloadSessionId,
                    isConnectedSessionPending: attachedSseSessionIdRef.current
                        ? isPendingSessionId(attachedSseSessionIdRef.current)
                        : false,
                    isCurrentSessionPending: currentSessionIdRef.current
                        ? isPendingSessionId(currentSessionIdRef.current)
                        : false,
                })) {
                    break;
                }
                // chat:init is sent on SSE connect/reconnect
                // A reset already cleared its local projection, so preserve that
                // boundary while still adopting the scoped live snapshot below.
                const shouldPreserveResetProjection = isNewSessionRef.current;

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
                // already completed its persisted restore lifecycle.
                // With the history-length guard, any session the user can see
                // on screen stays on screen; the only scenario that still clears
                // is "first-ever chat:init before any history loaded", which is
                // exactly the case where the clear is correct (no-op on empty).
                if (!shouldPreserveResetProjection && shouldClearHistoryOnInit({
                    isLoadingSession: isPersistedRestoreInFlight(),
                    historyLength: historyMessagesRef.current.length,
                    restoredSessionId: restoredPersistedSessionId(),
                    currentSessionId: currentSessionIdRef.current,
                })) {
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
                    setSystemNotice(null);
                    setAgentPlanTodos(null);
                    clearInteractiveState();
                }

                // Sync isLoading with backend state on SSE connect/reconnect
                // When backend reports 'idle', unconditionally reset frontend loading state.
                // This catches: (1) message-complete lost during connection issues,
                // (2) Tab joining a sidecar whose query already finished (no streaming ref set).
                if (initPayload?.sessionState) {
                    setSessionState(initPayload.sessionState);
                    if (initPayload.sessionState === 'idle') {
                        clearSessionActive();
                        setIsLoading(false);
                        setSystemStatus(null);
                        clearRuntimePlanTodos();
                    } else if (classifySessionActivity(initPayload.sessionState) === 'active') {
                        isSessionActiveRef.current = true;
                        setIsLoading(true);
                    }
                }

                if (initPayload && Object.hasOwn(initPayload, 'liveStreamingMessage')) {
                    pendingTextRef.current = '';
                    if (revealRafRef.current != null) {
                        cancelAnimationFrame(revealRafRef.current);
                        revealRafRef.current = null;
                    }
                    revealAccRef.current = 0;
                    revealLastRef.current = 0;
                    const liveStreamingMessage = wireAssistantToStreamingMessage(initPayload.liveStreamingMessage);
                    const isLiveActive = initPayload.sessionState
                        ? classifySessionActivity(initPayload.sessionState) === 'active'
                        : false;
                    if (liveStreamingMessage && isLiveActive) {
                        isStreamingRef.current = true;
                        adoptedStreamRef.current = true;
                        streamingMessageRef.current = liveStreamingMessage;
                        setStreamingMessage(liveStreamingMessage);
                    } else {
                        isStreamingRef.current = false;
                        adoptedStreamRef.current = false;
                        streamingMessageRef.current = null;
                        setStreamingMessage(null);
                    }
                }
                break;
            }

            case 'chat:message-replay': {
                const payload = data as ChatMessageReplayPayload<WireSessionMessage> | null;
                if (!payload?.message) break;
                const msg = payload.message;
                // `chat:message-replay` is OVERLOADED: the SSE-connect backfill carries
                // replayKind:'cold-history' (the whole in-memory transcript), while a
                // freshly-sent user / command bubble arrives on the SAME event tagged
                // replayKind:'live-user-echo' with its source session id (the chat
                // bubble's authoritative render path, see agent-session.ts). Skip when
                // a new session is being born or
                // loadSession is in flight (both guard the cold-history race); ADDITIONALLY
                // skip COLD-HISTORY for a REST-restored session (REST owns the ordered,
                // paginated history — older pages come via ?before=). A LIVE echo must
                // ALWAYS render, else a new user message vanishes after a restore (#0608
                // Codex review).
                const isColdHistoryReplay = payload.replayKind === COLD_HISTORY_REPLAY_KIND;
                const currentIdForReplay = currentSessionIdRef.current;
                const connectedIdForReplay = attachedSseSessionIdRef.current;
                const isExplicitLiveEcho = payload.replayKind === LIVE_USER_ECHO_REPLAY_KIND;
                const isCurrentSessionReplay = Boolean(payload.sessionId)
                    && shouldAcceptSessionScopedSseSnapshot({
                        connectedSessionId: connectedIdForReplay,
                        currentSessionId: currentIdForReplay,
                        payloadSessionId: payload.sessionId,
                        isConnectedSessionPending: connectedIdForReplay ? isPendingSessionId(connectedIdForReplay) : false,
                        isCurrentSessionPending: currentIdForReplay ? isPendingSessionId(currentIdForReplay) : false,
                    });
                if (isExplicitLiveEcho && !shouldAcceptLiveTurnEvent({
                    isNewSession: isNewSessionRef.current,
                    payloadSessionId: payload.sessionId ?? null,
                    isCurrentSessionScope: isCurrentSessionReplay,
                })) {
                    break;
                }
                const isResetBirthReplayPending =
                    resetBirthPendingRef.current &&
                    (
                        resetBirthSessionIdRef.current === null ||
                        resetBirthSessionIdRef.current === currentSessionIdRef.current
                    );
                if (shouldSkipHistoryReplay({
                    isNewSession: isNewSessionRef.current,
                    isLoadingSession: isPersistedRestoreInFlight(),
                    isColdHistoryReplay,
                    isCurrentSessionReplay,
                    isResetBirthPending: isResetBirthReplayPending,
                    restoredSessionId: restoredPersistedSessionId(),
                    currentSessionId: currentSessionIdRef.current,
                })) {
                    break;
                }
                if (isNewSessionRef.current && isCurrentSessionReplay) {
                    // A session-stamped live echo or reconnect snapshot is the
                    // ordered boundary between stale pre-reset events and B.
                    isNewSessionRef.current = false;
                }
                if (seenIdsRef.current.has(msg.id)) break;
                seenIdsRef.current.add(msg.id);

                if (isExplicitLiveEcho && msg.role === 'user') {
                    // This is the authoritative admission signal for an IM turn.
                    // A terminal error belongs to the previous turn and must not
                    // remain beside the newly-admitted message/model selection.
                    setAgentError(null);
                    projectAcceptedFirstUserTitle({
                        content: msg.content,
                        messageId: msg.id,
                    });
                }

                let attachments = normalizeWireAttachments(msg.attachments);
                if (msg.role === 'user' && pendingAttachmentsRef.current) {
                    attachments = mergeAttachmentPreviews(attachments, pendingAttachmentsRef.current);
                    pendingAttachmentsRef.current = null;
                }

                // Replayed assistant messages are completed — mark thinking blocks as isComplete
                // so the UI doesn't show a spinner on them.
                let replayContent = normalizeSessionMessageContent(msg.content);
                if (msg.role === 'assistant' && Array.isArray(replayContent)) {
                    const needsPatch = replayContent.some(b => b.type === 'thinking' && !b.isComplete);
                    if (needsPatch) {
                        replayContent = replayContent.map(b =>
                            b.type === 'thinking' && !b.isComplete ? { ...b, isComplete: true } : b
                        );
                    }
                }

                const replayMessage: Message = {
                    id: msg.id,
                    role: msg.role,
                    content: replayContent,
                    timestamp: new Date(msg.timestamp),
                    sdkUuid: msg.sdkUuid,
                    runtimeTurnAnchor: msg.runtimeTurnAnchor,
                    attachments,
                    metadata: msg.metadata,
                    ...getAssistantTurnMetrics(msg),
                };
                setHistoryMessages(prev => appendUniqueMessageById(prev, replayMessage));
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

            case 'chat:messages-retracted': {
                // SDK refusal-fallback retraction (0.3.162+). Two id spaces:
                // RESTORED-history bubbles carry server messageSequence ids →
                // evicted via the id list. LIVE bubbles carry client Date.now()
                // ids that never match server ids mid-turn (same reason
                // message-complete piggybacks assistant_message_id), so the
                // refused streaming bubble is evicted via the server-computed
                // retractedStreamingTail flag instead. Idempotent — unknown
                // ids no-op, and the no-op path preserves array identity so
                // Virtuoso doesn't reconcile an identical list.
                const payload = data as { messageIds?: string[]; retractedStreamingTail?: boolean } | null;
                const ids = payload?.messageIds;
                if (ids && ids.length > 0) {
                    const idSet = new Set(ids);
                    const titleProjection = firstUserTitleProjectionRef.current;
                    if (
                        titleProjection !== null
                        && titleProjection !== 'established'
                        && idSet.has(titleProjection.messageId)
                    ) {
                        if (currentSessionTitleRef.current === titleProjection.title) {
                            currentSessionTitleRef.current = 'New Chat';
                            firstUserTitleProjectionRef.current = null;
                            onTitleChangeRef.current?.('New Chat');
                        } else {
                            // A newer manual/AI title superseded the provisional
                            // first-query projection before the rejection arrived.
                            firstUserTitleProjectionRef.current = 'established';
                        }
                    }
                    setHistoryMessages(prev =>
                        prev.some(m => idSet.has(m.id)) ? prev.filter(m => !idSet.has(m.id)) : prev
                    );
                }
                if (payload?.retractedStreamingTail) {
                    setStreamingMessage(null);
                    isStreamingRef.current = false;
                    // Un-revealed refused text must not leak into the
                    // replacement bubble (mirrors the reset-callback reveal
                    // cleanup; loop-stop inlined for the same TDZ reason).
                    pendingTextRef.current = '';
                    if (revealRafRef.current != null) { cancelAnimationFrame(revealRafRef.current); revealRafRef.current = null; }
                    revealAccRef.current = 0;
                    revealLastRef.current = 0;
                }
                break;
            }

            case 'chat:status': {
                const payload = data as { sessionState: SessionState } | null;
                if (payload?.sessionState) {
                    const nextSessionState = payload.sessionState;
                    const activity = classifySessionActivity(nextSessionState);
                    setSessionState(nextSessionState);
                    if (activity === 'terminal') {
                        // Terminal backend state always converges both refs and
                        // loading, including cached error snapshots on reconnect.
                        clearSessionActive();
                        setIsLoading(false);
                        setSystemStatus(null);
                        clearRuntimePlanTodos();
                    } else if (activity === 'active') {
                        isSessionActiveRef.current = true;
                        // Session is busy (subprocess starting up or actively
                        // processing). This can arrive before any streaming
                        // event when a Tab connects
                        // mid-flight (e.g., IM session in progress) and
                        // receives a replayed chat:status from the SSE
                        // last-value cache, or during the (issue #174)
                        // startup-timeout window where the SDK subprocess is
                        // alive but system_init hasn't arrived. Status owns
                        // loading so the UI shows it instead of action
                        // buttons; the 'starting' branch lets MessageList
                        // render a distinct "AI 启动中" hint.
                        setIsLoading(true);
                    }
                }
                break;
            }

            case 'chat:system-status': {
                // System status from SDK (e.g., 'compacting' for context compression)
                const payload = data as {
                    status: string | null;
                    compactResult?: 'success' | 'failed';
                    compactError?: string;
                } | null;
                setSystemStatus(payload?.status ?? null);
                if (payload?.compactResult === 'success') {
                    setSystemNotice({
                        kind: 'compact',
                        level: 'success',
                        message: appText('tabProvider.compactSuccess'),
                    });
                } else if (payload?.compactResult === 'failed') {
                    const message = payload.compactError?.trim() || appText('tabProvider.compactFailed');
                    setSystemNotice({
                        kind: 'compact',
                        level: 'error',
                        message,
                    });
                    setAgentError(message);
                }
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
                const { index, toolId, type: blockType, input: finalInput, inputRef } = data as {
                    index: number;
                    toolId?: string;
                    type?: string;
                    input?: Record<string, unknown>;
                    inputRef?: unknown;
                };
                // Pattern 3 §3.2.2 — drain RAF-batched tool-input deltas for this
                // tool block before applying the final JSON.parse on the
                // accumulated inputJson; otherwise the terminal parse races
                // against pending fragments.
                if (toolId && pendingToolInputDeltasRef.current.has(toolId)) {
                    if (!finalInput && !inputRef) flushPendingToolInputDelta(toolId);
                    pendingToolInputDeltasRef.current.delete(toolId);
                }
                if (toolId && inputRef) {
                    const targetSessionId = currentSessionIdRef.current;
                    void getDataPlaneBaseUrl(tabId, targetSessionId)
                        .then((baseUrl) => fetchJsonLargeValueRef(
                            baseUrl,
                            inputRef,
                        ))
                        .then((resolvedInput) => {
                            if (currentSessionIdRef.current !== targetSessionId) return;
                            setStreamingMessage(prev => prev
                                ? replaceFinalToolInput(prev, toolId, resolvedInput)
                                : prev);
                            setHistoryMessages(prev => prev.map(
                                message => replaceFinalToolInput(message, toolId, resolvedInput),
                            ));
                        })
                        .catch((err) => console.error('[TabProvider] Failed to resolve final tool input ref:', err));
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
                        if (isToolBlock(block) && block.tool && finalInput) {
                            return replaceFinalToolInput(prev, toolId ?? block.tool.id, finalInput);
                        }
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
                    compact_result?: 'success';
                    runtime_turn_anchor?: Message['runtimeTurnAnchor'];
                } | null;
                const inputTokens = normalizeFiniteNumber(completePayload?.input_tokens);
                const outputTokens = normalizeFiniteNumber(completePayload?.output_tokens);
                const cacheReadTokens = normalizeFiniteNumber(completePayload?.cache_read_tokens);
                const cacheCreationTokens = normalizeFiniteNumber(completePayload?.cache_creation_tokens);
                const hasUsagePayload =
                    inputTokens !== undefined ||
                    outputTokens !== undefined ||
                    cacheReadTokens !== undefined ||
                    cacheCreationTokens !== undefined;
                const completedUsage: Message['usage'] | undefined = hasUsagePayload
                    ? {
                        inputTokens: inputTokens ?? 0,
                        outputTokens: outputTokens ?? 0,
                        cacheReadTokens,
                        cacheCreationTokens,
                        model: completePayload?.model,
                    }
                    : undefined;
                const completedToolCount = normalizeFiniteNumber(completePayload?.tool_count);
                const completedDurationMs = normalizeTurnDurationMs(completePayload?.duration_ms);
                const completionPatch: AssistantCompletionPatch | undefined =
                    completePayload?.assistant_sdk_uuid ||
                    completePayload?.assistant_message_id ||
                    completedUsage ||
                    completedToolCount !== undefined ||
                    completedDurationMs !== undefined ||
                    completePayload?.runtime_turn_anchor
                        ? {
                            sdkUuid: completePayload?.assistant_sdk_uuid,
                            realId: completePayload?.assistant_message_id,
                            usage: completedUsage,
                            toolCount: completedToolCount,
                            durationMs: completedDurationMs,
                            runtimeTurnAnchor: completePayload?.runtime_turn_anchor,
                        }
                        : undefined;
                // Pattern 3 §3.2.2 — drain all pending RAF-batched tool deltas
                // before finalising the message; otherwise stragglers would
                // land on a freshly-cleared streaming slot.
                flushAllPendingToolDeltas();
                flushSync(() => {
                    // NOTE: isStreamingRef.current is set to false inside moveStreamingToHistory's
                    // updater, NOT here. Setting it here would cause pending message-chunk updaters
                    // (queued by React batching) to see false and create a new message instead
                    // of appending, losing the accumulated content.
                    moveStreamingToHistory('completed', completionPatch);
                    // Finalize the message in the same synchronous commit as the loading-state
                    // cleanup so ultra-short one-chunk responses do not disappear between batches.
                    setIsLoading(false);
                    setSessionState('idle');  // Reset session state to idle
                    setSystemStatus(null);  // Clear system status (e.g., 'compacting') when message completes
                    clearRuntimePlanTodos();
                    // Do NOT clear agentError here — chat:agent-error is only emitted for terminal,
                    // unrecoverable errors (rate_limit, auth fail, SDK is_error result, timeouts).
                    // Clearing on message-complete would hide the banner in the race where the error
                    // fires ~ms before the turn closes (e.g. five-hour quota hit mid-turn).
                    // Transient recoveries use chat:api-retry, not chat:agent-error.
                    // Banner is cleared on: new send, session load, api-retry resolved, reset.
                });
                if (completionPatch?.realId) {
                    const realId = completionPatch.realId;
                    setHistoryMessages(prev => {
                        const next = updateMessageById(
                            prev,
                            realId,
                            message => applyAssistantCompletionPatch(message, completionPatch),
                        );
                        if (next !== prev) {
                            seenIdsRef.current.add(realId);
                        }
                        return next;
                    });
                }

                // Mark tab as unread when the result is not immediately visible:
                // either the user is on another tab, or the app/window is not
                // focused even though this tab is logically active.
                if (!isActiveRef.current || shouldNotifyUser()) {
                    onUnreadChangeRef.current?.(true);
                }

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

                if (completePayload?.compact_result === 'success') {
                    setSystemNotice({
                        kind: 'compact',
                        level: 'success',
                        message: appText('tabProvider.compactSuccess'),
                    });
                }
                // Always track message_complete, use defaults if payload is missing
                trackTabEvent('message_complete', {
                    runtime: analyticsMetaRef.current.runtime,
                    runtime_source: analyticsMetaRef.current.runtimeSource,
                    model: completePayload?.model,
                    input_tokens: completePayload?.input_tokens ?? 0,
                    output_tokens: completePayload?.output_tokens ?? 0,
                    cache_read_tokens: completePayload?.cache_read_tokens ?? 0,
                    cache_creation_tokens: completePayload?.cache_creation_tokens ?? 0,
                    tool_count: completePayload?.tool_count ?? 0,
                    duration_ms: completePayload?.duration_ms ?? 0,
                });

                // Auto-title generation is backend-owned (#296) — the sidecar
                // triggers it off this same turn-success signal and pushes the
                // result via `chat:session-title-changed` (handled below).

                break;
            }

            case 'chat:session-title-changed': {
                // #296 — backend Title Service applied an AI title for a session.
                // This event reaches only this session's sidecar (Tab-scoped SSE),
                // so a payload sessionId match means it's THIS tab's session.
                const titlePayload = data as { sessionId?: string; title?: string } | null;
                if (titlePayload?.title && titlePayload.sessionId
                    && titlePayload.sessionId === currentSessionIdRef.current) {
                    firstUserTitleProjectionRef.current = 'established';
                    currentSessionTitleRef.current = titlePayload.title;
                    onTitleChangeRef.current?.(titlePayload.title);
                }
                // Refresh the session-list surfaces (history dropdown / task center),
                // which re-read titles from disk where the backend already persisted.
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED));
                break;
            }

            case 'chat:context-usage': {
                // PRD 0.2.32 — 归一化 context 用量快照（builtin 每轮末 / Codex 亚轮流式）。
                // Session-scoped snapshot: Rust can receive/replay the latest context snapshot
                // while a fresh SSE connection is still being promoted on the renderer side.
                // Trust the payload session id, then store only the display shape.
                const payload = data as (ContextUsage & { sessionId?: string | null }) | null;
                const payloadSessionId = payload?.sessionId ?? null;
                const currentId = currentSessionIdRef.current;
                const connectedId = attachedSseSessionIdRef.current;
                if (!shouldAcceptSessionScopedSseSnapshot({
                    connectedSessionId: connectedId,
                    currentSessionId: currentId,
                    payloadSessionId,
                    isConnectedSessionPending: connectedId ? isPendingSessionId(connectedId) : false,
                    isCurrentSessionPending: currentId ? isPendingSessionId(currentId) : false,
                })) {
                    break;
                }
                // 后端已归一化，前端只存最新值供 <ContextUsageIndicator> 消费。
                liveContextUsageSessionIdRef.current = payloadSessionId ?? currentId;
                if (!payload) {
                    setContextUsage(null);
                } else {
                    const { sessionId: _payloadSessionId, ...usage } = payload;
                    void _payloadSessionId;
                    setContextUsage(usage);
                }
                break;
            }

            case 'chat:agent-plan-update': {
                const payload = data as { sessionId?: string | null; todos?: unknown } | null;
                const payloadSessionId = payload?.sessionId ?? null;
                const currentId = currentSessionIdRef.current;
                const connectedId = attachedSseSessionIdRef.current;
                if (!shouldAcceptSessionScopedSseSnapshot({
                    connectedSessionId: connectedId,
                    currentSessionId: currentId,
                    payloadSessionId,
                    isConnectedSessionPending: connectedId ? isPendingSessionId(connectedId) : false,
                    isCurrentSessionPending: currentId ? isPendingSessionId(currentId) : false,
                })) {
                    break;
                }
                setAgentPlanTodos(normalizeAgentPlanTodos(payload?.todos));
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
                    clearRuntimePlanTodos();
                });
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
                    clearRuntimePlanTodos();
                });
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
                const payload = data as {
                    info: SystemInitInfo;
                    sessionId?: string;
                    prewarm?: boolean;
                    runtime?: string;
                    runtimeSource?: RuntimeSource;
                } | null;
                if (payload?.info) {
                    const newSessionId = payload.sessionId;
                    const currentIdForSystemInit = currentSessionIdRef.current;
                    const connectedIdForSystemInit = attachedSseSessionIdRef.current;
                    const systemInitSessionDecision = decideSystemInitSessionId({
                        connectedSessionId: connectedIdForSystemInit,
                        currentSessionId: currentIdForSystemInit,
                        payloadSessionId: newSessionId,
                        expectedBirthSessionId: resetBirthSessionIdRef.current,
                        isConnectedSessionPending: connectedIdForSystemInit ? isPendingSessionId(connectedIdForSystemInit) : false,
                        isCurrentSessionPending: currentIdForSystemInit ? isPendingSessionId(currentIdForSystemInit) : false,
                        isNewSession: isNewSessionRef.current,
                        isResetBirthPending: resetBirthPendingRef.current,
                    });
                    if (!systemInitSessionDecision.accept) {
                        console.log(
                            `[TabProvider ${tabId}] Ignoring system_init for stale session ${newSessionId ?? 'none'} ` +
                            `(current=${currentIdForSystemInit ?? 'none'}, connected=${connectedIdForSystemInit ?? 'none'}, reason=${systemInitSessionDecision.reason})`,
                        );
                        break;
                    }

                    setSystemInitInfo(payload.info);
                    // v0.1.69: backend tags every system-init with the runtime that
                    // actually spawned the process (builtin / claude-code / codex /
                    // gemini). Freezing it here means a session created in this tab
                    // gets its sessionRuntime set on first system-init and is never
                    // affected by later agent.runtime changes — Chat.tsx's
                    // currentRuntime = sessionRuntime ?? agentRuntime then keeps the
                    // bottom-bar display consistent with how messages route.
                    if (payload.runtime) {
                        const runtime = normalizeRuntime(payload.runtime);
                        setSessionRuntime(runtime);
                        setSessionRuntimeSource(runtime === 'builtin'
                            ? null
                            : (payload.runtimeSource ?? 'system-cli'));
                        if (runtime !== 'builtin') {
                            setSdkSlashCommands([]);
                        }
                    }

                    // Auto-sync sessionId when a new session is created (e.g., first message in empty session)
                    // This ensures currentSessionId stays in sync with the actual session
                    // Use our sessionId (for SessionStore matching) not SDK's session_id
                    if (newSessionId && systemInitSessionDecision.shouldSyncSessionId) {
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
                        // The system-init decision above catches all three and rejects
                        // non-birth mismatches from stale history-switch/prewarm snapshots.
                        const isSessionBirth = systemInitSessionDecision.isSessionBirth;

                        console.log(`[TabProvider ${tabId}] Auto-syncing sessionId from system_init: ${newSessionId}`);
                        // Notify parent (App.tsx) to update Tab.sessionId for Session singleton constraint
                        // before committing the provider-local identity. App owns the
                        // pending→real admission boundary, so a concurrent deletion that
                        // wins that claim must leave every renderer projection on pending.
                        void Promise.resolve(onSessionIdChangeRef.current?.(newSessionId))
                            .then((changed) => {
                                if (changed === false) {
                                    console.error(`[TabProvider ${tabId}] system_init session id sync was refused by parent for ${newSessionId}`);
                                    return;
                                }
                                currentSessionIdRef.current = newSessionId;
                                setCurrentSessionId(newSessionId);
                                if (isNewSessionRef.current || resetBirthPendingRef.current) {
                                    resetBirthSessionIdRef.current = newSessionId;
                                    resetBirthPendingRef.current = false;
                                }

                                if (isSessionBirth) {
                                    // Fallback policy:
                                    //   - isNewSessionRef.current === true → explicit reset path,
                                    //     resetSession should have setPendingSurface('new_chat_button'),
                                    //     so fallback to 'new_chat_button' even if pending was lost
                                    //   - otherwise → organic mint via launcher input (most common
                                    //     case where caller didn't setPendingSurface)
                                    const fallback = isNewSessionRef.current
                                        ? birthContextForSurface('new_chat_button')
                                        : birthContextForSurface('launcher_input');
                                    trackSessionNewForBirth(
                                        newSessionId,
                                        fallback,
                                        payload.runtime ? normalizeRuntime(payload.runtime) : undefined,
                                        payload.runtime ? (payload.runtimeSource ?? null) : undefined,
                                    );
                                }
                            })
                            .catch((error) => {
                                console.error(`[TabProvider ${tabId}] system_init session id sync failed:`, error);
                            });
                    } else if (
                        newSessionId &&
                        resetBirthPendingRef.current &&
                        resetBirthSessionIdRef.current === newSessionId
                    ) {
                        // /chat/reset already synchronized the renderer/Rust identity.
                        // The later system-init confirms the same id and completes the
                        // reset-birth analytics/guard lifecycle without waiting for an
                        // artificial id change.
                        resetBirthPendingRef.current = false;
                        trackSessionNewForBirth(
                            newSessionId,
                            birthContextForSurface('new_chat_button'),
                            payload.runtime ? normalizeRuntime(payload.runtime) : undefined,
                            payload.runtime ? (payload.runtimeSource ?? null) : undefined,
                        );
                    }
                }
                break;
            }

            case 'chat:slash-commands': {
                const payload = data as { commands?: SlashCommand[]; sessionId?: string; runtime?: string } | null;
                const payloadSessionId = payload?.sessionId;
                const currentId = currentSessionIdRef.current;
                const connectedId = attachedSseSessionIdRef.current;
                if (!shouldAcceptSessionScopedSseSnapshot({
                    connectedSessionId: connectedId,
                    currentSessionId: currentId,
                    payloadSessionId,
                    isConnectedSessionPending: connectedId ? isPendingSessionId(connectedId) : false,
                    isCurrentSessionPending: currentId ? isPendingSessionId(currentId) : false,
                })) {
                    console.log(`[TabProvider ${tabId}] Ignoring slash commands for stale session ${payloadSessionId}`);
                    break;
                }
                setSdkSlashCommands(Array.isArray(payload?.commands) ? payload.commands : []);
                break;
            }

            case 'chat:runtime-tool-catalog': {
                const payload = data as { sessionId?: string; tools?: string[] } | null;
                const payloadSessionId = payload?.sessionId;
                const currentId = currentSessionIdRef.current;
                const connectedId = attachedSseSessionIdRef.current;
                if (!shouldAcceptSessionScopedSseSnapshot({
                    connectedSessionId: connectedId,
                    currentSessionId: currentId,
                    payloadSessionId,
                    isConnectedSessionPending: connectedId ? isPendingSessionId(connectedId) : false,
                    isCurrentSessionPending: currentId ? isPendingSessionId(currentId) : false,
                })) {
                    console.log(`[TabProvider ${tabId}] Ignoring runtime tool catalog for stale session ${payloadSessionId}`);
                    break;
                }
                const tools = Array.isArray(payload?.tools)
                    ? payload.tools.filter((tool): tool is string => typeof tool === 'string')
                    : [];
                setSystemInitInfo(previous => previous ? { ...previous, tools } : previous);
                break;
            }

            case 'chat:mcp-effective-snapshot': {
                const payload = data as McpEffectiveSnapshot | null;
                const payloadSessionId = payload?.sessionId;
                const currentId = currentSessionIdRef.current;
                const connectedId = attachedSseSessionIdRef.current;
                if (!payload || !shouldAcceptSessionScopedSseSnapshot({
                    connectedSessionId: connectedId,
                    currentSessionId: currentId,
                    payloadSessionId,
                    isConnectedSessionPending: connectedId ? isPendingSessionId(connectedId) : false,
                    isCurrentSessionPending: currentId ? isPendingSessionId(currentId) : false,
                })) {
                    console.log(`[TabProvider ${tabId}] Ignoring MCP effective snapshot for stale session ${payloadSessionId}`);
                    break;
                }
                setMcpEffectiveSnapshot(previous => reduceMcpEffectiveSnapshot(previous, payload));
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

            // Subagent event handling for nested tool calls (Task tool)
            case 'chat:subagent-tool-use': {
                const payload = data as {
                    parentToolUseId: string;
                    tool: ToolUse;
                    usage?: { input_tokens?: number; output_tokens?: number };
                    finalInput?: boolean;
                    inputRef?: unknown;
                };
                if (payload.inputRef) {
                    const targetSessionId = currentSessionIdRef.current;
                    void getDataPlaneBaseUrl(tabId, targetSessionId)
                        .then((baseUrl) => fetchJsonLargeValueRef(
                            baseUrl,
                            payload.inputRef,
                        ))
                        .then((resolvedInput) => {
                            if (currentSessionIdRef.current !== targetSessionId) return;
                            setStreamingMessage(prev => prev
                                ? replaceFinalSubagentToolInput(
                                    prev,
                                    payload.parentToolUseId,
                                    payload.tool.id,
                                    resolvedInput,
                                )
                                : prev);
                            setHistoryMessages(prev => prev.map(message => replaceFinalSubagentToolInput(
                                message,
                                payload.parentToolUseId,
                                payload.tool.id,
                                resolvedInput,
                            )));
                        })
                        .catch((err) => console.error('[TabProvider] Failed to resolve final nested tool input ref:', err));
                    break;
                }
                setStreamingMessage(prev => {
                    if (!prev) return prev;
                    return applySubagentCallsUpdate(prev, payload.parentToolUseId, (calls, tool) => {
                        const inputJson = payload.finalInput
                            ? undefined
                            : JSON.stringify(payload.tool.input ?? {}, null, 2);
                        const existingIdx = calls.findIndex(c => c.id === payload.tool.id);

                        const updatedCalls: SubagentToolCall[] = existingIdx !== -1
                            ? calls.map(c => c.id === payload.tool.id
                                ? {
                                    ...c,
                                    name: payload.tool.name,
                                    input: payload.tool.input ?? {},
                                    inputJson,
                                    isLoading: payload.finalInput ? c.isLoading : true,
                                }
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
                const payload = data as {
                    parentToolUseId: string;
                    toolUseId: string;
                    content: string;
                    isError?: boolean;
                    metadata?: ToolUseSimple['resultMeta'];
                    attachments?: import('@/types/chat').ToolAttachment[];
                };
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
                                ? {
                                    ...call,
                                    result: payload.content,
                                    resultMeta: payload.metadata,
                                    isError: payload.isError,
                                    isLoading: false,
                                    attachments: payload.attachments ?? call.attachments,
                                }
                                : call
                        );
                        return { calls: updatedCalls };
                    }) ?? prev;
                });
                break;
            }

            case 'chat:subagent-status': {
                const payload = data as {
                    parentToolUseId: string;
                    lifecycle: SubagentLifecycle;
                };
                setStreamingMessage(prev => (
                    prev ? applySubagentLifecycleUpdate(
                        prev,
                        payload.parentToolUseId,
                        payload.lifecycle,
                    ) ?? prev : prev
                ));
                setHistoryMessages(prev => prev.map(message => (
                    applySubagentLifecycleUpdate(
                        message,
                        payload.parentToolUseId,
                        payload.lifecycle,
                    ) ?? message
                )));
                break;
            }

            case 'chat:subagent-tool-attachment-update': {
                // Cross-review (#0.2.29) — async fulfillment of a nested sub-agent
                // tool's placeholder attachment (mirrors chat:tool-attachment-update
                // for top-level tools). Replace the matching pendingId in-place.
                const payload = data as {
                    parentToolUseId: string;
                    toolUseId: string;
                    pendingId: string;
                    attachment: import('@/types/chat').ToolAttachment;
                };
                setStreamingMessage(prev => {
                    if (!prev) return prev;
                    return applySubagentCallsUpdate(prev, payload.parentToolUseId, (calls) => {
                        const updatedCalls = calls.map(call => {
                            if (call.id !== payload.toolUseId || !call.attachments) return call;
                            const idx = call.attachments.findIndex(a => a.pendingId === payload.pendingId);
                            if (idx === -1) return call;
                            const next = [...call.attachments];
                            next[idx] = payload.attachment;
                            return { ...call, attachments: next };
                        });
                        return { calls: updatedCalls };
                    }) ?? prev;
                });
                break;
            }

            case 'permission:request': {
                // Agent is requesting permission to use a tool
                const payload = data as { requestId: string; sessionId?: string | null; toolName: string; input: string } | null;
                console.log(`[TabProvider] permission:request received:`, payload);
                if (payload?.requestId && shouldAcceptInteractiveEvent(payload.sessionId)) {
                    console.log(`[TabProvider] Queueing pendingPermission for: ${payload.toolName}`);
                    setPendingPermissions(prev => enqueuePermissionRequest(prev, {
                        requestId: payload.requestId,
                        sessionId: payload.sessionId,
                        toolName: payload.toolName,
                        input: payload.input || '',
                    }));
                    // Send system notification if user is not focused on the app
                    notifyPermissionRequest(payload.toolName);
                    if (!isActiveRef.current || shouldNotifyUser()) {
                        onUnreadChangeRef.current?.(true);
                    }
                }
                break;
            }

            case 'permission:expired': {
                const payload = data as { requestId?: string; sessionId?: string | null; reason?: string } | null;
                if (payload?.requestId && shouldAcceptInteractiveEvent(payload.sessionId)) {
                    console.log(`[TabProvider] permission:expired received for ${payload.requestId} (${payload.reason ?? 'unknown'})`);
                    setPendingPermissions(prev => removePermissionRequest(prev, payload.requestId));
                }
                break;
            }

            case 'ask-user-question:request': {
                // Agent is asking user structured questions
                const payload = data as { requestId: string; sessionId?: string | null; questions: AskUserQuestion[]; previewFormat?: 'html' | 'markdown' } | null;
                console.log(`[TabProvider] ask-user-question:request received:`, payload);
                if (payload?.requestId && shouldAcceptInteractiveEvent(payload.sessionId) && payload.questions?.length > 0) {
                    console.log(`[TabProvider] Setting pendingAskUserQuestion with ${payload.questions.length} questions`);
                    setPendingAskUserQuestion({
                        requestId: payload.requestId,
                        sessionId: payload.sessionId,
                        questions: payload.questions,
                        previewFormat: payload.previewFormat,
                    });
                    // Send system notification if user is not focused on the app
                    notifyAskUserQuestion();
                    if (!isActiveRef.current || shouldNotifyUser()) {
                        onUnreadChangeRef.current?.(true);
                    }
                }
                break;
            }

            case 'exit-plan-mode:request': {
                const payload = data as { requestId: string; sessionId?: string | null; plan?: string; allowedPrompts?: ExitPlanModeAllowedPrompt[] } | null;
                if (payload?.requestId && shouldAcceptInteractiveEvent(payload.sessionId)) {
                    setPendingExitPlanMode({
                        requestId: payload.requestId,
                        sessionId: payload.sessionId,
                        plan: payload.plan,
                        allowedPrompts: payload.allowedPrompts,
                    });
                    notifyPlanModeRequest();
                    if (!isActiveRef.current || shouldNotifyUser()) {
                        onUnreadChangeRef.current?.(true);
                    }
                }
                break;
            }

            case 'enter-plan-mode:request': {
                const payload = data as { requestId: string; sessionId?: string | null; autoApproved?: boolean } | null;
                if (payload?.requestId && shouldAcceptInteractiveEvent(payload.sessionId)) {
                    // Always auto-approve EnterPlanMode (no user card needed).
                    // For SDK-auto path, backend already proceeded; just update UI state.
                    // For canUseTool path, backend is waiting — notify it to proceed.
                    setPendingEnterPlanMode({ requestId: payload.requestId, sessionId: payload.sessionId, autoApproved: true, resolved: 'approved' });
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
                const payload = data as { requestId: string; sessionId?: string | null; reason?: string } | null;
                if (payload?.requestId && shouldAcceptInteractiveEvent(payload.sessionId)) {
                    setPendingAskUserQuestion(prev =>
                        prev?.requestId === payload.requestId ? null : prev,
                    );
                }
                break;
            }
            case 'exit-plan-mode:expired': {
                const payload = data as { requestId: string; sessionId?: string | null; reason?: string } | null;
                if (payload?.requestId && shouldAcceptInteractiveEvent(payload.sessionId)) {
                    setPendingExitPlanMode(prev =>
                        prev?.requestId === payload.requestId ? null : prev,
                    );
                }
                break;
            }
            case 'enter-plan-mode:expired': {
                const payload = data as { requestId: string; sessionId?: string | null; reason?: string } | null;
                if (payload?.requestId && shouldAcceptInteractiveEvent(payload.sessionId)) {
                    setPendingEnterPlanMode(prev =>
                        prev?.requestId === payload.requestId ? null : prev,
                    );
                }
                break;
            }

            // Background task lifecycle (SDK Task tool)
            case 'chat:task-started': {
                console.log(`[TabProvider ${tabId}] ${eventName}:`, data);
                const startPayload = data as { taskId?: string; toolUseId?: string; description?: string; taskType?: string; sessionId?: string | null };
                if (!shouldAcceptInteractiveEvent(startPayload.sessionId)) break;
                const eventSessionId = startPayload.sessionId ?? attachedSseSessionIdRef.current ?? currentSessionIdRef.current;
                if (startPayload.taskId && startPayload.description) {
                    setBackgroundTaskDescription(startPayload.taskId, startPayload.description, eventSessionId);
                }
                // Register the toolUseId↔taskId mapping so TaskTool components
                // (which only know their tool.id = toolUseId) can look up status
                // from task-notification events (which only carry taskId).
                if (startPayload.taskId && startPayload.toolUseId) {
                    registerBackgroundTask(startPayload.taskId, startPayload.toolUseId, {
                        description: startPayload.description,
                        taskType: startPayload.taskType,
                    }, eventSessionId);
                } else if (startPayload.taskId && !startPayload.toolUseId) {
                    console.warn(`[TabProvider ${tabId}] chat:task-started missing toolUseId for task ${startPayload.taskId} — background task status matching will degrade`);
                }
                break;
            }
            case 'chat:task-notification': {
                console.log(`[TabProvider ${tabId}] ${eventName}:`, data);
                const payload = data as { taskId?: string; toolUseId?: string; status?: string; summary?: string; sessionId?: string | null };
                if (!shouldAcceptInteractiveEvent(payload.sessionId)) break;
                const eventSessionId = payload.sessionId ?? attachedSseSessionIdRef.current ?? currentSessionIdRef.current;
                if (payload.taskId && payload.status) {
                    setBackgroundTaskStatus(payload.taskId, payload.status, payload.toolUseId, eventSessionId);
                    // Inject a visible notification message into the chat so the user
                    // understands why AI continues responding (prevents "AI talking to itself" UX).
                    // toolUseId 写进 JSON 是给 PRD 0.2.17 Agent Status Panel 用的「持久化完成证据」：
                    // backgroundTaskStatus 模块是 renderer 进程级 Map，Cmd+R / LRU 驱逐后会丢；
                    // 注入到消息历史里能扛住这些场景，让 useAgentStatusState 反查到「这条 BG 任务
                    // 在历史里已经 notified-complete」。
                    const description = getBackgroundTaskDescription(payload.taskId, eventSessionId);
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
                // `isInFlight` indicates the backend has already yielded this item
                // to the SDK CLI. It remains conditionally cancellable via the
                // SDK control plane until replay/dequeue confirmation arrives.
                const payload = data as {
                    queueId: string;
                    messageText: string;
                    isInFlight?: boolean;
                    deliveryMode?: 'realtime' | 'turn';
                    canCancel?: boolean;
                    canForceExecute?: boolean;
                } | null;
                if (payload?.queueId) {
                    const visibleMessageText = queueDisplayText(payload.messageText);
                    console.log(`[TabProvider] queue:added queueId=${payload.queueId} isInFlight=${!!payload.isInFlight}`);
                    setQueuedMessages(prev => {
                        // Exact queueId match — already added by .then(); update isInFlight if it changed.
                        const existingIdx = prev.findIndex(q => q.queueId === payload.queueId);
                        if (existingIdx !== -1) {
                            const nextDeliveryMode = payload.deliveryMode ?? prev[existingIdx].deliveryMode;
                            const nextCanCancel = payload.canCancel ?? prev[existingIdx].canCancel;
                            const nextCanForceExecute = payload.canForceExecute ?? prev[existingIdx].canForceExecute;
                            if (
                                prev[existingIdx].isInFlight === !!payload.isInFlight
                                && prev[existingIdx].deliveryMode === nextDeliveryMode
                                && prev[existingIdx].canCancel === nextCanCancel
                                && prev[existingIdx].canForceExecute === nextCanForceExecute
                            ) return prev;
                            const next = [...prev];
                            next[existingIdx] = {
                                ...prev[existingIdx],
                                text: visibleMessageText,
                                isInFlight: !!payload.isInFlight,
                                deliveryMode: nextDeliveryMode,
                                canCancel: nextCanCancel,
                                canForceExecute: nextCanForceExecute,
                            };
                            return next;
                        }
                        // Optimistic entry exists — .then() will reconcile with real queueId
                        if (prev.some(q => q.queueId.startsWith('opt-'))) return prev;
                        return [...prev, {
                            queueId: payload.queueId,
                            text: visibleMessageText,
                            timestamp: Date.now(),
                            isInFlight: !!payload.isInFlight,
                            deliveryMode: payload.deliveryMode,
                            canCancel: payload.canCancel,
                            canForceExecute: payload.canForceExecute,
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
                    sessionId?: string;
                    midTurnBreak?: boolean;
                    userMessage?: {
                        id: string;
                        role: 'user';
                        content: string;
                        timestamp: string;
                        attachments?: WireMessageAttachment[];
                    };
                } | null;
                if (payload?.queueId) {
                    const currentIdForQueueStart = currentSessionIdRef.current;
                    const connectedIdForQueueStart = attachedSseSessionIdRef.current;
                    const isCurrentSessionQueueStart = Boolean(payload.sessionId)
                        && shouldAcceptSessionScopedSseSnapshot({
                            connectedSessionId: connectedIdForQueueStart,
                            currentSessionId: currentIdForQueueStart,
                            payloadSessionId: payload.sessionId,
                            isConnectedSessionPending: connectedIdForQueueStart ? isPendingSessionId(connectedIdForQueueStart) : false,
                            isCurrentSessionPending: currentIdForQueueStart ? isPendingSessionId(currentIdForQueueStart) : false,
                        });
                    if (!shouldAcceptLiveTurnEvent({
                        isNewSession: isNewSessionRef.current,
                        payloadSessionId: payload.sessionId ?? null,
                        isCurrentSessionScope: isCurrentSessionQueueStart,
                    })) {
                        break;
                    }
                    if (isNewSessionRef.current && isCurrentSessionQueueStart) {
                        isNewSessionRef.current = false;
                    }
                    // Track started IDs to prevent sendMessage .then() from re-adding
                    startedQueueIdsRef.current.add(payload.queueId);
                    console.log(`[TabProvider] queue:started queueId=${payload.queueId} midTurnBreak=${!!payload.midTurnBreak} streaming=${isStreamingRef.current}`);

                    // Build the user message
                    if (payload.userMessage) {
                        const msgId = payload.userMessage.id;
                        if (!seenIdsRef.current.has(msgId)) {
                            seenIdsRef.current.add(msgId);

                            projectAcceptedFirstUserTitle({
                                content: payload.userMessage.content,
                                messageId: msgId,
                            });

                            let attachments = normalizeWireAttachments(payload.userMessage.attachments);
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
                                attachments = mergeAttachmentPreviews(
                                    attachments,
                                    queuedMsg.images.map((img) => ({
                                        id: img.id,
                                        name: img.name,
                                        size: img.sizeBytes ?? 0,
                                        mimeType: img.mimeType ?? 'image/png',
                                        relativePath: img.relativePath,
                                        previewUrl: img.preview,
                                        isImage: true,
                                    })),
                                );
                            } else if (!attachments?.length && queuedMsg?.images?.length) {
                                // Fallback: server sent no attachments, use frontend snapshot
                                attachments = queuedMsg.images.map(img => ({
                                    id: img.id,
                                    name: img.name,
                                    size: img.sizeBytes ?? 0,
                                    mimeType: img.mimeType ?? 'image/png',
                                    relativePath: img.relativePath,
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
                                        const finalizedPrev = finalizeAssistantForHistory(prev, 'stopped');
                                        setHistoryMessages(prevHistory => [...prevHistory, finalizedPrev, userMsg]);
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
                                // force-surface suppresses message-stopped, so its renderer cleanup
                                // (setSystemStatus(null) + clearRuntimePlanTodos) is owned here — the
                                // old turn's transient status/todos must not leak into the new turn (V3c).
                                setSystemStatus(null);
                                clearRuntimePlanTodos();
                            } else {
                                // Normal turn start: render immediately
                                setHistoryMessages(prev => [...prev, userMsg]);
                            }
                        }
                    }
                    pendingAttachmentsRef.current = null;

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
                // Admin CLI modified config — notify global ConfigProvider to refresh.
                // Routes through `notifyConfigChanged` so the event detail stays
                // payload-free (issue #303 review-by-codex follow-up: a window-
                // level CustomEvent observable by any renderer listener must not
                // carry providerApiKeys / mcpServerEnv).
                console.log('[TabProvider] config:changed via Admin CLI', data);
                notifyConfigChanged('sse:config:changed');
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
                // Routes through `notifyConfigChanged` for the same secret-
                // leakage reason as the `config:changed` case above.
                notifyConfigChanged('sse:plugins:changed');
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
    }, [appendLog, appendUnifiedLog, tabId, moveStreamingToHistory, beginFreshStreamIfNeeded, setStreamingMessage, postJson, clearInteractiveState, flushPendingTextNow, startRevealLoop, flushAllPendingToolDeltas, flushPendingToolInputDelta, flushPendingToolResultDelta, flushPendingSubagentToolInputDelta, flushPendingSubagentToolResultDelta, clearSessionActive, clearRuntimePlanTodos, resetPaginationState, trackTabEvent, trackSessionNewForBirth, shouldAcceptInteractiveEvent, isPersistedRestoreInFlight, restoredPersistedSessionId, projectAcceptedFirstUserTitle]);

    const handleSseEvent = useCallback((
        eventName: string,
        data: unknown,
        metadata: SseEventMetadata,
    ) => {
        const eventSessionId = metadata.sessionId;
        const liveRevision = metadata.liveRevision;
        const restore = persistedRestoreLifecycleRef.current;
        if (restore.phase === 'failed') {
            const isGlobalControlEvent = eventName === 'config:changed'
                || eventName === 'plugin:install-progress'
                || eventName === 'plugins:changed';
            const payloadSessionId = eventSessionId ?? (
                typeof data === 'object'
                && data !== null
                && 'sessionId' in data
                && typeof data.sessionId === 'string'
                    ? data.sessionId
                    : null
            );
            if (
                !isGlobalControlEvent
                && (
                    payloadSessionId === restore.sessionId
                    || currentSessionIdRef.current === restore.sessionId
                )
            ) {
                // Failed is terminal until the explicit retry action creates a
                // new lifecycle token. Legacy chat:init and external-runtime
                // cold-history carry no Session scope, so the Tab's current
                // Session is also authoritative for rejecting local events.
                return;
            }
        }
        if (!eventSessionId || liveRevision === undefined) {
            applySseEvent(eventName, data);
            return;
        }

        const currentSessionId = currentSessionIdRef.current;
        if (
            currentSessionId &&
            !isPendingSessionId(currentSessionId) &&
            currentSessionId !== eventSessionId
        ) {
            return;
        }

        const fence = liveRevisionFenceRef.current;
        if (restore.phase === 'failed' && restore.sessionId === eventSessionId) {
            // Failed is terminal until the user explicitly retries. Live events
            // remain covered by the error shell; the retry snapshot catches up.
            return;
        }
        const isRestoredSession = restore.phase === 'ready' && restore.sessionId === eventSessionId;
        const isRestoreTarget = restore.sessionId === eventSessionId && restore.phase !== 'inactive';
        if (!isRestoredSession && !isRestoreTarget) {
            // Brand-new sessions are SSE-native until their first REST adoption.
            applySseEvent(eventName, data);
            return;
        }
        if (currentSessionIdRef.current !== eventSessionId) {
            return;
        }

        const decision = ingestLiveRevisionEvent(fence, {
            eventName,
            data,
            sessionId: eventSessionId,
            liveRevision,
            connectionGeneration: metadata.connectionGeneration,
        });
        liveRevisionFenceRef.current = decision.fence;
        if (decision.action === 'apply') {
            applySseEvent(eventName, data);
        } else if (decision.action === 'resync') {
            requestLiveRestoreRef.current(eventSessionId, decision.fence.restoreToken);
        }
    }, [applySseEvent]);

    // Connect serializer: each caller's task chains onto the *previous*
    // task, so pending->real id upgrades and Session switches cannot create
    // two concurrent SseConnection instances for one tab.
    const connectSseTailRef = useRef<Promise<void> | null>(null);
    // Unmount guard for async attachment work.
    const isMountedRef = useRef(true);
    useEffect(() => () => {
        isMountedRef.current = false;
        abortActiveRestoreRequest();
    }, [abortActiveRestoreRequest]);

    // Install one SSE subscription for the current Session. In Tauri mode
    // Rust owns transport lookup/retry; this layer owns only attachment and
    // projection convergence. Browser development mode retains EventSource.
    const connectSseImpl = useCallback(async () => {
        const connectingSessionId = currentSessionIdRef.current;
        if (!connectingSessionId) return;

        if (sseRef.current?.isActive()) {
            if (attachedSseSessionIdRef.current === connectingSessionId) return;
            console.log(`[TabProvider ${tabId}] Replacing SSE attachment ${attachedSseSessionIdRef.current ?? 'none'} -> ${connectingSessionId}`);
            const oldSse = sseRef.current;
            sseRef.current = null;
            attachedSseSessionIdRef.current = null;
            setIsConnected(false);
            resetTabServerUrlCache(tabId);
            await oldSse.disconnect();
        } else {
            attachedSseSessionIdRef.current = null;
            setIsConnected(false);
            if (sseRef.current) {
                const oldSse = sseRef.current;
                sseRef.current = null;
                await oldSse.disconnect();
            }
        }

        const sse = createSseConnection(tabId, currentSessionIdRef);
        sse.setEventHandler(handleSseEvent);
        sse.setStatusHandler((status) => {
            if (sseRef.current !== sse) return;
            if (status === 'disconnected' || status === 'reconnecting' || status === 'failed') {
                setIsConnected(false);
                if (status !== 'reconnecting') {
                    setIsLoading(false);
                }
            }
            if (status === 'connected') {
                const targetSessionId = currentSessionIdRef.current;
                const restore = persistedRestoreLifecycleRef.current;
                const connectionGeneration = sse.getConnectionGeneration();
                if (
                    targetSessionId
                    && restore.phase === 'restoring'
                    && restore.sessionId === targetSessionId
                    && restore.connectionGeneration !== connectionGeneration
                ) {
                    const fence = beginPersistedRestore(
                        targetSessionId,
                        connectionGeneration,
                        restore.mode,
                    );
                    requestLiveRestoreRef.current(targetSessionId, fence.restoreToken, restore.mode);
                }
                setIsConnected(true);
            }
        });
        sseRef.current = sse;
        // The connect operation owns this attachment label. Status callbacks
        // report liveness only and must never rewrite it from business state.
        attachedSseSessionIdRef.current = connectingSessionId;

        try {
            await sse.connect();
            if (sseRef.current !== sse || !isMountedRef.current || !sse.isActive()) {
                await sse.disconnect();
                return;
            }
            // Command ack means attachment only. `isConnected` becomes true
            // after the first envelope from a real transport generation.
        } catch (error) {
            if (sseRef.current === sse) {
                sseRef.current = null;
                attachedSseSessionIdRef.current = null;
                setIsConnected(false);
            }
            console.error(`[TabProvider ${tabId}] SSE connect failed:`, error);
            throw error;
        }
    }, [tabId, handleSseEvent, beginPersistedRestore]);

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
            if (sseRef.current?.isActive() && attachedSseSessionIdRef.current === sid) return;
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
    // App.tsx switches Session Sidecars without remounting TabProvider. Keep the
    // event stream attached to the current session, otherwise /chat/send can
    // persist successfully while the visible tab waits on an old/dead SSE stream.
    //
    // Load-bearing invariant: this effect drives SSE connect on initial mount
    // and on session switch. App.tsx assigns a
    // sessionId (real or `pending-...`) on every chat-view transition, so
    // `sessionId` truthy here covers initial mount as well. If a future code
    // path opens a chat tab without setting sessionId, SSE will silently
    // never connect — keep that invariant intact.
    useEffect(() => {
        if (!agentDir || !sessionId) return;

        const connectedSessionId = attachedSseSessionIdRef.current;
        const hasActiveSubscription = sseRef.current?.isActive() ?? false;

        if (hasActiveSubscription && connectedSessionId === sessionId) return;

        // The stable frontend owner keeps the same Sidecar for pending births and
        // explicit reset/migration births. Replacing the subscription here creates
        // a zero-client window that can lose the sole live user echo (#491).
        if (
            hasActiveSubscription &&
            shouldReuseSseSubscriptionForSessionChange({
                attachedSessionId: connectedSessionId,
                nextSessionId: sessionId,
                isAttachedSessionPending: connectedSessionId ? isPendingSessionId(connectedSessionId) : false,
                isNextSessionPending: isPendingSessionId(sessionId),
            })
        ) {
            attachedSseSessionIdRef.current = sessionId;
            return;
        }

        const generation = ++sseReconnectGenerationRef.current;
        let cancelled = false;

        void (async () => {
            if (hasActiveSubscription) {
                console.log(`[TabProvider ${tabId}] SessionId changed from ${connectedSessionId ?? 'none'} to ${sessionId}, reconnecting SSE`);
                attachedSseSessionIdRef.current = null;
                setIsConnected(false);
                resetTabServerUrlCache(tabId);
                const oldSse = sseRef.current;
                sseRef.current = null;
                if (oldSse) {
                    await oldSse.disconnect();
                }
            }

            if (cancelled || !isMountedRef.current || sseReconnectGenerationRef.current !== generation) return;
            await connectSse();
        })().catch((error) => {
            if (!cancelled) {
                console.error(`[TabProvider ${tabId}] SSE reconnect for session ${sessionId} failed:`, error);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [agentDir, sessionId, tabId, connectSse]);

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
            attachedSseSessionIdRef.current = null;
            if (stopTimeoutRef.current) {
                clearTimeout(stopTimeoutRef.current);
                stopTimeoutRef.current = null;
            }
            // Sidecar stop is handled by App.tsx performCloseTab()
            // which properly checks for active cron tasks before stopping
        };
    }, [tabId]);

    // Other tab-scoped HTTP callers still use the URL cache. SSE follows the
    // owner to the new port inside Rust and needs no renderer reconnect.
    useEffect(() => {
        if (!isTauri()) return;
        const ac = new AbortController();
        void listenWithCleanup<{ sessionId: string; port: number }>('session-sidecar:restarted', (event) => {
            const { sessionId: restartedSid, port } = event.payload;
            if (restartedSid === currentSessionIdRef.current) {
                console.log(`[TabProvider ${tabId}] Session Sidecar restarted on port ${port}; invalidating tab URL cache`);
                // The subscription survives a Rust-owned Sidecar replacement,
                // but the live transport does not. Reflect that process epoch
                // boundary until the first envelope from the replacement marks
                // the connection live again; Tab config hydration keys off it.
                setIsConnected(false);
                setMcpEffectiveSnapshot(null);
                resetTabServerUrlCache(tabId);
                const restore = persistedRestoreLifecycleRef.current;
                if (isPendingSessionId(restartedSid)) return;
                // liveRevision is process-local. A replacement Sidecar starts a
                // new epoch, so an old numeric baseline cannot be compared with
                // its revisions even if the transport generation later looks
                // contiguous. Re-arm the existing lifecycle from REST now.
                const mode: PersistedRestoreMode = restore.phase === 'ready'
                    ? 'live-recovery'
                    : restore.mode;
                const fence = beginPersistedRestore(
                    restartedSid,
                    sseRef.current?.getConnectionGeneration() ?? 0,
                    mode,
                );
                requestLiveRestoreRef.current(restartedSid, fence.restoreToken, mode);
            }
        }, ac.signal);
        return () => ac.abort();
    }, [tabId, beginPersistedRestore]);

    // Send message with optional images, permission mode, and model
    // Returns true immediately (optimistic) to clear the input without waiting for HTTP response.
    // The actual API call runs in the background — backend may take time for provider changes,
    // session startup, etc. but the user shouldn't be blocked.
    const sendMessage = useCallback(async (
        text: string,
        images?: ImageAttachment[],
        permissionMode?: PermissionMode,
        model?: string,
        providerEnv?: { providerId?: string; providerName?: string; baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses'; modelAliases?: { fable?: string; sonnet?: string; opus?: string; haiku?: string } },
        isCron?: boolean,
        // #324 — reasoning effort setting ('default' | level); send-time safety
        // net mirroring `model` (the /api/reasoning-effort/set push is primary).
        reasoningEffort?: string,
        providerRoute?: ProviderRoute,
        requiredSystemSkill?: ProductSystemSkillRequirement,
    ): Promise<boolean> => {
        const trimmed = text.trim();
        if (!trimmed && (!images || images.length === 0)) return false;
        if (isRestoreActionBlocked(persistedRestoreLifecycleRef.current.phase)) return false;
        const visibleQueueText = queueDisplayText(trimmed);

        // Detect skill/slash command: /command at start of message (for analytics)
        const skillMatch = trimmed.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)/);
        const skill = skillMatch ? skillMatch[1] : null;
        const hasImages = !!(images && images.length > 0);
        const sessionIdForSend = currentSessionIdRef.current ?? sessionId;
        const releaseSendTransition = sessionIdForSend
            ? claimSessionOpeningTransition(sessionIdForSend)
            : null;
        if (sessionIdForSend && !releaseSendTransition) return false;
        const isSessionBirthSend = !sessionIdForSend || isPendingSessionId(sessionIdForSend) || isNewSessionRef.current;
        const birthOrigin = isSessionBirthSend
            ? originFromDesktopSurface(peekPendingSessionBirth(
                tabId,
                isNewSessionRef.current
                    ? birthContextForSurface('new_chat_button')
                    : birthContextForSurface('launcher_input'),
            ).surface)
            : undefined;

        // Reset new session flag BEFORE sending - allow message replay to show user's message
        isNewSessionRef.current = false;

        // A successfully claimed send starts a new turn. Clear both terminal
        // projections here rather than on message-complete, where an error event
        // can race the completion envelope and be hidden.
        setAgentError(null);
        setLastTerminalReason(null);
        setSystemNotice(null);

        // Store attachments for merging with SSE replay
        if (hasImages) {
            pendingAttachmentsRef.current = images.map((img) => ({
                id: img.id,
                name: imageAttachmentName(img),
                size: imageAttachmentSize(img),
                mimeType: imageAttachmentMimeType(img),
                previewUrl: img.preview,
                relativePath: img.relativePath,
                isImage: true,
            }));
        }

        // Prepare image data for backend. Path-backed attachments carry refs;
        // only legacy no-path File/paste fallback carries base64.
        const imageData = images?.map(imagePayloadForSend);

        // Optimistic queue: immediately show badge when AI is streaming.
        // We don't know the real queueId yet (backend assigns it), so use a local ID.
        // .then() will reconcile: replace opt- with real queueId, or clean up if already started.
        const localQueueId = isStreamingRef.current ? `opt-${crypto.randomUUID()}` : null;
        if (localQueueId) {
            setQueuedMessages(prev => [...prev, {
                queueId: localQueueId,
                text: visibleQueueText,
                images: images?.map(queuedImageInfo),
                timestamp: Date.now(),
                canCancel: false,
                canForceExecute: false,
            }]);
        }

        // Fire-and-forget: send to backend without blocking the UI.
        // The HTTP response may be delayed by provider changes or session startup,
        // but the input should clear immediately for a responsive experience.
        // Desktop is the ONLY caller that should trigger provider switches per-message.
        // When no providerEnv is given (subscription mode), send 'subscription' explicitly
        // so enqueueUserMessage knows this is an intentional switch, not "I don't know".
        // IM/Task callers omit the field entirely (undefined = "keep current provider").
        const sendPayload = {
            text: trimmed,
            images: imageData,
            sessionId: sessionIdForSend,
            permissionMode: permissionMode ?? 'auto',
            // #264 — echo the global background-agent permission policy so the
            // builtin PermissionRequest hook applies it to run_in_background sub-agents.
            // Read via ref (not the closure-captured appConfig) so a Settings change
            // takes effect immediately in already-mounted tabs.
            backgroundAgentPermissionMode: appConfigRef.current?.backgroundAgentPermissionMode ?? 'inherit',
            model,
            reasoningEffort,
            providerRoute,
            requiredSystemSkill,
            ...(birthOrigin ? { birthOrigin } : {}),
            ...(providerRoute ? {} : { providerEnv: providerEnv ?? 'subscription' }),
        };

        void postJson<{
            success: boolean;
            error?: string;
            queued?: boolean;
            queueId?: string;
            isInFlight?: boolean;
            deliveryMode?: 'realtime' | 'turn';
            canCancel?: boolean;
            canForceExecute?: boolean;
        }>('/chat/send', sendPayload).then((response) => {
            if (response.success) {
                trackTabEvent('message_send', {
                    runtime: analyticsMetaRef.current.runtime,
                    runtime_source: analyticsMetaRef.current.runtimeSource,
                    mode: permissionMode ?? 'auto',
                    model: model ?? 'default',
                    skill,
                    has_image: hasImages,
                    has_file: false,
                    is_cron: isCron ?? false,
                });

                if (response.queued && response.queueId) {
                    pendingAttachmentsRef.current = null;
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
                                    deliveryMode: response.deliveryMode,
                                    canCancel: response.canCancel,
                                    canForceExecute: response.canForceExecute,
                                    images: images?.map(queuedImageInfo),
                                }
                                : q
                        ));
                    } else {
                        // Non-optimistic path (wasn't streaming when sent)
                        setQueuedMessages(prev => {
                            if (prev.some(q => q.queueId === realQueueId)) {
                                // SSE already added it — enrich with image data if available
                                return prev.map(q => q.queueId === realQueueId
                                    ? {
                                        ...q,
                                        deliveryMode: response.deliveryMode ?? q.deliveryMode,
                                        canCancel: response.canCancel ?? q.canCancel,
                                        canForceExecute: response.canForceExecute ?? q.canForceExecute,
                                        images: images?.length ? images.map(queuedImageInfo) : q.images,
                                    }
                                    : q
                                );
                            }
                            return [...prev, {
                                queueId: realQueueId,
                                text: visibleQueueText,
                                images: images?.map(queuedImageInfo),
                                timestamp: Date.now(),
                                isInFlight: !!response.isInFlight,
                                deliveryMode: response.deliveryMode,
                                canCancel: response.canCancel,
                                canForceExecute: response.canForceExecute,
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
                setAgentError(response.error ?? appText('tabProvider.sendFailed'));
                pendingAttachmentsRef.current = null;
            }
        }).catch((error) => {
            console.error(`[TabProvider ${tabId}] Send message failed:`, error);
            if (localQueueId) {
                setQueuedMessages(prev => prev.filter(q => q.queueId !== localQueueId));
            }
            const msg = error instanceof Error ? error.message : appText('tabProvider.networkError');
            setAgentError(msg === 'Failed to fetch' ? appText('tabProvider.networkDisconnected') : msg);
            pendingAttachmentsRef.current = null;
        }).finally(() => {
            releaseSendTransition?.();
        });

        // Return true immediately — input clears without waiting for HTTP response
        return true;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [tabId, sessionId, claimSessionOpeningTransition]);

    // Stop response with timeout fallback
    const stopResponse = useCallback(async (): Promise<{ success: boolean; alreadyStopped: boolean }> => {
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
                        clearRuntimePlanTodos();
                    });
                    return { success: true, alreadyStopped: true };
                }
                // 设置 5 秒超时，如果没有收到 SSE 事件确认则强制恢复 UI
                stopTimeoutRef.current = setTimeout(() => {
                    if (isStreamingRef.current) {
                        console.warn(`[TabProvider ${tabId}] Stop timeout - forcing UI recovery`);
                        recoverStreamingUi('stopped');
                    }
                    // Also recover from 'stopping' state if SSE confirmation never arrived
                    setSessionState(prev => prev === 'stopping' ? 'idle' : prev);
                    clearRuntimePlanTodos();
                    stopTimeoutRef.current = null;
                }, 5000);
                return { success: true, alreadyStopped: false };
            }
            // POST failed (success=false), recover UI
            recoverStreamingUi('stopped');
            return { success: false, alreadyStopped: false };
        } catch (error) {
            console.error(`[TabProvider ${tabId}] Stop response failed:`, error);
            // 请求失败也强制恢复 UI
            recoverStreamingUi('failed');
            return { success: false, alreadyStopped: false };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [recoverStreamingUi, tabId]);

    // Read and project the current Tab's persisted Session. This internal
    // function accepts an explicit target only so fence-driven recovery can
    // retain its captured identity; the public context exposes current-Session
    // reload without a target argument.
    const restorePersistedSession = useCallback(async (
        targetSessionId: string,
        options?: {
            restoreToken?: number;
            mode?: PersistedRestoreMode;
            gapRecoveryAttempted?: boolean;
        }
    ): Promise<boolean> => {
        if (currentSessionIdRef.current !== targetSessionId) return false;
        if (persistedRestoreLifecycleRef.current.phase === 'failed') return false;
        const connectionGeneration = sseRef.current?.getConnectionGeneration() ?? 0;
        const currentRestore = persistedRestoreLifecycleRef.current;
        const restoreMode = options?.mode ?? currentRestore.mode;
        let restoreToken: number;

        if (options?.restoreToken !== undefined) {
            restoreToken = options.restoreToken;
        } else {
            const currentFence = liveRevisionFenceRef.current;
            const canReuseRestore = (
                currentRestore.phase === 'restoring'
                && currentRestore.sessionId === targetSessionId
                && currentRestore.restoreToken === currentFence.restoreToken
                && currentFence.sessionId === targetSessionId
                && currentFence.connectionGeneration === connectionGeneration
                && currentFence.restoring
            );
            if (canReuseRestore) {
                restoreToken = currentFence.restoreToken;
            } else {
                const nextFence = beginPersistedRestore(
                    targetSessionId,
                    connectionGeneration,
                    restoreMode,
                );
                restoreToken = nextFence.restoreToken;
            }
        }

        abortActiveRestoreRequest();
        const controller = new AbortController();
        const restoreRequest = {
            sessionId: targetSessionId,
            restoreToken,
            connectionGeneration,
            controller,
        };
        activeRestoreRequestRef.current = restoreRequest;

        const ownsCurrentRestore = (): boolean => {
            const fence = liveRevisionFenceRef.current;
            return (
                isMountedRef.current
                && activeRestoreRequestRef.current === restoreRequest
                && currentSessionIdRef.current === targetSessionId
                && fence.sessionId === targetSessionId
                && fence.restoreToken === restoreToken
                && fence.connectionGeneration === connectionGeneration
                && (sseRef.current?.getConnectionGeneration() ?? 0) === connectionGeneration
                && fence.restoring
            );
        };

        const failOwnedRestore = (message: string) => {
            if (!ownsCurrentRestore()) return;
            const fence = liveRevisionFenceRef.current;
            liveRevisionFenceRef.current = {
                ...fence,
                restoring: false,
                lastAppliedRevision: null,
                buffered: [],
            };
            publishPersistedRestoreLifecycle({
                phase: 'failed',
                mode: restoreMode,
                sessionId: targetSessionId,
                restoreToken,
                connectionGeneration,
                error: message,
            });
        };

        try {
            console.log(`[TabProvider ${tabId}] Restoring persisted session: ${targetSessionId}`);
            const response = await apiGetJson<{
                success: boolean;
                session?: SessionMetadata & {
                    snapshotRevision?: number;
                    liveSessionState?: SessionState;
                    liveStreamingMessage?: WireSessionMessage | null;
                    pendingInteractiveRequests?: Array<{ type: string; data: unknown }>;
                    messages: WireSessionMessage[];
                    totalCount?: number;
                    hasMoreBefore?: boolean;
                };
            }>(
                `/sessions/${encodeURIComponent(targetSessionId)}?limit=${INITIAL_PAGE_SIZE}`,
                { signal: controller.signal },
            );

            if (!ownsCurrentRestore()) return false;
            if (!response.success || !response.session) {
                failOwnedRestore(String(i18n.t('chat:shell.boot.restoreFailed')));
                return false;
            }

            const restoreCompletion = completeLiveRevisionRestore(
                liveRevisionFenceRef.current,
                restoreToken,
                response.session.snapshotRevision ?? 0,
            );
            if (restoreCompletion.stale) return false;
            if (restoreCompletion.needsResync) {
                if (options?.gapRecoveryAttempted) {
                    failOwnedRestore(String(i18n.t('chat:shell.boot.restoreFailed')));
                    return false;
                }
                liveRevisionFenceRef.current = restoreCompletion.fence;
                publishPersistedRestoreLifecycle({
                    phase: 'restoring',
                    mode: restoreMode,
                    sessionId: targetSessionId,
                    restoreToken: restoreCompletion.fence.restoreToken,
                    connectionGeneration: restoreCompletion.fence.connectionGeneration,
                    error: null,
                });
                requestLiveRestoreRef.current(
                    targetSessionId,
                    restoreCompletion.fence.restoreToken,
                    restoreMode,
                    true,
                );
                return false;
            }

            const loadedMessages = response.session.messages.map(wireSessionMessageToMessage);
            const isLiveRecovery = restoreMode === 'live-recovery';
            const liveStreamingMessage = wireAssistantToStreamingMessage(
                response.session.liveStreamingMessage,
            );

            let projectedMessages = loadedMessages;
            if (isLiveRecovery) {
                const reconciled = reconcileLiveRecoveryHistory(
                    historyMessagesRef.current,
                    loadedMessages,
                );
                projectedMessages = reconciled.messages;
                if (!reconciled.hasOverlap) {
                    setFirstItemIndex(PAGINATION_START_INDEX);
                    const hasMoreBefore = response.session.hasMoreBefore ?? false;
                    setHasMoreBefore(hasMoreBefore);
                    hasMoreBeforeRef.current = hasMoreBefore;
                    loadingOlderRef.current = false;
                }
            } else {
                setAgentPlanTodos(null);
                isNewSessionRef.current = false;
                resetBirthPendingRef.current = false;
                resetBirthSessionIdRef.current = null;
                clearSessionActive();
                setFirstItemIndex(PAGINATION_START_INDEX);
                const hasMoreBefore = response.session.hasMoreBefore ?? false;
                setHasMoreBefore(hasMoreBefore);
                hasMoreBeforeRef.current = hasMoreBefore;
                loadingOlderRef.current = false;
            }

            seenIdsRef.current.clear();
            for (const message of projectedMessages) {
                seenIdsRef.current.add(message.id);
            }
            historyMessagesRef.current = projectedMessages;
            setHistoryMessages(projectedMessages);

            pendingTextRef.current = '';
            if (revealRafRef.current != null) {
                cancelAnimationFrame(revealRafRef.current);
                revealRafRef.current = null;
            }
            revealAccRef.current = 0;
            revealLastRef.current = 0;

            const liveSessionState = response.session.liveSessionState ?? 'idle';
            const isLiveActive = classifySessionActivity(liveSessionState) === 'active';
            isSessionActiveRef.current = isLiveActive;
            if (liveStreamingMessage && isLiveActive) {
                isStreamingRef.current = true;
                adoptedStreamRef.current = true;
                streamingMessageRef.current = liveStreamingMessage;
                setStreamingMessage(liveStreamingMessage);
            } else {
                isStreamingRef.current = false;
                adoptedStreamRef.current = false;
                streamingMessageRef.current = null;
                setStreamingMessage(null);
                if (isLiveRecovery) clearRuntimePlanTodos();
            }

            const loadedRuntime = response.session.runtime || 'builtin';
            setSessionRuntime(loadedRuntime);
            setSessionRuntimeSource(loadedRuntime === 'builtin'
                ? null
                : (response.session.runtimeSource ?? 'system-cli'));

            const { messages: _metaMessages, ...metaOnly } = response.session as SessionMetadata & { messages?: unknown };
            void _metaMessages;
            setSessionMeta(metaOnly as SessionMetadata);
            firstUserTitleProjectionRef.current = (
                response.session.titleSource === 'user'
                || (response.session.title && response.session.title !== 'New Chat')
                || projectedMessages.some(message => (
                    message.role === 'user'
                    && typeof message.content === 'string'
                    && Boolean(deriveSessionTitle(message.content, 40))
                ))
            ) ? 'established' : null;
            const restoredTitle = getSessionDisplayText(response.session);
            currentSessionTitleRef.current = restoredTitle;
            onTitleChangeRef.current?.(restoredTitle);

            if (!isLiveRecovery) {
                const persistedUsage = response.session.lastContextUsage ?? null;
                const seedDecision = decidePersistedContextUsageSeed({
                    snapshotSource: persistedUsage?.source,
                    seedRuntime: loadedRuntime,
                    targetSessionId,
                    liveSessionId: liveContextUsageSessionIdRef.current,
                });
                if (seedDecision === 'seed') {
                    setContextUsage(persistedUsage);
                } else if (seedDecision === 'clear') {
                    liveContextUsageSessionIdRef.current = null;
                    setContextUsage(null);
                }
                setSdkSlashCommands([]);
                setSystemStatus(null);
                setSystemNotice(null);
                setAgentError(null);
                setLastTerminalReason(null);
                setRuntimeDiagnostics(null);
                currentSessionIdRef.current = targetSessionId;
                setCurrentSessionId(targetSessionId);
            }

            setIsLoading(isLiveActive);
            setSessionState(liveSessionState);

            clearInteractiveState();
            for (const pending of response.session.pendingInteractiveRequests ?? []) {
                applySseEvent(pending.type, pending.data);
            }

            liveRevisionFenceRef.current = restoreCompletion.fence;
            publishPersistedRestoreLifecycle({
                phase: 'ready',
                mode: restoreMode,
                sessionId: targetSessionId,
                restoreToken,
                connectionGeneration,
                error: null,
            });
            for (const event of restoreCompletion.replay) {
                applySseEvent(event.eventName, event.data);
            }

            console.log(
                `[TabProvider ${tabId}] Restored ${loadedMessages.length} persisted messages at revision ${response.session.snapshotRevision ?? 0}`,
            );
            return true;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return false;
            }
            const message = error instanceof Error ? error.message : String(error);
            failOwnedRestore(message);
            console.error(`[TabProvider ${tabId}] Persisted session restore failed:`, error);
            return false;
        } finally {
            if (activeRestoreRequestRef.current === restoreRequest) {
                activeRestoreRequestRef.current = null;
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- apiGetJson is stable
    }, [tabId, clearInteractiveState, applySseEvent, clearSessionActive, clearRuntimePlanTodos, abortActiveRestoreRequest, beginPersistedRestore, publishPersistedRestoreLifecycle]);
    // Fetch the page of messages immediately older than the one currently at
    // the top of the history. Called by MessageList when Virtuoso's
    // startReached fires. Safe to call repeatedly — the loadingOlderRef guard
    // coalesces concurrent triggers, and hasMoreBefore short-circuits once
    // the earliest message on disk is loaded.
    const loadOlderMessages = useCallback(async (options?: LoadOlderMessagesOptions): Promise<void> => {
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
                    messages: WireSessionMessage[];
                    hasMoreBefore?: boolean;
                };
            }>(`/sessions/${encodeURIComponent(sid)}?limit=${OLDER_PAGE_SIZE}&before=${encodeURIComponent(oldest.id)}`);

            // Session may have switched while the request was in flight.
            if (currentSessionIdRef.current !== sid) return;
            if (!resp.success || !resp.session) return;

            const older = resp.session.messages.map(wireSessionMessageToMessage);

            if (older.length === 0) {
                setHasMoreBefore(false);
                hasMoreBeforeRef.current = false;
                return;
            }

            const knownBeforeCommit = new Set(historyMessagesRef.current.map(m => m.id));
            const freshBeforeCommit = older.filter(m => !knownBeforeCommit.has(m.id));
            if (freshBeforeCommit.length === 0) {
                const nextHasMore = resp.session.hasMoreBefore ?? false;
                setHasMoreBefore(nextHasMore);
                hasMoreBeforeRef.current = nextHasMore;
                return;
            }
            options?.beforePrepend?.(countVisibleChatTimelineRows(freshBeforeCommit));

            // Prepend raw history in a single React commit, but decrement
            // firstItemIndex only by rows that enter Virtuoso. Hidden persisted
            // task notifications do not occupy the visual index space.
            setHistoryMessages(prev => {
                const known = new Set(prev.map(m => m.id));
                const fresh = older.filter(m => !known.has(m.id));
                if (fresh.length === 0) return prev;
                for (const m of fresh) seenIdsRef.current.add(m.id);
                setFirstItemIndex(idx => shiftFirstItemIndexForVisiblePrepend(idx, fresh));
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
    const restorePersistedSessionRef = useRef(restorePersistedSession);
    restorePersistedSessionRef.current = restorePersistedSession;
    requestLiveRestoreRef.current = (
        targetSessionId,
        restoreToken,
        requestedMode,
        gapRecoveryAttempted,
    ) => {
        const fence = liveRevisionFenceRef.current;
        if (
            currentSessionIdRef.current !== targetSessionId
            || fence.sessionId !== targetSessionId
            || fence.restoreToken !== restoreToken
            || !fence.restoring
        ) {
            return;
        }
        const currentRestore = persistedRestoreLifecycleRef.current;
        const mode: PersistedRestoreMode = requestedMode ?? (
            currentRestore.phase === 'ready' && currentRestore.sessionId === targetSessionId
                ? 'live-recovery'
                : currentRestore.mode
        );
        publishPersistedRestoreLifecycle({
            phase: 'restoring',
            mode,
            sessionId: targetSessionId,
            restoreToken,
            connectionGeneration: fence.connectionGeneration,
            error: null,
        });
        void restorePersistedSessionRef.current(targetSessionId, {
            restoreToken,
            mode,
            gapRecoveryAttempted,
        });
    };

    useEffect(() => {
        if (!isTauri()) return;
        const ac = new AbortController();
        void listenWithCleanup<{ taskId: string; success: boolean; executionCount: number; internalSessionId?: string }>(
            'cron:execution-complete',
            async (event) => {
                const { internalSessionId } = event.payload;
                const currentSid = currentSessionIdRef.current;
                if (!internalSessionId || !currentSid || internalSessionId !== currentSid) return;
                if (persistedRestoreLifecycleRef.current.phase === 'failed') return;

                // Don't disturb an in-flight turn. If the user is still streaming
                // or actively loading this session, let the normal SSE path
                // deliver new messages — appending mid-turn would compete with
                // the streaming message's final move-to-history step.
                if (isStreamingRef.current || isPersistedRestoreInFlight()) {
                    return;
                }

                const last = historyMessagesRef.current.at(-1);
                if (!last) {
                    // Empty tab view — fall through to a full load (first-time open).
                    console.log(`[TabProvider ${tabId}] Cron complete on empty view, full load`);
                    restorePersistedSessionRef.current(internalSessionId, { mode: 'live-recovery' });
                    return;
                }

                try {
                    const resp = await apiGetJson<{
                        success: boolean;
                        fromIndex: number;
                        messages: WireSessionMessage[];
                    }>(`/sessions/${encodeURIComponent(internalSessionId)}/since/${encodeURIComponent(last.id)}`);

                    if (!resp.success) return;

                    // Server couldn't locate our baseline (rewind / compaction /
                    // JSONL rewrite). Fall back to a full reload — still better
                    // than stale data.
                    if (resp.fromIndex === -1) {
                        console.log(`[TabProvider ${tabId}] Cron complete, baseline lost, full reload`);
                        restorePersistedSessionRef.current(internalSessionId, { mode: 'live-recovery' });
                        return;
                    }

                    if (resp.messages.length === 0) return;

                    const appended = resp.messages.map(wireSessionMessageToMessage);

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
                    restorePersistedSessionRef.current(internalSessionId, { mode: 'live-recovery' });
                }
            },
            ac.signal,
        );
        return () => ac.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- apiGetJson is stable via useMemo
    }, [tabId]);

    // Track the previous prop identity so pending/reset births stay on their
    // SSE-native path while persisted targets enter the REST restore lifecycle.
    const prevSessionIdRef = useRef<string | null | undefined>(null);

    // If SSE attachment never completes, persisted history can still load from
    // the target Sidecar over HTTP. This is an existing degraded transport path,
    // not an additional startup delay: the normal path starts as soon as SSE is ready.
    const sseAttachFallbackRef = useRef<{ timer: ReturnType<typeof setTimeout>; sessionId: string } | null>(null);
    const SSE_ATTACH_FALLBACK_MS = 8000;
    const clearSseAttachFallback = useCallback(() => {
        if (sseAttachFallbackRef.current) {
            clearTimeout(sseAttachFallbackRef.current.timer);
            sseAttachFallbackRef.current = null;
        }
    }, []);
    const armSseAttachFallback = useCallback((target: string) => {
        if (sseAttachFallbackRef.current?.sessionId === target) return;
        clearSseAttachFallback();
        const timer = setTimeout(() => {
            sseAttachFallbackRef.current = null;
            const restore = persistedRestoreLifecycleRef.current;
            const request = activeRestoreRequestRef.current;
            const alreadySettled = restore.sessionId === target && restore.phase !== 'restoring';
            if (!shouldDegradedLoad({
                mounted: isMountedRef.current,
                currentSessionId: currentSessionIdRef.current,
                target,
                connectedSseSessionId: attachedSseSessionIdRef.current,
                alreadyLoaded: alreadySettled || request?.sessionId === target,
                prevSessionId: prevSessionIdRef.current,
                sessionActiveOrStreaming: isSessionActiveRef.current || isStreamingRef.current,
                allowWhileActive: true,
            })) return;
            console.warn(`[TabProvider ${tabId}] SSE attach timed out for ${target} after ${SSE_ATTACH_FALLBACK_MS}ms — restoring persisted history over HTTP`);
            void restorePersistedSessionRef.current(target, { mode: 'initial' });
        }, SSE_ATTACH_FALLBACK_MS);
        sseAttachFallbackRef.current = { timer, sessionId: target };
    }, [tabId, clearSseAttachFallback]);
    useEffect(() => clearSseAttachFallback, [clearSseAttachFallback]);

    useEffect(() => {
        const prevSessionId = prevSessionIdRef.current;
        const isPendingSession = isPendingSessionId(sessionId);
        const wasPendingSession = isPendingSessionId(prevSessionId);
        const sessionChanged = prevSessionId !== sessionId;

        if (
            sessionChanged
            && resetBirthSessionIdRef.current
            && resetBirthSessionIdRef.current !== sessionId
        ) {
            isNewSessionRef.current = false;
            resetBirthPendingRef.current = false;
            resetBirthSessionIdRef.current = null;
        }

        const resetSessionBirth = isResetSessionBirth({
            resetBirthSessionId: resetBirthSessionIdRef.current,
            sessionId,
        });
        prevSessionIdRef.current = sessionId;
        clearSseAttachFallback();

        if (!sessionId || isPendingSession) return;

        // Pending materialization and reset/migration birth already own their
        // live projection through SSE; persisted history restoration must not
        // compete with that path.
        if (wasPendingSession || resetSessionBirth) {
            console.log(`[TabProvider ${tabId}] Session ${sessionId} is an SSE-native birth; skipping persisted restore`);
            return;
        }

        const restore = persistedRestoreLifecycleRef.current;
        if (
            restore.sessionId === sessionId
            && (restore.phase === 'inactive' || restore.phase === 'ready' || restore.phase === 'failed')
        ) {
            return;
        }
        if (activeRestoreRequestRef.current?.sessionId === sessionId) return;

        if (!isConnected || attachedSseSessionIdRef.current !== sessionId) {
            armSseAttachFallback(sessionId);
            return;
        }

        if (isNewSessionRef.current) {
            isNewSessionRef.current = false;
            resetBirthPendingRef.current = false;
            resetBirthSessionIdRef.current = null;
        }

        void restorePersistedSession(sessionId, { mode: 'initial' });
    }, [sessionId, isConnected, tabId, restorePersistedSession, armSseAttachFallback, clearSseAttachFallback]);

    const retryCurrentSessionRestore = useCallback(async (
        targetMessageId?: string,
    ): Promise<CurrentSessionRestoreResult> => {
        const targetSessionId = currentSessionIdRef.current;
        if (!targetSessionId || isPendingSessionId(targetSessionId)) {
            return { restored: false, targetMessagePresent: null };
        }
        const restore = persistedRestoreLifecycleRef.current;
        const mode: PersistedRestoreMode = restore.phase === 'ready'
            ? 'live-recovery'
            : restore.mode;
        const fence = beginPersistedRestore(
            targetSessionId,
            sseRef.current?.getConnectionGeneration() ?? 0,
            mode,
        );
        const restored = await restorePersistedSession(targetSessionId, {
            restoreToken: fence.restoreToken,
            mode,
        });
        if (!restored || !targetMessageId) {
            return { restored, targetMessagePresent: null };
        }
        if (historyMessagesRef.current.some(message => message.id === targetMessageId)) {
            return { restored: true, targetMessagePresent: true };
        }

        let before = historyMessagesRef.current[0]?.id;
        let hasOlder = hasMoreBeforeRef.current;
        try {
            while (hasOlder && before) {
                const response = await apiGetJson<{
                    success: boolean;
                    session?: {
                        messages: WireSessionMessage[];
                        hasMoreBefore?: boolean;
                    };
                }>(`/sessions/${encodeURIComponent(targetSessionId)}?limit=${OLDER_PAGE_SIZE}&before=${encodeURIComponent(before)}`);
                if (currentSessionIdRef.current !== targetSessionId || !response.success || !response.session) {
                    return { restored: true, targetMessagePresent: null };
                }
                if (response.session.messages.some(message => message.id === targetMessageId)) {
                    return { restored: true, targetMessagePresent: true };
                }
                hasOlder = response.session.hasMoreBefore ?? false;
                before = response.session.messages[0]?.id;
            }
        } catch {
            return { restored: true, targetMessagePresent: null };
        }
        return {
            restored: true,
            targetMessagePresent: hasOlder ? null : false,
        };
    }, [apiGetJson, beginPersistedRestore, restorePersistedSession]);

    // Cancel a queued message — returns the original text (for restoring to input)
    const cancelQueuedMessage = useCallback(async (queueId: string): Promise<string | null> => {
        if (isRestoreActionBlocked(persistedRestoreLifecycleRef.current.phase)) return null;
        try {
            const response = await postJson<{ success: boolean; stale?: boolean; cancelledText?: string }>('/chat/queue/cancel', { queueId });
            if (response.success) {
                setQueuedMessages(prev => prev.filter(q => q.queueId !== queueId));
                return response.cancelledText ?? null;
            }
            if (response.stale) {
                // The queue owner no longer has this ID (usually because a
                // terminal SSE event was lost or rejected during a session
                // transition). Reconcile the local replica; restoring text
                // here could duplicate an already-executed request.
                setQueuedMessages(prev => prev.filter(q => q.queueId !== queueId));
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
        if (isRestoreActionBlocked(persistedRestoreLifecycleRef.current.phase)) return false;
        const sid = currentSessionIdRef.current ?? sessionId;
        const releaseSendTransition = sid
            ? claimSessionOpeningTransition(sid)
            : null;
        if (sid && !releaseSendTransition) return false;
        try {
            const response = await postJson<{ success: boolean; stale?: boolean }>('/chat/queue/force', { queueId });
            if (response.stale) {
                // A not-found authority response is terminal for this local
                // queue replica. Never retry as a new send: that risks running
                // a request twice if it was already consumed.
                setQueuedMessages(prev => prev.filter(q => q.queueId !== queueId));
            }
            return response.success;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] Force execute queue item failed:`, error);
            return false;
        } finally {
            releaseSendTransition?.();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [tabId, sessionId, claimSessionOpeningTransition]);

    // Respond to permission request
    const respondPermission = useCallback(async (decision: 'deny' | 'allow_once' | 'always_allow', requestIdOverride?: string) => {
        if (isRestoreActionBlocked(persistedRestoreLifecycleRef.current.phase)) return;
        const permission = requestIdOverride
            ? pendingPermissions.find(item => item.requestId === requestIdOverride)
            : pendingPermission;
        if (!permission) return;

        const requestId = permission.requestId;
        const toolName = permission.toolName;
        console.log(`[TabProvider] Permission response: ${decision} for ${toolName}`);

        // Track permission decision
        if (decision === 'deny') {
            trackTabEvent('permission_deny', { tool: toolName });
        } else {
            trackTabEvent('permission_grant', { tool: toolName, type: decision });
        }

        // Send response to backend
        try {
            const response = await postJson<{ success?: boolean; error?: string }>('/api/permission/respond', { requestId, decision });
            if (response.success !== true) {
                throw new Error(response.error || 'Permission response was not accepted by backend');
            }
            setPendingPermissions(prev => removePermissionRequest(prev, requestId));
        } catch (error) {
            console.error('[TabProvider] Failed to send permission response:', error);
            throw error;
        }
    }, [pendingPermission, pendingPermissions, postJson, trackTabEvent]);

    // Respond to AskUserQuestion request
    const respondAskUserQuestion = useCallback(async (answers: Record<string, string> | null) => {
        if (isRestoreActionBlocked(persistedRestoreLifecycleRef.current.phase)) return;
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
        if (isRestoreActionBlocked(persistedRestoreLifecycleRef.current.phase)) return false;
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
        getQueryElapsedSeconds,
        isSessionLoading,
        sessionRestoreError,
        sessionRestoreMode,
        sessionState,
        sessionRuntime,
        sessionRuntimeSource,
        sessionMeta,
        logs,
        unifiedLogs,
        systemInitInfo,
        mcpEffectiveSnapshot,
        sdkSlashCommands,
        runtimeDiagnostics,
        agentError,
        systemStatus,
        systemNotice,
        contextUsage,
        agentPlanTodos,
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
        setSystemNotice,
        setSessionMeta,
        sendMessage,
        stopResponse,
        retryCurrentSessionRestore,
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
    }), [
        tabId, agentDir, currentSessionId, messages, historyMessages, streamingMessage, firstItemIndex, hasMoreBefore, isLoading, isSessionLoading, sessionRestoreError, sessionRestoreMode, sessionState, sessionRuntime, sessionRuntimeSource, sessionMeta,
        logs, unifiedLogs, systemInitInfo, mcpEffectiveSnapshot, sdkSlashCommands, runtimeDiagnostics, agentError, systemStatus, systemNotice, contextUsage, agentPlanTodos, lastTerminalReason, pendingPermission, pendingAskUserQuestion, pendingExitPlanMode, pendingEnterPlanMode, toolCompleteCount, queuedMessages, isConnected,
        getQueryElapsedSeconds, setMessages, appendLog, appendUnifiedLog, clearUnifiedLogs, sendMessage, stopResponse, retryCurrentSessionRestore, loadOlderMessages, resetSession, adoptMigratedSession,
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
