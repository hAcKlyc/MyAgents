import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { MessageCircleQuestion, ChevronLeft, ChevronRight, X, Check } from 'lucide-react';

// Import shared types
import type { AskUserQuestionRequest } from '../../shared/types/askUserQuestion';
export type { AskUserQuestion, AskUserQuestionOption, AskUserQuestionRequest } from '../../shared/types/askUserQuestion';

// Special marker for custom input answer (UUID-like to avoid collision with option labels)
const CUSTOM_INPUT_MARKER = '__CUSTOM_INPUT_7f3d8a2e__';

interface AskUserQuestionPromptProps {
    request: AskUserQuestionRequest;
    onSubmit: (requestId: string, answers: Record<string, string>) => void;
    onCancel: (requestId: string) => void;
}

/**
 * AskUserQuestion prompt component - wizard-style multi-question form
 * Shows one question at a time with navigation between questions
 */
export function AskUserQuestionPrompt({ request, onSubmit, onCancel }: AskUserQuestionPromptProps) {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<number, string[]>>({});
    const [customInputs, setCustomInputs] = useState<Record<number, string>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const customInputRef = useRef<HTMLInputElement>(null);
    const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Cleanup timers on unmount
    useEffect(() => {
        return () => {
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

    // Check if current question has an answer (either option or custom input)
    const currentAnswer = answers[currentIndex] || [];
    const currentCustomInput = customInputs[currentIndex] || '';
    const hasCustomInput = currentAnswer.includes(CUSTOM_INPUT_MARKER) && currentCustomInput.trim().length > 0;
    const hasCurrentAnswer = currentAnswer.length > 0 && (
        !currentAnswer.includes(CUSTOM_INPUT_MARKER) || hasCustomInput
    );

    // Check if all questions have answers
    const allAnswered = useMemo(() => {
        return request.questions.every((_, idx) => {
            const ans = answers[idx];
            if (!ans || ans.length === 0) return false;
            // If custom input is selected, check it has content
            if (ans.includes(CUSTOM_INPUT_MARKER)) {
                return (customInputs[idx] || '').trim().length > 0;
            }
            return true;
        });
    }, [request.questions, answers, customInputs]);

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

    const handleSubmit = useCallback(() => {
        if (!allAnswered || isSubmitting) return;
        setIsSubmitting(true);

        // Convert answers to the format SDK expects: { "0": "label", "1": "label1,label2" }
        const formattedAnswers: Record<string, string> = {};
        request.questions.forEach((_, idx) => {
            const selectedOptions = answers[idx] || [];
            // Replace custom input marker with actual input value
            const finalOptions = selectedOptions.map(opt =>
                opt === CUSTOM_INPUT_MARKER ? (customInputs[idx] || '').trim() : opt
            ).filter(Boolean);
            formattedAnswers[String(idx)] = finalOptions.join(',');
        });

        onSubmit(request.requestId, formattedAnswers);
    }, [allAnswered, isSubmitting, answers, customInputs, request, onSubmit]);

    const handleCancel = useCallback(() => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        onCancel(request.requestId);
    }, [isSubmitting, request.requestId, onCancel]);

    // Navigate to specific question by clicking indicator
    const handleIndicatorClick = useCallback((idx: number) => {
        // Only allow navigation to answered questions or the next unanswered
        const canNavigate = idx <= currentIndex || (answers[idx - 1]?.length ?? 0) > 0;
        if (canNavigate) {
            setCurrentIndex(idx);
        }
    }, [currentIndex, answers]);

    // Handle Enter key in custom input to advance
    const handleCustomInputKeyDown = useCallback((e: React.KeyboardEvent) => {
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

    // Guard against empty questions array - render fallback after all hooks
    if (!currentQuestion) {
        console.error('[AskUserQuestionPrompt] No questions provided');
        return null;
    }

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="rounded-xl border border-[var(--line)] bg-white dark:bg-[var(--paper-elevated)] shadow-sm overflow-hidden">
                {/* Header row */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--line-subtle)]">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/10">
                        <MessageCircleQuestion className="size-4 text-[var(--accent)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-[var(--ink-muted)] px-1.5 py-0.5 bg-[var(--paper-contrast)] rounded">
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

                {/* Options */}
                <div className="p-4 space-y-2">
                    {currentQuestion.options.map((option) => {
                        const isSelected = currentAnswer.includes(option.label);
                        return (
                            <button
                                key={option.label}
                                onClick={() => handleOptionSelect(option.label)}
                                disabled={isSubmitting}
                                aria-pressed={isSelected}
                                className={`w-full text-left px-4 py-3 rounded-lg border transition-all
                                    ${isSelected
                                        ? 'border-[var(--accent)] bg-[var(--accent)]/5 ring-1 ring-[var(--accent)]/20'
                                        : 'border-[var(--line-subtle)] hover:border-[var(--line)] hover:bg-[var(--paper-contrast)]'
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
                                        {isSelected && <Check className="size-3 text-white" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className={`text-sm font-medium ${isSelected ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                                            {option.label}
                                        </div>
                                        {option.description && (
                                            <div className="text-xs text-[var(--ink-muted)] mt-0.5">
                                                {option.description}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </button>
                        );
                    })}

                    {/* Custom input option */}
                    <div
                        className={`w-full text-left px-4 py-3 rounded-lg border transition-all
                            ${isCustomSelected
                                ? 'border-[var(--accent)] bg-[var(--accent)]/5 ring-1 ring-[var(--accent)]/20'
                                : 'border-[var(--line-subtle)] hover:border-[var(--line)]'
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
                                    {isCustomSelected && <Check className="size-3 text-white" />}
                                </div>
                            </button>
                            <input
                                ref={customInputRef}
                                type="text"
                                value={currentCustomInput}
                                onChange={(e) => handleCustomInputChange(e.target.value)}
                                onKeyDown={handleCustomInputKeyDown}
                                placeholder="说说你的想法"
                                disabled={isSubmitting}
                                className={`flex-1 min-w-0 bg-transparent text-sm outline-none
                                    placeholder:text-[var(--ink-muted)]
                                    ${isCustomSelected ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}
                                    disabled:opacity-50`}
                            />
                        </div>
                    </div>
                </div>

                {/* Progress indicators (for multi-question) */}
                {totalQuestions > 1 && (
                    <div className="flex justify-center gap-1.5 px-4 pb-3" role="tablist" aria-label="问题进度">
                        {request.questions.map((q, idx) => {
                            const isAnswered = (answers[idx]?.length ?? 0) > 0;
                            const isCurrent = idx === currentIndex;
                            return (
                                <button
                                    key={`progress-${idx}`}
                                    onClick={() => handleIndicatorClick(idx)}
                                    role="tab"
                                    aria-selected={isCurrent}
                                    aria-label={`问题 ${idx + 1}: ${q.header}`}
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
                <div className="flex items-center justify-between gap-2 px-4 py-3 bg-[var(--paper-contrast)] border-t border-[var(--line-subtle)]">
                    <button
                        onClick={handleCancel}
                        disabled={isSubmitting}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                            text-[var(--ink-muted)] hover:text-[var(--ink)]
                            border border-[var(--line-subtle)] hover:border-[var(--line)] hover:bg-white dark:hover:bg-[var(--paper-elevated)]
                            transition-colors disabled:opacity-50"
                    >
                        <X className="size-3.5" />
                        <span>取消</span>
                    </button>

                    <div className="flex items-center gap-2">
                        {/* Previous button */}
                        {!isFirstQuestion && (
                            <button
                                onClick={handlePrevious}
                                disabled={isSubmitting}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg
                                    text-[var(--ink-muted)] hover:text-[var(--ink)]
                                    border border-[var(--line-subtle)] hover:border-[var(--line)] hover:bg-white dark:hover:bg-[var(--paper-elevated)]
                                    transition-colors disabled:opacity-50"
                            >
                                <ChevronLeft className="size-3.5" />
                                <span>上一题</span>
                            </button>
                        )}

                        {/* Next or Submit button */}
                        {isLastQuestion ? (
                            <button
                                onClick={handleSubmit}
                                disabled={!allAnswered || isSubmitting}
                                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg
                                    text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)]
                                    transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Check className="size-3.5" />
                                <span>提交</span>
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
                                <span>下一题</span>
                                <ChevronRight className="size-3.5" />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
