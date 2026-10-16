import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { LoaderIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';

interface ConfirmDialogProps {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    confirmLabel?: string; // Deprecated, use confirmText
    cancelLabel?: string;  // Deprecated, use cancelText
    confirmVariant?: 'danger' | 'primary';
    danger?: boolean; // Deprecated, use confirmVariant
    loading?: boolean;
    /**
     * When true, suppress the global Enter-to-confirm shortcut. Use for
     * confirmations triggered automatically as a safety net (e.g. Bug #123's
     * IME-duplication guard) where the user just pressed Enter to send and
     * a reflexive second Enter must NOT silently confirm a danger action.
     * Escape-to-cancel stays on, button clicks still work.
     */
    disableEnterShortcut?: boolean;
    /** An explicitly clicked alternative; never invoked by Enter. */
    alternativeAction?: { text: string; onClick: () => void; danger?: boolean };
    onConfirm: () => void;
    onCancel: () => void;
}

export default function ConfirmDialog({
    title,
    message,
    confirmText,
    cancelText,
    confirmLabel,
    cancelLabel,
    confirmVariant,
    danger = false,
    loading = false,
    disableEnterShortcut = false,
    alternativeAction,
    onConfirm,
    onCancel
}: ConfirmDialogProps) {
    const { t } = useTranslation('common');
    // Cmd+W dismissal: z-[300] matches the component's CSS z-index
    useCloseLayer(() => { onCancel(); return true; }, 300);

    // Support both old and new props
    const finalConfirmText = confirmText || confirmLabel || t('actions.confirm');
    const finalCancelText = cancelText || cancelLabel || t('actions.cancel');
    const isDanger = confirmVariant === 'danger' || danger;

    // Keyboard: Enter to confirm (unless disabled), Escape to cancel
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (isImeComposingEvent(e)) return;
        if (loading) return;
        if (e.key === 'Enter' && !disableEnterShortcut) {
            e.preventDefault();
            onConfirm();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
        }
    }, [loading, disableEnterShortcut, onConfirm, onCancel]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    // Portal to body so z-[300] competes at the root stacking context. Without
    // this, any caller whose ancestor creates a stacking context renders this
    // dialog behind sibling FloatingPortal content (Popover/DropdownMenu) at
    // body level — observed 2026-05-08 with SessionHistoryDropdown.
    return createPortal(
        <OverlayBackdrop onClose={loading ? undefined : onCancel} className="z-[300] px-4">
            <div className="glass-panel max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto">
                <div className="border-b border-[var(--line)] px-5 py-4">
                    <div className="break-words text-lg font-semibold text-[var(--ink)]">{title}</div>
                </div>
                <div className="px-5 py-4">
                    {/* `whitespace-pre-line` lets callers pass multi-line messages via `\n`
                        (e.g. Runtime-switch dialog's three-line explanation). Single-line
                        callers render identically. */}
                    <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--ink-muted)]">{message}</p>
                </div>
                <div className={`flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3 ${alternativeAction ? 'flex-wrap' : ''}`}>
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={loading}
                        className="rounded-full bg-[var(--button-secondary-bg)] px-4 py-1.5 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-50"
                    >
                        {finalCancelText}
                    </button>
                    {alternativeAction && <button
                        type="button"
                        onClick={alternativeAction.onClick}
                        disabled={loading}
                        className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${alternativeAction.danger
                            ? 'text-[var(--error)] hover:bg-[var(--button-secondary-bg-hover)]'
                            : 'bg-[var(--button-secondary-bg)] text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]'}`}
                    >
                        {alternativeAction.text}
                    </button>}
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={loading}
                        className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50 ${isDanger
                            ? 'bg-[var(--error)] text-[var(--on-error)] hover:brightness-110'
                            : 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]'
                            }`}
                    >
                        {loading && <LoaderIcon className="h-3 w-3 animate-spin" />}
                        {finalConfirmText}
                    </button>
                </div>
            </div>
        </OverlayBackdrop>,
        document.body,
    );
}
