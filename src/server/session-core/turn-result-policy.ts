export type BuiltinInjectedTurnTerminal =
  | {
      status: 'complete';
      assistantMessagePresent: boolean;
      text: string;
      error?: string;
    }
  | {
      status: 'stopped' | 'error';
      assistantMessagePresent: boolean;
      text: string;
      error?: string;
      code?: string;
    };

export type InjectedTurnDecision = {
  success: boolean;
  assistantMessagePresent?: boolean;
  text?: string;
  error?: string;
  code?: string;
  status?: number;
};

export type TransientProviderTextErrorKind =
  | 'concurrency_limit'
  | 'rate_limit'
  | 'temporarily_overloaded';

export type TransientProviderTextError = {
  kind: TransientProviderTextErrorKind;
  rawText: string;
  userMessage: string;
};

export type BuiltinSdkTerminalDisposition = 'complete' | 'stopped' | 'error';

/**
 * Decide whether a builtin SDK result represents a genuinely completed turn.
 *
 * `is_error` alone is not authoritative: the SDK can emit a success-shaped
 * result for limits, setup failures, or other non-completed terminal reasons.
 * Missing terminal_reason remains compatible with older SDK/bridge payloads,
 * while unknown future values fail closed instead of completing Task/Goal
 * owners with a partial answer.
 */
export function classifyBuiltinSdkTerminalResult(params: {
  isError: boolean;
  terminalReason?: unknown;
}): BuiltinSdkTerminalDisposition {
  const terminalReason = params.terminalReason;
  if (typeof terminalReason === 'string' && terminalReason.startsWith('aborted_')) {
    return 'stopped';
  }
  if (params.isError) return 'error';
  if (terminalReason == null || terminalReason === '' || terminalReason === 'completed') {
    return 'complete';
  }
  return 'error';
}

export type TransientProviderTextRetryDecision =
  | {
      retry: true;
      error: TransientProviderTextError;
      attempt: number;
      maxRetries: number;
      delayMs: number;
    }
  | {
      retry: false;
      error: TransientProviderTextError | null;
      exhausted: boolean;
      maxRetries: number;
    };

export const TRANSIENT_PROVIDER_TEXT_RETRY_DELAYS_MS = [15_000, 30_000, 60_000] as const;

function normalizeProviderErrorText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function hasAny(text: string, needles: readonly string[]): boolean {
  return needles.some(needle => text.includes(needle));
}

export function classifyTransientProviderTextError(text: string): TransientProviderTextError | null {
  const rawText = text.trim();
  if (!rawText || rawText.length > 800 || rawText.split(/\r?\n/).length > 8) {
    return null;
  }

  const normalized = normalizeProviderErrorText(rawText);
  const hasErrorPrefix = /^(?:\[?error\]?|api error|provider error|upstream error)\s*[:：-]/i.test(rawText);
  const mentionsRetryLater = hasAny(normalized, [
    'please retry later',
    'try again later',
    'retry later',
  ]);

  if (
    normalized.includes('concurrency limit exceeded') &&
    (hasErrorPrefix || normalized.startsWith('concurrency limit exceeded') || mentionsRetryLater)
  ) {
    return {
      kind: 'concurrency_limit',
      rawText,
      userMessage: '上游模型服务达到账号并发限制，请稍后重试。',
    };
  }

  if (
    (
      normalized.includes('rate_limit_exceeded') ||
      normalized.includes('rate limit exceeded') ||
      normalized.includes('too many requests') ||
      (hasErrorPrefix && normalized.includes('rate limit'))
    ) && (
      hasErrorPrefix ||
      normalized.startsWith('rate_limit_exceeded') ||
      normalized.startsWith('rate limit exceeded') ||
      normalized.startsWith('too many requests') ||
      mentionsRetryLater
    )
  ) {
    return {
      kind: 'rate_limit',
      rawText,
      userMessage: '上游模型服务触发临时限流，请稍后重试。',
    };
  }

  if (
    (
      normalized.includes('temporarily overloaded') ||
      normalized.includes('temporarily unavailable') ||
      (hasErrorPrefix && hasAny(normalized, ['overloaded', 'service unavailable']))
    ) && (
      hasErrorPrefix ||
      normalized.startsWith('temporarily overloaded') ||
      normalized.startsWith('temporarily unavailable') ||
      mentionsRetryLater
    )
  ) {
    return {
      kind: 'temporarily_overloaded',
      rawText,
      userMessage: '上游模型服务临时过载，请稍后重试。',
    };
  }

  return null;
}

export function decideTransientProviderTextRetry(params: {
  resultText: string;
  isError: boolean;
  isAbortResult?: boolean;
  apiErrorStatus?: number | null;
  toolUseCount?: number;
  currentAttempt: number;
  retryDelaysMs?: readonly number[];
}): TransientProviderTextRetryDecision {
  const retryDelaysMs = params.retryDelaysMs ?? TRANSIENT_PROVIDER_TEXT_RETRY_DELAYS_MS;
  const maxRetries = retryDelaysMs.length;
  if (params.isError || params.isAbortResult || params.apiErrorStatus != null) {
    return { retry: false, error: null, exhausted: false, maxRetries };
  }

  const error = classifyTransientProviderTextError(params.resultText);
  if (!error) {
    return { retry: false, error: null, exhausted: false, maxRetries };
  }

  if ((params.toolUseCount ?? 0) > 0) {
    return { retry: false, error, exhausted: false, maxRetries };
  }

  if (params.currentAttempt >= maxRetries) {
    return { retry: false, error, exhausted: true, maxRetries };
  }

  return {
    retry: true,
    error,
    attempt: params.currentAttempt + 1,
    maxRetries,
    delayMs: retryDelaysMs[params.currentAttempt],
  };
}

export function decideBuiltinInjectedTurnResult(params: {
  idleCompleted: boolean;
  outcome?: BuiltinInjectedTurnTerminal;
}): InjectedTurnDecision {
  if (!params.idleCompleted) {
    return { success: false, error: 'Execution timed out', status: 408 };
  }
  if (!params.outcome) {
    return {
      success: false,
      error: 'Injected turn finished without a recorded outcome',
      status: 503,
    };
  }
  if (params.outcome.status !== 'complete') {
    return {
      success: false,
      error: params.outcome.error ?? `Injected turn ${params.outcome.status}`,
      ...(params.outcome.code ? { code: params.outcome.code } : {}),
      status: 503,
    };
  }
  return {
    success: true,
    assistantMessagePresent: params.outcome.assistantMessagePresent,
    text: params.outcome.text,
  };
}

export function decideExternalInjectedTurnResult(params: {
  idleCompleted: boolean;
  turnSucceeded?: boolean;
  text?: string;
  error?: string;
}): InjectedTurnDecision {
  if (!params.idleCompleted) {
    return { success: false, error: 'Execution timed out', status: 408 };
  }
  if (!params.turnSucceeded) {
    return {
      success: false,
      error: params.error ?? 'External runtime turn failed',
      status: 503,
    };
  }
  return { success: true, text: params.text };
}
