import {
  FileCheckIcon,
  CheckIcon,
  TerminalIcon,
  SuccessIcon,
  XCircleIcon,
  ArrowUpIcon,
} from '@/components/icons';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from '@/components/Markdown';

import type { ExitPlanModeRequest } from '../../shared/types/planMode';

interface ExitPlanModePromptProps {
    request: ExitPlanModeRequest;
    onApprove: () => void;
    /**
     * Reject the plan, optionally with the user's 「修改意见」 (issue #182).
     * - feedback empty/undefined → AI stops (interrupt the turn)
     * - feedback present → AI revises the plan in the same turn
     */
    onReject: (feedback?: string) => void;
}

const TEXTAREA_MAX_HEIGHT = 128; // px — caps the auto-grow textarea

/**
 * ExitPlanMode prompt - AI submits a plan for user review
 */
export function ExitPlanModePrompt({ request, onApprove, onReject }: ExitPlanModePromptProps) {
    const { t } = useTranslation('chat');
    const isResolved = !!request.resolved;
    const isApproved = request.resolved === 'approved';
    const hasPlan = typeof request.plan === 'string' && !!request.plan.trim();

    const [feedback, setFeedback] = useState('');
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // Bug #123 IME guard: track composition state via ref so the auto-resize
    // effect can skip textarea.style writes during composition. Aligns with
    // SimpleChatInput.tsx — required to avoid CJK candidate-text duplication
    // on macOS WebKit/Tauri WebView.
    const isComposingRef = useRef(false);
    // Re-trigger the resize effect after composition end, since the IME may
    // not emit a follow-up `input` event after committing.
    const [resizeBump, setResizeBump] = useState(0);
    // Submit-in-flight lock: blocks duplicate POSTs from rapid Enter presses
    // (review-by-codex finding — TabProvider clears state optimistically, so
    // the second Enter would otherwise fire a duplicate `/api/exit-plan-mode/respond`).
    const submittedRef = useRef(false);

    // Re-enable the submit lock if the resolution is rolled back (e.g. the
    // POST failed in TabProvider and the resolved flag was reverted). Lets
    // the user retry their feedback after a transient failure.
    // (Per-request reset handled by `key={requestId}` at the call site —
    // a fresh requestId remounts the component, dropping local state.)
    useEffect(() => {
        if (!isResolved) submittedRef.current = false;
    }, [isResolved]);

    // Auto-resize textarea up to TEXTAREA_MAX_HEIGHT. Skipped during IME
    // composition (Bug #123) — `resizeBump` re-runs the effect after
    // composition end so the height catches up to the committed text.
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        if (isComposingRef.current) return;
        el.style.height = 'auto';
        const next = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT);
        el.style.height = `${next}px`;
    }, [feedback, resizeBump]);

    const handleSubmit = useCallback(() => {
        if (isResolved || submittedRef.current) return;
        const trimmed = feedback.trim();
        submittedRef.current = true;
        onReject(trimmed || undefined);
    }, [feedback, isResolved, onReject]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
        // Enter submits; Shift+Enter inserts newline (chat-input convention).
        // IME guard: check both `isComposing` (standard) and `keyCode === 229`
        // (legacy WebKit) — same pattern as SimpleChatInput.tsx.
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            handleSubmit();
        }
    }, [handleSubmit]);

    const handleCompositionStart = useCallback(() => {
        isComposingRef.current = true;
    }, []);
    const handleCompositionEnd = useCallback(() => {
        isComposingRef.current = false;
        setResizeBump(b => b + 1);
    }, []);

    const trimmed = feedback.trim();
    const submitTitle = trimmed ? t('shell.planPrompt.submitFeedback') : t('shell.planPrompt.rejectPlan');

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className={`rounded-xl border p-4 shadow-sm ${
                isResolved && !isApproved
                    ? 'border-[var(--line)] bg-[var(--paper-elevated)]'
                    : 'border-[var(--success)]/30 bg-[var(--success-bg)]/80'
            }`}>
                {/* Header */}
                <div className={`${isResolved ? '' : 'mb-3'} flex items-center gap-2`}>
                    <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                        isResolved && !isApproved
                            ? 'bg-[var(--paper-inset)]'
                            : 'bg-[var(--success-bg)]'
                    }`}>
                        <FileCheckIcon className={`h-4.5 w-4.5 ${
                            isResolved && !isApproved
                                ? 'text-[var(--ink-subtle)]'
                                : 'text-[var(--success)]'
                        }`} />
                    </div>
                    <div className="flex-1">
                        <h3 className={`text-sm font-semibold ${
                            isResolved && !isApproved
                                ? 'text-[var(--ink-secondary)]'
                                : 'text-[var(--success)]'
                        }`}>{t('shell.planPrompt.title')}</h3>
                        <p className={`text-xs ${
                            isResolved && !isApproved
                                ? 'text-[var(--ink-muted)]'
                                : 'text-[var(--success)]'
                        }`}>{t(hasPlan ? 'shell.planPrompt.subtitle' : 'shell.planPrompt.missingPlanSubtitle')}</p>
                    </div>
                    {/* Resolved badge in header */}
                    {isResolved && (
                        <div className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                            isApproved
                                ? 'bg-[var(--success-bg)] text-[var(--success)]'
                                : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]'
                        }`}>
                            {isApproved
                                ? <><SuccessIcon className="h-3.5 w-3.5" />{t('shell.planPrompt.approved')}</>
                                : <><XCircleIcon className="h-3.5 w-3.5" />{t('shell.planPrompt.rejected')}</>
                            }
                        </div>
                    )}
                </div>

                {/* Plan content — always visible */}
                {hasPlan && (
                    <div className={`mt-3 max-h-[26rem] overflow-y-auto rounded-lg border p-3 text-sm ${
                        isResolved && !isApproved
                            ? 'border-[var(--line)] bg-[var(--paper)]'
                            : 'border-[var(--success)]/30 bg-[var(--paper-elevated)]/80'
                    }`}>
                        <Markdown>{request.plan ?? ''}</Markdown>
                    </div>
                )}

                {!hasPlan && (
                    <p role="alert" className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3 text-sm text-[var(--ink)]">
                        {t('shell.planPrompt.missingPlan')}
                    </p>
                )}

                {/* Allowed prompts — always visible */}
                {request.allowedPrompts && request.allowedPrompts.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                        <p className={`text-xs font-medium ${
                            isResolved && !isApproved
                                ? 'text-[var(--ink-muted)]'
                                : 'text-[var(--success)]'
                        }`}>{t('shell.planPrompt.permissions')}</p>
                        {request.allowedPrompts.map((ap, i) => (
                            <div key={i} className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ${
                                isResolved && !isApproved
                                    ? 'bg-[var(--paper-inset)]/60 text-[var(--ink-muted)]'
                                    : 'bg-[var(--success-bg)]/60 text-[var(--success)]'
                            }`}>
                                <TerminalIcon className="h-3.5 w-3.5 shrink-0" />
                                <span>{ap.prompt}</span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Actions - only show when not resolved.
                    Two rows (issue #182):
                      - Row 1: 「批准执行」full-width button
                      - Row 2: feedback textarea + submit; empty submit = reject,
                              filled submit = reject with feedback so AI revises.
                */}
                {!isResolved && (
                    <div className="mt-3 space-y-2">
                        <button
                            onClick={() => { if (hasPlan) onApprove(); }}
                            disabled={!hasPlan}
                            className="disabled:cursor-not-allowed disabled:opacity-50 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--success)] px-3 py-2 text-sm font-medium text-[var(--on-success)] transition-colors hover:brightness-110"
                        >
                            <CheckIcon className="h-4 w-4" />
                            {t('shell.planPrompt.approve')}
                        </button>
                        <div className="flex items-end gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 transition-colors focus-within:border-[var(--success)]/50">
                            <textarea
                                ref={textareaRef}
                                value={feedback}
                                onChange={e => setFeedback(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onCompositionStart={handleCompositionStart}
                                onCompositionEnd={handleCompositionEnd}
                                placeholder={t('shell.planPrompt.feedbackPlaceholder')}
                                rows={1}
                                className="max-h-32 min-h-[24px] flex-1 resize-none border-0 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
                            />
                            <button
                                type="button"
                                onClick={handleSubmit}
                                title={submitTitle}
                                aria-label={submitTitle}
                                className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors ${
                                    trimmed
                                        ? 'bg-[var(--success)] text-[var(--on-success)] hover:brightness-110'
                                        : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]'
                                }`}
                            >
                                <ArrowUpIcon className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
