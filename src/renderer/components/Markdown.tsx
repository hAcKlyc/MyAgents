/**
 * Markdown - Enhanced Markdown renderer for AI chat
 * 
 * Features:
 * - Syntax highlighted code blocks with copy button
 * - LaTeX math formulas (KaTeX)
 * - Mermaid diagrams
 * - GFM tables, task lists, strikethrough
 * - External links open in system browser
 */

import 'katex/dist/katex.min.css';

import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import CodeBlock from './markdown/CodeBlock';
import InlineCode from './markdown/InlineCode';
import MermaidDiagram from './markdown/MermaidDiagram';
import { openExternal } from '@/utils/openExternal';

// Static plugin arrays to avoid recreation on every render
const REMARK_PLUGINS_DEFAULT = [remarkGfm, remarkMath];
const REMARK_PLUGINS_WITH_BREAKS = [remarkGfm, remarkMath, remarkBreaks];
const REHYPE_PLUGINS = [rehypeKatex];

// Custom link component that opens links in system browser/default app
// Supports text selection for copying
const MarkdownLink: Components['a'] = ({ href, children, ...props }) => {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();

    // Check if user is selecting text - don't open link if selecting
    const selection = window.getSelection();
    const hasSelection = selection && selection.toString().length > 0;

    if (!hasSelection && href) {
      // Open all links with system default application
      // - http/https: system browser
      // - mailto: system email client
      // - file paths: system default app for that file type
      openExternal(href);
    }
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      className="text-amber-700 underline decoration-amber-300 underline-offset-2 transition-colors hover:text-amber-600 hover:decoration-amber-400 dark:text-amber-400 dark:decoration-amber-600 dark:hover:text-amber-300"
      style={{ userSelect: 'text' }}
      {...props}
    >
      {children}
    </a>
  );
};

// Custom code component - handles both inline and block code
const CodeComponent: Components['code'] = ({ className, children, node, ...props }) => {
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';

  // Extract text content from children, handling both string and React elements
  // Max depth prevents stack overflow on deeply nested structures (defensive)
  const extractText = (child: React.ReactNode, depth = 0): string => {
    if (depth > 50) return ''; // Defensive: prevent stack overflow
    if (typeof child === 'string') return child;
    if (typeof child === 'number') return String(child);
    if (Array.isArray(child)) return child.map(c => extractText(c, depth + 1)).join('');
    if (child && typeof child === 'object' && 'props' in child) {
      const element = child as { props?: { children?: React.ReactNode } };
      if (element.props?.children) {
        return extractText(element.props.children, depth + 1);
      }
    }
    return '';
  };

  const codeString = extractText(children).replace(/\n$/, '');

  // Check if this is a block code (has language or multiple lines)
  const isBlock = match || codeString.includes('\n');

  if (isBlock) {
    // Special handling for Mermaid diagrams
    if (language === 'mermaid') {
      return <MermaidDiagram>{codeString}</MermaidDiagram>;
    }

    return (
      <CodeBlock language={language} className={className}>
        {codeString}
      </CodeBlock>
    );
  }

  // Inline code
  return <InlineCode {...props}>{children}</InlineCode>;
};

// Custom pre component - wrapper for code blocks
const PreComponent: Components['pre'] = ({ children }) => {
  // Just pass through - CodeBlock handles the styling
  return <>{children}</>;
};

// Custom table components for better styling
const TableComponent: Components['table'] = ({ children }) => (
  <div className="my-4 overflow-x-auto rounded-lg border border-stone-200/60 dark:border-neutral-700/50">
    <table className="min-w-full divide-y divide-stone-200 dark:divide-neutral-700">
      {children}
    </table>
  </div>
);

const TableHeadComponent: Components['thead'] = ({ children }) => (
  <thead className="bg-stone-100/80 dark:bg-neutral-800/50">{children}</thead>
);

const TableRowComponent: Components['tr'] = ({ children }) => (
  <tr className="border-b border-stone-100 last:border-0 dark:border-neutral-800">
    {children}
  </tr>
);

const TableCellComponent: Components['td'] = ({ children }) => (
  <td className="px-4 py-2.5 text-sm">{children}</td>
);

const TableHeaderComponent: Components['th'] = ({ children }) => (
  <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-stone-600 dark:text-neutral-400">
    {children}
  </th>
);

// Custom blockquote for better styling
const BlockquoteComponent: Components['blockquote'] = ({ children }) => (
  <blockquote className="my-4 border-l-4 border-[var(--warning)]/60 bg-[var(--warning-bg)]/50 py-2 pl-4 pr-3 italic text-[var(--ink-muted)]">
    {children}
  </blockquote>
);

// Custom heading components - H1:22px H2:20px H3:18px H4-H6:16px
const H1Component: Components['h1'] = ({ children }) => (
  <h1 className="mb-4 mt-6 text-[22px] font-bold text-[var(--ink)]">
    {children}
  </h1>
);

const H2Component: Components['h2'] = ({ children }) => (
  <h2 className="mb-3 mt-5 text-[20px] font-semibold text-[var(--ink)]">
    {children}
  </h2>
);

const H3Component: Components['h3'] = ({ children }) => (
  <h3 className="mb-2 mt-4 text-[18px] font-semibold text-[var(--ink)]">
    {children}
  </h3>
);

const H4Component: Components['h4'] = ({ children }) => (
  <h4 className="mb-2 mt-3 text-[16px] font-semibold text-[var(--ink-secondary)]">
    {children}
  </h4>
);

const H5Component: Components['h5'] = ({ children }) => (
  <h5 className="mb-2 mt-3 text-[16px] font-medium text-[var(--ink-secondary)]">
    {children}
  </h5>
);

const H6Component: Components['h6'] = ({ children }) => (
  <h6 className="mb-2 mt-3 text-[16px] font-medium text-[var(--ink-muted)]">
    {children}
  </h6>
);

// Custom list components
const UlComponent: Components['ul'] = ({ children }) => (
  <ul className="my-3 ml-6 block list-outside list-disc space-y-1.5 text-[var(--ink)] marker:text-[var(--ink-muted)]">
    {children}
  </ul>
);

const OlComponent: Components['ol'] = ({ children }) => (
  <ol className="my-3 ml-6 block list-outside list-decimal space-y-1.5 text-[var(--ink)] marker:text-[var(--ink-muted)]">
    {children}
  </ol>
);

const LiComponent: Components['li'] = ({ children }) => (
  <li className="pl-1" style={{ display: 'list-item' }}>{children}</li>
);

// Paragraph component
const ParagraphComponent: Components['p'] = ({ children }) => (
  <p className="my-2 leading-relaxed">{children}</p>
);

// Horizontal rule
const HrComponent: Components['hr'] = () => (
  <hr className="my-6 border-stone-200 dark:border-neutral-700" />
);

// Combine all custom components
const markdownComponents: Components = {
  a: MarkdownLink,
  code: CodeComponent,
  pre: PreComponent,
  table: TableComponent,
  thead: TableHeadComponent,
  tr: TableRowComponent,
  td: TableCellComponent,
  th: TableHeaderComponent,
  blockquote: BlockquoteComponent,
  p: ParagraphComponent,
  hr: HrComponent,
  h1: H1Component,
  h2: H2Component,
  h3: H3Component,
  h4: H4Component,
  h5: H5Component,
  h6: H6Component,
  ul: UlComponent,
  ol: OlComponent,
  li: LiComponent,
};

interface MarkdownProps {
  children: string;
  /** Use compact styling for smaller spaces like thinking blocks */
  compact?: boolean;
  /** Preserve single newlines as line breaks (useful for user messages in chat) */
  preserveNewlines?: boolean;
}

/**
 * Preprocess markdown content for better streaming compatibility
 * - Ensures headers have proper line breaks before them
 * - Ensures headers have a space after the # symbols
 * - Ensures list items are on separate lines
 * - Handles edge cases during streaming
 */
function preprocessContent(content: string): string {
  if (!content) return '';

  let processed = content;

  // 1. Ensure headers have a blank line before them (except at the start)
  // Only match when header is immediately after non-newline text
  // "text## Header" -> "text\n\n## Header"
  processed = processed.replace(/([^\n])(#{1,6})(\s*)/g, '$1\n\n$2 ');

  // 2. Ensure headers at the start of lines have a space after # (if missing)
  // "##Title" -> "## Title" (only at line start)
  processed = processed.replace(/^(#{1,6})([^\s#\n])/gm, '$1 $2');

  // 3. Fix unordered list items at LINE START ONLY
  // "-item" -> "- item" (only when dash is at start of line with no space after)
  processed = processed.replace(/^-([^\s\-\n])/gm, '- $1');

  // 4. Fix ordered list items at LINE START ONLY  
  // "1.item" -> "1. item" (only when number+dot is at start of line with no space after)
  processed = processed.replace(/^(\d+\.)([^\s\n])/gm, '$1 $2');

  return processed;
}

export default function Markdown({ children, compact = false, preserveNewlines = false }: MarkdownProps) {
  const processedContent = preprocessContent(children);

  return (
    <div className={compact ? 'text-sm' : 'text-base'}>
      <ReactMarkdown
        remarkPlugins={preserveNewlines ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS_DEFAULT}
        rehypePlugins={REHYPE_PLUGINS}
        components={markdownComponents}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
}

