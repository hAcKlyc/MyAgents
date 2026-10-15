import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import CustomSelect from '../../components/CustomSelect';
import type { AppConfig, Provider } from '../../../shared/config-types';
import { isModelFailoverProvider, type ModelFailoverSettings as Settings } from '../../../shared/modelFailover';

const modelKey = (ref: NonNullable<Settings['backup']>) => JSON.stringify([ref.providerId, ref.modelId]);

export function ModelFailoverSettings({ value, providers, apiKeys, updateConfig }: {
  value: Settings | undefined;
  providers: readonly Provider[];
  apiKeys: Readonly<Record<string, string>>;
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const saving = useRef(false);
  const settings = value ?? { enabled: false };
  const models = providers.filter(isModelFailoverProvider).flatMap(provider => provider.models.map(model => ({
    providerId: provider.id,
    modelId: model.model,
    label: `${provider.name} · ${model.model}`,
    hasKey: Boolean(apiKeys[provider.id]?.trim()),
  })));
  const selectedKey = settings.backup ? modelKey(settings.backup) : '';
  const selected = models.find(model => modelKey(model) === selectedKey);
  const ready = Boolean(selected?.hasKey);
  const hint = !settings.backup ? t('modelFailover.chooseHint')
    : !selected ? t('modelFailover.unavailableHint')
      : !selected.hasKey ? t('modelFailover.keyHint') : t('modelFailover.readyHint');

  const save = async (next: Settings) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(false);
    try { await updateConfig({ modelFailover: next }); }
    catch { setError(true); }
    finally { saving.current = false; setBusy(false); }
  };

  return <section aria-label={t('modelFailover.title')} className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-base font-medium text-[var(--ink)]">{t('modelFailover.title')}</h3>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">{t('modelFailover.description')}</p>
      </div>
      <button type="button" role="switch" aria-label={t('modelFailover.enable')} aria-checked={settings.enabled}
        aria-describedby={hintId} disabled={busy || (!settings.enabled && !ready)}
        onClick={() => { if (settings.enabled || ready) void save({ ...settings, enabled: !settings.enabled }); }}
        className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 ${settings.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'}`}>
        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform motion-reduce:transition-none ${settings.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </div>
    <div className="mt-4 grid gap-2">
      <p className="text-sm font-medium text-[var(--ink-secondary)]">{t('modelFailover.backup')}</p>
      <CustomSelect ariaLabel={t('modelFailover.backup')} size="md" disabled={busy} value={selectedKey}
        options={[
          { value: '', label: t('modelFailover.none') },
          ...(settings.backup && !selected ? [{ value: modelKey(settings.backup), label: `${t('modelFailover.unavailable')} · ${settings.backup.modelId}` }] : []),
          ...models.map(model => ({ value: modelKey(model), label: model.label })),
        ]}
        onChange={key => {
          const model = models.find(candidate => modelKey(candidate) === key);
          void save({ enabled: settings.enabled && Boolean(model?.hasKey), ...(model ? { backup: { providerId: model.providerId, modelId: model.modelId } } : {}) });
        }} />
      <p id={hintId} className="text-xs text-[var(--ink-muted)]">{hint}</p>
      {!models.length && <p className="text-xs text-[var(--ink-muted)]">{t('modelFailover.empty')}</p>}
    </div>
    <details className="mt-4">
      <summary className="cursor-pointer text-sm text-[var(--ink-secondary)]">{t('modelFailover.details')}</summary>
      <div className="mt-2 space-y-2 text-xs text-[var(--ink-muted)]">
        <p>{t('modelFailover.scope')}</p>
        <p>{t('modelFailover.safety')}</p>
        <p>{t('modelFailover.compatibility')}</p>
      </div>
    </details>
    <div className="mt-3 min-h-5 text-xs" aria-live="polite">
      {busy && <p role="status" className="text-[var(--ink-muted)]">{t('modelFailover.saving')}</p>}
      {error && <p role="alert" className="text-[var(--error)]">{t('modelFailover.saveFailed')}</p>}
    </div>
  </section>;
}
