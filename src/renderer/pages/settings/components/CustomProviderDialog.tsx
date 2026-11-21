import { useId, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/components/icons';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import ModelManagementPanel from '@/components/ModelManagementPanel';
import type { AppConfig } from '@/config/types';
import { enrichExistingModelsFromDiscovery } from '@/config/services/modelDiscoveryService';
import { buildCustomProvider, type CustomProviderForm } from '../providerForms';

export default function CustomProviderDialog({ form, onChange, onSubmit, onCancel, config }: {
  form: CustomProviderForm;
  onChange: Dispatch<SetStateAction<CustomProviderForm>>;
  onSubmit: () => void;
  onCancel: () => void;
  config: AppConfig;
}) {
  const { t } = useTranslation('settings');
  const titleId = useId();
  const [managingModels, setManagingModels] = useState(false);
  const provider = useMemo(() => buildCustomProvider(form, 'custom-provider-draft'), [form]);
  return <>
        <OverlayBackdrop portal className="z-[100] overflow-y-auto py-8">
          <div role="dialog" aria-modal="true" aria-hidden={managingModels || undefined} inert={managingModels} aria-labelledby={titleId} className="mx-4 w-full max-w-md flex max-h-[90vh] flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
            <div className="flex-shrink-0 px-6 pt-6 pb-4">
              <div className="flex items-center justify-between">
                <h3 id={titleId} className="text-lg font-semibold text-[var(--ink)]">
                  {t('providers.custom.addTitle')}
                </h3>
                <button
                  onClick={onCancel}
                  className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
              <div>
                <label htmlFor={`${titleId}-name`} className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                  {t('providers.custom.providerName')}{' '}
                  <span className="text-[var(--error)]">*</span>
                </label>
                <input
                  id={`${titleId}-name`} type="text"
                  value={form.name}
                  onChange={(e) =>
                    onChange((p) => ({ ...p, name: e.target.value }))
                  }
                  placeholder={t(
                    'providers.custom.providerNamePlaceholder',
                  )}
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                  {t('providers.custom.cloudProvider')}
                </label>
                <input
                  type="text"
                  value={form.cloudProvider}
                  onChange={(e) =>
                    onChange((p) => ({
                      ...p,
                      cloudProvider: e.target.value,
                    }))
                  }
                  placeholder={t(
                    'providers.custom.cloudProviderPlaceholder',
                  )}
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">
                  {t('providers.custom.apiProtocol')}
                </label>
                <div className="mt-1 flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="create-apiProtocol"
                      value="anthropic"
                      checked={form.apiProtocol !== 'openai'}
                      onChange={() =>
                        onChange((p) => ({
                          ...p,
                          apiProtocol: 'anthropic',
                          authType: 'auth_token',
                        }))
                      }
                      className="accent-[var(--ink)]"
                    />
                    <span className="text-sm text-[var(--ink)]">
                      {t('providers.custom.anthropicProtocol')}
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="create-apiProtocol"
                      value="openai"
                      checked={form.apiProtocol === 'openai'}
                      onChange={() =>
                        onChange((p) => ({
                          ...p,
                          apiProtocol: 'openai',
                          authType: 'api_key',
                        }))
                      }
                      className="accent-[var(--ink)]"
                    />
                    <span className="text-sm text-[var(--ink)]">
                      {t('providers.custom.openaiProtocol')}
                    </span>
                  </label>
                </div>
              </div>

              <div>
                <label htmlFor={`${titleId}-url`} className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                  {t('providers.custom.baseUrl')}{' '}
                  <span className="text-[var(--error)]">*</span>
                </label>
                <input
                  id={`${titleId}-url`} type="url"
                  value={form.baseUrl}
                  onChange={(e) =>
                    onChange((p) => ({ ...p, baseUrl: e.target.value }))
                  }
                  placeholder={
                    form.apiProtocol === 'openai'
                      ? 'https://api.openai.com/v1'
                      : 'https://api.example.com/anthropic'
                  }
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                />
              </div>

              {form.apiProtocol === 'openai' && (
                <>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                      {t('providers.custom.upstreamFormat')}
                    </label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="create-upstreamFormat"
                          value="chat_completions"
                          checked={
                            form.upstreamFormat === 'chat_completions'
                          }
                          onChange={() =>
                            onChange((p) => ({
                              ...p,
                              upstreamFormat: 'chat_completions',
                            }))
                          }
                          className="accent-[var(--ink)]"
                        />
                        <span className="text-sm text-[var(--ink)]">
                          Chat Completions
                        </span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="create-upstreamFormat"
                          value="responses"
                          checked={form.upstreamFormat === 'responses'}
                          onChange={() =>
                            onChange((p) => ({
                              ...p,
                              upstreamFormat: 'responses',
                            }))
                          }
                          className="accent-[var(--ink)]"
                        />
                        <span className="text-sm text-[var(--ink)]">
                          Responses API
                        </span>
                      </label>
                    </div>
                  </div>
                </>
              )}

              {/* Auth Type - only meaningful for Anthropic protocol (controls x-api-key vs Authorization header) */}
              {form.apiProtocol !== 'openai' && (
                <div>
                  <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">
                    {t('providers.custom.authType')}
                  </label>
                  <p className="mb-1.5 text-xs text-[var(--ink-muted)]">
                    {t('providers.custom.authTypeDescription')}
                  </p>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="create-authType"
                        value="auth_token"
                        checked={form.authType === 'auth_token'}
                        onChange={() =>
                          onChange((p) => ({
                            ...p,
                            authType: 'auth_token',
                          }))
                        }
                        className="accent-[var(--ink)]"
                      />
                      <span className="text-sm text-[var(--ink)]">
                        AUTH_TOKEN
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="create-authType"
                        value="api_key"
                        checked={form.authType === 'api_key'}
                        onChange={() =>
                          onChange((p) => ({ ...p, authType: 'api_key' }))
                        }
                        className="accent-[var(--ink)]"
                      />
                      <span className="text-sm text-[var(--ink)]">API_KEY</span>
                    </label>
                  </div>
                </div>
              )}

              <div>
                <p className="mb-1.5 text-sm font-medium text-[var(--ink)]">{t('providers.custom.models')} <span className="text-[var(--error)]">*</span></p>
                <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] px-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-[var(--ink)]">{form.models.length ? t('providers.custom.selectedModels', { count: form.models.length }) : t('providers.custom.noModelsSelected')}</p>
                    {form.models.length > 0 && <p className="mt-1 truncate text-xs text-[var(--ink-muted)]">{t('providers.custom.primaryModelSummary', { name: provider.primaryModel })}</p>}
                  </div>
                  <button type="button" onClick={() => setManagingModels(true)} className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-[var(--accent)] hover:bg-[var(--paper-inset)]">{t('providers.custom.manageModels')}</button>
                </div>
              </div>
              <div>
                <label htmlFor={`${titleId}-key`} className="mb-1.5 block text-sm font-medium text-[var(--ink)]">API Key</label>
                <input id={`${titleId}-key`} type="password" autoComplete="off" placeholder={t('providers.custom.apiKeyPlaceholder')} value={form.apiKey}
                  onChange={e => onChange(current => ({ ...current, apiKey: e.target.value }))}
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm focus:border-[var(--focus-border)] focus:outline-none" />
              </div>

            </div>

            <div className="flex-shrink-0 border-t border-[var(--line)] px-6 py-4">
              <div className="flex gap-3">
                <button
                  onClick={onCancel}
                  className="flex-1 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  {t('providers.custom.cancel')}
                </button>
                <button
                  onClick={onSubmit}
                  disabled={
                    !form.name ||
                    !form.baseUrl ||
                    form.models.length === 0
                  }
                  className="flex-1 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                >
                  {t('providers.custom.add')}
                </button>
              </div>
            </div>
          </div>
        </OverlayBackdrop>
    {managingModels && <ModelManagementPanel
      provider={provider} apiKey={form.apiKey || undefined} config={config}
      onClose={() => setManagingModels(false)}
      onSaveCustomModels={async () => {}}
      onUpdateCustomProvider={async (next, discovered) => {
        onChange(current => {
          const models = discovered ? enrichExistingModelsFromDiscovery(current.models, discovered) : next.models;
          return { ...current, models, primaryModel: models.some(model => model.model === current.primaryModel)
            ? current.primaryModel : models[0]?.model ?? '' };
        });
      }}
      onSetPrimaryModel={async (_id, modelId) => { onChange(current => ({ ...current, primaryModel: modelId })); }}
      onRefresh={async () => {}}
    />}
  </>;
}
