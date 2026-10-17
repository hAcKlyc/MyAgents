import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RedoIcon } from '@/components/icons';
import Tip from '@/components/Tip';
import type { McpEffectiveServerSnapshot } from '../../../../shared/mcpEffectiveState';
import type { McpRetryResult } from '../../../../shared/mcpFailure';

export function McpStatusNotice({ server, stale, busy, onRetry }: {
  server: McpEffectiveServerSnapshot;
  stale?: boolean;
  busy?: boolean;
  onRetry?: (serverId: string) => Promise<McpRetryResult>;
}) {
  const { t } = useTranslation('chat');
  const [retrying, setRetrying] = useState(false);
  const [acceptedSnapshot, setAcceptedSnapshot] = useState<McpEffectiveServerSnapshot | null>(null);
  const [retryFailure, setRetryFailure] = useState<{ snapshot: McpEffectiveServerSnapshot; message: string } | null>(null);
  const pending = useRef(false);
  const failed = server.state === 'failed';
  const stopped = server.state === 'stopped';
  const connecting = retrying || acceptedSnapshot === server
    || server.state === 'starting' || server.state === 'queued';
  if (server.state === 'ready' || server.state === 'disabled') return null;
  const reason = t(`input.mcpStatus.errors.${server.errorCode ?? 'MCP_STARTUP_FAILED'}`, {
    defaultValue: t('input.mcpStatus.errors.MCP_STARTUP_FAILED'),
  });
  const showRetryFailure = (code: unknown, status?: unknown) => {
    const key = status === 404 ? 'endpoint_unavailable' : typeof code === 'string' ? code : 'retry_failed';
    setRetryFailure({ snapshot: server, message: t(`input.mcpStatus.retryErrors.${key}`, {
      defaultValue: t('input.mcpStatus.retryErrors.retry_failed'),
    }) });
  };
  const retry = async () => {
    if (!onRetry || pending.current || busy || connecting) return;
    pending.current = true;
    setRetryFailure(null);
    setRetrying(true);
    try {
      const result = await onRetry(server.id);
      if (!result.success) {
        showRetryFailure(result.errorCode, result.status);
      } else {
        setAcceptedSnapshot(server);
      }
    } catch (error) {
      // Tab API attaches the bounded errorCode to non-2xx responses.
      showRetryFailure(
        error instanceof Error && 'errorCode' in error ? error.errorCode : undefined,
        error instanceof Error && 'status' in error ? error.status : undefined,
      );
    } finally {
      pending.current = false;
      setRetrying(false);
    }
  };
  return (
    <div className="mt-0.5 flex items-center gap-1 text-xs text-[var(--ink-muted)]">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stopped || connecting ? 'bg-[var(--ink-muted)]' : 'bg-amber-500'}`} />
      <span className="min-w-0" role="status">
        {retryFailure?.snapshot === server ? retryFailure.message
          : connecting ? t('input.mcpStatus.starting')
          : stale ? t('input.mcpStatus.stale')
          : stopped ? t('input.mcpStatus.stopped')
          : failed ? reason : t('input.mcpStatus.needsAuth')}
      </span>
      {(failed || stopped) && onRetry && (
        <Tip label={busy ? t('input.mcpStatus.retryErrors.session_busy') : t('input.mcpStatus.retryHint')}>
          <button
            type="button"
            aria-label={t(stopped ? 'input.mcpStatus.start' : 'input.mcpStatus.retry')}
            className="compact-action ml-auto shrink-0 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40"
            disabled={busy || connecting}
            onClick={(event) => { event.stopPropagation(); void retry(); }}
          >
            <RedoIcon className={`h-3.5 w-3.5 ${connecting ? 'animate-spin' : ''}`} />
          </button>
        </Tip>
      )}
    </div>
  );
}
