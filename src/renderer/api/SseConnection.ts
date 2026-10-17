/**
 * SseConnection - Instance-based SSE connection for renderer-surface isolation
 * 
 * Each Chat Tab or Companion surface creates an independent subscription,
 * allowing concurrent agent sessions without interference.
 * 
 * Tauri mode:
 * - Rust SSE proxy supports multiple subscriptions keyed by connectionId
 * - Events are prefixed with connectionId: sse:connectionId:event-name
 * - Each surface only receives events from its own subscription
 * 
 * Browser mode (development):
 * - Uses native EventSource with full multiple connection support
 */

import type React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { isTauriEnvironment } from '../utils/browserMock';
import { isLiveRevisionEnvelope } from '../../shared/liveRevision';
import { isSsePayloadRef } from '../../shared/ssePayloadRef';
import { getSessionPort } from './tauriClient';

// Event types that should be parsed as JSON
// IMPORTANT: When adding new SSE events in backend, remember to add them here too!
const JSON_EVENTS = new Set([
  'chat:transcript-operation',
  'chat:transcript-save-status',
    'chat:init',
    'chat:message-replay',
    'chat:thinking-start',
    'chat:thinking-chunk',
    'chat:tool-use-start',
    'chat:server-tool-use-start', // Server-side tool use (e.g., 智谱 GLM-4.7's webReader)
    'chat:tool-input-delta',
    'chat:content-block-stop',
    'chat:tool-result-start',
    'chat:tool-result-delta',
    'chat:tool-result-complete',
    'chat:tool-attachment-update', // PRD 0.2.15 — placeholder attachment async fulfillment
    'chat:subagent-tool-use',
    'chat:subagent-tool-input-delta',
    'chat:subagent-tool-result-start',
    'chat:subagent-tool-result-delta',
    'chat:subagent-tool-result-complete',
    'chat:subagent-status',
    'chat:subagent-tool-attachment-update', // #0.2.29 — nested sub-agent attachment async fulfillment
    'chat:system-init',
    'chat:slash-commands', // SDK-provided slash commands (including plugin skills)
    'chat:system-status', // SDK system status (e.g., 'compacting')
    'chat:logs',
    'chat:status',
    'chat:agent-error',
    'permission:request', // Permission prompt for tool usage
    'permission:expired', // Permission prompt expired or resolved server-side
    'ask-user-question:request', // AskUserQuestion tool prompt
    'ask-user-question:expired', // PRD #131 — backend timeout / SDK abort: clear stale UI card
    'exit-plan-mode:request',  // ExitPlanMode tool - AI submits plan for review
    'exit-plan-mode:expired',  // PRD #131 — backend timeout: clear stale UI card
    'enter-plan-mode:request', // EnterPlanMode tool - AI requests plan mode
    'enter-plan-mode:expired', // PRD #131 — backend timeout: clear stale UI card
    'chat:task-started',    // Background task (SDK Task tool) started
    'chat:task-notification', // Background task completed/failed/stopped
    'mcp:oauth-expired',    // MCP OAuth token expired (trigger re-auth prompt)
    'queue:added',     // Message queued (confirmation; carries isInFlight; re-emitted on promote to flip isInFlight true)
    'queue:started',   // Queued message started executing
    'queue:cancelled', // Queued message cancelled
    'chat:message-sdk-uuid', // SDK UUID assignment for user/assistant messages (fork button, rewind)
    'chat:session-config-changed', // Explicit Session desired config edit; payload is identity only
    'config:changed', // Admin CLI modified app config — triggers frontend refresh
    'chat:api-retry', // SDK API retry status (v0.2.77+) — rate limit / transient error retrying
    'chat:permission-mode-changed', // Backend permission mode changed (plan/auto/etc.) — sync frontend UI
    'chat:session-title-changed', // #296 — backend Title Service applied an AI title; carries {sessionId,title,titleSource}
    'chat:context-usage', // PRD 0.2.32 — 归一化的当前 context 窗口用量快照（ContextUsage）；builtin 每轮末 / Codex 亚轮流式
    'chat:agent-plan-update', // Codex turn/plan/updated → AgentStatusPanel todo snapshot
    // (Phase E PRD 0.2.7: `workspace:files-changed` SSE event removed —
    // renderer subscribes to Rust workspace_files watcher via Tauri event
    // `workspace:files-changed:<eventKey>` instead.)
    'chat:attachments-filtered', // Sidecar stripped image/video/audio attachments because the resolved model lacks the modality (see modelSupportsModality)
    'chat:attachments-fallback', // Sidecar wrote unsupported-modality attachments to <agentDir>/myagents_files/ and appended @<path> refs to the user text (see PRD prd_0.2.3_image_modality_file_fallback.md)
    'chat:runtime-diagnostics', // Issue #194 — external-runtime self-report (auth/features/MCP/apps/effective env)
    'chat:runtime-tool-catalog', // #474 — external runtime's ready MCP tool catalog
    'chat:mcp-effective-snapshot', // Runtime-neutral desired/effective MCP state
    'plugin:install-progress', // PRD 0.2.17 — Claude plugin install progress phases
    'plugins:changed', // PRD 0.2.17 — plugin install/uninstall/toggle invalidation signal
    'chat:messages-retracted', // SDK refusal-fallback retraction (0.3.162+ protocol) — evict refused-leg bubbles by message id
]);

// Event types that can be JSON or plain string
// These are tried as JSON first, fallback to string if parsing fails
// Used when backend sends both formats for the same event type
const JSON_OR_STRING_EVENTS = new Set([
    'chat:log', // agent-session sends strings, logger sends LogEntry objects
]);

// Event types that should be passed as raw strings
const STRING_EVENTS = new Set([
    'chat:message-chunk',
    'chat:message-error',
    'chat:debug-message'
]);

// Event types with null payload
const NULL_EVENTS = new Set(['chat:message-stopped']);

// Event types with JSON payload for analytics
const JSON_ANALYTICS_EVENTS = new Set(['chat:message-complete']);

// All event types
const ALL_EVENTS = [...JSON_EVENTS, ...JSON_OR_STRING_EVENTS, ...STRING_EVENTS, ...NULL_EVENTS, ...JSON_ANALYTICS_EVENTS];

export type SseEventMetadata = {
    connectionGeneration: number;
    sessionId?: string;
    liveRevision?: number;
};

export type SseEventHandler = (
    eventName: string,
    data: unknown,
    metadata: SseEventMetadata,
) => void;
export type SseConnectionStatusHandler = (status: 'connected' | 'disconnected' | 'reconnecting' | 'failed') => void;

export type SseSidecarOwner = {
    type: 'tab' | 'companion';
    id: string;
};

type TauriSseEnvelope = {
    transportGeneration: number;
    data: string;
};

// Reconnection configuration
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 10000;

/**
 * SseConnection - Manages a single SSE connection with auto-reconnection
 */
export class SseConnection {
    private eventSource: EventSource | null = null;
    private tauriUnlisteners: UnlistenFn[] = [];
    private tauriActive = false;
    private eventHandler: SseEventHandler | null = null;
    private statusHandler: SseConnectionStatusHandler | null = null;
    private connectionId: string;
    private sessionIdRef?: React.MutableRefObject<string | null>; // For Session-centric port lookup
    private sidecarOwner: SseSidecarOwner;

    // Reconnection state
    private reconnectAttempts = 0;
    // A reopened transport (or an earlier ref) does not prove that the full
    // snapshot loaded. Bound payload recovery for this logical connection.
    private payloadRecoveryAttempts = 0;
    private connecting: Promise<void> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private isReconnecting = false;
    private shouldReconnect = true; // Set to false when intentionally disconnecting
    private connectionGeneration = 0;
    private deliveryEpoch = 0;
    private payloadAbort: AbortController | null = null;
    private pendingEvents: Array<{ eventName: string; data: string }> = [];
    private pendingBytes = 0;


    constructor(
        connectionId: string,
        sessionIdRef?: React.MutableRefObject<string | null>,
        sidecarOwner: SseSidecarOwner = { type: 'tab', id: connectionId },
    ) {
        this.connectionId = connectionId;
        this.sessionIdRef = sessionIdRef;
        this.sidecarOwner = sidecarOwner;
    }

    /**
     * Set the event handler for SSE events
     */
    setEventHandler(handler: SseEventHandler): void {
        this.eventHandler = handler;
    }

    /**
     * Set the connection status handler
     */
    setStatusHandler(handler: SseConnectionStatusHandler): void {
        this.statusHandler = handler;
    }

    /**
     * Notify status change
     */
    private notifyStatus(status: 'connected' | 'disconnected' | 'reconnecting' | 'failed'): void {
        if (this.statusHandler) {
            this.statusHandler(status);
        }
    }

    /**
     * Check whether this renderer surface owns an active subscription.
     * This deliberately does not claim that an HTTP stream is currently live.
     */
    isActive(): boolean {
        return this.eventSource !== null || this.tauriActive || this.isReconnecting;
    }

    /**
     * Tear down all registered Tauri listeners idempotently.
     * Safe to call multiple times — `splice(0)` empties the array atomically
     * so re-entrant calls see nothing to clean up.
     */
    private cleanupTauriListeners(): void {
        for (const unlisten of this.tauriUnlisteners.splice(0)) {
            try {
                unlisten();
            } catch (error) {
                console.warn(`[SSE ${this.connectionId}] unlisten failed:`, error);
            }
        }
    }

    private resetPendingDelivery(): void {
        this.deliveryEpoch++;
        this.payloadAbort?.abort();
        this.payloadAbort = null;
        this.pendingEvents = [];
        this.pendingBytes = 0;
    }

    /** Decode at the connection owner so Tab and Companion share ordering/fences. */
    private receiveSseEvent(eventName: string, data: string): void {
        if (!this.shouldReconnect) return;
        if (this.payloadAbort) {
            // A stalled data-plane read must not create an unbounded second queue.
            if (this.pendingEvents.length >= 10_000 || this.pendingBytes + data.length * 2 > 32 * 1024 * 1024) {
                void this.recoverPayloadDelivery(this.deliveryEpoch);
                return;
            }
            this.pendingEvents.push({ eventName, data });
            this.pendingBytes += data.length * 2;
            return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { /* legacy string */ }
        if (!isSsePayloadRef(parsed)) {
            this.handleSseEvent(eventName, data);
            return;
        }
        const epoch = this.deliveryEpoch;
        const sessionId = this.sessionIdRef?.current;
        const abort = new AbortController();
        this.payloadAbort = abort;
        // Bound a missing/hung ref using the existing connection retry path.
        const timeout = setTimeout(() => abort.abort(), 30_000);
        void (async () => {
            try {
                const port = sessionId ? await getSessionPort(sessionId) : null;
                if (epoch !== this.deliveryEpoch) return;
                if (!port) throw new Error('SSE ref Sidecar is unavailable');
                const response = await fetch(`http://127.0.0.1:${port}/refs/${parsed.ref.id}`, { signal: abort.signal });
                if (!response.ok) throw new Error(`SSE payload ref returned ${response.status}`);
                const body = await response.text();
                if (epoch !== this.deliveryEpoch || !this.shouldReconnect) return;
                // Validate before admission: a corrupt ref must not become a null
                // business event followed by deltas against an absent baseline.
                JSON.parse(body);
                this.payloadAbort = null;
                this.handleSseEvent(eventName, body);
                while (epoch === this.deliveryEpoch && !this.payloadAbort && this.pendingEvents.length > 0) {
                    const next = this.pendingEvents.shift()!;
                    this.pendingBytes -= next.data.length * 2;
                    this.receiveSseEvent(next.eventName, next.data);
                }
            } catch {
                if (epoch === this.deliveryEpoch && this.shouldReconnect) {
                    await this.recoverPayloadDelivery(epoch);
                }
            } finally { clearTimeout(timeout); }
        })();
    }

    private async recoverPayloadDelivery(epoch: number): Promise<void> {
        if (epoch !== this.deliveryEpoch || !this.shouldReconnect) return;
        console.warn(`[SSE ${this.connectionId}] Full payload unavailable; reconnecting for a fresh snapshot`);
        const starting = this.connecting;
        const disconnected = this.disconnect(); // Revokes this queue synchronously.
        const recoveryEpoch = this.deliveryEpoch;
        // Recovery retains this logical attachment while the physical start
        // is being cancelled. The connect caller must not dispose its owner.
        this.isReconnecting = true;
        // A first event can precede start_sse_proxy's acknowledgement. Keep
        // cancellation asserted until that attempt has stopped/unlistened.
        await Promise.allSettled([disconnected, starting]);
        // A user disconnect or a replacement connection during teardown wins.
        if (recoveryEpoch !== this.deliveryEpoch) return;
        this.payloadRecoveryAttempts++;
        if (this.payloadRecoveryAttempts > RECONNECT_MAX_ATTEMPTS) {
            this.isReconnecting = false;
            this.notifyStatus('failed');
            return;
        }
        this.shouldReconnect = true;
        this.reconnectAttempts = Math.max(this.reconnectAttempts, this.payloadRecoveryAttempts - 1);
        this.scheduleReconnect();
    }

    /**
     * Handle SSE event - parse and emit to handler
     */
    private handleSseEvent(eventName: string, data: string): void {
        if (!this.eventHandler) {
            console.warn(`[SSE ${this.connectionId}] Event received but no handler: ${eventName}`);
            return;
        }

        const metadata: SseEventMetadata = {
            connectionGeneration: this.connectionGeneration,
        };
        try {
            const parsed = JSON.parse(data) as unknown;
            if (isLiveRevisionEnvelope(parsed)) {
                this.eventHandler(eventName, parsed.payload, {
                    ...metadata,
                    sessionId: parsed.sessionId,
                    liveRevision: parsed.liveRevision,
                });
                return;
            }
        } catch {
            // Plain-string events continue through their existing parser below.
        }

        // Handle null-payload events (message-stopped)
        if (NULL_EVENTS.has(eventName)) {
            console.debug(`[SSE ${this.connectionId}] Received: ${eventName}`);
            this.eventHandler(eventName, null, metadata);
            return;
        }

        // Handle JSON analytics events (message-complete with usage data)
        if (JSON_ANALYTICS_EVENTS.has(eventName)) {
            try {
                const parsed = JSON.parse(data);
                this.eventHandler(eventName, parsed, metadata);
            } catch (e) {
                console.warn(`[SSE ${this.connectionId}] Failed to parse analytics JSON for ${eventName}:`, e);
                // Still emit event with null so tracking can proceed with defaults
                this.eventHandler(eventName, null, metadata);
            }
            return;
        }

        if (JSON_EVENTS.has(eventName)) {
            try {
                const parsed = JSON.parse(data);
                this.eventHandler(eventName, parsed, metadata);
            } catch (e) {
                console.warn(`[SSE ${this.connectionId}] Failed to parse JSON for ${eventName}:`, e);
                this.eventHandler(eventName, null, metadata);
            }
            return;
        }

        // JSON_OR_STRING_EVENTS: try JSON first, fallback to raw string
        if (JSON_OR_STRING_EVENTS.has(eventName)) {
            try {
                const parsed = JSON.parse(data);
                this.eventHandler(eventName, parsed, metadata);
            } catch {
                // Not valid JSON, pass as raw string (this is expected for legacy log format)
                this.eventHandler(eventName, data, metadata);
            }
            return;
        }

        if (STRING_EVENTS.has(eventName)) {
            this.eventHandler(eventName, data, metadata);
            return;
        }

        // Unrecognized event - log warning to help identify missing event registrations
        console.warn(`[SSE ${this.connectionId}] Unrecognized event dropped: ${eventName}`);
    }

    private handleTauriEnvelope(eventName: string, envelope: TauriSseEnvelope): void {
        if (!this.shouldReconnect) return;
        if (
            !envelope
            || !Number.isSafeInteger(envelope.transportGeneration)
            || envelope.transportGeneration <= 0
            || typeof envelope.data !== 'string'
        ) {
            console.warn(`[SSE ${this.connectionId}] Invalid Tauri SSE envelope dropped`);
            return;
        }

        if (envelope.transportGeneration < this.connectionGeneration) {
            console.debug(
                `[SSE ${this.connectionId}] Stale transport generation dropped:`,
                envelope.transportGeneration,
            );
            return;
        }

        if (envelope.transportGeneration > this.connectionGeneration) {
            this.resetPendingDelivery();
            this.connectionGeneration = envelope.transportGeneration;
            // Establish the restore fence before applying the first business
            // event from this physical stream.
            this.notifyStatus('connected');
        }

        this.receiveSseEvent(eventName, envelope.data);
    }

    /**
     * Connect using browser EventSource with auto-reconnection
     */
    private async connectBrowser(): Promise<void> {
        if (this.eventSource) return;

        // Use Tab-specific server URL (or fixed port if provided)
        const serverUrl = await this.getServerUrl();
        const sseUrl = `${serverUrl}/chat/stream`;

        console.debug(`[SSE ${this.connectionId}] Connecting browser EventSource:`, sseUrl);

        if (!this.shouldReconnect) return;
        this.resetPendingDelivery();
        this.connectionGeneration += 1;
        this.eventSource = new EventSource(sseUrl);

        this.eventSource.onopen = () => {
            console.debug(`[SSE ${this.connectionId}] Connected`);
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            this.notifyStatus('connected');
        };

        for (const eventName of ALL_EVENTS) {
            this.eventSource.addEventListener(eventName, ((event: MessageEvent<string>) => {
                this.receiveSseEvent(event.type, event.data);
            }) as EventListener);
        }

        this.eventSource.onerror = () => {
            console.warn(`[SSE ${this.connectionId}] Connection error`);
            this.resetPendingDelivery();

            // Only attempt reconnection if not intentionally disconnected
            if (this.shouldReconnect && !this.isReconnecting) {
                this.scheduleReconnect();
            }
        };
    }

    /**
     * Connect using the Tauri SSE subscription proxy.
     * Each renderer surface has its own connection-key-prefixed events.
     */
    private async connectTauri(): Promise<void> {
        if (this.tauriActive) return;

        const sessionIdHint = this.sessionIdRef?.current;
        if (!sessionIdHint) {
            throw new Error(`[SSE ${this.connectionId}] Cannot attach without a Session id hint`);
        }

        console.debug(`[SSE ${this.connectionId}] Installing Tauri SSE subscription`);

        // Set up listeners for Tab-prefixed SSE event types.
        // The whole listen-loop is wrapped in try/catch so that a rejection
        // from any single listen() call (e.g. Tauri IPC dropped mid-loop)
        // tears down the listeners we already registered. Without this,
        // partial registration would leak the same way the original guard
        // bug did — just driven by errors instead of races.
        try {
            for (const eventName of ALL_EVENTS) {
                const tauriEventName = `sse:${this.connectionId}:${eventName}`;
                const unlisten = await listen<TauriSseEnvelope>(tauriEventName, (event) => {
                    this.handleTauriEnvelope(eventName, event.payload);
                });
                // Cancellation checkpoint — listen() has resolved so the
                // listener IS installed; if disconnect raced us, unlisten
                // this one + the ones we already pushed, then bail.
                if (!this.shouldReconnect) {
                    try { unlisten(); } catch { /* best-effort */ }
                    this.cleanupTauriListeners();
                    return;
                }
                this.tauriUnlisteners.push(unlisten);
            }
        } catch (error) {
            console.error(`[SSE ${this.connectionId}] listen() registration failed:`, error);
            this.cleanupTauriListeners();
            throw error;
        }

        // Command acknowledgement means the long-lived subscription is
        // installed. Only a forwarded envelope proves a physical transport.
        try {
            await invoke('start_sse_proxy', {
                connectionKey: this.connectionId,
                sessionIdHint,
                sidecarOwnerType: this.sidecarOwner.type,
                sidecarOwnerId: this.sidecarOwner.id,
            });
        } catch (error) {
            console.error(`[SSE ${this.connectionId}] Failed to start Tauri SSE proxy:`, error);
            // start failed → no proxy held; just clean up the listeners we
            // already registered and surface the error to the caller.
            this.cleanupTauriListeners();
            throw error;
        }
        // Even on a successful start, a racing disconnect may have already
        // flipped shouldReconnect to false; tear down the proxy we just
        // started and our listeners so nothing leaks.
        if (!this.shouldReconnect) {
            try { await invoke('stop_sse_proxy', { connectionKey: this.connectionId }); }
            catch (error) { console.error(`[SSE ${this.connectionId}] stop_sse_proxy after cancel failed:`, error); }
            this.cleanupTauriListeners();
            return;
        }
        this.tauriActive = true;
        console.debug(`[SSE ${this.connectionId}] Tauri SSE subscription installed`);
    }

    /**
     * Connect to SSE stream
     */
    async connect(): Promise<void> {
        if (!this.isReconnecting) this.payloadRecoveryAttempts = 0;
        this.resetPendingDelivery();
        this.shouldReconnect = true;
        const attempt = isTauriEnvironment() ? this.connectTauri() : this.connectBrowser();
        this.connecting = attempt;
        try { await attempt; }
        finally { if (this.connecting === attempt) this.connecting = null; }
    }

    /**
     * Disconnect SSE stream
     * Safe to call multiple times - subsequent calls are no-ops
     */
    async disconnect(): Promise<void> {
        // Flip shouldReconnect FIRST so any in-flight connectTauri() observes
        // it at its next await checkpoint and bails out cleanly. Even when
        // the early-exit guard below fires (nothing yet to tear down), we
        // keep shouldReconnect=false: if a connect IS racing us, this is the
        // signal that cancels it. A subsequent connect() will set it back
        // to true at the top of its own body.
        this.shouldReconnect = false;
        this.isReconnecting = false;
        this.resetPendingDelivery();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Idempotent guard: only skip when there is genuinely nothing to clean
        // up. Note tauriUnlisteners.length: connectTauri() may have already
        // pushed listeners while tauriActive is still false.
        if (
            !this.tauriActive
            && !this.eventSource
            && this.tauriUnlisteners.length === 0
        ) {
            return;
        }

        console.debug(`[SSE ${this.connectionId}] Disconnecting`);

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.isReconnecting = false;

        // Stop the Rust SSE proxy if we ever started it.
        if (this.tauriActive) {
            try {
                await invoke('stop_sse_proxy', { connectionKey: this.connectionId });
            } catch (error) {
                console.error(`[SSE ${this.connectionId}] Failed to stop Tauri SSE proxy:`, error);
            }
            this.tauriActive = false;
        }

        // Always tear down listeners we registered, regardless of whether
        // start_sse_proxy completed — connectTauri() may have queued listeners
        // before flipping tauriActive, and our cancellation checkpoints
        // also rely on this method to clean up partial state.
        this.cleanupTauriListeners();

        // Disconnect browser EventSource
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }

        this.notifyStatus('disconnected');
    }

    /**
     * Schedule a reconnection attempt with exponential backoff
     */
    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            console.error(`[SSE ${this.connectionId}] Max reconnection attempts (${RECONNECT_MAX_ATTEMPTS}) reached`);
            this.isReconnecting = false;
            this.notifyStatus('failed');
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        // Exponential backoff: 1s, 2s, 4s, 8s... capped at max
        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
            RECONNECT_MAX_DELAY_MS
        );

        // Throttle reconnect logs: first attempt + every 10th
        if (this.reconnectAttempts === 1) {
            console.warn(`[SSE ${this.connectionId}] Connection failed, retrying...`);
        } else if (this.reconnectAttempts % 10 === 0) {
            console.debug(`[SSE ${this.connectionId}] Still reconnecting (attempt ${this.reconnectAttempts})`);
        }
        this.notifyStatus('reconnecting');

        // Clear any existing timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(async () => {
            if (!this.shouldReconnect) return;

            try {
                // Close existing connection first
                if (this.eventSource) {
                    this.eventSource.close();
                    this.eventSource = null;
                }

                const attempts = this.reconnectAttempts;
                await this.connect();
                if (attempts > 0) {
                    console.log(`[SSE ${this.connectionId}] Reconnected after ${attempts} attempts`);
                }
            } catch (_error) {
                // Schedule another attempt
                if (this.shouldReconnect) {
                    this.scheduleReconnect();
                }
            }
        }, delay);
    }

    /**
     * Reset reconnection state (call when intentionally connecting)
     */
    resetReconnectState(): void {
        this.payloadRecoveryAttempts = 0;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.shouldReconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    getConnectionGeneration(): number {
        return this.connectionGeneration;
    }

    /**
     * Get the server URL for this connection
     * Session-centric: first try a ready session port, then fallback to the tab URL waiter.
     */
    private async getServerUrl(): Promise<string> {
        return this.sessionIdRef?.current ? 'http://127.0.0.1:3000' : '';
    }
}

/**
 * Create a new SSE connection instance
 * @param connectionId - Stable Tauri event namespace for this renderer surface
 * @param sessionIdRef - Ref to current Session identity (and browser-mode port lookup)
 * @param sidecarOwner - Existing Sidecar owner identity; defaults to the Tab owner
 */
export function createSseConnection(
    connectionId: string,
    sessionIdRef?: React.MutableRefObject<string | null>,
    sidecarOwner?: SseSidecarOwner,
): SseConnection {
    return new SseConnection(connectionId, sessionIdRef, sidecarOwner);
}
