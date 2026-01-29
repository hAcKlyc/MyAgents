// SlashCommandMenu.tsx
// Dropdown menu for slash commands selection
// Supports builtin commands, custom commands, and skills

import { useEffect, useRef } from 'react';

// Import SlashCommand type from shared module to avoid duplication
import type { SlashCommand } from '../../shared/slashCommands';

// Re-export for consumers that import from this file
export type { SlashCommand };

interface SlashCommandMenuProps {
    commands: SlashCommand[]; // Already filtered commands
    selectedIndex: number;
    onSelect: (command: SlashCommand) => void;
    isEmpty?: boolean; // True when search found no results
}

export default function SlashCommandMenu({
    commands,
    selectedIndex,
    onSelect,
    isEmpty = false,
}: SlashCommandMenuProps) {
    // Ref to track the selected item for auto-scroll
    const selectedItemRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to keep selected item visible when navigating with keyboard
    useEffect(() => {
        if (selectedItemRef.current) {
            selectedItemRef.current.scrollIntoView({
                block: 'nearest',
                behavior: 'smooth',
            });
        }
    }, [selectedIndex]);

    // Empty state: show "未找到指令" when no matches
    if (isEmpty || commands.length === 0) {
        return (
            <div className="absolute left-4 bottom-full mb-2 w-[26rem] max-h-64 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl">
                <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                    未找到指令
                </div>
            </div>
        );
    }

    return (
        <div className="absolute left-4 bottom-full mb-2 w-[26rem] max-h-64 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl">
            {commands.map((cmd, index) => (
                <div
                    key={`${cmd.source}-${cmd.name}`}
                    ref={index === selectedIndex ? selectedItemRef : null}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer text-sm ${index === selectedIndex
                        ? 'bg-[var(--accent)]/10 text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]'
                        }`}
                    onClick={() => onSelect(cmd)}
                >
                    <span className="font-medium text-[var(--ink)] whitespace-nowrap">/{cmd.name}</span>
                    {cmd.source === 'skill' && (
                        <span className="text-[10px] text-[var(--ink-muted)]/60 bg-[var(--paper-contrast)] px-1.5 py-0.5 rounded shrink-0">
                            skill
                        </span>
                    )}
                    <span
                        className="text-[var(--ink-muted)] text-xs truncate flex-1"
                        title={cmd.description}
                    >
                        {cmd.description}
                    </span>
                </div>
            ))}
        </div>
    );
}

// Helper function to filter and sort commands (used by SimpleChatInput)
export function filterAndSortCommands(commands: SlashCommand[], query: string): SlashCommand[] {
    const q = query.toLowerCase();

    if (!q) {
        // No query: return all commands sorted alphabetically
        return [...commands].sort((a, b) => a.name.localeCompare(b.name));
    }

    return commands
        .filter(cmd =>
            cmd.name.toLowerCase().includes(q) ||
            cmd.description.toLowerCase().includes(q)
        )
        .sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            const aStartsWith = aName.startsWith(q);
            const bStartsWith = bName.startsWith(q);

            // Prefix match comes first
            if (aStartsWith && !bStartsWith) return -1;
            if (!aStartsWith && bStartsWith) return 1;

            // Then sort alphabetically
            return aName.localeCompare(bName);
        });
}
