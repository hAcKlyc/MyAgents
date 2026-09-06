import React, { useCallback, useMemo } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Pin, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
    closestCenter,
    DndContext,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { normalizeProviderOrder, type Provider } from '@/config/types';
import { TOKENDANCE_PROVIDER_ID } from '../../shared/tokendance';

interface ProviderEnableOrderDialogProps {
    providers: Provider[];
    providerOrderDraft: string[];
    disabledProviderDraft: string[];
    onProviderOrderDraftChange: React.Dispatch<React.SetStateAction<string[]>>;
    onDisabledProviderDraftChange: React.Dispatch<React.SetStateAction<string[]>>;
    onClose: () => void;
    onSave: () => void;
}

interface ProviderOrderRowProps {
    provider: Provider;
    index: number;
    isLast: boolean;
    enabled: boolean;
    fixed?: boolean;
    onMove: (providerId: string, direction: -1 | 1) => void;
    onToggle: (providerId: string, enabled: boolean) => void;
}

function ProviderOrderRow({ provider, index, isLast, enabled, fixed = false, onMove, onToggle }: ProviderOrderRowProps) {
    const { t } = useTranslation('settings');
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: provider.id, disabled: fixed });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    return (
        <div
            data-provider-order-row={provider.id}
            ref={setNodeRef}
            style={style}
            className={`flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-3 transition-shadow ${isDragging ? 'relative z-10 shadow-lg ring-1 ring-[var(--focus-border)]' : ''} ${enabled ? '' : 'opacity-60'}`}
        >
            {fixed ? (
                <div className="flex w-[106px] shrink-0 items-center gap-2 px-1.5 text-xs text-[var(--ink-muted)]">
                    <Pin className="h-4 w-4" />
                    <span>{t('providers.order.fixedFirst')}</span>
                </div>
            ) : (
                <>
                    <button
                        type="button"
                        {...attributes}
                        {...listeners}
                        className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] active:cursor-grabbing"
                        title={t('providers.order.drag')}
                        aria-label={t('providers.order.dragProvider', { name: provider.name })}
                    >
                        <GripVertical className="h-4 w-4" />
                    </button>
                    <div className="flex w-16 shrink-0 items-center gap-1">
                        <button
                            type="button"
                            onClick={() => onMove(provider.id, -1)}
                            disabled={index === 0}
                            className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-35"
                            title={t('providers.order.moveUp')}
                        >
                            <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                            type="button"
                            onClick={() => onMove(provider.id, 1)}
                            disabled={isLast}
                            className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-35"
                            title={t('providers.order.moveDown')}
                        >
                            <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </>
            )}
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-medium text-[var(--ink)]">{provider.name}</p>
                    <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                        {provider.cloudProvider}
                    </span>
                    <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                        {provider.type === 'subscription' ? t('providers.order.subscription') : t('providers.order.api')}
                    </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                    {provider.models.length > 0
                        ? provider.models.map(model => model.modelName || model.model).join(', ')
                        : t('providers.noModels')}
                </p>
            </div>
            <button
                type="button"
                role="switch"
                aria-label={provider.name}
                aria-checked={enabled}
                onClick={() => onToggle(provider.id, !enabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors ${enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'}`}
                title={enabled ? t('providers.order.enabled') : t('providers.order.disabled')}
            >
                <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
        </div>
    );
}

export default function ProviderEnableOrderDialog({
    providers,
    providerOrderDraft,
    disabledProviderDraft,
    onProviderOrderDraftChange,
    onDisabledProviderDraftChange,
    onClose,
    onSave,
}: ProviderEnableOrderDialogProps) {
    const { t } = useTranslation('settings');
    const providerRows = useMemo(() => {
        const byId = new Map(providers.map(provider => [provider.id, provider] as const));
        return normalizeProviderOrder(providers.map(provider => provider.id), providerOrderDraft)
            .map(id => byId.get(id))
            .filter((provider): provider is Provider => Boolean(provider));
    }, [providers, providerOrderDraft]);
    const fixedProvider = providerRows.find(provider => provider.id === TOKENDANCE_PROVIDER_ID);
    const sortableProviders = providerRows.filter(provider => provider.id !== TOKENDANCE_PROVIDER_ID);
    const sortableIds = sortableProviders.map(provider => provider.id);

    const disabledSet = useMemo(
        () => new Set(disabledProviderDraft),
        [disabledProviderDraft],
    );
    const enabledCount = providerRows.length - disabledSet.size;
    const allEnabled = providerRows.length > 0 && disabledSet.size === 0;

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 6 },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        }),
    );

    const moveProvider = useCallback((providerId: string, direction: -1 | 1) => {
        onProviderOrderDraftChange((current) => {
            const normalized = normalizeProviderOrder(providers.map(provider => provider.id), current)
                .filter(id => id !== TOKENDANCE_PROVIDER_ID);
            const index = normalized.indexOf(providerId);
            const nextIndex = index + direction;
            if (index < 0 || nextIndex < 0 || nextIndex >= normalized.length) return normalized;
            const next = [...normalized];
            [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
            return normalizeProviderOrder(providers.map(provider => provider.id), next);
        });
    }, [providers, onProviderOrderDraftChange]);

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        onProviderOrderDraftChange((current) => {
            const normalized = normalizeProviderOrder(providers.map(provider => provider.id), current)
                .filter(id => id !== TOKENDANCE_PROVIDER_ID);
            const oldIndex = normalized.indexOf(String(active.id));
            const newIndex = normalized.indexOf(String(over.id));
            if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return normalized;
            return normalizeProviderOrder(providers.map(provider => provider.id), arrayMove(normalized, oldIndex, newIndex));
        });
    }, [providers, onProviderOrderDraftChange]);

    const toggleProviderEnabled = useCallback((providerId: string, enabled: boolean) => {
        onDisabledProviderDraftChange((current) => {
            if (enabled) return current.filter(id => id !== providerId);
            return current.includes(providerId) ? current : [...current, providerId];
        });
    }, [onDisabledProviderDraftChange]);

    const toggleAllProvidersEnabled = useCallback(() => {
        onDisabledProviderDraftChange(allEnabled
            ? providers.map(provider => provider.id)
            : []);
    }, [providers, allEnabled, onDisabledProviderDraftChange]);

    return (
        <OverlayBackdrop className="z-50 overflow-y-auto py-8">
            <div className="mx-4 flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
                <div className="flex-shrink-0 px-6 pb-4 pt-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-lg font-semibold text-[var(--ink)]">{t('providers.order.title')}</h3>
                            <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                {t('providers.order.description')}
                            </p>
                        </div>
                        <button
                            onClick={onClose}
                            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                            aria-label={t('providers.order.close')}
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
                    <div className="mb-3 flex items-center justify-between rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
                        <div>
                            <p className="text-sm font-medium text-[var(--ink)]">
                                {t('providers.order.enabledCount', { enabled: Math.max(0, enabledCount), total: providerRows.length })}
                            </p>
                            <p className="text-xs text-[var(--ink-muted)]">
                                {t('providers.order.description2')}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={toggleAllProvidersEnabled}
                            className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                        >
                            {allEnabled ? t('providers.order.clearAll') : t('providers.order.selectAll')}
                        </button>
                    </div>
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        {fixedProvider && (
                            <div className="mb-2">
                                <ProviderOrderRow
                                    provider={fixedProvider}
                                    index={0}
                                    isLast
                                    fixed
                                    enabled={!disabledSet.has(fixedProvider.id)}
                                    onMove={moveProvider}
                                    onToggle={toggleProviderEnabled}
                                />
                            </div>
                        )}
                        <SortableContext
                            items={sortableIds}
                            strategy={verticalListSortingStrategy}
                        >
                            <div className="space-y-2">
                                {sortableProviders.map((provider, index) => (
                                    <ProviderOrderRow
                                        key={provider.id}
                                        provider={provider}
                                        index={index}
                                        isLast={index === sortableProviders.length - 1}
                                        enabled={!disabledSet.has(provider.id)}
                                        onMove={moveProvider}
                                        onToggle={toggleProviderEnabled}
                                    />
                                ))}
                            </div>
                        </SortableContext>
                    </DndContext>
                </div>

                <div className="flex flex-shrink-0 justify-end gap-3 border-t border-[var(--line)] px-6 py-4">
                    <button
                        onClick={onClose}
                        className="rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                    >
                        {t('providers.order.cancel')}
                    </button>
                    <button
                        onClick={onSave}
                        className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        {t('providers.order.save')}
                    </button>
                </div>
            </div>
        </OverlayBackdrop>
    );
}
