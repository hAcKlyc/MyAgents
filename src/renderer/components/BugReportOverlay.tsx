import { useOverlayOwnerActive } from '@/context/OverlayOwnerActiveContext';
import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CloseIcon, SendIcon, ImagePlusIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';

import { useCloseLayer } from '@/hooks/useCloseLayer';

import { track } from '@/analytics';
import type { AssistantEntry } from '@/analytics';
import type { Provider, ProviderVerifyStatus } from '@/config/types';
import { useImagePreview } from '@/context/ImagePreviewContext';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { HelperModelPicker, resolveInitialHelperModel } from '@/components/HelperModelPicker';
import { useImageAttachments } from '@/hooks/useImageAttachments';
import { dispatchHelperRequest } from '@/utils/dispatchHelperRequest';
import { useChatComposerKeydown } from '@/hooks/useChatComposerKeydown';
import { sendKeyHint } from '@/utils/chatSendKey';

interface BugReportOverlayProps {
    onClose: () => void;
    onNavigateToProviders: () => void;
    appVersion: string;
    providers: Provider[];
    apiKeys: Record<string, string>;
    providerVerifyStatus: Record<string, ProviderVerifyStatus>;
    /** Helper Agent's persisted default — initial picker selection. */
    initialProviderId?: string;
    initialModel?: string;
    /** Called when user picks a model so caller can persist to helper Agent. */
    onModelChange?: (providerId: string, model: string) => void;
    /** Fine-grained helper launch location for session_new analytics. */
    assistantEntry?: AssistantEntry;
}

export default function BugReportOverlay({
    onClose, onNavigateToProviders, appVersion, providers, apiKeys, providerVerifyStatus,
    initialProviderId, initialModel, onModelChange, assistantEntry,
}: BugReportOverlayProps) {
    const ownerActive = useOverlayOwnerActive();
    const { t } = useTranslation('settings');
    // Cmd+W dismissal: z-[250] matches the component's CSS z-index
    useCloseLayer(() => { onClose(); return true; }, 250);

    const [description, setDescription] = useState('');
    const menuOpenRef = useRef(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { openPreview } = useImagePreview();

    const {
        images,
        addFile,
        removeAt,
        isDragging,
        dragHandlers,
        pasteHandler,
    } = useImageAttachments();

    // Default selection: prefer the helper Agent's persisted default (if the
    // chosen provider is currently usable); fall back to the first available
    // provider's primaryModel. Computed once at mount — subsequent prop
    // changes don't reset the picker mid-session.
    const [picked, setPicked] = useState(() =>
        resolveInitialHelperModel(providers, apiKeys, providerVerifyStatus, {
            providerId: initialProviderId,
            model: initialModel,
        }),
    );
    const selectedProviderId = picked.providerId;
    const selectedModel = picked.model;

    const hasValidModel = !!selectedProviderId && !!selectedModel;
    const hasText = description.trim().length > 0;
    const hasContent = hasText || images.length > 0;
    const canSubmit = hasContent && hasValidModel;

    // Focus textarea on mount
    useEffect(() => {
        textareaRef.current?.focus();
    }, []);

    // Dialog-level Escape closes the overlay, but defers to picker menu Esc
    // (Popover handles Esc internally to close the menu first).
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; });

    useEffect(() => {
        if (!ownerActive) return;
        const handleKey = (e: KeyboardEvent) => {
            if (isImeComposingEvent(e)) return;
            if (e.key === 'Escape' && !menuOpenRef.current) {
                onCloseRef.current();
            }
        };
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [ownerActive]);

    const handleSubmit = useCallback(() => {
        if (!canSubmit) return;
        track('bug_report_submit', { has_screenshot: images.length > 0 });
        dispatchHelperRequest({
            description,
            providerId: selectedProviderId,
            model: selectedModel,
            appVersion,
            images,
            assistantEntry,
        });
        onClose();
    }, [canSubmit, description, selectedProviderId, selectedModel, appVersion, images, assistantEntry, onClose]);

    // Send-key behavior follows the user's chatSendShortcut preference (shared
    // with the main chat box). The hook also supplies the IME composition
    // handlers this overlay previously lacked. handleSubmit self-guards.
    const { onKeyDown: handleKeyDown, onCompositionStart, onCompositionEnd, sendShortcut } =
        useChatComposerKeydown(handleSubmit);

    const isMac = navigator.platform.toLowerCase().includes('mac');
    const getSubmitTitle = () => {
        if (!hasContent) return t('helper.feedbackEmptyTip');
        if (!hasValidModel) return t('helper.configureModelTip');
        return `${t('helper.send')} (${sendKeyHint(sendShortcut, isMac).shortcut})`;
    };

    return (
        <OverlayBackdrop portal onClose={onClose} className="z-[250] px-4">
            <div className="glass-panel w-full max-w-md">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
                    <h2 className="text-lg font-semibold text-[var(--ink)]">{t('helper.title')}</h2>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                        <CloseIcon className="h-4 w-4" />
                    </button>
                </div>

                {/* Input area — matches Chat input style */}
                <div className="rounded-b-[24px] bg-[var(--paper)] px-5 py-4">
                    <div
                        className={`rounded-2xl border bg-[var(--paper-elevated)] transition-colors ${isDragging ? 'border-[var(--accent)]' : 'border-[var(--line)]'}`}
                        {...dragHandlers}
                    >
                        {/* Image thumbnails */}
                        {images.length > 0 && (
                            <div className="flex gap-2 overflow-x-auto px-4 pb-1 pt-3">
                                {images.map(img => (
                                    <div key={img.id} className="group relative flex-shrink-0">
                                        <img
                                            src={img.preview}
                                            alt={t('helper.attachmentAlt')}
                                            className="h-16 w-16 cursor-pointer rounded-lg border border-[var(--line)] object-cover"
                                            onDoubleClick={() => openPreview(img.preview, img.file.name)}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => removeAt(img.id)}
                                            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--error)] text-[var(--on-error)] opacity-0 transition-opacity group-hover:opacity-100"
                                        >
                                            <CloseIcon className="h-3 w-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Textarea */}
                        <textarea
                            ref={textareaRef}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onCompositionStart={onCompositionStart}
                            onCompositionEnd={onCompositionEnd}
                            onPaste={pasteHandler}
                            placeholder={t('helper.feedbackPlaceholder')}
                            className="w-full resize-none border-0 bg-transparent px-4 py-3 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)]/50 focus:outline-none"
                            rows={5}
                        />

                        {/* Hidden file input */}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/png,image/jpeg,image/gif,image/webp"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                                for (const file of Array.from(e.target.files || [])) addFile(file);
                                e.target.value = '';
                            }}
                        />

                        {/* Bottom toolbar */}
                        <div className="flex items-center justify-between border-t border-[var(--line)] px-3 py-2">
                            <div className="flex items-center gap-1">
                                {/* Image upload button */}
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                    title={t('helper.uploadImage')}
                                >
                                    <ImagePlusIcon className="h-4 w-4" />
                                </button>

                                {/* Model selector */}
                                <HelperModelPicker
                                    providers={providers}
                                    apiKeys={apiKeys}
                                    verifyStatus={providerVerifyStatus}
                                    value={picked}
                                    onChange={(providerId, model) => {
                                        setPicked({ providerId, model });
                                        onModelChange?.(providerId, model);
                                    }}
                                    onNavigateToProviders={onNavigateToProviders}
                                    onOpenChange={(open) => { menuOpenRef.current = open; }}
                                    triggerClassName="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                />
                            </div>

                            {/* Send button */}
                            <button
                                type="button"
                                onClick={handleSubmit}
                                disabled={!canSubmit}
                                title={getSubmitTitle()}
                                className={`rounded-lg p-2 transition-colors ${
                                    canSubmit
                                        ? 'bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-warm-hover)]'
                                        : 'bg-[var(--ink-muted)]/15 text-[var(--ink-muted)]/40'
                                }`}
                            >
                                <SendIcon className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </OverlayBackdrop>
    );
}
