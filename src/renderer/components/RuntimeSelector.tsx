// RuntimeSelector — dropdown to switch between Agent Runtime types (v0.1.59)
// Used by the Launcher and Agent settings; a Chat Session's Runtime is read-only.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckIcon,
  ChevronUpIcon,
  HelpIcon,
  SettingsIcon,
} from '@/components/icons';
import { useTranslation } from 'react-i18next';

import { Popover } from '@/components/ui/Popover';
import Tip from '@/components/Tip';
import { RUNTIME_PRESENTATION } from '@/components/runtimePresentation';
import RuntimeIcon from '@/components/RuntimeIcon';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type { RuntimeType, RuntimeDetections } from '../../shared/types/runtime';
import {
  AGENT_RUNTIME_DISTRIBUTION_POLICY,
  isRuntimeAllowedByDistribution,
  type AgentRuntimeDistributionPolicy,
} from '../../shared/integrated-runtimes/distribution-policy';

// Runtime types that have backend implementations (not just type definitions)
const IMPLEMENTED_RUNTIMES = new Set<RuntimeType>(['builtin', 'dsh', 'claude-code', 'codex', 'antigravity']);

// ─── Runtime display metadata ───

const RUNTIME_OPTIONS: {
  type: RuntimeType;
  name: string;
  group: 'integrated' | 'external';
}[] = [
    { type: 'builtin', name: RUNTIME_PRESENTATION.builtin.name, group: 'integrated' },
    { type: 'dsh', name: RUNTIME_PRESENTATION.dsh.name, group: 'integrated' },
    { type: 'claude-code', name: RUNTIME_PRESENTATION['claude-code'].name, group: 'external' },
    { type: 'antigravity', name: RUNTIME_PRESENTATION.antigravity.name, group: 'external' },
    { type: 'codex', name: RUNTIME_PRESENTATION.codex.name, group: 'external' },
  ];

function RuntimeGroupHeading({ group }: { group: 'integrated' | 'external' }) {
  const { t } = useTranslation('chat');
  const label = t(group === 'integrated' ? 'runtime.integrated' : 'runtime.externalCli');
  const description = t(group === 'integrated' ? 'runtime.integratedHelp' : 'runtime.externalCliHelp');

  return (
    <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-2 text-xs font-medium text-[var(--ink-muted)]">
      <span>{label}</span>
      <Tip label={description} wrap>
        <button
          type="button"
          aria-label={`${label}: ${description}`}
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
        >
          <HelpIcon className="h-3 w-3" aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}

// ─── Component ───

interface RuntimeSelectorProps {
  value: RuntimeType;
  detections: RuntimeDetections;
  onChange: (runtime: RuntimeType) => void;
  variant?: 'launcher' | 'panel';
  onOpenSettings?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  onDisabledClick?: () => void;
  distributionPolicy?: AgentRuntimeDistributionPolicy;
  integratedOnly?: boolean;
}

export default memo(function RuntimeSelector({
  value,
  detections,
  onChange,
  variant = 'launcher',
  onOpenSettings,
  disabled = false,
  disabledReason,
  onDisabledClick,
  distributionPolicy = AGENT_RUNTIME_DISTRIBUTION_POLICY,
  integratedOnly = false,
}: RuntimeSelectorProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!disabled || !open) return;
    const timer = window.setTimeout(() => setOpen(false), 0);
    return () => window.clearTimeout(timer);
  }, [disabled, open]);

  const menuOpen = open && !disabled;

  // Register with close layer system so Cmd+W dismisses dropdown before closing Tab
  useCloseLayer(() => {
    if (menuOpen) { setOpen(false); return true; }
    return false;
  }, menuOpen ? 10 : -1);

  const handleSelect = useCallback((type: RuntimeType) => {
    if (disabled) return;
    const detection = detections[type];
    if (!detection?.installed) return; // Can't select uninstalled runtime
    setOpen(false);
    onChange(type);
  }, [detections, onChange, disabled]);

  const availableOptions = RUNTIME_OPTIONS.filter(option =>
    (!integratedOnly || option.group === 'integrated') &&
    isRuntimeAllowedByDistribution(distributionPolicy, option.type),
  );
  const currentOption = availableOptions.find(o => o.type === value) ?? availableOptions[0];
  if (!currentOption) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-disabled={disabled}
        aria-expanded={menuOpen}
        onClick={(event) => {
          if (variant === 'launcher') event.stopPropagation();
          if (disabled) {
            onDisabledClick?.();
            return;
          }
          setOpen(!menuOpen);
        }}
        className={`${variant === 'panel'
          ? 'flex w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] [--runtime-icon-surface:var(--paper-elevated)]'
          : 'inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--ink-muted)] [--runtime-icon-surface:var(--paper)]'
        } transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${disabled
          ? 'cursor-not-allowed opacity-50'
          : 'hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] hover:[--runtime-icon-surface:var(--hover-bg)]'
        }`}
        title={disabled ? disabledReason : `Runtime: ${currentOption.name}`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <RuntimeIcon type={value} size={16} />
          {variant === 'panel' && <span className="truncate">{currentOption.name}</span>}
        </span>
        <ChevronUpIcon className={`h-3 w-3 shrink-0 text-[var(--ink-muted)] transition-transform ${menuOpen ? '' : 'rotate-180'}`} />
      </button>
      <Popover
        open={menuOpen}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        placement="top-start"
        className="w-88 max-w-[calc(100vw-1rem)] rounded-xl py-2"
      >
        <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-1">
          <span className="text-xs font-semibold text-[var(--ink-muted)]">{t('runtime.header')}</span>
          {onOpenSettings && (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); setOpen(false); onOpenSettings(); }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <SettingsIcon className="h-3 w-3" />
              {t('runtime.settings')}
            </button>
          )}
        </div>
        {availableOptions.map((opt, index) => {
          const detection = detections[opt.type];
          const installed = opt.type === 'builtin' || (detection?.installed && detection.reason !== 'protocol-mismatch' && IMPLEMENTED_RUNTIMES.has(opt.type));
          const selected = opt.type === value;
          const groupStart = index === 0 || availableOptions[index - 1].group !== opt.group;
          return (
            <div key={opt.type}>
              {groupStart && (
                <>
                  {index > 0 && <div className="mx-3 my-2 h-px bg-[var(--line-subtle)]" />}
                  <RuntimeGroupHeading group={opt.group} />
                </>
              )}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (installed) handleSelect(opt.type);
                }}
                disabled={!installed}
                aria-pressed={selected}
                title={opt.name}
                className={`flex w-full items-center gap-3 px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)] ${selected && installed
                  ? 'bg-[var(--accent-warm-subtle)] [--runtime-icon-surface:var(--accent-warm-subtle)]'
                  : '[--runtime-icon-surface:var(--paper-elevated)]'
                } ${installed
                  ? selected ? '' : 'hover:bg-[var(--hover-bg)] hover:[--runtime-icon-surface:var(--hover-bg)]'
                  : 'cursor-not-allowed opacity-40'
                }`}
              >
                <span className="flex w-9 shrink-0 items-center">
                  <RuntimeIcon type={opt.type} size={20} />
                </span>
                <span className={`min-w-0 flex-1 truncate text-sm font-medium ${selected ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                  {opt.name}
                </span>
                {installed ? (
                  <CheckIcon className={`h-3.5 w-3.5 shrink-0 text-[var(--accent)] ${selected ? '' : 'invisible'}`} aria-hidden="true" />
                ) : (
                  <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                    {opt.type === 'antigravity' ? t(detection?.installed ? 'runtime.upgradeAgy' : 'runtime.installAgy') : detection?.installed && !IMPLEMENTED_RUNTIMES.has(opt.type)
                      ? t('runtime.comingSoon')
                      : t('runtime.notInstalled')}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </Popover>
    </>
  );
});
