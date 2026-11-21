/**
 * CustomSelect - Custom dropdown select component
 * Replaces native <select> with styled dropdown matching design system.
 * Positioning is delegated to the shared `<Popover>` primitive, which
 * portals to <body> and auto-flips when there isn't room below.
 */

import { CheckIcon, ChevronDownIcon } from '@/components/icons';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Popover } from '@/components/ui/Popover';

export interface SelectOption {
  value: string;
  label: string;
  /** Optional structured label. `label` remains the accessible/plain-text source. */
  content?: ReactNode;
  icon?: ReactNode;
  /** Right-aligned suffix content (e.g., status badge) */
  suffix?: ReactNode;
  /** Renders as a non-selectable section header/divider */
  isSeparator?: boolean;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  renderMenu?: (select: (value: string) => void, dismiss: () => void) => ReactNode;
  onChange: (value: string) => void;
  placeholder?: string;
  triggerIcon?: ReactNode;
  className?: string;
  /** Keep a portaled menu usable when a compact trigger is narrower than its options. */
  popoverMinWidth?: number;
  /**
   * Trigger size — controls the closed-state padding + font size:
   *   'compact' (default when `compact={true}`): 12px / px-2 py-1
   *   'sm'      (default): 12px / px-3 py-2 — fine-print fields, dense forms
   *   'toolbar':           14px / px-3 py-1.5 — dense page/header filters
   *   'md':                14px / px-3 py-2.5 — primary fields the user
   *                        focuses on (e.g. workspace picker in dispatch
   *                        dialog where the active workspace is the most
   *                        important context to read at a glance).
   * `compact` prop kept for back-compat; `size` is the modern API.
   */
  size?: 'sm' | 'toolbar' | 'md';
  compact?: boolean;
  disabled?: boolean;
  /** Mirror the selected option's right-aligned suffix in the closed trigger. */
  showSelectedSuffix?: boolean;
  footerAction?: {
    label: string;
    icon?: ReactNode;
    onClick: () => void;
  };
  /** Accessible name when no external <label> is associated with the trigger. */
  ariaLabel?: string;
}

export default function CustomSelect({
  value,
  options,
  renderMenu,
  onChange,
  placeholder,
  triggerIcon,
  className,
  popoverMinWidth,
  size = 'sm',
  compact,
  disabled = false,
  showSelectedSuffix = false,
  footerAction,
  ariaLabel,
}: CustomSelectProps) {
  const { t } = useTranslation('app');
  const resolvedPlaceholder = placeholder ?? t('common.selectPlaceholder');
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  const handleSelect = useCallback(
    (optionValue: string) => {
      onChange(optionValue);
      setIsOpen(false);
    },
    [onChange],
  );

  return (
    <div
      className={`relative ${className ?? ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isOpen) {
          event.stopPropagation();
          setIsOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={(event) => {
          // Native accessibility activation may click without moving focus.
          // Keep Escape in this select's existing keyboard/focus owner.
          if (!isOpen) event.currentTarget.focus({ preventScroll: true });
          setIsOpen(!isOpen);
        }}
        className={`flex w-full items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] text-left transition-colors hover:border-[var(--ink-subtle)] disabled:cursor-not-allowed disabled:opacity-60 ${
          compact
            ? 'px-2 py-1 text-xs'
            : size === 'md'
              ? 'px-3 py-2.5 text-sm'
              : size === 'toolbar'
                ? 'px-3 py-1.5 text-sm'
                : 'px-3 py-2 text-xs'
        }`}
      >
        {triggerIcon && (
          <span className="shrink-0 text-[var(--ink-muted)]">
            {triggerIcon}
          </span>
        )}
        {/* Mirror the selected option's `icon` (when present) into the
                    closed trigger so users see the same visual marker as the
                    dropdown row they picked. Falls back gracefully when the
                    option set has no icons. */}
        {!triggerIcon && selectedOption?.icon && (
          <span className="shrink-0">{selectedOption.icon}</span>
        )}
        <span
          className={`min-w-0 flex-1 ${selectedOption ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]'}`}
        >
          {selectedOption?.content ?? (
            <span className="block truncate">
              {selectedOption?.label ?? resolvedPlaceholder}
            </span>
          )}
        </span>
        {showSelectedSuffix && selectedOption?.suffix && (
          <span className="shrink-0">{selectedOption.suffix}</span>
        )}
        <ChevronDownIcon
          className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      <Popover
        open={isOpen && !disabled}
        onClose={() => setIsOpen(false)}
        anchorRef={triggerRef}
        placement="bottom-start"
        matchAnchorWidth
        className={renderMenu ? "flex flex-col shadow-md" : "shadow-md"}
        style={
          popoverMinWidth ? { minWidth: `${popoverMinWidth}px` } : undefined
        }
        // Elevated above modal backdrops since selects are often
        // rendered inside OverlayBackdrop-wrapped dialogs.
        zIndex={300}
      >
        {/* Scroll container — Popover's DEFAULT_CHROME ships
                    `overflow-hidden` (for rounded-corner clipping of the
                    shadow). Putting `overflow-auto` on the same element
                    via className gets overridden by that `overflow-hidden`
                    in Tailwind's compiled order, which silently clipped
                    long option lists (e.g. 24-hour picker showed only
                    ~8 items, couldn't scroll). A nested div sidesteps the
                    conflict: outer clips, inner scrolls. */}
        {renderMenu ? renderMenu(handleSelect, () => setIsOpen(false)) : (
          <div className="max-h-60 overflow-y-auto py-1">
            {options.map((option) =>
              option.isSeparator ? (
                <div
                  key={option.value}
                  className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60"
                >
                  {option.label}
                </div>
              ) : (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelect(option.value)}
                  // Item font size mirrors the trigger's: `size='md'`
                  // → `text-sm` (14px) so options read at parity with
                  // what the closed trigger shows. Default `size='sm'`
                  // keeps the legacy `text-xs` (12px) for dense forms.
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    size === 'md' || size === 'toolbar' ? 'text-sm' : 'text-xs'
                  } ${
                    option.value === value
                      ? 'text-[var(--accent-warm)]'
                      : 'text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                  }`}
                >
                  {option.icon && <span className="shrink-0">{option.icon}</span>}
                  <span className="min-w-0">
                    {option.content ?? (
                      <span className="block truncate">{option.label}</span>
                    )}
                  </span>
                  {option.value === value && (
                    <CheckIcon data-selected-indicator className="h-3 w-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1" />
                  {option.suffix && (
                    <span className="shrink-0">{option.suffix}</span>
                  )}
                </button>
              ),
            )}

            {footerAction && (
              <>
                <div className="my-1 border-t border-[var(--line)]" />
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    footerAction.onClick();
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] ${
                    size === 'md' || size === 'toolbar' ? 'text-sm' : 'text-xs'
                  }`}
                >
                  {footerAction.icon && (
                    <span className="shrink-0">{footerAction.icon}</span>
                  )}
                  <span>{footerAction.label}</span>
                </button>
              </>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}
