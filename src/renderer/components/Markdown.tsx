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
import './Markdown.css';

import { Fragment, lazy, Suspense, memo, useEffect, useMemo, useState, type ComponentProps } from 'react';
import type { Components } from 'react-markdown';
import type { Element } from 'hast';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';

import CodeBlock from './markdown/CodeBlock';
import InlineCode from './markdown/InlineCode';
import ContentLink from './markdown/ContentLink';
import { MarkdownDocumentDirectoryContext } from './markdown/linkContext';
import MarkdownTable from './markdown/MarkdownTable';
const MermaidDiagram = lazy(() => import('./markdown/MermaidDiagram'));
import { useFileAction } from '@/context/fileActionState';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { remarkRuntimeCitations, type CitationSources } from '@/utils/runtimeCitations';
import { preprocessMarkdownContent } from '@/utils/markdownPreprocess';
import { splitMarkdownRenderChunks } from '@/utils/markdownChunks';
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS_DEFAULT,
  MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  MARKDOWN_URL_TRANSFORM,
  convertFrontmatter,
  remarkDisableSetextHeadings,
} from '@/utils/markdownPipeline';
import { canonicalizeLegacyMyAgentsResourceUrl } from '@/utils/myagentsProtocol';
import { fileUrlToPath, resolveAgainstWorkspace } from '@/utils/workspaceFileLinks';

// ── Streaming leading-edge fade ──
// While streaming, wrap the LAST few characters of the last text node in a
// <span class="md-stream-tail"> so CSS can give them a left→right fade — newly-typed
// text emerges softly instead of hard-popping (replaces the old caret). A positional CSS
// mask can't target "the newest characters" (their on-screen position varies), but since
// the data-layer typewriter feeds revealed text into the message, we can find the tail in
// the parsed HAST. Runs AFTER sanitize (last in the rehype chain) so the injected span is
// never stripped. STREAM_TAIL_LEN code points fade; as reveal advances the window slides,
// so each char fades in over a few reveal steps. Tunable taste param.
const STREAM_TAIL_LEN = 10;
interface HastNodeLite { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNodeLite[]; }
type TailHit = { parent: HastNodeLite; index: number; value: string };
function rehypeStreamTail() {
  return (tree: HastNodeLite) => {
    // Find the LAST text node in document order. walk returns its hit (rather than mutating
    // an outer `let`, which TS can't narrow through a closure) — children are scanned in
    // order and the latest text/recursion result wins, so the document-order-last text node.
    const walk = (node: HastNodeLite): TailHit | null => {
      const kids = node.children;
      if (!kids) return null;
      let result: TailHit | null = null;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.type === 'text' && child.value) {
          result = { parent: node, index: i, value: child.value };
        } else if (child.children) {
          const deeper = walk(child);
          if (deeper) result = deeper;
        }
      }
      return result;
    };
    const found = walk(tree);
    if (!found) return;
    const chars = Array.from(found.value); // code-point aware
    const n = Math.min(STREAM_TAIL_LEN, chars.length);
    if (n <= 0) return;
    const head = chars.slice(0, chars.length - n).join('');
    const tail = chars.slice(chars.length - n).join('');
    const span: HastNodeLite = {
      type: 'element', tagName: 'span',
      properties: { className: ['md-stream-tail'] },
      children: [{ type: 'text', value: tail }],
    };
    const replacement: HastNodeLite[] = head ? [{ type: 'text', value: head }, span] : [span];
    found.parent.children!.splice(found.index, 1, ...replacement);
  };
}

// Streaming variant: same chain + the trailing-fade injector last (post-sanitize).
const REHYPE_PLUGINS_STREAMING: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  ...(MARKDOWN_REHYPE_PLUGINS ?? []),
  rehypeStreamTail as unknown as NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>[number],
];

// Custom link component that opens links in embedded browser panel (if available)
// or falls back to system browser. Supports text selection for copying.
// Strips react-markdown's hast `node` prop so it doesn't get spread onto the DOM <a>.
const MarkdownLink = memo(function MarkdownLink({ href, children, basePath = '', node, ...props }: React.ComponentProps<'a'> & { node?: Element; basePath?: string }) {
  const originalHref = (node?.data as { originalHref?: unknown } | undefined)?.originalHref;
  return <ContentLink reference={href ?? ''} displayReference={typeof originalHref === 'string' ? originalHref : href} basePath={basePath} {...props}>{children}</ContentLink>;
});

// Custom code component - handles both inline and block code
const CodeComponent: Components['code'] = ({ className, children, node: _node, ...props }) => {
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
      return <Suspense fallback={<pre className="overflow-auto rounded-lg bg-[var(--paper-inset)] p-4">{codeString}</pre>}><MermaidDiagram>{codeString}</MermaidDiagram></Suspense>;
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

// Shared table surface and per-table actions.
const TableHeadComponent: Components['thead'] = ({ children }) => (
  <thead className="bg-[var(--paper-inset)]/40">{children}</thead>
);

const TableRowComponent: Components['tr'] = ({ children }) => (
  <tr className="border-b border-[var(--line-subtle)] last:border-0">
    {children}
  </tr>
);

// 表格 = text-sm(14px)：嵌在 16px 正文里的密集内容比正文低一档（13px 会造成
// 肉眼可见跳变，PRD 0.2.34 P0-1 定为 14）。v2.5 起 ui 档本身就是 14px，原 dense
// 专用档（text-md）与其 lint 白名单机制已随 Part 3 合并删除。
const TableCellComponent: Components['td'] = ({ children, node: _node, ...props }) => (
  <td {...props} className="markdown-table-cell">{children}</td>
);

const TableHeaderComponent: Components['th'] = ({ children, node: _node, ...props }) => (
  <th {...props} className="markdown-table-header">
    {children}
  </th>
);

// Custom blockquote for better styling
const BlockquoteComponent: Components['blockquote'] = ({ children }) => (
  <blockquote className="markdown-blockquote">
    {children}
  </blockquote>
);

// Custom heading components - H1:22px H2:20px H3:18px H4-H6:16px
const H1Component: Components['h1'] = ({ children, className, node: _node, ...props }) => (
  <h1 {...props} className={['markdown-heading markdown-h1', className].filter(Boolean).join(' ')}>
    {children}
  </h1>
);

const H2Component: Components['h2'] = ({ children, className, node: _node, ...props }) => (
  <h2 {...props} className={['markdown-heading markdown-h2', className].filter(Boolean).join(' ')}>
    {children}
  </h2>
);

const H3Component: Components['h3'] = ({ children, className, node: _node, ...props }) => (
  <h3 {...props} className={['markdown-heading markdown-h3', className].filter(Boolean).join(' ')}>
    {children}
  </h3>
);

const H4Component: Components['h4'] = ({ children, className, node: _node, ...props }) => (
  <h4 {...props} className={['markdown-heading markdown-h4', className].filter(Boolean).join(' ')}>
    {children}
  </h4>
);

const H5Component: Components['h5'] = ({ children, className, node: _node, ...props }) => (
  <h5 {...props} className={['markdown-heading markdown-h5', className].filter(Boolean).join(' ')}>
    {children}
  </h5>
);

const H6Component: Components['h6'] = ({ children, className, node: _node, ...props }) => (
  <h6 {...props} className={['markdown-heading markdown-h6', className].filter(Boolean).join(' ')}>
    {children}
  </h6>
);

// Custom list components
const UlComponent: Components['ul'] = ({ children, className, node: _node, ...props }) => (
  <ul
    {...props}
    className={['markdown-list', 'markdown-list-unordered', className].filter(Boolean).join(' ')}
  >
    {children}
  </ul>
);

const OlComponent: Components['ol'] = ({ children, className, node: _node, start, ...props }) => (
  <ol
    {...props}
    start={start}
    className={['markdown-list', 'markdown-list-ordered', className].filter(Boolean).join(' ')}
  >
    {children}
  </ol>
);

const LiComponent: Components['li'] = ({ children, className, node: _node, ...props }) => (
  <li
    {...props}
    className={['markdown-list-item', className].filter(Boolean).join(' ')}
  >
    {children}
  </li>
);

// Paragraph rhythm is owned by the Markdown root stylesheet. Keeping a semantic
// class here lets default and compact density change as one coherent system.
const ParagraphComponent: Components['p'] = ({ children }) => (
  <p className="markdown-paragraph">{children}</p>
);

const StrongComponent: Components['strong'] = ({ children }) => (
  <strong className="markdown-strong">{children}</strong>
);

// Horizontal rule
const HrComponent: Components['hr'] = () => (
  <hr className="markdown-rule border-[var(--line)]" />
);

// Display math is a native horizontal scroller, including in live preview.
const SpanComponent: Components['span'] = ({ className, node: _node, ...props }) => (
  <span {...props} className={className?.split(' ').includes('katex-display')
    ? `${className} overflow-x-auto` : className} />
);

// Combine all custom components
const markdownComponents: Components = {
  a: MarkdownLink,
  span: SpanComponent,
  code: CodeComponent,
  pre: PreComponent,
  table: MarkdownTable,
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
  strong: StrongComponent,
};

interface MarkdownProps {
  /** Remote text cannot invoke local file/browser/image/embedded-diagram actions. */
  remoteContent?: boolean;
  citationSources?: CitationSources;
  children: string;
  /** Document-level numbering for an editor rendering isolated fragments. */
  footnoteNumbers?: ReadonlyMap<string, number>;
  /** Use compact styling for smaller spaces like thinking blocks */
  compact?: boolean;
  /** Preserve single newlines as line breaks (useful for user messages in chat) */
  preserveNewlines?: boolean;
  /** User prose requires explicit # headings; documents retain Setext headings. */
  allowSetextHeadings?: boolean;
  /** Skip preprocessing (for rendering complete documents like file preview) */
  raw?: boolean;
  /** Active streaming tail: softly fade the bottom edge + show a breathing caret
   *  on the last paragraph. Only the currently-growing assistant text block sets
   *  this (see Message.tsx); it is removed the instant the turn ends → crisp final. */
  streaming?: boolean;
  /** Native document directory: workspace-relative for workspace documents,
   *  absolute for external documents. Used for relative images and links. */
  basePath?: string;
  /** **Absolute** workspace root path — fed to `useWorkspaceFileService` so
   *  the relative-image fetch goes through `cmd_workspace_download_file`.
   *  Defaults to the enclosing FileActionProvider's workspace in chat.
   *  Explicit null means there is no workspace. An absolute `basePath` still
   *  resolves external document references through the existing local-file API. */
  workspacePath?: string | null;
}

/** Browser URLs, including protocol-relative CDN addresses. */
function isAbsoluteUrl(src: string): boolean {
  return /^(https?:|data:|blob:|\/\/)/i.test(src);
}

/** Safely decode URI component, returning original on malformed input */
function safeDecodeURIComponent(str: string): string {
  try { return decodeURIComponent(str); } catch { return str; }
}

/**
 * Local image loading is shared by chat and document previews. Browser URLs
 * remain URLs; absolute OS paths use the local-file API; relative paths use
 * the document directory within the explicit or enclosing chat workspace.
 * Rust owns path normalization, containment and read authorization. This
 * component owns the returned blob handle, including late async completion.
 */
function MarkdownImageInner({ src, alt, basePath, workspacePath }: {
  src?: string;
  alt?: string;
  basePath: string;
  workspacePath?: string | null;
}) {
  const { t } = useTranslation('app');
  const fileAction = useFileAction();
  const workspace = workspacePath === undefined ? fileAction?.workspacePath ?? null : workspacePath;
  const fileService = useWorkspaceFileService(workspace);
  const { isAvailable, readFileAsBlobUrl, readLocalFileAsBlobUrl } = fileService;
  const srcType = !src ? 'empty' : isAbsoluteUrl(src) ? 'url' : 'local';
  // Markdown encodes filenames as URLs. Decode once at the filesystem boundary.
  const decoded = srcType === 'local' ? fileUrlToPath(src!) ?? safeDecodeURIComponent(src!) : '';
  // Do not collapse `..` here: Rust must see and reject workspace escapes.
  const relativePath = basePath ? `${basePath}/${decoded}` : decoded;
  const absolutePath = resolveAgainstWorkspace(decoded, null) ?? resolveAgainstWorkspace(relativePath, null);
  // isAvailable includes a workspace requirement; absolute local reads do not.
  const unavailable = srcType === 'local' && !absolutePath && !isAvailable;

  // State only needed for async-loaded local files.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (srcType !== 'local' || unavailable) return;
    let cancelled = false;
    let handle: { blobUrl: string; revoke: () => void } | null = null;

    (async () => {
      try {
        handle = absolutePath
          ? await readLocalFileAsBlobUrl({ fullPath: absolutePath, workspace })
          : await readFileAsBlobUrl({ path: relativePath });
        if (cancelled) {
          handle.revoke();
          return;
        }
        setBlobUrl(handle.blobUrl);
      } catch {
        if (!cancelled) setError(t('markdown.imageLoadFailed', { src }));
      }
    })();

    return () => {
      cancelled = true;
      // The handle owns the blob URL — revoke through it so we don't leak if
      // we created it before the cancel flag flipped.
      if (handle) handle.revoke();
      setBlobUrl(null);
      setError(null);
    };
  }, [src, srcType, absolutePath, relativePath, workspace, unavailable, readLocalFileAsBlobUrl, readFileAsBlobUrl, t]);

  // Empty src: static error (no state needed)
  if (srcType === 'empty') {
    return <span className="md-image-error text-xs text-[var(--ink-muted)] italic">[{t('markdown.emptyImagePath')}]</span>;
  }

  // Browser URL: render directly, after the existing Markdown sanitizer.
  if (srcType === 'url') {
    return (
      <img
        src={canonicalizeLegacyMyAgentsResourceUrl(src!)}
        alt={alt ?? ''}
        className="max-w-full"
      />
    );
  }

  // Local file: loading / error / loaded.
  if (error || unavailable) {
    return <span className="md-image-error text-xs text-[var(--ink-muted)] italic">[{error ?? t('markdown.imageLoadFailed', { src })}]</span>;
  }

  if (!blobUrl) {
    return <span className="inline-block h-4 w-16 animate-pulse rounded bg-[var(--paper-inset)]" />;
  }

  return <img src={blobUrl} alt={alt ?? ''} className="max-w-full" onError={() => setError(t('markdown.imageLoadFailed', { src }))} />;
}

/**
 * Memoized MarkdownImage — second cross-review caught that streamed markdown
 * remounts every <img> on each chunk, which re-fetches the blob and pegs the
 * Tauri IPC channel. The custom comparator keys on (src, basePath, workspacePath)
 * — the only props that affect what gets fetched. Alt text changes don't need
 * to re-trigger the effect.
 */
const MarkdownImage = memo(MarkdownImageInner, (prev, next) =>
  prev.src === next.src
  && prev.basePath === next.basePath
  && prev.workspacePath === next.workspacePath
  && prev.alt === next.alt,
);

/** One independently parsed chunk; ReactMarkdown emits no wrapper element, so
 * sibling chunks produce the same DOM as one whole-document render. */
const MarkdownChunk = memo(function MarkdownChunk({ source, remarkPlugins, rehypePlugins, components }: {
  source: string;
  remarkPlugins: ComponentProps<typeof ReactMarkdown>['remarkPlugins'];
  rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'];
  components: Components;
}) {
  return (
    <ReactMarkdown
      urlTransform={MARKDOWN_URL_TRANSFORM}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {source}
    </ReactMarkdown>
  );
});

const Markdown = memo(function Markdown({ children, compact = false, preserveNewlines = false, allowSetextHeadings = true, raw = false, basePath = '', workspacePath, remoteContent = false, streaming = false, footnoteNumbers, citationSources }: MarkdownProps) {
  const { t } = useTranslation('app');
  const citationUnavailable = t('markdown.citationUnavailable');
  // Skip preprocessing for raw mode (file preview) - preprocessing is for streaming chat messages.
  // In raw mode, convert YAML frontmatter to a fenced code block for proper rendering.
  //
  // NOTE: the per-character typewriter is NOT here. It lives in TabProvider's reveal loop
  // (data layer) so streamingMessage grows on a single clock that also drives autoscroll +
  // Virtuoso measurement. A view-layer typewriter inside this component animated item height
  // on its own rAF, decoupled from scroll/measurement → the streaming-phantom-thinking-rows
  // regressions. `streaming` here only swaps in the rehypeStreamTail plugin (leading-edge fade).
  const processedContent = useMemo(
    () => raw ? convertFrontmatter(children) : preprocessMarkdownContent(children),
    [children, raw],
  );
  // Parse cost must follow what changed, not the whole document: a streaming
  // append re-parses only the tail chunk because earlier chunk strings stay
  // identical and their memoized renderers bail out (#634).
  const chunks = useMemo(() => splitMarkdownRenderChunks(processedContent), [processedContent]);

  const remarkPlugins = useMemo(() => {
    const base = preserveNewlines ? MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : MARKDOWN_REMARK_PLUGINS_DEFAULT;
    const plugins: NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']> = base.map(plugin =>
      plugin === remarkRuntimeCitations ? [remarkRuntimeCitations, { sources: citationSources, unavailableLabel: citationUnavailable }] : plugin);
    return allowSetextHeadings ? plugins : [...plugins, remarkDisableSetextHeadings];
  }, [preserveNewlines, allowSetextHeadings, citationSources, citationUnavailable]);

  // The document directory resolves relative references; it never becomes a
  // workspace grant. Rust separately validates the resulting local/workspace read.

  // All Markdown surfaces share filesystem-aware images. Keep the component
  // identity stable while chat text streams so unchanged images retain handles.
  const components = useMemo(() => {
    return {
      ...markdownComponents,
      ...(remoteContent ? {
        img: ({ alt }: React.ImgHTMLAttributes<HTMLImageElement>) => <span>{alt || ''}</span>,
        a: ({ children }: React.ComponentProps<'a'>) => <span>{children}</span>,
        code: ({ children, className }: React.ComponentProps<'code'>) => <code className={className}>{children}</code>,
        pre: ({ children }: React.ComponentProps<'pre'>) => <pre className="overflow-auto rounded-lg bg-[var(--paper-inset)] p-4">{children}</pre>,
      } : {}),
      img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
        remoteContent ? <span>{props.alt || ''}</span> : <MarkdownImage src={props.src} alt={props.alt} basePath={basePath} workspacePath={workspacePath} />
      ),
      a: (props: React.ComponentProps<'a'> & { node?: Element }) => {
        if (remoteContent) return <span>{props.children}</span>;
        let number: number | undefined;
        if (props.href?.startsWith('#user-content-fn-')) {
          try { number = footnoteNumbers?.get(decodeURIComponent(props.href.slice('#user-content-fn-'.length))); } catch { /* keep the source fragment's link */ }
        }
        return <MarkdownLink {...props} basePath={basePath}>{number ?? props.children}</MarkdownLink>;
      },
    };
  }, [basePath, workspacePath, footnoteNumbers, remoteContent]);

  return (
    <MarkdownDocumentDirectoryContext.Provider value={basePath}>
    <div className={`markdown-content min-w-0 max-w-full break-words${compact ? ' markdown-content--compact' : ''}`}>
      {chunks.map((chunk, index) => (
        <Fragment key={index}>
        {/* ReactMarkdown separates top-level blocks with a "\n" text node;
            keep it at chunk boundaries so the DOM (and plain-text copy) is
            identical to a whole-document render. */}
        {index > 0 && '\n'}
        <MarkdownChunk
          source={chunk}
          remarkPlugins={remarkPlugins}
          rehypePlugins={streaming && !raw && index === chunks.length - 1 ? REHYPE_PLUGINS_STREAMING : MARKDOWN_REHYPE_PLUGINS}
          components={components}
        />
        </Fragment>
      ))}
    </div>
    </MarkdownDocumentDirectoryContext.Provider>
  );
});

export default Markdown;
