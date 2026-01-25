/**
 * InlineCode - Styled inline code snippets
 */

interface InlineCodeProps {
    children: React.ReactNode;
}

export default function InlineCode({ children }: InlineCodeProps) {
    return (
        <code className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 font-mono text-[0.9em] text-[var(--ink)]">
            {children}
        </code>
    );
}
