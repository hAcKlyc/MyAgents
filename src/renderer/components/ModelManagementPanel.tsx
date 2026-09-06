/**
 * ModelManagementPanel - Unified overlay for managing provider models
 *
 * Upper section: Active models — hover "设为首选", delete any model, add custom ID
 * Lower section: Discover more — single-click "添加" per row, no multi-select
 */
import { X, Search, Loader2, RefreshCw, AlertCircle, Plus, Trash2, Settings2 } from 'lucide-react';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { TOKENDANCE_PROVIDER_ID } from '../../shared/tokendance';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import {
  EDITABLE_MODALITIES,
  discoveredModelWritePlan,
  initialModalitySelection,
  isModalitySelectionValid,
  parseContextWindowInput,
  resolveModalitiesToSave,
  type EditableModality,
} from '@/utils/modelSettingsForm';
import { PRESET_PROVIDERS, splitProviderModelInput, type Provider, type ModelEntity, type AppConfig } from '@/config/types';
import {
  fetchProviderModels,
  enrichExistingModelsFromDiscovery,
  toModelEntity,
  formatTokenCount,
  supportsModelDiscovery,
  synthesizeModalitiesFromDiscovered,
  isTokenDanceConversationModel,
  type DiscoveredModel,
} from '@/config/services/modelDiscoveryService';
import { atomicModifyConfig, rebuildAndPersistAvailableProviders } from '@/config/configService';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { ModalityBadges } from '@/components/ModalityBadges';
import Popover from '@/components/ui/Popover';

interface ModelManagementPanelProps {
  provider: Provider;
  apiKey: string | undefined;
  config: AppConfig;
  onClose: () => void;
  onSaveCustomModels: (providerId: string, models: ModelEntity[]) => Promise<void>;
  onUpdateCustomProvider?: (provider: Provider, discoveredModels?: DiscoveredModel[]) => Promise<void>;
  onSetPrimaryModel: (providerId: string, modelId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  discoveryAction?: () => Promise<DiscoveredModel[]>;
  discoveryUnavailableMessage?: string;
}

// Both the panel and its portaled editor own their keyboard focus. Popover
// deliberately leaves focus to callers, since other consumers are autocompletes.
function containModelDialogTab(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return;
  const root = event.currentTarget;
  const controls = [...root.querySelectorAll<HTMLElement>(
    'button, input, [href], [tabindex="0"]',
  )].filter(element => !element.matches(':disabled'));
  const target = event.shiftKey ? controls.at(-1) : controls[0];
  const boundary = event.shiftKey ? controls[0] : controls.at(-1);
  if (!root.contains(document.activeElement) || document.activeElement === boundary) {
    event.preventDefault();
    (target ?? root).focus();
  }
  event.stopPropagation();
}

export default function ModelManagementPanel({
  provider,
  apiKey,
  config,
  onClose,
  onSaveCustomModels,
  onUpdateCustomProvider,
  onSetPrimaryModel,
  onRefresh,
  discoveryAction,
  discoveryUnavailableMessage,
}: ModelManagementPanelProps) {
  const { t } = useTranslation('settings');
  // ===== Discovery state =====
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  // #325 — which model row has its inline settings editor expanded.
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [pendingCustomModel, setPendingCustomModel] = useState<ModelEntity | null>(null);
  const isMountedRef = useRef(true);
  const fetchIdRef = useRef(0);
  const editingAnchorRef = useRef<HTMLDivElement | null>(null);
  const pendingAnchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  const primaryModel = provider.primaryModel;

  // Active model IDs set
  const activeModelIds = useMemo(
    () => new Set(provider.models.map(m => m.model)),
    [provider.models],
  );
  const customInputModelIds = useMemo(
    () => splitProviderModelInput(customInput),
    [customInput],
  );
  const hasAddableCustomInput = useMemo(
    () => !pendingCustomModel && customInputModelIds.some(id => !activeModelIds.has(id)),
    [pendingCustomModel, customInputModelIds, activeModelIds],
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.body.style.overflow = prev;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  useCloseLayer(() => { onClose(); return true; }, 200);

  // ===== Discovery fetch =====
  const canDiscover = discoveryAction !== undefined || ((!!apiKey || provider.id === TOKENDANCE_PROVIDER_ID) && supportsModelDiscovery(provider));

  const bundledModelsById = useMemo(
    () => new Map(
      provider.isBuiltin
        ? PRESET_PROVIDERS.find(p => p.id === provider.id)?.models.map(m => [m.model, m] as const) ?? []
        : [],
    ),
    [provider.isBuiltin, provider.id],
  );

  // Hand-curated bundled model ids for this builtin provider — shared by the
  // editability gate below and the re-add write plan in
  // handleAddDiscoveredModel (both must agree on what "bundled" means).
  const bundledModelIds = useMemo(
    () => new Set(bundledModelsById.keys()),
    [bundledModelsById],
  );

  const doFetch = useCallback(async () => {
    if (!canDiscover) return;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    const thisId = ++fetchIdRef.current;
    try {
      const result = discoveryAction
        ? await discoveryAction()
        : await fetchProviderModels(provider, apiKey);
      if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      if (provider.id === TOKENDANCE_PROVIDER_ID) {
        // Catalog capability is a merge intent, never a stale replacement of
        // user-authored names, primary choice, or removals.
        let changed = false;
        await atomicModifyConfig(c => {
          const entries = [...(c.presetCustomModels?.[provider.id] ?? [])];
          // Derive the current enabled set from disk while holding the lock;
          // an in-flight refresh must not resurrect a concurrently removed ID.
          const bundled = PRESET_PROVIDERS.find(p => p.id === provider.id)?.models ?? [];
          const removed = new Set(c.presetRemovedModels?.[provider.id] ?? []);
          const currentModels = [...bundled.filter(m => !removed.has(m.model)), ...entries];
          for (const model of currentModels) {
            if (removed.has(model.model)) continue;
            const found = result.find(m => m.id === model.model);
            if (!found?.supportedProtocols) continue;
            const index = entries.findIndex(m => m.model === model.model);
            const existing = index < 0 ? model : entries[index];
            if (JSON.stringify(existing.supportedProtocols) === JSON.stringify(found.supportedProtocols)) continue;
            const updated = { ...existing, supportedProtocols: found.supportedProtocols };
            if (index < 0) entries.push({ ...updated, source: 'discovered' });
            else entries[index] = updated;
            changed = true;
          }
          return changed ? { ...c, presetCustomModels: { ...c.presetCustomModels, [provider.id]: entries } } : c;
        });
        if (changed) {
          await rebuildAndPersistAvailableProviders();
          await onRefresh();
        }
        if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      }
      if (!provider.isBuiltin && onUpdateCustomProvider) {
        const enrichedModels = enrichExistingModelsFromDiscovery(provider.models, result);
        if (enrichedModels !== provider.models) {
          // Pass the raw discovery result as merge intent. ConfigProvider
          // re-reads the Provider under its file lock before filling gaps, so
          // this stale render snapshot can never overwrite a newer manual edit.
          await onUpdateCustomProvider({ ...provider, models: enrichedModels }, result);
          if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
        }
      }
      setDiscoveredModels(provider.id === TOKENDANCE_PROVIDER_ID
        ? result.filter(isTokenDanceConversationModel) : result);
    } catch (e) {
      if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      const structuredMessage = e && typeof e === 'object' && 'message' in e
        ? (e as { message?: unknown }).message
        : undefined;
      setDiscoveryError(
        typeof structuredMessage === 'string'
          ? structuredMessage
          : e instanceof Error ? e.message : String(e),
      );
    } finally {
      if (isMountedRef.current && thisId === fetchIdRef.current) {
        setDiscoveryLoading(false);
      }
    }
  }, [provider, apiKey, canDiscover, discoveryAction, onUpdateCustomProvider, onRefresh]);

  useEffect(() => { doFetch(); }, [doFetch]);

  // ===== Actions =====
  const handleSetPrimary = useCallback(async (modelId: string) => {
    await onSetPrimaryModel(provider.id, modelId);
    await onRefresh();
  }, [provider.id, onSetPrimaryModel, onRefresh]);

  const handleDeleteModel = useCallback(async (modelId: string) => {
    if (provider.isBuiltin) {
      // For preset models: add to presetRemovedModels
      // For user-added models: remove from presetCustomModels
      const customModels = config.presetCustomModels?.[provider.id] ?? [];
      const isBundledPreset = bundledModelIds.has(modelId);
      const isUserAdded = customModels.some(m => m.model === modelId);
      if (isUserAdded && !isBundledPreset) {
        await onSaveCustomModels(provider.id, customModels.filter(m => m.model !== modelId));
      } else {
        // Preset model — add to removed list. If the preset also has a manual
        // override in presetCustomModels, remove that override too; otherwise
        // deleting a bundled row would merely strip the override and the preset
        // would immediately reappear.
        await atomicModifyConfig(c => {
          const existingCustomModels = c.presetCustomModels?.[provider.id] ?? [];
          const nextCustomModels = existingCustomModels.filter(m => m.model !== modelId);
          const nextPresetCustomModels = { ...c.presetCustomModels };
          if (nextCustomModels.length > 0) {
            nextPresetCustomModels[provider.id] = nextCustomModels;
          } else {
            delete nextPresetCustomModels[provider.id];
          }
          const removed = c.presetRemovedModels?.[provider.id] ?? [];
          const nextRemoved = removed.includes(modelId) ? removed : [...removed, modelId];
          return {
            ...c,
            presetCustomModels: nextPresetCustomModels,
            presetRemovedModels: { ...c.presetRemovedModels, [provider.id]: nextRemoved },
          };
        });
        await rebuildAndPersistAvailableProviders();
      }
    } else if (onUpdateCustomProvider) {
      const updatedModels = provider.models.filter(m => m.model !== modelId);
      await onUpdateCustomProvider({ ...provider, models: updatedModels });
    }
    if (modelId === primaryModel) {
      const remaining = provider.models.filter(m => m.model !== modelId);
      if (remaining.length > 0) {
        await onSetPrimaryModel(provider.id, remaining[0].model);
      }
    }
    await onRefresh();
  }, [provider, config.presetCustomModels, primaryModel, bundledModelIds, onSaveCustomModels, onUpdateCustomProvider, onSetPrimaryModel, onRefresh]);

  // #325 — which rows get the ⚙ settings button. On a custom provider every
  // model lives in the provider file → all editable. On a builtin (preset)
  // provider, user-added models are editable. A bundled preset also becomes
  // editable when it has a manual presetCustomModels override, because that is
  // now user-authored data rather than automatic discovery metadata.
  //
  const createManualModelEntity = useCallback((id: string): ModelEntity => ({
    ...bundledModelsById.get(id),
    model: id,
    modelName: bundledModelsById.get(id)?.modelName ?? id,
    modelSeries: bundledModelsById.get(id)?.modelSeries ?? provider.vendor.toLowerCase(),
    source: 'manual',
  }), [bundledModelsById, provider.vendor]);

  const handleAddCustomModel = useCallback(() => {
    if (pendingCustomModel) return;
    const seen = new Set(activeModelIds);
    const modelIds = customInputModelIds.filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (modelIds.length === 0) return;

    setEditingModelId(null);
    setPendingCustomModel(createManualModelEntity(modelIds[0]));
  }, [pendingCustomModel, customInputModelIds, activeModelIds, createManualModelEntity]);

  const handleCancelPendingCustomModel = useCallback(() => {
    setPendingCustomModel(null);
  }, []);

  const handleSavePendingCustomModelSettings = useCallback(async (modelId: string, patch: Partial<ModelEntity>) => {
    const base = pendingCustomModel && pendingCustomModel.model === modelId
      ? pendingCustomModel
      : createManualModelEntity(modelId);
    const entity: ModelEntity = { ...base, ...patch };
    for (const key of Object.keys(patch) as Array<keyof ModelEntity>) {
      if (patch[key] === undefined) delete entity[key];
    }
    if (provider.id === TOKENDANCE_PROVIDER_ID) {
      const catalog = discoveredModels.length ? discoveredModels : await fetchProviderModels(provider, apiKey);
      const matched = catalog.find(m => m.id === modelId);
      const supportedProtocols = matched?.supportedProtocols;
      if (!matched || !isTokenDanceConversationModel(matched)) {
        throw new Error(t('providers.tokendance.models.protocolUnavailable'));
      }
      entity.supportedProtocols = supportedProtocols;
    }
    const remainingInputIds = customInputModelIds.filter((id) => (
      id !== modelId && !activeModelIds.has(id)
    ));

    if (provider.isBuiltin) {
      await atomicModifyConfig(c => {
        const existing = c.presetCustomModels?.[provider.id] ?? [];
        const nextPresetCustomModels = {
          ...c.presetCustomModels,
          [provider.id]: [
            ...existing.filter(m => m.model !== modelId),
            entity,
          ],
        };
        const removed = c.presetRemovedModels?.[provider.id];
        if (!removed?.includes(modelId)) {
          return {
            ...c,
            presetCustomModels: nextPresetCustomModels,
          };
        }
        const nextRemoved = removed.filter(id => id !== modelId);
        const nextPresetRemovedModels = { ...c.presetRemovedModels };
        if (nextRemoved.length > 0) {
          nextPresetRemovedModels[provider.id] = nextRemoved;
        } else {
          delete nextPresetRemovedModels[provider.id];
        }
        return {
          ...c,
          presetCustomModels: nextPresetCustomModels,
          presetRemovedModels: nextPresetRemovedModels,
        };
      });
      await rebuildAndPersistAvailableProviders();
    } else if (onUpdateCustomProvider) {
      await onUpdateCustomProvider({
        ...provider,
        models: [
          ...provider.models.filter(m => m.model !== modelId),
          entity,
        ],
      });
    }
    await onRefresh();
    setPendingCustomModel(null);
    setCustomInput(remainingInputIds.join(', '));
  }, [pendingCustomModel, createManualModelEntity, customInputModelIds, activeModelIds, provider, onUpdateCustomProvider, onRefresh, discoveredModels, apiKey, t]);

  const editableModelIds = useMemo(() => {
    if (!provider.isBuiltin) return activeModelIds;
    const customModels = config.presetCustomModels?.[provider.id] ?? [];
    return new Set(
      customModels
        .filter(m => !bundledModelIds.has(m.model) || m.source !== 'discovered')
        .map(m => m.model)
    );
  }, [provider.isBuiltin, provider.id, activeModelIds, config.presetCustomModels, bundledModelIds]);

  const handleToggleEdit = useCallback((modelId: string) => {
    setPendingCustomModel(null);
    setEditingModelId(prev => (prev === modelId ? null : modelId));
  }, []);

  const handleCancelEdit = useCallback(() => setEditingModelId(null), []);

  // #325 — persist edited model-level params through the SAME write paths the
  // add/delete actions use, so the sidecar capability registry picks the change
  // up via its existing mtime invalidation (providers dir / config.json).
  const handleSaveModelSettings = useCallback(async (modelId: string, patch: Partial<ModelEntity>) => {
    const applyPatch = (m: ModelEntity): ModelEntity => {
      if (m.model !== modelId) return m;
      const next = { ...m, ...patch };
      // `undefined` patch values mean "clear" — drop the keys so the stored
      // JSON stays minimal and the registry falls back per its source chain.
      for (const key of Object.keys(patch) as Array<keyof ModelEntity>) {
        if (patch[key] === undefined) delete next[key];
      }
      return next;
    };
    if (provider.isBuiltin) {
      await atomicModifyConfig(c => {
        const customModels = c.presetCustomModels?.[provider.id] ?? [];
        const nextCustomModels = customModels.map(applyPatch);
        const nextPresetCustomModels = { ...c.presetCustomModels };
        if (nextCustomModels.length > 0) {
          nextPresetCustomModels[provider.id] = nextCustomModels;
        } else {
          delete nextPresetCustomModels[provider.id];
        }
        return { ...c, presetCustomModels: nextPresetCustomModels };
      });
      await rebuildAndPersistAvailableProviders();
    } else if (onUpdateCustomProvider) {
      await onUpdateCustomProvider({ ...provider, models: provider.models.map(applyPatch) });
    }
    setEditingModelId(null);
    await onRefresh();
  }, [provider, onUpdateCustomProvider, onRefresh]);

  const handleAddDiscoveredModel = useCallback(async (model: DiscoveredModel) => {
    if (activeModelIds.has(model.id)) return;
    const entity = toModelEntity(model, provider);

    if (provider.id === TOKENDANCE_PROVIDER_ID) {
      if (!isTokenDanceConversationModel(model)) return;
      await atomicModifyConfig(c => {
        const entries = c.presetCustomModels?.[provider.id] ?? [];
        const existing = entries.find(m => m.model === model.id);
        return {
          ...c,
          presetRemovedModels: { ...c.presetRemovedModels,
            [provider.id]: (c.presetRemovedModels?.[provider.id] ?? []).filter(id => id !== model.id),
          },
          presetCustomModels: { ...c.presetCustomModels,
            [provider.id]: [...entries.filter(m => m.model !== model.id),
              { ...entity, ...existing, supportedProtocols: entity.supportedProtocols }],
          },
        };
      });
      await rebuildAndPersistAvailableProviders();
      await onRefresh();
      return;
    }

    if (provider.isBuiltin) {
      // Also remove from presetRemovedModels if re-adding a previously removed preset
      await atomicModifyConfig(c => {
        const removed = c.presetRemovedModels?.[provider.id];
        if (!removed?.includes(model.id)) return c;
        return {
          ...c,
          presetRemovedModels: {
            ...c.presetRemovedModels,
            [provider.id]: removed.filter(id => id !== model.id),
          },
        };
      });
      // Re-adding a BUNDLED preset stops here: un-removing makes the preset
      // resurface by itself. Appending a duplicate into presetCustomModels
      // would diverge the registries (renderer merge is preset-wins, sidecar
      // ingest is first-wins over presetCustomModels) — see
      // discoveredModelWritePlan + its regression tests.
      const plan = discoveredModelWritePlan(bundledModelIds, model.id);
      if (plan.appendToCustomModels) {
        const existing = config.presetCustomModels?.[provider.id] ?? [];
        await onSaveCustomModels(provider.id, [...existing, entity]);
      } else {
        await rebuildAndPersistAvailableProviders();
      }
    } else if (onUpdateCustomProvider) {
      await onUpdateCustomProvider({ ...provider, models: [...provider.models, entity] });
    }
    await onRefresh();
  }, [activeModelIds, provider, config.presetCustomModels, bundledModelIds, onSaveCustomModels, onUpdateCustomProvider, onRefresh]);

  // ===== Filtered discovery (exclude already-added) =====
  const filteredDiscovered = useMemo(() => {
    let list = discoveredModels.filter(m => !activeModelIds.has(m.id));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(m =>
        m.id.toLowerCase().includes(q) ||
        m.displayName?.toLowerCase().includes(q) ||
        m.ownedBy?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [discoveredModels, activeModelIds, search]);

  const allAdded = discoveredModels.length > 0 && discoveredModels.every(m => activeModelIds.has(m.id));

  return createPortal(
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div
        data-model-management-panel
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (editingModelId || pendingCustomModel) return;
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          containModelDialogTab(event);
        }}
        className="relative flex h-[85vh] w-[620px] max-w-[90vw] flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-3.5">
          <h2 id={titleId} className="text-lg font-semibold text-[var(--ink)]">
            {t('providers.models.title')}
            <span className="ml-2 text-sm font-normal text-[var(--ink-muted)]">{provider.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:actions.close')}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* ===== Upper: Active Models ===== */}
          <div className="border-b border-[var(--line-subtle)] px-5 py-4">
            <h3 className="mb-2.5 text-xs font-semibold text-[var(--ink-muted)]">
              {t('providers.models.activeTitle')}
              {provider.models.length > 0 && (
                <span className="ml-1.5 font-normal text-[var(--ink-subtle)]">{provider.models.length}</span>
              )}
            </h3>

            {provider.models.length === 0 ? (
              <p className="py-4 text-center text-sm text-[var(--ink-muted)]">{t('providers.models.emptyActive')}</p>
            ) : (
              <div>
                {provider.models.map(model => (
                  <div
                    key={model.model}
                    ref={editingModelId === model.model ? editingAnchorRef : undefined}
                  >
                    <ActiveModelRow
                      model={model}
                      isPrimary={model.model === primaryModel}
                      editable={editableModelIds.has(model.model)}
                      isEditing={editingModelId === model.model}
                      onSetPrimary={handleSetPrimary}
                      onDelete={handleDeleteModel}
                      onToggleEdit={handleToggleEdit}
                    />
                    {editingModelId === model.model && (
                      <ModelSettingsEditor
                        model={model}
                        anchorRef={editingAnchorRef}
                        onCancel={handleCancelEdit}
                        onSave={handleSaveModelSettings}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Add custom model input */}
            <div ref={pendingAnchorRef} className="relative mt-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustomModel(); } }}
                  placeholder={t('providers.models.customPlaceholder')}
                  className="flex-1 rounded-lg border border-[var(--line)] bg-transparent px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink-muted)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleAddCustomModel}
                  disabled={!hasAddableCustomInput}
                  aria-label={t('providers.models.add')}
                  className="rounded-lg bg-[var(--paper-inset)] px-2.5 py-1.5 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)] disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              {pendingCustomModel && (
                <ModelSettingsEditor
                  model={pendingCustomModel}
                  anchorRef={pendingAnchorRef}
                  onCancel={handleCancelPendingCustomModel}
                  onSave={handleSavePendingCustomModelSettings}
                />
              )}
            </div>
          </div>

          {/* ===== Lower: Discover Models ===== */}
          <div className="px-5 py-4">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-[var(--ink-muted)]">
                {t('providers.models.discoverTitle')}
              </h3>
              {canDiscover && discoveredModels.length > 0 && (
                <button
                  type="button"
                  onClick={doFetch}
                  disabled={discoveryLoading}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${discoveryLoading ? 'animate-spin' : ''}`} />
                  {t('providers.models.refresh')}
                </button>
              )}
            </div>

            {/* Search — always visible once models have been loaded (avoids layout jump on refresh) */}
            {canDiscover && !discoveryError && discoveredModels.length > 0 && (
              <div className="relative mb-3">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-subtle)]" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('providers.models.searchPlaceholder')}
                  className="w-full rounded-lg border border-[var(--line)] bg-transparent py-1.5 pl-8 pr-3 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink-muted)] focus:outline-none"
                />
              </div>
            )}

            {/* States */}
            {!canDiscover && discoveryUnavailableMessage && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">{discoveryUnavailableMessage}</p>
            )}
            {!canDiscover && !discoveryUnavailableMessage && !apiKey && !discoveryAction && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">{t('providers.models.needApiKey')}</p>
            )}
            {!canDiscover && !discoveryUnavailableMessage && (apiKey || discoveryAction) && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">{t('providers.models.notSupported')}</p>
            )}

            {canDiscover && discoveryLoading && discoveredModels.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-[var(--ink-muted)]">
                <Loader2 className="h-5 w-5 animate-spin" />
                <p className="mt-2 text-sm">{t('providers.models.loading')}</p>
              </div>
            )}

            {canDiscover && discoveryError && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <AlertCircle className="h-5 w-5 text-[var(--error)]" />
                <p className="mt-2 text-sm text-[var(--ink)]">{t('providers.models.loadFailed')}</p>
                <p className="mt-1 max-w-md text-xs text-[var(--ink-muted)]">{discoveryError}</p>
                <button
                  type="button"
                  onClick={doFetch}
                  className="mt-3 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('providers.models.retry')}
                </button>
              </div>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && allAdded && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">{t('providers.models.allAdded')}</p>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && !allAdded && filteredDiscovered.length === 0 && search && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">{t('providers.models.noMatches')}</p>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && discoveredModels.length === 0 && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">{t('providers.models.noneReturned')}</p>
            )}

            {/* Model list — no checkboxes, just rows with hover "添加" */}
            {filteredDiscovered.length > 0 && (
              <div>
                {filteredDiscovered.map(m => (
                  <DiscoveredModelRow
                    key={m.id}
                    model={m}
                    onAdd={handleAddDiscoveredModel}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 items-center justify-end border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            {t('providers.models.done')}
          </button>
        </div>
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}

// ===== ActiveModelRow =====

const ActiveModelRow = React.memo(function ActiveModelRow({
  model,
  isPrimary,
  editable,
  isEditing,
  onSetPrimary,
  onDelete,
  onToggleEdit,
}: {
  model: ModelEntity;
  isPrimary: boolean;
  editable: boolean;
  isEditing: boolean;
  onSetPrimary: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleEdit: (id: string) => void;
}) {
  const { t } = useTranslation('settings');
  const handleSetPrimary = useCallback(() => { if (!isPrimary) onSetPrimary(model.model); }, [isPrimary, onSetPrimary, model.model]);
  const handleDelete = useCallback(() => onDelete(model.model), [onDelete, model.model]);
  const handleToggleEdit = useCallback(() => onToggleEdit(model.model), [onToggleEdit, model.model]);

  const displayName = model.modelName && model.modelName !== model.model ? model.modelName : null;

  const title = displayName ?? model.model;
  const subtitle = displayName ? model.model : null;

  return (
    <div className={`group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--hover-bg)] ${isPrimary ? 'bg-[var(--accent-warm-subtle)]' : ''}`}>
      {/* Model info — unified: title always same style, subtitle always same style */}
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium text-[var(--ink)]">{title}</span>
        {subtitle && (
          <span className="ml-2 font-mono text-xs text-[var(--ink-subtle)]">{subtitle}</span>
        )}
      </div>

      {/* Modality badges (image / video / audio — text-only models render nothing) */}
      <ModalityBadges modalities={model.inputModalities} className="flex-shrink-0" />

      {/* Context length */}
      {model.contextLength ? (
        <span className="flex-shrink-0 text-xs text-[var(--ink-subtle)]">
          {formatTokenCount(model.contextLength)}
        </span>
      ) : null}

      {/* #325 — per-model settings (user-added / custom-provider models only;
          bundled preset models are app-curated and read-only) */}
      {editable && (
        <button
          type="button"
          onClick={handleToggleEdit}
          title={t('providers.models.settingsTitle')}
          aria-label={`${t('providers.models.settingsTitle')}: ${model.modelName ?? model.model}`}
          data-model-gear
          className={`flex-shrink-0 rounded p-1 transition-all hover:text-[var(--accent)] ${
            isEditing
              ? 'text-[var(--accent)] opacity-100'
              : 'text-[var(--ink-subtle)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          }`}
        >
          <Settings2 className="h-3 w-3" />
        </button>
      )}

      {/* Primary badge or hover action */}
      {isPrimary ? (
        <span className="flex-shrink-0 rounded-full bg-[var(--accent-warm-muted)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
          {t('providers.models.primary')}
        </span>
      ) : (
        <button
          type="button"
          onClick={handleSetPrimary}
          className="flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-[var(--ink-subtle)] opacity-0 transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--accent)] group-hover:opacity-100 group-focus-within:opacity-100"
        >
          {t('providers.models.setPrimary')}
        </button>
      )}

      {/* Delete */}
      <button
        type="button"
        onClick={handleDelete}
        aria-label={t('providers.models.removeModel', { model: model.modelName ?? model.model })}
        className="flex-shrink-0 rounded p-1 text-[var(--ink-subtle)] opacity-0 transition-all hover:text-[var(--error)] group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
});

// ===== ModelSettingsEditor (#325 — anchored per-model parameter popover) =====
//
// A small card anchored under the row/input via the shared Popover primitive,
// which portals to body so the model panel's overflow-hidden shell and scroll
// container cannot clip it. Edits the three fields that actually have consumers
// (see utils/modelSettingsForm.ts header for the audit; model-level
// maxOutputTokens is deliberately absent — it has none).
//
// Dismissal: outside-click + Escape are handled by Popover; Cmd+W goes through
// useCloseLayer at 210 — above the panel's own 200, so Cmd+W closes the
// popover before the panel.

const ModelSettingsEditor = function ModelSettingsEditor({
  model,
  anchorRef,
  onCancel,
  onSave,
}: {
  model: ModelEntity;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onCancel: () => void;
  onSave: (modelId: string, patch: Partial<ModelEntity>) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [nameDraft, setNameDraft] = useState(model.modelName ?? model.model);
  const [contextDraft, setContextDraft] = useState(
    model.contextLength ? String(model.contextLength) : '',
  );
  const [modalities, setModalities] = useState<EditableModality[]>(
    () => initialModalitySelection(model.inputModalities),
  );
  const [modalitiesTouched, setModalitiesTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const focusBeforeOpen = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const focusEditor = useCallback((node: HTMLDivElement | null) => {
    node?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);

  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const handlePopoverClose = useCallback(() => {
    onCancelRef.current();
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    const trigger = focusBeforeOpen.current;
    return () => {
      mountedRef.current = false;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  useCloseLayer(() => { onCancelRef.current(); return true; }, 210);

  const parsedContext = parseContextWindowInput(contextDraft);
  const contextInvalid = parsedContext === 'invalid';
  const modalitiesInvalid = !isModalitySelectionValid(modalities);
  const canSave = !contextInvalid && !modalitiesInvalid && !saving;

  const toggleModality = (kind: EditableModality) => {
    setModalitiesTouched(true);
    setModalities(prev => (
      prev.includes(kind)
        ? prev.filter(m => m !== kind)
        : EDITABLE_MODALITIES.filter(m => prev.includes(m) || m === kind)
    ));
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      // `canSave` guard above already excluded 'invalid' (TS narrows via the
      // aliased condition), so parsedContext is number | null here.
      await onSave(model.model, {
        modelName: nameDraft.trim() || model.model,
        contextLength: parsedContext ?? undefined,
        inputModalities: resolveModalitiesToSave(modalitiesTouched, model.inputModalities, modalities),
      });
    } catch (error) {
      if (mountedRef.current) {
        setSaveError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  // Live hint: parsed-value echo when valid, error when invalid, default otherwise.
  const hint = saveError
    ? t('providers.models.saveFailed', { message: saveError })
    : contextInvalid
      ? t('providers.models.invalidContext')
      : modalitiesInvalid
        ? t('providers.models.modalityRequired')
        : typeof parsedContext === 'number'
          ? t('providers.models.contextEcho', { tokens: formatTokenCount(parsedContext) })
          : t('providers.models.contextDefault');

  const inputBase =
    'w-full rounded-lg border bg-[var(--paper)] px-2.5 py-1.5 text-xs text-[var(--ink)] outline-none transition-all placeholder:text-[var(--ink-faint)] focus:bg-[var(--paper-elevated)]';
  const inputOk =
    'border-[var(--line)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-warm-subtle)]';
  const inputErr = 'border-[var(--error)] focus:shadow-[0_0_0_3px_var(--error-subtle)]';

  return (
    <Popover
      open
      anchorRef={anchorRef}
      onClose={handlePopoverClose}
      closeOnEscape={false}
      preserveTabOrder={false}
      placement="bottom-end"
      offset={8}
      zIndex={260}
      unstyled
      className="w-[360px] max-w-[calc(100vw-32px)] origin-top-right animate-[popoverIn_0.22s_cubic-bezier(0.3,1.2,0.4,1)] rounded-[14px] border border-[var(--line-subtle)] bg-[var(--paper-elevated)] p-4 shadow-[var(--shadow-lg)]"
    >
      <div
        ref={focusEditor}
        role="dialog"
        aria-modal="true"
        aria-label={t('providers.models.parameterTitle')}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            handlePopoverClose();
          }
          containModelDialogTab(event);
        }}
      >
        <div data-testid="model-settings-popover" className="mb-3 flex items-baseline gap-2">
          <span className="flex-shrink-0 text-xs font-semibold text-[var(--ink)]">{t('providers.models.parameterTitle')}</span>
          <code className="truncate font-mono text-xs text-[var(--ink-subtle)]">{model.model}</code>
        </div>

        {/* 显示名称 */}
        <div className="mb-2.5">
          <label className="mb-1 block text-xs font-medium tracking-wide text-[var(--ink-muted)]">{t('providers.models.displayName')}</label>
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder={model.model}
            aria-label={t('providers.models.displayName')}
            className={`${inputBase} ${inputOk}`}
          />
        </div>

        {/* 上下文窗口 */}
        <div className="mb-2.5">
          <label className="mb-1 block text-xs font-medium tracking-wide text-[var(--ink-muted)]">{t('providers.models.contextWindow')}</label>
          <input
            type="text"
            value={contextDraft}
            onChange={(e) => setContextDraft(e.target.value)}
            placeholder={t('providers.models.contextPlaceholder')}
            aria-label={t('providers.models.contextWindow')}
            className={`${inputBase} font-mono placeholder:font-sans ${contextInvalid ? inputErr : inputOk}`}
          />
        </div>

        {/* 输入模态 */}
        <div>
          <label className="mb-1 block text-xs font-medium tracking-wide text-[var(--ink-muted)]">{t('providers.models.inputModalities')}</label>
          <div className="flex gap-1.5 pt-0.5">
            {EDITABLE_MODALITIES.map(kind => {
              const selected = modalities.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => toggleModality(kind)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    selected
                      ? 'border-transparent bg-[var(--accent-warm-muted)] font-medium text-[var(--accent)]'
                      : 'border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--ink-subtle)]'
                  }`}
                >
                  {selected && <span className="mr-1 text-xs">✓</span>}
                  {t(`providers.models.modality.${kind}`)}
                </button>
              );
            })}
          </div>
        </div>

        <p className={`mt-2 text-xs leading-relaxed ${saveError || contextInvalid || modalitiesInvalid ? 'text-[var(--error)]' : 'text-[var(--ink-subtle)]'}`}>
          {hint}
        </p>

        {/* Actions */}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            {t('providers.models.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-1.5 text-xs font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-40"
          >
            {saving ? t('providers.models.saving') : t('providers.models.save')}
          </button>
        </div>
      </div>
    </Popover>
  );
};

// ===== DiscoveredModelRow (lower section — light row with hover "添加") =====

const DiscoveredModelRow = React.memo(function DiscoveredModelRow({
  model,
  onAdd,
}: {
  model: DiscoveredModel;
  onAdd: (model: DiscoveredModel) => void;
}) {
  const { t } = useTranslation('settings');
  const handleAdd = useCallback(() => onAdd(model), [onAdd, model]);
  const displayName = model.displayName && model.displayName !== model.id ? model.displayName : null;
  const title = displayName ?? model.id;
  const subtitle = displayName ? model.id : null;

  // Synthesize modalities via the shared helper so this preview row stays in
  // sync with `toModelEntity` (the persisted form). Returns undefined when
  // discovery exposed no flags either way — the badge component then renders
  // nothing, matching how an unknown / future-modality model would appear.
  const discoveredModalities = synthesizeModalitiesFromDiscovered(model);

  return (
    <div className="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--hover-bg)]">
      {/* Model info — same style as ActiveModelRow */}
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium text-[var(--ink)]">{title}</span>
        {subtitle && (
          <span className="ml-2 font-mono text-xs text-[var(--ink-subtle)]">{subtitle}</span>
        )}
      </div>

      {/* Modality badges — text-only models render nothing */}
      <ModalityBadges modalities={discoveredModalities} className="flex-shrink-0" />

      {/* Metadata */}
      {model.contextLength ? (
        <span className="flex-shrink-0 text-xs text-[var(--ink-subtle)]">
          {formatTokenCount(model.contextLength)}
        </span>
      ) : null}

      {/* Add button — visible on hover */}
      <button
        type="button"
        onClick={handleAdd}
        className="flex-shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium text-[var(--accent)] opacity-0 transition-all hover:bg-[var(--accent-warm-subtle)] group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {t('providers.models.add')}
      </button>
    </div>
  );
});
