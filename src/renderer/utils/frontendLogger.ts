/**
 * Frontend Logger — Pattern 6 (Renderer correlation + bounded global store).
 *
 * Single window-level diagnostic buffer for React, Node SSE, and Rust logs.
 * Only visible log panels subscribe; Chat state never carries log arrays.
 *
 * `console.*` interception is unchanged (statutory entry pattern from
 * `unified_logging.md` §最佳实践 #1). Each captured entry stamps
 * `tabId` from App's active tab registry before being persisted to disk and
 * pushed to the store; TabProvider supplements that registry for mounted Chat
 * tabs.
 *
 * Bounded:
 *  - Global ring buffer: 5000 entries (drops oldest)
 *  - Persistence batch buffer: 50 entries (existing)
 */

import type { LogEntry, LogLevel } from '@/types/log';
import { localTimestamp } from '../../shared/logTime';
import { isTauriEnvironment } from './browserMock';
import { listenWithCleanup } from './tauriListen';

// Store original console methods
const originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  debug: console.debug.bind(console),
};

// Track initialization state
let initialized = false;
let rendererLogLabel: string | null = null;
let rustLogAbort: AbortController | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
const HEALTH_INTERVAL_MS = 5 * 60_000;

// Custom event name for React logs (kept for back-compat with code that still
// listens via window event; the global store is the canonical source going
// forward).
export const REACT_LOG_EVENT = 'myagents:react-log';

// ── Pattern 6: active tab tracking (FIXED — App-owned active registry) ─────
// Previously this was a single `currentTabId` overwritten by whichever tab
// mounted last. With multiple tabs mounted concurrently, captured console.*
// logs were stamped with the wrong tabId. App.tsx now owns the active tab
// across every surface, while TabProvider keeps a mounted-Chat registry as a
// fallback and session-scoped supplement.
const mountedTabIds = new Set<string>();
const appTabIds = new Set<string>();
let focusedTabId: string | undefined;
let activeAppTabId: string | undefined;
// Last-resort fallback for legacy callers — preserves old "last mounted
// wins" behavior when no focus event has fired yet (cold start before any
// focus listener attaches).
let lastMountedTabId: string | undefined;

function isKnownTabId(tabId: string | undefined): boolean {
    return !!tabId && (mountedTabIds.has(tabId) || appTabIds.has(tabId));
}

function resolveFallbackTabId(): string | undefined {
    if (activeAppTabId && appTabIds.has(activeAppTabId)) return activeAppTabId;
    if (lastMountedTabId && mountedTabIds.has(lastMountedTabId)) return lastMountedTabId;
    return (appTabIds.values().next().value as string | undefined)
        ?? (mountedTabIds.values().next().value as string | undefined);
}

/**
 * App.tsx is the only owner that knows the active tab across all surfaces.
 * Launcher / Settings / TaskCenter do not mount TabProvider, so without this
 * they inherit the previously-focused Chat tab in persisted React logs.
 */
export function setAppActiveTabId(tabId: string | null | undefined, allTabIds: readonly string[] = []): void {
    appTabIds.clear();
    for (const id of allTabIds) {
        appTabIds.add(id);
    }
    activeAppTabId = tabId ?? undefined;
    if (activeAppTabId) {
        appTabIds.add(activeAppTabId);
        focusedTabId = activeAppTabId;
    } else if (!isKnownTabId(focusedTabId)) {
        focusedTabId = undefined;
    }
}

/**
 * Mount or unmount a tab in the active-tab registry. Pass `undefined` to
 * unmount the most recently mounted tab (legacy 1-arg shape; rarely needed —
 * the focus-aware variant `setCurrentTabId(tabId, mounted=true|false)` is
 * preferred). App's active tab remains authoritative; mounted Chat tabs are
 * only the fallback when App has not synced yet.
 */
export function setCurrentTabId(tabId: string | undefined, mounted: boolean = true): void {
    if (tabId === undefined) {
        // Legacy unmount-all path: shouldn't be hit in current code, but kept
        // for safety — clearing without a specific id is never the right thing.
        return;
    }
    if (mounted) {
        mountedTabIds.add(tabId);
        lastMountedTabId = tabId;
        // First mount → claim focus until something else explicitly does.
        if (!isKnownTabId(focusedTabId)) {
            focusedTabId = tabId;
        }
    } else {
        mountedTabIds.delete(tabId);
        if (focusedTabId === tabId) {
            focusedTabId = resolveFallbackTabId();
        }
        if (lastMountedTabId === tabId) {
            // Pick any remaining mounted tab as the new "last".
            lastMountedTabId = mountedTabIds.values().next().value as string | undefined;
        }
    }
}

/** Mark `tabId` as currently focused — called by TabProvider when its tab gains focus. */
export function setFocusedTabId(tabId: string | undefined): void {
    if (tabId === undefined) {
        // Don't clobber focusedTabId on blur — keep the last-focused as the
        // best guess. App-level captures still work via the fallback chain.
        return;
    }
    focusedTabId = tabId;
    if (!mountedTabIds.has(tabId)) {
        // Belt-and-suspenders: a tab that focuses without first mounting
        // should be added so capture still works.
        mountedTabIds.add(tabId);
        lastMountedTabId = tabId;
    }
}

function resolveActiveTabId(): string | undefined {
    if (activeAppTabId && appTabIds.has(activeAppTabId)) return activeAppTabId;
    if (isKnownTabId(focusedTabId)) return focusedTabId;
    return resolveFallbackTabId();
}

export function getActiveFrontendLogTabIdForTest(): string | undefined {
    return resolveActiveTabId();
}

// ── Pattern 6: global log store (bounded ring buffer + listeners) ─────
const STORE_CAPACITY = 5000;

type LogStoreListener = (entry: LogEntry) => void;

interface FrontendLogStore {
    entries: Array<{ sequence: number; entry: LogEntry }>;
    sequence: number;
    listeners: Set<LogStoreListener>;
}

const store: FrontendLogStore = {
    entries: [],
    sequence: 0,
    listeners: new Set(),
};

/** UI projection only. Node and Rust already own their disk persistence. */
export function appendFrontendLog(entry: LogEntry): void {
    store.entries.push({ sequence: ++store.sequence, entry });
    if (store.entries.length > STORE_CAPACITY) {
        store.entries.splice(0, store.entries.length - STORE_CAPACITY);
    }
    for (const l of store.listeners) {
        try { l(entry); } catch { /* ignore listener errors */ }
    }
}

/**
 * Subscribe to ALL log entries pushed to the global store. Returns the
 * unsubscribe function. Pass `tabFilter` to only receive entries whose
 * `tabId` matches (or entries with no tabId, which are global) — that's
 * entry callbacks remain available for diagnostics; panels use the same store.
 */
export function subscribeFrontendLogs(
    listener: LogStoreListener,
    tabFilter?: string,
): () => void {
    const wrapped: LogStoreListener = tabFilter
        ? (e) => { if (!e.tabId || e.tabId === tabFilter) listener(e); }
        : listener;
    store.listeners.add(wrapped);
    return () => { store.listeners.delete(wrapped); };
}

/**
 * Snapshot of the current store contents, optionally filtered by tab. Used
 * when a tab mounts and wants to backfill recent history.
 */
export interface FrontendLogScope {
    tabId?: string;
    sessionId?: string | null;
}

export function matchesFrontendLogScope(entry: LogEntry, scope: FrontendLogScope): boolean {
    if (!scope.tabId && !scope.sessionId) return true;
    if (entry.sessionId) return entry.sessionId === scope.sessionId;
    if (entry.tabId) return entry.tabId === scope.tabId;
    return true;
}

export function getFrontendLogSequence(): number {
    return store.sequence;
}

export function snapshotFrontendLogs(scope: FrontendLogScope = {}, afterSequence = 0, throughSequence = store.sequence): LogEntry[] {
    return store.entries
        .filter(({ sequence, entry }) => sequence > afterSequence && sequence <= throughSequence && matchesFrontendLogScope(entry, scope))
        .map(({ entry }) => entry);
}

export function clearFrontendLogs(tabFilter?: string): void {
    if (!tabFilter) {
        store.entries.length = 0;
        return;
    }
    store.entries = store.entries.filter(({ entry }) => entry.tabId && entry.tabId !== tabFilter);
}

// Log buffer for batching
const logBuffer: LogEntry[] = [];
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 500; // Flush every 500ms
const MAX_BUFFER_SIZE = 50; // Force flush if buffer exceeds this size

let logServerReady = false;

// Circuit breaker: prevents infinite error spam when Global Sidecar is dead
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
let circuitBrokenUntil = 0; // timestamp (ms) when half-open probe is allowed
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Set the server URL for sending logs
 * Should be called once with Global Sidecar URL on app startup
 * Tab sidecars should NOT override this - logs should always go to global
 * Also resets the circuit breaker (e.g., when Global Sidecar auto-restarts)
 */
export function setLogServerReady(): void {
  logServerReady = true;
  consecutiveFailures = 0;
  circuitBrokenUntil = 0;
  void flushLogs();
}

/**
 * Clear the server URL (e.g., on app shutdown)
 */
export function clearLogServerUrl(): void {
  logServerReady = false;
  consecutiveFailures = 0;
  circuitBrokenUntil = 0;
}

/**
 * Format arguments to string (safely handles objects)
 */
function formatArgs(args: unknown[]): string {
  return args.map(arg => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    try {
      return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
}

/**
 * Internal function to send log entries to server
 * Shared by flushLogs and sendLogBatch
 */
async function sendToServer(entries: LogEntry[]): Promise<void> {
  if (entries.length === 0 || !logServerReady) return;

  // Circuit breaker: skip requests while broken
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const now = Date.now();
    if (now < circuitBrokenUntil) {
      return; // Still in backoff — silently drop to prevent error spam
    }
    // Backoff expired → half-open probe (try one request)
  }

  try {
    // Dynamic import to avoid circular dependency
    const { globalSidecarFetch } = await import('@/api/tauriClient');

    await globalSidecarFetch('/api/unified-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    // Success: reset circuit breaker
    consecutiveFailures = 0;
    circuitBrokenUntil = 0;
  } catch {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s, 60s, ...
      const backoff = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - MAX_CONSECUTIVE_FAILURES),
        BACKOFF_MAX_MS,
      );
      circuitBrokenUntil = Date.now() + backoff;
    }
  }
}

/**
 * Flush log buffer to server
 */
async function flushLogs(): Promise<void> {
  if (logBuffer.length === 0) return;
  if (!logServerReady) {
    if (logBuffer.length > MAX_BUFFER_SIZE * 2) {
      logBuffer.splice(0, logBuffer.length - MAX_BUFFER_SIZE * 2);
    }
    return;
  }

  // Take all logs from buffer
  const entries = logBuffer.splice(0, logBuffer.length);
  await sendToServer(entries);
}

/**
 * Schedule a flush with debounce
 */
function scheduleFlush(): void {
  // Force flush if buffer is too large
  if (logBuffer.length >= MAX_BUFFER_SIZE) {
    if (flushTimeout) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }
    void flushLogs();
    return;
  }

  // Debounce flush
  if (!flushTimeout) {
    flushTimeout = setTimeout(() => {
      flushTimeout = null;
      void flushLogs();
    }, FLUSH_INTERVAL);
  }
}

/**
 * Create a log entry, dispatch event, and queue for persistence
 */
function createAndDispatch(level: LogLevel, args: unknown[]): void {
  const rawMessage = formatArgs(args);
  const message = rendererLogLabel ? `[${rendererLogLabel}] ${rawMessage}` : rawMessage;

  // Skip empty messages
  if (!message.trim()) return;

  // Skip recursive logs from our own system
  if (message.includes('[FrontendLogger]')) return;

  const entry: LogEntry = {
    source: 'react',
    level,
    message,
    timestamp: localTimestamp(),
    // Pattern 6: stamp tabId from the focus-aware registry. Outside any
    // tab, leave undefined → entries appear as global (every tab's
    // filtered subscription includes them). Replaces the old "last mounted
    // wins" singleton which mis-tagged logs in multi-tab sessions.
    tabId: resolveActiveTabId(),
  };

  // Push to global store (bounded ring + listeners). Replaces the old
  // "each TabProvider keeps its own 3000-entry copy" model.
  appendFrontendLog(entry);

  // Back-compat: also dispatch the legacy CustomEvent so any consumer
  // that hasn't migrated to subscribeFrontendLogs() still gets the entry.
  window.dispatchEvent(new CustomEvent(REACT_LOG_EVENT, { detail: entry }));

  // Add to buffer for persistence (cap when circuit is broken to prevent memory leak)
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && logBuffer.length >= MAX_BUFFER_SIZE * 2) {
    logBuffer.splice(0, logBuffer.length - MAX_BUFFER_SIZE);
  }
  logBuffer.push(entry);
  scheduleFlush();
}

/** O(1) observations only: never retain payloads, walk the DOM or measure the heap. */
function recordRendererHealth(): void {
  try {
    const internals = (globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: { callbacks?: Map<unknown, unknown> };
    }).__TAURI_INTERNALS__;
    createAndDispatch('info', ['[renderer-health]', JSON.stringify({
      uptimeSec: Math.floor(performance.now() / 1000),
      visibility: document.visibilityState,
      appTabs: appTabIds.size,
      mountedChats: mountedTabIds.size,
      // Pinned Tauri exposes this existing Map for debugging. Its absence is
      // unknown, not zero; no wrappers or mirrored callback registry needed.
      tauriCallbacks: internals?.callbacks instanceof Map ? internals.callbacks.size : null,
      logEntries: store.entries.length,
      logSubscribers: store.listeners.size,
      pendingLogs: logBuffer.length,
    })]);
  } catch {
    // Diagnostic failure must not affect rendering or recursively emit logs.
  }
}

/**
 * Initialize frontend logger - overrides console methods
 * Safe to call multiple times (will only initialize once)
 */
export function initFrontendLogger(): void {
  if (initialized) {
    return;
  }

  // Override console.log
  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    createAndDispatch('info', args);
  };

  // Override console.error
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    createAndDispatch('error', args);
  };

  // Override console.warn
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    createAndDispatch('warn', args);
  };

  // Override console.debug
  console.debug = (...args: unknown[]) => {
    originalConsole.debug(...args);
    createAndDispatch('debug', args);
  };

  initialized = true;
  if (rendererLogLabel === 'main') {
    recordRendererHealth();
    healthTimer = setInterval(recordRendererHealth, HEALTH_INTERVAL_MS);
  }
  if (isTauriEnvironment()) {
    rustLogAbort = new AbortController();
    // One listener per renderer window, independent of mounted Chat/Settings
    // tabs. Never enqueue these entries for HTTP persistence (log loop).
    void listenWithCleanup<LogEntry>('log:rust', event => appendFrontendLog(event.payload), rustLogAbort.signal);
  }
  originalConsole.log('[FrontendLogger] React console logging initialized');
}

export function setRendererLogLabel(label: string | null | undefined): void {
  rendererLogLabel = label || null;
}

/**
 * Restore original console methods (for testing)
 */
export function restoreFrontendLogger(): void {
  if (!initialized) return;

  if (healthTimer !== null) clearInterval(healthTimer);
  healthTimer = null;
  rustLogAbort?.abort();
  rustLogAbort = null;

  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.debug = originalConsole.debug;

  initialized = false;
}

import.meta.hot?.dispose(restoreFrontendLogger);

/**
 * Check if frontend logger is initialized
 */
export function isFrontendLoggerInitialized(): boolean {
  return initialized;
}

/**
 * Get original console for internal use (avoid recursion)
 */
export const getOriginalConsole = () => originalConsole;

/**
 * Force flush any pending logs (call on unmount/cleanup)
 */
export function forceFlushLogs(): void {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  void flushLogs();
}
