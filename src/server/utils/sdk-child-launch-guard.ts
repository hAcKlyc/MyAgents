import { createHash } from 'crypto';
import { realpathSync, statSync } from 'fs';
import { managementApi } from './management-api-client';
import { isUpdaterQaBuild } from '../../shared/updaterQa';
import {
  diagnoseSdkSubprocessFailure,
  SdkChildLaunchCircuitOpenError,
} from './sdk-subprocess-diagnostics';

type ManagementCall = (
  path: string,
  method?: 'GET' | 'POST',
  body?: Record<string, unknown>,
  requestOptions?: { timeoutMs?: number; parentSignal?: AbortSignal },
) => Promise<unknown>;

type GuardOptions = {
  managementCall?: ManagementCall;
  sidecarId?: string;
};

type QueryWithInitialization = {
  initializationResult?: () => Promise<unknown>;
};

const MANAGEMENT_GUARD_TIMEOUT_MS = 2_000;
const MIN_RETRY_AFTER_MS = 1_000;

function executableIdentity(executablePath: string): string {
  let canonicalPath = executablePath;
  let metadata = 'metadata-unavailable';
  try {
    canonicalPath = realpathSync(executablePath);
    const stat = statSync(canonicalPath);
    metadata = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.mode].join(':');
  } catch {
    // Tests, development shims, and an executable removed during update may
    // not be stat-able. The normalized path still gives Rust a stable scope;
    // the real spawn error remains the source of truth.
  }
  return createHash('sha256')
    .update(`${canonicalPath}\0${metadata}`)
    .digest('hex');
}

function deterministicErrorCode(value: unknown): 'EPERM' | 'EACCES' | 'ENOEXEC' | null {
  return value === 'EPERM' || value === 'EACCES' || value === 'ENOEXEC' ? value : null;
}

function finiteRetryAfter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(MIN_RETRY_AFTER_MS, Math.round(value))
    : MIN_RETRY_AFTER_MS;
}

function continueWithoutCircuit<T>(createQuery: () => T, reason: string): T {
  console.warn(`[sdk-child-launch-guard] ${reason}; continuing without application circuit`);
  return createQuery();
}

function responseRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Application-level admission around the SDK's child-process control plane.
 *
 * Rust owns the best-effort retry circuit because Session:Sidecar is 1:1: a
 * process-local flag would still allow every tab, IM bot, and background owner
 * to retry the same broken bundled executable. The circuit is not the SDK
 * launch owner: only an explicit denial carrying a deterministic OS spawn
 * error may veto a launch. Missing, stale, or malformed control-plane state
 * fails open so lifecycle bookkeeping cannot disable an otherwise healthy SDK.
 */
export async function createGuardedSdkQuery<T>(
  executablePath: string,
  createQuery: () => T,
  options: GuardOptions = {},
): Promise<T> {
  // QA update acceptance never launches a model process or its OAuth fallback.
  if (isUpdaterQaBuild()) throw new Error('UPDATER_QA_EXECUTION_DISABLED');
  const sidecarId = options.sidecarId ?? process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (!sidecarId) {
    return continueWithoutCircuit(createQuery, 'missing sidecar identity');
  }

  const call = options.managementCall ?? managementApi;
  const identity = executableIdentity(executablePath);
  const requestOptions = { timeoutMs: MANAGEMENT_GUARD_TIMEOUT_MS };
  let admissionResult: unknown;
  try {
    admissionResult = await call(
      '/api/runtime/sdk-child/admit',
      'POST',
      { sidecarId, executableIdentity: identity },
      requestOptions,
    );
  } catch {
    return continueWithoutCircuit(createQuery, 'management admission failed');
  }
  const admission = responseRecord(admissionResult);
  if (!admission) {
    return continueWithoutCircuit(createQuery, 'invalid admission response');
  }
  if (admission.ok !== true) {
    const code = typeof admission.code === 'string' ? admission.code : 'invalid admission response';
    return continueWithoutCircuit(createQuery, code);
  }

  if (admission.admitted !== true) {
    const errorCode = deterministicErrorCode(admission.errorCode);
    if (admission.admitted !== false || !errorCode) {
      return continueWithoutCircuit(createQuery, 'malformed circuit denial');
    }
    const retryAfterMs = finiteRetryAfter(admission.retryAfterMs);
    throw new SdkChildLaunchCircuitOpenError(errorCode, retryAfterMs);
  }

  const admissionEpoch = admission.admissionEpoch;
  if (typeof admissionEpoch !== 'number' || !Number.isSafeInteger(admissionEpoch) || admissionEpoch <= 0) {
    return continueWithoutCircuit(createQuery, 'missing admission epoch');
  }

  let settled = false;
  let settleInFlight: Promise<void> | null = null;
  const settle = async (
    outcome: 'ready' | 'spawn_denied' | 'released',
    errorCode?: 'EPERM' | 'EACCES' | 'ENOEXEC',
  ): Promise<void> => {
    if (settled) return;
    if (settleInFlight) return settleInFlight;
    settleInFlight = (async () => {
      try {
        const result = responseRecord(await call(
          '/api/runtime/sdk-child/settle',
          'POST',
          {
            sidecarId,
            executableIdentity: identity,
            admissionEpoch,
            outcome,
            ...(errorCode ? { errorCode } : {}),
          },
          requestOptions,
        ));
        if (result?.ok === true) {
          settled = true;
        } else {
          console.warn('[sdk-child-launch-guard] invalid settlement response; ignoring');
        }
      } catch {
        console.warn('[sdk-child-launch-guard] management settlement failed; ignoring');
      }
    })().finally(() => {
      settleInFlight = null;
    });
    return settleInFlight;
  };

  const settleFromError = (error: unknown): void => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      error,
    });
    if (diagnostic?.kind === 'sdk-child-spawn-denied' && diagnostic.errorCode) {
      void settle('spawn_denied', diagnostic.errorCode);
    } else {
      void settle('released');
    }
  };

  let sdkQuery: T;
  try {
    sdkQuery = createQuery();
  } catch (error) {
    settleFromError(error);
    throw error;
  }

  const initializationResult = (sdkQuery as QueryWithInitialization).initializationResult;
  if (typeof initializationResult !== 'function') {
    void settle('released');
    return sdkQuery;
  }

  try {
    void initializationResult.call(sdkQuery).then(
      () => { void settle('ready'); },
      settleFromError,
    );
  } catch (error) {
    settleFromError(error);
  }
  return sdkQuery;
}
