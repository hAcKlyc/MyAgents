import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { emitEvent } from './eventBus';
import { getServerUrl } from './tauriClient';
import { isTauriEnvironment } from '../utils/browserMock';

const JSON_EVENTS = new Set([
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
  'chat:subagent-tool-use',
  'chat:subagent-tool-input-delta',
  'chat:subagent-tool-result-start',
  'chat:subagent-tool-result-delta',
  'chat:subagent-tool-result-complete',
  'chat:system-init',
  'chat:logs',
  'chat:status',
  'chat:agent-error'
]);

const STRING_EVENTS = new Set([
  'chat:message-chunk',
  'chat:message-error',
  'chat:debug-message',
  'chat:log'
]);

const NULL_EVENTS = new Set(['chat:message-complete', 'chat:message-stopped']);

// Browser EventSource for non-Tauri environments
let eventSource: EventSource | null = null;

// Tauri event listeners for SSE proxy
let tauriUnlisteners: UnlistenFn[] = [];
let tauriSseConnected = false;

function handleBrowserEvent(event: MessageEvent<string>): void {
  const { type, data } = event;
  handleSseEvent(type, data);
}

function handleSseEvent(eventName: string, data: string): void {
  if (JSON_EVENTS.has(eventName)) {
    try {
      const parsed = JSON.parse(data);
      emitEvent(eventName, parsed);
    } catch {
      emitEvent(eventName, null);
    }
    return;
  }

  if (NULL_EVENTS.has(eventName)) {
    emitEvent(eventName, null);
    return;
  }

  if (STRING_EVENTS.has(eventName)) {
    emitEvent(eventName, data);
  }
}

/** Connect using Tauri SSE proxy (Rust-side, bypasses CORS) */
async function connectTauriSseProxy(): Promise<void> {
  if (tauriSseConnected) {
    return;
  }

  const serverUrl = await getServerUrl();
  const sseUrl = `${serverUrl}/chat/stream`;

  console.debug('[SSE] Using Tauri SSE proxy for:', sseUrl);

  // Set up listeners for all SSE event types
  const allEvents = [...JSON_EVENTS, ...STRING_EVENTS, ...NULL_EVENTS];

  for (const eventName of allEvents) {
    // Tauri events are prefixed with "sse:" and event name
    const tauriEventName = `sse:${eventName}`;
    const unlisten = await listen<string>(tauriEventName, (event) => {
      handleSseEvent(eventName, event.payload);
    });
    tauriUnlisteners.push(unlisten);
  }

  // Also listen for SSE proxy errors
  const errorUnlisten = await listen<string>('sse:error', (event) => {
    console.error('[SSE Proxy] Error:', event.payload);
  });
  tauriUnlisteners.push(errorUnlisten);

  // Start the Rust SSE proxy
  try {
    await invoke('start_sse_proxy', { url: sseUrl });
    tauriSseConnected = true;
    console.debug('[SSE] Tauri SSE proxy started');
  } catch (error) {
    console.error('[SSE] Failed to start Tauri SSE proxy:', error);
    throw error;
  }
}

/** Connect using browser EventSource (for dev mode or browser) */
async function connectBrowserSse(): Promise<void> {
  if (eventSource) {
    return;
  }

  const serverUrl = await getServerUrl();
  const sseUrl = `${serverUrl}/chat/stream`;

  console.debug('[SSE] Using browser EventSource for:', sseUrl);

  eventSource = new EventSource(sseUrl);
  const events = [...JSON_EVENTS, ...STRING_EVENTS, ...NULL_EVENTS];
  events.forEach((eventName) => {
    eventSource?.addEventListener(eventName, handleBrowserEvent as EventListener);
  });

  eventSource.onerror = () => {
    // Keep the connection open; EventSource will retry automatically.
  };
}

/** Connect to SSE stream - uses Tauri proxy in Tauri env, browser EventSource otherwise */
export async function connectSse(): Promise<void> {
  if (isTauriEnvironment()) {
    await connectTauriSseProxy();
  } else {
    await connectBrowserSse();
  }
}

/** Disconnect SSE */
export async function disconnectSse(): Promise<void> {
  // Disconnect Tauri SSE proxy
  if (tauriSseConnected) {
    try {
      await invoke('stop_sse_proxy');
    } catch (error) {
      console.error('[SSE] Failed to stop Tauri SSE proxy:', error);
    }

    // Unregister all Tauri event listeners
    for (const unlisten of tauriUnlisteners) {
      unlisten();
    }
    tauriUnlisteners = [];
    tauriSseConnected = false;
  }

  // Disconnect browser EventSource
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}
