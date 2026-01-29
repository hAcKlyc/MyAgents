/**
 * Frontend API client for Session management
 */

import { apiFetch, apiGetJson, apiPostJson } from './apiFetch';

export interface SessionStats {
    messageCount: number;
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
    model?: string;
}

export interface SessionMetadata {
    id: string;
    agentDir: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
    stats?: SessionStats;
}

export interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    usage?: MessageUsage;
    toolCount?: number;
    durationMs?: number;
}

export interface SessionData extends SessionMetadata {
    messages: SessionMessage[];
}

export interface SessionDetailedStats {
    summary: SessionStats;
    byModel: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        count: number;
    }>;
    messageDetails: Array<{
        userQuery: string;
        model?: string;
        inputTokens: number;
        outputTokens: number;
        toolCount?: number;
        durationMs?: number;
    }>;
}

/**
 * Get all sessions, optionally filtered by agentDir
 */
export async function getSessions(agentDir?: string): Promise<SessionMetadata[]> {
    const endpoint = agentDir
        ? `/sessions?agentDir=${encodeURIComponent(agentDir)}`
        : '/sessions';
    const result = await apiGetJson<{ success: boolean; sessions: SessionMetadata[] }>(endpoint);
    return result.sessions ?? [];
}

/**
 * Create a new session
 */
export async function createSession(agentDir: string): Promise<SessionMetadata> {
    const result = await apiPostJson<{ success: boolean; session: SessionMetadata }>(
        '/sessions',
        { agentDir }
    );
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
export async function deleteSession(sessionId: string): Promise<boolean> {
    try {
        await apiFetch(`/sessions/${sessionId}`, { method: 'DELETE' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Update session metadata
 */
export async function updateSession(
    sessionId: string,
    updates: { title?: string }
): Promise<SessionMetadata | null> {
    try {
        const result = await apiFetch(`/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        const data = await result.json() as { success: boolean; session: SessionMetadata };
        return data.session ?? null;
    } catch {
        return null;
    }
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
