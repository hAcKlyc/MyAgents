import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
    label: string;
    icon?: React.ReactNode;
    disabled?: boolean;
    danger?: boolean;
    onClick: () => void;
}

interface ContextMenuProps {
    x: number;
    y: number;
    items: ContextMenuItem[];
    onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [onClose]);

    // Adjust position to keep menu in viewport
    useEffect(() => {
        if (menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let adjustedX = x;
            let adjustedY = y;

            if (x + rect.width > viewportWidth) {
                adjustedX = viewportWidth - rect.width - 8;
            }
            if (y + rect.height > viewportHeight) {
                adjustedY = viewportHeight - rect.height - 8;
            }

            menuRef.current.style.left = `${adjustedX}px`;
            menuRef.current.style.top = `${adjustedY}px`;
        }
    }, [x, y]);

    return (
        <div
            ref={menuRef}
            className="fixed z-50 min-w-[160px] rounded-xl border border-[var(--line)] bg-[var(--paper-strong)] py-1.5 shadow-lg backdrop-blur"
            style={{ left: x, top: y }}
        >
            {items.map((item, index) => (
                <button
                    key={index}
                    type="button"
                    disabled={item.disabled}
                    onClick={() => {
                        if (!item.disabled) {
                            item.onClick();
                            onClose();
                        }
                    }}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors ${item.disabled
                            ? 'cursor-not-allowed text-[var(--ink-muted)]/50'
                            : item.danger
                                ? 'text-[var(--error)] hover:bg-[var(--error-bg)]'
                                : 'text-[var(--ink)] hover:bg-[var(--paper-contrast)]'
                        }`}
                >
                    {item.icon && <span className="h-4 w-4">{item.icon}</span>}
                    <span>{item.label}</span>
                </button>
            ))}
        </div>
    );
}
