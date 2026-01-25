import { Loader2 } from 'lucide-react';

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
    onConfirm,
    onCancel
}: ConfirmDialogProps) {
    // Support both old and new props
    const finalConfirmText = confirmText || confirmLabel || 'Confirm';
    const finalCancelText = cancelText || cancelLabel || 'Cancel';
    const isDanger = confirmVariant === 'danger' || danger;

    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm">
            <div className="glass-panel w-full max-w-sm">
                <div className="border-b border-[var(--line)] px-5 py-4">
                    <div className="text-[14px] font-semibold text-[var(--ink)]">{title}</div>
                </div>
                <div className="px-5 py-4">
                    <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">{message}</p>
                </div>
                <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={loading}
                        className="action-button px-4 py-1.5 text-[12px] font-semibold disabled:opacity-50"
                    >
                        {finalCancelText}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={loading}
                        className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-semibold text-white transition-colors disabled:opacity-50 ${isDanger
                            ? 'bg-[var(--error)] hover:brightness-110'
                            : 'bg-[var(--button-primary-bg)] hover:bg-[var(--button-primary-bg-hover)]'
                            }`}
                    >
                        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                        {finalConfirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}

