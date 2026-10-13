/**
 * Frontend API client for Session management
 */

import { apiFetch, apiGetJson, apiPostJson } from './apiFetch';
import {
    deleteSessionIfUnowned,
    ensureSessionSidecar,
    releaseSessionSidecar,
    sessionSidecarFetch,
    upgradeSessionId,
    isTauri,
    type SessionDeleteResult,
} from './tauriClient';
import { materializePendingSessionConfig, type MaterializePostBody, type MaterializeResponse } from './sessionMaterialize';
import type { ContextUsage } from '../../shared/types/context-usage';
import type { ProviderRoute } from '../../shared/providerRoute';
import type { RuntimeBackedProviderIdentity } from '../../shared/providerExecution';
import type { RuntimeSource } from '../../shared/types/runtime';
import type { OfficialToolId } from '../../shared/official-tools';
import type { SessionOrigin } from '../../shared/session-origin';
import type {
    GlobalSessionUserTagMutation,
    SessionUserTagMutation,
    SessionUserTagSummary,
} from '../../shared/session-user-tags';
import {
    isSystemMaintenanceSession,
    type SystemMaintenanceSessionKind,
} from '../../shared/managedScheduledJob';

export interface SessionStats {
    turnCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
}

export interface MessageUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    providerId?: string;
    model?: string;
    modelUsage?: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
    }>;
}

export interface SessionMetadata {
    transcriptFormat?: 2;
    id: string;
    agentDir: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
    /** @deprecated legacy split-id sessions; equals id on unified sessions */
    sdkSessionId?: string;
    unifiedSession?: boolean;
    stats?: SessionStats;
    /** Associated cron task ID (if this session is used by a scheduled task) */
    cronTaskId?: string;
    /** Product-owned hidden maintenance marker. Ordinary automation sessions leave this unset. */
    systemMaintenanceKind?: SystemMaintenanceSessionKind;
    /**
     * Legacy channel/source metadata. Kept for compatibility with old sessions
     * and IM channel identifiers; use `origin` for product/statistics origin.
     */
    source?: string;
    /** Stable product/statistics origin. This is the session birth fact; legacy `source` is channel metadata. */
    origin?: SessionOrigin;
    /** User-pinned to the 收藏 filter view. Only `true` is persisted; absent
     *  has identical meaning to false. */
    favorite?: boolean;
    /** Hidden from active sidebar lists; content and execution remain intact. */
    archived?: boolean;
    /** Server-owned ordering timestamp for the workspace sidebar. */
    pinnedAt?: string;
    /** User-managed global names used to organize Session history. */
    userTags?: string[];
    /** Preview of the last user message (truncated, for Task Center display) */
    lastMessagePreview?: string;
    /** How the title was set: default (first message truncation), auto (AI-generated), user (manually renamed) */
    titleSource?: 'default' | 'auto' | 'user';
    /** Fork source — present on first open after a fork, consumed and cleared */
    forkFrom?: { sourceSessionId: string; messageUuid?: string };
    /** Runtime that created this session. Absent = pre-v0.1.60 session → treat as 'builtin' */
    runtime?: string;
    /** Runtime source. Missing external Codex history is treated as 'system-cli'. */
    runtimeSource?: RuntimeSource;
    /** Runtime's native session/thread ID (Codex threadId, CC session_id from hook) */
    runtimeSessionId?: string;

    // ─── Config snapshot (v0.1.69) ───
    // Desktop/Cron sessions capture these on first write; IM sessions stay undefined
    // (live-follow AgentConfig). `configSnapshotAt` presence marks "locked".
    model?: string;
    /** #324 — reasoning effort snapshot ('default' | level) */
    reasoningEffort?: string;
    permissionMode?: string;
    mcpEnabledServers?: string[];
    /** Snapshot Claude cc-plugin enabled list. */
    enabledPluginIds?: string[];
    /** Snapshot MyAgents official CLI tool enabled list. */
    enabledOfficialToolIds?: OfficialToolId[];
    providerId?: string;
    providerRoute?: ProviderRoute;
    /** Provider-facing identity for runtime-backed providers such as Managed Codex. */
    providerExecutionIdentity?: RuntimeBackedProviderIdentity;
    providerRouteRepairedAt?: string;
    /** Credentials — server redacts to '[redacted]' in PATCH response (zero-trust) */
    providerEnvJson?: string;
    configSnapshotAt?: string;
    materializationState?: 'prepared';
    materializationSourceSessionId?: string;

    /**
     * PRD 0.2.32 — 上一轮结束时的 context 用量快照（与实时环同一个计算结果，单一数据源）。
     * 后端每轮末写入；重开会话时前端 seed 给指示器，使环立即显示真实占用、且与会话期间一致。
     */
    lastContextUsage?: ContextUsage;
}

export interface SessionMessage {
    turnId?: string;
    transcriptState?: import('../../shared/types/session-message').SessionMessage['transcriptState'];
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    sdkUuid?: string;
    runtimeTurnAnchor?: {
        turnId: string;
        rootUserMessageId: string;
    };
    attachments?: Array<{
        id: string;
        name: string;
        mimeType: string;
        path: string;
        previewUrl?: string;
    }>;
    usage?: MessageUsage;
    toolCount?: number;
    durationMs?: number;
}

export interface SessionData extends SessionMetadata {
    messages: SessionMessage[];
    transcriptSaveStatus?: import('../../shared/sessionTranscript').TranscriptSaveStatus;
    transcriptRecovery?: 'incomplete' | 'unavailable';
}

export interface SessionDetailedStats {
    summary: SessionStats & { humanQueryCount: number };
    byModel: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        count: number;
        model?: string;
        providerId?: string;
    }>;
    details: Array<{
        turnTrigger: string;
        model?: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        toolCount?: number;
        durationMs?: number;
    }>;
}

function sortSessionsByLastActive(data: SessionMetadata[]): SessionMetadata[] {
    return [...data]
        .filter((session) => !isSystemMaintenanceSession(session))
        .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
}

/**
 * Get all sessions, optionally filtered by agentDir
 */
export async function getSessions(agentDir?: string): Promise<SessionMetadata[]> {
    if (isTauri()) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const sessions = await invoke<SessionMetadata[]>('cmd_list_session_metadata', {
                agentDir: agentDir ?? null,
            });
            return sortSessionsByLastActive(sessions);
        } catch (error) {
            console.warn('[sessionClient] cmd_list_session_metadata failed, falling back to /sessions:', error);
        }
    }

    const endpoint = agentDir
        ? `/sessions?agentDir=${encodeURIComponent(agentDir)}`
        : '/sessions';
    const result = await apiGetJson<{ success: boolean; sessions: SessionMetadata[] }>(endpoint);
    return sortSessionsByLastActive(result.sessions ?? []);
}

/**
 * Create a new session
 */
export async function createSession(
    agentDir: string,
    runtime?: string,
    opts?: {
        seedMaxPermission?: boolean;
        runtimeSource?: RuntimeSource;
        providerExecutionIdentity?: RuntimeBackedProviderIdentity;
        providerId?: string;
        model?: string;
        permissionMode?: string;
        reasoningEffort?: string;
        mcpEnabledServers?: string[];
        enabledPluginIds?: string[];
        enabledOfficialToolIds?: OfficialToolId[];
        origin?: SessionOrigin;
        prepareForFirstUserMessage?: boolean;
        materializationSourceSessionId?: string;
    },
    owner?: { type: 'tab' | 'companion'; id: string; pendingSessionId?: string },
): Promise<SessionMetadata> {
    const payload = {
            agentDir,
            ...(runtime ? { runtime } : {}),
            ...(opts?.runtimeSource ? { runtimeSource: opts.runtimeSource } : {}),
            ...(opts?.providerExecutionIdentity ? { providerExecutionIdentity: opts.providerExecutionIdentity } : {}),
            ...(opts?.providerId ? { providerId: opts.providerId } : {}),
            ...(opts?.model !== undefined ? { model: opts.model } : {}),
            ...(opts?.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
            ...(opts?.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
            ...(opts?.mcpEnabledServers !== undefined ? { mcpEnabledServers: opts.mcpEnabledServers } : {}),
            ...(opts?.enabledPluginIds !== undefined ? { enabledPluginIds: opts.enabledPluginIds } : {}),
            ...(opts?.enabledOfficialToolIds !== undefined ? { enabledOfficialToolIds: opts.enabledOfficialToolIds } : {}),
            ...(opts?.origin !== undefined ? { origin: opts.origin } : {}),
            ...(opts?.prepareForFirstUserMessage ? { prepareForFirstUserMessage: true } : {}),
            ...(opts?.materializationSourceSessionId !== undefined ? { materializationSourceSessionId: opts.materializationSourceSessionId } : {}),
            // PRD 0.2.34 §14 D14：桌面渠道创建时由服务端原子地种「最宽松权限 per
            // runtime」（getMaxPermissionForRuntime），避免创建后再 PATCH 的吞错窗口。
            ...(opts?.seedMaxPermission ? { seedMaxPermission: true } : {}),
        };
    if (owner) {
        const pendingSessionId = owner.pendingSessionId ?? `pending-${crypto.randomUUID()}`;
        let ownedSessionId = pendingSessionId;
        await ensureSessionSidecar(pendingSessionId, agentDir, owner.type, owner.id,
            runtime ? { runtime, runtimeSource: opts?.runtimeSource } : undefined);
        const post = async (id: string, body: MaterializePostBody): Promise<MaterializeResponse> => {
            const preparing = body.phase === 'prepare';
            const response = await sessionSidecarFetch(id, owner,
                preparing ? '/api/session/birth' : '/api/session/materialize', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(preparing ? payload : body),
                });
            if (!response.ok) {
                const error = await response.json().catch(() => null) as { error?: string } | null;
                throw new Error(error?.error ?? `Session creation failed (HTTP ${response.status}).`);
            }
            const result = await response.json() as MaterializeResponse & { session?: SessionMetadata };
            return preparing ? { ...result, sessionId: result.session?.id, metadata: result.session } : result;
        };
        try {
            const created = await materializePendingSessionConfig({
                pendingSessionId, tabId: owner.id, workspacePath: agentDir, snapshotPatch: {},
                transport: {
                    postCurrent: body => post(pendingSessionId, body),
                    postForSession: post,
                    upgradeSessionId: async (oldId, newId) => {
                        const applied = await upgradeSessionId(oldId, newId, owner.id, owner.type);
                        if (applied) ownedSessionId = newId;
                        return applied;
                    },
                },
            });
            return created.metadata;
        } catch (error) {
            await releaseSessionSidecar(ownedSessionId, owner.type, owner.id).catch(() => false);
            throw error;
        }
    }
    const result = await apiPostJson<{ success: boolean; session: SessionMetadata }>('/sessions', payload);
    return result.session;
}

/**
 * Get session details with messages
 */
export async function getSessionDetails(sessionId: string): Promise<SessionData | null> {
    try {
        const result = await apiGetJson<{ success: boolean; session: SessionData }>(
            `/sessions/${sessionId}`
        );
        return result.session ?? null;
    } catch {
        return null;
    }
}

/**
 * Delete a session
 */
export async function deleteSession(
    sessionId: string,
    releasableTabIds: readonly string[] = [],
): Promise<SessionDeleteResult> {
    try {
        return await deleteSessionIfUnowned(sessionId, releasableTabIds);
    } catch {
        return { deleted: false, reason: 'unexpected' };
    }
}

/**
 * Update session metadata
 */
export async function updateSession(
    sessionId: string,
    updates: {
        title?: string;
        titleSource?: 'default' | 'auto' | 'user';
        /** true → pin to 收藏 view; false → unpin. Server only stores `true`,
         *  so toggling off shrinks the on-disk metadata back to the absent
         *  baseline. */
        favorite?: boolean;
        /** true archives; false restores without altering execution or history. */
        archived?: boolean;
        /** true pins to the workspace sidebar; false removes the canonical timestamp. */
        pinned?: boolean;
        // v0.1.69 snapshot fields — null clears, undefined leaves unchanged.
        // Server auto-stamps configSnapshotAt when any snapshot field is touched
        // and redacts providerEnvJson to '[redacted]' in the response (zero-trust).
        model?: string | null;
        /** #324 — reasoning effort snapshot ('default' | level); null clears. */
        reasoningEffort?: string | null;
        permissionMode?: string | null;
        mcpEnabledServers?: string[] | null;
        enabledPluginIds?: string[] | null;
        enabledOfficialToolIds?: OfficialToolId[] | null;
        providerId?: string | null;
        providerRoute?: ProviderRoute | null;
        providerExecutionIdentity?: RuntimeBackedProviderIdentity | null;
        providerEnvJson?: string | null;
        origin?: SessionOrigin | null;
    },
    owner?: { type: 'tab' | 'companion'; id: string },
): Promise<SessionMetadata | null> {
    // #305: throw on HTTP / JSON failure instead of returning null.
    // Pre-fix: catch-all → null → callers treated persistence failures as
    // "session not found" silently, and `persistInputOptionChange` swallowed
    // them as success. Now `patchSnapshot` rejects on real failure so the
    // toast warning "配置未能完全保存" actually fires for the user.
    const options: RequestInit = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    };
    // Live configuration edits must update the same active transcript binding
    // that supplies the next turn's snapshot. Global writes only update disk.
    const result = owner
        ? await sessionSidecarFetch(sessionId, owner, `/sessions/${sessionId}`, options)
        : await apiFetch(`/sessions/${sessionId}`, options);
    if (!result.ok) {
        // 404 ("Session not found") is the one legitimate null — race where
        // the session was deleted out from under us. Other status codes are
        // real failures the caller needs to know about.
        if (result.status === 404) return null;
        const body = await result.text().catch(() => '');
        throw new Error(`PATCH /sessions/${sessionId} failed: HTTP ${result.status} ${body.slice(0, 200)}`);
    }
    const data = await result.json() as { success: boolean; session: SessionMetadata };
    return data.session ?? null;
}

export type SessionUserTagApiFailureReason =
    | 'invalid-name'
    | 'session-not-found'
    | 'protected-session'
    | 'limit-reached'
    | 'tag-not-found'
    | 'merge-required'
    | 'conflict'
    | 'io-error';

export class SessionUserTagApiError extends Error {
    constructor(
        public readonly reason: SessionUserTagApiFailureReason,
        message: string,
        public readonly status: number,
        public readonly targetName?: string,
    ) {
        super(message);
        this.name = 'SessionUserTagApiError';
    }
}

export interface SessionUserTagMutationResponse {
    session?: SessionMetadata;
    tags: SessionUserTagSummary[];
    affectedSessionCount: number;
    action: 'updated' | 'noop';
}

async function readSessionUserTagMutationResponse(response: Response): Promise<SessionUserTagMutationResponse> {
    const payload = await response.json().catch(() => null) as ({
        success?: boolean;
        reason?: SessionUserTagApiFailureReason;
        error?: string;
        targetName?: string;
    } & Partial<SessionUserTagMutationResponse>) | null;
    if (!response.ok || payload?.success !== true || !Array.isArray(payload.tags)) {
        throw new SessionUserTagApiError(
            payload?.reason ?? 'io-error',
            payload?.error ?? `Session Tag request failed with HTTP ${response.status}.`,
            response.status,
            payload?.targetName,
        );
    }
    return {
        ...(payload.session ? { session: payload.session } : {}),
        tags: payload.tags,
        affectedSessionCount: payload.affectedSessionCount ?? 0,
        action: payload.action ?? 'noop',
    };
}

export async function getSessionUserTags(): Promise<SessionUserTagSummary[]> {
    const response = await apiGetJson<{ success: boolean; tags: SessionUserTagSummary[] }>('/api/session-tags');
    return response.tags ?? [];
}

export async function mutateSessionUserTagAssignment(
    sessionId: string,
    mutation: SessionUserTagMutation,
): Promise<SessionUserTagMutationResponse> {
    const response = await apiFetch('/api/session-tags/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sessionId,
            operation: mutation.kind,
            name: mutation.name,
        }),
    });
    return readSessionUserTagMutationResponse(response);
}

export async function mutateGlobalSessionUserTag(
    mutation: GlobalSessionUserTagMutation,
    focusSessionId?: string,
): Promise<SessionUserTagMutationResponse> {
    const response = await apiFetch('/api/session-tags/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            operation: mutation.kind,
            name: mutation.name,
            ...(mutation.kind === 'rename' ? { newName: mutation.newName, merge: mutation.merge === true } : {}),
            ...(focusSessionId ? { focusSessionId } : {}),
        }),
    });
    return readSessionUserTagMutationResponse(response);
}

/**
 * Get detailed session statistics
 */
export async function getSessionStats(sessionId: string): Promise<SessionDetailedStats | null> {
    try {
        const result = await apiGetJson<{ success: boolean; stats: SessionDetailedStats }>(
            `/sessions/${sessionId}/stats`
        );
        return result.stats ?? null;
    } catch {
        return null;
    }
}

// Auto session-title generation moved fully to the backend Title Service (#296):
// the sidecar triggers it after a successful turn and pushes the result via the
// `chat:session-title-changed` SSE event. The former `generateSessionTitle`
// client helper + its frontend trigger in TabProvider were retired. The
// `/api/generate-session-title` endpoint still exists for a future manual
// "regenerate title" action.

// ============= Global Stats =============

export interface GlobalStats {
    summary: {
        totalSessions: number;
        turnCount: number;
        humanQueryCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCacheReadTokens: number;
        totalCacheCreationTokens: number;
    };
    daily: Array<{
        date: string;
        inputTokens: number;
        outputTokens: number;
        turnCount: number;
        humanQueryCount: number;
    }>;
    byModel: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        count: number;
        model?: string;
        providerId?: string;
    }>;
}

/**
 * Get global token usage statistics
 */
export async function getGlobalStats(range: '7d' | '30d' | '60d'): Promise<GlobalStats | null> {
    try {
        const result = await apiGetJson<{ success: boolean; stats: GlobalStats }>(
            `/api/global-stats?range=${range}`
        );
        return result.stats ?? null;
    } catch {
        return null;
    }
}
