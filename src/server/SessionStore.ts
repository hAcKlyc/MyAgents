import { normalizeMcpSelection, normalizeMcpSelectionField } from '../shared/mcpSelection';
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

import { existsSync, linkSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync, renameSync, truncateSync, openSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as asyncFs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import type { DshProjectionCursor, MessageUsage, PendingConversationMutation, PendingDshMutation, PendingDshRootOperation, SessionMetadata, SessionData, SessionMessage, SessionStats } from './types/session';
import type { PendingDshInput } from './types/session';
import { createSessionMetadata, generateSessionTitle, ownsSessionMetadataBirth } from './types/session';
import { isValidProductSessionId, resolveTranscriptFormat } from '../shared/transcriptFormat';
import { createTranscriptProjection, fromStoredTranscriptMessage, transcriptMessages, type TranscriptProjection, type TranscriptSaveStatus, type TranscriptObject } from '../shared/sessionTranscript';
import { copyForkAttachments, discardForkAttachments } from './session-transcript/fork-attachments';
import { SessionTranscript } from './session-transcript/session';
import { TranscriptFile, readTranscriptFile, syncTranscriptDirectory } from './session-transcript/file';
import { TranscriptStorageError, type TranscriptCommitTarget } from './session-transcript/writer';
import type { DecodedTranscript } from './session-transcript/codec';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../shared/config-types';
import { isPendingSessionId } from '../shared/constants';
import { runtimeTypeForBinding } from '../shared/integrated-runtimes/identity';
import { isSystemMaintenanceSession } from '../shared/managedScheduledJob';
import {
    deriveSessionUserTagSummaries,
    MAX_SESSION_USER_TAGS,
    normalizeSessionUserTag,
    sanitizeSessionUserTags,
    type GlobalSessionUserTagMutation,
    type SessionUserTagMutation,
    type SessionUserTagSummary,
} from '../shared/session-user-tags';
import {
    normalizeSessionOrigin,
    type RegisteredAgentSessionOrigin,
    type SessionOrigin,
} from '../shared/session-origin';
import { stripBom } from '../shared/utils';
import { workspacePathsEqual } from '../shared/workspacePath';
import { ensureDirSync } from './utils/fs-utils';
import { withFileLock } from './utils/file-lock';
import { elapsedMs, emitPerfTrace, nowMs } from './utils/perf-trace';
import { reconcileDshV2Assistant } from './session-engine/dsh-product-projection';
import { assertDshProductInputMatches, fingerprintDshProductInput } from './session-engine/dsh-root-operation';
import { normalizeSessionRuntimeIdentity, resolveBuiltinSdkSessionId } from './utils/session-runtime-identity';
import { resolveLastVisibleTurnPreview } from './utils/session-message-preview';

const MYAGENTS_DIR = join(homedir(), '.myagents');
const SESSIONS_FILE = join(MYAGENTS_DIR, 'sessions.json');
const SESSIONS_DIR = join(MYAGENTS_DIR, 'sessions');
const SESSIONS_V2_DIR = join(MYAGENTS_DIR, 'sessions-v2');
const ATTACHMENTS_DIR = join(MYAGENTS_DIR, 'attachments');
const SESSIONS_TMP_FILE = join(MYAGENTS_DIR, 'sessions.json.tmp');
const SESSIONS_LOCK_FILE = join(MYAGENTS_DIR, 'sessions.lock');
const SESSIONS_LOCK_DIR = join(MYAGENTS_DIR, 'session-locks');
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

// Active instances belong to this Session Sidecar, never to a mounted Tab.
const activeTranscripts = new Map<string, SessionTranscript>();
const transcriptBindings = new Map<string, Promise<SessionTranscript>>();
const transcriptStatusListeners = new Set<(status: TranscriptSaveStatus) => void>();

export function getActiveSessionTranscript(sessionId: string): SessionTranscript | undefined {
    const active = activeTranscripts.get(sessionId);
    return active?.isRevoked ? undefined : active;
}

export function subscribeTranscriptSaveStatus(listener: (status: TranscriptSaveStatus) => void): () => void {
    transcriptStatusListeners.add(listener);
    return () => transcriptStatusListeners.delete(listener);
}

function getV2SessionFilePath(sessionId: string): string {
    if (!isValidProductSessionId(sessionId)) throw new Error('Invalid product Session ID');
    return join(SESSIONS_V2_DIR, `${sessionId}.jsonl`);
}

async function pathExists(path: string): Promise<boolean> {
    try { await asyncFs.stat(path); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

async function sessionTranscriptFormat(metadata: SessionMetadata | null, sessionId: string): Promise<'legacy' | 'v2'> {
    const [legacyJsonl, legacyJson, v2] = await Promise.all([
        pathExists(getSessionFilePath(sessionId)), pathExists(getLegacySessionFilePath(sessionId)),
        pathExists(getV2SessionFilePath(sessionId)),
    ]);
    const format = resolveTranscriptFormat({
        metadataExists: metadata !== null, transcriptFormat: metadata?.transcriptFormat,
        legacyFileExists: legacyJsonl || legacyJson, v2FileExists: v2,
    });
    if (format === 'legacy' || format === 'v2') return format;
    throw new TranscriptStorageError('invalid-history', `Session transcript format: ${format}`);
}

async function publishV2Metadata(
    metadata: SessionMetadata, patch: Partial<SessionMetadata>, birth: boolean, committed?: TranscriptCommitTarget,
): Promise<SessionMetadata> {
    return withSessionsLock(async () => {
        let all: SessionMetadata[];
        try { all = parseSessionsIndex(await asyncFs.readFile(SESSIONS_FILE, 'utf8')); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            all = [];
        }
        const index = all.findIndex(row => row.id === metadata.id);
        const existing = all[index];
        if ((!existing && !birth) || (existing && (existing.transcriptFormat !== 2
            || existing.createdAt !== metadata.createdAt || existing.agentDir !== metadata.agentDir))) {
            throw new TranscriptStorageError('invalid-history', 'Session birth publication conflicts with metadata');
        }
        if (committed && sessionUsesDsh(metadata)) {
            const active = getActiveSessionTranscript(metadata.id);
            // The callback runs inside the index lock. Only a commit covering
            // the current projection may retire execution recovery records.
            const caughtUp = active && committed.revision >= active.writer.status.liveRevision;
            const safePatch = { ...patch };
            for (const key of DSH_EXECUTION_METADATA_KEYS) delete safePatch[key];
            patch = caughtUp ? { ...safePatch,
                ...Object.fromEntries(DSH_EXECUTION_METADATA_KEYS.map(key => [key, active.metadata[key]])),
                pendingDshRootInputs: active.metadata.pendingDshRootInputs?.filter(root => !active.writer.projection.messages.has(root.clientUserMessageId)).length
                    ? active.metadata.pendingDshRootInputs?.filter(root => !active.writer.projection.messages.has(root.clientUserMessageId)) : undefined,
            } : safePatch;
        }
        // V2 never writes a cached full row over another owner's unrelated fields.
        const updated = existing ? { ...existing, ...patch } : metadata;
        if (index < 0) all.push(updated); else all[index] = updated;
        await asyncFs.mkdir(MYAGENTS_DIR, { recursive: true });
        const file = await asyncFs.open(SESSIONS_TMP_FILE, 'w');
        try { await file.writeFile(JSON.stringify(all, null, 2), 'utf8'); await file.sync(); }
        finally { await file.close(); }
        await asyncFs.rename(SESSIONS_TMP_FILE, SESSIONS_FILE);
        await syncTranscriptDirectory(MYAGENTS_DIR);
        return updated;
    });
}

function createActiveTranscript(metadata: SessionMetadata, birth: boolean, decoded?: DecodedTranscript, incompleteSource = false): SessionTranscript {
    const transcript = new SessionTranscript({
        metadata, birth, filePath: getV2SessionFilePath(metadata.id),
        generation: decoded?.header.generation ?? randomUUID(), revision: decoded?.revision ?? 0,
        projection: decoded?.projection ?? createTranscriptProjection(),
        recoverIncompleteTail: decoded?.tail === 'incomplete',
        incompleteSource: incompleteSource || decoded?.tail === 'invalid',
        deriveMetadata: projection => {
            // Counts/usage are scalar message fields; tool bodies need no
            // serialization to derive list metadata. Preview remains the last
            // visible USER query, matching the established legacy behavior.
            const messages = [...projection.messages.values()];
            return {
                stats: calculateSessionStats(messages),
                lastMessagePreview: resolveLastVisibleTurnPreview(messages.filter(message => message.role === 'user')
                    .map(message => ({ role: message.role, content: typeof message.content === 'string'
                        ? message.content : JSON.stringify(message.content) }))).preview,
            };
        },
        withLock: run => withSessionFileLock(metadata.id, run), publishMetadata: publishV2Metadata,
        contentBoundMetadataKeys: sessionUsesDsh(metadata) ? DSH_EXECUTION_METADATA_KEYS : undefined,
        prepareReplacement: sessionUsesDsh(metadata) ? async (source, target) => {
            await withSessionsLock(async () => {
                const rows = readSessionsIndexForWrite();
                const index = rows.findIndex(row => row.id === metadata.id);
                const row = rows[index];
                const intent = row?.pendingDshMutation;
                if (intent?.kind !== 'dsh-rewind') return;
                rows[index] = { ...row, pendingDshMutation: { ...intent, transcript: {
                    format: 2, sourceGeneration: source.generation,
                    targetGeneration: target.generation, targetRevision: target.revision,
                } } };
                atomicWriteSessionsFile(JSON.stringify(rows, null, 2));
            });
        } : undefined,
        publishMutationIntent: async (source, intent) => {
            await publishV2Metadata(source, { pendingConversationMutation: intent }, false);
        },
        onStatus: status => {
            for (const listener of transcriptStatusListeners) {
                try { listener(status); } catch (error) { console.warn('[SessionStore] Save status listener failed:', error); }
            }
        },
    });
    activeTranscripts.set(metadata.id, transcript);
    return transcript;
}

/** Called by the existing runtime binding owner before it consumes native events. */
export async function activateSessionTranscript(sessionId: string): Promise<SessionTranscript | undefined> {
    const active = activeTranscripts.get(sessionId);
    if (active) {
        if (active.isRevoked) throw new Error('Session binding has been revoked');
        return active;
    }
    const metadata = getSessionMetadata(sessionId);
    if (!metadata || metadata.transcriptFormat === undefined) return undefined;
    const binding = transcriptBindings.get(sessionId);
    if (binding) return binding;
    const reading = withSessionFileLock(sessionId, async () => {
        let decoded: DecodedTranscript | undefined;
        let incomplete = false;
        let recoverBirth = false;
        try {
            await sessionTranscriptFormat(metadata, sessionId);
            decoded = await readTranscriptFile(getV2SessionFilePath(sessionId), sessionId);
        } catch (error) {
            // A transient read failure must leave cold activation retryable.
            // DSH alone can recover an explicitly journaled missing birth;
            // an ordinary missing published DSH file remains invalid history.
            const invalidHistory = error instanceof TranscriptStorageError && error.reason === 'invalid-history';
            const missingDshFile = sessionUsesDsh(metadata) && (error as NodeJS.ErrnoException).code === 'ENOENT';
            if (!invalidHistory && !missingDshFile) throw error;
            recoverBirth = sessionUsesDsh(metadata) && metadata.pendingDshRootInputs?.some(root => root.transcriptBirth) === true
                && !(await pathExists(getV2SessionFilePath(sessionId)))
                && !(await pathExists(getSessionFilePath(sessionId))) && !(await pathExists(getLegacySessionFilePath(sessionId)));
            incomplete = !recoverBirth;
            if (incomplete) console.warn(`[SessionStore] Cannot fully restore V2 history for ${sessionId}:`, error);
        }
        return { decoded, incomplete, recoverBirth };
    });
    // Adopt the actual read; a slow or temporarily inaccessible file is not corrupt.
    const task = (async () => {
        const result = await reading;
        let effective = metadata;
        if (metadata.pendingConversationMutation) {
            const intent = metadata.pendingConversationMutation;
            const stamp = intent.transcript;
            const decoded = result.decoded;
            if (!stamp || stamp.format !== 2 || !decoded || decoded.tail === 'invalid') {
                throw new TranscriptStorageError('invalid-history', 'Pending conversation mutation has no confirmed native binding');
            }
            if (decoded.header.generation === stamp.targetGeneration && decoded.revision >= stamp.targetRevision) {
                const messages = transcriptMessages(decoded.projection);
                effective = intent.kind === 'codex-rewind'
                    ? finalizeCodexRewindMetadata(metadata, intent, messages)
                    : finalizeBuiltinRewindMetadata(metadata, intent, messages);
            } else if (decoded.header.generation === stamp.sourceGeneration) {
                effective = { ...metadata, pendingConversationMutation: undefined };
            } else {
                throw new TranscriptStorageError('invalid-history', 'Pending conversation mutation generation is ambiguous');
            }
        }
        const transcript = createActiveTranscript(effective, 'recoverBirth' in result && result.recoverBirth === true, result.decoded, result.incomplete);
        if (sessionUsesDsh(metadata)) {
            for (const root of metadata.pendingDshRootInputs ?? []) if (root.userMessage && !transcript.writer.projection.messages.has(root.clientUserMessageId)) {
                assertDshProductInputMatches(root, root.userMessage);
                transcript.writer.observe({ kind: 'message-create', message: fromStoredTranscriptMessage(root.userMessage) });
            }
        }
        if (effective !== metadata) transcript.patchMetadata(effective);
        for (const message of transcript.writer.projection.messages.values()) {
            if (message.transcriptState === 'streaming') transcript.writer.observe({
                kind: 'message-update', messageId: message.id, details: { transcriptState: 'interrupted' },
            });
        }
        // This is cold lifecycle adoption: the previous execution owner is gone.
        // Preserve observed output, but never leave an orphaned tool spinning or
        // imply it completed successfully. No native work is replayed here.
        for (const message of transcript.writer.projection.messages.values()) {
            if (!Array.isArray(message.content)) continue;
            for (const block of message.content) {
                const target = { messageId: message.id, blockId: block.id };
                if ((block.type === 'text' || block.type === 'thinking') && !block.isComplete) {
                    transcript.writer.observe({ kind: 'block-update', ...target, target: 'block', details: { isComplete: true } });
                }
                const tool = block.tool as TranscriptObject | undefined;
                if (!tool || typeof tool !== 'object') continue;
                const interruptTool = (value: TranscriptObject, subagentToolId?: string) => {
                    const details: TranscriptObject = {};
                    if (value.isLoading) Object.assign(details, { isLoading: false, isError: true,
                        resultMeta: { ...(value.resultMeta as TranscriptObject ?? {}), status: 'interrupted' } });
                    const lifecycle = value.subagentLifecycle as TranscriptObject | undefined;
                    if (lifecycle?.status === 'running') details.subagentLifecycle = { ...lifecycle, status: 'interrupted', finishedAt: Date.now() };
                    if (Object.keys(details).length) transcript.writer.observe({ kind: 'block-update', ...target, target: 'tool', ...(subagentToolId ? { subagentToolId } : {}), details });
                };
                interruptTool(tool);
                if (Array.isArray(tool.subagentCalls)) for (const value of tool.subagentCalls) {
                    const call = value as TranscriptObject;
                    if (typeof call?.id === 'string') interruptTool(call, call.id);
                }
            }
        }
        for (const turn of transcript.writer.projection.turns.values()) {
            if (turn.status === 'running') transcript.writer.observe({ kind: 'turn-update', turn: { ...turn, status: 'interrupted' } });
        }
        return transcript;
    })();
    transcriptBindings.set(sessionId, task);
    try { return await task; } finally { transcriptBindings.delete(sessionId); }
}

type TranscriptFileIdentity = Readonly<{
    exists: boolean;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    endsWithNewline: boolean;
}>;

const transcriptCursorState: unique symbol = Symbol('TranscriptWriteCursor');

/**
 * In-process capability proving which durable transcript snapshot an owner
 * loaded. The symbol-keyed physical identity is deliberately unavailable to
 * callers; only SessionStore can issue or advance the capability.
 */
export type TranscriptWriteCursor = Readonly<{
    persistedMessageCount: number;
    [transcriptCursorState]: Readonly<{
        sessionId: string;
        file: TranscriptFileIdentity;
        v2?: Readonly<{ generation: string; revision: number; instanceId?: string; liveRevision?: number }>;
    }>;
}>;

export type SessionTranscriptSnapshot = Readonly<{
    messages: SessionMessage[];
    cursor: TranscriptWriteCursor;
    hasMalformedRows: boolean;
}>;

class CorruptSessionsIndexError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CorruptSessionsIndexError';
    }
}

class MalformedSessionTranscriptError extends Error {
    constructor(sessionId: string) {
        super(`Session ${sessionId} contains malformed JSONL rows`);
        this.name = 'MalformedSessionTranscriptError';
    }
}

function isSessionMetadataLike(entry: unknown): entry is SessionMetadata {
    return Boolean(
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { id?: unknown }).id === 'string'
    );
}

function dedupeSessionMetadata(sessions: SessionMetadata[]): SessionMetadata[] {
    const byId = new Map<string, SessionMetadata>();
    for (const session of sessions) {
        byId.set(session.id, session);
    }
    return [...byId.values()];
}

/**
 * File locking for sessions.json + per-session JSONL concurrent access safety.
 *
 * Pattern 5 §5.4 invariant: no synchronous event-loop blocking. We use the
 * shared async {@link withFileLock} helper (atomic mkdir lock, polled with
 * setTimeout — never Atomics.wait, never busy-spin). This forces all writer
 * paths in SessionStore to be async, and callers cascade `await` accordingly.
 *
 * Stale-recovery rules (delegated to withFileLock):
 *   - valid Node/Rust owner with a confirmed-dead PID → break immediately.
 *   - valid live or liveness-unknown process owner → retain regardless of age.
 *   - missing, renderer, or malformed owner → break only after LOCK_STALE_MS.
 *
 * Lock hold time is ~1ms per call (single append + sessions.json stats update).
 */
async function withSessionsLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(
        { lockPath: SESSIONS_LOCK_FILE, timeoutMs: LOCK_TIMEOUT_MS, staleMs: LOCK_STALE_MS },
        fn,
    );
}

/**
 * Per-session JSONL writer lock. Serializes append + rewind on
 * `<session>.jsonl` against any other writer (cross-tab cron, background
 * completion, future multi-owner cases).
 */
async function withSessionFileLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const safeId = sessionId.replace(/[^a-zA-Z0-9-]/g, '_');
    await asyncFs.mkdir(SESSIONS_LOCK_DIR, { recursive: true });
    const lockPath = join(SESSIONS_LOCK_DIR, `${safeId}.jsonl.lock`);
    return withFileLock(
        { lockPath, timeoutMs: LOCK_TIMEOUT_MS, staleMs: LOCK_STALE_MS },
        fn,
    );
}

async function withSessionFileLocks<T>(sessionIds: string[], fn: () => Promise<T>): Promise<T> {
    const orderedIds = [...new Set(sessionIds)].sort();
    const acquireNext = async (index: number): Promise<T> => {
        if (index >= orderedIds.length) {
            return fn();
        }
        return withSessionFileLock(orderedIds[index], () => acquireNext(index + 1));
    };
    return acquireNext(0);
}

/**
 * Atomic write: write to tmp file then rename.
 * Prevents data loss from partial writes (process crash / power loss during writeFileSync).
 * rename() is atomic on POSIX (macOS/Linux) and near-atomic on Windows (NTFS MoveFileEx).
 */
function atomicWriteSessionsFile(content: string): void {
    const start = nowMs();
    writeFileSync(SESSIONS_TMP_FILE, content, 'utf-8');
    renameSync(SESSIONS_TMP_FILE, SESSIONS_FILE);
    emitPerfTrace({
        trace: 'storage_io',
        phase: 'sessions_metadata_write',
        durationMs: elapsedMs(start),
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
        status: 'ok',
    });
}

/** Session-owned compatibility; never consults current Agent defaults. */
function normalizePersistedSessionMetadata(session: SessionMetadata): SessionMetadata {
    const normalized = normalizeSessionRuntimeIdentity(session);
    normalizeMcpSelectionField(normalized);
    return normalized;
}

function parseSessionsIndexRaw(content: string): SessionMetadata[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripBom(content));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CorruptSessionsIndexError(`sessions.json is not valid JSON: ${detail}`);
    }

    if (!Array.isArray(parsed)) {
        throw new CorruptSessionsIndexError('sessions.json must contain a SessionMetadata array.');
    }

    const malformedIndex = parsed.findIndex(entry => !isSessionMetadataLike(entry));
    if (malformedIndex >= 0) {
        throw new CorruptSessionsIndexError(`sessions.json entry at index ${malformedIndex} is not valid SessionMetadata.`);
    }

    return parsed as SessionMetadata[];
}

function parseSessionsIndex(content: string): SessionMetadata[] {
    return parseSessionsIndexRaw(content).map(normalizePersistedSessionMetadata);
}

function extractCompleteSessionMetadataObjects(content: string): SessionMetadata[] {
    const sessions: SessionMetadata[] = [];
    const text = stripBom(content);
    let depth = 0;
    let objectStart = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === '{') {
            if (depth === 0) {
                objectStart = i;
            }
            depth++;
            continue;
        }

        if (char === '}' && depth > 0) {
            depth--;
            if (depth === 0 && objectStart >= 0) {
                const candidate = text.slice(objectStart, i + 1);
                objectStart = -1;
                try {
                    const parsed = JSON.parse(candidate) as unknown;
                    if (isSessionMetadataLike(parsed)) {
                        sessions.push(parsed);
                    }
                } catch {
                    // Ignore this object; recovery is best-effort and never
                    // mutates the original corrupt file before it is backed up.
                }
            }
        }
    }

    return sessions;
}

function recoverSessionsIndexFromContent(content: string): SessionMetadata[] {
    try {
        const parsed = JSON.parse(stripBom(content)) as unknown;
        if (Array.isArray(parsed)) {
            return dedupeSessionMetadata(parsed.filter(isSessionMetadataLike).map(normalizePersistedSessionMetadata));
        }
    } catch {
        // Fall through to structural scan for truncated or partially written JSON.
    }

    return dedupeSessionMetadata(
        extractCompleteSessionMetadataObjects(content).map(normalizePersistedSessionMetadata),
    );
}

function readTmpSessionsIndexStrict(): SessionMetadata[] | null {
    if (!existsSync(SESSIONS_TMP_FILE)) {
        return null;
    }

    try {
        if (existsSync(SESSIONS_FILE)) {
            const tmpStat = statSync(SESSIONS_TMP_FILE);
            const mainStat = statSync(SESSIONS_FILE);
            if (tmpStat.mtimeMs < mainStat.mtimeMs) {
                console.warn('[SessionStore] Ignoring stale sessions.json.tmp during corrupt-index recovery.');
                return null;
            }
        }
        return parseSessionsIndex(readFileSync(SESSIONS_TMP_FILE, 'utf-8'));
    } catch (error) {
        console.warn('[SessionStore] Ignoring invalid sessions.json.tmp during corrupt-index recovery:', error);
        return null;
    }
}

function recoverSessionsIndexCandidates(): SessionMetadata[] {
    const corruptContent = existsSync(SESSIONS_FILE) ? readFileSync(SESSIONS_FILE, 'utf-8') : '';
    let recovered = recoverSessionsIndexFromContent(corruptContent);
    const tmpSessions = readTmpSessionsIndexStrict();
    if (tmpSessions && tmpSessions.length > 0) {
        recovered = tmpSessions;
    }
    return recovered;
}

function createCorruptBackupPath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(MYAGENTS_DIR, `sessions.json.corrupt-${stamp}`);
    if (!existsSync(base)) {
        return base;
    }

    for (let i = 1; i < 1000; i++) {
        const candidate = `${base}-${i}`;
        if (!existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error('[SessionStore] Cannot allocate a unique sessions.json corrupt backup path.');
}

function readSessionsIndexStrict(): SessionMetadata[] {
    if (!existsSync(SESSIONS_FILE)) {
        return [];
    }

    return parseSessionsIndex(readFileSync(SESSIONS_FILE, 'utf-8'));
}

function backupCorruptSessionsIndex(error: CorruptSessionsIndexError): string {
    const backupPath = createCorruptBackupPath();
    try {
        renameSync(SESSIONS_FILE, backupPath);
    } catch (renameError) {
        const detail = renameError instanceof Error ? renameError.message : String(renameError);
        throw new Error(`[SessionStore] Cannot recover corrupt sessions.json (${error.message}); failed to move it aside: ${detail}`);
    }
    console.error(`[SessionStore] sessions.json was corrupt and has been moved to ${backupPath}. Cause: ${error.message}`);
    return backupPath;
}

function readSessionsIndexForWrite(): SessionMetadata[] {
    try {
        return readSessionsIndexStrict();
    } catch (error) {
        if (error instanceof CorruptSessionsIndexError) {
            const recovered = recoverSessionsIndexCandidates();
            const backupPath = backupCorruptSessionsIndex(error);
            atomicWriteSessionsFile(JSON.stringify(recovered, null, 2));
            console.error(`[SessionStore] Recovered ${recovered.length} session metadata entries while repairing sessions.json. Backup: ${backupPath}`);
            return recovered;
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`[SessionStore] Failed to read sessions.json for write: ${detail}`);
    }
}

/**
 * Ensure storage directories exist
 */
function ensureStorageDir(): void {
    if (!existsSync(MYAGENTS_DIR)) {
        ensureDirSync(MYAGENTS_DIR);
    }
    if (!existsSync(SESSIONS_DIR)) {
        ensureDirSync(SESSIONS_DIR);
    }
    if (!existsSync(ATTACHMENTS_DIR)) {
        ensureDirSync(ATTACHMENTS_DIR);
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

function readJsonlSnapshot(filePath: string): {
    messages: SessionMessage[];
    hasMalformedRows: boolean;
} {
    if (!existsSync(filePath)) {
        return { messages: [], hasMalformedRows: false };
    }

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const messages: SessionMessage[] = [];
    let hasMalformedRows = false;
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            messages.push(JSON.parse(line) as SessionMessage);
        } catch {
            hasMalformedRows = true;
        }
    }
    return { messages, hasMalformedRows };
}

function getTranscriptFileIdentity(filePath: string): TranscriptFileIdentity {
    if (!existsSync(filePath)) {
        return { exists: false, dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0, endsWithNewline: false };
    }
    const stat = statSync(filePath);
    let endsWithNewline = false;
    if (stat.size > 0) {
        const fd = openSync(filePath, 'r');
        try {
            const byte = Buffer.allocUnsafe(1);
            readSync(fd, byte, 0, 1, stat.size - 1);
            endsWithNewline = byte[0] === 0x0a;
        } finally {
            closeSync(fd);
        }
    }
    return {
        exists: true,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        endsWithNewline,
    };
}

function sameTranscriptFileIdentity(
    left: TranscriptFileIdentity,
    right: TranscriptFileIdentity,
): boolean {
    return left.exists === right.exists
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
        && left.endsWithNewline === right.endsWithNewline;
}

function issueTranscriptCursor(
    sessionId: string,
    persistedMessageCount: number,
    file: TranscriptFileIdentity,
): TranscriptWriteCursor {
    return Object.freeze({
        persistedMessageCount,
        [transcriptCursorState]: Object.freeze({ sessionId, file }),
    });
}

function cursorMatches(
    sessionId: string,
    cursor: TranscriptWriteCursor,
    file: TranscriptFileIdentity,
): boolean {
    return cursor[transcriptCursorState].sessionId === sessionId
        && sameTranscriptFileIdentity(cursor[transcriptCursorState].file, file);
}

function readSessionMessagesForMutation(sessionId: string): SessionMessage[] {
    const jsonlPath = getSessionFilePath(sessionId);
    if (existsSync(jsonlPath)) {
        const snapshot = readJsonlSnapshot(jsonlPath);
        if (snapshot.hasMalformedRows) throw new MalformedSessionTranscriptError(sessionId);
        return snapshot.messages;
    }
    if (existsSync(getLegacySessionFilePath(sessionId))) return migrateToJsonl(sessionId);
    return [];
}

function atomicRewriteSessionMessages(sessionId: string, messages: SessionMessage[]): void {
    const filePath = getSessionFilePath(sessionId);
    const tempPath = `${filePath}.rewind-${process.pid}.tmp`;
    const content = messages.map(message => JSON.stringify(message)).join('\n')
        + (messages.length > 0 ? '\n' : '');
    try {
        writeFileSync(tempPath, content, 'utf-8');
        renameSync(tempPath, filePath);
    } catch (error) {
        try {
            if (existsSync(tempPath)) unlinkSync(tempPath);
        } catch { /* best-effort temp cleanup */ }
        throw error;
    }
}

function readMessagesFromLegacyJson(filePath: string): SessionMessage[] {
    if (!existsSync(filePath)) {
        return [];
    }

    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as { messages?: unknown };
    return Array.isArray(data.messages)
        ? data.messages.filter((msg): msg is SessionMessage => Boolean(msg && typeof msg === 'object' && typeof (msg as { role?: unknown }).role === 'string'))
        : [];
}

export function sessionHasUserMessages(sessionId: string): boolean {
    const jsonlPath = getSessionFilePath(sessionId);
    if (existsSync(jsonlPath)) {
        const content = readFileSync(jsonlPath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        for (const line of lines) {
            const msg = JSON.parse(line) as { role?: unknown };
            if (msg.role === 'user') {
                return true;
            }
        }
    }

    const legacyPath = getLegacySessionFilePath(sessionId);
    return readMessagesFromLegacyJson(legacyPath).some(msg => msg.role === 'user');
}

function hasPositiveNumber(value: unknown): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function statsShowActivity(stats: SessionMetadata['stats'] | undefined): boolean {
    return hasPositiveNumber(stats?.messageCount)
        || hasPositiveNumber(stats?.totalInputTokens)
        || hasPositiveNumber(stats?.totalOutputTokens)
        || hasPositiveNumber(stats?.totalCacheReadTokens)
        || hasPositiveNumber(stats?.totalCacheCreationTokens);
}

function isManagedCodexRuntimeBackedBirth(session: SessionMetadata): boolean {
    const identity = session.providerExecutionIdentity;
    return Boolean(
        identity?.kind === 'runtime-backed-provider'
        && identity.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID
        && identity.runtime === 'codex'
        && identity.runtimeSource === 'managed-provider'
    ) || (
        session.runtime === 'codex'
        && session.runtimeSource === 'managed-provider'
        && session.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID
    );
}

function isDesktopOrUnknownOrigin(session: SessionMetadata): boolean {
    const kind = session.origin?.kind;
    if (kind && kind !== 'desktop' && kind !== 'unknown') {
        return false;
    }
    if (session.source && session.source !== 'desktop') {
        return false;
    }
    return true;
}

export function isLegacyPreQueryManagedCodexDraft(session: SessionMetadata): boolean {
    // Versioned births have an explicit lifecycle. Empty or lagging transcript
    // statistics cannot turn a committed V2 Session into a legacy draft.
    // Keep this boundary aligned with Rust via session-history-visibility.json.
    if (session.transcriptFormat !== undefined) return false;
    if (session.materializationState === 'prepared') return false;
    if (!isManagedCodexRuntimeBackedBirth(session)) return false;
    if (!isDesktopOrUnknownOrigin(session)) return false;
    if (session.favorite === true) return false;
    if (session.cronTaskId) return false;
    if (session.title !== 'New Chat') return false;
    if (session.titleSource === 'user') return false;
    if (session.lastMessagePreview) return false;
    if (session.lastContextUsage) return false;
    if (session.runtimeUsageTotals) return false;
    if (statsShowActivity(session.stats)) return false;
    try {
        return !sessionHasUserMessages(session.id);
    } catch {
        return false;
    }
}

export function isHistoryVisibleSession(session: SessionMetadata): boolean {
    return session.materializationState !== 'prepared'
        && !(session.pendingDshMutation?.kind === 'dsh-delete'
            && session.pendingDshMutation.runtimeCommitted === true)
        && !isSystemMaintenanceSession(session)
        && !isLegacyPreQueryManagedCodexDraft(session);
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

    // Read legacy JSON. Migration failures must propagate: returning an empty
    // snapshot would let a later append create a JSONL that masks intact legacy
    // history. The atomic rewrite keeps the legacy file authoritative until a
    // complete JSONL has been published.
    const content = readFileSync(legacyPath, 'utf-8');
    const data = JSON.parse(content) as { messages: SessionMessage[] };
    const messages = data.messages ?? [];

    if (messages.length > 0) {
        atomicRewriteSessionMessages(sessionId, messages);
        console.log(`[SessionStore] Migrated ${messages.length} messages to JSONL: ${sessionId}`);
    }

    unlinkSync(legacyPath);
    console.log(`[SessionStore] Removed legacy JSON file: ${sessionId}`);
    return messages;
}

/**
 * Read all session metadata
 */
export function getAllSessionMetadata(): SessionMetadata[] {
    try {
        return readSessionsIndexStrict();
    } catch (error) {
        if (error instanceof CorruptSessionsIndexError) {
            const recovered = recoverSessionsIndexCandidates();
            console.error(`[SessionStore] sessions.json is corrupt; returning ${recovered.length} recoverable session metadata entries. Next metadata write will move the corrupt file aside and rewrite a repaired index. Cause: ${error.message}`);
            return recovered;
        }
        console.error('[SessionStore] Failed to read sessions.json:', error);
        return [];
    }
}

export type SessionUserTagMutationFailureReason =
    | 'invalid-name'
    | 'session-not-found'
    | 'protected-session'
    | 'limit-reached'
    | 'tag-not-found'
    | 'merge-required'
    | 'conflict'
    | 'io-error';

export type SessionUserTagMutationResult =
    | {
        ok: true;
        session?: SessionMetadata;
        tags: SessionUserTagSummary[];
        affectedSessionCount: number;
        action: 'updated' | 'noop';
    }
    | {
        ok: false;
        reason: SessionUserTagMutationFailureReason;
        targetName?: string;
        error: string;
    };

function storedUserTagsEqual(input: unknown, expected: readonly string[]): boolean {
    if (expected.length === 0) return input === undefined || (Array.isArray(input) && input.length === 0);
    return Array.isArray(input)
        && input.length === expected.length
        && input.every((value, index) => value === expected[index]);
}

function replaceSessionUserTags(session: SessionMetadata, tags: readonly string[]): SessionMetadata {
    const { userTags: _userTags, ...rest } = session;
    return tags.length > 0 ? { ...rest, userTags: [...tags] } : rest;
}

function sessionUserTagSummaries(sessions: readonly SessionMetadata[]): SessionUserTagSummary[] {
    return deriveSessionUserTagSummaries(sessions.filter(isHistoryVisibleSession));
}

/** Read-only global catalog projection. Assignments remain the sole authority. */
export function listSessionUserTags(): SessionUserTagSummary[] {
    return sessionUserTagSummaries(getAllSessionMetadata());
}

/**
 * Apply one idempotent assignment intent against a fresh sessions.json
 * snapshot. The Renderer never submits a replacement userTags array.
 */
export async function mutateSessionUserTag(
    sessionId: string,
    mutation: SessionUserTagMutation,
): Promise<SessionUserTagMutationResult> {
    const requested = normalizeSessionUserTag(mutation.name);
    if (!requested.ok) {
        return { ok: false, reason: 'invalid-name', error: `Invalid Tag name (${requested.reason}).` };
    }

    ensureStorageDir();
    try {
        return await withSessionsLock(async () => {
            const all = readSessionsIndexForWrite();
            const index = all.findIndex((session) => session.id === sessionId);
            if (index < 0) {
                return { ok: false, reason: 'session-not-found', error: 'Session not found.' };
            }
            const current = all[index];
            if (isSystemMaintenanceSession(current)) {
                return { ok: false, reason: 'protected-session', error: 'System maintenance session is not user-editable.' };
            }

            const currentTags = sanitizeSessionUserTags(current.userTags);
            const currentIdentities = new Set(currentTags.map((name) => name.toLowerCase()));
            let nextTags: string[];

            if (mutation.kind === 'add') {
                if (currentIdentities.has(requested.tag.identity)) {
                    nextTags = currentTags;
                } else {
                    if (currentTags.length >= MAX_SESSION_USER_TAGS) {
                        return { ok: false, reason: 'limit-reached', error: `A Session can have at most ${MAX_SESSION_USER_TAGS} Tags.` };
                    }
                    const canonical = sessionUserTagSummaries(all)
                        .find((summary) => normalizeSessionUserTag(summary.name).ok
                            && summary.name.toLowerCase() === requested.tag.identity)
                        ?.name ?? requested.tag.name;
                    nextTags = [...currentTags, canonical];
                }
            } else {
                nextTags = currentTags.filter((name) => name.toLowerCase() !== requested.tag.identity);
            }

            const changed = !storedUserTagsEqual(current.userTags, nextTags);
            const updated = replaceSessionUserTags(current, nextTags);
            if (changed) {
                all[index] = updated;
                atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            }
            return {
                ok: true,
                session: updated,
                tags: sessionUserTagSummaries(all),
                affectedSessionCount: changed ? 1 : 0,
                action: changed ? 'updated' : 'noop',
            };
        });
    } catch (error) {
        return {
            ok: false,
            reason: 'io-error',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Rename/merge/delete one global name in a single sessions.json commit. */
export async function mutateGlobalSessionUserTag(
    mutation: GlobalSessionUserTagMutation,
    focusSessionId?: string,
): Promise<SessionUserTagMutationResult> {
    const source = normalizeSessionUserTag(mutation.name);
    if (!source.ok) {
        return { ok: false, reason: 'invalid-name', error: `Invalid Tag name (${source.reason}).` };
    }
    const requestedTarget = mutation.kind === 'rename'
        ? normalizeSessionUserTag(mutation.newName)
        : null;
    if (requestedTarget && !requestedTarget.ok) {
        return { ok: false, reason: 'invalid-name', error: `Invalid Tag name (${requestedTarget.reason}).` };
    }

    ensureStorageDir();
    try {
        return await withSessionsLock(async () => {
            const all = readSessionsIndexForWrite();
            const summaries = sessionUserTagSummaries(all);
            const canonicalSource = summaries.find((summary) => summary.name.toLowerCase() === source.tag.identity);
            if (!canonicalSource) {
                return { ok: false, reason: 'tag-not-found', error: 'Tag no longer exists.' };
            }

            if (mutation.kind === 'rename'
                && requestedTarget?.ok
                && requestedTarget.tag.name === canonicalSource.name) {
                const focusSession = focusSessionId
                    ? all.find((session) => session.id === focusSessionId)
                    : undefined;
                return {
                    ok: true,
                    ...(focusSession ? { session: focusSession } : {}),
                    tags: summaries,
                    affectedSessionCount: 0,
                    action: 'noop',
                };
            }

            let replacementName: string | null = null;
            if (mutation.kind === 'rename' && requestedTarget?.ok) {
                const existingTarget = summaries.find((summary) => (
                    summary.name.toLowerCase() === requestedTarget.tag.identity
                    && summary.name.toLowerCase() !== source.tag.identity
                ));
                if (existingTarget && !mutation.merge) {
                    return {
                        ok: false,
                        reason: 'merge-required',
                        targetName: existingTarget.name,
                        error: 'The target Tag already exists and requires merge confirmation.',
                    };
                }
                if (!existingTarget
                    && mutation.merge
                    && requestedTarget.tag.identity !== source.tag.identity) {
                    return {
                        ok: false,
                        reason: 'conflict',
                        error: 'The merge target changed before the operation committed.',
                    };
                }
                replacementName = existingTarget?.name ?? requestedTarget.tag.name;
            }

            let affectedSessionCount = 0;
            const nextAll = all.map((session) => {
                if (isSystemMaintenanceSession(session)) return session;
                const tags = sanitizeSessionUserTags(session.userTags);
                if (!tags.some((name) => name.toLowerCase() === source.tag.identity)) return session;

                const nextTags: string[] = [];
                const seen = new Set<string>();
                for (const name of tags) {
                    const identity = name.toLowerCase();
                    const nextName = identity === source.tag.identity ? replacementName : name;
                    if (!nextName) continue;
                    const nextIdentity = nextName.toLowerCase();
                    if (seen.has(nextIdentity)) continue;
                    seen.add(nextIdentity);
                    nextTags.push(nextName);
                }
                if (storedUserTagsEqual(session.userTags, nextTags)) return session;
                affectedSessionCount += 1;
                return replaceSessionUserTags(session, nextTags);
            });

            if (affectedSessionCount === 0) {
                return { ok: false, reason: 'conflict', error: 'Tag assignments changed before the operation committed.' };
            }
            atomicWriteSessionsFile(JSON.stringify(nextAll, null, 2));
            const focusSession = focusSessionId
                ? nextAll.find((session) => session.id === focusSessionId)
                : undefined;
            return {
                ok: true,
                ...(focusSession ? { session: focusSession } : {}),
                tags: sessionUserTagSummaries(nextAll),
                affectedSessionCount,
                action: 'updated',
            };
        });
    } catch (error) {
        return {
            ok: false,
            reason: 'io-error',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Get sessions for a specific agent directory
 */
export function getSessionsByAgentDir(agentDir: string): SessionMetadata[] {
    const all = getAllSessionMetadata();
    return all
        // #320 family: session agentDir and the caller's path come from
        // different stores (sessions.json vs projects.json/config) — on
        // Windows they disagree on separators/drive case, so raw === drops
        // every session. Compare on the canonical identity.
        .filter(s => workspacePathsEqual(s.agentDir, agentDir))
        .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
}

/**
 * Get session metadata by ID
 */
export function getSessionMetadata(sessionId: string): SessionMetadata | null {
    const active = activeTranscripts.get(sessionId);
    if (active) return active.isRevoked ? null : active.metadata;
    const all = getAllSessionMetadata();
    return all.find(s => s.id === sessionId) ?? null;
}

export function getPersistedSessionOrigin(sessionId: string): SessionOrigin | undefined {
    return normalizeSessionOrigin(getSessionMetadata(sessionId)?.origin);
}

export type EnsureRegisteredAgentSessionOriginResult =
    | { success: true; metadataExists: boolean; adoptedLegacyOrigin?: boolean }
    | { success: false; error: string };

/**
 * Bind a delivery Session to one exact Registered Agent identity.
 *
 * Existing context-free registered-agent origins are upgraded in place for
 * compatibility. Any other existing origin is an authority conflict and is
 * rejected. Missing metadata is safe: the caller must pass the same exact
 * origin as the birth origin when it materializes the Session.
 */
function checkRegisteredAgentSessionOrigin(current: SessionMetadata | undefined, expected: RegisteredAgentSessionOrigin): EnsureRegisteredAgentSessionOriginResult {
    if (!current) return { success: true, metadataExists: false };
    const normalized = normalizeSessionOrigin(current.origin);
    if (normalized?.kind === 'registered-agent' && normalized.surface === 'space_issue_delivery'
        && normalized.context.spaceId === expected.context.spaceId
        && normalized.context.registeredAgentId === expected.context.registeredAgentId) {
        return { success: true, metadataExists: true };
    }
    const raw = current.origin as { kind?: unknown; surface?: unknown; context?: unknown } | undefined;
    if (raw?.kind === 'registered-agent' && raw.surface === 'space_issue_delivery'
        && !Object.prototype.hasOwnProperty.call(raw, 'context')) {
        return { success: true, metadataExists: true, adoptedLegacyOrigin: true };
    }
    return { success: false, error: 'SESSION_ORIGIN_CONFLICT: This Session is already bound to a different origin.' };
}

export async function ensureRegisteredAgentSessionOrigin(
    sessionId: string,
    expected: RegisteredAgentSessionOrigin,
): Promise<EnsureRegisteredAgentSessionOriginResult> {
    const active = activeTranscripts.get(sessionId);
    if (active && !active.isRevoked) {
        // The legitimate birth/claim already exists even if its index write is
        // pending. An absent disk row cannot relax this exact origin check.
        const result = checkRegisteredAgentSessionOrigin(active.metadata, expected);
        if (result.success && result.adoptedLegacyOrigin) active.patchMetadata({ origin: expected });
        return result;
    }
    ensureStorageDir();
    return withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const index = all.findIndex(session => session.id === sessionId);
        const result = checkRegisteredAgentSessionOrigin(all[index], expected);
        if (result.success && result.adoptedLegacyOrigin) {
            all[index] = { ...all[index], origin: expected };
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
        }
        return result;
    });
}

/**
 * Save session metadata (create or update)
 */
export async function saveSessionMetadata(session: SessionMetadata): Promise<void> {
    normalizeMcpSelectionField(session);
    if (session.transcriptFormat === 2) {
        let active = activeTranscripts.get(session.id);
        if (!active) {
            // The creation owner already issued this identity. Disk validation
            // belongs to asynchronous publication, never first AI admission.
            if (ownsSessionMetadataBirth(session)) {
                createActiveTranscript(session, true);
                return;
            }
            const existing = getSessionMetadata(session.id);
            if (existing?.transcriptFormat !== 2) {
                throw new TranscriptStorageError('invalid-history', 'V2 creation requires a new Session birth');
            }
            active = await activateSessionTranscript(session.id);
        }
        if (!active) throw new TranscriptStorageError('invalid-history', 'Missing V2 Session binding');
        // Whole-row compatibility callers may hold a pre-admission snapshot.
        // Creation identity and prepared admission belong to their explicit CAS
        // entrypoints, never to a subsequent snapshot save.
        const current = active.metadata;
        if (changesPendingDshAuthority(current, session)) {
            throw new Error('Pending DSH execution prevents changing Runtime Session authority');
        }
        const {
            pendingDshRootOperation: _root, pendingDshRootInputs: _roots, pendingDshInputs: _inputs,
            pendingDshMutation: _mutation, dshProjectionCursor: _cursor,
            id: _id, transcriptFormat: _format, createdAt: _createdAt, agentDir: _agentDir,
            materializationState: _prepared, materializationSourceSessionId: _source,
            ...patch
        } = session;
        active.patchMetadata(patch);
        return;
    }
    ensureStorageDir();

    await withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();

        const index = all.findIndex(s => s.id === session.id);

        if (index >= 0 && all[index].transcriptFormat !== session.transcriptFormat) {
            throw new TranscriptStorageError('invalid-history', 'Session transcript format is immutable');
        }

        if (index >= 0) {
            const current = all[index]!;
            if (current.pendingDshInputs?.length && (session.runtimeSessionId !== current.runtimeSessionId
                || JSON.stringify(session.runtimeBinding) !== JSON.stringify(current.runtimeBinding))) {
                throw new Error('Pending DSH input intents prevent changing Runtime Session authority');
            }
            // Full metadata callers do not own input settlement. A stale
            // snapshot must neither erase a pending intent nor resurrect one.
            all[index] = { ...session, pendingDshInputs: current.pendingDshInputs };
        } else {
            all.push(session);
        }

        try {
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
        } catch (error) {
            console.error('[SessionStore] Failed to write sessions.json:', error);
            throw error;
        }
    });
}

export async function migrateSessionRuntimeBindings(): Promise<{
    migratedSessions: number;
    incompatibleSessions: number;
}> {
    ensureStorageDir();
    let migratedSessions = 0;
    let incompatibleSessions = 0;
    await withSessionsLock(async () => {
        let raw: unknown = [];
        if (existsSync(SESSIONS_FILE)) {
            try {
                raw = JSON.parse(stripBom(readFileSync(SESSIONS_FILE, 'utf-8'))) as unknown;
            } catch {
                // readSessionsIndexForWrite owns corrupt-index recovery below.
            }
        }
        const rawRows = Array.isArray(raw) ? raw : [];
        const sessions = readSessionsIndexForWrite();
        for (let index = 0; index < sessions.length; index += 1) {
            const before = rawRows[index] as { runtimeBinding?: unknown; runtimeBindingCompatibility?: unknown } | undefined;
            const after = sessions[index];
            if (after.runtimeBindingCompatibility) incompatibleSessions += 1;
            if (
                before?.runtimeBinding === undefined
                && before?.runtimeBindingCompatibility === undefined
                && (after.runtimeBinding !== undefined || after.runtimeBindingCompatibility !== undefined)
            ) {
                migratedSessions += 1;
            }
        }
        if (JSON.stringify(rawRows) !== JSON.stringify(sessions)) {
            atomicWriteSessionsFile(JSON.stringify(sessions, null, 2));
        }
    });
    return { migratedSessions, incompatibleSessions };
}

export type SessionDeleteIntent =
    | { kind: 'user-delete' }
    | { kind: 'prepared-materialization-rollback'; sourceSessionId: string };

export type SessionDeleteResult =
    | { deleted: true }
    | {
        deleted: false;
        reason: 'not-found' | 'protected-session' | 'precondition-failed' | 'data-present' | 'io-error';
    };

function rejectSessionDeletion(
    sessionId: string,
    intent: SessionDeleteIntent,
    reason: Exclude<SessionDeleteResult, { deleted: true }>['reason'],
    detail: string,
): SessionDeleteResult {
    console.warn(`[SessionStore] Refused session deletion id=${sessionId} intent=${intent.kind} reason=${reason}: ${detail}`);
    return { deleted: false, reason };
}

/**
 * Delete session metadata and data for one of the explicitly supported
 * lifecycle transitions. The intent is validated while both the per-session
 * data lock and sessions-index lock are held, immediately before deletion.
 *
 * User deletion is additionally fenced by the Rust Sidecar lifecycle owner;
 * prepared rollback can only remove transaction-owned metadata that has not
 * admitted transcript data.
 */
export async function deleteSession(
    sessionId: string,
    intent: SessionDeleteIntent,
): Promise<SessionDeleteResult> {
    return deleteSessionOwned(sessionId, intent);
}

async function deleteSessionOwned(
    sessionId: string,
    intent: SessionDeleteIntent,
): Promise<SessionDeleteResult> {
    const active = activeTranscripts.get(sessionId);
    const metadata = active?.metadata ?? getSessionMetadata(sessionId);
    if (metadata?.transcriptFormat !== undefined) {
        if (intent.kind === 'prepared-materialization-rollback' && (
            metadata.materializationState !== 'prepared'
            || metadata.materializationSourceSessionId !== intent.sourceSessionId
            || (active && active.writer.projection.messages.size > 0)
        )) return { deleted: false, reason: 'precondition-failed' };
        if (intent.kind === 'user-delete' && isSystemMaintenanceSession(metadata)) return { deleted: false, reason: 'protected-session' };
        // Rollback and admission decide synchronously on this same instance.
        // Revocation survives a cleanup timeout; no producer can resurrect it.
        const outstanding = active?.revoke() ?? Promise.resolve();
        const deletion = outstanding.then(() => withSessionFileLock(sessionId, () => withSessionsLock(async (): Promise<SessionDeleteResult> => {
            let all: SessionMetadata[];
            try { all = parseSessionsIndex(await asyncFs.readFile(SESSIONS_FILE, 'utf8')); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                all = [];
            }
            const disk = all.find(row => row.id === sessionId);
            if (disk && (disk.transcriptFormat !== 2 || disk.createdAt !== metadata.createdAt)) return { deleted: false, reason: 'precondition-failed' };
            if (intent.kind === 'prepared-materialization-rollback' && disk && (
                disk.materializationState !== 'prepared' || disk.materializationSourceSessionId !== intent.sourceSessionId
            )) return { deleted: false, reason: 'precondition-failed' };
            try {
                await asyncFs.unlink(getV2SessionFilePath(sessionId));
                await syncTranscriptDirectory(SESSIONS_V2_DIR);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            if (disk) {
                const file = await asyncFs.open(SESSIONS_TMP_FILE, 'w');
                try { await file.writeFile(JSON.stringify(all.filter(row => row.id !== sessionId), null, 2)); await file.sync(); }
                finally { await file.close(); }
                await asyncFs.rename(SESSIONS_TMP_FILE, SESSIONS_FILE);
                await syncTranscriptDirectory(MYAGENTS_DIR);
            }
            // Retain the revoked in-process identity until this Sidecar exits.
            return { deleted: true };
        }))).catch((error): SessionDeleteResult => {
            console.warn(`[SessionStore] V2 delete failed for ${sessionId}:`, error);
            return { deleted: false, reason: 'io-error' };
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
            deletion,
            new Promise<SessionDeleteResult>(resolve => { timer = setTimeout(() => resolve({ deleted: false, reason: 'io-error' }), 2000); }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
    }
    ensureStorageDir();

    // Lock order matches transcript append/mutation: per-session file lock OUTER,
    // sessions lock INNER. Taking the file lock here serializes the delete
    // against an in-flight append from another writer of the same session
    // (cross-tab cron, background completion) — previously the unlink could
    // interleave with an append and leave either a half-deleted file or a
    // just-recreated one.
    try {
        return await withSessionFileLock(sessionId, async () => withSessionsLock(async () => {
            const all = readSessionsIndexForWrite();
            const index = all.findIndex(s => s.id === sessionId);

            if (index < 0) {
                return { deleted: false, reason: 'not-found' };
            }
            const current = all[index];
            const jsonlFile = getSessionFilePath(sessionId);
            const legacyFile = getLegacySessionFilePath(sessionId);
            const hasJsonl = existsSync(jsonlFile);
            const hasLegacyData = existsSync(legacyFile);

            switch (intent.kind) {
                case 'user-delete':
                    if (isSystemMaintenanceSession(current)) {
                        return rejectSessionDeletion(
                            sessionId,
                            intent,
                            'protected-session',
                            'system maintenance sessions are not user-editable',
                        );
                    }
                    break;
                case 'prepared-materialization-rollback':
                    if (
                        current.materializationState !== 'prepared'
                        || current.materializationSourceSessionId !== intent.sourceSessionId
                    ) {
                        return rejectSessionDeletion(
                            sessionId,
                            intent,
                            'precondition-failed',
                            'the prepared row is not owned by this materialization transaction',
                        );
                    }
                    if (hasJsonl || hasLegacyData) {
                        return rejectSessionDeletion(
                            sessionId,
                            intent,
                            'data-present',
                            'prepared rollback cannot remove a session after transcript data exists',
                        );
                    }
                    break;
            }

            const filtered = all.filter(s => s.id !== sessionId);

            // Remove the data files FIRST, then the index entry. If we crash
            // between the two steps, the failure mode is "entry present, file
            // gone" — a visible empty session the user can still see and delete
            // again. The previous order (entry first) left "entry gone, file
            // present": an invisible orphan that no UI can reach (issue #336).
            console.log(
                `[SessionStore] Deleting session id=${sessionId} intent=${intent.kind} metadataState=${current.materializationState ?? 'committed'} jsonl=${hasJsonl} legacy=${hasLegacyData}`,
            );

            if (hasJsonl) {
                unlinkSync(jsonlFile);
            }
            if (hasLegacyData) {
                unlinkSync(legacyFile);
            }

            atomicWriteSessionsFile(JSON.stringify(filtered, null, 2));

            return { deleted: true };
        }));
    } catch (error) {
        console.error(`[SessionStore] Failed to delete session id=${sessionId} intent=${intent.kind}:`, error);
        return { deleted: false, reason: 'io-error' };
    }
}

export type PendingSessionIdentityMigrationResult =
    | { migrated: true; metadata: SessionMetadata; transcript: SessionTranscriptSnapshot }
    | {
        migrated: false;
        reason: 'source-not-found' | 'source-not-pending' | 'target-exists' | 'data-conflict' | 'authority-revoked' | 'io-error';
    };

function pathsReferToSameFile(firstPath: string, secondPath: string): boolean {
    try {
        const first = statSync(firstPath);
        const second = statSync(secondPath);
        return first.ino !== 0 && first.dev === second.dev && first.ino === second.ino;
    } catch {
        return false;
    }
}

function loadSessionTranscriptLocked(sessionId: string): SessionTranscriptSnapshot {
    const filePath = getSessionFilePath(sessionId);
    if (!existsSync(filePath) && existsSync(getLegacySessionFilePath(sessionId))) {
        migrateToJsonl(sessionId);
    }
    const snapshot = readJsonlSnapshot(filePath);
    return {
        messages: snapshot.messages,
        cursor: issueTranscriptCursor(
            sessionId,
            snapshot.messages.length,
            getTranscriptFileIdentity(filePath),
        ),
        hasMalformedRows: snapshot.hasMalformedRows,
    };
}

/**
 * Atomically hand a pending Session identity to the concrete SDK UUID without
 * discarding a transcript that may already have been persisted under the
 * pending ID. Source data remains authoritative until the target hard-link
 * staging and the single sessions.json identity replacement have both
 * succeeded.
 */
export async function migratePendingSessionIdentity(
    sourceSessionId: string,
    targetSessionId: string,
    patch: Pick<SessionMetadata, 'sdkSessionId' | 'unifiedSession'>,
    commitPrecondition?: () => boolean,
): Promise<PendingSessionIdentityMigrationResult> {
    ensureStorageDir();
    if (!isPendingSessionId(sourceSessionId) || sourceSessionId === targetSessionId) {
        return { migrated: false, reason: 'source-not-pending' };
    }

    try {
        return await withSessionFileLocks(
            [sourceSessionId, targetSessionId],
            async () => withSessionsLock(async () => {
                if (commitPrecondition && !commitPrecondition()) {
                    return { migrated: false, reason: 'authority-revoked' };
                }
                const all = readSessionsIndexForWrite();
                const sourceIndex = all.findIndex(session => session.id === sourceSessionId);
                if (sourceIndex < 0) {
                    // Crash recovery: metadata publication is atomic, but the
                    // process can die before the obsolete source hard-link is
                    // removed. The target row carries the source identity as
                    // provenance until cleanup finishes, so a retry can prove
                    // ownership without accepting an unrelated target row.
                    const targetIndex = all.findIndex(session => session.id === targetSessionId);
                    const targetMetadata = targetIndex >= 0 ? all[targetIndex] : undefined;
                    if (targetMetadata?.materializationSourceSessionId === sourceSessionId) {
                        const sourceJsonl = getSessionFilePath(sourceSessionId);
                        const targetJsonl = getSessionFilePath(targetSessionId);
                        const sourceLegacy = getLegacySessionFilePath(sourceSessionId);
                        const targetLegacy = getLegacySessionFilePath(targetSessionId);
                        const sourceJsonlExists = existsSync(sourceJsonl);
                        const targetJsonlExists = existsSync(targetJsonl);
                        const sourceLegacyExists = existsSync(sourceLegacy);
                        const targetLegacyExists = existsSync(targetLegacy);

                        if (
                            (sourceJsonlExists && targetJsonlExists && !pathsReferToSameFile(sourceJsonl, targetJsonl))
                            || (sourceLegacyExists && targetLegacyExists && !pathsReferToSameFile(sourceLegacy, targetLegacy))
                        ) {
                            return { migrated: false, reason: 'data-conflict' };
                        }
                        if (sourceJsonlExists && !targetJsonlExists) linkSync(sourceJsonl, targetJsonl);
                        if (sourceLegacyExists && !targetLegacyExists) linkSync(sourceLegacy, targetLegacy);
                        if (sourceJsonlExists) unlinkSync(sourceJsonl);
                        if (sourceLegacyExists) unlinkSync(sourceLegacy);

                        // Prepared-session ownership uses this field until the
                        // first turn commits. For an already-visible session it
                        // was only the crash-recovery marker and can now retire.
                        let recoveredMetadata = targetMetadata;
                        if (targetMetadata.materializationState !== 'prepared') {
                            recoveredMetadata = {
                                ...targetMetadata,
                                materializationSourceSessionId: undefined,
                            };
                            all[targetIndex] = recoveredMetadata;
                            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                        }

                        return {
                            migrated: true,
                            metadata: recoveredMetadata,
                            transcript: loadSessionTranscriptLocked(targetSessionId),
                        };
                    }
                    return { migrated: false, reason: 'source-not-found' };
                }
                if (all.some(session => session.id === targetSessionId)) {
                    return { migrated: false, reason: 'target-exists' };
                }

                const sourceJsonl = getSessionFilePath(sourceSessionId);
                const targetJsonl = getSessionFilePath(targetSessionId);
                const sourceLegacy = getLegacySessionFilePath(sourceSessionId);
                const targetLegacy = getLegacySessionFilePath(targetSessionId);
                const hasSourceJsonl = existsSync(sourceJsonl);
                const hasSourceLegacy = existsSync(sourceLegacy);

                const hasTargetJsonl = existsSync(targetJsonl);
                const hasTargetLegacy = existsSync(targetLegacy);
                const jsonlStagedByThisSource = hasSourceJsonl
                    && hasTargetJsonl
                    && pathsReferToSameFile(sourceJsonl, targetJsonl);
                const legacyStagedByThisSource = hasSourceLegacy
                    && hasTargetLegacy
                    && pathsReferToSameFile(sourceLegacy, targetLegacy);

                if (
                    (hasTargetJsonl && !jsonlStagedByThisSource)
                    || (hasTargetLegacy && !legacyStagedByThisSource)
                ) {
                    console.warn(`[SessionStore] Refused pending identity migration source=${sourceSessionId} target=${targetSessionId}: target data exists without an indexed target`);
                    return { migrated: false, reason: 'data-conflict' };
                }

                // Stage the target as a hard link before publishing metadata.
                // Source remains authoritative until the index commit; a crash
                // leaves a same-inode target that a retry can identify without
                // overwriting unrelated orphan data.
                if (hasSourceJsonl && !hasTargetJsonl) {
                    linkSync(sourceJsonl, targetJsonl);
                }
                if (hasSourceLegacy && !hasTargetLegacy) {
                    linkSync(sourceLegacy, targetLegacy);
                }

                const sourceMetadata = all[sourceIndex];
                const metadata: SessionMetadata = {
                    ...sourceMetadata,
                    ...patch,
                    id: targetSessionId,
                    // Keep provenance durable until source-name cleanup has
                    // completed. Prepared sessions already use the same marker
                    // for their admission transaction, so no new state field is
                    // needed.
                    materializationSourceSessionId:
                        sourceMetadata.materializationSourceSessionId ?? sourceSessionId,
                };
                all[sourceIndex] = metadata;
                atomicWriteSessionsFile(JSON.stringify(all, null, 2));

                // Metadata now points at the same inode. Remove the obsolete
                // source name before releasing either file lock. If cleanup
                // fails, roll the metadata identity back while both names still
                // reference identical bytes; never publish a split-writable
                // source/target pair.
                try {
                    if (hasSourceJsonl) unlinkSync(sourceJsonl);
                    if (hasSourceLegacy) unlinkSync(sourceLegacy);
                } catch (error) {
                    try {
                        // One source name may already have been removed before
                        // another unlink failed. Recreate every missing source
                        // name from its same-inode target before restoring the
                        // original metadata row.
                        if (hasSourceJsonl && !existsSync(sourceJsonl) && existsSync(targetJsonl)) {
                            linkSync(targetJsonl, sourceJsonl);
                        }
                        if (hasSourceLegacy && !existsSync(sourceLegacy) && existsSync(targetLegacy)) {
                            linkSync(targetLegacy, sourceLegacy);
                        }
                        all[sourceIndex] = sourceMetadata;
                        atomicWriteSessionsFile(JSON.stringify(all, null, 2));

                        if (existsSync(targetJsonl)) unlinkSync(targetJsonl);
                        if (existsSync(targetLegacy)) unlinkSync(targetLegacy);
                    } catch (rollbackError) {
                        console.error(`[SessionStore] Pending identity migration rollback could not fully restore source=${sourceSessionId} target=${targetSessionId}:`, rollbackError);
                    }
                    console.error(`[SessionStore] Pending identity migration source cleanup failed source=${sourceSessionId} target=${targetSessionId}:`, error);
                    return { migrated: false, reason: 'io-error' };
                }

                let completedMetadata = metadata;
                if (metadata.materializationState !== 'prepared') {
                    completedMetadata = {
                        ...metadata,
                        materializationSourceSessionId: undefined,
                    };
                    all[sourceIndex] = completedMetadata;
                    atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                }

                console.log(`[SessionStore] Migrated pending session identity source=${sourceSessionId} target=${targetSessionId} jsonl=${hasSourceJsonl} legacy=${hasSourceLegacy}`);
                return {
                    migrated: true,
                    metadata: completedMetadata,
                    transcript: loadSessionTranscriptLocked(targetSessionId),
                };
            }),
        );
    } catch (error) {
        console.error(`[SessionStore] Failed pending identity migration source=${sourceSessionId} target=${targetSessionId}:`, error);
        return { migrated: false, reason: 'io-error' };
    }
}

/**
 * Get full session data including messages
 */
export async function getSessionData(sessionId: string): Promise<SessionData | null> {
    const metadata = getSessionMetadata(sessionId);
    if (!metadata) {
        return null;
    }

    return getSessionDataFromMetadata(metadata);
}

/**
 * Get full session data when the caller already owns the authoritative
 * metadata row. Bulk readers must use this path instead of looking the same
 * row up in sessions.json again for every session.
 */
export async function getSessionDataFromMetadata(metadata: SessionMetadata): Promise<SessionData> {
    const sessionId = metadata.id;

    const active = activeTranscripts.get(sessionId);
    if (active) return {
        ...active.metadata, messages: transcriptMessages(active.writer.projection),
        transcriptTurns: [...active.writer.projection.turns.values()],
        transcriptSaveStatus: active.writer.status,
        ...(active.writer.status.reason === 'invalid-history' ? { transcriptRecovery: 'unavailable' as const } : {}),
    };
    let format: Awaited<ReturnType<typeof sessionTranscriptFormat>>;
    try {
        format = await sessionTranscriptFormat(metadata, sessionId);
    } catch (error) {
        // Format/file conflicts concern product history, not an already valid
        // native binding. Expose an unavailable history without falling back
        // to a legacy file or making the REST shell disable conversation.
        console.warn(`[SessionStore] History format unavailable for ${sessionId}:`, error);
        return { ...metadata, messages: [], transcriptRecovery: 'unavailable' };
    }
    if (format === 'v2') {
        try {
            const decoded = await readTranscriptFile(getV2SessionFilePath(sessionId), sessionId);
            // A file reader cannot infer whether another Sidecar still owns execution.
            const messages = transcriptMessages(decoded.projection);
            return { ...metadata, messages, transcriptTurns: [...decoded.projection.turns.values()],
                ...(decoded.tail === 'invalid' ? { transcriptRecovery: 'incomplete' as const } : {}),
            };
        } catch (error) {
            console.warn(`[SessionStore] V2 history unavailable for ${sessionId}:`, error);
            return { ...metadata, messages: [], transcriptRecovery: 'unavailable' };
        }
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
 * Load the durable transcript and issue the only capability accepted by later
 * append/mutation calls. Legacy JSON is migrated lazily under the same
 * per-Session writer lock used by every transcript mutation.
 */
export async function loadSessionTranscript(sessionId: string): Promise<SessionTranscriptSnapshot> {
    const active = activeTranscripts.get(sessionId);
    if (active) return snapshotActiveTranscript(active);
    const metadata = getSessionMetadata(sessionId);
    if (metadata?.transcriptFormat === 2) {
        return withSessionFileLock(sessionId, async () => {
            await sessionTranscriptFormat(metadata, sessionId);
            const decoded = await readTranscriptFile(getV2SessionFilePath(sessionId), sessionId);
            const messages = transcriptMessages(decoded.projection);
            return { messages, cursor: issueV2Cursor(sessionId, messages.length, decoded.header.generation, decoded.revision), hasMalformedRows: decoded.tail === 'invalid' };
        });
    }
    if (await pathExists(getV2SessionFilePath(sessionId)) || metadata?.transcriptFormat !== undefined) {
        throw new TranscriptStorageError('invalid-history', 'Conflicting or unsupported transcript format');
    }
    // An unmaterialized identity has nothing to read or migrate. Cold lookup
    // must not require a writable product directory before AI admission.
    // The returned absent-file cursor still fences a later legacy append.
    if (!existsSync(getSessionFilePath(sessionId)) && !existsSync(getLegacySessionFilePath(sessionId))) {
        return loadSessionTranscriptLocked(sessionId);
    }
    return withSessionFileLock(sessionId, async () => loadSessionTranscriptLocked(sessionId));
}

function issueV2Cursor(sessionId: string, count: number, generation: string, revision: number, live?: TranscriptSaveStatus): TranscriptWriteCursor {
    return Object.freeze({
        persistedMessageCount: count,
        [transcriptCursorState]: Object.freeze({
            sessionId,
            file: { exists: true, dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0, endsWithNewline: true },
            v2: Object.freeze({ generation, revision, ...(live ? { instanceId: live.instanceId, liveRevision: live.liveRevision } : {}) }),
        }),
    });
}

function snapshotActiveTranscript(active: SessionTranscript): SessionTranscriptSnapshot {
    const messages = transcriptMessages(active.writer.projection);
    const status = active.writer.status;
    return {
        messages, cursor: issueV2Cursor(status.sessionId, messages.length, status.generation, status.durableRevision, status),
        hasMalformedRows: status.reason === 'invalid-history',
    };
}

export type ConversationMutationResult =
    | { success: true; metadata: SessionMetadata; messages: SessionMessage[]; cursor: TranscriptWriteCursor }
    | {
        success: false;
        reason: 'precondition_failed' | 'storage_consistency_error' | 'write_error';
        error: string;
    };

export type DshMutationStoreResult<T> =
    | { success: true; value: T }
    | {
        success: false;
        reason: 'precondition_failed' | 'storage_consistency_error' | 'write_error';
        error: string;
    };

type PendingDshFork = Extract<PendingDshMutation, { kind: 'dsh-fork' }>;
type PendingDshRewind = Extract<PendingDshMutation, { kind: 'dsh-rewind' }>;
type PendingDshDelete = Extract<PendingDshMutation, { kind: 'dsh-delete' }>;

function dshMutationFailure(
    reason: Exclude<DshMutationStoreResult<never>, { success: true }>['reason'],
    error: string,
): DshMutationStoreResult<never> {
    return { success: false, reason, error };
}

function exactPendingDshMutation(
    metadata: SessionMetadata,
    clientMutationId: string,
): PendingDshMutation | undefined {
    const pending = metadata.pendingDshMutation;
    return pending?.schemaVersion === 1 && pending.clientMutationId === clientMutationId
        ? pending
        : undefined;
}

function sessionUsesDsh(metadata: SessionMetadata): boolean {
    return metadata.runtimeBinding !== undefined
        && runtimeTypeForBinding(metadata.runtimeBinding) === 'dsh';
}

function changesPendingDshAuthority(current: SessionMetadata, patch: Partial<SessionMetadata>): boolean {
    if (!current.pendingDshRootOperation && !current.pendingDshMutation && !current.pendingDshInputs?.length) return false;
    const updated = { ...current, ...patch };
    return updated.runtimeSessionId !== current.runtimeSessionId
        || JSON.stringify(updated.runtimeBinding) !== JSON.stringify(current.runtimeBinding);
}

function validDshOperationIdentifier(value: string): boolean {
    return value.length > 0
        && value.length <= 256
        && !Array.from(value).some(character => {
            const code = character.charCodeAt(0);
            return code < 0x20 || code === 0x7f;
        });
}

// DSH execution journals share SessionStore's lifecycle, while V2 content keeps
// the ordinary writer's non-blocking IO. These fields are execution-owned; an
// active overlay must never replace another owner's config or product edits.
const DSH_EXECUTION_METADATA_KEYS = [
    'runtimeBinding', 'runtime', 'runtimeSource', 'runtimeSessionId',
    'pendingDshMutation', 'pendingDshRootOperation', 'pendingDshRootInputs', 'pendingDshInputs',
    'dshProjectionCursor', 'runtimeUsageTotals', 'lastContextUsage',
] as const satisfies readonly (keyof SessionMetadata)[];

function readDshSessionsIndexForWrite(sessionId: string): SessionMetadata[] {
    const rows = readSessionsIndexForWrite();
    const active = getActiveSessionTranscript(sessionId);
    if (!active) return rows;
    const metadata = active.metadata;
    const index = rows.findIndex(row => row.id === sessionId);
    if (index < 0) rows.push(metadata);
    else {
        const execution = Object.fromEntries(DSH_EXECUTION_METADATA_KEYS.map(key => [key, metadata[key]]));
        rows[index] = { ...rows[index], ...execution };
    }
    return rows;
}

/** Caller holds the existing index lock. Retirement is saved after the V2
 * content it describes, so a crash cannot forget the only recoverable input. */
function writeDshSessionsIndex(rows: SessionMetadata[], sessionId: string, afterContent = false): void {
    const active = getActiveSessionTranscript(sessionId);
    const row = rows.find(item => item.id === sessionId);
    if (active && row && afterContent) {
        active.patchMetadata(Object.fromEntries(DSH_EXECUTION_METADATA_KEYS.map(key => [key, row[key]])));
        return;
    }
    const prior = readSessionsIndexForWrite().find(item => item.id === sessionId);
    const output = rows.map(item => {
        if (!active || item.id !== sessionId) return item;
        // An immediate execution write must not prematurely retire inputs
        // whose body is still queued. The live overlay may already be settled.
        const roots = new Map((prior?.pendingDshRootInputs ?? []).map(root => [root.clientOperationId, root]));
        for (const root of item.pendingDshRootInputs ?? []) roots.set(root.clientOperationId, root);
        const inputs = new Map((prior?.pendingDshInputs ?? []).map(input => [input.clientUserMessageId, input]));
        for (const input of item.pendingDshInputs ?? []) inputs.set(input.clientUserMessageId, input);
        return { ...item, pendingDshRootInputs: roots.size ? [...roots.values()] : undefined,
            pendingDshInputs: inputs.size ? [...inputs.values()] : undefined,
            // New admission may follow a native rewind while its Product
            // replacement is still saving. Preserve that durable generation proof.
            pendingDshMutation: item.pendingDshMutation ?? (prior?.pendingDshMutation?.kind === 'dsh-rewind' ? prior.pendingDshMutation : undefined),
        };
    });
    atomicWriteSessionsFile(JSON.stringify(output, null, 2));
    if (active && row) active.adoptExecutionMetadata(row, DSH_EXECUTION_METADATA_KEYS);
}

/** Live V2 content belongs to the active writer; execution must not wait for its
 * physical body IO. Legacy/cold operations still serialize their file access. */
function withDshProjection<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    return getActiveSessionTranscript(sessionId) ? run() : withSessionFileLock(sessionId, run);
}

/** Cold callers own the file lock and never create a writer in a foreign Sidecar. */
async function readDshMessagesForMutation(sessionId: string, options: { allowIncompleteLive?: boolean } = {}): Promise<SessionMessage[]> {
    const active = getActiveSessionTranscript(sessionId);
    if (active) {
        if (active.writer.status.reason === 'invalid-history' && !options.allowIncompleteLive) throw new MalformedSessionTranscriptError(sessionId);
        return transcriptMessages(active.writer.projection);
    }
    if (getSessionMetadata(sessionId)?.transcriptFormat === 2) {
        const decoded = await readTranscriptFile(getV2SessionFilePath(sessionId), sessionId);
        if (decoded.tail === 'invalid') throw new MalformedSessionTranscriptError(sessionId);
        return transcriptMessages(decoded.projection);
    }
    return readSessionMessagesForMutation(sessionId);
}

function rewriteDshMessages(sessionId: string, messages: SessionMessage[]): void {
    const active = getActiveSessionTranscript(sessionId);
    if (active) {
        const projection = createTranscriptProjection();
        for (const message of messages) projection.messages.set(message.id, fromStoredTranscriptMessage(message));
        const ids = new Set(messages.map(message => message.id));
        for (const [id, turn] of active.writer.projection.turns) {
            if ((turn.rootUserMessageId ? ids.has(turn.rootUserMessageId) : messages.some(message => message.turnId === id))) projection.turns.set(id, turn);
        }
        for (const message of projection.messages.values()) {
            const anchor = message.runtimeTurnAnchor;
            if (message.role !== 'assistant' || !anchor) continue;
            const turnId = message.turnId ?? anchor.rootUserMessageId ?? anchor.turnId;
            message.turnId = turnId;
            const root = anchor.rootUserMessageId ? projection.messages.get(anchor.rootUserMessageId) : undefined;
            if (root) root.turnId = turnId;
            projection.turns.set(turnId, {
                id: turnId,
                ...(anchor.origin === 'collaboration' ? { origin: 'collaboration' as const } : { rootUserMessageId: anchor.rootUserMessageId }),
                startedAt: root?.timestamp ?? message.timestamp,
                status: message.completionState === 'partial' ? message.terminalStatus ?? 'interrupted' : 'complete',
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
            });
        }
        active.writer.replaceProjection(projection);
        // A named baseline replacement does not emit individual content ops.
        active.patchMetadata({ stats: calculateSessionStats(messages), lastMessagePreview: resolveLastVisibleTurnPreview(messages).preview });
        return;
    }
    if (getSessionMetadata(sessionId)?.transcriptFormat !== undefined) throw new Error('DSH V2 mutation requires the active Session owner');
    atomicRewriteSessionMessages(sessionId, messages);
}

/**
 * Persist Product ownership before a root user row may be dispatched to DSH.
 * The journal intentionally lands first; an absent user row is a recoverable
 * pre-admission abort, while a present row requires exact native replay.
 */
export async function beginDshRootOperation(input: {
    sessionId: string;
    cursor: TranscriptWriteCursor;
    runtimeSessionId: string;
    clientOperationId: string;
    userMessage: SessionMessage;
    productImageSha256: readonly string[];
}): Promise<DshMutationStoreResult<PendingDshRootOperation>> {
    ensureStorageDir();
    try {
        return await withDshProjection(input.sessionId, async () => {
            const currentFile = getTranscriptFileIdentity(getSessionFilePath(input.sessionId));
            const active = getActiveSessionTranscript(input.sessionId);
            const cursorState = input.cursor[transcriptCursorState];
            const matches = active ? cursorState.sessionId === input.sessionId
                && cursorState.v2?.instanceId === active.writer.status.instanceId
                && cursorState.v2.liveRevision === active.writer.status.liveRevision
                : cursorMatches(input.sessionId, input.cursor, currentFile);
            if (!matches) {
                return dshMutationFailure('precondition_failed', 'The Product transcript changed before DSH admission');
            }
            if (
                !validDshOperationIdentifier(input.clientOperationId)
                || !validDshOperationIdentifier(input.userMessage.id)
                || input.userMessage.role !== 'user'
            ) {
                return dshMutationFailure('precondition_failed', 'The DSH root operation identity is invalid');
            }
            const transcript = { messages: await readDshMessagesForMutation(input.sessionId, { allowIncompleteLive: true }), hasMalformedRows: false };
            if (transcript.hasMalformedRows) {
                return dshMutationFailure('storage_consistency_error', 'The Product transcript is malformed');
            }
            if (!active && transcript.messages.some(message => message.id === input.userMessage.id)) {
                return dshMutationFailure('precondition_failed', 'The DSH root user identity is already persisted');
            }
            const operation: PendingDshRootOperation = {
                schemaVersion: 1,
                ...(active ? { userMessage: structuredClone(input.userMessage),
                    ...(active.isUnpublishedBirth && transcript.messages.length === 1 ? { transcriptBirth: true as const } : {}),
                } : {}),
                clientOperationId: input.clientOperationId,
                clientUserMessageId: input.userMessage.id,
                sourceRuntimeSessionId: input.runtimeSessionId,
                productImageSha256: [...input.productImageSha256],
                productInputFingerprint: fingerprintDshProductInput(
                    input.userMessage,
                    input.clientOperationId,
                    input.productImageSha256,
                ),
            };
            return withSessionsLock(async () => {
                const all = readDshSessionsIndexForWrite(input.sessionId);
                const index = all.findIndex(session => session.id === input.sessionId);
                const current = index >= 0 ? all[index] : undefined;
                if (
                    !current
                    || (active && (getActiveSessionTranscript(input.sessionId) !== active
                        || active.writer.status.liveRevision !== cursorState.v2?.liveRevision))
                    || !sessionUsesDsh(current)
                    || current.runtimeSessionId !== input.runtimeSessionId
                    || current.pendingDshMutation
                    || (current.pendingDshInputs?.length ?? 0) > 0
                ) {
                    return dshMutationFailure('precondition_failed', 'The DSH Session authority changed before root admission');
                }
                const existing = current.pendingDshRootOperation;
                if (existing) {
                    if (JSON.stringify({ ...existing, transcriptBirth: undefined }) !== JSON.stringify({ ...operation, transcriptBirth: undefined })) {
                        return dshMutationFailure('precondition_failed', 'Another DSH root operation owns Product admission');
                    }
                    return { success: true, value: structuredClone(existing) };
                }
                all[index] = { ...current, pendingDshRootOperation: operation,
                    ...(active ? { pendingDshRootInputs: [...(current.pendingDshRootInputs ?? []), operation] } : {}),
                };
                writeDshSessionsIndex(all, input.sessionId);
                return { success: true, value: structuredClone(operation) };
            });
        });
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

/** Product input intent lands before the native follow-up request can be sent. */
export async function beginDshInput(input: {
    sessionId: string;
    runtimeSessionId: string;
    clientOperationId: string;
    queueId: string;
    userMessage: SessionMessage;
    productImageSha256: readonly string[];
    runtimeInputFingerprint: string;
}): Promise<DshMutationStoreResult<PendingDshInput>> {
    ensureStorageDir();
    try {
        const pending: PendingDshInput = {
            schemaVersion: 1, clientOperationId: input.clientOperationId, clientUserMessageId: input.userMessage.id,
            sourceRuntimeSessionId: input.runtimeSessionId, queueId: input.queueId, userMessage: structuredClone(input.userMessage),
            productImageSha256: [...input.productImageSha256],
            productInputFingerprint: fingerprintDshProductInput(input.userMessage, input.clientOperationId, input.productImageSha256),
            runtimeInputFingerprint: input.runtimeInputFingerprint, delivery: 'realtime', state: 'pending',
        };
        if (![input.clientOperationId, input.queueId, input.userMessage.id].every(validDshOperationIdentifier)
            || !/^[a-f0-9]{64}$/u.test(input.runtimeInputFingerprint)
            || input.userMessage.runtimeOperationAnchor?.clientOperationId !== input.clientOperationId
            || input.userMessage.runtimeOperationAnchor.runtimeSessionId !== input.runtimeSessionId) {
            return dshMutationFailure('precondition_failed', 'The DSH input intent identity is invalid');
        }
        return await withDshProjection(input.sessionId, () => withSessionsLock(async () => {
            const all = readDshSessionsIndexForWrite(input.sessionId);
            const index = all.findIndex(session => session.id === input.sessionId);
            const current = all[index];
            if (!current || !sessionUsesDsh(current) || current.runtimeSessionId !== input.runtimeSessionId || current.pendingDshMutation) {
                return dshMutationFailure('precondition_failed', 'The DSH input intent lost its Product Session authority');
            }
            const inputs = current.pendingDshInputs ?? [];
            const existing = inputs.find(item => item.clientUserMessageId === pending.clientUserMessageId);
            if (existing) {
                if (JSON.stringify({ ...existing, state: 'pending' }) !== JSON.stringify(pending)) return dshMutationFailure('precondition_failed', 'The DSH input retry changed immutable Product input');
                return { success: true, value: structuredClone(existing) };
            }
            if (inputs.some(item => item.queueId === input.queueId) || inputs.length >= 32
                || Buffer.byteLength(JSON.stringify([...inputs, pending])) > 8 * 1024 * 1024) {
                return dshMutationFailure('precondition_failed', 'The DSH pending input journal is full or its queue identity is reused');
            }
            if ((await readDshMessagesForMutation(input.sessionId, { allowIncompleteLive: true })).some(message => message.id === pending.clientUserMessageId)) {
                return dshMutationFailure('precondition_failed', 'The DSH input identity is already in Product history');
            }
            all[index] = { ...current, pendingDshInputs: [...inputs, pending] };
            writeDshSessionsIndex(all, input.sessionId);
            return { success: true, value: structuredClone(pending) };
        }));
    } catch (error) { return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error)); }
}

/** Record cancel intent or retire the exact journal after a native receipt. */
export async function settleDshInput(input: {
    sessionId: string; clientOperationId: string; clientUserMessageId: string;
    state: 'cancel_requested' | 'cancelled' | 'projected';
}): Promise<DshMutationStoreResult<{ settled: boolean }>> {
    ensureStorageDir();
    try {
        return await withDshProjection(input.sessionId, () => withSessionsLock(async () => {
            const all = readDshSessionsIndexForWrite(input.sessionId);
            const index = all.findIndex(session => session.id === input.sessionId);
            const current = all[index];
            const inputs = current?.pendingDshInputs ?? [];
            const pending = inputs.find(item => item.clientUserMessageId === input.clientUserMessageId);
            if (!current || !pending) return { success: true, value: { settled: false } };
            if (!sessionUsesDsh(current) || current.runtimeSessionId !== pending.sourceRuntimeSessionId || current.pendingDshMutation
                || pending.clientOperationId !== input.clientOperationId) return dshMutationFailure('precondition_failed', 'The DSH input settlement changed its owner');
            const users = (await readDshMessagesForMutation(input.sessionId, { allowIncompleteLive: true })).filter(message => message.id === input.clientUserMessageId);
            if (input.state === 'projected') {
                if (users.length !== 1) return dshMutationFailure('storage_consistency_error', 'A consumed DSH input has no exact durable Product projection');
                assertDshProductInputMatches(pending, users[0]!);
            } else if (input.state === 'cancelled' && users.length > 0) {
                return dshMutationFailure('storage_consistency_error', 'A consumed Product input cannot be cancelled');
            }
            const next = input.state === 'cancel_requested' ? inputs.map(item => item === pending ? { ...item, state: 'cancel_requested' as const } : item)
                : inputs.filter(item => item !== pending);
            all[index] = { ...current, pendingDshInputs: next.length ? next : undefined };
            writeDshSessionsIndex(all, input.sessionId, input.state !== 'cancel_requested');
            return { success: true, value: { settled: input.state !== 'cancel_requested' } };
        }));
    } catch (error) { return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error)); }
}

/** Clear a journal only when its root user never became durable. */
export async function discardUnpersistedDshRootOperation(input: {
    sessionId: string;
    clientOperationId: string;
    clientUserMessageId: string;
}): Promise<DshMutationStoreResult<{ discarded: boolean }>> {
    ensureStorageDir();
    try {
        return await withDshProjection(input.sessionId, async () => {
            const transcript = { messages: await readDshMessagesForMutation(input.sessionId), hasMalformedRows: false };
            if (transcript.hasMalformedRows) {
                return dshMutationFailure('storage_consistency_error', 'The Product transcript is malformed');
            }
            if (transcript.messages.some(message => message.id === input.clientUserMessageId)) {
                return { success: true, value: { discarded: false } };
            }
            return withSessionsLock(async () => {
                const all = readDshSessionsIndexForWrite(input.sessionId);
                const index = all.findIndex(session => session.id === input.sessionId);
                const current = index >= 0 ? all[index] : undefined;
                const pending = current?.pendingDshRootOperation;
                if (!current || !pending) return { success: true, value: { discarded: false } };
                if (
                    pending.clientOperationId !== input.clientOperationId
                    || pending.clientUserMessageId !== input.clientUserMessageId
                ) {
                    return dshMutationFailure('storage_consistency_error', 'The DSH root operation owner changed before discard');
                }
                all[index] = { ...current, pendingDshRootOperation: undefined,
                    pendingDshRootInputs: current.pendingDshRootInputs?.filter(root => root.clientOperationId !== input.clientOperationId),
                };
                writeDshSessionsIndex(all, input.sessionId, true);
                return { success: true, value: { discarded: true } };
            });
        });
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

/** Retire the exact Product journal only after the matching native terminal is handled. */
export async function settleDshRootOperation(input: {
    sessionId: string;
    clientOperationId: string;
}): Promise<DshMutationStoreResult<{ settled: boolean }>> {
    ensureStorageDir();
    try {
        return await withSessionsLock(async () => {
            const all = readDshSessionsIndexForWrite(input.sessionId);
            const index = all.findIndex(session => session.id === input.sessionId);
            const current = index >= 0 ? all[index] : undefined;
            const pending = current?.pendingDshRootOperation;
            if (!current || !pending) return { success: true, value: { settled: false } };
            if (pending.clientOperationId !== input.clientOperationId) {
                return dshMutationFailure('storage_consistency_error', 'The DSH terminal changed its Product operation owner');
            }
            all[index] = { ...current, pendingDshRootOperation: undefined };
            writeDshSessionsIndex(all, input.sessionId, true);
            return { success: true, value: { settled: true } };
        });
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

/**
 * Reconcile Runtime-owned terminal turns into the Product-owned transcript
 * projection. The native cursor and every inserted assistant row are committed
 * under the same Product locks; exact replay is a no-op.
 */
export async function reconcileDshTurnProjections(input: {
    sessionId: string;
    runtimeSessionId: string;
    cursor: DshProjectionCursor;
    assistantMessages: readonly SessionMessage[];
    nativeInputReceipts?: readonly {
        clientOperationId: string; clientUserMessageId: string; inputFingerprint: string;
        sequence: number; state: 'pending' | 'consumed' | 'cancelled';
    }[];
    nativeRootOperations: readonly {
        inherited?: true;
        origin?: 'collaboration';
        consumedUserMessageIds?: readonly string[];
        clientOperationId: string;
        clientUserMessageId: string;
        productTurnId: string;
        terminal: boolean;
        partialTerminalStatus?: 'stopped' | 'error';
    }[];
    unsettledTurn?: {
        origin?: 'collaboration';
        clientOperationId: string;
        productTurnId: string;
        clientUserMessageId: string;
    };
    runtimeUsageTotals?: MessageUsage;
}): Promise<DshMutationStoreResult<{ transcriptChanged: boolean; cursor: DshProjectionCursor }>> {
    ensureStorageDir();
    try {
        return await withDshProjection(input.sessionId, async () => {
            return withSessionsLock(async () => {
                const messages = await readDshMessagesForMutation(input.sessionId, { allowIncompleteLive: true });
                const all = readDshSessionsIndexForWrite(input.sessionId);
                const index = all.findIndex(session => session.id === input.sessionId);
                const current = index >= 0 ? all[index] : undefined;
                if (
                    !current
                    || !sessionUsesDsh(current)
                    || current.runtimeSessionId !== input.runtimeSessionId
                    || input.cursor.schemaVersion !== 1
                    || input.cursor.runtimeSessionId !== input.runtimeSessionId
                    || !Number.isSafeInteger(input.cursor.durableSequence)
                    || input.cursor.durableSequence < 0
                    || !/^[a-f0-9]{64}$/u.test(input.cursor.transcriptPostcondition)
                    || current.pendingDshMutation
                ) {
                    return dshMutationFailure('precondition_failed', 'The DSH projection authority changed');
                }

                const nativeRoots = new Map<string, (typeof input.nativeRootOperations)[number]>();
                const nativeRootsByTurn = new Map<string, (typeof input.nativeRootOperations)[number]>();
                const nativeRootsByUser = new Map<string, (typeof input.nativeRootOperations)[number]>();
                const consumedUserOwners = new Map<string, string>();
                for (const operation of input.nativeRootOperations) {
                    if (
                        !validDshOperationIdentifier(operation.clientOperationId)
                        || !validDshOperationIdentifier(operation.clientUserMessageId)
                        || !validDshOperationIdentifier(operation.productTurnId)
                        || typeof operation.terminal !== 'boolean'
                        || (operation.inherited !== undefined && (operation.inherited !== true || !operation.terminal))
                        || (operation.origin !== undefined && operation.origin !== 'collaboration')
                        || (
                            operation.partialTerminalStatus !== undefined
                            && operation.partialTerminalStatus !== 'stopped'
                            && operation.partialTerminalStatus !== 'error'
                        )
                        || (!operation.terminal && operation.partialTerminalStatus !== undefined)
                        || nativeRoots.has(operation.clientOperationId)
                        || nativeRootsByTurn.has(operation.productTurnId)
                        || nativeRootsByUser.has(operation.clientUserMessageId)
                    ) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH native root operation set is ambiguous');
                    }
                    nativeRoots.set(operation.clientOperationId, operation);
                    nativeRootsByTurn.set(operation.productTurnId, operation);
                    nativeRootsByUser.set(operation.clientUserMessageId, operation);
                    for (const userId of operation.consumedUserMessageIds ?? []) {
                        if (!validDshOperationIdentifier(userId) || consumedUserOwners.has(userId)) {
                            return dshMutationFailure('storage_consistency_error', 'The DSH consumed user identity is ambiguous');
                        }
                        consumedUserOwners.set(userId, operation.clientOperationId);
                    }
                }
                if ([...consumedUserOwners.keys()].some(id => nativeRootsByUser.has(id))) {
                    return dshMutationFailure('storage_consistency_error', 'A DSH continuation cannot borrow a root user');
                }

                const active = getActiveSessionTranscript(input.sessionId);
                if (active?.writer.status.reason === 'invalid-history') {
                    // Native execution remains authoritative when Product history
                    // cannot be repaired. Keep that prefix read-only, settle only
                    // exact execution identities in the live overlay, and leave
                    // durable recovery journals intact until a valid content commit.
                    const pending = current.pendingDshRootOperation;
                    const native = pending ? nativeRoots.get(pending.clientOperationId) : undefined;
                    if (pending && native && (pending.sourceRuntimeSessionId !== input.runtimeSessionId
                        || native.clientUserMessageId !== pending.clientUserMessageId)) {
                        return dshMutationFailure('storage_consistency_error', 'DSH recovery changed the admitted input identity');
                    }
                    const receipts = new Map((input.nativeInputReceipts ?? []).map(receipt => [receipt.clientUserMessageId, receipt]));
                    const pendingInputs = (current.pendingDshInputs ?? []).filter(item => {
                        const receipt = receipts.get(item.clientUserMessageId);
                        if (!receipt) return true;
                        if (receipt.clientOperationId !== item.clientOperationId || receipt.inputFingerprint !== item.runtimeInputFingerprint) {
                            throw new Error('DSH recovery changed its durable follow-up input');
                        }
                        return receipt.state === 'pending';
                    });
                    active.patchMetadata({
                        pendingDshRootOperation: native?.terminal ? undefined : pending,
                        pendingDshInputs: pendingInputs.length ? pendingInputs : undefined,
                    });
                    return { success: true, value: { transcriptChanged: false, cursor: structuredClone(input.cursor) } };
                }

                const projectedIds = new Set<string>();
                const projectedTurns = new Set<string>();
                const projectedRoots = new Set<string>();
                const target = [...messages];
                let transcriptChanged = false;
                if (current.transcriptFormat === 2) for (const root of current.pendingDshRootInputs ?? (current.pendingDshRootOperation ? [current.pendingDshRootOperation] : [])) {
                    if (!root.userMessage) continue;
                    assertDshProductInputMatches(root, root.userMessage);
                    const existing = target.filter(message => message.id === root.clientUserMessageId);
                    if (existing.length > 1) return dshMutationFailure('storage_consistency_error', 'Duplicate DSH recovery input');
                    if (existing[0]) assertDshProductInputMatches(root, existing[0]);
                    else { target.push(structuredClone(root.userMessage)); transcriptChanged = true; }
                }
                const retainedInputs = [...(current.pendingDshInputs ?? [])];
                const receiptIds = new Set<string>();
                for (const receipt of input.nativeInputReceipts ?? []) {
                    if (receiptIds.has(receipt.clientUserMessageId) || !nativeRoots.has(receipt.clientOperationId)
                        || !/^[a-f0-9]{64}$/u.test(receipt.inputFingerprint)) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH input receipt set is ambiguous');
                    }
                    if ((nativeRoots.get(receipt.clientOperationId)?.consumedUserMessageIds?.includes(receipt.clientUserMessageId) ?? false)
                        !== (receipt.state === 'consumed')) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH input receipt contradicts its consumed operation association');
                    }
                    receiptIds.add(receipt.clientUserMessageId);
                    const pending = retainedInputs.find(item => item.clientUserMessageId === receipt.clientUserMessageId);
                    if (!pending) continue;
                    if (pending.sourceRuntimeSessionId !== input.runtimeSessionId || pending.clientOperationId !== receipt.clientOperationId
                        || pending.runtimeInputFingerprint !== receipt.inputFingerprint) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH receipt changed its durable Product input');
                    }
                    assertDshProductInputMatches(pending, pending.userMessage);
                    if (receipt.state === 'pending') continue;
                    const existing = target.filter(message => message.id === pending.clientUserMessageId);
                    if (receipt.state === 'cancelled') {
                        if (existing.length) return dshMutationFailure('storage_consistency_error', 'DSH cancelled an input already projected as consumed');
                    } else {
                        const native = nativeRoots.get(receipt.clientOperationId)!;
                        const consumed = native.consumedUserMessageIds ?? [];
                        const position = consumed.indexOf(pending.clientUserMessageId);
                        if (position < 0 || existing.length > 1) return dshMutationFailure('storage_consistency_error', 'The DSH consumed input lacks its operation association');
                        if (existing.length === 1) assertDshProductInputMatches(pending, existing[0]!);
                        else {
                            const predecessor = position > 0 ? consumed[position - 1] : native.origin === 'collaboration' ? undefined : native.clientUserMessageId;
                            let insertion: number;
                            if (predecessor !== undefined) {
                                const indexes = target.flatMap((message, index) => message.role === 'user' && message.id === predecessor ? [index] : []);
                                if (indexes.length !== 1) return dshMutationFailure('storage_consistency_error', 'The recovered DSH input lost its preceding Product input');
                                insertion = indexes[0]! + 1;
                                if (current.transcriptFormat === 2) {
                                    const turnId = target[indexes[0]!]!.turnId ?? native.clientUserMessageId;
                                    while (target[insertion]?.role === 'assistant' && target[insertion]?.turnId === turnId) insertion += 1;
                                }
                            } else {
                                const order = input.nativeRootOperations.indexOf(native);
                                const index = target.findIndex(message => {
                                    const other = message.runtimeTurnAnchor ? nativeRootsByTurn.get(message.runtimeTurnAnchor.turnId)
                                        : message.runtimeOperationAnchor ? nativeRoots.get(message.runtimeOperationAnchor.clientOperationId) : undefined;
                                    return other ? input.nativeRootOperations.indexOf(other) >= order
                                        : message.role === 'user' && message.runtimeOperationAnchor?.runtime === 'dsh';
                                });
                                insertion = index < 0 ? target.length : index;
                            }
                            target.splice(insertion, 0, structuredClone(pending.userMessage)); transcriptChanged = true;
                        }
                    }
                    retainedInputs.splice(retainedInputs.indexOf(pending), 1);
                }
                const lastConsumedUserIndex = (native: (typeof input.nativeRootOperations)[number], rootIndex?: number): number | undefined => {
                    let previous = rootIndex;
                    for (const userId of native.consumedUserMessageIds ?? []) {
                        const matches = target.flatMap((message, index) => message.role === 'user' && message.id === userId ? [index] : []);
                        const index = matches[0];
                        if (matches.length !== 1 || index === undefined || (previous !== undefined && (index <= previous || target.slice(previous + 1, index).some(message => message.role !== 'assistant' || (current.transcriptFormat !== 2 || message.turnId !== target[previous!]?.turnId))))) {
                            throw new Error('The DSH consumed input is missing, duplicated or out of order in Product history');
                        }
                        const anchor = target[index]!.runtimeOperationAnchor;
                        if (anchor && (anchor.clientOperationId !== native.clientOperationId || anchor.runtimeSessionId !== input.runtimeSessionId)) {
                            throw new Error('The DSH consumed input changed its Product operation owner');
                        }
                        previous = index;
                    }
                    return previous;
                };
                for (const assistant of input.assistantMessages) {
                    const anchor = assistant.runtimeTurnAnchor;
                    if (anchor?.origin === 'collaboration') {
                        const native = nativeRootsByTurn.get(anchor.turnId);
                        if (assistant.role !== 'assistant' || !assistant.id || !native?.terminal || native.origin !== 'collaboration'
                            || native.clientOperationId !== anchor.clientOperationId || anchor.rootUserMessageId !== undefined
                            || projectedIds.has(assistant.id) || projectedTurns.has(anchor.turnId)) {
                            return dshMutationFailure('storage_consistency_error', 'The DSH collaboration projection lacks its native owner');
                        }
                        projectedIds.add(assistant.id); projectedTurns.add(anchor.turnId);
                        const lastInputIndex = lastConsumedUserIndex(native);
                        if (current.transcriptFormat === 2) {
                            const changed = reconcileDshV2Assistant(target, assistant, native);
                            if (changed !== undefined) { transcriptChanged ||= changed; continue; }
                        }
                        const matches = target.flatMap((message, index) => message.role === 'assistant'
                            && message.runtimeTurnAnchor?.turnId === anchor.turnId ? [{ message, index }] : []);
                        if (matches.length > 1 || (matches[0] && (matches[0].message.runtimeTurnAnchor?.origin !== 'collaboration'
                            || matches[0].message.runtimeTurnAnchor.clientOperationId !== native.clientOperationId))) {
                            return dshMutationFailure('storage_consistency_error', 'The Product transcript changed a collaboration owner');
                        }
                        const existing = matches[0];
                        if (existing) {
                            if (lastInputIndex !== undefined && existing.index !== lastInputIndex + 1) {
                                return dshMutationFailure('storage_consistency_error', 'The collaboration assistant precedes its consumed Product input');
                            }
                            const repaired = { ...structuredClone(assistant), id: existing.message.id };
                            if (JSON.stringify(existing.message) !== JSON.stringify(repaired)) { target[existing.index] = repaired; transcriptChanged = true; }
                        } else {
                            if (target.some(message => message.id === assistant.id)) return dshMutationFailure('storage_consistency_error', 'The collaboration assistant id is already owned');
                            const order = input.nativeRootOperations.indexOf(native);
                            const insertion = target.findIndex(message => {
                                const other = message.runtimeTurnAnchor ? nativeRootsByTurn.get(message.runtimeTurnAnchor.turnId)
                                    : message.runtimeOperationAnchor ? nativeRoots.get(message.runtimeOperationAnchor.clientOperationId) : undefined;
                                return other ? input.nativeRootOperations.indexOf(other) > order
                                    : message.role === 'user' && message.runtimeOperationAnchor?.runtime === 'dsh';
                            });
                            const position = insertion < 0 ? target.length : insertion;
                            if (lastInputIndex !== undefined && position !== lastInputIndex + 1) {
                                return dshMutationFailure('storage_consistency_error', 'The collaboration input overlaps another Product operation');
                            }
                            target.splice(position, 0, structuredClone(assistant)); transcriptChanged = true;
                        }
                        continue;
                    }
                    if (
                        assistant.role !== 'assistant'
                        || !assistant.id
                        || !anchor?.turnId
                        || !anchor.rootUserMessageId
                        || projectedIds.has(assistant.id)
                        || projectedTurns.has(anchor.turnId)
                        || projectedRoots.has(anchor.rootUserMessageId)
                    ) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH assistant projection is ambiguous');
                    }
                    projectedIds.add(assistant.id);
                    projectedTurns.add(anchor.turnId);
                    projectedRoots.add(anchor.rootUserMessageId);
                    const native = nativeRootsByTurn.get(anchor.turnId);
                    if (!native?.terminal || native.origin === 'collaboration' || native.clientUserMessageId !== anchor.rootUserMessageId) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH assistant lacks its exact native user operation');
                    }

                    const userIndexes = target.flatMap((message, messageIndex) => (
                        message.role === 'user' && message.id === anchor.rootUserMessageId
                            ? [messageIndex]
                            : []
                    ));
                    if (userIndexes.length !== 1) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH root user projection is missing or duplicated');
                    }
                    const insertionIndex = lastConsumedUserIndex(native, userIndexes[0]!)! + 1;
                    if (current.transcriptFormat === 2) {
                        const changed = reconcileDshV2Assistant(target, assistant, native);
                        if (changed !== undefined) { transcriptChanged ||= changed; continue; }
                    }
                    const matchingAssistants = target.flatMap((message, messageIndex) => {
                        if (message.role !== 'assistant' || !message.runtimeTurnAnchor) return [];
                        const candidate = message.runtimeTurnAnchor;
                        return candidate.turnId === anchor.turnId || candidate.rootUserMessageId === anchor.rootUserMessageId
                            ? [{ message, messageIndex }]
                            : [];
                    });
                    if (matchingAssistants.length > 1) {
                        return dshMutationFailure('storage_consistency_error', 'The Product transcript duplicates a DSH terminal turn');
                    }
                    const existing = matchingAssistants[0];
                    if (existing) {
                        if (
                            existing.message.runtimeTurnAnchor?.turnId !== anchor.turnId
                            || existing.message.runtimeTurnAnchor.rootUserMessageId !== anchor.rootUserMessageId
                            || existing.messageIndex !== insertionIndex
                        ) {
                            return dshMutationFailure('storage_consistency_error', 'The Product transcript changed a DSH terminal anchor');
                        }
                        const repaired = { ...structuredClone(assistant), id: existing.message.id };
                        if (JSON.stringify(existing.message) !== JSON.stringify(repaired)) {
                            target[existing.messageIndex] = repaired;
                            transcriptChanged = true;
                        }
                        continue;
                    }
                    if (target.some(message => message.id === assistant.id)) {
                        return dshMutationFailure('storage_consistency_error', 'The deterministic DSH assistant id is already owned');
                    }
                    const next = target[insertionIndex];
                    if (next?.role === 'assistant') {
                        return dshMutationFailure('storage_consistency_error', 'An unowned Product assistant occupies the DSH turn projection');
                    }
                    target.splice(insertionIndex, 0, structuredClone(assistant));
                    transcriptChanged = true;
                }
                const retainedHistoryTurns = new Set<string>();
                const retainedHistoryRoots = new Set<string>();
                for (let messageIndex = 0; messageIndex < target.length; messageIndex += 1) {
                    const message = target[messageIndex]!;
                    if (message.role !== 'assistant' || message.runtimeTurnAnchor === undefined) continue;
                    const anchor = message.runtimeTurnAnchor;
                    if (projectedTurns.has(anchor.turnId) && (anchor.origin === 'collaboration' || projectedRoots.has(anchor.rootUserMessageId))) continue;
                    const nativeByTurn = nativeRootsByTurn.get(anchor.turnId);
                    const nativeByUser = anchor.origin === 'collaboration'
                        ? nativeByTurn?.origin === 'collaboration' && nativeByTurn.clientOperationId === anchor.clientOperationId ? nativeByTurn : undefined
                        : nativeRootsByUser.get(anchor.rootUserMessageId);
                    if (nativeByTurn?.inherited === true && nativeByTurn === nativeByUser && nativeByTurn.terminal
                        && !retainedHistoryTurns.has(anchor.turnId)
                        && (anchor.rootUserMessageId === undefined || !retainedHistoryRoots.has(anchor.rootUserMessageId))) {
                        retainedHistoryTurns.add(anchor.turnId);
                        if (anchor.rootUserMessageId !== undefined) retainedHistoryRoots.add(anchor.rootUserMessageId);
                        continue;
                    }
                    if (
                        nativeByTurn === undefined
                        || nativeByTurn !== nativeByUser
                        || !nativeByTurn.terminal
                        || nativeByTurn.partialTerminalStatus === undefined
                        || message.completionState !== 'partial'
                        || retainedHistoryTurns.has(anchor.turnId)
                        || (anchor.rootUserMessageId !== undefined && retainedHistoryRoots.has(anchor.rootUserMessageId))
                    ) {
                        return dshMutationFailure('storage_consistency_error', 'The Product transcript contains a terminal absent from DSH native truth');
                    }
                    retainedHistoryTurns.add(anchor.turnId);
                    if (anchor.rootUserMessageId !== undefined) retainedHistoryRoots.add(anchor.rootUserMessageId);
                    if (message.terminalStatus !== nativeByTurn.partialTerminalStatus) {
                        target[messageIndex] = {
                            ...message,
                            terminalStatus: nativeByTurn.partialTerminalStatus,
                        };
                        transcriptChanged = true;
                    }
                }
                if (input.unsettledTurn) {
                    const matchingUsers = target.filter(message => (
                        message.role === 'user'
                        && message.id === input.unsettledTurn?.clientUserMessageId
                    ));
                    const conflictingAssistant = target.some(message => (
                        message.role === 'assistant'
                        && message.runtimeTurnAnchor !== undefined
                        && (
                            message.runtimeTurnAnchor.turnId === input.unsettledTurn?.productTurnId
                            || message.runtimeTurnAnchor.rootUserMessageId === input.unsettledTurn?.clientUserMessageId
                        )
                    ));
                    const unsettledNative = nativeRoots.get(input.unsettledTurn.clientOperationId);
                    if ((input.unsettledTurn.origin === 'collaboration'
                        ? unsettledNative?.origin !== 'collaboration' || unsettledNative.terminal || unsettledNative.productTurnId !== input.unsettledTurn.productTurnId
                        : matchingUsers.length !== 1) || conflictingAssistant) {
                        return dshMutationFailure('storage_consistency_error', 'The active DSH turn lacks one exact Product user owner');
                    }
                }

                let pendingDshRootOperation = current.pendingDshRootOperation;
                if (pendingDshRootOperation) {
                    if (
                        pendingDshRootOperation.schemaVersion !== 1
                        || pendingDshRootOperation.sourceRuntimeSessionId !== input.runtimeSessionId
                    ) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH root operation journal changed Runtime authority');
                    }
                    const journalUsers = target.filter(message => (
                        message.role === 'user'
                        && message.id === pendingDshRootOperation?.clientUserMessageId
                    ));
                    const native = nativeRoots.get(pendingDshRootOperation.clientOperationId);
                    if (journalUsers.length === 0) {
                        if (native) {
                            return dshMutationFailure('storage_consistency_error', 'DSH admitted a root operation without its Product user');
                        }
                        pendingDshRootOperation = undefined;
                    } else if (journalUsers.length !== 1) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH root operation journal has a duplicated Product user');
                    } else {
                        try {
                            assertDshProductInputMatches(pendingDshRootOperation, journalUsers[0]!);
                        } catch (error) {
                            return dshMutationFailure(
                                'storage_consistency_error',
                                error instanceof Error ? error.message : String(error),
                            );
                        }
                        if (native && (
                            native.clientUserMessageId !== pendingDshRootOperation.clientUserMessageId
                            || native.clientOperationId !== pendingDshRootOperation.clientOperationId
                        )) {
                            return dshMutationFailure('storage_consistency_error', 'DSH changed the journaled root operation identity');
                        }
                        if (native?.terminal) pendingDshRootOperation = undefined;
                    }
                    if (
                        input.unsettledTurn
                        && input.unsettledTurn.origin !== 'collaboration'
                        && pendingDshRootOperation
                        && input.unsettledTurn.clientOperationId !== pendingDshRootOperation.clientOperationId
                    ) {
                        return dshMutationFailure('storage_consistency_error', 'A different DSH root operation is active beside the Product journal');
                    }
                }

                if (transcriptChanged) rewriteDshMessages(input.sessionId, target);
                const { preview } = resolveLastVisibleTurnPreview(target);
                all[index] = {
                    ...current,
                    stats: calculateSessionStats(target),
                    lastMessagePreview: preview,
                    dshProjectionCursor: structuredClone(input.cursor),
                    pendingDshInputs: retainedInputs.length ? retainedInputs : undefined,
                    pendingDshRootOperation: pendingDshRootOperation
                        ? structuredClone(pendingDshRootOperation)
                        : undefined,
                    runtimeUsageTotals: input.runtimeUsageTotals
                        ? structuredClone(input.runtimeUsageTotals)
                        : undefined,
                };
                writeDshSessionsIndex(all, input.sessionId, true);
                return {
                    success: true,
                    value: { transcriptChanged, cursor: structuredClone(input.cursor) },
                };
            });
        });
    } catch (error) {
        return dshMutationFailure(
            error instanceof MalformedSessionTranscriptError ? 'storage_consistency_error' : 'write_error',
            error instanceof Error ? error.message : String(error),
        );
    }
}

/** Persist a DSH delete intent while Product metadata and transcript still exist. */
export async function beginDshDeleteMutation(input: {
    sessionId: string;
    clientMutationId: string;
}): Promise<DshMutationStoreResult<PendingDshDelete>> {
    ensureStorageDir();
    try {
        return await withSessionFileLock(input.sessionId, async () => {
            return withSessionsLock(async () => {
                const all = readDshSessionsIndexForWrite(input.sessionId);
                const index = all.findIndex(session => session.id === input.sessionId);
                const current = index >= 0 ? all[index] : undefined;
                if (!current) return dshMutationFailure('precondition_failed', 'The DSH Session is unavailable');
                const existing = exactPendingDshMutation(current, input.clientMutationId);
                if (existing?.kind === 'dsh-delete') return { success: true, value: existing };
                if (
                    !sessionUsesDsh(current)
                    || !current.runtimeSessionId
                    || current.pendingDshMutation
                    || isSystemMaintenanceSession(current)
                ) {
                    return dshMutationFailure('precondition_failed', 'The DSH delete authority changed');
                }
                // Rust has retired execution owners. Pending inputs/operations
                // remain intact until native purge succeeds and Product removal
                // completes; deletion never needs to decode the transcript.
                const intent: PendingDshDelete = {
                    schemaVersion: 1,
                    kind: 'dsh-delete',
                    clientMutationId: input.clientMutationId,
                    sourceRuntimeSessionId: current.runtimeSessionId,
                };
                all[index] = { ...current, pendingDshMutation: intent };
                writeDshSessionsIndex(all, input.sessionId);
                return { success: true, value: intent };
            });
        });
    } catch (error) {
        return dshMutationFailure(
            error instanceof MalformedSessionTranscriptError ? 'storage_consistency_error' : 'write_error',
            error instanceof Error ? error.message : String(error),
        );
    }
}

export async function recordPreparedDshDelete(input: {
    sessionId: string;
    clientMutationId: string;
    token: string;
}): Promise<DshMutationStoreResult<PendingDshDelete>> {
    ensureStorageDir();
    try {
        return await withSessionFileLock(input.sessionId, async () => withSessionsLock(async () => {
            const all = readDshSessionsIndexForWrite(input.sessionId);
            const index = all.findIndex(session => session.id === input.sessionId);
            const current = index >= 0 ? all[index] : undefined;
            const pending = current && exactPendingDshMutation(current, input.clientMutationId);
            if (!current || pending?.kind !== 'dsh-delete') {
                return dshMutationFailure('precondition_failed', 'The DSH delete intent changed');
            }
            if (pending.token && pending.token !== input.token) {
                return dshMutationFailure('storage_consistency_error', 'The DSH delete token changed');
            }
            const updatedIntent: PendingDshDelete = { ...pending, token: input.token };
            all[index] = { ...current, pendingDshMutation: updatedIntent };
            writeDshSessionsIndex(all, input.sessionId);
            return { success: true, value: updatedIntent };
        }));
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

export async function recordCommittedDshDelete(input: {
    sessionId: string;
    clientMutationId: string;
    token: string;
}): Promise<DshMutationStoreResult<PendingDshDelete>> {
    ensureStorageDir();
    try {
        return await withSessionFileLock(input.sessionId, async () => withSessionsLock(async () => {
            const all = readDshSessionsIndexForWrite(input.sessionId);
            const index = all.findIndex(session => session.id === input.sessionId);
            const current = index >= 0 ? all[index] : undefined;
            const pending = current && exactPendingDshMutation(current, input.clientMutationId);
            if (
                !current
                || pending?.kind !== 'dsh-delete'
                || (pending.token && pending.token !== input.token)
            ) {
                return dshMutationFailure('precondition_failed', 'The DSH delete journal changed before tombstone publication');
            }
            const updatedIntent: PendingDshDelete = {
                ...pending,
                token: input.token,
                runtimeCommitted: true,
            };
            all[index] = { ...current, pendingDshMutation: updatedIntent };
            writeDshSessionsIndex(all, input.sessionId);
            return { success: true, value: updatedIntent };
        }));
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

/** Remove Product data only after DSH reports the delete journal as purged. */
export async function deleteCommittedDshProduct(input: {
    sessionId: string;
    clientMutationId: string;
    token: string;
}): Promise<DshMutationStoreResult<{ deleted: true }>> {
    ensureStorageDir();
    try {
        const owner = getSessionMetadata(input.sessionId);
        const intent = owner && exactPendingDshMutation(owner, input.clientMutationId);
        if (intent?.kind !== 'dsh-delete' || intent.token !== input.token || intent.runtimeCommitted !== true) {
            return dshMutationFailure('precondition_failed', 'The Product delete journal is not purge-ready');
        }
        await getActiveSessionTranscript(input.sessionId)?.revoke();
        return await withSessionFileLock(input.sessionId, async () => withSessionsLock(async () => {
            const all = readDshSessionsIndexForWrite(input.sessionId);
            const index = all.findIndex(session => session.id === input.sessionId);
            const current = index >= 0 ? all[index] : undefined;
            const pending = current && exactPendingDshMutation(current, input.clientMutationId);
            if (
                !current
                || pending?.kind !== 'dsh-delete'
                || pending.token !== input.token
                || pending.runtimeCommitted !== true
            ) {
                return dshMutationFailure('precondition_failed', 'The Product delete journal is not purge-ready');
            }
            const jsonlFile = getSessionFilePath(input.sessionId);
            const legacyFile = getLegacySessionFilePath(input.sessionId);
            if (existsSync(jsonlFile)) unlinkSync(jsonlFile);
            if (existsSync(legacyFile)) unlinkSync(legacyFile);
            const v2File = getV2SessionFilePath(input.sessionId);
            if (existsSync(v2File)) unlinkSync(v2File);
            await discardForkAttachments(input.sessionId);
            activeTranscripts.delete(input.sessionId);
            all.splice(index, 1);
            writeDshSessionsIndex(all, input.sessionId);
            return { success: true, value: { deleted: true } };
        }));
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

/** Persist the immutable Product half of a DSH fork before Runtime prepare. */
export async function beginDshForkMutation(input: {
    sourceSessionId: string;
    sourceAssistantMessageId: string;
    clientMutationId: string;
    targetProductSessionId: string;
    targetRuntimeSessionId: string;
    targetRuntimeHome: string;
    targetPersistenceRef: string;
    targetWorkspaceIdentity: string;
}): Promise<DshMutationStoreResult<{
    intent: PendingDshFork;
    source: SessionMetadata;
    targetMessages: SessionMessage[];
}>> {
    ensureStorageDir();
    try {
        const activeSource = getActiveSessionTranscript(input.sourceSessionId);
        if (activeSource && !(await activeSource.writer.flushForMutation())) {
            return dshMutationFailure('write_error', 'Save the complete DSH conversation before this explicit mutation');
        }
        return await withSessionFileLocks(
            [input.sourceSessionId, input.targetProductSessionId],
            async () => {
                const messages = await readDshMessagesForMutation(input.sourceSessionId);
                const targetIndex = messages.findIndex(message => (
                    message.id === input.sourceAssistantMessageId && message.role === 'assistant'
                ));
                const target = targetIndex >= 0 ? messages[targetIndex] : undefined;
                if (!target?.runtimeTurnAnchor) {
                    return dshMutationFailure('precondition_failed', 'This message has no exact DSH turn anchor');
                }
                const sourceRuntimeTurnId = target.runtimeTurnAnchor.turnId;
                const targetMessages = messages.slice(0, targetIndex + 1);
                return withSessionsLock(async () => {
                    const all = readDshSessionsIndexForWrite(input.sourceSessionId);
                    const sourceIndex = all.findIndex(session => session.id === input.sourceSessionId);
                    if (sourceIndex < 0) {
                        return dshMutationFailure('precondition_failed', 'The source Session is unavailable');
                    }
                    const source = all[sourceIndex];
                    const existing = exactPendingDshMutation(source, input.clientMutationId);
                    if (existing?.kind === 'dsh-fork') {
                        return {
                            success: true,
                            value: { intent: existing, source, targetMessages },
                        };
                    }
                    if (
                        !sessionUsesDsh(source)
                        || !source.runtimeSessionId
                        || source.pendingDshMutation
                        || source.pendingDshRootOperation
                        || (source.pendingDshInputs?.length ?? 0) > 0
                        || all.some(session => session.id === input.targetProductSessionId)
                    ) {
                        return dshMutationFailure('precondition_failed', 'The DSH fork source or target changed');
                    }
                    const intent: PendingDshFork = {
                        schemaVersion: 1,
                        kind: 'dsh-fork',
                        clientMutationId: input.clientMutationId,
                        sourceRuntimeSessionId: source.runtimeSessionId,
                        sourceMessageCount: messages.length,
                        sourceAssistantMessageId: input.sourceAssistantMessageId,
                        sourceRuntimeTurnId,
                        targetProductSessionId: input.targetProductSessionId,
                        targetRuntimeSessionId: input.targetRuntimeSessionId,
                        targetRuntimeHome: input.targetRuntimeHome,
                        targetPersistenceRef: input.targetPersistenceRef,
                        targetWorkspaceIdentity: input.targetWorkspaceIdentity,
                        targetMessageCount: targetMessages.length,
                        settlement: 'commit',
                    };
                    const updated = { ...source, pendingDshMutation: intent };
                    all[sourceIndex] = updated;
                    writeDshSessionsIndex(all, input.sourceSessionId);
                    return {
                        success: true,
                        value: { intent, source: updated, targetMessages },
                    };
                });
            },
        );
    } catch (error) {
        return dshMutationFailure(
            error instanceof MalformedSessionTranscriptError ? 'storage_consistency_error' : 'write_error',
            error instanceof Error ? error.message : String(error),
        );
    }
}

/** Persist the Runtime prepare token before either authority may commit. */
export async function recordPreparedDshFork(input: {
    sourceSessionId: string;
    clientMutationId: string;
    token: string;
    sourceStableBoundaryId: string;
}): Promise<DshMutationStoreResult<PendingDshFork>> {
    ensureStorageDir();
    try {
        return await withSessionFileLock(input.sourceSessionId, async () => withSessionsLock(async () => {
            const all = readDshSessionsIndexForWrite(input.sourceSessionId);
            const index = all.findIndex(session => session.id === input.sourceSessionId);
            const current = index >= 0 ? all[index] : undefined;
            const pending = current && exactPendingDshMutation(current, input.clientMutationId);
            if (!current || pending?.kind !== 'dsh-fork') {
                return dshMutationFailure('precondition_failed', 'The DSH fork intent changed before prepare settled');
            }
            if (
                (pending.token && pending.token !== input.token)
                || (pending.sourceStableBoundaryId && pending.sourceStableBoundaryId !== input.sourceStableBoundaryId)
            ) {
                return dshMutationFailure('storage_consistency_error', 'The DSH fork receipt changed');
            }
            const updatedIntent: PendingDshFork = {
                ...pending,
                token: input.token,
                sourceStableBoundaryId: input.sourceStableBoundaryId,
            };
            all[index] = { ...current, pendingDshMutation: updatedIntent };
            writeDshSessionsIndex(all, input.sourceSessionId);
            return { success: true, value: updatedIntent };
        }));
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

/** Persist rollback intent before asking Runtime to abort a prepared fork. */
export async function requestDshForkAbort(input: {
    sourceSessionId: string;
    clientMutationId: string;
    token: string;
}): Promise<DshMutationStoreResult<PendingDshFork>> {
    ensureStorageDir();
    try {
        return await withSessionFileLock(input.sourceSessionId, async () => withSessionsLock(async () => {
            const all = readDshSessionsIndexForWrite(input.sourceSessionId);
            const index = all.findIndex(session => session.id === input.sourceSessionId);
            const current = index >= 0 ? all[index] : undefined;
            const pending = current && exactPendingDshMutation(current, input.clientMutationId);
            if (!current || pending?.kind !== 'dsh-fork' || pending.token !== input.token) {
                return dshMutationFailure('precondition_failed', 'The DSH fork journal changed before abort');
            }
            const updatedIntent: PendingDshFork = { ...pending, settlement: 'abort' };
            all[index] = { ...current, pendingDshMutation: updatedIntent };
            writeDshSessionsIndex(all, input.sourceSessionId);
            return { success: true, value: updatedIntent };
        }));
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

/** Stage the Product branch invisibly while the DSH target generation is prepared. */
export async function stageDshForkProduct(input: {
    sourceSessionId: string;
    clientMutationId: string;
    targetMetadata: SessionMetadata;
    targetMessages: SessionMessage[];
}): Promise<DshMutationStoreResult<SessionMetadata>> {
    ensureStorageDir();
    const targetSessionId = input.targetMetadata.id;
    try {
        return await withSessionFileLocks([input.sourceSessionId, targetSessionId], async () => {
            const sourceMessages = await readDshMessagesForMutation(input.sourceSessionId);
            if (
                sourceMessages.length < input.targetMessages.length
                || input.targetMessages.some((message, index) => message.id !== sourceMessages[index]?.id)
            ) {
                return dshMutationFailure('precondition_failed', 'The DSH fork transcript prefix changed');
            }
            const staged = await withSessionsLock<DshMutationStoreResult<SessionMetadata>>(async () => {
                const all = readDshSessionsIndexForWrite(input.sourceSessionId);
                const source = all.find(session => session.id === input.sourceSessionId);
                const pending = source && exactPendingDshMutation(source, input.clientMutationId);
                if (
                    pending?.kind !== 'dsh-fork'
                    || pending.targetProductSessionId !== targetSessionId
                    || input.targetMetadata.materializationState !== 'prepared'
                    || input.targetMetadata.materializationSourceSessionId !== input.sourceSessionId
                ) {
                    return dshMutationFailure('precondition_failed', 'The DSH fork staging authority changed');
                }
                const targetIndex = all.findIndex(session => session.id === targetSessionId);
                if (targetIndex >= 0) {
                    const existing = all[targetIndex];
                    if (
                        existing.materializationState !== 'prepared'
                        || existing.materializationSourceSessionId !== input.sourceSessionId
                        || existing.runtimeSessionId !== pending.targetRuntimeSessionId
                    ) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH fork target identity conflicts');
                    }
                    return { success: true, value: existing };
                }
                all.push(input.targetMetadata);
                writeDshSessionsIndex(all, input.sourceSessionId);
                return { success: true, value: input.targetMetadata };
            });
            if (!staged.success) return staged;
            const targetPath = staged.value.transcriptFormat === 2 ? getV2SessionFilePath(targetSessionId) : getSessionFilePath(targetSessionId);
            if (existsSync(targetPath)) {
                const existingMessages = await readDshMessagesForMutation(targetSessionId);
                if (existingMessages.length !== input.targetMessages.length
                    || existingMessages.some((message, index) => message.id !== input.targetMessages[index]?.id)) {
                    return dshMutationFailure('storage_consistency_error', 'The staged DSH fork transcript conflicts');
                }
            } else if (staged.value.transcriptFormat === 2) {
                const copied = await copyForkAttachments(input.targetMessages, targetSessionId);
                const projection = createTranscriptProjection();
                for (const message of copied) projection.messages.set(message.id, fromStoredTranscriptMessage(message));
                const generation = randomUUID();
                const candidate = new TranscriptFile({
                    sessionId: targetSessionId, filePath: targetPath, generation, allowCreate: true,
                    // Both source and target file locks already belong to this mutation.
                    withLock: run => run(),
                });
                try { await candidate.replace({ generation, revision: 0 }, projection, 0); }
                catch (error) { await candidate.discardCandidate(); throw error; }
            } else {
                atomicRewriteSessionMessages(targetSessionId, input.targetMessages);
            }
            return staged;
        });
    } catch (error) {
        return dshMutationFailure(
            error instanceof MalformedSessionTranscriptError ? 'storage_consistency_error' : 'write_error',
            error instanceof Error ? error.message : String(error),
        );
    }
}

/** Publish the staged Product branch and retire the source journal in one index write. */
export async function commitDshForkProduct(input: {
    sourceSessionId: string;
    clientMutationId: string;
    token: string;
}): Promise<DshMutationStoreResult<SessionMetadata>> {
    ensureStorageDir();
    try {
        const source = getSessionMetadata(input.sourceSessionId);
        const pending = source && exactPendingDshMutation(source, input.clientMutationId);
        if (pending?.kind !== 'dsh-fork') {
            return dshMutationFailure('precondition_failed', 'The DSH fork journal is unavailable');
        }
        return await withSessionFileLocks(
            [input.sourceSessionId, pending.targetProductSessionId],
            async () => withSessionsLock(async () => {
                const all = readDshSessionsIndexForWrite(input.sourceSessionId);
                const sourceIndex = all.findIndex(session => session.id === input.sourceSessionId);
                const targetIndex = all.findIndex(session => session.id === pending.targetProductSessionId);
                const currentSource = sourceIndex >= 0 ? all[sourceIndex] : undefined;
                const currentPending = currentSource
                    && exactPendingDshMutation(currentSource, input.clientMutationId);
                const target = targetIndex >= 0 ? all[targetIndex] : undefined;
                if (
                    !currentSource
                    || currentPending?.kind !== 'dsh-fork'
                    || currentPending.token !== input.token
                    || !target
                    || target.materializationState !== 'prepared'
                    || target.materializationSourceSessionId !== input.sourceSessionId
                ) {
                    return dshMutationFailure('precondition_failed', 'The staged DSH fork changed before commit');
                }
                const targetMessages = await readDshMessagesForMutation(target.id);
                if (targetMessages.length !== currentPending.targetMessageCount) {
                    return dshMutationFailure('storage_consistency_error', 'The staged DSH fork transcript is incomplete');
                }
                const committedTarget: SessionMetadata = {
                    ...target,
                    materializationState: undefined,
                    materializationSourceSessionId: undefined,
                };
                all[sourceIndex] = { ...currentSource, pendingDshMutation: undefined };
                all[targetIndex] = committedTarget;
                writeDshSessionsIndex(all, input.sourceSessionId);
                return { success: true, value: committedTarget };
            }),
        );
    } catch (error) {
        return dshMutationFailure(
            error instanceof MalformedSessionTranscriptError ? 'storage_consistency_error' : 'write_error',
            error instanceof Error ? error.message : String(error),
        );
    }
}

/** Remove an invisible Product fork after DSH durably reports abort. */
export async function abortDshForkProduct(input: {
    sourceSessionId: string;
    clientMutationId: string;
}): Promise<DshMutationStoreResult<SessionMetadata>> {
    ensureStorageDir();
    try {
        const source = getSessionMetadata(input.sourceSessionId);
        const pending = source && exactPendingDshMutation(source, input.clientMutationId);
        if (pending?.kind !== 'dsh-fork') {
            return dshMutationFailure('precondition_failed', 'The DSH fork journal is unavailable');
        }
        return await withSessionFileLocks(
            [input.sourceSessionId, pending.targetProductSessionId],
            async () => withSessionsLock(async () => {
                const all = readDshSessionsIndexForWrite(input.sourceSessionId);
                const sourceIndex = all.findIndex(session => session.id === input.sourceSessionId);
                const currentSource = sourceIndex >= 0 ? all[sourceIndex] : undefined;
                const currentPending = currentSource
                    && exactPendingDshMutation(currentSource, input.clientMutationId);
                if (!currentSource || currentPending?.kind !== 'dsh-fork') {
                    return dshMutationFailure('precondition_failed', 'The DSH fork journal changed');
                }
                const targetIndex = all.findIndex(session => session.id === currentPending.targetProductSessionId);
                const target = targetIndex >= 0 ? all[targetIndex] : undefined;
                if (target && (
                    target.materializationState !== 'prepared'
                    || target.materializationSourceSessionId !== input.sourceSessionId
                )) {
                    return dshMutationFailure('storage_consistency_error', 'The DSH fork target is no longer rollback-owned');
                }
                if (target) {
                    const targetJsonl = getSessionFilePath(target.id);
                    const targetLegacy = getLegacySessionFilePath(target.id);
                    if (existsSync(targetJsonl)) unlinkSync(targetJsonl);
                    if (existsSync(targetLegacy)) unlinkSync(targetLegacy);
                    const targetV2 = getV2SessionFilePath(target.id);
                    if (existsSync(targetV2)) unlinkSync(targetV2);
                    await discardForkAttachments(target.id);
                }
                const updatedSource = { ...currentSource, pendingDshMutation: undefined };
                all[sourceIndex] = updatedSource;
                if (target) all.splice(targetIndex, 1);
                writeDshSessionsIndex(all, input.sourceSessionId);
                return { success: true, value: updatedSource };
            }),
        );
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

/** Persist the immutable Product half of a DSH rewind before Runtime prepare. */
export async function beginDshRewindMutation(input: {
    sessionId: string;
    targetUserMessageId: string;
    clientMutationId: string;
}): Promise<DshMutationStoreResult<{
    intent: PendingDshRewind;
    targetUserMessage: SessionMessage;
    targetMessages: SessionMessage[];
}>> {
    ensureStorageDir();
    try {
        const activeSource = getActiveSessionTranscript(input.sessionId);
        if (activeSource && !(await activeSource.writer.flushForMutation())) {
            return dshMutationFailure('write_error', 'Save the complete DSH conversation before this explicit mutation');
        }
        return await withSessionFileLock(input.sessionId, async () => {
            const messages = await readDshMessagesForMutation(input.sessionId);
            const targetUserIndex = messages.findIndex(message => (
                message.id === input.targetUserMessageId && message.role === 'user'
            ));
            const targetUserMessage = targetUserIndex >= 0 ? messages[targetUserIndex] : undefined;
            const priorAssistant = targetUserIndex > 0
                ? messages.slice(0, targetUserIndex).findLast(message => message.role === 'assistant')
                : undefined;
            if (!targetUserMessage || (priorAssistant && !priorAssistant.runtimeTurnAnchor)) {
                return dshMutationFailure(
                    'precondition_failed',
                    'This message has no exact preceding DSH boundary identity',
                );
            }
            const targetRuntimeTurnId = priorAssistant?.runtimeTurnAnchor?.turnId ?? null;
            const targetMessages = messages.slice(0, targetUserIndex);
            return withSessionsLock(async () => {
                const all = readDshSessionsIndexForWrite(input.sessionId);
                const index = all.findIndex(session => session.id === input.sessionId);
                const current = index >= 0 ? all[index] : undefined;
                if (!current) return dshMutationFailure('precondition_failed', 'The DSH Session is unavailable');
                const existing = exactPendingDshMutation(current, input.clientMutationId);
                if (existing?.kind === 'dsh-rewind') {
                    return {
                        success: true,
                        value: { intent: existing, targetUserMessage, targetMessages },
                    };
                }
                if (
                    !sessionUsesDsh(current)
                    || !current.runtimeSessionId
                    || current.pendingDshMutation
                    || current.pendingDshRootOperation
                    || (current.pendingDshInputs?.length ?? 0) > 0
                ) {
                    return dshMutationFailure('precondition_failed', 'The DSH rewind source changed');
                }
                const intent: PendingDshRewind = {
                    schemaVersion: 1,
                    kind: 'dsh-rewind',
                    clientMutationId: input.clientMutationId,
                    sourceRuntimeSessionId: current.runtimeSessionId,
                    sourceMessageCount: messages.length,
                    targetUserMessageId: input.targetUserMessageId,
                    targetRuntimeTurnId,
                    targetMessageCount: targetMessages.length,
                };
                all[index] = { ...current, pendingDshMutation: intent };
                writeDshSessionsIndex(all, input.sessionId);
                return {
                    success: true,
                    value: { intent, targetUserMessage, targetMessages },
                };
            });
        });
    } catch (error) {
        return dshMutationFailure(
            error instanceof MalformedSessionTranscriptError ? 'storage_consistency_error' : 'write_error',
            error instanceof Error ? error.message : String(error),
        );
    }
}

export async function recordPreparedDshRewind(input: {
    sessionId: string;
    clientMutationId: string;
    token: string;
    targetStableBoundaryId: string;
    sourceTranscriptPostcondition: string;
    targetTranscriptPostcondition: string;
}): Promise<DshMutationStoreResult<PendingDshRewind>> {
    ensureStorageDir();
    try {
        return await withSessionFileLock(input.sessionId, async () => withSessionsLock(async () => {
            const all = readDshSessionsIndexForWrite(input.sessionId);
            const index = all.findIndex(session => session.id === input.sessionId);
            const current = index >= 0 ? all[index] : undefined;
            const pending = current && exactPendingDshMutation(current, input.clientMutationId);
            if (!current || pending?.kind !== 'dsh-rewind') {
                return dshMutationFailure('precondition_failed', 'The DSH rewind intent changed');
            }
            for (const [stored, incoming] of [
                [pending.token, input.token],
                [pending.targetStableBoundaryId, input.targetStableBoundaryId],
                [pending.sourceTranscriptPostcondition, input.sourceTranscriptPostcondition],
                [pending.targetTranscriptPostcondition, input.targetTranscriptPostcondition],
            ]) {
                if (stored && stored !== incoming) {
                    return dshMutationFailure('storage_consistency_error', 'The DSH rewind receipt changed');
                }
            }
            const updatedIntent: PendingDshRewind = {
                ...pending,
                token: input.token,
                targetStableBoundaryId: input.targetStableBoundaryId,
                sourceTranscriptPostcondition: input.sourceTranscriptPostcondition,
                targetTranscriptPostcondition: input.targetTranscriptPostcondition,
            };
            all[index] = { ...current, pendingDshMutation: updatedIntent };
            writeDshSessionsIndex(all, input.sessionId);
            return { success: true, value: updatedIntent };
        }));
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

/** Finish the Product transcript half after DSH has committed its generation. */
export async function commitDshRewindProduct(input: {
    sessionId: string;
    clientMutationId: string;
    token: string;
}): Promise<DshMutationStoreResult<{ metadata: SessionMetadata; messages: SessionMessage[] }>> {
    ensureStorageDir();
    try {
        return await withSessionFileLock(input.sessionId, async () => {
            let messages = await readDshMessagesForMutation(input.sessionId);
            return withSessionsLock(async () => {
                const all = readDshSessionsIndexForWrite(input.sessionId);
                const index = all.findIndex(session => session.id === input.sessionId);
                const current = index >= 0 ? all[index] : undefined;
                const pending = current && exactPendingDshMutation(current, input.clientMutationId);
                if (!current || pending?.kind !== 'dsh-rewind' || pending.token !== input.token) {
                    return dshMutationFailure('precondition_failed', 'The DSH rewind journal changed before commit');
                }
                const stamp = pending.transcript;
                const active = getActiveSessionTranscript(input.sessionId);
                const committedTarget = stamp && active?.writer.status.generation === stamp.targetGeneration
                    && active.writer.status.durableRevision >= stamp.targetRevision;
                if (stamp && !committedTarget && active?.writer.status.generation !== stamp.sourceGeneration) {
                    return dshMutationFailure('storage_consistency_error', 'The DSH rewind transcript generation is ambiguous');
                }
                if (committedTarget) {
                    // The named replacement already landed; later admitted rows
                    // belong to that generation and must survive journal recovery.
                } else if (messages.length >= pending.sourceMessageCount) {
                    const recoveredTail = messages.slice(pending.sourceMessageCount);
                    const inputs = [...(current.pendingDshRootInputs ?? []), ...(current.pendingDshInputs ?? []),
                        ...(current.pendingDshRootOperation ? [current.pendingDshRootOperation] : [])];
                    for (const message of recoveredTail) {
                        const journal = inputs.find(item => item.clientUserMessageId === message.id);
                        if (!journal || message.role !== 'user') return dshMutationFailure('storage_consistency_error', 'The DSH rewind has an unowned trailing message');
                        assertDshProductInputMatches(journal, message);
                    }
                    const targetIndex = messages.findIndex(message => (
                        message.id === pending.targetUserMessageId && message.role === 'user'
                    ));
                    if (targetIndex !== pending.targetMessageCount) {
                        return dshMutationFailure('storage_consistency_error', 'The DSH rewind target changed');
                    }
                    messages = [...messages.slice(0, pending.targetMessageCount), ...recoveredTail];
                    rewriteDshMessages(input.sessionId, messages);
                } else if (messages.length !== pending.targetMessageCount) {
                    return dshMutationFailure('storage_consistency_error', 'The DSH rewind transcript has an unknown length');
                }
                const { preview } = resolveLastVisibleTurnPreview(messages);
                const updated: SessionMetadata = {
                    ...current,
                    pendingDshMutation: undefined,
                    runtimeUsageTotals: undefined,
                    lastContextUsage: undefined,
                    stats: calculateSessionStats(messages),
                    lastMessagePreview: preview,
                };
                all[index] = updated;
                writeDshSessionsIndex(all, input.sessionId, true);
                return { success: true, value: { metadata: updated, messages } };
            });
        });
    } catch (error) {
        return dshMutationFailure(
            error instanceof MalformedSessionTranscriptError ? 'storage_consistency_error' : 'write_error',
            error instanceof Error ? error.message : String(error),
        );
    }
}

/** Clear an uncommitted/rolled-back DSH journal without weakening exact identity checks. */
export async function clearPendingDshMutation(input: {
    sessionId: string;
    clientMutationId: string;
}): Promise<DshMutationStoreResult<SessionMetadata>> {
    ensureStorageDir();
    try {
        return await withSessionFileLock(input.sessionId, async () => withSessionsLock(async () => {
            const all = readDshSessionsIndexForWrite(input.sessionId);
            const index = all.findIndex(session => session.id === input.sessionId);
            const current = index >= 0 ? all[index] : undefined;
            if (!current || !exactPendingDshMutation(current, input.clientMutationId)) {
                return dshMutationFailure('precondition_failed', 'The DSH mutation journal changed');
            }
            const updated = { ...current, pendingDshMutation: undefined };
            all[index] = updated;
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            getActiveSessionTranscript(input.sessionId)?.adoptExecutionMetadata(updated, DSH_EXECUTION_METADATA_KEYS);
            return { success: true, value: updated };
        }));
    } catch (error) {
        return dshMutationFailure('write_error', error instanceof Error ? error.message : String(error));
    }
}

type CodexRewindIntent = Extract<PendingConversationMutation, { kind: 'codex-rewind' }>;
type BuiltinRewindIntent = Extract<PendingConversationMutation, { kind: 'builtin-rewind' }>;

function conversationMutationSuccess(
    sessionId: string,
    metadata: SessionMetadata,
    messages: SessionMessage[],
): ConversationMutationResult {
    return {
        success: true,
        metadata,
        messages,
        cursor: activeTranscripts.has(sessionId) ? snapshotActiveTranscript(activeTranscripts.get(sessionId)!).cursor : issueTranscriptCursor(
            sessionId,
            messages.length,
            getTranscriptFileIdentity(getSessionFilePath(sessionId)),
        ),
    };
}

function finalizeCodexRewindMetadata(
    current: SessionMetadata,
    intent: CodexRewindIntent,
    messages: SessionMessage[],
): SessionMetadata {
    const { preview } = resolveLastVisibleTurnPreview(messages);
    return {
        ...current,
        runtimeSessionId: intent.replacementRuntimeSessionId ?? undefined,
        pendingConversationMutation: undefined,
        runtimeUsageTotals: undefined,
        lastContextUsage: undefined,
        stats: calculateSessionStats(messages),
        lastMessagePreview: preview,
    };
}

function finalizeBuiltinRewindMetadata(
    current: SessionMetadata,
    intent: BuiltinRewindIntent,
    messages: SessionMessage[],
): SessionMetadata {
    const { preview } = resolveLastVisibleTurnPreview(messages);
    return {
        ...current,
        sdkSessionId: intent.replacementSdkSessionId,
        sdkResumeSessionAt: intent.resumeSessionAt,
        unifiedSession: false,
        forkFrom: intent.resumeSessionAt ? current.forkFrom : undefined,
        pendingConversationMutation: undefined,
        runtimeUsageTotals: undefined,
        lastContextUsage: undefined,
        stats: calculateSessionStats(messages),
        lastMessagePreview: preview,
    };
}

async function resolvePendingConversationMutationLocked(
    sessionId: string,
): Promise<ConversationMutationResult> {
    const messages = readSessionMessagesForMutation(sessionId);
    return withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const index = all.findIndex(session => session.id === sessionId);
        if (index < 0) {
            return { success: false, reason: 'precondition_failed', error: 'Session metadata is missing' };
        }
        const current = all[index];
        const intent = current.pendingConversationMutation;
        if (!intent) return conversationMutationSuccess(sessionId, current, messages);
        if (intent.schemaVersion !== 1 || (intent.kind !== 'codex-rewind' && intent.kind !== 'builtin-rewind')) {
            return { success: false, reason: 'storage_consistency_error', error: 'Unknown conversation mutation intent' };
        }

        const sourceBindingMatches = intent.kind === 'codex-rewind'
            ? current.runtimeSessionId === intent.sourceRuntimeSessionId
            : (resolveBuiltinSdkSessionId(current) ?? null) === intent.sourceSdkSessionId;
        if (!sourceBindingMatches) {
            return {
                success: false,
                reason: 'storage_consistency_error',
                error: 'Conversation mutation source binding mismatch',
            };
        }

        if (messages.length === intent.sourceMessageCount) {
            const restored = { ...current, pendingConversationMutation: undefined };
            all[index] = restored;
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            return conversationMutationSuccess(sessionId, restored, messages);
        }
        if (messages.length === intent.targetMessageCount) {
            const completed = intent.kind === 'codex-rewind'
                ? finalizeCodexRewindMetadata(current, intent, messages)
                : finalizeBuiltinRewindMetadata(current, intent, messages);
            all[index] = completed;
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            return conversationMutationSuccess(sessionId, completed, messages);
        }
        return {
            success: false,
            reason: 'storage_consistency_error',
            error: `Conversation mutation count mismatch: expected ${intent.sourceMessageCount} or ${intent.targetMessageCount}, found ${messages.length}`,
        };
    });
}

/** Resolve a bounded rewind intent before a Session may resume or send. */
export async function resolvePendingConversationMutation(
    sessionId: string,
): Promise<ConversationMutationResult> {
    if (getSessionMetadata(sessionId)?.transcriptFormat !== undefined) {
        try {
            const active = await activateSessionTranscript(sessionId);
            if (!active) return { success: false, reason: 'precondition_failed', error: 'Session metadata is missing' };
            return conversationMutationSuccess(sessionId, active.metadata, transcriptMessages(active.writer.projection));
        } catch (error) {
            return { success: false, reason: 'storage_consistency_error', error: error instanceof Error ? error.message : String(error) };
        }
    }
    ensureStorageDir();
    try {
        return await withSessionFileLock(sessionId, () => resolvePendingConversationMutationLocked(sessionId));
    } catch (error) {
        return {
            success: false,
            reason: error instanceof MalformedSessionTranscriptError
                ? 'storage_consistency_error'
                : 'write_error',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Commit transcript truncation and native binding replacement under one recoverable intent. */
export async function commitCodexConversationRewind(input: {
    sessionId: string;
    sourceRuntimeSessionId: string;
    replacementRuntimeSessionId: string | null;
    sourceMessages: SessionMessage[];
    targetMessages: SessionMessage[];
}): Promise<ConversationMutationResult> {
    if (getSessionMetadata(input.sessionId)?.transcriptFormat !== undefined) {
        return commitV2ConversationMutation(input.sessionId, {
            schemaVersion: 1, kind: 'codex-rewind', sourceRuntimeSessionId: input.sourceRuntimeSessionId,
            replacementRuntimeSessionId: input.replacementRuntimeSessionId,
            sourceMessageCount: input.sourceMessages.length, targetMessageCount: input.targetMessages.length,
        }, input.targetMessages.map(message => message.id), input.sourceMessages.map(message => message.id));
    }
    ensureStorageDir();
    if (
        input.targetMessages.length >= input.sourceMessages.length
        || input.targetMessages.some((message, index) => message.id !== input.sourceMessages[index]?.id)
    ) {
        return { success: false, reason: 'precondition_failed', error: 'Rewind target is not a strict transcript prefix' };
    }
    const intent: PendingConversationMutation = {
        schemaVersion: 1,
        kind: 'codex-rewind',
        sourceRuntimeSessionId: input.sourceRuntimeSessionId,
        replacementRuntimeSessionId: input.replacementRuntimeSessionId,
        sourceMessageCount: input.sourceMessages.length,
        targetMessageCount: input.targetMessages.length,
    };

    try {
        return await withSessionFileLock(input.sessionId, async () => {
            const durableMessages = readSessionMessagesForMutation(input.sessionId);
            if (
                durableMessages.length !== input.sourceMessages.length
                || durableMessages.some((message, index) => message.id !== input.sourceMessages[index]?.id)
            ) {
                return { success: false, reason: 'precondition_failed', error: 'Session transcript changed before rewind' };
            }

            const intentWritten = await withSessionsLock(async () => {
                const all = readSessionsIndexForWrite();
                const index = all.findIndex(session => session.id === input.sessionId);
                if (index < 0) return false;
                const current = all[index];
                if (
                    current.runtime !== 'codex'
                    || current.runtimeSessionId !== input.sourceRuntimeSessionId
                    || current.pendingConversationMutation
                ) return false;
                all[index] = { ...current, pendingConversationMutation: intent };
                atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                return true;
            });
            if (!intentWritten) {
                return { success: false, reason: 'precondition_failed', error: 'Session binding changed before rewind' };
            }

            try {
                atomicRewriteSessionMessages(input.sessionId, input.targetMessages);
                return await resolvePendingConversationMutationLocked(input.sessionId);
            } catch (error) {
                const recovered = await resolvePendingConversationMutationLocked(input.sessionId);
                if (
                    recovered.success
                    && recovered.messages.length === input.targetMessages.length
                    && recovered.messages.every((message, index) => message.id === input.targetMessages[index]?.id)
                ) return recovered;
                if (!recovered.success && recovered.reason === 'storage_consistency_error') return recovered;
                return {
                    success: false,
                    reason: 'write_error',
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        });
    } catch (error) {
        return {
            success: false,
            reason: error instanceof MalformedSessionTranscriptError
                ? 'storage_consistency_error'
                : 'write_error',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Atomically bind a shortened builtin transcript to one exact replacement SDK
 * identity. Product Session identity is deliberately not writable here.
 */
export async function commitBuiltinConversationRewind(input: {
    sessionId: string;
    cursor: TranscriptWriteCursor;
    sourceSdkSessionId: string | null;
    replacementSdkSessionId: string;
    resumeSessionAt?: string;
    targetMessageId: string;
    targetMessageCount: number;
}): Promise<ConversationMutationResult> {
    if (input.cursor[transcriptCursorState].v2) {
        const active = activeTranscripts.get(input.sessionId);
        if (!active || !v2CursorMatches(active, input.cursor)) return { success: false, reason: 'precondition_failed', error: 'Stale V2 rewind cursor' };
        const source = transcriptMessages(active.writer.projection);
        const derived = deriveTranscriptMutationTarget(source, { kind: 'builtin-rewind', targetMessageId: input.targetMessageId, targetMessageCount: input.targetMessageCount });
        if (!derived.ok || !derived.target) return { success: false, reason: 'precondition_failed', error: derived.ok ? 'Empty rewind target' : derived.error };
        return commitV2ConversationMutation(input.sessionId, {
            schemaVersion: 1, kind: 'builtin-rewind', sourceSdkSessionId: input.sourceSdkSessionId,
            replacementSdkSessionId: input.replacementSdkSessionId, resumeSessionAt: input.resumeSessionAt,
            sourceMessageCount: source.length, targetMessageCount: derived.target.length,
        }, derived.target.map(message => message.id), source.map(message => message.id));
    }
    ensureStorageDir();
    if (input.sourceSdkSessionId === input.replacementSdkSessionId && !input.resumeSessionAt) {
        return { success: false, reason: 'precondition_failed', error: 'Replacement SDK identity must be fresh' };
    }

    const intent: BuiltinRewindIntent = {
        schemaVersion: 1,
        kind: 'builtin-rewind',
        sourceSdkSessionId: input.sourceSdkSessionId,
        replacementSdkSessionId: input.replacementSdkSessionId, resumeSessionAt: input.resumeSessionAt,
        sourceMessageCount: input.cursor.persistedMessageCount,
        targetMessageCount: input.targetMessageCount,
    };

    try {
        return await withSessionFileLock(input.sessionId, async () => {
            const filePath = getSessionFilePath(input.sessionId);
            const currentFile = getTranscriptFileIdentity(filePath);
            if (!cursorMatches(input.sessionId, input.cursor, currentFile)) {
                return {
                    success: false,
                    reason: 'precondition_failed',
                    error: 'stale-cursor: Session transcript changed after the cursor was issued',
                };
            }

            const source = readJsonlSnapshot(filePath);
            if (source.hasMalformedRows) throw new MalformedSessionTranscriptError(input.sessionId);
            if (source.messages.length !== input.cursor.persistedMessageCount) {
                return {
                    success: false,
                    reason: 'precondition_failed',
                    error: 'stale-cursor: Cursor message count does not match durable transcript',
                };
            }

            const derived = deriveTranscriptMutationTarget(source.messages, {
                kind: 'builtin-rewind',
                targetMessageId: input.targetMessageId,
                targetMessageCount: input.targetMessageCount,
            });
            if (!derived.ok || !derived.target || derived.target.length >= source.messages.length) {
                return {
                    success: false,
                    reason: 'precondition_failed',
                    error: derived.ok ? 'Rewind target is not a strict transcript prefix' : derived.error,
                };
            }

            const intentWritten = await withSessionsLock(async () => {
                const all = readSessionsIndexForWrite();
                const index = all.findIndex(session => session.id === input.sessionId);
                if (index < 0) return false;
                const current = all[index];
                if (
                    (current.runtime ?? 'builtin') !== 'builtin'
                    || (resolveBuiltinSdkSessionId(current) ?? null) !== input.sourceSdkSessionId
                    || current.pendingConversationMutation
                ) return false;
                all[index] = { ...current, pendingConversationMutation: intent };
                atomicWriteSessionsFile(JSON.stringify(all, null, 2));
                return true;
            });
            if (!intentWritten) {
                return { success: false, reason: 'precondition_failed', error: 'Session binding changed before rewind' };
            }

            try {
                atomicRewriteSessionMessages(input.sessionId, derived.target);
                return await resolvePendingConversationMutationLocked(input.sessionId);
            } catch (error) {
                const recovered = await resolvePendingConversationMutationLocked(input.sessionId);
                if (
                    recovered.success
                    && recovered.messages.length === derived.target.length
                    && recovered.messages.every((message, index) => message.id === derived.target?.[index]?.id)
                ) return recovered;
                if (!recovered.success && recovered.reason === 'storage_consistency_error') return recovered;
                return {
                    success: false,
                    reason: 'write_error',
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        });
    } catch (error) {
        return {
            success: false,
            reason: error instanceof MalformedSessionTranscriptError
                ? 'storage_consistency_error'
                : 'write_error',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Calculate session statistics from messages
 */
export function calculateSessionStats(messages: readonly Pick<SessionMessage, 'role' | 'usage'>[]): SessionStats {
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

export type AppendSessionMessagesResult =
    | { ok: true; action: 'appended' | 'noop'; count: number; totalCount: number; cursor: TranscriptWriteCursor }
    | { ok: false; reason: 'unindexed-create-refused' | 'write-error'; error: string; cursor: TranscriptWriteCursor }
    | { ok: false; reason: 'stale-cursor' | 'storage-consistency-error'; error: string };

export type TranscriptMutationIntent =
    | { kind: 'builtin-rewind'; targetMessageId: string; targetMessageCount: number }
    | { kind: 'dsh-unadmitted-retry'; targetMessageId: string; targetMessageCount: number }
    | { kind: 'sdk-retraction'; sdkUuids: readonly string[]; streamingTailMessageId?: string }
    | { kind: 'builtin-admission-rollback'; messageId: string }
    | { kind: 'builtin-transient-retry'; messageId: string }
    | { kind: 'external-rejected-message'; messageId: string };

export type MutateSessionTranscriptResult =
    | { ok: true; action: 'replaced' | 'noop'; cursor: TranscriptWriteCursor }
    | { ok: false; reason: 'stale-cursor' | 'precondition-failed' | 'malformed-transcript' | 'write-error'; error: string };

function appendHasExpectedLineage(
    before: TranscriptFileIdentity,
    after: TranscriptFileIdentity,
): boolean {
    if (!before.exists) return after.exists;
    if (!after.exists || before.dev !== after.dev) return false;
    return before.ino === 0 || after.ino === 0 || before.ino === after.ino;
}

function appendedSuffixMatches(
    filePath: string,
    before: TranscriptFileIdentity,
    after: TranscriptFileIdentity,
    bytes: Buffer,
    mode: 'exact' | 'prefix',
): boolean {
    if (!appendHasExpectedLineage(before, after) || after.size < before.size) return false;
    const suffixLength = after.size - before.size;
    if (mode === 'exact' ? suffixLength !== bytes.length : suffixLength >= bytes.length) return false;
    const content = readFileSync(filePath);
    const suffix = content.subarray(before.size);
    return mode === 'exact' ? suffix.equals(bytes) : bytes.subarray(0, suffix.length).equals(suffix);
}

async function updateStatsAfterAppend(sessionId: string, messages: SessionMessage[]): Promise<void> {
    const delta = calculateSessionStats(messages);
    try {
        await withSessionsLock(async () => {
            const all = readSessionsIndexForWrite();
            const index = all.findIndex(session => session.id === sessionId);
            if (index < 0) {
                console.warn(`[SessionStore] appended ${messages.length} message(s) to unindexed session ${sessionId}; stats not updated`);
                return;
            }
            const current = all[index];
            const stats = current.stats ?? { messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0 };
            all[index] = {
                ...current,
                stats: {
                    messageCount: stats.messageCount + delta.messageCount,
                    totalInputTokens: stats.totalInputTokens + delta.totalInputTokens,
                    totalOutputTokens: stats.totalOutputTokens + delta.totalOutputTokens,
                    totalCacheReadTokens: ((stats.totalCacheReadTokens ?? 0) + (delta.totalCacheReadTokens ?? 0)) || undefined,
                    totalCacheCreationTokens: ((stats.totalCacheCreationTokens ?? 0) + (delta.totalCacheCreationTokens ?? 0)) || undefined,
                },
            };
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
        });
    } catch (error) {
        console.warn(`[SessionStore] Transcript append committed for ${sessionId}, but stats update failed:`, error);
    }
}

async function replaceDerivedTranscriptProjection(
    sessionId: string,
    messages: SessionMessage[],
): Promise<void> {
    try {
        await withSessionsLock(async () => {
            const all = readSessionsIndexForWrite();
            const index = all.findIndex(session => session.id === sessionId);
            if (index < 0) return;
            const { preview } = resolveLastVisibleTurnPreview(messages);
            all[index] = {
                ...all[index],
                stats: calculateSessionStats(messages),
                lastMessagePreview: preview,
            };
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
        });
    } catch (error) {
        console.warn(`[SessionStore] Transcript mutation committed for ${sessionId}, but derived metadata update failed:`, error);
    }
}

/** Append only caller-supplied tail rows when the issued durable cursor is current. */
export async function appendSessionMessages(
    sessionId: string,
    cursor: TranscriptWriteCursor,
    messages: readonly SessionMessage[],
): Promise<AppendSessionMessagesResult> {
    const v2 = cursor[transcriptCursorState].v2;
    if (v2) {
        const active = activeTranscripts.get(sessionId) ?? await activateSessionTranscript(sessionId);
        if (!active || cursor[transcriptCursorState].sessionId !== sessionId
            || (v2.instanceId && (v2.instanceId !== active.writer.status.instanceId || v2.liveRevision !== active.writer.status.liveRevision))
            || v2.generation !== active.writer.status.generation) {
            return { ok: false, reason: 'stale-cursor', error: 'V2 transcript changed before explicit append' };
        }
        for (const message of messages) {
            active.writer.observe({ kind: 'message-create', message: fromStoredTranscriptMessage(message) });
        }
        if (messages.length) {
            const projection = transcriptMessages(active.writer.projection);
            active.patchMetadata({ stats: calculateSessionStats(projection), lastMessagePreview: resolveLastVisibleTurnPreview(projection).preview });
        }
        if (!await active.writer.flush()) return { ok: false, reason: 'write-error', error: 'V2 append could not confirm saving', cursor };
        const snapshot = snapshotActiveTranscript(active);
        return { ok: true, action: messages.length ? 'appended' : 'noop', count: messages.length, totalCount: snapshot.messages.length, cursor: snapshot.cursor };
    }
    if (getSessionMetadata(sessionId)?.transcriptFormat !== undefined || await pathExists(getV2SessionFilePath(sessionId))) {
        return { ok: false, reason: 'storage-consistency-error', error: 'Legacy cursor cannot write a versioned transcript' };
    }
    ensureStorageDir();
    const filePath = getSessionFilePath(sessionId);
    try {
        return await withSessionFileLock(sessionId, async () => {
            const before = cursor[transcriptCursorState].file;
            const needsSeparator = before.exists && before.size > 0 && !before.endsWithNewline;
            const serialized = `${needsSeparator ? '\n' : ''}${messages.map(message => JSON.stringify(message)).join('\n')}${messages.length > 0 ? '\n' : ''}`;
            const bytes = Buffer.from(serialized, 'utf-8');
            const current = getTranscriptFileIdentity(filePath);

            if (!cursorMatches(sessionId, cursor, current)) {
                if (messages.length > 0 && appendedSuffixMatches(filePath, before, current, bytes, 'exact')) {
                    const recoveredCursor = issueTranscriptCursor(
                        sessionId,
                        cursor.persistedMessageCount + messages.length,
                        current,
                    );
                    await replaceDerivedTranscriptProjection(sessionId, readJsonlSnapshot(filePath).messages);
                    return { ok: true, action: 'appended', count: messages.length, totalCount: recoveredCursor.persistedMessageCount, cursor: recoveredCursor };
                }
                return { ok: false, reason: 'stale-cursor', error: 'Session transcript changed after the cursor was issued' };
            }
            if (messages.length === 0) {
                return { ok: true, action: 'noop', count: 0, totalCount: cursor.persistedMessageCount, cursor };
            }
            if (!current.exists && !getSessionMetadata(sessionId)) {
                return {
                    ok: false,
                    reason: 'unindexed-create-refused',
                    error: 'Session metadata is missing; refused to create transcript',
                    cursor,
                };
            }

            const startedAt = nowMs();
            try {
                appendFileSync(filePath, bytes);
            } catch (error) {
                const afterFailure = getTranscriptFileIdentity(filePath);
                if (sameTranscriptFileIdentity(before, afterFailure)) {
                    return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error), cursor };
                }
                if (appendedSuffixMatches(filePath, before, afterFailure, bytes, 'exact')) {
                    const recoveredCursor = issueTranscriptCursor(sessionId, cursor.persistedMessageCount + messages.length, afterFailure);
                    await updateStatsAfterAppend(sessionId, [...messages]);
                    return { ok: true, action: 'appended', count: messages.length, totalCount: recoveredCursor.persistedMessageCount, cursor: recoveredCursor };
                }
                if (appendedSuffixMatches(filePath, before, afterFailure, bytes, 'prefix')) {
                    try {
                        truncateSync(filePath, before.size);
                        const repaired = getTranscriptFileIdentity(filePath);
                        const repairedCursor = issueTranscriptCursor(sessionId, cursor.persistedMessageCount, repaired);
                        return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error), cursor: repairedCursor };
                    } catch (repairError) {
                        return { ok: false, reason: 'storage-consistency-error', error: repairError instanceof Error ? repairError.message : String(repairError) };
                    }
                }
                return { ok: false, reason: 'storage-consistency-error', error: error instanceof Error ? error.message : String(error) };
            }

            let after: TranscriptFileIdentity;
            try {
                after = getTranscriptFileIdentity(filePath);
                if (!appendedSuffixMatches(filePath, before, after, bytes, 'exact')) {
                    return { ok: false, reason: 'storage-consistency-error', error: 'Append completed without the expected durable suffix' };
                }
            } catch (error) {
                return {
                    ok: false,
                    reason: 'storage-consistency-error',
                    error: error instanceof Error ? error.message : String(error),
                };
            }
            emitPerfTrace({
                trace: 'storage_io',
                phase: 'session_jsonl_append',
                sessionId,
                durationMs: elapsedMs(startedAt),
                sizeBytes: bytes.length,
                count: messages.length,
                status: 'ok',
            });
            await updateStatsAfterAppend(sessionId, [...messages]);
            const nextCursor = issueTranscriptCursor(sessionId, cursor.persistedMessageCount + messages.length, after);
            return { ok: true, action: 'appended', count: messages.length, totalCount: nextCursor.persistedMessageCount, cursor: nextCursor };
        });
    } catch (error) {
        return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error), cursor };
    }
}

function deriveTranscriptMutationTarget(
    messages: SessionMessage[],
    intent: TranscriptMutationIntent,
): { ok: true; target: SessionMessage[] | null } | { ok: false; error: string } {
    if (intent.kind === 'builtin-rewind' || intent.kind === 'dsh-unadmitted-retry') {
        const targetId = intent.targetMessageId;
        const targetIndex = messages.findIndex(message => message.id === targetId && message.role === 'user');
        if (targetIndex < 0) {
            return intent.targetMessageCount >= messages.length
                ? { ok: true, target: null }
                : { ok: false, error: 'Mutation target is missing from the proven durable prefix' };
        }
        if (targetIndex !== intent.targetMessageCount) {
            return { ok: false, error: 'Mutation target index does not match the durable transcript' };
        }
        return { ok: true, target: messages.slice(0, targetIndex) };
    }
    if (intent.kind === 'sdk-retraction') {
        const sdkUuids = new Set(intent.sdkUuids);
        const target = messages.filter(message => (
            (message.role !== 'assistant' || !message.sdkUuid || !sdkUuids.has(message.sdkUuid))
            && message.id !== intent.streamingTailMessageId
        ));
        return { ok: true, target: target.length === messages.length ? null : target };
    }
    const target = messages.filter(message => message.id !== intent.messageId);
    return { ok: true, target: target.length === messages.length ? null : target };
}

function v2CursorMatches(active: SessionTranscript, cursor: TranscriptWriteCursor): boolean {
    const stamp = cursor[transcriptCursorState];
    const current = active.writer.status;
    const source = stamp.v2;
    if (!source || stamp.sessionId !== current.sessionId) return false;
    // Publishing a baseline changes disk generation, not the live snapshot.
    return source.instanceId
        ? source.instanceId === current.instanceId && source.liveRevision === current.liveRevision
        : source.generation === current.generation && source.revision === current.durableRevision
            && current.liveRevision === current.durableRevision;
}

function selectV2Messages(source: TranscriptProjection, ids: readonly string[]): TranscriptProjection {
    const target = createTranscriptProjection();
    const selected = new Set(ids);
    const changedTurns = new Set<string>();
    for (const message of source.messages.values()) {
        if (selected.has(message.id)) target.messages.set(message.id, message);
        else if (message.turnId) changedTurns.add(message.turnId);
    }
    for (const [id, turn] of source.turns) {
        if (turn.rootUserMessageId ? !selected.has(turn.rootUserMessageId) : ![...target.messages.values()].some(message => message.turnId === id)) continue;
        target.turns.set(id, changedTurns.has(id)
            ? { ...turn, status: 'interrupted', usage: undefined, durationMs: undefined } : turn);
    }
    return target;
}

async function commitV2ConversationMutation(
    sessionId: string, intent: PendingConversationMutation, targetIds: string[], sourceIds: string[],
): Promise<ConversationMutationResult> {
    const active = activeTranscripts.get(sessionId);
    const sourceFailure = await prepareSessionTranscriptMutation(sessionId);
    if (sourceFailure) return { success: false, reason: sourceFailure.reason === 'write-error' ? 'write_error' : 'precondition_failed', error: sourceFailure.error };
    if (!active || targetIds.length >= sourceIds.length
        || targetIds.some((id, index) => id !== sourceIds[index])) {
        return { success: false, reason: 'precondition_failed', error: 'V2 rewind requires a current, complete source prefix' };
    }
    const current = active.metadata;
    const sourceMatches = intent.kind === 'codex-rewind'
        ? current.runtime === 'codex' && current.runtimeSessionId === intent.sourceRuntimeSessionId
        : (current.runtime ?? 'builtin') === 'builtin'
            && (resolveBuiltinSdkSessionId(current) ?? null) === intent.sourceSdkSessionId
            && (intent.replacementSdkSessionId !== intent.sourceSdkSessionId || Boolean(intent.resumeSessionAt));
    if (!sourceMatches) return { success: false, reason: 'precondition_failed', error: 'Native rewind source binding changed' };
    const revision = active.writer.status.liveRevision;
    if (!await active.writer.flushForMutation()) return { success: false, reason: 'write_error', error: 'Rewind could not save its source history' };
    const source = [...active.writer.projection.messages.keys()];
    if (revision !== active.writer.status.liveRevision || source.length !== sourceIds.length || source.some((id, i) => id !== sourceIds[i])) {
        return { success: false, reason: 'precondition_failed', error: 'V2 rewind source changed while preparing' };
    }
    const target = selectV2Messages(active.writer.projection, targetIds);
    const messages = transcriptMessages(target);
    const updated = intent.kind === 'codex-rewind'
        ? finalizeCodexRewindMetadata(current, intent, messages)
        : finalizeBuiltinRewindMetadata(current, intent, messages);
    // This is the logical commit. Native binding and live history now describe
    // the same target; file publication is asynchronous and cannot undo it.
    active.beginConversationMutation(intent, updated, target);
    return conversationMutationSuccess(sessionId, active.metadata, messages);
}

/** Check the source before native/file side effects; publication uses the existing writer queue. */
export async function prepareSessionTranscriptMutation(
    sessionId: string,
): Promise<Extract<MutateSessionTranscriptResult, { ok: false }> | undefined> {
    const active = activeTranscripts.get(sessionId);
    if (active) {
        if (active.writer.status.reason === 'invalid-history') {
            return { ok: false, reason: 'malformed-transcript', error: 'History has no complete mutation source' };
        }
        if (active.hasPendingMutation && !await active.writer.flushForMutation()) {
            return { ok: false, reason: 'write-error', error: 'The previous conversation edit is still waiting to be saved; try again once saving completes' };
        }
        return;
    }
    return withSessionFileLock(sessionId, async () => {
        if (await sessionTranscriptFormat(getSessionMetadata(sessionId), sessionId) === 'legacy'
            && readJsonlSnapshot(getSessionFilePath(sessionId)).hasMalformedRows) {
            return { ok: false, reason: 'malformed-transcript', error: 'History contains unreadable rows' };
        }
    });
}

/** Commit a named destructive transcript operation from the owner's proven source. */
export async function mutateSessionTranscript(
    sessionId: string,
    cursor: TranscriptWriteCursor,
    intent: TranscriptMutationIntent,
): Promise<MutateSessionTranscriptResult> {
    if (cursor[transcriptCursorState].v2) {
        const sourceFailure = await prepareSessionTranscriptMutation(sessionId);
        if (sourceFailure) return sourceFailure;
        const active = activeTranscripts.get(sessionId);
        if (!active || !v2CursorMatches(active, cursor)) return { ok: false, reason: 'stale-cursor', error: 'V2 mutation source changed' };
        const derived = deriveTranscriptMutationTarget(transcriptMessages(active.writer.projection), intent);
        if (!derived.ok) return { ok: false, reason: 'precondition-failed', error: derived.error };
        if (!derived.target) return { ok: true, action: 'noop', cursor };
        const target = selectV2Messages(active.writer.projection, derived.target.map(message => message.id));
        active.writer.replaceProjection(target);
        active.patchMetadata({ stats: calculateSessionStats(derived.target), lastMessagePreview: resolveLastVisibleTurnPreview(derived.target).preview });
        return { ok: true, action: 'replaced', cursor: snapshotActiveTranscript(active).cursor };
    }
    if (getSessionMetadata(sessionId)?.transcriptFormat !== undefined || await pathExists(getV2SessionFilePath(sessionId))) {
        return { ok: false, reason: 'precondition-failed', error: 'Legacy mutation cannot change versioned history' };
    }
    ensureStorageDir();
    const filePath = getSessionFilePath(sessionId);
    try {
        return await withSessionFileLock(sessionId, async () => {
            const current = getTranscriptFileIdentity(filePath);
            if (!cursorMatches(sessionId, cursor, current)) {
                return { ok: false, reason: 'stale-cursor', error: 'Session transcript changed after the cursor was issued' };
            }
            if (!getSessionMetadata(sessionId)) {
                return { ok: false, reason: 'precondition-failed', error: 'Session metadata is missing' };
            }
            const source = readJsonlSnapshot(filePath);
            if (source.hasMalformedRows) {
                return { ok: false, reason: 'malformed-transcript', error: 'Destructive mutation requires a fully readable transcript' };
            }
            if (source.messages.length !== cursor.persistedMessageCount) {
                return { ok: false, reason: 'stale-cursor', error: 'Cursor message count does not match durable transcript' };
            }
            const derived = deriveTranscriptMutationTarget(source.messages, intent);
            if (!derived.ok) {
                return { ok: false, reason: 'precondition-failed', error: derived.error };
            }
            const target = derived.target;
            if (!target) {
                return { ok: true, action: 'noop', cursor };
            }
            try {
                atomicRewriteSessionMessages(sessionId, target);
            } catch (error) {
                return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error) };
            }
            await replaceDerivedTranscriptProjection(sessionId, target);
            return {
                ok: true,
                action: 'replaced',
                cursor: issueTranscriptCursor(sessionId, target.length, getTranscriptFileIdentity(filePath)),
            };
        });
    } catch (error) {
        return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Update session metadata.
 *
 * Writable keys include config-snapshot fields (v0.1.69) so the PATCH
 * /sessions/:id endpoint can persist model / permissionMode / MCP / provider
 * onto an existing session without replaying the full SessionMetadata blob.
 */
function monotonicLastActiveAt(current: string, incoming: string): string {
    const incomingMs = Date.parse(incoming);
    const currentMs = Date.parse(current);
    const incomingIsCanonical = Number.isFinite(incomingMs)
        && new Date(incomingMs).toISOString() === incoming;
    if (!incomingIsCanonical || (Number.isFinite(currentMs) && incomingMs < currentMs)) {
        return current;
    }
    return incoming;
}

export async function updateSessionMetadata(
    sessionId: string,
    updates: Partial<Pick<SessionMetadata,
        | 'title'
        | 'lastActiveAt'
        | 'sdkSessionId'
        | 'unifiedSession'
        | 'stats'
        | 'cronTaskId'
        | 'source'
        | 'origin'
        | 'favorite'
        | 'lastMessagePreview'
        | 'titleSource'
        | 'titleGenAttempts'
        | 'forkFrom'
        | 'runtime'
        | 'runtimeSource'
        | 'runtimeBinding'
        | 'runtimeBindingCompatibility'
        | 'runtimeSessionId'
        | 'runtimeUsageTotals'
        | 'lastContextUsage'
        | 'model'
        | 'reasoningEffort'
        | 'permissionMode'
        | 'mcpEnabledServers'
        | 'enabledPluginIds'
        | 'enabledOfficialToolIds'
        | 'providerId'
        | 'providerRoute'
        | 'providerExecutionIdentity'
        | 'providerRouteRepairedAt'
        | 'providerEnvJson'
        | 'configSnapshotAt'
        | 'materializationState'
        | 'materializationSourceSessionId'
        | 'sdkResumeSessionAt'
        | 'pendingContinueAfterAbort'
    >> & {
        /** Pin intent. SessionStore owns the canonical ordering timestamp. */
        pinned?: boolean;
    },
    /**
     * Optional compare-and-set guard evaluated INSIDE the lock against the
     * freshly-read current metadata. When it returns false the write is skipped
     * and this returns null. This closes a check-then-write TOCTOU that a
     * caller cannot close on its own: reading metadata, deciding, then calling
     * this leaves a window where a concurrent writer can change the very field
     * the decision was based on. Auto-titling uses it to never clobber a title
     * the user renamed during the multi-second LLM call (review #3).
     */
    precondition?: (current: SessionMetadata) => boolean,
): Promise<SessionMetadata | null> {
    if ('mcpEnabledServers' in updates) {
        updates = { ...updates, mcpEnabledServers: normalizeMcpSelection(updates.mcpEnabledServers) };
    }
    const active = activeTranscripts.get(sessionId);
    if (active && updates.pinned === undefined && !precondition) {
        if (active.isRevoked) return null;
        const current = active.metadata;
        if (changesPendingDshAuthority(current, updates)) return null;
        const { pinned: _pinned, ...patch } = updates;
        if (patch.lastActiveAt !== undefined) patch.lastActiveAt = monotonicLastActiveAt(current.lastActiveAt, patch.lastActiveAt);
        return active.patchMetadata(patch);
    }
    // Explicit CAS edits wait only for their own bounded publication. Ordinary
    // AI/birth lifecycle uses the active binding entrypoint below.
    if (active && !(await active.writer.flush())) return null;
    // Race-safe read-modify-write — must happen entirely under
    // `withSessionsLock` so a concurrent updater (e.g. periodic stats /
    // title patch / runtime-change freeze) doesn't get its just-applied
    // changes clobbered by us reading a pre-their-write snapshot and
    // writing back the full stale object.
    //
    // Pre-v0.2.14: read happened OUTSIDE the lock, so two concurrent
    // updaters could each compute `{...session, ...patch_X}` from the
    // same snapshot and the second writer would silently drop the first
    // writer's fields. Now: read fresh under the lock, patch, write back
    // — all atomic. (review-by-codex F3.)
    ensureStorageDir();
    let result: SessionMetadata | null = null;
    await withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const idx = all.findIndex(s => s.id === sessionId);
        if (idx < 0) {
            // session not found — leave result=null
            return;
        }
        if (precondition && !precondition(all[idx])) {
            // CAS guard failed against the in-lock snapshot — skip the write.
            return;
        }
        const current = all[idx];
        const { pinned, ...updatesWithoutPinIntent } = updates;
        const patch: Partial<SessionMetadata> = { ...updatesWithoutPinIntent };
        if (pinned !== undefined) {
            if (!pinned) {
                patch.pinnedAt = undefined;
            } else {
                const latestPinnedAtMs = all.reduce((latest, session) => {
                    const candidate = session.pinnedAt ? Date.parse(session.pinnedAt) : Number.NaN;
                    return Number.isFinite(candidate) ? Math.max(latest, candidate) : latest;
                }, 0);
                // A user can issue two pin intents inside one wall-clock millisecond. Allocate
                // under the sessions lock so the later committed intent still sorts first.
                patch.pinnedAt = new Date(Math.max(Date.now(), latestPinnedAtMs + 1)).toISOString();
            }
        }
        if (patch.lastActiveAt !== undefined) {
            patch.lastActiveAt = monotonicLastActiveAt(current.lastActiveAt, patch.lastActiveAt);
        }
        const updated: SessionMetadata = { ...current, ...patch };
        normalizeMcpSelectionField(updated);
        if (changesPendingDshAuthority(current, updated)) return;
        all[idx] = updated;
        try {
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            result = updated;
        } catch (error) {
            console.error('[SessionStore] updateSessionMetadata write failed:', error);
        }
    });
    if (result && active) active.adoptPublishedMetadata(result);
    return result;
}

/** Admission CAS is adjudicated by the current binding, even before its disk
 * birth exists. It must never inherit a product-edit durability dependency. */
export async function updateSessionMetadataForBinding(
    sessionId: string,
    updates: Parameters<typeof updateSessionMetadata>[1],
    precondition: (current: SessionMetadata) => boolean,
): Promise<SessionMetadata | null> {
    const active = getActiveSessionTranscript(sessionId);
    if (!active) return updateSessionMetadata(sessionId, updates, precondition);
    if (!precondition(active.metadata) || changesPendingDshAuthority(active.metadata, updates)) return null;
    const { pinned: _pinned, ...patch } = updates;
    return active.patchMetadata(patch);
}

export async function commitPreparedSessionForFirstUserTurn(
    sessionId: string,
    params: {
        messageText?: string;
        title?: string;
        runtimeSessionId?: string;
        origin?: SessionMetadata['origin'];
        lastActiveAt?: string;
        lastMessagePreview?: string;
    },
): Promise<SessionMetadata | null> {
    const active = activeTranscripts.get(sessionId);
    if (active) {
        if (active.isRevoked) return null;
        const current = active.metadata;
        const title = params.title ?? generateSessionTitle(params.messageText ?? '');
        return active.patchMetadata({
            ...(current.title === 'New Chat' && current.titleSource !== 'user' && title ? { title, titleSource: 'default' } : {}),
            ...(!current.origin && params.origin ? { origin: params.origin } : {}),
            ...(params.runtimeSessionId ? { runtimeSessionId: params.runtimeSessionId } : {}),
            ...(current.materializationState === 'prepared' ? {
                materializationState: undefined, materializationSourceSessionId: undefined,
                lastMessagePreview: params.lastMessagePreview,
                ...(params.lastActiveAt ? { lastActiveAt: monotonicLastActiveAt(current.lastActiveAt, params.lastActiveAt) } : {}),
            } : {}),
        });
    }
    ensureStorageDir();
    const title = params.title ?? generateSessionTitle(params.messageText ?? '');
    let result: SessionMetadata | null = null;

    await withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const idx = all.findIndex(s => s.id === sessionId);
        if (idx < 0) return;

        const current = all[idx];
        const patch: Partial<SessionMetadata> = {};
        const canSetDefaultTitle = current.title === 'New Chat' && current.titleSource !== 'user';

        if (canSetDefaultTitle && title && title !== current.title) {
            patch.title = title;
            patch.titleSource = 'default';
        }
        if (!current.origin && params.origin) {
            patch.origin = params.origin;
        }
        if (params.runtimeSessionId && current.runtimeSessionId !== params.runtimeSessionId) {
            patch.runtimeSessionId = params.runtimeSessionId;
        }
        if (current.materializationState === 'prepared') {
            patch.materializationState = undefined;
            patch.materializationSourceSessionId = undefined;
            patch.lastMessagePreview = params.lastMessagePreview;
            if (params.lastActiveAt) {
                patch.lastActiveAt = monotonicLastActiveAt(current.lastActiveAt, params.lastActiveAt);
            }
        }

        if (Object.keys(patch).length === 0) {
            result = current;
            return;
        }

        const updated: SessionMetadata = { ...current, ...patch };
        all[idx] = updated;
        atomicWriteSessionsFile(JSON.stringify(all, null, 2));
        result = updated;
    });

    return result;
}

export type PreparedSessionAdmissionClaimResult =
    | { status: 'claimed'; metadata: SessionMetadata }
    | { status: 'already-committed'; metadata: SessionMetadata }
    | { status: 'not-found' }
    | { status: 'source-mismatch' }
    | { status: 'io-error' };

/**
 * Durable turn-admission compare-and-set for renderer-prepared sessions.
 *
 * This is deliberately a typed SessionStore operation instead of a caller-side
 * `getSessionMetadata()` followed by `commitPrepared...()`: rollback and
 * admission must decide against the same in-lock row. `expectedSourceSessionId`
 * is supplied by the in-process preparation transaction when one exists; its
 * absence supports crash/restart recovery of a still-prepared row without
 * weakening an active transaction's ownership check.
 */
export async function claimPreparedSessionForTurnAdmission(
    sessionId: string,
    expectedSourceSessionId: string | undefined,
    params: {
        messageText?: string;
        title?: string;
        origin?: SessionMetadata['origin'];
        lastMessagePreview?: string;
    },
): Promise<PreparedSessionAdmissionClaimResult> {
    const active = activeTranscripts.get(sessionId);
    if (active) {
        if (active.isRevoked) return { status: 'not-found' };
        const current = active.metadata;
        if (current.materializationState !== 'prepared') return { status: 'already-committed', metadata: current };
        if (expectedSourceSessionId !== undefined && current.materializationSourceSessionId !== expectedSourceSessionId) return { status: 'source-mismatch' };
        // No await between the ownership check and claim. Rollback uses this
        // same instance, so a stale prepared disk row cannot revoke admission.
        const title = params.title ?? generateSessionTitle(params.messageText ?? '');
        const metadata = active.patchMetadata({
            materializationState: undefined, materializationSourceSessionId: undefined,
            lastMessagePreview: params.lastMessagePreview,
            ...(current.title === 'New Chat' && current.titleSource !== 'user' && title ? { title, titleSource: 'default' } : {}),
            ...(!current.origin && params.origin ? { origin: params.origin } : {}),
        });
        return { status: 'claimed', metadata };
    }
    ensureStorageDir();
    const title = params.title ?? generateSessionTitle(params.messageText ?? '');

    try {
        return await withSessionsLock(async () => {
            const all = readSessionsIndexForWrite();
            const idx = all.findIndex(session => session.id === sessionId);
            if (idx < 0) return { status: 'not-found' };

            const current = all[idx];
            if (current.materializationState !== 'prepared') {
                return { status: 'already-committed', metadata: current };
            }
            if (
                expectedSourceSessionId !== undefined
                && current.materializationSourceSessionId !== expectedSourceSessionId
            ) {
                return { status: 'source-mismatch' };
            }

            const patch: Partial<SessionMetadata> = {
                materializationState: undefined,
                materializationSourceSessionId: undefined,
                lastMessagePreview: params.lastMessagePreview,
            };
            const canSetDefaultTitle = current.title === 'New Chat' && current.titleSource !== 'user';
            if (canSetDefaultTitle && title && title !== current.title) {
                patch.title = title;
                patch.titleSource = 'default';
            }
            if (!current.origin && params.origin) {
                patch.origin = params.origin;
            }

            const updated: SessionMetadata = { ...current, ...patch };
            all[idx] = updated;
            atomicWriteSessionsFile(JSON.stringify(all, null, 2));
            return { status: 'claimed', metadata: updated };
        });
    } catch (error) {
        console.error(`[SessionStore] Failed prepared turn-admission claim for ${sessionId}:`, error);
        return { status: 'io-error' };
    }
}

export async function removeMcpServerFromSessionSnapshots(serverId: string): Promise<number> {
    ensureStorageDir();
    let updatedCount = 0;
    await withSessionsLock(async () => {
        const all = readSessionsIndexForWrite();
        const next = all.map(session => {
            if (!Array.isArray(session.mcpEnabledServers) || !session.mcpEnabledServers.includes(serverId)) {
                return session;
            }
            updatedCount++;
            return {
                ...session,
                mcpEnabledServers: session.mcpEnabledServers.filter(id => id !== serverId),
            };
        });

        if (updatedCount === 0) {
            return;
        }
        atomicWriteSessionsFile(JSON.stringify(next, null, 2));
    });
    return updatedCount;
}

/**
 * Create a new session for the given agent directory.
 *
 * `snapshot` is the partial SessionMetadata produced by the caller (typically via
 * `snapshotForOwnedSession()` for Desktop/Cron or `snapshotForImSession()` for IM).
 * Hand-assembling fields here is forbidden — go through the helpers in
 * `utils/session-snapshot.ts` so a new field added later cannot silently bypass
 * snapshot capture (PRD §6.2 pit-of-success).
 */
export async function createSession(agentDir: string, snapshot?: Partial<SessionMetadata>): Promise<SessionMetadata> {
    const session = createSessionMetadata(agentDir, snapshot);
    await saveSessionMetadata(session);
    console.log(`[SessionStore] Created session ${session.id} for ${agentDir} runtime=${session.runtime} configSnapshot=${session.configSnapshotAt ? 'yes' : 'no'}`);
    return session;
}

/** Fork must import a complete product source, including any history predating
 * a resumed native turn. An incomplete live tail is still usable for AI. */
export async function assertCompleteSessionForkSource(sessionId: string): Promise<void> {
    const active = getActiveSessionTranscript(sessionId);
    if (active) {
        if (active.writer.status.reason === 'invalid-history') {
            throw new TranscriptStorageError('invalid-history', 'Cannot fork an incompletely restored conversation');
        }
        return;
    }
    const source = await getSessionData(sessionId);
    if (!source || source.transcriptRecovery) {
        throw new TranscriptStorageError('invalid-history', 'Cannot fork an incompletely restored conversation');
    }
}

/** Publish an unopened fork as one validated V2 baseline. This explicit
 * transaction never installs a target writer in the source Session Sidecar.
 * The prepared row stays hidden until the complete candidate is durable.
 */
export async function publishForkSession(
    metadata: SessionMetadata, messages: readonly SessionMessage[], sourceSessionId: string,
): Promise<void> {
    if (!ownsSessionMetadataBirth(metadata) || metadata.transcriptFormat !== 2 || getSessionMetadata(metadata.id)) {
        throw new Error('Fork target must be a fresh V2 Session birth');
    }
    await assertCompleteSessionForkSource(sourceSessionId);
    const prepared: SessionMetadata = { ...metadata, materializationState: 'prepared', materializationSourceSessionId: sourceSessionId };
    let candidate: TranscriptFile | undefined;
    try {
        await publishV2Metadata(prepared, {}, true);
        const copied = await copyForkAttachments(messages, metadata.id);
        const projection = createTranscriptProjection();
        for (const message of copied) {
            if (projection.messages.has(message.id)) throw new Error('Duplicate fork message identity');
            projection.messages.set(message.id, fromStoredTranscriptMessage(message));
        }
        const generation = randomUUID();
        const file = candidate = new TranscriptFile({
            sessionId: metadata.id, filePath: getV2SessionFilePath(metadata.id), generation,
            allowCreate: true, withLock: run => withSessionFileLock(metadata.id, run),
            publishBirth: async () => {
                await publishV2Metadata(prepared, {
                    materializationState: undefined, materializationSourceSessionId: undefined,
                    lastMessagePreview: resolveLastVisibleTurnPreview([...messages]).preview,
                    stats: calculateSessionStats(messages),
                }, false);
            },
        });
        await file.replace({ generation, revision: 0 }, projection, 0);
    } catch (error) {
        await candidate?.discardCandidate();
        const cleanup = await deleteSession(metadata.id, { kind: 'prepared-materialization-rollback', sourceSessionId });
        if (cleanup.deleted) await discardForkAttachments(metadata.id);
        throw error;
    }
}

/** Explicit unopened/fork targets hand off only after a committed publication.
 * Ordinary births run inside their Session Sidecar and never use this barrier.
 */
export async function publishSessionForHandoff(sessionId: string): Promise<boolean> {
    const active = getActiveSessionTranscript(sessionId);
    if (!active || !(await active.writer.flush())) return false;
    await active.writer.close();
    if (activeTranscripts.get(sessionId) === active) activeTranscripts.delete(sessionId);
    return true;
}

/** Existing binding owner calls this before changing the Session ID of its
 * process. Unlike shutdown, a failed retirement retains the usable binding. */
export async function releaseSessionTranscriptForBinding(sessionId: string, timeoutMs = 2000): Promise<void> {
    const active = activeTranscripts.get(sessionId);
    if (!active) return;
    const deadline = Date.now() + timeoutMs;
    // Save the live tail when possible without making storage health a new
    // admission gate. Retirement alone decides whether physical IO is settled.
    if (!active.isRevoked) await active.writer.flush(timeoutMs);
    if (!await active.retire(Math.max(0, deadline - Date.now()))) {
        throw new Error('Session history IO is still finishing; retry the session change');
    }
    if (activeTranscripts.get(sessionId) === active) activeTranscripts.delete(sessionId);
}

/** Last-owner/process shutdown has a finite product-history drain. A timeout
 * revokes producers but does not pretend to cancel an outstanding filesystem
 * operation; Rust still waits for this process to exit before replacement.
 */
export async function drainSessionTranscripts(timeoutMs = 1500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const transcripts = [...activeTranscripts.values()];
    await Promise.all(transcripts.map(transcript => transcript.writer.flush(timeoutMs)));
    const closing = Promise.all(transcripts.map(transcript => transcript.revoke()));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([closing, new Promise<void>(resolve => { timer = setTimeout(resolve, remaining); })]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Update session title from first message if needed
 */
export async function updateSessionTitleFromMessage(sessionId: string, message: string): Promise<void> {
    const session = getSessionMetadata(sessionId);
    if (!session || session.title !== 'New Chat') {
        return;
    }

    const title = generateSessionTitle(message);
    await updateSessionMetadata(sessionId, { title, titleSource: 'default' });
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
        ensureDirSync(sessionAttachmentsDir);
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
