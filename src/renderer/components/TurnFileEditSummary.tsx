import { MoreIcon, FileEditIcon } from '@/components/icons';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import Tip from '@/components/Tip';
import { FileIcon } from '@/components/file-icon';
import { Popover } from '@/components/ui/Popover';
import { useFileAction } from '@/context/FileActionContext';
import type { Message } from '@/types/chat';
import {
  deriveTurnFileEdits,
  type TurnFileEditItem,
} from '@/utils/turnFileEdits';
import { resolveFileActionTarget } from '@/utils/workspaceFileLinks';

const TURN_FILE_MENU_Z_INDEX = 270;

export function TurnFileEditSummary({ content }: { content: Message['content'] }) {
  const { t } = useTranslation('app');
  const fileAction = useFileAction();
  const summary = useMemo(
    () => deriveTurnFileEdits(content, fileAction?.workspacePath),
    [content, fileAction?.workspacePath],
  );
  const [open, setOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const cancelFileMenuRef = useRef<(() => void) | null>(null);
  const popoverId = useId();

  useEffect(() => () => {
    cancelFileMenuRef.current?.();
    cancelFileMenuRef.current = null;
  }, []);

  if (!summary) return null;

  const capsuleLabel = t('message.turnFileEdits.summary', {
    count: summary.files.length,
  });
  const showTotals = summary.allStatsReliable
    && (summary.totalAdded > 0 || summary.totalRemoved > 0);
  const cancelFileMenu = () => {
    const cancel = cancelFileMenuRef.current;
    cancelFileMenuRef.current = null;
    cancel?.();
    setFileMenuOpen(false);
  };
  const closeAndRestoreFocus = () => {
    cancelFileMenu();
    setOpen(false);
    anchorRef.current?.focus();
  };

  return (
    <>
      <Tip label={capsuleLabel} disabled={open}>
        <button
          ref={anchorRef}
          type="button"
          className="flex h-7 max-w-full items-center gap-1.5 rounded-full px-2 text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={() => {
            if (open) cancelFileMenu();
            setOpen((current) => !current);
          }}
        >
          <FileEditIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{capsuleLabel}</span>
          {showTotals && (
            <span className="shrink-0 font-mono text-xs text-[var(--ink-muted)]/80">
              {t('message.turnFileEdits.accumulated')}{' '}
              <span className="text-[var(--success)]">+{summary.totalAdded}</span>
              {' '}
              <span className="text-[var(--error)]">−{summary.totalRemoved}</span>
            </span>
          )}
        </button>
      </Tip>
      <Popover
        open={open}
        onClose={closeAndRestoreFocus}
        anchorRef={anchorRef}
        placement="top-start"
        offset={6}
        closeOnEscape={!fileMenuOpen}
        className="w-[min(380px,calc(100vw-24px))]"
      >
        <div id={popoverId} role="dialog" aria-label={t('message.turnFileEdits.title')}>
          <div className="border-b border-[var(--line-subtle)] px-3 py-2 text-sm font-medium text-[var(--ink)]">
            {t('message.turnFileEdits.title')}
          </div>
          <div className="max-h-80 overflow-y-auto overscroll-contain py-1">
            {summary.files.map((file) => (
              <TurnFileEditRow
                key={file.identityPath}
                file={file}
                onOpen={() => {
                  if (file.status === 'deleted' || !fileAction) return;
                  const target = resolveFileActionTarget(
                    file.displayPath,
                    fileAction.workspacePath,
                  ) ?? file.actionTarget;
                  cancelFileMenu();
                  setOpen(false);
                  fileAction.openFileTarget(target, { displayPath: file.displayPath });
                }}
                canOpenMenu={file.status !== 'deleted' && !!fileAction}
                onOpenMenu={(x, y) => {
                  if (file.status === 'deleted' || !fileAction) return;
                  const target = resolveFileActionTarget(
                    file.displayPath,
                    fileAction.workspacePath,
                  ) ?? file.actionTarget;
                  cancelFileMenuRef.current = fileAction.openFileTargetMenu(x, y, target, {
                    displayPath: file.displayPath,
                    zIndex: TURN_FILE_MENU_Z_INDEX,
                    onOpen: () => setFileMenuOpen(true),
                    onClose: () => {
                      cancelFileMenuRef.current = null;
                      setFileMenuOpen(false);
                    },
                  });
                }}
              />
            ))}
          </div>
        </div>
      </Popover>
    </>
  );
}

function TurnFileEditRow({
  file,
  onOpen,
  canOpenMenu,
  onOpenMenu,
}: {
  file: TurnFileEditItem;
  onOpen: () => void;
  canOpenMenu: boolean;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const { t } = useTranslation('app');
  const deleted = file.status === 'deleted';
  const basename = basenameOf(file.displayPath);
  const originalName = file.originalPath ? basenameOf(file.originalPath) : null;
  const showOriginalName = !!originalName && originalName !== basename;
  const statusLabel = t(`message.turnFileEdits.status.${file.status}`);
  const moreActionsLabel = `${t('dropdown.moreActions')}: ${basename}`;

  return (
    <div
      className="flex min-h-9 w-full items-center px-1 hover:bg-[var(--hover-bg)] focus-within:bg-[var(--hover-bg)]"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!canOpenMenu) return;
        onOpenMenu(event.clientX, event.clientY);
      }}
    >
      <button
        type="button"
        disabled={deleted}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left focus-visible:outline-none disabled:cursor-default disabled:opacity-65"
        aria-label={`${statusLabel}: ${file.originalPath ? `${file.originalPath} → ` : ''}${file.displayPath}`}
        onClick={onOpen}
      >
        <FileIcon name={basename} size="regular" />
        <span className="flex min-w-0 flex-1 items-baseline gap-1 text-sm text-[var(--ink)]">
          {showOriginalName && (
            <>
              <span className="truncate">{originalName}</span>
              <span className="shrink-0 text-[var(--ink-muted)]">→</span>
            </>
          )}
          <span className="truncate">{basename}</span>
        </span>
        <span className="shrink-0 font-mono text-xs">
          {renderStats(file, t)}
        </span>
      </button>
      <button
        type="button"
        disabled={!canOpenMenu}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-border)]/30 disabled:cursor-default disabled:opacity-40"
        aria-label={moreActionsLabel}
        title={moreActionsLabel}
        aria-haspopup="menu"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(rect.right, rect.bottom + 4);
        }}
      >
        <MoreIcon className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop() || normalized;
}

function renderStats(
  file: TurnFileEditItem,
  t: (key: string) => string,
): React.ReactNode {
  if (!file.statsReliable || (file.added === 0 && file.removed === 0)) {
    return (
      <span className="text-[var(--ink-muted)]">
        {file.status === 'deleted'
          ? t('message.turnFileEdits.deleted')
          : t('message.turnFileEdits.edited')}
      </span>
    );
  }
  return (
    <>
      {file.added > 0 && (
        <span className="text-[var(--success)]">+{file.added}</span>
      )}
      {file.added > 0 && file.removed > 0 && ' '}
      {file.removed > 0 && (
        <span className="text-[var(--error)]">−{file.removed}</span>
      )}
    </>
  );
}
