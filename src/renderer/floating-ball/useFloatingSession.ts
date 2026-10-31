import { messageCompletionParams, type MessageCompletionTelemetry } from '@/analytics/conversation';
import { resolveDefaultMcpSelection } from '../../shared/mcpSelection';
import { getProjectAgent } from '@/config/services/agentConfigService';
import { LOG_SESSION_HEADER } from '../../shared/types/log';
import type { AskUserQuestionAnswers } from '../../shared/types/askUserQuestion';
import type { QueuedMessageInfo } from '@/types/queue';
import type { ToolPermissionHints } from '../../shared/types/toolPermission';
import { appendStreamingText, completeStreamingText } from '@/utils/streamingTextBlocks';
import { sameAsyncQuestionReply, type AsyncQuestionReply, type AsyncQuestionSet } from '../../shared/asyncUserQuestions';
/**
 * Desktop-channel session brain for the floating ball companion (PRD 0.2.35).
 *
 * The companion is a "mini Tab": it reuses the whole session-sidecar pipeline
 * (ensure → Rust proxy HTTP → SSE) with a channel identity layered on top —
 * a persistent, config-stored session id routed to the Mino (default) work-
 * space, rotated daily (PRD §6.2: rotation over compaction; cross-session
 * continuity is carried by Mino's memory system, not by session history).
 *
 * It reuses the Tab send/SSE/session surfaces, plus a tiny scenario-sync
 * endpoint so sidecar pre-warm receives the floating-window prompt layer.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { createSseConnection, type SseConnection, type SseEventHandler } from '@/api/SseConnection';
import { useTranscriptSaveToast } from '@/context/useTranscriptSaveToast';
import { applyTranscriptDisplayOperation } from '@/context/transcriptDisplay';
import { applyTranscriptToolDisplayEvent, TRANSCRIPT_TOOL_DISPLAY_EVENTS, type TranscriptToolDisplayEvent } from '@/context/transcriptToolDisplay';
import { EMPTY_LIVE_REVISION_FENCE, beginLiveRevisionRestore, completeLiveRevisionRestore, ingestLiveRevisionEvent } from '@/context/liveRevisionFence';
import type { TranscriptOperation, TranscriptSaveStatus } from '../../shared/sessionTranscript';
import { ensureSessionSidecar, getSessionPort, sessionSidecarFetch, releaseSessionSidecar, startBackgroundCompletion } from '@/api/tauriClient';
import { fetchJsonLargeValueRef } from '@/api/largeValueRef';
import { createSession } from '@/api/sessionClient';
import { initAnalytics, setAnalyticsContext, track } from '@/analytics';
import { originAnalyticsFields } from '../../shared/session-origin';
import { loadAppConfig, atomicModifyConfig } from '@/config/services/appConfigService';
import { getAllMcpServersFromConfig } from '@/config/services/mcpService';
import { loadProjects } from '@/config/services/projectService';
import type { AppConfig, Project } from '@/config/types';
import { resolveAttachmentUrl } from '@/utils/attachmentUrl';
import { listenWithCleanup } from '@/utils/tauriListen';
import { parsePartialJson } from '@/utils/parsePartialJson';
import { enqueuePermissionRequest, peekPermissionRequest, removePermissionRequest } from '@/utils/permissionQueue';
import { i18n } from '@/i18n';
import { isSubagentContainerTool } from '@/components/tools/toolBadgeConfig';
import {
    applySubagentLifecycleToContent,
    isSubagentContainerRunning,
} from '@/components/tools/subagentActivity';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { localDate } from '../../shared/logTime';
import { stripLeadingSystemReminder } from '../../shared/systemReminder';
import type { AskUserQuestionRequest } from '../../shared/types/askUserQuestion';
import type { ExitPlanModeRequest } from '../../shared/types/planMode';
import type { SubagentLifecycle } from '../../shared/types/subagent-lifecycle';
import {
    normalizeRuntime,
    runtimeSourceForRuntimeType,
    type RuntimeSource,
    type RuntimeType,
} from '../../shared/types/runtime';
import { runtimeTypeForBinding, runtimeSourceForBinding, type EffectiveRuntimeBinding } from '../../shared/integrated-runtimes/identity';
import type { FbPendingKind } from './petStateMapper';
import { resolveBoundWorkspace, type FbProject } from './workspaceBinding';
import { SESSION_MIGRATED_EVENT, type FloatingBallSessionMigratedPayload } from './sessionBinding';
import type { ContentBlock, Message, ProviderToolUsePayload, ToolAttachment, ToolInput, ToolUseSimple } from '@/types/chat';
import type { ToolUse } from '@/types/stream';

export interface FbAttachment {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    relativePath?: string;
    previewUrl?: string;
    isImage?: boolean;
}

export interface FbUserMsg {
    timestamp?: string;
    asyncQuestionReply?: AsyncQuestionReply;
    id: string;
    role: 'user';
    text: string;
    quote?: string;
    attachments?: FbAttachment[];
}

export interface FbAssistantMsg {
    timestamp?: string;
    id: string;
    role: 'ai';
    content: ContentBlock[];
    streamingTextActive?: boolean;
}

export type FbMsg = FbUserMsg | FbAssistantMsg;

/** Adapt only the surface representation; all V2 content semantics are shared
 * with Chat's reducers, including historical and nested tool updates. */
function updateFloatingDisplay(message: FbMsg, update: (row: Message) => Message): FbMsg {
    const row = update({
        id: message.id, role: message.role === 'ai' ? 'assistant' : 'user',
        content: message.role === 'ai' ? message.content : message.text,
        timestamp: new Date(message.timestamp ?? 0),
    });
    return message.role === 'ai'
        ? { ...message, content: Array.isArray(row.content) ? row.content : parseAssistantContent(row.content) }
        : { ...message, text: stripLeadingSystemReminder(typeof row.content === 'string' ? row.content : extractMessageText(JSON.stringify(row.content))) };
}

/** Derived live activity row during a turn（思考/工具调用的单行展示）。 */
export interface FbActivity {
    id: string;
    kind: 'thinking' | 'tool';
    running: boolean;
    startedAt: number;
    durationMs?: number;
    tool?: ToolUseSimple;
}

export interface FbPermReq extends ToolPermissionHints {
    requestId: string;
    sessionId?: string | null;
    toolName: string;
    input: string;
}

export interface FbSendOpts {
    asyncQuestionReply?: AsyncQuestionReply;
    quote?: string | null;
    images?: Array<
        | { kind?: 'inline_base64'; id?: string; name: string; mimeType: string; data: string; sizeBytes?: number }
        | { kind: 'attachment_ref'; id?: string; name: string; mimeType: string; relativePath: string; sizeBytes?: number }
    >;
    attachments?: FbAttachment[];
    /** Eager-captured source window（最前台 app / 窗口标题）— context reminder only. */
    appName?: string | null;
    windowTitle?: string | null;
    screenshotAttached?: boolean;
}

const OWNER_ID = 'floating-ball';
const HISTORY_LIMIT = 50;
const TOOL_RESULT_DISPLAY_CAP = 8 * 1024;
const TOOL_RESULT_TAIL_KEEP = 1024;

function fbText(key: string, options?: Record<string, unknown>): string {
    return String(i18n.t(`app:floatingSession.${key}`, options));
}

function elapsedMs(startedAt: number): string {
    return `${Date.now() - startedAt}ms`;
}

function describeError(err: unknown): string {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function isContentBlock(value: unknown): value is ContentBlock {
    if (!value || typeof value !== 'object') return false;
    const type = (value as { type?: unknown }).type;
    return type === 'text' || type === 'thinking' || type === 'tool_use' || type === 'server_tool_use';
}

function parseAssistantContent(content: string): ContentBlock[] {
    if (!content) return [];
    const trimmed = content.trim();
    if (trimmed.startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.filter(isContentBlock);
        } catch {
            // Fall through to plain text.
        }
    }
    if (trimmed.startsWith('{')) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') {
                const obj = parsed as { text?: unknown; content?: unknown };
                const text = typeof obj.text === 'string'
                    ? obj.text
                    : typeof obj.content === 'string'
                        ? obj.content
                        : '';
                return text ? [{ type: 'text', text }] : [];
            }
        } catch {
            // Fall through to plain text.
        }
    }
    return content ? [{ type: 'text', text: content }] : [];
}

function isToolBlock(block: ContentBlock): block is ContentBlock & { tool: ToolUseSimple } {
    return (block.type === 'tool_use' || block.type === 'server_tool_use') && !!block.tool;
}

function replaceFloatingToolInput(
    message: FbAssistantMsg,
    toolUseId: string,
    input: Record<string, unknown>,
): FbAssistantMsg {
    return {
        ...message,
        content: message.content.map((block) => {
            if (!isToolBlock(block) || block.tool.id !== toolUseId) return block;
            return {
                ...block,
                tool: {
                    ...block.tool,
                    input,
                    inputJson: undefined,
                    parsedInput: input as ToolInput,
                },
            };
        }),
    };
}

function closeOpenThinkingBlocks(content: ContentBlock[], now = Date.now()): ContentBlock[] {
    if (!content.some((b) => b.type === 'thinking' && !b.isComplete)) return content;
    return content.map((b) =>
        b.type === 'thinking' && !b.isComplete
            ? { ...b, isComplete: true, thinkingDurationMs: b.thinkingStartedAt ? now - b.thinkingStartedAt : undefined }
            : b,
    );
}

function clampToolResult(existing: string, delta: string): string {
    let nextResult = existing + delta;
    if (nextResult.length > TOOL_RESULT_DISPLAY_CAP) {
        const head = nextResult.slice(0, TOOL_RESULT_DISPLAY_CAP - TOOL_RESULT_TAIL_KEEP);
        const tail = nextResult.slice(-TOOL_RESULT_TAIL_KEEP);
        nextResult = `${head}\n…[truncated for display; full result available on completion]…\n${tail}`;
    }
    return nextResult;
}

function mergeAttachmentsByPendingId(
    existing: ToolAttachment[] | undefined,
    incoming: ToolAttachment[] | undefined,
): ToolAttachment[] | undefined {
    if (!incoming?.length) return existing;
    if (!existing?.length) return incoming;
    const byPending = new Map<string, number>();
    existing.forEach((att, idx) => {
        if (att.pendingId) byPending.set(att.pendingId, idx);
    });
    const merged = [...existing];
    for (const att of incoming) {
        const idx = att.pendingId ? byPending.get(att.pendingId) : undefined;
        if (idx !== undefined) {
            merged[idx] = att;
        } else {
            merged.push(att);
        }
    }
    return merged;
}

export function deriveActivities(message: FbAssistantMsg | null): FbActivity[] {
    if (!message) return [];
    return message.content.flatMap((block, index): FbActivity[] => {
        if (block.type === 'thinking') {
            return [{
                id: `${message.id}-thinking-${block.thinkingStreamIndex ?? index}`,
                kind: 'thinking',
                running: block.isComplete !== true && !block.isFailed && !block.isStopped,
                startedAt: block.thinkingStartedAt ?? 0,
                durationMs: block.thinkingDurationMs,
            }];
        }
        if (isToolBlock(block)) {
            return [{
                id: block.tool.id,
                kind: 'tool',
                running: isSubagentContainerTool(block.tool.name)
                    ? isSubagentContainerRunning(block.tool)
                    : Boolean(block.tool.isLoading),
                startedAt: block.tool.taskStartTime ?? 0,
                durationMs: block.tool.resultMeta?.durationMs ?? undefined,
                tool: block.tool,
            }];
        }
        return [];
    });
}

export function applyFloatingSubagentLifecycle(
    message: FbAssistantMsg,
    parentToolUseId: string,
    lifecycle: SubagentLifecycle,
): FbAssistantMsg {
    const content = applySubagentLifecycleToContent(
        message.content,
        parentToolUseId,
        lifecycle,
    );
    if (!content || content === message.content) return message;
    return { ...message, content };
}

/** Best-effort text extraction from SessionMessage.content (JSON blocks or plain). */
export function extractMessageText(content: string): string {
    if (!content) return '';
    const trimmed = content.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return parsed
                .map((block) => {
                    if (block && typeof block === 'object') {
                        const b = block as { type?: string; text?: string };
                        if (typeof b.text === 'string') return b.text;
                    }
                    return '';
                })
                .filter(Boolean)
                .join('\n\n');
        }
        if (parsed && typeof parsed === 'object') {
            const obj = parsed as { text?: string; content?: string };
            if (typeof obj.text === 'string') return obj.text;
            if (typeof obj.content === 'string') return obj.content;
        }
    } catch {
        // Not JSON — render as-is.
    }
    return content;
}

/**
 * Parse the `GET /sessions/:id` response into companion messages.
 * Response shape is `{ success, session: { messages: SessionMessage[] } }`
 * (src/server/index.ts — the same payload TabProvider reads via
 * `response.session.messages`); reading top-level `.messages` was the
 * review-caught fabrication that left history backfill永远为空.
 */
export function parseSessionHistory(payload: unknown, limit: number): FbMsg[] {
    const session = (payload as { session?: { messages?: unknown; transcriptFormat?: 2 } } | null)?.session;
    const raw = Array.isArray(session?.messages)
        ? (session.messages as Array<{ id?: string; role?: string; content?: string }>)
        : [];
    return raw
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .slice(-limit)
        .map<FbMsg | null>((m, i) => {
            const msg = m as {
                id?: string;
                role?: string;
                timestamp?: string;
                asyncQuestionReply?: AsyncQuestionReply;
                content?: string | ContentBlock[];
                attachments?: Array<{ id?: string; name?: string; mimeType?: string; path?: string; previewUrl?: string }>;
            };
            const attachments = msg.attachments?.map((att, idx) => ({
                id: att.id ?? `${msg.id ?? `h-${i}`}-att-${idx}`,
                name: att.name ?? 'attachment',
                size: 0,
                mimeType: att.mimeType ?? 'application/octet-stream',
                previewUrl: resolveAttachmentUrl({ savedPath: att.path ?? '', previewUrl: att.previewUrl }),
                isImage: (att.mimeType ?? '').startsWith('image/'),
            }));
            if (msg.role === 'assistant') {
                const content = Array.isArray(msg.content) ? msg.content : parseAssistantContent(msg.content ?? '');
                if (content.length === 0 && session?.transcriptFormat !== 2) return null;
                return {
                    id: msg.id ?? `h-${i}`,
                    timestamp: msg.timestamp,
                    role: 'ai',
                    content,
                };
            }
            return {
                id: msg.id ?? `h-${i}`,
                timestamp: msg.timestamp,
                role: 'user',
                asyncQuestionReply: msg.asyncQuestionReply,
                text: stripLeadingSystemReminder(session?.transcriptFormat === 2 && typeof msg.content === 'string'
                    ? msg.content : extractMessageText(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''))),
                attachments,
            };
        })
        .filter((m): m is FbMsg => {
            if (!m) return false;
            // V2 creates an empty target before its text/block operations arrive.
            if (session?.transcriptFormat === 2) return true;
            if (m.role === 'ai') return m.content.length > 0;
            return m.text.trim().length > 0 || (m.attachments?.length ?? 0) > 0;
        });
}

async function sessionDataPlaneBaseUrl(sessionId: string): Promise<string | null> {
    const port = await getSessionPort(sessionId);
    return port === null ? null : `http://127.0.0.1:${port}`;
}

function headerRecord(headers?: HeadersInit): Record<string, string> {
    const out: Record<string, string> = {};
    if (!headers) return out;
    if (headers instanceof Headers) {
        headers.forEach((value, key) => {
            out[key] = value;
        });
    } else if (Array.isArray(headers)) {
        headers.forEach(([key, value]) => {
            out[key] = String(value);
        });
    } else {
        Object.assign(out, headers);
    }
    return out;
}

function withFloatingCorrelation(sessionId: string, options: RequestInit = {}): RequestInit {
    return {
        ...options,
        headers: {
            ...headerRecord(options.headers),
            [LOG_SESSION_HEADER]: sessionId,
            'X-MyAgents-Tab-Id': OWNER_ID,
        },
    };
}

function floatingProxyFetch(sessionId: string, path: string, options?: RequestInit): Promise<Response> {
    return sessionSidecarFetch(
        sessionId,
        { type: 'companion', id: OWNER_ID },
        path,
        withFloatingCorrelation(sessionId, options),
    );
}

type EnabledAgentsResponse = {
    success: boolean;
    agents?: Record<string, { description: string; prompt: string; model?: string; scope?: 'user' | 'project'; folderName?: string }>;
    error?: string;
};

async function syncFloatingSidecarConfig(
    sessionId: string,
    workspacePath: string,
    config: AppConfig,
    projects: Project[],
): Promise<void> {
    const startedAt = Date.now();
    let stage = 'dispatch';
    console.info(`[fb-session] sync config start session=${sessionId} workspace=${workspacePath}`);

    try {
        const project = projects.find((p) => workspacePathsEqual(p.path, workspacePath));
        const globalEnabled = new Set(Array.isArray(config.mcpEnabledServers) ? config.mcpEnabledServers : []);
        const workspaceEnabled = resolveDefaultMcpSelection(getProjectAgent(config, projects, workspacePath), project);
        const allServers = getAllMcpServersFromConfig(config);
        const effectiveServers = allServers.filter((s) =>
            globalEnabled.has(s.id) && workspaceEnabled.includes(s.id),
        );

        stage = 'scenario-set';
        const scenarioResp = await floatingProxyFetch(sessionId, '/api/interaction-scenario/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scenario: { type: 'desktop', surface: 'floating-ball' } }),
        });
        if (!scenarioResp.ok) throw new Error(`Scenario sync failed: HTTP ${scenarioResp.status}`);

        stage = 'mcp-set';
        console.info(`[fb-session] sync mcp start session=${sessionId} servers=${effectiveServers.length}`);
        const mcpResp = await floatingProxyFetch(sessionId, '/api/mcp/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ servers: effectiveServers }),
        });
        if (!mcpResp.ok) throw new Error(`MCP sync failed: HTTP ${mcpResp.status}`);

        stage = 'agent-scan';
        const agentsQuery = new URLSearchParams({ agentDir: workspacePath });
        const agentsResp = await floatingProxyFetch(sessionId, `/api/agents/enabled?${agentsQuery}`);
        if (!agentsResp.ok) throw new Error(`Agent scan failed: HTTP ${agentsResp.status}`);
        const agentsBody = (await agentsResp.json().catch(() => ({}))) as EnabledAgentsResponse;
        if (!agentsBody.success || !agentsBody.agents) {
            throw new Error(agentsBody.error || 'Agent scan failed');
        }

        stage = 'agent-set';
        const agentCount = Object.keys(agentsBody.agents).length;
        console.info(`[fb-session] sync agents start session=${sessionId} agents=${agentCount}`);
        const setAgentsResp = await floatingProxyFetch(sessionId, '/api/agents/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agents: agentsBody.agents }),
        });
        if (!setAgentsResp.ok) throw new Error(`Agent sync failed: HTTP ${setAgentsResp.status}`);
        console.info(
            `[fb-session] sync config done session=${sessionId} mcp=${effectiveServers.length} agents=${agentCount} elapsed=${elapsedMs(startedAt)}`,
        );
    } catch (err) {
        console.error(
            `[fb-session] sync config failed session=${sessionId} stage=${stage} elapsed=${elapsedMs(startedAt)} error=${describeError(err)}`,
        );
        throw err;
    }
}

/**
 * 断言一次 respond POST 真的被后端接受（cross-review C3）。respond 端点对未知 /
 * 过期 / 已轮换的 requestId 会回 **HTTP 200 `{success:false}`**（agent-session 的
 * handleXxxResponse 返回 false），只查 `resp.ok` 会把它当成功清掉卡片 → 后端 pending
 * 仍永久挂起、用户无从重试。这里要求 `success===true` 才算成功，否则抛错让卡片留着。
 */
async function assertRespondSucceeded(resp: Response): Promise<void> {
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (body.success !== true) {
        throw new Error(body.error || fbText('backendNotConfirmed'));
    }
}

export function useFloatingSession(modeRef: React.MutableRefObject<'hidden' | 'peek' | 'pin'>) {
    const showTranscriptSaveToast = useTranscriptSaveToast();
    const transcriptFormatRef = useRef<2 | undefined>(undefined);
    const revisionFenceRef = useRef(EMPTY_LIVE_REVISION_FENCE);
    const restoreTranscriptRef = useRef<() => Promise<void>>(async () => undefined);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [workspacePath, setWorkspacePath] = useState<string | null>(null);
    const [workspaceName, setWorkspaceName] = useState<string>('Mino');
    const [messages, setMessages] = useState<FbMsg[]>([]);
    const [queuedMessages, setQueuedMessages] = useState<QueuedMessageInfo[]>([]);
    const [liveMessage, setLiveMessage] = useState<FbAssistantMsg | null>(null);
    const [busy, setBusy] = useState(false);
    const [permReqs, setPermReqs] = useState<FbPermReq[]>([]);
    const permReq = peekPermissionRequest(permReqs);
    // 交互表单（D13）：用户提问 / 方案审核。与 permReq 并列驱动「等我」球态。
    const [askReq, setAskReq] = useState<AskUserQuestionRequest | null>(null);
    const [planReq, setPlanReq] = useState<ExitPlanModeRequest | null>(null);
    // 本 session 的有效权限模式（D14：创建时种最宽松、之后跟随活状态）。
    // 发送时随消息走（不再硬编码 fullAgency）；chat:permission-mode-changed /
    // 展开 Tab 改 / resume 读快照 三处更新。
    const [permissionMode, setPermissionMode] = useState<string>('fullAgency');
    const [runtime, setRuntime] = useState<string>('builtin');
    const [providerId, setProviderId] = useState<string | null>(null);
    const [model, setModel] = useState<string | null>(null);
    // 设置面板（D17）：可绑定工作区列表 + 当前覆盖（null=跟随默认）。
    const [projects, setProjects] = useState<FbProject[]>([]);
    const [workspaceOverride, setWorkspaceOverride] = useState<string | null>(null);
    const [unread, setUnread] = useState(0);
    const [sendShortcut, setSendShortcut] = useState<'enter' | 'modEnter'>('enter');
    const liveMessageRef = useRef<FbAssistantMsg | null>(null);

    const sessionIdRef = useRef<string | null>(null);
    const sseRef = useRef<SseConnection | null>(null);
    const bootedRef = useRef(false);
    const busyRef = useRef(false);
    const isCurrentInteractiveEvent = useCallback((eventSessionId?: string | null): boolean => {
        const current = sessionIdRef.current;
        return !eventSessionId || !current || eventSessionId === current;
    }, []);
    const migrationInFlightRef = useRef(false);
    const queuedMigrationEventsRef = useRef<FloatingBallSessionMigratedPayload[]>([]);
    useEffect(() => {
        busyRef.current = busy;
    }, [busy]);
    // send 是 []-deps 的稳定 useCallback，权限模式经 ref 读最新（避免 stale 闭包）。
    const permissionModeRef = useRef(permissionMode);
    useEffect(() => {
        permissionModeRef.current = permissionMode;
    }, [permissionMode]);
    // 旧会话是否卡在"等我"的表单上——轮换时据此决定是否中止旧轮（见 rotateTo）。
    // 用 ref 让 rotateTo 不必把这三个 state 纳入依赖（否则会 churn 整条轮换链）。
    const pendingFormRef = useRef(false);
    useEffect(() => {
        pendingFormRef.current = !!(permReq || askReq || planReq);
    }, [permReq, askReq, planReq]);
    const sessionDateRef = useRef<string | null>(null);
    const workspaceRef = useRef<{ path: string } | null>(null);
    // SSE handler 里要触发轮换（会话失效自愈），但 rotateTo 声明在其后——
    // 经 ref 解耦（effect 同步，见 rotateTo 定义处）。
    const rotateToRef = useRef<(today: string, ws: { path: string; name?: string }) => Promise<void>>(
        async () => undefined,
    );
    // Attribution comes from this Companion Session, never the active Chat Tab.
    // Until its execution snapshot arrives, the Runtime remains unknown.
    const analyticsRuntimeRef = useRef<RuntimeType | 'unknown'>('unknown');
    const analyticsRuntimeSourceRef = useRef<RuntimeSource | null>(null);
    const analyticsModelRef = useRef<string | null>(null);
    const trackSessionEvent = useCallback((event: string, params: Record<string, string | number | boolean | null | undefined> = {}) => {
        track(event, {
            source: 'floating_ball', surface: 'floating_ball', session_id: sessionIdRef.current,
            runtime: analyticsRuntimeRef.current, runtime_source: analyticsRuntimeSourceRef.current, ...params,
        });
    }, []);

    const applySessionSnapshot = useCallback((meta: { runtimeBinding?: EffectiveRuntimeBinding; runtime?: string; runtimeSource?: RuntimeSource; providerId?: string; model?: string } | null | undefined) => {
        if (!meta) return;
        const snapshotRuntime = meta.runtimeBinding ? runtimeTypeForBinding(meta.runtimeBinding) : normalizeRuntime(meta.runtime);
        analyticsRuntimeRef.current = snapshotRuntime;
        analyticsRuntimeSourceRef.current = runtimeSourceForRuntimeType(snapshotRuntime, meta.runtimeBinding ? runtimeSourceForBinding(meta.runtimeBinding) : meta.runtimeSource) ?? null;
        analyticsModelRef.current = meta.model ?? null;
        setRuntime(snapshotRuntime);
        setProviderId(meta.providerId ?? null);
        setModel(meta.model ?? null);
    }, []);

    // ── ball state push（球状态 = 本 hook 的派生态，经 Rust 转发） ──
    // 「等我 / blocked」= 任意 pending 交互表单（权限 / 提问 / 方案审核）。这让
    // §3.4 的核心「等我」态真正活起来——此前只看 permReq，而 fullAgency 下它几乎
    // 不来、真正会来的 ask-user-question 又不驱动它（PRD §14.1）。
    useEffect(() => {
        const blocked = permReq || askReq || planReq;
        const state = blocked ? 'blocked' : busy ? 'running' : unread > 0 ? 'done' : 'idle';
        const pendingKind: FbPendingKind | undefined = planReq ? 'plan' : permReq ? 'permission' : askReq ? 'ask' : undefined;
        void invoke('cmd_fb_relay', {
            target: 'ball',
            event: 'fb:state',
            payload: { state, count: unread, pendingKind, hasError: Boolean(error) },
        }).catch(() => undefined);
    }, [permReq, askReq, planReq, busy, unread, error]);

    const replaceLiveMessage = useCallback((updater: (current: FbAssistantMsg | null) => FbAssistantMsg | null) => {
        const next = updater(liveMessageRef.current);
        liveMessageRef.current = next;
        setLiveMessage(next);
    }, []);

    const updateLiveContent = useCallback((
        updater: (content: ContentBlock[], current: FbAssistantMsg | null) => { content: ContentBlock[]; streamingTextActive?: boolean },
    ) => {
        replaceLiveMessage((current) => {
            const base: FbAssistantMsg = current ?? {
                id: `ai-${Date.now()}`,
                role: 'ai',
                content: [],
                streamingTextActive: false,
            };
            const next = updater(base.content, base);
            return {
                ...base,
                content: next.content,
                streamingTextActive: next.streamingTextActive ?? base.streamingTextActive,
            };
        });
    }, [replaceLiveMessage]);

    const appendTextChunk = useCallback((chunk: string) => {
        updateLiveContent(content => ({
            content: appendStreamingText(closeOpenThinkingBlocks(content), chunk) as ContentBlock[],
            streamingTextActive: true,
        }));
    }, [updateLiveContent]);

    const markTextStopped = useCallback((questions?: AsyncQuestionSet) => {
        if (!questions && !liveMessageRef.current) return;
        updateLiveContent(content => ({ content: completeStreamingText(content, questions), streamingTextActive: false }));
    }, [updateLiveContent]);

    const appendThinkingBlock = useCallback((index: number | undefined) => {
        const now = Date.now();
        updateLiveContent((content) => {
            const closed = closeOpenThinkingBlocks(content, now);
            if (index !== undefined && closed.some((b) => b.type === 'thinking' && b.thinkingStreamIndex === index && !b.isComplete)) {
                return { content: closed, streamingTextActive: false };
            }
            return {
                content: [
                    ...closed,
                    {
                        type: 'thinking',
                        thinking: '',
                        thinkingStreamIndex: index,
                        thinkingStartedAt: now,
                    },
                ],
                streamingTextActive: false,
            };
        });
    }, [updateLiveContent]);

    const appendToolBlock = useCallback((payload: ToolUse | ProviderToolUsePayload, blockType: 'tool_use' | 'server_tool_use') => {
        const initialInputJson = Object.keys(payload.input ?? {}).length > 0
            ? JSON.stringify(payload.input, null, 2)
            : '';
        const initialParsedInput = Object.keys(payload.input ?? {}).length > 0
            ? payload.input as unknown as ToolInput
            : undefined;
        const taskFields = isSubagentContainerTool(payload.name)
            ? {
                taskStartTime: Date.now(),
                taskStats: { toolCount: 0, inputTokens: 0, outputTokens: 0 },
            }
            : {};
        const tool: ToolUseSimple = {
            ...payload,
            inputJson: initialInputJson,
            parsedInput: initialParsedInput,
            isLoading: true,
            ...taskFields,
        };
        updateLiveContent((content) => ({
            content: [
                ...closeOpenThinkingBlocks(content),
                {
                    type: blockType,
                    providerRouteId: blockType === 'server_tool_use'
                        ? (payload as ProviderToolUsePayload).providerRouteId
                        : undefined,
                    providerBlockType: blockType === 'server_tool_use'
                        ? (payload as ProviderToolUsePayload).providerBlockType
                        : undefined,
                    tool,
                },
            ],
            streamingTextActive: false,
        }));
    }, [updateLiveContent]);

    const updateToolBlock = useCallback((
        toolUseId: string | undefined,
        updater: (tool: ToolUseSimple) => ToolUseSimple,
    ) => {
        if (!toolUseId) return;
        updateLiveContent((content, current) => ({
            content: content.map((block) => {
                if (!isToolBlock(block) || block.tool.id !== toolUseId) return block;
                return { ...block, tool: updater(block.tool) };
            }),
            streamingTextActive: current?.streamingTextActive ?? false,
        }));
    }, [updateLiveContent]);

    const finalizeStream = useCallback((terminal?: 'stopped' | 'failed') => {
        const current = liveMessageRef.current;
        if (transcriptFormatRef.current === 2) {
            // Terminal content/tool state belongs to the canonical operations.
            // A background child may legitimately outlive the foreground turn.
            if (current) setMessages(rows => [...rows.filter(row => row.id !== current.id), current]);
            replaceLiveMessage(() => null);
            return;
        }
        if (!current || current.content.length === 0) {
            replaceLiveMessage(() => null);
            return;
        }
        const now = Date.now();
        const finalized: FbAssistantMsg = {
            ...current,
            streamingTextActive: false,
            content: closeOpenThinkingBlocks(current.content, now).map((block) => {
                if (block.type === 'thinking') {
                    return {
                        ...block,
                        isComplete: true,
                        isStopped: terminal === 'stopped' ? true : block.isStopped,
                        isFailed: terminal === 'failed' ? true : block.isFailed,
                        thinkingDurationMs: block.thinkingDurationMs
                            ?? (block.thinkingStartedAt ? now - block.thinkingStartedAt : undefined),
                    };
                }
                if (isToolBlock(block)) {
                    return {
                        ...block,
                        tool: {
                            ...block.tool,
                            isLoading: false,
                            isStopped: terminal === 'stopped' ? true : block.tool.isStopped,
                            isFailed: terminal === 'failed' ? true : block.tool.isFailed,
                        },
                    };
                }
                return block;
            }),
        };
        replaceLiveMessage(() => null);
        setMessages((prev) => [...prev, finalized]);
    }, [replaceLiveMessage]);

    const handleSseEvent = useCallback(
        (eventName: string, data: unknown) => {
            const updateRows = (update: (row: Message) => Message) => {
                setMessages(rows => rows.map(row => updateFloatingDisplay(row, update)));
                replaceLiveMessage(row => row ? updateFloatingDisplay(row, update) as FbAssistantMsg : null);
            };
            if (transcriptFormatRef.current === 2 && TRANSCRIPT_TOOL_DISPLAY_EVENTS.has(eventName)) {
                const payload = data as TranscriptToolDisplayEvent;
                updateRows(row => applyTranscriptToolDisplayEvent(row, eventName, payload));
                if (payload.inputRef) {
                    const fence = revisionFenceRef.current;
                    void sessionDataPlaneBaseUrl(fence.sessionId!).then(baseUrl => {
                        if (!baseUrl) throw new Error('Session sidecar is unavailable');
                        return fetchJsonLargeValueRef(baseUrl, payload.inputRef);
                    }).then(input => {
                        const current = revisionFenceRef.current;
                        if (current.sessionId !== fence.sessionId || current.restoreToken !== fence.restoreToken) return;
                        updateRows(row => applyTranscriptToolDisplayEvent(row, eventName, { ...payload, inputRef: undefined, input, finalInput: true }));
                    }).catch(err => console.warn('[fb-session] tool input preview failed:', err));
                }
                return;
            }
            if (transcriptFormatRef.current === 2 && ['chat:message-chunk', 'chat:thinking-start', 'chat:thinking-chunk', 'chat:message-replay', 'chat:messages-retracted'].includes(eventName)) return;
            switch (eventName) {
                case 'chat:transcript-operation': {
                    const { sessionId: sid, operation } = data as { sessionId: string; operation: TranscriptOperation };
                    if (!isCurrentInteractiveEvent(sid)) break;
                    transcriptFormatRef.current = 2;
                    if (operation.kind === 'message-create') {
                        const message = parseSessionHistory({ session: { transcriptFormat: 2, messages: [operation.message] } }, 1)[0];
                        if (!message || liveMessageRef.current?.id === message.id) break;
                        finalizeStream();
                        if (message.role === 'ai') {
                            replaceLiveMessage(() => message);
                            setBusy(true);
                        } else setMessages(rows => [...rows.filter(row => row.id !== message.id), message]);
                    } else if (operation.kind === 'messages-remove') {
                        setMessages(rows => rows.filter(row => !operation.messageIds.includes(row.id)));
                        replaceLiveMessage(row => row && operation.messageIds.includes(row.id) ? null : row);
                    } else if (operation.kind !== 'turn-update') {
                        updateRows(row => applyTranscriptDisplayOperation(row, operation));
                    }
                    break;
                }
                case 'chat:transcript-save-status': {
                    const status = data as TranscriptSaveStatus;
                    if (isCurrentInteractiveEvent(status.sessionId)) showTranscriptSaveToast(status);
                    break;
                }
                case 'chat:init': {
                    const payload = data as { sessionId?: string; transcriptFormat?: 2; transcriptSaveStatus?: TranscriptSaveStatus; queuedMessages?: Array<{ id: string; messagePreview: string; asyncQuestionReply?: AsyncQuestionReply }>; liveStreamingMessage?: { id: string; content: string } } | null;
                    if (!isCurrentInteractiveEvent(payload?.sessionId)) break;
                    transcriptFormatRef.current = payload?.transcriptFormat;
                    if (payload?.transcriptSaveStatus) showTranscriptSaveToast(payload.transcriptSaveStatus);
                    if (payload?.transcriptFormat === 2) break; // Revisioned REST owns the baseline.
                    if (payload?.queuedMessages) setQueuedMessages(payload.queuedMessages.map(item => ({ queueId: item.id, text: item.messagePreview, asyncQuestionReply: item.asyncQuestionReply, timestamp: Date.now() })));
                    if (payload?.liveStreamingMessage) {
                        const message = payload.liveStreamingMessage;
                        replaceLiveMessage(() => ({ id: message.id, role: 'ai', content: parseAssistantContent(message.content) }));
                    }
                    break;
                }
                case 'queue:added': {
                    const payload = data as { queueId?: string; messageText?: string; asyncQuestionReply?: AsyncQuestionReply } | null;
                    if (!payload?.queueId || !payload.asyncQuestionReply) break;
                    const reply = payload.asyncQuestionReply;
                    const entry = { queueId: payload.queueId, text: payload.messageText ?? '', asyncQuestionReply: reply, timestamp: Date.now() };
                    setQueuedMessages(prev => [...prev.filter(item => item.queueId !== entry.queueId && !sameAsyncQuestionReply(item.asyncQuestionReply, reply)), entry]);
                    break;
                }
                case 'queue:cancelled': {
                    const payload = data as { queueId?: string } | null;
                    setQueuedMessages(prev => prev.filter(item => item.queueId !== payload?.queueId));
                    break;
                }
                case 'queue:started':
                case 'chat:message-replay': {
                    const payload = data as { sessionId?: string; queueId?: string; midTurnBreak?: boolean; userMessage?: unknown; message?: unknown } | null;
                    if (!isCurrentInteractiveEvent(payload?.sessionId)) break;
                    if (transcriptFormatRef.current === 2) {
                        const message = parseSessionHistory({ session: { transcriptFormat: 2, messages: [payload?.userMessage ?? payload?.message] } }, 1)[0];
                        const reply = message?.role === 'user' ? message.asyncQuestionReply : undefined;
                        setQueuedMessages(prev => prev.filter(item => item.queueId !== payload?.queueId && (!reply || !sameAsyncQuestionReply(item.asyncQuestionReply, reply))));
                        break;
                    }
                    const message = parseSessionHistory({ session: { messages: [payload?.userMessage ?? payload?.message] } }, 1)[0];
                    if (!message || message.role !== 'user' || !message.asyncQuestionReply) break;
                    const reply = message.asyncQuestionReply;
                    if (payload?.midTurnBreak) finalizeStream();
                    setMessages(prev => prev.some(item => item.id === message.id) ? prev : [...prev, message]);
                    setQueuedMessages(prev => prev.filter(item => item.queueId !== payload?.queueId && !sameAsyncQuestionReply(item.asyncQuestionReply, reply)));
                    break;
                }
                case 'chat:messages-retracted': {
                    const payload = data as { messageIds?: string[] } | null;
                    if (payload?.messageIds) setMessages(prev => prev.filter(item => !payload.messageIds!.includes(item.id)));
                    break;
                }

                case 'chat:message-chunk': {
                    const chunk = typeof data === 'string' ? data : '';
                    if (!chunk) break;
                    appendTextChunk(chunk);
                    setBusy(true);
                    break;
                }
                case 'chat:thinking-start': {
                    const payload = data as { index?: number } | null;
                    setBusy(true);
                    appendThinkingBlock(payload?.index);
                    break;
                }
                case 'chat:thinking-chunk': {
                    const payload = data as { index?: number; delta?: string } | null;
                    if (payload?.index === undefined || !payload.delta) break;
                    updateLiveContent((content, current) => ({
                        content: content.map((block) => {
                            if (block.type !== 'thinking' || block.thinkingStreamIndex !== payload.index || block.isComplete) return block;
                            return { ...block, thinking: (block.thinking ?? '') + payload.delta };
                        }),
                        streamingTextActive: current?.streamingTextActive ?? false,
                    }));
                    break;
                }
                case 'chat:tool-use-start': {
                    const payload = data as ToolUse | null;
                    if (!payload?.id || !payload.name) break;
                    setBusy(true);
                    trackSessionEvent('tool_use', { tool: payload.name, tool_origin: 'runtime' });
                    appendToolBlock(payload, 'tool_use');
                    break;
                }
                case 'chat:server-tool-use-start': {
                    const payload = data as ProviderToolUsePayload | null;
                    if (!payload?.id || !payload.name) break;
                    trackSessionEvent('tool_use', { tool: payload.name, tool_origin: 'provider' });
                    appendToolBlock(payload, 'server_tool_use');
                    break;
                }
                case 'chat:tool-input-delta': {
                    const payload = data as { toolId?: string; delta?: string } | null;
                    if (!payload?.toolId || !payload.delta) break;
                    updateToolBlock(payload.toolId, (tool) => {
                        const inputJson = (tool.inputJson ?? '') + payload.delta;
                        const parsedInput = parsePartialJson<ToolInput>(inputJson);
                        return {
                            ...tool,
                            inputJson,
                            parsedInput: parsedInput ?? tool.parsedInput,
                        };
                    });
                    break;
                }
                case 'chat:content-block-stop': {
                    const payload = data as {
                        index?: number;
                        toolId?: string;
                        type?: string;
                        input?: Record<string, unknown>;
                        inputRef?: unknown;
                        asyncQuestions?: AsyncQuestionSet;
                    } | null;
                    if (payload?.type === 'text') {
                        markTextStopped(payload.asyncQuestions);
                        break;
                    }
                    if (payload?.type === 'thinking' || payload?.index !== undefined) {
                        updateLiveContent((content, current) => ({
                            content: content.map((block) => {
                                if (block.type !== 'thinking' || block.thinkingStreamIndex !== payload.index || block.isComplete) return block;
                                return {
                                    ...block,
                                    isComplete: true,
                                    thinkingDurationMs: block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined,
                                };
                            }),
                            streamingTextActive: current?.streamingTextActive ?? false,
                        }));
                    }
                    if (payload?.toolId) {
                        if (payload.inputRef) {
                            const targetSessionId = sessionIdRef.current;
                            if (targetSessionId) {
                                void sessionDataPlaneBaseUrl(targetSessionId)
                                    .then((baseUrl) => {
                                        if (!baseUrl) throw new Error('Session sidecar is unavailable');
                                        return fetchJsonLargeValueRef(
                                            baseUrl,
                                            payload.inputRef,
                                        );
                                    })
                                    .then((resolvedInput) => {
                                        if (sessionIdRef.current !== targetSessionId) return;
                                        updateToolBlock(payload.toolId, (tool) => ({
                                            ...tool,
                                            input: resolvedInput,
                                            inputJson: undefined,
                                            parsedInput: resolvedInput as ToolInput,
                                        }));
                                        setMessages((prev) => prev.map((message) => message.role === 'ai'
                                            ? replaceFloatingToolInput(message, payload.toolId!, resolvedInput)
                                            : message));
                                    })
                                    .catch((err) => console.error('[fb-session] Failed to resolve final tool input ref:', err));
                            }
                            break;
                        }
                        updateToolBlock(payload.toolId, (tool) => {
                            if (payload.input) {
                                return {
                                    ...tool,
                                    input: payload.input,
                                    inputJson: undefined,
                                    parsedInput: payload.input as ToolInput,
                                };
                            }
                            if (!tool.inputJson) return tool;
                            let parsedInput: ToolInput | undefined;
                            try {
                                parsedInput = JSON.parse(tool.inputJson) as ToolInput;
                            } catch {
                                parsedInput = parsePartialJson<ToolInput>(tool.inputJson) ?? undefined;
                            }
                            return { ...tool, parsedInput };
                        });
                    }
                    break;
                }
                case 'chat:tool-result-delta': {
                    const payload = data as { toolUseId?: string; delta?: string } | null;
                    if (!payload?.toolUseId || !payload.delta) break;
                    updateToolBlock(payload.toolUseId, (tool) => ({
                        ...tool,
                        result: clampToolResult(tool.result ?? '', payload.delta ?? ''),
                        isLoading: true,
                    }));
                    break;
                }
                case 'chat:tool-attachment-update': {
                    const payload = data as { toolUseId?: string; pendingId?: string; attachment?: ToolAttachment } | null;
                    if (!payload?.toolUseId || !payload.pendingId || !payload.attachment) break;
                    const attachment = payload.attachment;
                    updateToolBlock(payload.toolUseId, (tool) => {
                        const attachments = tool.attachments ?? [];
                        const idx = attachments.findIndex((att) => att.pendingId === payload.pendingId);
                        if (idx === -1) return tool;
                        const next = [...attachments];
                        next[idx] = attachment;
                        return { ...tool, attachments: next };
                    });
                    break;
                }
                case 'chat:tool-result-start':
                case 'chat:tool-result-complete': {
                    const payload = data as {
                        id?: string;
                        toolUseId?: string;
                        content?: string;
                        isError?: boolean;
                        metadata?: ToolUseSimple['resultMeta'];
                        attachments?: ToolAttachment[];
                    } | null;
                    const target = payload?.toolUseId ?? payload?.id;
                    updateToolBlock(target, (tool) => {
                        const incoming = payload?.content;
                        const attachments = mergeAttachmentsByPendingId(tool.attachments, payload?.attachments);
                        return {
                            ...tool,
                            result: incoming ?? tool.result,
                            isError: payload?.isError,
                            isLoading: eventName !== 'chat:tool-result-complete',
                            resultMeta: payload?.metadata ?? tool.resultMeta,
                            attachments,
                        };
                    });
                    break;
                }
                case 'chat:subagent-status': {
                    const payload = data as {
                        parentToolUseId?: string;
                        lifecycle?: SubagentLifecycle;
                    } | null;
                    if (!payload?.parentToolUseId || !payload.lifecycle) break;
                    replaceLiveMessage((current) => current
                        ? applyFloatingSubagentLifecycle(
                            current,
                            payload.parentToolUseId!,
                            payload.lifecycle!,
                        )
                        : current);
                    setMessages((prev) => prev.map(message => message.role === 'ai'
                        ? applyFloatingSubagentLifecycle(
                            message,
                            payload.parentToolUseId!,
                            payload.lifecycle!,
                        )
                        : message));
                    break;
                }
                case 'chat:message-complete': {
                    trackSessionEvent('message_complete', messageCompletionParams(
                        analyticsRuntimeRef.current, analyticsRuntimeSourceRef.current,
                        data as MessageCompletionTelemetry | null,
                    ));
                    // Turn presentation can finish while queued Session work is
                    // still running. chat:status / REST owns the busy projection.
                    finalizeStream();
                    // 终态清掉一切 pending 表单（backstop：正常路径下用户回应后已清，
                    // 这里兜住中止 / 异常路径，防陈旧卡片）。
                    setPermReqs([]);
                    setAskReq(null);
                    setPlanReq(null);
                    if (modeRef.current !== 'pin') {
                        setUnread((n) => n + 1);
                    }
                    break;
                }
                case 'chat:message-error': {
                    trackSessionEvent('message_error');
                    const msg =
                        typeof data === 'string'
                            ? data
                            : data && typeof data === 'object' && 'message' in data
                                ? String((data as { message?: unknown }).message ?? '')
                                : fbText('replyFailed');
                    finalizeStream('failed');
                    setPermReqs([]);
                    setAskReq(null);
                    setPlanReq(null);
                    setError(msg || fbText('replyFailed'));
                    break;
                }
                case 'chat:message-stopped': {
                    trackSessionEvent('message_stop');
                    finalizeStream('stopped');
                    setPermReqs([]);
                    setAskReq(null);
                    setPlanReq(null);
                    break;
                }
                case 'chat:status': {
                    const payload = data as { sessionState?: string } | null;
                    if (payload?.sessionState === 'idle' || payload?.sessionState === 'error') {
                        setBusy(false);
                    } else if (payload?.sessionState === 'running' || payload?.sessionState === 'starting') {
                        setBusy(true);
                    }
                    break;
                }
                case 'permission:request': {
                    const payload = data as FbPermReq | null;
                    if (payload?.requestId && isCurrentInteractiveEvent(payload.sessionId)) {
                        setPermReqs(prev => enqueuePermissionRequest(prev, {
                            requestId: payload.requestId,
                            sessionId: payload.sessionId,
                            toolName: payload.toolName,
                            input: payload.input || '',
                            defaultToNo: payload.defaultToNo,
                            suppressAlwaysAllowRule: payload.suppressAlwaysAllowRule,
                        }));
                    }
                    break;
                }
                case 'permission:expired': {
                    const payload = data as { requestId?: string; sessionId?: string | null } | null;
                    if (payload?.requestId && isCurrentInteractiveEvent(payload.sessionId)) {
                        setPermReqs(prev => removePermissionRequest(prev, payload.requestId));
                    }
                    break;
                }
                case 'chat:agent-error': {
                    // Terminal agent errors（rate limit / auth / SDK is_error）走
                    // 这条而非 message-error——漏接会让"发完就走"的任务静默死掉、
                    // 球退回 idle（review W2）。
                    const msg = typeof data === 'string' ? data : fbText('agentErrorOpenMainWindow');
                    finalizeStream('failed');
                    // 会话失效自愈：SDK 在当前工作区找不到这条对话（典型：persisted
                    // sid 的 SDK 数据被清理）。直接轮换新 session，别让用户卡死在
                    // 一条永远发不出去的会话里。
                    if (msg.includes('No conversation found')) {
                        setError(fbText('sessionExpiredNewChat'));
                        const ws = workspaceRef.current;
                        if (ws) {
                            void rotateToRef.current(localDate(), { path: ws.path });
                        }
                    } else {
                        setError(msg);
                    }
                    break;
                }
                // ── 交互表单（D13）：复用主 Chat 同款事件，渲染主组件 ──
                // 这些是「控制转移工具」，即便 fullAgency 也会触发（agent-session.ts
                // 快速通道排除它们），漏接 = 本轮永久 hang（PRD §14.1）。
                // permission / ask-user-question / plan 对 builtin + external 透明；是否
                // 实际触发由当前 runtime 的能力决定。DSH 的 plan_approval 也复用这张卡。
                case 'ask-user-question:request': {
                    const payload = data as AskUserQuestionRequest | null;
                    if (payload?.requestId && isCurrentInteractiveEvent(payload.sessionId) && Array.isArray(payload.questions)) {
                        setAskReq(payload);
                    }
                    break;
                }
                case 'ask-user-question:expired': {
                    const payload = data as { requestId?: string; sessionId?: string | null } | null;
                    if (!isCurrentInteractiveEvent(payload?.sessionId)) break;
                    const rid = payload?.requestId;
                    setAskReq((cur) => (cur && (!rid || cur.requestId === rid) ? null : cur));
                    break;
                }
                case 'exit-plan-mode:request': {
                    const payload = data as ExitPlanModeRequest | null;
                    if (payload?.requestId && isCurrentInteractiveEvent(payload.sessionId)) setPlanReq(payload);
                    break;
                }
                case 'exit-plan-mode:expired': {
                    const payload = data as { requestId?: string; sessionId?: string | null } | null;
                    if (!isCurrentInteractiveEvent(payload?.sessionId)) break;
                    const rid = payload?.requestId;
                    setPlanReq((cur) => (cur && (!rid || cur.requestId === rid) ? null : cur));
                    break;
                }
                case 'enter-plan-mode:request': {
                    // EnterPlanMode 走「自动批准、无卡片」，对齐 TabProvider。批准后真正
                    // 的用户介入点是随后的 ExitPlanMode 审核卡。⚠️ SDK-auto 路径广播
                    // { requestId:'sdk_auto_…', autoApproved:true } 且后端**无** pending
                    // （已自行放行）——此时 POST 会命中 "Unknown request"。故仅对非
                    // autoApproved 的真·pending 才回 approved（TabProvider 同款 gate，
                    // cross-review W1）。
                    const payload = data as { requestId?: string; sessionId?: string | null; autoApproved?: boolean } | null;
                    if (!isCurrentInteractiveEvent(payload?.sessionId)) break;
                    const rid = payload?.requestId;
                    const sid = sessionIdRef.current;
                    if (rid && sid && !payload?.autoApproved) {
                        void (async () => {
                            try {
                                await floatingProxyFetch(sid, '/api/enter-plan-mode/respond', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ requestId: rid, approved: true }),
                                });
                            } catch (err) {
                                console.warn('[fb] enter-plan-mode auto-approve failed:', err);
                            }
                        })();
                    }
                    break;
                }
                case 'enter-plan-mode:expired': {
                    break; // 无 UI，无需清理
                }
                case 'chat:permission-mode-changed': {
                    // 权限模式跟随活状态（D14）：用户在展开 Tab 改、AI 出 plan 恢复基线，
                    // 都经此同步，下次发送即采纳。⚠️ **不镜像 'plan'**（cross-review W2）：
                    // 'plan' 是 server 端 in-turn 瞬态；若镜像进 send-mode，一旦本轮异常
                    // 终止（reject-abort / 中途 error）而没走 ExitPlanMode 恢复，send-mode
                    // 会卡在 'plan'，把发完就走的渠道静默降级成逐步确认。只跟非-plan 基线
                    // → 下一次 idle send 带基线、applySessionConfig 自愈。
                    const mode = (data as { permissionMode?: string } | null)?.permissionMode;
                    if (typeof mode === 'string' && mode && mode !== 'plan') setPermissionMode(mode);
                    break;
                }
                default:
                    break;
            }
        },
        [
            appendTextChunk,
            appendThinkingBlock,
            appendToolBlock,
            finalizeStream,
            isCurrentInteractiveEvent,
            markTextStopped,
            modeRef,
            replaceLiveMessage,
            updateLiveContent,
            updateToolBlock,
            showTranscriptSaveToast,
            trackSessionEvent,
        ],
    );
    const handleSseEventRef = useRef(handleSseEvent);
    useLayoutEffect(() => { handleSseEventRef.current = handleSseEvent; }, [handleSseEvent]);

    const messagesRef = useRef(messages);
    useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);
    const restoreTranscript = useCallback(async (gapRecoveryAttempted = false): Promise<void> => {
        const pending = revisionFenceRef.current;
        const sid = pending.sessionId;
        if (!sid) return;
        try {
            const query = new URLSearchParams({ limit: String(HISTORY_LIMIT) });
            if (transcriptFormatRef.current === 2 && messagesRef.current[0]) query.set('from', messagesRef.current[0].id);
            const resp = await floatingProxyFetch(sid, `/sessions/${sid}?${query}`);
            if (!resp.ok) throw new Error(`History read failed: HTTP ${resp.status}`);
            const json = await resp.json() as { success: boolean; session?: {
                id: string; transcriptFormat?: 2; messages: unknown[]; liveStreamingMessage?: unknown;
                snapshotRevision?: number; liveSessionState?: string; transcriptSaveStatus?: TranscriptSaveStatus;
                runtimeBinding?: EffectiveRuntimeBinding; runtime?: string; runtimeSource?: RuntimeSource; providerId?: string; model?: string; permissionMode?: string;
                pendingInteractiveRequests?: Array<{ type: string; data: unknown }>;
                queuedMessages?: Array<{ id: string; messagePreview: string; asyncQuestionReply?: AsyncQuestionReply }>;
            } };
            if (sessionIdRef.current !== sid || revisionFenceRef.current.restoreToken !== pending.restoreToken) return;
            if (!json.success || json.session?.id !== sid) throw new Error('History snapshot has no matching Session');
            const snapshot = json.session;
            const completed = completeLiveRevisionRestore(revisionFenceRef.current, pending.restoreToken, snapshot.snapshotRevision ?? 0);
            if (completed.stale) return;
            if (completed.needsResync) {
                if (!gapRecoveryAttempted) {
                    revisionFenceRef.current = completed.fence;
                    return restoreTranscript(true);
                }
                throw new Error('History snapshot has a revision gap');
            }
            revisionFenceRef.current = completed.fence;
            transcriptFormatRef.current = snapshot.transcriptFormat;
            applySessionSnapshot(snapshot);
            if (snapshot.transcriptSaveStatus) showTranscriptSaveToast(snapshot.transcriptSaveStatus);
            const history = parseSessionHistory(json, snapshot.transcriptFormat === 2 ? Infinity : HISTORY_LIMIT);
            if (snapshot.transcriptFormat === 2) {
                setMessages(history);
                const live = parseSessionHistory({ session: { transcriptFormat: 2, messages: [snapshot.liveStreamingMessage] } }, 1)[0];
                replaceLiveMessage(() => live?.role === 'ai' ? live : null);
                setBusy(snapshot.liveSessionState === 'running' || snapshot.liveSessionState === 'starting');
                setQueuedMessages((snapshot.queuedMessages ?? []).map(item => ({ queueId: item.id, text: item.messagePreview, asyncQuestionReply: item.asyncQuestionReply, timestamp: Date.now() })));
                setPermReqs([]); setAskReq(null); setPlanReq(null);
                for (const request of snapshot.pendingInteractiveRequests ?? []) handleSseEventRef.current(request.type, request.data);
            } else if (history.length) {
                setMessages(current => [...history, ...current.filter(row => !history.some(saved => saved.id === row.id))]);
            }
            if (snapshot.permissionMode && snapshot.permissionMode !== 'plan') setPermissionMode(snapshot.permissionMode);
            for (const event of completed.replay) handleSseEventRef.current(event.eventName, event.data);
        } catch (err) {
            if (sessionIdRef.current !== sid || revisionFenceRef.current.restoreToken !== pending.restoreToken) return;
            revisionFenceRef.current = { ...revisionFenceRef.current, restoring: false, lastAppliedRevision: null, buffered: [] };
            console.warn(`[fb-session] history load failed session=${sid} error=${describeError(err)}`);
        }
    }, [applySessionSnapshot, replaceLiveMessage, showTranscriptSaveToast]);
    useLayoutEffect(() => { restoreTranscriptRef.current = restoreTranscript; }, [restoreTranscript]);

    const receiveSseEvent = useCallback<SseEventHandler>((eventName, data, metadata) => {
        const sid = sessionIdRef.current;
        if (!sid || (metadata.sessionId && metadata.sessionId !== sid)) return;
        if (eventName === 'chat:init') {
            handleSseEventRef.current(eventName, data);
            if (!revisionFenceRef.current.restoring || revisionFenceRef.current.connectionGeneration !== metadata.connectionGeneration) {
                revisionFenceRef.current = beginLiveRevisionRestore(revisionFenceRef.current, sid, metadata.connectionGeneration);
                void restoreTranscriptRef.current();
            }
            return;
        }
        if (transcriptFormatRef.current === 2 && metadata.liveRevision !== undefined) {
            const result = ingestLiveRevisionEvent(revisionFenceRef.current, { eventName, data, sessionId: sid,
                connectionGeneration: metadata.connectionGeneration, liveRevision: metadata.liveRevision });
            revisionFenceRef.current = result.fence;
            if (result.action === 'resync') void restoreTranscriptRef.current();
            if (result.action !== 'apply') return;
        }
        handleSseEventRef.current(eventName, data);
    }, []);

    /** Mint a fresh channel session and persist the FULL identity triple
     *  (id, workspace, date). PRD §6.2 rotation + §14 D15 全升格：不再自铸裸
     *  UUID，而是走和 Tab 同一条 `POST /sessions` 路径建一条 **owned snapshot
     *  session**——服务端用 `snapshotForOwnedSession` 从绑定 agent 捕获
     *  runtime/model/provider/MCP，session 自此自包含（解决一期 #1/#2 裁剪）。
     *  创建时把 permissionMode 种成该 runtime 的最宽松档（D14：发完就走）。
     *  Workspace 绑定是 load-bearing：SDK 对话树按工作区落盘，跨工作区 resume
     *  必然 "No conversation found"。 */
    const mintSession = useCallback(async (today: string, workspace: string): Promise<string> => {
        const startedAt = Date.now();
        let createdSessionId: string | undefined;
        console.info(`[fb-session] mint start workspace=${workspace} date=${today}`);
        // 种「最宽松权限 per runtime」由服务端在快照构造期原子完成（seedMaxPermission
        // → getMaxPermissionForRuntime），不再创建后 PATCH——避免 PATCH 失败被吞、
        // 本地态与磁盘快照不一致（cross-review）。seed≠override：这只是创建起点，
        // 之后跟随 session 活状态（用户在展开 Tab 改 → 写回快照；AI 进/出 plan →
        // chat:permission-mode-changed）。created.permissionMode 即服务端种好的值。
        try {
            const origin = { kind: 'desktop' as const, surface: 'floating_ball' as const };
            const created = await createSession(workspace, undefined, { seedMaxPermission: true, origin },
                { type: 'companion', id: OWNER_ID });
            const sid = created.id;
            createdSessionId = sid;
            console.info(
                `[fb-session] mint created session=${sid} runtime=${created.runtime ?? 'unknown'} permission=${created.permissionMode ?? 'default'} elapsed=${elapsedMs(startedAt)}`,
            );
            setPermissionMode(created.permissionMode ?? 'fullAgency');
            applySessionSnapshot(created);
            await atomicModifyConfig((c) => ({
                ...c,
                floatingBallSessionId: sid,
                floatingBallSessionDate: today,
                floatingBallSessionWorkspace: workspace,
            }));
            console.info(`[fb-session] mint config saved session=${sid} elapsed=${elapsedMs(startedAt)}`);
            sessionDateRef.current = today;
            // Provenance anchor (PRD §11.2 / D11): downstream session-scoped events
            // — including the server-side ai_turn_complete — join back to this via
            // session_id, which is how the desktop channel becomes sliceable in
            // analytics without any server change.
            trackSessionEvent('session_new', {
                session_id: sid,
                triggered_by: 'floating_ball',
                ...originAnalyticsFields(origin),
                entry_intent: 'new_chat',
                runtime: analyticsRuntimeRef.current,
                runtime_source: analyticsRuntimeSourceRef.current,
                has_initial_message: false,
                agent_hash: null,
            });
            return sid;
        } catch (err) {
            if (createdSessionId) await releaseSessionSidecar(createdSessionId, 'companion', OWNER_ID).catch(() => false);
            console.error(`[fb-session] mint failed workspace=${workspace} elapsed=${elapsedMs(startedAt)} error=${describeError(err)}`);
            throw err;
        }
    }, [applySessionSnapshot, trackSessionEvent]);

    /** Ensure sidecar + (re)connect SSE for `sid`. */
    const connectSession = useCallback(async (
        sid: string,
        workspace: string,
        configSnapshot: AppConfig,
        projectSnapshot: Project[],
    ): Promise<void> => {
        const startedAt = Date.now();
        let stage = 'disconnect-old-sse';
        console.info(`[fb-session] connect start session=${sid} workspace=${workspace}`);
        // 串台防护（cross-review C2）：必须**先**断开旧 SSE、**再**切 sessionIdRef。
        // 否则在 await ensureSessionSidecar 的空窗里，旧 session 的 SSE 若送来
        // permission/ask/plan 事件，handler 会用已切到新 sid 的 ref → 用户的回应
        // POST 到新 sid、旧后端 pending 永久挂起。SSE 连接读的是 sessionIdRef，
        // 断开后再换 ref 即可干净重建。
        const previousSse = sseRef.current;
        sseRef.current = null;
        if (previousSse) {
            await previousSse.disconnect();
        }
        sessionIdRef.current = sid;
        transcriptFormatRef.current = undefined;
        setSessionId(sid);
        setAnalyticsContext({ sessionId: sid });
        let ownerEnsured = false;
        try {
            stage = 'ensure-session-sidecar';
            // Ensure = pre-warm：伴侣窗作为长寿 owner 让 sidecar 常驻（唤起即出字
            // 的体感来源，PRD §10「最高效 = 预热」）。
            const ensured = await ensureSessionSidecar(sid, workspace, 'companion', OWNER_ID);
            ownerEnsured = true;
            console.info(`[fb-session] ensure sidecar ok session=${sid} elapsed=${elapsedMs(startedAt)}`);
            stage = 'sync-config';
            // A shared/prewarmed Session already owns its effective config.
            // Match Chat: only the locked ensure result can authorize adoption.
            if (ensured.isNew) await syncFloatingSidecarConfig(sid, workspace, configSnapshot, projectSnapshot);
            console.info(`[fb-session] sync config ok session=${sid} elapsed=${elapsedMs(startedAt)}`);
            stage = 'connect-sse';
            // SSE（事件名/payload 与 Tab 完全同构，白名单已覆盖）。
            const sse = createSseConnection('fb', sessionIdRef, {
                type: 'companion',
                id: OWNER_ID,
            });
            // Reject callbacks from a detached connection before interpreting
            // identity or revision, including delayed async connect/init work.
            sse.setEventHandler((...args) => { if (sseRef.current === sse) receiveSseEvent(...args); });
            sseRef.current = sse;
            revisionFenceRef.current = beginLiveRevisionRestore(revisionFenceRef.current, sid, sse.getConnectionGeneration());
            await sse.connect();
            await restoreTranscriptRef.current();
            console.info(`[fb-session] sse connected session=${sid} elapsed=${elapsedMs(startedAt)}`);
        } catch (err) {
            await sseRef.current?.disconnect();
            sseRef.current = null;
            if (ownerEnsured) {
                await releaseSessionSidecar(sid, 'companion', OWNER_ID).catch(() => false);
            }
            console.error(
                `[fb-session] connect failed session=${sid} stage=${stage} elapsed=${elapsedMs(startedAt)} error=${describeError(err)}`,
            );
            throw err;
        }
    }, [receiveSseEvent]);

    const adoptMigratedSession = useCallback(
        async (payload: FloatingBallSessionMigratedPayload) => {
            if (!payload?.oldSessionId || !payload.newSessionId) return;
            queuedMigrationEventsRef.current.push(payload);
            if (migrationInFlightRef.current) return;

            migrationInFlightRef.current = true;
            try {
                while (queuedMigrationEventsRef.current.length > 0) {
                    const nextPayload = queuedMigrationEventsRef.current.shift();
                    if (!nextPayload) continue;

                    const oldSid = sessionIdRef.current;
                    if (oldSid === nextPayload.newSessionId) continue;
                    if (oldSid !== nextPayload.oldSessionId) continue;

                    const workspace = workspaceRef.current?.path ?? nextPayload.workspacePath;
                    if (!workspace) continue;

                    const oldHadPendingForm = pendingFormRef.current;
                    workspaceRef.current = { path: workspace };
                    setWorkspacePath(workspace);
                    setMessages([]);
                    setQueuedMessages([]);
                    replaceLiveMessage(() => null);
                    setPermReqs([]);
                    setAskReq(null);
                    setPlanReq(null);
                    setUnread(0);
                    setError(null);
                    setBusy(false);

                    try {
                        const [cfg, projects] = await Promise.all([loadAppConfig(), loadProjects()]);
                        await connectSession(nextPayload.newSessionId, workspace, cfg, projects);
                        setReady(true);
                        if (oldSid && oldSid !== nextPayload.newSessionId) {
                            try {
                                if (oldHadPendingForm) {
                                    await floatingProxyFetch(oldSid, '/chat/stop', { method: 'POST' });
                                }
                                await startBackgroundCompletion(oldSid);
                                await releaseSessionSidecar(oldSid, 'companion', OWNER_ID);
                            } catch (err) {
                                console.warn('[fb] migrated old session handover failed (non-fatal):', err);
                            }
                        }
                        console.info(`[fb] session binding migrated · ${nextPayload.oldSessionId} -> ${nextPayload.newSessionId}`);
                    } catch (err) {
                        console.warn('[fb] adopt migrated session failed:', err);
                        setReady(false);
                        setError(err instanceof Error ? err.message : String(err));
                    }
                }
            } finally {
                migrationInFlightRef.current = false;
            }
        },
        [connectSession, replaceLiveMessage],
    );

    useEffect(() => {
        const ac = new AbortController();
        void listenWithCleanup<FloatingBallSessionMigratedPayload>(
            SESSION_MIGRATED_EVENT,
            (event) => {
                void adoptMigratedSession(event.payload);
            },
            ac.signal,
        );
        return () => ac.abort();
    }, [adoptMigratedSession]);

    // ── boot：解析 Mino → session 轮换 → ensure → SSE → 历史 ──
    useEffect(() => {
        if (bootedRef.current) return;
        bootedRef.current = true;
        let cancelled = false;

        (async () => {
            const bootStartedAt = Date.now();
            let stage = 'init';
            console.info('[fb-session] boot start');
            try {
                // fb 窗口不挂 App.tsx，需要自己初始化 analytics（否则 platform/
                // app_version 预载与 flush 监听都不在，事件质量打折）。
                void initAnalytics();

                stage = 'load-config-projects';
                const [cfg, projects] = await Promise.all([loadAppConfig(), loadProjects()]);
                console.info(
                    `[fb-session] boot config loaded projects=${projects.length} hasSession=${Boolean(cfg.floatingBallSessionId)} date=${cfg.floatingBallSessionDate ?? 'none'} workspace=${cfg.floatingBallSessionWorkspace ?? 'none'} elapsed=${elapsedMs(bootStartedAt)}`,
                );
                setSendShortcut(cfg.chatSendShortcut ?? 'enter');
                // 设置面板（D17）：工作区选择器的候选 + 当前绑定覆盖。
                setProjects(projects.map((p) => ({ path: p.path, name: p.name })));
                setWorkspaceOverride(cfg.floatingBallWorkspaceOverride ?? null);

                // 渠道路由（D17）：override（钉死）→ 默认工作区 → /mino → 第一个项目。
                // 默认 override=null 时与 Launcher 一致（跟随主端默认工作区）。
                const boundWs = resolveBoundWorkspace(
                    cfg.floatingBallWorkspaceOverride,
                    cfg.defaultWorkspacePath,
                    projects,
                );
                if (!boundWs) {
                    throw new Error(fbText('noWorkspace'));
                }
                console.info(`[fb-session] boot workspace resolved path=${boundWs.path} name=${boundWs.name ?? 'Mino'}`);
                workspaceRef.current = { path: boundWs.path };

                // Session 轮换（PRD §6.2）：身份三元组 (id, workspace, date)。
                // 日期翻篇 **或** 绑定工作区变更都轮换——后者是硬约束（SDK 对话
                // 树按工作区落盘，跨工作区 resume 必 "No conversation found"）。
                // 跨 session 的"懂我"由记忆系统承载，不靠 session 连续性。
                const today = localDate();
                let sid = cfg.floatingBallSessionId;
                const rotated =
                    !sid
                    || cfg.floatingBallSessionDate !== today
                    || !cfg.floatingBallSessionWorkspace
                    || !workspacePathsEqual(cfg.floatingBallSessionWorkspace, boundWs.path);
                console.info(
                    `[fb-session] boot session decision rotated=${rotated} session=${sid ?? 'none'} today=${today}`,
                );
                if (rotated) {
                    stage = 'mint-session';
                    sid = await mintSession(today, boundWs.path);
                } else {
                    sessionDateRef.current = cfg.floatingBallSessionDate ?? today;
                }
                if (cancelled || !sid) {
                    if (rotated && sid) await releaseSessionSidecar(sid, 'companion', OWNER_ID).catch(() => false);
                    return;
                }

                setWorkspacePath(boundWs.path);
                setWorkspaceName(boundWs.name || 'Mino');
                stage = 'connect-session';
                await connectSession(sid, boundWs.path, cfg, projects);
                if (cancelled) return;

                if (!cancelled) {
                    setReady(true);
                    // Lands in unified log via frontendLogger — the smoke-test
                    // signal that the desktop channel booted end-to-end.
                    console.info(
                        `[fb-session] companion ready session=${sid} workspace=${boundWs.path} rotated=${rotated} elapsed=${elapsedMs(bootStartedAt)}`,
                    );
                }
            } catch (err) {
                console.error(
                    `[fb-session] boot failed stage=${stage} elapsed=${elapsedMs(bootStartedAt)} error=${describeError(err)}`,
                );
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                }
            }
        })();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- boot-once; helpers are stable useCallbacks
    }, []);

    /** 轮换到一条全新 session（清空会话区 + ensure 新 sidecar + 重连 SSE），并把
     *  旧 session 的 owner 妥善交接——这是 cross-review C1 的修复：此前 rotateTo
     *  只 ensure 新 sid、从不释放旧 sid 的 'floating-ball' owner，每次轮换（按天 /
     *  换工作区 / 新对话）都把旧 sidecar 留成孤儿、常驻到 app 退出。正确做法是复用
     *  主 Chat 的 owner 交接语义（App.tsx）：
     *    - 旧轮卡在"等我"表单上（出不了结果）→ 先 stop 中止它；
     *    - 真在跑的工具 → startBackgroundCompletion 转后台续命（发完就走，结果落历史）；
     *    - 然后释放旧 tab owner：闲则 sidecar 停（并 drain 残留 pending），忙则由
     *      BackgroundCompletion owner 续命到 turn 完成后自动释放。 */
    const rotateTo = useCallback(
        async (today: string, workspace: { path: string; name?: string }) => {
            const rotateStartedAt = Date.now();
            const oldSid = sessionIdRef.current;
            const oldHadPendingForm = pendingFormRef.current;
            console.info(`[fb-session] rotate start old=${oldSid ?? 'none'} workspace=${workspace.path} date=${today}`);
            const sid = await mintSession(today, workspace.path);
            workspaceRef.current = { path: workspace.path };
            setWorkspacePath(workspace.path);
            if (workspace.name) setWorkspaceName(workspace.name);
            setMessages([]);
                    setQueuedMessages([]);
            replaceLiveMessage(() => null);
            setPermReqs([]);
            setAskReq(null);
            setPlanReq(null);
            setUnread(0);
            setError(null);
            const [cfg, projects] = await Promise.all([loadAppConfig(), loadProjects()]);
            await connectSession(sid, workspace.path, cfg, projects);
            // 旧 session owner 交接（C1）。非致命：失败不阻断新会话已就绪。
            if (oldSid && oldSid !== sid) {
                try {
                    if (oldHadPendingForm) {
                        // 卡在表单上的旧轮永远等不到回应（用户已走）→ 中止它。
                        await floatingProxyFetch(oldSid, '/chat/stop', { method: 'POST' });
                    }
                    await startBackgroundCompletion(oldSid);
                    await releaseSessionSidecar(oldSid, 'companion', OWNER_ID);
                } catch (err) {
                    console.warn(`[fb-session] old session handover failed old=${oldSid} error=${describeError(err)}`);
                }
            }
            console.info(`[fb-session] rotate done session=${sid} workspace=${workspace.path} elapsed=${elapsedMs(rotateStartedAt)}`);
        },
        [mintSession, connectSession, replaceLiveMessage],
    );

    useEffect(() => {
        rotateToRef.current = rotateTo;
    }, [rotateTo]);

    /** Summon-time rotation check：每次显式唤起时重新解析默认工作区并评估
     *  三元组（boot-only 检查在"跨午夜长跑"和"运行期间改默认工作区"两种
     *  情形下都会失效）。运行中不打断当轮。 */
    const rotateIfStale = useCallback(async () => {
        if (!ready) return;
        if (busyRef.current) return;
        try {
            const today = localDate();
            const [cfg, projects] = await Promise.all([loadAppConfig(), loadProjects()]);
            // 同步设置面板的候选 + 当前绑定（用户可能在别处改了默认工作区 / 加删项目）。
            setProjects(projects.map((p) => ({ path: p.path, name: p.name })));
            setWorkspaceOverride(cfg.floatingBallWorkspaceOverride ?? null);
            const target = resolveBoundWorkspace(
                cfg.floatingBallWorkspaceOverride,
                cfg.defaultWorkspacePath,
                projects,
            );
            if (!target) return;
            const current = workspaceRef.current;
            const dateStale = sessionDateRef.current !== today;
            const wsStale = !current || !workspacePathsEqual(current.path, target.path);
            if (!dateStale && !wsStale) return;
            await rotateTo(today, { path: target.path, name: target.name });
        } catch (err) {
            console.warn('[fb] summon-time rotation failed:', err);
        }
    }, [ready, rotateTo]);

    /** 设置面板（D17）：切换工作区绑定。override=null 跟随默认；具体路径=钉死。
     *  写盘后重新解析目标——目标变了就铸新 session（绑定即身份的一部分）。 */
    const setWorkspaceBinding = useCallback(
        async (override: string | null) => {
            await atomicModifyConfig((c) => ({ ...c, floatingBallWorkspaceOverride: override }));
            setWorkspaceOverride(override);
            try {
                const [cfg, projs] = await Promise.all([loadAppConfig(), loadProjects()]);
                setProjects(projs.map((p) => ({ path: p.path, name: p.name })));
                const target = resolveBoundWorkspace(override, cfg.defaultWorkspacePath, projs);
                if (!target) return;
                const current = workspaceRef.current;
                if (current && workspacePathsEqual(current.path, target.path)) return; // 已在该工作区
                await rotateTo(localDate(), { path: target.path, name: target.name });
            } catch (err) {
                console.warn('[fb] setWorkspaceBinding failed:', err);
                setError(fbText('switchWorkspaceFailed'));
            }
        },
        [rotateTo],
    );

    /** 设置面板（D17）：手动新对话。在当前绑定工作区铸一条全新 owned session，
     *  按当前 agent 配置刷新。任何时候允许——若有任务在跑，旧 session 继续在后台
     *  跑（发完就走），结果落会话历史，可经展开 ↗ 找回；球跟随新 session。 */
    const newConversation = useCallback(async () => {
        try {
            const [cfg, projs] = await Promise.all([loadAppConfig(), loadProjects()]);
            const target = resolveBoundWorkspace(
                cfg.floatingBallWorkspaceOverride,
                cfg.defaultWorkspacePath,
                projs,
            );
            if (!target) return;
            await rotateTo(localDate(), { path: target.path, name: target.name });
        } catch (err) {
            console.warn('[fb] newConversation failed:', err);
            setError(fbText('newConversationFailed'));
        }
    }, [rotateTo]);

    // ── send ──
    const sendingRef = useRef(false);
    const send = useCallback(
        async (text: string, opts?: FbSendOpts): Promise<boolean> => {
            const sid = sessionIdRef.current;
            const images = opts?.images?.length ? opts.images : undefined;
            if (!sid || (!text.trim() && !images?.length)) return false;
            // ref 闸防双发（项目 memory：绝不用 useState 当并发锁）。
            if (sendingRef.current) return false;
            sendingRef.current = true;
            setError(null);

            const quote = opts?.quote?.trim() || undefined;

            const primaryContext = { kind: 'floating-context' as const, input: {
                appName: opts?.appName,
                windowTitle: opts?.windowTitle,
                selectedText: quote,
                screenshotAttached: opts?.screenshotAttached === true,
            } };
            const finalText = text.trim();

            const reply = opts?.asyncQuestionReply;
            const optimisticQueueId = reply ? `opt-${crypto.randomUUID()}` : null;
            if (reply && optimisticQueueId) setQueuedMessages(prev => [...prev, { queueId: optimisticQueueId, text, asyncQuestionReply: reply, timestamp: Date.now() }]);
            if (!reply && transcriptFormatRef.current !== 2) setMessages((prev) => [
                ...prev,
                {
                    id: `u-${Date.now()}`,
                    role: 'user',
                    text,
                    quote,
                    attachments: opts?.attachments,
                },
            ]);
            if (!reply) setBusy(true);

            // D14：带 session 当前权限模式（创建时种最宽松、之后跟随活状态）。
            // **不能省略**——/chat/send 对缺省 permissionMode 落 'auto'（index.ts），
            // 会把发完就走的渠道意外降级成逐项确认。`/chat/send` 内部再按 session 的
            // runtime 分流到 builtin / external（D16 无需前端分流）。破坏性保护由
            // hook 硬闸承担（plan-mode-gate / background-agent-permission）。
            const sendAnalytics = {
                runtime: analyticsRuntimeRef.current,
                runtime_source: analyticsRuntimeSourceRef.current,
                model: analyticsModelRef.current,
            };
            const sendMode = permissionModeRef.current || 'fullAgency';
            const sendStartedAt = Date.now();
            console.info(
                `[fb-session] send start session=${sid} chars=${finalText.length} images=${images?.length ?? 0} mode=${sendMode}`,
            );
            try {
                const resp = await floatingProxyFetch(sid, '/chat/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: finalText,
                    primaryContext,
                        images,
                        permissionMode: sendMode,
                        analyticsSource: 'floating_ball',
                        asyncQuestionReply: reply,
                    }),
                });
                const body = (await resp.json().catch(() => ({}))) as { success?: boolean; error?: string; queueId?: string };
                if (!resp.ok || body.success !== true) throw new Error(body.error || `HTTP ${resp.status}`);
                if (optimisticQueueId && body.queueId) setQueuedMessages(prev => prev.map(item => item.queueId === optimisticQueueId ? { ...item, queueId: body.queueId! } : item));
                // Emit only after admission, using the Session identity captured for this send.
                trackSessionEvent('message_send', {
                    mode: sendMode,
                    ...sendAnalytics,
                    has_image: Boolean(images?.length),
                    has_file: false,
                    is_cron: false,
                    surface: 'floating_ball',
                    session_id: sid,
                });
                console.info(`[fb-session] send accepted session=${sid} elapsed=${elapsedMs(sendStartedAt)}`);
                return true;
            } catch (err) {
                if (!reply) setBusy(false);
                if (optimisticQueueId) setQueuedMessages(prev => prev.filter(item => item.queueId !== optimisticQueueId));
                setError(err instanceof Error ? err.message : String(err));
                console.error(`[fb-session] send failed session=${sid} elapsed=${elapsedMs(sendStartedAt)} error=${describeError(err)}`);
                return false;
            } finally {
                sendingRef.current = false;
            }
        },
        [trackSessionEvent],
    );

    const respondPermission = useCallback(
        async (decision: 'deny' | 'allow_once' | 'always_allow', requestIdOverride?: string) => {
            const sid = sessionIdRef.current;
            const req = requestIdOverride
                ? permReqs.find(item => item.requestId === requestIdOverride)
                : permReq;
            if (!sid || !req) return;
            const permissionAnalytics = {
                session_id: sid,
                runtime: analyticsRuntimeRef.current,
                runtime_source: analyticsRuntimeSourceRef.current,
            };
            try {
                const resp = await floatingProxyFetch(sid, '/api/permission/respond', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: req.requestId, decision }),
                });
                // 后端真确认（success===true）后才清卡片——乐观清除 / 只查 resp.ok 会在
                // POST 失败或后端回 {success:false}（过期/已轮换）时让 pending 永久挂起
                // 且无从重试（review W4 + cross-review C3）。
                await assertRespondSucceeded(resp);
                trackSessionEvent(decision === 'deny' ? 'permission_deny' : 'permission_grant', {
                    ...permissionAnalytics, tool: req.toolName, ...(decision === 'deny' ? {} : { type: decision }),
                });
                setPermReqs(prev => removePermissionRequest(prev, req.requestId));
            } catch (err) {
                console.error('[fb] permission respond failed:', err);
                setError(fbText('confirmSendFailed'));
                throw err;
            }
        },
        [permReq, permReqs, trackSessionEvent],
    );

    /** 回答 ask-user-question（D13）。answers=null 表示用户取消（SDK deny+interrupt）。
     *  与 permission 同纪律：成功后才清卡片（W4，乐观清除会卡死后端 pending）。 */
    const respondAskUserQuestion = useCallback(
        async (requestId: string, answers: AskUserQuestionAnswers | null) => {
            const sid = sessionIdRef.current;
            const req = askReq;
            if (!sid || req?.requestId !== requestId) throw new Error('Question is no longer pending');
            try {
                const resp = await floatingProxyFetch(sid, '/api/ask-user-question/respond', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId, answers }),
                });
                await assertRespondSucceeded(resp);
                setAskReq(prev => prev?.requestId === requestId ? null : prev);
            } catch (err) {
                console.error('[fb] ask-user-question respond failed:', err);
                setError(fbText('answerSendFailed'));
                throw err;
            }
        },
        [askReq],
    );

    /** 审核方案（D13）。approved=true 批准；false + feedback → AI 同轮修订，
     *  false 无 feedback → 中止本轮。成功后才清卡片（W4）。 */
    const respondExitPlanMode = useCallback(
        async (approved: boolean, feedback?: string) => {
            const sid = sessionIdRef.current;
            const req = planReq;
            if (!sid || !req) return;
            try {
                const resp = await floatingProxyFetch(sid, '/api/exit-plan-mode/respond', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: req.requestId, approved, feedback }),
                });
                await assertRespondSucceeded(resp);
                setPlanReq(null);
            } catch (err) {
                console.error('[fb] exit-plan-mode respond failed:', err);
                setError(fbText('submitFailed'));
            }
        },
        [planReq],
    );

    const markRead = useCallback(() => setUnread(0), []);
    const clearError = useCallback(() => setError(null), []);

    /** Stop the in-flight turn（伴侣窗的"停止"控制）。 */
    const stop = useCallback(async () => {
        const sid = sessionIdRef.current;
        if (!sid) return;
        try {
            await floatingProxyFetch(sid, '/chat/stop', { method: 'POST' });
        } catch (err) {
            console.warn('[fb] stop failed:', err);
        }
    }, []);

    /** Feature off（cmd_fb_disable）→ 释放资源：断 SSE + 释放 sidecar owner。
     *  没有这步，关掉悬浮球后 Mino sidecar 会常驻到 app 退出（review C2）。 */
    const suspend = useCallback(async () => {
        const sid = sessionIdRef.current;
        await sseRef.current?.disconnect();
        sseRef.current = null;
        if (sid) {
            try {
                await releaseSessionSidecar(sid, 'companion', OWNER_ID);
            } catch (err) {
                console.warn('[fb] release sidecar failed:', err);
            }
        }
        setReady(false);
        setBusy(false);
        setPermReqs([]);
        setAskReq(null);
        setPlanReq(null);
        console.info('[fb] companion suspended (owner released)');
    }, []);

    /** Re-enable → 重新 ensure + SSE（沿用当前 session id，历史已在内存）。 */
    const resume = useCallback(async () => {
        const sid = sessionIdRef.current;
        const workspace = workspaceRef.current;
        if (!sid || !workspace || sseRef.current) return;
        try {
            const [cfg, projects] = await Promise.all([loadAppConfig(), loadProjects()]);
            await connectSession(sid, workspace.path, cfg, projects);
            setReady(true);
            console.info('[fb] companion resumed');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [connectSession]);

    const activities = deriveActivities(liveMessage);

    return {
        ready,
        error,
        clearError,
        sessionId,
        workspacePath,
        workspaceName,
        messages,
        queuedMessages,
        liveMessage,
        streamText: null,
        busy,
        permReq,
        askReq,
        planReq,
        permissionMode,
        runtime,
        providerId,
        model,
        projects,
        workspaceOverride,
        unread,
        activities,
        sendShortcut,
        send,
        stop,
        respondPermission,
        respondAskUserQuestion,
        respondExitPlanMode,
        setWorkspaceBinding,
        newConversation,
        markRead,
        rotateIfStale,
        suspend,
        resume,
    };
}
