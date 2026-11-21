/**
 * CodeBlock - Syntax highlighted code block with copy button
 * Supports all major programming languages via react-syntax-highlighter
 */

import { CheckIcon, CopyIcon } from '@/components/icons';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { useResolvedTheme } from '@/theme';
import { createStreamingHighlight, renderFinishedHighlight } from './streamingHighlight';
import { copyPlainText } from '@/utils/clipboard';

interface CodeBlockProps {
    children: string;
    language?: string;
    className?: string;
    streaming?: boolean;
    sourceOffset?: number;
}


export default function CodeBlock({ children, language, className, sourceOffset, streaming = false }: CodeBlockProps) {
    const { t } = useTranslation('app');
    const customTheme = useResolvedTheme().adapters.prism;
    const [copied, setCopied] = useState(false);

    // Extract language from className if not provided directly
    const extractedLanguage = language || className?.replace(/language-/, '') || 'text';

    const numbered = children.split('\n').length > 5;
    const source = children.trim();
    const optimized = streaming && numbered && ['typescript', 'ts', 'javascript', 'js'].includes(extractedLanguage);
    const [wasOptimized, setWasOptimized] = useState(optimized);
    if (optimized && !wasOptimized) setWasOptimized(true);
    const highlight = useMemo(() => optimized ? createStreamingHighlight(extractedLanguage, customTheme) : null,
        [optimized, extractedLanguage, customTheme]);
    const syntax = useMemo(() => highlight?.(source), [highlight, source]);

    const handleCopy = useCallback(async () => {
        try {
            await copyPlainText(children);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }, [children]);

    return (
        <div data-chat-source={sourceOffset} className="markdown-code-block group relative w-full min-w-0 max-w-full overflow-hidden rounded-md border border-[var(--line)] bg-[var(--paper-inset)]/30">
            {/* Header with language label and copy button */}
            <div className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--code-bg)] px-4 py-1.5 text-xs font-normal">
                <span className="font-mono text-[var(--code-line-number)] uppercase tracking-wide">
                    {extractedLanguage}
                </span>
                <button
                    type="button"
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-[var(--code-line-number)] transition-colors hover:bg-[var(--line-subtle)] hover:text-[var(--code-text)]"
                    title={copied ? t('markdown.copied') : t('markdown.copyCode')}
                >
                    {copied ? (
                        <>
                            <CheckIcon className="size-3.5" />
                            <span>{t('markdown.copied')}</span>
                        </>
                    ) : (
                        <>
                            <CopyIcon className="size-3.5" />
                            <span>{t('markdown.copy')}</span>
                        </>
                    )}
                </button>
            </div>

            {/* Code content with syntax highlighting */}
            <SyntaxHighlighter
                language={extractedLanguage}
                style={customTheme}
                className="overflow-x-auto"
                customStyle={{
                    margin: 0,
                    background: 'transparent',
                    borderTopLeftRadius: 0,
                    borderTopRightRadius: 0,
                }}
                wrapLines={false}
                renderer={wasOptimized ? renderFinishedHighlight : undefined}
                {...syntax}
                showLineNumbers={numbered}
                lineNumberStyle={{
                    minWidth: '2.5em',
                    paddingRight: '1em',
                    color: 'var(--code-line-number)',
                    userSelect: 'none',
                }}
                wrapLongLines={false}
            >
                {source}
            </SyntaxHighlighter>
        </div>
    );
}
