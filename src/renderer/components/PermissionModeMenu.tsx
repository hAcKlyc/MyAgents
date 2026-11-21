import {
  BanIcon,
  EyeIcon,
  FileEditIcon,
  LockOpenIcon,
  ShieldCheckIcon,
  ShieldQuestionIcon,
  type AppIconComponent,
} from '@/components/icons';

export interface PermissionModeMenuItem {
  value: string;
  label: string;
  description: string;
  icon?: string;
}

const PERMISSION_MODE_ICONS: Partial<Record<string, AppIconComponent>> = {
  auto: ShieldCheckIcon,
  plan: EyeIcon,
  fullAgency: LockOpenIcon,
  'approval-required': ShieldQuestionIcon,
  'workspace-autonomous': ShieldCheckIcon,
  'full-autonomous': LockOpenIcon,
  default: ShieldQuestionIcon,
  manual: ShieldQuestionIcon,
  dontAsk: BanIcon,
  acceptEdits: FileEditIcon,
  'accept-edits': ShieldQuestionIcon,
  'dangerously-skip-permissions': LockOpenIcon,
  bypassPermissions: LockOpenIcon,
  suggest: ShieldQuestionIcon,
  'auto-edit': FileEditIcon,
  'full-auto': ShieldCheckIcon,
  'no-restrictions': LockOpenIcon,
};

export function PermissionModeIcon({
  value,
  fallback,
  className,
}: {
  value: string | undefined;
  fallback?: string;
  className: string;
}) {
  if (value) {
    const Icon = PERMISSION_MODE_ICONS[value];
    if (Icon) return <Icon aria-hidden="true" className={className} strokeWidth={1.75} />;
  }

  return fallback ? <span>{fallback}</span> : null;
}

export function PermissionModeMenuContent({
  items,
  selectedValue,
  onSelect,
  header,
  headerAction,
}: {
  items: readonly PermissionModeMenuItem[];
  selectedValue: string | undefined;
  onSelect: (value: string) => void;
  header: string;
  headerAction?: { label: string; onClick: () => void };
}) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
        <span className="text-xs font-medium text-[var(--ink-muted)]">{header}</span>
        {headerAction && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              headerAction.onClick();
            }}
            className="text-xs font-medium text-[var(--accent)] transition-colors hover:text-[var(--accent-warm-hover)]"
          >
            {headerAction.label}
          </button>
        )}
      </div>
      {items.map(item => {
        const selected = selectedValue === item.value;
        return (
          <button
            key={item.value}
            type="button"
            aria-current={selected ? 'true' : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(item.value);
            }}
            className={`flex w-full flex-col items-start px-3 py-2 text-left transition-colors ${
              selected ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--hover-bg)]'
            }`}
          >
            <span className={`flex items-center gap-1.5 text-sm font-medium ${
              selected ? 'text-[var(--accent)]' : 'text-[var(--ink)]'
            }`}>
              <PermissionModeIcon
                value={item.value}
                fallback={item.icon}
                className="h-4 w-4 shrink-0"
              />
              {item.label}
            </span>
            <span className="mt-0.5 text-xs text-[var(--ink-muted)]">{item.description}</span>
          </button>
        );
      })}
    </>
  );
}
