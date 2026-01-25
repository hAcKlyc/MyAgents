import { useState } from 'react';
import { ShieldAlert, X, Check, CheckCheck } from 'lucide-react';

export interface PermissionRequest {
    requestId: string;
    toolName: string;
    input: string;
}

interface PermissionPromptProps {
    request: PermissionRequest;
    onDecision: (requestId: string, decision: 'deny' | 'allow_once' | 'always_allow') => void;
}

/**
 * Permission prompt card shown inline in the message flow
 * when Agent requests to use a tool that requires user confirmation
 */
export function PermissionPrompt({ request, onDecision }: PermissionPromptProps) {
    const [isResponding, setIsResponding] = useState(false);
    const [responded, setResponded] = useState(false);

    const handleDecision = (decision: 'deny' | 'allow_once' | 'always_allow') => {
        if (isResponding) return;
        setIsResponding(true);
        onDecision(request.requestId, decision);
        setResponded(true);
    };

    // Format tool name for display
    const formatToolName = (name: string) => {
        // mcp__playwright__browser_tabs -> Playwright: browser_tabs
        if (name.startsWith('mcp__')) {
            const parts = name.split('__');
            if (parts.length >= 3) {
                return `${parts[1]}: ${parts.slice(2).join('_')}`;
            }
        }
        return name;
    };

    // Format input for display - extract key info
    const formatInput = (input: string) => {
        try {
            const parsed = JSON.parse(input);
            // For common tools, show key parameters
            if (parsed.query) return parsed.query;
            if (parsed.command) return parsed.command;
            if (parsed.url) return parsed.url;
            if (parsed.file_path) return parsed.file_path;
            return JSON.stringify(parsed, null, 2);
        } catch {
            return input;
        }
    };

    // If already responded, show nothing
    if (responded) {
        return null;
    }

    const formattedInput = formatInput(request.input);

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="rounded-xl border border-[var(--line)] bg-white dark:bg-[var(--paper-elevated)] shadow-sm overflow-hidden">
                {/* Header row */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--line-subtle)]">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/10">
                        <ShieldAlert className="size-4 text-[var(--accent)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-[var(--ink)]">
                            {formatToolName(request.toolName)}
                        </div>
                        {formattedInput && (
                            <div className="text-xs text-[var(--ink-muted)] truncate mt-0.5">
                                {formattedInput}
                            </div>
                        )}
                    </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2 px-4 py-3 bg-gray-50/80 dark:bg-black/5">
                    <button
                        onClick={() => handleDecision('deny')}
                        disabled={isResponding}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                            text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[var(--paper-contrast)]
                            border border-[var(--line-subtle)] hover:border-[var(--line)]
                            transition-colors disabled:opacity-50"
                    >
                        <X className="size-3.5" />
                        <span>拒绝</span>
                    </button>

                    <button
                        onClick={() => handleDecision('allow_once')}
                        disabled={isResponding}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                            text-[var(--ink)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/5
                            border border-[var(--line-subtle)] hover:border-[var(--accent)]/30
                            transition-colors disabled:opacity-50"
                    >
                        <Check className="size-3.5" />
                        <span>允许</span>
                    </button>

                    <button
                        onClick={() => handleDecision('always_allow')}
                        disabled={isResponding}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                            text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/15
                            border border-[var(--accent)]/20 hover:border-[var(--accent)]/30
                            transition-colors disabled:opacity-50"
                    >
                        <CheckCheck className="size-3.5" />
                        <span>始终允许</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
