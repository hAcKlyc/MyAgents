import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import OverlayBackdrop from '../OverlayBackdrop';
import { useCloseLayer } from '../../hooks/useCloseLayer';

export const primaryButton =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40';
export const secondaryButton =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] hover:bg-[var(--paper-inset)] disabled:opacity-40';
export const iconButton =
  'rounded-lg p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40';

export function TokenDanceDialog({
  title,
  subtitle,
  badge,
  children,
  footer,
  onClose,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 200);
  useEffect(() => {
    const before =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    root.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  return (
    <OverlayBackdrop
      portal
      onClose={onClose}
      className="z-[200] overflow-y-auto px-4 py-8"
    >
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-64px)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const nodes = [
            ...(root.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]',
            ) ?? []),
          ];
          const first = nodes[0];
          const last = nodes[nodes.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--line-subtle)] px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={titleId} className="text-lg font-semibold">
                {title}
              </h3>
              {badge}
            </div>
            {subtitle && (
              <p className="mt-1 text-sm text-[var(--ink-muted)]">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            className={iconButton}
            onClick={onClose}
            aria-label={t('actions.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-5 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--line-subtle)] px-6 py-4">
            {footer}
          </footer>
        )}
      </div>
    </OverlayBackdrop>
  );
}

export function TokenDanceBadge({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'success' | 'error' | 'info';
}) {
  const color =
    tone === 'muted'
      ? 'bg-[var(--paper-inset)] text-[var(--ink-muted)]'
      : tone === 'success'
        ? 'bg-[var(--success-bg)] text-[var(--success)]'
        : tone === 'error'
          ? 'bg-[var(--error-bg)] text-[var(--error)]'
          : 'bg-[var(--info-bg)] text-[var(--info)]';
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${color}`}
    >
      {children}
    </span>
  );
}
