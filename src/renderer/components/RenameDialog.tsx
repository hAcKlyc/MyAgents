import { useEffect, useRef, useState } from 'react';

interface RenameDialogProps {
    currentName: string;
    itemType: 'file' | 'folder';
    onRename: (newName: string) => void;
    onCancel: () => void;
}

export default function RenameDialog({
    currentName,
    itemType,
    onRename,
    onCancel
}: RenameDialogProps) {
    const [name, setName] = useState(currentName);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const isCreateMode = !currentName;
    const title = isCreateMode
        ? `新建${itemType === 'folder' ? '文件夹' : '文件'}`
        : `重命名${itemType === 'folder' ? '文件夹' : '文件'}`;

    useEffect(() => {
        inputRef.current?.focus();
        if (!isCreateMode) {
            inputRef.current?.select();
        }
    }, [isCreateMode]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = name.trim();

        if (!trimmed) {
            setError('名称不能为空');
            return;
        }

        if (trimmed.includes('/') || trimmed.includes('\\')) {
            setError('名称不能包含 / 或 \\');
            return;
        }

        if (!isCreateMode && trimmed === currentName) {
            onCancel();
            return;
        }

        onRename(trimmed);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm">
            <div className="glass-panel w-full max-w-sm">
                <form onSubmit={handleSubmit}>
                    <div className="border-b border-[var(--line)] px-5 py-4">
                        <div className="text-[14px] font-semibold text-[var(--ink)]">
                            {title}
                        </div>
                    </div>
                    <div className="px-5 py-4">
                        <input
                            ref={inputRef}
                            type="text"
                            value={name}
                            onChange={(e) => {
                                setName(e.target.value);
                                setError(null);
                            }}
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[13px] text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent)]"
                            placeholder={isCreateMode ? `输入${itemType === 'folder' ? '文件夹' : '文件'}名称` : '输入新名称'}
                        />
                        {error && <p className="mt-2 text-[11px] text-[var(--error)]">{error}</p>}
                    </div>
                    <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="action-button px-4 py-1.5 text-[12px] font-semibold"
                        >
                            取消
                        </button>
                        <button
                            type="submit"
                            className="rounded-full bg-[var(--button-primary-bg)] px-4 py-1.5 text-[12px] font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                        >
                            {isCreateMode ? '创建' : '确认'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
