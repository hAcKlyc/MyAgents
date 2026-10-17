import { ChevronDownIcon, ChevronUpIcon, MoreIcon } from '@/components/icons';
import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useFileAction, useFileTargetInfo } from '@/context/FileActionContext';
import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import type { ToolUseSimple } from '@/types/chat';
import { resolveFileActionTarget } from '@/utils/workspaceFileLinks';

import {
  getThinkingBadgeConfig,
  getThinkingExpandedLabel,
  getToolBadgeConfig,
  getToolExpandedLabel
} from './toolBadgeConfig';

// (MCP content-array unwrapping now lives in the shared single-source parser
//  `src/shared/builtinMediaResult.ts::unwrapMcpResult` — the local copy here was
//  dead after GeminiImageTool/EdgeTtsTool migrated to it.)

// Legacy function for backward compatibility - now uses unified config
export function getToolColors(toolName: string): {
  text: string;
  icon: string;
} {
  const config = getToolBadgeConfig(toolName);
  return {
    text: config.colors.text,
    icon: config.colors.iconColor
  };
}

interface ToolHeaderProps {
  icon?: ReactNode;
  label?: string;
  toolName?: string;
  tool?: ToolUseSimple;
}

export function ToolHeader({ icon, label, toolName, tool }: ToolHeaderProps) {
  const { t } = useTranslation('chat');
  const config = toolName ? getToolBadgeConfig(toolName) : null;
  // Always use icon from unified config if toolName is provided (single source of truth)
  // Otherwise fall back to passed icon for backward compatibility
  let displayIcon = config?.icon || icon;

  // Config icons carry a flat `size-4` class; resize to size-3 for the denser header.
  // This ensures icons match between badge and header while maintaining readability.
  if (config?.icon && isValidElement(displayIcon)) {
    const element = displayIcon as React.ReactElement<{ className?: string }>;
    const existingProps = element.props as { className?: string };
    const existingClassName = existingProps?.className || '';
    // Replace any size-* with size-3, or add size-3 if no size class exists
    const newClassName =
      existingClassName ? existingClassName.replace(/size-\d+(\.\d+)?/g, 'size-3') : 'size-3';
    displayIcon = cloneElement(element, {
      ...existingProps,
      className: newClassName
    });
  }

  // Use unified expanded label if tool is provided, otherwise use passed label or toolName
  const displayLabel = tool ? getToolExpandedLabel(tool, t) : label || toolName || '';

  return (
    <div
      className={`flex items-center gap-1.5 text-sm font-medium ${config?.colors.text || 'text-[var(--ink-muted)]'}`}
    >
      {displayIcon && (
        <span
          className={`flex h-4 w-4 items-center justify-center ${config?.colors.iconColor || 'text-[var(--ink-muted)]'}`}
        >
          {displayIcon}
        </span>
      )}
      <span className="tracking-tight">{displayLabel}</span>
    </div>
  );
}

const MONO_BASE_CLASS = 'font-mono text-sm tracking-tight text-[var(--ink)]';

export function MonoText({
  children,
  className = ''
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <code className={`${MONO_BASE_CLASS} ${className}`}>
      {children}
    </code>
  );
}

const FILE_PATH_BOX_CLASS = 'rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5';

function useResolvedFileAction(path?: string | null) {
  const fileAction = useFileAction();
  const displayPath = path?.trim() || null;
  const actionTarget = displayPath && fileAction
    ? resolveFileActionTarget(displayPath, fileAction.workspacePath)
    : null;
  const pathInfo = useFileTargetInfo(actionTarget);

  if (!displayPath || !fileAction || !actionTarget || !pathInfo?.exists) return null;
  return {
    displayPath,
    pathInfo,
    openPrimary: (forceExternal: boolean) => {
      fileAction.openFileTarget(actionTarget, { displayPath, forceExternal });
    },
    openMenu: (x: number, y: number) => {
      fileAction.openFileTargetMenu(x, y, actionTarget, { displayPath });
    },
  };
}

/**
 * File-path chip rendered by file tools (Write / Edit / Read / NotebookEdit).
 *
 * When rendered inside a Chat (FileActionContext available) and the path
 * resolves to a file/folder target, the chip becomes interactive — dashed
 * underline + primary click / right-click context menu, matching how inline
 * file paths in AI text behave (see markdown/InlineCode.tsx, which shares the
 * same FileActionContext). Pending, missing and safety-rejected targets remain
 * plain monospace chips; the dashed underline is reserved for a current
 * `exists:true` capability.
 */
export function FilePath({ path }: { path?: string | null }) {
  const { t } = useTranslation('chat');
  const resolvedAction = useResolvedFileAction(path);
  // A file tool can arrive with NO path: a partial/streaming tool input where
  // `file_path` hasn't parsed yet, or a restored/old persisted tool block whose
  // input lacks it (parsedInput comes from parsePartialJson and is optional).
  // Render nothing rather than crash the WHOLE app downstream in
  // toWorkspaceRelativePath's `path.trim()` — that uncaught render error hits the
  // root AppErrorBoundary and replaces the entire UI ("界面渲染出错"). Mirror
  // toWorkspaceRelativePath's emptiness test so a whitespace-only path (also
  // non-actionable) renders nothing rather than a blank chip.
  if (!path?.trim()) return null;
  if (!resolvedAction) {
    return <MonoText className={FILE_PATH_BOX_CLASS}>{path}</MonoText>;
  }

  return (
    <code
      className={`${MONO_BASE_CLASS} ${FILE_PATH_BOX_CLASS} cursor-pointer underline decoration-dashed decoration-[var(--ink-muted)] underline-offset-2 transition-colors hover:border-[var(--ink-muted)] hover:bg-[var(--accent-warm-subtle)]`}
      role="link"
      tabIndex={0}
      onClick={(e) => {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        e.stopPropagation();
        resolvedAction.openPrimary(e.metaKey || e.ctrlKey);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        resolvedAction.openPrimary(e.metaKey || e.ctrlKey);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        resolvedAction.openMenu(e.clientX, e.clientY);
      }}
      title={resolvedAction.pathInfo.type === 'dir' ?
        t('shell.toolChrome.filePath.folder', { path })
        : t('shell.toolChrome.filePath.file', { path })}
    >
      {path}
    </code>
  );
}

/**
 * The single file-toolbar action used by FilePatchTool. It deliberately shares
 * the same resolution and FileActionContext menu owner as FilePath. Once
 * resolution confirms the target exists, the menu uses the same action-time
 * recheck as inline paths.
 */
export function FileActionMenuButton({ path, className = '' }: { path?: string | null; className?: string }) {
  const { t } = useTranslation('chat');
  const resolvedAction = useResolvedFileAction(path);
  if (!resolvedAction) return null;

  const label = t('shell.toolChrome.filePatch.moreActions');
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        resolvedAction.openMenu(rect.right, rect.bottom + 4);
      }}
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-border)]/30 ${className}`}
    >
      <MoreIcon className="size-4" aria-hidden="true" />
    </button>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <MonoText className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5">
      {children}
    </MonoText>
  );
}

/**
 * Unwrap SDK tool result JSON wrappers into displayable plain text.
 *
 * The SDK wraps tool results in JSON with metadata:
 *   Bash:  {"stdout":"...","stderr":"...","interrupted":false}
 *   Read:  {"type":"text","file":{"filePath":"...","content":"..."}}
 *   Grep:  {"mode":"content","numFiles":0,"filenames":[],"content":"1142:function..."}
 *   Glob:  {"mode":"files_with_matches","filenames":["a.ts","b.ts"],"content":"a.ts\nb.ts"}
 *
 * This extracts the meaningful text and unescapes \n so it renders properly.
 * Falls back to the original string if it's not recognized JSON.
 */
export function unwrapSdkResult(result: string): string {
  const trimmed = result.trimStart();
  if (!trimmed.startsWith('{')) return result;
  try {
    const parsed = JSON.parse(trimmed);

    // Bash format: {"stdout":"...","stderr":"..."}
    if ('stdout' in parsed && typeof parsed.stdout === 'string') {
      let output = parsed.stdout;
      if (parsed.stderr && typeof parsed.stderr === 'string') {
        output += (output ? '\n\n' : '') + '[stderr]\n' + parsed.stderr;
      }
      return output || '(no output)';
    }

    // Read format: {"type":"text","file":{"filePath":"...","content":"..."}}
    if (parsed.type === 'text' && typeof parsed.file?.content === 'string') {
      return parsed.file.content;
    }

    // Grep/Glob format: {"mode":"...","content":"..."}
    if ('content' in parsed && typeof parsed.content === 'string') {
      return parsed.content;
    }

    // Unknown JSON — return as-is (let specialized components handle it)
    return result;
  } catch {
    return result;
  }
}

/**
 * Generic height-clamp container — `max-h-96` by default + gradient fade + "展开全部" button.
 * Accepts arbitrary children (ReactNode), so tools with non-string bodies (Edit diff,
 * NotebookEdit cell content, multi-pre layouts) can share the same overflow UX.
 *
 * Watches both ResizeObserver and MutationObserver on the clamped wrapper, so
 * re-measurement fires reliably during streaming (content grows under a fixed
 * max-h, where scrollHeight changes but clientHeight stays).
 */
/** #333: collapse-fade gradients must end at the SAME color with alpha 0 —
 *  never the `transparent` keyword (= rgba(0,0,0,0); buggy gradient
 *  interpolation, e.g. macOS 27 beta WebKit's oklab path, renders the ramp
 *  through BLACK as a gray smear band; see the --*-a0 tokens in index.css).
 *  The fade is a single named choice so the from/to pair can never mismatch,
 *  and the class strings stay literal for Tailwind JIT extraction. */
export type ExpandFade = 'paper-inset' | 'paper-elevated' | 'code-bg';
const EXPAND_FADE_CLASSES: Record<ExpandFade, string> = {
  'paper-inset': 'from-[var(--paper-inset)] to-[var(--paper-inset-a0)]',
  'paper-elevated': 'from-[var(--paper-elevated)] to-[var(--paper-elevated-a0)]',
  'code-bg': 'from-[var(--code-bg)] to-[var(--code-bg-a0)]',
};
const COMPACT_EXPAND_FADE_CLASSES: Record<ExpandFade, string> = {
  'paper-inset': 'from-[var(--paper-inset)]/90 via-[var(--paper-inset)]/80 via-40% to-[var(--paper-inset-a0)]',
  'paper-elevated': 'from-[var(--paper-elevated)]/90 via-[var(--paper-elevated)]/80 via-40% to-[var(--paper-elevated-a0)]',
  'code-bg': 'from-[var(--code-bg)]/90 via-[var(--code-bg)]/80 via-40% to-[var(--code-bg-a0)]',
};

interface ExpandableContainerProps {
  children: ReactNode;
  /** className applied to the outer relative wrapper (e.g. for shared border/bg) */
  wrapperClassName?: string;
  /** Fade color — must match the actual content background for a smooth fade. */
  fade?: ExpandFade;
  /** A short preview with a translucent inline expander and a collapse action. */
  compact?: boolean;
  expandLabel?: string;
  collapseLabel?: string;
}

export function ExpandableContainer({
  children,
  wrapperClassName = '',
  fade = 'paper-inset',
  compact = false,
  expandLabel,
  collapseLabel,
}: ExpandableContainerProps) {
  const { t } = useTranslation('chat');
  const ref = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [needsExpand, setNeedsExpand] = useState(false);
  const contentId = useId();
  const notifyRowLayoutChanged = useNotifyRowLayoutChanged();

  useEffect(() => {
    const el = ref.current;
    if (!el || isExpanded) return;
    const measure = () => {
      setNeedsExpand(el.scrollHeight > el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [isExpanded, compact]);

  return (
    <div className={`relative ${wrapperClassName}`}>
      <div
        ref={ref}
        id={contentId}
        className={`${isExpanded ? '' : compact ? 'max-h-20' : 'max-h-96'} overflow-hidden`}
      >
        {children}
      </div>
      {needsExpand && !isExpanded && compact && (
        <button
          type="button"
          aria-expanded={false}
          aria-controls={contentId}
          onClick={() => {
            notifyRowLayoutChanged('expandable-container-expand');
            setIsExpanded(true);
          }}
          className={`absolute inset-x-0 bottom-0 flex h-12 w-full items-end justify-center gap-1.5 bg-gradient-to-t ${COMPACT_EXPAND_FADE_CLASSES[fade]} pb-2 text-xs text-[var(--ink-secondary)] hover:text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]`}
        >
          <ChevronDownIcon className="mb-0.5 size-3.5" aria-hidden="true" />
          {expandLabel ?? t('shell.toolChrome.common.expandAll')}
        </button>
      )}
      {needsExpand && !isExpanded && !compact && (
        <div className={`absolute bottom-0 left-0 right-0 flex justify-center bg-gradient-to-t ${EXPAND_FADE_CLASSES[fade]} pb-2 pt-8`}>
          <button
            type="button"
            aria-expanded={false}
            aria-controls={contentId}
            onClick={() => {
              notifyRowLayoutChanged('expandable-container-expand');
              setIsExpanded(true);
            }}
            className="rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1 text-xs text-[var(--ink-muted)] shadow-sm hover:text-[var(--ink-secondary)] transition-colors"
          >
            {expandLabel ?? t('shell.toolChrome.common.expandAll')}
          </button>
        </div>
      )}
      {isExpanded && compact && (
        <button
          type="button"
          aria-expanded
          aria-controls={contentId}
          onClick={() => {
            notifyRowLayoutChanged('expandable-container-collapse');
            setIsExpanded(false);
          }}
          className="flex w-full items-center justify-center gap-1.5 py-2 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <ChevronUpIcon className="size-3.5" aria-hidden="true" />
          {collapseLabel ?? t('shell.toolChrome.common.collapse')}
        </button>
      )}
    </div>
  );
}

/**
 * Expandable result container for plain string output — wraps {@link ExpandableContainer}
 * with a `<pre>` and SDK-result unwrapping. Kept as the path of least resistance for
 * tools whose result is just text (Read, Grep, Glob, Skill, BashOutput, Bash, Task).
 */
interface ExpandableResultProps {
  content: string;
  className?: string;
  /** Additional wrapper className (e.g. for terminal-style bg) */
  wrapperClassName?: string;
  /** Fade color — must match the actual background for smooth fade.
   *  Defaults to paper-inset; BashTool passes code-bg. */
  fade?: ExpandFade;
}

export function ExpandableResult({ content: rawContent, className = '', wrapperClassName = '', fade = 'paper-inset' }: ExpandableResultProps) {
  // Auto-unwrap SDK JSON wrappers so all tools display clean text
  const content = unwrapSdkResult(rawContent);
  return (
    <ExpandableContainer wrapperClassName={wrapperClassName} fade={fade}>
      <pre className={`overflow-x-auto font-mono text-sm whitespace-pre-wrap select-text ${className}`}>
        {content}
      </pre>
    </ExpandableContainer>
  );
}

interface ThinkingHeaderProps {
  isComplete: boolean;
  durationMs?: number;
}

export function ThinkingHeader({ isComplete, durationMs }: ThinkingHeaderProps) {
  const { t } = useTranslation('chat');
  const config = getThinkingBadgeConfig();
  const label = getThinkingExpandedLabel(isComplete, durationMs, t);

  // Resize the icon's flat size class to size-3 for header visibility
  let displayIcon = config.icon;
  if (isValidElement(displayIcon)) {
    const element = displayIcon as React.ReactElement<{ className?: string }>;
    const existingProps = element.props as { className?: string };
    const existingClassName = existingProps?.className || '';
    const newClassName =
      existingClassName ? existingClassName.replace(/size-\d+(\.\d+)?/g, 'size-3') : 'size-3';
    displayIcon = cloneElement(element, {
      ...existingProps,
      className: newClassName
    });
  }

  return (
    <div className={`flex items-center gap-1.5 text-sm font-medium ${config.colors.text}`}>
      {displayIcon && (
        <span className={`flex h-4 w-4 items-center justify-center ${config.colors.iconColor}`}>
          {displayIcon}
        </span>
      )}
      <span className="tracking-wide">{label}</span>
    </div>
  );
}
