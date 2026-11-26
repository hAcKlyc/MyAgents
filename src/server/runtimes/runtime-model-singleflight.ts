import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import { elapsedMs, emitPerfTrace, nowMs } from '../utils/perf-trace';

interface InFlightModelQuery {
  controller: AbortController;
  promise: Promise<unknown[]>;
  subscribers: number;
  settled: boolean;
}

const inFlightModelQueries = new Map<string, InFlightModelQuery>();
// The app-wide Antigravity discovery catalog is separate from each live ACP session.
const antigravityCatalogTtlMs = 60_000;
let antigravityCatalog: { models: unknown[]; expiresAt: number } | undefined;

function modelQueryKey(runtimeType: RuntimeType, runtimeSource?: RuntimeSource): string {
  return `${runtimeType}:${runtimeSource ?? 'system-cli'}`;
}

export async function queryRuntimeModelsSingleFlight(
  runtimeType: RuntimeType,
  queryer: (signal: AbortSignal) => Promise<unknown[]>,
  runtimeSource?: RuntimeSource,
  signal?: AbortSignal,
): Promise<unknown[]> {
  if (runtimeType === 'builtin') return [];
  if (signal?.aborted) throw signal.reason ?? new Error('Runtime model query aborted');

  const cacheAntigravityCatalog = runtimeType === 'antigravity'
    && process.env.MYAGENTS_SIDECAR_ROLE === 'global';
  if (cacheAntigravityCatalog && antigravityCatalog && Date.now() < antigravityCatalog.expiresAt) {
    emitPerfTrace({ trace: 'runtime', phase: 'model_list_cache_hit', runtime: runtimeType, status: 'ok' });
    return antigravityCatalog.models;
  }

  const key = modelQueryKey(runtimeType, runtimeSource);
  const existing = inFlightModelQueries.get(key);
  if (existing) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'model_list_join',
      runtime: runtimeType,
      detail: { source: runtimeSource ?? 'system-cli' },
      status: 'ok',
    });
    return subscribeToModelQuery(existing, signal);
  }

  const start = nowMs();
  emitPerfTrace({
    trace: 'runtime',
    phase: 'model_list_start',
    runtime: runtimeType,
    detail: { source: runtimeSource ?? 'system-cli' },
  });

  const controller = new AbortController();
  const entry: InFlightModelQuery = {
    controller,
    subscribers: 0,
    settled: false,
    promise: (async () => {
    try {
      const models = await queryer(controller.signal);
      controller.signal.throwIfAborted();
      if (cacheAntigravityCatalog && models.length > 0) {
        antigravityCatalog = { models, expiresAt: Date.now() + antigravityCatalogTtlMs };
      }
      emitPerfTrace({
        trace: 'runtime',
        phase: 'model_list_done',
        runtime: runtimeType,
        detail: { source: runtimeSource ?? 'system-cli' },
        durationMs: elapsedMs(start),
        count: models.length,
        status: 'ok',
      });
      return models;
    } catch (error) {
      emitPerfTrace({
        trace: 'runtime',
        phase: 'model_list_done',
        runtime: runtimeType,
        detail: { source: runtimeSource ?? 'system-cli' },
        durationMs: elapsedMs(start),
        status: 'error',
      });
      throw error;
    }
    })(),
  };

  inFlightModelQueries.set(key, entry);
  void entry.promise.then(
    () => {
      entry.settled = true;
      if (inFlightModelQueries.get(key) === entry) inFlightModelQueries.delete(key);
    },
    () => {
      entry.settled = true;
      if (inFlightModelQueries.get(key) === entry) inFlightModelQueries.delete(key);
    },
  );
  return subscribeToModelQuery(entry, signal);
}

function subscribeToModelQuery(
  entry: InFlightModelQuery,
  signal?: AbortSignal,
): Promise<unknown[]> {
  entry.subscribers += 1;
  return new Promise<unknown[]>((resolve, reject) => {
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      entry.subscribers -= 1;
      if (entry.subscribers === 0 && !entry.settled && !entry.controller.signal.aborted) {
        entry.controller.abort(new Error('Runtime model query cancelled by all subscribers'));
      }
    };
    const onAbort = (): void => {
      release();
      reject(signal?.reason ?? new Error('Runtime model query aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    void entry.promise.then(
      models => {
        if (!active) return;
        signal?.removeEventListener('abort', onAbort);
        release();
        resolve(models);
      },
      error => {
        if (!active) return;
        signal?.removeEventListener('abort', onAbort);
        release();
        reject(error);
      },
    );
  });
}

export function __resetRuntimeModelSingleFlightForTest(): void {
  for (const entry of inFlightModelQueries.values()) {
    entry.controller.abort(new Error('Runtime model query state reset'));
  }
  inFlightModelQueries.clear();
  antigravityCatalog = undefined;
}
