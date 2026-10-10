import { AsyncLocalStorage } from 'node:async_hooks';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { SystemInitInfo } from '../../shared/types/system';
import {
  MCP_PREWARM_GRACE_MS,
  type McpPrewarmOutcome,
} from '../session-core/mcp-prewarm-policy';
import type { BuiltinLifecycleSnapshot, MessageQueueItem } from './types';

const PRE_WARM_MAX_RETRIES = 3;

let querySession: Query | null = null;
export type BuiltinQueryAuthority = Readonly<{
  query: Query;
  productSessionId: string;
  expectedSdkSessionId: string;
  readonly revoked: boolean;
}>;
let queryAuthorityRecord: {
  authority: BuiltinQueryAuthority;
  revoke: () => void;
} | null = null;
let queryGeneration = 0;
let queryMcpRevision = 0;
let queryMcpPrewarmOwner: {
  query: Query;
  generation: number;
  revision: number;
  fingerprint: string;
  requiredServerIds: readonly string[];
  startedAt: number;
  deadlineAt: number;
  outcome?: McpPrewarmOutcome;
  statusRead?: ReturnType<Query['mcpServerStatus']>;
} | null = null;
export type QueryMcpMutationResult =
  | { ok: true; deferred?: boolean }
  | {
    ok: false;
    reason: 'failed' | 'timeout' | 'deferred' | 'query_replaced';
    error: string;
  };

let queryMcpMutationOwner: {
  query: Query;
  generation: number;
  promise: Promise<QueryMcpMutationResult>;
  settle(result: QueryMcpMutationResult): void;
} | null = null;
export type QueryBackgroundTaskInfo = {
  toolUseId?: string;
  description?: string;
};

const queryBackgroundTasks = new Map<Query, Map<string, QueryBackgroundTaskInfo>>();
let isProcessing = false;
let abortRequested = false;
let sessionTerminationPromise: Promise<void> | null = null;
let abortCleanupPromise: Promise<void> | null = null;
let messageResolver: ((item: MessageQueueItem | null) => void) | null = null;
const queryExitWaiters = new Set<{ query: Query; resolve: () => void }>();
let isPreWarming = false;
let preWarmTimer: ReturnType<typeof setTimeout> | null = null;
let preWarmFailCount = 0;
let preWarmDisabled = false;
let systemInitInfo: SystemInitInfo | null = null;
let systemInitAuthority: BuiltinQueryAuthority | null = null;
let sdkControlReady = false;
let liveRevision = 0;
let sessionMutationBarrier: Promise<void> | null = null;

function replaceQuerySession(session: Query | null): void {
  if (querySession === session) return;
  const previousQuery = querySession;
  queryAuthorityRecord?.revoke();
  queryAuthorityRecord = null;
  resetControlPlaneState();
  if (queryMcpMutationOwner) {
    queryMcpMutationOwner.settle({
      ok: false,
      reason: 'query_replaced',
      error: 'Query was replaced during MCP transport mutation',
    });
  }
  querySession = session;
  queryGeneration += 1;
  console.log(`[builtin-input] phase=query-replaced generation=${queryGeneration} previousQuery=${previousQuery !== null} query=${session !== null}`);
  queryMcpPrewarmOwner = null;
  if (previousQuery) {
    for (const waiter of queryExitWaiters) {
      if (waiter.query !== previousQuery) continue;
      queryExitWaiters.delete(waiter);
      waiter.resolve();
    }
  }
}

export const lifecycleState = {
  get query(): Query | null {
    return querySession;
  },
  set query(session: Query | null) {
    replaceQuerySession(session);
  },
  get processing(): boolean {
    return isProcessing;
  },
  set processing(value: boolean) {
    isProcessing = value;
  },
  get abortRequested(): boolean {
    return abortRequested;
  },
  set abortRequested(value: boolean) {
    abortRequested = value;
  },
  get termination(): Promise<void> | null {
    return sessionTerminationPromise;
  },
  set termination(promise: Promise<void> | null) {
    sessionTerminationPromise = promise;
  },
  get preWarming(): boolean {
    return isPreWarming;
  },
  set preWarming(value: boolean) {
    isPreWarming = value;
  },
  get preWarmTimer(): ReturnType<typeof setTimeout> | null {
    return preWarmTimer;
  },
  set preWarmTimer(timer: ReturnType<typeof setTimeout> | null) {
    preWarmTimer = timer;
  },
  get preWarmFailCount(): number {
    return preWarmFailCount;
  },
  set preWarmFailCount(value: number) {
    preWarmFailCount = value;
  },
  get preWarmDisabled(): boolean {
    return preWarmDisabled;
  },
  set preWarmDisabled(value: boolean) {
    preWarmDisabled = value;
  },
  get systemInitInfo(): SystemInitInfo | null {
    return systemInitInfo;
  },
  set systemInitInfo(info: SystemInitInfo | null) {
    systemInitInfo = info;
  },
  get sdkControlReady(): boolean {
    return sdkControlReady;
  },
  set sdkControlReady(value: boolean) {
    sdkControlReady = value;
  },
  get messageResolver(): ((item: MessageQueueItem | null) => void) | null {
    return messageResolver;
  },
  set messageResolver(resolve: ((item: MessageQueueItem | null) => void) | null) {
    messageResolver = resolve;
  },
};

export function getQuerySession(): Query | null {
  return querySession;
}

export function getQueryGeneration(): number {
  return queryGeneration;
}

export function hasQuerySession(): boolean {
  return querySession !== null;
}

export function setQuerySession(session: Query | null): void {
  replaceQuerySession(session);
}

export function setQuerySessionWithAuthority(
  session: Query,
  identity: { productSessionId: string; expectedSdkSessionId: string },
): BuiltinQueryAuthority {
  queryAuthorityRecord?.revoke();
  queryAuthorityRecord = null;
  replaceQuerySession(session);
  let revoked = false;
  const authority = Object.freeze({
    query: session,
    productSessionId: identity.productSessionId,
    expectedSdkSessionId: identity.expectedSdkSessionId,
    get revoked() { return revoked; },
  });
  queryAuthorityRecord = {
    authority,
    revoke: () => { revoked = true; },
  };
  return authority;
}

export function getCurrentQueryAuthority(): BuiltinQueryAuthority | null {
  return queryAuthorityRecord?.authority ?? null;
}

export function isCurrentQueryAuthority(
  authority: BuiltinQueryAuthority | null | undefined,
): authority is BuiltinQueryAuthority {
  return Boolean(
    authority
    && !authority.revoked
    && querySession === authority.query
    && queryAuthorityRecord?.authority === authority,
  );
}

export function clearQuerySession(): Query | null {
  const session = querySession;
  replaceQuerySession(null);
  return session;
}

const mutationScope = new AsyncLocalStorage<{ active: boolean }>();

/** Serialize reset/switch/recovery mutations against the shared builtin Session. */
export function runSerializedSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
  if (mutationScope.getStore()?.active) return operation();
  const scope = { active: true };
  const predecessor = sessionMutationBarrier ?? Promise.resolve();
  let release!: () => void;
  const operationDone = new Promise<void>((resolve) => { release = resolve; });
  const barrier = predecessor.catch(() => undefined).then(() => operationDone);
  sessionMutationBarrier = barrier;

  return predecessor
    .catch(() => undefined)
    .then(() => mutationScope.run(scope, operation))
    .finally(() => {
      scope.active = false;
      release();
      if (sessionMutationBarrier === barrier) sessionMutationBarrier = null;
    });
}

/** Current barrier includes every session mutation queued at read time. */
export function getSessionMutationBarrier(): Promise<void> | null {
  return mutationScope.getStore()?.active ? null : sessionMutationBarrier;
}

/** Record a task only against the exact Query that emitted task_started. */
export function recordQueryBackgroundTask(
  query: Query | null,
  taskId: string,
  info: QueryBackgroundTaskInfo,
): boolean {
  if (!query || querySession !== query) return false;
  let tasks = queryBackgroundTasks.get(query);
  if (!tasks) {
    tasks = new Map();
    queryBackgroundTasks.set(query, tasks);
  }
  tasks.set(taskId, info);
  return true;
}

export function hasQueryBackgroundTask(query: Query | null, taskId: string): boolean {
  return Boolean(query && queryBackgroundTasks.get(query)?.has(taskId));
}

export function getQueryBackgroundTask(
  query: Query | null,
  taskId: string,
): QueryBackgroundTaskInfo | undefined {
  return query ? queryBackgroundTasks.get(query)?.get(taskId) : undefined;
}

export function hasQueryBackgroundTasks(query: Query | null = querySession): boolean {
  return Boolean(query && (queryBackgroundTasks.get(query)?.size ?? 0) > 0);
}

export function completeQueryBackgroundTask(
  query: Query | null,
  taskId: string,
): { removed: boolean; becameQuiescent: boolean; info?: QueryBackgroundTaskInfo } {
  if (!query) return { removed: false, becameQuiescent: false };
  const tasks = queryBackgroundTasks.get(query);
  const info = tasks?.get(taskId);
  if (!tasks || !info) return { removed: false, becameQuiescent: false };
  tasks.delete(taskId);
  const becameQuiescent = tasks.size === 0;
  if (becameQuiescent) queryBackgroundTasks.delete(query);
  return { removed: true, becameQuiescent, info };
}

/** Transfer remaining task ownership to the exact Query finalizer. */
export function takeQueryBackgroundTasks(
  query: Query | null,
): Array<[string, QueryBackgroundTaskInfo]> {
  if (!query) return [];
  const tasks = queryBackgroundTasks.get(query);
  if (!tasks) return [];
  queryBackgroundTasks.delete(query);
  return [...tasks.entries()];
}

export function setQueryMcpPrewarmOwner(params: {
  query: Query;
  fingerprint: string;
  requiredServerIds: readonly string[];
  startedAt?: number;
  deadlineAt?: number;
}): boolean {
  if (querySession !== params.query) return false;
  queryMcpRevision += 1;
  const startedAt = params.startedAt ?? Date.now();
  queryMcpPrewarmOwner = {
    query: params.query,
    generation: queryGeneration,
    revision: queryMcpRevision,
    fingerprint: params.fingerprint,
    requiredServerIds: [...params.requiredServerIds].sort(),
    startedAt,
    deadlineAt: params.deadlineAt ?? startedAt + MCP_PREWARM_GRACE_MS,
  };
  return true;
}

export function clearQueryMcpPrewarmOwner(query?: Query): void {
  if (query && queryMcpPrewarmOwner?.query !== query) return;
  queryMcpPrewarmOwner = null;
}

export function getQueryMcpPrewarmOwner(): {
  query: Query;
  generation: number;
  revision: number;
  fingerprint: string;
  requiredServerIds: readonly string[];
  startedAt: number;
  deadlineAt: number;
  outcome?: McpPrewarmOutcome;
} | null {
  if (!queryMcpPrewarmOwner || queryMcpPrewarmOwner.query !== querySession) return null;
  return {
    ...queryMcpPrewarmOwner,
    requiredServerIds: [...queryMcpPrewarmOwner.requiredServerIds],
  };
}

/** Settle one Query/map generation exactly once. */
export function settleQueryMcpPrewarmOwner(params: {
  query: Query;
  generation: number;
  revision: number;
  outcome: Exclude<McpPrewarmOutcome, { state: 'owner_replaced' }>;
}): boolean {
  const owner = queryMcpPrewarmOwner;
  if (!owner
    || owner.query !== params.query
    || owner.generation !== params.generation
    || owner.revision !== params.revision
    || owner.outcome) {
    return false;
  }
  owner.outcome = params.outcome;
  return true;
}

/**
 * One SDK mcp_status control request at a time per Query owner. The SDK API
 * has no AbortSignal; if one request wedges, retries share it instead of
 * accumulating pendingControlResponses until Query teardown.
 */
export function readQueryMcpStatuses(query: Query): ReturnType<Query['mcpServerStatus']> {
  const owner = queryMcpPrewarmOwner;
  if (!owner || owner.query !== query || querySession !== query) {
    return Promise.reject(new Error('MCP pre-warm owner is no longer current'));
  }
  if (owner.statusRead) return owner.statusRead;
  const read = query.mcpServerStatus();
  owner.statusRead = read.finally(() => {
    if (queryMcpPrewarmOwner === owner) owner.statusRead = undefined;
  });
  return owner.statusRead;
}

/**
 * Claim the one live MCP transport mutation allowed for the current Query
 * generation. The owner is published synchronously before `run` starts, so a
 * generator promotion in the next microtask can fence on the same promise.
 */
export function claimQueryMcpMutation(
  query: Query,
  run: () => Promise<QueryMcpMutationResult>,
): { claimed: boolean; promise: Promise<QueryMcpMutationResult> } {
  if (querySession !== query) {
    return {
      claimed: false,
      promise: Promise.resolve({
        ok: false,
        reason: 'query_replaced',
        error: 'Query was replaced before MCP transport mutation',
      }),
    };
  }
  if (queryMcpMutationOwner) {
    return { claimed: false, promise: queryMcpMutationOwner.promise };
  }

  let resolvePromise!: (result: QueryMcpMutationResult) => void;
  const promise = new Promise<QueryMcpMutationResult>((resolve) => {
    resolvePromise = resolve;
  });
  const owner = {
    query,
    generation: queryGeneration,
    promise,
    settle(result: QueryMcpMutationResult) {
      if (queryMcpMutationOwner !== owner) return;
      queryMcpMutationOwner = null;
      resolvePromise(result);
    },
  };
  queryMcpMutationOwner = owner;

  try {
    void run().then(
      result => owner.settle(result),
      error => owner.settle({
        ok: false,
        reason: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } catch (error) {
    owner.settle({
      ok: false,
      reason: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { claimed: true, promise };
}

export function getQueryMcpMutation(
  query: Query | null = querySession,
): { generation: number; promise: Promise<QueryMcpMutationResult> } | null {
  if (!query || !queryMcpMutationOwner || queryMcpMutationOwner.query !== query) return null;
  return {
    generation: queryMcpMutationOwner.generation,
    promise: queryMcpMutationOwner.promise,
  };
}

export function isSessionProcessing(): boolean {
  return isProcessing;
}

export function setSessionProcessing(value: boolean): void {
  isProcessing = value;
}

export function isAbortRequested(): boolean {
  return abortRequested;
}

export function requestAbort(): void {
  queryAuthorityRecord?.revoke();
  resetControlPlaneState();
  abortRequested = true;
  for (const waiter of queryExitWaiters) waiter.resolve();
  queryExitWaiters.clear();
}

/**
 * Wait for the current Query generation to enter its abort path.
 *
 * This is deliberately separate from `waitForMessage`: a generator quarantined
 * behind a required Query rebuild must not be woken by a newly enqueued user
 * message. Only abort or replacement of that exact Query may release it.
 */
export function waitForQueryExit(query: Query): Promise<void> {
  if (abortRequested || querySession !== query) return Promise.resolve();
  return new Promise(resolve => { queryExitWaiters.add({ query, resolve }); });
}

export function clearAbortFlag(): void {
  abortRequested = false;
}

export function getSessionTerminationPromise(): Promise<void> | null {
  return sessionTerminationPromise;
}

export function setSessionTerminationPromise(promise: Promise<void> | null): void {
  sessionTerminationPromise = promise;
}

/**
 * Extend the canonical Session-abort barrier with an exact pre-dispatch
 * rollback. Query termination and domain rollback are independent owners;
 * reset/switch/restart is complete only after both have settled.
 */
export function registerSessionAbortCleanup(cleanup: Promise<void>): void {
  const previous = abortCleanupPromise;
  const combined = (previous
    ? Promise.all([previous, cleanup])
    : cleanup
  ).then(() => undefined);
  abortCleanupPromise = combined;
  void combined.finally(() => {
    if (abortCleanupPromise === combined) abortCleanupPromise = null;
  }).catch(() => undefined);
}

async function awaitSessionAbortCleanup(): Promise<void> {
  while (abortCleanupPromise) {
    await abortCleanupPromise;
  }
}

export function isPreWarmInProgress(): boolean {
  return isPreWarming;
}

export function setPreWarmInProgress(value: boolean): void {
  isPreWarming = value;
}

export function getPreWarmTimer(): ReturnType<typeof setTimeout> | null {
  return preWarmTimer;
}

export function setPreWarmTimer(timer: ReturnType<typeof setTimeout> | null): void {
  preWarmTimer = timer;
}

export function clearPreWarmTimer(): void {
  if (preWarmTimer) clearTimeout(preWarmTimer);
  preWarmTimer = null;
}

export function getPreWarmFailCount(): number {
  return preWarmFailCount;
}

export function resetPreWarmFailCount(): void {
  preWarmFailCount = 0;
}

export function incrementPreWarmFailCount(): number {
  preWarmFailCount += 1;
  return preWarmFailCount;
}

export function getPreWarmMaxRetries(): number {
  return PRE_WARM_MAX_RETRIES;
}

export function isPreWarmDisabled(): boolean {
  return preWarmDisabled;
}

export function setPreWarmDisabled(value: boolean): void {
  preWarmDisabled = value;
}

export function getSystemInitInfo(): SystemInitInfo | null {
  return systemInitInfo;
}

export function setSystemInitInfo(info: SystemInitInfo | null): void {
  systemInitInfo = info;
  systemInitAuthority = info ? getCurrentQueryAuthority() : null;
}

export function getSystemInitAuthority(): BuiltinQueryAuthority | null {
  return systemInitAuthority;
}

export function isSdkControlReady(): boolean {
  return sdkControlReady;
}

export function setSdkControlReady(value: boolean): void {
  sdkControlReady = value;
}

export function hasMessageResolver(): boolean {
  return messageResolver !== null;
}

export function wakeGenerator(item: MessageQueueItem | null): void {
  console.log(`[builtin-input] phase=resolver-wake generation=${queryGeneration} parked=${messageResolver !== null} input=${item !== null}`);
  if (!messageResolver) return;
  const resolve = messageResolver;
  messageResolver = null;
  resolve(item);
}

export function waitForMessage(dequeue: () => MessageQueueItem | undefined): Promise<MessageQueueItem | null> {
  if (abortRequested) {
    console.log(`[builtin-input] phase=message-wait-aborted generation=${queryGeneration}`);
    return Promise.resolve(null);
  }
  const queued = dequeue();
  if (queued) {
    console.log(`[builtin-input] phase=message-dequeued generation=${queryGeneration}`);
    return Promise.resolve(queued);
  }
  return new Promise(resolve => {
    const resolverGeneration = queryGeneration;
    console.log(`[builtin-input] phase=resolver-parked generation=${resolverGeneration}`);
    messageResolver = item => {
      console.log(`[builtin-input] phase=resolver-received installedGeneration=${resolverGeneration} currentGeneration=${queryGeneration} input=${item !== null}`);
      resolve(item);
    };
  });
}

export function resetControlPlaneState(): void {
  systemInitInfo = null;
  systemInitAuthority = null;
  sdkControlReady = false;
}

export function nextBuiltinLiveRevision(): number {
  liveRevision += 1;
  return liveRevision;
}

export function getBuiltinLiveRevision(): number {
  return liveRevision;
}

export function resetBuiltinLiveRevision(): void {
  liveRevision = 0;
}

export function resetPreWarmState(): void {
  isPreWarming = false;
  preWarmFailCount = 0;
  clearPreWarmTimer();
}

export function clearGeneratorResolver(): void {
  console.log(`[builtin-input] phase=resolver-cleared generation=${queryGeneration} parked=${messageResolver !== null}`);
  messageResolver = null;
}

export function forceWakeGeneratorWithNull(): void {
  wakeGenerator(null);
}

export async function awaitSessionTermination(params: {
  timeoutMs?: number;
  label?: string;
  onTimeoutForceCleanup?: (session: Query | null) => void;
} = {}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const label = params.label ?? '';
  const termination = sessionTerminationPromise;
  if (termination) {
    let timerId: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        termination,
        new Promise<never>((_, reject) => {
          timerId = setTimeout(() => reject(new Error(`sessionTermination timeout (${label})`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      const isTimeout = error instanceof Error && error.message.includes('timeout');
      console.warn(`[agent] ${label}: sessionTerminationPromise ${isTimeout ? 'timed out' : 'rejected'} after ${timeoutMs}ms, force-cleaning:`, error);
      const session = clearQuerySession();
      isProcessing = false;
      isPreWarming = false;
      forceWakeGeneratorWithNull();
      params.onTimeoutForceCleanup?.(session);
      try { void session?.close(); } catch { /* subprocess may already be dead */ }
    } finally {
      clearTimeout(timerId!);
    }
  }
  // Do not put the durable domain rollback under the Query's force-cleanup
  // timeout. A timeout may prove the subprocess dead; it cannot prove that a
  // Goal/Task reservation was rolled back.
  await awaitSessionAbortCleanup();
}

export function snapshotLifecycle(): BuiltinLifecycleSnapshot {
  return {
    querySession,
    queryGeneration,
    queryMcpRevision,
    queryMcpFingerprint: queryMcpPrewarmOwner?.fingerprint ?? null,
    queryMcpServerIds: [...(queryMcpPrewarmOwner?.requiredServerIds ?? [])],
    queryMcpMutationInFlight: queryMcpMutationOwner !== null,
    isProcessing,
    abortRequested,
    sessionTerminationPromise,
    abortCleanupInFlight: abortCleanupPromise !== null,
    isPreWarming,
    preWarmTimer,
    preWarmFailCount,
    preWarmDisabled,
    systemInitInfo,
    sdkControlReady,
    hasMessageResolver: messageResolver !== null,
  };
}

export function resetLifecycleForTest(): void {
  for (const waiter of queryExitWaiters) waiter.resolve();
  queryExitWaiters.clear();
  queryMcpMutationOwner?.settle({
    ok: false,
    reason: 'query_replaced',
    error: 'Lifecycle reset during MCP transport mutation',
  });
  querySession = null;
  queryAuthorityRecord?.revoke();
  queryAuthorityRecord = null;
  queryGeneration = 0;
  queryMcpRevision = 0;
  queryMcpPrewarmOwner = null;
  queryMcpMutationOwner = null;
  queryBackgroundTasks.clear();
  isProcessing = false;
  abortRequested = false;
  sessionTerminationPromise = null;
  abortCleanupPromise = null;
  clearGeneratorResolver();
  isPreWarming = false;
  preWarmTimer = null;
  preWarmFailCount = 0;
  preWarmDisabled = false;
  systemInitInfo = null;
  systemInitAuthority = null;
  sdkControlReady = false;
  sessionMutationBarrier = null;
}
