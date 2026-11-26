import { createContext, useContext, useCallback, useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import {
  AlertIcon,
  SuccessIcon,
  InfoIcon,
  CloseIcon,
  WarningIcon,
} from '@/components/icons';
import { useTranslation } from 'react-i18next';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
    id: string;
    message: string;
    type: ToastType;
    duration: number;
}

interface ToastContextValue {
    showToast: (message: string, type?: ToastType, duration?: number) => void;
    success: (message: string, duration?: number) => void;
    error: (message: string, duration?: number) => void;
    warning: (message: string, duration?: number) => void;
    info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_TOAST_DURATION = 3000; // 3 seconds
const ERROR_TOAST_DURATION = 5000; // 5 seconds — errors need more reading time

const typeConfig = {
    success: {
        icon: SuccessIcon,
        bg: 'bg-[var(--success-bg)]',
        border: 'border-[var(--success)]/20',
        text: 'text-[var(--success)]',
        iconColor: 'text-[var(--success)]',
    },
    error: {
        icon: AlertIcon,
        bg: 'bg-[var(--error-bg)]',
        border: 'border-[var(--error)]/20',
        text: 'text-[var(--error)]',
        iconColor: 'text-[var(--error)]',
    },
    warning: {
        icon: WarningIcon,
        bg: 'bg-[var(--warning-bg)]',
        border: 'border-[var(--warning)]/20',
        text: 'text-[var(--warning)]',
        iconColor: 'text-[var(--warning)]',
    },
    info: {
        icon: InfoIcon,
        bg: 'bg-[var(--info-bg)]',
        border: 'border-[var(--info)]/20',
        text: 'text-[var(--info)]',
        iconColor: 'text-[var(--info)]',
    },
};

function ToastItem({ toast, onClose }: { toast: Toast; onClose: (id: string) => void }) {
    const { t } = useTranslation('common');
    const config = typeConfig[toast.type];
    const Icon = config.icon;
    const { id, duration } = toast;

    useEffect(() => {
        const timer = setTimeout(() => onClose(id), duration);
        return () => clearTimeout(timer);
    }, [id, duration, onClose]);

    return (
        <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg backdrop-blur-sm animate-slide-down ${config.bg} ${config.border}`}
            style={{
                animation: 'slideDown 0.3s ease-out',
            }}
        >
            <Icon className={`h-5 w-5 flex-shrink-0 ${config.iconColor}`} />
            <span className={`text-sm font-medium ${config.text}`}>{toast.message}</span>
            <button
                type="button"
                aria-label={t('actions.close')}
                onClick={() => onClose(id)}
                className={`ml-2 p-0.5 rounded-md hover:bg-black/5 dark:hover:bg-white/10 transition-colors ${config.text}`}
            >
                <CloseIcon className="h-4 w-4" />
            </button>
        </div>
    );
}

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const showToast = useCallback((message: string, type: ToastType = 'info', duration?: number) => {
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        setToasts((prev) => [...prev, { id, message, type, duration: duration ?? DEFAULT_TOAST_DURATION }]);
    }, []);

    const success = useCallback((message: string, duration?: number) => showToast(message, 'success', duration), [showToast]);
    const error = useCallback((message: string, duration?: number) => showToast(message, 'error', duration ?? ERROR_TOAST_DURATION), [showToast]);
    const warning = useCallback((message: string, duration?: number) => showToast(message, 'warning', duration), [showToast]);
    const info = useCallback((message: string, duration?: number) => showToast(message, 'info', duration), [showToast]);

    // Memoize context value to prevent unnecessary re-renders of consumers
    // Without this, every toast shown would cause all useToast() consumers to re-render
    // and re-trigger their useEffects that depend on toast
    const contextValue = useMemo(() => ({
        showToast, success, error, warning, info
    }), [showToast, success, error, warning, info]);

    return (
        <ToastContext.Provider value={contextValue}>
            {children}
            {/* Toast container - use portal to ensure it's above all modals */}
            {createPortal(
                <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 pointer-events-none">
                    {toasts.map((toast) => (
                        <div key={toast.id} className="pointer-events-auto">
                            <ToastItem toast={toast} onClose={removeToast} />
                        </div>
                    ))}
                </div>,
                document.body
            )}
        </ToastContext.Provider>
    );
}

export function useToast(): ToastContextValue {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
}

/**
 * Non-throwing variant: returns null when there is no ToastProvider above.
 *
 * Use this in widely-reused, deeply-nested components (e.g. Message /
 * ProcessRow) where toast is best-effort feedback for an optional action — so
 * rendering the component outside a provider (notably in unit tests) degrades
 * gracefully to "no toast" instead of crashing the whole subtree. In the real
 * app ToastProvider always wraps the tree, so this returns the live toast.
 */
export function useToastOptional(): ToastContextValue | null {
    return useContext(ToastContext);
}
