import { CheckIcon, StopIcon, CloseIcon } from '@/components/icons';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import type { Provider } from '@/config/types';
import type { ProxyScopeSettings } from '../../shared/config-types';
import { isRuntimeBackedProvider } from '../../shared/providerExecution';
import { normalizeProxyScope } from '../../shared/proxyScope';

interface ProxyScopeDialogProps {
  providers: Provider[];
  initialScope: ProxyScopeSettings;
  onClose: () => void;
  onSave: (scope: ProxyScopeSettings, editableProviderIds: string[]) => void;
}

function providerKindKey(provider: Provider): string {
  if (isRuntimeBackedProvider(provider)) return 'proxy.scopeDialogManaged';
  if (provider.type === 'subscription') return 'proxy.scopeDialogSubscription';
  return 'proxy.scopeDialogApi';
}

export default function ProxyScopeDialog({
  providers: configuredProviders,
  initialScope,
  onClose,
  onSave,
}: ProxyScopeDialogProps) {
  const { t } = useTranslation('settings');
  // One edit owns one catalog snapshot. Background discovery/gate changes
  // must not change which choices this open dialog displays or can commit.
  const [providers] = useState(() => [...configuredProviders]);
  const providerIds = useMemo(() => providers.map(provider => provider.id), [providers]);
  const [scope, setScope] = useState(() => normalizeProxyScope(initialScope));
  const generalRequests = scope.mode === 'all' || scope.generalRequests === true;
  const selectedIds = useMemo(() => scope.mode === 'all' ? providerIds : (scope.providerIds ?? []), [scope, providerIds]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allSelected = generalRequests && providerIds.every(id => selectedSet.has(id));
  const selectedCount = providerIds.filter(id => selectedSet.has(id)).length + (generalRequests ? 1 : 0);

  const toggle = (providerId: string) => {
    setScope({ mode: 'custom', generalRequests, providerIds: selectedSet.has(providerId)
      ? selectedIds.filter(id => id !== providerId)
      : [...selectedIds, providerId] });
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-50 overflow-y-auto px-4 py-8">
      <div
        className="mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--line-subtle)] px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-[var(--ink)]">{t('proxy.scopeDialogTitle')}</h3>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">{t('proxy.scopeDialogDescription')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            aria-label={t('proxy.scopeDialogCancel')}
          >
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-[var(--line-subtle)] px-5 py-3">
          <span className="text-sm text-[var(--ink-muted)]">
            {t('proxy.scopeDialogSelected', { count: selectedCount })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                // Bulk actions only edit the displayed subset. Hidden IDs
                // remain selected if the catalog changes during this dialog.
                setScope({ mode: 'custom', generalRequests: !allSelected,
                  providerIds: allSelected
                    ? selectedIds.filter(id => !providerIds.includes(id))
                    : [...new Set([...selectedIds, ...providerIds])],
                });
              }}
              className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)] active:scale-[0.98]"
            >
              {t(allSelected ? 'proxy.scopeDialogDeselectAll' : 'proxy.scopeDialogSelectAll')}
            </button>
          </div>
        </div>

        <div className="max-h-[56vh] overflow-y-auto">
          <button
            type="button"
            role="checkbox"
            aria-checked={generalRequests}
            onClick={() => setScope({ mode: 'custom', generalRequests: !generalRequests, providerIds: selectedIds })}
            className="flex w-full items-center gap-3 border-b border-[var(--line-subtle)] px-5 py-3 text-left transition-colors hover:bg-[var(--hover-bg)]"
          >
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--accent)]"
              aria-hidden="true"
            >
              {generalRequests ? <CheckIcon size={18} /> : <StopIcon size={18} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--ink)]">
                {t('proxy.scopeDialogGeneralRequests')}
              </span>
              <span className="block text-xs text-[var(--ink-muted)]">
                {t('proxy.scopeDialogGeneralRequestsDescription')}
              </span>
            </span>
            <span className="shrink-0 rounded-md bg-[var(--paper-elevated)] px-2 py-1 text-xs text-[var(--ink-muted)]">
              {t('proxy.scopeDialogGeneral')}
            </span>
          </button>

          <div className="border-b border-[var(--line-subtle)] px-5 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
            {t('proxy.scopeDialogProviders')}
          </div>
          {providers.length === 0 && (
            <p className="border-b border-[var(--line-subtle)] px-5 py-4 text-sm text-[var(--ink-muted)]">
              {t('proxy.scopeDialogNoProviders')}
            </p>
          )}
          {providers.map((provider) => {
            const selected = selectedSet.has(provider.id);
            return (
              <button
                key={provider.id}
                type="button"
                role="checkbox"
                aria-checked={selected}
                onClick={() => toggle(provider.id)}
                className="flex w-full items-center gap-3 border-b border-[var(--line-subtle)] px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-[var(--hover-bg)]"
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--accent)]"
                  aria-hidden="true"
                >
                  {selected ? <CheckIcon size={18} /> : <StopIcon size={18} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--ink)]">{provider.name}</span>
                  <span className="block truncate text-xs text-[var(--ink-muted)]">{provider.id}</span>
                </span>
                <span className="shrink-0 rounded-md bg-[var(--paper-elevated)] px-2 py-1 text-xs text-[var(--ink-muted)]">
                  {t(providerKindKey(provider))}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--line-subtle)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--line)] px-4 py-2 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)] active:scale-[0.98]"
          >
            {t('proxy.scopeDialogCancel')}
          </button>
          <button
            type="button"
            onClick={() => onSave(scope, providerIds)}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)] transition-transform active:scale-[0.98]"
          >
            <CheckIcon size={16} />
            {t('proxy.scopeDialogSave')}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
