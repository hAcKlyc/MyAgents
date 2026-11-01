// HelperModelPicker — model selector for MA helper invocation surfaces.
//
// Self-contained Ghost-style toolbar trigger + Popover menu, used by both
// BugReportOverlay (floating dialog) and SettingsHelperInbox (inline entry
// in the Providers settings page). Both surfaces share the same logical
// concern: pick a (providerId, model) tuple from the user's available
// providers, defaulting to the helper Agent's persisted choice.
//
// Why a single component instead of two: the menu visual (provider-grouped
// list, "请先配置模型 →" empty state, selection styling) is what users
// associate with "this is the same helper across the app". Diverging visuals
// would invite drift — keeping one component keeps both surfaces in lock
// step on the picker.

import { useCallback, useMemo, useRef, useState } from 'react';
import { ChevronUpIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';

import type { Provider, ProviderVerifyStatus } from '@/config/types';
import { isProviderAvailable } from '@/config/configService';
import { isRuntimeBackedProvider } from '../../shared/providerExecution';
import { Popover, type PopoverPlacement } from '@/components/ui/Popover';
import { ModalityBadges } from '@/components/ModalityBadges';

export interface HelperModelPickerValue {
    providerId: string;
    model: string;
}

export interface HelperModelPickerProps {
    providers: Provider[];
    apiKeys: Record<string, string>;
    verifyStatus: Record<string, ProviderVerifyStatus>;
    value: HelperModelPickerValue;
    onChange: (providerId: string, model: string) => void;
    /** Called when the user clicks the empty-state CTA (no provider configured). */
    onNavigateToProviders?: () => void;
    /** Popover placement. Default `'top-start'` (toolbar at bottom of card). */
    placement?: PopoverPlacement;
    /**
     * Notified when the picker menu opens or closes. Surfaces that need to
     * coordinate Esc behavior (e.g. dialog Esc-to-close should defer to
     * picker Esc-to-close-menu) read this to know whether the menu is open.
     */
    onOpenChange?: (open: boolean) => void;
    /** Override the trigger button class. Default = Ghost toolbar style. */
    triggerClassName?: string;
}

const DEFAULT_TRIGGER_CLASS =
    'flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium ' +
    'text-[var(--ink-muted)] transition-colors ' +
    'hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]';

/**
 * Resolve a sensible default `(providerId, model)` for surfaces that mount
 * with no prior selection: prefer the helper Agent's persisted defaults if
 * (a) the provider is still usable AND (b) the model still exists in
 * provider.models (managed runtime models are validated by the runtime) — falling back to first available provider's primaryModel
 * otherwise. The membership check matters when a user removes a model from
 * a provider while the helper Agent still references it: without it the
 * picker would show a stale name while App.tsx's handler silently rebases
 * to primaryModel.
 *
 * Exposed as a named export so callers can compute their initial state
 * synchronously without inlining the same precedence logic. Returns empty
 * strings (caller treats as "no selection yet") when nothing is available.
 */
export function resolveInitialHelperModel(
    providers: Provider[],
    apiKeys: Record<string, string>,
    verifyStatus: Record<string, ProviderVerifyStatus>,
    persisted?: { providerId?: string; model?: string },
): HelperModelPickerValue {
    if (persisted?.providerId && persisted?.model) {
        const p = providers.find(x => x.id === persisted.providerId);
        if (
            p &&
            isProviderAvailable(p, apiKeys, verifyStatus) &&
            (isRuntimeBackedProvider(p) || p.models.some(m => m.model === persisted.model))
        ) {
            return { providerId: p.id, model: persisted.model };
        }
    }
    const first = providers.find(p => isProviderAvailable(p, apiKeys, verifyStatus) && p.primaryModel);
    return { providerId: first?.id ?? '', model: first?.primaryModel ?? '' };
}

export function HelperModelPicker({
    providers,
    apiKeys,
    verifyStatus,
    value,
    onChange,
    onNavigateToProviders,
    placement = 'top-start',
    onOpenChange,
    triggerClassName,
}: HelperModelPickerProps) {
    const { t } = useTranslation('app');
    const [open, setOpenState] = useState(false);
    const btnRef = useRef<HTMLButtonElement>(null);

    const setOpen = useCallback((v: boolean) => {
        setOpenState(v);
        onOpenChange?.(v);
    }, [onOpenChange]);

    const selectedProvider = providers.find(p => p.id === value.providerId);
    const modelDisplayName = useMemo(() => {
        if (!selectedProvider || !value.model) return t('helperModelPicker.noModelSelected');
        const m = selectedProvider.models.find(mod => mod.model === value.model);
        return m?.modelName || value.model;
    }, [selectedProvider, value.model, t]);

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                onClick={() => setOpen(!open)}
                className={triggerClassName ?? DEFAULT_TRIGGER_CLASS}
            >
                <span className="max-w-[180px] truncate">{modelDisplayName}</span>
                <ChevronUpIcon className="h-3 w-3" />
            </button>
            <Popover
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={btnRef}
                placement={placement}
                maxHeight="300px" className="w-[260px] overflow-y-auto rounded-xl py-1 shadow-lg"
            >
                {(() => {
                    const availableProviders = providers.filter(p =>
                        isProviderAvailable(p, apiKeys, verifyStatus),
                    );
                    if (availableProviders.length === 0) {
                        return (
                            <button
                                type="button"
                                onClick={() => {
                                    setOpen(false);
                                    onNavigateToProviders?.();
                                }}
                                className="w-full px-3 py-2.5 text-left text-sm text-[var(--accent)] transition-colors hover:bg-[var(--paper-inset)]"
                            >
                                {t('helperModelPicker.configureModel')}
                            </button>
                        );
                    }
                    return availableProviders.map((provider, idx) => (
                        <div key={provider.id}>
                            {idx > 0 && (
                                <div className="mx-2 my-1 border-t border-[var(--line)]" />
                            )}
                            <div className="px-3 pb-0.5 pt-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                                {provider.name}
                            </div>
                            {provider.models.map(model => {
                                const isSelected =
                                    value.providerId === provider.id &&
                                    value.model === model.model;
                                return (
                                    <button
                                        key={model.model}
                                        type="button"
                                        onClick={() => {
                                            onChange(provider.id, model.model);
                                            setOpen(false);
                                        }}
                                        className={`flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                                            isSelected
                                                ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                                                : 'text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                                        }`}
                                    >
                                        <span className="truncate">{model.modelName}</span>
                                        <ModalityBadges modalities={model.inputModalities} className="ml-2" />
                                    </button>
                                );
                            })}
                        </div>
                    ));
                })()}
            </Popover>
        </>
    );
}

export default HelperModelPicker;
