import { APP_DATA_DIR_NAME } from '../shared/appProfile';
/**
 * Server-side Analytics
 *
 * Lightweight event tracker for the Node Sidecar.
 * Reads config from ~/.myagents/analytics_config.json (written by frontend at startup).
 * Sends events directly via fetch() — Node 20+'s undici-based fetch has no CORS.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { cancellableFetch } from './utils/cancellation';

const CONFIG_PATH = join(homedir(), APP_DATA_DIR_NAME, 'analytics_config.json');

interface AnalyticsConfig {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  deviceId: string;
  platform: string;
  appVersion: string;
}

interface ServerTrackEvent {
  event: string;
  device_id: string;
  platform: string;
  app_version: string;
  params: Record<string, string | number | boolean | null | undefined>;
  client_timestamp: string;
}

interface PendingConfigTrackEvent {
  event: string;
  params: Record<string, string | number | boolean | null | undefined>;
  client_timestamp: string;
  created_at_ms: number;
}

type ConfigState = AnalyticsConfig | 'disabled' | 'missing';

// Lazy-loaded config with retry — frontend writes the file asynchronously at startup,
// so the Sidecar may call trackServer() before the file exists. Missing config is
// distinct from disabled analytics: missing gets a short pending queue; disabled
// stays a no-op.
let config: ConfigState | null = null;
let configLoadedAt = 0;
const CONFIG_RETRY_MS = 10_000; // retry every 10s if config was missing

// Simple batch queue
const queue: ServerTrackEvent[] = [];
const pendingConfigQueue: PendingConfigTrackEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 3000;
const MAX_QUEUE_SIZE = 30;
const CONFIG_PENDING_RETRY_MS = 1000;
const PENDING_CONFIG_TTL_MS = 30_000;
const MAX_PENDING_CONFIG_QUEUE_SIZE = 100;
const ANALYTICS_FETCH_TIMEOUT_MS = 10_000;
let flushInFlight = false;

function loadConfig(): ConfigState {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as AnalyticsConfig;
    if (!parsed.enabled || !parsed.apiKey || !parsed.endpoint) return 'disabled';
    return parsed;
  } catch {
    return 'missing';
  }
}

function isReadyConfig(value: ConfigState | null): value is AnalyticsConfig {
  return typeof value === 'object' && value !== null;
}

function getConfigState(): ConfigState {
  const now = Date.now();
  // Retry if config failed to load and enough time has passed
  const retryMs = config === 'missing' && pendingConfigQueue.length > 0
    ? CONFIG_PENDING_RETRY_MS
    : CONFIG_RETRY_MS;
  if (config === null || (!isReadyConfig(config) && now - configLoadedAt >= retryMs)) {
    config = loadConfig();
    configLoadedAt = now;
  }
  return config;
}

function createEvent(
  cfg: AnalyticsConfig,
  event: string,
  params: Record<string, string | number | boolean | null | undefined>,
  clientTimestamp = new Date().toISOString(),
): ServerTrackEvent {
  return {
    event,
    device_id: cfg.deviceId,
    platform: cfg.platform,
    app_version: cfg.appVersion,
    params,
    client_timestamp: clientTimestamp,
  };
}

function pruneExpiredPendingConfigEvents(): void {
  const now = Date.now();
  for (let i = pendingConfigQueue.length - 1; i >= 0; i -= 1) {
    if (now - pendingConfigQueue[i].created_at_ms > PENDING_CONFIG_TTL_MS) {
      pendingConfigQueue.splice(i, 1);
    }
  }
}

function materializePendingConfigEvents(cfg: AnalyticsConfig): void {
  pruneExpiredPendingConfigEvents();
  if (pendingConfigQueue.length === 0) return;

  const pending = pendingConfigQueue.splice(0, pendingConfigQueue.length);
  for (const item of pending) {
    queue.push(createEvent(cfg, item.event, item.params, item.client_timestamp));
  }
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushQueue(), delayMs);
  flushTimer.unref?.();
}

async function flushQueue(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (flushInFlight) {
    if (queue.length > 0 || pendingConfigQueue.length > 0) {
      scheduleFlush(FLUSH_DELAY_MS);
    }
    return;
  }

  const cfg = getConfigState();
  if (cfg === 'disabled') {
    queue.length = 0;
    pendingConfigQueue.length = 0;
    return;
  }

  if (!isReadyConfig(cfg)) {
    pruneExpiredPendingConfigEvents();
    if (queue.length > 0 || pendingConfigQueue.length > 0) {
      scheduleFlush(CONFIG_PENDING_RETRY_MS);
    }
    return;
  }

  materializePendingConfigEvents(cfg);
  if (queue.length === 0) {
    return;
  }

  const events = queue.splice(0, MAX_QUEUE_SIZE);

  flushInFlight = true;
  try {
    await cancellableFetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': cfg.apiKey,
      },
      body: JSON.stringify({ events }),
    }, {
      timeoutMs: ANALYTICS_FETCH_TIMEOUT_MS,
    });
  } catch {
    // Silent failure — analytics must never affect the main flow
  } finally {
    flushInFlight = false;
  }

  // If there are remaining events, schedule another flush
  if (queue.length > 0) {
    scheduleFlush(FLUSH_DELAY_MS);
  }
}

/**
 * Track a server-side event.
 * Silent no-op if analytics is disabled. If the Sidecar starts before the
 * renderer has written analytics_config.json, retain a short pending queue so
 * early turn-complete events are not lost.
 */
export function trackServer(
  event: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const cfg = getConfigState();

  if (cfg === 'disabled') {
    pendingConfigQueue.length = 0;
    return;
  }

  if (!isReadyConfig(cfg)) {
    pruneExpiredPendingConfigEvents();
    pendingConfigQueue.push({
      event,
      params,
      client_timestamp: new Date().toISOString(),
      created_at_ms: Date.now(),
    });
    if (pendingConfigQueue.length > MAX_PENDING_CONFIG_QUEUE_SIZE) {
      pendingConfigQueue.splice(0, pendingConfigQueue.length - MAX_PENDING_CONFIG_QUEUE_SIZE);
    }
    scheduleFlush(CONFIG_PENDING_RETRY_MS);
    return;
  }

  materializePendingConfigEvents(cfg);
  queue.push(createEvent(cfg, event, params));

  if (queue.length >= MAX_QUEUE_SIZE) {
    void flushQueue();
  } else {
    scheduleFlush(FLUSH_DELAY_MS);
  }
}
