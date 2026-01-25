/**
 * SessionStore - Handles persistence of session data to JSON files.
 * 
 * Storage structure:
 * ~/.myagents/
 * ├── sessions.json          # Array of SessionMetadata
 * └── sessions/
 *     ├── {session-id}.json  # Full session data with messages
 *     └── ...
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { SessionMetadata, SessionData, SessionMessage } from './types/session';
import { createSessionMetadata, generateSessionTitle } from './types/session';

const MYAGENTS_DIR = join(homedir(), '.myagents');
const SESSIONS_FILE = join(MYAGENTS_DIR, 'sessions.json');
const SESSIONS_DIR = join(MYAGENTS_DIR, 'sessions');
const ATTACHMENTS_DIR = join(MYAGENTS_DIR, 'attachments');

/**
 * Ensure storage directories exist
 */
function ensureStorageDir(): void {
    if (!existsSync(MYAGENTS_DIR)) {
        mkdirSync(MYAGENTS_DIR, { recursive: true });
    }
    if (!existsSync(SESSIONS_DIR)) {
        mkdirSync(SESSIONS_DIR, { recursive: true });
    }
    if (!existsSync(ATTACHMENTS_DIR)) {
        mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    }
}

/**
 * Read all session metadata
 */
export function getAllSessionMetadata(): SessionMetadata[] {
    ensureStorageDir();

    if (!existsSync(SESSIONS_FILE)) {
        return [];
    }

    try {
        const content = readFileSync(SESSIONS_FILE, 'utf-8');
        return JSON.parse(content) as SessionMetadata[];
    } catch (error) {
        console.error('[SessionStore] Failed to read sessions.json:', error);
        return [];
    }
}

/**
 * Get sessions for a specific agent directory
 */
export function getSessionsByAgentDir(agentDir: string): SessionMetadata[] {
    const all = getAllSessionMetadata();
    return all
        .filter(s => s.agentDir === agentDir)
        .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
}

/**
 * Get session metadata by ID
 */
export function getSessionMetadata(sessionId: string): SessionMetadata | null {
    const all = getAllSessionMetadata();
    return all.find(s => s.id === sessionId) ?? null;
}

/**
 * Save session metadata (create or update)
 */
export function saveSessionMetadata(session: SessionMetadata): void {
    ensureStorageDir();

    const all = getAllSessionMetadata();
    const index = all.findIndex(s => s.id === session.id);

    if (index >= 0) {
        all[index] = session;
    } else {
        all.push(session);
    }

    try {
        writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2), 'utf-8');
    } catch (error) {
        console.error('[SessionStore] Failed to write sessions.json:', error);
    }
}

/**
 * Delete session metadata and data
 */
export function deleteSession(sessionId: string): boolean {
    ensureStorageDir();

    // Remove from metadata
    const all = getAllSessionMetadata();
    const filtered = all.filter(s => s.id !== sessionId);

    if (filtered.length === all.length) {
        return false; // Not found
    }

    try {
        writeFileSync(SESSIONS_FILE, JSON.stringify(filtered, null, 2), 'utf-8');

        // Remove session data file
        const dataFile = join(SESSIONS_DIR, `${sessionId}.json`);
        if (existsSync(dataFile)) {
            unlinkSync(dataFile);
        }

        return true;
    } catch (error) {
        console.error('[SessionStore] Failed to delete session:', error);
        return false;
    }
}

/**
 * Get full session data including messages
 */
export function getSessionData(sessionId: string): SessionData | null {
    const metadata = getSessionMetadata(sessionId);
    if (!metadata) {
        return null;
    }

    const dataFile = join(SESSIONS_DIR, `${sessionId}.json`);

    if (!existsSync(dataFile)) {
        return {
            ...metadata,
            messages: [],
        };
    }

    try {
        const content = readFileSync(dataFile, 'utf-8');
        const data = JSON.parse(content) as { messages: SessionMessage[] };
        return {
            ...metadata,
            messages: data.messages ?? [],
        };
    } catch (error) {
        console.error('[SessionStore] Failed to read session data:', error);
        return {
            ...metadata,
            messages: [],
        };
    }
}

/**
 * Save session messages
 */
export function saveSessionMessages(sessionId: string, messages: SessionMessage[]): void {
    ensureStorageDir();

    const dataFile = join(SESSIONS_DIR, `${sessionId}.json`);

    try {
        writeFileSync(dataFile, JSON.stringify({ messages }, null, 2), 'utf-8');
    } catch (error) {
        console.error('[SessionStore] Failed to write session data:', error);
    }
}

/**
 * Update session metadata (title, lastActiveAt, sdkSessionId)
 */
export function updateSessionMetadata(
    sessionId: string,
    updates: Partial<Pick<SessionMetadata, 'title' | 'lastActiveAt' | 'sdkSessionId'>>
): SessionMetadata | null {
    const session = getSessionMetadata(sessionId);
    if (!session) {
        return null;
    }

    const updated = { ...session, ...updates };
    saveSessionMetadata(updated);
    return updated;
}

/**
 * Create a new session for the given agent directory
 */
export function createSession(agentDir: string): SessionMetadata {
    const session = createSessionMetadata(agentDir);
    saveSessionMetadata(session);
    console.log(`[SessionStore] Created session ${session.id} for ${agentDir}`);
    return session;
}

/**
 * Update session title from first message if needed
 */
export function updateSessionTitleFromMessage(sessionId: string, message: string): void {
    const session = getSessionMetadata(sessionId);
    if (!session || session.title !== 'New Chat') {
        return;
    }

    const title = generateSessionTitle(message);
    updateSessionMetadata(sessionId, { title });
}

/**
 * Save attachment data to disk
 * @returns Relative path to the attachment
 */
export function saveAttachment(
    sessionId: string,
    attachmentId: string,
    fileName: string,
    base64Data: string,
    mimeType: string
): string {
    ensureStorageDir();

    // Create session-specific attachments directory
    const sessionAttachmentsDir = join(ATTACHMENTS_DIR, sessionId);
    if (!existsSync(sessionAttachmentsDir)) {
        mkdirSync(sessionAttachmentsDir, { recursive: true });
    }

    // Determine file extension
    const ext = mimeType.split('/')[1] || 'bin';
    const safeFileName = `${attachmentId}.${ext}`;
    const filePath = join(sessionAttachmentsDir, safeFileName);

    // Decode base64 and write to file
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        writeFileSync(filePath, buffer);
        console.log(`[SessionStore] Saved attachment: ${filePath}`);
        return `${sessionId}/${safeFileName}`;
    } catch (error) {
        console.error('[SessionStore] Failed to save attachment:', error);
        throw error;
    }
}

/**
 * Get absolute path to attachment
 */
export function getAttachmentPath(relativePath: string): string {
    return join(ATTACHMENTS_DIR, relativePath);
}

/**
 * Get attachment as base64 data URL for frontend display
 */
export function getAttachmentDataUrl(relativePath: string, mimeType: string): string | null {
    try {
        const filePath = getAttachmentPath(relativePath);
        if (!existsSync(filePath)) {
            return null;
        }
        const buffer = readFileSync(filePath);
        const base64 = buffer.toString('base64');
        return `data:${mimeType};base64,${base64}`;
    } catch (error) {
        console.error('[SessionStore] Failed to read attachment:', error);
        return null;
    }
}
