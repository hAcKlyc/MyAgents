import { createContext, useContext, useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle, Info, X, AlertTriangle } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
    id: string;
    message: string;
    type: ToastType;
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

const typeConfig = {
    success: {
        icon: CheckCircle,
        bg: 'bg-[var(--success-bg)]',
        border: 'border-[var(--success)]/20',
        text: 'text-[var(--success)]',
        iconColor: 'text-[var(--success)]',
    },
    error: {
        icon: AlertCircle,
        bg: 'bg-[var(--error-bg)]',
        border: 'border-[var(--error)]/20',
        text: 'text-[var(--error)]',
        iconColor: 'text-[var(--error)]',
    },
    warning: {
        icon: AlertTriangle,
        bg: 'bg-[var(--warning-bg)]',
        border: 'border-[var(--warning)]/20',
        text: 'text-[var(--warning)]',
        iconColor: 'text-[var(--warning)]',
    },
    info: {
        icon: Info,
        bg: 'bg-[var(--info-bg)]',
        border: 'border-[var(--info)]/20',
        text: 'text-[var(--info)]',
        iconColor: 'text-[var(--info)]',
    },
};

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
    const config = typeConfig[toast.type];
    const Icon = config.icon;

    return (
        <div
            className={`flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg backdrop-blur-sm animate-slide-down ${config.bg} ${config.border}`}
            style={{
                animation: 'slideDown 0.3s ease-out',
            }}
        >
            <Icon className={`h-5 w-5 flex-shrink-0 ${config.iconColor}`} />
            <span className={`text-sm font-medium ${config.text}`}>{toast.message}</span>
            <button
                type="button"
                onClick={onClose}
                className={`ml-2 p-0.5 rounded-md hover:bg-black/5 transition-colors ${config.text}`}
            >
                <X className="h-4 w-4" />
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

        setToasts((prev) => [...prev, { id, message, type }]);

        // Auto dismiss
        setTimeout(() => {
            removeToast(id);
        }, duration ?? DEFAULT_TOAST_DURATION);
    }, [removeToast]);

    const success = useCallback((message: string, duration?: number) => showToast(message, 'success', duration), [showToast]);
    const error = useCallback((message: string, duration?: number) => showToast(message, 'error', duration), [showToast]);
    const warning = useCallback((message: string, duration?: number) => showToast(message, 'warning', duration), [showToast]);
    const info = useCallback((message: string, duration?: number) => showToast(message, 'info', duration), [showToast]);

    return (
        <ToastContext.Provider value={{ showToast, success, error, warning, info }}>
            {children}
            {/* Toast container - top center */}
            <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 pointer-events-none">
                {toasts.map((toast) => (
                    <div key={toast.id} className="pointer-events-auto">
                        <ToastItem toast={toast} onClose={() => removeToast(toast.id)} />
                    </div>
                ))}
            </div>
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
