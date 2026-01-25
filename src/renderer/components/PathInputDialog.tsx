// PathInputDialog.tsx
// Custom dialog for confirming project path in browser development mode
// Replaces window.prompt() which gets blocked by browser security policies

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

interface PathInputDialogProps {
    isOpen: boolean;
    folderName: string;
    defaultPath: string;
    onConfirm: (path: string) => void;
    onCancel: () => void;
}

export default function PathInputDialog({
    isOpen,
    folderName,
    defaultPath,
    onConfirm,
    onCancel,
}: PathInputDialogProps) {
    const [path, setPath] = useState(defaultPath);
    const inputRef = useRef<HTMLInputElement>(null);

    // Update path when defaultPath changes
    useEffect(() => {
        setPath(defaultPath);
    }, [defaultPath]);

    // Focus input when dialog opens
    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isOpen]);

    // Handle Enter key to confirm
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            onConfirm(path);
        } else if (e.key === 'Escape') {
            onCancel();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-[480px] rounded-xl bg-[var(--paper-elevated)] p-6 shadow-2xl">
                {/* Header */}
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-[var(--ink)]">
                        确认项目路径
                    </h2>
                    <button
                        onClick={onCancel}
                        className="rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="mb-6">
                    <p className="mb-3 text-sm text-[var(--ink-muted)]">
                        已选择文件夹: <span className="font-medium text-[var(--ink)]">{folderName}</span>
                    </p>
                    <label className="mb-2 block text-sm font-medium text-[var(--ink)]">
                        完整路径
                    </label>
                    <input
                        ref={inputRef}
                        type="text"
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                        placeholder="/Users/yourname/project/folder"
                    />
                    <p className="mt-2 text-xs text-[var(--ink-muted)]">
                        浏览器无法获取真实路径，请确认或手动修改上方路径
                    </p>
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-3">
                    <button
                        onClick={onCancel}
                        className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                    >
                        取消
                    </button>
                    <button
                        onClick={() => onConfirm(path)}
                        disabled={!path.trim()}
                        className="action-button rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
                    >
                        确认添加
                    </button>
                </div>
            </div>
        </div>
    );
}
