// SlashCommandMenu.tsx
// Content of the `/` command dropdown — positioning + outside-click are the
// caller's responsibility (wraps this in `<Popover>`). Keeping this pure
// means the primitive owns all layout/dismissal logic and the menu can be
// anchored to different triggers without duplicating chrome.

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { isClientActionCommand } from '@/utils/slashActions';

// Import SlashCommand type from shared module to avoid duplication
import type { SlashCommand } from '../../shared/slashCommands';

// Re-export for consumers that import from this file
export type { SlashCommand };

interface SlashCommandMenuProps {
    commands: SlashCommand[]; // Already filtered commands
    selectedIndex: number;
    onSelect: (command: SlashCommand) => void;
    sdkSourceLabel?: string;
    isEmpty?: boolean; // True when search found no results
}

export default function SlashCommandMenu({
    commands,
    selectedIndex,
    onSelect,
    isEmpty = false,
    sdkSourceLabel = 'plugin',
}: SlashCommandMenuProps) {
    const { t } = useTranslation('chat');
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

    // Empty state: show the localized no-results copy when no matches exist.
    if (isEmpty || commands.length === 0) {
        return (
            <div className="w-80 max-h-64 overflow-auto">
                <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                    {t('input.slashCommands.noResults')}
                </div>
            </div>
        );
    }

    return (
        <div className="w-80 max-h-64 overflow-auto">
            {commands.map((cmd, index) => (
                <div
                    key={`${cmd.source}-${commandIdentity(cmd)}`}
                    ref={index === selectedIndex ? selectedItemRef : null}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer text-sm ${index === selectedIndex
                        ? 'bg-[var(--accent)]/10 text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]'
                        }`}
                    onClick={() => onSelect(cmd)}
                >
                    <span className="font-medium text-[var(--ink)] whitespace-nowrap">/{cmd.name}</span>
                    {cmd.source === 'skill' && (
                        <span className="text-xs text-[var(--ink-muted)]/60 bg-[var(--paper-inset)] px-1.5 py-0.5 rounded shrink-0">
                            skill
                        </span>
                    )}
                    {cmd.source === 'sdk' && (
                        <span className="text-xs text-[var(--ink-muted)]/60 bg-[var(--paper-inset)] px-1.5 py-0.5 rounded shrink-0">
                            {sdkSourceLabel}
                        </span>
                    )}
                    <span
                        className="text-[var(--ink-muted)] text-xs truncate flex-1"
                        title={[cmd.description, cmd.argumentHint].filter(Boolean).join(' · ')}
                    >
                        {[cmd.description, cmd.argumentHint].filter(Boolean).join(' · ')}
                    </span>
                </div>
            ))}
        </div>
    );
}

// Helper function to filter and sort commands (used by SimpleChatInput)
//
// Renderer client actions (currently `/goal`) rank first, followed by other
// built-in/system commands, then user skills & commands. Within a tier the
// existing order is preserved (alphabetical with no query;
// prefix-match-then-alphabetical when filtering).
export function filterAndSortCommands(commands: SlashCommand[], query: string): SlashCommand[] {
    const q = query.toLowerCase();
    const tier = (c: SlashCommand) => (
        isClientActionCommand(c) ? 0 : (c.source === 'builtin' ? 1 : 2)
    );
    const matches = (cmd: SlashCommand) => {
        const name = cmd.name.toLowerCase();
        const invocationName = (cmd.invocationName ?? cmd.name).toLowerCase();
        const description = cmd.description.toLowerCase();
        const aliases = cmd.aliases ?? [];
        return name.includes(q) ||
            invocationName.includes(q) ||
            description.includes(q) ||
            aliases.some((alias) => alias.toLowerCase().includes(q));
    };

    if (!q) {
        // No query: client actions first, then alphabetical within each tier.
        return [...commands].sort((a, b) => tier(a) - tier(b) || a.name.localeCompare(b.name));
    }

    return commands
        .filter(matches)
        .sort((a, b) => {
            // Higher product tier first, regardless of match quality.
            const tierDiff = tier(a) - tier(b);
            if (tierDiff !== 0) return tierDiff;

            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            const aAliasStartsWith = a.aliases?.some((alias) => alias.toLowerCase().startsWith(q)) ?? false;
            const bAliasStartsWith = b.aliases?.some((alias) => alias.toLowerCase().startsWith(q)) ?? false;
            const aStartsWith = aName.startsWith(q) || aAliasStartsWith;
            const bStartsWith = bName.startsWith(q) || bAliasStartsWith;

            // Prefix match comes first
            if (aStartsWith && !bStartsWith) return -1;
            if (!aStartsWith && bStartsWith) return 1;

            // Then sort alphabetically
            return aName.localeCompare(bName);
        });
}

function commandIdentity(command: SlashCommand): string {
    return (command.invocationName ?? command.name).trim().replace(/^\/+/, '').toLowerCase();
}

function appendUniqueSlashCommands(
    primaryCommands: SlashCommand[],
    supplementalCommands: SlashCommand[],
    sourceOverride?: SlashCommand['source'],
): SlashCommand[] {
    if (supplementalCommands.length === 0) return primaryCommands;

    const seen = new Set(primaryCommands.map(commandIdentity));
    let merged = primaryCommands;

    for (const command of supplementalCommands) {
        const invocationName = (command.invocationName ?? command.name).trim().replace(/^\/+/, '');
        if (!invocationName) continue;

        const key = invocationName.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        if (merged === primaryCommands) {
            merged = [...primaryCommands];
        }
        merged.push({
            ...command,
            ...(command.invocationName
                ? { invocationName }
                : { name: invocationName }),
            ...(sourceOverride ? { source: sourceOverride } : {}),
        });
    }

    return merged;
}

/**
 * Merge product builtins with effective project/global capabilities while
 * preserving the capability snapshot's skill/custom provenance.
 */
export function mergeLocalSlashCommands(
    productCommands: SlashCommand[],
    localCommands: SlashCommand[],
): SlashCommand[] {
    return appendUniqueSlashCommands(productCommands, localCommands);
}

/**
 * Merge the local menu with the builtin SDK's live command snapshot.
 *
 * Local commands win on name collisions. Only this dynamic source is stamped
 * as SDK-provided because it contains plugin skills/commands resolved by the
 * builtin SDK.
 */
export function mergeSdkSlashCommands(
    localCommands: SlashCommand[],
    sdkCommands: SlashCommand[],
): SlashCommand[] {
    return appendUniqueSlashCommands(localCommands, sdkCommands, 'sdk');
}
