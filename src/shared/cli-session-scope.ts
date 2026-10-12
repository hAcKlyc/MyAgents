import { APP_CLI_NAME } from './appProfile';
export const CLI_SESSION_HEADER = 'x-myagents-session-id';

export function isCliProductSessionId(value: string): boolean {
  return /^[A-Za-z0-9-]{1,99}$/u.test(value);
}

export function cliSessionScopeError(requested: string | null, current: string | null | undefined) {
  if (requested === null) return undefined;
  if (isCliProductSessionId(requested) && requested === current) return undefined;
  return {
    success: false as const,
    code: 'CLI_SESSION_SCOPE_MISMATCH',
    error: 'The CLI request does not belong to this Sidecar Session.',
    recoveryHint: {
      message: 'Retry from the active Session so its current routing context is used.',
      recoveryCommand: `${APP_CLI_NAME} agent current --json`,
    },
  };
}
