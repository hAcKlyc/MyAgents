import { useTranslation } from 'react-i18next';
import { GlobeIcon, SlidersIcon } from '@/components/icons';
import { useBrowserResourceStatus } from '@/hooks/useBrowserResourceReady';
import { isBrowserResourceReady, MANAGED_BROWSER_MCP_ID } from '../../../../shared/browserTools';
import type { McpEffectiveServerSnapshot } from '../../../../shared/mcpEffectiveState';
import type { McpRetryResult } from '../../../../shared/mcpFailure';
import { McpStatusNotice } from './McpStatusNotice';

/** Always discoverable, including before global enablement or resource installation. */
export function BrowserToolEntry({ available, selected, effective, stale, busy, onToggle, onSetup, onRetry }: {
  available: boolean;
  selected: boolean;
  effective?: McpEffectiveServerSnapshot | null;
  stale?: boolean;
  busy?: boolean;
  onToggle?: (id: string, enabled: boolean) => void;
  onSetup: () => void;
  onRetry?: (id: string) => Promise<McpRetryResult>;
}) {
  const { t } = useTranslation(['chat', 'settings']);
  const status = useBrowserResourceStatus();
  const ready = isBrowserResourceReady(status);
  const canSelect = available && ready;
  return (
    <div className="border-b border-[var(--line)] px-3 py-2">
      <div className="flex items-center gap-2">
        <GlobeIcon className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
        <span className="min-w-0 flex-1 text-sm font-medium text-[var(--ink)]">{t('input.browserTool.title')}</span>
        <button type="button" aria-label={t('input.browserTool.setup')} title={t('input.browserTool.setup')}
          className="shrink-0 rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]" onClick={onSetup}>
          <SlidersIcon className="h-3.5 w-3.5" />
        </button>
        {canSelect || selected ? (
          <button type="button" role="switch" aria-label={t('input.browserTool.title')} aria-checked={selected}
            disabled={!selected && !canSelect}
            onClick={() => onToggle?.(MANAGED_BROWSER_MCP_ID, !selected)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${selected ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'}`}>
            <span className={`pointer-events-none h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${selected ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        ) : (
          <button type="button" onClick={onSetup} className="shrink-0 rounded px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--paper-inset)]">
            {t(ready ? 'input.browserTool.enable' : status?.state === 'never_installed' ? 'input.browserTool.install' : 'input.browserTool.manage')}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">{t('input.browserTool.description')}</p>
      <p role="status" className="mt-1 text-xs text-[var(--ink-muted)]">
        {status === undefined ? t('input.browserTool.checkFailed') : !status ? t('input.browserTool.checking') : !ready ? t(`settings:toolbox.browserResource.states.${status.state}`) : t(!available ? 'input.browserTool.needsEnable' : selected ? effective?.state === 'ready' && !stale ? 'input.browserTool.connected' : 'input.browserTool.selected' : 'input.browserTool.ready')}
      </p>
      {selected && effective && <McpStatusNotice server={effective} stale={stale} busy={busy} onRetry={onRetry} />}
    </div>
  );
}
