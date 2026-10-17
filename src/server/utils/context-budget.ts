import { SDK_DEFAULT_CONTEXT_WINDOW } from '../../shared/contextUsage';

const MAX_PLAUSIBLE_CONTEXT_WINDOW = 20_000_000;

function validWindow(value: number | null | undefined): number | undefined {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= MAX_PLAUSIBLE_CONTEXT_WINDOW
    ? value
    : undefined;
}

export function resolveBuiltinContextBudget(input: {
  declaredWindow?: number | null;
  operationalWindow?: number | null;
  apiRoute: boolean;
}): { window: number; declaredWindow?: number; source: 'registry' | 'default' | 'safety-budget' } {
  const declaredWindow = validWindow(input.declaredWindow);

  if (!input.apiRoute) {
    return declaredWindow
      ? { window: declaredWindow, declaredWindow, source: 'registry' }
      : { window: SDK_DEFAULT_CONTEXT_WINDOW, source: 'default' };
  }

  // Unknown custom API limits are not capacity evidence; compact against a conservative budget.
  const operationalWindow = validWindow(input.operationalWindow)
    ?? SDK_DEFAULT_CONTEXT_WINDOW;
  if (declaredWindow !== undefined && declaredWindow <= operationalWindow) {
    return { window: declaredWindow, declaredWindow, source: 'registry' };
  }

  return {
    window: operationalWindow,
    ...(declaredWindow === undefined ? {} : { declaredWindow }),
    source: 'safety-budget',
  };
}

export function classifyContextTurnFailure(input: {
  compactResult?: 'success' | 'failed' | null;
  apiErrorStatus?: number | null;
  errorText?: string;
}): 'compaction_failed' | 'context_recovery_required' | 'provider_invalid_request' | 'automatic_replay_blocked' | undefined {
  if (input.compactResult === 'failed') return 'compaction_failed';

  const text = input.errorText?.toLowerCase() ?? '';
  if (/automatic_replay_blocked|replay_blocked/.test(text)) return 'automatic_replay_blocked';
  if (/context_recovery_required/.test(text)) return 'context_recovery_required';
  if (/context_length_exceeded|context(?: window| length)? (?:is )?(?:full|exceeded)|prompt (?:is )?too long|maximum context length/.test(text)) {
    return 'context_recovery_required';
  }

  // HTTP 400 alone says the request was invalid, not that context capacity was exceeded.
  if (input.apiErrorStatus === 400) return 'provider_invalid_request';
  return undefined;
}
