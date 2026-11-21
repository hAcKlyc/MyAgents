import type { AskUserQuestionAnswers } from '../../shared/types/askUserQuestion';
import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  HelpBubbleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CheckIcon,
  EyeIcon,
} from '@/components/icons';
import { useTranslation } from 'react-i18next';

// Import shared types
import type { AskUserQuestionRequest } from '../../shared/types/askUserQuestion';
export type { AskUserQuestion, AskUserQuestionOption, AskUserQuestionRequest } from '../../shared/types/askUserQuestion';

// Special marker for custom input answer (UUID-like to avoid collision with option labels)
const CUSTOM_INPUT_MARKER = '__CUSTOM_INPUT_7f3d8a2e__';

/**
 * Sanitize HTML preview content from SDK to prevent XSS.
 * Uses browser-native DOMParser for robust sanitization — immune to regex bypass tricks.
 * The content originates from AI model output — not directly user-controlled,
 * but in Tauri WebView, XSS can access invoke() commands.
 */
function sanitizePreviewHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Remove dangerous elements
    const dangerousTags = doc.querySelectorAll(
        'script, iframe, object, embed, form, style, link, meta, base, svg[onload], math'
    );
    dangerousTags.forEach(el => el.remove());
    // Remove event handlers and javascript: URLs from all remaining elements
    const allElements = doc.querySelectorAll('*');
    allElements.forEach(el => {
        for (const attr of Array.from(el.attributes)) {
            if (attr.name.toLowerCase().startsWith('on') ||
                attr.value.trim().toLowerCase().startsWith('javascript:')) {
                el.removeAttribute(attr.name);
            }
        }
    });
    return doc.body?.innerHTML ?? '';
}

interface AskUserQuestionPromptProps {
    request: AskUserQuestionRequest;
    onSubmit: (requestId: string, answers: AskUserQuestionAnswers) => void | Promise<void>;
    onCancel: (requestId: string) => void | Promise<void>;
}

/**
 * AskUserQuestion prompt component - wizard-style multi-question form
 * Shows one question at a time with navigation between questions
 */
export function AskUserQuestionPrompt(props: AskUserQuestionPromptProps) {
    return <AskUserQuestionForm key={props.request.requestId} {...props} />;
}

function AskUserQuestionForm({ request, onSubmit, onCancel }: AskUserQuestionPromptProps) {
    const { t } = useTranslation('chat');
    const [currentIndex, setCurrentIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<number, string[]>>({});
    const [customInputs, setCustomInputs] = useState<Record<number, string>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [responseError, setResponseError] = useState('');
    const customInputRef = useRef<HTMLInputElement>(null);
    const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    // Cleanup timers on unmount
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current);
            if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
        };
    }, []);

    const totalQuestions = request.questions.length;

    // Safely get current question with fallback (prevents accessing undefined)
    const currentQuestion = useMemo(() => {
        return request.questions[currentIndex] ?? request.questions[0];
    }, [request.questions, currentIndex]);

    const isFirstQuestion = currentIndex === 0;
    const isLastQuestion = currentIndex === totalQuestions - 1;
    const isCurrentRequired = currentQuestion?.required !== false;

    // Check if current question has an answer (either option or custom input)
    const currentAnswer = answers[currentIndex] || [];
    const currentCustomInput = customInputs[currentIndex] || '';
    const hasCustomInput = currentAnswer.includes(CUSTOM_INPUT_MARKER) && currentCustomInput.trim().length > 0;
    const currentAnswerFilled = currentAnswer.length > 0 && (
        !currentAnswer.includes(CUSTOM_INPUT_MARKER) || hasCustomInput
    );
    const hasCurrentAnswer = !isCurrentRequired || currentAnswerFilled;

    // Check if all questions have answers
    const isQuestionAnswered = useCallback((idx: number) => {
        const question = request.questions[idx];
        if (!question) return false;
        const ans = answers[idx];
        if (!ans || ans.length === 0) return question.required === false;
        // If custom input is selected, check it has content unless the question
        // is optional; blank optional custom input is treated as skipped.
        if (ans.includes(CUSTOM_INPUT_MARKER)) {
            const filled = (customInputs[idx] || '').trim().length > 0;
            return filled || question.required === false;
        }
        return true;
    }, [request.questions, answers, customInputs]);

    const allAnswered = useMemo(() => {
        return request.questions.every((_, idx) => isQuestionAnswered(idx));
    }, [request.questions, isQuestionAnswered]);

    // Auto-advance to next question for single-select (not last question)
    const handleOptionSelect = useCallback((optionLabel: string) => {
        const isCustom = optionLabel === CUSTOM_INPUT_MARKER;

        setAnswers(prev => {
            const current = prev[currentIndex] || [];
            if (currentQuestion?.multiSelect) {
                // Toggle selection for multi-select
                if (current.includes(optionLabel)) {
                    return { ...prev, [currentIndex]: current.filter(l => l !== optionLabel) };
                } else {
                    return { ...prev, [currentIndex]: [...current, optionLabel] };
                }
            } else {
                // Single select - replace
                return { ...prev, [currentIndex]: [optionLabel] };
            }
        });

        // For single-select (non-custom), auto-advance to next question if not last
        if (!currentQuestion?.multiSelect && !isCustom && !isLastQuestion) {
            // Clear any pending timer
            if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current);
            // Small delay for visual feedback before advancing
            autoAdvanceTimerRef.current = setTimeout(() => {
                setCurrentIndex(prev => prev + 1);
            }, 150);
        }

        // Focus custom input when selected
        if (isCustom) {
            if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
            focusTimerRef.current = setTimeout(() => customInputRef.current?.focus(), 50);
        }
    }, [currentIndex, currentQuestion?.multiSelect, isLastQuestion]);

    const handleCustomInputChange = useCallback((value: string) => {
        setCustomInputs(prev => ({ ...prev, [currentIndex]: value }));
        // Auto-select custom option when typing
        setAnswers(prev => {
            const current = prev[currentIndex] || [];
            if (!current.includes(CUSTOM_INPUT_MARKER)) {
                if (currentQuestion?.multiSelect) {
                    return { ...prev, [currentIndex]: [...current, CUSTOM_INPUT_MARKER] };
                } else {
                    return { ...prev, [currentIndex]: [CUSTOM_INPUT_MARKER] };
                }
            }
            return prev;
        });
    }, [currentIndex, currentQuestion?.multiSelect]);

    const handlePrevious = useCallback(() => {
        if (!isFirstQuestion) {
            setCurrentIndex(prev => prev - 1);
        }
    }, [isFirstQuestion]);

    const handleNext = useCallback(() => {
        if (hasCurrentAnswer && !isLastQuestion) {
            setCurrentIndex(prev => prev + 1);
        }
    }, [hasCurrentAnswer, isLastQuestion]);

    const handleSubmit = useCallback(async () => {
        if (!allAnswered || isSubmitting) return;
        setIsSubmitting(true);
        setResponseError('');

        // Convert answers to the runtime format. Builtin/CC questions omit
        // `id` and keep the historical numeric keys; Codex app-server requires
        // native question ids in ToolRequestUserInputResponse.answers.
        const formattedAnswers: AskUserQuestionAnswers = {};
        request.questions.forEach((question, idx) => {
            const selectedOptions = answers[idx] || [];
            const selected = selectedOptions.filter(option => option !== CUSTOM_INPUT_MARKER);
            const custom = selectedOptions.includes(CUSTOM_INPUT_MARKER) ? customInputs[idx]?.trim() : undefined;
            if (selected.length === 0 && !custom && question.required === false) return;
            formattedAnswers[question.id ?? String(idx)] = { selected, ...(custom ? { custom } : {}) };
        });

        try {
            await onSubmit(request.requestId, formattedAnswers);
        } catch (error) {
            console.error('[AskUserQuestionPrompt] Question response failed:', error);
            if (mountedRef.current) { setIsSubmitting(false); setResponseError(t('shell.askQuestion.submitFailed')); }
        }
    }, [allAnswered, isSubmitting, answers, customInputs, request, onSubmit, t]);

    const handleCancel = useCallback(async () => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        setResponseError('');
        try {
            await onCancel(request.requestId);
        } catch (error) {
            console.error('[AskUserQuestionPrompt] Question cancellation failed:', error);
            if (mountedRef.current) { setIsSubmitting(false); setResponseError(t('shell.askQuestion.cancelFailed')); }
        }
    }, [isSubmitting, request.requestId, onCancel, t]);

    // Navigate to specific question by clicking indicator
    const handleIndicatorClick = useCallback((idx: number) => {
        // Only allow navigation to answered questions or the next unanswered
        const canNavigate = idx <= currentIndex || isQuestionAnswered(idx - 1);
        if (canNavigate) {
            setCurrentIndex(idx);
        }
    }, [currentIndex, isQuestionAnswered]);

    // Handle Enter key in custom input to advance
    const handleCustomInputKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (isImeComposingEvent(e)) return;
        if (e.key === 'Enter' && hasCurrentAnswer) {
            e.preventDefault();
            if (isLastQuestion) {
                handleSubmit();
            } else {
                handleNext();
            }
        }
    }, [hasCurrentAnswer, isLastQuestion, handleSubmit, handleNext]);

    const isCustomSelected = currentAnswer.includes(CUSTOM_INPUT_MARKER);

    // Track which option's preview is expanded: "questionIndex:optionLabel"
    // Encoding question index in key ensures auto-reset when switching questions
    const [expandedPreviewKey, setExpandedPreviewKey] = useState<string | null>(null);
    const expandedPreview = expandedPreviewKey?.startsWith(`${currentIndex}:`)
        ? expandedPreviewKey.slice(`${currentIndex}:`.length)
        : null;

    // Guard against empty questions array - render fallback after all hooks
    if (!currentQuestion) {
        console.error('[AskUserQuestionPrompt] No questions provided');
        return null;
    }

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-200">
            {/* 反相版（PRD 0.2.34）：padded 白卡，去 header 分隔线 / footer 内嵌栏，
                颜色只落在被选中的选项上（accent 赭石）。交互逻辑一行未动。 */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 shadow-sm">
                {/* Header row */}
                <div className="flex items-center gap-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/10">
                        <HelpBubbleIcon className="size-4 text-[var(--accent)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-[var(--accent)] px-2 py-0.5 bg-[var(--accent)]/15 rounded-md">
                                {currentQuestion.header}
                            </span>
                            {totalQuestions > 1 && (
                                <span className="text-xs text-[var(--ink-muted)]">
                                    {currentIndex + 1} / {totalQuestions}
                                </span>
                            )}
                        </div>
                        <div className="text-sm font-medium text-[var(--ink)] mt-1">
                            {currentQuestion.question}
                        </div>
                    </div>
                </div>

                {responseError && <p role="alert" className="mt-3 text-sm text-[var(--error)]">{responseError}</p>}

                {/* Options */}
                <div className="mt-3 space-y-2">
                    {currentQuestion.options.map((option) => {
                        const isSelected = currentAnswer.includes(option.label);
                        const hasPreview = !!option.preview;
                        const isPreviewExpanded = expandedPreview === option.label;
                        return (
                            <div key={option.label}>
                                <button
                                    onClick={() => handleOptionSelect(option.label)}
                                    disabled={isSubmitting}
                                    aria-pressed={isSelected}
                                    className={`w-full text-left px-4 py-3 rounded-lg border transition-all
                                        ${isSelected
                                            ? 'border-[var(--accent)] bg-[var(--accent)]/8 ring-1 ring-[var(--accent)]/25'
                                            : 'border-[var(--line-subtle)] bg-[var(--paper)] hover:border-[var(--line)] hover:bg-[var(--paper-inset)]'
                                        }
                                        disabled:opacity-50 disabled:cursor-not-allowed`}
                                >
                                    <div className="flex items-start gap-3">
                                        <div className={`mt-0.5 flex-shrink-0 size-5 border-2 flex items-center justify-center
                                            ${currentQuestion.multiSelect ? 'rounded-md' : 'rounded-full'}
                                            ${isSelected
                                                ? 'border-[var(--accent)] bg-[var(--accent)]'
                                                : 'border-[var(--line)]'
                                            }`}
                                        >
                                            {isSelected && <CheckIcon className="size-3 text-[var(--on-accent)]" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <div className={`text-sm font-medium ${isSelected ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                                                    {option.label}
                                                </div>
                                                {hasPreview && (
                                                    <span
                                                        role="button"
                                                        tabIndex={0}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setExpandedPreviewKey(isPreviewExpanded ? null : `${currentIndex}:${option.label}`);
                                                        }}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter' || e.key === ' ') {
                                                                e.stopPropagation();
                                                                e.preventDefault();
                                                                setExpandedPreviewKey(isPreviewExpanded ? null : `${currentIndex}:${option.label}`);
                                                            }
                                                        }}
                                                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded
                                                            transition-colors cursor-pointer select-none
                                                            ${isPreviewExpanded
                                                                ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                                                                : 'text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                                                            }`}
                                                        title={t('shell.askQuestion.preview')}
                                                    >
                                                        <EyeIcon className="size-3" />
                                                    </span>
                                                )}
                                            </div>
                                            {option.description && (
                                                <div className="text-xs text-[var(--ink-muted)] mt-0.5">
                                                    {option.description}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </button>
                                {/* Inline preview panel (HTML content from SDK) */}
                                {isPreviewExpanded && option.preview && (
                                    <div className="mt-1 ml-8 rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] overflow-hidden">
                                        <div
                                            className="p-3 text-xs text-[var(--ink)] overflow-auto max-h-64
                                                [&_pre]:bg-[var(--paper)] [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto [&_pre]:text-xs
                                                [&_code]:font-mono [&_code]:text-xs
                                                [&_p]:my-1 [&_ul]:ml-4 [&_ol]:ml-4 [&_li]:my-0.5"
                                            dangerouslySetInnerHTML={{
                                                __html: request.previewFormat === 'html'
                                                    ? sanitizePreviewHtml(option.preview)
                                                    : option.preview.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
                                            }}
                                        />
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {/* Custom input option */}
                    {currentQuestion.allowCustom !== false && <div
                        className={`w-full text-left px-4 py-3 rounded-lg border transition-all
                            ${isCustomSelected
                                ? 'border-[var(--accent)] bg-[var(--accent)]/8 ring-1 ring-[var(--accent)]/25'
                                : 'border-[var(--line-subtle)] bg-[var(--paper)] hover:border-[var(--line)]'
                            }`}
                    >
                        <div className="flex items-start gap-3">
                            <button
                                onClick={() => handleOptionSelect(CUSTOM_INPUT_MARKER)}
                                disabled={isSubmitting}
                                className="mt-0.5 flex-shrink-0"
                            >
                                <div className={`size-5 border-2 flex items-center justify-center
                                    ${currentQuestion.multiSelect ? 'rounded-md' : 'rounded-full'}
                                    ${isCustomSelected
                                        ? 'border-[var(--accent)] bg-[var(--accent)]'
                                        : 'border-[var(--line)]'
                                    }`}
                                >
                                    {isCustomSelected && <CheckIcon className="size-3 text-[var(--on-accent)]" />}
                                </div>
                            </button>
                            <input
                                ref={customInputRef}
                                type={currentQuestion.isSecret ? 'password' : 'text'}
                                value={currentCustomInput}
                                onChange={(e) => handleCustomInputChange(e.target.value)}
                                onKeyDown={handleCustomInputKeyDown}
                                placeholder={t('shell.askQuestion.customPlaceholder')}
                                autoComplete={currentQuestion.isSecret ? 'off' : undefined}
                                disabled={isSubmitting}
                                className={`flex-1 min-w-0 bg-transparent text-sm outline-none
                                    placeholder:text-[var(--ink-muted)]
                                    ${isCustomSelected ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}
                                    disabled:opacity-50`}
                            />
                        </div>
                    </div>}
                </div>

                {/* Progress indicators (for multi-question) */}
                {totalQuestions > 1 && (
                    <div className="mt-3 flex justify-center gap-1.5" role="tablist" aria-label={t('shell.askQuestion.progressAria')}>
                        {request.questions.map((q, idx) => {
                            const isAnswered = (answers[idx]?.length ?? 0) > 0;
                            const isCurrent = idx === currentIndex;
                            return (
                                <button
                                    key={`progress-${idx}`}
                                    onClick={() => handleIndicatorClick(idx)}
                                    role="tab"
                                    aria-selected={isCurrent}
                                    aria-label={t('shell.askQuestion.questionAria', { index: idx + 1, header: q.header })}
                                    className={`h-1.5 rounded-full transition-all
                                        ${isCurrent ? 'w-6' : 'w-1.5'}
                                        ${isCurrent
                                            ? 'bg-[var(--accent)]'
                                            : isAnswered
                                                ? 'bg-[var(--accent)]/40 hover:bg-[var(--accent)]/60'
                                                : 'bg-[var(--line)] hover:bg-[var(--line-subtle)]'
                                        }`}
                                    disabled={isSubmitting}
                                />
                            );
                        })}
                    </div>
                )}

                {/* Action buttons */}
                <div className="mt-3 flex items-center justify-between gap-2">
                    <button
                        onClick={handleCancel}
                        disabled={isSubmitting}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                            text-[var(--ink-muted)] hover:text-[var(--ink)]
                            border border-[var(--line-subtle)] hover:border-[var(--line)] hover:bg-[var(--paper-inset)]
                            transition-colors disabled:opacity-50"
                    >
                        <CloseIcon className="size-3.5" />
                        <span>{t('shell.common.cancel')}</span>
                    </button>

                    <div className="flex items-center gap-2">
                        {/* Previous button */}
                        {!isFirstQuestion && (
                            <button
                                onClick={handlePrevious}
                                disabled={isSubmitting}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg
                                    text-[var(--ink-muted)] hover:text-[var(--ink)]
                                    border border-[var(--line-subtle)] hover:border-[var(--line)] hover:bg-[var(--paper-inset)]
                                    transition-colors disabled:opacity-50"
                            >
                                <ChevronLeftIcon className="size-3.5" />
                                <span>{t('shell.askQuestion.previous')}</span>
                            </button>
                        )}

                        {/* Next or Submit button */}
                        {isLastQuestion ? (
                            <button
                                onClick={handleSubmit}
                                disabled={!allAnswered || isSubmitting}
                                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg
                                    text-[var(--on-accent)] bg-[var(--accent)] hover:bg-[var(--accent-warm-hover)]
                                    transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <CheckIcon className="size-3.5" />
                                <span>{t('shell.askQuestion.submit')}</span>
                            </button>
                        ) : (
                            <button
                                onClick={handleNext}
                                disabled={!hasCurrentAnswer || isSubmitting}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg
                                    text-[var(--ink)] hover:text-[var(--accent)]
                                    border border-[var(--line-subtle)] hover:border-[var(--accent)]/30 hover:bg-[var(--accent)]/5
                                    transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <span>{t('shell.askQuestion.next')}</span>
                                <ChevronRightIcon className="size-3.5" />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
