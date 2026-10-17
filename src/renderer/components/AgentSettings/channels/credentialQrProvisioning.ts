import type { CredentialQrProvider } from '../../../../shared/types/im';

export interface CredentialQrStartResult {
  sessionKey: string;
  qrUrl: string;
  sessionDomain?: string;
  pollIntervalMs: number;
  expiresInMs: number;
}

export interface CredentialQrPollResult {
  status: 'waiting' | 'success' | 'expired' | 'cancelled' | 'denied';
  configValues?: Record<string, string>;
  allowedUserId?: string;
  sessionDomain?: string;
  nextPollIntervalMs?: number;
}

export interface CredentialQrRunSuccess {
  kind: 'success';
  result: CredentialQrPollResult & { configValues: Record<string, string> };
  refreshCount: number;
}

export interface CredentialQrRunFailure {
  kind: 'error';
  reason: 'expired' | 'denied' | 'cancelled' | 'start-failed' | 'poll-failed' | 'invalid-response';
  refreshCount: number;
  message?: string;
}

/** Both setup surfaces show the failed operation, never infer it from refresh count. */
export function credentialQrFailureMessageKey(reason: CredentialQrRunFailure['reason'] | undefined) {
  switch (reason) {
    case 'denied':
    case 'cancelled': return 'agentSettings.channelWizard.dual.scanDenied';
    case 'expired': return 'agentSettings.channelWizard.dual.qrExpiredMultiple';
    case 'poll-failed': return 'agentSettings.channelWizard.dual.qrPollFailed';
    case 'invalid-response': return 'agentSettings.channelWizard.dual.qrInvalidResponse';
    default: return 'agentSettings.channelWizard.qr.loadFailed';
  }
}

export type CredentialQrRunResult =
  | CredentialQrRunSuccess
  | CredentialQrRunFailure
  | { kind: 'cancelled'; refreshCount: number };

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface CredentialProvisioningChannelStatus {
  status?: string;
}

export function credentialProvisioningRequiresRestart(
  status: CredentialProvisioningChannelStatus | null | undefined,
): boolean {
  return status?.status === 'online' || status?.status === 'connecting';
}

/**
 * Restart only when a fresh runtime status says the Channel is active. Failures
 * deliberately propagate: credentials may already be persisted, so claiming a
 * successful re-provision while the old runtime is still active would be false.
 */
export async function restartProvisionedChannelIfRunning(
  status: CredentialProvisioningChannelStatus | null | undefined,
  stopChannel: () => Promise<void>,
  startChannel: () => Promise<void>,
): Promise<boolean> {
  if (!credentialProvisioningRequiresRestart(status)) return false;
  await stopChannel();
  await startChannel();
  return true;
}

interface RunCredentialQrProvisioningOptions {
  provider: CredentialQrProvider;
  invoke: Invoke;
  isCancelled: () => boolean;
  onPhase: (phase: 'loading' | 'waiting', refreshCount: number) => void;
  onQrUrl: (url: string, refreshCount: number) => Promise<void> | void;
  maxRefreshes?: number;
  maxPollsPerQr?: number;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_MAX_REFRESHES = 5;
// Provider expiry is the primary bound (Feishu currently returns one hour).
// Keep a second finite ceiling in case an upstream supplies a broken duration.
const DEFAULT_MAX_POLLS_PER_QR = 1_000;

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasProvisionedCredentials(
  requiredFields: readonly string[],
  configValues: Readonly<Record<string, string>> | undefined,
): boolean {
  return requiredFields.length > 0
    && requiredFields.every(field => String(configValues?.[field] ?? '').trim().length > 0);
}

/**
 * Run one provider-neutral QR credential provisioning lifecycle.
 *
 * The Rust command owns provider endpoints and response normalization. This
 * runner owns only the short-lived UI lifecycle: timing, expiry refresh, and
 * cancellation when the wizard closes or switches to manual mode.
 */
export async function runCredentialQrProvisioning({
  provider,
  invoke,
  isCancelled,
  onPhase,
  onQrUrl,
  maxRefreshes = DEFAULT_MAX_REFRESHES,
  maxPollsPerQr = DEFAULT_MAX_POLLS_PER_QR,
  delay = defaultDelay,
  now = Date.now,
}: RunCredentialQrProvisioningOptions): Promise<CredentialQrRunResult> {
  let refreshCount = 0;
  let globalPollIndex = 0;

  while (refreshCount <= maxRefreshes) {
    if (isCancelled()) return { kind: 'cancelled', refreshCount };
    onPhase('loading', refreshCount);

    let start: CredentialQrStartResult;
    try {
      start = await invoke<CredentialQrStartResult>('cmd_channel_credential_qr_start', { provider });
      if (!start.sessionKey || !start.qrUrl || start.pollIntervalMs <= 0 || start.expiresInMs <= 0) {
        return { kind: 'error', reason: 'invalid-response', refreshCount };
      }
      if (isCancelled()) return { kind: 'cancelled', refreshCount };
      await onQrUrl(start.qrUrl, refreshCount);
    } catch (error) {
      return { kind: 'error', reason: 'start-failed', refreshCount, message: errorMessage(error) };
    }

    if (isCancelled()) return { kind: 'cancelled', refreshCount };
    onPhase('waiting', refreshCount);

    let pollIntervalMs = start.pollIntervalMs;
    let sessionDomain = start.sessionDomain;
    const expiresAt = now() + start.expiresInMs;
    let pollsThisQr = 0;
    let shouldRefresh = false;

    while (pollsThisQr < maxPollsPerQr && now() < expiresAt) {
      await delay(pollIntervalMs);
      if (isCancelled()) return { kind: 'cancelled', refreshCount };

      let poll: CredentialQrPollResult;
      try {
        poll = await invoke<CredentialQrPollResult>('cmd_channel_credential_qr_poll', {
          provider,
          sessionKey: start.sessionKey,
          sessionDomain,
          pollIntervalMs,
          pollIndex: globalPollIndex,
        });
      } catch (error) {
        return { kind: 'error', reason: 'poll-failed', refreshCount, message: errorMessage(error) };
      }
      globalPollIndex += 1;
      pollsThisQr += 1;
      sessionDomain = poll.sessionDomain ?? sessionDomain;
      pollIntervalMs = poll.nextPollIntervalMs ?? pollIntervalMs;

      if (poll.status === 'success') {
        if (!poll.configValues || Object.keys(poll.configValues).length === 0) {
          return { kind: 'error', reason: 'invalid-response', refreshCount };
        }
        return {
          kind: 'success',
          result: { ...poll, configValues: poll.configValues },
          refreshCount,
        };
      }
      if (poll.status === 'expired') {
        shouldRefresh = true;
        break;
      }
      if (poll.status === 'denied' || poll.status === 'cancelled') {
        return { kind: 'error', reason: poll.status, refreshCount };
      }
    }

    if (!shouldRefresh && pollsThisQr < maxPollsPerQr && now() < expiresAt) {
      return { kind: 'error', reason: 'invalid-response', refreshCount };
    }
    refreshCount += 1;
  }

  return { kind: 'error', reason: 'expired', refreshCount: maxRefreshes };
}
