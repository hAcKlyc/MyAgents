/**
 * QuickAccess - Quick shortcuts to Settings sections
 * Elegant card-style buttons for Model, Skills, and MCP management
 */

import { Cpu, Sparkles, Plug2 } from 'lucide-react';

interface QuickAccessProps {
    onOpenSettings?: (section: string) => void;
}

const shortcuts = [
    {
        id: 'providers',
        label: '模型管理',
        icon: Cpu,
        description: '配置 AI 模型',
    },
    {
        id: 'skills',
        label: '技能 Skills',
        icon: Sparkles,
        description: '管理技能库',
    },
    {
        id: 'mcp',
        label: '工具 MCP',
        icon: Plug2,
        description: '扩展工具能力',
    },
];

export default function QuickAccess({ onOpenSettings }: QuickAccessProps) {
    return (
        <div className="mb-6">
            <h3 className="mb-3 text-[13px] font-medium uppercase tracking-widest text-[var(--ink-muted)]/70">
                快捷功能
            </h3>
            <div className="flex gap-2">
                {shortcuts.map((item) => {
                    const Icon = item.icon;
                    return (
                        <button
                            key={item.id}
                            onClick={() => onOpenSettings?.(item.id)}
                            aria-label={`打开${item.label}设置`}
                            className="group flex flex-1 flex-col items-center gap-1.5 rounded-xl border border-[var(--line)]/60 bg-[var(--paper-elevated)]/50 px-3 py-3 transition-all hover:border-[var(--line)] hover:bg-[var(--paper-contrast)] hover:shadow-sm"
                        >
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--paper-contrast)]/80 transition-colors group-hover:bg-[var(--accent)]/10">
                                <Icon className="h-4 w-4 text-[var(--ink-muted)] transition-colors group-hover:text-[var(--accent)]" />
                            </div>
                            <span className="text-[12px] font-medium text-[var(--ink-muted)] transition-colors group-hover:text-[var(--ink)]">
                                {item.label}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
