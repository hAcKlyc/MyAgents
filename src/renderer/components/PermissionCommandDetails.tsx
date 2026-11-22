import {
  CheckIcon,
  CopyIcon,
  FolderIcon,
  TerminalIcon,
} from '@/components/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { useResolvedTheme } from '@/theme';
import { copyPlainText } from '@/utils/clipboard';
import { ExpandableContainer } from './tools/utils';

export interface PermissionCommandDisplay {
  command: string;
  cwd?: string;
  description?: string;
  dialect: 'bash' | 'pwsh' | 'terminal';
}

/** Only renders the reviewed command. Copy and approval always retain its exact bytes. */
export function PermissionCommandDetails({ command, cwd, description, dialect }: PermissionCommandDisplay) {
  const { t } = useTranslation(['chat', 'app']);
  const theme = useResolvedTheme().adapters.prism;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const mounted = useRef(false);
  const resetCopy = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(resetCopy.current);
    };
  }, []);

  const copy = async () => {
    clearTimeout(resetCopy.current);
    try {
      await copyPlainText(command);
      if (mounted.current) setCopyState('copied');
    } catch {
      if (mounted.current) setCopyState('failed');
    }
    if (mounted.current) resetCopy.current = setTimeout(() => setCopyState('idle'), 2_000);
  };
  const pathSeparator = cwd ? Math.max(cwd.lastIndexOf('/'), cwd.lastIndexOf('\\')) : -1;
  // Large approval payloads stay complete without blocking the WebView on syntax parsing.
  const highlight = dialect !== 'terminal' && command.length <= 16_384;

  return <>
    {description && <p className="mt-3 text-sm text-[var(--ink-secondary)]">
      <span className="mr-2 text-xs text-[var(--ink-muted)]">{t('shell.permissionPrompt.purpose')}</span>{description}
    </p>}
    {cwd !== undefined && <div className="mt-3 flex min-w-0 items-start gap-2 text-xs text-[var(--ink-muted)]">
      <FolderIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t('shell.permissionPrompt.cwd')}: </span>
      <span data-permission-cwd="" className="min-w-0 break-all font-mono text-[var(--ink-secondary)]">
        {cwd.slice(0, pathSeparator + 1)}<strong className="font-semibold text-[var(--ink)]">{cwd.slice(pathSeparator + 1)}</strong>
      </span>
    </div>}
    <div className="mt-3 min-w-0 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--code-bg)]">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-[var(--ink-muted)]">
        <span className="flex items-center gap-1.5"><TerminalIcon className="size-3.5" aria-hidden="true" />{t('shell.permissionPrompt.command')}</span>
        <button type="button" aria-label={t('app:markdown.copy')} onClick={() => void copy()} className="flex items-center gap-1.5 rounded px-1 py-1 hover:text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          {copyState === 'copied' ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <CopyIcon className="size-3.5" aria-hidden="true" />}
          <span role="status">{copyState === 'copied' ? t('app:markdown.copied') : copyState === 'failed' ? t('workspaceFiles.common.copyFailed') : t('app:markdown.copy')}</span>
        </button>
      </div>
      <ExpandableContainer compact fade="code-bg" expandLabel={t('shell.permissionPrompt.expandCommand')} collapseLabel={t('shell.permissionPrompt.collapseCommand')}>
        <div className="px-3 pb-3 pt-1" data-permission-command="">
          {highlight ? <SyntaxHighlighter
            language={dialect === 'pwsh' ? 'powershell' : 'bash'}
            style={theme}
            className="whitespace-pre-wrap break-words"
            customStyle={{ margin: 0, padding: 0, background: 'transparent', fontFamily: 'var(--font-code)', fontSize: 'var(--text-xs)', lineHeight: 1.625, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            codeTagProps={{ style: { fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit', whiteSpace: 'pre-wrap' } }}
            wrapLongLines
          >{command}</SyntaxHighlighter> : <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-[var(--code-text)]">{command}</pre>}
        </div>
      </ExpandableContainer>
    </div>
  </>;
}
