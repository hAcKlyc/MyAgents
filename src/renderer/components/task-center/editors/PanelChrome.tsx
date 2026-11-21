// PanelChrome — shared chrome primitives that keep the three task-center
// surfaces (DispatchTaskDialog · TaskDetailOverlay header · TaskEditPanel)
// pixel-aligned. The lifecycle "create → preview → edit" is one continuous
// object touched by the same user — section headers, footers, gaps, toggles
// must look identical or the user perceives them as different things.
//
// Hierarchy (intentional, not arbitrary):
//   PanelHeader  — 18px semibold              ← modal / panel root
//   FormSection  — 14px semibold              ← section grouping inside body
//   field label  — 14px (text-sm) medium                ← single field
//
// Spacing constants are exported so callers compose with `${SECTION_GAP}`
// instead of pasting `space-y-7` and slowly drifting apart again.

import { useOverlayOwnerActive } from '@/context/OverlayOwnerActiveContext';
import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/components/icons';

type IconType = React.ComponentType<{ className?: string }>;

/** Vertical rhythm between top-level sections inside a panel body.
 *  28px sits between the dispatch dialog's previous 32px (too airy) and
 *  the edit panel's previous 20px (too dense). */
export const SECTION_GAP = 'space-y-7';

/** Subtle line — preferred for in-body dividers. The heavier `--line` is
 *  reserved for body↔footer / header↔body boundaries. */
export const SECTION_DIVIDER = 'border-t border-[var(--line-subtle)]';

// ─────────────────────────────────────────────────────────────────────────
// PanelHeader
// ─────────────────────────────────────────────────────────────────────────

interface PanelHeaderProps {
  icon?: IconType;
  title: React.ReactNode;
  /** Subtitle / description rendered under the title. */
  subtitle?: React.ReactNode;
  /** Trailing slot, sits left of the close button (e.g. status badge row). */
  trailing?: React.ReactNode;
  /** Slot rendered to the LEFT of the title (status badge, origin chip).
   *  Kept on the same flex row as the title so the row reads as one unit. */
  leading?: React.ReactNode;
  onClose: () => void;
  /** Override close-button title (e.g. "关闭 (Cmd+W)"). */
  closeTitle?: string;
}

/** Modal / panel header. 18px semibold title — one notch larger than
 *  section h3s (14px) so the visual hierarchy "panel > section > field"
 *  is unambiguous on first glance. */
export function PanelHeader({
  icon: Icon,
  title,
  subtitle,
  trailing,
  leading,
  onClose,
  closeTitle,
}: PanelHeaderProps) {
  const { t } = useTranslation('task');
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-[var(--line)] px-6 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="h-[18px] w-[18px] shrink-0 text-[var(--accent)]" />}
          {leading}
          <h2 className="min-w-0 truncate text-lg font-semibold leading-snug text-[var(--ink)]">
            {title}
          </h2>
        </div>
        {subtitle && (
          <div className="mt-1 text-xs text-[var(--ink-muted)]">{subtitle}</div>
        )}
      </div>
      {trailing}
      <button
        type="button"
        onClick={onClose}
        title={closeTitle ?? t('common.close')}
        className="shrink-0 rounded-[var(--radius-md)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// FormSection
// ─────────────────────────────────────────────────────────────────────────

interface FormSectionProps {
  icon?: IconType;
  title: React.ReactNode;
  /** Tiny inline hint after the title, e.g. "（可选）". */
  hint?: React.ReactNode;
  /** Right-aligned slot in the header row (e.g. inline action button). */
  action?: React.ReactNode;
  children: React.ReactNode;
  /** Optional className on the outer <section>. */
  className?: string;
}

/** Standard task-center section. 14px semibold title, optional accent icon,
 *  no inner indent — section padding is owned by the panel body. */
export function FormSection({
  icon: Icon,
  title,
  hint,
  action,
  children,
  className,
}: FormSectionProps) {
  return (
    <section className={className}>
      <div className="mb-3 flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />}
        <h3 className="text-sm font-semibold text-[var(--ink)]">{title}</h3>
        {hint && (
          <span className="text-xs font-normal text-[var(--ink-muted)]/80">
            {hint}
          </span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// PanelFooter
// ─────────────────────────────────────────────────────────────────────────

interface PanelFooterProps {
  /** When set, rendered on the left of the footer in error styling. */
  error?: string | null;
  onCancel: () => void;
  onSubmit: () => void;
  busy?: boolean;
  /** Disable the primary action without entering busy state. */
  disabled?: boolean;
  cancelLabel?: string;
  submitLabel: string;
  /** Secondary slot rendered between cancel and primary (rare). */
  extra?: React.ReactNode;
}

/** Standard footer. Error left, cancel + primary right. Primary button is
 *  the dispatch-dialog size (`px-5 py-2`) so create/edit feel continuous. */
export function PanelFooter({
  error,
  onCancel,
  onSubmit,
  busy = false,
  disabled = false,
  cancelLabel,
  submitLabel,
  extra,
}: PanelFooterProps) {
  const { t } = useTranslation('task');
  const blocked = busy || disabled;
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-[var(--line)] px-6 py-4">
      {error ? (
        <p className="min-w-0 truncate pr-3 text-xs text-[var(--error)]" title={error}>
          {error}
        </p>
      ) : (
        <div />
      )}
      <div className="flex shrink-0 items-center gap-2">
        {extra}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-[var(--radius-md)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cancelLabel ?? t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={blocked}
          className="rounded-[var(--radius-md)] bg-[var(--button-primary-bg)] px-5 py-2 text-sm font-medium text-[var(--button-primary-text)] transition hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Keyboard
// ─────────────────────────────────────────────────────────────────────────

/** Esc closes / Cmd|Ctrl+Enter submits. Exempts the input being focused
 *  via IME composition (composing CJK should not trigger submit). */
export function usePanelKeys(opts: {
  onClose?: () => void;
  onSubmit?: () => void;
  /** When true, Cmd/Ctrl+Enter is ignored. */
  disabled?: boolean;
}): void {
  const { onClose, onSubmit, disabled } = opts;
  const ownerActive = useOverlayOwnerActive();
  useEffect(() => {
    if (!ownerActive) return;
    const handler = (e: KeyboardEvent) => {
      if (isImeComposingEvent(e)) return;
      if (e.key === 'Escape' && onClose) {
        onClose();
        return;
      }
      if (
        !disabled &&
        onSubmit &&
        e.key === 'Enter' &&
        (e.metaKey || e.ctrlKey)
      ) {
        e.preventDefault();
        onSubmit();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, onSubmit, disabled, ownerActive]);
}

// ─────────────────────────────────────────────────────────────────────────
// Toggle (DESIGN.md §5.6)
// ─────────────────────────────────────────────────────────────────────────

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}

/** Canonical toggle switch — 44×24 capsule, 20px white slider, accent on.
 *  Single source of truth so we don't ship two mildly different switches
 *  in the same flow (the prior NotificationConfigEditor / controls.tsx
 *  divergence). Imported by both task-center and dispatch flows. */
export function Toggle({ checked, onChange, ariaLabel, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
      } ${disabled ? '' : 'cursor-pointer'}`}
    >
      <span
        aria-hidden
        className={`inline-block h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform duration-150 ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
