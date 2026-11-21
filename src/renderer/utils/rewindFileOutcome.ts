export type RewindResponse = {
  success?: boolean;
  error?: string;
  skippedLinks?: number;
  fileRewindStatus?: 'complete' | 'partial' | 'failed' | 'not_attempted';
  rewindScope?: 'conversation-only';
  errorCode?: string;
};

export type RewindTransportOutcome = 'rejected' | 'committed' | 'unchanged' | 'target-unknown' | 'unresolved';

export type RewindRecoveryProjection = {
  restoreMessageSnapshot: boolean;
  restoreComposerSnapshot: boolean;
};

export function classifyRewindTransportOutcome(
  result: { restored: boolean; targetMessagePresent: boolean | null } | null,
): RewindTransportOutcome {
  if (!result?.restored) return 'unresolved';
  if (result.targetMessagePresent === null) return 'target-unknown';
  return result.targetMessagePresent ? 'unchanged' : 'committed';
}

export function projectRewindRecovery(
  outcome: RewindTransportOutcome,
): RewindRecoveryProjection {
  return {
    restoreMessageSnapshot: outcome === 'rejected',
    restoreComposerSnapshot: outcome === 'rejected' || outcome === 'unchanged',
  };
}

type Translate = (key: string, options?: { count: number }) => string;

/** Keep transcript success separate from the optional workspace-file outcome. */
export function warnRewindFileOutcome(
  result: RewindResponse | undefined,
  warning: (message: string) => void,
  translate: Translate,
): void {
  if (result?.success === false && result.fileRewindStatus === 'complete') {
    warning(translate('shell.toasts.rewindFilesAlreadyRestored'));
  } else if (result?.fileRewindStatus === 'failed') {
    warning(translate('shell.toasts.rewindFilesFailed'));
  } else if (result?.fileRewindStatus === 'not_attempted') {
    warning(translate('shell.toasts.rewindFilesNotAttempted'));
  } else if (result?.fileRewindStatus === 'partial' || (result?.skippedLinks ?? 0) > 0) {
    warning(translate('shell.toasts.rewindPartialLinks', { count: result?.skippedLinks ?? 0 }));
  }
}

/** A validation/capability rejection is known; IO/transport failures remain ambiguous. */
export function isConversationRejection(error: unknown): error is { status: number; errorCode?: unknown } {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  return error.status === 400 || error.status === 409 ||
    (error.status === 502 && 'errorCode' in error && error.errorCode === 'native_fork_failed');
}

export function getConversationRejectionMessage(error: unknown, translate: Translate): string | null {
  if (!isConversationRejection(error)) return null;
  if ('errorCode' in error && typeof error.errorCode === 'string') {
    return translate(`shell.toasts.conversationError.${error.errorCode}`);
  }
  return error instanceof Error ? error.message : translate('shell.toasts.unknownError');
}
