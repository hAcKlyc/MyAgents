/**
 * Frontend API client for Session management
 */

import { apiFetch, apiGetJson, apiPostJson } from './apiFetch';

export interface SessionMetadata {
    id: string;
    agentDir: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
}

export interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
}

export interface SessionData extends SessionMetadata {
    messages: SessionMessage[];
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
