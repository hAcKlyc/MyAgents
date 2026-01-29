/**
 * SessionStore - Handles persistence of session data using JSONL format.
 *
 * Storage structure:
 * ~/.myagents/
 * ├── sessions.json          # Array of SessionMetadata (index)
 * └── sessions/
 *     ├── {session-id}.jsonl  # Messages in JSONL format (append-only)
 *     └── ...
 *
 * JSONL Benefits:
 * - O(1) append for new messages (no full file rewrite)
 * - Crash recovery: partial writes don't corrupt history
 * - Concurrent safety: append is atomic on most filesystems
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync, rmdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { SessionMetadata, SessionData, SessionMessage, SessionStats } from './types/session';
import { createSessionMetadata, generateSessionTitle } from './types/session';

const MYAGENTS_DIR = join(homedir(), '.myagents');
const SESSIONS_FILE = join(MYAGENTS_DIR, 'sessions.json');
const SESSIONS_DIR = join(MYAGENTS_DIR, 'sessions');
const ATTACHMENTS_DIR = join(MYAGENTS_DIR, 'attachments');

/**
 * Line count cache for JSONL files
 * Avoids repeated file reads when appending messages
 * Cache is per-process (each Sidecar maintains its own cache)
 */
const lineCountCache = new Map<string, number>();

/**
 * Get cached line count, reading from file only on cache miss
 */
function getCachedLineCount(sessionId: string, filePath: string): number {
    const cached = lineCountCache.get(sessionId);
    if (cached !== undefined) {
        return cached;
    }
    // Cold start: read from file
    const count = countLinesFromFile(filePath);
    lineCountCache.set(sessionId, count);
    return count;
}

/**
 * Update cached line count after appending messages
 */
function incrementLineCount(sessionId: string, delta: number): void {
    const current = lineCountCache.get(sessionId) ?? 0;
    lineCountCache.set(sessionId, current + delta);
}

/**
 * Clear line count cache for a session (on delete)
 */
function clearLineCountCache(sessionId: string): void {
    lineCountCache.delete(sessionId);
}

/**
 * File locking for sessions.json concurrent access safety.
 *
 * Uses directory creation (mkdir) as an atomic lock operation (cross-platform).
 *
 * Design rationale for synchronous locking:
 * - Each Chat Tab has its own Sidecar process; cross-process contention is rare
 * - sessions.json writes happen infrequently (session create, stats update, title update)
 * - The lock hold time is very short (~1ms for a JSON write)
 * - Making this async would cascade through persistMessagesToStorage → handleMessageComplete,
 *   requiring a large refactor with minimal practical benefit
 * - The retry loop uses a short busy-wait (10ms intervals, 3 retries) as a pragmatic trade-off:
 *   worst case blocks the event loop for ~30ms, which is unnoticeable in practice
 */
const SESSIONS_LOCK_FILE = join(MYAGENTS_DIR, 'sessions.lock');
const LOCK_MAX_RETRIES = 3;    // Max retry attempts before giving up
const LOCK_RETRY_MS = 10;      // Short busy-wait between retries
const LOCK_STALE_MS = 30000;   // Consider lock stale after 30 seconds

/**
 * Acquire lock for sessions.json modification.
 * Returns true if lock acquired, false if all retries exhausted.
 */
function acquireSessionsLock(): boolean {
    for (let attempt = 0; attempt <= LOCK_MAX_RETRIES; attempt++) {
        try {
            // mkdir is atomic - fails if directory already exists
            mkdirSync(SESSIONS_LOCK_FILE);
            return true;
        } catch {
            // Lock exists — check if it's stale (e.g., process crashed while holding lock)
            try {
                const stat = statSync(SESSIONS_LOCK_FILE);
                const lockAge = Date.now() - stat.mtimeMs;
                if (lockAge > LOCK_STALE_MS) {
                    console.warn(`[SessionStore] Releasing stale lock (age: ${lockAge}ms)`);
                    releaseSessionsLock();
                    continue; // Retry immediately after clearing stale lock
                }
            } catch {
                // Lock was released between our check and stat — retry immediately
                continue;
            }

            // Brief busy-wait before retry. Acceptable because:
            // 1. Lock hold time is ~1ms (just a JSON write)
            // 2. Max total busy-wait is LOCK_MAX_RETRIES * LOCK_RETRY_MS = 30ms
            // 3. Cross-process contention is rare in practice
            if (attempt < LOCK_MAX_RETRIES) {
                const end = Date.now() + LOCK_RETRY_MS;
                while (Date.now() < end) { /* busy-wait */ }
            }
        }
    }

    console.error('[SessionStore] Failed to acquire lock after retries');
    return false;
}

/**
 * Release sessions.json lock
 */
function releaseSessionsLock(): void {
    try {
        rmdirSync(SESSIONS_LOCK_FILE);
    } catch {
        // Lock already released or doesn't exist
    }
}

/**
 * Execute a function with sessions.json lock held.
 * Ensures lock is always released, even if fn throws.
 */
function withSessionsLock<T>(fn: () => T): T {
    if (!acquireSessionsLock()) {
        throw new Error('[SessionStore] Could not acquire lock for sessions.json');
    }
    try {
        return fn();
    } finally {
        releaseSessionsLock();
    }
}

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
 * Validate session ID to prevent path traversal attacks
 */
function isValidSessionId(sessionId: string): boolean {
    // Allow UUID format and session-timestamp-random format
    return /^[a-zA-Z0-9-]+$/.test(sessionId) && sessionId.length > 0 && sessionId.length < 100;
}

/**
 * Get the JSONL file path for a session
 */
function getSessionFilePath(sessionId: string): string {
    if (!isValidSessionId(sessionId)) {
        throw new Error(`[SessionStore] Invalid session ID: ${sessionId}`);
    }
    return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

/**
 * Get the legacy JSON file path (for migration)
 */
function getLegacySessionFilePath(sessionId: string): string {
    if (!isValidSessionId(sessionId)) {
        throw new Error(`[SessionStore] Invalid session ID: ${sessionId}`);
    }
    return join(SESSIONS_DIR, `${sessionId}.json`);
}

/**
 * Count lines in a JSONL file by reading the file (internal, use getCachedLineCount for performance)
 */
function countLinesFromFile(filePath: string): number {
    if (!existsSync(filePath)) {
        return 0;
    }
    try {
        const content = readFileSync(filePath, 'utf-8');
        return content.split('\n').filter(line => line.trim()).length;
    } catch {
        return 0;
    }
}

/**
 * Read messages from JSONL file with per-line error tolerance
 * Corrupted lines are skipped to prevent data loss
 */
function readMessagesFromJsonl(filePath: string): SessionMessage[] {
    if (!existsSync(filePath)) {
        return [];
    }

    try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        const messages: SessionMessage[] = [];

        for (let i = 0; i < lines.length; i++) {
            try {
                messages.push(JSON.parse(lines[i]) as SessionMessage);
            } catch (lineError) {
                // Skip corrupted lines but continue processing
                console.warn(`[SessionStore] Skipping corrupted line ${i + 1}:`, lineError);
            }
        }

        return messages;
    } catch (error) {
        console.error('[SessionStore] Failed to read JSONL file:', error);
        return [];
    }
}

/**
 * Migrate legacy JSON file to JSONL format
 * Handles interrupted migrations (both files exist) gracefully
 */
function migrateToJsonl(sessionId: string): SessionMessage[] {
    const legacyPath = getLegacySessionFilePath(sessionId);
    const jsonlPath = getSessionFilePath(sessionId);

    // Handle interrupted migration: if both files exist, prefer JSONL and cleanup legacy
    if (existsSync(jsonlPath) && existsSync(legacyPath)) {
        console.log(`[SessionStore] Cleaning up interrupted migration: ${sessionId}`);
        try {
            unlinkSync(legacyPath);
        } catch (e) {
            console.warn('[SessionStore] Failed to cleanup legacy file:', e);
        }
        return readMessagesFromJsonl(jsonlPath);
    }

    if (!existsSync(legacyPath)) {
        return [];
    }

    try {
        // Read legacy JSON
        const content = readFileSync(legacyPath, 'utf-8');
        const data = JSON.parse(content) as { messages: SessionMessage[] };
        const messages = data.messages ?? [];

        if (messages.length > 0) {
            // Write to JSONL format
            const jsonlContent = messages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
            writeFileSync(jsonlPath, jsonlContent, 'utf-8');
            console.log(`[SessionStore] Migrated ${messages.length} messages to JSONL: ${sessionId}`);
        }

        // Remove legacy file
        unlinkSync(legacyPath);
        console.log(`[SessionStore] Removed legacy JSON file: ${sessionId}`);

        return messages;
    } catch (error) {
        console.error('[SessionStore] Migration failed:', error);
        return [];
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

    withSessionsLock(() => {
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
    });
}

/**
 * Delete session metadata and data
 */
export function deleteSession(sessionId: string): boolean {
    ensureStorageDir();

    return withSessionsLock(() => {
        // Remove from metadata
        const all = getAllSessionMetadata();
        const filtered = all.filter(s => s.id !== sessionId);

        if (filtered.length === all.length) {
            return false; // Not found
        }

        try {
            writeFileSync(SESSIONS_FILE, JSON.stringify(filtered, null, 2), 'utf-8');

            // Remove session data file (both formats)
            const jsonlFile = getSessionFilePath(sessionId);
            const legacyFile = getLegacySessionFilePath(sessionId);

            if (existsSync(jsonlFile)) {
                unlinkSync(jsonlFile);
            }
            if (existsSync(legacyFile)) {
                unlinkSync(legacyFile);
            }

            // Clear line count cache
            clearLineCountCache(sessionId);

            return true;
        } catch (error) {
            console.error('[SessionStore] Failed to delete session:', error);
            return false;
        }
    });
}

/**
 * Get full session data including messages
 */
export function getSessionData(sessionId: string): SessionData | null {
    const metadata = getSessionMetadata(sessionId);
    if (!metadata) {
        return null;
    }

    const jsonlPath = getSessionFilePath(sessionId);
    const legacyPath = getLegacySessionFilePath(sessionId);

    let messages: SessionMessage[] = [];

    // Check for JSONL file first
    if (existsSync(jsonlPath)) {
        messages = readMessagesFromJsonl(jsonlPath);
    }
    // Check for legacy JSON file and migrate
    else if (existsSync(legacyPath)) {
        messages = migrateToJsonl(sessionId);
    }

    return {
        ...metadata,
        messages,
    };
}

/**
 * Calculate session statistics from messages
 */
export function calculateSessionStats(messages: SessionMessage[]): SessionStats {
    let messageCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;

    for (const msg of messages) {
        if (msg.role === 'user') {
            messageCount++;
        } else if (msg.role === 'assistant' && msg.usage) {
            totalInputTokens += msg.usage.inputTokens ?? 0;
            totalOutputTokens += msg.usage.outputTokens ?? 0;
            totalCacheReadTokens += msg.usage.cacheReadTokens ?? 0;
            totalCacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;
        }
    }

    return {
        messageCount,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens: totalCacheReadTokens || undefined,
        totalCacheCreationTokens: totalCacheCreationTokens || undefined,
    };
}

/**
 * Append a single message to session (O(1) operation)
 */
export function appendSessionMessage(sessionId: string, message: SessionMessage): void {
    ensureStorageDir();

    const filePath = getSessionFilePath(sessionId);

    try {
        const line = JSON.stringify(message) + '\n';
        appendFileSync(filePath, line, 'utf-8');
    } catch (error) {
        console.error('[SessionStore] Failed to append message:', error);
    }
}

/**
 * Save session messages using incremental append.
 * Only appends new messages and updates stats incrementally for performance.
 *
 * The stats update is performed inside withSessionsLock to prevent TOCTOU races
 * where another process could modify sessions.json between our read and write.
 */
export function saveSessionMessages(sessionId: string, messages: SessionMessage[]): void {
    ensureStorageDir();

    const filePath = getSessionFilePath(sessionId);
    const legacyPath = getLegacySessionFilePath(sessionId);

    try {
        // Get existing message count (use cached line count for performance)
        let existingCount = 0;

        if (existsSync(filePath)) {
            existingCount = getCachedLineCount(sessionId, filePath);
        } else if (existsSync(legacyPath)) {
            // Migrate first, then get count from new file
            migrateToJsonl(sessionId);
            existingCount = getCachedLineCount(sessionId, filePath);
        }

        // Only append new messages
        const newMessages = messages.slice(existingCount);

        if (newMessages.length > 0) {
            // Append to JSONL file (no lock needed — per-session files are written by a single Sidecar)
            const linesToAppend = newMessages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
            appendFileSync(filePath, linesToAppend, 'utf-8');
            incrementLineCount(sessionId, newMessages.length);
            console.log(`[SessionStore] Appended ${newMessages.length} new messages (total: ${messages.length})`);

            // Update stats in sessions.json atomically (read + calculate + write under lock)
            const incrementalStats = calculateSessionStats(newMessages);
            withSessionsLock(() => {
                // Read metadata inside the lock to prevent TOCTOU race
                const session = getSessionMetadata(sessionId);
                if (!session) return;

                const existingStats = session.stats ?? {
                    messageCount: 0,
                    totalInputTokens: 0,
                    totalOutputTokens: 0,
                };
                const updatedStats: SessionStats = {
                    messageCount: existingStats.messageCount + incrementalStats.messageCount,
                    totalInputTokens: existingStats.totalInputTokens + incrementalStats.totalInputTokens,
                    totalOutputTokens: existingStats.totalOutputTokens + incrementalStats.totalOutputTokens,
                    totalCacheReadTokens: ((existingStats.totalCacheReadTokens ?? 0) + (incrementalStats.totalCacheReadTokens ?? 0)) || undefined,
                    totalCacheCreationTokens: ((existingStats.totalCacheCreationTokens ?? 0) + (incrementalStats.totalCacheCreationTokens ?? 0)) || undefined,
                };

                // Write directly (we already hold the lock — don't call saveSessionMetadata which would deadlock)
                const all = getAllSessionMetadata();
                const index = all.findIndex(s => s.id === sessionId);
                if (index >= 0) {
                    all[index] = { ...session, stats: updatedStats };
                    writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2), 'utf-8');
                }
            });
        }
    } catch (error) {
        console.error('[SessionStore] Failed to save session messages:', error);
    }
}

/**
 * Update session metadata (title, lastActiveAt, sdkSessionId, stats)
 */
export function updateSessionMetadata(
    sessionId: string,
    updates: Partial<Pick<SessionMetadata, 'title' | 'lastActiveAt' | 'sdkSessionId' | 'stats'>>
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
